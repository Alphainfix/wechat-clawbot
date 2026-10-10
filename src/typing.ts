/**
 * 「对方正在输入…」while the bot works on a reply.
 *
 * Same rhythm as the official OpenClaw channel (@tencent-weixin/openclaw-weixin):
 * TYPING is re-sent every 5 s while a turn runs, CANCEL is sent when it ends,
 * and the per-user typing ticket comes from getconfig and is cached for up to a
 * day. Everything here is best effort — a failed indicator must never delay or
 * break the reply itself, so nothing in this class throws or blocks a caller.
 *
 * After a reply reaches the phone the indicator goes down at once (CANCEL), and
 * stays down unless the bot is evidently still working: a new tool call
 * (noteWorking), a new message from the user (start), or the quiet window
 * running out. Every turn ends with one more model call after the last reply —
 * 2.4 s median, 6.8 s at most over 60 turns measured on 2026-10-10 — and that
 * wrap-up used to keep 「正在输入」 on screen, or bring it back, after the
 * answer was already there.
 */
import { getConfig, sendTyping } from "./ilink/api/api.js";
import { TypingStatus } from "./ilink/api/types.js";
import { logger } from "./ilink/util/logger.js";

type TypingAccount = { baseUrl: string; token?: string };

export type TypingDeps = {
  getAccount: () => TypingAccount | null | undefined;
  getContextToken: (sender: string) => string;
  /**
   * True while the bot is waiting for this sender to answer (an approval or a
   * question). The bot is not typing then — the user is — so the indicator
   * pauses instead of claiming otherwise.
   */
  isWaitingFor: (sender: string) => boolean;
  keepaliveMs?: number;
  /** Quiet window after a reply (see QUIET_AFTER_REPLY_MS). */
  quietMs?: number;
  /** The two iLink calls; injectable so tests run without the network. */
  api?: { getConfig: typeof getConfig; sendTyping: typeof sendTyping };
};

const KEEPALIVE_MS = 5_000;
/**
 * How long the indicator stays down after a reply when nothing says the bot is
 * still working. Longer than the slowest wrap-up step measured (6.8 s), so a
 * finished turn never flashes it again; a long think before more output still
 * gets it back.
 */
const QUIET_AFTER_REPLY_MS = 8_000;
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const TICKET_RETRY_MS = 60_000;
/** Consecutive failures after which a turn stops trying (the account is likely offline). */
const MAX_FAILURES = 3;

export class TypingIndicator {
  private readonly deps: TypingDeps;
  private readonly keepaliveMs: number;
  private readonly quietMs: number;
  private readonly api: { getConfig: typeof getConfig; sendTyping: typeof sendTyping };
  private readonly tickets = new Map<string, { ticket: string; nextFetchAt: number }>();
  /** Whom the indicator is currently running for. */
  private sender: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the phone shows us as typing, as far as we know. */
  private shown = false;
  private failures = 0;
  /** A tick's requests are in flight (its timer has already fired). */
  private busy = false;
  /** Down after a reply, waiting for a sign of more work (or the quiet window). */
  private quiet = false;
  /** Replies delivered so far: tells a TYPING that was in flight across one to take itself back. */
  private deliveries = 0;

  constructor(deps: TypingDeps) {
    this.deps = deps;
    this.keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;
    this.quietMs = deps.quietMs ?? QUIET_AFTER_REPLY_MS;
    this.api = deps.api ?? { getConfig, sendTyping };
  }

  /**
   * Show typing to `sender` until stop(). Already running for them = no-op,
   * except right after a reply: a new message from them means more work, so
   * the indicator comes back at once.
   */
  start(sender: string): void {
    if (this.sender === sender && (this.timer !== undefined || this.busy)) {
      this.noteWorking(sender);
      return;
    }
    if (this.sender !== undefined && this.sender !== sender) this.stop();
    this.sender = sender;
    this.failures = 0;
    this.quiet = false;
    this.schedule(0);
  }

  /**
   * A message just reached the phone: take the indicator down now. Waiting for
   * WeChat to clear it on arrival left it up until the turn ended, and the turn
   * always has one more model call to go. It stays down for the quiet window
   * unless noteWorking/start says the bot is busy again.
   */
  noteDelivered(sender: string): void {
    if (this.sender !== sender) return;
    this.deliveries += 1;
    this.quiet = true;
    if (this.shown) {
      this.shown = false;
      void this.send(sender, TypingStatus.CANCEL);
    }
    this.schedule(this.quietMs);
  }

  /**
   * The bot started real work after a reply (a tool call other than talking to
   * the user): show typing again now instead of after the quiet window.
   */
  noteWorking(sender: string): void {
    if (this.sender !== sender || !this.quiet) return;
    this.quiet = false;
    if (!this.busy) this.schedule(0);
  }

  stop(): void {
    const sender = this.sender;
    this.clearTimer();
    this.sender = undefined;
    this.quiet = false;
    if (sender !== undefined && this.shown) void this.send(sender, TypingStatus.CANCEL);
    this.shown = false;
  }

  dispose(): void {
    this.stop();
  }

  /** Whether the indicator is running for anyone (for tests and logs). */
  get activeFor(): string | undefined {
    return this.sender;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    const timer = setTimeout(() => { void this.tick(); }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    const sender = this.sender;
    if (sender === undefined) return;
    this.timer = undefined;
    this.busy = true;
    try {
      await this.step(sender);
    } finally {
      this.busy = false;
    }
    if (this.sender === sender && this.timer === undefined && this.failures < MAX_FAILURES) {
      this.schedule(this.keepaliveMs);
    }
  }

  private async step(sender: string): Promise<void> {
    if (this.deps.isWaitingFor(sender)) {
      if (this.shown) {
        this.shown = false;
        await this.send(sender, TypingStatus.CANCEL);
      }
    } else {
      const before = this.deliveries;
      const ok = await this.send(sender, TypingStatus.TYPING);
      // stop() may have run while the request was in flight: take it back down.
      if (this.sender !== sender) {
        if (ok) void this.send(sender, TypingStatus.CANCEL);
        return;
      }
      // A reply landed while it was in flight: the TYPING may reach WeChat after
      // the reply's CANCEL, so cancel once more.
      if (ok && this.deliveries !== before) {
        void this.send(sender, TypingStatus.CANCEL);
        return;
      }
      if (ok) {
        this.shown = true;
        this.quiet = false;
      }
    }
  }

  /** One sendtyping request; returns whether it went through. */
  private async send(sender: string, status: number): Promise<boolean> {
    const account = this.deps.getAccount();
    if (!account?.token) return false;
    const ticket = await this.ticketFor(sender, account);
    if (ticket === undefined) {
      this.failures += 1;
      return false;
    }
    try {
      await this.api.sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: { ilink_user_id: sender, typing_ticket: ticket, status },
        timeoutMs: 5_000,
      });
      this.failures = 0;
      return true;
    } catch (err) {
      this.failures += 1;
      // A stale ticket is the likely cause: fetch a fresh one next time.
      this.tickets.delete(sender);
      logger.debug(`typing: ${status === TypingStatus.TYPING ? "typing" : "cancel"} failed (${this.failures}): ${String(err)}`);
      return false;
    }
  }

  private async ticketFor(sender: string, account: TypingAccount): Promise<string | undefined> {
    const now = Date.now();
    const cached = this.tickets.get(sender);
    if (cached !== undefined && now < cached.nextFetchAt) return cached.ticket || undefined;
    try {
      const resp = await this.api.getConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: sender,
        contextToken: this.deps.getContextToken(sender) || undefined,
        timeoutMs: 5_000,
      });
      const ticket = resp.ret === undefined || resp.ret === 0 ? resp.typing_ticket ?? "" : "";
      // Spread refreshes over the day, like the official channel does.
      this.tickets.set(sender, {
        ticket,
        nextFetchAt: now + (ticket ? Math.random() * TICKET_TTL_MS : TICKET_RETRY_MS),
      });
      return ticket || undefined;
    } catch (err) {
      this.tickets.set(sender, { ticket: "", nextFetchAt: now + TICKET_RETRY_MS });
      logger.debug(`typing: getconfig failed: ${String(err)}`);
      return undefined;
    }
  }
}
