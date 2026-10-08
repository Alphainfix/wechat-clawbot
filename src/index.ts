/**
 * wechat-clawbot — DeepSeek Harness ⇄ WeChat (official ClawBot bridge).
 *
 * A DSH plugin bundle that connects a profile to the user's WeChat through
 * Tencent's iLink API (the same protocol the official WeChat ClawBot channel
 * uses). Inbound WeChat messages are routed into one fixed agent session;
 * assistant replies and approval requests are sent back to WeChat.
 *
 * @module wechat-clawbot
 */
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";

import { normalizeConfig, snapshotConfig, HOT_FIELDS, type ClawbotConfig } from "./config.js";
import { WechatBridge } from "./bridge.js";
import { InboundRouter } from "./inbound.js";
import { ApprovalRelay } from "./approvals.js";
import { tryRegisterQuestionProvider } from "./questions.js";
import { runMonitor } from "./monitor.js";
import { PendingRegistry } from "./pending.js";
import { watchAccountStore, type StateWatcher } from "./state.js";
import { registerWechatGuidanceGlobal } from "./prompt.js";
import { registerSubagentModelPolicy } from "./subagent-model.js";
import { registerModelsRoute } from "./models-route.js";
import { registerMcpRoutes } from "./mcp-route.js";
import { CodexPeer } from "./codex-peer.js";
import { claimInstance } from "./instance-guard.js";
import { CodexProgressStore } from "./codex-progress.js";
import { ensureMemoryFile } from "./memory.js";
import { isHostSchedule, migrateLegacyReminders, type HostSchedule } from "./schedule-migrate.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import {
  resolveWeixinAccount,
  setBotAgent,
  listIndexedWeixinAccountIds,
  type ResolvedWeixinAccount,
} from "./ilink/auth/accounts.js";
import { sendMessageWeixin } from "./ilink/messaging/send.js";
import { stripEmoji, stripWechatCodes } from "./emoji.js";
import { setLogLevel, logger } from "./ilink/util/logger.js";
import { registerWorkspaceInstructionsFilter } from "./workspace-instructions.js";

/** Stable Cordis plugin name for the clawbot row. */
export const name = "clawbot";

/**
 * Services the plugin uses directly. `agentPresets` and `userQuestions` are
 * deliberately NOT listed: they are optional (agent-presets only ships with
 * web/headless bundles) and are accessed defensively instead.
 */
export const inject = ["agents", "sessions", "tools", "systemPrompt"];

// Re-exported so cordis finds the schema on the plugin module: it is what the
// settings page renders as a form, and what validates a change before the
// update hook below ever sees it.
export { Config } from "./config.js";

export function apply(ctx: Context, rawConfig?: Partial<ClawbotConfig>): () => Promise<void> {
  // Since DSH 0.1.7 the hot fields of `rawConfig` are live `{ get() }`
  // references (they are `.volatile()` in `Config`), so the row must be
  // unwrapped BEFORE normalising: `normalizeConfig` checks `typeof … ===
  // "string"`, and a reference would silently fall back to every default —
  // the bot would boot on the harness default model with none of its settings.
  const config = normalizeConfig(snapshotConfig(rawConfig));
  setLogLevel(config.logLevel);
  setBotAgent(config.botAgent);

  // Mutating `config` in place is what makes adoption work at all: bridge,
  // inbound, approvals and the tools each hold a reference to this same object
  // and read the field at the moment they use it. Replacing the reference would
  // update nobody.

  // Reads the running fiber's references on every call, so it always returns
  // the values the Loader last committed.
  const readSettings = (): Partial<ClawbotConfig> | undefined => snapshotConfig(rawConfig);
  const adoptSettings = (): void => {
    const incoming = normalizeConfig(readSettings());
    const changed = (Object.keys(incoming) as (keyof ClawbotConfig)[])
      .filter((key) => JSON.stringify(incoming[key]) !== JSON.stringify(config[key]));
    if (changed.length === 0) return;

    const hot = changed.filter((key) => HOT_FIELDS.has(key));
    const cold = changed.filter((key) => !HOT_FIELDS.has(key));

    // Copy the HOT fields only, one by one — never `Object.assign` the whole
    // incoming object. A cold field taking effect the instant it is typed is
    // exactly what this design promises not to do: `apiBaseUrl` would redirect
    // a connected client mid-flight, `sessionId` would point the bridge at a
    // session it is not bound to. They are stored, and the next start reads them.
    //
    // Cold fields are also deliberately not auto-restarted: reloading this fiber
    // from inside its own change hook is a re-entrancy hazard, and a WeChat
    // monitor that drops itself as each keystroke lands is worse than one that
    // waits to be told. The card says so, and /restart applies them.
    for (const key of hot) (config as unknown as Record<string, unknown>)[key] = incoming[key];
    // The one hot field with a side effect beyond the config object: the logger
    // captured its level at startup, so an in-place change is invisible.
    if (hot.includes("logLevel")) setLogLevel(config.logLevel);
    if (hot.length > 0) logger.info(`设置已即时生效 [${hot.join(", ")}](没有重启,微信监听未中断)`);
    // Re-point the live model selection. Separate from the field copy above
    // because it validates the model id before switching — a typo in the
    // settings box must not brick the next message.
    if (hot.some((key) => key === "provider" || key === "model" || key === "reasoningEffort")) {
      void bridge?.refreshSelection().catch((err) => {
        logger.warn(`refreshSelection 失败: ${String(err)}`);
      });
    }
    if (cold.length > 0) logger.info(`设置已保存 [${cold.join(", ")}],但要等重启才生效(/restart 或小鲸鱼的重启按钮)`);
  };

  // Adopt live edits without tearing anything down.
  //
  // DSH 0.1.7 removed `installSettingsSection`. The replacement is structural:
  // HOT fields are `.volatile()` in `Config`, the Plugins page edits exactly
  // those, and when an edit touches only volatile fields the Loader commits the
  // new values into this fiber's references in place — no restart — then emits
  // `loader/volatile-update` to this fiber alone. Any other field changing
  // restarts the fiber, which is what cold fields always needed anyway, and
  // those are not on the page at all.
  //
  // So the only job left here is the side effects: `adoptSettings` re-reads the
  // references, diffs against the plain `config` every other module holds,
  // copies the hot fields in place, re-points the model selection and the log
  // level, and logs what took effect. Unchanged logic, new trigger. The event
  // is a Loader event, absent from cordis's typed map, hence the cast.
  (ctx.on as unknown as (name: string, cb: () => void) => () => void)(
    "loader/volatile-update",
    () => adoptSettings(),
  );

  // This plugin ships its own card (the Plugins page, via the browser half), so
  // tell the settings service not to auto-generate a competing page. Optional
  // inject: naming `settings` in `inject` would make it a hard requirement, and
  // a bare `ctx.settings` read throws.
  ctx.inject(["settings"], (child) => {
    child.effect(() => (child as unknown as {
      settings: { configure(p: { auto: boolean }, owner: unknown): () => void };
    }).settings.configure({ auto: false }, ctx.fiber));
  });

  // Register the WeChat conversation guidance GLOBALLY with a dynamic text
  // provider: it yields the rules ONLY for the WeChat session (by session id),
  // and an empty string for every other DSH conversation, so unrelated GUI
  // sessions are never affected. This covers agents that the harness resumes
  // directly from GUI messages without running the bridge's agent setup.
  try {
    registerWechatGuidanceGlobal(ctx, config.sessionId, config);
    logger.info(`clawbot: wechat guidance registered globally (session=${config.sessionId})`);
  } catch (err) {
    logger.warn(`clawbot: global guidance registration failed: ${String(err)}`);
  }

  // The settings card's dropdowns need a model catalogue; publish one.
  registerModelsRoute(ctx);

  // Long-term user memory (Claude-Desktop style): seed the memory file so the
  // dynamic memory section (registered above, order 79) has content to inject.
  ensureMemoryFile();

  // Subagents delegated from the WeChat session run with max thinking:
  // the main conversation is reasoningEffort=off for fast replies, but deep
  // delegated tasks get full reasoning on DeepSeek Flash. The id has to be one
  // the host's catalog still lists: 0.1.7 cut the built-in DeepSeek catalog to
  // `deepseek-flash` / `deepseek-v4-pro`, and the old `deepseek-v4-flash` pin
  // left every delegated task pointing at a model the router no longer knows.
  try {
    registerSubagentModelPolicy(ctx, {
      sessionId: config.sessionId,
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEffort: "max",
    });
    logger.info(`clawbot: subagent max-thinking policy registered (parent=${config.sessionId})`);
  } catch (err) {
    logger.warn(`clawbot: subagent model policy registration failed: ${String(err)}`);
  }

  const pending = new PendingRegistry();

  let bridge: WechatBridge | null = null;
  const codexProgress = new CodexProgressStore();
  const codexPeer = new CodexPeer(config, codexProgress, {
    askWechat: (question, signal) => bridge?.askWechat(question, 300_000, signal) ?? Promise.resolve(null),
  });
  let router: InboundRouter | null = null;
  let monitorTask: Promise<void> | null = null;
  let currentAccount: ResolvedWeixinAccount | null = null;
  /** Fresh per monitor start (an aborted controller cannot be reused). */
  let abort = new AbortController();

  // DSH 0.1.7-rc.2 moved reminders into a Host table and leaves the old
  // session-log ones behind without a word (see schedule-migrate.ts), so every
  // reminder the bot had confirmed would silently never fire. Carry the
  // WeChat session's pending ones over once both halves exist: the host
  // `schedule` service (rc.1 has none, so this never runs there) and the
  // warmed agent whose session holds the legacy events.
  let hostSchedule: HostSchedule | undefined;
  let warmSession: { id: unknown; snapshotEvents(): readonly unknown[] } | undefined;
  let carryOver: Promise<void> | undefined;
  const carryOverLegacyReminders = (): void => {
    const schedule = hostSchedule;
    const session = warmSession;
    if (!schedule || !session || carryOver) return;
    carryOver = migrateLegacyReminders({
      schedule,
      sessionId: String(session.id),
      events: session.snapshotEvents() as Iterable<{ type: string; data?: unknown }>,
      markerPath: path.join(resolveStateDir(), "schedule-migration.json"),
    }).then((report) => {
      for (const item of report.created) {
        logger.info(`legacy reminder ${item.legacyId} carried over as ${item.hostId} (due ${item.scheduledAt})`);
      }
      for (const item of report.skipped) {
        logger.warn(`legacy reminder ${item.legacyId} not carried over: ${item.reason}`);
      }
      if (report.present.length > 0) {
        logger.info(`legacy reminders already in the task table: ${report.present.join(", ")}`);
      }
    }, (err) => {
      logger.warn(`legacy reminders: carry-over failed, retrying on next start: ${String(err)}`);
    }).finally(() => {
      carryOver = undefined;
    });
  };
  ctx.inject(["schedule"], (scoped) => {
    const service = (scoped as unknown as { schedule?: unknown }).schedule;
    if (!isHostSchedule(service)) return;
    hostSchedule = service;
    scoped.effect(() => () => {
      if (hostSchedule === service) hostSchedule = undefined;
    });
    carryOverLegacyReminders();
  });

  // Session event feed: assistant replies for the WeChat session. Attached
  // once for the plugin lifetime; the bridge is looked up per event.
  ctx.on("session/event", (session, event) => {
    bridge?.onSessionEvent(session, event);
  });

  /** Send a text message back to one WeChat user through the bound account. */
  const sendText = async (to: string, text: string): Promise<void> => {
    if (!currentAccount?.configured) throw new Error("no bound WeChat account");
    // Bracket codes go either way — see src/emoji.ts.
    const finalText = config.stripEmoji ? stripEmoji(text) : stripWechatCodes(text);
    if (!finalText) return;
    await sendMessageWeixin({
      to,
      text: finalText,
      opts: {
        baseUrl: currentAccount.baseUrl,
        token: currentAccount.token,
        contextToken: router?.contextTokenFor(to) ?? undefined,
        timeoutMs: 15_000,
      },
    });
  };

  // Bridge routes for the local MCP server: list/read/drive sessions, and push
  // one WeChat message to the owner. Registered here rather than beside
  // registerModelsRoute because it needs `sendText` and the account getter,
  // both defined just above.
  registerMcpRoutes(ctx, { config, sendText, getAccount: () => currentAccount, codexProgress });

  /** Pick the first bound account (v1 supports a single account). */
  const pickAccount = (): ResolvedWeixinAccount | null => {
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 0) return null;
    try {
      return resolveWeixinAccount(ids[0]);
    } catch (err) {
      logger.warn(`pickAccount: ${String(err)}`);
      return null;
    }
  };

  /** Start the monitor for the current account (idempotent). */
  // Set once a newer instance has taken over (see instance-guard.ts) or we were
  // unloaded: from then on nothing here may start talking to WeChat again.
  let superseded = false;

  const startMonitor = (): void => {
    if (monitorTask || superseded) return;
    const account = pickAccount();
    if (!account) {
      logger.info("startMonitor: no bound account; waiting for `clawbot login`");
      return;
    }
    if (!account.configured) {
      logger.info("startMonitor: account not configured (no token)");
      return;
    }
    currentAccount = account;
    bridge = new WechatBridge(ctx, config, sendText, {
      codexPeer,
      getAccount: () => currentAccount,
      getContextToken: (sender) => router?.contextTokenFor(sender) ?? "",
      pending,
    });
    router = new InboundRouter({
      config,
      account,
      bridge,
      pending,
      sendText,
    });

    abort = new AbortController();
    const signal = abort.signal;
    monitorTask = runMonitor({
      account,
      signal,
      onMessage: (msg) => router!.handle(msg),
      onStop: (reason) => {
        logger.warn(`monitor stopped: ${reason}`);
        void stopMonitor(reason);
      },
    });
    monitorTask.catch((err) => {
      logger.error(`monitor crashed: ${String(err)}`);
      void stopMonitor(`monitor crashed: ${String(err)}`);
    });
    // 可选服务只能这样拿:回调只在真有这些服务的组合里触发,不会变成硬依赖。
    const boundBridge = bridge;
    if (boundBridge) {
      ctx.inject(["llm", "attachments"], (scoped) => { boundBridge.useVisionServices(scoped); });
    }

    logger.info(`startMonitor: monitoring account=${account.accountId}`);

    // 定时提醒是 session-local 的:dsh-schedule 的定时器只在这个会话的 agent
    // 活着的时候存在。而 agent 过去是懒创建的 —— 只有收到微信消息才建。于是
    // 每次重启都会静默解除所有待触发的提醒,直到下一条消息进来才重新武装:
    // 2026-08-21 那条设在 09:00 的提醒,因为 07:43 重启、而下一条消息是 11:03,
    // 就迟了两个多小时才以"逾期"的形式补发。
    // 所以启动时就把 agent 预热出来,让待触发的提醒从开机起就是武装状态。
    // (0.1.7-rc.2 起提醒进了宿主的任务表,到点时宿主自己会把冷会话拉起来,
    // 这一条对新宿主不再必需;预热保留,是因为旧提醒的迁移要读这个会话的日志。)
    void bridge?.ensureAgent().then(
      async (agent) => {
        logger.info("startMonitor: agent warmed at startup (pending reminders armed)");
        warmSession = agent.session;
        carryOverLegacyReminders();
        // 现在 installSelection() 已经跑过,路由才是真的,自检结果才可信。
        await boundBridge?.reportVisionReadiness();
        await boundBridge?.reportIdleCompactReadiness();
      },
      (err) => logger.warn(`startMonitor: agent warm-up failed: ${String(err)}`),
    );
  };

  /** Stop the monitor and release the agent handle (idempotent). */
  const stopMonitor = async (reason: string): Promise<void> => {
    if (!monitorTask) return;
    logger.info(`stopMonitor: ${reason}`);
    abort.abort();
    try {
      await monitorTask;
    } catch (err) {
      logger.warn(`stopMonitor: task error ${String(err)}`);
    }
    monitorTask = null;
    warmSession = undefined;
    await bridge?.dispose();
    bridge = null;
    router = null;
    currentAccount = null;
    pending.abortAll();
  };

  // Approval questions for WeChat sessions arrive in WeChat.
  const relay = new ApprovalRelay({
    config,
    getBridge: () => bridge,
    pending,
    sendText,
  });
  relay.register(ctx);

  // Optionally keep AGENTS.md / CLAUDE.md out of the WeChat session (config
  // workspaceInstructions; read per step, so the switch is live).
  registerWorkspaceInstructionsFilter(
    ctx,
    (agentId) => config.workspaceInstructions === false && (bridge?.isWechatSession(agentId) ?? false),
  );

  // Optional ask_user_question / plan-review forwarding.
  tryRegisterQuestionProvider({
    ctx,
    config,
    pending,
    sendText,
    primaryUser: () => currentAccount?.userId,
  });

  // React to `clawbot login` / `clawbot logout` while the profile is running.
  const watcher: StateWatcher = watchAccountStore(() => {
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 0) {
      void stopMonitor("account removed (logout)");
    } else if (!monitorTask) {
      startMonitor();
    }
  });

  // One live instance per process. If the host reloaded us without disposing
  // the previous instance, retire it first, then start our own monitor.
  const claim = claimInstance(async (reason) => {
    superseded = true;
    logger.warn(`clawbot instance: ${reason}; stopping this older one (the host did not dispose it)`);
    watcher.close();
    codexPeer.close();
    await stopMonitor(reason);
  });
  logger.info(`clawbot instance #${claim.id} active`);
  if (config.autoStart) {
    void claim.ready.then(() => {
      if (claim.isCurrent()) startMonitor();
    });
  }

  return async () => {
    logger.info(`plugin unload: stopping clawbot (instance #${claim.id})`);
    superseded = true;
    claim.release();
    watcher.close();
    codexPeer.close();
    await stopMonitor("plugin unload");
  };
}
