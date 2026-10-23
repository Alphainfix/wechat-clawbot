/**
 * Keep the host's clock readings out of the WeChat session (DSH 0.2.1+).
 *
 * DSH 0.2.1 put `dsh-time-context` into the standard agent preset, which this
 * plugin mounts for the WeChat agent. At most every ten minutes it appends a
 * user-role reading: the current time, the browser time zone of the request,
 * and the time since the last message. A WeChat message has no browser time
 * zone, so the reading always says "Browser time zone for this request:
 * unavailable. Ask the user to clarify otherwise-unqualified dates and times."
 * The bot would start asking which zone "明天下午三点" means — right where it
 * sets reminders and calendar events. The WeChat session already has its
 * clock: every inbound message carries [微信消息 MM-DD HH:mm], and the prompt
 * has today's date. Web sessions keep the readings.
 *
 * The reading is added by a `prepend` pre-step listener that the preset mounts
 * in the agent's scope. Listeners run outermost-first and `prepend` puts a
 * listener at the front, so the one registered last is outermost: a filter
 * registered when this plugin starts would run inside the clock and never see
 * the reading. This one is registered on the WeChat agent's scope after its
 * preset is mounted (bridge.ts ensureTools), which puts it outside.
 */
import type { Context } from "@deepseek-ai/cordis";
import { lateScheduleNote } from "./backlog.js";
import { logger } from "./ilink/util/logger.js";

/** The source kind dsh-time-context gives its readings. */
export const TIME_CONTEXT_KIND = "time-context";

type SourceCarrier = { source?: { kind?: unknown } };
type Decision = { kind?: unknown; messages?: unknown };
type PreStepArgs = { agent?: { id?: unknown } };

export function isClockReading(message: unknown): boolean {
  return (message as SourceCarrier | null)?.source?.kind === TIME_CONTEXT_KIND;
}

/** One pre-step decision without clock readings, and how many it had. */
export function stripClockReadings(decision: Decision): { decision: Decision; dropped: number } {
  if (decision.kind === "reject" || !Array.isArray(decision.messages)) return { decision, dropped: 0 };
  const kept = (decision.messages as unknown[]).filter((message) => !isClockReading(message));
  const dropped = decision.messages.length - kept.length;
  return dropped === 0 ? { decision, dropped } : { decision: { ...decision, messages: kept }, dropped };
}

/**
 * Register the filter on the WeChat agent's scope; call it after the agent's
 * preset is mounted. Returns the listener's disposer (or whatever the host
 * returns). Best effort: any surprise leaves the host's decision as it was.
 */
export function registerClockReadingFilter(agentCtx: Context, isWechat: (agentId: string) => boolean): unknown {
  const on = agentCtx.on as unknown as (
    name: string,
    listener: (args: PreStepArgs, next: () => Promise<Decision>) => Promise<Decision>,
    options: { prepend: boolean },
  ) => unknown;
  let logged = false;
  return on.call(agentCtx, "agent/pre-step", async (args, next) => {
    const decision = await next();
    try {
      const id = args?.agent?.id;
      if (typeof id !== "string" || !isWechat(id)) return decision;
      const result = stripClockReadings(decision);
      if (result.dropped > 0 && !logged) {
        logged = true;
        logger.info("time-context: kept the host's clock reading out of the WeChat session (no browser time zone there; messages carry their own time)");
      }
      return result.decision;
    } catch (err) {
      logger.warn(`time-context: filter skipped: ${String(err)}`);
      return decision;
    }
  }, { prepend: true });
}

type TextCarrier = { source?: { kind?: unknown; plugin?: unknown }; content?: ReadonlyArray<{ type?: string; text?: string }> };

/**
 * One pre-step decision with a line after each scheduled message that came on
 * a later day than it was due (backlog.ts lateScheduleNote). In the same step,
 * so the model has the dates before its first call; `make` builds the message.
 */
export function withLateScheduleNotes(decision: Decision, make: (text: string) => unknown, now: Date = new Date()): { decision: Decision; added: number } {
  if (decision.kind === "reject" || !Array.isArray(decision.messages)) return { decision, added: 0 };
  const out: unknown[] = [];
  let added = 0;
  for (const message of decision.messages as TextCarrier[]) {
    out.push(message);
    if (message?.source?.kind !== "schedule" && message?.source?.plugin !== "schedule") continue;
    const text = (message.content ?? []).map((b) => (b.type === "text" ? b.text ?? "" : "")).join("\n");
    const note = lateScheduleNote(text, now);
    if (note === undefined) continue;
    out.push(make(note));
    added += 1;
  }
  return added === 0 ? { decision, added } : { decision: { ...decision, messages: out }, added };
}

/**
 * Register the late-delivery line on the WeChat agent's scope (next to the clock
 * filter). Returns the listener's disposer. Best effort: any surprise leaves the
 * host's decision as it was.
 */
export function registerLateScheduleNotes(agentCtx: Context, isWechat: (agentId: string) => boolean, make: (text: string) => unknown): unknown {
  const on = agentCtx.on as unknown as (
    name: string,
    listener: (args: PreStepArgs, next: () => Promise<Decision>) => Promise<Decision>,
    options: { prepend: boolean },
  ) => unknown;
  return on.call(agentCtx, "agent/pre-step", async (args, next) => {
    const decision = await next();
    try {
      const id = args?.agent?.id;
      if (typeof id !== "string" || !isWechat(id)) return decision;
      const result = withLateScheduleNotes(decision, make);
      if (result.added > 0) logger.info("schedule: a scheduled message came on a later day than it was due; told the bot which day it meant");
      return result.decision;
    } catch (err) {
      logger.warn(`schedule: late-delivery line skipped: ${String(err)}`);
      return decision;
    }
  }, { prepend: true });
}
