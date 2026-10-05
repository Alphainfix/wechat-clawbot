/**
 * Compact the WeChat session while nobody is waiting on it.
 *
 * The host compacts automatically, but at `agent/pre-step` — right before a
 * model call. For a chat bot that means the owner's message is the thing that
 * triggers it: on 2026-10-04 a reply waited 17 s behind a compaction of ~30万
 * tokens. Here the same work moves into the quiet time after a reply: once a
 * turn has ended, typing has stopped and nothing new has arrived for a while,
 * and the last request was already close to the host's threshold, run the
 * host's own `/compact` on the session. The next message then finds a short
 * history and the host's pre-step check has nothing to do.
 *
 * `/compact` folds the whole history into one summary (it keeps no verbatim
 * tail, unlike the pre-step compaction). That is why it waits for a quiet
 * period: a conversation in progress is never cut; by the time the owner comes
 * back the chat restarts anyway, with the summary and long-term memory behind it.
 *
 * Best effort throughout: every failure is logged and swallowed — the host's
 * pre-step compaction is still there as the fallback.
 */
import { logger } from "./ilink/util/logger.js";

/** Quiet period after the last turn before the size is checked. */
export const IDLE_COMPACT_DELAY_MS = 10 * 60 * 1000;
/** Compact once the last request reached this share of the host's threshold. */
export const IDLE_COMPACT_RATIO = 0.85;
/** compaction-basic's default `headroomTokens` (its summary output reserve). */
const HOST_HEADROOM_TOKENS = 65_536;
/** compaction-basic's default `thresholdRatio`. */
const HOST_THRESHOLD_RATIO = 0.8;

/**
 * The token count at which the host's compaction-basic compacts before a step,
 * with its default policy: `min(window × 0.8, window − maxTokens − 65536)`.
 * Undefined when the route does not declare a usable window.
 */
export function hostCompactionThreshold(contextWindow: unknown, maxTokens: unknown): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const reserved = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0;
  const budget = contextWindow - reserved - HOST_HEADROOM_TOKENS;
  if (budget <= 0) return undefined;
  return Math.floor(Math.min(contextWindow * HOST_THRESHOLD_RATIO, budget));
}

export type IdleCompactDeps = {
  /** The owner's switch (config `idleCompaction`), read each time. */
  enabled: () => boolean;
  /** A turn running, a message queued, or a question waiting on the owner. */
  isBusy: () => boolean;
  /** Tokens the session's last model request carried, as the provider reported. */
  lastRequestTokens: () => number | undefined;
  /** The host's compaction threshold for the current route. */
  hostThreshold: () => Promise<number | undefined>;
  /** Run the host's `/compact` on the session; undefined when it is not available. */
  compact: (signal: AbortSignal) => Promise<{ ok: boolean; text: string } | undefined>;
  /** The history was just compacted: forget the last request size. */
  onCompacted?: () => void;
  delayMs?: number;
  ratio?: number;
};

export class IdleCompactor {
  private readonly deps: IdleCompactDeps;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  constructor(deps: IdleCompactDeps) {
    this.deps = deps;
  }

  /** A turn ended and nothing is queued: (re)start the quiet-period clock. */
  noteIdle(): void {
    if (this.disposed) return;
    this.clear();
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, this.deps.delayMs ?? IDLE_COMPACT_DELAY_MS);
    timer.unref?.();
    this.timer = timer;
  }

  /** Something happened (a message, a new turn): the session is not quiet. */
  noteActivity(): void {
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  /** Whether a quiet-period check is pending (for tests and logs). */
  get pending(): boolean {
    return this.timer !== undefined;
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One check after the quiet period; exposed for tests. */
  async check(): Promise<void> {
    if (this.disposed || this.running || !this.deps.enabled() || this.deps.isBusy()) return;
    const used = this.deps.lastRequestTokens();
    if (used === undefined || used <= 0) return;
    let threshold: number | undefined;
    try {
      threshold = await this.deps.hostThreshold();
    } catch (err) {
      logger.debug(`idle-compact: threshold unavailable: ${String(err)}`);
      return;
    }
    if (threshold === undefined) return;
    const trigger = Math.floor(threshold * (this.deps.ratio ?? IDLE_COMPACT_RATIO));
    if (used < trigger) {
      logger.debug(`idle-compact: ${used} tokens < ${trigger} (host threshold ${threshold}); nothing to do`);
      return;
    }
    // The threshold lookup awaited; the owner may have written meanwhile.
    if (this.disposed || this.deps.isBusy()) return;
    this.running = true;
    try {
      logger.info(`idle-compact: last request ${used} tokens >= ${trigger} (host threshold ${threshold}); compacting while idle`);
      const result = await this.deps.compact(AbortSignal.timeout(180_000));
      if (result === undefined) {
        logger.info("idle-compact: /compact is not available for this session; leaving it to the host's pre-step compaction");
      } else if (result.ok) {
        this.deps.onCompacted?.();
        logger.info(`idle-compact: done — ${result.text}`);
      } else {
        logger.warn(`idle-compact: /compact declined — ${result.text}`);
      }
    } catch (err) {
      logger.warn(`idle-compact: failed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
