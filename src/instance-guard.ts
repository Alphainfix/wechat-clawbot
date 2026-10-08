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
 */
const KEY = Symbol.for("wechat-clawbot/active-instance");

type Holder = { readonly id: number; readonly stop: (reason: string) => Promise<void> };
type Slot = { seq: number; active?: Holder };

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (g[KEY] ??= { seq: 0 });
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
  const previous = s.active;
  s.active = me;
  const ready = previous === undefined
    ? Promise.resolve()
    : Promise.resolve()
      .then(() => previous.stop(`superseded by instance #${me.id}`))
      .catch(() => undefined);
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
