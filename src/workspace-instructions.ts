/**
 * Optionally keep DSH's workspace instruction files (AGENTS.md / CLAUDE.md)
 * out of the WeChat session.
 *
 * The host's agent-instructions plugin splices a directory's instruction file
 * into the conversation the first time a tool touches a file there — and the
 * WHOLE file again every time it changes afterwards. A long developer notebook
 * kept for a coding agent (30–40k characters) is the bad case: the bot runs one
 * script in that project, then every later edit of the notebook — none of them
 * the bot's business — adds another full copy, and in a long-lived chat
 * ~140k characters end up riding along on every request.
 *
 * Off by config (`workspaceInstructions: false`), this session gets none of it;
 * the owner keeps the knowledge on demand instead (e.g. a memory.md line telling
 * the bot to read the relevant section before working there). On by default,
 * because for someone else an AGENTS.md in the bot's working directory may be
 * exactly how they instruct their bot. Other sessions (web, subagents) are
 * never touched.
 *
 * Mechanism: an outermost `agent/pre-step` listener (`prepend`) runs after the
 * agent-instructions listener and drops its messages — the ones it spliced into
 * this step and the ones it parked in the next-step inbox. Best effort: any
 * surprise leaves the host's decision exactly as it was.
 */
import type { Context } from "@deepseek-ai/cordis";
import { logger } from "./ilink/util/logger.js";

type SourceCarrier = { id?: unknown; source?: { kind?: unknown; changes?: unknown } };

/** A message the host's agent-instructions plugin produced. */
export function isWorkspaceInstructions(message: unknown): boolean {
  return (message as SourceCarrier | null)?.source?.kind === "agent-instructions";
}

/** The instruction files a message carries, for the log line (no content). */
function scopesOf(message: SourceCarrier): string[] {
  const changes = Array.isArray(message.source?.changes) ? message.source.changes : [];
  return changes
    .map((c) => (typeof (c as { scope?: unknown }).scope === "string" ? (c as { scope: string }).scope.replace(/\u0000/g, "/") : ""))
    .filter((s) => s.length > 0);
}

type Inbox = { nextStep?: readonly SourceCarrier[]; remove?: (id: unknown) => unknown };
type Decision = { kind?: unknown; messages?: unknown };

/**
 * Remove workspace-instruction messages from one pre-step decision and from the
 * agent's next-step inbox. Returns the decision to use and what was dropped.
 */
export function stripWorkspaceInstructions(
  agent: { inbox?: Inbox },
  decision: Decision,
): { decision: Decision; dropped: string[] } {
  const dropped: string[] = [];
  const inbox = agent.inbox;
  if (inbox?.nextStep !== undefined && typeof inbox.remove === "function") {
    for (const message of inbox.nextStep.filter(isWorkspaceInstructions)) {
      inbox.remove(message.id);
      dropped.push(...scopesOf(message));
    }
  }
  if (decision.kind === "reject" || !Array.isArray(decision.messages)) return { decision, dropped };
  const kept = (decision.messages as SourceCarrier[]).filter((m) => {
    if (!isWorkspaceInstructions(m)) return true;
    dropped.push(...scopesOf(m));
    return false;
  });
  if (kept.length === decision.messages.length) return { decision, dropped };
  return { decision: { ...decision, messages: kept }, dropped };
}

type PreStepArgs = { agent?: { id?: unknown; inbox?: Inbox } };

/**
 * Install the filter. `shouldStrip(agentId)` decides per step, so the config
 * switch takes effect on the next step without a restart.
 */
export function registerWorkspaceInstructionsFilter(
  ctx: Context,
  shouldStrip: (agentId: string) => boolean,
): void {
  const on = ctx.on as unknown as (
    name: string,
    listener: (args: PreStepArgs, next: () => Promise<Decision>) => Promise<Decision>,
    options: { prepend: boolean },
  ) => unknown;
  let lastLogged = "";
  on.call(ctx, "agent/pre-step", async (args, next) => {
    const decision = await next();
    try {
      const agent = args?.agent;
      if (agent === undefined || typeof agent.id !== "string" || !shouldStrip(agent.id)) return decision;
      const result = stripWorkspaceInstructions(agent, decision);
      if (result.dropped.length > 0) {
        const files = [...new Set(result.dropped)].join(", ") || "(unnamed)";
        if (files !== lastLogged) {
          lastLogged = files;
          logger.info(`workspace-instructions: kept ${files} out of the WeChat session (workspaceInstructions: false)`);
        }
      }
      return result.decision;
    } catch (err) {
      logger.warn(`workspace-instructions: filter skipped: ${String(err)}`);
      return decision;
    }
  }, { prepend: true });
}
