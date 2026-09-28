/**
 * WeChat message monitor: a resilient long-poll loop over the iLink
 * `getUpdates` endpoint.
 *
 * Ported from `@tencent-weixin/openclaw-weixin` (MIT) `src/monitor/monitor.ts`
 * semantics: 35s long-poll, `get_updates_buf` seq continuity, exponential
 * backoff on network failures, and a one-hour pause on stale-token errors.
 * The OpenClaw channel-runtime plumbing is replaced by a plain callback.
 */
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

      // Persist the server-provided continuation buffer BEFORE processing,
      // so a crash mid-batch resumes from the same position.
      if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveGetUpdatesBuf(syncBufPath, getUpdatesBuf);
      }

      for (const msg of resp.msgs ?? []) {
        if (signal.aborted) break;
        try {
          await opts.onMessage(msg);
        } catch (err) {
          log.error(`onMessage failed: ${String(err)}`);
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
