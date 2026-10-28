/**
 * Alarms for the WeChat bot, part of 全天候秘书: urgent reminders in a Reminders
 * list of the bot's own ("规划 闹钟" for a calendar named 规划). Reminders rings
 * an urgent reminder like an alarm on the device Find My uses as the owner's
 * location — usually the iPhone; other devices only show a notification — and
 * iCloud carries it there, so it rings even when WeChat would not let the bot
 * write first (the ~24 h window after the owner's last message).
 *
 * The helper app does the work (native/macos-calendar/main.swift, the alarm
 * commands, through the private ReminderKit). This file is the plugin side:
 * the list, the three tools, and the two buttons on the settings card
 * (一键授权, 测试闹钟).
 *
 * What the Mac cannot do for the owner, which the card says:
 * - The phone has its own permission: Reminders on the iPhone asks to allow
 *   urgent alarms only the first time someone marks a reminder urgent there by
 *   hand. Until then an alarm is saved and synced but does not ring.
 * - Both Mac permissions (calendar, reminders) are asked for when the switch
 *   goes on or 一键授权 is pressed, never later behind the owner's back: a
 *   prompt nobody is at the Mac to answer is a feature that silently stops.
 *
 * Planning alarms day by day is not in here on purpose: the owner sets that up
 * with the bot in chat, as a daily 「任务」 reminder with their own rules
 * (prompt.ts, G5).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { logger } from "./ilink/util/logger.js";
import { USER_TIME_ZONE, zonedDate, zonedStamp, zonedWeekday } from "./localtime.js";
import {
  HELPER_NAME, notOwnerReason,
  type AuthorizePlan, type CalendarHelper, type CalendarToolDeps, type HelperResponse,
} from "./mac-calendar.js";
import { cardRequestAllowed } from "./secretary.js";

export type AlarmInfo = { id: string; title: string; due?: string; urgent: boolean; completed: boolean; notes?: string };

/** A wall-clock time in the owner's zone, as the tools and the helper write it. */
type Wall = { y: number; m: number; d: number; h: number; mi: number };

const wallFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: USER_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function wallOf(at: Date): Wall {
  const parts = Object.fromEntries(wallFormat.formatToParts(at).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** The owner's UTC offset at `at`, in minutes. */
function offsetAt(at: Date): number {
  const minute = Math.floor(at.getTime() / 60_000) * 60_000;
  const w = wallOf(new Date(minute));
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - minute) / 60_000);
}

/** "2026-10-23T07:00" back into its parts. */
function parseWall(text: string): Wall {
  const [date, time] = text.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return { y, m, d, h, mi };
}

const sameWall = (a: Wall, b: Wall): boolean => a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.mi === b.mi;

/**
 * Every instant a wall-clock time in the owner's zone names, earliest first:
 * none for a time that does not exist there (2026-02-30, or the hour skipped
 * when the clocks go forward), two in the hour repeated when they go back.
 */
export function zonedInstants(w: Wall): Date[] {
  const local = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const found = new Set<number>();
  // The offsets in force within a day either side cover both sides of any change.
  for (const probe of [-86_400_000, -43_200_000, 0, 43_200_000, 86_400_000]) {
    const at = local - offsetAt(new Date(local + probe)) * 60_000;
    if (sameWall(wallOf(new Date(at)), w)) found.add(at);
  }
  return [...found].sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * The instant a wall-clock time in the owner's zone names, or undefined for a
 * time that does not exist there. In the hour the clocks go back it is the
 * first of the two: Reminders keeps a wall clock and reads it back that way.
 */
export function zonedInstant(w: Wall): Date | undefined {
  return zonedInstants(w)[0];
}

/**
 * "2026-10-23 07:00" / "2026-10-23T07:00" (seconds ignored); a date alone is
 * not an alarm time. `repeated` is the second instant of a wall time that
 * happens twice (the hour the clocks go back).
 */
export function parseAlarmTime(text: string): { wall: string; at: Date; repeated?: Date } | { error: "format" | "invalid" } {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(text);
  if (m === null) return { error: "format" };
  const w: Wall = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) };
  if (w.m < 1 || w.m > 12 || w.d < 1 || w.d > 31 || w.h > 23 || w.mi > 59) return { error: "invalid" };
  const all = zonedInstants(w);
  if (all.length === 0) return { error: "invalid" };
  const pad = (n: number) => String(n).padStart(2, "0");
  return { wall: `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`, at: all[0], ...(all.length > 1 ? { repeated: all[1] } : {}) };
}

/** "2026-10-23T07:00": a wall-clock time in the owner's zone, as the helper takes it. */
export function wallText(at: Date): string {
  const w = wallOf(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/**
 * When a due time the helper reported happens, as the owner reads it: its own
 * wall clock ("10-23 周五 07:00"), not one worked out again here. macOS and Node
 * ship time-zone rules of their own, and Reminders rings by macOS's.
 */
export function dueWhen(due: string, now: Date = new Date()): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(due);
  if (m === null || m[0].endsWith("Z")) {
    const at = new Date(due);
    return Number.isNaN(at.getTime()) ? "（没有时间）" : alarmWhen(at, now);
  }
  return `${m[1].slice(0, 4) === zonedDate(now).slice(0, 4) ? m[1].slice(5) : m[1]} ${zonedWeekday(m[1])} ${m[2]}`;
}

/**
 * An instant as the helper takes it: ISO 8601 with the owner's offset
 * ("2026-10-25T01:30:00+01:00"). Unlike a bare wall clock it cannot be read
 * as the other one of two: sent only for a time in the hour the clocks go
 * back. Everything else goes as a wall clock (wallText), so the instant is
 * worked out with macOS's own time-zone rules, the ones Reminders rings by.
 */
export function isoAt(at: Date): string {
  const w = wallOf(at);
  const off = offsetAt(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const abs = Math.abs(off);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:00${off < 0 ? "-" : "+"}${pad(Math.trunc(abs / 60))}:${pad(abs % 60)}`;
}

/** "10-23 周五 07:00"; with the year when it is not this year ("2027-10-24 周日 06:30"), so a year slip shows. */
export function alarmWhen(at: Date, now: Date = new Date()): string {
  const stamp = zonedStamp(at);
  const day = zonedDate(at);
  return `${day.slice(0, 4) === zonedDate(now).slice(0, 4) ? stamp.slice(0, 5) : day} ${zonedWeekday(day)} ${stamp.slice(6)}`;
}

/** An empty value means "not given" (some models fill every optional field with ""). */
function given(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * One alarm to set: `wall` is what goes to the helper ("2026-10-23T07:00"),
 * `at` the instant it names here, `repeated` that the wall time happens twice
 * (the hour the clocks go back), when `at` — its first instant — goes instead.
 */
export type AlarmInput = { at: Date; wall: string; repeated?: boolean; title: string; notes?: string };

/** One plain result for the tools and the card. */
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

function isAlarm(value: unknown): value is AlarmInfo {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" && (value as { id: string }).id !== "";
}

/** The alarms in a helper answer, whatever shape it came in. */
function alarmsOf(res: HelperResponse): AlarmInfo[] {
  return (Array.isArray(res.alarms) ? res.alarms : []).filter(isAlarm).map((a) => ({
    ...a, title: typeof a.title === "string" ? a.title : "", urgent: a.urgent === true, completed: a.completed === true,
    ...(typeof a.due === "string" ? { due: a.due } : { due: undefined }),
  }));
}

const timeOf = (a: AlarmInfo): number => (a.due === undefined ? Number.NaN : new Date(a.due).getTime());

/** Alarms whose time passed this long ago are marked done (see tidy). */
const TIDY_AFTER_MS = 2 * 3_600_000;

/** The alarm list and what goes in it, for the tools and the card alike. */
export class AlarmService {
  /** Adds run one at a time: the look for the same alarm and the add must not interleave. */
  private adding: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly helper: CalendarHelper,
    /** The dedicated calendar's name, read live (hot field). */
    private readonly baseName: () => string,
  ) {}

  /** "规划 闹钟": the name a new list gets, after the bot's own calendar. Empty before that has a name. */
  listName(): string {
    const base = this.baseName().trim();
    return base === "" ? "" : `${base} 闹钟`;
  }

  /**
   * The list's name as Reminders has it. Once made, the list is the one
   * remembered by id, even after the calendar is renamed on the card: a new
   * list would strand the alarms already set in the old one.
   */
  shownName(): string {
    return this.helper.alarmList()?.name || this.listName();
  }

  /** A helper failure as a sentence the owner (or the model) can act on; `op` is what was being done. */
  explain(res: HelperResponse, op: "set" | "cancel" | "list" = "list"): string {
    const code = String(res.code ?? "");
    const error = String(res.error ?? "");
    if (res.pending === true) {
      return `正在等 Mac 上的授权：屏幕上有「${HELPER_NAME}」的授权窗口，点「允许」之后再试。`;
    }
    if (code === "reminders_not_authorized") {
      if (error === "notDetermined") {
        return "还没授权「提醒事项」，闹钟设不了：到 Mac 前，在设置卡片「全天候秘书」上点「一键授权」，在弹出的窗口里点「允许」。";
      }
      if (error === "denied") return `「提醒事项」的授权被拒绝了：在 Mac 的 系统设置 → 隐私与安全 → 提醒事项 里打开「${HELPER_NAME}」。`;
      return `「${HELPER_NAME}」没有「提醒事项」的完全访问权限（${error}）：在 Mac 的 系统设置 → 隐私与安全 → 提醒事项 里打开它。`;
    }
    if (code === "bad_request" && /unknown command/.test(error)) {
      return `Mac 上的「${HELPER_NAME}」还是旧版，没有闹钟功能：到 Mac 前在设置卡片「全天候秘书」上点「一键授权」更新它（会再弹出两次授权，都点「允许」）。`;
    }
    if (code === "reminderkit_missing") {
      return `这台 Mac 的「提醒事项」没有紧急提醒（要 macOS 26.2 或更新；也可能是系统更新改了接口），闹钟用不了；日历不受影响。${error ? `（${error}）` : ""}`;
    }
    if (code === "no_icloud") return "「提醒事项」里没有登录 iCloud：闹钟要靠 iCloud 才能到 iPhone 上响。";
    if (code === "no_urgent") return "这个 iCloud 账户不支持紧急提醒，闹钟设不了。";
    if (code === "past") return "这个时间已经过了。";
    if (code === "ambiguous") return "这个钟点正赶上夏令时结束、时钟往回拨的那一小时（一天里有两次），闹钟只能定在第一次：换一个这一小时以外的时间。";
    if (code === "no_alarm") return "这个闹钟已经不在清单里了（可能在 iPhone 上删掉或完成了）：先用 alarm_list 再看一下。";
    if (code === "timeout" || code === "no_response") {
      if (op === "set") return `${error}。闹钟可能已经设上了：先用 alarm_list 看一下；再设一次也没关系，同一时间、同一标题的不会设两个。`;
      if (op === "cancel") return `${error}。闹钟可能已经取消了：先用 alarm_list 看一下，再决定要不要重试。`;
      return `${error}，稍后再试。`;
    }
    if (code === "deadline") return "这次太慢，到时限前停下了，什么都没改，可以再试一次。";
    if (code === "stopped") return "这一轮被停了，闹钟没有动。";
    return `闹钟操作失败：${error || code || "未知原因"}`;
  }

  private async run(request: Record<string, unknown>, signal?: AbortSignal): Promise<HelperResponse> {
    let res: HelperResponse;
    try {
      res = await this.helper.call(request, 30_000, signal);
    } catch (err) {
      return { ok: false, code: "error", error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    // The helper checks the permission before ReminderKit. On a macOS without urgent
    // reminders nothing ever asks for Reminders access (一键授权 skips it), so "not
    // authorized" there is not something 一键授权 or System Settings could fix.
    if (res.code === "reminders_not_authorized" && res.pending !== true) {
      const status = await this.helper.status().catch(() => undefined);
      if (status?.alarms === "unsupported") return { ok: false, code: "reminderkit_missing", error: "" };
    }
    return res;
  }

  /** The list, made on first use and then kept by id. */
  async ensureList(signal?: AbortSignal): Promise<Outcome<{ id: string; name: string; account: string; created: boolean; adopted: boolean }>> {
    const name = this.listName();
    if (name === "") return { ok: false, message: "专用日历还没起名字：在设置卡片「全天候秘书」里填上再试。" };
    const known = this.helper.alarmList();
    // By id, whatever the card's name is now (see shownName). The helper falls
    // back to the name, then to a new list, when that one was deleted.
    const res = await this.run({ cmd: "ensureAlarmList", name, ...(known !== null ? { knownId: known.id } : {}) }, signal);
    if (!res.ok) return { ok: false, message: this.explain(res) };
    const list = res.list as { id?: unknown; name?: unknown; account?: unknown } | undefined;
    if (list === undefined || typeof list.id !== "string" || list.id === "") {
      return { ok: false, message: "闹钟操作失败：小程序的回答不完整（没有清单），可能要在设置卡片上点「一键授权」更新它。" };
    }
    const record = {
      name: typeof list.name === "string" && list.name !== "" ? list.name : name,
      id: list.id,
      account: typeof list.account === "string" ? list.account : "",
    };
    this.helper.rememberAlarmList(record);
    if (res.created === true) logger.info(`alarms: created the reminders list 「${record.name}」 in ${record.account || "iCloud"}`);
    if (res.adopted === true) logger.info(`alarms: using the existing reminders list 「${record.name}」`);
    return { ok: true, value: { ...record, created: res.created === true, adopted: res.adopted === true } };
  }

  /**
   * Run commands on the list; a list that has disappeared is made again, once.
   * `step` gets the list's id and answers with the helper's response.
   */
  private async onList<T>(
    step: (listId: string) => Promise<{ res: HelperResponse; op: "set" | "cancel" | "list"; value?: T }>,
    signal?: AbortSignal,
  ): Promise<Outcome<{ res: HelperResponse; value?: T; listId: string }>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const list = await this.ensureList(signal);
      if (!list.ok) return list;
      const { res, op, value } = await step(list.value.id);
      if (res.ok) return { ok: true, value: { res, ...(value === undefined ? {} : { value }), listId: list.value.id } };
      if (res.code !== "no_list" || attempt > 0) return { ok: false, message: this.explain(res, op) };
    }
    return { ok: false, message: "闹钟清单找不到了" };
  }

  /**
   * Alarms that rang a couple of hours ago stay open in Reminders (ringing
   * does not complete them) and would pile up there as overdue: mark them
   * done, in the background. Only the alarms this plugin set itself: a list
   * adopted by its name may also hold the owner's own to-dos, all-day ones, or
   * one the owner made repeat — none of them the bot's to tick off. An older
   * helper without the command just skips it.
   */
  private tidy(alarms: readonly AlarmInfo[], listId: string): void {
    const cutoff = Date.now() - TIDY_AFTER_MS;
    const ours = this.helper.createdAlarms();
    const ids = alarms.filter((a) => !a.completed && a.urgent && ours.has(a.id) && timeOf(a) < cutoff).map((a) => a.id);
    if (ids.length === 0) return;
    void this.run({ cmd: "alarmComplete", listId, ids }).then((res) => {
      if (!res.ok) return;
      this.helper.forgetCreatedAlarms(ids);
      logger.info(`alarms: marked ${String(res.completed ?? ids.length)} alarm(s) that rang hours ago as done`);
    });
  }

  /**
   * Set one alarm, unless the same one (same minute, same title) is already
   * set: a retry after a timeout, or a routine that runs twice, then finds it
   * instead of ringing the owner twice.
   */
  add(input: AlarmInput, signal?: AbortSignal): Promise<Outcome<AlarmInfo & { existing?: boolean }>> {
    const run = this.adding.then(() => this.addNow(input, signal));
    this.adding = run.catch(() => undefined);
    return run;
  }

  private async addNow(input: AlarmInput, signal?: AbortSignal): Promise<Outcome<AlarmInfo & { existing?: boolean }>> {
    let seen: AlarmInfo[] = [];
    let existing = false;
    const done = await this.onList<AlarmInfo>(async (listId) => {
      const listed = await this.run({ cmd: "alarms", listId }, signal);
      if (!listed.ok) return { res: listed, op: "list" };
      seen = alarmsOf(listed);
      // Compared by the wall clock the helper reports: an instant worked out here may differ from macOS's.
      const same = seen.find((a) => !a.completed && a.due?.slice(0, 16) === input.wall && a.title === input.title);
      if (same !== undefined) {
        existing = true;
        return { res: listed, op: "list", value: same };
      }
      const res = await this.run({
        cmd: "alarmAdd", listId, due: input.repeated === true ? isoAt(input.at) : input.wall, title: input.title,
        ...(input.notes ? { notes: input.notes } : {}),
      }, signal);
      return { res, op: "set", ...(isAlarm(res.alarm) ? { value: res.alarm } : {}) };
    }, signal);
    if (!done.ok) return done;
    this.tidy(seen, done.value.listId);
    const alarm = done.value.value;
    if (alarm === undefined) return { ok: false, message: "闹钟可能设上了，但小程序的回答不完整：先用 alarm_list 看一下。" };
    const value = {
      ...alarm, title: typeof alarm.title === "string" ? alarm.title : input.title,
      urgent: alarm.urgent === true, completed: alarm.completed === true,
    };
    if (existing) return { ok: true, value: { ...value, existing: true } };
    this.helper.rememberCreatedAlarm(value.id);
    logger.info("alarm_set: one alarm added");
    return { ok: true, value };
  }

  async list(signal?: AbortSignal): Promise<Outcome<AlarmInfo[]>> {
    const done = await this.onList(async (listId) => ({ res: await this.run({ cmd: "alarms", listId }, signal), op: "list" }), signal);
    if (!done.ok) return done;
    const alarms = alarmsOf(done.value.res);
    this.tidy(alarms, done.value.listId);
    return { ok: true, value: alarms };
  }

  async remove(id: string, signal?: AbortSignal): Promise<Outcome<AlarmInfo>> {
    const done = await this.onList(async (listId) => ({ res: await this.run({ cmd: "alarmDelete", listId, id }, signal), op: "cancel" }), signal);
    if (!done.ok) return done;
    logger.info("alarm_cancel: one alarm removed");
    const gone = done.value.res.alarm;
    return { ok: true, value: isAlarm(gone) ? gone : { id, title: "", urgent: false, completed: false } };
  }
}

// -------------------------------------------------------------------- tools

export type AlarmToolDeps = Pick<CalendarToolDeps, "config" | "getAccount" | "activeSender"> & { alarms: AlarmService };

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean", required: true }, summary: { type: "string", required: true } },
} as const;

const HANDLE_LIMIT = 500;

export function registerAlarmTools(agentCtx: Context, deps: AlarmToolDeps): void {
  const alarms = deps.alarms;
  /** Alarms shown this process lifetime, by the short handle the model uses. */
  const handles = new Map<string, { id: string; title: string; due?: string }>();

  const remember = (a: AlarmInfo): string => {
    const digest = createHash("sha1").update(a.id).digest("hex");
    let len = 8;
    let tag = `a${digest.slice(0, len)}`;
    while (handles.has(tag) && handles.get(tag)!.id !== a.id && len < digest.length) tag = `a${digest.slice(0, ++len)}`;
    handles.delete(tag);
    handles.set(tag, { id: a.id, title: a.title, ...(a.due === undefined ? {} : { due: a.due }) });
    while (handles.size > HANDLE_LIMIT) handles.delete(handles.keys().next().value as string);
    return tag;
  };

  const line = (a: AlarmInfo): string => {
    const when = a.due === undefined ? "（没有时间）" : dueWhen(a.due);
    return `${when}「${a.title || "(无标题)"}」${a.urgent ? "" : "（不是紧急提醒，只会通知、不会像闹钟一样响）"} #${remember(a)}`;
  };

  agentCtx.tools.register(
    defineTool({
      name: "alarm_set",
      description:
        "Set an alarm for the owner: an urgent reminder in the bot's own alarm list in the Reminders app. At that time it "
        + "rings like an alarm on the device Find My uses as the owner's location (usually their iPhone), and it does not "
        + "go through WeChat, so it rings even when a WeChat message could not reach them. Use it when the owner asks for "
        + "an alarm or a wake-up call (闹钟, 叫醒, 定个闹钟), or wants something at an exact time to ring rather than just a "
        + "message (a flight, an exam). A plain \"remind me to…\" stays a WeChat reminder (schedule_create); a block of "
        + "time goes in the calendar. The same time with the same title is never set twice (it answers that it is already "
        + "set), so retrying, or a routine that plans alarms, can simply set what it wants. To move an alarm, set the new "
        + "time first, then cancel the old one. Say back the time it will ring, as the result gives it. If the owner says "
        + "one did not ring: that iPhone must be on iOS 26.2 or later; Reminders there must be allowed to ring alarms "
        + "(Settings → Apps → Reminders → Alarms; it also asks the first time a reminder is marked urgent there by hand); "
        + "and Find My's My Location must be that iPhone.",
      parameters: {
        time: { type: "string", required: true, description: "When it rings: a date and a time of day in the owner's time zone, e.g. 2026-10-23 07:00." },
        title: { type: "string", description: "What it is for, shown when it rings, e.g. 起床. Default 闹钟." },
        note: { type: "string", description: "Details shown with it, if any." },
      },
      output: { schema: SUMMARY_SCHEMA, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(args, exec) {
        const refused = notOwnerReason(deps, "闹钟");
        if (refused !== undefined) return { ok: false, summary: refused };
        const raw = args as { time?: string; title?: string; note?: string };
        const time = given(raw.time);
        if (time === undefined) return { ok: false, summary: "要给出响的时间：日期加几点几分，例如 2026-10-23 07:00。" };
        const parsed = parseAlarmTime(time);
        if ("error" in parsed) {
          return {
            ok: false,
            summary: parsed.error === "format"
              ? `看不懂「${time}」：要写成 2026-10-23 07:00 这样，日期加几点几分（闹钟一定要有钟点）。`
              : `「${time}」不是一个真实存在的时间（日期不存在，或正赶上夏令时跳过的那一小时）。`,
          };
        }
        const soon = Date.now() + 30_000;
        if (parsed.repeated !== undefined && parsed.at.getTime() <= soon && parsed.repeated.getTime() > soon) {
          // Reminders keeps a wall clock, and reads a repeated one as the first: the second cannot be set.
          return { ok: false, summary: `${parsed.wall.slice(11)} 正赶上夏令时结束、时钟往回拨的那一小时，今天有两次，第一次已经过了；闹钟只能定在第一次，换一个这一小时以外的时间。` };
        }
        if (parsed.at.getTime() <= soon) {
          return { ok: false, summary: `${alarmWhen(parsed.at)} 已经过了（或离现在不到半分钟）：给一个以后的时间。` };
        }
        if (parsed.at.getTime() > Date.now() + 400 * 86_400_000) {
          return { ok: false, summary: "闹钟最多设到一年多以后；更远的事先记进日历。" };
        }
        const title = given(raw.title) ?? "闹钟";
        const note = given(raw.note);
        const res = await alarms.add({
          at: parsed.at, wall: parsed.wall, repeated: parsed.repeated !== undefined, title, ...(note === undefined ? {} : { notes: note }),
        }, exec?.signal);
        if (!res.ok) return { ok: false, summary: res.message };
        const a = res.value;
        if (a.existing === true) return { ok: true, summary: `这个闹钟已经设过了：${line(a)}，没有再设一个。` };
        return {
          ok: true,
          summary: `已设闹钟：${line(a)}，在「${alarms.shownName()}」清单里。`
            + (a.urgent ? "" : "\n注意：没能设成紧急提醒，到点只会弹通知；把这个告诉机主。"),
        };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "alarm_list",
      description:
        "The alarms in the bot's alarm list that have not rung yet, soonest first, each with a handle like #a3f9a2b1 for "
        + "alarm_cancel (also any without a time, and any whose time passed but that are still open). Check it before "
        + "changing alarms and to answer which alarms are set — never from memory.",
      parameters: {},
      output: { schema: SUMMARY_SCHEMA, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(_args, exec) {
        const refused = notOwnerReason(deps, "闹钟");
        if (refused !== undefined) return { ok: false, summary: refused };
        const res = await alarms.list(exec?.signal);
        if (!res.ok) return { ok: false, summary: res.message };
        const now = Date.now();
        const open = res.value.filter((a) => !a.completed);
        const upcoming = open.filter((a) => timeOf(a) > now).sort((x, y) => timeOf(x) - timeOf(y));
        const timeless = open.filter((a) => Number.isNaN(timeOf(a)));
        const passed = open.filter((a) => timeOf(a) <= now).sort((x, y) => timeOf(y) - timeOf(x));
        const shown = upcoming.slice(0, 30);
        const lines = [
          upcoming.length === 0
            ? `「${alarms.shownName()}」里没有还没响的闹钟。`
            : `还没响的闹钟（${upcoming.length} 个）：`,
          ...shown.map((a) => `• ${line(a)}`),
        ];
        if (upcoming.length > shown.length) lines.push(`（还有 ${upcoming.length - shown.length} 个更晚的没列出）`);
        if (timeless.length > 0) {
          lines.push(`没有时间、不会响的（${timeless.length} 个）：`, ...timeless.slice(0, 10).map((a) => `• ${line(a)}`));
        }
        if (passed.length > 0) {
          lines.push(`时间已经过了、还没勾掉的（${passed.length} 个）：`, ...passed.slice(0, 10).map((a) => `• ${line(a)}`));
        }
        return { ok: true, summary: lines.join("\n") };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "alarm_cancel",
      description:
        "Cancel one alarm, named by its handle (#a…) from alarm_list or alarm_set. To move an alarm, set the new one "
        + "first, then cancel the old one.",
      parameters: {
        alarm: { type: "string", required: true, description: "The handle, e.g. #a3f9a2b1." },
      },
      output: { schema: SUMMARY_SCHEMA, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(args, exec) {
        const refused = notOwnerReason(deps, "闹钟");
        if (refused !== undefined) return { ok: false, summary: refused };
        const tag = (given((args as { alarm?: string }).alarm) ?? "").replace(/^[#＃]/, "").toLowerCase();
        const known = handles.get(tag);
        if (known === undefined) return { ok: false, summary: `不认识 #${tag}：先用 alarm_list 看一下，用那里给的编号。` };
        const res = await alarms.remove(known.id, exec?.signal);
        if (!res.ok) return { ok: false, summary: res.message };
        handles.delete(tag);
        return { ok: true, summary: `已取消闹钟：${known.due === undefined ? "" : dueWhen(known.due)}「${known.title}」。` };
      },
    }),
  );
}

// ------------------------------------------------------------ card buttons

type WebServerLike = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

export const AUTHORIZE_PATH = "/plugins/clawbot/secretary/authorize";
export const TEST_ALARM_PATH = "/plugins/clawbot/secretary/test-alarm";

/** Two minutes from now at least, on a whole minute. */
export function testAlarmTime(now: Date = new Date()): Date {
  return new Date(Math.ceil((now.getTime() + 120_000) / 60_000) * 60_000);
}

/** What the test alarm says when it rings: what to check on the phone if it did not. */
export const TEST_ALARM_NOTE = "像闹钟一样响了，就说明一切就绪，这条可以删掉。没响的话看 iPhone：①「设置 → 你的名字 → 查找 → 我的位置」"
  + "要是这台 iPhone（紧急提醒只在这台设备上像闹钟一样响）；②「设置 → App → 提醒事项」里的「闹钟」要开着，没有这一项就在「提醒事项」里"
  + "手动把一条提醒设成紧急一次，允许弹出的授权；③iPhone 要 iOS 26.2 或更新。";

/** A test alarm at most this often: each one rings the owner's phone. */
const TEST_ALARM_EVERY_MS = 60_000;
let lastTestAlarmAt = 0;

type CardRouteDeps = {
  helper: CalendarHelper;
  alarms: AlarmService;
  /** The 全天候秘书 switch (macCalendar), read live. */
  enabled: () => boolean;
};

/**
 * POST /plugins/clawbot/secretary/authorize — 一键授权: replace an outdated
 * helper and put up every permission prompt still open (calendar, reminders),
 * while the owner is at the Mac. Answers at once with what it is doing (the
 * plan); the card follows the status.
 *
 * POST /plugins/clawbot/secretary/test-alarm — 测试闹钟: an urgent reminder two
 * minutes out, so the owner hears the phone ring before walking away.
 *
 * Plugin routes are not behind DSH's login cookie, so both take only what the
 * card itself sends (see cardRequestAllowed).
 */
export async function handleCardRoute(kind: "authorize" | "test", req: IncomingMessage, res: ServerResponse, deps: CardRouteDeps): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? "GET") !== "POST") return reply(405, { ok: false, message: "use POST" });
  if (!cardRequestAllowed(req)) return reply(403, { ok: false, message: "只接受设置卡片发来的请求" });
  if (process.platform !== "darwin") return reply(400, { ok: false, message: "只支持 macOS" });
  if (!deps.enabled()) return reply(409, { ok: false, message: "先打开「全天候秘书」" });
  if (kind === "authorize") {
    let plan: AuthorizePlan;
    try {
      plan = await deps.helper.authorizePlan();
    } catch (err) {
      plan = { ask: [], denied: [], error: (err instanceof Error ? err.message : String(err)).slice(0, 240) };
    }
    // A helper that does not answer may just need its update: let the forced round try.
    const started = plan.build !== undefined || plan.ask.length > 0 || plan.error !== undefined;
    if (started) {
      void deps.helper.prepare(true).catch((err: unknown) =>
        logger.warn(`calendar: 一键授权 failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`));
    }
    deps.helper.invalidateStatus();
    logger.info(`calendar: 一键授权 pressed on the settings card (${started ? [plan.build, ...plan.ask].filter(Boolean).join(", ") || "retrying" : "nothing to ask"})`);
    return reply(200, { ok: true, started, plan });
  }
  const wait = lastTestAlarmAt + TEST_ALARM_EVERY_MS - Date.now();
  if (wait > 0) return reply(429, { ok: false, message: `刚设过一个测试闹钟，${Math.ceil(wait / 1000)} 秒后再试` });
  // Claimed before waiting on the helper: two presses at once must not both ring.
  const claimed = Date.now();
  lastTestAlarmAt = claimed;
  const at = testAlarmTime();
  const wall = wallText(at);
  if (zonedInstants(parseWall(wall)).length > 1) {
    // Two minutes from now falls in the hour the clocks go back: a wall time there names two instants.
    lastTestAlarmAt = 0;
    return reply(200, { ok: false, message: "时钟正在往回拨（夏令时结束）：过了这一小时再点「测试闹钟」" });
  }
  const made = await deps.alarms.add({ at, wall, title: "全天候秘书测试闹钟", notes: TEST_ALARM_NOTE });
  if (!made.ok) {
    if (lastTestAlarmAt === claimed) lastTestAlarmAt = 0;
    return reply(200, { ok: false, message: made.message });
  }
  const due = made.value.due === undefined ? at : new Date(made.value.due);
  return reply(200, {
    ok: true,
    at: zonedStamp(Number.isNaN(due.getTime()) ? at : due).slice(6),
    list: deps.alarms.shownName(),
    urgent: made.value.urgent,
  });
}

export function registerCardRoutes(ctx: Context, deps: CardRouteDeps): void {
  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;
    scoped.effect(
      () => server.register({ kind: "exact", path: AUTHORIZE_PATH, handler: (req, res) => handleCardRoute("authorize", req, res, deps) }),
      "clawbot: secretary authorize route",
    );
    scoped.effect(
      () => server.register({ kind: "exact", path: TEST_ALARM_PATH, handler: (req, res) => handleCardRoute("test", req, res, deps) }),
      "clawbot: secretary test-alarm route",
    );
  });
}
