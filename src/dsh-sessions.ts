/**
 * The DSH conversations on this machine, as the WeChat bot sees them.
 *
 * The bot already sees the owner's Claude Code sessions (claude-peer.ts). These
 * three tools do the same for DSH's own conversations — the ones in the web UI,
 * in any working directory: list them, read the tail of one, and put a message
 * into one. The MCP routes for Claude Code (mcp-route.ts) use the same
 * functions, so the two views cannot drift apart.
 *
 * ## Global, not per folder
 *
 * DSH stores each working directory's sessions in its own folder, but nothing
 * here reads those folders. `sessionQuery` is the host's index over every
 * session it knows, and `sessionController.resolveAgent` wakes any of them the
 * way the web UI does (its model selection and preset included). Both are read
 * with `ctx.get` rather than injected: a composition without them degrades to
 * "live agents only" instead of refusing to load.
 */
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { zonedStamp } from "./localtime.js";
import { logger } from "./ilink/util/logger.js";

/** The part of the host's `sessionQuery` service these tools use. */
export type SessionQueryLike = {
  listSessions: (signal?: AbortSignal) => Promise<readonly {
    header: { id: string; createdAt: number; cwd?: string };
    live: boolean;
    persisted: boolean;
  }[]>;
  readTitleSnapshots: (ids: readonly string[], signal?: AbortSignal) => Promise<readonly {
    status: string;
    value?: { title?: { title?: string } };
  }[]>;
  readSurface: (id: string) => Promise<{
    capturedThroughSeq: number | null;
    events: readonly { type: string; seq: number; time: number; data?: unknown }[];
  }>;
};

/** The part of the host's `sessionController` service used to wake a session. */
type SessionControllerLike = {
  resolveAgent: (sessionId: unknown) => Promise<{ agent: LiveAgent } | { error: unknown }>;
};

type LiveAgent = {
  status: string;
  session: { id: unknown; seq: number; header: { cwd?: string } };
  steer: (message: unknown) => void;
  followup: (message: unknown) => void;
};

/** How much of one message a read keeps. */
export const TAIL_TEXT_CAP = 2_000;

/** Pull the plain text out of a surface event, whatever kind it is. */
export function eventText(event: { type: string; data?: unknown }): string {
  const data = event.data as
    | { content?: readonly unknown[]; message?: { content?: readonly unknown[] } }
    | undefined;
  // user/message carries `content`; assistant/message nests it under `message`
  // (the shape difference is real — see WechatBridge.buildSessionIndex).
  const blocks = event.type === "assistant/message"
    ? data?.message?.content ?? []
    : data?.content ?? [];
  return blocks
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export type DshSessionRow = {
  id: string;
  title?: string;
  cwd?: string;
  createdAt: number;
  /** Resumed into memory. */
  live: boolean;
  persisted: boolean;
  /** A turn is executing right now. */
  running: boolean;
};

function sessionQuery(ctx: Context): SessionQueryLike | undefined {
  try {
    return ctx.get("sessionQuery") as SessionQueryLike | undefined;
  } catch {
    return undefined;
  }
}

function sessionController(ctx: Context): SessionControllerLike | undefined {
  try {
    return ctx.get("sessionController") as SessionControllerLike | undefined;
  } catch {
    return undefined;
  }
}

/** Every DSH session the host knows, with titles; `degraded` when only live agents could be seen. */
export async function listDshSessions(
  ctx: Context,
): Promise<{ rows: DshSessionRow[]; degraded?: string }> {
  const live = new Map<string, ReturnType<typeof ctx.agents.list>[number]>(
    ctx.agents.list().map((a) => [String(a.session.id), a]),
  );
  const sq = sessionQuery(ctx);
  if (sq === undefined) {
    return {
      degraded: "no sessionQuery service; listing live agents only",
      rows: [...live.values()].map((a) => ({
        id: String(a.session.id),
        cwd: a.session.header.cwd,
        createdAt: 0,
        live: true,
        persisted: true,
        running: a.status === "running",
      })),
    };
  }
  const records = await sq.listSessions();
  const ids = records.map((r) => r.header.id);
  // One batched call — readTitle per session would be N round trips, and
  // titles are the whole point of a list a human reads.
  let titles: readonly { status: string; value?: { title?: { title?: string } } }[] = [];
  try {
    titles = await sq.readTitleSnapshots(ids);
  } catch (err) {
    logger.warn(`dsh sessions: title fold failed: ${String(err).slice(0, 120)}`);
  }
  return {
    rows: records.map((record, index) => {
      const title = titles[index]?.status === "fulfilled"
        ? titles[index]?.value?.title?.title
        : undefined;
      return {
        id: record.header.id,
        ...(title === undefined || title === "" ? {} : { title }),
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        createdAt: record.header.createdAt,
        live: record.live,
        persisted: record.persisted,
        running: live.get(record.header.id)?.status === "running",
      };
    }),
  };
}

export type DshMessage = { role: "user" | "assistant"; at: number; seq: number; text: string };

/** The text messages of one session, oldest first; undefined when the host cannot read sessions. */
export async function readDshSession(ctx: Context, sessionId: string): Promise<DshMessage[] | undefined> {
  const sq = sessionQuery(ctx);
  if (sq === undefined) return undefined;
  const surface = await sq.readSurface(sessionId);
  return surface.events
    .filter((e) => e.type === "user/message" || e.type === "assistant/message")
    .map((e) => ({
      role: e.type === "user/message" ? "user" as const : "assistant" as const,
      at: e.time,
      seq: e.seq,
      text: eventText(e).slice(0, TAIL_TEXT_CAP),
    }))
    .filter((m) => m.text !== "");
}

export type DshSendResult =
  | { ok: true; delivered: "steered" | "followup"; woke: boolean; agent: LiveAgent; before: number }
  | { ok: false; message: string };

/**
 * Put a message into a DSH session.
 *
 * steer vs followup is not a style choice: a running driver must be steered
 * into its nearest step, while an idle one needs followup to start a turn.
 * Calling the wrong one either drops the message or starts a second
 * concurrent turn — the same distinction WechatBridge.drainQueue makes.
 *
 * A session that is not in memory is woken through the host's own session
 * controller when `wake` is set (the web UI does the same when it is opened),
 * so it comes back with its model selection and preset rather than defaults.
 *
 * `kind` is the message source. It must not be "wechat-clawbot": the
 * bridge's session listener treats a non-schedule plugin turn as GUI-only, which
 * is what keeps an answer to an injected message in the web UI instead of
 * forwarding it to WeChat.
 */
export async function sendToDshSession(
  ctx: Context,
  sessionId: string,
  text: string,
  opts: { kind: string; wake: boolean },
): Promise<DshSendResult> {
  let agent = ctx.agents.get(SessionId(sessionId)) as unknown as LiveAgent | undefined;
  let woke = false;
  if (agent === undefined) {
    if (!opts.wake) {
      return {
        ok: false,
        message:
          `session "${sessionId}" is not live — nothing is holding it in memory. `
          + "Open it in the web UI (or send it a WeChat message) and try again.",
      };
    }
    const controller = sessionController(ctx);
    if (controller === undefined) {
      return { ok: false, message: "这个 DSH 没有 sessionController 服务,只能给已经打开的会话发消息" };
    }
    const resolved = await controller.resolveAgent(SessionId(sessionId));
    if ("error" in resolved) {
      return { ok: false, message: `唤醒会话失败: ${String(resolved.error).slice(0, 200)}` };
    }
    agent = resolved.agent;
    woke = true;
  }
  const message = createUserMessage({
    content: [{ type: "text", text }],
    // v4 refuses the retired `plugin` wrapper; `plugin:<producer>` is the shape it takes.
    source: { kind: opts.kind } as never,
  });
  const before = agent.session.seq;
  const running = agent.status === "running";
  if (running) agent.steer(message);
  else agent.followup(message);
  logger.info(
    `dsh send: ${running ? "steered" : "followed up"} ${text.length} chars into ${sessionId}${woke ? " (woken)" : ""}`,
  );
  return { ok: true, delivered: running ? "steered" : "followup", woke, agent, before };
}

// ---------------------------------------------------------------- the tools

/** Rows the list shows at most; the rest are counted. */
const LIST_LIMIT = 20;

function folder(cwd: string | undefined): string {
  return cwd === undefined || cwd === "" ? "" : path.basename(cwd);
}

function stateLabel(row: DshSessionRow): string {
  if (row.running) return "正在运行";
  if (row.live) return "已打开";
  return "未打开";
}

function stamp(ms: number): string {
  return ms > 0 ? zonedStamp(new Date(ms)) : "时间不明";
}

function describeRow(row: DshSessionRow): string {
  const where = folder(row.cwd);
  return `• ${row.title ?? "(没有标题)"} — ${row.id.slice(0, 8)}`
    + `${where === "" ? "" : ` · ${where}`} · 创建于 ${stamp(row.createdAt)} · ${stateLabel(row)}`;
}

/** Newest activity first: running, then open, then by creation time. */
function ordered(rows: readonly DshSessionRow[]): DshSessionRow[] {
  const rank = (r: DshSessionRow) => (r.running ? 2 : r.live ? 1 : 0);
  return [...rows].sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt);
}

/**
 * Find one session by id prefix, title words or folder name. Several matches
 * (or none) come back as an error carrying the candidates, so the model can
 * pick and retry without listing first.
 */
export function resolveDshSession(
  rows: readonly DshSessionRow[],
  handle: string,
): { row?: DshSessionRow; error?: string } {
  const h = handle.trim().toLowerCase();
  if (h === "") return { error: "没说是哪个会话" };
  const byId = rows.filter((r) => r.id.toLowerCase().startsWith(h));
  if (byId.length === 1) return { row: byId[0] };
  const byTitle = rows.filter((r) => (r.title ?? "").toLowerCase().includes(h));
  if (byTitle.length === 1) return { row: byTitle[0] };
  const byFolder = rows.filter((r) => folder(r.cwd).toLowerCase() === h);
  if (byFolder.length === 1) return { row: byFolder[0] };
  const many = byId.length > 1 ? byId : byTitle.length > 1 ? byTitle : byFolder;
  const shown = ordered(many.length > 1 ? many : rows).slice(0, LIST_LIMIT);
  return {
    error: `${many.length > 1 ? `「${handle}」对上了 ${many.length} 个会话` : `没找到「${handle}」`},`
      + `换成下面某个的标题或 id 前缀再试:\n${shown.map(describeRow).join("\n")}`,
  };
}

const RENDERED_TEXT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", required: true },
    summary: { type: "string", required: true },
  },
} as const;

/**
 * Register list_dsh_sessions / read_dsh_session / send_to_dsh_session on the
 * WeChat agent.
 *
 * @param agentCtx - the WeChat agent's scope (the tools are its alone).
 * @param ctx - the plugin's root context, which can see the host services.
 * @param wechatSessionId - the bot's own session, left out of every list.
 */
export function registerDshSessionTools(agentCtx: Context, ctx: Context, wechatSessionId: string): void {
  const others = async (): Promise<{ rows: DshSessionRow[]; degraded?: string }> => {
    const listed = await listDshSessions(ctx);
    return { ...listed, rows: listed.rows.filter((r) => r.id !== wechatSessionId) };
  };

  agentCtx.tools.register(
    defineTool({
      name: "list_dsh_sessions",
      description:
        "List the conversations in DSH (DeepSeek Harness, the web UI on this computer) — every working "
        + "directory, not just one: title, id, folder, when it was started, and whether it is running now. "
        + "These are the owner's other DSH conversations, separate from this WeChat one and from Claude Code "
        + "(list_claude_sessions). Use it before read_dsh_session or send_to_dsh_session.",
      parameters: {},
      output: { schema: RENDERED_TEXT, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute() {
        const { rows, degraded } = await others();
        if (rows.length === 0) return { ok: true, summary: "DSH 里除了微信这个会话,没有别的会话。" };
        const shown = ordered(rows).slice(0, LIST_LIMIT);
        const running = rows.filter((r) => r.running).length;
        logger.info(`list_dsh_sessions: ${rows.length} sessions, ${running} running`);
        return {
          ok: true,
          summary: `DSH 里有 ${rows.length} 个会话(${running} 个正在运行)`
            + `${rows.length > shown.length ? `,下面是最近的 ${shown.length} 个` : ""}:\n`
            + shown.map(describeRow).join("\n")
            + (degraded === undefined ? "" : "\n(只看得到已经打开的会话)"),
        };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "read_dsh_session",
      description:
        "Read the latest messages of one DSH conversation (what the owner asked and what DSH answered), "
        + "to tell the owner what it is doing or what it concluded. Name it by title words, id prefix or "
        + "folder name; an unknown or ambiguous name returns the candidates.",
      parameters: {
        session: { type: "string", required: true, description: "Title words, id prefix, or folder name." },
        limit: { type: "number", description: "How many recent messages (default 10, at most 40)." },
      },
      output: { schema: RENDERED_TEXT, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(args) {
        const { session, limit } = args as { session?: string; limit?: number };
        const { rows } = await others();
        const found = resolveDshSession(rows, session ?? "");
        if (found.row === undefined) return { ok: false, summary: found.error ?? "没找到" };
        let messages: DshMessage[] | undefined;
        try {
          messages = await readDshSession(ctx, found.row.id);
        } catch (err) {
          return { ok: false, summary: `读不出会话「${found.row.title ?? found.row.id.slice(0, 8)}」:${String(err).slice(0, 160)}` };
        }
        if (messages === undefined) return { ok: false, summary: "这个 DSH 读不了会话内容(没有 sessionQuery 服务)" };
        const n = Number.isFinite(Number(limit)) ? Math.min(Math.max(Math.trunc(Number(limit)), 1), 40) : 10;
        const tail = messages.slice(-n);
        logger.info(`read_dsh_session: ${found.row.id.slice(0, 8)} -> ${tail.length} of ${messages.length}`);
        const head = `会话「${found.row.title ?? found.row.id.slice(0, 8)}」(${stateLabel(found.row)})`
          + `,共 ${messages.length} 条消息,最近 ${tail.length} 条:`;
        const body = tail.map((m) =>
          `[${stamp(m.at)}] ${m.role === "user" ? "用户" : "DSH"}:${m.text.slice(0, 600)}${m.text.length > 600 ? "…" : ""}`);
        return { ok: true, summary: tail.length === 0 ? `${head}\n(还没有文字消息)` : `${head}\n${body.join("\n")}` };
      },
    }),
  );

  agentCtx.tools.register(
    defineTool({
      name: "send_to_dsh_session",
      description:
        "Put a message into one of the owner's DSH conversations, e.g. to have it continue a task. "
        + "A conversation that is not open is woken up first, the way the web UI opens it. It is answered "
        + "in the web UI, NOT on WeChat: this tool returns once the message is delivered, not when the work "
        + "is done — use read_dsh_session later to see the result, or ask the conversation to report back "
        + "with its notify_wechat tool. Write it as a relay of what the owner asked (\"用户在微信里说:…\"), "
        + "never as if you were the owner.",
      parameters: {
        session: { type: "string", required: true, description: "Title words, id prefix, or folder name." },
        text: { type: "string", required: true, description: "The message to deliver." },
      },
      output: { schema: RENDERED_TEXT, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(args) {
        const { session, text } = args as { session?: string; text?: string };
        const body = (text ?? "").trim();
        if (body === "") return { ok: false, summary: "消息是空的,没有发送" };
        const { rows } = await others();
        const found = resolveDshSession(rows, session ?? "");
        if (found.row === undefined) return { ok: false, summary: found.error ?? "没找到" };
        const label = found.row.title ?? found.row.id.slice(0, 8);
        let sent: DshSendResult;
        try {
          sent = await sendToDshSession(ctx, found.row.id, body, { kind: "plugin:clawbot-wechat", wake: true });
        } catch (err) {
          return { ok: false, summary: `没送进去(会话「${label}」):${String(err).slice(0, 160)}` };
        }
        if (!sent.ok) return { ok: false, summary: `没送进去(会话「${label}」):${sent.message}` };
        return {
          ok: true,
          summary: `已送进 DSH 会话「${label}」(${body.length} 字`
            + `${sent.woke ? ",它原本没开着,已唤醒" : ""}`
            + `${sent.delivered === "steered" ? ",它正在运行,会在下一步看到" : ""})。`
            + "它会在网页里处理;要看结果用 read_dsh_session。",
        };
      },
    }),
  );
}
