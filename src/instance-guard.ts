/**
 * At most one live clawbot instance per process.
 *
 * When DSH reloads this plugin in place — a cold setting changed, or a hot code
 * reload — the old instance is supposed to be disposed first, which is what the
 * function `apply` returns is for. In practice its unload line has never once
 * appeared in the log: on 2026-10-07 two settings edits left three instances
 * running side by side, each with its own WeChat long-poll. Every message was
 * handled three times, and the stale instances' 「正在输入」 never stopped.
 *
 * So whatever the host does, a new instance takes over: it stops the previous
 * one (monitor, bridge, typing, Codex peer, account watcher) before starting its
 * own monitor. The slot lives on `globalThis`, so a re-imported module (HMR)
 * still finds the instance the old module started.
 *
 * The key does not depend on the package name (like clawbot.notify-wechat and
 * clawbot.calendar). It used to be "<package>/active-instance", so an instance
 * started under one package name was invisible to an instance started under
 * another: the owner's own install moved from the dev name to the public one,
 * and a public install upgraded in place from a version with the old key would
 * be the same. Slots under those old keys are still emptied and their holders
 * retired. The old names are built from parts because the release export
 * rewrites the literal.
 */
const KEY = Symbol.for("clawbot.active-instance");
const LEGACY_KEYS = [["dsh", "plugin", "clawbot"], ["wechat", "clawbot"]]
  .map((parts) => Symbol.for(`${parts.join("-")}/active-instance`));

type Holder = { readonly id: number; readonly stop: (reason: string) => Promise<void> };
type Slot = { seq: number; active?: Holder };

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (g[KEY] ??= { seq: 0 });
}

/** Empty the slots older versions used, returning whoever still held them. */
function takeLegacy(): Holder[] {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  const held: Holder[] = [];
  for (const key of LEGACY_KEYS) {
    const old = g[key];
    if (old?.active !== undefined) {
      held.push(old.active);
      old.active = undefined;
    }
  }
  return held;
}

export type InstanceClaim = {
  /** 1, 2, 3 … per process, for the logs. */
  readonly id: number;
  /** Still the live instance (no newer one has taken over). */
  isCurrent(): boolean;
  /** Settles once the previous instance has been stopped (never rejects). */
  readonly ready: Promise<void>;
  /** Give the slot up on our own disposal. */
  release(): void;
};

/**
 * Become the live instance. `stop` is what a newer instance calls to retire
 * this one; it must leave nothing running that talks to WeChat.
 */
export function claimInstance(stop: (reason: string) => Promise<void>): InstanceClaim {
  const s = slot();
  const me: Holder = { id: ++s.seq, stop };
  // The previous live instance, and any left in a slot an older version used.
  const previous = [s.active, ...takeLegacy()].filter((h): h is Holder => h !== undefined);
  s.active = me;
  const reason = `superseded by instance #${me.id}`;
  const ready = Promise.resolve().then(async () => {
    for (const holder of previous) await Promise.resolve().then(() => holder.stop(reason)).catch(() => undefined);
  });
  return {
    id: me.id,
    isCurrent: () => slot().active === me,
    ready,
    release: () => {
      const current = slot();
      if (current.active === me) current.active = undefined;
    },
  };
}
