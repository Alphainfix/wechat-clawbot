/**
 * Subagent model policy for the WeChat agent: every subagent delegated from
 * the WeChat session (directly or transitively) runs with max thinking
 * (reasoningEffort=max) on deepseek-flash, so that complex/deep tasks the
 * user delegates still get full reasoning even though the main WeChat
 * conversation runs with reasoningEffort=off for fast replies.
 *
 * Implementation: `agent/created` is emitted for every live agent (children
 * included); each child's session header carries `parentSession`, so we can
 * tell whether it descends from the WeChat session. For those children we
 * install a model selection (provider/model/reasoningEffort=max) via
 * `installModelSelection`, which couples prompt assembly and request routing
 * on the child's scope.
 */
import type { Context } from "@deepseek-ai/cordis";

import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { logger } from "./ilink/util/logger.js";

export type SubagentModelPolicy = {
  /** The WeChat session id whose subagents get the policy. */
  sessionId: string;
  provider: string;
  model: string;
  /** "max" = full thinking (deepseek v4 flash supports off|high|max). */
  reasoningEffort: string;
};

/** Install the policy: listen for child agents of the WeChat session. */
export function registerSubagentModelPolicy(ctx: Context, policy: SubagentModelPolicy): void {
  // 0.1.7 widened the payload to `{ agent, source, signal? }` and types `agent`
  // as the real Agent; a hand-narrowed parameter no longer fits. Let the event
  // map type it and read only what this policy needs.
  ctx.on("agent/created", ({ agent }): undefined => {
    try {
      const parentSession = agent.session?.header?.parentSession;
      if (String(parentSession) !== String(policy.sessionId)) return undefined;
      // Only children created at or below this session; if a descendant of
      // the child exists it inherits this selection through its own
      // parentSession chain anyway (each level is its own agent/created).
      const selection = {
        current: {
          provider: policy.provider,
          model: policy.model,
          reasoningEffort: ReasoningEffortId(policy.reasoningEffort),
        },
        assembled: undefined,
      };
      installModelSelection(agent.ctx, selection);
      logger.info(
        `subagent-model: wechat subagent ${String(agent.id)} -> ${policy.provider}/${policy.model} reasoningEffort=${policy.reasoningEffort}`,
      );
    } catch (err) {
      logger.warn(`subagent-model: install failed: ${String(err)}`);
    }
    return undefined;
  });
}
