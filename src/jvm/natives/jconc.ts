// java.util.concurrent.* — cooperative single-JS-thread implementations.

import { rt, JObj, type NativeSpec, type ClassInfo } from "../runtime";
import { vcall, newObj, JThread, JEnum, setCurThread, curThread, park, defineException } from "./jlang";
import { JList, JRandom, listMethods, randomSeed, JPriorityQueue, pqInsert, priorityQueueMethods } from "./jutil";

// ── atomics (single-threaded: trivial)
class JAtomicInt extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicInteger", ctor: JAtomicInt, sup: "java/lang/Number",
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JAtomicInt, v: number) { this.v = v; },
    "get()I": function (this: JAtomicInt) { return this.v; },
    "set(I)V": function (this: JAtomicInt, v: number) { this.v = v; },
    "lazySet(I)V": function (this: JAtomicInt, v: number) { this.v = v; },
    "incrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v + 1) | 0); },
    "decrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v - 1) | 0); },
    "getAndIncrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o + 1) | 0; return o; },
    "getAndDecrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o - 1) | 0; return o; },
    "addAndGet(I)I": function (this: JAtomicInt, d: number) { return (this.v = (this.v + d) | 0); },
    "getAndAdd(I)I": function (this: JAtomicInt, d: number) { const o = this.v; this.v = (o + d) | 0; return o; },
    "getAndSet(I)I": function (this: JAtomicInt, v: number) { const o = this.v; this.v = v; return o; },
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
    "<init>()V": function () {},
    "<init>(J)V": function (this: JAtomicLong, v: bigint) { this.v = v; },
    "get()J": function (this: JAtomicLong) { return this.v; },
    "set(J)V": function (this: JAtomicLong, v: bigint) { this.v = v; },
    "incrementAndGet()J": function (this: JAtomicLong) { return (this.v = BigInt.asIntN(64, this.v + 1n)); },
    "getAndIncrement()J": function (this: JAtomicLong) { const o = this.v; this.v = BigInt.asIntN(64, o + 1n); return o; },
    "addAndGet(J)J": function (this: JAtomicLong, d: bigint) { return (this.v = BigInt.asIntN(64, this.v + d)); },
    "compareAndSet(JJ)Z": function (this: JAtomicLong, e: bigint, v: bigint) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "getAndSet(J)J": function (this: JAtomicLong, v: bigint) { const o = this.v; this.v = v; return o; },
  },
});
class JAtomicBool extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicBoolean", ctor: JAtomicBool,
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function (this: JAtomicBool, v: number) { this.v = v; },
    "get()Z": function (this: JAtomicBool) { return this.v; },
    "set(Z)V": function (this: JAtomicBool, v: number) { this.v = v; },
    "compareAndSet(ZZ)Z": function (this: JAtomicBool, e: number, v: number) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "getAndSet(Z)Z": function (this: JAtomicBool, v: number) { const o = this.v; this.v = v; return o; },
  },
});
class JAtomicRef extends JObj { v: unknown = null; }
function checkRefStore(v: unknown, where: string) {
  if (typeof v === "number" || typeof v === "bigint") {
    console.warn("[atomicref] raw number stored via " + where, v, new Error().stack?.split("\n").slice(1, 6).join("\n"));
  }
  return v;
}
rt.register({
  name: "java/util/concurrent/atomic/AtomicReference", ctor: JAtomicRef,
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/Object;)V": function (this: JAtomicRef, v: unknown) { this.v = checkRefStore(v, "init"); },
    "get()Ljava/lang/Object;": function (this: JAtomicRef) { return this.v; },
    "set(Ljava/lang/Object;)V": function (this: JAtomicRef, v: unknown) { this.v = checkRefStore(v, "set"); },
    "lazySet(Ljava/lang/Object;)V": function (this: JAtomicRef, v: unknown) { this.v = checkRefStore(v, "lazySet"); },
    "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z": function (this: JAtomicRef, e: unknown, v: unknown) {
      if (this.v !== e) return 0;
      this.v = checkRefStore(v, "cas");
      return 1;
    },
    "getAndSet(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JAtomicRef, v: unknown) { const o = this.v; this.v = v; return o; },
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
rt.register({
  name: "java/util/concurrent/atomic/AtomicLongArray", ctor: JAtomicLongArray,
  methods: {
    "<init>(I)V": function (this: JAtomicLongArray, n: number) { this.a = new BigInt64Array(n); },
    "get(I)J": function (this: JAtomicLongArray, i: number) { return this.a[i]; },
    "set(IJ)V": function (this: JAtomicLongArray, i: number, v: bigint) { this.a[i] = v; },
    "getAndSet(IJ)J": function (this: JAtomicLongArray, i: number, v: bigint) { const o = this.a[i]; this.a[i] = v; return o; },
    "compareAndSet(IJJ)Z": function (this: JAtomicLongArray, i: number, e: bigint, v: bigint) { if (this.a[i] !== e) return 0; this.a[i] = v; return 1; },
    "incrementAndGet(I)J": function (this: JAtomicLongArray, i: number) { return (this.a[i] += 1n); },
    "addAndGet(IJ)J": function (this: JAtomicLongArray, i: number, d: bigint) { return (this.a[i] += d); },
    "length()I": function (this: JAtomicLongArray) { return this.a.length; },
  },
});

// ── TimeUnit (enum-like native)
class JTimeUnit extends JEnum { ms = 1; }
function tu(name: string, ord: number, ms: number): JTimeUnit {
  const t = new JTimeUnit(); t.ename = name; t.ord = ord; t.ms = ms; return t;
}
const TUS = {
  NANOSECONDS: tu("NANOSECONDS", 0, 1e-6), MICROSECONDS: tu("MICROSECONDS", 1, 1e-3),
  MILLISECONDS: tu("MILLISECONDS", 2, 1), SECONDS: tu("SECONDS", 3, 1000),
  MINUTES: tu("MINUTES", 4, 60000), HOURS: tu("HOURS", 5, 3600000), DAYS: tu("DAYS", 6, 86400000),
};
rt.register({
  name: "java/util/concurrent/TimeUnit", ctor: JTimeUnit, sup: "java/lang/Enum",
  statics: { ...TUS },
  methods: {
    "toMillis(J)J": function (this: JTimeUnit, v: bigint) { return BigInt(Math.round(Number(v) * this.ms)); },
    "toSeconds(J)J": function (this: JTimeUnit, v: bigint) { return BigInt(Math.floor(Number(v) * this.ms / 1000)); },
    "toNanos(J)J": function (this: JTimeUnit, v: bigint) { return BigInt(Math.round(Number(v) * this.ms * 1e6)); },
    "toMinutes(J)J": function (this: JTimeUnit, v: bigint) { return BigInt(Math.floor(Number(v) * this.ms / 60000)); },
    "convert(JLjava/util/concurrent/TimeUnit;)J": function (this: JTimeUnit, v: bigint, src: JTimeUnit) {
      return BigInt(Math.floor(Number(v) * src.ms / this.ms));
    },
    "sleep(J)V": function (this: JTimeUnit, v: bigint) { return park(curThread, () => () => {}, Number(v) * this.ms); },
  },
});

// ── Executors: queue tasks as macrotasks, mark thread context
class JExecutor extends JObj {
  shut = false;
  pending = 0;
  removeOnCancel = 0;
  queue: JObj | null = null;
  thread = new JThread();
}
/** run one task on the executor's thread; a submitted task's outcome lands on its Future */
async function runTask(ex: JExecutor, task: unknown, f: JFuture | null = null, method = "run", desc = "()V") {
  ex.pending++;
  const prev = curThread;
  setCurThread(ex.thread);
  try { const v = await vcall(task, method, desc); if (f && v !== undefined) f.value = v; }
  catch (e) {
    // AOSP: the failure belongs to the Future (get() rethrows it); an execute()d task has no owner
    if (f) f.error = rt.jx(e);
    else { const je = rt.jx(e); console.error("[executor]", (je as any).msg ?? je, (e as any)?.stack ?? ""); }
  } finally { setCurThread(prev); ex.pending--; if (f) f.done = 1; }
}
class JFuture extends JObj {
  promise: Promise<unknown> | null = null;
  value: unknown = null;
  error: unknown = null;
  done = 0;
  cancelled = 0;
}
/** get(): the value, or the task's throwable as ExecutionException (cause = it, message = its toString) */
async function futureGet(f: JFuture) {
  if (!f.cancelled && f.promise) await f.promise;
  if (f.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
  if (f.error) throw await newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", f.error);
  return f.value;
}
async function futureGetTimed(f: JFuture, d: bigint, u: JTimeUnit) {
  if (!f.done && f.promise) {
    const late = {};
    const first = await Promise.race([f.promise, new Promise((r) => setTimeout(() => r(late), Number(d) * u.ms))]);
    if (first === late && !f.done) throw rt.mkThrowable("java/util/concurrent/TimeoutException", null);
  }
  return futureGet(f);
}
rt.register({
  name: "webdroid/Future", ctor: JFuture,
  ifaces: ["java/util/concurrent/Future", "java/util/concurrent/ScheduledFuture"],
  methods: {
    "get()Ljava/lang/Object;": function (this: JFuture) { return futureGet(this); },
    "get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JFuture, d: bigint, u: JTimeUnit) { return futureGetTimed(this, d, u); },
    "isDone()Z": function (this: JFuture) { return this.done; },
    "isCancelled()Z": function (this: JFuture) { return this.cancelled; },
    "cancel(Z)Z": function (this: JFuture) { this.cancelled = 1; return 1; },
  },
});
function submit(ex: JExecutor, task: unknown, method: string, desc: string): JFuture {
  const f = new JFuture();
  f.promise = new Promise((resolve) => setTimeout(() => runTask(ex, task, f, method, desc).then(resolve), 0));
  return f;
}
const executorMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "execute(Ljava/lang/Runnable;)V": function (this: JExecutor, r: unknown) {
    setTimeout(() => void runTask(this, r), 0);
  },
  "submit(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;": function (this: JExecutor, r: unknown) {
    return submit(this, r, "run", "()V");
  },
  "submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;": function (this: JExecutor, c: unknown) {
    return submit(this, c, "call", "()Ljava/lang/Object;");
  },
  "shutdown()V": function (this: JExecutor) { this.shut = true; },
  "shutdownNow()Ljava/util/List;": function (this: JExecutor) { this.shut = true; return new JList(); },
  "isShutdown()Z": function (this: JExecutor) { return this.shut ? 1 : 0; },
  "isTerminated()Z": function (this: JExecutor) { return this.shut && this.pending === 0 ? 1 : 0; },
  "awaitTermination(JLjava/util/concurrent/TimeUnit;)Z": () => 1,
  "schedule(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;":
    function (this: JExecutor, r: unknown, d: bigint, u: JTimeUnit) {
      const f = new JFuture();
      f.promise = new Promise((resolve) =>
        setTimeout(() => (f.cancelled ? resolve(null) : runTask(this, r, f).then(resolve)), Number(d) * u.ms));
      return f;
    },
  "scheduleAtFixedRate(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;":
    function (this: JExecutor, r: unknown, init: bigint, period: bigint, u: JTimeUnit) {
      const f = new JFuture();
      const tick = () => {
        if (f.cancelled || this.shut) return;
        void runTask(this, r);
        setTimeout(tick, Number(period) * u.ms);
      };
      setTimeout(tick, Number(init) * u.ms);
      return f;
    },
};
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
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V": function () {},
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;)V": function () {},
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/RejectedExecutionHandler;)V": function () {},
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": function () {},
      "<init>(I)V": function () {},
      "<init>(ILjava/util/concurrent/ThreadFactory;)V": function () {},
      "<init>(ILjava/util/concurrent/RejectedExecutionHandler;)V": function () {},
      "<init>(ILjava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": function () {},
      "allowCoreThreadTimeOut(Z)V": function () {},
      // Our tasks go straight to setTimeout and nothing ever waits, so the work queue is the
      // one an idle pool reports: real, and empty. Sentry asks it whether it may still submit.
      "getQueue()Ljava/util/concurrent/BlockingQueue;": function (this: JExecutor) {
        return this.queue ??= new (rt.link("java/util/concurrent/LinkedBlockingQueue").ctor)();
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
function mkExec(): JExecutor {
  const info = rt.link("webdroid/Executor");
  return new info.ctor();
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
      () => new (rt.link("webdroid/DefaultThreadFactory").ctor)(),
    "static callable(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Callable;":
      (r: unknown, result: unknown) => {
        const c = new (rt.link("webdroid/RunnableCallable").ctor as typeof JRunnableCallable)();
        c.r = r; c.result = result;
        return c;
      },
    "static newSingleThreadExecutor()Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newSingleThreadExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newFixedThreadPool(I)Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newFixedThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newCachedThreadPool()Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newCachedThreadPool(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": mkExec,
    "static newScheduledThreadPool(I)Ljava/util/concurrent/ScheduledExecutorService;": mkExec,
    "static newScheduledThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": mkExec,
    "static newSingleThreadScheduledExecutor()Ljava/util/concurrent/ScheduledExecutorService;": mkExec,
    "static newSingleThreadScheduledExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": mkExec,
    "static unconfigurableExecutorService(Ljava/util/concurrent/ExecutorService;)Ljava/util/concurrent/ExecutorService;": (e: unknown) => e,
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

// blocking queue (async take)
class JBlockingQueue extends JList {
  takers: ((v: unknown) => void)[] = [];
  /** hand the value to a parked take(), else queue it */
  enqueue(v: unknown) {
    const t = this.takers.shift();
    if (t) queueMicrotask(() => t(v));
    else this.a.push(v);
  }
}
/** BlockingDeque's ends: a parked taker still receives whatever arrives next, either end. */
const dequeMethods = (): NonNullable<NativeSpec["methods"]> => ({
  "putFirst(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.a.unshift(v); },
  "offerFirst(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.a.unshift(v); return 1; },
  "putLast(Ljava/lang/Object;)V": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); },
  "offerLast(Ljava/lang/Object;)Z": function (this: JBlockingQueue, v: unknown) { this.enqueue(v); return 1; },
  "takeFirst()Ljava/lang/Object;": function (this: JBlockingQueue) {
    return this.a.length ? this.a.shift() : new Promise((r) => this.takers.push(r));
  },
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
    "take()Ljava/lang/Object;": function (this: JBlockingQueue) {
      if (this.a.length) return this.a.shift();
      return new Promise((r) => this.takers.push(r));
    },
    "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JBlockingQueue, d: bigint, u: JTimeUnit) {
      if (this.a.length) return this.a.shift();
      return new Promise((resolve) => {
        const taker = (v: unknown) => resolve(v);
        this.takers.push(taker);
        setTimeout(() => {
          const i = this.takers.indexOf(taker);
          if (i >= 0) { this.takers.splice(i, 1); resolve(null); }
        }, Number(d) * u.ms);
      });
    },
  },
});
for (const qn of ["java/util/concurrent/LinkedBlockingQueue", "java/util/concurrent/SynchronousQueue", "java/util/concurrent/ArrayBlockingQueue"]) mkBlockingQueue(qn);
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
    "take()Ljava/lang/Object;": function (this: JPriorityBlockingQueue) {
      if (this.a.length) return this.a.shift();
      return new Promise((r) => this.takers.push(r));
    },
    "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JPriorityBlockingQueue, d: bigint, u: JTimeUnit) {
      if (this.a.length) return this.a.shift();
      return new Promise((resolve) => {
        const taker = (v: unknown) => resolve(v);
        this.takers.push(taker);
        setTimeout(() => {
          const i = this.takers.indexOf(taker);
          if (i >= 0) { this.takers.splice(i, 1); resolve(null); }
        }, Number(d) * u.ms);
      });
    },
    "remainingCapacity()I": () => 0x7fffffff,
    "drainTo(Ljava/util/Collection;)I": async function (this: JPriorityBlockingQueue, c: unknown) {
      const n = this.a.length;
      for (const v of this.a.splice(0)) await vcall(c, "add", "(Ljava/lang/Object;)Z", v);
      return n;
    },
  },
});

class JSemaphore extends JObj { permits = 0; q: (() => void)[] = []; }
rt.register({
  name: "java/util/concurrent/Semaphore", ctor: JSemaphore,
  methods: {
    "<init>(I)V": function (this: JSemaphore, n: number) { this.permits = n; },
    "acquire()V": function (this: JSemaphore) {
      if (this.permits > 0) { this.permits--; return; }
      return new Promise<void>((r) => this.q.push(r));
    },
    "release()V": function (this: JSemaphore) {
      const w = this.q.shift();
      if (w) queueMicrotask(w);
      else this.permits++;
    },
    "tryAcquire()Z": function (this: JSemaphore) {
      if (this.permits > 0) { this.permits--; return 1; }
      return 0;
    },
  },
});

// marker interfaces
for (const i of ["java/util/concurrent/Executor", "java/util/concurrent/ExecutorService",
  "java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/Future",
  "java/util/concurrent/ScheduledFuture", "java/util/concurrent/Callable", "java/util/concurrent/ThreadFactory",
  "java/util/concurrent/RejectedExecutionHandler"]) {
  rt.register({ name: i, ctor: class extends JObj {} });
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
  const u = new (rt.link(cls).ctor)() as JFieldUpdater;
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

// ReentrantReadWriteLock — cooperative single thread: locks are advisory no-ops
class JRWLock extends JObj {}
class JRWInner extends JObj {}
rt.register({
  name: "webdroid/RWInner", ctor: JRWInner,
  ifaces: ["java/util/concurrent/locks/Lock"],
  methods: {
    "lock()V": () => {},
    "unlock()V": () => {},
    "tryLock()Z": () => 1,
    "lockInterruptibly()V": () => {},
    "newCondition()Ljava/util/concurrent/locks/Condition;": () => null,
  },
});
const rwInner = () => new (rt.link("webdroid/RWInner").ctor)();
rt.register({
  name: "java/util/concurrent/locks/ReentrantReadWriteLock", ctor: JRWLock,
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function () {},
    "readLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$ReadLock;": rwInner,
    "writeLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$WriteLock;": rwInner,
    // interface-descriptor call sites (ReadWriteLock.readLock/writeLock return Lock)
    "readLock()Ljava/util/concurrent/locks/Lock;": rwInner,
    "writeLock()Ljava/util/concurrent/locks/Lock;": rwInner,
  },
});
for (const n of ["java/util/concurrent/locks/ReentrantReadWriteLock$ReadLock", "java/util/concurrent/locks/ReentrantReadWriteLock$WriteLock", "java/util/concurrent/locks/Lock", "java/util/concurrent/locks/Condition"]) {
  rt.register({ name: n, ctor: class extends JRWInner {}, sup: "webdroid/RWInner" });
}

// ── ConcurrentLinkedQueue / LockSupport / FutureTask
for (const n of ["java/util/concurrent/ConcurrentLinkedQueue", "java/util/AbstractQueue"]) {
  rt.register({
    name: n, ctor: class extends JList {},
    ifaces: ["java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
    methods: listMethods(),
  });
}
// unpark() is a no-op, so a parked thread only wakes on its own deadline (see AGENTS.md "curThread is a global")
const parkFor = (ms: number) => new Promise((r) => setTimeout(r, ms));
rt.register({
  name: "java/util/concurrent/locks/LockSupport", ctor: class extends JObj {},
  methods: {
    "static park()V": () => parkFor(10),
    "static park(Ljava/lang/Object;)V": () => parkFor(10),
    "static parkNanos(J)V": (n: bigint) => parkFor(Math.min(50, Number(n) / 1e6)),
    "static parkNanos(Ljava/lang/Object;J)V": (b: unknown, n: bigint) => parkFor(Math.min(50, Number(n) / 1e6)),
    "static unpark(Ljava/lang/Thread;)V": () => {},
  },
});
// get() parks until whoever executes the task has run() it
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
rt.register({ name: "java/util/concurrent/RunnableFuture", ctor: class extends JObj {} });
