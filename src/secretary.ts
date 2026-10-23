/**
 * The rules of 全天候秘书 (the all-day secretary: the Mac calendar, alarms and
 * these rules behind one switch), until 2026-10-21 called 日程秘书: a short set
 * of planning rules the owner switches on in the settings card.
 *
 * The rules go into the long-term memory file (memory.md), not into this
 * plugin's prompt. Like a persona they belong to one owner, and in the memory
 * file the owner can read and rewrite them; the plugin's own prompt stays the
 * same for everyone and byte-stable. memory.md is read into every WeChat turn
 * whether or not auto-memory is on, so nothing else has to be enabled for the
 * rules to apply — except the Mac calendar, which the rules lean on.
 *
 * Switching off moves the section out of memory.md into a copy beside it, and
 * switching on again puts that copy back, so the owner's own edits survive a
 * round trip. Only an explicit switch changes the file: a start-up with the
 * switch off never deletes anything.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";
import { ensureMemoryFile, memoryFilePath } from "./memory.js";

export const SECRETARY_HEADING = "## 全天候秘书";
/**
 * The owner may retitle it ("## 全天候秘书（我的版本）", "## 日程秘书规则",
 * "## 全天候秘书v2"); it is still the same section. The name it had before the
 * merge counts too, so a memory file written then is not given a second copy.
 * Only notes named after it are the owner's own, not these rules:
 * "## 日程秘书工作日志", "…日志", "…记录", "…笔记".
 */
const HEADING = /^##\s*(全天候秘书|日程秘书)(?!工作日志|日志|工作记录|记录|笔记)/u;

const PLANNING_RULES = [
  "- 用户问接下来做什么，或补充待办、截止时间，就直接排进日历再汇报，不反问；只说了哪天、没说几点的，看那天已有的日程找空档先排上；闲聊不硬排。",
  "- 排之前先查日历，先保住课程、会议、硬截止，不凭记忆说有空。",
  "- 一天一条主线、最多三个关键交付，其余写明延后；用户没明确选的叫“建议主线”。",
  "- 深度工作 60–90 分钟一块，零碎事合并，只排满 70–80%，不默认熬夜；没有外部截止就标“暂排”。",
  "- 只说「提醒我…」、到点叫一下就行的事（吃药、出门、打电话），只设微信提醒，不进日历；要占一段时间的事（写东西、开会、约饭、出差）才排进日历，并照样设微信提醒，和日历自带的提醒重复也没关系。",
];
const CLOSING_RULES = [
  "- 插单或进度落后时重算，直接说保留什么、挪走什么、今天能交付什么。",
  "- 回复要短：用几行编号说清今天主要做什么、几点做什么、哪些挪到以后、哪里有冲突；用户只报了一件事的进度，就只说这件事带来的调整，不把整天安排再发一遍。",
];

/**
 * The default rules (written with the first owner who used them). How alarms
 * get planned each day is not in here on purpose: the owner sets that up with
 * the bot in chat, as a daily 「任务」 reminder holding their own rules.
 */
export const SECRETARY_RULES = [
  SECRETARY_HEADING,
  ...PLANNING_RULES,
  "- 要闹钟、叫醒，或某个时刻一定要响的事（赶飞机、考试），用闹钟（alarm_set：紧急提醒，到点像闹钟一样响，不靠微信）。"
    + "想让你每天自己排闹钟（比如每晚看第二天的行程定好），先和用户说好规则，再建一个每天定时的「任务」提醒（见定时提醒的规则），到点照规则做。",
  ...CLOSING_RULES,
].join("\n");

/**
 * Earlier defaults, word for word. A section still exactly like one of them
 * was never edited, so it is brought up to date; an edited one is the owner's
 * and is left alone.
 */
export const EARLIER_RULES: readonly string[] = [
  // 1.2.0, 日程秘书 (before alarms).
  ["## 日程秘书", ...PLANNING_RULES, ...CLOSING_RULES].join("\n"),
  // The first alarm version (2026-10-22, never released).
  [
    SECRETARY_HEADING,
    ...PLANNING_RULES,
    "- 要闹钟、叫醒，或某个时刻一定要响的事（赶飞机、考试），用闹钟（alarm_set，会在 iPhone 上像闹钟一样响，不靠微信）；用户让你每天定起床闹钟，就每晚看第二天的日历定好，再说一声定在几点。",
    ...CLOSING_RULES,
  ].join("\n"),
];

/** Where the section waits while the switch is off. */
function savedCopyPath(): string {
  return path.join(resolveStateDir(), "secretary-rules.md");
}

/**
 * The whole memory file. A missing file is empty; any other failure throws,
 * because the callers write the file back and must never write over a memory
 * they could not read.
 */
function readMemory(): string {
  try {
    return fs.readFileSync(memoryFilePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function writeMemory(text: string): void {
  const p = memoryFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, p);
}

/** Every such section's [start, end) line range: its heading up to the next heading. */
function sectionRanges(lines: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!HEADING.test(lines[start].trim())) continue;
    let end = start + 1;
    while (end < lines.length && !/^#{1,2} /.test(lines[end])) end += 1;
    ranges.push([start, end]);
    start = end - 1;
  }
  return ranges;
}

export function hasSecretaryRules(): boolean {
  try {
    return sectionRanges(readMemory().split("\n")).length > 0;
  } catch {
    return false;
  }
}

/** Put the rules at the end of memory.md: the owner's own last version if there is one. */
export function addSecretaryRules(): "added" | "present" {
  ensureMemoryFile();
  const text = readMemory();
  if (sectionRanges(text.split("\n")).length > 0) {
    upgradeSecretaryRules();
    return "present";
  }
  let block = SECRETARY_RULES;
  try {
    const saved = fs.readFileSync(savedCopyPath(), "utf-8").trim();
    if (HEADING.test(saved)) block = saved;
  } catch {
    // never switched off before: the default rules
  }
  writeMemory(`${text.replace(/\s*$/, "")}\n\n${block}\n`);
  logger.info("secretary: scheduling rules added to memory.md");
  upgradeSecretaryRules();
  return "added";
}

/**
 * Bring an untouched section up to the current default (EARLIER_RULES). Runs
 * when the rules go in and at start-up while the switch is on; a section the
 * owner edited, even by a character, stays as it is.
 */
export function upgradeSecretaryRules(): "upgraded" | "kept" | "absent" {
  const lines = readMemory().split("\n");
  const ranges = sectionRanges(lines);
  if (ranges.length === 0) return "absent";
  const earlier = new Set(EARLIER_RULES.map((rules) => rules.trim()));
  let changed = false;
  // From the last one back, so the earlier ranges stay where they are.
  for (const [start, end] of [...ranges].reverse()) {
    const section = lines.slice(start, end).join("\n").trim();
    if (!earlier.has(section)) continue;
    const trailing = lines.slice(start, end).length - section.split("\n").length;
    lines.splice(start, end - start, ...SECRETARY_RULES.split("\n"), ...Array<string>(trailing).fill(""));
    changed = true;
  }
  if (!changed) return "kept";
  writeMemory(lines.join("\n"));
  logger.info("secretary: rules in memory.md brought up to the current default (they were never edited)");
  return "upgraded";
}

/** Take the section out of memory.md (every copy of it), keeping it for the next time the switch goes on. */
export function removeSecretaryRules(): "removed" | "absent" {
  const lines = readMemory().split("\n");
  const ranges = sectionRanges(lines);
  if (ranges.length === 0) return "absent";
  const kept = ranges.map(([start, end]) => lines.slice(start, end).join("\n").trim());
  fs.mkdirSync(path.dirname(savedCopyPath()), { recursive: true });
  fs.writeFileSync(savedCopyPath(), `${kept.join("\n\n")}\n`, { mode: 0o600 });
  const inside = new Set(ranges.flatMap(([start, end]) => Array.from({ length: end - start }, (_, i) => start + i)));
  const rest = lines.filter((_, i) => !inside.has(i)).join("\n").replace(/\n{3,}/g, "\n\n");
  writeMemory(`${rest.replace(/\s*$/, "")}\n`);
  logger.info("secretary: scheduling rules moved out of memory.md (kept for the next time)");
  return "removed";
}

// ------------------------------------------------- "open memory.md" (settings card)

export const MEMORY_OPEN_PATH = "/plugins/clawbot/memory/open";

/** Opens a file with the desktop's own app. */
export type Opener = (file: string) => Promise<void>;

/** macOS: the app set for .md files, else the text editor; Linux: xdg-open; Windows: start. */
export const openOnDesktop: Opener = (file) =>
  new Promise((resolve, reject) => {
    const run = (cmd: string, args: string[], fallback?: () => void): void => {
      execFile(cmd, args, { timeout: 10_000 }, (err) => {
        if (err === null) resolve();
        else if (fallback !== undefined) fallback();
        else reject(err);
      });
    };
    if (process.platform === "darwin") run("open", [file], () => run("open", ["-t", file]));
    else if (process.platform === "win32") run("cmd", ["/c", "start", "", file]);
    else run("xdg-open", [file]);
  });

/** Whether a Host header names this machine: 127.x, localhost, [::1] — the same fence DSH keeps around /api. */
function loopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Whether a request comes from this machine's DSH page: its Host names this
 * machine (see cardRequestAllowed on DNS rebinding) and the browser does not
 * mark it cross-site. Also for the card's GET routes, which answer without a
 * login too.
 */
export function localRequest(req: IncomingMessage): boolean {
  return loopbackHost(req.headers.host) && req.headers["sec-fetch-site"] !== "cross-site";
}

/**
 * Whether a POST is what the settings card itself sends: JSON, from the DSH
 * page. Plugin routes are not behind DSH's login cookie; a page on another site
 * cannot send that content type without a preflight these routes never answer,
 * and a browser names the page a request came from in Origin.
 *
 * The Host must be this machine too. A page whose domain is rebound to
 * 127.0.0.1 (DNS rebinding) sends a same-origin request, so its Origin matches
 * its Host — only the Host still names the attacker's domain. DSH fences its
 * own /api the same way, but not plugin routes. (A reverse proxy in front of
 * DSH has to pass a loopback Host such as 127.0.0.1:3080, or these buttons
 * refuse its requests.)
 */
export function cardRequestAllowed(req: IncomingMessage): boolean {
  const type = String(req.headers["content-type"] ?? "");
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!localRequest(req)) return false;
  const sameSite = origin === undefined || origin === `http://${host}` || origin === `https://${host}`;
  return type.startsWith("application/json") && sameSite;
}

/**
 * POST /plugins/clawbot/memory/open — the settings card's "打开 memory.md". It
 * takes only the card's own request (cardRequestAllowed), and opens a file the
 * bot already reads every turn; nothing is sent back but its path.
 */
export async function handleMemoryOpen(req: IncomingMessage, res: ServerResponse, opener: Opener = openOnDesktop): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? "GET") !== "POST") return reply(405, { ok: false, message: "use POST" });
  if (!cardRequestAllowed(req)) {
    return reply(403, { ok: false, message: "只接受设置卡片发来的请求" });
  }
  ensureMemoryFile();
  const file = memoryFilePath();
  try {
    await opener(file);
    logger.info(`memory: opened ${file} on the desktop (settings card)`);
    reply(200, { ok: true, path: file });
  } catch (err) {
    reply(500, { ok: false, path: file, message: `打不开：${String((err as Error).message ?? err).slice(0, 160)}` });
  }
}

type WebServerLike = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

export function registerMemoryOpenRoute(ctx: Context): void {
  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;
    scoped.effect(
      () => server.register({ kind: "exact", path: MEMORY_OPEN_PATH, handler: (req, res) => handleMemoryOpen(req, res) }),
      "clawbot: memory open route",
    );
  });
}
