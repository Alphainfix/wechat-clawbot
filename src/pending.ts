/**
 * Shared registry for pending WeChat interactions (approval questions, user
 * questions). One inbound WeChat text can resolve at most one pending
 * interaction for its sender; everything else is treated as a new agent turn.
 */
import { logger } from "./ilink/util/logger.js";

export interface PendingAnswer {
  /** Distinguishes the kind of pending interaction ("approval" | "question"). */
  readonly tag: string;
  /** The WeChat user id expected to answer. */
  readonly sender: string;
  /**
   * Resolve with the raw reply text, or `null` when the interaction was
   * aborted (e.g. the approval signal fired). Idempotent.
   */
  resolve: (reply: string | null) => void;
}

export class PendingRegistry {
  private readonly queue: PendingAnswer[] = [];
  private closed = false;

  /** Register a pending interaction (aborted at once while closed: nothing would answer it). */
  push(answer: PendingAnswer): void {
    if (this.closed) {
      answer.resolve(null);
      return;
    }
    this.queue.push(answer);
  }

  /**
   * The listener is stopping: abort everything waiting for a WeChat answer and
   * take nothing new until reopen(). A turn waiting on an approval would
   * otherwise keep the bridge, and with it the stop, waiting for ever.
   */
  close(): void {
    this.closed = true;
    this.abortAll();
  }

  reopen(): void {
    this.closed = false;
  }

  /** Whether the bot is waiting for this sender to answer something. */
  hasFor(sender: string): boolean {
    return this.queue.some((a) => a.sender === sender);
  }

  /** How many interactions are waiting for an answer from anyone. */
  get size(): number {
    return this.queue.length;
  }

  /** Pop the oldest pending interaction for a sender, if any. */
  popFor(sender: string): PendingAnswer | undefined {
    const index = this.queue.findIndex((a) => a.sender === sender);
    if (index < 0) return undefined;
    const [answer] = this.queue.splice(index, 1);
    return answer;
  }

  /**
   * Withdraw one interaction that ended without a reply (aborted, timed out).
   * It must leave the queue: otherwise the sender's next WeChat message is
   * taken as the answer to a question nobody waits for any more, and is lost.
   */
  remove(answer: PendingAnswer): boolean {
    const index = this.queue.indexOf(answer);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** Remove and abort every pending interaction for a sender (on logout etc.). */
  abortFor(sender: string): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i].sender === sender) {
        const [answer] = this.queue.splice(i, 1);
        answer.resolve(null);
      }
    }
  }

  /** Abort all pending interactions (on monitor stop). */
  abortAll(): void {
    const all = this.queue.splice(0);
    for (const answer of all) answer.resolve(null);
    logger.info(`PendingRegistry: aborted ${all.length} pending interactions`);
  }
}
