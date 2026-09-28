/**
 * `send_wechat_file` tool: lets the WeChat agent deliver a local file (image,
 * PDF, document, archive, …) to the user's WeChat conversation.
 *
 * Registered agent-scoped (only the WeChat session sees it) from the bridge's
 * setup hook. Media travels through the vendored iLink CDN upload pipeline
 * (AES-128-ECB encrypted), the same path the official OpenClaw WeChat channel
 * uses.
 */
import fs from "node:fs";
import path from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { ImageBlock } from "@deepseek-ai/dsh-llm/types";

import type { ClawbotConfig } from "./config.js";
import type { WechatBridge } from "./bridge.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import { sendWeixinMediaFile } from "./ilink/messaging/send-media.js";
import { compressForUpload, makePreviewCopy } from "./image-compress.js";
import { getMimeFromFilename } from "./ilink/media/mime.js";
import { stripEmoji, stripWechatCodes } from "./emoji.js";

import { appendMemoryEntry, oneOffReminderReason } from "./memory.js";
import { logger } from "./ilink/util/logger.js";

export type SendFileToolDeps = {
  /** The live bridge (sender routing), or null while the monitor is down. */
  getBridge: () => WechatBridge | null;
  /** The bound account (API credentials), or null before first login. */
  getAccount: () => ResolvedWeixinAccount | null;
  config: ClawbotConfig;
};

/**
 * Payload sizes above which the WeChat C2C CDN refuses an upload.
 *
 * **Measured brackets, not published limits.** The limit is documented nowhere:
 * not in the iLink protocol docs, not in any community SDK — several of which
 * simply retry a 500 three times, exactly as this one used to. The CDN never
 * says "too large"; it answers an opaque HTTP 500.
 *
 * And the ceiling depends on which upload the media type selects
 * (`sendWeixinMediaFile` branches on `mime.startsWith("image/")`). They are not
 * close to each other:
 *
 * | path  | works              | fails                          |
 * |-------|--------------------|--------------------------------|
 * | IMAGE | 2.26MB (prod log)  | 4.1MB (prod log)               |
 * | FILE  | 0.5MB  (2 of 2)    | 1.0MB (2 of 2), 2/4/6/7.2/18MB |
 *
 * The FILE path gives up around 3× lower, which is why photos mostly get
 * through while a 7MB archive never does. 1MB is reproducibly rejected, so the
 * file guard sits there.
 *
 * Uploads are also just slow — 0.5MB took 61s and 79s, roughly 6-10 KB/s — and
 * failures arrive anywhere from 18s to 137s. A fast 500 on a big payload looks
 * like a size check, a slow one like a server-side timeout; both are probably
 * in play. Either way the verdict is the same, and reaching it costs a minute
 * per attempt, three attempts deep.
 *
 * Related when photos fail: `compressThresholdBytes` is what the image ladder
 * compresses *down to*, so it has to stay UNDER the IMAGE figure or the ladder
 * stops while the file is still too big to send.
 */
const CDN_REJECT_ABOVE_IMAGE_BYTES = 3 * 1024 * 1024;
const CDN_REJECT_ABOVE_FILE_BYTES = 1024 * 1024;

/**
 * Register `look_at_image` — hand a local image straight to the model.
 *
 * This replaces `preview_wechat_image`, which only returned a *path*: the model
 * then had to call qwen's `vision_read` on that path, a second round trip that
 * cost roughly 40s per photo. Here the bytes are downscaled and committed
 * through the attachment service — literally the same `bridge.attachImage()`
 * call an inbound WeChat photo takes — and the picture itself comes back as an
 * image block, so the model simply sees it on the next request. No vision
 * model, no extra tool call.
 *
 * The old path-only behaviour survives as a fallback, because the model picker
 * can point this session at a text-only model at any time: on such a route the
 * tool still returns a downscaled copy's path and says to use a vision tool on
 * it. Same tool name, same call site in the prompt, either way.
 *
 * Precedent for returning an image from a tool: `read_image` in
 * @deepseek-ai/dsh-tool-fs. The image rides `output.render`, not the return
 * value — render is what projects the stored value into model content, so it
 * also works when the session is replayed.
 */
function registerLookAtImageTool(agentCtx: Context, deps: SendFileToolDeps): void {
  agentCtx.tools.register(
    defineTool({
      name: "look_at_image",
      description:
        "Look at a local image yourself. Downscales it and returns the picture itself, so you see it directly in your next step — do NOT call a vision tool afterwards. " +
        "Use this before sending any image you have not already seen this turn, and to inspect any image on disk. " +
        "The original file is never modified. If the current model cannot accept images, this returns a downscaled copy's path instead and says so.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Path of the local image to look at (absolute or relative).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            mode: { type: "string", enum: ["image", "path"], required: true },
            path: { type: "string", required: true },
            message: { type: "string", required: true },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: {
                  type: "string",
                  enum: ["image/png", "image/jpeg", "image/webp", "image/gif"],
                  required: true,
                },
                bytes: { type: "integer", required: true },
                width: { type: "integer", required: true },
                height: { type: "integer", required: true },
                name: { type: "string" },
                // Added by dsh-attachment 0.1.1-rc.2, which normalizes
                // orientation and downscales oversized images and records what
                // it came from. Declared because `additionalProperties: false`
                // would otherwise REJECT the whole tool result the first time a
                // real photo got downscaled.
                originalDimensions: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    width: { type: "integer", required: true },
                    height: { type: "integer", required: true },
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.ok !== true) return [{ type: "text", text: `看图失败: ${value.message}` }];
          if (value.mode === "image" && value.image !== undefined) {
            return [
              {
                type: "text",
                text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${value.image.mediaType} ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes — 图片本身就在下面,直接看\n</content>`,
              },
              { type: "image", attachment: value.image as unknown as ImageBlock["attachment"] },
            ];
          }
          return [{
            type: "text",
            text: `缩小副本: ${value.path}\n(${value.message})`,
          }];
        },
      },
      async execute(args) {
        const { path: rawPath } = args as { path: string };
        const resolved = path.isAbsolute(rawPath)
          ? path.normalize(rawPath)
          : path.resolve(deps.config.cwd ?? process.cwd(), rawPath);

        // Preferred path: the route takes images, so commit the bytes and let
        // the model look for itself.
        const bridge = deps.getBridge();
        if (bridge !== null && await bridge.routeTakesImages()) {
          const ref = await bridge.attachImage(resolved, "look_at_image");
          if (ref !== null) {
            // Pick the declared fields rather than passing the ref through.
            // The store owns this shape and grows it between releases —
            // `originalDimensions` arrived in 0.1.1-rc.2 — and with
            // `additionalProperties: false` an undeclared field fails the whole
            // call. Picking means a future addition is merely ignored.
            const image = {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
              ...(ref.originalDimensions === undefined
                ? {}
                : { originalDimensions: ref.originalDimensions }),
            };
            return { ok: true, mode: "image" as const, path: resolved, image, message: "图片已附在结果里" };
          }
          logger.warn(`look_at_image: 附图没成功,退回给路径 ${resolved}`);
        }

        // Fallback: text-only route (or the attach failed). Hand back a small
        // copy plus an explicit instruction, so the turn still completes.
        try {
          const preview = makePreviewCopy(resolved, {
            maxImageEdge: deps.config.maxImageEdge,
            imageQuality: deps.config.imageQuality,
            compressThresholdBytes: deps.config.compressThresholdBytes,
          });
          return {
            ok: true,
            mode: "path" as const,
            path: preview,
            message: "当前模型不能直接看图,请对这个路径调用 vision_read 查看",
          };
        } catch (err) {
          return {
            ok: false,
            mode: "path" as const,
            path: resolved,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  );
}

/** Register the tool into one agent's scoped world (call from setup). */
export function registerSendFileTool(agentCtx: Context, deps: SendFileToolDeps): void {
  registerLookAtImageTool(agentCtx, deps);
  registerMemoryTool(agentCtx);
  registerSendTextTool(agentCtx, deps);
  registerWechatAskTool(agentCtx, deps);
  agentCtx.tools.register(
    defineTool({
      name: "send_wechat_file",
      description:
        "Send a local file (image, PDF, document, spreadsheet, archive, ...) from this computer to the user's WeChat conversation. " +
        "Use this when the user asks you to send them a file or image, or when you produced/edited a file they want delivered. " +
        "This is the ONLY supported way to deliver files over WeChat: never write your own scripts, never read or import plugin source, and never call the WeChat/iLink API directly. " +
        "The file must exist on this computer; the user receives it in the WeChat ClawBot chat. " +
        "BEFORE sending any IMAGE you have not already inspected in this turn, you MUST check it first: call look_at_image on it and confirm from the returned picture that it is the right one and framed sensibly. " +
        "Do not skip this — the user asked for it explicitly, and sending the wrong photo is worse than sending nothing. " +
        "Large images are downscaled automatically before upload (the WeChat CDN rejects full-resolution camera files); pass original: true only when the user explicitly asks for the untouched original. " +
        "Uploading a large non-image file can still take 1-2 minutes — that is normal, do not retry. " +
        "Returns whether the delivery succeeded.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description:
            "Path of the file to send: absolute, or relative to the working directory.",
        },
        caption: {
          type: "string",
          description: "Optional short text caption delivered together with the file.",
        },
        original: {
          type: "boolean",
          description:
            "Send the file byte-for-byte with no downscaling. Only for an explicit request for the original — a full-resolution photo will usually be rejected by the WeChat CDN.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.ok
              ? `✅ 文件已发送到微信: ${value.message}`
              : `❌ 发送失败: ${value.message}`,
          },
        ],
      },
      async execute(args) {
        const { path: rawPath, caption, original } = args as { path: string; caption?: string; original?: boolean };
        const bridge = deps.getBridge();
        if (!bridge) {
          return { ok: false, message: "微信桥接未运行（监控未启动）" };
        }
        const account = deps.getAccount();
        if (!account?.configured) {
          return { ok: false, message: "没有已绑定的微信账号" };
        }
        const sender = bridge.activeSender ?? account.userId;
        if (!sender) {
          return { ok: false, message: "无法确定收件人（没有活跃的微信会话）" };
        }

        const resolved = path.isAbsolute(rawPath)
          ? path.normalize(rawPath)
          : path.resolve(deps.config.cwd ?? process.cwd(), rawPath);

        let stat: fs.Stats;
        try {
          stat = fs.statSync(resolved);
        } catch {
          return { ok: false, message: `文件不存在: ${resolved}` };
        }
        if (!stat.isFile()) {
          return { ok: false, message: `不是普通文件: ${resolved}` };
        }

        logger.info(`send_wechat_file: sending ${resolved} (${stat.size} bytes) to ${sender}`);

        // Originals were sent verbatim here until full-resolution camera files
        // (5568x3712, 5-12MB) started making the C2C CDN answer HTTP 500 —
        // opaque, and each failure burned the whole retry ladder, so one photo
        // hung for ~4 minutes and then failed. Downscale first unless the
        // caller explicitly asked for the untouched file.
        const prep = original === true
          ? { path: resolved, bytes: stat.size, temp: false, note: undefined }
          : compressForUpload(resolved, {
              maxImageEdge: deps.config.maxImageEdge,
              imageQuality: deps.config.imageQuality,
              compressThresholdBytes: deps.config.compressThresholdBytes,
            });

        // Refuse before uploading what the CDN will certainly reject.
        //
        // Measured on this account: a 2.26MB payload uploads fine, a 4.1MB image
        // gets an opaque HTTP 500, and 7.2MB / 18.3MB files get the same. The
        // CDN never says "too large" — it just fails, three times, ~20s each.
        //
        // Two reasons this guard is worth having rather than letting it fail.
        // Compression only exists for images (downscale + quality ladder); an
        // archive or an .xpi cannot be shrunk, so for those a rejection is the
        // final answer and spending a minute to reach it is pure waste. And the
        // old failure text advised "downscale before sending", which is not
        // something the user can do to a browser extension — advice that cannot
        // be followed is worse than none.
        // Same test `sendWeixinMediaFile` uses to pick the upload, so the guard
        // is measured against the ceiling that will actually apply.
        const isImage = getMimeFromFilename(prep.path).startsWith("image/");
        const ceiling = isImage ? CDN_REJECT_ABOVE_IMAGE_BYTES : CDN_REJECT_ABOVE_FILE_BYTES;
        if (prep.bytes > ceiling) {
          const mb = (prep.bytes / (1024 * 1024)).toFixed(1);
          const limit = (ceiling / (1024 * 1024)).toFixed(1);
          logger.warn(
            `send_wechat_file: ${prep.bytes} bytes exceeds the CDN ceiling; refused without uploading`,
          );
          if (prep.temp) { try { fs.unlinkSync(prep.path); } catch { /* best effort */ } }
          return {
            ok: false,
            message:
              `这个文件 ${mb} MB,超过微信 CDN 实测能收的上限(约 ${limit} MB),传上去只会拿到一个没有说明的 500。`
              + (isImage
                ? "把设置里的「图片长边上限」或「JPEG 质量」调低一点再试(压缩阈值也要低于这个上限才有用)。"
                : "非图片走的是另一条上传通道,上限低得多,而且没法压缩 —— 只能换个方式给:压缩分卷、或者放云盘/AirDrop 发链接。"),
          };
        }

        // Announce the upload only when it is actually going to make the user
        // wait. A downscaled photo is a few hundred KB and lands within a
        // second or two, so a "正在发送…" line arriving just ahead of the image
        // reads as a duplicate of the image itself — the typing indicator below
        // already covers that case. Big files (untouched originals, PDFs,
        // archives, video) can take a minute, and there the notice is the only
        // thing telling the user to wait.
        if (prep.bytes >= deps.config.noticeMinBytes) {
          const sizeMb = (prep.bytes / (1024 * 1024)).toFixed(1);
          const label = prep.note !== undefined
            ? `正在发送 \`${path.basename(resolved)}\`（已压缩 ${prep.note}），可能需要一会儿…`
            : `正在发送 \`${path.basename(resolved)}\`（${sizeMb} MB），大文件可能需要一会儿…`;
          bridge.sendTextTo(sender, label);
        }

        // 「正在输入」 while the upload runs. Usually already up for the whole
        // turn (see typing.ts); this covers a file sent from a reminder turn.
        bridge.showTyping(sender);

        try {
          await sendWeixinMediaFile({
            filePath: prep.path,
            to: sender,
            text: deps.config.stripEmoji ? stripEmoji(caption ?? "") : stripWechatCodes(caption ?? ""),
            opts: {
              baseUrl: account.baseUrl,
              token: account.token,
              contextToken: bridge.contextTokenFor(sender),
              timeoutMs: 30_000,
            },
            cdnBaseUrl: account.cdnBaseUrl,
          });
        } catch (err) {
          logger.error(`send_wechat_file: failed ${resolved}: ${String(err)}`);
          return {
            ok: false,
            message: `发送失败: ${err instanceof Error ? err.message : String(err)}`,
          };
        } finally {
          // Drop the downscaled copy; the original on disk is never touched.
          if (prep.temp) {
            try {
              fs.rmSync(prep.path, { force: true });
            } catch (err) {
              logger.debug(`send_wechat_file: temp cleanup failed (non-fatal): ${String(err)}`);
            }
          }
          // The file (or the failure) lands now: restart the keepalive clock so
          // the indicator does not flash back right after it.
          bridge.noteDelivered(sender);
        }
        return { ok: true, message: resolved };
      },
    }),
  );
}

/**
 * Register `remember_user_info`: lets the WeChat agent append durable facts
 * about the user into the long-term memory file (~/.dsh/clawbot/memory.md).
 * The memory text is re-injected into the system prompt on every turn, so the
 * agent grows familiar with the user across sessions (Claude-Desktop-style).
 */
function registerMemoryTool(agentCtx: Context): void {
  agentCtx.tools.register(
    defineTool({
      name: "remember_user_info",
      description:
        "Append one durable fact about the user into long-term memory (a Markdown file). " +
        "Use this when the user tells you something worth remembering ACROSS conversations: " +
        "personal background, preferences, habits, recurring needs (\"每周三下午组会\"). " +
        "Test: will this still be true in a month? If not, do not store it. " +
        "Do NOT use it for one-off reminders or anything tied to a specific time (今天/明天/几点/几分钟后) — " +
        "use schedule_create for those; a stored reminder is wrong the next day and misleads your date math. " +
        "Also not for one-off task details, file paths of the moment, or anything the user already knows you will forget harmlessly. " +
        "Keep the content short and self-contained (one sentence). " +
        "The memory is injected into your system prompt every turn, so remembered facts influence future replies.",
      parameters: {
        content: {
          type: "string",
          required: true,
          description:
            "The fact to remember, one concise sentence, e.g. '用户喜欢手冲咖啡'.",
        },
        section: {
          type: "string",
          description:
            "Which memory section to append to: 基本档案 / 偏好与习惯 / 重要事实. Defaults to 基本档案. " +
            "(There is no reminders section: one-off reminders go to schedule_create.)",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.ok ? `记忆已更新: ${value.message}` : `记忆更新失败: ${value.message}`,
          },
        ],
      },
      async execute(args) {
        const { content, section } = args as { content?: string; section?: string };
        // Refuse with a reason, not a bare false: the model reads this result and
        // should reach for schedule_create instead of retrying another section.
        const refused = oneOffReminderReason(section, content ?? "");
        if (refused !== null) {
          logger.info(`remember_user_info: refused section=${section ?? "基本档案"} content=${content ?? ""}`);
          return { ok: false, message: refused };
        }
        const changed = appendMemoryEntry(section ?? "基本档案", content ?? "");
        logger.info(`remember_user_info: section=${section ?? "基本档案"} changed=${changed} content=${content ?? ""}`);
        return {
          ok: changed,
          message: changed ? `已记住: ${content}` : "内容已存在或为空,未重复写入",
        };
      },
    }),
  );
}

/**
 * Register `send_wechat_text`: the ONLY way the agent can deliver a text
 * message to the user's WeChat. There is NO automatic forwarding of
 * assistant replies — every message the user should see must be sent by an
 * explicit tool call, so the agent fully controls what reaches WeChat
 * (acknowledgments, progress notes, final summaries, reminders, ...).
 */
function registerSendTextTool(agentCtx: Context, deps: SendFileToolDeps): void {
  agentCtx.tools.register(
    defineTool({
      name: "send_wechat_text",
      description:
        "Send ONE text message to the user's WeChat conversation. This is the ONLY way to deliver text over WeChat: assistant replies are NOT forwarded automatically, so if you do not call this tool the user never sees your message. " +
        "Use it for acknowledgments, short progress notes, final summaries, and timed-reminder deliveries. " +
        "Send ONE message per call; keep each message as short as possible. " +
        "Never write your own scripts or call the WeChat/iLink API directly.",
      parameters: {
        text: {
          type: "string",
          required: true,
          description:
            "The exact text to send to WeChat (plain text, no emojis; may use WeChat native emoji codes like [捂脸]).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.ok ? `微信消息已发送: ${value.message}` : `微信消息发送失败: ${value.message}`,
          },
        ],
      },
      async execute(args) {
        const { text } = args as { text?: string };
        const content = (text ?? "").trim();
        if (!content) {
          return { ok: false, message: "消息内容为空" };
        }
        const bridge = deps.getBridge();
        if (!bridge) {
          return { ok: false, message: "微信桥接未运行（监控未启动）" };
        }
        const account = deps.getAccount();
        if (!account?.configured) {
          return { ok: false, message: "没有已绑定的微信账号" };
        }
        const sender = bridge.activeSender ?? account.userId;
        if (!sender) {
          return { ok: false, message: "无法确定收件人（没有活跃的微信会话）" };
        }
        const finalText = deps.config.stripEmoji ? stripEmoji(content) : stripWechatCodes(content);
        bridge.sendTextTo(sender, finalText);
        logger.info(`send_wechat_text: to=${sender} chars=${finalText.length}`);
        return { ok: true, message: content };
      },
    }),
  );
}

/**
 * Register a WeChat-scoped override of `ask_user_question`: the global tool
 * routes questions to the webapp GUI provider, but WeChat users are not at
 * the webapp — so on the WeChat agent this tool sends the question through
 * WeChat and waits for the reply (5 min timeout).
 */
function registerWechatAskTool(agentCtx: Context, deps: SendFileToolDeps): void {
  agentCtx.tools.register(
    defineTool({
      name: "ask_user_question",
      description:
        "Ask the user a question and wait for their answer. The question is delivered to the user's WeChat; returns their reply text (or null on timeout). " +
        "Use when you need a choice/confirmation before continuing.",
      parameters: {
        question: {
          type: "string",
          required: true,
          description: "The question to ask the user, in their language.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            answer: { type: "string" },
            message: { type: "string", required: true },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value.ok ? `用户回答: ${value.answer ?? "(无)"}` : `提问失败: ${value.message}`,
          },
        ],
      },
      async execute(args) {
        const { question } = args as { question?: string };
        const q = (question ?? "").trim();
        if (!q) return { ok: false, message: "问题为空" };
        const bridge = deps.getBridge();
        if (!bridge) return { ok: false, message: "微信桥接未运行（监控未启动）" };
        const answer = await bridge.askWechat(q);
        return answer !== null
          ? { ok: true, answer, message: "已收到回答" }
          : { ok: false, message: "等待回答超时或中断" };
      },
    }),
  );
}
