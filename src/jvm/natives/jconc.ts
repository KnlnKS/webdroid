// java.util.concurrent.* — cooperative single-JS-thread implementations.

import { rt, JObj, type NativeSpec } from "../runtime";
import { parkTimeout } from "../yield";
import { after, vcall, vcallOn, newObj, JThread, JEnum, enumValueOf, setCurThread, curThread, park, defineException } from "./jlang";
import { JList, newArrayList } from "./jutil";
import { JRandom, randomSeed } from "./jrandom";
import { mangleMethod, splitSig, jarray } from "../abi";
import { clearGuestTimeout, guestNow, setGuestTimeout, type GuestTimer } from "../../guest-clock";

// ── TimeUnit (enum-like native)
export class JTimeUnit extends JEnum { ms = 1; ns = 1000000n; }
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
  tasks: { task: unknown; f: JFuture; method: string; desc: string; queued: boolean; finish: () => void }[] = [];
  drainScheduled = false;
  consecutiveDrains = 0;
}
const mirror = (ex: JExecutor) => (ex.queue instanceof JList ? ex.queue.a : null);
function drainExecutor(ex: JExecutor) {
  while (ex.tasks.length) {
    let worker = ex.workers.find((w) => !w.busy);
    if (!worker) {
      if (ex.workers.length >= ex.limit) return;
      worker = { thread: null, busy: false }; ex.workers.push(worker);
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
async function runTask(ex: JExecutor, worker: JExecutor["workers"][number], entry: JExecutor["tasks"][number]) {
  const { task, f, method, desc } = entry;
  try {
    if (entry.queued) await vcall(ex.queue, "remove", "(Ljava/lang/Object;)Z", task);
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
    if (ex.tasks.length) scheduleDrain(ex);
    else {
      ex.consecutiveDrains = 0;
      if (ex.shut) for (const w of ex.workers) if (!w.busy && w.thread) w.thread.alive = 0;
    }
  }
}
class JFuture extends JObj {
  delayed = false;
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
function submit(ex: JExecutor, task: unknown, method: string, desc: string, delay = 0, queued = false): JFuture {
  if (ex.shut) throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "executor shut down");
  const f = newFuture();
  ex.pending++; ex.jobs.set(f, task);
  f.promise = new Promise((resolve) => {
    const entry = { task, f, method, desc, queued, finish: () => resolve(null) };
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
        ex.pending--; ex.jobs.delete(f);
      }
      else if (timer !== undefined) { clearGuestTimeout(timer); timer = undefined; ex.pending--; ex.jobs.delete(f); }
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
  const enqueue = (queued = false) => {
    const f = submit(this, r, "run", "()V", 0, queued);
    void f.promise!.then(() => {
      if (!f.error) return;
      const e = f.error as { msg?: string; jsStack?: string; jframes?: string[] };
      console.error("[executor]", (e.msg ?? f.error) + (e.jframes ? "\n  at " + e.jframes.join("\n  at ") : ""), e.jsStack ?? "");
    });
  };
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
  this.pending--;
  this.jobs.delete(entry.f);
  entry.finish();
  return entry.queued ? after(vcall(this.queue, "remove", "(Ljava/lang/Object;)Z", task), () => 1) : 1;
}
const executorMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "execute(Ljava/lang/Runnable;)V": execute,
  "submit(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;": function (this: JExecutor, r: unknown) {
    return submitTask(this, "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/RunnableFuture;", r, null);
  },
  "submit(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;": function (this: JExecutor, c: unknown) {
    return submitTask(this, "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/RunnableFuture;", c);
  },
  "invokeAll(Ljava/util/Collection;)Ljava/util/List;": async function (this: JExecutor, tasks: JList) {
    if (tasks == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const futures = newArrayList();
    for (const task of tasks.a) futures.a.push(await vcall(this, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task));
    for (const future of futures.a) {
      try { await vcall(future, "get", "()Ljava/lang/Object;"); } catch {}
    }
    return futures;
  },
  "invokeAll(Ljava/util/Collection;JLjava/util/concurrent/TimeUnit;)Ljava/util/List;": async function (this: JExecutor, tasks: JList, timeout: bigint, unit: JTimeUnit) {
    if (tasks == null || unit == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const futures = newArrayList();
    for (const task of tasks.a) futures.a.push(await vcall(this, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task));
    const deadline = guestNow() + Number(timeout) * unit.ms;
    for (let i = 0; i < futures.a.length; i++) {
      const remaining = Math.max(0, deadline - guestNow());
      try { await vcall(futures.a[i], "get", "(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;", BigInt(Math.ceil(remaining * 1e6)), TUS.NANOSECONDS); }
      catch (e) {
        if (!rt.iof(e, "java/util/concurrent/TimeoutException")) continue;
        for (; i < futures.a.length; i++) await vcall(futures.a[i], "cancel", "(Z)Z", 1);
        break;
      }
    }
    return futures;
  },
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
  },
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
  this.limit = Math.max(1, core); this.factory = factory; this.rejectionHandler = handler;
}
function initPool(this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JObj, factory: unknown = null, handler: unknown = null) {
  if (core < 0 || max <= 0 || max < core || keep < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid pool size");
  this.pool = true; this.coreSize = core; this.maxSize = max;
  this.limit = Math.max(1, core); this.queue = queue; this.factory = factory; this.rejectionHandler = handler;
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
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number, max: number, keep: bigint, unit: JTimeUnit, queue: JObj, handler: unknown) { initPool.call(this, core, max, keep, unit, queue, null, handler); },
      "<init>(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;Ljava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initPool,
      "<init>(I)V": initScheduled,
      "<init>(ILjava/util/concurrent/ThreadFactory;)V": initScheduled,
      "<init>(ILjava/util/concurrent/RejectedExecutionHandler;)V": function (this: JExecutor, core: number, handler: unknown) { initScheduled.call(this, core, null, handler); },
      "<init>(ILjava/util/concurrent/ThreadFactory;Ljava/util/concurrent/RejectedExecutionHandler;)V": initScheduled,
      ...(n === "java/util/concurrent/ScheduledThreadPoolExecutor" ? {
        "setExecuteExistingDelayedTasksAfterShutdownPolicy(Z)V": function (this: JExecutor, value: number) {
          this.executeDelayedAfterShutdown = !!value;
          if (this.shut && !value) cancelDelayed(this);
        },
        "getExecuteExistingDelayedTasksAfterShutdownPolicy()Z": function (this: JExecutor) { return +this.executeDelayedAfterShutdown; },
      } : {}),
      "allowCoreThreadTimeOut(Z)V": function () {},
      "getPoolSize()I": function (this: JExecutor) { return this.workers.length; },
      "getActiveCount()I": function (this: JExecutor) { return this.workers.filter((w) => w.busy).length; },
      "getCorePoolSize()I": function (this: JExecutor) { return this.pool ? this.coreSize : this.limit; },
      "getMaximumPoolSize()I": function (this: JExecutor) { return this.pool ? this.maxSize : this.limit; },
      "remove(Ljava/lang/Runnable;)Z": removeQueued,
      "setKeepAliveTime(JLjava/util/concurrent/TimeUnit;)V": function () {},
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
      // kotlinx looks this up reflectively (removeFutureOnCancel); a cancelled schedule() never runs
      // here regardless, so the policy is just remembered
      "setRemoveOnCancelPolicy(Z)V": function (this: JExecutor, v: number) { this.removeOnCancel = v; },
      "getRemoveOnCancelPolicy()Z": function (this: JExecutor) { return this.removeOnCancel; },
    },
  });
}
let commonForkJoinPool: JExecutor | null = null;
class JForkJoinTask extends JObj { future: JFuture | null = null; result: unknown = null; }
const forkJoinDesc = (task: JForkJoinTask) => rt.iof(task, "java/util/concurrent/RecursiveAction") ? "()V" : "()Ljava/lang/Object;";
const forkTask = (task: JForkJoinTask, pool: JExecutor) => {
  task.future = submit(pool, task, "compute", forkJoinDesc(task));
  return task;
};
async function runForkJoinTask(task: JForkJoinTask): Promise<unknown> {
  const value = await vcall(task, "compute", forkJoinDesc(task));
  if (value !== undefined) task.result = value;
  return task.result;
}
async function invokeForkJoinTasks(tasks: JForkJoinTask[]): Promise<void> {
  for (let i = tasks.length - 1; i > 0; i--) await vcall(tasks[i], "fork", "()Ljava/util/concurrent/ForkJoinTask;");
  if (tasks.length) await vcall(tasks[0], "invoke", "()Ljava/lang/Object;");
  for (let i = 1; i < tasks.length; i++) await vcall(tasks[i], "join", "()Ljava/lang/Object;");
}
const forkJoinMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "fork()Ljava/util/concurrent/ForkJoinTask;": function (this: JForkJoinTask) {
    const pool = (rt.link("java/util/concurrent/ForkJoinPool").ctor as any)[mangleMethod("commonPool", "()Ljava/util/concurrent/ForkJoinPool;")]() as JExecutor;
    return forkTask(this, pool);
  },
  "join()Ljava/lang/Object;": async function (this: JForkJoinTask) {
    if (this.future) {
      const value = await futureGet(this.future);
      if (value !== undefined && value !== null) this.result = value;
    }
    return this.result;
  },
  "get()Ljava/lang/Object;": async function (this: JForkJoinTask) { return vcall(this, "join", "()Ljava/lang/Object;"); },
  "invoke()Ljava/lang/Object;": function (this: JForkJoinTask) { return runForkJoinTask(this); },
  "getRawResult()Ljava/lang/Object;": function (this: JForkJoinTask) { return this.result; },
  "isDone()Z": function (this: JForkJoinTask) { return !this.future || this.future.done ? 1 : 0; },
  "isCancelled()Z": function (this: JForkJoinTask) { return this.future?.cancelled ? 1 : 0; },
  "cancel(Z)Z": function (this: JForkJoinTask, interrupt: number) {
    if (!this.future || this.future.done) return 0;
    cancelFuture(this.future, interrupt);
    return 1;
  },
  "static invokeAll(Ljava/util/concurrent/ForkJoinTask;Ljava/util/concurrent/ForkJoinTask;)V": async (first: JForkJoinTask, second: JForkJoinTask) => {
    await vcall(second, "fork", "()Ljava/util/concurrent/ForkJoinTask;");
    await runForkJoinTask(first);
    await vcall(second, "join", "()Ljava/lang/Object;");
  },
  "static invokeAll([Ljava/util/concurrent/ForkJoinTask;)V": (tasks: JForkJoinTask[]) => invokeForkJoinTasks(tasks),
  "static invokeAll(Ljava/util/Collection;)Ljava/util/Collection;": async (tasks: unknown) => {
    await invokeForkJoinTasks(await vcall(tasks, "toArray", "()[Ljava/lang/Object;"));
    return tasks;
  },
};
rt.register({ name: "java/util/concurrent/ForkJoinTask", ctor: JForkJoinTask, ifaces: ["java/util/concurrent/Future", "java/io/Serializable"], methods: forkJoinMethods });
rt.register({ name: "java/util/concurrent/RecursiveTask", ctor: class extends JForkJoinTask {}, sup: "java/util/concurrent/ForkJoinTask", typeVars: "V", methods: { "<init>()V": function () {} } });
rt.register({ name: "java/util/concurrent/RecursiveAction", ctor: class extends JForkJoinTask {}, sup: "java/util/concurrent/ForkJoinTask", methods: { "<init>()V": function () {} } });
rt.register({
  name: "java/util/concurrent/ForkJoinPool", ctor: class extends JExecutor {},
  ifaces: ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  sup: "java/util/concurrent/AbstractExecutorService",
  methods: {
    ...executorMethods,
    "<init>()V": function (this: JExecutor) { initScheduled.call(this, navigator.hardwareConcurrency || 4); },
    "<init>(I)V": function (this: JExecutor, parallelism: number) {
      if (parallelism <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      initScheduled.call(this, parallelism);
    },
    "static commonPool()Ljava/util/concurrent/ForkJoinPool;": () => {
      if (!commonForkJoinPool) {
        const pool = rt.make("java/util/concurrent/ForkJoinPool") as JExecutor;
        initScheduled.call(pool, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
        commonForkJoinPool = pool;
      }
      return commonForkJoinPool;
    },
    "static getCommonPoolParallelism()I": () => Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
    "invoke(Ljava/util/concurrent/ForkJoinTask;)Ljava/lang/Object;": (task: unknown) => vcall(task, "invoke", "()Ljava/lang/Object;"),
    "execute(Ljava/util/concurrent/ForkJoinTask;)V": function (this: JExecutor, task: JForkJoinTask) { forkTask(task, this); },
    "submit(Ljava/util/concurrent/ForkJoinTask;)Ljava/util/concurrent/ForkJoinTask;": function (this: JExecutor, task: JForkJoinTask) { return forkTask(task, this); },
    "getParallelism()I": function (this: JExecutor) { return this.limit; },
    "getPoolSize()I": function (this: JExecutor) { return this.workers.length; },
    "getActiveThreadCount()I": function (this: JExecutor) { return this.workers.filter((worker) => worker.busy).length; },
    "getQueuedTaskCount()J": function (this: JExecutor) { return BigInt(this.tasks.length); },
    "isQuiescent()Z": function (this: JExecutor) { return this.pending === 0 ? 1 : 0; },
  },
});
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
  if (name === "<init>" || name === "newTaskFor") continue;
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

for (const [i, ...ifaces] of [["java/util/concurrent/Executor"], ["java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"],
  ["java/util/concurrent/ScheduledExecutorService", "java/util/concurrent/ExecutorService", "java/util/concurrent/Executor"], ["java/util/concurrent/Future"],
  ["java/util/concurrent/ScheduledFuture", "java/util/concurrent/Future"], ["java/util/concurrent/Callable"], ["java/util/concurrent/ThreadFactory"],
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
      "rejectedExecution(Ljava/lang/Runnable;Ljava/util/concurrent/ThreadPoolExecutor;)V": async (r: unknown, ex: JExecutor) => {
        if (n === "AbortPolicy") throw rt.mkThrowable("java/util/concurrent/RejectedExecutionException", "rejected");
        if (await vcall(ex, "isShutdown", "()Z")) return;
        if (run) return vcall(r, "run", "()V");
        if (n === "DiscardOldestPolicy") {
          const queue = await vcall(ex, "getQueue", "()Ljava/util/concurrent/BlockingQueue;");
          const oldest = await vcall(queue, "poll", "()Ljava/lang/Object;");
          if (oldest) await removeQueued.call(ex, oldest);
          return vcall(ex, "execute", "(Ljava/lang/Runnable;)V", r);
        }
      },
    },
  });
}
defineException("java/util/concurrent/RejectedExecutionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/TimeoutException", "java/lang/Exception");
defineException("java/util/concurrent/ExecutionException", "java/lang/Exception");
defineException("java/util/concurrent/CompletionException", "java/lang/RuntimeException");
defineException("java/util/concurrent/CancellationException", "java/lang/IllegalStateException");

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

// CompletableFuture: completed from outside, so the promise is armed by the constructor
class JCompletable extends JFuture { settle: () => void = () => {}; dependents: (() => void)[] = []; }
const completable = () => { const f = new JCompletable(); f.promise = new Promise<void>((r) => { f.settle = r; }); return f; };
const settleWith = (f: JCompletable, value: unknown, error: unknown) => {
  if (f.done) return 0;
  f.value = value; f.error = error; f.cancelled = rt.iof(error, "java/util/concurrent/CancellationException") ? 1 : 0; f.done = 1;
  f.settle();
  for (const run of f.dependents.splice(0)) run();
  return 1;
};
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
function supplyAsync(supplier: unknown, executor: unknown) {
  if (supplier == null || executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const future = completable();
  rt.link("webdroid/AsyncSupply");
  void vcall(executor, "execute", "(Ljava/lang/Runnable;)V", new JAsyncSupply(future, supplier))
    .catch(async (error) => settleWith(future, null, await completionError(rt.jx(error))));
  return future;
}
const completionActions = {
  thenApply: ["java/util/function/Function", "apply", "(Ljava/lang/Object;)Ljava/lang/Object;"],
  thenCompose: ["java/util/function/Function", "apply", "(Ljava/lang/Object;)Ljava/lang/Object;"],
  thenAccept: ["java/util/function/Consumer", "accept", "(Ljava/lang/Object;)V"],
  thenRun: ["java/lang/Runnable", "run", "()V"],
  exceptionally: ["java/util/function/Function", "apply", "(Ljava/lang/Object;)Ljava/lang/Object;"],
  handle: ["java/util/function/BiFunction", "apply", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;"],
  whenComplete: ["java/util/function/BiConsumer", "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V"],
} as const;
type CompletionAction = keyof typeof completionActions;
async function runDependent(source: JCompletable, target: JCompletable, action: unknown, kind: CompletionAction) {
  if (target.done) return;
  try {
    const handlesError = kind === "handle" || kind === "whenComplete" || kind === "exceptionally";
    if (source.error && !handlesError) { settleWith(target, null, await completionError(source.error)); return; }
    if (!source.error && kind === "exceptionally") { settleWith(target, source.value, null); return; }
    const [, method, desc] = completionActions[kind];
    const args = kind === "thenRun" ? [] : kind === "handle" || kind === "whenComplete" ? [source.value, source.error] : [kind === "exceptionally" ? source.error : source.value];
    const value = await vcall(action, method, desc, ...args);
    if (kind === "thenCompose") {
      if (value == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const next = value instanceof JCompletable ? value : await vcall(value, "toCompletableFuture", "()Ljava/util/concurrent/CompletableFuture;");
      if (!(next instanceof JCompletable)) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (!next.done) await next.promise;
      settleWith(target, next.value, next.error ? await completionError(next.error) : null);
    } else if (kind === "whenComplete") settleWith(target, source.value, source.error ? await completionError(source.error) : null);
    else settleWith(target, kind === "thenAccept" || kind === "thenRun" ? null : value, null);
  } catch (error) { settleWith(target, null, await completionError(kind === "whenComplete" && source.error ? source.error : rt.jx(error))); }
}
const completionMethods: NonNullable<NativeSpec["methods"]> = {};
for (const kind of Object.keys(completionActions) as CompletionAction[]) {
  const method = function (this: JCompletable, action: unknown) {
    if (action == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const target = completable(), run = () => { void runDependent(this, target, action, kind); };
    if (this.done) run(); else this.dependents.push(run);
    return target;
  };
  for (const result of ["CompletableFuture", "CompletionStage"])
    completionMethods[`${kind}(L${completionActions[kind][0]};)Ljava/util/concurrent/${result};`] = method;
}
class JCompletionRunnable extends JObj { task: () => Promise<void> = async () => {}; }
rt.register({
  name: "webdroid/CompletionRunnable", ctor: JCompletionRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: JCompletionRunnable) { return this.task(); } },
});
function dispatchCompletion(target: JCompletable, action: () => Promise<unknown>, executor: unknown): void {
  const task = new JCompletionRunnable();
  task.task = async () => {
    try { settleWith(target, await action(), null); }
    catch (error) { settleWith(target, null, await completionError(rt.jx(error))); }
  };
  void vcall(executor, "execute", "(Ljava/lang/Runnable;)V", task)
    .catch(async (error) => settleWith(target, null, await completionError(rt.jx(error))));
}
function asyncDependent(source: JCompletable, action: (value: unknown, error: unknown) => Promise<unknown>, executor: unknown): JCompletable {
  const target = completable();
  const run = () => dispatchCompletion(target, () => action(source.value, source.error), executor);
  if (source.done) run(); else source.dependents.push(run);
  return target;
}
const commonCompletionExecutor = () => completionExecutor ??= mkExecutor(Math.max(2, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1));
rt.register({
  name: "java/util/concurrent/CompletableFuture", ctor: JCompletable, sup: "webdroid/Future",
  ifaces: ["java/util/concurrent/Future", "java/util/concurrent/CompletionStage"],
  methods: {
    ...completionMethods,
    "<init>()V": function (this: JCompletable) { this.promise = new Promise<void>((r) => { this.settle = r; }); },
    "static completedFuture(Ljava/lang/Object;)Ljava/util/concurrent/CompletableFuture;": (v: unknown) => { const f = completable(); settleWith(f, v, null); return f; },
    "static supplyAsync(Ljava/util/function/Supplier;)Ljava/util/concurrent/CompletableFuture;": (supplier: unknown) =>
      supplyAsync(supplier, commonCompletionExecutor()),
    "static supplyAsync(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;": supplyAsync,
    "static runAsync(Ljava/lang/Runnable;)Ljava/util/concurrent/CompletableFuture;": (runnable: unknown) => {
      if (runnable == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const f = completable(); dispatchCompletion(f, async () => { await vcall(runnable, "run", "()V"); return null; }, commonCompletionExecutor()); return f;
    },
    "static runAsync(Ljava/lang/Runnable;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;": (runnable: unknown, executor: unknown) => {
      if (runnable == null || executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const f = completable(); dispatchCompletion(f, async () => { await vcall(runnable, "run", "()V"); return null; }, executor); return f;
    },
    "static allOf([Ljava/util/concurrent/CompletableFuture;)Ljava/util/concurrent/CompletableFuture;": (futures: JCompletable[]) => {
      if (!futures) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const result = completable();
      void Promise.all(futures.map(async (future) => {
        if (!future) throw rt.mkThrowable("java/lang/NullPointerException", null);
        await future.promise;
        if (future.cancelled) throw rt.mkThrowable("java/util/concurrent/CancellationException", null);
        if (future.error) throw future.error;
      })).then(() => settleWith(result, null, null), async (error) => settleWith(result, null, await completionError(rt.jx(error))));
      return result;
    },
    "complete(Ljava/lang/Object;)Z": function (this: JCompletable, v: unknown) { return settleWith(this, v, null); },
    "completeExceptionally(Ljava/lang/Throwable;)Z": function (this: JCompletable, t: unknown) { if (t == null) throw rt.mkThrowable("java/lang/NullPointerException", null); return settleWith(this, null, t); },
    "join()Ljava/lang/Object;": async function (this: JCompletable) { if (!this.done) await this.promise; return completableValue(this, true); },
    "getNow(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JCompletable, d: unknown) { return !this.done ? d : this.error ? completableValue(this, true) : this.value; },
    "isCompletedExceptionally()Z": function (this: JCompletable) { return this.done && this.error ? 1 : 0; },
    "toCompletableFuture()Ljava/util/concurrent/CompletableFuture;": function (this: JCompletable) { return this; },
    "cancel(Z)Z": function (this: JCompletable) { return settleWith(this, null, rt.mkThrowable("java/util/concurrent/CancellationException", null)) || this.cancelled; },
    "thenApplyAsync(Ljava/util/function/Function;)Ljava/util/concurrent/CompletableFuture;": function (this: JCompletable, fn: unknown) {
      if (fn == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return asyncDependent(this, (value, error) => error ? Promise.reject(error) : vcall(fn, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", value), commonCompletionExecutor());
    },
    "thenApplyAsync(Ljava/util/function/Function;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;": function (this: JCompletable, fn: unknown, executor: unknown) {
      if (fn == null || executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return asyncDependent(this, (value, error) => error ? Promise.reject(error) : vcall(fn, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", value), executor);
    },
    "whenCompleteAsync(Ljava/util/function/BiConsumer;)Ljava/util/concurrent/CompletableFuture;": function (this: JCompletable, fn: unknown) {
      if (fn == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return asyncDependent(this, async (value, error) => { await vcall(fn, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", value, error); if (error) throw error; return value; }, commonCompletionExecutor());
    },
    "whenCompleteAsync(Ljava/util/function/BiConsumer;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;": function (this: JCompletable, fn: unknown, executor: unknown) {
      if (fn == null || executor == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return asyncDependent(this, async (value, error) => { await vcall(fn, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", value, error); if (error) throw error; return value; }, executor);
    },
  },
});
rt.markers("java/util/concurrent/CompletionStage", "java/util/concurrent/CompletableFuture$AsynchronousCompletionTask");

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
    "run()V": async function (this: JFutureTask) {
      if (this.done || this.thread) return;
      const thread = this.thread = curThread;
      try {
        const value = await vcall(this.callable, "call", "()Ljava/lang/Object;");
        if (!this.cancelled) this.value = value;
      } catch (e) { this.error = rt.jx(e); } // surfaces from get(), as AOSP's setException
      this.done = 1; this.thread = null;
      this.wake(null);
      if (!this.cancelled) await vcallOn(thread, this, "done", "()V");
    },
    "done()V": function () {},
    "get()Ljava/lang/Object;": function (this: JFutureTask) { return futureGet(this); },
    "get(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JFutureTask, d: bigint, u: JTimeUnit) { return futureGetTimed(this, d, u); },
    "isDone()Z": function (this: JFutureTask) { return this.done; },
    "isCancelled()Z": function (this: JFutureTask) { return this.cancelled; },
    "cancel(Z)Z": async function (this: JFutureTask, interrupt: number) {
      if (this.done) return 0;
      cancelFuture(this, interrupt); this.wake(null);
      await vcall(this, "done", "()V");
      return 1;
    },
  },
});
