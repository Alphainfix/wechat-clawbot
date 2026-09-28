/**
 * Minimal leveled logger for the vendored iLink protocol layer.
 *
 * Drop-in replacement for the OpenClaw-bound logger used by
 * `@tencent-weixin/openclaw-weixin`: same surface (`debug/info/warn/error`
 * plus `withAccount`), but writes to stderr with a simple level filter so the
 * protocol code can be vendored verbatim.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel =
  (process.env.CLAWBOT_LOG_LEVEL as LogLevel | undefined) ?? "info";

/** Change the global log level at runtime (e.g. from plugin config). */
export function setLogLevel(level: LogLevel): void {
  if (level in LEVEL_ORDER) currentLevel = level;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function format(level: LogLevel, account: string | undefined, args: unknown[]): string {
  const ts = new Date().toISOString();
  const tag = account ? `[clawbot:${account}]` : "[clawbot]";
  const body = args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  return `${ts} ${level.toUpperCase()} ${tag} ${body}`;
}

function safeStringify(value: unknown): string {
  try {
    if (value instanceof Error) return String(value);
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  withAccount(accountId: string): Logger;
}

export const logger: Logger = {
  debug(...args: unknown[]): void {
    if (enabled("debug")) process.stderr.write(format("debug", undefined, args) + "\n");
  },
  info(...args: unknown[]): void {
    if (enabled("info")) process.stderr.write(format("info", undefined, args) + "\n");
  },
  warn(...args: unknown[]): void {
    if (enabled("warn")) process.stderr.write(format("warn", undefined, args) + "\n");
  },
  error(...args: unknown[]): void {
    if (enabled("error")) process.stderr.write(format("error", undefined, args) + "\n");
  },
  withAccount(accountId: string): Logger {
    const scoped = (level: LogLevel) => (...args: unknown[]): void => {
      if (enabled(level)) process.stderr.write(format(level, accountId, args) + "\n");
    };
    return {
      debug: scoped("debug"),
      info: scoped("info"),
      warn: scoped("warn"),
      error: scoped("error"),
      withAccount: () => logger,
    };
  },
};
