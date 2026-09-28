/**
 * Outbound text sending for the vendored iLink protocol layer.
 *
 * Adapted from `@tencent-weixin/openclaw-weixin` (MIT) `src/messaging/send.ts`:
 * the OpenClaw reply-runtime types and media upload paths are removed — v1 of
 * the DSH plugin sends plain text messages only. Media support lands in v2.
 */
import { sendMessage as sendMessageApi } from "../api/api.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";
import { generateId } from "../util/random.js";
import type { MessageItem, SendMessageReq } from "../api/types.js";
import type { UploadedFileInfo } from "../cdn/upload.js";
import { recordQuoteMessage } from "../../quote-history.js";
import { MessageItemType, MessageState, MessageType } from "../api/types.js";

export type WeixinMessageSendOptions = WeixinApiOptions & {
  contextToken?: string;
  runId?: string;
};

function generateClientId(): string {
  return generateId("dsh-clawbot");
}

/** Build a SendMessageReq containing a single text message. */
export function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, runId, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
      run_id: runId ?? undefined,
    },
  };
}

/**
 * Send a plain text message downstream.
 * @returns the generated client message id.
 */
export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  if (!opts.contextToken) {
    // Sync from openclaw-weixin 3.1.1 (upstream #247): sending without a
    // context token can be silently dropped by the server, so fail fast
    // with a clear error instead of returning a fake success.
    throw new Error(
      "sendMessageWeixin: contextToken missing — refusing to send to avoid silent-drop",
    );
  }
  const clientId = generateClientId();
  const req = buildTextMessageReq({
    to,
    text,
    contextToken: opts.contextToken,
    runId: opts.runId,
    clientId,
  });
  try {
    const { messageId } = await sendMessageApi({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      body: req,
    });
    if (messageId !== undefined) {
      recordQuoteMessage({
        msgId: String(messageId),
        text,
        time: Date.now(),
      });
    }
  } catch (err) {
    logger.error(`sendMessageWeixin: failed to=${to} clientId=${clientId} err=${String(err)}`);
    throw err;
  }
  return { messageId: clientId };
}

/**
 * Send one or more MessageItems (optionally preceded by a text caption).
 * Each item is sent as its own request so item_list always has exactly one
 * entry. Ported from @tencent-weixin/openclaw-weixin (MIT).
 */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinMessageSendOptions;
  label: string;
}): Promise<{ messageId: string }> {
  const { to, text, mediaItem, opts, label } = params;
  const runId = opts.runId;

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  if (!opts.contextToken) {
    throw new Error(
      `${label}: contextToken missing — refusing to send to avoid silent-drop`,
    );
  }
  let lastClientId = "";
  for (const item of items) {
    lastClientId = generateClientId();
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: opts.contextToken ?? undefined,
        run_id: runId,
      },
    };
    try {
      await sendMessageApi({
        baseUrl: opts.baseUrl,
        token: opts.token,
        timeoutMs: opts.timeoutMs,
        body: req,
      });
    } catch (err) {
      logger.error(`${label}: failed to=${to} clientId=${lastClientId} err=${String(err)}`);
      throw err;
    }
  }

  logger.info(`${label}: success to=${to} clientId=${lastClientId}`);
  return { messageId: lastClientId };
}

/** Send an image message downstream using a previously uploaded file. */
export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendImageMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  logger.info(
    `sendImageMessageWeixin: to=${to} filekey=${uploaded.filekey} fileSize=${uploaded.fileSize} aeskey=present`,
  );

  const imageItem: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: imageItem, opts, label: "sendImageMessageWeixin" });
}

/** Send a video message downstream using a previously uploaded file. */
export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendVideoMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }

  const videoItem: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      video_size: uploaded.fileSizeCiphertext,
    },
  };

  return sendMediaItems({ to, text, mediaItem: videoItem, opts, label: "sendVideoMessageWeixin" });
}

/** Send a file attachment downstream using a previously uploaded file. */
export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinMessageSendOptions;
}): Promise<{ messageId: string }> {
  const { to, text, fileName, uploaded, opts } = params;
  if (!opts.contextToken) {
    logger.warn(`sendFileMessageWeixin: contextToken missing for to=${to}, sending without context`);
  }
  const fileItem: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
        encrypt_type: 1,
      },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };

  return sendMediaItems({ to, text, mediaItem: fileItem, opts, label: "sendFileMessageWeixin" });
}
