// pthreads over cooperative Cpus: one Cpu per thread, mutex/cond/keys/once, and the sleeping calls.
// Everything runs on one JS thread, so a "contended" lock means the acquirer parks until unlock.

import { mem, AddrMap, guestAt } from "./mem";
import { NativeFault } from "./core";
import { hostLib, NORET, SERVED, type HostFn, PTR, ldp, stp, stLong } from "./host";
import { Cpu, bindCpu, cpuByTid, cpuOf, cpus, nameThread } from "./cpu";
import { yieldToLoop } from "../jvm/yield";
import { parkTimeout, unparkTimeout } from "../jvm/yield";
import { TLS_KEYS } from "./core";
import { RET_SENTINEL, E } from "./abi";
import { JThread } from "../jvm/natives/jentry";
import { logUncaught, dispatchUncaught } from "../jvm/natives/jthrowable";
import { threadExit } from "../jvm/natives/jentry";
import { readTs, fail, clockTime, utf8 } from "./libc";
import { KLAYOUT } from "./syscall";
import { guestSleep, MAX_TIMER_DELAY } from "../guest-clock";

/** Bionic's LP32 mutex word: the low half is state/counter/shared/type and the high half is
 *  owner tid for recursive/error-check mutexes. Normal mutexes deliberately have no owner. */
const COUNT = 0x3ffc;
const STATE = 0x3, SHARED = 0x2000, TYPE = 0xc000;
const ERRORCHECK = 0x8000;
const mutexWaiters = new AddrMap<(() => void)[]>();
const conds = new AddrMap<((timedOut: boolean) => void)[]>();
const sems = new AddrMap<{ count: number; waiters: (() => void)[] }>();
/** A rwlock lives in its own words, zero when unlocked as PTHREAD_RWLOCK_INITIALIZER leaves it:
 *  the reader count or RW_WRITER, the writer's tid, and how many threads wait. The core serves
 *  uncontended calls on the same words (libc.zig); a blocked acquirer parks here, and an unlock
 *  that finds waiters wakes them all to retry. */
const RW_WRITER = 0x80000000, RW_TID = 4, RW_WAITERS = 8;
const rwWaiters = new AddrMap<(() => void)[]>();
function rwTry(cpu: Cpu, a: number, write: boolean): boolean {
  const state = mem.ld32(a) >>> 0;
  if (write ? state !== 0 : (state & RW_WRITER) !== 0) return false;
  if (write) { mem.st32(a, RW_WRITER); mem.st32(a + RW_TID, cpu.tid); } else mem.st32(a, state + 1);
  return true;
}
function rwAcquire(cpu: Cpu, a: number, write: boolean): number | Promise<number> {
  if (rwTry(cpu, a, write)) return 0;
  return (async () => {
    do {
      mem.st32(a + RW_WAITERS, mem.ld32(a + RW_WAITERS) + 1);
      const q = rwWaiters.ensure(a, () => []);
      await new Promise<void>((r) => q.push(r));
      mem.st32(a + RW_WAITERS, mem.ld32(a + RW_WAITERS) - 1);
    } while (!rwTry(cpu, a, write));
    return 0;
  })();
}
function rwRelease(cpu: Cpu, a: number): number {
  const state = mem.ld32(a) >>> 0;
  if (state & RW_WRITER) {
    if (mem.ld32(a + RW_TID) !== cpu.tid) return E.PERM;
    mem.st32(a, 0); mem.st32(a + RW_TID, 0);
  } else if (state) mem.st32(a, state - 1);
  else return E.PERM;
  if (mem.ld32(a + RW_WAITERS)) for (const w of rwWaiters.get(a)?.splice(0) ?? []) w();
  return 0;
}
const threads = new Map<number, { done: Promise<void>; retval: bigint; detached: boolean; joined: boolean; exited: boolean; storage: number }>();
/** pthread_t (the thread's pthread_internal_t address) → Cpu tid, for as long as the thread is joinable or alive */
const handles = new Map<number, number>();
export const tidOf = (handle: number): number => handles.get(handle >>> 0) ?? cpuBySelf(handle >>> 0)?.tid ?? -1;
function cpuBySelf(handle: number): Cpu | undefined { for (const c of cpus) if (c.pthreadSelf === handle) return c; return undefined; }
let keySeq = 1, threadSeq = 0;
const keyDtors = new Map<number, number>();                              // pthread key → destructor, run for the thread's non-null values at its exit
const cleanupHeads = new Map<number, number>();
const attrGuards = new AddrMap<number>();
async function runCleanupHandlers(cpu: Cpu): Promise<void> {
  for (let head; (head = cleanupHeads.get(cpu.tid) ?? 0);) {
    cleanupHeads.set(cpu.tid, ldp(head));
    const routine = ldp(head + PTR);
    if (routine) { cpu.finished = false; await cpu.call(routine, [ldp(head + 2 * PTR)], "pthread cleanup"); }
  }
  cleanupHeads.delete(cpu.tid);
}
/** key destructors, as many rounds as they keep setting values (Bionic stops at four) */
async function runKeyDestructors(cpu: Cpu): Promise<void> {
  for (let round = 0, again = true; again && round < 4; round++) {
    again = false;
    for (const [k, d] of keyDtors) {
      const v = mem.ld64(cpu.tlsTab + 8 * k);
      if (!v) continue;
      mem.st64(cpu.tlsTab + 8 * k, 0n); again = true; cpu.finished = false;
      await cpu.call(d, [v], "key destructor");
    }
  }
}
// A Java thread that ends has no native frame left. Its thread-locals get their destructors,
// as a pthread exit gives them, and the stack goes back to the pool.
threadExit.hook = (t) => {
  const cpu = cpuOf(t);
  if (!cpu || cpu.loops || cpu.depth) return;
  void runCleanupHandlers(cpu).then(() => runKeyDestructors(cpu)).then(() => cpu.endThread()).catch(logUncaught).finally(() => { if (!cpu.loops) cpu.dispose(); });
};
const onceWaiters = new AddrMap<(() => void)[]>();

function lock(cpu: Cpu, a: number, tryOnly = false): number | Promise<number> {
  const w = mem.ld32(a);
  const kind = w & TYPE, constants = w & (TYPE | SHARED);
  if ((w & STATE) === 0) {
    mem.st32(a, constants | 1 | (kind === 0 ? 0 : cpu.tid << 16));
    return 0;
  }
  if (kind !== 0 && (w >>> 16) === cpu.tid) {
    if (kind === ERRORCHECK) return tryOnly ? E.BUSY : E.DEADLK;
    if ((w & COUNT) === COUNT) return E.AGAIN;
    mem.st32(a, w + 4);
    return 0;
  }
  if (tryOnly) return E.BUSY;
  mem.st32(a, (w & ~STATE) | 2);
  const Q = mutexWaiters.ensure(a, () => []);
  return new Promise<number>((res) => Q.push(() => {
    const current = mem.ld32(a), currentKind = current & TYPE;
    mem.st32(a, (current & (TYPE | SHARED)) | (Q.length ? 2 : 1) | (currentKind === 0 ? 0 : cpu.tid << 16));
    res(0);
  }));
}
function unlock(cpu: Cpu, a: number): number {
  const w = mem.ld32(a);
  const kind = w & TYPE;
  if ((w & STATE) === 0) return E.PERM;
  if (kind !== 0 && (w >>> 16) !== cpu.tid) return E.PERM;
  if (kind !== 0 && w & COUNT) { mem.st32(a, w - 4); return 0; }
  const next = mutexWaiters.get(a)?.shift();
  if (next) next(); else mem.st32(a, w & (TYPE | SHARED));
  return 0;
}
/** a wait past the longest timer is untimed */
const timed = (ms: number | null): number | null => (ms !== null && ms < MAX_TIMER_DELAY ? ms : null);
const sleepMs = (ms: number): Promise<number> => (ms < 1 ? yieldToLoop().then(() => 0) : guestSleep(ms).then(() => 0));

// ── futex: what libc++ and an engine's own primitives wait on when they bypass pthread
const futexes = new AddrMap<((woken: boolean) => void)[]>();
export const futexStats = new Map<string, Record<string, number>>();
const fstat = (cpu: Cpu, k: string) => { let r = futexStats.get(cpu.name); if (!r) futexStats.set(cpu.name, (r = {})); r[k] = (r[k] ?? 0) + 1; };
export function futex(cpu: Cpu, addr: number, op: number, val: number, ts: number): number | Promise<number> {
  const cmd = op & 0x7f;
  if (cmd === 0 || cmd === 9) {                                                 // FUTEX_WAIT (relative timeout) / FUTEX_WAIT_BITSET (absolute)
    if (mem.ld32(addr) !== val) { fstat(cpu, "eagain"); return fail(cpu, E.AGAIN); }
    const ms = timed(!ts ? null : cmd === 0 ? readTs(ts) : readTs(ts) - clockTime(op & 256 ? 0 : 1));
    const q = futexes.ensure(addr, () => []);
    fstat(cpu, ms === null ? "wait" : "timedwait");
    return new Promise<number>((r) => {
      const previous = cpu.signalInterrupt;
      let active = true;
      const finish = (result: number) => {
        if (!active) return;
        active = false;
        cpu.deferSignalsUntilResume();
        unparkTimeout(id);
        const i = q.indexOf(w); if (i >= 0) q.splice(i, 1);
        if (cpu.signalInterrupt === interrupt) cpu.signalInterrupt = previous;
        r(result);
      };
      const w = (woken: boolean) => { fstat(cpu, woken ? "woken" : "timeout"); finish(woken ? 0 : fail(cpu, E.TIMEDOUT)); };
      const interrupt = () => { fstat(cpu, "interrupted"); finish(fail(cpu, E.INTR)); };
      cpu.signalInterrupt = interrupt;
      q.push(w);
      const id = ms === null ? undefined : parkTimeout(() => w(false), Math.max(0, ms));
    });
  }
  if (cmd === 1 || cmd === 10) {                                                // FUTEX_WAKE / FUTEX_WAKE_BITSET
    fstat(cpu, "wake");
    const q = futexes.get(addr);
    let n = 0;
    while (q?.length && n < val) { q.shift()!(true); n++; }
    return n;
  }
  return fail(cpu, E.NOSYS);
}

function condWait(cpu: Cpu, cond: number, mutex: number, timeoutMs: number | null): Promise<number> {
  const count = mem.ld32(mutex) & COUNT;
  mem.st32(mutex, mem.ld32(mutex) & ~COUNT);
  unlock(cpu, mutex);
  const L = conds.ensure(cond, () => []);
  return new Promise<boolean>((res) => {
    let timer: ReturnType<typeof parkTimeout> | undefined;
    const wake = (timedOut: boolean) => { unparkTimeout(timer); res(timedOut); };
    L.push(wake);
    if (timed(timeoutMs) !== null) timer = parkTimeout(() => { const i = L.indexOf(wake); if (i >= 0) L.splice(i, 1); res(true); }, Math.max(0, timeoutMs!));
  }).then(async (timedOut) => {
    const r = lock(cpu, mutex);
    if (r instanceof Promise) await r;
    mem.st32(mutex, mem.ld32(mutex) | count);
    return timedOut ? E.TIMEDOUT : 0;
  });
}

const condUntil = (clk: number): HostFn => (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, readTs(ts) - clockTime(clk)); };
function semWait(cpu: Cpu, s: { count: number; waiters: (() => void)[] }, ts: number, clk: number): number | Promise<number> {
  if (s.count > 0) { s.count--; return 0; }
  const ms = timed(readTs(ts) - clockTime(clk));
  return new Promise<number>((r) => {
    const w = () => { unparkTimeout(t); r(0); };
    const t = ms === null ? undefined : parkTimeout(() => { const i = s.waiters.indexOf(w); if (i >= 0) { s.waiters.splice(i, 1); r(fail(cpu, E.TIMEDOUT)); } }, Math.max(0, ms));
    s.waiters.push(w);
  });
}

function newThread(parent: Cpu): Cpu {
  const jt = new JThread();
  jt.jname = `pthread-${++threadSeq}`;
  const cpu = new Cpu(jt, jt.jname);
  cpu.parent = parent;
  cpu.signalMask = parent.signalMask;
  bindCpu(jt, cpu);
  return cpu;
}
/** a new thread's base frame runs on a later turn: `body` drives it and `exit` follows it */
function launch(cpu: Cpu, body: () => Promise<void>, exit: () => void): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => void (async () => {
    // a thread is signalable before its first instruction runs. A handler delivered in that
    // window owns the base register file, so the thread's code must wait for it.
    await cpu.awaitIdleBase();
    cpu.depth++;
    try { await body(); } catch (e) { void dispatchUncaught(cpu.jthread, e); }
    finally {
      cpu.signals.length = 0;
      await cpu.awaitIdleBase();
      cpu.depth--; cpu.finished = true; cpu.signals.length = 0;
      exit();
      resolve();
    }
  })(), 0));
}

export function startThread(parent: Cpu, start: number, arg: bigint, detached: boolean): Cpu {
  const cpu = newThread(parent);
  try { cpu.ensureStack(); } catch (e) { cpu.dispose(); throw e; }
  cpu.w[0] = Number(arg & 0xffffffffn) | 0;
  cpu.w[2 * cpu.lrx] = RET_SENTINEL;
  cpu.setPc(start);
  const rec = { retval: 0n, done: Promise.resolve(), detached, joined: false, exited: false, storage: 0 };
  rec.done = launch(cpu, async () => {
    await cpu.run();
    if (!cpu.finished) rec.retval = BigInt(cpu.w[0] >>> 0);
    await runCleanupHandlers(cpu);
    await runKeyDestructors(cpu);
  }, () => {
    rec.exited = true;
    rec.storage = cpu.dispose(!rec.detached);
    if (rec.detached) { threads.delete(cpu.tid); handles.delete(cpu.pthreadSelf); }
  });
  threads.set(cpu.tid, rec);
  handles.set(cpu.pthreadSelf, cpu.tid);
  return cpu;
}

const CLONE_THREAD = 0x10000, CLONE_SETTLS = 0x80000, CLONE_PARENT_SETTID = 0x100000, CLONE_CHILD_CLEARTID = 0x200000;
/** clone(2) for a thread (the guest libc's pthread_create): the child continues past the svc with
 *  the caller's registers, 0 in x0, its own stack and thread pointer. A tab cannot hold a second
 *  process, so fork, vfork and posix_spawn (and popen and system over them) fail as at the
 *  kernel's process limit: EAGAIN. */
export function cloneThread(parent: Cpu, flags: number, stack: bigint, ptid: number, tls: bigint, ctid: number): number {
  if (!(flags & CLONE_THREAD)) return fail(parent, E.AGAIN);
  if (!stack) return fail(parent, E.INVAL);
  const cpu = newThread(parent);
  cpu.forkFrom(parent, stack);
  if (flags & CLONE_SETTLS) { cpu.tlsVa = tls; cpu.libc = "guest"; }
  if (flags & CLONE_PARENT_SETTID) mem.st32(ptid, cpu.osTid);
  if (flags & CLONE_CHILD_CLEARTID) cpu.clearChildTid = BigInt(mem.va(ctid));
  void launch(cpu, async () => cpu.run(), () => {
    // what pthread_join waits on, unless set_tid_address withdrew it
    if (cpu.clearChildTid) { const at = guestAt(cpu.clearChildTid); mem.st32(at, 0); futex(cpu, at, 1, 0x7fffffff, 0); }
    cpu.dispose();
  });
  return cpu.osTid;
}

export const PTHREAD_SYSCALLS: Record<string, HostFn> = {
  clock_nanosleep: (_c, a) => { const clk = a.i(), flags = a.i(), req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, KLAYOUT.TS_SIZE); const ms = readTs(req); return sleepMs(flags & 1 ? ms - clockTime(clk) : ms); },
  nanosleep: (_c, a) => { const req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, KLAYOUT.TS_SIZE); return sleepMs(readTs(req)); },
  sched_yield: () => yieldToLoop().then(() => 0),
};

export function pthreadInit(): void {
  const M: Record<string, HostFn> = {
    pthread_create: (parent, a) => {
      const out = a.p(), attr = a.p(), start = a.p(), arg = a.va();
      try {
        const cpu = startThread(parent, start, arg, !!attr && !!(mem.ld32(attr) & 1));
        stp(out, cpu.pthreadSelf);
        return 0;
      } catch (e) {
        if (e instanceof NativeFault && (e.message === "[native] out of stack address space" || e.message === "[native] out of memory for thread data")) return E.AGAIN;
        throw e;
      }
    },
    pthread_join: async (cpu, a) => {
      const handle = a.p(), tid = tidOf(handle), retp = a.va();
      if (tid === cpu.tid) return E.DEADLK;
      const t = threads.get(tid);
      if (!t) return E.SRCH;
      if (t.detached || t.joined) return E.INVAL;
      t.joined = true;
      await t.done;
      if (retp) mem.st32(mem.txVa(retp), Number(t.retval));
      if (t.storage) mem.free(t.storage);
      threads.delete(tid); handles.delete(handle);
      return 0;
    },
    pthread_detach: (_c, a) => {
      const handle = a.p(), tid = tidOf(handle), t = threads.get(tid);
      if (!t) return E.SRCH;
      if (t.detached || t.joined) return E.INVAL;
      t.detached = true;
      if (t.exited) { if (t.storage) mem.free(t.storage); threads.delete(tid); handles.delete(handle); }
      return 0;
    },
    pthread_gettid_np: (_c, a) => { const tid = tidOf(a.p()); return cpuByTid(tid)?.osTid ?? -1; },
    pthread_exit: (cpu, a) => {
      const rv = a.va();
      const t = threads.get(cpu.tid);
      if (t) t.retval = rv;
      cpu.finished = true;
      return NORET;
    },
    pthread_self: SERVED,
    pthread_equal: (_c, a) => (a.i() === a.i() ? 1 : 0),
    pthread_sigmask: (cpu, a) => cpu.sigmask(a.i(), a.p(), a.p(), 4),
    pthread_sigmask64: (cpu, a) => cpu.sigmask(a.i(), a.p(), a.p(), 8),
    pthread_setname_np: (_c, a) => {
      const handle = a.p(), name = a.str();
      if (utf8(name).length >= 16) return E.RANGE;
      const thread = cpuByTid(tidOf(handle));
      if (!thread) return E.SRCH;
      nameThread(thread.jthread, name);
      return 0;
    },
    pthread_getname_np: (_c, a) => {
      const handle = a.p(), out = a.p(), size = a.u();
      if (size < 16) return E.RANGE;
      const thread = cpuByTid(tidOf(handle));
      if (!thread) return E.SRCH;
      const name = utf8(thread.name).subarray(0, 15);
      mem.write(out, name); mem.st8(out + name.length, 0);
      return 0;
    },
    pthread_getschedparam: (_c, a) => { a.i(); const pol = a.p(), par = a.p(); if (pol) mem.st32(pol, 0); if (par) mem.st32(par, 0); return 0; },
    pthread_setschedparam: () => 0,
    pthread_attr_init: (_c, a) => { const attr = a.p(); mem.st32(attr, 0); attrGuards.set(attr, 4096); return 0; },
    pthread_attr_destroy: (_c, a) => { attrGuards.delete(a.p()); return 0; },
    pthread_attr_setstacksize: () => 0, pthread_attr_setstack: () => 0,
    pthread_attr_setguardsize: (_c, a) => { attrGuards.set(a.p(), Number(a.va())); return 0; },
    pthread_attr_getguardsize: (_c, a) => { const attr = a.p(), out = a.p(); stLong(out, attrGuards.get(attr) ?? 4096); return 0; },
    pthread_attr_setscope: (_c, a) => { a.p(); const scope = a.i(); return scope === 0 ? 0 : scope === 1 ? E.NOTSUP : E.INVAL; },
    pthread_attr_getscope: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
    pthread_attr_setdetachstate: (_c, a) => {
      const attr = a.p(), state = a.i();
      if (state !== 0 && state !== 1) return E.INVAL;
      mem.st32(attr, (mem.ld32(attr) & ~1) | state);
      return 0;
    },
    pthread_attr_getdetachstate: (_c, a) => { const attr = a.p(); mem.st32(a.p(), mem.ld32(attr) & 1); return 0; },
    pthread_attr_setschedparam: () => 0, pthread_attr_setschedpolicy: () => 0,
    pthread_attr_getschedparam: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
    pthread_attr_getstacksize: (_c, a) => { a.p(); stLong(a.p(), 0x100000); return 0; },
    pthread_attr_getstack: (cpu, a) => { a.p(); const base = a.p(), sz = a.p(); stp(base, cpu.stackBase); stLong(sz, cpu.stackTop - cpu.stackBase); return 0; },
    pthread_getattr_np: () => 0,
    __pthread_cleanup_push: (cpu, a) => {
      const entry = a.p(), routine = a.p(), arg = a.p();
      stp(entry, cleanupHeads.get(cpu.tid) ?? 0);
      stp(entry + PTR, routine); stp(entry + 2 * PTR, arg);
      cleanupHeads.set(cpu.tid, entry);
    },
    __pthread_cleanup_pop: (cpu, a) => {
      const entry = a.p(), execute = a.i();
      const previous = ldp(entry);
      if (previous) cleanupHeads.set(cpu.tid, previous); else cleanupHeads.delete(cpu.tid);
      const routine = ldp(entry + PTR);
      return execute && routine ? cpu.call(routine, [ldp(entry + 2 * PTR)], "pthread cleanup").then(() => undefined) : undefined;
    },
    pthread_mutex_init: (_c, a) => {
      const mutex = a.p(), attr = a.p();
      const av = attr ? mem.ld32(attr) : 0, type = av & 0xf;
      if (type < 0 || type > 2) return E.INVAL;
      mem.st32(mutex, (type << 14) | (av & 0x10 ? SHARED : 0));
      return 0;
    },
    pthread_mutex_destroy: (_c, a) => {
      const mutex = a.p(), w = mem.ld32(mutex);
      if ((w & STATE) !== 0) return E.BUSY;
      mutexWaiters.delete(mutex); mem.st32(mutex, 0xffff); return 0;
    },
    pthread_mutex_lock: (cpu, a) => lock(cpu, a.p()),
    pthread_mutex_trylock: (cpu, a) => lock(cpu, a.p(), true),
    pthread_mutex_unlock: (cpu, a) => unlock(cpu, a.p()),
    pthread_mutex_timedlock: (cpu, a) => lock(cpu, a.p()),
    pthread_mutexattr_init: (_c, a) => { mem.st32(a.p(), 0); return 0; },
    pthread_mutexattr_destroy: (_c, a) => { mem.st32(a.p(), -1); return 0; },
    pthread_mutexattr_settype: (_c, a) => {
      const attr = a.p(), type = a.i();
      if (type < 0 || type > 2) return E.INVAL;
      mem.st32(attr, (mem.ld32(attr) & ~0xf) | type); return 0;
    },
    pthread_mutexattr_setpshared: (_c, a) => {
      const attr = a.p(), shared = a.i();
      if (shared !== 0 && shared !== 1) return E.INVAL;
      mem.st32(attr, (mem.ld32(attr) & ~0x10) | (shared ? 0x10 : 0)); return 0;
    },
    pthread_cond_init: (_c, a) => { conds.set(a.p(), []); return 0; },
    pthread_cond_destroy: (_c, a) => { conds.delete(a.p()); return 0; },
    pthread_cond_wait: (cpu, a) => condWait(cpu, a.p(), a.p(), null),
    pthread_cond_timedwait: condUntil(0), pthread_cond_timedwait_monotonic_np: condUntil(1), pthread_cond_timedwait_monotonic: condUntil(1),
    pthread_cond_timedwait_relative_np: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, readTs(ts)); },
    pthread_cond_timeout_np: (cpu, a) => { const c = a.p(), m = a.p(), ms = a.u(); return condWait(cpu, c, m, ms); },
    pthread_cond_signal: (_c, a) => { const l = conds.get(a.p()); const w = l?.shift(); if (w) w(false); return 0; },
    pthread_cond_broadcast: (_c, a) => { const l = conds.get(a.p()); if (l) for (const w of l.splice(0)) w(false); return 0; },
    pthread_condattr_init: () => 0, pthread_condattr_destroy: () => 0, pthread_condattr_setclock: () => 0, pthread_condattr_setpshared: () => 0,
    pthread_key_create: (_c, a) => { const out = a.p(), dtor = a.p(); if (keySeq >= TLS_KEYS) return E.AGAIN; if (dtor) keyDtors.set(keySeq, dtor); mem.st32(out, keySeq++); return 0; },
    pthread_rwlock_init: (_c, a) => { mem.memset(a.p(), 0, RW_WAITERS + 4); return 0; },
    pthread_rwlock_destroy: (_c, a) => { rwWaiters.delete(a.p()); return 0; },
    pthread_rwlock_rdlock: (cpu, a) => rwAcquire(cpu, a.p(), false),
    pthread_rwlock_wrlock: (cpu, a) => rwAcquire(cpu, a.p(), true),
    pthread_rwlock_timedrdlock: (cpu, a) => rwAcquire(cpu, a.p(), false),
    pthread_rwlock_timedwrlock: (cpu, a) => rwAcquire(cpu, a.p(), true),
    pthread_rwlock_tryrdlock: (cpu, a) => rwTry(cpu, a.p(), false) ? 0 : E.BUSY,
    pthread_rwlock_trywrlock: (cpu, a) => rwTry(cpu, a.p(), true) ? 0 : E.BUSY,
    pthread_rwlock_unlock: (cpu, a) => rwRelease(cpu, a.p()),
    pthread_rwlockattr_init: () => 0, pthread_rwlockattr_destroy: () => 0, pthread_rwlockattr_setpshared: () => 0,
    pthread_atfork: () => 0,
    pthread_mutexattr_gettype: (_c, a) => { const attr = a.p(); mem.st32(a.p(), mem.ld32(attr) & 0xf); return 0; },
    pthread_condattr_getclock: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
    pthread_cond_clockwait: (cpu, a) => { const c = a.p(), m = a.p(), clk = a.i(), ts = a.p(); return condWait(cpu, c, m, readTs(ts) - clockTime(clk)); },
    pthread_mutex_clocklock: (cpu, a) => lock(cpu, a.p()),
    pthread_key_delete: (_c, a) => { keyDtors.delete(a.i()); return 0; },
    pthread_getspecific: SERVED, pthread_setspecific: SERVED,
    // the control word: 0 untouched, 1 running (callers wait), 2 done — no caller returns before the initializer has
    pthread_once: async (cpu, a) => {
      const once = a.p(), fn = a.p();
      if (mem.ld32(once) === 2) return 0;
      if (mem.ld32(once) === 1) { await new Promise<void>((r) => onceWaiters.get(once)!.push(r)); return 0; }
      mem.st32(once, 1); onceWaiters.set(once, []);
      try { await cpu.call(fn); } finally { mem.st32(once, 2); for (const w of onceWaiters.get(once) ?? []) w(); onceWaiters.delete(once); }
      return 0;
    },
    // semaphores (sem_t is a 32-bit word)
    sem_init: (_c, a) => { const s = a.p(); a.i(); const v = a.u(); sems.set(s, { count: v, waiters: [] }); return 0; },
    sem_destroy: (_c, a) => { sems.delete(a.p()); return 0; },
    sem_wait: (_c, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } return new Promise<number>((r) => s.waiters.push(() => r(0))); },
    sem_trywait: (cpu, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } return fail(cpu, E.AGAIN); },
    sem_post: (_c, a) => { const s = semOf(a.p()); const w = s.waiters.shift(); if (w) w(); else s.count++; return 0; },
    sem_getvalue: (_c, a) => { const s = semOf(a.p()); mem.st32(a.p(), s.count); return 0; },
    sem_timedwait: (cpu, a) => { const s = semOf(a.p()); return semWait(cpu, s, a.p(), 0); },
    sem_clockwait: (cpu, a) => { const s = semOf(a.p()), clk = a.i(); return semWait(cpu, s, a.p(), clk); },
    usleep: (_c, a) => sleepMs(a.u() / 1000),
    sleep: (_c, a) => sleepMs(a.u() * 1000),
  };
  hostLib("libc.so", M);
}
function semOf(a: number) {
  return sems.ensure(a, () => ({ count: 0, waiters: [] }));
}
