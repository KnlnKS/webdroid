// The ARM32 libc's pthreads over cooperative Cpus (thread.ts): each thread's libc data, pthread_create
// and join, mutex/cond/keys/once, rwlocks, semaphores and the sleeping calls. Everything runs on one JS
// thread, so a "contended" lock means the acquirer parks until unlock.

import { mem, AddrMap } from "../mem.ts";
import { NativeFault, TLS_KEYS } from "../core.ts";
import { NORET, SERVED, type HostFn, PTR, ldp, stp, stLong } from "../host.ts";
import { type Cpu, cpuByTid, cpus, nameThread } from "../cpu.ts";
import { msLeft } from "../poll.ts";
import { RET_SENTINEL, E, PAGE_SIZE, STACK_GUARD, STACK_SIZE } from "../abi.ts";
import { readTs, fail, clockTime, wrapped } from "../kernel.ts";
import { queues, queueAt, waitLimit as limit, sleepMs, newThread, launch } from "../thread.ts";
import { createTimer } from "../timers.ts";
import { utf8 as codec } from "../../jvm/abi.ts";
import { guestNow } from "../../guest-clock.ts";

/** Bionic's LP32 mutex word: the low half is state/counter/shared/type and the high half is
 *  owner tid for recursive/error-check mutexes. Normal mutexes deliberately have no owner. */
const COUNT = 0x3ffc;
const STATE = 0x3, SHARED = 0x2000, TYPE = 0xc000;
const ERRORCHECK = 0x8000;
const sems = new AddrMap<{ count: number }>();
/** A rwlock lives in its own words, zero when unlocked as PTHREAD_RWLOCK_INITIALIZER leaves it:
 *  the reader count or RW_WRITER, the writer's tid, and how many threads wait. The core serves
 *  uncontended calls on the same words (libc.zig); a blocked acquirer parks here, and an unlock
 *  that finds waiters wakes them all to retry. */
const RW_WRITER = 0x80000000, RW_TID = 4, RW_WAITERS = 8;
function rwTry(cpu: Cpu, a: number, write: boolean): boolean {
  const state = mem.ld32(a) >>> 0;
  if (write ? state !== 0 : (state & RW_WRITER) !== 0) return false;
  if (write) { mem.st32(a, RW_WRITER); mem.st32(a + RW_TID, cpu.tid); } else mem.st32(a, state + 1);
  return true;
}
function rwAcquire(cpu: Cpu, a: number, write: boolean, ms = -1): number | Promise<number> {
  if (rwTry(cpu, a, write)) return 0;
  const deadline = guestNow() + ms;
  return (async () => {
    do {
      mem.st32(a + RW_WAITERS, mem.ld32(a + RW_WAITERS) + 1);
      const woken = await queueAt(a).wait(msLeft(ms, deadline));
      mem.st32(a + RW_WAITERS, mem.ld32(a + RW_WAITERS) - 1);
      if (!woken) return E.TIMEDOUT;
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
  if (mem.ld32(a + RW_WAITERS)) queues.get(a)?.wakeAll();
  return 0;
}
/** bionic's ILP32 pthread_attr_t: flags (bit 0: detached), stack base and size, guard size,
 *  scheduling policy and priority */
const ATTR = { flags: 0, base: 4, size: 8, guard: 12, policy: 16, priority: 20 }, ATTR_DETACHED = 1;
type ThreadAttr = Record<keyof typeof ATTR, number>;
const ATTR_FIELDS = Object.keys(ATTR) as (keyof typeof ATTR)[];
const PTHREAD_STACK_MIN = 2 * PAGE_SIZE;
const DEFAULT_ATTR: ThreadAttr = { flags: 0, base: 0, size: STACK_SIZE, guard: PAGE_SIZE, policy: 0, priority: 0 };
/** what pthread_create reads from `attr` (0: the defaults), detached if `detached` */
export function threadAttr(attr: number, detached = false): ThreadAttr {
  const t = { ...DEFAULT_ATTR };
  if (attr) for (const field of ATTR_FIELDS) t[field] = mem.ld32(attr + ATTR[field]) >>> 0;
  if (detached) t.flags |= ATTR_DETACHED;
  return t;
}
function writeAttr(attr: number, t: ThreadAttr): void { for (const field of ATTR_FIELDS) mem.st32(attr + ATTR[field], t[field]); }
/** each pthread_create thread's attributes, its stack as it got it, and its libc data, which outlive it
 *  until it is joined: its pthread_t names its data */
const threads = new Map<number, { done: Promise<void>; retval: bigint; attr: ThreadAttr; detached: boolean; joined: boolean; exited: boolean; data: number }>();
/** pthread_t (the thread's pthread_internal_t address) → Cpu tid, for as long as the thread is joinable or alive */
const handles = new Map<number, number>();
export const tidOf = (handle: number): number => handles.get(handle >>> 0) ?? cpuBySelf(handle >>> 0)?.tid ?? -1;
function cpuBySelf(handle: number): Cpu | undefined { if (handle) for (const c of cpus) if (c.pthreadSelf === handle) return c; return undefined; }
/** a thread's libc data: its TLS block, whose slot 1 names its pthread_internal_t; errno; the pthread
 *  key table the core serves lookups from; then that pthread_internal_t (its tid at +0x10), which a
 *  crash reporter scans up to a page */
const ERRNO = 256, KEYS = 264, PTHREAD = KEYS + 8 * TLS_KEYS, PTHREAD_SIZE = 0x200;
/** a thread's libc identity, before its first instruction */
export function bindThread(cpu: Cpu): void {
  const data = mem.calloc(1, PTHREAD + PTHREAD_SIZE);
  if (!data) throw new NativeFault("[native] out of memory for thread data");
  mem.st32(data + PTHREAD + 0x10, cpu.osTid);
  mem.st32(data + 4, data + PTHREAD);
  cpu.keyTable = data + KEYS;
  cpu.bindThread(data, data + PTHREAD, data + ERRNO);
}
let keySeq = 1;
const keyDtors = new Map<number, number>();                              // pthread key → destructor, run for the thread's non-null values at its exit
const cleanupHeads = new Map<number, number>();
/** a thread's exit: its cleanup handlers, then its keys' destructors, as many rounds as they keep
 *  setting values (Bionic stops at four) */
async function exitThread(cpu: Cpu): Promise<void> {
  for (let head; (head = cleanupHeads.get(cpu.tid) ?? 0);) {
    cleanupHeads.set(cpu.tid, ldp(head));
    const routine = ldp(head + PTR);
    if (routine) { cpu.finished = false; await cpu.call(routine, [ldp(head + 2 * PTR)], "pthread cleanup"); }
  }
  cleanupHeads.delete(cpu.tid);
  for (let round = 0, again = true; again && round < 4; round++) {
    again = false;
    for (const [k, d] of keyDtors) {
      const v = mem.ld64(cpu.keyTable + 8 * k);
      if (!v) continue;
      mem.st64(cpu.keyTable + 8 * k, 0n); again = true; cpu.finished = false;
      await cpu.call(d, [v], "key destructor");
    }
  }
}
/** a thread the host started (a Java thread's, or an audio callback's) at its end */
export async function endThread(cpu: Cpu): Promise<void> {
  await exitThread(cpu);
  mem.free(cpu.tlsBase);
}
function lock(cpu: Cpu, a: number, tryOnly = false, ms = -1): number | Promise<number> {
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
  // unlock hands the mutex over
  const q = queueAt(a);
  return q.wait(ms, () => {
    const current = mem.ld32(a), currentKind = current & TYPE;
    mem.st32(a, (current & (TYPE | SHARED)) | (q.size ? 2 : 1) | (currentKind === 0 ? 0 : cpu.tid << 16));
  }).then((woken) => woken ? 0 : E.TIMEDOUT);
}
/** pthread_mutex_timedlock's kin: until the deadline on clock `clk` */
const lockUntil = (clk: number): HostFn => (cpu, a) => { const m = a.p(), ts = a.p(); return lock(cpu, m, false, limit(readTs(ts) - clockTime(clk))); };
function unlock(cpu: Cpu, a: number): number {
  const w = mem.ld32(a);
  const kind = w & TYPE;
  if ((w & STATE) === 0) return E.PERM;
  if (kind !== 0 && (w >>> 16) !== cpu.tid) return E.PERM;
  if (kind !== 0 && w & COUNT) { mem.st32(a, w - 4); return 0; }
  if (!queues.get(a)?.wake()) mem.st32(a, w & (TYPE | SHARED));
  return 0;
}
function condWait(cpu: Cpu, cond: number, mutex: number, timeoutMs: number | null): Promise<number> {
  const count = mem.ld32(mutex) & COUNT;
  mem.st32(mutex, mem.ld32(mutex) & ~COUNT);
  unlock(cpu, mutex);
  return queueAt(cond).wait(limit(timeoutMs)).then(async (woken) => {
    const r = lock(cpu, mutex);
    if (r instanceof Promise) await r;
    mem.st32(mutex, mem.ld32(mutex) | count);
    return woken ? 0 : E.TIMEDOUT;
  });
}

const condUntil = (clk: number): HostFn => (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, readTs(ts) - clockTime(clk)); };
/** sem_wait for `ms` (-1: no limit): sem_post hands its count to the waiter it wakes */
function semWait(cpu: Cpu, sem: number, ms: number): number | Promise<number> {
  const s = semOf(sem);
  if (s.count > 0) { s.count--; return 0; }
  return queueAt(sem).wait(ms).then((woken) => woken ? 0 : fail(cpu, E.TIMEDOUT));
}
const semUntil = (clk: number): HostFn => (cpu, a) => { const s = a.p(), ts = a.p(); return semWait(cpu, s, limit(readTs(ts) - clockTime(clk))); };

export function startThread(parent: Cpu, start: number, arg: bigint, attr: ThreadAttr): Cpu {
  const cpu = newThread(parent), detached = !!(attr.flags & ATTR_DETACHED);
  try {
    // the caller's own stack (pthread_attr_setstack) stays the caller's to free
    if (attr.base) { cpu.stackTop = attr.base + attr.size; cpu.w[2 * cpu.spx] = cpu.stackTop; }
    else {
      cpu.ensureStack((attr.size + PAGE_SIZE - 1) & -PAGE_SIZE);
      attr = { ...attr, base: cpu.stackBase, size: cpu.stackTop - cpu.stackBase };
    }
    bindThread(cpu);
  } catch (e) { cpu.dispose(); throw e; }
  cpu.w[0] = Number(arg & 0xffffffffn) | 0;
  cpu.w[2 * cpu.lrx] = RET_SENTINEL;
  cpu.setPc(start);
  const handle = cpu.pthreadSelf, rec = { retval: 0n, done: Promise.resolve(), attr, detached, joined: false, exited: false, data: cpu.tlsBase };
  rec.done = launch(cpu, async () => {
    await cpu.run();
    if (!cpu.finished) rec.retval = BigInt(cpu.w[0] >>> 0);
    await exitThread(cpu);
  }, () => {
    rec.exited = true;
    cpu.dispose();
    if (rec.detached) forget(cpu.tid, handle);
  });
  threads.set(cpu.tid, rec);
  handles.set(handle, cpu.tid);
  return cpu;
}
/** a thread's record and data, once it has exited and is joined or detached */
function forget(tid: number, handle: number): void {
  mem.free(threads.get(tid)!.data);
  threads.delete(tid); handles.delete(handle);
}

/** the ARM32 libc's pthread, semaphore, sleep and timer functions */
export const PTHREAD_LIBC: Record<string, HostFn> = {
  pthread_create: (parent, a) => {
    const out = a.p(), attr = a.p(), start = a.p(), arg = a.va();
    try {
      const cpu = startThread(parent, start, arg, threadAttr(attr));
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
    forget(tid, handle);
    return 0;
  },
  pthread_detach: (_c, a) => {
    const handle = a.p(), tid = tidOf(handle), t = threads.get(tid);
    if (!t) return E.SRCH;
    if (t.detached || t.joined) return E.INVAL;
    t.detached = true;
    if (t.exited) forget(tid, handle);
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
    if (codec.enc.encode(name).length >= 16) return E.RANGE;
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
    const name = codec.enc.encode(thread.name).subarray(0, 15);
    mem.write(out, name); mem.st8(out + name.length, 0);
    return 0;
  },
  pthread_getschedparam: (_c, a) => { a.i(); const pol = a.p(), par = a.p(); if (pol) mem.st32(pol, 0); if (par) mem.st32(par, 0); return 0; },
  pthread_setschedparam: () => 0,
  pthread_attr_init: (_c, a) => { writeAttr(a.p(), DEFAULT_ATTR); return 0; },
  pthread_attr_destroy: () => 0,
  pthread_attr_setstacksize: (_c, a) => { const attr = a.p(), size = a.u(); if (size < PTHREAD_STACK_MIN) return E.INVAL; mem.st32(attr + ATTR.size, size); return 0; },
  pthread_attr_setstack: (_c, a) => {
    const attr = a.p(), base = a.p(), size = a.u();
    if (size < PTHREAD_STACK_MIN || (size | base) & (PAGE_SIZE - 1)) return E.INVAL;
    mem.st32(attr + ATTR.base, base); mem.st32(attr + ATTR.size, size);
    return 0;
  },
  pthread_attr_setguardsize: (_c, a) => { const attr = a.p(); mem.st32(attr + ATTR.guard, a.u()); return 0; },
  pthread_attr_getguardsize: (_c, a) => { const attr = a.p(), out = a.p(); stLong(out, threadAttr(attr).guard); return 0; },
  pthread_attr_setscope: (_c, a) => { a.p(); const scope = a.i(); return scope === 0 ? 0 : scope === 1 ? E.NOTSUP : E.INVAL; },
  pthread_attr_getscope: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
  pthread_attr_setdetachstate: (_c, a) => {
    const attr = a.p(), state = a.i();
    if (state !== 0 && state !== 1) return E.INVAL;
    mem.st32(attr, (mem.ld32(attr) & ~1) | state);
    return 0;
  },
  pthread_attr_getdetachstate: (_c, a) => { const attr = a.p(); mem.st32(a.p(), mem.ld32(attr) & 1); return 0; },
  pthread_attr_setschedparam: (_c, a) => { const attr = a.p(), param = a.p(); mem.st32(attr + ATTR.priority, mem.ld32(param)); return 0; },
  pthread_attr_setschedpolicy: (_c, a) => { const attr = a.p(); mem.st32(attr + ATTR.policy, a.i()); return 0; },
  pthread_attr_getschedparam: (_c, a) => { const attr = a.p(); mem.st32(a.p(), mem.ld32(attr + ATTR.priority)); return 0; },
  pthread_attr_getstacksize: (_c, a) => { const attr = a.p(); stLong(a.p(), threadAttr(attr).size); return 0; },
  pthread_attr_getstack: (_c, a) => { const t = threadAttr(a.p()), base = a.p(), size = a.p(); stp(base, t.base); stLong(size, t.size); return 0; },
  // a thread pthread_create did not start (the main thread, or a Java thread's) has the stack
  // and guard the host gave it, and nothing joins it
  pthread_getattr_np: (_c, a) => {
    const handle = a.p(), attr = a.p(), tid = tidOf(handle), rec = threads.get(tid), t = cpuByTid(tid);
    if (rec) writeAttr(attr, { ...rec.attr, flags: rec.attr.flags & ~ATTR_DETACHED | (rec.detached ? ATTR_DETACHED : 0) });
    else if (t) writeAttr(attr, { ...DEFAULT_ATTR, flags: ATTR_DETACHED, base: t.stackBase, size: t.stackTop - t.stackBase, guard: STACK_GUARD });
    else return E.SRCH;
    return 0;
  },
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
    queues.delete(mutex); mem.st32(mutex, 0xffff); return 0;
  },
  pthread_mutex_lock: (cpu, a) => lock(cpu, a.p()),
  pthread_mutex_trylock: (cpu, a) => lock(cpu, a.p(), true),
  pthread_mutex_unlock: (cpu, a) => unlock(cpu, a.p()),
  pthread_mutex_timedlock: lockUntil(0), pthread_mutex_timedlock_monotonic_np: lockUntil(1),
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
  pthread_cond_init: (_c, a) => { queues.delete(a.p()); return 0; },
  pthread_cond_destroy: (_c, a) => { queues.delete(a.p()); return 0; },
  pthread_cond_wait: (cpu, a) => condWait(cpu, a.p(), a.p(), null),
  pthread_cond_timedwait: condUntil(0), pthread_cond_timedwait_monotonic_np: condUntil(1), pthread_cond_timedwait_monotonic: condUntil(1),
  pthread_cond_timedwait_relative_np: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, readTs(ts)); },
  pthread_cond_timeout_np: (cpu, a) => { const c = a.p(), m = a.p(), ms = a.u(); return condWait(cpu, c, m, ms); },
  pthread_cond_signal: (_c, a) => { queues.get(a.p())?.wake(); return 0; },
  pthread_cond_broadcast: (_c, a) => { queues.get(a.p())?.wakeAll(); return 0; },
  pthread_condattr_init: () => 0, pthread_condattr_destroy: () => 0, pthread_condattr_setclock: () => 0, pthread_condattr_setpshared: () => 0,
  pthread_key_create: (_c, a) => { const out = a.p(), dtor = a.p(); if (keySeq >= TLS_KEYS) return E.AGAIN; if (dtor) keyDtors.set(keySeq, dtor); mem.st32(out, keySeq++); return 0; },
  pthread_rwlock_init: (_c, a) => { mem.memset(a.p(), 0, RW_WAITERS + 4); return 0; },
  pthread_rwlock_destroy: (_c, a) => { queues.delete(a.p()); return 0; },
  pthread_rwlock_rdlock: (cpu, a) => rwAcquire(cpu, a.p(), false),
  pthread_rwlock_wrlock: (cpu, a) => rwAcquire(cpu, a.p(), true),
  pthread_rwlock_timedrdlock: (cpu, a) => { const rw = a.p(), ts = a.p(); return rwAcquire(cpu, rw, false, limit(readTs(ts) - clockTime(0))); },
  pthread_rwlock_timedwrlock: (cpu, a) => { const rw = a.p(), ts = a.p(); return rwAcquire(cpu, rw, true, limit(readTs(ts) - clockTime(0))); },
  pthread_rwlock_tryrdlock: (cpu, a) => rwTry(cpu, a.p(), false) ? 0 : E.BUSY,
  pthread_rwlock_trywrlock: (cpu, a) => rwTry(cpu, a.p(), true) ? 0 : E.BUSY,
  pthread_rwlock_unlock: (cpu, a) => rwRelease(cpu, a.p()),
  pthread_rwlockattr_init: () => 0, pthread_rwlockattr_destroy: () => 0, pthread_rwlockattr_setpshared: () => 0,
  pthread_atfork: () => 0,
  pthread_mutexattr_gettype: (_c, a) => { const attr = a.p(); mem.st32(a.p(), mem.ld32(attr) & 0xf); return 0; },
  pthread_condattr_getclock: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
  pthread_cond_clockwait: (cpu, a) => { const c = a.p(), m = a.p(), clk = a.i(), ts = a.p(); return condWait(cpu, c, m, readTs(ts) - clockTime(clk)); },
  pthread_mutex_clocklock: (cpu, a) => { const m = a.p(), clk = a.i(), ts = a.p(); return lock(cpu, m, false, limit(readTs(ts) - clockTime(clk))); },
  pthread_key_delete: (_c, a) => { keyDtors.delete(a.i()); return 0; },
  pthread_getspecific: SERVED, pthread_setspecific: SERVED,
  // the control word: 0 untouched, 1 running (callers wait), 2 done — no caller returns before the initializer has
  pthread_once: async (cpu, a) => {
    const once = a.p(), fn = a.p();
    if (mem.ld32(once) === 2) return 0;
    if (mem.ld32(once) === 1) { await queueAt(once).wait(); return 0; }
    mem.st32(once, 1);
    try { await cpu.call(fn); } finally { mem.st32(once, 2); queues.get(once)?.wakeAll(); queues.delete(once); }
    return 0;
  },
  // semaphores (sem_t is a 32-bit word)
  sem_init: (_c, a) => { const s = a.p(); a.i(); const v = a.u(); sems.set(s, { count: v }); return 0; },
  sem_destroy: (_c, a) => { const s = a.p(); sems.delete(s); queues.delete(s); return 0; },
  sem_wait: (cpu, a) => semWait(cpu, a.p(), -1),
  sem_trywait: (cpu, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } return fail(cpu, E.AGAIN); },
  sem_post: (_c, a) => { const s = a.p(); if (!queues.get(s)?.wake()) semOf(s).count++; return 0; },
  sem_getvalue: (_c, a) => { const s = semOf(a.p()); mem.st32(a.p(), s.count); return 0; },
  sem_timedwait: semUntil(0),
  sem_clockwait: (cpu, a) => { const s = a.p(), clk = a.i(), ts = a.p(); return semWait(cpu, s, limit(readTs(ts) - clockTime(clk))); },
  usleep: (_c, a) => sleepMs(a.u() / 1000),
  sleep: (_c, a) => sleepMs(a.u() * 1000),
  // SIGEV_THREAD runs its function on a detached thread of its own
  timer_create: wrapped((cpu, a) => createTimer(cpu, a.i(), a.p(), a.p(), (fn, attributes, value) => {
    const attr = threadAttr(attributes, true);
    return () => { startThread(cpu, fn, value, attr); };
  })),
};
function semOf(a: number) {
  return sems.ensure(a, () => ({ count: 0 }));
}
