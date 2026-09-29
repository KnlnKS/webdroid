interface Monitor {
  owner: unknown;
  depth: number;
  entrants: (() => void)[];
  waiters: (() => void)[];
}

export class Monitors {
  private objects = new WeakMap<object, Monitor>();
  private strings = new Map<string, Monitor>();
  /** threads parked on a contended enter, and what they wait for: the answer to "who holds the lock main wants" */
  private waiting = new Map<unknown, object | string>();
  constructor(private exception: (name: string) => unknown) {}
  blocked(): { thread: unknown; obj: object | string; owner: unknown }[] {
    return [...this.waiting].map(([thread, obj]) => ({ thread, obj, owner: this.get(obj).owner }));
  }
  isBlocked(thread: unknown): boolean { return this.waiting.has(thread); }

  private get(obj: object | string | null | 0): Monitor {
    if (obj == null || obj === 0) throw this.exception("NullPointerException");
    let monitor = typeof obj === "string" ? this.strings.get(obj) : this.objects.get(obj);
    if (!monitor) {
      monitor = { owner: null, depth: 0, entrants: [], waiters: [] };
      if (typeof obj === "string") this.strings.set(obj, monitor);
      else this.objects.set(obj, monitor);
    }
    return monitor;
  }
  private owned(obj: object | string | null | 0, thread: unknown): Monitor {
    const monitor = this.get(obj);
    if (!monitor.depth || monitor.owner !== thread) throw this.exception("IllegalMonitorStateException");
    return monitor;
  }
  enter(obj: object | string | null | 0, thread: unknown): void | Promise<void> {
    const monitor = this.get(obj);
    if (!monitor.depth || monitor.owner === thread) { monitor.owner = thread; monitor.depth++; return; }
    this.waiting.set(thread, obj as object | string);
    return new Promise((resolve) => monitor.entrants.push(() => { monitor.owner = thread; monitor.depth = 1; this.waiting.delete(thread); resolve(); }));
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
    return !!monitor.depth && monitor.owner === thread;
  }
  notify(obj: object | string | null | 0, thread: unknown, all: boolean): void {
    const monitor = this.owned(obj, thread);
    for (const wake of monitor.waiters.splice(0, all ? monitor.waiters.length : 1)) wake();
  }
  async wait(obj: object | string | null | 0, thread: unknown, park: (arm: (wake: () => void) => () => void) => Promise<boolean>): Promise<void> {
    const monitor = this.owned(obj, thread), depth = monitor.depth;
    const parked = park((wake) => {
      monitor.waiters.push(wake);
      return () => { const i = monitor.waiters.indexOf(wake); if (i >= 0) monitor.waiters.splice(i, 1); };
    });
    monitor.depth = 1;
    this.release(obj, monitor);
    try { await parked; }
    finally {
      const entered = this.enter(obj, thread);
      if (entered) await entered;
      this.get(obj).depth = depth;
    }
  }
}
