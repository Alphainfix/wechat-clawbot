/**
 * Weixin account credential storage for the vendored iLink protocol layer.
 *
 * Adapted from `@tencent-weixin/openclaw-weixin` (MIT) `src/auth/accounts.ts`:
 * the OpenClaw config dependency is replaced by a plain per-account JSON store
 * under the DSH ClawBot state directory, keeping the same public surface so
 * the vendored protocol code compiles unchanged.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../storage/state-dir.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Bot agent string sent to the iLink server; overridable via {@link setBotAgent}. */
let botAgent = "DSH-ClawBot/0.1.0";

/** Configure the `bot_agent` value reported in every iLink request. */
export function setBotAgent(agent: string | undefined): void {
  if (agent?.trim()) botAgent = agent.trim();
}

/**
 * Normalize a raw account id (`xxx@im.bot`) to a filesystem-safe form
 * (`xxx-im-bot`). Mirrors OpenClaw's `normalizeAccountId`.
 */
export function normalizeAccountId(raw: string): string {
  return raw.trim().replace(/[@.]/g, "-").replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * Derive the legacy raw account id from a normalized one, when applicable.
 * `b0f5860fdecb-im-bot` → `b0f5860fdecb@im.bot`.
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID (normalized or raw). */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }

  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Remove all files associated with an account. */
export function clearWeixinAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const accountFiles = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of accountFiles) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore
    }
  }
}

/** List account ids present in the state directory. */
export function listIndexedWeixinAccountIds(): string[] {
  const dir = resolveAccountsDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".sync.json") && !f.endsWith(".context-tokens.json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((id) => !id.endsWith(".tmp"));
  } catch {
    return [];
  }
}

/** Register an account id (no-op: ids are discovered from the directory). */
export function registerWeixinAccountId(_accountId: string): void {
  // nothing to do — the store is directory-scanned
}

/** Unregister an account id (no-op, see {@link registerWeixinAccountId}). */
export function unregisterWeixinAccountId(_accountId: string): void {
  // nothing to do
}

/** Remove stored accounts whose `userId` matches and that are not in `keepIds`. */
export function clearStaleAccountsForUserId(userId: string, keepIds: string[]): void {
  const keep = new Set(keepIds);
  for (const id of listIndexedWeixinAccountIds()) {
    if (keep.has(id)) continue;
    const data = loadWeixinAccount(id);
    if (data?.userId === userId) clearWeixinAccount(id);
  }
}

/** Read the SKRouteTag for an account (unused by the DSH plugin; kept for API compat). */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}

/** Read the configured bot agent string for `base_info`. */
export function loadConfigBotAgent(): string | undefined {
  return botAgent;
}

/** Channel reload hook (kept for API compat; the DSH plugin reacts to file changes instead). */
export async function triggerWeixinChannelReload(): Promise<void> {
  // no-op
}

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been obtained via QR login. */
  configured: boolean;
  name?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

/** List account ids from the state directory. */
export function listWeixinAccountIds(): string[] {
  return listIndexedWeixinAccountIds();
}

/** Resolve a weixin account by ID, merging config and stored credentials. */
export function resolveWeixinAccount(accountId?: string | null): ResolvedWeixinAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("weixin: accountId is required (no default account)");
  }
  const id = normalizeAccountId(raw);

  const accountData = loadWeixinAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token,
    enabled: true,
    configured: Boolean(token),
    userId: accountData?.userId?.trim() || undefined,
  };
}
