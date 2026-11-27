/**
 * The first-time setup guide.
 *
 * A few things make the bot much more useful and none of them can be done
 * from the phone: they are switches on the computer (DSH's web page, macOS
 * settings). Someone who has just paired the bot does not know they exist. So
 * the first time the owner writes, after the bot has answered them, they get
 * one message listing what is still worth setting up, and from there the bot
 * walks them through it one item at a time: `setup_guide` tells it where each
 * item really stands on this machine and how it is done, so "done" is checked
 * and not taken on trust.
 *
 * WeChat does not let a bot write first, which is why the list follows the
 * owner's first message instead of the pairing itself.
 *
 * Someone already using the bot when this arrived is not walked through
 * anything unasked (`legacy`); the tool still answers when they ask.
 * State: `<state>/onboarding.json`.
 */
import fs from "node:fs";
import path from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

import type { ClawbotConfig } from "./config.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";
import { permissionStatus } from "./permissions.js";
import { describeVoice, voiceStatus, VOICE_BY_HAND, VOICE_TOOL, type VoiceSetupDeps } from "./voice-setup.js";

export const SETUP_TOOL = "setup_guide";

export type SetupItem = "voice" | "files" | "model" | "names";
const ORDER: readonly SetupItem[] = ["voice", "files", "model", "names"];
type Mark = "done" | "skipped";

export type SetupState = {
  v: 1;
  /** When this file was first written. */
  since: string;
  /** Already using the bot when the guide arrived: never walked through it unasked. */
  legacy?: true;
  /** When the list was sent. */
  intro?: string;
  /** The owner said "later": quiet until they ask. */
  later?: string;
  items: Partial<Record<SetupItem, Mark>>;
};

export type SetupLine = {
  key: SetupItem;
  title: string;
  /** Why it is worth doing, as the list says it. */
  why: string;
  state: "done" | "skipped" | "todo";
  /** Where it stands on this machine. */
  detail: string;
  /** How it is done, for the bot to pass on. */
  how: string;
};

export type OnboardingDeps = {
  voice: Pick<VoiceSetupDeps, "ctx" | "config" | "macReady">;
  config: Pick<ClawbotConfig, "provider" | "model">;
  getAccount: () => ResolvedWeixinAccount | null;
  activeSender: () => string | undefined;
  /** Send the list to the owner and put a copy in the conversation. */
  tellOwner: (text: string) => Promise<void>;
  /** Tests stand in for the machine. */
  file?: string;
  platform?: NodeJS.Platform;
  permissions?: () => Promise<Record<string, unknown>>;
  usedBefore?: () => boolean;
};

/** Signs that the bot was already in use before this file existed. */
function usedBefore(): boolean {
  const state = resolveStateDir();
  try {
    if (fs.existsSync(path.join(state, "inbound-raw.jsonl"))) return true;
    return fs.readdirSync(path.join(state, "accounts")).some((name) => name.endsWith(".context-tokens.json"));
  } catch {
    return false;
  }
}

export class Onboarding {
  private readonly file: string;
  private sending = false;

  constructor(private readonly deps: OnboardingDeps) {
    this.file = deps.file ?? path.join(resolveStateDir(), "onboarding.json");
  }

  /**
   * Read the state, writing it the first time. Called when the listener
   * starts, before any message: that is the moment that tells a new pairing
   * from someone already using the bot.
   */
  state(): SetupState {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && (parsed as SetupState).v === 1) {
        const state = parsed as SetupState;
        return { ...state, items: state.items ?? {} };
      }
    } catch {
      // first time, or unreadable: start over below
    }
    const fresh: SetupState = {
      v: 1,
      since: new Date().toISOString(),
      ...((this.deps.usedBefore ?? usedBefore)() ? { legacy: true as const } : {}),
      items: {},
    };
    this.save(fresh);
    return fresh;
  }

  private save(state: SetupState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      logger.warn(`setup: could not save ${this.file}: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }

  /** Every item that applies to this machine, with where it really stands. */
  async lines(state: SetupState = this.state()): Promise<SetupLine[]> {
    const platform = this.deps.platform ?? process.platform;
    const where = "在电脑的 DSH 网页里点左边的「插件」→ wechat-clawbot，展开「微信 Bot」卡片";
    const out: SetupLine[] = [];
    const push = (key: SetupItem, title: string, why: string, done: boolean, detail: string, how: string): void => {
      out.push({ key, title, why, state: done ? "done" : state.items[key] === "skipped" ? "skipped" : "todo", detail, how });
    };

    const voice = await voiceStatus(this.deps.voice);
    push(
      "voice", "语音", "让我能听懂你发的语音", voice.engine !== null, describeVoice(voice),
      `调用 ${VOICE_TOOL}（它会自己向用户说明要改什么、等用户回「好」，你不用先问）。用户想自己弄：${VOICE_BY_HAND}。`,
    );

    if (platform === "darwin") {
      let granted = false;
      let detail = "还没开「完全磁盘访问权限」。";
      let name = "启动 DSH 的那个程序";
      try {
        const status = await (this.deps.permissions ?? (() => permissionStatus()))();
        granted = status.fullDisk === "granted";
        const launcher = status.launcher as { kind?: string; name?: string; localName?: string } | undefined;
        if (launcher !== undefined && launcher.kind !== "unknown" && typeof launcher.name === "string") name = `「${launcher.localName ?? launcher.name}」`;
        if (granted) detail = `${name}已经有「完全磁盘访问权限」。`;
        else if (status.fullDisk !== "denied") detail = "查不出「完全磁盘访问权限」开了没有，卡片上「电脑权限」那一行写着。";
      } catch (err) {
        detail = `没查成（${String((err as Error).message ?? err).slice(0, 80)}）。`;
      }
      push(
        "files", "文件权限", "让我能读这台电脑上的文件", granted, detail,
        `${where}，在「电脑权限」那一行点「打开设置」，在「完全磁盘访问权限」的列表里把${name}的开关打开（要输电脑密码或按指纹）。`
        + "不开也能用，只是我读「下载」「桌面」「文稿」这些文件夹时，电脑会一次次弹窗要人点允许，没人点我就一直等。",
      );
    }

    const pinned = Boolean(this.deps.config.provider && this.deps.config.model);
    push(
      "model", "固定模型", "免得你在网页里换模型时把我也换了", pinned,
      pinned ? `已经固定用 ${this.deps.config.provider}/${this.deps.config.model}。` : "还没固定：现在跟着网页当前的模型走。",
      `${where}，在「模型」那里给我选一个固定的模型。不选的话，用户在网页里换模型，我也跟着换。`,
    );

    push(
      "names", "称呼", "告诉我怎么叫你、你想叫我什么", state.items.names === "done",
      state.items.names === "done" ? "已经问过了。" : "还没问。",
      `这一项就在微信里做：问用户希望你怎么称呼他、想给你起什么名字，用 remember_user_info 记下来，然后调用 ${SETUP_TOOL}（item 填 names，set 填 done）。`,
    );
    return ORDER.flatMap((key) => out.filter((line) => line.key === key));
  }

  /** The first message of the guide; null when nothing is left to set up. */
  static intro(lines: readonly SetupLine[]): string | null {
    const todo = lines.filter((line) => line.state === "todo");
    if (todo.length === 0) return null;
    if (todo.length === 1) {
      return `第一次用，有一件事建议设置一下：${todo[0]!.title}，${todo[0]!.why}。回「开始」我带你做；回「以后再说」我就先不提了。`;
    }
    return [
      `第一次用，有 ${todo.length} 件事建议花几分钟设置一下。我一件一件带你做，随时可以说「跳过」：`,
      ...todo.map((line, index) => `${index + 1}. ${line.title}：${line.why}`),
      "回「开始」就从第 1 件来；回「以后再说」我就先不提了。",
    ].join("\n");
  }

  /**
   * After the bot has answered: the first time that happens for a new owner,
   * send the list. Once, and never to someone who was already using the bot.
   */
  async afterReply(sender: string): Promise<void> {
    if (this.sending) return;
    const owner = this.deps.getAccount()?.userId;
    if (owner === undefined || owner === "" || sender !== owner) return;
    const state = this.state();
    if (state.legacy === true || state.intro !== undefined || state.later !== undefined) return;
    this.sending = true;
    try {
      const text = Onboarding.intro(await this.lines(state));
      if (text !== null) {
        await this.deps.tellOwner(text);
        logger.info("setup: sent the first-time checklist");
      }
      this.save({ ...this.state(), intro: new Date().toISOString() });
    } catch (err) {
      // Not sent: it goes out after the next reply.
      logger.warn(`setup: the first-time checklist was not sent: ${String((err as Error).message ?? err).slice(0, 160)}`);
    } finally {
      this.sending = false;
    }
  }

  /** What `setup_guide` answers: the list as it stands, after applying a mark. */
  async guide(item: string, set: string): Promise<string> {
    let state = this.state();
    const notes: string[] = [];
    const key = (ORDER as readonly string[]).includes(item) ? (item as SetupItem) : undefined;
    if (set === "later") {
      state = { ...state, later: new Date().toISOString() };
      this.save(state);
      notes.push("已记下「以后再说」：不再主动提这份清单。用户哪天想弄，说一声就行。告诉用户这一点，然后不要再提。");
    } else if (set === "skip" && key !== undefined) {
      state = { ...state, items: { ...state.items, [key]: "skipped" } };
      this.save(state);
      notes.push("已记下跳过这一项。");
    } else if (set === "done" && key === "names") {
      state = { ...state, items: { ...state.items, names: "done" } };
      this.save(state);
    } else if (set === "done" && key !== undefined) {
      notes.push("这一项做没做好以电脑上实际的状态为准，下面是刚查到的。");
    }
    const lines = await this.lines(state);
    const mark = { done: "✅", skipped: "⏭", todo: "⬜" } as const;
    const done = lines.filter((line) => line.state === "done").length;
    const next = lines.find((line) => line.state === "todo");
    const body = lines.map((line) => {
      const head = `${mark[line.state]} ${line.title}：${line.state === "skipped" ? "用户说跳过。" : ""}${line.detail}`;
      return line.state === "todo" ? `${head}\n   怎么做：${line.how}` : head;
    });
    return [
      ...notes,
      `新手清单（${lines.length} 项，${done} 项已经好了）：`,
      ...body,
      next === undefined
        ? "没有待办的了。告诉用户都弄好了；日历和闹钟、Claude Code 联动这些可选功能，以后想要随时说。"
        : `下一项：${next.title}。`,
      ...(set === "later" || next === undefined ? [] : [
        "规矩：一次只讲一项，用自己的话把上面「怎么做」讲清楚；用户说做好了，就再调用一次本工具核对，核对过了再讲下一项；"
        + "用户说跳过，item 填那一项、set 填 skip；用户说以后再说或不想弄了，set 填 later。已经好了的项不用提。",
      ]),
    ].join("\n");
  }
}

const TEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { summary: { type: "string", required: true } },
} as const;

/** Register `setup_guide` on the WeChat agent. */
export function registerSetupGuideTool(agentCtx: Context, onboarding: Onboarding, deps: Pick<OnboardingDeps, "getAccount" | "activeSender">): void {
  agentCtx.tools.register(
    defineTool({
      name: SETUP_TOOL,
      description:
        "The first-time setup checklist for this bot: what is worth setting up on the owner's computer (hearing voice "
        + "messages, file access, a fixed model, names), where each item really stands right now, and how each is done. "
        + "A new owner is sent the list once (a message that starts 第一次用). Call this when they answer it with 开始, "
        + "when they say an item is done (it re-checks the computer; never take done on trust), when they want to skip an "
        + "item or stop, and whenever anyone asks what can be set up or why something (voice, reading files) does not "
        + "work. Lead them through one item at a time, in your own words, from what the result says.",
      parameters: {
        item: {
          type: "string",
          enum: ["", "voice", "files", "model", "names"],
          description: "The item `set` applies to. Leave empty just to see the list.",
        },
        set: {
          type: "string",
          enum: ["", "done", "skip", "later"],
          description:
            "Leave empty just to see the list. skip: the owner wants to skip `item`. later: the owner does not want the "
            + "guide now (it stops being brought up). done: only for names, after their answers are remembered; the other "
            + "items are checked on the computer instead.",
        },
      },
      output: { schema: TEXT_SCHEMA, render: (_args, value) => [{ type: "text", text: value.summary }] },
      async execute(args) {
        const owner = deps.getAccount()?.userId;
        const sender = deps.activeSender();
        if (owner !== undefined && sender !== undefined && sender !== owner) {
          return { summary: "这份清单是机主电脑上的设置，只有机主能看和改。" };
        }
        const raw = args as { item?: unknown; set?: unknown };
        const text = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
        try {
          return { summary: await onboarding.guide(text(raw.item), text(raw.set)) };
        } catch (err) {
          logger.warn(`setup: guide failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
          return { summary: `清单没读出来（${String((err as Error).message ?? err).slice(0, 120)}）。` };
        }
      },
    }),
  );
}
