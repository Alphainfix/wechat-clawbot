/**
 * One WeChat message to the owner, from something other than the WeChat
 * conversation: Claude Code or Codex through the MCP routes (mcp-route.ts), or
 * any DSH conversation through the `notify_wechat` tool registered here.
 *
 * ## The recipient is not a parameter
 *
 * It goes to `account.userId`, the id linked by QR login, and nothing takes a
 * `to`. That makes "message someone who isn't the owner" unrepresentable
 * rather than merely discouraged.
 *
 * ## `notify_wechat` is global
 *
 * The tool is registered on the plugin's root context, so every DSH
 * conversation gets it, in every working directory, with no per-folder setup.
 * Only the WeChat conversation itself is left out: it already talks to the
 * owner with send_wechat_text, and a second way would double-send.
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { logger } from "./ilink/util/logger.js";
import { isSendWindowClosed, oneSentence, type Backlog, type NoticeSource } from "./backlog.js";
import { listDshSessions } from "./dsh-sessions.js";

export type OwnerNotifyDeps = {
  /** Which session gets the mirrored copy of an outbound notify. */
  config: { sessionId: string };
  /** Send one plain-text WeChat message (applies the emoji policy). */
  sendText: (to: string, text: string) => Promise<void>;
  /** The currently bound account, or null before `clawbot login`. */
  getAccount: () => ResolvedWeixinAccount | null;
  /** Where a notification waits when WeChat will not let the bot write first (see backlog.ts). */
  backlog?: Backlog;
};

/** The name every DSH conversation sees. */
export const NOTIFY_TOOL = "notify_wechat";

/**
 * Put a copy of an outbound notify into the WeChat session's history.
 *
 * Without this the bot is blind to whatever another agent told the user: reply "那怎么办"
 * to one of these messages and the bot has no idea what "那" refers to.
 *
 * `session.append`, not `followup`: an inbox item starts a turn, and the bot
 * would answer a message that was already sent. `user/message`, not
 * `assistant/message`: the latter carries turn/step bookkeeping that cannot be
 * invented safely. The prefix is what makes it legible, and prompt rule C.6
 * tells the bot what to do with one: already delivered, do not repeat.
 *
 * Best effort: the WeChat message is already out, so a mirroring failure must
 * never turn a delivered notify into a reported failure.
 */
export function mirrorIntoSession(
  ctx: Context,
  sessionId: string,
  text: string,
  sender: string,
  note?: string,
): boolean {
  try {
    const agent = ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) return false;
    const message = createUserMessage({
      // "Claude 发给用户的", but "DSH 会话「X」发给用户的": no space after a closing bracket.
      content: [{ type: "text", text: `[${sender}${sender.endsWith("」") ? "" : " "}发给用户的${note === undefined ? "" : `，${note}`}] ${text}` }],
      // v4 refuses the retired `plugin` wrapper; this is the kind the v3→v4
      // converter assigns this producer, so migrated history matches.
      source: { kind: "plugin:clawbot-mcp" } as never,
    });
    agent.session.append("user/message", message, { surfaceOp: "append" });
    logger.info(`notify: mirrored ${text.length} chars into ${sessionId}`);
    return true;
  } catch (err) {
    logger.warn(`notify: mirror failed (message was still delivered): ${String(err).slice(0, 160)}`);
    return false;
  }
}

export type NotifyOutcome =
  | { ok: true; to: string; chars: number; mirrored: boolean; deferred?: false }
  | { ok: true; to: string; chars: number; mirrored: boolean; deferred: true; summary: string; message: string }
  | { ok: false; status: number; message: string };

/**
 * Send `text` to the owner. When WeChat will not let the bot write first, keep
 * one sentence for the digest after the owner's next message instead.
 *
 * @param source - who is talking, for the digest ("Claude 的通知").
 * @param origin - which conversation, when there is one worth naming.
 */
export async function notifyOwner(
  ctx: Context,
  deps: OwnerNotifyDeps,
  input: { text: string; summary?: string; source: NoticeSource; origin?: string },
): Promise<NotifyOutcome> {
  const account = deps.getAccount();
  if (account === null || !account.configured) {
    return { ok: false, status: 503, message: "no bound WeChat account — run `clawbot login` first" };
  }
  const owner = account.userId;
  if (owner === undefined || owner === "") {
    return { ok: false, status: 503, message: "the bound account has no linked userId; re-run the QR login so it is recorded" };
  }
  const { text, source, origin } = input;
  const sender = origin === undefined ? source : `${source} 会话「${origin}」`;
  try {
    await deps.sendText(owner, text);
  } catch (err) {
    if (!isSendWindowClosed(err) || deps.backlog === undefined) throw err;
    const given = (input.summary ?? "").trim();
    const summary = given !== "" ? given.slice(0, 120) : oneSentence(text);
    deps.backlog.add(owner, {
      kind: "notice", at: new Date().toISOString(), source, summary,
      ...(origin === undefined ? {} : { origin }),
    });
    logger.info(`notify: WeChat will not let the bot write first now; kept "${summary}" for the owner's next message`);
    const mirrored = mirrorIntoSession(ctx, deps.config.sessionId, text, sender, "暂未送达，对方下次发消息后合并补发");
    return {
      ok: true,
      deferred: true,
      to: owner,
      chars: text.length,
      summary,
      mirrored,
      message: "微信现在不让 bot 主动发消息（机主有一段时间没发消息了）。这条已存下，机主下次发消息、bot 回复之后，"
        + "会和其他没送达的消息按时间合并成一条补发，这条只保留一句：" + summary,
    };
  }
  logger.info(`notify: sent ${text.length} chars to the owner (${sender})`);
  const mirrored = mirrorIntoSession(ctx, deps.config.sessionId, text, sender);
  return { ok: true, to: owner, chars: text.length, mirrored };
}

/** A conversation's title, else its folder, else its short id: how the owner will recognise it. */
async function originOf(ctx: Context, sessionId: string): Promise<string> {
  try {
    const { rows } = await listDshSessions(ctx);
    const row = rows.find((r) => r.id === sessionId);
    if (row?.title !== undefined) return row.title;
    const folder = row?.cwd?.split(/[\\/]/).filter((s) => s !== "").pop();
    if (folder !== undefined) return folder;
  } catch {
    // fall through to the id
  }
  return sessionId.slice(0, 8);
}

/**
 * Who serves the tool. DSH re-applies this plugin on a hot reload without
 * disposing the old instance (instance-guard.ts), so the tool is registered
 * once per process and reads the NEWEST instance's dependencies from here; a
 * closure would keep sending through the superseded one.
 */
type NotifySlot = { ctx: Context; deps: OwnerNotifyDeps; registered: boolean };
const SLOT = Symbol.for("clawbot.notify-wechat");
const slots = globalThis as unknown as Record<symbol, NotifySlot | undefined>;

/**
 * Register `notify_wechat` for every DSH conversation.
 *
 * @param ctx - the plugin's ROOT context: a tool registered there is global.
 */
export function registerOwnerNotifyTool(ctx: Context, deps: OwnerNotifyDeps): void {
  const existing = slots[SLOT];
  if (existing?.registered === true) {
    existing.ctx = ctx;
    existing.deps = deps;
    logger.info(`${NOTIFY_TOOL}: already registered in this process; now served by the newest instance`);
    return;
  }
  const slot: NotifySlot = { ctx, deps, registered: false };
  slots[SLOT] = slot;
  const serving = (): NotifySlot => slots[SLOT] ?? slot;
  const tool = (
    defineTool({
      name: NOTIFY_TOOL,
      description:
        "Send a WeChat message to the owner of this computer (the person who linked the WeChat bot). "
        + "Use it when the owner asked to be told on WeChat, when a long task finishes or fails, or when it "
        + "needs a decision while they are away. Keep it short and self-contained: they read it on their phone "
        + "without this conversation in front of them, so say which task it is about. Do not use it for "
        + "ordinary replies — they are shown here. If WeChat will not let the bot write first right now "
        + "(the owner has been silent for about a day), the message is kept and delivered after their next "
        + "WeChat message; the result says so.",
      parameters: {
        text: { type: "string", required: true, description: "The message, as the owner should read it." },
        summary: {
          type: "string",
          description: "Optional one-sentence version, used if the message has to wait and is folded into a digest.",
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
      async execute(args, exec) {
        const { ctx, deps } = serving();
        const { text, summary } = args as { text?: string; summary?: string };
        const body = (text ?? "").trim();
        if (body === "") return { ok: false, summary: "消息是空的,没有发送" };
        const caller = String((exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id ?? "");
        if (caller !== "" && caller === deps.config.sessionId) {
          return { ok: false, summary: "这是微信会话本身:直接用 send_wechat_text 回复。" };
        }
        const origin = caller === "" ? undefined : await originOf(ctx, caller);
        try {
          const outcome = await notifyOwner(ctx, deps, {
            text: body,
            ...(typeof summary === "string" ? { summary } : {}),
            source: "DSH",
            ...(origin === undefined ? {} : { origin }),
          });
          if (!outcome.ok) return { ok: false, summary: `没发出去:${outcome.message}` };
          if (outcome.deferred === true) return { ok: true, summary: outcome.message };
          return { ok: true, summary: `已发到机主微信(${outcome.chars} 字)。` };
        } catch (err) {
          logger.warn(`${NOTIFY_TOOL}: ${String(err).slice(0, 200)}`);
          return { ok: false, summary: `没发出去:${String(err).slice(0, 200)}` };
        }
      },
    })
  );
  const register = (): (() => void) => {
    const off = ctx.tools.register(tool);
    slot.registered = true;
    return () => {
      off();
      // If the host ever does dispose this instance, the next one registers again.
      if (slots[SLOT] === slot) slot.registered = false;
    };
  };
  const scoped = ctx as unknown as { effect?: (fn: () => () => void, label?: string) => void };
  if (typeof scoped.effect === "function") scoped.effect(register, `clawbot: ${NOTIFY_TOOL}`);
  else register();
  logger.info(`${NOTIFY_TOOL}: registered for every DSH conversation except ${deps.config.sessionId}`);
}
