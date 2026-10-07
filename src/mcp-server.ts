/** Standard stdio MCP facade over the plugin's authenticated, local HTTP routes. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CODEX_PROGRESS_STATES } from "./codex-progress.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";

export class ClawbotMcpClient {
  private readonly base: URL;
  private readonly tokenFile: string;

  constructor(options: { url?: string; tokenFile?: string } = {}) {
    this.base = new URL(options.url ?? process.env.CLAWBOT_DSH_URL ?? "http://127.0.0.1:3080");
    if (!['http:', 'https:'].includes(this.base.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname)
      || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== "/") {
      throw new Error("CLAWBOT_DSH_URL must be a loopback HTTP(S) origin without credentials, a path, or a query");
    }
    this.tokenFile = options.tokenFile ?? process.env.CLAWBOT_MCP_TOKEN_FILE ?? path.join(resolveStateDir(), "mcp-token");
  }

  async request(route: string, body?: Record<string, unknown>, query?: URLSearchParams): Promise<Record<string, unknown>> {
    let token: string;
    try { token = (await readFile(this.tokenFile, "utf8")).trim(); }
    catch { throw new Error("Cannot read the MCP bridge token. Start DSH or configure CLAWBOT_MCP_TOKEN_FILE."); }
    if (!token) throw new Error("MCP bridge token is empty; start DSH first");
    const url = new URL(`/plugins/clawbot/mcp/${route}`, this.base);
    if (query) url.search = query.toString();
    const waitMs = typeof body?.waitMs === "number" ? body.waitMs : 120_000;
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // Never forward the local secret to a redirected endpoint.
      redirect: "error",
      signal: AbortSignal.timeout(body?.waitForReply === true ? Math.min(600_000, waitMs) + 5_000 : 30_000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.ok !== true) {
      throw new Error(`DSH bridge HTTP ${response.status}: ${typeof result.message === "string" ? result.message : "request failed"}`);
    }
    return result;
  }

  async wechatSession(): Promise<Record<string, unknown>> {
    const sessions = await this.request("sessions");
    if (typeof sessions.wechatSessionId !== "string") throw new Error("DSH plugin needs the Codex bridge update");
    const history = await this.request("read", { sessionId: sessions.wechatSessionId, limit: 20 });
    return { sessionId: sessions.wechatSessionId, messages: history.messages };
  }
}

export function createClawbotMcpServer(client = new ClawbotMcpClient()): McpServer {
  const server = new McpServer({ name: "wechat-clawbot", version: "1.0.0" });
  const text = z.string().trim().min(1).max(32_000);
  const sessionId = z.string().trim().min(1).max(256);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  // Honest hints matter here: Codex decides from them whether to ask before a
  // call. Driving a DSH agent can run commands outside Codex's sandbox, and a
  // notification leaves the machine, so both must prompt. Only the progress
  // report is a local, additive write.
  const drives = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const messages = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const records = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const call = async (operation: () => Promise<Record<string, unknown>>) => {
    try {
      const result = await operation();
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "DSH bridge request failed" }] };
    }
  };

  server.registerTool("dsh_list_sessions", {
    description: "List DSH conversations and their live states. wechatSessionId identifies the conversation used by WeChat Clawbot.",
    inputSchema: {}, annotations: readOnly,
  }, () => call(() => client.request("sessions")));
  server.registerTool("dsh_get_wechat_session", {
    description: "Read the configured DSH WeChat conversation and recent text. Use it to understand messages received by Clawbot.",
    inputSchema: {}, annotations: readOnly,
  }, () => call(async () => ({ ok: true, ...await client.wechatSession() })));
  server.registerTool("dsh_read_session", {
    description: "Read recent text from a selected DSH conversation without starting any work.",
    inputSchema: { sessionId, limit: z.number().int().min(1).max(200).optional() }, annotations: readOnly,
  }, (args) => call(() => client.request("read", args)));
  server.registerTool("dsh_send_to_session", {
    description: "Send a user-authorized message to a selected live DSH conversation. This drives that conversation; it does not send a WeChat notification. List sessions first.",
    inputSchema: {
      sessionId, text, waitForReply: z.boolean().optional(), waitMs: z.number().int().min(1_000).max(600_000).optional(),
    }, annotations: drives,
  }, (args) => call(() => client.request("send", args)));
  server.registerTool("dsh_notify_wechat", {
    description: "Send one user-authorized text notification to the QR-linked WeChat owner. The recipient is fixed. A Codex-labelled copy is recorded in the DSH WeChat conversation.",
    inputSchema: { text }, annotations: messages,
  }, (args) => call(() => client.request("notify", { ...args, source: "Codex" })));
  server.registerTool("dsh_report_codex_progress", {
    description: "Publish current Codex task progress for DSH/Clawbot to query. Call at meaningful milestones and completion; use the selected Codex thread id. This stores a timestamped report and does not notify WeChat by itself.",
    inputSchema: {
      threadId: sessionId, state: z.enum(CODEX_PROGRESS_STATES), summary: z.string().trim().min(1).max(4_000),
      cwd: z.string().min(1).max(4_096).optional(), turnId: sessionId.optional(),
    }, annotations: records,
  }, (args) => call(() => client.request("codex/report", args)));
  server.registerTool("dsh_read_codex_progress", {
    description: "Read the latest timestamped Codex progress reports held by Clawbot. Reports are cached observations; check updatedAt before calling a task currently running.",
    inputSchema: { threadId: sessionId.optional() }, annotations: readOnly,
  }, (args) => call(() => client.request("codex/progress", undefined, args.threadId ? new URLSearchParams({ threadId: args.threadId }) : undefined)));
  server.registerResource("wechat-session", "clawbot://wechat-session", {
    description: "The DSH conversation used by WeChat Clawbot and its recent messages", mimeType: "application/json",
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await client.wechatSession()) }],
  }));
  return server;
}
