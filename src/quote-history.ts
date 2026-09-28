/**
 * Quote history: a local registry mapping WeChat message ids to their
 * content, used to resolve quoted (引用) messages. The iLink wire only
 * carries the quoted message's id — the actual content must be looked up
 * locally.
 *
 * msg_ids are 19-digit numbers that exceed Number.MAX_SAFE_INTEGER, so they
 * are always handled as strings.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

const MAX_ENTRIES = 500;

type QuoteEntry = {
  msgId: string;
  /** Text content of the message ("" for media-only messages). */
  text: string;
  /** Local path when the message was an image we downloaded. */
  imagePath?: string;
  time: number;
};

type QuoteHistoryFile = {
  entries: QuoteEntry[];
};

function historyPath(): string {
  return path.join(resolveStateDir(), "quote-history.json");
}

function read(): QuoteHistoryFile {
  try {
    const raw = fs.readFileSync(historyPath(), "utf-8");
    const parsed = JSON.parse(raw) as QuoteHistoryFile;
    if (Array.isArray(parsed.entries)) return parsed;
  } catch {
    // missing or corrupt — start fresh
  }
  return { entries: [] };
}

function write(data: QuoteHistoryFile): void {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    const tmp = `${historyPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    fs.renameSync(tmp, historyPath());
  } catch (err) {
    logger.warn(`quote-history: write failed: ${String(err)}`);
  }
}

/** Record a message (inbound or outbound) by its server msg id. */
export function recordQuoteMessage(entry: QuoteEntry): void {
  if (!entry.msgId) return;
  const data = read();
  data.entries = data.entries.filter((e) => e.msgId !== entry.msgId);
  data.entries.push(entry);
  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(-MAX_ENTRIES);
  }
  write(data);
}

/**
 * Best-effort id tolerance: 19-digit msg ids exceed Number.MAX_SAFE_INTEGER,
 * so every JSON-number round trip (monitor parse, sendMessage response)
 * loses precision and the same real id can stringify differently
 * (observed diffs of ~500 on a ~1024 double grid). Compare as BigInt with a
 * small window instead of exact string equality.
 */
const ID_TOLERANCE = 4096n;

function idDiff(a: string, b: string): bigint | null {
  try {
    const ia = BigInt(a);
    const ib = BigInt(b);
    const d = ia > ib ? ia - ib : ib - ia;
    return d <= ID_TOLERANCE ? d : null;
  } catch {
    return null;
  }
}

/**
 * Look up a quoted message's content by its (possibly precision-lossy)
 * server msg id. Returns the best matching entry when one exists within
 * tolerance.
 */
export function lookupQuoteMessage(msgId: string): QuoteEntry | null {
  if (!msgId) return null;
  const data = read();
  let best: QuoteEntry | null = null;
  let bestDiff: bigint | null = null;
  for (let i = data.entries.length - 1; i >= 0; i -= 1) {
    const entry = data.entries[i];
    // Exact match wins immediately.
    if (entry.msgId === msgId) return entry;
    const diff = idDiff(entry.msgId, msgId);
    if (diff !== null && (bestDiff === null || diff < bestDiff)) {
      best = entry;
      bestDiff = diff;
    }
  }
  return best;
}
