// pthreads over cooperative Cpus: one Cpu per thread, mutex/cond/keys/once, and the sleeping calls.
// Everything runs on one JS thread, so a "contended" lock means the acquirer parks until unlock.

import { mem } from "./mem";
import { hostLib, NORET, type HostFn, stp } from "./host";
import { Cpu, bindCpu, cpuByTid, yieldToLoop } from "./cpu";
import { RET_SENTINEL, E } from "./abi";
import { JThread, reportUncaught } from "../jvm/natives/jlang";
import { readTs } from "./libc";

interface Mutex { owner: number; count: number; waiters: (() => void)[] }
const mutexes = new Map<number, Mutex>();
const conds = new Map<number, ((timedOut: boolean) => void)[]>();
const sems = new Map<number, { count: number; waiters: (() => void)[] }>();
const threads = new Map<number, { cpu: Cpu; done: Promise<void>; retval: number }>();
let keySeq = 1, threadSeq = 0;
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
const sleepMs = (ms: number): Promise<number> => (ms < 1 ? yieldToLoop().then(() => 0) : new Promise((r) => setTimeout(() => r(0), ms)));
const absMs = (ts: number) => readTs(ts);

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
    if (timeoutMs !== null) timer = setTimeout(() => { const i = L.indexOf(wake); if (i >= 0) L.splice(i, 1); res(true); }, Math.max(0, timeoutMs));
  }).then(async (timedOut) => {
    const r = lock(cpu, m);
    if (r instanceof Promise) await r;
    m.count = count || 1;
    return timedOut ? ETIMEDOUT : 0;
  });
}

function startThread(start: number, arg: number, name?: string): Cpu {
  const jt = new JThread();
  jt.jname = name ?? `pthread-${++threadSeq}`;
  jt.alive = 1;
  const cpu = new Cpu(jt, jt.jname);
  bindCpu(jt, cpu);
  cpu.ensureStack();
  cpu.r[0] = arg; cpu.h[0] = 0;
  cpu.r[cpu.lrx] = RET_SENTINEL;
  cpu.setPc(start);
  const rec = { cpu, retval: 0, done: Promise.resolve() };
  rec.done = new Promise<void>((resolve) => {
    setTimeout(() => {
      cpu.depth++;
      void cpu.run().then(() => { if (!cpu.finished) rec.retval = cpu.r[0]; }, (e) => reportUncaught(e))
        .finally(() => { cpu.finished = true; jt.alive = 0; resolve(); });
    }, 0);
  });
  threads.set(cpu.tid, rec);
  return cpu;
}

export function pthreadInit(): void {
  const M: Record<string, HostFn> = {
    pthread_create: (_c, a) => {
      const out = a.p(); a.p(); const start = a.p(), arg = a.i();
      const cpu = startThread(start, arg);
      stp(out, cpu.tid);
      return 0;
    },
    pthread_join: async (_c, a) => {
      const tid = a.i(), retp = a.p();
      const t = threads.get(tid);
      if (!t) return 3; // ESRCH
      await t.done;
      if (retp) stp(retp, t.retval);
      return 0;
    },
    pthread_detach: () => 0,
    pthread_exit: (cpu, a) => {
      const rv = a.i();
      const t = threads.get(cpu.tid);
      if (t) t.retval = rv;
      cpu.finished = true;
      return NORET;
    },
    pthread_self: (cpu) => cpu.tid,
    pthread_equal: (_c, a) => (a.i() === a.i() ? 1 : 0),
    pthread_kill: () => 0,
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
    pthread_key_create: (_c, a) => { const out = a.p(); mem.st32(out, keySeq++); return 0; },
    pthread_key_delete: () => 0,
    pthread_getspecific: (cpu, a) => cpu.tls.get(a.i()) ?? 0,
    pthread_setspecific: (cpu, a) => { const k = a.i(), v = a.i(); cpu.tls.set(k, v); return 0; },
    pthread_once: async (cpu, a) => {
      const once = a.p(), fn = a.p();
      if (mem.ld32(once) !== 0) return 0;
      mem.st32(once, 1);
      await cpu.call(fn);
      return 0;
    },
    // semaphores (sem_t is a 32-bit word)
    sem_init: (_c, a) => { const s = a.p(); a.i(); const v = a.u(); sems.set(s, { count: v, waiters: [] }); return 0; },
    sem_destroy: (_c, a) => { sems.delete(a.p()); return 0; },
    sem_wait: (_c, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } return new Promise<number>((r) => s.waiters.push(() => r(0))); },
    sem_trywait: (cpu, a) => { const s = semOf(a.p()); if (s.count > 0) { s.count--; return 0; } mem.st32(cpu.errnoAddr, E.AGAIN); return -1; },
    sem_post: (_c, a) => { const s = semOf(a.p()); const w = s.waiters.shift(); if (w) w(); else s.count++; return 0; },
    sem_getvalue: (_c, a) => { const s = semOf(a.p()); mem.st32(a.p(), s.count); return 0; },
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
