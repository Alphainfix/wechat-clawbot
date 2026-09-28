/**
 * Local wall-clock helpers — the one place this plugin decides what "now" is.
 *
 * Every date this plugin writes or shows is the user's LOCAL date. That sounds
 * obvious and has been wrong twice, both times the same way: `toISOString()`
 * returns UTC, and after 20:00 local (US Eastern) UTC is already tomorrow. So a
 * memory entry appended at 22:31 on Aug 31 was stamped `[2026-09-01]`, and the
 * agent — which reads those stamps back — saw a fact dated in the future.
 *
 * Centralised so there is one function to get right rather than four call sites
 * to remember. If you need a date or a timestamp anywhere in this plugin, take
 * it from here; `new Date().toISOString().slice(0, 10)` is always a bug.
 */

/**
 * The user's zone. Not configurable for now: the machine running DSH is the
 * user's own machine, so the system zone IS the user's local time. A hardcoded
 * zone would leak where the author lives and be wrong for everyone else.
 */
export const USER_TIME_ZONE =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** `YYYY-MM-DD` for an instant, as seen in the user's zone. */
export function zonedDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * The calendar date `days` after `at`, in the user's zone.
 *
 * Steps the zoned calendar date rather than adding 24h, which would drift by an
 * hour across a DST boundary and, on the wrong day, land on the wrong date.
 */
export function zonedDatePlus(days: number, at: Date = new Date()): string {
  const [y, m, d] = zonedDate(at).split("-").map(Number);
  // Noon UTC: far enough from either midnight that no zone offset can push the
  // instant onto a neighbouring calendar day.
  return zonedDate(new Date(Date.UTC(y, m - 1, d + days, 12)));
}

/** Chinese weekday for a `YYYY-MM-DD` zoned date, e.g. `周一`. */
export function zonedWeekday(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

/** `MM-DD HH:mm` in the user's zone — the compact stamp inbound messages carry. */
export function zonedStamp(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** `HH:mm:ss` in the user's zone. */
export function zonedClock(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: USER_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);
}

/** Full Chinese date + time, for the prompt's clock line. */
export function zonedPretty(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: USER_TIME_ZONE,
    dateStyle: "full",
    timeStyle: "medium",
    hour12: false,
  }).format(at);
}
