// java.lang.Thread: a Java thread is a JThread (jentry.ts) whose frames run cooperatively; parking,
// start and join, uncaught-exception handlers and ThreadLocal's fast path.

import { getDeclared, rt, type ClassInfo, driven, type Gen } from "../runtime";
import { mangleMethod, mangleField, mangleStaticField, idHash } from "../abi";
import { parkTimeout, unparkTimeout, yieldToLoop } from "../yield";
import type { GuestTimer } from "../../guest-clock";
import { intrinsicCompiler } from "./jbox";
import { procIdentity, procTasks, processTid } from "../../shell/procfs";
import { after, curThread, JThread, liveThreads, mainThread, newObj, scall, vcall, vcallOn } from "./jentry";
import { dispatchUncaught, logUncaught, threadTrace } from "./jthrowable";
import { systemClassLoader } from "./jlang";

/** the native tier releases a finished thread's Cpu and stack through this */
export const threadExit = { hook: null as ((t: JThread) => void) | null };
procTasks.tids = () => [...new Set([procIdentity.pid, ...[...liveThreads].map((t) => processTid(t, t === mainThread))])];
const taskOf = (tid: number) => { for (const t of liveThreads) if (processTid(t, t === mainThread) === tid) return t; return null; };
procTasks.name = (tid) => taskOf(tid)?.jname ?? null;
procTasks.rename = (tid, name) => { const t = taskOf(tid); if (t) t.jname = name; return !!t; };
// the default handler and the pre-handler, which RuntimeInit.commonInit sets (KillApplicationHandler,
// LoggingHandler); until then a ThreadGroup prints the trace to System.err
let defaultUEH: unknown = null, preUEH: unknown = null;
const UEH = "(Ljava/lang/Thread;Ljava/lang/Throwable;)V";
/** the thread's handler, else its group (libcore's Thread.getUncaughtExceptionHandler) */
const uncaughtHandler = (t: JThread): unknown => t.ueh ?? t.group ?? mainThreadGroup();
let threadCounter = 0;
const nextThreadName = () => "Thread-" + threadCounter++;
function initGroupedThread(this: JThread, group: unknown, target: unknown, name: string) { this.group = group ?? curThread.group; this.target = target; this.jname = name; }
/** the ThreadGroup ART makes at startup, libcore's ThreadGroup.mainThreadGroup */
function mainThreadGroup(): unknown {
  const info = rt.link("java/lang/ThreadGroup");
  return after(rt.initClass(info), () => info.ctor[mangleStaticField("mainThreadGroup")]);
}
/** a Thread constructor that, as Thread.init does, starts the thread with a copy of its creator's
 *  inheritable thread locals (libcore's ThreadLocal keeps them in the thread's fields) */
function inheriting(init: (this: JThread, ...a: any[]) => void) {
  return function (this: JThread, ...a: unknown[]) {
    init.apply(this, a);
    const parent = curThread.inheritableThreadLocals;
    if (parent === null) return;
    return after(scall("java/lang/ThreadLocal", "createInheritedMap", "(Ljava/lang/ThreadLocal$ThreadLocalMap;)Ljava/lang/ThreadLocal$ThreadLocalMap;", parent),
      (m: unknown) => { this.inheritableThreadLocals = m; });
  };
}
// §4.7: ThreadLocal.get and set when the value sits in the entry its hash names, in the thread's own
// map (getMap not overridden, as InheritableThreadLocal does); every other case is libcore's
{
  const TL = "java/lang/ThreadLocal", MAP = "java/lang/ThreadLocal$ThreadLocalMap";
  let proto: Record<string, unknown> | undefined;
  const compile = intrinsicCompiler({ hash: mangleField(TL, "threadLocalHashCode"), table: mangleField(MAP, "table"),
    value: mangleField(MAP + "$Entry", "value"), getMap: mangleMethod("getMap", "(Ljava/lang/Thread;)Ljava/lang/ThreadLocal$ThreadLocalMap;") },
  { R: rt, proto: () => proto ??= rt.link(TL).ctor.prototype });
  const entry = (params: string, hit: string) => compile(params, `
    const map = this.$getMap === proto().$getMap ? R.th().threadLocals : null;
    if (map !== null) {
      const table = map.$table, e = table[this.$hash & (table.length - 1)];
      if (e !== null && e.wr !== null && e.wr.deref() === this) ${hit}
    }
    return base.call(this${params ? ", " + params : ""});`);
  rt.intrinsic(TL, { "get()Ljava/lang/Object;": entry("", "return e.$value;"), "set(Ljava/lang/Object;)V": entry("v", "{ e.$value = v; return; }") });
}

// Parks `t` until `wake` is called (notify/signal), the timeout elapses, or the thread is
// interrupted: resolves true on a wake, false on a timeout, rejects with InterruptedException on
// an interrupt — including one already pending, which Java checks before blocking. `arm`
// enqueues the waiter and returns its dequeue, so neither a timeout nor an interrupt leaves a
// dead entry behind to swallow a later notify meant for someone else.
export function park(t: JThread, arm: (wake: () => void) => () => void, timeoutMs?: number): Promise<boolean> {
  const ie = () => rt.mkThrowable("java/lang/InterruptedException", null);
  if (t.interrupted) { t.interrupted = 0; return Promise.reject(ie()); }
  return new Promise<boolean>((resolve, reject) => {
    t.parked = timeoutMs === undefined ? 3 : 4;
    let id: GuestTimer | undefined;
    const disarm = arm(() => { t.parked = 0; t.wake = null; unparkTimeout(id); resolve(true); });
    // a delay past 2^31-1 ms overflows setTimeout and fires at once; treat it as untimed
    if (timeoutMs !== undefined && timeoutMs < 0x7fffffff) id = parkTimeout(() => { disarm(); t.parked = 0; t.wake = null; resolve(false); }, timeoutMs);
    t.wake = () => { disarm(); t.parked = 0; t.wake = null; unparkTimeout(id); t.interrupted = 0; reject(ie()); };
  });
}

/** Thread.start's body, the thread in its group */
function startThread(t: JThread): void {
  t.alive = 1;
  // the body begins now, not after the caller's whole main-looper job: a thread that
  // publishes its Handler has it by the time the next lifecycle call posts to it
  t.done = new Promise((resolve) => {
    queueMicrotask(async () => {
      try { await vcallOn(t, t, "run", "()V"); }
      catch (e) { await dispatchUncaught(t, e); }
      finally {
        t.alive = 0;
        try { await vcallOn(t, t.group, "threadTerminated", "(Ljava/lang/Thread;)V", t); } catch (e) { logUncaught(e); }
        threadExit.hook?.(t);
        resolve();
      }
    });
  });
}
function join(t: JThread, ms: number): Promise<void> | undefined {
  const done = t.done;
  if (ms < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout");
  if (!done || !t.alive) return;
  return park(curThread, (wake) => {
    let pending = true;
    void done.then(() => { if (pending) wake(); });
    return () => { pending = false; };
  }, ms > 0 ? ms : undefined).then(() => {});
}

rt.register({
  name: "java/lang/Thread", ctor: JThread,
  ifaces: ["java/lang/Runnable"],
  fields: ["threadLocalRandomSeed", "threadLocalRandomProbe", "threadLocalRandomSecondarySeed", "threadLocals", "inheritableThreadLocals",
    "inheritedAccessControlContext", "parkBlocker", "tid", "started"],
  methods: {
    "<init>()V": inheriting(function () { this.jname = nextThreadName(); }),
    "<init>(Ljava/lang/Runnable;)V": inheriting(function (r: unknown) { this.target = r; this.jname = nextThreadName(); }),
    "<init>(Ljava/lang/Runnable;Ljava/lang/String;)V": inheriting(function (r: unknown, n: string) { this.target = r; this.jname = n; }),
    "<init>(Ljava/lang/String;)V": inheriting(function (n: string) { this.jname = n; }),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;)V": inheriting(initGroupedThread),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;J)V": inheriting(initGroupedThread),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V": inheriting(function (g: unknown, n: string) { this.group = g ?? curThread.group; this.jname = n; }),
    "getName()Ljava/lang/String;": function (this: JThread) { return this.jname; },
    "setName(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "setDaemon(Z)V": function (this: JThread, d: number) { this.daemon = d; },
    "isDaemon()Z": function (this: JThread) { return this.daemon; },
    "setPriority(I)V": function (this: JThread, p: number) { this.prio = p; },
    "getPriority()I": function (this: JThread) { return this.prio; },
    "isAlive()Z": function (this: JThread) { return this.alive; },
    "getState()Ljava/lang/Thread$State;": function (this: JThread) {
      const state = THREAD_STATES[!this.started ? 0 : !this.alive ? 5 : rt.monitors.isBlocked(this) ? 2 : this.parked || 1];
      const info = rt.link("java/lang/Thread$State");
      return after(rt.initClass(info), () => info.ctor[mangleStaticField(state)]);
    },
    "getId()J": function (this: JThread) { return BigInt(idHash(this)); },
    "isInterrupted()Z": function (this: JThread) { return this.interrupted; },
    // an interruptible channel operation blocked here is closed by its Interruptible, as libcore's Thread does
    "interrupt()V": function (this: JThread) {
      this.interrupted = 1; this.wake?.();
      return this.blocker ? vcall(this.blocker, "interrupt", "(Ljava/lang/Thread;)V", this) : undefined;
    },
    "blockedOn(Lsun/nio/ch/Interruptible;)V": function (this: JThread, b: unknown) { this.blocker = b; },
    "start()V": function (this: JThread) {
      if (this.started) throw rt.mkThrowable("java/lang/IllegalThreadStateException", "Thread already started");
      return after(this.group ?? mainThreadGroup(), (group) => after(vcall(group, "addUnstarted", "()V"), () => after(vcall(group, "add", "(Ljava/lang/Thread;)V", this), () => {
        this.group = group;
        startThread(this);
      })));
    },
    "run()V": driven(function* (this: JThread): Gen {
      if (this.target) yield vcall(this.target, "run", "()V");
    }),
    "join()V": function (this: JThread) { return join(this, 0); },
    "join(J)V": function (this: JThread, ms: bigint) { return join(this, Number(ms)); },
    "join(JI)V": function (this: JThread, ms: bigint, ns: number) { return join(this, Number(ms) + (ns > 0 ? 1 : 0)); },
    // a thread that has ended has no group
    "getThreadGroup()Ljava/lang/ThreadGroup;": function (this: JThread) { return this.started && !this.alive ? null : this.group ?? mainThreadGroup(); },
    "getContextClassLoader()Ljava/lang/ClassLoader;": systemClassLoader,
    "setContextClassLoader(Ljava/lang/ClassLoader;)V": () => {},
    "getStackTrace()[Ljava/lang/StackTraceElement;": threadTrace,
    "static currentThread()Ljava/lang/Thread;": () => curThread,
    "static activeCount()I": () => liveThreads.size,
    "static enumerate([Ljava/lang/Thread;)I": enumerateThreads,
    "static getAllStackTraces()Ljava/util/Map;": driven(function* (): Gen {
      const m = yield newObj("java/util/HashMap");
      yield vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", curThread, threadTrace());
      return m;
    }),
    "static getDefaultUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": () => defaultUEH,
    "static setDefaultUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": (h: unknown) => { defaultUEH = h; },
    "static getUncaughtExceptionPreHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": () => preUEH,
    "static setUncaughtExceptionPreHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": (h: unknown) => { preUEH = h; },
    // a terminated thread has left its group, and has no handler unless it set one
    "getUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": function (this: JThread) { return this.started && !this.alive ? this.ueh : uncaughtHandler(this); },
    "setUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": function (this: JThread, h: unknown) { this.ueh = h; },
    "dispatchUncaughtException(Ljava/lang/Throwable;)V": driven(function* (this: JThread, e: unknown): Gen {
      if (preUEH) { try { yield vcall(preUEH, "uncaughtException", UEH, this, e); } catch { /* the pre-handler's failure is ignored */ } }
      yield vcall(yield uncaughtHandler(this), "uncaughtException", UEH, this, e);
    }),
    "static sleep(J)V": (ms: bigint) => park(curThread, () => () => {}, Number(ms)),
    "static sleep(JI)V": (ms: bigint, nanos: number) => {
      if (ms < 0n || nanos < 0 || nanos > 999999) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout value is negative or nanos out of range");
      return park(curThread, () => () => {}, Number(ms) + nanos / 1e6);
    },
    "static yield()V": yieldToLoop,
    "static interrupted()Z": () => { const v = curThread.interrupted; curThread.interrupted = 0; return v; },
    "static holdsLock(Ljava/lang/Object;)Z": (o: unknown) => rt.monitors.holds(o as object, rt.cur) ? 1 : 0,
  },
});

function enumerateThreads(threads: unknown[]): number {
  let count = 0;
  for (const thread of liveThreads) { if (count === threads.length) break; threads[count++] = thread; }
  return count;
}
const THREAD_STATES = ["NEW", "RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "TERMINATED"];
/** debug: each live thread as Thread.getState reads it, with the object it parked on
 *  (wd.threads; the e2e harness records it when a step's phase hangs) */
export const threadStates = (): { name: string; state: string; blocker?: string; owner?: string }[] => [...liveThreads].map((t) => ({
  name: t.jname, state: THREAD_STATES[rt.monitors.isBlocked(t) ? 2 : t.parked || 1],
  blocker: (t.parkBlocker as { constructor?: { $i?: ClassInfo } } | null)?.constructor?.$i?.name,
  owner: t.parkBlocker ? blockerOwner(t.parkBlocker) : undefined,
}));
/** the thread a parked thread waits for, where its blocker names one: a FutureTask's runner, a lock's owner */
function blockerOwner(blocker: unknown): string | undefined {
  for (const [cls, field] of [["java/util/concurrent/FutureTask", "runner"], ["java/util/concurrent/locks/AbstractOwnableSynchronizer", "exclusiveOwnerThread"]]) {
    try { const t = getDeclared<JThread | null>(blocker, cls, field); if (t !== undefined) return t?.jname ?? "none"; } catch { /* not loaded */ }
  }
  return undefined;
}

