// java.util.concurrent.* — cooperative single-JS-thread implementations.

import { rt, JObj, type NativeSpec, type ClassInfo } from "../runtime";
import { parkTimeout, unparkTimeout } from "../yield";
import { vcall, newObj, JThread, JEnum, setCurThread, curThread, park, defineException } from "./jlang";
import { JList, newArrayList, listMethods, JPriorityQueue, pqInsert, priorityQueueMethods } from "./jutil";
import { JRandom, randomSeed } from "./jrandom";
import { splitSig } from "../abi";

// ── atomics (single-threaded: trivial)
const atomicCore = (d: string): NativeSpec["methods"] => ({
  "<init>()V": function () {},
  [`<init>(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`get()${d}`]: function (this: { v: unknown }) { return this.v; },
  [`set(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`lazySet(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`getAndSet(${d})${d}`]: function (this: { v: unknown }, v: unknown) { const o = this.v; this.v = v; return o; },
});
class JAtomicInt extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicInteger", ctor: JAtomicInt, sup: "java/lang/Number",
  methods: {
    ...atomicCore("I"),
    "incrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v + 1) | 0); },
    "decrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v - 1) | 0); },
    "getAndIncrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o + 1) | 0; return o; },
    "getAndDecrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o - 1) | 0; return o; },
    "addAndGet(I)I": function (this: JAtomicInt, d: number) { return (this.v = (this.v + d) | 0); },
    "getAndAdd(I)I": function (this: JAtomicInt, d: number) { const o = this.v; this.v = (o + d) | 0; return o; },
    "compareAndSet(II)Z": function (this: JAtomicInt, e: number, v: number) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "intValue()I": function (this: JAtomicInt) { return this.v; },
    "longValue()J": function (this: JAtomicInt) { return BigInt(this.v); },
    "toString()Ljava/lang/String;": function (this: JAtomicInt) { return String(this.v); },
  },
});
class JAtomicLong extends JObj { v = 0n; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicLong", ctor: JAtomicLong, sup: "java/lang/Number",
  methods: {
    ...atomicCore("J"),
    "incrementAndGet()J": function (this: JAtomicLong) { return (this.v = BigInt.asIntN(64, this.v + 1n)); },
    "decrementAndGet()J": function (this: JAtomicLong) { return (this.v = BigInt.asIntN(64, this.v - 1n)); },
    "getAndDecrement()J": function (this: JAtomicLong) { const o = this.v; this.v = BigInt.asIntN(64, o - 1n); return o; },
    "getAndAdd(J)J": function (this: JAtomicLong, d: bigint) { const o = this.v; this.v = BigInt.asIntN(64, o + d); return o; },
    "intValue()I": function (this: JAtomicLong) { return Number(BigInt.asIntN(32, this.v)); },
    "longValue()J": function (this: JAtomicLong) { return this.v; },
    "toString()Ljava/lang/String;": function (this: JAtomicLong) { return String(this.v); },
    "getAndIncrement()J": function (this: JAtomicLong) { const o = this.v; this.v = BigInt.asIntN(64, o + 1n); return o; },
    "addAndGet(J)J": function (this: JAtomicLong, d: bigint) { return (this.v = BigInt.asIntN(64, this.v + d)); },
    "compareAndSet(JJ)Z": function (this: JAtomicLong, e: bigint, v: bigint) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "getAndUpdate(Ljava/util/function/LongUnaryOperator;)J": async function (this: JAtomicLong, f: unknown) { const o = this.v; this.v = await vcall(f, "applyAsLong", "(J)J", o); return o; },
    "updateAndGet(Ljava/util/function/LongUnaryOperator;)J": async function (this: JAtomicLong, f: unknown) { return (this.v = await vcall(f, "applyAsLong", "(J)J", this.v)); },
    "accumulateAndGet(JLjava/util/function/LongBinaryOperator;)J": async function (this: JAtomicLong, x: bigint, f: unknown) { return (this.v = await vcall(f, "applyAsLong", "(JJ)J", this.v, x)); },
  },
});
class JAtomicMarkable extends JObj { v: unknown = null; mark = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicMarkableReference", ctor: JAtomicMarkable,
  methods: {
    "<init>(Ljava/lang/Object;Z)V": function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    "getReference()Ljava/lang/Object;": function (this: JAtomicMarkable) { return this.v; },
    "isMarked()Z": function (this: JAtomicMarkable) { return this.mark; },
    "get([Z)Ljava/lang/Object;": function (this: JAtomicMarkable, out: Uint8Array) { out[0] = this.mark; return this.v; },
    "set(Ljava/lang/Object;Z)V": function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;ZZ)Z": function (this: JAtomicMarkable, e: unknown, v: unknown, em: number, m: number) {
      if (this.v !== e || this.mark !== em) return 0;
      this.v = v; this.mark = m; return 1;
    },
    "attemptMark(Ljava/lang/Object;Z)Z": function (this: JAtomicMarkable, e: unknown, m: number) { if (this.v !== e) return 0; this.mark = m; return 1; },
  },
});
class JAtomicBool extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicBoolean", ctor: JAtomicBool,
  methods: {
    ...atomicCore("Z"),
    "compareAndSet(ZZ)Z": function (this: JAtomicBool, e: number, v: number) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
  },
});
class JAtomicRef extends JObj { v: unknown = null; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicReference", ctor: JAtomicRef,
  methods: {
    ...atomicCore("Ljava/lang/Object;"),
    "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z": function (this: JAtomicRef, e: unknown, v: unknown) {
      if (this.v !== e) return 0;
      this.v = v;
      return 1;
    },
    "getAndUpdate(Ljava/util/function/UnaryOperator;)Ljava/lang/Object;": async function (this: JAtomicRef, f: unknown) { const o = this.v; this.v = await vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", o); return o; },
    "updateAndGet(Ljava/util/function/UnaryOperator;)Ljava/lang/Object;": async function (this: JAtomicRef, f: unknown) { return (this.v = await vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", this.v)); },
  },
});

class JAtomicIntArray extends JObj { a!: Int32Array; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicIntegerArray", ctor: JAtomicIntArray,
  methods: {
    "<init>(I)V": function (this: JAtomicIntArray, n: number) { this.a = new Int32Array(n); },
    "get(I)I": function (this: JAtomicIntArray, i: number) { return this.a[i]; },
    "set(II)V": function (this: JAtomicIntArray, i: number, v: number) { this.a[i] = v; },
    "lazySet(II)V": function (this: JAtomicIntArray, i: number, v: number) { this.a[i] = v; },
    "getAndSet(II)I": function (this: JAtomicIntArray, i: number, v: number) { const o = this.a[i]; this.a[i] = v; return o; },
    "compareAndSet(III)Z": function (this: JAtomicIntArray, i: number, e: number, v: number) { if (this.a[i] !== e) return 0; this.a[i] = v; return 1; },
    "incrementAndGet(I)I": function (this: JAtomicIntArray, i: number) { return ++this.a[i]; },
    "getAndIncrement(I)I": function (this: JAtomicIntArray, i: number) { return this.a[i]++; },
    "addAndGet(II)I": function (this: JAtomicIntArray, i: number, d: number) { return (this.a[i] += d); },
    "getAndAdd(II)I": function (this: JAtomicIntArray, i: number, d: number) { const o = this.a[i]; this.a[i] += d; return o; },
    "length()I": function (this: JAtomicIntArray) { return this.a.length; },
  },
});
class JAtomicLongArray extends JObj { a!: BigInt64Array; }
function atomicLongSet(this: JAtomicLongArray, i: number, value: bigint) {
  if (i < 0 || i >= this.a.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(i));
  this.a[i] = value;
}
rt.register({
  name: "java/util/concurrent/atomic/AtomicLongArray", ctor: JAtomicLongArray,
  methods: {
    "<init>(I)V": function (this: JAtomicLongArray, n: number) { this.a = new BigInt64Array(n); },
    "get(I)J": function (this: JAtomicLongArray, i: number) { return this.a[i]; },
    "set(IJ)V": atomicLongSet,
    "lazySet(IJ)V": atomicLongSet,
    "getAndSet(IJ)J": function (this: JAtomicLongArray, i: number, v: bigint) { const o = this.a[i]; this.a[i] = v; return o; },
    "compareAndSet(IJJ)Z": function (this: JAtomicLongArray, i: number, e: bigint, v: bigint) { if (this.a[i] !== e) return 0; this.a[i] = v; return 1; },
    "incrementAndGet(I)J": function (this: JAtomicLongArray, i: number) { return (this.a[i] += 1n); },
    "addAndGet(IJ)J": function (this: JAtomicLongArray, i: number, d: bigint) { return (this.a[i] += d); },
    "length()I": function (this: JAtomicLongArray) { return this.a.length; },
  },
});

// ── TimeUnit (enum-like native)
class JTimeUnit extends JEnum { ms = 1; ns = 1000000n; }
// enum constant, ordinal, the to* method's name, one unit in nanoseconds
const TU_DEFS: [string, string, bigint][] = [
  ["NANOSECONDS", "Nanos", 1n], ["MICROSECONDS", "Micros", 1000n], ["MILLISECONDS", "Millis", 1000000n],
  ["SECONDS", "Seconds", 1000000000n], ["MINUTES", "Minutes", 60000000000n],
  ["HOURS", "Hours", 3600000000000n], ["DAYS", "Days", 86400000000000n],
];
const MAX_LONG = 9223372036854775807n, MIN_LONG = -9223372036854775808n;
/** Java truncates toward zero and saturates instead of overflowing */
const tuConvert = (v: bigint, from: bigint, to: bigint) => {
  const r = (v * from) / to;
  return r > MAX_LONG ? MAX_LONG : r < MIN_LONG ? MIN_LONG : r;
};
const TUS = Object.fromEntries(TU_DEFS.map(([name, , ns], ord) => {
  const t = new JTimeUnit();
  t.ename = name; t.ord = ord; t.ns = ns; t.ms = Number(ns) / 1e6;
  return [name, t];
})) as Record<string, JTimeUnit>;
rt.register({
  name: "java/util/concurrent/TimeUnit", ctor: JTimeUnit, sup: "java/lang/Enum",
  statics: { ...TUS },
  methods: {
    ...Object.fromEntries(TU_DEFS.map(([, method, ns]) =>
      [`to${method}(J)J`, function (this: JTimeUnit, v: bigint) { return tuConvert(v, this.ns, ns); }])),
    "convert(JLjava/util/concurrent/TimeUnit;)J": function (this: JTimeUnit, v: bigint, src: JTimeUnit) {
      return tuConvert(v, src.ns, this.ns);
    },
    "sleep(J)V": function (this: JTimeUnit, v: bigint) { return park(curThread, () => () => {}, Number(v) * this.ms); },
  },
});

// ── Executors: each worker owns one Java thread and runs one task through completion.
class JExecutor extends JObj {
  shut = false;
  pending = 0;
  removeOnCancel = 0;
  queue: JList | JObj | null = null;
  limit = 1;
  factory: unknown = null;
  workers: { thread: JThread | null; busy: boolean }[] = [];
  jobs = new Map<JFuture, unknown>();
  tasks: { task: unknown; f: JFuture; method: string; desc: string; finish: () => void }[] = [];
}
// a queue implemented in bytecode is only handed back by getQueue(); the executor's own task
// list stays the source of truth and native queues mirror it for size()/isEmpty()
const mirror = (ex: JExecutor) => (ex.queue instanceof JList ? ex.queue.a : null);
function drainExecutor(ex: JExecutor) {
  while (ex.tasks.length) {
    let worker = ex.workers.find((w) => !w.busy);
    if (!worker) {
      if (ex.workers.length >= ex.limit) return;
      worker = { thread: null, busy: false }; ex.workers.push(worker);
    }
    const task = ex.tasks.shift()!;
    mirror(ex)?.shift();
    worker.busy = true;
    void runTask(ex, worker, task);
  }
}
async function runTask(ex: JExecutor, worker: JExecutor["workers"][number], entry: JExecutor["tasks"][number]) {
  const { task, f, method, desc } = entry;
  try {
    if (f.cancelled) return;
    if (!worker.thread) {
      worker.thread = ex.factory ? await vcall(ex.factory, "newThread", "(Ljava/lang/Runnable;)Ljava/lang/Thread;", task) : rt.make("java/lang/Thread");
      if (!worker.thread) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "ThreadFactory returned null");
    }
    if (f.cancelled) return;
    worker.thread.alive = 1;
    worker.thread.interrupted = 0;
    f.thread = worker.thread;
    const prev = curThread;
    setCurThread(worker.thread);
    let running: Promise<unknown>;
    try { running = vcall(task, method, desc); } finally { setCurThread(prev); }
    const value = await running;
    if (!f.cancelled && value !== undefined) f.value = value;
  } catch (e) {
    if (!f.cancelled) f.error = rt.jx(e);
  } finally {
    ex.pending--; ex.jobs.delete(f); worker.busy = false;
    f.done = 1; f.thread = null;
    entry.finish();
    if (ex.tasks.length) setTimeout(() => drainExecutor(ex), 0);
    else if (ex.shut) for (const w of ex.workers) if (!w.busy && w.thread) w.thread.alive = 0;
  }
}
class JFuture extends JObj {
  promise: Promise<unknown> | null = null;
  value: unknown = null;
  error: unknown = null;
  done = 0;
  cancelled = 0;
  thread: JThread | null = null;
  cancel: ((interrupt: number) => void) | null = null;
}
/** get(): the value, or the task's throwable as ExecutionException (cause = it, message = its toString) */
async function futureGet(f: JFuture) {
  if (!f.cancelled && f.promise) await f.promise;
  if (f instanceof JCompletable) return completableValue(f, false);
  if (f.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
  if (f.error) throw await newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", f.error);
  return f.value;
}
async function futureGetTimed(f: JFuture, d: bigint, u: JTimeUnit) {
  if (!f.done && f.promise) {
    const late = {};
    const first = await Promise.race([f.promise, new Promise((r) => parkTimeout(() => r(late), Number(d) * u.ms))]);
    if (first === late && !f.done) throw rt.mkThrowable("java/util/concurrent/TimeoutException", null);
  }
  return futureGet(f);
}
rt.register({
  name: "webdroid/Future", ctor: JFuture,
  ifaces: ["java/util/concurrent/Future", "java/util/concurrent/ScheduledFuture"],
  methods: {
    "get()Ljava/lang/Object;": async function (this: JFuture) { return futureGet(this); },
    "get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JFuture, d: bigint, u: JTimeUnit) { return futureGetTimed(this, d, u); },
    "isDone()Z": function (this: JFuture) { return this.done; },
    "isCancelled()Z": function (this: JFuture) { return this.cancelled; },
    "cancel(Z)Z": function (this: JFuture, interrupt: number) {
      if (this.done) return 0;
      cancelFuture(this, interrupt); return 1;
    },
  },
});
function cancelFuture(f: JFuture, interrupt: number) {
  f.cancelled = f.done = 1;
  if (interrupt && f.thread) { f.thread.interrupted = 1; f.thread.wake?.(); }
  f.cancel?.(interrupt);
}
let futureCtor: (new () => JFuture) | null = null;
const newFuture = () => new (futureCtor ??= rt.link("webdroid/Future").ctor as new () => JFuture)();
function submit(ex: JExecutor, task: unknown, method: string, desc: string, delay = 0): JFuture {
  if (ex.shut) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "executor shut down");
  const f = newFuture();
  ex.pending++; ex.jobs.set(f, task);
  f.promise = new Promise((resolve) => {
    const entry = { task, f, method, desc, finish: () => resolve(null) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enqueue = () => {
      timer = undefined; ex.tasks.push(entry); mirror(ex)?.push(task);
      setTimeout(() => drainExecutor(ex), 0);
    };
    if (delay > 0) timer = setTimeout(enqueue, delay); else enqueue();
    f.cancel = () => {
      const index = ex.tasks.indexOf(entry);
      if (index >= 0) { ex.tasks.splice(index, 1); mirror(ex)?.splice(index, 1); ex.pending--; ex.jobs.delete(f); }
      else if (timer !== undefined) { clearTimeout(timer); timer = undefined; ex.pending--; ex.jobs.delete(f); }
      resolve(null);
    };
  });
  return f;
}
const executorMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "execute(Ljava/lang/Runnable;)V": function (this: JExecutor, r: unknown) {
    const f = submit(this, r, "run", "()V");
    void f.promise!.then(() => {
      if (!f.error) return;
      const e = f.error as { msg?: string; jsStack?: string; jframes?: string[] };
      console.error("[executor]", (e.msg ?? f.error) + (e.jframes ? "\n  at " + e.jframes.join("\n  at ") : ""), e.jsStack ?? "");
    });
  },
  "submit(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;": function (this: JExecutor, r: unknown) {
    return submit(this, r, "run", "()V");
  },
  "submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;": function (this: JExecutor, c: unknown) {
    return submit(this, c, "call", "()Ljava/lang/Object;");
  },
  "shutdown()V": function (this: JExecutor) { this.shut = true; },
  "shutdownNow()Ljava/util/List;": function (this: JExecutor) {
    this.shut = true;
    const result = newArrayList();
    for (const [future, task] of this.jobs) {
      if (!future.thread) result.a.push(task);
      cancelFuture(future, 1);
    }
    return result;
  },
  "isShutdown()Z": function (this: JExecutor) { return this.shut ? 1 : 0; },
  "isTerminated()Z": function (this: JExecutor) { return this.shut && this.pending === 0 ? 1 : 0; },
  "awaitTermination(JLjava/util/concurrent/TimeUnit;)Z": () => 1,
  "schedule(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;":
    function (this: JExecutor, r: unknown, d: bigint, u: JTimeUnit) {
      return submit(this, r, "run", "()V", Number(d) * u.ms);
    },
  "schedule(Ljava/util/concurrent/Callable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;":
    function (this: JExecutor, c: unknown, d: bigint, u: JTimeUnit) {
      return submit(this, c, "call", "()Ljava/lang/Object;", Number(d) * u.ms);
    },
  ...repeating("scheduleAtFixedRate", true),
  ...repeating("scheduleWithFixedDelay", false),
};
/** The two periodic schedules differ only in where the next run is measured from: a rate keeps
 *  the period's grid, a delay starts counting when the previous run finished. */
function repeating(name: string, fixedRate: boolean): NativeSpec["methods"] {
  return {
    [`${name}(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;`]:
    function (this: JExecutor, r: unknown, init: bigint, period: bigint, u: JTimeUnit) {
      if (period <= 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "nonpositive period");
      const f = newFuture();
      let next = performance.now() + Number(init) * u.ms, task: JFuture;
      f.promise = new Promise((resolve) => {
        const tick = () => {
          if (f.cancelled || this.shut) { f.done = 1; resolve(null); return; }
          task = submit(this, r, "run", "()V", next - performance.now());
          void task.promise!.then(() => {
            if (task.error) { f.error = task.error; f.done = 1; resolve(null); }
            else { next = (fixedRate ? next : performance.now()) + Number(period) * u.ms; tick(); }
          });
        };
        f.cancel = (interrupt) => {
          if (task) cancelFuture(task, interrupt);
          resolve(null);
        };
        tick();
      });
      return f;
    },
  };
}
function initScheduled(this: JExecutor, core: number, factory: unknown = null) {
  if (core < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative pool size");
  this.limit = Math.max(1, core); this.factory = factory;
}
function initPool(this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JList, factory: unknown = null) {
  if (core < 0 || max <= 0 || max < core || keep < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid pool size");
  this.limit = rt.iof(queue, "java/util/concurrent/SynchronousQueue") ? max : Math.max(1, core); this.queue = queue; this.factory = factory;
}
for (const n of ["java/util/concurrent/ThreadPoolExecutor", "java/util/concurrent/ScheduledThreadPoolExecutor",
  "webdroid/Executor"]) {
  rt.register({
    name: n, ctor: class extends JExecutor {},
    ifaces: ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor",
      "java/util/concurrent/ScheduledExecutorService"],
    // an app subclassing ThreadPoolExecutor to hook beforeExecute/afterExecute cannot link
    // until the class AOSP puts between it and Object exists
    sup: "java/util/concurrent/AbstractExecutorService",
    methods: {
      ...executorMethods,
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V": initPool,
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;)V": initPool,
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JList) { initPool.call(this, core, max, keep, unit, queue); },
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initPool,
      "<init>(I)V": initScheduled,
      "<init>(ILjava/util/concurrent/ThreadFactory;)V": initScheduled,
      "<init>(ILjava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number) { initScheduled.call(this, core); },
      "<init>(ILjava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initScheduled,
      "allowCoreThreadTimeOut(Z)V": function () {},
      "getPoolSize()I": function (this: JExecutor) { return this.workers.length; },
      "getActiveCount()I": function (this: JExecutor) { return this.workers.filter((w) => w.busy).length; },
      "getCorePoolSize()I": function (this: JExecutor) { return this.limit; },
      "getMaximumPoolSize()I": function (this: JExecutor) { return this.limit; },
      "setKeepAliveTime(JLjava/util/concurrent/TimeUnit;)V": function () {},
      "getQueue()Ljava/util/concurrent/BlockingQueue;": function (this: JExecutor) {
        if (!this.queue) { const queue = rt.make("java/util/concurrent/LinkedBlockingQueue") as JList; queue.a = this.tasks.map((t) => t.task); this.queue = queue; }
        return this.queue;
      },
      "purge()V": function () {},
      "setRejectedExecutionHandler(Ljava/util/concurrent/RejectedExecutionHandler;)V": function () {},
      // kotlinx looks this up reflectively (removeFutureOnCancel); a cancelled schedule() never runs
      // here regardless, so the policy is just remembered
      "setRemoveOnCancelPolicy(Z)V": function (this: JExecutor, v: number) { this.removeOnCancel = v; },
      "getRemoveOnCancelPolicy()Z": function (this: JExecutor) { return this.removeOnCancel; },
    },
  });
}
rt.register({
  name: "java/util/concurrent/AbstractExecutorService", ctor: class extends JExecutor {},
  ifaces: ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  methods: executorMethods,
});
class JExecutors extends JObj {}
class JDelegatedExecutor extends JObj { delegate: unknown = null; }
const delegated: NativeSpec["methods"] = {};
for (const signature of Object.keys(executorMethods)) {
  const [name, desc] = splitSig(signature);
  if (name === "<init>") continue;
  delegated[signature] = async function (this: JDelegatedExecutor, ...args: unknown[]) { return vcall(this.delegate, name, desc, ...args); };
}
rt.register({ name: "webdroid/DelegatedScheduledExecutor", ctor: JDelegatedExecutor,
  ifaces: ["java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"], methods: delegated });
export function mkExecutor(count = 1, factory: unknown = null): JExecutor {
  if (count <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "nonpositive pool size");
  const ex: JExecutor = rt.make("webdroid/Executor");
  ex.limit = count; ex.factory = factory; return ex;
}
/** A scheduled pool takes the constructor's rule, not the fixed pool's: zero cores is legal
 *  and still runs a due task. */
function mkScheduled(count = 1, factory: unknown = null): JExecutor {
  const ex: JExecutor = rt.make("webdroid/Executor");
  initScheduled.call(ex, count, factory);
  return ex;
}
// Executors.defaultThreadFactory()/callable() must hand back REAL objects: callers wrap them and
// invoke newThread()/call() themselves, so the auto-stubbed interfaces are not enough.
class JRunnableCallable extends JObj { r: unknown = null; result: unknown = null; }
rt.register({
  name: "webdroid/RunnableCallable", ctor: JRunnableCallable, ifaces: ["java/util/concurrent/Callable"],
  methods: {
    "call()Ljava/lang/Object;": async function (this: JRunnableCallable) {
      await vcall(this.r, "run", "()V");
      return this.result;
    },
  },
});
rt.register({
  name: "webdroid/DefaultThreadFactory", ctor: class extends JObj {},
  ifaces: ["java/util/concurrent/ThreadFactory"],
  methods: {
    "newThread(Ljava/lang/Runnable;)Ljava/lang/Thread;": (r: unknown) => {
      const t = new (rt.link("java/lang/Thread").ctor as typeof JThread)();
      t.target = r;
      return t;
    },
  },
});
rt.register({
  name: "java/util/concurrent/Executors", ctor: JExecutors,
  methods: {
    "static defaultThreadFactory()Ljava/util/concurrent/ThreadFactory;":
      () => rt.make("webdroid/DefaultThreadFactory"),
    "static callable(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Callable;":
      (r: unknown, result: unknown) => {
        const c = new (rt.link("webdroid/RunnableCallable").ctor as typeof JRunnableCallable)();
        c.r = r; c.result = result;
        return c;
      },
    "static newSingleThreadExecutor()Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newSingleThreadExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": (factory: unknown) => mkExecutor(1, factory),
    "static newFixedThreadPool(I)Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newFixedThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newCachedThreadPool()Ljava/util/concurrent/ExecutorService;": () => mkExecutor(Infinity),
    "static newCachedThreadPool(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": (factory: unknown) => mkExecutor(Infinity, factory),
    "static newScheduledThreadPool(I)Ljava/util/concurrent/ScheduledExecutorService;": mkScheduled,
    "static newScheduledThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": mkScheduled,
    "static newSingleThreadScheduledExecutor()Ljava/util/concurrent/ScheduledExecutorService;": mkExecutor,
    "static newSingleThreadScheduledExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": (factory: unknown) => mkExecutor(1, factory),
    "static unconfigurableExecutorService(Ljava/util/concurrent/ExecutorService;)Ljava/util/concurrent/ExecutorService;": (e: unknown) => e,
    "static unconfigurableScheduledExecutorService(Ljava/util/concurrent/ScheduledExecutorService;)Ljava/util/concurrent/ScheduledExecutorService;": (executor: unknown) => {
      if (executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      rt.link("webdroid/DelegatedScheduledExecutor");
      const wrapper = new JDelegatedExecutor(); wrapper.delegate = executor; return wrapper;
    },
  },
});

// ── locks (no-op-ish under cooperative scheduling)
class JLock extends JObj { held = 0; }
rt.register({
  name: "java/util/concurrent/locks/ReentrantLock", ctor: JLock,
  ifaces: ["java/util/concurrent/locks/Lock"],
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function () {},
    "lock()V": function (this: JLock) { this.held++; },
    "unlock()V": function (this: JLock) { this.held--; },
    "tryLock()Z": function (this: JLock) { this.held++; return 1; },
    "lockInterruptibly()V": function (this: JLock) { this.held++; },
    "isHeldByCurrentThread()Z": function (this: JLock) { return this.held > 0 ? 1 : 0; },
    "isLocked()Z": function (this: JLock) { return this.held > 0 ? 1 : 0; },
    "newCondition()Ljava/util/concurrent/locks/Condition;": function () { return new JCondition(); },
  },
});
class JCondition extends JObj {
  q: (() => void)[] = [];
}
function condPark(c: JCondition, ms?: number) {
  return park(curThread, (wake) => {
    c.q.push(wake);
    return () => { const i = c.q.indexOf(wake); if (i >= 0) c.q.splice(i, 1); };
  }, ms);
}
rt.register({
  name: "webdroid/Condition", ctor: JCondition, ifaces: ["java/util/concurrent/locks/Condition"],
  methods: {
    "await()V": function (this: JCondition) { return condPark(this); },
    "awaitUninterruptibly()V": function (this: JCondition) { return new Promise<void>((r) => this.q.push(r)); },
    "await(JLjava/util/concurrent/TimeUnit;)Z": async function (this: JCondition, d: bigint, u: JTimeUnit) {
      return (await condPark(this, Number(d) * u.ms)) ? 1 : 0;
    },
    "awaitNanos(J)J": async function (this: JCondition, n: bigint) {
      const t0 = performance.now();
      if (!(await condPark(this, Number(n) / 1e6))) return 0n;
      return n - BigInt(Math.round((performance.now() - t0) * 1e6));
    },
    "signal()V": function (this: JCondition) { const w = this.q.shift(); if (w) queueMicrotask(w); },
    "signalAll()V": function (this: JCondition) { const ws = this.q.splice(0); for (const w of ws) queueMicrotask(w); },
  },
});

class JCountDownLatch extends JObj {
  n = 0;
  waiters: (() => void)[] = [];
}
rt.register({
  name: "java/util/concurrent/CountDownLatch", ctor: JCountDownLatch,
  methods: {
    "<init>(I)V": function (this: JCountDownLatch, n: number) { this.n = n; },
    "countDown()V": function (this: JCountDownLatch) {
      if (this.n > 0 && --this.n === 0) for (const w of this.waiters.splice(0)) queueMicrotask(w);
    },
    "getCount()J": function (this: JCountDownLatch) { return BigInt(this.n); },
    "await()V": function (this: JCountDownLatch) {
      if (this.n === 0) return;
      return new Promise<void>((r) => this.waiters.push(r));
    },
    "await(JLjava/util/concurrent/TimeUnit;)Z": function (this: JCountDownLatch, d: bigint, u: JTimeUnit) {
      if (this.n === 0) return 1;
      return new Promise<number>((resolve) => {
        const done = () => resolve(1);
        this.waiters.push(done);
        setTimeout(() => {
          const i = this.waiters.indexOf(done);
          if (i >= 0) { this.waiters.splice(i, 1); resolve(0); }
        }, Number(d) * u.ms);
      });
    },
  },
});

type WaitingQueue = { a: unknown[]; takers: ((value: unknown) => void)[] };

const takeFirst = function (this: WaitingQueue): unknown {
  return this.a.length ? this.a.shift() : new Promise((resolve) => this.takers.push(resolve));
};

const timedPoll = function (this: WaitingQueue, d: bigint, u: JTimeUnit): unknown {
  if (this.a.length) return this.a.shift();
  return new Promise((resolve) => {
    const taker = (v: unknown) => resolve(v);
    this.takers.push(taker);
    setTimeout(() => {
      const i = this.takers.indexOf(taker);
      if (i >= 0) { this.takers.splice(i, 1); resolve(null); }
    }, Number(d) * u.ms);
  });
};

class JBlockingQueue extends JList {
  takers: ((v: unknown) => void)[] = [];
  /** hand the value to a parked take(), else queue it */
  enqueue(v: unknown, front = false) {
    const t = this.takers.shift();
    if (t) queueMicrotask(() => t(v));
    else if (front) this.a.unshift(v);
    else this.a.push(v);
  }
}
async function drainTo(this: JBlockingQueue, collection: unknown, max = 0x7fffffff) {
  if (collection == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (collection === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  if (max <= 0) return 0;
  const batch = this.a.splice(0, max);
  let count = 0;
  try {
    for (const value of batch) { await vcall(collection, "add", "(Ljava/lang/Object;)Z", value); count++; }
  } finally { if (count < batch.length) this.a.unshift(...batch.slice(count)); }
  return count;
}
/** BlockingDeque's ends: a parked taker still receives whatever arrives next, either end. */
const dequeMethods = (): NonNullable<NativeSpec["methods"]> => ({
  "putFirst(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v, true); },
  "offerFirst(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v, true); return 1; },
  "addFirst(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v, true); },
  "addLast(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); },
  "putLast(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); },
  "offerLast(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); return 1; },
  "takeFirst()Ljava/lang/Object;": takeFirst,
  "takeLast()Ljava/lang/Object;": function (this: JBlockingQueue) {
    return this.a.length ? this.a.pop() : new Promise((r) => this.takers.push(r));
  },
  "pollFirst()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.a.length ? this.a.shift() : null; },
  "pollLast()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.a.length ? this.a.pop() : null; },
  "peekFirst()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.a[0] ?? null; },
  "peekLast()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.a[this.a.length - 1] ?? null; },
});
const mkBlockingQueue = (name: string, deque = false) => rt.register({
  name, ctor: class extends JBlockingQueue {},
  ifaces: deque
    ? ["java/util/concurrent/BlockingDeque", "java/util/Deque", "java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable"]
    : ["java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
  methods: {
    ...(deque ? dequeMethods() : {}),
    ...Object.fromEntries(Object.entries(listMethods() ?? {}).filter(([k]) => !k.startsWith("<init>"))),
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "put(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); },
    "offer(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); return 1; },
    "offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); return 1; },
    "add(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); return 1; },
    "take()Ljava/lang/Object;": takeFirst,
    "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": timedPoll,
    "drainTo(Ljava/util/Collection;)I": drainTo,
    "drainTo(Ljava/util/Collection;I)I": drainTo,
  },
});
for (const qn of ["java/util/concurrent/LinkedBlockingQueue", "java/util/concurrent/SynchronousQueue", "java/util/concurrent/ArrayBlockingQueue", "java/util/concurrent/LinkedTransferQueue"]) mkBlockingQueue(qn);
mkBlockingQueue("java/util/concurrent/LinkedBlockingDeque", true);
// PriorityBlockingQueue: the sorted queue with a parking take(); a parked taker receives the
// element that would have become the head
class JPriorityBlockingQueue extends JPriorityQueue { takers: ((v: unknown) => void)[] = []; }
async function pbqPut(this: JPriorityBlockingQueue, v: unknown) {
  const t = this.takers.shift();
  if (t) { queueMicrotask(() => t(v)); return 1; }
  await pqInsert(this, v);
  return 1;
}
rt.register({
  name: "java/util/concurrent/PriorityBlockingQueue", ctor: JPriorityBlockingQueue,
  ifaces: ["java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable", "java/io/Serializable"],
  methods: {
    ...priorityQueueMethods(),
    "put(Ljava/lang/Object;)V": pbqPut,
    "offer(Ljava/lang/Object;)Z": pbqPut,
    "add(Ljava/lang/Object;)Z": pbqPut,
    "offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z": pbqPut,
    "take()Ljava/lang/Object;": takeFirst,
    "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": timedPoll,
    "remainingCapacity()I": () => 0x7fffffff,
    "drainTo(Ljava/util/Collection;)I": async function (this: JPriorityBlockingQueue, c: unknown) {
      const n = this.a.length;
      for (const v of this.a.splice(0)) await vcall(c, "add", "(Ljava/lang/Object;)Z", v);
      return n;
    },
  },
});

class JSemaphore extends JObj {
  permits = 0;
  q: { n: number; wake: () => void }[] = [];
  acquire(n: number, ms?: number): number | Promise<number> {
    if (this.permits >= n) { this.permits -= n; return 1; }
    if (ms !== undefined && ms <= 0) return 0;
    return new Promise<number>((r) => {
      const w = { n, wake: () => { unparkTimeout(id); r(1); } };
      this.q.push(w);
      const id = ms === undefined ? undefined : parkTimeout(() => { this.q.splice(this.q.indexOf(w), 1); r(0); }, ms);
    });
  }
  release(n: number): void {
    this.permits += n;
    while (this.q.length && this.q[0].n <= this.permits) { const w = this.q.shift()!; this.permits -= w.n; queueMicrotask(w.wake); }
  }
}
const TU = "Ljava/util/concurrent/TimeUnit;";
rt.register({
  name: "java/util/concurrent/Semaphore", ctor: JSemaphore,
  methods: {
    "<init>(I)V": function (this: JSemaphore, n: number) { this.permits = n; },
    "<init>(IZ)V": function (this: JSemaphore, n: number) { this.permits = n; },
    "acquire()V": function (this: JSemaphore) { return this.acquire(1); },
    "acquire(I)V": function (this: JSemaphore, n: number) { return this.acquire(n); },
    "acquireUninterruptibly()V": function (this: JSemaphore) { return this.acquire(1); },
    "release()V": function (this: JSemaphore) { this.release(1); },
    "release(I)V": function (this: JSemaphore, n: number) { this.release(n); },
    "tryAcquire()Z": function (this: JSemaphore) { return this.acquire(1, 0); },
    "tryAcquire(I)Z": function (this: JSemaphore, n: number) { return this.acquire(n, 0); },
    [`tryAcquire(J${TU})Z`]: function (this: JSemaphore, t: bigint, u: JTimeUnit) { return this.acquire(1, Number(t) * u.ms); },
    [`tryAcquire(IJ${TU})Z`]: function (this: JSemaphore, n: number, t: bigint, u: JTimeUnit) { return this.acquire(n, Number(t) * u.ms); },
    "availablePermits()I": function (this: JSemaphore) { return this.permits; },
    "drainPermits()I": function (this: JSemaphore) { const permits = this.permits; this.permits = 0; return permits; },
  },
});

for (const [i, ...ifaces] of [["java/util/concurrent/Executor"], ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  ["java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"], ["java/util/concurrent/Future"],
  ["java/util/concurrent/ScheduledFuture", "java/util/concurrent/Future"], ["java/util/concurrent/Callable"], ["java/util/concurrent/ThreadFactory"],
  ["java/util/concurrent/RejectedExecutionHandler"]]) {
  rt.register({ name: i, ctor: class extends JObj {}, ifaces });
}
// ThreadPoolExecutor's four saturation policies. Our executors never saturate, so the policy is
// only ever constructed and handed over — but a pool built with one must not fail to link.
for (const [n, run] of [["AbortPolicy", 0], ["CallerRunsPolicy", 1], ["DiscardPolicy", 0], ["DiscardOldestPolicy", 0]] as const) {
  rt.register({
    name: "java/util/concurrent/ThreadPoolExecutor$" + n, ctor: class extends JObj {},
    ifaces: ["java/util/concurrent/RejectedExecutionHandler"],
    methods: {
      "<init>()V": function () {},
      "rejectedExecution(Ljava/lang/Runnable;Ljava/util/concurrent/ThreadPoolExecutor;)V": (r: unknown) => {
        if (run) return vcall(r, "run", "()V");
        if (n === "AbortPolicy") throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "rejected");
      },
    },
  });
}
rt.register({ name: "java/util/concurrent/BlockingQueue", ctor: class extends JObj {}, ifaces: ["java/util/Queue"] });
rt.register({ name: "java/util/concurrent/BlockingDeque", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/BlockingQueue", "java/util/Deque"] });
defineException("java/util/concurrent/RejectedExecutionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/TimeoutException", "java/lang/Exception");
defineException("java/util/concurrent/ExecutionException", "java/lang/Exception");
defineException("java/util/concurrent/CompletionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/CancellationException", "java/lang/IllegalStateException");

class JAtomicArr extends JObj { a: unknown[] = []; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicReferenceArray", ctor: JAtomicArr,
  methods: {
    "<init>(I)V": function (this: JAtomicArr, n: number) { this.a = new Array(n).fill(null); },
    "<init>([Ljava/lang/Object;)V": function (this: JAtomicArr, src: unknown[]) { this.a = (src ?? []).slice(); },
    "length()I": function (this: JAtomicArr) { return this.a.length; },
    "get(I)Ljava/lang/Object;": function (this: JAtomicArr, i: number) { return this.a[i] ?? null; },
    "set(ILjava/lang/Object;)V": function (this: JAtomicArr, i: number, v: unknown) { this.a[i] = v; },
    "lazySet(ILjava/lang/Object;)V": function (this: JAtomicArr, i: number, v: unknown) { this.a[i] = v; },
    "getAndSet(ILjava/lang/Object;)Ljava/lang/Object;": function (this: JAtomicArr, i: number, v: unknown) { const o = this.a[i] ?? null; this.a[i] = v; return o; },
    "compareAndSet(ILjava/lang/Object;Ljava/lang/Object;)Z": function (this: JAtomicArr, i: number, e: unknown, v: unknown) {
      if ((this.a[i] ?? null) !== e) return 0;
      this.a[i] = v; return 1;
    },
  },
});

// ── Atomic*FieldUpdater: operate on the mangled property resolved from the class
function fieldProp(cls: { ci?: ClassInfo | null } | null, name: string): string {
  for (let ci = cls?.ci; ci; ci = ci.superInfo) {
    const p = ci.fieldTable.get(name);
    if (p) return p;
  }
  return name;
}
class JFieldUpdater extends JObj { prop = ""; }
function mkUpdater(cls: string, target: { ci?: ClassInfo | null } | null, field: string): JFieldUpdater {
  const u = rt.make(cls) as JFieldUpdater;
  u.prop = fieldProp(target, field);
  return u;
}
const updaterCommon = (zero: unknown) => ({
  "get(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? zero; },
  "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JFieldUpdater, o: any, v: unknown) { o[this.prop] = v; },
  "lazySet(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JFieldUpdater, o: any, v: unknown) { o[this.prop] = v; },
  "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Z": function (this: JFieldUpdater, o: any, e: unknown, v: unknown) {
    const cur = o[this.prop] ?? zero;
    if (cur !== e && !(cur === zero && e === null)) return 0;
    o[this.prop] = v; return 1;
  },
  "getAndSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JFieldUpdater, o: any, v: unknown) {
    const old = o[this.prop] ?? zero; o[this.prop] = v; return old;
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicReferenceFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicReferenceFieldUpdater;":
      (cls: any, _vc: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicReferenceFieldUpdater", cls, name),
    ...updaterCommon(null),
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicLongFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicLongFieldUpdater;":
      (cls: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicLongFieldUpdater", cls, name),
    "get(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? 0n; },
    "set(Ljava/lang/Object;J)V": function (this: JFieldUpdater, o: any, v: bigint) { o[this.prop] = v; },
    "lazySet(Ljava/lang/Object;J)V": function (this: JFieldUpdater, o: any, v: bigint) { o[this.prop] = v; },
    "incrementAndGet(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) + 1n)); },
    "getAndIncrement(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old + 1n); return old; },
    "getAndDecrement(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old - 1n); return old; },
    "decrementAndGet(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) - 1n)); },
    "getAndAdd(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, d: bigint) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old + d); return old; },
    "addAndGet(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, d: bigint) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) + d)); },
    "compareAndSet(Ljava/lang/Object;JJ)Z": function (this: JFieldUpdater, o: any, e: bigint, v: bigint) {
      if ((o[this.prop] ?? 0n) !== e) return 0;
      o[this.prop] = v; return 1;
    },
    "getAndSet(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, v: bigint) { const old = o[this.prop] ?? 0n; o[this.prop] = v; return old; },
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicIntegerFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicIntegerFieldUpdater;":
      (cls: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicIntegerFieldUpdater", cls, name),
    "get(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? 0; },
    "set(Ljava/lang/Object;I)V": function (this: JFieldUpdater, o: any, v: number) { o[this.prop] = v; },
    "lazySet(Ljava/lang/Object;I)V": function (this: JFieldUpdater, o: any, v: number) { o[this.prop] = v; },
    "incrementAndGet(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return (o[this.prop] = ((o[this.prop] ?? 0) + 1) | 0); },
    "getAndIncrement(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0; o[this.prop] = (old + 1) | 0; return old; },
    "decrementAndGet(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return (o[this.prop] = ((o[this.prop] ?? 0) - 1) | 0); },
    "getAndDecrement(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0; o[this.prop] = (old - 1) | 0; return old; },
    "getAndAdd(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, d: number) { const old = o[this.prop] ?? 0; o[this.prop] = (old + d) | 0; return old; },
    "addAndGet(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, d: number) { return (o[this.prop] = ((o[this.prop] ?? 0) + d) | 0); },
    "compareAndSet(Ljava/lang/Object;II)Z": function (this: JFieldUpdater, o: any, e: number, v: number) {
      if ((o[this.prop] ?? 0) !== e) return 0;
      o[this.prop] = v; return 1;
    },
    "getAndSet(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, v: number) { const old = o[this.prop] ?? 0; o[this.prop] = v; return old; },
  },
});

// one process-wide Random (there is one JS thread), seeded from the CSPRNG
class JTlr extends JRandom {}
const threadLocalRandom = new JTlr();
threadLocalRandom.setSeed(randomSeed());
rt.register({
  name: "java/util/concurrent/ThreadLocalRandom", ctor: JTlr, sup: "java/util/Random",
  methods: {
    "static current()Ljava/util/concurrent/ThreadLocalRandom;": () => threadLocalRandom,
    "nextInt(II)I": function (this: JTlr, a: number, b: number) { return a + (this.next(31) % (b - a)); },
  },
});

type RWWaiter = { thread: JThread; write: boolean; wake: () => void };
class JRWLock extends JObj {
  readers = new Map<JThread, number>();
  writer: JThread | null = null;
  writes = 0;
  fair = false;
  queue: RWWaiter[] = [];
  read: JRWInner | null = null;
  write: JRWInner | null = null;
  acquire(thread: JThread, write: boolean, barge = false): boolean {
    const reentrant = this.writer === thread || (!write && this.readers.has(thread));
    if (this.writer && this.writer !== thread || write && !this.writer && this.readers.size) return false;
    if (!barge && !reentrant && this.queue.length && (this.fair || !write && this.queue[0].write)) return false;
    if (write) { this.writer = thread; this.writes++; }
    else this.readers.set(thread, (this.readers.get(thread) ?? 0) + 1);
    return true;
  }
  drain() {
    while (this.queue.length) {
      const first = this.queue[0];
      if (!this.acquire(first.thread, first.write, true)) break;
      this.queue.shift(); first.wake();
    }
  }
  arm(thread: JThread, write: boolean, wake: () => void) {
    const waiter = { thread, write, wake };
    this.queue.push(waiter);
    return () => { const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); this.drain(); };
  }
}
class JRWInner extends JObj {
  owner!: JRWLock;
  write = false;
  lock(interruptible: boolean, timeout?: number): void | boolean | Promise<boolean> {
    const thread = curThread;
    if (interruptible && thread.interrupted) {
      thread.interrupted = 0;
      throw rt.mkThrowable("java/lang/InterruptedException", null);
    }
    if (this.owner.acquire(thread, this.write)) return true;
    if (timeout !== undefined && timeout <= 0) return false;
    return interruptible ? park(thread, (wake) => this.owner.arm(thread, this.write, wake), timeout)
      : new Promise<boolean>((resolve) => this.owner.arm(thread, this.write, () => resolve(true)));
  }
}
const rwMethods: NativeSpec["methods"] = {
  "<init>(Ljava/util/concurrent/locks/ReentrantReadWriteLock;)V": function (this: JRWInner, owner: JRWLock) { this.owner = owner; },
  "lock()V": function (this: JRWInner) { return this.lock(false); },
  "lockInterruptibly()V": function (this: JRWInner) { return this.lock(true); },
  "tryLock()Z": function (this: JRWInner) { return this.owner.acquire(curThread, this.write, true) ? 1 : 0; },
  "tryLock(JLjava/util/concurrent/TimeUnit;)Z": async function (this: JRWInner, duration: bigint, unit: JTimeUnit) { return await this.lock(true, Number(duration) * unit.ms) ? 1 : 0; },
  "unlock()V": function (this: JRWInner) {
    const lock = this.owner, thread = curThread;
    if (this.write) {
      if (lock.writer !== thread) throw rt.mkThrowable("java/lang/IllegalMonitorStateException", "Write lock not held by current thread");
      if (!--lock.writes) lock.writer = null;
    } else {
      const count = lock.readers.get(thread) ?? 0;
      if (!count) throw rt.mkThrowable("java/lang/IllegalMonitorStateException", "Read lock not held by current thread");
      if (count === 1) lock.readers.delete(thread); else lock.readers.set(thread, count - 1);
    }
    lock.drain();
  },
  "newCondition()Ljava/util/concurrent/locks/Condition;": function (this: JRWInner) {
    if (!this.write) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
    throw rt.unimplemented("ReentrantReadWriteLock.WriteLock.newCondition");
  },
};
function rwHandle(lock: JRWLock, write: boolean): JRWInner {
  const existing = write ? lock.write : lock.read;
  if (existing) return existing;
  const inner: JRWInner = rt.make("java/util/concurrent/locks/ReentrantReadWriteLock$" + (write ? "WriteLock" : "ReadLock"));
  inner.owner = lock;
  if (write) lock.write = inner; else lock.read = inner;
  return inner;
}
const readLock = function (this: JRWLock) { return rwHandle(this, false); };
const writeLock = function (this: JRWLock) { return rwHandle(this, true); };
rt.register({
  name: "java/util/concurrent/locks/ReentrantReadWriteLock", ctor: JRWLock,
  ifaces: ["java/util/concurrent/locks/ReadWriteLock", "java/io/Serializable"],
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function (this: JRWLock, fair: number) { this.fair = !!fair; },
    "readLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$ReadLock;": readLock,
    "writeLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$WriteLock;": writeLock,
    "readLock()Ljava/util/concurrent/locks/Lock;": readLock,
    "writeLock()Ljava/util/concurrent/locks/Lock;": writeLock,
    "getReadHoldCount()I": function (this: JRWLock) { return this.readers.get(curThread) ?? 0; },
    "getWriteHoldCount()I": function (this: JRWLock) { return this.writer === curThread ? this.writes : 0; },
    "getReadLockCount()I": function (this: JRWLock) { let count = 0; for (const holds of this.readers.values()) count += holds; return count; },
    "isWriteLocked()Z": function (this: JRWLock) { return this.writes ? 1 : 0; },
    "isWriteLockedByCurrentThread()Z": function (this: JRWLock) { return this.writer === curThread ? 1 : 0; },
    "isFair()Z": function (this: JRWLock) { return this.fair ? 1 : 0; },
  },
});
rt.register({ name: "java/util/concurrent/locks/ReentrantReadWriteLock$ReadLock", ctor: class extends JRWInner {}, ifaces: ["java/util/concurrent/locks/Lock", "java/io/Serializable"], methods: rwMethods });
rt.register({ name: "java/util/concurrent/locks/ReentrantReadWriteLock$WriteLock", ctor: class extends JRWInner { write = true; }, ifaces: ["java/util/concurrent/locks/Lock", "java/io/Serializable"], methods: rwMethods });
for (const name of ["java/util/concurrent/locks/ReadWriteLock", "java/util/concurrent/locks/Lock", "java/util/concurrent/locks/Condition"]) rt.register({ name, ctor: class extends JObj {} });

// ── ConcurrentLinkedQueue / LockSupport / FutureTask
for (const n of ["java/util/concurrent/ConcurrentLinkedQueue", "java/util/AbstractQueue"]) {
  rt.register({
    name: n, ctor: class extends JList {},
    ifaces: ["java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
    methods: listMethods(),
  });
}
// A parked thread wakes on its permit, its deadline, or an interrupt. The wake is a macrotask
// so the unparker's own chain runs to its next await first, and an untimed park still polls,
// as Java's spurious wakeups allow, so a permit lost to a stale thread identity cannot hang it.
function parkThread(t: JThread, timeoutMs = 1000): void | Promise<void> {
  if (t.permit) { t.permit = false; return; }
  return park(t, (wake) => { t.unpark = () => setTimeout(wake, 0); return () => { t.unpark = null; }; }, timeoutMs).then(() => { t.permit = false; });
}
rt.register({
  name: "java/util/concurrent/locks/LockSupport", ctor: class extends JObj {},
  methods: {
    "static park()V": () => parkThread(curThread),
    "static park(Ljava/lang/Object;)V": () => parkThread(curThread),
    "static parkNanos(J)V": (n: bigint) => parkThread(curThread, Number(n) / 1e6),
    "static parkNanos(Ljava/lang/Object;J)V": (_b: unknown, n: bigint) => parkThread(curThread, Number(n) / 1e6),
    "static unpark(Ljava/lang/Thread;)V": (t: JThread | null) => { if (!t) return; if (t.unpark) { t.unpark(); t.unpark = null; } else t.permit = true; },
  },
});
// CompletableFuture: completed from outside, so the promise is armed by the constructor
class JCompletable extends JFuture { settle: () => void = () => {}; }
const completable = () => { const f = new JCompletable(); f.promise = new Promise<void>((r) => { f.settle = r; }); return f; };
const settleWith = (f: JCompletable, value: unknown, error: unknown) => { if (f.done) return 0; f.value = value; f.error = error; f.cancelled = rt.iof(error, "java/util/concurrent/CancellationException") ? 1 : 0; f.done = 1; f.settle(); return 1; };
const completionError = (error: unknown) => rt.iof(error, "java/util/concurrent/CompletionException")
  ? error : newObj("java/util/concurrent/CompletionException", "(Ljava/lang/Throwable;)V", error);
async function completableValue(future: JCompletable, join: boolean) {
  if (future.cancelled) throw future.error;
  if (!future.error) return future.value;
  if (join) throw await completionError(future.error);
  const cause = rt.iof(future.error, "java/util/concurrent/CompletionException")
    ? await vcall(future.error, "getCause", "()Ljava/lang/Throwable;") : null;
  throw await newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", cause ?? future.error);
}
class JAsyncSupply extends JObj {
  constructor(public future: JCompletable, public supplier: unknown) { super(); }
}
rt.register({
  name: "webdroid/AsyncSupply", ctor: JAsyncSupply,
  ifaces: ["java/lang/Runnable", "java/util/concurrent/CompletableFuture$AsynchronousCompletionTask"],
  methods: {
    "run()V": async function (this: JAsyncSupply) {
      if (this.future.done) return;
      try { settleWith(this.future, await vcall(this.supplier, "get", "()Ljava/lang/Object;"), null); }
      catch (error) { settleWith(this.future, null, await completionError(rt.jx(error))); }
    },
  },
});
let completionExecutor: JExecutor | null = null;
async function supplyAsync(supplier: unknown, executor: unknown) {
  if (supplier == null || executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const future = completable();
  rt.link("webdroid/AsyncSupply");
  await vcall(executor, "execute", "(Ljava/lang/Runnable;)V", new JAsyncSupply(future, supplier));
  return future;
}
rt.register({
  name: "java/util/concurrent/CompletableFuture", ctor: JCompletable, sup: "webdroid/Future",
  ifaces: ["java/util/concurrent/Future", "java/util/concurrent/CompletionStage"],
  methods: {
    "<init>()V": function (this: JCompletable) { this.promise = new Promise<void>((r) => { this.settle = r; }); },
    "static completedFuture(Ljava/lang/Object;)Ljava/util/concurrent/CompletableFuture;": (v: unknown) => { const f = completable(); settleWith(f, v, null); return f; },
    "static supplyAsync(Ljava/util/function/Supplier;)Ljava/util/concurrent/CompletableFuture;": (supplier: unknown) =>
      supplyAsync(supplier, completionExecutor ??= mkExecutor(Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))),
    "static supplyAsync(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;": supplyAsync,
    "complete(Ljava/lang/Object;)Z": function (this: JCompletable, v: unknown) { return settleWith(this, v, null); },
    "completeExceptionally(Ljava/lang/Throwable;)Z": function (this: JCompletable, t: unknown) { if (t == null) throw rt.mkThrowable("java/lang/NullPointerException", null); return settleWith(this, null, t); },
    "join()Ljava/lang/Object;": async function (this: JCompletable) { if (!this.done) await this.promise; return completableValue(this, true); },
    "getNow(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JCompletable, d: unknown) { return !this.done ? d : this.error ? completableValue(this, true) : this.value; },
    "isCompletedExceptionally()Z": function (this: JCompletable) { return this.done && this.error ? 1 : 0; },
    "cancel(Z)Z": function (this: JCompletable) { return settleWith(this, null, rt.mkThrowable("java/util/concurrent/CancellationException", null)) || this.cancelled; },
  },
});
rt.markers("java/util/concurrent/CompletionStage", "java/util/concurrent/CompletableFuture$AsynchronousCompletionTask");

class JFutureTask extends JFuture {
  callable: unknown = null;
  wake: (v: unknown) => void = () => {};
}
function armTask(t: JFutureTask, callable: unknown) {
  t.callable = callable;
  t.promise = new Promise((r) => (t.wake = r));
}
rt.register({
  name: "java/util/concurrent/FutureTask", ctor: JFutureTask,
  ifaces: ["java/util/concurrent/Future", "java/lang/Runnable", "java/util/concurrent/RunnableFuture"],
  methods: {
    "<init>(Ljava/util/concurrent/Callable;)V": function (this: JFutureTask, c: unknown) { armTask(this, c); },
    "<init>(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JFutureTask, r: unknown, v: unknown) {
      armTask(this, { runnable: r });
      this.value = v;
    },
    "run()V": async function (this: JFutureTask) {
      try {
        const c = this.callable as any;
        if (c?.runnable) await vcall(c.runnable, "run", "()V");
        else if (c) this.value = await vcall(c, "call", "()Ljava/lang/Object;");
      } catch (e) { this.error = rt.jx(e); } // surfaces from get(), as AOSP's setException
      this.done = 1;
      this.wake(null);
    },
    "get()Ljava/lang/Object;": function (this: JFutureTask) { return futureGet(this); },
    "get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JFutureTask, d: bigint, u: JTimeUnit) { return futureGetTimed(this, d, u); },
    "isDone()Z": function (this: JFutureTask) { return this.done; },
    "isCancelled()Z": () => 0,
    "cancel(Z)Z": () => 0,
  },
});
rt.markers("java/util/concurrent/RunnableFuture");

// ── AbstractQueuedSynchronizer: the state word, its CAS, and FIFO waiting in exclusive and shared
// modes; a subclass supplies tryAcquire/tryRelease (and the shared pair) as the JDK's does
class JAQS extends JObj { state = 0; q: (() => void)[] = []; owner: unknown = null; }
const D_TA = "(I)Z", D_TAS = "(I)I";
async function aqsAcquire(self: JAQS, arg: number, shared: boolean): Promise<void> {
  for (;;) {
    const ok = shared ? ((await vcall(self, "tryAcquireShared", D_TAS, arg)) as number) >= 0 : !!(await vcall(self, "tryAcquire", D_TA, arg));
    if (ok) { if (shared) for (const w of self.q.splice(0)) w(); return; }   // a shared acquire propagates
    await new Promise<void>((r) => self.q.push(r));
  }
}
async function aqsAcquireTimed(self: JAQS, arg: number, shared: boolean, ns: bigint): Promise<number> {
  let done = false;
  const t = parkTimeout(() => { done = true; for (const w of self.q.splice(0)) w(); }, Number(ns) / 1e6);
  for (;;) {
    if (shared ? ((await vcall(self, "tryAcquireShared", D_TAS, arg)) as number) >= 0 : await vcall(self, "tryAcquire", D_TA, arg)) {
      unparkTimeout(t);
      if (shared) for (const w of self.q.splice(0)) w();
      return 1;
    }
    if (done) return 0;
    await new Promise<void>((r) => self.q.push(r));
  }
}
async function aqsRelease(self: JAQS, arg: number, shared: boolean): Promise<number> {
  const ok = await vcall(self, shared ? "tryReleaseShared" : "tryRelease", D_TA, arg);
  if (ok) for (const w of self.q.splice(0)) w();
  return ok ? 1 : 0;
}
rt.register({
  name: "java/util/concurrent/locks/AbstractQueuedSynchronizer", ctor: JAQS, sup: "java/util/concurrent/locks/AbstractOwnableSynchronizer",
  methods: {
    "<init>()V": function () {},
    "getState()I": function (this: JAQS) { return this.state; },
    "setState(I)V": function (this: JAQS, v: number) { this.state = v; },
    "compareAndSetState(II)Z": function (this: JAQS, e: number, v: number) { if (this.state !== e) return 0; this.state = v; return 1; },
    "acquire(I)V": function (this: JAQS, a: number) { return aqsAcquire(this, a, false); },
    "acquireInterruptibly(I)V": function (this: JAQS, a: number) { return aqsAcquire(this, a, false); },
    "acquireShared(I)V": function (this: JAQS, a: number) { return aqsAcquire(this, a, true); },
    "acquireSharedInterruptibly(I)V": function (this: JAQS, a: number) { return aqsAcquire(this, a, true); },
    "tryAcquireNanos(IJ)Z": async function (this: JAQS, a: number, ns: bigint) { return aqsAcquireTimed(this, a, false, ns); },
    "tryAcquireSharedNanos(IJ)Z": async function (this: JAQS, a: number, ns: bigint) { return aqsAcquireTimed(this, a, true, ns); },
    "release(I)Z": function (this: JAQS, a: number) { return aqsRelease(this, a, false); },
    "releaseShared(I)Z": function (this: JAQS, a: number) { return aqsRelease(this, a, true); },
    "hasQueuedThreads()Z": function (this: JAQS) { return this.q.length ? 1 : 0; },
    "hasQueuedPredecessors()Z": function (this: JAQS) { return this.q.length ? 1 : 0; },
    "getQueueLength()I": function (this: JAQS) { return this.q.length; },
    "isQueued(Ljava/lang/Thread;)Z": () => 0,
    "getExclusiveOwnerThread()Ljava/lang/Thread;": function (this: JAQS) { return this.owner; },
    "setExclusiveOwnerThread(Ljava/lang/Thread;)V": function (this: JAQS, t: unknown) { this.owner = t; },
    "isHeldExclusively()Z": function (this: JAQS) { return this.owner === curThread ? 1 : 0; },
  },
});
rt.register({
  name: "java/util/concurrent/locks/AbstractOwnableSynchronizer", ctor: class extends JObj { owner: unknown = null; },
  methods: {
    "<init>()V": function () {},
    "getExclusiveOwnerThread()Ljava/lang/Thread;": function (this: { owner: unknown }) { return this.owner; },
    "setExclusiveOwnerThread(Ljava/lang/Thread;)V": function (this: { owner: unknown }, t: unknown) { this.owner = t; },
  },
});
