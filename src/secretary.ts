/**
 * The scheduling secretary ("日程秘书"): a short set of planning rules the
 * owner switches on in the settings card.
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

export const SECRETARY_HEADING = "## 日程秘书";
/** The owner may retitle it ("## 日程秘书（我的版本）"); it is still the same section. */
const HEADING = /^##\s*日程秘书/;

/** The default rules (written with the first owner who used them). */
export const SECRETARY_RULES = [
  SECRETARY_HEADING,
  "- 用户问接下来做什么，或补充待办、截止时间，就直接排进日历再汇报，不反问；只说了哪天、没说几点的，看那天已有的日程找空档先排上；闲聊不硬排。",
  "- 排之前先查日历，先保住课程、会议、硬截止，不凭记忆说有空。",
  "- 一天一条主线、最多三个关键交付，其余写明延后；用户没明确选的叫“建议主线”。",
  "- 深度工作 60–90 分钟一块，零碎事合并，只排满 70–80%，不默认熬夜；没有外部截止就标“暂排”。",
  "- 只说「提醒我…」、到点叫一下就行的事（吃药、出门、打电话），只设微信提醒，不进日历；要占一段时间的事（写东西、开会、约饭、出差）才排进日历，并照样设微信提醒，和日历自带的提醒重复也没关系。",
  "- 插单或进度落后时重算，直接说保留什么、挪走什么、今天能交付什么。",
  "- 回复要短：用几行编号说清今天主要做什么、几点做什么、哪些挪到以后、哪里有冲突；用户只报了一件事的进度，就只说这件事带来的调整，不把整天安排再发一遍。",
].join("\n");

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

/** The section's [start, end) line range: its heading up to the next heading. */
function sectionRange(lines: readonly string[]): [number, number] | null {
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end])) end += 1;
  return [start, end];
}

export function hasSecretaryRules(): boolean {
  try {
    return sectionRange(readMemory().split("\n")) !== null;
  } catch {
    return false;
  }
}

/** Put the rules at the end of memory.md: the owner's own last version if there is one. */
export function addSecretaryRules(): "added" | "present" {
  ensureMemoryFile();
  const text = readMemory();
  if (sectionRange(text.split("\n")) !== null) return "present";
  let block = SECRETARY_RULES;
  try {
    const saved = fs.readFileSync(savedCopyPath(), "utf-8").trim();
    if (HEADING.test(saved)) block = saved;
  } catch {
    // never switched off before: the default rules
  }
  writeMemory(`${text.replace(/\s*$/, "")}\n\n${block}\n`);
  logger.info("secretary: scheduling rules added to memory.md");
  return "added";
}

/** Take the section out of memory.md, keeping it for the next time the switch goes on. */
export function removeSecretaryRules(): "removed" | "absent" {
  const lines = readMemory().split("\n");
  const range = sectionRange(lines);
  if (range === null) return "absent";
  const [start, end] = range;
  fs.mkdirSync(path.dirname(savedCopyPath()), { recursive: true });
  fs.writeFileSync(savedCopyPath(), `${lines.slice(start, end).join("\n").trim()}\n`, { mode: 0o600 });
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
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

/**
 * POST /plugins/clawbot/memory/open — the settings card's "打开 memory.md".
 *
 * Plugin routes are not behind DSH's login cookie, so this takes only what the
 * card itself sends: a JSON POST from the DSH page. A page on another site
 * cannot send that content type without a preflight this route never answers,
 * and a browser names the page a request came from in Origin. It opens a file
 * the bot already reads every turn; nothing is sent back but its path.
 */
export async function handleMemoryOpen(req: IncomingMessage, res: ServerResponse, opener: Opener = openOnDesktop): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if ((req.method ?? "GET") !== "POST") return reply(405, { ok: false, message: "use POST" });
  const type = String(req.headers["content-type"] ?? "");
  const origin = req.headers.origin;
  const host = req.headers.host;
  const sameSite = origin === undefined || (host !== undefined && (origin === `http://${host}` || origin === `https://${host}`));
  if (!type.startsWith("application/json") || !sameSite) {
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
