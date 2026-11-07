/**
 * WeChat message monitor: a resilient long-poll loop over the iLink
 * `getUpdates` endpoint.
 *
 * Ported from `@tencent-weixin/openclaw-weixin` (MIT) `src/monitor/monitor.ts`
 * semantics: 35s long-poll, `get_updates_buf` seq continuity, exponential
 * backoff on network failures, and a one-hour pause on stale-token errors.
 * The OpenClaw channel-runtime plumbing is replaced by a plain callback.
 */
import fs from "node:fs";
import path from "node:path";

import { getUpdates, notifyStart, notifyStop } from "./ilink/api/api.js";
import {
  STALE_TOKEN_ERRCODE,
  isSessionPaused,
  pauseSession,
  getRemainingPauseMs,
} from "./ilink/api/session-guard.js";
import type { ResolvedWeixinAccount } from "./ilink/auth/accounts.js";
import type { WeixinMessage } from "./ilink/api/types.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "./ilink/storage/sync-buf.js";
import { logger } from "./ilink/util/logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorOptions = {
  account: ResolvedWeixinAccount;
  /** Called for every inbound message, in order. */
  onMessage: (msg: WeixinMessage) => Promise<void> | void;
  /** Called when the monitor stops (token stale, abort, fatal error). */
  onStop: (reason: string) => void;
  signal: AbortSignal;
};

/** Run the monitor loop until `signal` aborts or the session goes stale. */
export async function runMonitor(opts: MonitorOptions): Promise<void> {
  const { account, signal } = opts;
  const log = logger.withAccount(account.accountId);
  const syncBufPath = getSyncBufFilePath(account.accountId);

  let getUpdatesBuf = loadGetUpdatesBuf(syncBufPath) ?? "";
  // Ids of the messages already handled, so a replayed batch (see below) does
  // not answer the same message twice.
  const seen = new SeenSet(`${syncBufPath}.seen.json`);
  let consecutiveFailures = 0;

  const notify = async (fn: typeof notifyStart): Promise<void> => {
    try {
      await fn({ baseUrl: account.baseUrl, token: account.token });
    } catch (err) {
      log.warn(`notify failed: ${String(err)}`);
    }
  };

  await notify(notifyStart);
  log.info(`monitor started baseUrl=${account.baseUrl}`);

  try {
    while (!signal.aborted) {
      if (isSessionPaused(account.accountId)) {
        const remainMin = Math.ceil(getRemainingPauseMs(account.accountId) / 60_000);
        log.warn(`session paused (stale token), waiting ${remainMin} min`);
        opts.onStop("session paused: token stale (errcode -14), run `clawbot login` again");
        return;
      }

      let resp;
      try {
        resp = await getUpdates({
          baseUrl: account.baseUrl,
          token: account.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          abortSignal: signal,
        });
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        const delay =
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
        log.error(
          `getUpdates failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}; retrying in ${delay}ms`,
        );
        if (signal.aborted) break;
        await sleep(delay, signal);
        continue;
      }

      if (signal.aborted) break;

      if (resp.errcode === STALE_TOKEN_ERRCODE) {
        log.error(`getUpdates returned errcode ${STALE_TOKEN_ERRCODE}; pausing session`);
        pauseSession(account.accountId);
        opts.onStop("session paused: token stale (errcode -14), run `clawbot login` again");
        return;
      }
      if (resp.ret && resp.ret !== 0) {
        log.warn(`getUpdates ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
      }

      // Persist the server-provided continuation buffer AFTER the messages it
      // covers have been handled. Saving it first made delivery at-most-once: a
      // crash mid-batch resumed from the new position and silently dropped
      // whatever was left in that batch — and the sender's phone shows those
      // messages as delivered, so nothing on either side looks wrong. The new
      // order can replay a batch instead; the persisted set of handled ids below
      // absorbs that replay.
      const batch = resp.msgs ?? [];
      let processedAll = true;
      for (const msg of batch) {
        if (signal.aborted) {
          // Stopped mid-batch: do NOT advance the cursor, or the messages we
          // never handled would be skipped on the next start.
          processedAll = false;
          break;
        }
        const key = messageKey(msg);
        if (key !== null && seen.has(key)) {
          log.info(`skip replayed message ${key}`);
          continue;
        }
        try {
          await opts.onMessage(msg);
        } catch (err) {
          // Not marked as seen, but the cursor still moves: one message that
          // always fails (a broken media item) must not wedge every later one.
          log.error(`onMessage failed: ${String(err)}`);
          continue;
        }
        if (key !== null) seen.add(key);
      }
      if (processedAll && typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        try {
          saveGetUpdatesBuf(syncBufPath, getUpdatesBuf);
        } catch (err) {
          // A full disk must not take the WeChat connection down; the next poll retries.
          log.error(`could not persist the continuation buffer: ${String(err)}`);
        }
      }
    }
  } finally {
    if (!signal.aborted) {
      await notify(notifyStop);
    }
    log.info("monitor stopped");
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How many handled message ids are remembered: enough to cover a replayed batch. */
const SEEN_LIMIT = 500;

/**
 * The id a replayed message is recognised by.
 *
 * `client_id` is the sender's own message id; `seq` is only unique within an
 * account, so it is namespaced. The numeric `message_id` is NOT used: it
 * exceeds 2^53 and arrives rounded, which makes two different messages look
 * identical.
 */
export function messageKey(msg: WeixinMessage): string | null {
  const client = msg.client_id?.trim();
  if (client !== undefined && client !== "") return client;
  return typeof msg.seq === "number" ? `seq:${msg.seq}` : null;
}

/**
 * The last N handled message ids, on disk.
 *
 * This is the other half of saving the continuation buffer AFTER processing: a
 * crash in the middle of a batch now replays that batch instead of dropping it,
 * and this set keeps the replay from answering the same message twice.
 */
export class SeenSet {
  private ids: string[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  has(key: string): boolean {
    this.load();
    return this.ids.includes(key);
  }

  add(key: string): void {
    this.load();
    if (this.ids.includes(key)) return;
    this.ids.push(key);
    if (this.ids.length > SEEN_LIMIT) this.ids.splice(0, this.ids.length - SEEN_LIMIT);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ ids: this.ids }), "utf-8");
    } catch (err) {
      // Best effort: a full disk degrades to at-least-once, which is the safe side.
      logger.warn(`seen: could not persist ${this.file}: ${String(err)}`);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { ids?: unknown };
      if (Array.isArray(parsed.ids)) {
        this.ids = parsed.ids.filter((value): value is string => typeof value === "string").slice(-SEEN_LIMIT);
      }
    } catch {
      // Fresh install or unreadable file: nothing has been seen yet.
    }
  }
}
