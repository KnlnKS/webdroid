import { waitFor, type Strand } from "./suspend";

/** A lock is owned by the execution that can block: a thread as one call chain (a Strand), since
 *  chains interleave on a thread while another is suspended. A thread's root strand shares its
 *  locks with every chain of that thread. */
export interface Monitor {
  owner: Strand | null;
  depth: number;
  entrants: (() => void)[];
  waiters: (() => void)[];
}
const newMonitor = (): Monitor => ({ owner: null, depth: 0, entrants: [], waiters: [] });
/** whether `s` holds `m`: its owner, or the owner's thread as its root or another of its chains */
export const owns = (m: Monitor, s: Strand): boolean => {
  const o = m.owner;
  return o === s || o !== null && o.thread === s.thread && (o.root || s.root);
};
/** An object's monitor lives on the object as `$mon`, which compiled code loads at each monitor
 *  instruction (Runtime.me/mx) so that the load stays monomorphic. Non-enumerable, so clone() does
 *  not copy it. */
type Lockable = { $mon?: Monitor };
type Waiter = { strand: Strand; obj: object | string };

export class Monitors {
  private strings = new Map<string, Monitor>();
  /** executions parked on a contended enter, and what they wait for: the answer to "who holds the lock main wants" */
  private waiting = new Set<Waiter>();
  constructor(private exception: (name: string) => unknown) {}
  blocked(): { thread: unknown; obj: object | string; owner: unknown }[] {
    return [...this.waiting].map(({ strand, obj }) => ({ thread: strand.thread, obj, owner: this.get(obj).owner?.thread ?? null }));
  }
  isBlocked(thread: unknown): boolean {
    for (const w of this.waiting) if (w.strand.thread === thread) return true;
    return false;
  }

  private get(obj: object | string | null | 0): Monitor {
    if (obj == null || obj === 0) throw this.exception("NullPointerException");
    if (typeof obj !== "string") {
      return (obj as Lockable).$mon ?? (Object.defineProperty(obj, "$mon", { value: newMonitor() }) as Lockable).$mon!;
    }
    let monitor = this.strings.get(obj);
    if (!monitor) this.strings.set(obj, monitor = newMonitor());
    return monitor;
  }
  private owned(obj: object | string | null | 0, s: Strand): Monitor {
    const monitor = this.get(obj);
    if (!monitor.depth || !owns(monitor, s)) throw this.exception("IllegalMonitorStateException");
    return monitor;
  }
  enter(obj: object | string | null | 0, s: Strand): void | Promise<void> {
    const monitor = this.get(obj);
    if (!monitor.depth) { monitor.owner = s; monitor.depth = 1; return; }
    if (owns(monitor, s)) { monitor.depth++; return; }
    const waiter = { strand: s, obj: obj as object | string };
    this.waiting.add(waiter);
    return waitFor(s, monitor.owner!, new Promise((resolve) => monitor.entrants.push(() => {
      monitor.owner = s; monitor.depth = 1; this.waiting.delete(waiter); resolve();
    })));
  }
  exit(obj: object | string | null | 0, s: Strand): void {
    this.release(obj, this.owned(obj, s));
  }
  private release(obj: object | string | null | 0, monitor: Monitor): void {
    if (--monitor.depth) return;
    monitor.owner = null;
    if (monitor.entrants.length) monitor.entrants.shift()!();
    if (typeof obj === "string" && !monitor.depth && !monitor.waiters.length) this.strings.delete(obj);
  }
  holds(obj: object | string | null | 0, s: Strand): boolean {
    const monitor = this.get(obj);
    return !!monitor.depth && owns(monitor, s);
  }
  notify(obj: object | string | null | 0, s: Strand, all: boolean): void {
    const monitor = this.owned(obj, s);
    for (const wake of monitor.waiters.splice(0, all ? monitor.waiters.length : 1)) wake();
  }
  async wait(obj: object | string | null | 0, s: Strand, park: (arm: (wake: () => void) => () => void) => Promise<boolean>): Promise<void> {
    const monitor = this.owned(obj, s), depth = monitor.depth, owner = monitor.owner!;
    const parked = park((wake) => {
      monitor.waiters.push(wake);
      return () => { const i = monitor.waiters.indexOf(wake); if (i >= 0) monitor.waiters.splice(i, 1); };
    });
    monitor.depth = 1;
    this.release(obj, monitor);
    try { await parked; }
    finally {
      const entered = this.enter(obj, owner);
      if (entered) await entered;
      this.get(obj).depth = depth;
    }
  }
}
