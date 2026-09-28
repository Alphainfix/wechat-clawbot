import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { redactUrl } from "../util/redact.js";

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

/**
 * Above this ciphertext size, a server 500 is treated as a verdict rather than
 * a hiccup: the CDN rejects oversized payloads with an opaque 500, and
 * re-POSTing the same bytes only burns time. Measured on this account, a 3.9MB
 * photo spent 3m43s across the image ladder and the file-attachment fallback
 * before failing, while a 108KB image uploads in about 9s. Network-level
 * failures still get their retries at any size.
 */
const NO_RETRY_ON_SERVER_ERROR_ABOVE_BYTES = 2 * 1024 * 1024;

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  /** From getUploadUrl.upload_full_url; POST target when set (takes precedence over uploadParam). */
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(`${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        logger.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        logger.error(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        logger.error(
          `${label}: CDN response missing x-encrypted-param header attempt=${attempt}`,
        );
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      // Oversized payload + server error: retrying cannot change the outcome.
      if (
        ciphertext.length > NO_RETRY_ON_SERVER_ERROR_ABOVE_BYTES &&
        err instanceof Error &&
        err.message.includes("CDN upload server error")
      ) {
        logger.error(
          `${label}: ${ciphertext.length} bytes rejected by the CDN (server error) — not retrying; downscale before sending`,
        );
        break;
      }
      const cause =
        (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "";
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error(
          `${label}: attempt ${attempt} failed, retrying... url=${redactUrl(cdnUrl)} error=${String(err)}${cause ? ` cause=${cause}` : ""}`,
        );
      } else {
        logger.error(
          `${label}: all ${UPLOAD_MAX_RETRIES} attempts failed url=${redactUrl(cdnUrl)} error=${String(err)}${cause ? ` cause=${cause}` : ""}`,
        );
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}
