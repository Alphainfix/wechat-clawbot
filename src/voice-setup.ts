/**
 * Getting voice to work, on the owner's word.
 *
 * WeChat's newer voice messages come without text, so something on this
 * machine has to transcribe them (voice.ts). The way that is the same for
 * everyone is DSH's own 语音输入 (the experimental voice-input bundle: a local
 * SenseVoice model behind `ctx.speechToText`). It ships with DSH switched off.
 *
 * The bot can switch it on for the owner: `enable_voice_input`. Because that
 * changes DSH itself (a plugin goes on, a model of about 240 MB is downloaded,
 * the web page gains a microphone button), the tool asks first and the asking
 * is not left to the model's wording: the question below is sent as written,
 * to the owner only, and only a plain yes goes ahead. Then it selects the
 * bundle through DSH's plugin manager, starts the model's download through
 * the speech service, and tells the owner when the model is ready — or that it
 * failed, and what to do — in a message of its own, since a download outlives
 * the turn that started it.
 *
 * Everything here feature-detects: both services are DSH's, the speech one is
 * marked experimental, and a DSH without them just gets the by-hand steps.
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import type { ClawbotConfig } from "./config.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { logger } from "./ilink/util/logger.js";
import type { OwnerAnswer } from "./mac-calendar.js";
import {
  hostSpeechStatus, sharedSpeechHelper, voicePlatformSupported, VOICE_SETUP_PHRASE,
  type HostSpeech, type HostSpeechStatus,
} from "./voice.js";

/** DSH's optional bundle that brings the speech service and its local recognizer. */
export const VOICE_BUNDLE = "@deepseek-ai/dsh-experimental-voice-input-bundle";
export const VOICE_TOOL = "enable_voice_input";

/** By hand, for when the bot cannot do it. */
export const VOICE_BY_HAND = "在电脑的 DSH 网页里点左边的「插件」，打开「语音输入」，再点「下载并准备」";

/** As much of DSH's plugin manager (`ctx.pluginManager`) as is used here. */
type PluginManagerLike = {
  setBundleEnabled(name: string, enabled: boolean): Promise<{ application?: string; error?: unknown } | undefined>;
};

export type VoiceStatus = {
  /** What a voice message without WeChat's text would be transcribed with right now; null: nothing. */
  engine: "dsh" | "mac" | null;
  host: HostSpeechStatus;
  /** This Mac's own on-device transcription. unsupported: not a Mac on macOS 26 or later. */
  mac: "ready" | "unavailable" | "unsupported";
  /** The plugin's own switch (voiceTranscribe). */
  on: boolean;
};

export type VoiceSetupDeps = {
  /** The plugin's root context: `ctx.get` reaches DSH's services. */
  ctx: Pick<Context, "get">;
  config: Pick<ClawbotConfig, "voiceTranscribe" | "voiceLanguage" | "allowFrom">;
  getAccount: () => ResolvedWeixinAccount | null;
  activeSender: () => string | undefined;
  /** Ask the owner on WeChat and wait for the answer (bridge.askOwner). */
  askOwner: (question: string, signal?: AbortSignal) => Promise<OwnerAnswer>;
  /** Tell the owner something later, outside any turn. */
  tellOwner: (text: string) => Promise<void>;
  /** Tests: how often to look at the download, how long to wait for the service to appear, and this Mac's readiness. */
  pollMs?: number;
  appearMs?: number;
  watchMs?: number;
  macReady?: () => Promise<VoiceStatus["mac"]>;
};

function service<T>(ctx: Pick<Context, "get">, name: string): T | undefined {
  try {
    return (ctx.get as (key: string) => unknown)(name) as T | undefined;
  } catch {
    return undefined;
  }
}

/** DSH's speech recognition, when the owner has it switched on. */
export function hostSpeech(ctx: Pick<Context, "get">): HostSpeech | undefined {
  return service<HostSpeech>(ctx, "speechToText");
}

let macCache: { at: number; language: string; value: VoiceStatus["mac"] } | null = null;

/** Whether this Mac's own models can transcribe `language` (asked of the helper; remembered for a minute). */
async function macReadiness(language: string): Promise<VoiceStatus["mac"]> {
  if (!voicePlatformSupported()) return "unsupported";
  if (macCache !== null && macCache.language === language && Date.now() - macCache.at < 60_000) return macCache.value;
  let value: VoiceStatus["mac"] = "unavailable";
  try {
    const status = await sharedSpeechHelper().status(language);
    value = status.ok === true && typeof status.engine === "string" ? "ready" : "unavailable";
  } catch {
    value = "unavailable";
  }
  macCache = { at: Date.now(), language, value };
  return value;
}

/** Where voice stands on this machine right now. */
export async function voiceStatus(deps: Pick<VoiceSetupDeps, "ctx" | "config" | "macReady">): Promise<VoiceStatus> {
  const host = hostSpeechStatus(hostSpeech(deps.ctx));
  const mac = await (deps.macReady ?? (() => macReadiness(deps.config.voiceLanguage || "zh-CN")))();
  const on = deps.config.voiceTranscribe !== false;
  return { engine: !on ? null : host.state === "ready" ? "dsh" : mac === "ready" ? "mac" : null, host, mac, on };
}

/** One line on where voice stands, for the bot to pass on. */
export function describeVoice(status: VoiceStatus): string {
  if (!status.on) return "插件里的「语音没带文字时在本机转写」开关关着，所以听不了没带文字的语音。";
  if (status.engine === "dsh") {
    return `能听语音：用的是 DSH 的「语音输入」（${status.host.state === "absent" ? "" : status.host.name}，${status.host.state !== "absent" && !status.host.local ? "云端" : "在这台电脑上运行"}）。`;
  }
  const hostLine = status.host.state === "absent"
    ? "DSH 的「语音输入」没开"
    : status.host.state === "preparing"
      ? "DSH 的「语音输入」开着，语音识别模型正在下载或加载"
      : status.host.state === "failed"
        ? `DSH 的「语音输入」开着，但模型没准备成${status.host.message ? `（${status.host.message}）` : ""}`
        : "DSH 的「语音输入」开着，但语音识别模型还没下载";
  if (status.engine === "mac") return `能听语音：用的是这台 Mac 自带的转写（${hostLine}；打开它一般更准，中英文夹着说也认得更好）。`;
  return `还听不了没带文字的语音：${hostLine}${status.mac === "unsupported" ? "" : "，这台 Mac 自带的转写也用不了"}。`;
}

/**
 * A plain yes to "shall I switch it on?". Anything else is a no — a bare
 * 嗯 / 是 / 对 too, which on WeChat is often just "I'm reading".
 */
export function isPlainYes(reply: string | null): boolean {
  if (reply === null) return false;
  return /^\s*(好|好的|好啊|好呀|可以|行|行的|确认|同意|没问题|打开|打开吧|开吧|ok|okay|yes|y)\s*[。.!！~]*\s*$/i.test(reply);
}

/** What the owner is asked before DSH is changed. Sent as written. */
export function consentQuestion(host: HostSpeechStatus): string {
  if (host.state === "absent") {
    return [
      "要我替你打开 DSH 的「语音输入」吗？打开后你发的语音就能在这台电脑上转成文字。它是 DSH 自带的插件（标着「实验性」），打开意味着：",
      "· 下载一个约 240 MB 的语音识别模型，只下一次",
      "· 语音只在这台电脑上处理，不上传",
      "· DSH 网页的输入框旁边会多一个麦克风按钮",
      "· 不想要了，随时可以在 DSH 网页的「插件」里关掉",
      "回「好」我就打开，回别的我就不动。",
    ].join("\n");
  }
  return "DSH 的「语音输入」已经开着，但语音识别模型还没下载好。要我现在下载吗？约 240 MB，只下一次，下好后语音就在这台电脑上转成文字，不上传。回「好」就开始，回别的我就不动。";
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function progress(host: HostSpeechStatus): string {
  if (host.state === "absent" || host.completedBytes === undefined) return "";
  return host.totalBytes !== undefined && host.totalBytes > 0
    ? `（已下载 ${megabytes(host.completedBytes)} / ${megabytes(host.totalBytes)}）`
    : `（已下载 ${megabytes(host.completedBytes)}）`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
/** For the long watch of a download: it must not keep a process alive that has nothing else to do. */
const idle = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** One watcher per process, however many times the owner asks. */
let watching = false;

/**
 * Follow the model's download to its end and tell the owner how it went.
 * Quiet when someone switches the bundle off meanwhile.
 */
function watchPreparation(deps: VoiceSetupDeps): void {
  if (watching) return;
  watching = true;
  const pollMs = deps.pollMs ?? 3000;
  const deadline = Date.now() + (deps.watchMs ?? 60 * 60_000);
  void (async () => {
    try {
      for (;;) {
        await idle(pollMs);
        const host = hostSpeechStatus(hostSpeech(deps.ctx));
        if (host.state === "absent") return;
        if (host.state === "ready") {
          logger.info(`voice-setup: DSH's ${host.name} is ready`);
          await deps.tellOwner("语音识别准备好了。现在发语音，我就能听了。");
          return;
        }
        if (host.state === "failed") {
          logger.warn(`voice-setup: DSH's ${host.name} did not get ready (${host.message ?? "no reason given"})`);
          await deps.tellOwner(
            `语音识别模型没准备成${host.message ? `（${host.message}）` : ""}。再跟我说一次「${VOICE_SETUP_PHRASE}」可以重试；`
            + "也可以在电脑的 DSH 网页里点「插件」→「语音输入」，换一个下载源再试。",
          );
          return;
        }
        if (Date.now() > deadline) {
          await deps.tellOwner(`语音识别模型下载了很久还没好${progress(host)}。可以在电脑的 DSH 网页里点「插件」→「语音输入」看看卡在哪一步。`);
          return;
        }
      }
    } catch (err) {
      logger.warn(`voice-setup: stopped watching the model's download: ${String((err as Error).message ?? err).slice(0, 200)}`);
    } finally {
      watching = false;
    }
  })();
}

/** Only the owner changes this machine; the desktop (no WeChat sender) is the owner too. */
function notOwner(deps: Pick<VoiceSetupDeps, "getAccount" | "activeSender">): string | undefined {
  const owner = deps.getAccount()?.userId;
  if (owner === undefined || owner === "") return "不知道机主是谁（登录信息里没有用户 id），这件事做不了。重新扫码登录一次再试。";
  const sender = deps.activeSender();
  if (sender !== undefined && sender !== owner) return "打开语音识别要改这台电脑上的 DSH，只有机主能决定。请机主自己来说。";
  return undefined;
}

export type VoiceSetupResult = { ok: boolean; summary: string };

/**
 * Switch DSH's speech recognition on for the owner and get its model, after
 * asking them. Returns what to tell them now; the end of the download is told
 * later by `tellOwner`.
 */
export async function enableVoiceInput(deps: VoiceSetupDeps, signal?: AbortSignal): Promise<VoiceSetupResult> {
  const refused = notOwner(deps);
  if (refused !== undefined) return { ok: false, summary: refused };
  let host = hostSpeechStatus(hostSpeech(deps.ctx));
  if (host.state === "ready") {
    return { ok: true, summary: `DSH 的「语音输入」已经可以用了（${host.name}），不用再设置。让用户直接发语音试试。` };
  }
  if (host.state === "preparing") {
    watchPreparation(deps);
    return { ok: true, summary: `语音识别模型正在下载或加载${progress(host)}，好了会有一条消息告诉用户。在那之前发的语音还听不了。` };
  }

  // Find out whether it can be done at all before asking whether it should be.
  const manager = host.state === "absent" ? service<PluginManagerLike>(deps.ctx, "pluginManager") : undefined;
  if (host.state === "absent" && (manager === undefined || typeof manager.setBundleEnabled !== "function")) {
    return { ok: false, summary: `这个版本的 DSH 不让我替用户打开插件，得用户自己来：${VOICE_BY_HAND}。弄好后再发语音就行。` };
  }

  const answer = await deps.askOwner(consentQuestion(host), signal);
  if (answer.status !== "answered") {
    const why = answer.status === "undelivered"
      ? `问题没发出去（${answer.detail ?? "原因不明"}）`
      : answer.status === "timeout" ? "用户一直没回" : answer.status === "stopped" ? "这一轮被停下了" : "不知道机主是谁";
    return { ok: false, summary: `没有打开语音输入：${why}。什么都没改。` };
  }
  if (!isPlainYes(answer.reply)) {
    return { ok: false, summary: `用户没有同意（回的是「${answer.reply.slice(0, 40)}」），什么都没改。不要再追问；他想自己弄的话，做法是：${VOICE_BY_HAND}。` };
  }

  if (host.state === "absent" && manager !== undefined) {
    let application = "";
    try {
      const result = await manager.setBundleEnabled(VOICE_BUNDLE, true);
      application = String(result?.application ?? "");
      if (application === "failed" || application === "cancelled" || application === "overridden") {
        const detail = (result?.error as { message?: unknown } | undefined)?.message;
        throw new Error(`${application}${typeof detail === "string" ? `: ${detail}` : ""}`);
      }
    } catch (err) {
      const detail = String((err as Error).message ?? err).slice(0, 160);
      logger.warn(`voice-setup: could not switch the voice-input bundle on (${detail})`);
      return { ok: false, summary: `没打开成（${detail}）。请用户自己来：${VOICE_BY_HAND}。` };
    }
    logger.info(`voice-setup: switched DSH's voice-input bundle on at the owner's word (${application || "applied"})`);
    if (application === "restart-required") {
      return { ok: true, summary: `已经替用户选上了 DSH 的「语音输入」，但这台 DSH 要重启一次才生效。请用户重启 DSH，然后再说一次「${VOICE_SETUP_PHRASE}」，我接着下载模型。` };
    }
    // The bundle's plugins start a moment after the change is saved.
    const until = Date.now() + (deps.appearMs ?? 20_000);
    while (host.state === "absent" && Date.now() < until) {
      await sleep(Math.min(250, deps.pollMs ?? 250));
      host = hostSpeechStatus(hostSpeech(deps.ctx));
    }
    if (host.state === "absent") {
      return { ok: true, summary: `「语音输入」已经打开，但语音识别服务还没起来。过一会儿让用户再说一次「${VOICE_SETUP_PHRASE}」，或者自己到 DSH 网页的「插件」→「语音输入」里点「下载并准备」。` };
    }
  }

  if (host.state === "ready") {
    return { ok: true, summary: "已经打开，模型以前就下载过，语音识别现在就能用。让用户发一条语音试试。" };
  }
  if (host.state === "unprepared" || host.state === "failed") {
    const speech = hostSpeech(deps.ctx);
    if (speech === undefined || typeof speech.prepare !== "function") {
      return { ok: true, summary: "「语音输入」已经打开，但模型要用户自己点一下才会下载：在电脑的 DSH 网页里点「插件」→「语音输入」→「下载并准备」。" };
    }
    try {
      speech.prepare(host.providerId);
    } catch (err) {
      const detail = String((err as Error).message ?? err).slice(0, 160);
      logger.warn(`voice-setup: could not start the model's download (${detail})`);
      return { ok: false, summary: `「语音输入」已经打开，但模型的下载没能开始（${detail}）。请用户在电脑的 DSH 网页里点「插件」→「语音输入」→「下载并准备」。` };
    }
    logger.info(`voice-setup: started the download of DSH's ${host.name}`);
  }
  watchPreparation(deps);
  return { ok: true, summary: "已经打开，语音识别模型正在下载（约 240 MB）。下载好了会有一条消息告诉用户；在那之前发的语音我还听不了。告诉用户这两点，不要说已经能听语音了。" };
}

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ok: { type: "boolean", required: true }, summary: { type: "string", required: true } },
} as const;

/** Register `enable_voice_input` on the WeChat agent. */
export function registerVoiceSetupTools(agentCtx: Context, deps: VoiceSetupDeps): void {
  agentCtx.tools.register(
    defineTool({
      name: VOICE_TOOL,
      description:
        "Make voice messages work on this computer by switching on DSH's own speech recognition (语音输入) for the owner and "
        + "downloading its model. Use it when the owner says 打开语音输入, asks you to be able to hear voice messages, "
        + "or reaches the voice item of the first-time setup. Call it straight away: the tool itself sends the owner a "
        + "fixed question that says exactly what will change (a DSH plugin goes on, about 240 MB is downloaded, audio stays "
        + "on the computer) and waits for their answer, so do NOT ask for permission first and do NOT describe it yourself "
        + "beforehand — that would ask them twice. Nothing is changed unless they answer with a plain yes. Afterwards tell "
        + "them what the result says, no more: when the model is still downloading, voice does not work yet, and a "
        + "separate message will tell them when it does.",
      parameters: {},
      output: { schema: SUMMARY_SCHEMA, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(_args, exec) {
        try {
          return await enableVoiceInput(deps, (exec as { signal?: AbortSignal } | undefined)?.signal);
        } catch (err) {
          logger.warn(`voice-setup: failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
          return { ok: false, summary: `没有弄成（${String((err as Error).message ?? err).slice(0, 120)}）。请用户自己来：${VOICE_BY_HAND}。` };
        }
      },
    }),
  );
}

/**
 * One line in the log at start: what a voice message without WeChat's text
 * would be transcribed with, and whether the bot could switch DSH's speech
 * recognition on. The first thing to read when voice does not work.
 */
export async function logVoiceSetup(deps: Pick<VoiceSetupDeps, "ctx" | "config" | "macReady">): Promise<void> {
  try {
    const status = await voiceStatus(deps);
    const manager = service<PluginManagerLike>(deps.ctx, "pluginManager");
    const can = manager !== undefined && typeof manager.setBundleEnabled === "function";
    const host = status.host.state === "absent" ? "not switched on" : `${status.host.name} ${status.host.phase}`;
    logger.info(
      `voice: without WeChat's transcript -> ${status.engine === "dsh" ? "DSH's speech recognition" : status.engine === "mac" ? "this Mac's own models" : "nothing can transcribe"}`
      + ` (DSH 语音输入: ${host}; this Mac: ${status.mac}; the bot ${can ? "can" : "cannot"} switch 语音输入 on)`,
    );
  } catch (err) {
    logger.warn(`voice: could not read the voice setup: ${String((err as Error).message ?? err).slice(0, 160)}`);
  }
}

/** Tests start each case with no watcher left over. */
export function resetVoiceSetupForTests(): void {
  watching = false;
  macCache = null;
}
