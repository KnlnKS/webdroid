// pthreads over cooperative Cpus: one Cpu per thread, mutex/cond/keys/once, and the sleeping calls.
// Everything runs on one JS thread, so a "contended" lock means the acquirer parks until unlock.

import { mem, AddrMap } from "./mem";
import { hostLib, NORET, type HostFn, stp, stpVa } from "./host";
import { Cpu, bindCpu, cpuByTid, yieldToLoop } from "./cpu";
import { RET_SENTINEL, E } from "./abi";
import { JThread, reportUncaught } from "../jvm/natives/jlang";
import { readTs, fail } from "./libc";

interface Mutex { owner: number; count: number; waiters: (() => void)[] }
const mutexes = new AddrMap<Mutex>();
const conds = new AddrMap<((timedOut: boolean) => void)[]>();
const sems = new AddrMap<{ count: number; waiters: (() => void)[] }>();
/** readers share, one writer excludes; a blocked acquirer parks and every unlock wakes them all to retry */
interface RwLock { readers: number; writer: number; waiters: (() => void)[] }
const rwlocks = new AddrMap<RwLock>();
function rwOf(a: number): RwLock { let l = rwlocks.get(a); if (!l) rwlocks.set(a, (l = { readers: 0, writer: 0, waiters: [] })); return l; }
async function rwAcquire(cpu: Cpu, l: RwLock, write: boolean): Promise<number> {
  for (;;) {
    if (write ? l.writer === 0 && l.readers === 0 : l.writer === 0) { if (write) l.writer = cpu.tid; else l.readers++; return 0; }
    await new Promise<void>((r) => l.waiters.push(r));
  }
}
function rwRelease(cpu: Cpu, l: RwLock): number {
  if (l.writer === cpu.tid) l.writer = 0; else if (l.readers > 0) l.readers--; else return E.PERM;
  for (const w of l.waiters.splice(0)) w();
  return 0;
}
const threads = new Map<number, { cpu: Cpu; done: Promise<void>; retval: bigint }>();
let keySeq = 1, threadSeq = 0;
const keyDtors = new Map<number, number>();
const onceWaiters = new AddrMap<(() => void)[]>();                      // pthread key → destructor, run for the thread's non-null values at its exit
const ETIMEDOUT = E.TIMEDOUT, EBUSY = E.BUSY;

function mutexOf(a: number): Mutex {
  let m = mutexes.get(a);
  if (!m) mutexes.set(a, (m = { owner: 0, count: 0, waiters: [] }));
  return m;
}
function lock(cpu: Cpu, m: Mutex): number | Promise<number> {
  if (m.owner === 0) { m.owner = cpu.tid; m.count = 1; return 0; }
  if (m.owner === cpu.tid) { m.count++; return 0; }
  return new Promise<number>((res) => m.waiters.push(() => { m.owner = cpu.tid; m.count = 1; res(0); }));
}
function unlock(m: Mutex): void {
  if (m.count > 1) { m.count--; return; }
  m.owner = 0; m.count = 0;
  const w = m.waiters.shift();
  if (w) w();
}
/** setTimeout past 2^31-1 ms fires at once; a wait that long is untimed */
const timed = (ms: number | null): number | null => (ms !== null && ms < 0x7fffffff ? ms : null);
const sleepMs = (ms: number): Promise<number> => (ms < 1 ? yieldToLoop().then(() => 0) : new Promise((r) => setTimeout(() => r(0), Math.min(ms, 0x7ffffffe))));
const absMs = (ts: number) => readTs(ts);

// ── futex: what libc++ and an engine's own primitives wait on when they bypass pthread
const futexes = new AddrMap<((woken: boolean) => void)[]>();
export const futexStats = new Map<string, Record<string, number>>();
const fstat = (cpu: Cpu, k: string) => { let r = futexStats.get(cpu.name); if (!r) futexStats.set(cpu.name, (r = {})); r[k] = (r[k] ?? 0) + 1; };
export function futex(cpu: Cpu, addr: number, op: number, val: number, ts: number, _val3: number): number | Promise<number> {
  const cmd = op & 0x7f;
  if (cmd === 0 || cmd === 9) {                                                 // FUTEX_WAIT (relative timeout) / FUTEX_WAIT_BITSET (absolute)
    if (mem.ld32(addr) !== val) { fstat(cpu, "eagain"); return fail(cpu, E.AGAIN); }
    // a delay past 2^31-1 ms overflows setTimeout and fires at once: that long is untimed
    const raw = !ts ? null : cmd === 0 ? readTs(ts) : readTs(ts) - (op & 256 ? Date.now() : performance.now() + 1000);
    const ms = raw !== null && raw < 0x7fffffff ? raw : null;
    let q = futexes.get(addr);
    if (!q) futexes.set(addr, (q = []));
    fstat(cpu, ms === null ? "wait" : "timedwait:" + Math.round(ms));
    return new Promise<number>((r) => {
      const w = (woken: boolean) => { clearTimeout(id); fstat(cpu, woken ? "woken" : "timeout"); r(woken ? 0 : fail(cpu, E.TIMEDOUT)); };
      q.push(w);
      const id = ms === null ? undefined : setTimeout(() => { const i = q.indexOf(w); if (i >= 0) { q.splice(i, 1); w(false); } }, Math.max(0, ms));
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
  const m = mutexOf(mutex);
  const count = m.count;
  m.owner = 0; m.count = 0;
  const w = m.waiters.shift();
  if (w) w();
  let list = conds.get(cond);
  if (!list) conds.set(cond, (list = []));
  const L = list;
  return new Promise<boolean>((res) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = (timedOut: boolean) => { if (timer !== undefined) clearTimeout(timer); res(timedOut); };
    L.push(wake);
    if (timed(timeoutMs) !== null) timer = setTimeout(() => { const i = L.indexOf(wake); if (i >= 0) L.splice(i, 1); res(true); }, Math.max(0, timeoutMs!));
  }).then(async (timedOut) => {
    const r = lock(cpu, m);
    if (r instanceof Promise) await r;
    m.count = count || 1;
    return timedOut ? ETIMEDOUT : 0;
  });
}

function startThread(start: number, arg: bigint, name?: string): Cpu {
  const jt = new JThread();
  jt.jname = name ?? `pthread-${++threadSeq}`;
  jt.alive = 1;
  const cpu = new Cpu(jt, jt.jname);
  bindCpu(jt, cpu);
  cpu.ensureStack();
  cpu.r[0] = Number(arg & 0xffffffffn) | 0; cpu.h[0] = Number(arg >> 32n) | 0;
  cpu.r[cpu.lrx] = RET_SENTINEL;
  cpu.setPc(start);
  const rec = { cpu, retval: 0n, done: Promise.resolve() };
  rec.done = new Promise<void>((resolve) => {
    setTimeout(() => {
      cpu.depth++;
      void cpu.run().then(async () => {
        if (!cpu.finished) rec.retval = BigInt(cpu.h[0] >>> 0) << 32n | BigInt(cpu.r[0] >>> 0);
        // key destructors, as many rounds as they keep setting values (Bionic stops at four)
        for (let round = 0, again = true; again && round < 4; round++) {
          again = false;
          for (const [k, v] of cpu.tls) {
            const d = keyDtors.get(k);
            if (!v || !d) continue;
            cpu.tls.set(k, 0n); again = true; cpu.finished = false;
            await cpu.call(d, [v], "key destructor");
          }
        }
      }, (e) => reportUncaught(e))
        .finally(() => { cpu.finished = true; jt.alive = 0; mem.freeStack(cpu.stackBase, cpu.stackTop); resolve(); });
    }, 0);
  });
  threads.set(cpu.tid, rec);
  return cpu;
}

export function pthreadInit(): void {
  const M: Record<string, HostFn> = {
    pthread_create: (_c, a) => {
      const out = a.p(); a.p(); const start = a.p(), arg = a.va();
      const cpu = startThread(start, arg);
      stp(out, cpu.tid);
      return 0;
    },
    pthread_join: async (_c, a) => {
      const tid = a.i(), retp = a.va();
      const t = threads.get(tid);
      if (!t) return 3; // ESRCH
      await t.done;
      if (retp) stpVa(mem.txVa(retp), t.retval);
      return 0;
    },
    pthread_detach: () => 0,
    pthread_exit: (cpu, a) => {
      const rv = a.va();
      const t = threads.get(cpu.tid);
      if (t) t.retval = rv;
      cpu.finished = true;
      return NORET;
    },
    pthread_self: (cpu) => cpu.tid,
    pthread_equal: (_c, a) => (a.i() === a.i() ? 1 : 0),
    pthread_sigmask: () => 0,
    pthread_setname_np: (_c, a) => { const c = cpuByTid(a.i()); const n = a.str(); if (c) { c.name = n; c.jthread.jname = n; } return 0; },
    pthread_getschedparam: (_c, a) => { a.i(); const pol = a.p(), par = a.p(); if (pol) mem.st32(pol, 0); if (par) mem.st32(par, 0); return 0; },
    pthread_setschedparam: () => 0,
    pthread_attr_init: () => 0, pthread_attr_destroy: () => 0, pthread_attr_setstacksize: () => 0, pthread_attr_setstack: () => 0,
    pthread_attr_setdetachstate: () => 0, pthread_attr_setschedparam: () => 0, pthread_attr_setschedpolicy: () => 0,
    pthread_attr_getstacksize: (_c, a) => { a.p(); stp(a.p(), 0x100000); return 0; },
    pthread_attr_getstack: (cpu, a) => { a.p(); const base = a.p(), sz = a.p(); stp(base, cpu.stackBase); stp(sz, cpu.stackTop - cpu.stackBase); return 0; },
    pthread_getattr_np: () => 0,
    // mutex: state keyed by address, the guest word untouched
    pthread_mutex_init: (_c, a) => { mutexes.set(a.p(), { owner: 0, count: 0, waiters: [] }); return 0; },
    pthread_mutex_destroy: (_c, a) => { mutexes.delete(a.p()); return 0; },
    pthread_mutex_lock: (cpu, a) => lock(cpu, mutexOf(a.p())),
    pthread_mutex_trylock: (cpu, a) => { const m = mutexOf(a.p()); if (m.owner && m.owner !== cpu.tid) return EBUSY; return lock(cpu, m) as number; },
    pthread_mutex_unlock: (_c, a) => { unlock(mutexOf(a.p())); return 0; },
    pthread_mutex_timedlock: (cpu, a) => lock(cpu, mutexOf(a.p())),
    pthread_mutexattr_init: () => 0, pthread_mutexattr_destroy: () => 0, pthread_mutexattr_settype: () => 0, pthread_mutexattr_setpshared: () => 0,
    pthread_cond_init: (_c, a) => { conds.set(a.p(), []); return 0; },
    pthread_cond_destroy: (_c, a) => { conds.delete(a.p()); return 0; },
    pthread_cond_wait: (cpu, a) => condWait(cpu, a.p(), a.p(), null),
    pthread_cond_timedwait: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, absMs(ts) - Date.now()); },
    pthread_cond_timedwait_monotonic_np: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, absMs(ts) - (performance.now() + 1000)); },
    pthread_cond_timedwait_monotonic: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, absMs(ts) - (performance.now() + 1000)); },
    pthread_cond_timedwait_relative_np: (cpu, a) => { const c = a.p(), m = a.p(), ts = a.p(); return condWait(cpu, c, m, absMs(ts)); },
    pthread_cond_timeout_np: (cpu, a) => { const c = a.p(), m = a.p(), ms = a.u(); return condWait(cpu, c, m, ms); },
    pthread_cond_signal: (_c, a) => { const l = conds.get(a.p()); const w = l?.shift(); if (w) w(false); return 0; },
    pthread_cond_broadcast: (_c, a) => { const l = conds.get(a.p()); if (l) for (const w of l.splice(0)) w(false); return 0; },
    pthread_condattr_init: () => 0, pthread_condattr_destroy: () => 0, pthread_condattr_setclock: () => 0, pthread_condattr_setpshared: () => 0,
    pthread_key_create: (_c, a) => { const out = a.p(), dtor = a.p(); if (dtor) keyDtors.set(keySeq, dtor); mem.st32(out, keySeq++); return 0; },
    pthread_rwlock_init: (_c, a) => { rwlocks.set(a.p(), { readers: 0, writer: 0, waiters: [] }); return 0; },
    pthread_rwlock_destroy: (_c, a) => { rwlocks.delete(a.p()); return 0; },
    pthread_rwlock_rdlock: (cpu, a) => rwAcquire(cpu, rwOf(a.p()), false),
    pthread_rwlock_wrlock: (cpu, a) => rwAcquire(cpu, rwOf(a.p()), true),
    pthread_rwlock_timedrdlock: (cpu, a) => rwAcquire(cpu, rwOf(a.p()), false),
    pthread_rwlock_timedwrlock: (cpu, a) => rwAcquire(cpu, rwOf(a.p()), true),
    pthread_rwlock_tryrdlock: (_c, a) => { const l = rwOf(a.p()); if (l.writer) return EBUSY; l.readers++; return 0; },
    pthread_rwlock_trywrlock: (cpu, a) => { const l = rwOf(a.p()); if (l.writer || l.readers) return EBUSY; l.writer = cpu.tid; return 0; },
    pthread_rwlock_unlock: (cpu, a) => rwRelease(cpu, rwOf(a.p())),
    pthread_rwlockattr_init: () => 0, pthread_rwlockattr_destroy: () => 0, pthread_rwlockattr_setpshared: () => 0,
    pthread_atfork: () => 0,
    pthread_mutexattr_gettype: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
    pthread_condattr_getclock: (_c, a) => { a.p(); mem.st32(a.p(), 0); return 0; },
    pthread_cond_clockwait: (cpu, a) => { const c = a.p(), m = a.p(), clk = a.i(), ts = a.p(); return condWait(cpu, c, m, absMs(ts) - (clk === 0 ? Date.now() : performance.now() + 1000)); },
    pthread_mutex_clocklock: (cpu, a) => lock(cpu, mutexOf(a.p())),
    pthread_key_delete: (_c, a) => { keyDtors.delete(a.i()); return 0; },
    pthread_getspecific: (cpu, a) => cpu.tls.get(a.i()) ?? 0n,
    pthread_setspecific: (cpu, a) => { const k = a.i(), v = a.va(); cpu.tls.set(k, v); return 0; },
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
    sem_trywait: (cpu, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } mem.st32(cpu.errnoAddr, E.AGAIN); return -1; },
    sem_post: (_c, a) => { const s = semOf(a.p()); const w = s.waiters.shift(); if (w) w(); else s.count++; return 0; },
    sem_getvalue: (_c, a) => { const s = semOf(a.p()); mem.st32(a.p(), s.count); return 0; },
    sem_timedwait: (cpu, a) => {
      const s = semOf(a.p()), ts = a.p();
      if (s.count > 0) { s.count--; return 0; }
      const ms = timed(absMs(ts) - Date.now());
      return new Promise<number>((r) => {
        const w = () => { clearTimeout(t); r(0); };
        const t = ms === null ? undefined : setTimeout(() => { const i = s.waiters.indexOf(w); if (i >= 0) { s.waiters.splice(i, 1); mem.st32(cpu.errnoAddr, ETIMEDOUT); r(-1); } }, Math.max(0, ms));
        s.waiters.push(w);
      });
    },
    sem_clockwait: (cpu, a) => { const s = semOf(a.p()); a.i(); const ts = a.p(); if (s.count > 0) { s.count--; return 0; } void cpu; const ms = timed(absMs(ts) - Date.now()); return new Promise<number>((r) => { if (ms !== null) setTimeout(() => r(-1), Math.max(0, ms)); s.waiters.push(() => r(0)); }); },
    clock_nanosleep: (_c, a) => { const clk = a.i(), flags = a.i(), req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, 16); const ms = readTs(req); return sleepMs(flags & 1 ? ms - (clk === 0 ? Date.now() : performance.now() + 1000) : ms); },
    // sleeping
    usleep: (_c, a) => sleepMs(a.u() / 1000),
    sleep: (_c, a) => sleepMs(a.u() * 1000),
    nanosleep: (_c, a) => { const req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, 16); return sleepMs(readTs(req)); },
    sched_yield: () => yieldToLoop().then(() => 0),
  };
  hostLib("libc.so", M);
}
function semOf(a: number) {
  let s = sems.get(a);
  if (!s) sems.set(a, (s = { count: 0, waiters: [] }));
  return s;
}
