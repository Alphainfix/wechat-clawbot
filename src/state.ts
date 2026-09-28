/**
 * State persistence helpers for the DSH plugin side (context tokens, session
 * marker, file watching). Credentials and sync buffers live in the vendored
 * `ilink/storage` layer under the same state directory.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./ilink/storage/state-dir.js";
import { logger } from "./ilink/util/logger.js";

/** Directory holding per-account runtime data (context tokens etc.). */
export function accountsRuntimeDir(accountId: string): string {
  return path.join(resolveStateDir(), "accounts");
}

export function contextTokensPath(accountId: string): string {
  return path.join(accountsRuntimeDir(accountId), `${accountId}.context-tokens.json`);
}

type ContextTokensFile = {
  /** WeChat user id → last seen context token from inbound messages. */
  tokens?: Record<string, string>;
};

/**
 * Normalize peer ids for context-token keys: OpenClaw (and the iLink server)
 * can supply the same peer id with mixed case, so lookups must be
 * case-insensitive (sync from openclaw-weixin 3.1.0).
 */
function tokenKey(userId: string): string {
  return userId.toLowerCase();
}

/**
 * Read the stored context token for a sender (empty string when absent).
 * Falls back to a case-insensitive scan so tokens persisted by pre-3.1.0
 * builds (mixed-case keys) keep working after the normalization upgrade.
 */
export function loadContextToken(accountId: string, userId: string): string {
  try {
    const raw = fs.readFileSync(contextTokensPath(accountId), "utf-8");
    const data = JSON.parse(raw) as ContextTokensFile;
    const tokens = data.tokens ?? {};
    const hit = tokens[tokenKey(userId)];
    if (hit) return hit;
    const lower = userId.toLowerCase();
    for (const key of Object.keys(tokens)) {
      if (key.toLowerCase() === lower) return tokens[key];
    }
    return "";
  } catch {
    return "";
  }
}

/** Persist a sender's latest context token. */
export function saveContextToken(accountId: string, userId: string, token: string): void {
  if (!token) return;
  try {
    let data: ContextTokensFile = {};
    try {
      data = JSON.parse(fs.readFileSync(contextTokensPath(accountId), "utf-8")) as ContextTokensFile;
    } catch {
      // fresh file
    }
    data.tokens = { ...(data.tokens ?? {}), [tokenKey(userId)]: token };
    fs.mkdirSync(accountsRuntimeDir(accountId), { recursive: true });
    const tmp = `${contextTokensPath(accountId)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, contextTokensPath(accountId));
  } catch (err) {
    logger.warn(`saveContextToken: failed userId=${userId} err=${String(err)}`);
  }
}

/** Path of the marker recording that we created the WeChat session. */
export function sessionMarkerPath(sessionId: string): string {
  return path.join(resolveStateDir(), "sessions", `${sessionId}.json`);
}

/** Whether the WeChat session was previously created by this plugin. */
export function wasSessionCreated(sessionId: string): boolean {
  try {
    return fs.existsSync(sessionMarkerPath(sessionId));
  } catch {
    return false;
  }
}

/** Record that the WeChat session was created by this plugin. */
export function markSessionCreated(sessionId: string): void {
  try {
    const p = sessionMarkerPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ created: true, at: new Date().toISOString() }, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`markSessionCreated: failed sessionId=${sessionId} err=${String(err)}`);
  }
}

export type StateWatcher = {
  close(): void;
};

/**
 * Watch the ClawBot state directory for account credential changes made by
 * the `clawbot` CLI while the profile is running (login/logout). Callbacks
 * are debounced to collapse rename-then-write sequences.
 */
export function watchAccountStore(onChange: () => void): StateWatcher {
  const dir = resolveStateDir();
  const accountsDir = path.join(dir, "accounts");
  try {
    fs.mkdirSync(accountsDir, { recursive: true });
  } catch {
    // ignore
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        onChange();
      } catch (err) {
        logger.warn(`watchAccountStore: onChange failed err=${String(err)}`);
      }
    }, 500);
  };
  const watchers: fs.FSWatcher[] = [];
  for (const target of [dir, accountsDir]) {
    try {
      const w = fs.watch(target, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (name.endsWith(".json")) schedule();
      });
      watchers.push(w);
    } catch (err) {
      logger.warn(`watchAccountStore: cannot watch ${target} err=${String(err)}`);
    }
  }
  return {
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
