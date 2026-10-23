/**
 * `/plugins/clawbot/mcp/*` — the HTTP surface a local MCP server calls, so
 * Claude Code / Codex can see what DSH is doing, drive a session, and reach the owner
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
import { SessionId } from "@deepseek-ai/dsh-session";

import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";
import { CodexProgressStore, type CodexProgressState } from "./codex-progress.js";
import type { Backlog } from "./backlog.js";
import { eventText, listDshSessions, readDshSession, sendToDshSession, TAIL_TEXT_CAP } from "./dsh-sessions.js";
import { notifyOwner } from "./owner-notify.js";
import { localRequest } from "./secretary.js";

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
  /** Where a notification waits when WeChat will not let the bot write first (see backlog.ts). */
  backlog?: Backlog;
  /** Shared with the DSH Codex tools. Process-local, never a workspace index. */
  codexProgress?: CodexProgressStore;
};

/** Largest request body accepted, so a stray POST cannot balloon memory. */
const MAX_BODY_BYTES = 64 * 1024;

/** Default ceiling on how long `send` will wait for the turn to finish. */
const DEFAULT_WAIT_MS = 120_000;

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
 * What the settings card shows. Kept in memory on purpose: this is "has an MCP client
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

// --------------------------------------------------------------------- routes

type Handlers = {
  sessions: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  read: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  sendMessage: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  notify: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  reportProgress: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readProgress: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/**
 * The session and notify logic lives in dsh-sessions.ts / owner-notify.ts, which
 * the WeChat bot's own tools and the global notify_wechat tool share; these
 * handlers only translate it to and from HTTP.
 */
function buildHandlers(ctx: Context, deps: McpRouteDeps): Handlers {
  const progress = deps.codexProgress ?? new CodexProgressStore();

  return {
    /** Which conversations exist, which are live, which are mid-turn. */
    async sessions(_req, res) {
      const { rows, degraded } = await listDshSessions(ctx);
      if (degraded !== undefined) {
        // Degraded: no corpus, so only the agents currently in memory.
        send(res, 200, {
          ok: true,
          wechatSessionId: deps.config.sessionId,
          degraded,
          sessions: rows.map((r) => ({ id: r.id, live: true, running: r.running, cwd: r.cwd })),
        });
        return;
      }
      send(res, 200, {
        ok: true,
        wechatSessionId: deps.config.sessionId,
        sessions: rows.map((r) => ({
          id: r.id,
          ...(r.title === undefined ? {} : { title: r.title }),
          ...(r.cwd === undefined ? {} : { cwd: r.cwd }),
          createdAt: new Date(r.createdAt).toISOString(),
          live: r.live,
          persisted: r.persisted,
          // The distinction that matters for "正在进行": live means resumed into
          // memory, running means a turn is executing right now.
          running: r.running,
        })),
      });
    },

    /** The tail of one conversation, as plain text. */
    async read(req, res) {
      const body = await readJsonBody(req);
      const sessionId = requireString(body, "sessionId");
      const rawLimit = Number(body.limit ?? 20);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 20;
      const messages = await readDshSession(ctx, sessionId);
      if (messages === undefined) {
        send(res, 501, { ok: false, message: "no sessionQuery service in this composition" });
        return;
      }
      send(res, 200, {
        ok: true,
        sessionId,
        total: messages.length,
        messages: messages.slice(-limit).map((m) => ({ ...m, at: new Date(m.at).toISOString() })),
      });
    },

    /**
     * Put a message into a live session (sendToDshSession has the steer vs
     * followup rule). Only a live one: a coding agent that wakes conversations
     * nobody is looking at is a bigger step than this route was granted.
     */
    async sendMessage(req, res) {
      const body = await readJsonBody(req);
      const sessionId = requireString(body, "sessionId");
      const text = requireString(body, "text");
      const wait = body.waitForReply === true;
      const waitMs = Number.isFinite(Number(body.waitMs))
        ? Math.min(Math.max(Math.trunc(Number(body.waitMs)), 1_000), 600_000)
        : DEFAULT_WAIT_MS;

      // A distinct plugin source, NOT "wechat-clawbot": the bridge's
      // session listener treats any non-schedule plugin turn as GUI-only and
      // leaves currentSender unset, so a message injected here is answered in
      // the web UI and does NOT get forwarded to WeChat. That is the intended
      // split — dsh_wechat_notify is the only route that reaches the phone.
      const sent = await sendToDshSession(ctx, sessionId, text, { kind: "plugin:clawbot-mcp", wake: false });
      if (!sent.ok) {
        send(res, 409, { ok: false, message: sent.message });
        return;
      }
      if (!wait) {
        send(res, 200, { ok: true, sessionId, delivered: sent.delivered });
        return;
      }
      const agent = ctx.agents.get(SessionId(sessionId));
      if (agent === undefined) {
        send(res, 200, { ok: true, sessionId, delivered: sent.delivered, replies: [] });
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
        if (event.seq <= sent.before) continue;
        if (event.type !== "assistant/message") continue;
        const body_ = eventText(event as { type: string; data?: unknown });
        if (body_) replies.push(body_.slice(0, TAIL_TEXT_CAP));
      }
      send(res, 200, {
        ok: true,
        sessionId,
        delivered: sent.delivered,
        ...(timedOut ? { stillRunning: true, waitedMs: waitMs } : {}),
        replies,
      });
    },

    /** Push one WeChat message to the QR-linked owner. */
    async notify(req, res) {
      const body = await readJsonBody(req);
      const text = requireString(body, "text");
      if (body.source !== undefined && body.source !== "Claude" && body.source !== "Codex") {
        throw new Error('"source" must be Claude or Codex');
      }
      if (body.summary !== undefined && typeof body.summary !== "string") throw new Error('"summary" must be a string');
      const outcome = await notifyOwner(ctx, deps, {
        text,
        ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
        source: body.source === "Codex" ? "Codex" : "Claude",
      });
      if (!outcome.ok) {
        send(res, outcome.status, { ok: false, message: outcome.message });
        return;
      }
      // Echo the recipient back so a wrong destination would be visible at the
      // call site instead of only in the recipient's chat. `mirrored` says
      // whether the bot's own history now contains a copy.
      send(res, 200, outcome);
    },

    async reportProgress(req, res) {
      const body = await readJsonBody(req);
      const entry = progress.report({
        threadId: requireString(body, "threadId"),
        state: requireString(body, "state") as CodexProgressState,
        summary: requireString(body, "summary"),
        ...(body.cwd === undefined ? {} : { cwd: requireString(body, "cwd") }),
        ...(body.turnId === undefined ? {} : { turnId: requireString(body, "turnId") }),
        source: "codex-mcp",
      });
      send(res, 200, { ok: true, progress: entry });
    },

    async readProgress(req, res) {
      const threadId = new URL(req.url ?? "/", "http://localhost").searchParams.get("threadId") ?? undefined;
      send(res, 200, { ok: true, progress: progress.list(threadId) });
    },
  };
}

/**
 * Register session, notification, and Codex progress routes.
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
    { path: "/plugins/clawbot/mcp/codex/report", method: "POST", run: handlers.reportProgress },
    { path: "/plugins/clawbot/mcp/codex/progress", method: "GET", run: handlers.readProgress },
  ];

  ctx.inject(["webServer"], (scoped) => {
    const server = (scoped as unknown as { webServer: WebServerLike }).webServer;

    // Status is deliberately NOT behind the bearer token: the settings card is
    // a browser page and cannot hold the secret, and this answers nothing an
    // attacker gains from — no token, no ids, no message content, just whether
    // the bridge is on and whether anything has used it. It is also outside the
    // `mcpBridge` gate, because "is it off?" is the question you ask when it is
    // off. It does name the token file's path, so only this machine's page gets
    // an answer (a page rebound to 127.0.0.1 does not: see localRequest).
    scoped.effect(
      () =>
        server.register({
          kind: "exact",
          path: "/plugins/clawbot/mcp/status",
          handler(req: IncomingMessage, res: ServerResponse) {
            if (!localRequest(req)) {
              send(res, 403, { ok: false, error: "only this machine's settings card" });
              return;
            }
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
                  message: "MCP 桥已在设置里关闭(微信 Bot → 开放 MCP 桥)",
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
