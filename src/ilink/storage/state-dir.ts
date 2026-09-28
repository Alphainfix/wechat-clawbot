import os from "node:os";
import path from "node:path";

/**
 * Resolve the ClawBot state directory.
 *
 * Priority:
 *   1. `CLAWBOT_STATE_DIR` (explicit override)
 *   2. `$DSH_HOME/clawbot` (DeepSeek Harness home; `DSH_HOME` defaults to
 *      `~/.dsh`)
 *   3. `~/.dsh/clawbot` (fallback when DSH_HOME is unset)
 *
 * Kept as a drop-in replacement for the OpenClaw state-dir helper so the
 * vendored protocol code compiles unchanged.
 */
export function resolveStateDir(): string {
  const explicit = process.env.CLAWBOT_STATE_DIR?.trim();
  if (explicit) return explicit;
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "clawbot");
}
