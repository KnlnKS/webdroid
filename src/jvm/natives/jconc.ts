// java.util.concurrent.* — cooperative single-JS-thread implementations.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { parkTimeout } from "../yield";
import { after, vcall, vcallOn, newObj, JThread, JEnum, enumValueOf, setCurThread, curThread, park, defineException, dispatchUncaught, mainThread } from "./jlang";
import { JList, newArrayList, toJsArray } from "./jutil";
import { splitSig, jarray } from "../abi";
import { clearGuestTimeout, guestNow, setGuestTimeout, type GuestTimer } from "../../guest-clock";

// ── TimeUnit (enum-like native)
export class JTimeUnit extends JEnum { ms = 1; ns = 1000000n; }
// enum constant, the to* method's suffix, one unit in nanoseconds
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
const timeUnits = Object.values(TUS);
rt.register({
  name: "java/util/concurrent/TimeUnit", ctor: JTimeUnit, sup: "java/lang/Enum",
  statics: { ...TUS },
  methods: {
    "static values()[Ljava/util/concurrent/TimeUnit;": () => jarray(timeUnits.slice(), "Ljava/util/concurrent/TimeUnit;"),
    "static valueOf(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;": (name: string) => enumValueOf(timeUnits, name),
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
  executeDelayedAfterShutdown = true;
  queue: JObj | null = null;
  limit = 1;
  coreSize = 1;
  maxSize = 1;
  pool = false;
  factory: unknown = null;
  rejectionHandler: unknown = null;
  workers: { thread: JThread | null; busy: boolean }[] = [];
  jobs = new Map<JFuture, unknown>();
  terminationWaiters = new Set<() => void>();
  /** `bare`: a ThreadPoolExecutor.execute()d Runnable, whose exception ends its worker thread */
  tasks: { task: unknown; f: JFuture; method: string; desc: string; queued: boolean; bare: boolean; finish: () => void }[] = [];
  /** a ScheduledThreadPoolExecutor: execute(r) is schedule(r, 0), whose future keeps the exception */
  scheduled = false;
  drainScheduled = false;
  consecutiveDrains = 0;
  keepAliveNs = 0n;
  coreTimeout = false;
  continuePeriodic = false;
  largest = 0;
  completed = 0;
}
/** a job leaves the executor's accounting; the last one after shutdown terminates it */
function release(ex: JExecutor, f: JFuture) {
  ex.pending--; ex.jobs.delete(f);
  wakeIfTerminated(ex);
}
function wakeIfTerminated(ex: JExecutor) {
  if (!ex.shut || ex.pending !== 0) return;
  for (const wake of ex.terminationWaiters) wake();
  ex.terminationWaiters.clear();
}
const mirror = (ex: JExecutor) => (ex.queue instanceof JList ? ex.queue.a : null);
function retireIdleWorkers(ex: JExecutor) {
  for (let i = ex.workers.length - 1; i >= 0 && ex.workers.length > ex.limit; i--) {
    const worker = ex.workers[i];
    if (worker.busy) continue;
    if (worker.thread) worker.thread.alive = 0;
    ex.workers.splice(i, 1);
  }
}
/** a new idle worker, counted toward getLargestPoolSize */
function addWorker(ex: JExecutor): JExecutor["workers"][number] {
  const worker = { thread: null, busy: false };
  ex.workers.push(worker);
  ex.largest = Math.max(ex.largest, ex.workers.length);
  return worker;
}
function drainExecutor(ex: JExecutor) {
  while (ex.tasks.length) {
    let worker = ex.workers.find((w) => !w.busy);
    if (!worker) {
      if (ex.workers.length >= ex.limit) return;
      worker = addWorker(ex);
    }
    const task = ex.tasks.shift()!;
    if (!ex.pool) mirror(ex)?.shift();
    worker.busy = true;
    void runTask(ex, worker, task);
  }
}
function scheduleDrain(ex: JExecutor) {
  if (ex.drainScheduled) return;
  ex.drainScheduled = true;
  const run = () => { ex.drainScheduled = false; drainExecutor(ex); };
  if (++ex.consecutiveDrains < 64) queueMicrotask(() => queueMicrotask(run));
  else { ex.consecutiveDrains = 0; setTimeout(run, 0); }
}
/** an app's ThreadPoolExecutor subclass sees each task through beforeExecute/afterExecute */
const hooked = (ex: JExecutor) => !(ex.constructor as { $i?: { native?: boolean } }).$i?.native;
function onThread<T>(thread: JThread, f: () => T): T {
  const prev = curThread;
  setCurThread(thread);
  try { return f(); } finally { setCurThread(prev); }
}
const runTask = driven(function* runTask(ex: JExecutor, worker: JExecutor["workers"][number], entry: JExecutor["tasks"][number]): Gen {
  const { task, f, method, desc } = entry;
  try {
    if (entry.queued) yield vcall(ex.queue, "remove", "(Ljava/lang/Object;)Z", task);
    if (f.cancelled) return;
    if (!worker.thread) {
      worker.thread = ex.factory ? yield vcall(ex.factory, "newThread", "(Ljava/lang/Runnable;)Ljava/lang/Thread;", task) : rt.make("java/lang/Thread");
      if (!worker.thread) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "ThreadFactory returned null");
    }
    if (f.cancelled) return;
    worker.thread.alive = 1;
    worker.thread.interrupted = 0;
    f.thread = worker.thread;
    if (hooked(ex)) yield onThread(worker.thread, () => vcall(ex, "beforeExecute", "(Ljava/lang/Thread;Ljava/lang/Runnable;)V", worker.thread, task));
    const value = yield onThread(worker.thread, () => vcall(task, method, desc));
    if (!f.cancelled && value !== undefined) f.value = value;
  } catch (e) {
    if (!f.cancelled) f.error = rt.jx(e);
  } finally {
    ex.completed++;
    // a throwing hook ends that worker on a device; here the pool's accounting must still finish
    if (hooked(ex) && worker.thread?.alive) {
      try { yield onThread(worker.thread, () => vcall(ex, "afterExecute", "(Ljava/lang/Runnable;Ljava/lang/Throwable;)V", task, f.error ?? null)); }
      catch (e) { console.error("[executor] afterExecute", rt.jx(e)); }
    }
    release(ex, f); worker.busy = false;
    retireIdleWorkers(ex);
    f.done = 1; f.thread = null;
    entry.finish();
    if (ex.tasks.length) scheduleDrain(ex);
    else {
      ex.consecutiveDrains = 0;
      if (ex.shut) for (const w of ex.workers) if (!w.busy && w.thread) w.thread.alive = 0;
    }
    // ThreadPoolExecutor.runWorker rethrows after afterExecute and the worker reports it as it dies
    if (entry.bare && f.error) void dispatchUncaught(worker.thread ?? mainThread, f.error);
  }
});
class JFuture extends JObj {
  delayed = false;
  deadline = guestNow();
  promise: Promise<unknown> | null = null;
  value: unknown = null;
  error: unknown = null;
  done = 0;
  cancelled = 0;
  thread: JThread | null = null;
  cancel: ((interrupt: number) => void) | null = null;
}
/** get(): the value, or the task's throwable as ExecutionException (cause = it, message = its toString) */
const futureGet = driven(function* futureGet(f: JFuture): Gen {
  if (!f.cancelled && f.promise) yield f.promise;
  if (f.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
  if (f.error) throw yield newObj("java/util/concurrent/ExecutionException", "(Ljava/lang/Throwable;)V", f.error);
  return f.value;
});
const futureGetTimed = driven(function* futureGetTimed(f: JFuture, d: bigint, u: JTimeUnit): Gen {
  if (!f.done && f.promise) {
    const late = {};
    const first = yield Promise.race([f.promise, new Promise((r) => parkTimeout(() => r(late), Number(d) * u.ms))]);
    if (first === late && !f.done) throw rt.mkThrowable("java/util/concurrent/TimeoutException", null);
  }
  return futureGet(f);
});
/** the Future accessors webdroid/Future and FutureTask share */
const futureAccessors: NativeSpec["methods"] = {
  "get()Ljava/lang/Object;": function (this: JFuture) { return futureGet(this); },
  "get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JFuture, d: bigint, u: JTimeUnit) { return futureGetTimed(this, d, u); },
  "isDone()Z": function (this: JFuture) { return this.done; },
  "isCancelled()Z": function (this: JFuture) { return this.cancelled; },
};
rt.register({
  name: "webdroid/Future", ctor: JFuture,
  ifaces: ["java/util/concurrent/Future", "java/util/concurrent/ScheduledFuture"],
  methods: {
    ...futureAccessors,
    "getDelay(Ljava/util/concurrent/TimeUnit;)J": function (this: JFuture, unit: JTimeUnit) {
      if (!unit) rt.npe();
      return tuConvert(BigInt(Math.trunc((this.deadline - guestNow()) * 1e6)), 1n, unit.ns);
    },
    "compareTo(Ljava/util/concurrent/Delayed;)I": driven(function* (this: JFuture, other: unknown): Gen {
      if (this === other) return 0;
      if (other instanceof JFuture) return Math.sign(this.deadline - other.deadline);
      const delay: bigint = yield vcall(other, "getDelay", "(Ljava/util/concurrent/TimeUnit;)J", TUS.NANOSECONDS);
      const delta = BigInt(Math.trunc((this.deadline - guestNow()) * 1e6)) - delay;
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    }),
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
function submit(ex: JExecutor, task: unknown, method: string, desc: string, delay = 0, queued = false, bare = false): JFuture {
  if (ex.shut) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "executor shut down");
  const f = newFuture();
  f.deadline = guestNow() + Math.max(0, delay);
  ex.pending++; ex.jobs.set(f, task);
  f.promise = new Promise((resolve) => {
    const entry = { task, f, method, desc, queued, bare, finish: () => resolve(null) };
    let timer: GuestTimer | undefined;
    const enqueue = () => {
      timer = undefined; f.delayed = false; ex.tasks.push(entry); if (!ex.pool) mirror(ex)?.push(task);
      scheduleDrain(ex);
    };
    if (delay > 0) { f.delayed = true; timer = setGuestTimeout(enqueue, delay); } else enqueue();
    f.cancel = () => {
      const index = ex.tasks.indexOf(entry);
      if (index >= 0) {
        ex.tasks.splice(index, 1);
        if (entry.queued) void vcall(ex.queue, "remove", "(Ljava/lang/Object;)Z", task);
        else if (!ex.pool) mirror(ex)?.splice(index, 1);
        release(ex, f);
      }
      else if (timer !== undefined) { clearGuestTimeout(timer); timer = undefined; release(ex, f); }
      resolve(null);
    };
  });
  return f;
}
function reject(ex: JExecutor, task: unknown): unknown {
  if (ex.rejectionHandler) return vcall(ex.rejectionHandler, "rejectedExecution",
    "(Ljava/lang/Runnable;Ljava/util/concurrent/ThreadPoolExecutor;)V", task, ex);
  throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", ex.shut ? "executor shut down" : "executor saturated");
}
function execute(this: JExecutor, r: unknown): unknown {
  if (r == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (this.shut) return reject(this, r);
  const enqueue = (queued = false) => { submit(this, r, "run", "()V", 0, queued, !this.scheduled); };
  if (!this.pool || this.pending < this.coreSize || this.pending < this.workers.length) return enqueue();
  return after(vcall(this.queue, "offer", "(Ljava/lang/Object;)Z", r), accepted => {
    if (accepted) return enqueue(true);
    if (this.pending >= this.limit) {
      if (this.limit >= this.maxSize) return reject(this, r);
      this.limit++;
    }
    return enqueue();
  });
}
function removeQueued(this: JExecutor, task: unknown): unknown {
  const index = this.tasks.findIndex((entry) => entry.task === task);
  if (index < 0) return 0;
  const [entry] = this.tasks.splice(index, 1);
  if (!this.pool) mirror(this)?.splice(index, 1);
  release(this, entry.f);
  entry.finish();
  return entry.queued ? after(vcall(this.queue, "remove", "(Ljava/lang/Object;)Z", task), () => 1) : 1;
}
const executorMethods: NativeSpec["methods"] = {
  "execute(Ljava/lang/Runnable;)V": execute,
  "submit(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;": function (this: JExecutor, r: unknown) {
    return submitTask(this, "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/RunnableFuture;", r, null);
  },
  "submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;": function (this: JExecutor, c: unknown) {
    return submitTask(this, "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/RunnableFuture;", c);
  },
  "invokeAll(Ljava/util/Collection;)Ljava/util/List;": driven(function* (this: JExecutor, tasks: JList): Gen {
    if (tasks == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const futures = newArrayList();
    for (const task of tasks.a) futures.a.push(yield vcall(this, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task));
    for (const future of futures.a) {
      try { yield vcall(future, "get", "()Ljava/lang/Object;"); } catch {}
    }
    return futures;
  }),
  "invokeAll(Ljava/util/Collection;JLjava/util/concurrent/TimeUnit;)Ljava/util/List;": driven(function* (this: JExecutor, tasks: JList, timeout: bigint, unit: JTimeUnit): Gen {
    if (tasks == null || unit == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const futures = newArrayList();
    for (const task of tasks.a) futures.a.push(yield vcall(this, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task));
    const deadline = guestNow() + Number(timeout) * unit.ms;
    for (let i = 0; i < futures.a.length; i++) {
      const remaining = Math.max(0, deadline - guestNow());
      try { yield vcall(futures.a[i], "get", "(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;", BigInt(Math.ceil(remaining * 1e6)), TUS.NANOSECONDS); }
      catch (e) {
        if (!rt.iof(e, "java/util/concurrent/TimeoutException")) continue;
        for (; i < futures.a.length; i++) yield vcall(futures.a[i], "cancel", "(Z)Z", 1);
        break;
      }
    }
    return futures;
  }),
  "submit(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;": function (this: JExecutor, r: unknown, result: unknown) {
    return submitTask(this, "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/RunnableFuture;", r, result);
  },
  "newTaskFor(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/RunnableFuture;": (r: unknown, result: unknown) =>
    taskForCallable(runnableCallable(r, result)),
  "newTaskFor(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/RunnableFuture;": (c: unknown) =>
    taskForCallable(c),
  "shutdown()V": function (this: JExecutor) {
    this.shut = true;
    if (!this.executeDelayedAfterShutdown) cancelDelayed(this);
    wakeIfTerminated(this);
  },
  "shutdownNow()Ljava/util/List;": function (this: JExecutor) {
    this.shut = true;
    const result = newArrayList();
    for (const [future, task] of this.jobs) {
      if (!future.thread) result.a.push(task);
      cancelFuture(future, 1);
    }
    wakeIfTerminated(this);
    return result;
  },
  "isShutdown()Z": function (this: JExecutor) { return this.shut ? 1 : 0; },
  "isTerminated()Z": function (this: JExecutor) { return this.shut && this.pending === 0 ? 1 : 0; },
  "awaitTermination(JLjava/util/concurrent/TimeUnit;)Z": driven(function* (this: JExecutor, timeout: bigint, unit: JTimeUnit): Gen {
    const deadline = guestNow() + Number(timeout) * unit.ms;
    while (!(this.shut && this.pending === 0)) {
      const left = deadline - guestNow();
      if (left <= 0) return 0;
      // a cancelled future settles while its task still runs; only the accounting says when it ends
      yield park(curThread, (wake) => { this.terminationWaiters.add(wake); return () => this.terminationWaiters.delete(wake); }, left);
    }
    return 1;
  }),
  "invokeAny(Ljava/util/Collection;)Ljava/lang/Object;": driven(function* (this: JExecutor, tasks: unknown): Gen {
    if (tasks == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const list: unknown[] = yield toJsArray(tasks);
    if (!list.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    let failure: unknown;
    for (const task of list) {
      const future = yield vcall(this, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task);
      try { return yield vcall(future, "get", "()Ljava/lang/Object;"); } catch (e) { failure = e; }
    }
    throw failure;
  }),
};
const scheduleMethods: NativeSpec["methods"] = {
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
function taskForCallable(callable: unknown): JFutureTask {
  rt.link("java/util/concurrent/FutureTask");
  const task = new JFutureTask(); armTask(task, callable); return task;
}
function submitTask(ex: JExecutor, desc: string, task: unknown, ...args: unknown[]): unknown {
  if (task == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const thread = curThread;
  return after(vcallOn(thread, ex, "newTaskFor", desc, task, ...args), future =>
    after(vcallOn(thread, ex, "execute", "(Ljava/lang/Runnable;)V", future), () => future));
}
/** The two periodic schedules differ only in where the next run is measured from: a rate keeps
 *  the period's grid, a delay starts counting when the previous run finished. */
function repeating(name: string, fixedRate: boolean): NativeSpec["methods"] {
  return {
    [`${name}(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;`]:
    function (this: JExecutor, r: unknown, init: bigint, period: bigint, u: JTimeUnit) {
      if (period <= 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "nonpositive period");
      const f = newFuture();
      let next = guestNow() + Number(init) * u.ms, task: JFuture;
      f.promise = new Promise((resolve) => {
        const tick = () => {
          if (f.cancelled || this.shut) { f.done = 1; resolve(null); return; }
          f.deadline = next;
          task = submit(this, r, "run", "()V", next - guestNow());
          void task.promise!.then(() => {
            if (task.error) { f.error = task.error; f.done = 1; resolve(null); }
            else { next = (fixedRate ? next : guestNow()) + Number(period) * u.ms; tick(); }
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
function cancelDelayed(ex: JExecutor): void {
  for (const f of ex.jobs.keys()) if (f.delayed) cancelFuture(f, 0);
}
function initScheduled(this: JExecutor, core: number, factory: unknown = null, handler: unknown = null) {
  if (core < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative pool size");
  this.coreSize = core; this.maxSize = 0x7fffffff;
  this.limit = Math.max(1, core); this.factory = factory; this.rejectionHandler = handler;
}
function initPool(this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JObj, factory: unknown = null, handler: unknown = null) {
  if (core < 0 || max <= 0 || max < core || keep < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid pool size");
  this.pool = true; this.coreSize = core; this.maxSize = max; this.keepAliveNs = keep * unit.ns;
  this.limit = Math.max(1, core); this.queue = queue; this.factory = factory; this.rejectionHandler = handler;
}
for (const n of ["java/util/concurrent/ThreadPoolExecutor", "java/util/concurrent/ScheduledThreadPoolExecutor",
  "webdroid/Executor"]) {
  rt.register({
    name: n, ctor: n === "java/util/concurrent/ScheduledThreadPoolExecutor" ? class extends JExecutor { override scheduled = true; } : class extends JExecutor {},
    ifaces: ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor",
      "java/util/concurrent/ScheduledExecutorService"],
    // an app subclassing ThreadPoolExecutor to hook beforeExecute/afterExecute cannot link
    // until the class AOSP puts between it and Object exists
    sup: "java/util/concurrent/AbstractExecutorService",
    methods: {
      ...executorMethods,
      ...(n !== "java/util/concurrent/ScheduledThreadPoolExecutor" ? {
        "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V": initPool,
        "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;)V": initPool,
        "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JObj, handler: unknown) { initPool.call(this, core, max, keep, unit, queue, null, handler); },
        "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initPool,
      } : {}),
      ...(n !== "java/util/concurrent/ThreadPoolExecutor" ? {
        ...scheduleMethods,
        "<init>(I)V": initScheduled,
        "<init>(ILjava/util/concurrent/ThreadFactory;)V": initScheduled,
        "<init>(ILjava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number, handler: unknown) { initScheduled.call(this, core, null, handler); },
        "<init>(ILjava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initScheduled,
        // kotlinx looks this up reflectively (removeFutureOnCancel); a cancelled schedule() never runs
        // here regardless, so the policy is just remembered
        "setRemoveOnCancelPolicy(Z)V": function (this: JExecutor, v: number) { this.removeOnCancel = v; },
        "getRemoveOnCancelPolicy()Z": function (this: JExecutor) { return this.removeOnCancel; },
      } : {}),
      ...(n === "java/util/concurrent/ScheduledThreadPoolExecutor" ? {
        "setExecuteExistingDelayedTasksAfterShutdownPolicy(Z)V": function (this: JExecutor, value: number) {
          this.executeDelayedAfterShutdown = !!value;
          if (this.shut && !value) cancelDelayed(this);
        },
        "getExecuteExistingDelayedTasksAfterShutdownPolicy()Z": function (this: JExecutor) { return +this.executeDelayedAfterShutdown; },
        "setContinueExistingPeriodicTasksAfterShutdownPolicy(Z)V": function (this: JExecutor, value: number) { this.continuePeriodic = !!value; },
        "getContinueExistingPeriodicTasksAfterShutdownPolicy()Z": function (this: JExecutor) { return +this.continuePeriodic; },
      } : {}),
      "allowCoreThreadTimeOut(Z)V": function (this: JExecutor, value: number) {
        if (value && this.keepAliveNs <= 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Core threads must have nonzero keep alive times");
        this.coreTimeout = !!value;
      },
      "allowsCoreThreadTimeOut()Z": function (this: JExecutor) { return +this.coreTimeout; },
      "setMaximumPoolSize(I)V": function (this: JExecutor, max: number) {
        if (max <= 0 || max < this.coreSize) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
        this.maxSize = max;
        if (this.limit > max) { this.limit = max; retireIdleWorkers(this); }
      },
      "getLargestPoolSize()I": function (this: JExecutor) { return this.largest; },
      "getTaskCount()J": function (this: JExecutor) { return BigInt(this.completed + this.pending); },
      "getCompletedTaskCount()J": function (this: JExecutor) { return BigInt(this.completed); },
      "getKeepAliveTime(Ljava/util/concurrent/TimeUnit;)J": function (this: JExecutor, unit: JTimeUnit) { return tuConvert(this.keepAliveNs, 1n, unit.ns); },
      "getThreadFactory()Ljava/util/concurrent/ThreadFactory;": function (this: JExecutor) {
        return this.factory ??= vcall(rt.link("java/util/concurrent/Executors").ctor, "defaultThreadFactory", "()Ljava/util/concurrent/ThreadFactory;");
      },
      "setThreadFactory(Ljava/util/concurrent/ThreadFactory;)V": function (this: JExecutor, factory: unknown) {
        if (!factory) throw rt.mkThrowable("java/lang/NullPointerException", null);
        this.factory = factory;
      },
      "prestartCoreThread()Z": function (this: JExecutor) {
        if (this.workers.length >= this.coreSize) return 0;
        addWorker(this);
        return 1;
      },
      "prestartAllCoreThreads()I": function (this: JExecutor) {
        let n = 0;
        for (; this.workers.length < this.coreSize; n++) addWorker(this);
        return n;
      },
      // the protected hooks a subclass overrides, and calls up to
      "beforeExecute(Ljava/lang/Thread;Ljava/lang/Runnable;)V": () => {},
      "afterExecute(Ljava/lang/Runnable;Ljava/lang/Throwable;)V": () => {},
      "terminated()V": () => {},
      "finalize()V": () => {},
      "getPoolSize()I": function (this: JExecutor) { return this.workers.length; },
      "getActiveCount()I": function (this: JExecutor) { return this.workers.filter((w) => w.busy).length; },
      "getCorePoolSize()I": function (this: JExecutor) { return this.coreSize; },
      "getMaximumPoolSize()I": function (this: JExecutor) { return this.maxSize; },
      "setCorePoolSize(I)V": function (this: JExecutor, core: number) {
        if (core < 0 || core > this.maxSize) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid core pool size");
        this.coreSize = core; this.limit = Math.max(1, core);
        retireIdleWorkers(this);
        if (this.tasks.length) scheduleDrain(this);
      },
      "remove(Ljava/lang/Runnable;)Z": removeQueued,
      "setKeepAliveTime(JLjava/util/concurrent/TimeUnit;)V": function (this: JExecutor, time: bigint, unit: JTimeUnit) {
        if (time < 0n || (time === 0n && this.coreTimeout)) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
        this.keepAliveNs = time * unit.ns;
      },
      "getQueue()Ljava/util/concurrent/BlockingQueue;": function (this: JExecutor) {
        if (!this.queue) { const queue = rt.make("java/util/concurrent/LinkedBlockingQueue") as JList; queue.a = this.tasks.map((t) => t.task); this.queue = queue; }
        return this.queue;
      },
      "purge()V": function () {},
      "setRejectedExecutionHandler(Ljava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, handler: unknown) {
        if (!handler) throw rt.mkThrowable("java/lang/NullPointerException", null);
        this.rejectionHandler = handler;
      },
      "getRejectedExecutionHandler()Ljava/util/concurrent/RejectedExecutionHandler;": function (this: JExecutor) {
        return this.rejectionHandler ??= rt.make("java/util/concurrent/ThreadPoolExecutor$AbortPolicy");
      },
    },
  });
}
rt.register({
  name: "java/util/concurrent/AbstractExecutorService", ctor: class extends JExecutor {},
  ifaces: ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  methods: { "<init>()V": function () {}, ...executorMethods },
});
class JExecutors extends JObj {}
class JDelegatedExecutor extends JObj { delegate: unknown = null; }
const delegated: NativeSpec["methods"] = {};
for (const signature of Object.keys({ ...executorMethods, ...scheduleMethods })) {
  const [name, desc] = splitSig(signature);
  if (name === "<init>" || name === "newTaskFor") continue;
  delegated[signature] = async function (this: JDelegatedExecutor, ...args: unknown[]) { return vcall(this.delegate, name, desc, ...args); };
}
rt.register({ name: "webdroid/DelegatedScheduledExecutor", ctor: JDelegatedExecutor,
  ifaces: ["java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"], methods: delegated });
export function mkExecutor(count = 1, factory: unknown = null): JExecutor {
  if (count <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "nonpositive pool size");
  const ex: JExecutor = rt.make("webdroid/Executor");
  ex.limit = ex.coreSize = ex.maxSize = count; ex.factory = factory; return ex;
}
/** A scheduled pool takes the constructor's rule, not the fixed pool's: zero cores is legal
 *  and still runs a due task. */
function mkScheduled(count = 1, factory: unknown = null): JExecutor {
  const ex: JExecutor = rt.make("webdroid/Executor");
  initScheduled.call(ex, count, factory);
  ex.scheduled = true;
  return ex;
}
// Executors.defaultThreadFactory()/callable() must hand back REAL objects: callers wrap them and
// invoke newThread()/call() themselves, so the auto-stubbed interfaces are not enough.
class JRunnableCallable extends JObj { r: unknown = null; result: unknown = null; }
function runnableCallable(r: unknown, result: unknown = null): JRunnableCallable {
  if (r == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  rt.link("webdroid/RunnableCallable");
  const c = new JRunnableCallable();
  c.r = r; c.result = result;
  return c;
}
rt.register({
  name: "webdroid/RunnableCallable", ctor: JRunnableCallable, ifaces: ["java/util/concurrent/Callable"],
  methods: {
    "call()Ljava/lang/Object;": driven(function* (this: JRunnableCallable): Gen {
      yield vcall(this.r, "run", "()V");
      return this.result;
    }),
  },
});
rt.register({
  name: "webdroid/DefaultThreadFactory", ctor: class extends JObj {},
  ifaces: ["java/util/concurrent/ThreadFactory"],
  methods: {
    "newThread(Ljava/lang/Runnable;)Ljava/lang/Thread;": (r: unknown) => {
      const t = rt.make("java/lang/Thread") as JThread;
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
    "static callable(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Callable;": runnableCallable,
    "static callable(Ljava/lang/Runnable;)Ljava/util/concurrent/Callable;": runnableCallable,
    "static newSingleThreadExecutor()Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newSingleThreadExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": (factory: unknown) => mkExecutor(1, factory),
    "static newFixedThreadPool(I)Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newFixedThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": mkExecutor,
    "static newCachedThreadPool()Ljava/util/concurrent/ExecutorService;": () => mkExecutor(Infinity),
    "static newCachedThreadPool(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ExecutorService;": (factory: unknown) => mkExecutor(Infinity, factory),
    "static newScheduledThreadPool(I)Ljava/util/concurrent/ScheduledExecutorService;": mkScheduled,
    "static newScheduledThreadPool(ILjava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": mkScheduled,
    "static newSingleThreadScheduledExecutor()Ljava/util/concurrent/ScheduledExecutorService;": () => mkScheduled(),
    "static newSingleThreadScheduledExecutor(Ljava/util/concurrent/ThreadFactory;)Ljava/util/concurrent/ScheduledExecutorService;": (factory: unknown) => mkScheduled(1, factory),
    "static unconfigurableExecutorService(Ljava/util/concurrent/ExecutorService;)Ljava/util/concurrent/ExecutorService;": (e: unknown) => e,
    "static unconfigurableScheduledExecutorService(Ljava/util/concurrent/ScheduledExecutorService;)Ljava/util/concurrent/ScheduledExecutorService;": (executor: unknown) => {
      if (executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      rt.link("webdroid/DelegatedScheduledExecutor");
      const wrapper = new JDelegatedExecutor(); wrapper.delegate = executor; return wrapper;
    },
  },
});

for (const [i, ...ifaces] of [["java/util/concurrent/Executor"], ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  ["java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"], ["java/util/concurrent/Future"],
  ["java/util/concurrent/Delayed", "java/lang/Comparable"],
  ["java/util/concurrent/ScheduledFuture", "java/util/concurrent/Future", "java/util/concurrent/Delayed"], ["java/util/concurrent/Callable"], ["java/util/concurrent/ThreadFactory"],
  ["java/util/concurrent/RunnableFuture", "java/lang/Runnable", "java/util/concurrent/Future"],
  ["java/util/concurrent/RunnableScheduledFuture", "java/util/concurrent/RunnableFuture", "java/util/concurrent/ScheduledFuture"],
  ["java/util/concurrent/RejectedExecutionHandler"]]) {
  rt.register({ name: i, ctor: class extends JObj {}, ifaces });
}
for (const [n, run] of [["AbortPolicy", 0], ["CallerRunsPolicy", 1], ["DiscardPolicy", 0], ["DiscardOldestPolicy", 0]] as const) {
  rt.register({
    name: "java/util/concurrent/ThreadPoolExecutor$" + n, ctor: class extends JObj {},
    ifaces: ["java/util/concurrent/RejectedExecutionHandler"],
    methods: {
      "<init>()V": function () {},
      "rejectedExecution(Ljava/lang/Runnable;Ljava/util/concurrent/ThreadPoolExecutor;)V": driven(function* (r: unknown, ex: JExecutor): Gen {
        if (n === "AbortPolicy") throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "rejected");
        if (yield vcall(ex, "isShutdown", "()Z")) return;
        if (run) return vcall(r, "run", "()V");
        if (n === "DiscardOldestPolicy") {
          const queue = yield vcall(ex, "getQueue", "()Ljava/util/concurrent/BlockingQueue;");
          const oldest = yield vcall(queue, "poll", "()Ljava/lang/Object;");
          if (oldest) yield removeQueued.call(ex, oldest);
          return vcall(ex, "execute", "(Ljava/lang/Runnable;)V", r);
        }
      }),
    },
  });
}
defineException("java/util/concurrent/RejectedExecutionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/TimeoutException", "java/lang/Exception");
defineException("java/util/concurrent/ExecutionException", "java/lang/Exception");
defineException("java/util/concurrent/CompletionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/CancellationException", "java/lang/IllegalStateException");


class JFutureTask extends JFuture {
  callable: unknown = null;
  wake: (v: unknown) => void = () => {};
}
function armTask(t: JFutureTask, callable: unknown) {
  if (callable == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  t.callable = callable;
  t.promise = new Promise((r) => (t.wake = r));
}
rt.register({
  name: "java/util/concurrent/FutureTask", ctor: JFutureTask,
  ifaces: ["java/util/concurrent/Future", "java/lang/Runnable", "java/util/concurrent/RunnableFuture"],
  methods: {
    "<init>(Ljava/util/concurrent/Callable;)V": function (this: JFutureTask, c: unknown) { armTask(this, c); },
    "<init>(Ljava/lang/Runnable;Ljava/lang/Object;)V": function (this: JFutureTask, r: unknown, v: unknown) {
      armTask(this, runnableCallable(r, v));
    },
    "run()V": driven(function* (this: JFutureTask): Gen {
      if (this.done || this.thread) return;
      const thread = this.thread = curThread;
      try {
        const value = yield vcall(this.callable, "call", "()Ljava/lang/Object;");
        if (!this.cancelled) this.value = value;
      } catch (e) { this.error = rt.jx(e); } // surfaces from get(), as AOSP's setException
      this.done = 1; this.thread = null;
      this.wake(null);
      if (!this.cancelled) yield vcallOn(thread, this, "done", "()V");
    }),
    "done()V": function () {},
    ...futureAccessors,
    "cancel(Z)Z": driven(function* (this: JFutureTask, interrupt: number): Gen {
      if (this.done) return 0;
      cancelFuture(this, interrupt); this.wake(null);
      yield vcall(this, "done", "()V");
      return 1;
    }),
  },
});
