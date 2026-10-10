/**
 * DSH integration bridge: maps WeChat messages onto one fixed agent session.
 *
 * Every inbound WeChat message (from any allowed sender) is queued into the
 * SAME persisted session (`config.sessionId`), so the conversation keeps one
 * context and is compacted like any other DSH session. Assistant replies are
 * collected from the durable `session/event` feed and sent back to the WeChat
 * user who triggered the turn.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
import { SessionId, type Session, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage, type UserMessage } from "@deepseek-ai/dsh-llm";
import { zonedStamp } from "./localtime.js";
import { compressForUpload } from "./image-compress.js";
import { registerClaudePeerTools } from "./claude-peer.js";
import { registerCodexPeerTools, type CodexPeer } from "./codex-peer.js";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
// `@deepseek-ai/dsh-agent-presets` (and its `ctx.agentPresets` type
// augmentation) is gone in DSH 0.1.7; the service keeps its name
// ("agentPresets", now from dsh-agent-preset-registry) and `mount(ctx, id?)`
// keeps its shape, so only the type moved here.
type AgentPresetsService = { mount(ctx: unknown, id?: string): Promise<unknown> };

import type { ClawbotConfig } from "./config.js";
import { markSessionCreated, wasSessionCreated } from "./state.js";
import { PendingRegistry, type PendingAnswer } from "./pending.js";
import { TypingIndicator } from "./typing.js";

/**
 * Tool calls that are the bot talking to the user, not working: they must not
 * bring 「正在输入」 back after a reply (see TypingIndicator.noteWorking).
 */
const REPLY_TOOLS = new Set(["send_wechat_text", "send_wechat_file", "ask_user_question"]);
import { IdleCompactor, IDLE_COMPACT_RATIO, hostCompactionThreshold } from "./idle-compact.js";
import { registerSendFileTool } from "./tool.js";
import { randomUUID } from "node:crypto";
import { captureTurnMemory, type MemoryJudge } from "./memory-auto.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { logger } from "./ilink/util/logger.js";

export type SendTextFn = (to: string, text: string) => Promise<void>;

export type BridgeDeps = {
  /** Current bound account (API credentials), or null before login. */
  getAccount: () => ResolvedWeixinAccount | null;
  /** Outbound context token for a sender ("" when unknown). */
  getContextToken: (sender: string) => string;
  /** Pending WeChat interactions (approvals + questions). */
  pending: PendingRegistry;
  codexPeer?: CodexPeer;
};

/**
 * The durable, serializable reference `attachments.saveImages()` hands back.
 *
 * Mirrored here rather than imported from `@deepseek-ai/dsh-attachment`: this
 * plugin's dev tree carries an older copy of that package than the host runs,
 * and a bare import resolves to the near one (that mismatch is exactly what
 * silently broke attaching once already — see `attachImage`). Six plain fields,
 * all JSON, so mirroring costs nothing and cannot drift into a runtime crash.
 */
export type ImageRef = {
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  width: number;
  height: number;
  name?: string;
  /**
   * Present from dsh-attachment 0.1.1-rc.2 onward, and only when the store
   * actually resized: it now normalizes EXIF orientation and downscales
   * oversized images, recording what the original was.
   */
  originalDimensions?: { width: number; height: number };
};

export class WechatBridge {
  private readonly ctx: Context;
  private readonly config: ClawbotConfig;
  private readonly sendText: SendTextFn;
  private readonly deps: BridgeDeps;
  private readonly sessionId: SessionId;

  private handle: AgentHandle | null = null;
  private disposed = false;
  /** Agent contexts we already installed the model selection on (avoid duplicates). */
  private selectionInstalled = new WeakSet<object>();

  /** Queued turns waiting for the serialized worker (oldest first). */
  private readonly queue: Array<{ sender: string; text: string; message: UserMessage }> = [];
  /** Whether the WeChat tools are registered on the current agent scope. */
  private toolsRegistered = false;
  /** The sender whose turn is currently being driven (approvals go to them). */
  private currentSender: string | undefined;
  /** Messages sent in the current turn (cap enforcement, RULE B). */
  private turnMessageCount = 0;
  /** Per-turn outbound message cap. */
  private static readonly MAX_TURN_MESSAGES = 10;
  /** The serialized turn worker (one followup → idle at a time). */
  private worker: Promise<void> | null = null;
  /** Time index of session message events (for quote backfill). */
  private sessionIndex: {
    seq: number;
    entries: Array<{ time: number; text: string; imagePath?: string }>;
  } | null = null;
  /**
   * Serialized outbound chain: assistant segments, tool acks, and approvals
   * are delivered one at a time so WeChat messages never interleave.
   */
  private sendChain: Promise<void> = Promise.resolve();
  /** 「对方正在输入…」 from the moment a WeChat message is picked up until the turn ends. */
  private readonly typing: TypingIndicator;
  /** Compacts the session in the quiet time after a reply (see idle-compact.ts). */
  private readonly idleCompact: IdleCompactor;
  /** Tokens the last model request on this session carried, as reported by the provider. */
  private lastRequestTokens: number | undefined;

  constructor(ctx: Context, config: ClawbotConfig, sendText: SendTextFn, deps: BridgeDeps) {
    this.ctx = ctx;
    this.config = config;
    this.sendText = sendText;
    this.deps = deps;
    this.sessionId = SessionId(config.sessionId);
    this.typing = new TypingIndicator({
      getAccount: () => deps.getAccount(),
      getContextToken: (sender) => deps.getContextToken(sender),
      isWaitingFor: (sender) => deps.pending.hasFor(sender),
    });
    this.idleCompact = new IdleCompactor({
      enabled: () => this.config.idleCompaction !== false,
      isBusy: () => this.disposed
        || this.worker !== null
        || this.queue.length > 0
        || deps.pending.size > 0
        || this.ctx.agents.get(this.sessionId)?.status === "running",
      lastRequestTokens: () => this.lastRequestTokens,
      hostThreshold: () => this.hostCompactionThreshold(),
      compact: (signal) => this.runHostCompact(signal),
      onCompacted: () => { this.lastRequestTokens = undefined; },
    });
  }

  /**
   * Log once at startup whether idle compaction can work here: the host's
   * command registry must be reachable and carry `/compact` for this session,
   * and the route must declare a window. Without this line a missing piece
   * would only show as "never compacts while idle".
   */
  async reportIdleCompactReadiness(): Promise<void> {
    if (this.config.idleCompaction === false) {
      logger.info("idle-compact: 关闭(配置 idleCompaction: false)");
      return;
    }
    const commands = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.("commands") as {
      find?: (agent: unknown, name: string) => unknown;
    } | undefined;
    const agent = this.ctx.agents.get(this.sessionId);
    const hasCompact = commands?.find !== undefined && agent !== undefined && commands.find(agent, "compact") !== undefined;
    let threshold: number | undefined;
    try { threshold = await this.hostCompactionThreshold(); } catch { threshold = undefined; }
    logger.info(
      `idle-compact: /compact ${hasCompact ? "可用" : "不可用(只剩宿主回复前的压缩)"};`
      + ` 宿主阈值 ${threshold ?? "未知"},空闲时超过 ${threshold === undefined ? "?" : Math.floor(threshold * IDLE_COMPACT_RATIO)} token 就整理`
      + `(上次请求 ${this.lastRequestTokens ?? "未知"})`,
    );
  }

  /** The host's pre-step compaction threshold for the bot's current route. */
  private async hostCompactionThreshold(): Promise<number | undefined> {
    const route = this.currentRoute();
    const llm = this.service<{
      resolveModelInfo?: (p: string, m: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }>;
    }>("llm");
    if (route === null || llm?.resolveModelInfo === undefined) return undefined;
    const info = await llm.resolveModelInfo(route.provider, route.model);
    return hostCompactionThreshold(info?.context?.contextWindow, info?.defaultMaxTokens);
  }

  /**
   * Run the host's `/compact` on the WeChat session through the command
   * registry — the same entry the web UI's slash command uses, so the host does
   * the compaction exactly as it would by hand. Undefined when the registry or
   * the command is absent (e.g. a preset without compaction).
   */
  private async runHostCompact(signal: AbortSignal): Promise<{ ok: boolean; text: string } | undefined> {
    const commands = (this.ctx as unknown as { get?: (name: string) => unknown }).get?.("commands") as {
      execute?: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) =>
        Promise<{ result: { kind: string; text?: string } } | undefined>;
    } | undefined;
    const agent = this.ctx.agents.get(this.sessionId);
    if (commands?.execute === undefined || agent === undefined) return undefined;
    const out = await commands.execute(agent, "/compact", [], signal);
    if (out === undefined) return undefined;
    return { ok: out.result.kind === "success", text: out.result.text ?? "" };
  }

  /** Keep 「正在输入」 up for this sender (no-op if it already is). */
  showTyping(sender: string): void {
    this.typing.start(sender);
  }

  /** A message or file just reached this sender's phone. */
  noteDelivered(sender: string): void {
    this.typing.noteDelivered(sender);
  }

  /** Outbound context token for a WeChat sender ("" when unknown). */
  contextTokenFor(sender: string): string {
    return this.deps.getContextToken(sender);
  }

  /**
   * Send one text message to a WeChat user, serialized behind every other
   * outbound message so delivery order is preserved.
   */
  sendTextTo(sender: string, text: string, opts?: { uncapped?: boolean }): boolean {
    // Per-turn message cap (mirrors RULE B's "约 10 条"): beyond 10 messages
    // in one turn, drop extras and warn. Resets when a new turn starts
    // (drainQueue for WeChat turns, the schedule branch of onSessionEvent for
    // reminder turns). Returns false when the text was dropped, so a caller
    // never reports a message as sent that never left.
    // `uncapped` is for a question the agent then blocks on: dropping that one
    // would leave the bot waiting for an answer to something nobody saw.
    if (!opts?.uncapped && this.turnMessageCount >= WechatBridge.MAX_TURN_MESSAGES) {
      logger.warn(`sendTextTo: turn message cap (${WechatBridge.MAX_TURN_MESSAGES}) reached for ${sender}; dropping: ${text.slice(0, 40)}…`);
      return false;
    }
    this.turnMessageCount += 1;
    this.sendChain = this.sendChain.then(async () => {
      try {
        await this.sendText(sender, text);
        this.typing.noteDelivered(sender);
      } catch (err) {
        logger.error(`sendTextTo: failed to ${sender}: ${String(err)}`);
      }
    });
    return true;
  }

  get id(): SessionId {
    return this.sessionId;
  }

  /**
   * Ask the user a question THROUGH WeChat and wait for their reply.
   * Used by the WeChat-scoped ask_user_question override so bot questions
   * never pop up in the webapp GUI. Returns the raw reply text, or null on
   * timeout / abort.
   */
  askWechat(question: string, timeoutMs = 300_000, signal?: AbortSignal): Promise<string | null> {
    const sender = this.currentSender ?? this.deps.getAccount()?.userId;
    if (!sender || signal?.aborted) return Promise.resolve(null);
    this.sendTextTo(sender, question, { uncapped: true });
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const entry: PendingAnswer = {
        tag: "question",
        sender,
        resolve: (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", withdraw);
          resolve(reply);
        },
      };
      // Timed out or the turn was stopped: withdraw only this question. The
      // entry must not outlive its waiter, or the sender's next message would
      // be taken as its answer and never reach the agent.
      const withdraw = (): void => {
        this.deps.pending.remove(entry);
        entry.resolve(null);
      };
      const timer = setTimeout(withdraw, timeoutMs);
      signal?.addEventListener("abort", withdraw, { once: true });
      this.deps.pending.push(entry);
    });
  }

  /**
   * Install the deployment default model selection (provider/model/
   * reasoningEffort from settings.yaml) onto an agent context, once per
   * context. Used both by the agent setup and for agents the harness
   * resumed directly without running the bridge setup.
   */
  /**
   * One mutable selection shared by every agent context this bridge installs
   * into. `installModelSelection` is documented to snapshot `current` per step,
   * so writing a new value here switches the model from the next step onward —
   * no reinstall, no restart, no dropped WeChat connection.
   */
  private readonly selectionRef: ModelSelectionRef = { current: undefined, assembled: undefined };

  /**
   * What this session should route to: the plugin's own pin when configured,
   * otherwise the deployment default.
   *
   * The default-following branch is why choosing a model in the web UI used to
   * move the bot as well — that picker writes through to the global
   * `agent-default-model`, and with nothing pinned here the bot simply adopts
   * it. Setting `model` in this plugin's settings breaks that coupling.
   */
  private desiredSelection(): ModelSelection | undefined {
    const pinned = this.config.model;
    if (pinned !== undefined) {
      return {
        provider: this.config.provider ?? "deepseek-official",
        model: pinned,
        ...(this.config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: this.config.reasoningEffort as ModelSelection["reasoningEffort"] }),
      };
    }
    return this.ctx.get("agentDefaultModel")?.currentSelection();
  }

  private installSelection(agentCtx: Context): void {
    if (this.selectionInstalled.has(agentCtx)) return;
    const selection = this.desiredSelection();
    if (!selection) return;
    this.selectionRef.current = selection;
    try {
      installModelSelection(agentCtx, this.selectionRef);
      this.selectionInstalled.add(agentCtx);
      logger.info(
        `ensureAgent: model selection installed (${selection.provider}/${selection.model} reasoningEffort=${selection.reasoningEffort ?? "(default)"}${this.config.model === undefined ? " ,跟随全局默认" : " ,插件自己钉的"})`,
      );
    } catch (err) {
      logger.warn(`ensureAgent: installModelSelection failed: ${String(err)}`);
    }
  }

  /**
   * Re-point the live selection after a settings change.
   *
   * A model id that cannot be resolved is REFUSED rather than applied: a typo
   * in the settings box would otherwise brick the bot on its next message, and
   * the failure would surface as a request error with no obvious cause. When
   * the llm service is unavailable the value is taken on trust — refusing
   * everything would be worse than a possible bad pin.
   */
  async refreshSelection(): Promise<void> {
    const next = this.desiredSelection();
    if (next === undefined) {
      logger.warn("refreshSelection: 既没有插件自己的设置,也读不到全局默认,保持原样");
      return;
    }
    // Nothing installed yet means this ran before the agent was set up — the
    // settings hook fires at attach, which can beat provider registration. There
    // is no good selection to protect here, and installSelection() is about to
    // assign one anyway, so refusing would only print a scary warning about a
    // value that turns out to be fine.
    if (this.selectionRef.current === undefined) {
      this.selectionRef.current = next;
      return;
    }
    const llm = this.llmService();
    if (llm !== undefined) {
      try {
        await llm.resolveModelInfo(next.provider, next.model);
      } catch (err) {
        logger.warn(
          `refreshSelection: 解析不出 ${next.provider}/${next.model}(${String(err).slice(0, 100)}),拒绝换过去,继续用 ${this.selectionRef.current?.provider}/${this.selectionRef.current?.model}`,
        );
        return;
      }
    }
    this.selectionRef.current = next;
    logger.info(
      `refreshSelection: 微信会话现在走 ${next.provider}/${next.model} reasoningEffort=${next.reasoningEffort ?? "(默认)"}`,
    );
    await this.reportVisionReadiness();
  }

  /** Whether the given session id is the WeChat session. */
  isWechatSession(sessionId: string): boolean {
    return sessionId === this.sessionId;
  }

  /** The sender the current activity is attributed to (for approval routing). */
  get activeSender(): string | undefined {
    return this.currentSender;
  }

  /**
   * Get (or create/resume) the WeChat agent. The agent is composed from the
   * deployment's default agent preset (standard coding tools) and its
   * approval policy is forced to `ask`, so remote access requests arrive in
   * WeChat regardless of the deployment-wide policy.
   *
   * Mirrors the headless runner's creation pattern: wait for the loader to
   * finish composing sibling plugins (otherwise the agent's world is
   * half-composed and the driver can stall) and install the deployment's
   * default model selection into the agent scope.
   */
  async ensureAgent(): Promise<Agent> {
    if (this.disposed) throw new Error("clawbot bridge disposed");

    const live = this.ctx.agents.get(this.sessionId);
    if (live) {
      // The harness may have resumed this session directly (e.g. from a GUI
      // message) without running the bridge setup, so the deployment model
      // selection — including reasoningEffort from settings.yaml — was never
      // installed. Install it now on the live agent so per-request config
      // follows settings instead of the session's persisted header.
      this.installSelection(live.ctx);
      // Same for the WeChat tools: re-register them on the live agent scope
      // so send_wechat_file / preview_wechat_image / send_wechat_text are
      // available even when the agent was resumed outside the bridge setup.
      this.ensureTools(live.ctx);
      return live;
    }

    if (!this.handle) {
      // Loader siblings mount concurrently; never create an Agent before the
      // complete application (tools, adapters, services) is composed.
      try {
        await this.ctx.get("loader")?.await?.();
      } catch (err) {
        logger.warn(`ensureAgent: loader await failed (continuing): ${String(err)}`);
      }

      const setup = async (agentCtx: Context): Promise<void> => {
        // Pin the deployment default model for this agent's requests.
        this.installSelection(agentCtx);
        // Join the deployment's default agent preset (standard tools) when a
        // preset roster is composed; degrade gracefully without one. Read via
        // ctx.get() so no inject declaration is needed (works in profiles
        // with and without the agent-presets service).
        try {
          const agentPresets = (agentCtx.get as ((name: string) => unknown) | undefined)?.("agentPresets") as AgentPresetsService | undefined;
          if (agentPresets) {
            await agentPresets.mount(agentCtx);
          } else {
            logger.debug("ensureAgent: no agentPresets service; using global-layer tools");
          }
        } catch (err) {
          logger.warn(`ensureAgent: preset mount failed (agent may have no tools): ${String(err)}`);
        }
        // WeChat conversation norms (concise, split, use the send tool).
        try {
          // WeChat guidance is registered GLOBALLY with a dynamic session
          // filter (see index.ts) so it also covers agents the harness
          // resumes directly from GUI messages.
          logger.info("ensureAgent: wechat guidance section registered");
        } catch (err) {
          logger.warn(`ensureAgent: guidance section registration failed: ${String(err)}`);
        }
        // The WeChat session can deliver files/images/voice straight to WeChat.
        this.ensureTools(agentCtx);
      };

      // Resume the persisted session when it exists; otherwise create fresh.
      if (wasSessionCreated(this.sessionId)) {
        try {
          this.handle = await this.ctx.agents.resume({
            resumeSessionId: this.sessionId,
            setup,
          });
        } catch (err) {
          logger.warn(`ensureAgent: resume failed (${String(err)}); will create a fresh session`);
        }
      }
      if (!this.handle) {
        const defaultModel = this.ctx.get("agentDefaultModel");
        const selection = defaultModel?.currentSelection();
        try {
          this.handle = await this.ctx.agents.create({
            sessionId: this.sessionId,
            meta: { cwd: this.config.cwd ?? process.cwd() },
            agentOptions: selection
              ? { provider: selection.provider, model: selection.model }
              : undefined,
            setup,
          });
        } catch (err) {
          // The session is on disk but our marker is not (state dir reset, or
          // copied without `sessions/`). Creating can never succeed then, and
          // every inbound message would fail the same way — resume it instead.
          const name = (err as { name?: unknown } | null)?.name;
          if (name !== "SessionAlreadyExistsError" && !/already exists/i.test(String(err))) throw err;
          logger.warn(`ensureAgent: ${String(err)}; resuming the existing session instead`);
          this.handle = await this.ctx.agents.resume({
            resumeSessionId: this.sessionId,
            setup,
          });
        }
        markSessionCreated(this.sessionId);
      }
      // The WeChat session answers approvals via WeChat: force `ask`.
      try {
        setApprovalPolicy(this.handle.agent.session, "ask");
      } catch (err) {
        logger.warn(`ensureAgent: setApprovalPolicy failed: ${String(err)}`);
      }
    }
    return this.handle.agent;
  }

  /**
   * Deliver one WeChat text message immediately, no waiting window. Normal
   * flow: when the agent is idle the message starts a new turn. Interrupt
   * flow: when the agent is already mid-turn (the user interjects while we
   * are working), the message is STEERED into the running turn (next-step) so
   * the agent absorbs it and rethinks before replying — one reply total.
   * Returns immediately: the monitor loop must NEVER block on an agent turn.
   */
  /**
   * Whether the model this session will actually route to accepts image input.
   *
   * Read from the session's live request header (the route in force), falling
   * back to the agent's options. Any failure to resolve counts as "no": an
   * unproven route must not be handed an image it may reject, which would fail
   * the whole turn instead of just missing a picture.
   *
   * `llm` and `attachments` are deliberately NOT in this plugin's `inject`
   * list — declaring them makes them hard requirements, and a composition
   * without them (headless, say) would fail the entire loader tree. So they
   * are probed defensively and absence simply degrades to the old
   * path-plus-vision-tool behaviour.
   */
  private visionCtx: Context | null = null;

  /**
   * Receive a context scoped by `ctx.inject(["llm","attachments"], …)`.
   *
   * The only safe way to reach an optional service here: bare property access
   * THROWS ("cannot get property \"llm\" without inject") and took down a whole
   * inbound message, while listing them in `export const inject` would make
   * them hard requirements and fail the loader tree wherever they are absent.
   * This callback simply never fires in such a composition.
   */
  useVisionServices(scoped: Context): void {
    this.visionCtx = scoped;
    // 这里**不要**立刻自检:本回调比 installSelection() 早约 80ms 触发,那一刻
    // agentDefaultModel 还没解析出配置里的选择,读到的是 harness 的内置默认
    // (deepseek-official/deepseek-v4-flash),自检会报出一个假的路由。
    // 由 index.ts 在 agent 预热完成后再调 reportVisionReadiness()。
  }

  /** Read a service from the injected context; undefined when unavailable. */
  private service<T>(name: string): T | undefined {
    const from = this.visionCtx;
    if (from === null) return undefined;
    try {
      const direct = (from as unknown as Record<string, unknown>)[name];
      return direct === undefined || direct === null ? undefined : (direct as T);
    } catch {
      return undefined;
    }
  }

  /**
   * Log at startup exactly what the image probe sees. Without it the only way
   * to learn why a photo was not attached was to ask for another photo, and a
   * genuine "not image capable" looks identical to a broken probe.
   */
  async reportVisionReadiness(): Promise<void> {
    const llm = this.llmService();
    const attachments = this.service<unknown>("attachments");
    const route = this.currentRoute();
    if (llm === undefined || attachments === undefined || route === null) {
      logger.info(`vision: 关闭 (llm=${llm !== undefined} attachments=${attachments !== undefined} route=${route === null ? "未知" : `${route.provider}/${route.model}`})`);
      return;
    }
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model);
      const mods = info.inputModalities ?? [];
      logger.info(
        `vision: ${route.provider}/${route.model} (按${route.source}) `
        + `输入模态 = [${mods.join(", ")}] → 附图${mods.includes("image") ? "开启" : "关闭"}`,
      );
    } catch (err) {
      logger.info(
        `vision: 解析 ${route.provider}/${route.model} (按${route.source}) 模态失败 `
        + `(${String(err).slice(0, 120)}) → 附图关闭`,
      );
    }
  }

  private llmService(): { resolveModelInfo: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }> } | undefined {
    const llm = this.service<{ resolveModelInfo?: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }> }>("llm");
    return llm?.resolveModelInfo === undefined
      ? undefined
      : (llm as { resolveModelInfo: (p: string, m: string) => Promise<{ inputModalities?: readonly string[] }> });
  }

  /**
   * A `MemoryJudge` bound to **this session's own route**.
   *
   * Auto-memory used to POST straight to `api.deepseek.com` with a hardcoded
   * model and key. That was a second data destination, and switching the bot
   * to another provider made it worse rather than better: the conversation
   * moved, the personal-looking snippets did not. Going through the host
   * `llm` service fixes that for free — the service already owns baseURL,
   * credential lookup, and the wire format (this route speaks
   * `openai-responses`, DeepSeek speaks `openai-completions`; neither shape
   * belongs in this plugin).
   *
   * Returns undefined when the service is absent or the route is unresolved;
   * the caller then skips classification rather than reaching for a fallback
   * vendor.
   */
  private memoryJudge(): MemoryJudge | undefined {
    const llm = this.service<{
      stream?: (options: unknown) => AsyncIterable<{
        type: string;
        text?: string;
        reason?: { kind: string; failure?: { message?: string } };
      }>;
    }>("llm");
    const route = this.currentRoute();
    if (llm?.stream === undefined || route === null) return undefined;
    const stream = llm.stream.bind(llm);

    return async (prompt: string): Promise<string | null> => {
      const parts: string[] = [];
      try {
        for await (const chunk of stream({
          provider: route.provider,
          model: route.model,
          // 分类不需要推敲,而且**思考和回复共用输出预算** —— 留着思考会把
          // maxTokens 吃光、message 全空(deepseek-flash 上踩过)。
          // 'off' 是 DSH 的合法档位名,两个 provider 都声明了它;万一某个 provider
          // 没声明,下面的 catch 会把它降级成「这条不记」,不会拖垮这一轮对话。
          reasoningEffort: "off",
          system: "你是记忆提取助手,只输出 JSON。",
          messages: [{
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: prompt }],
            // 适配器会读 source.kind(assistant 那条分支用得到),给不出就会抛。
            source: { kind: "user" },
          }],
          maxTokens: 400,
        })) {
          if (chunk.type === "text-delta" && chunk.text !== undefined) parts.push(chunk.text);
          if (chunk.type === "finish" && chunk.reason?.kind !== "stop") {
            logger.warn(
              `memory-auto: 判定调用未正常结束(${chunk.reason?.kind}) `
              + `${chunk.reason?.failure?.message?.slice(0, 90) ?? ""}`,
            );
            return null;
          }
        }
      } catch (err) {
        logger.warn(`memory-auto: 判定调用失败 ${String(err).slice(0, 120)}`);
        return null;
      }
      return parts.join("");
    };
  }

  /**
   * The provider/model this session will actually route to.
   *
   * Three sources, in descending authority. The live request header is the
   * truth once a request has been made. A resumed agent has neither — no
   * request yet in this process, and `options` is only populated on the create
   * path — which is why the first probe reported "route unknown" and quietly
   * disabled attachments. The deployment default is the reliable fallback
   * precisely because installSelection() pins it onto this agent, so it IS the
   * route the next turn takes.
   */
  private currentRoute(): { provider: string; model: string; source: string } | null {
    const live = this.ctx.agents.get(this.sessionId);
    const routed = live?.session.requestHeader()?.config as { provider?: string; model?: string } | undefined;
    // 顺序就是权威顺序,排错了会读到别的路由:agent.options 是 harness 的默认
    // (实测是 deepseek-official/deepseek-v4-flash),而 installSelection() 会用
    // 配置/部署默认值把它覆盖掉 —— 所以那两个都比 options 权威。
    //
    // **插件自己钉的模型排在请求头前面。** 设置页里填了 provider+model 时,
    // refreshSelection() 当场把它钉到这个 agent 上,下一轮就走它;而请求头记的
    // 是**上一轮**的模型。两者不一致的时刻正是刚换完模型的时候 —— bot 换成了
    // 模型 A、全局默认还是模型 B,日志就报成了 B。这个函数不只写日志,
    // routeTakesImages() 也用它决定
    // 附不附图:读错模型就可能按错的模态把图挡掉。
    const pinned = this.config.provider !== undefined && this.config.model !== undefined
      ? { provider: this.config.provider, model: this.config.model }
      : undefined;
    const selection = this.ctx.get("agentDefaultModel")?.currentSelection();
    const provider = pinned?.provider ?? routed?.provider ?? selection?.provider ?? live?.options.provider;
    const model = pinned?.model ?? routed?.model ?? selection?.model ?? live?.options.model;
    // 来源要跟着一起报:报一个旧模型会让人白查一轮,宁可啰嗦一点说清数据来自哪。
    const source = pinned !== undefined
      ? "插件配置"
      : routed?.provider !== undefined && routed?.model !== undefined
        ? "上一轮请求头"
        : selection?.provider !== undefined && selection?.model !== undefined
          ? "部署默认"
          : "agent options";
    return provider === undefined || model === undefined ? null : { provider, model, source };
  }

  /**
   * Whether the model this session routes to can take an image in its input.
   * Public: the outbound pre-send check (`look_at_image` in tool.ts) gates on
   * exactly the same answer as the inbound attach.
   */
  async routeTakesImages(): Promise<boolean> {
    // The settings switch comes first: it exists to force the old
    // path-plus-vision-tool behaviour for comparison, so it has to win over a
    // route that would otherwise accept images.
    if (!this.config.attachImages) {
      logger.info("routeTakesImages: 设置里关掉了附图,走视觉工具");
      return false;
    }
    const llm = this.llmService();
    const route = this.currentRoute();
    if (llm === undefined || route === null) {
      logger.warn(`routeTakesImages: 无法判定(llm=${llm !== undefined} route=${route === null ? "未知" : "已知"}),按不支持处理`);
      return false;
    }
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model);
      const ok = info.inputModalities?.includes("image") === true;
      if (!ok) {
        logger.info(
          `routeTakesImages: ${route.provider}/${route.model} (按${route.source}) 不接受图片,走视觉工具`,
        );
      }
      return ok;
    } catch (err) {
      logger.warn(
        `routeTakesImages: 解析 ${route.provider}/${route.model} (按${route.source}) 失败: `
        + `${String(err).slice(0, 120)}`,
      );
      return false;
    }
  }

  /**
   * Commit one local image to the attachment store and hand back its durable
   * reference — downscaled first, because a camera original is tens of
   * megapixels and would blow the store's per-image limits long before it
   * reached the model.
   *
   * Public, and used by BOTH directions: an inbound WeChat photo (via
   * `imageBlock` below) and an outbound photo the agent is about to send (via
   * `look_at_image` in tool.ts). Those used to differ — inbound attached the
   * bytes natively while outbound handed a *path* to qwen and paid a second
   * round trip for it — and there was never a reason for two mechanisms.
   *
   * @param imagePath - the local image to commit.
   * @param tag - log prefix naming the caller, so the two directions stay
   *   distinguishable in the log.
   * @returns the durable reference, or null when anything is missing.
   */
  async attachImage(imagePath: string, tag = "imageBlock"): Promise<ImageRef | null> {
    // Call the injected store's own method rather than importing the
    // `admitEncodedImages` helper. A bare import resolves nearest-first, which
    // means this plugin's own node_modules copy of dsh-attachment (older than
    // the host's, and without that export) shadowed the host's — so the import
    // succeeded, the export was missing, and the attach returned null in
    // silence. The service object is the host's instance, so there is no module
    // resolution to get wrong. Bytes go straight in; no base64 round trip.
    const store = this.service<{ saveImages?: (inputs: readonly { data: Uint8Array; mediaType: string }[]) => Promise<readonly ImageRef[]> }>("attachments");
    if (store?.saveImages === undefined) {
      logger.warn(`${tag}: 附件服务不可用(或没有 saveImages),跳过附图`);
      return null;
    }
    let prep: { path: string; bytes: number; temp: boolean } | undefined;
    try {
      prep = compressForUpload(imagePath, {
        maxImageEdge: this.config.maxImageEdge,
        imageQuality: this.config.imageQuality,
        compressThresholdBytes: this.config.compressThresholdBytes,
      });
      const data = readFileSync(prep.path);
      const mediaType = prep.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const refs = await store.saveImages([{ data, mediaType }]);
      const ref = refs[0];
      if (ref === undefined) {
        logger.warn(`${tag}: 附件库没有返回引用,跳过附图`);
        return null;
      }
      logger.info(`${tag}: 已附上 ${basename(imagePath)} (${Math.round(prep.bytes / 1024)} KB, ${ref.width}x${ref.height})`);
      return ref;
    } catch (err) {
      logger.warn(`${tag}: 附图失败 ${imagePath}: ${String(err)}`);
      return null;
    } finally {
      if (prep?.temp === true) {
        try { unlinkSync(prep.path); } catch { /* best effort */ }
      }
    }
  }

  /** Wrap `attachImage` as the content block an inbound message carries. */
  private async imageBlock(imagePath: string): Promise<{ type: "image"; attachment: ImageRef } | null> {
    const ref = await this.attachImage(imagePath);
    return ref === null ? null : { type: "image", attachment: ref };
  }

  async enqueueMessage(sender: string, text: string, imagePath?: string): Promise<void> {
    this.idleCompact.noteActivity();
    if (this.disposed) return;
    // Prefix every WeChat-originated message with a visible marker so the
    // agent can distinguish it from system-injected content and knows this
    // message REQUIRES a send_wechat_text reply (see RULE A0-WX).
    //
    // The marker carries the local wall-clock time because the history used to
    // carry none, and an undated history is the only other temporal signal the
    // model has. On 2026-08-31 at 22:30 the system prompt said today was 08-31
    // (verified in the session log's request/header) and the agent still filed a
    // reminder for 08-29 — the date of the previous exchange, two days earlier.
    // It had no way to know two days had passed. Now every message says when it
    // was sent, so the nearest date in context is the right one.
    let marked = `[微信消息 ${zonedStamp()}] ${text}`;
    // Attach the picture itself when the route can see one. Before this the
    // model only ever got a filesystem path plus "go call a vision tool",
    // which is why a separate vision provider was needed at all.
    // 附图是增强功能,任何失败都不能挡住消息本身。
    let block: { type: "image"; attachment: unknown } | null = null;
    try {
      if (imagePath !== undefined && await this.routeTakesImages()) {
        block = await this.imageBlock(imagePath);
      }
    } catch (err) {
      logger.warn(`enqueueMessage: 附图跳过: ${String(err)}`);
    }
    // 只说真话。上一版由上游 inbound 无条件断言"图片已附上",而它并不知道附图成没成
    // —— 静默失败那次,模型被告知有图、又被禁止用工具,于是给一盘水果编出了一只小熊猫。
    // 只有执行附图的这段代码有资格描述它。
    if (imagePath !== undefined) {
      marked += block === null
        ? "\n（图片没有附在本条消息里,请用视觉工具读上面那个路径来查看。）"
        : "\n（上面这张图已附在本条消息里,直接看图回应,不用再调视觉工具。）";
    }
    const message = createUserMessage({
      content: block === null
        ? [{ type: "text", text: marked }]
        : [{ type: "text", text: marked }, block as never],
      // v4 sessions refuse the retired `{ kind: "plugin", plugin }` wrapper
      // outright ("format v4 message requires a producer-owned source kind"),
      // so every inbound WeChat message would fail to append. This is the exact
      // kind the v3→v4 converter gives this plugin's history
      // (`plugin:${name}` for a third-party producer), so old and new agree.
      source: { kind: "plugin:wechat-clawbot" } as never,
    });
    const live = this.ctx.agents.get(this.sessionId);
    if (live && live.status === "running") {
      // Interrupt-style insertion: steer into the running turn (next-step).
      logger.info(`enqueueMessage: steering message (${text.length} chars) into running turn`);
      // Attribute the running turn's reply to the WeChat sender so the
      // steered response (which may merge GUI + WeChat context) reaches the
      // phone and is not dropped as "GUI-only".
      this.currentSender = sender;
      try {
        live.steer(message);
        this.typing.start(sender);
        return;
      } catch (err) {
        logger.warn(`enqueueMessage: steer failed (${String(err)}); falling back to queue`);
      }
    }
    this.queue.push({ sender, text, message });
    logger.info(`enqueueMessage: queued sender=${sender} msgId=${message.id} queueDepth=${this.queue.length}`);
    void this.runWorker();
  }

  /** Start the serialized worker if it is not already running. */
  private runWorker(): void {
    if (this.worker) return;
    this.worker = this.drainQueue().finally(() => {
      this.worker = null;
    });
  }

  /** Drive queued turns one at a time; never rejects. */
  private async drainQueue(): Promise<void> {
    while (!this.disposed && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.currentSender = task.sender;
      this.turnMessageCount = 0; // 新回合重置发送计数
      this.typing.start(task.sender);
      const started = Date.now();
      try {
        const agent = await this.ensureAgent();
        if (agent.status === "running") {
          // Mid-turn steer (unexpected via queue): inject into next-step so
          // the running turn absorbs the message instead of starting a new one.
          logger.info(`drainQueue: steering queued message into running turn`);
          agent.steer(task.message);
        } else {
          agent.followup(task.message);
        }
        await agent.whenIdle();
        // Automatic memory fallback: capture durable user facts from this
        // turn's message without relying on the model calling
        // remember_user_info (which it often skips).
        //
        // Deliberately fire-and-forget (async): the reply is already sent
        // when whenIdle() resolves, and the memory file is re-read on every
        // prompt assembly, so the NEXT user message already benefits. Doing
        // it off the worker's tail keeps rapid consecutive messages from
        // being delayed by file I/O or the LLM confirm call.
        const turnText = task.text;
        // Opt-in (see ClawbotConfig.autoMemory). Since 2026-09-22 the
        // classifier goes through the host `llm` service on **this session's
        // own route**, so it is no longer a second data destination — the text
        // only reaches the model the user is already chatting with.
        if (this.config.autoMemory) {
          void Promise.resolve().then(async () => {
            try {
              await captureTurnMemory([turnText], this.memoryJudge());
            } catch (err) {
              logger.warn(`memory-auto: capture failed: ${String(err)}`);
            }
          });
        }
        logger.debug(`drainQueue: idle after ${Date.now() - started}ms`);
      } catch (err) {
        logger.error(`drainQueue: turn failed sender=${task.sender} err=${String(err)}`);
      }
      // 后面还有排队的消息就接着显示,否则收起「正在输入」,开始等空闲压缩。
      if (this.queue.length === 0) {
        this.typing.stop();
        this.idleCompact.noteIdle();
      }
    }
    this.currentSender = undefined;
  }

  /**
   * Session event feed: track the active WeChat recipient for turns NOT
   * driven by the inbound queue. Assistant text is NEVER forwarded
   * automatically — the agent must call the send_wechat_text / 
   * send_wechat_file tools explicitly to deliver anything to WeChat. This
   * method only:
   * - sets `currentSender` for scheduled-reminder injections (source plugin
   *   "schedule"), so the send tools know whom to deliver to; and
   * - clears the stale sender when a GUI-only turn ends, so GUI messages
   *   never get a WeChat recipient.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (session.id !== this.sessionId) return;
    logger.debug(`sessionEvent: type=${event.type} seq=${event.seq}`);
    // Turns the worker drives stop the indicator themselves; this covers
    // reminder turns and messages steered into a turn someone else started.
    if (event.type === "assistant/message") {
      const tokens = (event.data as { usage?: { totalTokens?: unknown } } | undefined)?.usage?.totalTokens;
      if (typeof tokens === "number" && tokens > 0) this.lastRequestTokens = tokens;
    }
    // Real work after a reply (search, shell, files…): 「正在输入」 comes back now
    // instead of after the quiet window. A reply tool is the answer itself.
    if (event.type === "tool/call" && this.currentSender) {
      const name = (event.data as { name?: unknown } | undefined)?.name;
      if (typeof name === "string" && !REPLY_TOOLS.has(name)) this.typing.noteWorking(this.currentSender);
    }
    if (event.type === "turn/start") this.idleCompact.noteActivity();
    if (event.type === "turn/end" && !this.worker) {
      this.typing.stop();
      this.idleCompact.noteIdle();
    }
    if (event.type === "user/message" && !this.worker) {
      // v4 drops the `plugin` field: dsh-schedule now writes `{ kind: "schedule" }`
      // and the v3→v4 converter maps old reminders to the same. Checking only
      // `source.plugin` would be silently false forever — every reminder would
      // be answered in the web UI and never reach WeChat. The `plugin` arm is
      // kept for a session still read through the v3 shape.
      const source = event.data?.source as { kind?: unknown; plugin?: unknown } | undefined;
      if (source?.kind === "schedule" || source?.plugin === "schedule") {
        // Scheduled-reminder injection: attribute the turn to the WeChat
        // owner so the agent's explicit send tool calls reach the phone.
        const owner = this.deps.getAccount()?.userId;
        if (owner) {
          logger.info(`sessionEvent: schedule turn attributed to owner ${owner}`);
          this.currentSender = owner;
          // A reminder turn is a turn of its own: without this it inherited
          // what the last WeChat turn left of the 10-message budget, and once
          // that ran out every later reminder was dropped (the tool still said
          // 已发送) until the owner happened to message the bot again.
          this.turnMessageCount = 0;
          this.typing.start(owner);
        }
        // dsh-schedule 自己就能把会话唤醒来投递提醒,这条路径**不经过**
        // ensureAgent —— 所以那一轮里工具屏蔽、微信发送工具、配置的模型全都还
        // 没装上。2026-08-21 就是这么出事的:模型在提醒那轮拿到了本该被屏蔽的
        // send_message,拿它乱调一把,用户收到的是
        // `subagent "invalid" is unavailable`;而且那轮用的是会话里残留的旧
        // header(上一次的 provider + 模型 + 档位),不是设置里的模型。
        // 这里补上,而且必须在模型发起请求之前 —— 事件是消息入 inbox 时同步派发的。
        const live = this.ctx.agents.get(this.sessionId);
        if (live) {
          this.installSelection(live.ctx);
          this.ensureTools(live.ctx);
        }
      } else {
        // Direct GUI message: leave currentSender unset so send tools have
        // no WeChat recipient (the agent will answer in the GUI only).
        logger.debug(`sessionEvent: external turn from ${String(source?.kind ?? source?.plugin ?? "unknown")}; GUI-only, no wechat recipient`);
      }
    }
  }

  /**
   * Build (or refresh) a time index of all session message events, so quotes
   * of messages that predate the quote-history registry (e.g. before a
   * restart) can still be resolved by timestamp.
   */
  private buildSessionIndex(): void {
    const session = this.handle?.agent.session;
    if (!session) {
      this.sessionIndex = null;
      return;
    }
    if (this.sessionIndex && this.sessionIndex.seq === session.seq) return;
    const entries: Array<{ time: number; text: string; imagePath?: string }> = [];
    // 0.1.7 replaced `session.events` with `snapshotEvents()` (same event shapes).
    for (const event of session.snapshotEvents()) {
      if (event.type === "user/message") {
        const text = (event.data.content ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!text.trim()) continue;
        const pathMatch = /已保存到 ([^\s）]+)/.exec(text);
        entries.push({
          time: event.time,
          text,
          imagePath: pathMatch?.[1] ?? undefined,
        });
      } else if (event.type === "assistant/message") {
        const text = (event.data.message?.content ?? [])
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!text.trim()) continue;
        entries.push({ time: event.time, text });
      }
    }
    this.sessionIndex = { seq: session.seq, entries };
  }

  /**
   * Resolve a quote by the quoted message's server creation time (used when
   * the msg-id lookup misses, e.g. for messages sent before the quote
   * history started). Returns the nearest session message within tolerance.
   */
  lookupQuoteByTime(createTimeMs?: number): { text: string; imagePath?: string } | null {
    if (createTimeMs === undefined) return null;
    this.buildSessionIndex();
    if (!this.sessionIndex) return null;
    let best: { time: number; text: string; imagePath?: string } | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const entry of this.sessionIndex.entries) {
      const diff = Math.abs(entry.time - createTimeMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry;
      }
    }
    return best && bestDiff <= 10_000 ? best : null;
  }

  /**
   * Register the WeChat-scoped tools (send_wechat_file, preview_wechat_image,
   * (send_wechat_file, preview_wechat_image) on an agent scope. Idempotent
   * per bridge lifetime; safe
   * to call from both the creation setup and the live-agent path.
   */
  private ensureTools(agentCtx: Context): void {
    if (this.toolsRegistered) return;
    try {
      registerSendFileTool(agentCtx, {
        getBridge: () => this,
        getAccount: this.deps.getAccount,
        config: this.config,
      });
      // Visibility into the user's Claude Code sessions, so a WeChat message can
      // ask "what is Claude doing" or redirect a coding session the user is not
      // sitting in front of. restrictTools below is a DENY list, so these three
      // are visible without needing to be named there.
      registerClaudePeerTools(agentCtx, this.config);
      // Codex tools only when the owner switched them on: every registered tool
      // rides along on every request. codexPeer is a cold field, so a flip
      // restarts the listener and lands here again with the new value.
      const codex = this.deps.codexPeer !== undefined && this.config.codexPeer === true;
      if (codex) registerCodexPeerTools(agentCtx, this.deps.codexPeer!);
      this.restrictTools(agentCtx);
      this.toolsRegistered = true;
      logger.info(`ensureTools: WeChat tools registered (Codex tools ${codex ? "on" : "off"})`);
    } catch (err) {
      logger.warn(`ensureTools: registration failed (will retry): ${String(err)}`);
    }
  }

  /**
   * Hide the multi-agent orchestration tools from the WeChat session.
   *
   * Observed failure: the agent called `send_message` with
   * `{subagent_id: "schedule-9", message: "ignore"}`, got
   * `subagent "schedule-9" is unavailable`, then retried with schedule-10,
   * -11, ... past -103 — 158 steps and 4.5M input tokens in about three
   * minutes ($0.11 of a $10 monthly allowance) before it was stopped by hand.
   * Running with reasoning_effort "none" (the only setting this gateway
   * accepts alongside tools) leaves no self-correction to break such a loop.
   *
   * `send_message` is the likeliest trigger: it sits next to this plugin's own
   * `send_wechat_text` in the same tool list, and the two names are easy to
   * conflate. None of these tools have a role in a one-on-one WeChat chat, so
   * denying them removes the whole failure mode rather than guarding it.
   *
   * A deny list, not an allow list: everything the bot actually uses (bash,
   * read/glob/grep, web_search, the vision tools, schedule_*, memory) keeps
   * working untouched. Per-scope restrictions also leave scoped registrations
   * alone, so the WeChat tools registered just above survive.
   */
  private restrictTools(agentCtx: Context): void {
    // "subagent" 在 DSH 0.1.5 里改名成了 subagent_fork。一个不存在的名字会让
    // tools.restrict() 整个抛异常 —— 于是**整份 deny 一条都没生效**,
    // send_message 又回到了 bot 的工具列表里(就是上面那个烧钱故事的触发器)。
    // 所以:一个名字一次调用,谁不认识就只丢那一个,并把丢掉的名字打出来。
    const deny = [
      "send_message",
      "subagent_fork",
      "list_agents",
      "ralph",
      "workflow",
    ];
    try {
      // Direct property access, matching how this plugin already registers its
      // own tools (`agentCtx.tools.register`). cordis isolates services a
      // context has not injected, so `agentCtx.get("tools")` returns nothing
      // here and the restriction would silently never apply.
      const tools = agentCtx.tools as unknown as {
        restrict?: (filter: { deny?: readonly string[] }) => () => void;
      };
      if (typeof tools?.restrict !== "function") {
        logger.warn("restrictTools: tools.restrict unavailable, orchestration tools stay visible");
        return;
      }
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const name of deny) {
        try {
          tools.restrict({ deny: [name] });
          applied.push(name);
        } catch {
          // 宿主不认识这个名字(改名/删掉了)。只丢它,别拖累别的。
          skipped.push(name);
        }
      }
      logger.info(
        `restrictTools: hidden from WeChat session -> ${applied.join(", ") || "(无)"}`
        + (skipped.length > 0 ? `; 宿主不认识、已跳过 -> ${skipped.join(", ")}` : ""),
      );
    } catch (err) {
      logger.warn(`restrictTools: failed (non-fatal): ${String(err)}`);
    }
  }

  /** Tear down the owned agent handle (the persisted session log survives). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.typing.dispose();
    this.idleCompact.dispose();
    // Dispose the agent first: this stops the driver, so a pending whenIdle
    // resolves and the worker can exit instead of hanging forever.
    try {
      await this.handle?.dispose();
    } catch (err) {
      logger.warn(`dispose: ${String(err)}`);
    }
    this.handle = null;
    this.queue.length = 0;
    try {
      await this.worker;
    } catch (err) {
      logger.warn(`dispose: worker error ${String(err)}`);
    }
    this.worker = null;
  }
}
