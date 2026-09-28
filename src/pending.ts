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

  /** Register a pending interaction. */
  push(answer: PendingAnswer): void {
    this.queue.push(answer);
  }

  /** Whether the bot is waiting for this sender to answer something. */
  hasFor(sender: string): boolean {
    return this.queue.some((a) => a.sender === sender);
  }

  /** Pop the oldest pending interaction for a sender, if any. */
  popFor(sender: string): PendingAnswer | undefined {
    const index = this.queue.findIndex((a) => a.sender === sender);
    if (index < 0) return undefined;
    const [answer] = this.queue.splice(index, 1);
    return answer;
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
