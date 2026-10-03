import { currentStrand } from "./suspend";

/** A lock is owned by the execution that can block: a thread as one call chain (suspend.ts's
 *  strand), since chains interleave on a thread while another is suspended. Chain 0 (Java no entry
 *  gave an identity, as in host tools) shares its thread's locks with every chain of that thread. */
export interface Monitor {
  owner: unknown;
  strand: number;
  depth: number;
  entrants: (() => void)[];
  waiters: (() => void)[];
}
const newMonitor = (): Monitor => ({ owner: null, strand: 0, depth: 0, entrants: [], waiters: [] });
/** whether chain `s` of the owning thread holds `m` */
const chainHolds = (m: Monitor, s: number): boolean => m.strand === s || m.strand === 0 || s === 0;
/** An object's monitor lives on the object as `$mon`, which compiled code loads at each monitor
 *  instruction (Runtime.me/mx) so that the load stays monomorphic. Non-enumerable, so clone() does
 *  not copy it. */
type Lockable = { $mon?: Monitor };
type Waiter = { thread: unknown; obj: object | string };

export class Monitors {
  private strings = new Map<string, Monitor>();
  /** executions parked on a contended enter, and what they wait for: the answer to "who holds the lock main wants" */
  private waiting = new Set<Waiter>();
  constructor(private exception: (name: string) => unknown) {}
  blocked(): { thread: unknown; obj: object | string; owner: unknown }[] {
    return [...this.waiting].map(({ thread, obj }) => ({ thread, obj, owner: this.get(obj).owner }));
  }
  isBlocked(thread: unknown): boolean {
    for (const w of this.waiting) if (w.thread === thread) return true;
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
  private owned(obj: object | string | null | 0, thread: unknown): Monitor {
    const monitor = this.get(obj);
    if (!monitor.depth || monitor.owner !== thread || !chainHolds(monitor, currentStrand())) throw this.exception("IllegalMonitorStateException");
    return monitor;
  }
  enter(obj: object | string | null | 0, thread: unknown, s = currentStrand()): void | Promise<void> {
    const monitor = this.get(obj);
    if (!monitor.depth) { monitor.owner = thread; monitor.strand = s; monitor.depth = 1; return; }
    if (monitor.owner === thread && chainHolds(monitor, s)) { monitor.depth++; return; }
    const waiter = { thread, obj: obj as object | string };
    this.waiting.add(waiter);
    return new Promise((resolve) => monitor.entrants.push(() => {
      monitor.owner = thread; monitor.strand = s; monitor.depth = 1; this.waiting.delete(waiter); resolve();
    }));
  }
  exit(obj: object | string | null | 0, thread: unknown): void {
    this.release(obj, this.owned(obj, thread));
  }
  private release(obj: object | string | null | 0, monitor: Monitor): void {
    if (--monitor.depth) return;
    monitor.owner = null;
    if (monitor.entrants.length) monitor.entrants.shift()!();
    if (typeof obj === "string" && !monitor.depth && !monitor.waiters.length) this.strings.delete(obj);
  }
  holds(obj: object | string | null | 0, thread: unknown): boolean {
    const monitor = this.get(obj);
    return !!monitor.depth && monitor.owner === thread && chainHolds(monitor, currentStrand());
  }
  notify(obj: object | string | null | 0, thread: unknown, all: boolean): void {
    const monitor = this.owned(obj, thread);
    for (const wake of monitor.waiters.splice(0, all ? monitor.waiters.length : 1)) wake();
  }
  async wait(obj: object | string | null | 0, thread: unknown, park: (arm: (wake: () => void) => () => void) => Promise<boolean>): Promise<void> {
    const monitor = this.owned(obj, thread), depth = monitor.depth, s = monitor.strand;
    const parked = park((wake) => {
      monitor.waiters.push(wake);
      return () => { const i = monitor.waiters.indexOf(wake); if (i >= 0) monitor.waiters.splice(i, 1); };
    });
    monitor.depth = 1;
    this.release(obj, monitor);
    try { await parked; }
    finally {
      const entered = this.enter(obj, thread, s);
      if (entered) await entered;
      this.get(obj).depth = depth;
    }
  }
}
