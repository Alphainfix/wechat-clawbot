/**
 * Messages that arrive while the bot is working: answered together, without
 * making anyone wait. Modelled on Claude Code, which has two ways to send a
 * message mid-turn:
 *
 * - Enter queues it. The current request finishes, any tool it chose runs, and
 *   the message is handed to the model with the next tool result ("this round
 *   finishes, then it thinks again"). The bot does this through DSH's `steer`.
 * - Ctrl+Enter ("send now") cuts off a request that is still generating and
 *   starts over with the message.
 *
 * The owner chose a mix (2026-10-12), after measuring that finishing the first
 * round cost 4–7 s on two simple exchanges:
 *
 * 1. Interrupt the first round. While the bot is still on its first thought
 *    (no tool called, nothing sent), a newer message from the same person
 *    cancels the turn and a new turn sees both. Nothing has happened yet that
 *    the cancel could cut short, so this is pure time saved. Images and files
 *    are taken up at once; nothing waits for a caption.
 *    The cancel waits until the host has written the first message into the
 *    history: the host takes a message out of the inbox before the step and
 *    records it only when the step starts, so cancelling in between loses it.
 * 2. Otherwise finish, then think again. Once the bot has called a tool, the
 *    message is steered in and read at the next step; a running tool is never
 *    killed.
 * 3. Read before replying. On WeChat the answer is itself a tool call
 *    (send_wechat_text, send_wechat_file, ask_user_question), so a reply chosen
 *    before a message arrived would go out without it. A reply tool holds while
 *    the recipient has a message the next step will read; its result says so,
 *    and the next step answers everything at once. A message still on its way
 *    (an image downloading) is waited for first, up to INCOMING_WAIT_MS.
 * 4. One prompt for what has not been picked up. While the bot's own message
 *    still waits in the agent's inbox (a restart settling, or compaction
 *    holding the agent), a newer one merges into it.
 */

/** Restarts allowed while answering one message, so a long burst still gets answered. */
export const MAX_RESTARTS = 3;

/** Replies held per turn; after that one goes out, so a long burst still gets answered. */
export const MAX_HOLDS = 3;

/** Added to a message that arrived before the bot answered: answer it together with the rest. */
export const TOGETHER_HINT = "（对方在你回复之前又发来了上面这些。请连同之前的消息一起考虑，一次回复。）";

/** How long a reply tool waits for a message that is still downloading before it decides. */
export const INCOMING_WAIT_MS = 8_000;

/** What a held reply tool tells the model. */
export const HOLD_MESSAGE = "这条还没发出：对方刚又发来了新消息，你下一步就能看到。看完之后把要说的合在一起再发，别把这条原样重发。";

export type RestartState = {
  /** A turn the WeChat queue started is in progress (not a reminder or a web-UI turn). */
  wechatTurn: boolean;
  /** Who the running turn answers. */
  turnSender: string | undefined;
  /** Who just sent the newer message. */
  sender: string;
  /**
   * The host has written the running turn's message into the history, in the
   * very turn and step that are running now. Another turn the host runs in the
   * same driver (a reminder, a web-UI message) or a later step never counts,
   * so a restart can only cancel the step that is thinking about that message.
   */
  recorded: boolean;
  /** Tool calls the running turn has made so far; 0 = still on its first thought. */
  toolCalls: number;
  /** Restarts already made while answering this message. */
  restarts: number;
};

/** Whether a newer message should restart the running turn instead of being steered in. */
export function mayRestartTurn(s: RestartState): boolean {
  return s.wechatTurn
    && s.turnSender === s.sender
    && s.recorded
    && s.toolCalls === 0
    && s.restarts < MAX_RESTARTS;
}

/** Whether a reply must wait: the recipient wrote more, and the cap is not reached. */
export function shouldHoldReply(s: { unread: boolean; holds: number }): boolean {
  return s.unread && s.holds < MAX_HOLDS;
}
