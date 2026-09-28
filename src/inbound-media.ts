/**
 * Inbound WeChat media handling: download, decrypt (AES-128-ECB) and persist
 * images/files the user sends from WeChat, then hand the local path to the
 * agent so it can inspect the file (e.g. with vision tools).
 *
 * Adapted from `@tencent-weixin/openclaw-weixin` (MIT)
 * `src/media/media-download.ts`: the OpenClaw media store is replaced by a
 * plain directory under the ClawBot state dir, and voice/video are not yet
 * supported (voice needs a silk transcoder).
 */
import fs from "node:fs";
import path from "node:path";

import {
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
} from "./ilink/cdn/pic-decrypt.js";
import { getMimeFromFilename } from "./ilink/media/mime.js";
import type { MessageItem } from "./ilink/api/types.js";
import { MessageItemType } from "./ilink/api/types.js";
import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** Sniff an image format from magic bytes → file extension. */
function sniffExtension(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return ".png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return ".jpg";
  }
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return ".gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }
  if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    return ".pdf";
  }
  return ".bin";
}

function inboundDir(): string {
  return path.join(resolveStateDir(), "inbound");
}

/** Persist a decrypted media buffer into the inbound dir; returns the path. */
function saveInboundMedia(buf: Buffer, ext: string, originalName?: string): string {
  const dir = inboundDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = originalName
    ? `${Date.now()}-${path.basename(originalName).replace(/[^\w.\-]/g, "_")}`
    : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${ext}`;
  const filePath = path.join(dir, base);
  fs.writeFileSync(filePath, buf, { mode: 0o600 });
  logger.info(`inbound media saved: ${filePath} (${buf.length} bytes)`);
  return filePath;
}

export type InboundMediaResult = {
  /** Local path of a downloaded/decrypted image. */
  imagePath?: string;
  /** Local path of a downloaded/decrypted file attachment. */
  filePath?: string;
  mime?: string;
};

/**
 * Download and decrypt media from a single MessageItem (image or file).
 * Returns an empty object when the item is unsupported or failed.
 */
export async function downloadMediaFromItem(
  item: MessageItem,
  deps: { cdnBaseUrl: string; label: string },
): Promise<InboundMediaResult> {
  const { cdnBaseUrl, label } = deps;
  const result: InboundMediaResult = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return result;
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            img.media.full_url,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            img.media.full_url,
          );
      result.imagePath = saveInboundMedia(buf, sniffExtension(buf));
      logger.debug(`${label} image saved: ${result.imagePath}`);
    } catch (err) {
      logger.error(`${label} image download/decrypt failed: ${String(err)}`);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key) {
      return result;
    }
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        fileItem.media.full_url,
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      result.filePath = saveInboundMedia(
        buf,
        sniffExtension(buf),
        fileItem.file_name ?? undefined,
      );
      result.mime = mime;
      logger.debug(`${label} file: saved to ${result.filePath} mime=${mime}`);
    } catch (err) {
      logger.error(`${label} file download failed: ${String(err)}`);
    }
  }

  return result;
}
