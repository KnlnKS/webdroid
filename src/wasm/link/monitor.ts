// Java monitors. The fast path is in the object header (compiler/j2w.ts menter/mexit): the high half of the header word is 0 for an
// unlocked object, strand id << 8 | count for a thin lock, and INFLATED | index for a monitor of this table. A lock another strand holds,
// a count past 255 or the first wait inflates it; an inflated monitor with no owner, entrants, waiters or pending re-entries is deflated
// when released. Waiting is cooperative: an entrant or a waiter is a promise the releasing or notifying strand resolves.
import type { Strand, ThreadRec } from "./sched.ts";
import { St } from "../compiler/hostcalls.ts";

const INFLATED = 0x80000000 | 0;
const THIN_MAX = 255;

/** the lock half of an object's header word */
export interface Header { lock(obj: object): number; setLock(obj: object, lock: number): void }
interface Entrant { strand: Strand; depth: number; go: () => void }
interface Waiter { strand: Strand; notify: () => void }
class Monitor {
  readonly index: number; readonly obj: object;
  owner: Strand | null = null;
  depth = 0;
  entrants: Entrant[] = [];
  waiters: Waiter[] = [];
  /** waiters that were woken and have not got the lock back yet: the monitor stays inflated for them */
  pending = 0;
  constructor(index: number, obj: object) { this.index = index; this.obj = obj; }
}

/** whether `s` holds what `owner` holds: the same strand, a strand that native code of the other entered Java on (the same thread, up the chain of `parent`s), or
 *  one of its thread's other strands when either is the thread's root (host code that enters Java outside any job shares the thread's locks) */
const owns = (owner: Strand | null | undefined, s: Strand): boolean => {
  if (owner === s) return true;
  if (!owner || owner.thread !== s.thread) return false;
  if (owner.root || s.root) return true;
  for (let p = s.parent; p; p = p.parent) if (p === owner) return true;
  for (let p = owner.parent; p; p = p.parent) if (p === s) return true;
  return false;
};

export class Monitors {
  private header: Header; private strands: (Strand | undefined)[]; private after: (ms: number, fn: () => void) => () => void;
  private table: (Monitor | undefined)[] = [];
  private free: number[] = [];
  /** the strand each id names, while it lives: a lock whose owner has ended is free */
  constructor(header: Header, strands: (Strand | undefined)[], after: (ms: number, fn: () => void) => () => void) { this.header = header; this.strands = strands; this.after = after; }

  private inflate(obj: object, owner: Strand | null, depth: number): Monitor {
    const index = this.free.pop() ?? this.table.length, m = new Monitor(index, obj);
    this.table[index] = m; m.owner = owner; m.depth = depth;
    this.header.setLock(obj, INFLATED | index);
    return m;
  }
  /** the monitor an inflated lock word names */
  private inflated(l: number): Monitor { return this.table[l & 0x7fffffff]!; }
  private thin(l: number): Strand | undefined { return this.strands[l >>> 8]; }
  private deflate(m: Monitor): void {
    if (m.owner || m.depth || m.entrants.length || m.waiters.length || m.pending) return;
    this.header.setLock(m.obj, 0); this.table[m.index] = undefined; this.free.push(m.index);
  }
  /** the monitor of `obj` as `s` holds it, inflating a thin lock; undefined when `s` does not hold it */
  private held(obj: object, s: Strand): Monitor | undefined {
    const l = this.header.lock(obj);
    if (l < 0) { const m = this.inflated(l); return owns(m.owner, s) ? m : undefined; }
    if (l === 0 || !owns(this.thin(l), s)) return undefined;
    return this.inflate(obj, s, l & 255);
  }

  /** enters at once when the lock is free or `s` holds it (the compiled fast path handled the thin cases it could); Block when `s` has to wait for another strand */
  tryEnter(obj: object, s: Strand): St {
    const l = this.header.lock(obj);
    if (l === 0) { this.header.setLock(obj, (s.id << 8) | 1); return St.Ok; }
    if (l > 0) {
      const o = this.thin(l);
      if (!o) { this.header.setLock(obj, (s.id << 8) | 1); return St.Ok; }
      if (owns(o, s)) { if ((l & 255) < THIN_MAX) this.header.setLock(obj, l + 1); else this.inflate(obj, o, THIN_MAX + 1); return St.Ok; }
      this.inflate(obj, o, l & 255);
      return s.sched.canWait(s) ? St.Block : St.Nbs;
    }
    const m = this.inflated(l);
    if (!m.owner) { m.owner = s; m.depth = 1; return St.Ok; }
    if (owns(m.owner, s)) { m.depth++; return St.Ok; }
    return s.sched.canWait(s) ? St.Block : St.Nbs;
  }
  /** waits for the owner of an inflated monitor to hand it over */
  enter(obj: object, s: Strand): Promise<void> {
    return this.queue(this.inflated(this.header.lock(obj)), s, 1);
  }
  private queue(m: Monitor, s: Strand, depth: number): Promise<void> {
    if (!m.owner) { m.owner = s; m.depth = depth; return Promise.resolve(); }
    s.waitsOn = m.owner;
    s.thread.blocked = true;
    return new Promise((go) => m.entrants.push({ strand: s, depth, go: () => { s.waitsOn = null; s.thread.blocked = false; go(); } }));
  }
  exit(obj: object, s: Strand): St {
    const l = this.header.lock(obj);
    if (l > 0) {
      if (!owns(this.thin(l), s)) return St.Imse;
      this.header.setLock(obj, (l & 255) === 1 ? 0 : l - 1);
      return St.Ok;
    }
    const m = l < 0 ? this.inflated(l) : undefined;
    if (!m || !owns(m.owner, s)) return St.Imse;
    if (--m.depth === 0) this.release(m);
    return St.Ok;
  }
  private release(m: Monitor): void {
    const e = m.entrants.shift();
    if (e) { m.owner = e.strand; m.depth = e.depth; e.go(); return; }
    m.owner = null;
    this.deflate(m);
  }
  /** whether a strand waits to enter a monitor a strand of `thread` holds */
  contended(thread: ThreadRec): boolean { return this.table.some((m) => m?.owner?.thread === thread && m.entrants.length > 0); }
  holds(obj: object, s: Strand): boolean {
    const l = this.header.lock(obj);
    return l > 0 ? owns(this.thin(l), s) : l < 0 && owns(this.inflated(l).owner, s);
  }
  notify(obj: object, s: Strand, all: boolean): St {
    const m = this.held(obj, s);
    if (!m) return St.Imse;
    for (const w of m.waiters.splice(0, all ? m.waiters.length : 1)) w.notify();
    this.deflate(m);
    return St.Ok;
  }
  /** Object.wait (and Thread.sleep, which waits on its thread's lock and is never notified): releases the monitor, waits for a notification, the
   *  timeout (`ms` of 0 is none unless `timed`) or an interrupt, and gets the monitor back with its count */
  wait(obj: object, s: Strand, ms: number, timed: boolean): Promise<St> | St {
    const m = this.held(obj, s);
    if (!m) return St.Imse;
    const th: ThreadRec = s.thread;
    if (th.interrupted) { th.interrupted = false; return St.Interrupted; }
    const depth = m.depth;
    return new Promise<St>((resolve) => {
      let done = false, cancel: (() => void) | null = null;
      const wake = (r: St) => {
        if (done) return;
        done = true; cancel?.(); th.wake = null; th.waiting = 0;
        const i = m.waiters.indexOf(waiter); if (i >= 0) m.waiters.splice(i, 1);
        m.pending++;
        void this.queue(m, s, depth).then(() => {
          m.pending--;
          if (r === St.Interrupted) th.interrupted = false;
          resolve(r);
        });
      };
      const waiter: Waiter = { strand: s, notify: () => wake(St.Ok) };
      if (timed || ms > 0) cancel = this.after(ms, () => wake(St.Ok));
      m.waiters.push(waiter);
      th.wake = () => wake(St.Interrupted);
      th.waiting = timed || ms > 0 ? 4 : 3;
      m.depth = 0; this.release(m);
    });
  }
}
