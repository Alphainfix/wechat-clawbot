/** DSH tools for selecting Codex projects/threads, relaying text, and reading progress. */
import path from "node:path";
import os from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { ClawbotConfig } from "./config.js";
import { CodexAppServer, CodexRpcError, findCodexBinary, type CodexRpc, type RpcMessage } from "./codex-rpc.js";
import { CodexProgressStore } from "./codex-progress.js";

type Status = { type: string; activeFlags?: string[] };
type Item = { type: string; text?: string; content?: Array<{ type: string; text?: string }>; status?: string };
type Turn = { id: string; status: string; items: Item[]; error?: { message?: string } | null };
export type CodexThread = {
  id: string;
  cwd: string;
  projectId?: string | null;
  name?: string | null;
  preview?: string;
  updatedAt?: number;
  status: Status;
  turns?: Turn[];
};
type ThreadPage = { data: CodexThread[]; nextCursor: string | null };
type PeerConfig = Pick<ClawbotConfig, "codexPeer" | "codexTransport" | "codexBinary" | "codexSocket">;
const SOURCES = ["cli", "vscode", "appServer", "exec", "unknown"];

function stateLabel(status: Status): string {
  if (status.type === "active") {
    return status.activeFlags?.length ? `等待: ${status.activeFlags.join(", ")}` : "运行中";
  }
  return { idle: "空闲", notLoaded: "未加载,实时状态未知", systemError: "服务错误" }[status.type] ?? status.type;
}

function describe(thread: CodexThread): string {
  return `${thread.id} | ${thread.name || thread.preview?.slice(0, 100) || "未命名"}`
    + ` | ${stateLabel(thread.status)} | ${thread.cwd}`;
}

export class CodexPeer {
  private readonly rpc: CodexRpc;
  private readonly threads = new Map<string, CodexThread>();
  private readonly sends = new Map<string, Promise<unknown>>();
  private readonly questions = new Map<string, { threadId: unknown; turnId: unknown; abort: AbortController }>();

  constructor(
    private readonly config: PeerConfig,
    readonly progress: CodexProgressStore,
    options: {
      rpc?: CodexRpc;
      askWechat?: (question: string, signal?: AbortSignal) => Promise<string | null>;
    } = {},
  ) {
    this.rpc = options.rpc ?? new CodexAppServer({
      ...(config.codexTransport === "stdio" ? {
        command: findCodexBinary(config.codexBinary), args: ["app-server", "--listen", "stdio://"],
      } : {
        socketPath: config.codexSocket ?? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "app-server-control", "app-server-control.sock"),
      }),
      onNotification: (message) => this.observe(message),
      onRequest: async (message) => {
        const params = message.params ?? {};
        if (typeof params.threadId === "string") {
          this.record(params.threadId, "waiting", `Codex 需要处理 ${message.method}`, params.turnId);
        }
        // A shared server's existing Codex client keeps ownership of approval UI.
        if (config.codexTransport !== "stdio") return undefined;
        const key = JSON.stringify(message.id);
        const abort = new AbortController();
        this.questions.set(key, { threadId: params.threadId, turnId: params.turnId, abort });
        try {
          if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
            const detail = params.command ?? params.reason ?? params.itemId ?? "文件改动";
            const reply = await options.askWechat?.(`【Codex 权限请求】\n${String(detail).slice(0, 2_000)}\n请回复: 同意 / 拒绝`, abort.signal);
            if (abort.signal.aborted) return undefined;
            const accepted = /^(同意|允许|批准|确认|yes|y|ok|approve)[。.!！\s]*$/i.test(reply?.trim() ?? "");
            return { decision: accepted ? "accept" : "decline" };
          }
          if (message.method === "item/permissions/requestApproval") return { permissions: {} };
          if (message.method === "mcpServer/elicitation/request") return { action: "decline", content: null };
          if (message.method === "item/tool/requestUserInput") {
            const questions = params.questions as Array<{ id: string; question: string }> | undefined;
            const answers: Record<string, { answers: string[] }> = {};
            for (const question of questions ?? []) {
              const reply = await options.askWechat?.(`【Codex 提问】\n${question.question}`, abort.signal);
              if (abort.signal.aborted) return undefined;
              answers[question.id] = { answers: reply === null || reply === undefined ? [] : [reply] };
            }
            return { answers };
          }
          throw new CodexRpcError(`Unsupported Codex client request: ${message.method}`, -32601);
        } finally { this.questions.delete(key); }
      },
    });
  }

  private enabled(): void {
    if (!this.config.codexPeer) throw new Error("Codex 会话联动已在设置里关闭");
  }

  close(): void {
    for (const question of this.questions.values()) question.abort.abort();
    this.questions.clear();
    this.rpc.close();
  }

  private remember(thread: CodexThread): CodexThread {
    this.threads.delete(thread.id);
    this.threads.set(thread.id, thread);
    while (this.threads.size > 500) this.threads.delete(this.threads.keys().next().value!);
    return thread;
  }

  async list(project?: string, cursor?: string, limit = 50): Promise<ThreadPage> {
    this.enabled();
    if (project && !path.isAbsolute(project)) throw new Error("project 必须是 list_codex_projects 返回的完整工作目录");
    const page = await this.rpc.request<ThreadPage>("thread/list", {
      sourceKinds: SOURCES,
      sortKey: "updated_at",
      limit: Math.min(100, Math.max(1, Math.trunc(limit) || 50)),
      ...(project ? { cwd: project } : {}),
      ...(cursor ? { cursor } : {}),
    });
    for (const thread of page.data) this.remember(thread);
    return page;
  }

  /** IDs are authoritative. Short IDs/titles must resolve uniquely across all pages. */
  private async resolve(session: string, project?: string): Promise<CodexThread> {
    this.enabled();
    if (!session.trim()) throw new Error("请先选择 Codex 会话");
    if (project && !path.isAbsolute(project)) throw new Error("project 必须是完整工作目录");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) {
      const { thread } = await this.rpc.request<{ thread: CodexThread }>("thread/read", { threadId: session });
      if (project && thread.cwd !== project) throw new Error("会话不属于所选项目,没有发送");
      return this.remember(thread);
    }
    const candidates: CodexThread[] = [];
    let cursor: string | undefined;
    // Bound work while refusing to infer uniqueness from an incomplete roster.
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await this.list(project, cursor, 100);
      candidates.push(...page.data);
      if (!page.nextCursor) break;
      if (pageNumber === 19 || page.nextCursor === cursor) {
        throw new Error("会话列表尚未读完,请用 list_codex_sessions 的完整会话 id");
      }
      cursor = page.nextCursor;
    }
    const query = session.trim().toLowerCase();
    const exact = candidates.filter((thread) => thread.id === session || thread.name?.toLowerCase() === query);
    const matches = exact.length ? exact : candidates.filter((thread) =>
      thread.id.toLowerCase().startsWith(query) || thread.name?.toLowerCase().includes(query));
    if (matches.length !== 1) {
      const roster = matches.length ? matches : candidates;
      throw new Error(`${matches.length ? "多个会话匹配" : "找不到会话"},请指定项目和完整 id:\n`
        + roster.slice(0, 20).map(describe).join("\n"));
    }
    return matches[0]!;
  }

  async read(session: string, project?: string, limit = 10): Promise<CodexThread> {
    const selected = await this.resolve(session, project);
    const { thread } = await this.rpc.request<{ thread: CodexThread }>("thread/read", {
      threadId: selected.id,
    });
    this.remember(thread);
    return { ...thread, turns: await this.latestTurns(thread.id, limit) };
  }

  private async latestTurns(threadId: string, limit: number): Promise<Turn[]> {
    const count = Math.min(30, Math.max(1, Math.trunc(limit) || 10));
    try {
      const page = await this.rpc.request<{ data: Turn[] }>("thread/turns/list", {
        // Full items include command output and tool results that can exceed the
        // RPC frame limit in long tasks. Summaries retain the text we report.
        threadId, limit: count, sortDirection: "desc", itemsView: "summary",
      });
      return [...page.data].reverse();
    } catch (error) {
      // A new, empty thread exists in memory before its first message creates history.
      if (error instanceof CodexRpcError && error.code === -32600 && error.message.includes("not materialized yet")) return [];
      // Only an unsupported read API gets a compatibility fallback. Never replay sends.
      if (!(error instanceof CodexRpcError) || error.code !== -32601) throw error;
      const { thread } = await this.rpc.request<{ thread: CodexThread }>("thread/read", { threadId, includeTurns: true });
      return (thread.turns ?? []).slice(-count);
    }
  }

  async send(session: string, text: string, project?: string, allowResume = false): Promise<{ threadId: string; delivered: string; turnId: string }> {
    if (!text.trim() || text.length > 32_000) throw new Error("消息必须包含 1–32000 个字符");
    const selected = await this.resolve(session, project);
    const previous = this.sends.get(selected.id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.enabled();
      let { thread } = await this.rpc.request<{ thread: CodexThread }>("thread/read", {
        threadId: selected.id,
      });
      if (project && thread.cwd !== project) throw new Error("会话所属项目发生变化,没有发送");
      if (thread.status.type === "notLoaded" && !allowResume) {
        throw new Error("此服务未加载会话,无法判断另一个 Codex 客户端是否正在工作。先关闭原会话,明确允许后台续聊后设置 allowResume: true;实时转发需将原客户端连接到同一共享服务");
      }
      if (thread.status.type === "systemError") throw new Error("Codex 会话处于服务错误状态");
      // Resume also subscribes to events. No model, cwd, sandbox, or approval override.
      ({ thread } = await this.rpc.request<{ thread: CodexThread }>("thread/resume", { threadId: thread.id, excludeTurns: true }));
      this.remember(thread);
      if (thread.status.type !== "idle" && thread.status.type !== "active") {
        throw new Error("Codex 没有返回可投递的运行状态,没有发送");
      }
      const input = [{ type: "text", text: `[由 DSH 微信 clawbot 转发的用户消息]\n${text}`, text_elements: [] }];
      if (thread.status.type === "active") {
        const active = (await this.latestTurns(thread.id, 1)).find((turn) => turn.status === "inProgress");
        if (!active) throw new Error("Codex 正在工作但未返回当前 turn id,没有启动另一轮。请稍后重试");
        const result = await this.rpc.request<{ turnId: string }>("turn/steer", {
          threadId: thread.id, expectedTurnId: active.id, input,
        });
        return { threadId: thread.id, delivered: "steered", turnId: result.turnId };
      }
      const result = await this.rpc.request<{ turn: Turn }>("turn/start", { threadId: thread.id, input });
      const observed = this.progress.list(thread.id)[0];
      if (observed?.source !== "app-server" || observed.turnId !== result.turn.id) {
        this.record(thread.id, "running", "已接收微信消息,任务正在执行", result.turn.id);
      }
      return { threadId: thread.id, delivered: "started", turnId: result.turn.id };
    });
    this.sends.set(selected.id, operation);
    try { return await operation; }
    finally { if (this.sends.get(selected.id) === operation) this.sends.delete(selected.id); }
  }

  private record(threadId: string, state: "running" | "waiting" | "completed" | "failed" | "interrupted", summary: string, turnId?: unknown): void {
    const currentTurnId = typeof turnId === "string" ? turnId : this.progress.list(threadId)[0]?.turnId;
    this.progress.report({
      threadId, cwd: this.threads.get(threadId)?.cwd, state, summary: summary.slice(0, 4_000),
      ...(currentTurnId ? { turnId: currentTurnId } : {}), source: "app-server",
    });
  }

  private observe(message: RpcMessage): void {
    const params = message.params ?? {};
    if (message.method === "serverRequest/resolved") this.questions.get(JSON.stringify(params.requestId))?.abort.abort();
    if (typeof params.threadId !== "string") return;
    const id = params.threadId;
    if (message.method === "turn/started") this.record(id, "running", "任务正在执行", (params.turn as Turn)?.id);
    if (message.method === "turn/completed") {
      const turn = params.turn as Turn;
      for (const question of this.questions.values()) {
        if (question.threadId === id && question.turnId === turn.id) question.abort.abort();
      }
      const state = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : "failed";
      this.record(id, state, turn.error?.message || `本轮状态: ${turn.status}`, turn.id);
    }
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      const last = this.progress.list(id)[0];
      this.record(id, "running", `${last?.turnId === params.turnId ? last.summary : ""}${params.delta}`.slice(-4_000), params.turnId);
    }
    if (message.method === "item/started") {
      const item = params.item as Item;
      if (item?.type) this.record(id, "running", `正在执行: ${item.type}`, params.turnId);
    }
    if (message.method === "thread/status/changed") {
      const status = params.status as Status;
      const thread = this.threads.get(id);
      if (thread) thread.status = status;
      if (status?.type === "active" && status.activeFlags?.length) this.record(id, "waiting", stateLabel(status));
    }
  }
}

export function registerCodexPeerTools(ctx: Context, peer: CodexPeer): void {
  const register = (name: string, description: string, parameters: ParameterSchemaSpec,
    execute: (args: Record<string, unknown>) => Promise<string>): void => {
    ctx.tools.register(defineTool({
      name, description, parameters,
      output: {
        schema: { type: "object", properties: {
          ok: { type: "boolean", required: true }, summary: { type: "string", required: true },
        }, additionalProperties: false },
        render: (_args, value) => [{ type: "text", text: value.summary }],
      },
      async execute(args) {
        try { return { ok: true, summary: await execute(args) }; }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : "Codex 操作失败" }; }
      },
    }));
  };
  const project = { type: "string", description: "Full working directory from list_codex_projects. Use it to disambiguate projects." } as const;
  const session = { type: "string", required: true, description: "Full thread id, unique id prefix, or unique conversation title. Never guess a target." } as const;

  register("list_codex_projects", "List Codex project directories with conversations on the connected app-server. Use the returned directory to select a project before selecting a conversation. Results are paginated.", {
    cursor: { type: "string", description: "nextCursor from the previous page" },
  }, async (args) => {
    const page = await peer.list(undefined, args.cursor as string | undefined, 100);
    const projects = new Map<string, number>();
    for (const thread of page.data) projects.set(thread.cwd, (projects.get(thread.cwd) ?? 0) + 1);
    return JSON.stringify({ projects: [...projects].map(([cwd, sessionsOnThisPage]) => ({ name: path.basename(cwd), cwd, sessionsOnThisPage })), nextCursor: page.nextCursor });
  });
  register("list_codex_sessions", "List Codex conversations, titles, IDs, project directories and live states. notLoaded means runtime state is unknown; it must never be reported as idle. Use a project directory and full id for forwarding.", {
    project, cursor: { type: "string" }, limit: { type: "number" },
  }, async (args) => {
    const page = await peer.list(args.project as string | undefined, args.cursor as string | undefined, args.limit as number | undefined);
    return JSON.stringify({ sessions: page.data.map((thread) => ({ id: thread.id, title: thread.name, cwd: thread.cwd, state: stateLabel(thread.status) })), nextCursor: page.nextCursor });
  });
  register("read_codex_session", "Read saved history without resuming the selected Codex conversation, including notLoaded conversations. notLoaded only means this server cannot observe live execution; it does not mean history is unreadable. Returns recent user/agent text and saved turn states, omitting reasoning and command outputs. Use the recorded timestamp when reporting cached progress.", {
    session, project, limit: { type: "number" },
  }, async (args) => {
    const thread = await peer.read(String(args.session), args.project as string | undefined, args.limit as number | undefined);
    const turns = (thread.turns ?? []).map((turn) => ({
      id: turn.id, status: turn.status,
      messages: turn.items.filter((item) => item.type === "agentMessage" || item.type === "userMessage").map((item) => ({
        role: item.type === "agentMessage" ? "assistant" : "user",
        text: (item.text ?? item.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "").slice(0, 2_000),
      })),
    }));
    return JSON.stringify({ session: describe(thread), turns, progressReports: peer.progress.list(thread.id) });
  });
  register("send_to_codex_session", "Relay a user's WeChat message to the chosen project and Codex conversation. Active turns are steered; idle threads start a turn. Delivery is not completion. For an unloaded thread in either transport, allowResume requires the user to explicitly permit background continuation after closing the original client. Never set it just to bypass a refusal.", {
    session, project, text: { type: "string", required: true }, allowResume: { type: "boolean" },
  }, async (args) => JSON.stringify(await peer.send(String(args.session), String(args.text), args.project as string | undefined, args.allowResume === true)));
  register("read_codex_progress", "Read timestamped progress that Codex published through MCP or that the connected app-server emitted. Available even when no shared server is reachable. Reports are cached observations, not proof a task is still running.", {
    threadId: { type: "string", description: "Omit to list recent reports; otherwise use the exact conversation id." },
  }, async (args) => JSON.stringify({ progress: peer.progress.list(args.threadId as string | undefined) }));
}
