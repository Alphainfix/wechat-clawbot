/**
 * `/plugins/clawbot/mcp/*` — the HTTP surface a local MCP server calls, so
 * Claude Code can see what DSH is doing, drive a session, and reach the owner
 * on WeChat.
 *
 * ## Why the privileged half lives here and not in the MCP server
 *
 * All three capabilities need things that only exist *inside* the running
 * harness: `ctx.agents` holds the live agent objects (an out-of-process caller
 * cannot `steer()` anything), and the WeChat send needs the account token plus
 * the per-peer context token. Reproducing either outside would mean a second
 * copy of the credential handling — so the MCP server stays a dumb HTTP client
 * and every privileged operation happens in this file.
 *
 * ## Who can call it
 *
 * The web server binds loopback only, but "any local process" is still a wider
 * door than this deserves: two of these routes have side effects that reach the
 * owner's phone. So every route needs `Authorization: Bearer <token>`, read
 * from `<state>/mcp-token` (0600, generated on first start). The MCP server
 * reads the same file — the secret is never copied into config, args, or git.
 *
 * ## The recipient is not a parameter
 *
 * `notify` sends to `account.userId` — the id linked by QR login — and takes no
 * `to` at all. That is deliberate: it makes "message someone who isn't the
 * owner" unrepresentable rather than merely discouraged. clawbot already treats
 * that field as "the WeChat owner" when attributing scheduled reminders.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

/** The one method this file uses, structurally — see models-route.ts. */
type WebServerLike = {
  register: (route: {
    kind: "exact";
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => () => void;
};

/** What the route module needs from the plugin body. */
export type McpRouteDeps = {
  /**
   * The LIVE config object, held by reference so `mcpBridge` can be flipped
   * from the settings page without a restart. Read at request time, never
   * snapshotted here.
   */
  config: {
    mcpBridge: boolean;
    /** Which session gets the mirrored copy of an outbound notify. Cold field. */
    sessionId: string;
  };
  /** Send one plain-text WeChat message (applies the emoji policy). */
  sendText: (to: string, text: string) => Promise<void>;
  /** The currently bound account, or null before `clawbot login`. */
  getAccount: () => ResolvedWeixinAccount | null;
};

/** Largest request body accepted, so a stray POST cannot balloon memory. */
const MAX_BODY_BYTES = 64 * 1024;

/** Default ceiling on how long `send` will wait for the turn to finish. */
const DEFAULT_WAIT_MS = 120_000;

/** How much of one message's text a tail entry keeps. */
const TAIL_TEXT_CAP = 2_000;

// ------------------------------------------------------------------ the token

function tokenPath(): string {
  return path.join(resolveStateDir(), "mcp-token");
}

/**
 * Read the shared secret, generating it on first use.
 *
 * `mode` on `writeFileSync` only applies when the file is created, so the
 * chmod is unconditional — a token file left at 0644 by an earlier build would
 * otherwise stay world-readable forever.
 */
export function ensureMcpToken(): string {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) {
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      return existing;
    }
  } catch {
    // absent — fall through and mint one
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  logger.info(`mcp: minted a new bridge token at ${file}`);
  return token;
}

/** Constant-time compare that tolerates length mismatch. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf-8");
  const right = Buffer.from(b, "utf-8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------- observation

/**
 * What the settings card shows. Kept in memory on purpose: this is "has Claude
 * actually talked to us", which is a fact about the current process. Persisting
 * it would answer a different, less useful question.
 */
const stats = {
  calls: 0,
  lastCallAt: 0,
  lastRoute: "",
  rejected: 0,
  lastRejectedAt: 0,
};

// ------------------------------------------------------------------- plumbing

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error(`body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

/** Pull the plain text out of a surface event, whatever kind it is. */
function eventText(event: { type: string; data?: unknown }): string {
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

/**
 * Put a copy of an outbound notify into the WeChat session's history.
 *
 * Without this the bot is blind to whatever Claude told the user: reply "那怎么办"
 * to one of these messages and the bot has no idea what "那" refers to. The copy
 * closes that gap.
 *
 * ## Why `session.append` and not `followup`
 *
 * `followup`/`steer` put an item in the agent's INBOX, which starts a turn — the
 * bot would answer a message that was already sent, to a user who did not ask it
 * anything. `append` is the event-sourcing primitive: it records into the log and
 * dispatches nothing. That is precisely the wanted behaviour — history gains an
 * entry, the driver stays asleep.
 *
 * ## Why `user/message` and not `assistant/message`
 *
 * Semantically an assistant message is the closer fit — this text did go out to
 * the user. But that event carries `{ turn, step, message }`, and turn/step are
 * the session's own turn bookkeeping; inventing values risks exactly the kind of
 * structural damage that an orphaned event does (one such bug bricked a session
 * here and could only be fixed by hand-editing the log). `'user/message'` is
 * just a `UserMessage` — nothing to fabricate — and it is already how this
 * bridge and dsh-schedule inject out-of-band context.
 *
 * The prefix is what makes it legible to the model, and prompt rule C.6 tells it
 * what to do with one: already delivered, do not repeat, do not reply.
 *
 * Best effort throughout. The WeChat message has already been sent by the time
 * this runs, so a mirroring failure must never turn a delivered notify into a
 * reported failure.
 */
function mirrorIntoSession(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const agent = ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) return false;
    const message = createUserMessage({
      content: [{ type: "text", text: `[Claude 发给用户的] ${text}` }],
      // v4 refuses the retired `plugin` wrapper; this is the kind the v3→v4
      // converter assigns this producer, so migrated history matches.
      source: { kind: "plugin:clawbot-mcp" } as never,
    });
    agent.session.append("user/message", message, { surfaceOp: "append" });
    logger.info(`mcp notify: mirrored ${text.length} chars into ${sessionId}`);
    return true;
  } catch (err) {
    logger.warn(`mcp notify: mirror failed (message was still delivered): ${String(err).slice(0, 160)}`);
    return false;
  }
}

// --------------------------------------------------------------------- routes

type Handlers = {
  sessions: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  read: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  sendMessage: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  notify: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/**
 * `ctx.get` rather than a declared dependency: a headless composition may have
 * no session-query backend, and this bridge should degrade to "live agents
 * only" instead of refusing to load. Reading an un-injected service directly
 * would THROW — cordis does not return undefined.
 */
type SessionQueryLike = {
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

function buildHandlers(ctx: Context, deps: McpRouteDeps): Handlers {
  const sessionQuery = (): SessionQueryLike | undefined =>
    ctx.get("sessionQuery") as SessionQueryLike | undefined;

  return {
    /** Which conversations exist, which are live, which are mid-turn. */
    async sessions(_req, res) {
      const live = new Map<string, ReturnType<typeof ctx.agents.list>[number]>(
        ctx.agents.list().map((a) => [String(a.session.id), a]),
      );
      const sq = sessionQuery();
      if (sq === undefined) {
        // Degraded: no corpus, so only the agents currently in memory.
        send(res, 200, {
          ok: true,
          degraded: "no sessionQuery service; listing live agents only",
          sessions: [...live.values()].map((a) => ({
            id: String(a.session.id),
            live: true,
            running: a.status === "running",
            cwd: a.session.header.cwd,
          })),
        });
        return;
      }
      const records = await sq.listSessions();
      const ids = records.map((r) => r.header.id);
      // One batched call — readTitle per session would be N round trips, and
      // titles are the whole point of a list a human reads.
      let titles: readonly { status: string; value?: { title?: { title?: string } } }[] = [];
      try {
        titles = await sq.readTitleSnapshots(ids);
      } catch (err) {
        logger.warn(`mcp sessions: title fold failed: ${String(err).slice(0, 120)}`);
      }
      const sessions = records.map((record, index) => {
        const agent = live.get(record.header.id);
        const title = titles[index]?.status === "fulfilled"
          ? titles[index]?.value?.title?.title
          : undefined;
        return {
          id: record.header.id,
          ...(title === undefined ? {} : { title }),
          ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
          createdAt: new Date(record.header.createdAt).toISOString(),
          live: record.live,
          persisted: record.persisted,
          // The distinction that matters for "正在进行": live means resumed into
          // memory, running means a turn is executing right now.
          running: agent?.status === "running",
        };
      });
      send(res, 200, { ok: true, sessions });
    },

    /** The tail of one conversation, as plain text. */
    async read(req, res) {
      const body = await readJsonBody(req);
      const sessionId = requireString(body, "sessionId");
      const rawLimit = Number(body.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 20;
      const sq = sessionQuery();
      if (sq === undefined) {
        send(res, 501, { ok: false, message: "no sessionQuery service in this composition" });
        return;
      }
      const surface = await sq.readSurface(sessionId);
      const messages = surface.events
        .filter((e) => e.type === "user/message" || e.type === "assistant/message")
        .map((e) => ({
          role: e.type === "user/message" ? "user" : "assistant",
          at: new Date(e.time).toISOString(),
          seq: e.seq,
          text: eventText(e).slice(0, TAIL_TEXT_CAP),
        }))
        .filter((m) => m.text !== "");
      send(res, 200, {
        ok: true,
        sessionId,
        total: messages.length,
        messages: messages.slice(-limit),
      });
    },

    /**
     * Put a message into a live session.
     *
     * steer vs followup is not a style choice: a running driver must be steered
     * into its nearest step, while an idle one needs followup to start a turn.
     * Calling the wrong one either drops the message or starts a second
     * concurrent turn — the same distinction WechatBridge.drainQueue makes.
     */
    async sendMessage(req, res) {
      const body = await readJsonBody(req);
      const sessionId = requireString(body, "sessionId");
      const text = requireString(body, "text");
      const wait = body.waitForReply === true;
      const waitMs = Number.isFinite(Number(body.waitMs))
        ? Math.min(Math.max(Math.trunc(Number(body.waitMs)), 1_000), 600_000)
        : DEFAULT_WAIT_MS;

      const agent = ctx.agents.get(SessionId(sessionId));
      if (agent === undefined) {
        send(res, 409, {
          ok: false,
          message:
            `session "${sessionId}" is not live — nothing is holding it in memory. ` +
            "Open it in the web UI (or send it a WeChat message) and try again.",
        });
        return;
      }
      // A distinct plugin source, NOT "wechat-clawbot": the bridge's
      // session listener treats any non-schedule plugin turn as GUI-only and
      // leaves currentSender unset, so a message injected here is answered in
      // the web UI and does NOT get forwarded to WeChat. That is the intended
      // split — dsh_wechat_notify is the only route that reaches the phone.
      const message = createUserMessage({
        content: [{ type: "text", text }],
        // v4 refuses the retired `plugin` wrapper; this is the kind the v3→v4
        // converter assigns this producer, so migrated history matches.
        source: { kind: "plugin:clawbot-mcp" } as never,
      });
      const before = agent.session.seq;
      const wasRunning = agent.status === "running";
      if (wasRunning) agent.steer(message);
      else agent.followup(message);
      logger.info(
        `mcp send: ${wasRunning ? "steered" : "followed up"} ${text.length} chars into ${sessionId}`,
      );

      if (!wait) {
        send(res, 200, { ok: true, sessionId, delivered: wasRunning ? "steered" : "followup" });
        return;
      }
      // Never hold the HTTP request open indefinitely: a long agent turn would
      // look like a hung MCP tool call with no way to tell the two apart.
      let timedOut = false;
      await Promise.race([
        agent.whenIdle(),
        new Promise<void>((resolve) => {
          setTimeout(() => { timedOut = true; resolve(); }, waitMs).unref?.();
        }),
      ]);
      const replies: string[] = [];
      for (const event of agent.session.snapshotEvents()) {
        if (event.seq <= before) continue;
        if (event.type !== "assistant/message") continue;
        const body_ = eventText(event as { type: string; data?: unknown });
        if (body_) replies.push(body_.slice(0, TAIL_TEXT_CAP));
      }
      send(res, 200, {
        ok: true,
        sessionId,
        delivered: wasRunning ? "steered" : "followup",
        ...(timedOut ? { stillRunning: true, waitedMs: waitMs } : {}),
        replies,
      });
    },

    /** Push one WeChat message to the QR-linked owner. */
    async notify(req, res) {
      const body = await readJsonBody(req);
      const text = requireString(body, "text");
      const account = deps.getAccount();
      if (account === null || !account.configured) {
        send(res, 503, { ok: false, message: "no bound WeChat account — run `clawbot login` first" });
        return;
      }
      const owner = account.userId;
      if (owner === undefined || owner === "") {
        send(res, 503, {
          ok: false,
          message: "the bound account has no linked userId; re-run the QR login so it is recorded",
        });
        return;
      }
      await deps.sendText(owner, text);
      logger.info(`mcp notify: sent ${text.length} chars to the owner`);
      const mirrored = mirrorIntoSession(ctx, deps.config.sessionId, text);
      // Echo the recipient back so a wrong destination would be visible at the
      // call site instead of only in the recipient's chat. `mirrored` says
      // whether the bot's own history now contains a copy.
      send(res, 200, { ok: true, to: owner, chars: text.length, mirrored });
    },
  };
}

/**
 * Register the four routes.
 *
 * `webServer` goes through `ctx.inject` so a headless composition without it
 * simply has no bridge, rather than failing the whole plugin tree.
 */
export function registerMcpRoutes(ctx: Context, deps: McpRouteDeps): void {
  const token = ensureMcpToken();
  const handlers = buildHandlers(ctx, deps);
  const routes: Array<{ path: string; method: "GET" | "POST"; run: Handlers[keyof Handlers] }> = [
    { path: "/plugins/clawbot/mcp/sessions", method: "GET", run: handlers.sessions },
    { path: "/plugins/clawbot/mcp/read", method: "POST", run: handlers.read },
    { path: "/plugins/clawbot/mcp/send", method: "POST", run: handlers.sendMessage },
    { path: "/plugins/clawbot/mcp/notify", method: "POST", run: handlers.notify },
  ];

  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;

    // Status is deliberately NOT behind the bearer token: the settings card is
    // a browser page and cannot hold the secret, and this answers nothing an
    // attacker gains from — no token, no ids, no message content, just whether
    // the bridge is on and whether anything has used it. It is also outside the
    // `mcpBridge` gate, because "is it off?" is the question you ask when it is
    // off.
    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: "/plugins/clawbot/mcp/status",
          handler(_req: IncomingMessage, res: ServerResponse) {
            let tokenReady = false;
            try {
              tokenReady = fs.readFileSync(tokenPath(), "utf-8").trim() !== "";
            } catch {
              tokenReady = false;
            }
            send(res, 200, {
              ok: true,
              enabled: deps.config.mcpBridge === true,
              tokenReady,
              tokenPath: tokenPath(),
              calls: stats.calls,
              lastCallAt: stats.lastCallAt === 0 ? null : new Date(stats.lastCallAt).toISOString(),
              lastRoute: stats.lastRoute === "" ? null : stats.lastRoute,
              rejected: stats.rejected,
            });
          },
        }),
      "clawbot: mcp status route",
    );

    for (const route of routes) {
      scoped.effect(
        () =>
          server.register({
            kind: "exact",
            path: route.path,
            async handler(req: IncomingMessage, res: ServerResponse) {
              if ((req.method ?? "GET") !== route.method) {
                send(res, 405, { ok: false, message: `use ${route.method}` });
                return;
              }
              // Read the switch per request, not at registration: that is what
              // makes it a live kill switch. Routes stay registered when it is
              // off so turning it back on needs no restart either.
              if (deps.config.mcpBridge !== true) {
                send(res, 403, {
                  ok: false,
                  message: "Claude 桥已在设置里关闭(微信 Bot → 开放 Claude 桥)",
                });
                return;
              }
              if (!secretEquals(bearer(req), token)) {
                stats.rejected += 1;
                stats.lastRejectedAt = Date.now();
                // No detail about what was wrong: an unauthenticated caller
                // learns only that it needs a token.
                send(res, 401, { ok: false, message: "bad or missing bearer token" });
                return;
              }
              stats.calls += 1;
              stats.lastCallAt = Date.now();
              stats.lastRoute = route.path.replace("/plugins/clawbot/mcp/", "");
              try {
                await route.run(req, res);
              } catch (err) {
                const detail = String(err).slice(0, 200);
                logger.warn(`mcp ${route.path}: ${detail}`);
                if (!res.headersSent) send(res, 400, { ok: false, message: detail });
              }
            },
          }),
        `clawbot: mcp route ${route.path}`,
      );
    }
    logger.info(`mcp: bridge routes registered (token at ${tokenPath()})`);
  });
}
