/**
 * Messages WeChat would not let the bot send, kept and delivered later as one.
 *
 * iLink lets a bot write first only for a while after the user's last message.
 * In this owner's logs every `sendMessage ret=-2 errmsg=prepare failed` came
 * 24.8–53 h after their last message and every delivered reminder within
 * 20.5 h; the vendored api.ts says the same (agent-initiated sends need a
 * context token that only a recent inbound message refreshes). A reminder that
 * fired later than that, or a Claude/Codex notification, was simply lost, and
 * send_wechat_text had already told the model it was sent.
 *
 * Now such a message waits here, on disk, and goes out after the bot has
 * answered the user's next message: one message that lists everything in time
 * order and marks when each part was due, then any files.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { zonedDate, zonedDatePlus, zonedStamp, zonedWeekday } from "./localtime.js";
import { logger } from "./ilink/util/logger.js";

/** Who sent a notification: Claude Code or Codex (MCP), or a DSH conversation (notify_wechat). */
export type NoticeSource = "Claude" | "Codex" | "DSH";

export type BacklogItem =
  /** A text the bot sent (a reminder, or any reply) that did not get through. */
  | { id: string; kind: "text"; at: string; text: string }
  /** A notification from Claude, Codex or another DSH conversation (`origin` names it), kept as one sentence. */
  | { id: string; kind: "notice"; at: string; source: NoticeSource; origin?: string; summary: string }
  /**
   * A file or image, sent again after the digest if it still exists. Once a
   * digest has said it follows (`announced`), later deliveries only retry it.
   */
  | { id: string; kind: "file"; at: string; path: string; caption?: string; original?: boolean; attempts?: number; announced?: boolean };

/** What callers hand in; the backlog stamps the id. */
export type NewBacklogItem =
  | { kind: "text"; at: string; text: string }
  | { kind: "notice"; at: string; source: NoticeSource; origin?: string; summary: string }
  | { kind: "file"; at: string; path: string; caption?: string; original?: boolean };

/** Items kept per recipient; the oldest go first beyond this. */
export const BACKLOG_LIMIT = 100;

/** A digest message is split at entry boundaries beyond this many characters. */
export const DIGEST_MAX_CHARS = 3000;

/** Deliveries a kept file gets before it is given up (a CDN or network failure each time). */
export const FILE_ATTEMPTS = 3;

/** Whether a send failed because WeChat will not let the bot write first right now. */
export function isSendWindowClosed(err: unknown): boolean {
  return /\bret=-2\b/.test(err instanceof Error ? err.message : String(err));
}

/**
 * When a scheduled reminder was due, from the message dsh-schedule writes
 * (`occurrence_at: 2026-10-06T17:30:00.000Z`). A reminder that fired late (the
 * computer was asleep) is still stamped with its own time.
 */
export function occurrenceAt(text: string): string | undefined {
  const m = /^occurrence_at:\s*(\S+)\s*$/m.exec(text);
  if (m !== null) {
    const t = Date.parse(m[1]);
    return Number.isNaN(t) ? undefined : new Date(t).toISOString();
  }
  // A recurring reminder comes as a batch: `reminders_json: [{ occurrence_at, … }]`. The latest one.
  const batch = /^reminders_json:\s*(\[.*\])\s*$/m.exec(text);
  if (batch === null) return undefined;
  try {
    const times = (JSON.parse(batch[1]) as Array<{ occurrence_at?: unknown }>)
      .map((r) => (typeof r?.occurrence_at === "string" ? Date.parse(r.occurrence_at) : Number.NaN))
      .filter((t) => !Number.isNaN(t));
    return times.length === 0 ? undefined : new Date(Math.max(...times)).toISOString();
  } catch {
    return undefined;
  }
}

/** What each reminder in a scheduled message says (one, or a recurring batch). */
export function reminderPrompts(text: string): string[] {
  const one = /^reminder_prompt_json:\s*(".*")\s*$/m.exec(text);
  try {
    if (one !== null) {
      const prompt = JSON.parse(one[1]) as unknown;
      return typeof prompt === "string" ? [prompt] : [];
    }
    const batch = /^reminders_json:\s*(\[.*\])\s*$/m.exec(text);
    if (batch === null) return [];
    return (JSON.parse(batch[1]) as Array<{ reminder_prompt?: unknown }>)
      .map((r) => r?.reminder_prompt)
      .filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** A reminder that is a job for the bot (prompt rule G5.5): it starts with 「任务:」 or 「任务：」. */
export function isTaskPrompt(prompt: string): boolean {
  return /^\s*任务\s*[:：]/.test(prompt);
}

/** A scheduled message made only of 「任务」: it may end without a word to the owner. */
export function quietTask(text: string): boolean {
  const prompts = reminderPrompts(text);
  return prompts.length > 0 && prompts.every(isTaskPrompt);
}

/**
 * What a scheduled message asks for, for the reminder fallback: its reminder
 * prompts. If dsh-schedule ever changes the format, the message without its
 * machine lines instead, never nothing: a reminder that cannot be parsed is
 * still a reminder.
 */
export function scheduledReminders(text: string): string[] {
  const prompts = reminderPrompts(text);
  if (prompts.length > 0) return prompts;
  const rest = text
    .split("\n")
    .filter((line) => !/^\s*(\[SCHEDULE REMINDER\]|This is a scheduled message|schedule_id_json:|occurrence_at:|reminders_json:)/i.test(line))
    .join("\n")
    .trim();
  return rest === "" ? [] : [rest];
}

/** Why a failed turn (`turn/end` reason) failed, as the owner reads it. */
function failureLabel(reason: unknown): string {
  const kind = (reason as { kind?: unknown } | undefined)?.kind;
  if (kind === "max-tokens") return "模型的回复被截断了";
  if (kind === "blocked") return "模型请求被拦下了";
  switch ((reason as { error?: { code?: unknown } } | undefined)?.error?.code) {
    case "RATE_LIMIT": return "模型服务器太忙";
    case "TIMEOUT": return "模型响应超时";
    case "SERVER": return "模型服务器出错";
    case "TRANSPORT": return "连不上模型";
    case "EMPTY_RESPONSE": return "模型没有回复";
    case "QUOTA":
    case "ACCOUNT_QUOTA": return "模型额度用完了";
    case "INVALID_CREDENTIAL": return "模型的 key 不能用";
    default: return "模型暂时出错";
  }
}

/**
 * What the owner gets when a reminder's turn ended in an error before the bot
 * sent anything (the model was down): each reminder as it was set, and why it
 * reads plainer than usual.
 *
 * A 「任务」 is a job for the bot, not a line for the owner, so it is reported
 * as not done. If the turn had already started on it (`started`: it made tool
 * calls), it is reported as not finished.
 */
export function reminderFallbackText(prompts: readonly string[], reason?: unknown, started = false): string {
  const why = failureLabel(reason);
  const strip = (prompt: string, word: string): string => prompt.trim().replace(new RegExp(`^${word}\\s*[:：]\\s*`), "");
  const reminders = prompts.filter((p) => !isTaskPrompt(p)).map((p) => strip(p, "提醒"));
  const tasks = prompts.filter(isTaskPrompt).map((p) => strip(p, "任务"));
  const note = tasks.length === 0
    ? `（${why}，没能照常回复，这是提醒原文。）`
    : reminders.length === 0
      ? `（${why}。要补做的话跟我说一声。）`
      : `（${why}：提醒是原文；任务要补做的话跟我说一声。）`;
  return [
    ...reminders.map((r) => `提醒：${r}`),
    ...tasks.map((t) => `定时任务没${started ? "做完" : "做成"}：${t}`),
    note,
  ].join("\n");
}

/**
 * The line that goes with a scheduled message delivered on a later day than it
 * was due (the Mac slept, DSH was down), or undefined. The message reads the
 * same whenever it arrives and its only time is UTC, while the prompt's date
 * line says today: a nightly 「任务」 about "the next day" would plan the wrong
 * one. So the dates are worked out here, not left to the model.
 */
export function lateScheduleNote(text: string, now: Date = new Date()): string | undefined {
  const due = occurrenceAt(text);
  if (due === undefined) return undefined;
  const at = new Date(due);
  const day = zonedDate(at);
  if (day >= zonedDate(now)) return undefined;
  const next = zonedDatePlus(1, at);
  const label = (d: string): string => `${d.slice(5)} ${zonedWeekday(d)}`;
  return `[定时消息晚到] 上面这条定时消息原定 ${dueStamp(at)}，${dueStamp(now)} 才送到（电脑睡着了，或 DSH 没在运行）。`
    + `照原定那天算：内容里的「今天」是 ${label(day)}，「明天」「第二天」是 ${label(next)}；要设的闹钟、要排的日程，时间已经过了的就跳过。`;
}

/** What a file is called in the digest: 图片 or 文件, and its name. */
export function fileLabel(p: string): string {
  return `${IMAGE_EXT.test(p) ? "图片" : "文件"} ${path.basename(p)}`;
}

/** `10-13 周一 09:00` in the user's zone. */
export function dueStamp(at: Date): string {
  const stamp = zonedStamp(at);
  return `${stamp.slice(0, 5)} ${zonedWeekday(zonedDate(at))} ${stamp.slice(6)}`;
}

/**
 * One short sentence for a long notification when the sender gave no summary:
 * its first non-empty line, cut at the first sentence end, at most `max` chars.
 */
export function oneSentence(text: string, max = 60): string {
  const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "") ?? "";
  const s = line.replace(/[：:]\s*$/, "");
  const end = s.search(/[。！？!?]/);
  if (end >= 0 && end < max) return s.slice(0, end + 1);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i;

/**
 * The digest: one header sentence, then every item in time order with the time
 * it was due. Split into several messages at entry boundaries when long.
 */
export function formatDigest(
  items: readonly BacklogItem[],
  opts: { fileExists: (p: string) => boolean; maxChars?: number },
): string[] {
  return digestChunks(items, opts).map((chunk) => chunk.text);
}

/** The digest's messages, each with the ids of the items it carries (forgotten once it is out). */
export function digestChunks(
  items: readonly BacklogItem[],
  opts: { fileExists: (p: string) => boolean; maxChars?: number },
): Array<{ text: string; ids: string[] }> {
  const maxChars = opts.maxChars ?? DIGEST_MAX_CHARS;
  // A file an earlier digest already announced is only retried, not announced again.
  const sorted = [...items]
    .filter((item) => item.kind !== "file" || item.announced !== true)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (sorted.length === 0) return [];
  const entries = sorted.map((item) => {
    const due = `〔${dueStamp(new Date(item.at))}〕`;
    if (item.kind === "text") return `${due}\n${item.text}`;
    if (item.kind === "notice") {
      const from = item.origin === undefined ? item.source : `${item.source} 会话「${item.origin}」`;
      return `${due}${from}${item.origin === undefined ? " " : ""}的通知\n${item.summary}`;
    }
    const exists = opts.fileExists(item.path);
    const status = exists ? "（随后补发）" : "（文件已经不在了，没法补发）";
    // The file carries its own caption; when it is gone, the caption is all that is left.
    return `${due}${fileLabel(item.path)}${status}${!exists && item.caption ? `\n${item.caption}` : ""}`;
  });
  const header = `有 ${sorted.length} 条消息当时没能发出（微信不允许 bot 在你一段时间没说话时主动发消息），按原定时间补上：`;
  const chunks: Array<{ text: string; ids: string[] }> = [];
  let current = { text: header, ids: [] as string[] };
  entries.forEach((entry, i) => {
    const next = `${current.text}\n\n${entry}`;
    if (next.length > maxChars && current.ids.length > 0) {
      chunks.push(current);
      current = { text: entry, ids: [sorted[i].id] };
    } else {
      current = { text: next, ids: [...current.ids, sorted[i].id] };
    }
  });
  chunks.push(current);
  return chunks;
}

type BacklogFile = { version: 1; recipients: Record<string, BacklogItem[]> };

/** The kept messages, one list per recipient, in `<state dir>/backlog.json`. */
export class Backlog {
  constructor(private readonly file: string = path.join(resolveStateDir(), "backlog.json")) {}

  /** Keep one message for `to`. */
  add(to: string, item: NewBacklogItem): BacklogItem {
    const data = this.read();
    const list = data.recipients[to] ?? [];
    const kept = { ...item, id: randomUUID() } as BacklogItem;
    list.push(kept);
    if (list.length > BACKLOG_LIMIT) {
      const dropped = list.splice(0, list.length - BACKLOG_LIMIT);
      logger.warn(`backlog: more than ${BACKLOG_LIMIT} waiting for ${to}; dropped the ${dropped.length} oldest`);
    }
    data.recipients[to] = list;
    this.write(data);
    return kept;
  }

  /** What is waiting for `to`, oldest first. */
  peek(to: string): BacklogItem[] {
    return [...(this.read().recipients[to] ?? [])];
  }

  /** Count one more failed delivery of a kept file; returns the new count. */
  bumpAttempts(to: string, id: string): number {
    const data = this.read();
    const item = (data.recipients[to] ?? []).find((i) => i.id === id);
    if (item === undefined || item.kind !== "file") return 0;
    item.attempts = (item.attempts ?? 0) + 1;
    this.write(data);
    return item.attempts;
  }

  /** Note that a digest has told the user these files follow. */
  markAnnounced(to: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const data = this.read();
    const want = new Set(ids);
    for (const item of data.recipients[to] ?? []) if (item.kind === "file" && want.has(item.id)) item.announced = true;
    this.write(data);
  }

  /** Forget items once delivered (by id, so anything added meanwhile stays). */
  remove(to: string, ids: readonly string[]): void {
    const data = this.read();
    const gone = new Set(ids);
    const left = (data.recipients[to] ?? []).filter((item) => !gone.has(item.id));
    if (left.length > 0) data.recipients[to] = left;
    else delete data.recipients[to];
    this.write(data);
  }

  private read(): BacklogFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<BacklogFile>;
      if (parsed && typeof parsed === "object" && parsed.recipients && typeof parsed.recipients === "object") {
        return { version: 1, recipients: parsed.recipients };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(`backlog: unreadable ${this.file}: ${String(err)}`);
    }
    return { version: 1, recipients: {} };
  }

  private write(data: BacklogFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
