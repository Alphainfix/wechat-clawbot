/**
 * Tools that let the DSH agent see and poke the Claude Code sessions running on
 * this machine — the reverse of `dsh-mcp-bridge`, which points the other way.
 *
 * ## Why the three tools use two completely different mechanisms
 *
 * Claude Code exposes its local sessions as **files**, and its live-session
 * messaging only as an **undocumented socket**:
 *
 *   - `~/.claude/sessions/<pid>.json` is world-readable and carries everything
 *     needed to enumerate sessions (id, cwd, name, kind, version, and the
 *     socket path). `~/.claude/projects/<slug>/<sessionId>.jsonl` is the
 *     transcript. Both are just files, so listing and reading are stable.
 *   - Delivering a message into a *live* session means speaking `peerProtocol
 *     1` over `/tmp/cc-socks/<pid>.sock`, authenticated with the sibling
 *     `.key` file. There is no documented CLI for it (checked: `claude` has no
 *     send/message subcommand, and `--resume -p` starts a NEW run from history
 *     rather than reaching the session the user is watching).
 *
 * Rather than reverse-engineer that socket — a native binary, a version field
 * that can bump, and a silent-corruption failure mode — `send_to_claude_session`
 * shells out to a short-lived `claude -p` with `--allowed-tools
 * ListAgents,SendMessage`. Claude Code then does the socket work with its own
 * supported implementation, so protocol changes are Anthropic's to keep working
 * instead of ours to chase. Verified: a headless run does see peer sessions.
 *
 * The cost is one process and a few hundred cheap-model tokens per send, which
 * is the right trade for "occasionally steer a session from WeChat".
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { CLAUDE_RECORDED_MODES } from "./config.js";
import type { ClaudePermissionMode, ClaudeResumeMode, ClawbotConfig } from "./config.js";
import { logger } from "./ilink/util/logger.js";

/**
 * Run the helper with stdin **closed**.
 *
 * `execFile` always hands the child a stdin pipe and never closes it, so
 * `claude -p` sat waiting for piped input, warned "no stdin data received in
 * 3s", and only then proceeded — three wasted seconds on every single send, plus
 * a warning that buried the real error underneath it. `execFile` has no `stdio`
 * option, so the child handle is taken from the callback form and its stdin
 * ended immediately.
 *
 * Both streams come back on failure too: the interesting output is not always on
 * the stream you would expect — `claude` prints its authentication failure to
 * **stdout**, and exits 0 while doing it.
 */
function runHelper(
  bin: string,
  args: readonly string[],
  token?: string,
  cwd?: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1 << 20,
        // Resuming a session has to happen in ITS directory: the project a
        // transcript belongs to is derived from cwd, and resuming from the
        // wrong one gives the run a different project's context.
        ...(cwd === undefined ? {} : { cwd }),
        // Layered onto the inherited environment, never replacing it — the same
        // mistake the menu-bar app documents: a wholesale replacement loses PATH
        // and HOME and the child cannot even start.
        //
        // The token goes in the ENV, not argv: argv is visible to every process
        // on the machine through `ps`.
        ...(token === undefined ? {} : { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token } }),
      },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr });
          return;
        }
        const carried = err as Error & { stdout?: string; stderr?: string };
        carried.stdout = stdout;
        carried.stderr = stderr;
        reject(carried);
      },
    );
    child.stdin?.end();
  });
}

/**
 * Does this output mean "Claude Code has no usable login"?
 *
 * Checked against stdout **and** stderr, on both the success and failure paths,
 * because the message lands on stdout with exit code 0 — so an authentication
 * problem arrives looking exactly like a normal, unsuccessful reply.
 */
function looksUnauthenticated(text: string): boolean {
  return /failed to authenticate|oauth session expired|could not be refreshed|access token is invalid/i
    .test(text);
}

/**
 * Name of the credential holding a **dedicated** long-lived token for the helper
 * (`claude setup-token`), resolved through DSH's credential store so nothing is
 * copied into a new file.
 *
 * Why this matters more than it looks. Without it the helper authenticates from
 * the macOS keychain — the *same* credential the user's interactive sessions
 * use. That credential's refresh token rotates, so two processes refreshing at
 * once can invalidate each other, and a failed refresh clears the entry
 * outright: `accessToken` and `refreshToken` both went to zero length on this
 * machine, after which no new Claude Code session could start until the user
 * logged in again. A tool that can brick logins as a side effect of running is
 * not one to leave armed.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` takes precedence over the keychain — measured: with
 * a deliberately bad value the error changes from "OAuth session expired" to
 * "401 OAuth access token is invalid", so the keychain is not consulted at all.
 * That is the whole point: with this set, the helper cannot touch the user's
 * login even in principle.
 */
const HELPER_TOKEN_REF = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Fetch the dedicated token, or undefined when none is configured.
 *
 * `ctx.get` rather than a declared dependency: a composition without the
 * credential service should degrade to "share the keychain" rather than refuse
 * to load, and a bare property read would THROW — cordis does not return
 * undefined for an un-injected service.
 */
async function resolveHelperToken(ctx: Context): Promise<string | undefined> {
  const fromEnv = process.env[HELPER_TOKEN_REF]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const store = ctx.get("credentials") as
    | { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }
    | undefined;
  if (store?.resolve === undefined) return undefined;
  try {
    const hit = await store.resolve(HELPER_TOKEN_REF);
    const value = hit?.value?.trim();
    return value === undefined || value === "" ? undefined : value;
  } catch {
    // An unconfigured reference is not an error — it just means "not set up".
    return undefined;
  }
}

/** What to tell the user — an action, not a diagnosis. Differs by which path failed. */
function unauthenticatedMessage(usedDedicatedToken: boolean): string {
  if (usedDedicatedToken) {
    return `${HELPER_TOKEN_REF} 这个长期 token 被拒了(过期或撤销)。`
      + "重新跑 `claude setup-token`,把新值写回 ~/.dsh/.credentials.yaml 的同名条目。";
  }
  return "Claude Code 没有可用的登录凭证,所以投递不了。在终端跑一次 `claude` 重新登录。\n"
    + `更好的做法:跑 \`claude setup-token\`,把它给的长期 token 存进 ~/.dsh/.credentials.yaml 的 ${HELPER_TOKEN_REF},`
    + "这样这个工具就用自己的凭证,再也碰不到你的登录(现在它和你的交互会话共用同一份,并发续期有互相作废的风险)。";
}

/** Where Claude Code keeps its per-process session registry. */
function sessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/** Where it keeps transcripts, one directory per cwd. */
function projectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** How long a send may take before we stop waiting on the helper process. */
const SEND_TIMEOUT_MS = 120_000;

/**
 * Ceiling for a resume, which is a heavier thing than a relay: the run has to
 * replay the target's entire transcript before it can answer even a one-line
 * question. Measured 20s on a two-turn session; a long conversation is minutes,
 * and hitting the relay's 120s would report a failure for something that was
 * merely slow.
 */
const RESUME_TIMEOUT_MS = 300_000;

/**
 * Absolute path of the `claude` binary, discovered rather than assumed.
 *
 * A bare `execFile("claude", …)` looks it up on PATH, and that is exactly what
 * broke: the harness runs under whatever node the menu-bar app picked — nvm's
 * NEWEST version — while `claude` happened to be installed under an OLDER one.
 * So the harness PATH carried `…/v24.19.0/bin` while the binary lived in
 * `…/v24.16.0/bin`, and every send failed with a bare "Command failed" that
 * named no reason.
 *
 * Same lesson as the whale's node discovery, from the other side: on a machine
 * with several node installs, "which node is running" and "where the CLI lives"
 * are independent facts. Neither may be hardcoded and neither may be assumed
 * from the other.
 */
let claudeBinCache: string | undefined;

function findClaude(): string | undefined {
  // Re-resolve when a cached path stops existing: an nvm upgrade or a `claude`
  // reinstall moves it, and a stale cache would fail forever.
  if (claudeBinCache !== undefined && fs.existsSync(claudeBinCache)) return claudeBinCache;
  claudeBinCache = undefined;

  const candidates: string[] = [];
  // PATH first — when it does work, honour the user's own selection.
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir !== "") candidates.push(path.join(dir, "claude"));
  }
  // Then every nvm version, newest first, so an upgrade is picked up without
  // touching this file.
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    const versions = fs.readdirSync(nvm).sort().reverse();
    for (const v of versions) candidates.push(path.join(nvm, v, "bin", "claude"));
  } catch {
    // no nvm on this machine
  }
  // Then the usual global locations.
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")]) {
    candidates.push(path.join(dir, "claude"));
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      claudeBinCache = candidate;
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Cap on transcript text per message, so one huge turn cannot flood a reply. */
const TEXT_CAP = 1_200;

type PeerSession = {
  /** Absent for a dormant session: there is no process. */
  pid?: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  kind?: string;
  version?: string;
  startedAt?: number;
  peerProtocol?: number;
  messagingSocketPath?: string;
  /**
   * True for a session that exists only as a transcript — closed, or never
   * reopened. Reachable by `--resume`, not by the peer socket, so the send path
   * branches on this.
   */
  dormant?: boolean;
  /** Epoch ms of its last recorded activity. Dormant sessions only. */
  lastActive?: number;
};

/** True when a pid is actually still around. */
function pidAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the registry.
 *
 * A crashed session leaves its json behind, so liveness is checked per entry
 * rather than trusted — a stale row looks identical to a running one otherwise,
 * and "send to it" would then fail for no visible reason.
 */
function listSessions(): PeerSession[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PeerSession[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(sessionsDir(), file), "utf-8"),
      ) as PeerSession;
      if (typeof raw.pid !== "number" || typeof raw.sessionId !== "string") continue;
      if (!pidAlive(raw.pid)) continue;
      out.push(raw);
    } catch {
      // A half-written registry row is not worth failing the whole listing over.
    }
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * The relay helper's own first prompt — see `relayToLive`.
 *
 * Matched against the HEAD of the transcript, not the tail. The first attempt
 * tested the tail-derived title/preview, and it silently caught nothing: a
 * helper transcript's last 64KB is its attachment records (skill listings, MCP
 * blocks), so the one user turn that carries the signature had already scrolled
 * out of the window. The signature is always in the FIRST turn, so read from
 * offset 0 instead — and as a plain substring search, no JSON parsing needed.
 */
const RELAY_HELPER_MARK = "Use SendMessage to deliver the following message verbatim";

/** How much of a transcript's head to read when checking whose it is. */
const HEAD_PROBE_BYTES = 64 * 1024;

/** Is this transcript one of this plugin's own relay-helper runs? */
function isRelayHelperTranscript(file: string): boolean {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_PROBE_BYTES);
    const read = fs.readSync(handle, buf, 0, HEAD_PROBE_BYTES, 0);
    return buf.toString("utf-8", 0, read).includes(RELAY_HELPER_MARK);
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* nothing to do */ }
    }
  }
}

/** How many dormant sessions to offer. Newest first; the rest are noise. */
const DORMANT_LIMIT = 8;

/** How much of a transcript's tail to read when only its metadata is wanted. */
const META_TAIL_BYTES = 64 * 1024;

/**
 * Second, larger attempt when 64KB yielded no cwd.
 *
 * One `attachment` record can be tens of KB (skill listings, MCP instruction
 * blocks), so a transcript's last 64KB can be two trailing records that carry no
 * cwd at all — measured on a 155KB file, which then listed with no directory.
 * Bounded on purpose: the roster reads every dormant session, and the send path
 * does the unbounded scan where a wrong directory would actually matter.
 */
const META_TAIL_RETRY_BYTES = 512 * 1024;

/**
 * Cheap metadata for a transcript, without parsing the whole thing.
 *
 * `readTail` reads the file WHOLE — fine for the two or three live sessions,
 * hopeless here: this machine has 61 transcripts totalling 206MB, one of them
 * 62MB, and the roster is rebuilt on every resolve. So the dormant scan reads
 * only the last 64KB and takes what happens to be in it.
 *
 * The first line of that window is almost always a fragment, so it is dropped.
 * A title is only found when a title record happens to fall inside the window;
 * the last human turn is captured as a label either way, which is usually the
 * better handle for "the one where I asked about X" anyway.
 */
function readMetaTail(file: string, bytes: number = META_TAIL_BYTES): {
  cwd?: string; title?: string; lastAt: number; preview?: string;
} {
  let handle: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    handle = fs.openSync(file, "r");
    fs.readSync(handle, buf, 0, length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift();
    let cwd: string | undefined;
    let title: string | undefined;
    let preview: string | undefined;
    let lastAt = 0;
    for (const line of lines) {
      if (line === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof entry.cwd === "string" && entry.cwd !== "") cwd = entry.cwd;
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
        title = entry.customTitle;
      } else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") {
        title ??= entry.aiTitle;
      }
      if (typeof entry.timestamp === "string") {
        const t = Date.parse(entry.timestamp);
        if (Number.isFinite(t) && t > lastAt) lastAt = t;
      }
      if (entry.type === "user" && entry.isSidechain !== true) {
        const body = messageText(entry.message);
        if (body !== "") preview = body.replace(/\s+/g, " ").slice(0, 80);
      }
    }
    // Retry once, wider, when the window happened to hold no cwd — but only
    // when there is more file to read, or this recurses forever on a small one.
    if (cwd === undefined && bytes < META_TAIL_RETRY_BYTES && size > bytes) {
      const wider = readMetaTail(file, META_TAIL_RETRY_BYTES);
      if (wider.cwd !== undefined) return wider;
    }
    return {
      ...(cwd === undefined ? {} : { cwd }),
      ...(title === undefined ? {} : { title }),
      ...(preview === undefined ? {} : { preview }),
      lastAt,
    };
  } catch {
    return { lastAt: 0 };
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* nothing to do */ }
    }
  }
}

/**
 * Sessions that exist only on disk — closed, or simply not open right now.
 *
 * The registry under `~/.claude/sessions` is keyed by pid and only ever
 * describes running processes, so a roster built from it alone answers "本机没有
 * 正在运行的 Claude Code 会话" the moment the user closes their terminal — which
 * is exactly when messaging one from WeChat is most useful. Transcripts, on the
 * other hand, live forever, and `claude -p --resume <id>` reaches them
 * (verified 2026-09-04: a session created and exited, then resumed, recalled a
 * codeword from before it died and appended the new turn to the SAME
 * transcript).
 *
 * Sorted by file mtime, not by parsed timestamps: stat is free and the parse is
 * not, and the two agree on ordering.
 */
function listDormant(liveIds: ReadonlySet<string>): Candidate[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {
    return [];
  }
  const found: { file: string; sessionId: string; mtime: number }[] = [];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(projectsDir(), dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.slice(0, -6);
      if (liveIds.has(sessionId)) continue;
      const full = path.join(projectsDir(), dir, file);
      try {
        found.push({ file: full, sessionId, mtime: fs.statSync(full).mtimeMs });
      } catch {
        // A transcript that vanished between readdir and stat is not an error.
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const out: Candidate[] = [];
  for (const { file, sessionId, mtime } of found) {
    if (out.length >= DORMANT_LIMIT) break;
    // Skip this plugin's OWN exhaust. Every relay spawns a headless `claude -p`
    // to call SendMessage, and that run leaves a transcript of its own — 32 had
    // accumulated, five of them crowding the user's real sessions out of the
    // eight-row list and being offered to the model as things it could message.
    if (isRelayHelperTranscript(file)) continue;
    const meta = readMetaTail(file);
    // A dormant session is never "running" — and the title comes back here
    // rather than from roster(), which would re-read the whole transcript.
    out.push({
      session: {
        sessionId,
        dormant: true,
        lastActive: meta.lastAt > 0 ? meta.lastAt : mtime,
        ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      },
      ...(meta.title === undefined
        ? (meta.preview === undefined ? {} : { title: meta.preview })
        : { title: meta.title }),
      running: false,
    });
  }
  return out;
}

/**
 * Locate a transcript by session id.
 *
 * Globbed across every project directory instead of deriving the directory name
 * from the cwd: that name is the path with separators AND dots flattened to
 * dashes, which is easy to get subtly wrong (`~/.claude-jobs/x` becomes
 * `-Users-me--claude-jobs-x`). The id is unique, so searching is both simpler
 * and correct.
 */
function transcriptPath(sessionId: string): string | undefined {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projectsDir());
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir(), dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

type Turn = { role: "user" | "assistant"; at: string; text: string };

/**
 * Format an ISO stamp in the MACHINE'S timezone.
 *
 * Claude Code writes UTC. Slicing `"…T20:33:05Z"` down to `"20:33"` — which is
 * what this file used to do — showed a 16:33 message as 20:33, and the bot then
 * reported those wrong times to the user. Not hardcoded to one zone either:
 * `toLocaleTimeString` with no locale argument follows the host, so this stays
 * right when the laptop travels.
 */
function localTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Same, with the date, for things older than today. */
function localStamp(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** "8 秒前" / "3 分钟前" / "2 小时前". */
function since(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
  return `${Math.round(secs / 3600)} 小时前`;
}

/**
 * How stale the last transcript write may be while still calling a session
 * "running". Without this, a session killed mid-tool-call would read as running
 * forever, since its last entry is permanently an unfinished turn.
 */
const RUNNING_WINDOW_MS = 180_000;

type SessionState = {
  turns: Turn[];
  title?: string;
  /** Messages enqueued but not yet delivered or withdrawn. */
  queued: string[];
  /** Epoch ms of the newest user/assistant entry, 0 when there is none. */
  lastActivity: number;
  /** Best available inference — see `running` below for why it is an inference. */
  running: boolean;
  /** The directory the session ran in, as recorded on its own entries. */
  cwd?: string;
};

/** Pull the text blocks out of an Anthropic-shaped message. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null
        && (b as { type?: unknown }).type === "text"
        && typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * Read the last `limit` human-visible turns.
 *
 * Streamed through a ring buffer rather than parsed into an array: these files
 * reach tens of megabytes (12MB for a long session), and only the tail matters.
 *
 * Sidechain entries are dropped — those are subagent traffic, and mixing them
 * into the main thread makes the transcript unreadable. A `user` entry whose
 * content holds no text block is a tool result, not something a person typed,
 * so it falls out naturally.
 */
function readTail(file: string, limit: number): SessionState {
  const ring: Turn[] = [];
  let title: string | undefined;
  // Queue accounting. THREE operations, not two: `enqueue` adds (with content),
  // `dequeue` delivers one (content is null), and `remove` withdraws a specific
  // item by content — a task notification that got superseded, say. Counting
  // only enqueue/dequeue reports every withdrawn item as still waiting, which
  // is exactly the wrong answer (measured: 15/9/6 reads as 6 pending, truly 0).
  const queued: string[] = [];
  let lastActivity = 0;
  // Shape of the newest main-thread turn, which is what says whether a turn is
  // still in flight.
  let midTurn = false;

  let cwd: string | undefined;
  const text = fs.readFileSync(file, "utf-8");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (cwd === undefined && typeof entry.cwd === "string" && entry.cwd !== "") cwd = entry.cwd;
    const type = entry.type;
    if (type === "custom-title" && typeof entry.customTitle === "string") {
      title = entry.customTitle;
    } else if (type === "ai-title" && typeof entry.aiTitle === "string" && title === undefined) {
      title = entry.aiTitle;
    } else if (type === "queue-operation") {
      const op = entry.operation;
      const content = typeof entry.content === "string" ? entry.content : "";
      if (op === "enqueue") queued.push(content);
      else if (op === "dequeue") queued.shift();
      else if (op === "remove") {
        const at = queued.indexOf(content);
        if (at >= 0) queued.splice(at, 1);
        else queued.shift();
      }
    }
    if (type !== "user" && type !== "assistant") continue;
    if (entry.isSidechain === true) continue;
    const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(stamp) && stamp > lastActivity) lastActivity = stamp;

    // A turn is in flight when the last thing on the main thread is either an
    // assistant message holding a tool_use, or a user entry that is nothing but
    // tool_result — both mean the model is expected to keep going. A plain
    // assistant text turn means it finished and is waiting on the human.
    const blocks = ((entry.message as { content?: unknown } | undefined)?.content);
    const kinds = Array.isArray(blocks)
      ? blocks.map((b) => (typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined))
      : [];
    if (type === "assistant") midTurn = kinds.includes("tool_use");
    else midTurn = kinds.length > 0 && kinds.every((k) => k === "tool_result");

    if (entry.isVisibleInTranscriptOnly === true) continue;
    const body = messageText(entry.message);
    if (body === "") continue;
    ring.push({
      role: type,
      at: typeof entry.timestamp === "string" ? entry.timestamp : "",
      text: body.slice(0, TEXT_CAP),
    });
    if (ring.length > limit) ring.shift();
  }

  return {
    turns: ring,
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    queued,
    lastActivity,
    // Freshness gate: a session killed mid-tool-call keeps an unfinished last
    // entry forever, and would otherwise report as running for good.
    running: midTurn && lastActivity > 0 && Date.now() - lastActivity < RUNNING_WINDOW_MS,
  };
}

/**
 * Test seam. Queue accounting and the run-state inference are the parts most
 * likely to rot (three operations, one of which withdraws by content), and they
 * are only reachable through a live session otherwise — which makes the
 * assertion depend on whatever the machine is doing at the time. Exported so a
 * synthetic transcript with a known answer can be checked instead.
 */
export const readTranscriptForTest = readTail;

/**
 * Test seam for the binary search — the piece that actually failed in
 * production, and the one whose correctness depends on this machine's layout
 * rather than on any logic here.
 */
export const resolveClaudeBinaryForTest = findClaude;

/**
 * Test seam for the approval-mode decision. Exported because the two branches
 * that matter — a mode that needs a human, and no recorded mode at all — are
 * exactly the ones a live machine will not reliably produce on demand, and
 * getting them wrong reproduces the "it sits in manual mode" complaint.
 */
export const resolveReviveModeForTest = resolveReviveMode;

/** Test seam: the backwards chunked scan for a session's mode and directory. */
export const reviveFactsForTest = reviveFacts;

/**
 * Test seam: "is this transcript one of ours". Exported because the live roster
 * cannot test it — whether a helper session happens to fall inside the newest
 * eight depends on what the machine did today, which makes the assertion pass
 * for the wrong reason.
 */
export const isRelayHelperTranscriptForTest = isRelayHelperTranscript;

/** A session plus the two facts that make it choosable: what it is, and whether it is busy. */
type Candidate = { session: PeerSession; title?: string; running: boolean };

/**
 * Every live session with its title and run state.
 *
 * One transcript read per session (tail of 1), which is what carries the title
 * and the in-flight shape. Cheap enough to do on every resolve, and doing it
 * there is the point: a roster computed at send time cannot be stale.
 */
function roster(): Candidate[] {
  const live = listSessions().map((session) => {
    const file = transcriptPath(session.sessionId);
    if (file === undefined) return { session, running: false };
    try {
      const state = readTail(file, 1);
      return {
        session,
        ...(state.title === undefined ? {} : { title: state.title }),
        running: state.running,
      };
    } catch {
      // Unreadable transcript still leaves the session choosable by name/id.
      return { session, running: false };
    }
  });
  // Live first: when a handle matches both a running session and a closed one,
  // the running one is what the user means.
  return [...live, ...listDormant(new Set(live.map((c) => c.session.sessionId)))];
}

/**
 * Resolve a user-supplied handle to exactly one session.
 *
 * Accepts the display name, a session-id prefix, or the full id. Ambiguity is
 * an error rather than a guess: picking the wrong session here would deliver a
 * message into a conversation the user is not looking at.
 */
function resolve(handle: string): { session?: PeerSession; error?: string } {
  const all = roster();
  if (all.length === 0) return { error: "本机既没有运行中的 Claude Code 会话,也没有找到任何历史会话记录" };
  const needle = handle.trim().toLowerCase();

  // Exact name or id prefix first — the caller naming one of those means it.
  let hits = all.filter(
    (c) => (c.session.name ?? "").toLowerCase() === needle
      || c.session.sessionId.toLowerCase().startsWith(needle),
  );
  // Then the TITLE, as a substring. Titles are the stable handle here: derived
  // names churn (one session went proj-96 → proj-35 → proj-ef → claude-44 →
  // claude-90 inside a day) while a title like "论文插件调试" keeps meaning the
  // same conversation. It is also how a person refers to it.
  if (hits.length === 0) {
    hits = all.filter((c) => (c.title ?? "").toLowerCase().includes(needle));
  }
  // Then the directory. A closed session is usually remembered by its project
  // ("那个 Zotero 的"), and a dormant entry often has no name at all.
  if (hits.length === 0) {
    hits = all.filter((c) => (c.session.cwd ?? "").toLowerCase().includes(needle));
  }
  // Live beats dormant on a tie: same conversation, and the running one is the
  // one the user can see.
  if (hits.length > 1) {
    const liveHits = hits.filter((c) => c.session.dormant !== true);
    if (liveHits.length === 1) return { session: liveHits[0].session };
  }
  if (hits.length === 1) return { session: hits[0].session };

  // Either way, hand back the full mapping rather than just "not found". The
  // caller is a model deciding what to do next; a bare refusal makes it guess
  // again, while the roster lets it pick correctly on the spot.
  const table = all.map((c) => describeCandidate(c)).join("\n");
  if (hits.length === 0) {
    return { error: `找不到 "${handle}"。当前会话:\n${table}` };
  }
  return { error: `"${handle}" 同时匹配到 ${hits.length} 个,请挑一个:\n${table}` };
}

/** One roster line: everything needed to choose, nothing more. */
function describeCandidate(c: Candidate): string {
  const dormant = c.session.dormant === true;
  const bits = [
    dormant ? "[已关闭]" : c.running ? "[运行中]" : "[空闲]",
    c.session.name ?? (dormant ? "(未打开)" : "(未命名)"),
    `id=${c.session.sessionId.slice(0, 8)}`,
  ];
  if (c.title !== undefined) bits.push(`「${c.title}」`);
  if (dormant && c.session.lastActive !== undefined) {
    bits.push(`最后活动 ${since(c.session.lastActive)}`);
  }
  if (c.session.cwd !== undefined) bits.push(`cwd=${c.session.cwd}`);
  return `  · ${bits.join(" · ")}`;
}

/**
 * One line per session for the model to read.
 *
 * The run state and the queue depth are stated EXPLICITLY, including when they
 * are zero. The first version of this omitted both, and the bot answered "两边
 * 目前都没有正在运行的任务" about a session that was mid-tool-call — an absent
 * field does not read as "unknown" to a model, it reads as "nothing". A tool
 * that leaves a gap gets that gap filled in by invention.
 */
function describe(s: PeerSession, state?: SessionState): string {
  const dormant = s.dormant === true;
  const bits = [
    dormant ? "[已关闭]" : state?.running === true ? "[运行中]" : "[空闲]",
    s.name ?? (dormant ? "(未打开)" : "(未命名)"),
    `id=${s.sessionId.slice(0, 8)}`,
  ];
  if (state?.title !== undefined) bits.push(`「${state.title}」`);
  if (!dormant) {
    const pending = state?.queued.length ?? 0;
    bits.push(pending > 0 ? `队列 ${pending} 条待处理` : "队列空");
  }
  const last = dormant ? s.lastActive ?? 0 : state?.lastActivity ?? 0;
  if (last > 0) bits.push(`最后活动 ${since(last)}`);
  if (s.cwd !== undefined) bits.push(`cwd=${s.cwd}`);
  if (s.startedAt !== undefined) bits.push(`启动于 ${localStamp(s.startedAt)}`);
  return `- ${bits.join(" · ")}`;
}

/**
 * The last-recorded facts a revive needs: the session's own approval mode, and
 * the directory it was running in.
 *
 * Both are read by scanning BACKWARDS in growing windows rather than from the
 * 64KB tail `readMetaTail` uses, because 64KB is demonstrably not enough:
 *
 *   - `permissionMode` is only written when the mode CHANGES, so most sessions
 *     have none of it anywhere near the end (measured: 5 of the 8 newest).
 *   - `cwd` is on most records, but a single `attachment` record can be tens of
 *     KB (skill listings, MCP instruction blocks). On a 155KB transcript the
 *     last 64KB held only two trailing records, neither carrying a cwd — so the
 *     session came back with no directory at all, and the revive would have run
 *     in the wrong place.
 *
 * Called once, on the send path, for one session. The roster deliberately does
 * NOT use this: it reads a fixed 64KB per session because it touches eight of
 * them and a missing cwd there is cosmetic, not wrong.
 */
function reviveFacts(file: string): { mode?: ClaudePermissionMode; cwd?: string } {
  let handle: number | undefined;
  // Typed as the flag list, but may hold `default` — resolveReviveMode is the
  // thing that decides `default` cannot be passed to a background session.
  let mode: ClaudePermissionMode | undefined;
  let cwd: string | undefined;
  try {
    const size = fs.statSync(file).size;
    handle = fs.openSync(file, "r");
    for (const window of [64 * 1024, 1024 * 1024, 8 * 1024 * 1024, size]) {
      const length = Math.min(window, size);
      const start = size - length;
      const buf = Buffer.alloc(length);
      fs.readSync(handle, buf, 0, length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift();
      // Backwards: the LAST recorded value is the one in force.
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i] === "") continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(lines[i]) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (mode === undefined) {
          const raw = entry.permissionMode ?? entry.mode;
          // CLAUDE_RECORDED_MODES, not the flag list: `default` is a real
          // recorded mode that `--permission-mode` will not accept, and
          // dropping it here made `inherit` say "no mode recorded" about a
          // session that plainly recorded one.
          if (typeof raw === "string"
            && (CLAUDE_RECORDED_MODES as readonly string[]).includes(raw)) {
            mode = raw as ClaudePermissionMode;
          }
        }
        if (cwd === undefined && typeof entry.cwd === "string" && entry.cwd !== "") {
          cwd = entry.cwd;
        }
        if (mode !== undefined && cwd !== undefined) return { mode, cwd };
      }
      if (length >= size) break;
    }
    return {
      ...(mode === undefined ? {} : { mode }),
      ...(cwd === undefined ? {} : { cwd }),
    };
  } catch {
    return {};
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* nothing to do */ }
    }
  }
}

/**
 * Modes that need a human standing there. A revived background session has
 * nobody to answer a prompt, so inheriting one of these would reproduce exactly
 * the "it just sits in manual mode" complaint that prompted this design.
 */
const NEEDS_A_HUMAN: ReadonlySet<string> = new Set(["default", "manual", "plan"]);

/** Where `inherit` lands when the session's own mode cannot be honoured. */
const INHERIT_FALLBACK: ClaudePermissionMode = "acceptEdits";

/**
 * Decide the approval mode for a revive, and say where it came from.
 *
 * `inherit` (the default) means "run it the way that workspace was already
 * running" — which is what the user asked for and what a transcript can actually
 * answer. The two escape hatches are honest rather than silent: a mode that
 * needs a human, or no recorded mode at all, falls back to `acceptEdits` and the
 * reply says so.
 */
function resolveReviveMode(
  configured: ClaudeResumeMode,
  recorded: ClaudePermissionMode | undefined,
): { mode: ClaudePermissionMode; why: string } {
  if (configured !== "inherit") return { mode: configured, why: `设置指定 ${configured}` };
  if (recorded === undefined) {
    return { mode: INHERIT_FALLBACK, why: `会话没记录过审批模式,用 ${INHERIT_FALLBACK}` };
  }
  if (NEEDS_A_HUMAN.has(recorded)) {
    return {
      mode: INHERIT_FALLBACK,
      why: `会话原本是 ${recorded}(要人盯着批),后台没人可批,改用 ${INHERIT_FALLBACK}`,
    };
  }
  return { mode: recorded, why: `沿用会话原本的 ${recorded}` };
}

/** How long to wait for a revived session to register itself as a peer. */
const REVIVE_REGISTER_TIMEOUT_MS = 20_000;

/**
 * Bring a closed session back as a real background session, and wait until it
 * registers as a peer.
 *
 * `claude --bg --resume <id>` continues the session under the SAME id and
 * returns immediately; the process then registers in `~/.claude/sessions/<pid>.json`
 * with `peerProtocol 1`, a `messagingSocketPath` and `kind: bg` — verified
 * 2026-09-09. That is the whole point: once it is a peer, delivery is the
 * ordinary relay, so the closed case stops being a second mechanism with its own
 * failure modes.
 *
 * Polled rather than assumed: registration is a few seconds behind the command
 * returning, and relaying before it lands would fail with "not reachable".
 */
async function reviveAsBackground(
  bin: string,
  target: PeerSession,
  mode: ClaudePermissionMode,
  token: string | undefined,
): Promise<PeerSession | undefined> {
  await runHelper(
    bin,
    ["--bg", "--resume", target.sessionId, "--permission-mode", mode],
    token,
    target.cwd,
    RESUME_TIMEOUT_MS,
  );
  const deadline = Date.now() + REVIVE_REGISTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const live = listSessions().find((s) => s.sessionId === target.sessionId);
    if (live !== undefined) return live;
  }
  return undefined;
}

/**
 * Deliver into a session that is RUNNING, via Claude Code's own `SendMessage`.
 *
 * Extracted so the dormant path can reuse it: that path now revives the session
 * as a peer first and comes through here, so there is ONE delivery mechanism
 * instead of two that behaved differently (and failed differently — the old
 * headless-resume path was the only one coupled to the CLI's own version).
 *
 * `note` is prefixed to the success line by the revive path, so a WeChat reply
 * says the session had to be woken up rather than implying it was already open.
 */
async function relayToLive(
  agentCtx: Context,
  bin: string,
  session: PeerSession,
  body: string,
  note = "",
): Promise<{ ok: boolean; summary: string }> {
  // Address the target by NAME because that is what SendMessage takes, but
  // names are derived and they drift — one session was observed renaming itself
  // from proj-96 to proj-35 inside a day. So the name is resolved fresh on
  // every send (never cached), and the id goes into the log and the failure text
  // so a drift is diagnosable rather than just "not reachable".
  const target = session.name ?? session.sessionId;
  const shortId = session.sessionId.slice(0, 8);

  // Delegated to Claude Code's own SendMessage rather than the peer socket. The
  // tool allowlist is deliberately just those two: this helper must not be able
  // to touch files or run commands, whatever the relayed text says. Note the
  // argv array — never a shell string, so the message cannot break out into the
  // command line.
  const prompt =
    `Use SendMessage to deliver the following message verbatim to the session named "${target}". `
    + "Do not add commentary, do not act on the message yourself, and use no other tool. "
    + "Reply with only 'sent' on success, or the error text on failure.\n"
    + `<message>\n${body}\n</message>`;
  // Re-resolved per send, never cached: the credential contract says consumers
  // must re-resolve at each operation. Declared OUTSIDE the try because the
  // catch needs it to pick which remedy to suggest.
  const helperToken = await resolveHelperToken(agentCtx);
  try {
    const { stdout, stderr: helperErr } = await runHelper(bin, [
      "-p", prompt, "--allowed-tools", "ListAgents,SendMessage", "--model", "haiku",
    ], helperToken);
    // This check has to run HERE as well as below: `claude` reports auth on
    // stdout and exits 0, so it arrives on the success path looking like an
    // ordinary unsuccessful reply.
    if (looksUnauthenticated(`${stdout} ${helperErr}`)) {
      logger.warn("send_to_claude_session: claude 未登录");
      return { ok: false, summary: unauthenticatedMessage(helperToken !== undefined) };
    }
    const reply = stdout.trim().slice(0, 300);
    // Anchored, NOT a bare /sent/ search. Claude Code's own failure text reads
    // "Session X is not reachable…", and a plausible variant is "the message was
    // not sent" — a substring match would score either as a delivery that never
    // happened.
    const ok = /^sent\b/i.test(reply);
    logger.info(
      `send_to_claude_session: -> ${target} (${shortId}) ok=${ok} (${body.length} chars)`,
    );
    return {
      ok,
      summary: ok
        ? `${note}已把消息送进 Claude 会话 ${target}(${body.length} 字)。它会在当前对话里处理。`
        : `送不进去(目标 ${target} / ${shortId}):${reply}`,
    };
  } catch (err) {
    // NOT String(err).slice(0, 240). An execFile rejection reads "Command
    // failed: <the entire command>\n<stderr>", and this prompt is ~300 chars, so
    // slicing the HEAD keeps the useless command echo and cuts off the reason.
    // BOTH streams: `claude` puts the reason on either, and on 2026-09-09 a
    // stderr-only report cost a morning.
    const e = err as {
      code?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown;
    };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
    if (looksUnauthenticated(`${stdout} ${stderr} ${String(e.message ?? "")}`)) {
      logger.warn("send_to_claude_session: claude 未登录");
      return { ok: false, summary: unauthenticatedMessage(helperToken !== undefined) };
    }
    const bits = [
      e.code === undefined ? "" : `exit=${String(e.code)}`,
      e.signal === undefined || e.signal === null ? "" : `signal=${String(e.signal)}`,
      stderr === "" ? "" : `stderr: ${stderr.slice(-240)}`,
      stdout === "" ? "" : `输出: ${stdout.slice(-240)}`,
    ].filter((b) => b !== "");
    const detail = bits.length > 0 ? bits.join(" ") : String(e.message ?? err).slice(-240);
    logger.warn(`send_to_claude_session: failed -> ${target} (${shortId}) via ${bin}: ${detail}`);
    return { ok: false, summary: `送不进去(目标 ${target} / ${shortId}):${detail}` };
  }
}

/** What each approval mode meant for this turn, in one clause. */
const MODE_NOTE: Partial<Record<ClaudePermissionMode, string>> = {
  acceptEdits: "改文件直接过,跑命令仍需批准",
  bypassPermissions: "全部不问",
  plan: "只出方案,不动手",
  dontAsk: "不再询问",
  manual: "每步都要批准,headless 下等于不动手",
  auto: "由分类器判定",
};

/**
 * Deliver into a session that is not open.
 *
 * ## Revive it, then use the ordinary relay
 *
 * The first version ran the turn itself: `claude -p --resume <id>`. It worked,
 * but it made the closed case a SECOND mechanism with its own failure modes, and
 * on 2026-09-09 that bill came due — the turn executes inside the CLI process,
 * so it runs on the CLI's version and the CLI's model, and a stale binary got a
 * flat `400 … does not support this model` where the relay path was unaffected.
 *
 * `claude --bg --resume <id>` is better in the way that matters: it continues the
 * session under the same id as a real background session, which registers as a
 * peer (`peerProtocol 1`, a `messagingSocketPath`, `kind: bg` — verified
 * 2026-09-09). Once it is a peer, delivery is just `relayToLive`. One mechanism,
 * and the turn runs in an actual session on its own model.
 *
 * Verified end to end the same day: revive with `--permission-mode acceptEdits`,
 * relay "create proof.txt", and the file appeared — no manual-mode stall.
 *
 * The approval mode comes from `clawbot.claudeResumePermissionMode`, whose
 * default `inherit` reads the mode off the session's own transcript. See
 * `resolveReviveMode` for the two cases where that cannot be honoured; both are
 * reported rather than silently substituted.
 *
 * The old headless path is kept as a FALLBACK for when the revive never
 * registers (an older CLI without `--bg`, or a session that refuses to come
 * back). It is worse, but "worse" beats "nothing" and the reply says which ran.
 */
async function sendToDormant(
  agentCtx: Context,
  bin: string,
  target: PeerSession,
  body: string,
  configured: ClaudeResumeMode,
): Promise<{ ok: boolean; summary: string }> {
  const shortId = target.sessionId.slice(0, 8);
  // cwd's last segment is the most recognisable handle a dormant session has:
  // it carries no name, and its title may not have been in the tail window.
  const folder = target.cwd === undefined ? undefined : path.basename(target.cwd);
  const label = target.name ?? (folder === undefined ? shortId : `${folder}/${shortId}`);
  const helperToken = await resolveHelperToken(agentCtx);
  // One backwards scan for both facts. The cwd from here WINS over the roster's
  // 64KB guess, which can legitimately be undefined on a transcript whose tail
  // is one huge attachment record.
  const file = transcriptPath(target.sessionId);
  const facts = file === undefined ? {} : reviveFacts(file);
  const revivable: PeerSession = facts.cwd === undefined
    ? target
    : { ...target, cwd: facts.cwd };
  const { mode, why } = resolveReviveMode(configured, facts.mode);

  // ---- preferred: wake it up, then relay like any open session -------------
  try {
    const live = await reviveAsBackground(bin, revivable, mode, helperToken);
    if (live !== undefined) {
      logger.info(
        `send_to_claude_session: revived ${shortId} as bg (mode=${mode}; ${why})`,
      );
      // The note has to carry the hand-back commands, because a background
      // session is EXCLUSIVE: while it runs, that conversation cannot be opened
      // in the desktop app at all. Claude Code refuses with "is running as a
      // background session", the app's child process exits 1, and the app shows
      // "Claude Code crashed" — which is exactly what happened to the user on
      // 2026-09-09, minutes after this path first shipped. The trade is inherent
      // to --bg; the surprise is not, so every revive says how to undo it.
      return await relayToLive(
        agentCtx, bin, live, body,
        `会话 ${label} 当时没开着,已在后台拉活(审批模式 ${mode} —— ${why})。`
        + `\n注意:它现在是**后台会话**,在桌面版里打不开(会报错)。`
        + `要自己接手:终端跑 \`claude attach ${shortId}\`;`
        + `想在桌面版打开:先 \`claude stop ${shortId}\`。`,
      );
    }
    logger.warn(
      `send_to_claude_session: ${shortId} revived but never registered as a peer; falling back`,
    );
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const both = `${typeof e.stdout === "string" ? e.stdout : ""} `
      + `${typeof e.stderr === "string" ? e.stderr : ""}`;
    if (looksUnauthenticated(`${both} ${String(e.message ?? "")}`)) {
      logger.warn("send_to_claude_session(revive): claude 未登录");
      return { ok: false, summary: unauthenticatedMessage(helperToken !== undefined) };
    }
    logger.warn(
      `send_to_claude_session: revive of ${shortId} failed (${both.trim().slice(-160)}); falling back`,
    );
  }

  // ---- fallback: run the turn headlessly, the old way ----------------------
  // Same token as the revive above — resolved once at the top of this function.
  try {
    const startedAt = Date.now();
    const { stdout, stderr } = await runHelper(
      bin,
      ["-p", body, "--resume", target.sessionId, "--permission-mode", mode],
      helperToken,
      revivable.cwd,
      RESUME_TIMEOUT_MS,
    );
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (looksUnauthenticated(`${stdout} ${stderr}`)) {
      logger.warn("send_to_claude_session(dormant): claude 未登录");
      return { ok: false, summary: unauthenticatedMessage(helperToken !== undefined) };
    }
    const reply = stdout.trim();
    logger.info(
      `send_to_claude_session: resumed ${shortId} (${body.length} chars) -> ${reply.length} chars back`,
    );
    if (reply === "") {
      return {
        ok: false,
        summary: `会话 ${label}(${shortId})恢复了,但没有回任何内容。`
          + (stderr.trim() === "" ? "" : `stderr 尾部:${stderr.trim().slice(-200)}`),
      };
    }
    return {
      ok: true,
      summary: `会话 ${label} 拉活没成功,退回到无头续接(${body.length} 字,耗时 ${seconds} 秒,`
        + `审批模式 ${mode} —— ${why})。它已回复,内容写进了同一个对话,`
        + `用户下次打开就能看到:\n`
        + reply.slice(0, 600)
        + `\n(审批模式 ${mode}${MODE_NOTE[mode] === undefined ? "" : `:${MODE_NOTE[mode]}`})`,
    };
  } catch (err) {
    // Same shape as the live path: the diagnosis is at the END of stderr, and
    // slicing the head would keep the command echo and drop the cause.
    const e = err as {
      code?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown;
    };
    const errText = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const outText = typeof e.stdout === "string" ? e.stdout.trim() : "";
    if (looksUnauthenticated(`${outText} ${errText} ${String(e.message ?? "")}`)) {
      logger.warn("send_to_claude_session(dormant): claude 未登录");
      return { ok: false, summary: unauthenticatedMessage(helperToken !== undefined) };
    }
    // STDOUT as well as stderr. This file already knew that `claude` reports
    // authentication on stdout, and the auth check above reads both — then this
    // block was written reading stderr only, and on 2026-09-09 it cost a whole
    // morning: two resumes into the Zotero session failed and the only thing
    // reported to WeChat was "exit=1". The actual reason was sitting on stdout:
    //   API Error: 400 Claude Code 2.1.246 does not support this model;
    //   version 2.1.251 or newer is required. Run 'claude update' …
    // An exit code with no message is not a diagnosis, it is a dead end.
    const bits = [
      e.code === undefined ? "" : `exit=${String(e.code)}`,
      e.signal === undefined || e.signal === null ? "" : `signal=${String(e.signal)}`,
      errText === "" ? "" : `stderr: ${errText.slice(-240)}`,
      outText === "" ? "" : `输出: ${outText.slice(-320)}`,
    ].filter((b) => b !== "");
    const detail = bits.length > 0 ? bits.join(" ") : String(e.message ?? err).slice(-240);
    logger.warn(`send_to_claude_session: resume failed ${shortId} via ${bin}: ${detail}`);
    // A stale CLI is the one failure with an exact remedy, and the message the
    // API returns names it — so say it plainly instead of leaving a 400 in the
    // reply for the user to interpret from their phone.
    const stale = /does not support this model|version [\d.]+ or newer is required/i
      .test(`${outText} ${errText}`);
    return {
      ok: false,
      summary: stale
        ? `续接会话 ${label}(${shortId})失败:插件调用的 claude 命令行版本太旧,`
          + `这个会话用的模型不接受它。在终端跑 \`claude update\`(或更新桌面版)即可。`
          + `\n原文:${`${outText} ${errText}`.trim().slice(-300)}`
        : `续接会话 ${label}(${shortId})失败:${detail}`,
    };
  }
}

/**
 * Register all three tools on one context.
 *
 * @param agentCtx - the context whose agent should get the tools.
 */
export function registerClaudePeerTools(
  agentCtx: Context,
  // Held by REFERENCE, not copied: the settings page writes into the live
  // config object and this field is hot, so a copy would pin the approval mode
  // to whatever it was when the tools were registered. Same contract as the
  // prompt section's `config`.
  config: Pick<ClawbotConfig, "claudeResumePermissionMode"> = {
    claudeResumePermissionMode: "acceptEdits",
  },
): void {
  agentCtx.tools.register(
    defineTool({
      name: "list_claude_sessions",
      description:
        "List the Claude Code sessions running on this machine (name, id, cwd, how long they have been up, "
        + "and the current conversation title). Use this before reading or messaging one. "
        + "These are the user's own coding sessions, separate from this conversation.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "number", required: true },
            summary: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.summary }],
      },
      async execute() {
        const sessions = listSessions();
        // Closed sessions are listed too, because they are reachable: see
        // `listDormant`. Without them the answer to "message my Zotero session"
        // was "there are none" whenever the user had closed their terminal.
        const dormant = listDormant(new Set(sessions.map((s) => s.sessionId)));
        if (sessions.length === 0 && dormant.length === 0) {
          return { count: 0, summary: "本机没有 Claude Code 会话,连历史记录也没有。" };
        }
        const lines: string[] = [];
        const queuePreviews: string[] = [];
        let running = 0;
        for (const s of sessions) {
          const file = transcriptPath(s.sessionId);
          let state: SessionState | undefined;
          if (file !== undefined) {
            try {
              // limit 1: the tail is not wanted here, but the same single pass
              // yields the title, the queue and the run state.
              state = readTail(file, 1);
            } catch {
              // A transcript we cannot read still leaves the session listable.
            }
          }
          if (state?.running === true) running += 1;
          lines.push(describe(s, state));
          for (const q of state?.queued ?? []) {
            queuePreviews.push(`  · ${s.name ?? s.sessionId.slice(0, 8)} 队列: ${q.replace(/\s+/g, " ").slice(0, 90)}`);
          }
        }
        // The title for a dormant entry lives on the Candidate (roster() would
        // have to re-read a 62MB transcript to get it), so it is handed to the
        // shared renderer as a minimal state rather than duplicating the format.
        const dormantLines = dormant.map((c) => describe(c.session, {
          turns: [],
          queued: [],
          lastActivity: c.session.lastActive ?? 0,
          running: false,
          ...(c.title === undefined ? {} : { title: c.title }),
        }));
        logger.info(
          `list_claude_sessions: ${sessions.length} live, ${running} running, ${dormant.length} dormant`,
        );
        const head = `本机有 ${sessions.length} 个开着的 Claude Code 会话,${running} 个正在跑`
          + `${dormant.length > 0 ? `;另有 ${dormant.length} 个最近关掉的(仍可发消息)` : ""}:`;
        // Stated even when empty, so the model reports "no queue" from evidence
        // rather than from the absence of a field.
        const queueNote = queuePreviews.length > 0
          ? ["排队中的消息:", ...queuePreviews]
          : ["没有排队中的消息(按已记录的队列事件)。"];
        return {
          count: sessions.length + dormant.length,
          summary: [
            head,
            ...lines,
            ...(dormantLines.length > 0 ? ["", "最近关掉的(发消息会用 --resume 续上):", ...dormantLines] : []),
            "",
            ...queueNote,
          ].join("\n"),
        };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "read_claude_session",
      description:
        "Read the tail of one Claude Code session's conversation — what the user asked and what Claude replied. "
        + "Tool calls and subagent traffic are omitted. Use list_claude_sessions first to get a name or id.",
      parameters: {
        session: {
          type: "string",
          required: true,
          description:
            "Any of: the session name (e.g. 'claude-90'), a session-id prefix, "
            + "or a word from its title (e.g. 'Zotero'). Titles are the most reliable — "
            + "names are derived and change while a session runs. A handle that matches "
            + "nothing, or more than one, comes back with the full current roster so you "
            + "can pick without calling list_claude_sessions first.",
        },
        limit: {
          type: "number",
          description: "How many trailing turns to return. Default 15, max 60.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            summary: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.summary }],
      },
      async execute(args) {
        const { session, limit } = args as { session?: string; limit?: number };
        const found = resolve(session ?? "");
        if (found.session === undefined) return { ok: false, summary: found.error ?? "解析失败" };
        const file = transcriptPath(found.session.sessionId);
        if (file === undefined) {
          return { ok: false, summary: `会话 ${found.session.name ?? ""} 还没有落盘的记录` };
        }
        const n = Math.min(Math.max(Math.trunc(Number(limit ?? 15)) || 15, 1), 60);
        const state = readTail(file, n);
        const { turns, title } = state;
        const head = `${found.session.name ?? found.session.sessionId.slice(0, 8)}`
          + `${title === undefined ? "" : `「${title}」`}`
          + ` [${state.running ? "运行中" : "空闲"}]`
          + `${state.queued.length > 0 ? ` 队列 ${state.queued.length} 条` : ""}`
          + ` 最后 ${turns.length} 轮:`;
        // localTime, NOT at.slice(11,16): the stamps in the log are UTC, and
        // slicing them showed a 16:33 message as 20:33.
        const body = turns.map(
          (t) => `\n[${t.role === "user" ? "用户" : "Claude"} ${localTime(t.at)}]\n${t.text}`,
        );
        logger.info(
          `read_claude_session: ${found.session.sessionId.slice(0, 8)} -> ${turns.length} turns`,
        );
        return { ok: true, summary: [head, ...body].join("\n") };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "send_to_claude_session",
      description:
        "Relay a message into one of the user's Claude Code sessions. "
        + "Works whether or not the session is currently open: an open session receives it in the "
        + "conversation the user is watching, and a CLOSED one is first woken up in the background "
        + "(under the same conversation, keeping its history) and then receives it the same way. "
        + "The tool says which of the two happened, and which approval mode the woken session got. "
        + "A woken session becomes a BACKGROUND session, which is exclusive: until it is stopped, that "
        + "conversation cannot be opened in the desktop app (trying to shows 'Claude Code crashed'). "
        + "The tool's reply carries the `claude attach` / `claude stop` commands — pass them on to the "
        + "user rather than dropping them, or they will hit that error without knowing why. "
        + "IMPORTANT — it does NOT arrive as if the user typed it. Claude Code labels it as coming "
        + "from another session and tells the receiver to treat it as a teammate's request, acted on "
        + "under that session's own permissions. So write the message as a relay: quote what the user "
        + "asked for (\"用户说：…\") and never claim to be the user or to have told the session things "
        + "you did not — a session that is told \"the codeword I gave you earlier\" by a peer that gave "
        + "it nothing will refuse and say so, which is correct of it. "
        + "You can name the target by title (most reliable), by name, by id prefix, or by a word from its "
        + "directory; if it is ambiguous or unknown the tool returns every session with its name, id, "
        + "title, state and directory, so you can choose and retry immediately. "
        + "For an open session it returns once the message is delivered, NOT once the work is done — "
        + "read_claude_session afterwards to see what it did.",
      parameters: {
        session: {
          type: "string",
          required: true,
          description:
            "Any of: the session name (e.g. 'claude-90'), a session-id prefix, "
            + "or a word from its title (e.g. 'Zotero'). Titles are the most reliable — "
            + "names are derived and change while a session runs. A handle that matches "
            + "nothing, or more than one, comes back with the full current roster so you "
            + "can pick without calling list_claude_sessions first.",
        },
        text: {
          type: "string",
          required: true,
          description: "The message to deliver, exactly as the user would have typed it.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            summary: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.summary }],
      },
      async execute(args) {
        const { session, text } = args as { session?: string; text?: string };
        const body = (text ?? "").trim();
        if (body === "") return { ok: false, summary: "消息是空的,没有发送" };
        const found = resolve(session ?? "");
        if (found.session === undefined) return { ok: false, summary: found.error ?? "解析失败" };
        const bin = findClaude();
        if (bin === undefined) {
          logger.warn("send_to_claude_session: 找不到 claude 可执行文件");
          return {
            ok: false,
            summary: "找不到 claude 可执行文件(PATH、nvm 各版本、常见安装位置都查过了)。"
              + "装了 Claude Code 吗?",
          };
        }
        if (found.session.dormant === true) {
          return await sendToDormant(
            agentCtx, bin, found.session, body, config.claudeResumePermissionMode,
          );
        }
        return await relayToLive(agentCtx, bin, found.session, body);
      },
    }),
  );
}
