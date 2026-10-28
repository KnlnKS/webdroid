// The kernel's threads over cooperative Cpus: clone(2), futex(2), the sleeping calls and a thread's
// end. Everything runs on one JS thread, so a blocked thread parks until whatever it waits on wakes it.

import { mem, AddrMap, guestAt } from "./mem.ts";
import type { HostFn } from "./host.ts";
import { Cpu, bindCpu, cpuOf } from "./cpu.ts";
import { parkTimeout, unparkTimeout, yieldToLoop } from "../jvm/yield.ts";
import { WaitQueue } from "./poll.ts";
import { E } from "./abi.ts";
import { JThread, threadExit } from "../jvm/natives/jentry.ts";
import { dispatchUncaught, logUncaught, toThread } from "../jvm/natives/jthrowable.ts";
import { readTs, clockTime, KLAYOUT } from "./kernel.ts";
import { guestSleep, MAX_TIMER_DELAY } from "../guest-clock.ts";

/** whoever waits at an address: a futex, or the ARM32 libc's mutex, condition, semaphore, rwlock or once */
export const queues = new AddrMap<WaitQueue>();
export const queueAt = (a: number): WaitQueue => queues.ensure(a, () => new WaitQueue());
/** a wait's limit for WaitQueue.wait: none for null or past the longest timer, and no less than now */
export const waitLimit = (ms: number | null): number => ms === null || ms >= MAX_TIMER_DELAY ? -1 : Math.max(0, ms);
export const sleepMs = (ms: number): Promise<number> => (ms < 1 ? yieldToLoop().then(() => 0) : guestSleep(ms).then(() => 0));

// A Java thread that ends has no native frame left: its guest libc tears its thread down, as a
// pthread exit would, and the stack goes back to the pool.
threadExit.hook = (t) => {
  const cpu = cpuOf(t);
  if (!cpu || cpu.loops || cpu.depth) return;
  void cpu.endThread().catch(logUncaught).finally(() => { if (!cpu.loops) cpu.dispose(); });
};

/** a library's own thread (a binder thread, a callback looper), made when first needed, that runs the guest
 *  callbacks handed to it one after another */
export function callbackThread(name: string): (run: (cpu: Cpu) => Promise<unknown>) => void {
  let cpu: Cpu | null = null, calls: Promise<unknown> = Promise.resolve();
  return (run) => {
    if (!cpu) { const thread = new JThread(); thread.jname = name; cpu = new Cpu(thread, name); bindCpu(thread, cpu); }
    const c = cpu;
    calls = calls.then(() => run(c)).catch(toThread(c.jthread));
  };
}

// ── futex: what libc++ and an engine's own primitives wait on when they bypass pthread
export const futexStats = new Map<string, Record<string, number>>();
const fstat = (cpu: Cpu, k: string) => { let r = futexStats.get(cpu.name); if (!r) futexStats.set(cpu.name, (r = {})); r[k] = (r[k] ?? 0) + 1; };
/** FUTEX_WAIT (relative timeout) or FUTEX_WAIT_BITSET (absolute): the only commands whose fourth argument is a timeout */
const isWait = (op: number) => (op & 0x7f) === 0 || (op & 0x7f) === 9;
export function futex(cpu: Cpu, addr: number, op: number, val: number, ts: number): PromiseOrVal<number> {
  const cmd = op & 0x7f;
  if (isWait(op)) {
    if (mem.ld32(addr) !== val) { fstat(cpu, "eagain"); return -E.AGAIN; }
    const ms = waitLimit(!ts ? null : cmd === 0 ? readTs(ts) : readTs(ts) - clockTime(op & 256 ? 0 : 1));
    const q = queueAt(addr);
    fstat(cpu, ms < 0 ? "wait" : "timedwait");
    return new Promise<number>((r) => {
      const previous = cpu.signalInterrupt, depth = cpu.depth;
      let active = true;
      const finish = (result: number) => {
        if (!active) return;
        active = false;
        cpu.deferSignalsUntilResume(depth);
        unparkTimeout(id);
        stop();
        if (cpu.signalInterrupt === waiting) cpu.signalInterrupt = previous;
        r(result);
      };
      const waiting = { depth, interrupt: () => { fstat(cpu, "interrupted"); finish(-E.INTR); } };
      cpu.signalInterrupt = waiting;
      const stop = q.add(() => { fstat(cpu, "woken"); finish(0); });
      const id = ms < 0 ? undefined : parkTimeout(() => { fstat(cpu, "timeout"); finish(-E.TIMEDOUT); }, ms);
    });
  }
  if (cmd === 1 || cmd === 10) {                                                // FUTEX_WAKE / FUTEX_WAKE_BITSET
    fstat(cpu, "wake");
    return queues.get(addr)?.wake(val) ?? 0;
  }
  return -E.NOSYS;
}

let threadSeq = 0;
/** a new guest thread, with `parent`'s signal mask */
export function newThread(parent: Cpu): Cpu {
  const jt = new JThread();
  jt.jname = `pthread-${++threadSeq}`;
  const cpu = new Cpu(jt, jt.jname);
  cpu.parent = parent;
  cpu.signalMask = parent.signalMask;
  bindCpu(jt, cpu);
  return cpu;
}
/** a new thread's base frame runs on a later turn: `body` drives it and `exit` follows it */
export function launch(cpu: Cpu, body: () => Promise<void>, exit: () => void): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(() => void (async () => {
    // a thread is signalable before its first instruction runs. A handler delivered in that
    // window owns the base register file, so the thread's code must wait for it.
    await cpu.awaitIdleBase();
    cpu.depth++;
    try { await body(); } catch (e) { void dispatchUncaught(cpu.jthread, e); }
    finally {
      cpu.signals.clear();
      await cpu.awaitIdleBase();
      cpu.depth--; cpu.finished = true; cpu.signals.clear();
      exit();
      resolve();
    }
  })(), 0));
}

const CLONE_THREAD = 0x10000, CLONE_SETTLS = 0x80000, CLONE_PARENT_SETTID = 0x100000, CLONE_CHILD_CLEARTID = 0x200000;
/** clone(2) for a thread (the guest libc's pthread_create): the child continues past the svc with
 *  the caller's registers, 0 in x0, its own stack and thread pointer. A tab cannot hold a second
 *  process, so fork, vfork and posix_spawn (and popen and system over them) fail as at the
 *  kernel's process limit: EAGAIN. */
export function cloneThread(parent: Cpu, flags: number, stack: bigint, ptid: number, tls: bigint, ctid: number): number {
  if (!(flags & CLONE_THREAD)) return -E.AGAIN;
  if (!stack) return -E.INVAL;
  const cpu = newThread(parent);
  cpu.forkFrom(parent, stack);
  if (flags & CLONE_SETTLS) cpu.cloned(tls);
  if (flags & CLONE_PARENT_SETTID) mem.st32(ptid, cpu.osTid);
  if (flags & CLONE_CHILD_CLEARTID) cpu.clearChildTid = BigInt(mem.va(ctid));
  void launch(cpu, async () => cpu.run(), () => {
    // what pthread_join waits on, unless set_tid_address withdrew it
    if (cpu.clearChildTid) { const at = guestAt(cpu.clearChildTid); mem.st32(at, 0); futex(cpu, at, 1, 0x7fffffff, 0); }
    cpu.dispose();
  });
  return cpu.osTid;
}

export const THREAD_SYSCALLS: Record<string, HostFn> = {
  clock_nanosleep: (_c, a) => { const clk = a.i(), flags = a.i(), req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, KLAYOUT.TS_SIZE); const ms = readTs(req); return sleepMs(flags & 1 ? ms - clockTime(clk) : ms); },
  nanosleep: (_c, a) => { const req = a.p(), rem = a.p(); if (rem) mem.memset(rem, 0, KLAYOUT.TS_SIZE); return sleepMs(readTs(req)); },
  // it completes before a pending signal is delivered
  sched_yield: (cpu) => { cpu.deferSignalsUntilResume(); return yieldToLoop().then(() => 0); },
  // a wake's fourth argument is whatever a variadic syscall(2) left in the register, so only a wait translates it
  futex: (cpu, a) => { const addr = a.p(), op = a.i(), val = a.i(); return futex(cpu, addr, op, val, isWait(op) ? a.p() : 0); },
  clone: (cpu, a) => { const flags = a.u(), stack = a.va(), ptid = a.p(), tls = a.va(), ctid = a.p(); return cloneThread(cpu, flags, stack, ptid, tls, ctid); },
  set_tid_address: (cpu, a) => { cpu.clearChildTid = a.va(); return cpu.osTid; },
  // no process-shared robust mutexes to recover
  set_robust_list: () => 0,
  // this thread's end
  exit: (cpu) => { cpu.finished = true; return Promise.resolve(0); },
};
