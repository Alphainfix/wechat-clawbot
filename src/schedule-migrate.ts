/**
 * One-time carry-over of session-log reminders into the Host schedule table.
 *
 * Up to DSH 0.1.7-rc.1, dsh-schedule kept reminders in the Session log itself
 * (`schedule/change` events) and armed them while that Session's Agent was
 * alive. 0.1.7-rc.2 moved them into a Host-wide table and deliberately does
 * NOT migrate: "Historical events do not populate the Host task table … the
 * Host does not scan historical Sessions, migrate tasks implicitly". All it
 * does is log `contains legacy reminders; recreate active reminders with
 * schedule_create` — so on upgrade every pending WeChat reminder goes quiet,
 * and the bot still confirmed them at creation time.
 *
 * This module folds the WeChat Session's legacy events the same way the host's
 * own `foldScheduleEvents` does and recreates what is still pending through
 * `schedule.create(sessionId, …)`, which binds the task to the original
 * Session without waking it. A marker file records every legacy id that has
 * been handled, so a restart never recreates one — including one the user
 * later deleted from the new table.
 *
 * The legacy events stay in the log untouched (they are the host's
 * package-owned stream), so rolling back to rc.1 still finds them there.
 */
import fs from "node:fs";
import path from "node:path";

/** A still-pending reminder from a version-1 `schedule/change` stream. */
export type LegacyReminder = {
  id: string;
  kind: "after" | "at" | "every";
  prompt: string;
  scheduledAt: string;
  everySeconds?: number;
};

/** The slice of rc.2's `schedule` service this module calls. */
export type HostSchedule = {
  create(sessionId: string, request: Record<string, unknown>): Promise<{ id: string; scheduledAt: string }>;
  list(request: { sessionId: string }): Promise<ReadonlyArray<{ id: string; prompt: string; scheduledAt: string }>>;
};

type EventLike = { type: string; data?: unknown };

/**
 * rc.2's service answers `create(sessionId, request)` and `catalog()`; rc.1
 * provides no `schedule` service at all. Anything else is left alone rather
 * than guessed at.
 */
export function isHostSchedule(value: unknown): value is HostSchedule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.create === "function" && typeof v.list === "function" && typeof v.catalog === "function";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function decodeLegacy(value: unknown): LegacyReminder | undefined {
  const r = asRecord(value);
  if (!r) return undefined;
  const { id, kind, prompt, scheduledAt } = r;
  if (typeof id !== "string" || typeof prompt !== "string" || typeof scheduledAt !== "string") return undefined;
  if (!Number.isFinite(Date.parse(scheduledAt)) || prompt.trim() === "") return undefined;
  if (kind === "after" || kind === "at") return { id, kind, prompt, scheduledAt };
  if (kind === "every" && typeof r.everySeconds === "number") {
    return { id, kind, prompt, scheduledAt, everySeconds: r.everySeconds };
  }
  return undefined;
}

/**
 * Replay version-1 `schedule/change` events into the reminders still active.
 * Same transitions as the host's fold (create adds, delete removes, dispatch
 * retires a one-shot and advances an `every`), but lenient: an event the
 * host would reject is skipped instead of failing the whole Session.
 */
export function foldLegacyReminders(events: Iterable<EventLike>): LegacyReminder[] {
  const active = new Map<string, LegacyReminder>();
  for (const event of events) {
    if (event.type !== "schedule/change") continue;
    const change = asRecord(event.data);
    if (!change || change.version !== 1) continue;
    if (change.operation === "create") {
      const record = decodeLegacy(change.schedule);
      if (record) active.set(record.id, record);
    } else if (change.operation === "delete" && typeof change.id === "string") {
      active.delete(change.id);
    } else if (change.operation === "dispatch" && typeof change.id === "string") {
      const record = active.get(change.id);
      if (!record) continue;
      if (record.kind !== "every" || typeof change.acceptedAt !== "string") {
        active.delete(change.id);
        continue;
      }
      // Advance to the first target strictly after the accepted dispatch.
      const step = (record.everySeconds ?? 0) * 1000;
      const accepted = Date.parse(change.acceptedAt);
      let next = Date.parse(record.scheduledAt);
      if (step > 0 && Number.isFinite(accepted)) {
        if (next <= accepted) next += Math.floor((accepted - next) / step + 1) * step;
        active.set(record.id, { ...record, scheduledAt: new Date(next).toISOString() });
      }
    }
  }
  return [...active.values()];
}

/**
 * rc.2 requires a title (1–120 chars) and never derives one itself. The
 * legacy prompt is what the bot showed the user, so name the task after it,
 * minus the "提醒:" lead-in the bot tends to write.
 */
export function reminderTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? "";
  const bare = firstLine.replace(/^\s*(提醒|reminder)\s*[:：]\s*/i, "").replace(/\s+/g, " ").trim();
  const chars = [...(bare || "提醒")];
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : chars.join("");
}

/** How late a one-shot may be and still be delivered (rc.1 caught up on restart too). */
export const CATCH_UP_MS = 24 * 60 * 60 * 1000;

export type MigrationStep =
  | { legacy: LegacyReminder; action: "create"; request: Record<string, unknown> }
  | { legacy: LegacyReminder; action: "present" }
  | { legacy: LegacyReminder; action: "skip"; reason: string };

/**
 * Decide what to do with each legacy reminder that has not been handled yet.
 * @param legacy - active reminders folded from the Session log.
 * @param existing - the Session's active tasks already in the Host table.
 * @param handled - legacy ids recorded in the marker file.
 * @param now - current wall clock in epoch milliseconds.
 */
export function planLegacyMigration(
  legacy: readonly LegacyReminder[],
  existing: ReadonlyArray<{ prompt: string; scheduledAt: string }>,
  handled: ReadonlySet<string>,
  now: number,
): MigrationStep[] {
  const steps: MigrationStep[] = [];
  for (const reminder of legacy) {
    if (handled.has(reminder.id)) continue;
    const title = reminderTitle(reminder.prompt);
    const due = Date.parse(reminder.scheduledAt);
    // Someone (the bot, the task page) already recreated it by hand.
    if (existing.some((task) => task.prompt === reminder.prompt
      && (reminder.kind === "every" || Date.parse(task.scheduledAt) === due))) {
      steps.push({ legacy: reminder, action: "present" });
      continue;
    }
    if (reminder.kind === "every") {
      const every = reminder.everySeconds ?? 0;
      if (!Number.isSafeInteger(every) || every < 60) {
        steps.push({ legacy: reminder, action: "skip", reason: `interval ${every}s is below the host minimum of 60s` });
      } else {
        steps.push({ legacy: reminder, action: "create", request: { prompt: reminder.prompt, title, every_seconds: every } });
      }
      continue;
    }
    // `at` must be strictly future when the host accepts it; leave headroom
    // for the serialized queue.
    if (due > now + 5_000) {
      steps.push({ legacy: reminder, action: "create", request: { prompt: reminder.prompt, title, at: new Date(due).toISOString() } });
    } else if (now - due <= CATCH_UP_MS) {
      steps.push({ legacy: reminder, action: "create", request: { prompt: reminder.prompt, title, after_seconds: 60 } });
    } else {
      steps.push({ legacy: reminder, action: "skip", reason: `was due ${new Date(due).toISOString()}, more than a day ago` });
    }
  }
  return steps;
}

type MarkerEntry = { status: "created" | "present" | "skipped"; hostId?: string; at: string; reason?: string };
type MarkerFile = { version: 1; sessions: Record<string, Record<string, MarkerEntry>> };

function readMarker(file: string): MarkerFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as MarkerFile;
    if (parsed && parsed.version === 1 && typeof parsed.sessions === "object" && parsed.sessions) return parsed;
  } catch {
    // Missing or unreadable: nothing handled yet.
  }
  return { version: 1, sessions: {} };
}

function writeMarker(file: string, marker: MarkerFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type MigrationReport = {
  created: Array<{ legacyId: string; hostId: string; scheduledAt: string }>;
  present: string[];
  skipped: Array<{ legacyId: string; reason: string }>;
};

/**
 * Recreate the Session's pending legacy reminders in the Host table, once.
 * The marker is written after every successful create, so a failure part-way
 * leaves the rest for the next start and never duplicates what went through.
 */
export async function migrateLegacyReminders(options: {
  schedule: HostSchedule;
  sessionId: string;
  events: Iterable<EventLike>;
  markerPath: string;
  now?: () => number;
}): Promise<MigrationReport> {
  const now = options.now ?? Date.now;
  const report: MigrationReport = { created: [], present: [], skipped: [] };
  const legacy = foldLegacyReminders(options.events);
  if (legacy.length === 0) return report;

  const marker = readMarker(options.markerPath);
  const done = (marker.sessions[options.sessionId] ??= {});
  const steps = planLegacyMigration(legacy, await options.schedule.list({ sessionId: options.sessionId }),
    new Set(Object.keys(done)), now());
  for (const step of steps) {
    const at = new Date(now()).toISOString();
    if (step.action === "create") {
      const task = await options.schedule.create(options.sessionId, step.request);
      done[step.legacy.id] = { status: "created", hostId: task.id, at };
      report.created.push({ legacyId: step.legacy.id, hostId: task.id, scheduledAt: task.scheduledAt });
    } else if (step.action === "present") {
      done[step.legacy.id] = { status: "present", at };
      report.present.push(step.legacy.id);
    } else {
      done[step.legacy.id] = { status: "skipped", at, reason: step.reason };
      report.skipped.push({ legacyId: step.legacy.id, reason: step.reason });
    }
    writeMarker(options.markerPath, marker);
  }
  return report;
}
