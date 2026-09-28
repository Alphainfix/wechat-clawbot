/**
 * Approval relay: forwards `approval/request` questions for WeChat-owned
 * agents into WeChat and maps the user's reply back to an approval outcome.
 *
 * Follows the ACP-bridge pattern: the listener only answers requests whose
 * agent belongs to the WeChat session and delegates everything else with
 * `next()`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";

import type { ClawbotConfig } from "./config.js";
import type { WechatBridge } from "./bridge.js";
import { PendingRegistry } from "./pending.js";
import { logger } from "./ilink/util/logger.js";

// NOTE: no \b word boundaries here — JS \b does not match CJK text, so
// "同意" would never match a pattern like /^同意\b/.
const YES_RE = /^(同意|允许|批准|确认|可以|好的?|是|yes|y|ok|allow|approve)$/i;
const NO_RE = /^(拒绝|不同意|不允许|不行|不要|否|no|n|reject|deny)$/i;

function parseApprovalReply(text: string): "yes" | "no" {
  // Trim and strip trailing punctuation before matching.
  const trimmed = text.trim().replace(/[\s，。！!？?,.、；;：:]+$/g, "");
  if (YES_RE.test(trimmed)) return "yes";
  if (NO_RE.test(trimmed)) return "no";
  // Anything else is treated as a rejection (fail closed).
  return "no";
}

export class ApprovalRelay {
  private readonly config: ClawbotConfig;
  private readonly getBridge: () => WechatBridge | null;
  private readonly pending: PendingRegistry;
  private readonly sendText: (to: string, text: string) => Promise<void>;

  constructor(deps: {
    config: ClawbotConfig;
    /** Returns the live bridge, or null while the monitor is not running. */
    getBridge: () => WechatBridge | null;
    pending: PendingRegistry;
    sendText: (to: string, text: string) => Promise<void>;
  }) {
    this.config = deps.config;
    this.getBridge = deps.getBridge;
    this.pending = deps.pending;
    this.sendText = deps.sendText;
  }

  /** Register the `approval/request` waterfall listener on the root context. */
  register(ctx: Context): void {
    ctx.on("approval/request", (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) =>
      this.answer(req, next),
    );
  }

  private async answer(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const bridge = this.getBridge();
    if (!bridge || !bridge.isWechatSession(req.agent.id)) {
      return next();
    }
    const sender = bridge.activeSender;
    if (!sender) {
      logger.warn(`approval: no active WeChat sender for agent ${req.agent.id}; failing closed`);
      return "unavailable";
    }

    const question =
      `【DSH 权限请求】\n` +
      `工具: ${req.toolName}\n` +
      `原因: ${req.reason ?? "(未提供)"}\n` +
      `请回复：同意 / 拒绝`;

    try {
      await this.sendText(sender, question);
    } catch (err) {
      logger.error(`approval: failed to send question to ${sender}: ${String(err)}`);
      return "unavailable";
    }

    return new Promise<ApprovalOutcome>((resolveOutcome) => {
      let settled = false;
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        resolveOutcome(outcome);
      };

      const answer: { tag: string; sender: string; resolve: (reply: string | null) => void } = {
        tag: "approval",
        sender,
        resolve: (reply) => {
          if (reply === null) {
            settle("cancelled");
            return;
          }
          const decision = parseApprovalReply(reply);
          void this.sendText(sender, decision === "yes" ? "已批准。" : "已拒绝。").catch(() => {});
          settle(decision === "yes" ? "allowed-once" : "rejected");
        },
      };
      this.pending.push(answer);

      // Withdraw the question when the requesting turn is aborted.
      req.signal?.addEventListener(
        "abort",
        () => {
          answer.resolve(null);
        },
        { once: true },
      );

      if (this.config.approvalTimeoutMs > 0) {
        setTimeout(() => {
          answer.resolve(null);
        }, this.config.approvalTimeoutMs).unref?.();
      }
    });
  }
}
