/**
 * Inbound WeChat message handling: allowlist check, pending-interaction
 * resolution, text/quote extraction, media download, and routing into the
 * DSH session. Quoted messages (微信"引用") are unpacked so the agent sees
 * what the user is referencing.
 */
import fs from "node:fs";
import path from "node:path";

import type { MessageItem, WeixinMessage } from "./ilink/api/types.js";
import { MessageItemType } from "./ilink/api/types.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { downloadMediaFromItem } from "./inbound-media.js";
import { lookupQuoteMessage, recordQuoteMessage } from "./quote-history.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import type { ClawbotConfig } from "./config.js";
import type { WechatBridge } from "./bridge.js";
import { PendingRegistry } from "./pending.js";
import { loadContextToken, saveContextToken } from "./state.js";
import { logger } from "./ilink/util/logger.js";

function isMediaItem(item: MessageItem | undefined): boolean {
  return (
    !!item &&
    (item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.VIDEO ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VOICE)
  );
}

/**
 * Rebuild the message body, unpacking quoted context (微信"引用").
 * Ported from @tencent-weixin/openclaw-weixin (MIT) bodyFromItemList:
 * a quoted message becomes `[引用: <title | quoted text>]\n<current text>`.
 */
function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed separately (downloaded as media); only the
      // current text goes into the body here.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音消息：微信服务端自带转文字（voice_item.text），直接使用。
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  return "";
}

/** Raw plain text of an inbound message, WITHOUT quote context (for approval matching). */
function extractPlainText(msg: WeixinMessage): string | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT) {
      const text = item.text_item?.text?.trim();
      if (text) return text;
    }
  }
  return null;
}

/** WeChat's own transcript of a voice message, if the message is one. */
function extractVoiceText(msg: WeixinMessage): string | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.VOICE) {
      const text = item.voice_item?.text?.trim();
      if (text) return text;
    }
  }
  return null;
}

/** True when the message carries any item that is not plain text. */
export function hasNonTextItem(msg: WeixinMessage): boolean {
  return (msg.item_list ?? []).some((item) => item.type !== MessageItemType.TEXT);
}

/**
 * Resolve the quoted (引用) content of an inbound message. The wire only
 * carries the quoted message's id and creation time; the content comes from
 * the local quote-history registry, with a timestamp fallback over the
 * session log for messages that predate the registry (e.g. before restart).
 */
function buildQuotePrefix(msg: WeixinMessage, bridge: WechatBridge): string {
  for (const item of msg.item_list ?? []) {
    const ref = item.ref_msg;
    if (!ref) continue;
    const refMsgId = ref.message_item?.msg_id;
    if (refMsgId !== undefined) {
      const hit = lookupQuoteMessage(String(refMsgId));
      if (hit) {
        if (hit.imagePath) return `[引用: 用户引用了一张图片，已保存到 ${hit.imagePath}]`;
        if (hit.text) return `[引用: ${hit.text}]`;
      }
    }
    // Timestamp fallback: quoted messages older than the registry.
    const byTime = bridge.lookupQuoteByTime(ref.message_item?.create_time_ms);
    if (byTime) {
      if (byTime.imagePath) return `[引用: 用户引用了一张图片，已保存到 ${byTime.imagePath}]`;
      if (byTime.text) return `[引用: ${byTime.text}]`;
    }
    return "[引用: 用户引用了一条之前的消息，但引用内容未能获取]";
  }
  return "";
}

export class InboundRouter {
  private readonly config: ClawbotConfig;
  private readonly account: ResolvedWeixinAccount;
  private readonly bridge: WechatBridge;
  private readonly pending: PendingRegistry;
  private readonly sendText: (to: string, text: string) => Promise<void>;

  constructor(deps: {
    config: ClawbotConfig;
    account: ResolvedWeixinAccount;
    bridge: WechatBridge;
    pending: PendingRegistry;
    sendText: (to: string, text: string) => Promise<void>;
  }) {
    this.config = deps.config;
    this.account = deps.account;
    this.bridge = deps.bridge;
    this.pending = deps.pending;
    this.sendText = deps.sendText;
  }

  /** Whether a sender may talk to the agent. */
  isAllowed(sender: string): boolean {
    if (this.config.allowFrom.length > 0) {
      return this.config.allowFrom.includes(sender);
    }
    // No explicit allowlist: only the user who scanned the QR code.
    return this.account.userId === sender;
  }

  /** Handle one inbound message from the monitor. */
  async handle(msg: WeixinMessage): Promise<void> {
    // Debug: record the raw item structure (types + ref fields) to a file so
    // quote handling can be diagnosed without access to the GUI terminal.
    // Rotates at 5MB, keeping 3 old files, to bound disk use and privacy.
    try {
      const rawPath = path.join(resolveStateDir(), "inbound-raw.jsonl");
      try {
        const st = fs.statSync(rawPath);
        if (st.size > 5 * 1024 * 1024) {
          fs.renameSync(rawPath, `${rawPath}.1`);
          for (let i = 2; i >= 1; i--) {
            const older = `${rawPath}.${i + 1}`;
            const newer = `${rawPath}.${i}`;
            if (fs.existsSync(older)) fs.renameSync(older, newer);
          }
          const drop = `${rawPath}.4`;
          if (fs.existsSync(drop)) fs.unlinkSync(drop);
        }
      } catch {
        // fresh file / stat race: proceed
      }
      fs.appendFileSync(
        rawPath,
        JSON.stringify({
          t: Date.now(),
          seq: msg.seq,
          msgType: msg.message_type,
          msgId: msg.message_id,
          clientId: msg.client_id,
          items: (msg.item_list ?? []).map((i) => ({
            type: i.type,
            text: i.text_item?.text ?? null,
            hasRef: !!i.ref_msg,
            ref: i.ref_msg ?? null,
          })),
        }) + "\n",
      );
    } catch {
      // ignore logging failures
    }

    const sender = msg.from_user_id?.trim();
    if (!sender) {
      logger.debug("inbound: message without from_user_id ignored");
      return;
    }
    logger.info(`inbound: from=${sender} seq=${msg.seq ?? "?"} msgId=${msg.message_id ?? "?"}`);

    // Remember the context token so replies stay in the same WeChat thread.
    if (msg.context_token) {
      saveContextToken(this.account.accountId, sender, msg.context_token);
    }

    if (!this.isAllowed(sender)) {
      logger.warn(`inbound: sender ${sender} is not allowed; ignored`);
      return;
    }

    const plainText = extractPlainText(msg);
    const body = bodyFromItemList(msg.item_list);
    const quotePrefix = buildQuotePrefix(msg, this.bridge);

    // A pending approval/question for this sender wins over a new turn.
    // A voice reply answers it too (WeChat transcribes voice itself). A reply
    // with no text at all — a photo, a file — answers nothing: the question is
    // withdrawn as unanswered and the message goes on to the agent like any
    // other, instead of being used up and thrown away.
    const pending = this.pending.popFor(sender);
    if (pending) {
      const answer = plainText ?? extractVoiceText(msg);
      if (answer !== null) {
        pending.resolve(answer);
        return;
      }
      pending.resolve(null);
    }

    // Download inbound images/files (decrypt + persist), so the agent can
    // inspect them (e.g. with the dsh-vision tools). Also downloads media
    // the user QUOTED (引用) inside a text reply.
    let mediaNote = "";
    let firstImagePath: string | undefined;
    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.IMAGE || item.type === MessageItemType.FILE) {
        const media = await downloadMediaFromItem(item, {
          cdnBaseUrl: this.account.cdnBaseUrl,
          label: "inbound",
        });
        if (media.imagePath) {
          firstImagePath ??= media.imagePath;
          mediaNote +=
            // 图片本身会被 bridge 附到这条消息上(路由支持图片输入时)。路径仍然
            // 保留:他可能让你把同一张图发回去,而且路由万一不支持图片时,视觉
            // 工具还得靠这个路径。措辞对两种情况都成立,不需要按模型分叉。
            `\n（用户发送了一张图片，已保存到 ${media.imagePath}。）`;
        }
        if (media.filePath) {
          mediaNote += `\n（用户发送了一个文件，已保存到 ${media.filePath}。请查看内容并回应。）`;
        }
      }
    }

    // Quoted media: user quoted an image/file message and added text.
    const refMediaItem = msg.item_list?.find(
      (i) =>
        i.type === MessageItemType.TEXT &&
        i.ref_msg?.message_item &&
        isMediaItem(i.ref_msg.message_item),
    )?.ref_msg?.message_item;
    if (refMediaItem) {
      const media = await downloadMediaFromItem(refMediaItem, {
        cdnBaseUrl: this.account.cdnBaseUrl,
        label: "ref",
      });
      if (media.imagePath) {
        mediaNote +=
          `\n（用户引用的图片已保存到 ${media.imagePath}。）`;
      }
      if (media.filePath) {
        mediaNote += `\n（用户引用的文件已保存到 ${media.filePath}。请查看内容并回应。）`;
      }
    }

    if (!body && !mediaNote) {
      if (hasNonTextItem(msg)) {
        await this.sendText(
          sender,
          "[DSH] 收到视频消息，暂不支持处理。",
        ).catch(() => {});
      }
      return;
    }

    // Record this inbound message so future quotes of it can be resolved.
    if (msg.message_id !== undefined) {
      recordQuoteMessage({
        msgId: String(msg.message_id),
        text: plainText ?? (firstImagePath ? "（图片）" : ""),
        imagePath: firstImagePath,
        time: Date.now(),
      });
    }

    // Route into the shared WeChat session (fire-and-forget: the reply is
    // streamed back by the bridge when the turn completes).
    const content = [quotePrefix, body, mediaNote].filter(Boolean).join("\n");
    // firstImagePath 让 bridge 能把图片本身附上,而不只是给一个路径。
    await this.bridge.enqueueMessage(sender, content, firstImagePath);
  }

  /** Context token for an outbound message to a sender ("" when unknown). */
  contextTokenFor(sender: string): string {
    return loadContextToken(this.account.accountId, sender);
  }
}
