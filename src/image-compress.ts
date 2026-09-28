/**
 * Outbound image auto-compression: downscale + re-encode large images with
 * macOS's built-in `sips` before uploading to WeChat, so the slow CDN upload
 * stays short. Zero dependencies; best effort (any failure falls back to
 * sending the original file).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getMimeFromFilename } from "./ilink/media/mime.js";
import { logger } from "./ilink/util/logger.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tiff", ".tif"]);

export type ImageCompressOptions = {
  /** Long-edge pixel cap for the compressed image. */
  maxImageEdge: number;
  /** Primary JPEG quality (ladder falls back to 60 then 40). */
  imageQuality: number;
  /** Only compress images larger than this many bytes. */
  compressThresholdBytes: number;
};

/**
 * Create a downscaled JPEG copy of an image for FAST local analysis (vision
 * tools choke on multi-megapixel originals). Returns the copy path, or the
 * original path when the image is already small or not an image. The caller
 * must delete the returned temp file when it differs from the input path.
 */
export function makePreviewCopy(
  filePath: string,
  opts: ImageCompressOptions,
): string {
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext) && !getMimeFromFilename(filePath).startsWith("image/")) {
    return filePath;
  }
  if (ext === ".gif" || ext === ".svg") return filePath;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return filePath;
  }
  // Already small AND small enough on the long edge: analyze the original.
  if (stat.size <= opts.compressThresholdBytes) {
    try {
      const out = execFileSync(
        "sips",
        ["-g", "pixelWidth", "-g", "pixelHeight", filePath],
        { encoding: "utf8", timeout: 15_000 },
      );
      const w = Number(/pixelWidth: (\d+)/.exec(out)?.[1] ?? 0);
      const h = Number(/pixelHeight: (\d+)/.exec(out)?.[1] ?? 0);
      if (Math.max(w, h) <= opts.maxImageEdge) return filePath;
    } catch {
      return filePath;
    }
  }

  const tmp = path.join(
    os.tmpdir(),
    `clawbot-preview-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.jpg`,
  );
  try {
    execFileSync(
      "sips",
      [
        "-Z",
        String(opts.maxImageEdge),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(opts.imageQuality),
        filePath,
        "--out",
        tmp,
      ],
      { timeout: 60_000 },
    );
    logger.info(`makePreviewCopy: ${filePath} -> ${tmp} (${fs.statSync(tmp).size} bytes)`);
    return tmp;
  } catch (err) {
    logger.warn(`makePreviewCopy: sips failed, using original: ${String(err)}`);
    fs.rmSync(tmp, { force: true });
    return filePath;
  }
}

/** Quality ladder tried after the primary quality still exceeds the target. */
const QUALITY_LADDER = [60, 40];

/** Long edge / byte size of an image, or null when sips cannot read it. */
function imageDims(filePath: string): { w: number; h: number } | null {
  try {
    const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const w = Number(/pixelWidth: (\d+)/.exec(out)?.[1] ?? 0);
    const h = Number(/pixelHeight: (\d+)/.exec(out)?.[1] ?? 0);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

/** What {@link compressForUpload} decided. `temp` marks a file the caller must delete. */
export type UploadPrep = {
  path: string;
  bytes: number;
  temp: boolean;
  /** Human note for the pre-upload notice, e.g. "5568x3712 11.5MB → 2048x1365 0.6MB". */
  note?: string;
};

/**
 * Shrink an outbound image so the WeChat CDN will actually accept it.
 *
 * Full-resolution camera files (5568x3712, 5-12MB) make the C2C CDN answer
 * HTTP 500 — not a clean size error — and each failure burns the whole retry
 * ladder, so a single photo could hang for minutes and then fail. Downscaling
 * to `maxImageEdge` and walking the quality ladder until the copy fits
 * `compressThresholdBytes` keeps uploads in the range that works (a 108KB
 * image sends in ~9s).
 *
 * Best effort throughout: any sips failure returns the original, because
 * sending something beats sending nothing.
 */
export function compressForUpload(
  filePath: string,
  opts: ImageCompressOptions,
): UploadPrep {
  const original = (bytes: number): UploadPrep => ({ path: filePath, bytes, temp: false });

  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext) && !getMimeFromFilename(filePath).startsWith("image/")) {
    return original(safeSize(filePath));
  }
  // Animated / vector formats do not survive a sips re-encode meaningfully.
  if (ext === ".gif" || ext === ".svg") return original(safeSize(filePath));

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return original(0);
  }

  const dims = imageDims(filePath);
  const longEdge = dims ? Math.max(dims.w, dims.h) : 0;
  const withinBytes = stat.size <= opts.compressThresholdBytes;
  const withinEdge = longEdge === 0 || longEdge <= opts.maxImageEdge;
  if (withinBytes && withinEdge) return original(stat.size);

  const from = dims ? `${dims.w}x${dims.h} ${mb(stat.size)}` : mb(stat.size);
  let best: { path: string; bytes: number } | null = null;

  for (const quality of [opts.imageQuality, ...QUALITY_LADDER]) {
    const tmp = path.join(
      os.tmpdir(),
      `clawbot-send-${Date.now()}-${Math.random().toString(16).slice(2, 6)}-q${quality}.jpg`,
    );
    try {
      execFileSync(
        "sips",
        [
          "-Z",
          String(opts.maxImageEdge),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          String(quality),
          filePath,
          "--out",
          tmp,
        ],
        { timeout: 60_000 },
      );
      const bytes = fs.statSync(tmp).size;
      // Keep the smallest copy produced so far; drop the previous one.
      if (best === null || bytes < best.bytes) {
        if (best !== null) fs.rmSync(best.path, { force: true });
        best = { path: tmp, bytes };
      } else {
        fs.rmSync(tmp, { force: true });
      }
      if (bytes <= opts.compressThresholdBytes) break;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      logger.warn(`compressForUpload: sips q${quality} failed: ${String(err)}`);
    }
  }

  if (best === null) {
    logger.warn(`compressForUpload: every attempt failed, sending original ${filePath}`);
    return original(stat.size);
  }
  // A "compressed" copy that grew is worse than the original.
  if (best.bytes >= stat.size) {
    fs.rmSync(best.path, { force: true });
    return original(stat.size);
  }

  const toDims = imageDims(best.path);
  const to = toDims ? `${toDims.w}x${toDims.h} ${mb(best.bytes)}` : mb(best.bytes);
  logger.info(`compressForUpload: ${filePath} ${from} -> ${best.path} ${to}`);
  return { path: best.path, bytes: best.bytes, temp: true, note: `${from} → ${to}` };
}

function safeSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
