import { expect, test, describe } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync, curThread, mainThread, JThread, setCurThread, vcallOn, park } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
import { jarray } from "../src/jvm/abi";
import { mainLooper } from "../src/android/os";

describe("blocking-queue-drain", () => {
  rt.linkNatives();

  test("bounded queues reject overflow and wake blocked producers after removal", async () => {
    const queue = await newObj("java/util/concurrent/ArrayBlockingQueue", "(I)V", 1);
    expect(await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "first")).toBe(1);
    expect(await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "overflow")).toBe(0);
    let completed = false;
    const producer = vcallAsync(queue, "put", "(Ljava/lang/Object;)V", "second").then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(await vcall(queue, "remainingCapacity", "()I")).toBe(0);
    expect(await vcall(queue, "poll", "()Ljava/lang/Object;")).toBe("first");
    await producer;
    expect(await vcall(queue, "take", "()Ljava/lang/Object;")).toBe("second");
    expect(await vcall(queue, "remainingCapacity", "()I")).toBe(1);
    const handoff = await newObj("java/util/concurrent/SynchronousQueue");
    const pending = vcall(handoff, "put", "(Ljava/lang/Object;)V", "handoff");
    expect(await vcall(handoff, "size", "()I")).toBe(0);
    expect(await vcall(handoff, "take", "()Ljava/lang/Object;")).toBe("handoff");
    await pending;
  });

  for (const name of ["ArrayBlockingQueue", "LinkedBlockingQueue", "LinkedBlockingDeque", "LinkedTransferQueue", "PriorityBlockingQueue"]) {
    test(`${name} drains a bounded prefix and then the remaining elements`, async () => {
      const queue = await newObj(`java/util/concurrent/${name}`, "(I)V", 8);
      for (const value of ["a", "b", "c"]) await vcall(queue, "offer", "(Ljava/lang/Object;)Z", value);
      const target = newArrayList(["existing"]);
      const drain = (max: number) => vcall(queue, "drainTo", "(Ljava/util/Collection;I)I", target, max);
      expect(await drain(-1)).toBe(0);
      expect(await drain(2)).toBe(2);
      expect(target.a).toEqual(["existing", "a", "b"]);
      expect(await vcall(queue, "peek", "()Ljava/lang/Object;")).toBe("c");
      expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", target)).toBe(1);
      expect(target.a).toEqual(["existing", "a", "b", "c"]);
      expect(await vcall(queue, "size", "()I")).toBe(0);
      expect(await drain(10)).toBe(0);
      expect(await vcallAsync(queue, "drainTo", "(Ljava/util/Collection;I)I", null, 0).catch(e => rt.iof(e, "java/lang/NullPointerException"))).toBe(1);
      expect(await vcallAsync(queue, "drainTo", "(Ljava/util/Collection;)I", queue).catch(e => rt.iof(e, "java/lang/IllegalArgumentException"))).toBe(1);
    });
  }

  test("draining calls suspending collection overrides and propagates failures", async () => {
    class Target extends JObj { values: unknown[] = []; fail = false; }
    rt.register({ name: "test/DrainTarget", ctor: Target, methods: {
      "add(Ljava/lang/Object;)Z": async function (this: Target, value: unknown) {
        await Promise.resolve();
        if (this.fail) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
        this.values.push(value);
        return 1;
      },
    } });
    const queue = await newObj("java/util/concurrent/ArrayBlockingQueue", "(I)V", 8);
    const target = rt.make("test/DrainTarget");
    if (!(target instanceof Target)) throw new Error("Wrong target class");
    await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "first");
    expect(await vcall(queue, "drainTo", "(Ljava/util/Collection;)I", target)).toBe(1);
    expect(target.values).toEqual(["first"]);
    target.fail = true;
    await vcall(queue, "offer", "(Ljava/lang/Object;)Z", "second");
    expect(await vcallAsync(queue, "drainTo", "(Ljava/util/Collection;)I", target).catch(e => rt.iof(e, "java/lang/UnsupportedOperationException"))).toBe(1);
  });
});

describe("completable-future", () => {
  class Supplier extends JObj { runs = 0; error: unknown = null; thread = mainThread; }
  class Executor extends JObj { tasks: unknown[] = []; }
  class Action extends JObj { call: (...args: unknown[]) => unknown = () => null; }
  rt.register({ name: "test/FutureSupplier", ctor: Supplier, ifaces: ["java/util/function/Supplier"], methods: {
    "get()Ljava/lang/Object;": function (this: Supplier) {
      this.runs++; this.thread = curThread;
      if (this.error) throw this.error;
      return "supplied";
    },
  } });
  rt.register({ name: "test/FutureExecutor", ctor: Executor, ifaces: ["java/util/concurrent/Executor"], methods: {
    "execute(Ljava/lang/Runnable;)V": function (this: Executor, task: unknown) { this.tasks.push(task); },
  } });
  rt.register({ name: "test/FutureAction", ctor: Action, ifaces: ["java/util/function/Function", "java/util/function/BiConsumer"], methods: {
    "apply(Ljava/lang/Object;)Ljava/lang/Object;": function (this: Action, value: unknown) { return this.call(value); },
    "accept(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: Action, value: unknown, error: unknown) { return this.call(value, error); },
  } });
  rt.linkNatives();
  const supply = (supplier: Supplier) => vcall(rt.link("java/util/concurrent/CompletableFuture").ctor,
    "supplyAsync", "(Ljava/util/function/Supplier;)Ljava/util/concurrent/CompletableFuture;", supplier);

  test("supplyAsync runs on a worker and completes with the supplier's value", async () => {
    const supplier = new Supplier(), future = await supply(supplier);
    expect(supplier.runs).toBe(0);
    expect(await vcall(future, "join", "()Ljava/lang/Object;")).toBe("supplied");
    expect(supplier.runs).toBe(1);
    expect(supplier.thread).not.toBe(mainThread);
  });

  test("supplier exceptions retain their cause through get and join", async () => {
    const supplier = new Supplier(); supplier.error = rt.mkThrowable("java/lang/IllegalArgumentException", "supplier failed");
    const future = await supply(supplier);
    for (const [method, type] of [["get", "ExecutionException"], ["join", "CompletionException"]]) {
      const error = await vcallAsync(future, method, "()Ljava/lang/Object;").then(() => null, e => e);
      expect(rt.iof(error, `java/util/concurrent/${type}`)).toBeTruthy();
      expect(await vcall(error, "getCause", "()Ljava/lang/Throwable;")).toBe(supplier.error);
    }
  });

  test("cancelling before the supplied executor runs skips the supplier", async () => {
    const supplier = new Supplier(), executor = new Executor();
    const future = await vcall(rt.link("java/util/concurrent/CompletableFuture").ctor, "supplyAsync",
      "(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;", supplier, executor);
    expect(await vcall(future, "cancel", "(Z)Z", 1)).toBe(1);
    await vcall(executor.tasks[0], "run", "()V");
    expect(supplier.runs).toBe(0);
    expect(await vcall(future, "isCompletedExceptionally", "()Z")).toBe(1);
    const error = await vcallAsync(future, "getNow", "(Ljava/lang/Object;)Ljava/lang/Object;", "fallback").then(() => null, e => e);
    expect(rt.iof(error, "java/util/concurrent/CancellationException")).toBeTruthy();
    const incomplete = await newObj("java/util/concurrent/CompletableFuture");
    expect(await vcall(incomplete, "getNow", "(Ljava/lang/Object;)Ljava/lang/Object;", "fallback")).toBe("fallback");
  });

  test("dependent functions can suspend without blocking completion and compose another future", async () => {
    const source = await newObj("java/util/concurrent/CompletableFuture"), next = await newObj("java/util/concurrent/CompletableFuture");
    const action = new Action(); let release: (value: unknown) => void = () => {};
    action.call = value => { expect(value).toBe("source"); return new Promise(resolve => { release = resolve; }); };
    const mapped = await vcall(source, "thenApply", "(Ljava/util/function/Function;)Ljava/util/concurrent/CompletableFuture;", action);
    const compose = new Action(); compose.call = value => { expect(value).toBe("mapped"); return next; };
    const result = await vcall(mapped, "thenCompose", "(Ljava/util/function/Function;)Ljava/util/concurrent/CompletionStage;", compose);
    expect(await vcall(source, "complete", "(Ljava/lang/Object;)Z", "source")).toBe(1);
    expect(await vcall(mapped, "isDone", "()Z")).toBe(0);
    release("mapped");
    await vcall(next, "complete", "(Ljava/lang/Object;)Z", "composed");
    expect(await vcall(result, "join", "()Ljava/lang/Object;")).toBe("composed");
  });

  test("failed sources skip transforms, can recover, and retain their error when observation fails", async () => {
    const source = await newObj("java/util/concurrent/CompletableFuture"), original = rt.mkThrowable("java/lang/IllegalArgumentException", "original");
    const action = new Action(); action.call = () => { throw rt.mkThrowable("java/lang/IllegalStateException", "observer"); };
    const observed = await vcall(source, "whenComplete", "(Ljava/util/function/BiConsumer;)Ljava/util/concurrent/CompletableFuture;", action);
    await vcall(source, "completeExceptionally", "(Ljava/lang/Throwable;)Z", original);
    const error = await vcallAsync(observed, "join", "()Ljava/lang/Object;").then(() => null, e => e);
    expect(await vcall(error, "getCause", "()Ljava/lang/Throwable;")).toBe(original);
    const recovery = new Action(); recovery.call = value => { expect(value).toBe(original); return "recovered"; };
    const recovered = await vcall(source, "exceptionally", "(Ljava/util/function/Function;)Ljava/util/concurrent/CompletableFuture;", recovery);
    expect(await vcall(recovered, "join", "()Ljava/lang/Object;")).toBe("recovered");
    const transform = new Action(); let calls = 0; transform.call = () => { calls++; };
    const skipped = await vcall(source, "thenApply", "(Ljava/util/function/Function;)Ljava/util/concurrent/CompletableFuture;", transform);
    await vcallAsync(skipped, "join", "()Ljava/lang/Object;").catch(() => {});
    expect(calls).toBe(0);
  });
});

describe("cyclic-barrier", () => {
  class BarrierAction extends JObj { calls = 0; }
  rt.register({ name: "test/BarrierAction", ctor: BarrierAction, ifaces: ["java/lang/Runnable"], methods: {
    "run()V": async function (this: BarrierAction) { await Bun.sleep(1); this.calls++; },
  } });
  rt.linkNatives();
  const wait = (barrier: unknown, thread: JThread, duration?: bigint) => {
    setCurThread(thread);
    const result = duration === undefined ? vcall(barrier, "await", "()I") : vcall(barrier, "await", "(JLjava/util/concurrent/TimeUnit;)I", duration, rt.link("java/util/concurrent/TimeUnit").ctor.s$MILLISECONDS);
    setCurThread(mainThread); return result;
  };
  test("CyclicBarrier releases every generation after the suspendable action", async () => {
    const action = await newObj("test/BarrierAction");
    const barrier = await newObj("java/util/concurrent/CyclicBarrier", "(ILjava/lang/Runnable;)V", 2, action);
    for (let i = 0; i < 2; i++) {
      const first = wait(barrier, new JThread());
      const second = wait(barrier, new JThread());
      expect(await Promise.all([first, second])).toEqual([1, 0]);
      expect(action.calls).toBe(i + 1);
    }
  });
  test("timeout and interruption break peers until reset", async () => {
    const barrier = await newObj("java/util/concurrent/CyclicBarrier", "(I)V", 3);
    const peer = wait(barrier, new JThread()).catch((e: unknown) => e);
    await expect((async () => wait(barrier, new JThread(), 1n))()).rejects.toMatchObject({ constructor: rt.link("java/util/concurrent/TimeoutException").ctor });
    expect(await peer).toMatchObject({ constructor: rt.link("java/util/concurrent/BrokenBarrierException").ctor });
    await vcall(barrier, "reset", "()V");
    expect(await vcall(barrier, "isBroken", "()Z")).toBe(0);
    const thread = new JThread();
    const interrupted = wait(barrier, thread).catch((e: unknown) => e);
    await vcall(thread, "interrupt", "()V");
    expect(await interrupted).toMatchObject({ constructor: rt.link("java/lang/InterruptedException").ctor });
    expect(await vcall(barrier, "isBroken", "()Z")).toBe(1);
  });
});

describe("executor-queue", () => {
  class RecordingRunnable extends JObj { runs = 0; }
  class BlockingRunnable extends JObj {
    promise: Promise<void>;
    release!: () => void;
    constructor() {
      super();
      this.promise = new Promise((resolve) => { this.release = resolve; });
    }
  }
  class ValueSupplier extends JObj { value = "supplied"; }
  rt.register({
    name: "test/QueueRunnable", ctor: RecordingRunnable, ifaces: ["java/lang/Runnable"],
    methods: { "run()V": function (this: RecordingRunnable) { this.runs++; } },
  });
  rt.register({
    name: "test/ExecutorBlockingRunnable", ctor: BlockingRunnable, ifaces: ["java/lang/Runnable"],
    methods: { "run()V": function (this: BlockingRunnable) { return this.promise; } },
  });
  // the shape of an app's own BlockingQueue: implements the interface, carries no native storage
  rt.register({ name: "test/AppQueue", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/BlockingQueue"] });
  class ListeningExecutor extends (rt.link("java/util/concurrent/AbstractExecutorService").ctor as typeof JObj) { executed: unknown[] = []; }
  rt.register({
    name: "test/ListeningExecutor", ctor: ListeningExecutor, sup: "java/util/concurrent/AbstractExecutorService",
    methods: {
      "<init>()V": function () {},
      "execute(Ljava/lang/Runnable;)V": async function (this: ListeningExecutor, task: unknown) {
        this.executed.push(task);
        await vcall(task, "run", "()V");
      },
      "newTaskFor(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/RunnableFuture;": function (callable: unknown) {
        return newObj("test/OwnTask", "(Ljava/util/concurrent/Callable;)V", callable);
      },
    },
  });
  rt.register({ name: "test/OwnTask", ctor: class extends (rt.link("java/util/concurrent/FutureTask").ctor as typeof JObj) {}, sup: "java/util/concurrent/FutureTask", methods: {} });
  rt.register({ name: "test/Answer", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/Callable"], methods: { "call()Ljava/lang/Object;": () => "answer" } });
  rt.register({
    name: "test/ValueSupplier", ctor: ValueSupplier, ifaces: ["java/util/function/Supplier"],
    methods: { "get()Ljava/lang/Object;": function (this: ValueSupplier) { return this.value; } },
  });
  rt.linkNatives();

  const seconds = () => Reflect.get(rt.link("java/util/concurrent/TimeUnit").ctor, "s$SECONDS");
  const pool = (queue: unknown) => newObj("java/util/concurrent/ThreadPoolExecutor",
    "(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V", 1, 1, 0n, seconds(), queue);

  test("scheduled futures expose remaining delay and deadline ordering", async () => {
    const ex = await newObj("java/util/concurrent/ScheduledThreadPoolExecutor", "(I)V", 1);
    const task = new RecordingRunnable(), unit = seconds();
    const schedule = (delay: bigint) => vcall(ex, "schedule", "(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;", task, delay, unit);
    const first = await schedule(60n), second = await schedule(120n);
    try {
      const delay = await vcall(first, "getDelay", "(Ljava/util/concurrent/TimeUnit;)J", unit);
      expect(delay >= 59n && delay <= 60n).toBe(true);
      expect(await vcall(first, "compareTo", "(Ljava/util/concurrent/Delayed;)I", second)).toBe(-1);
      expect(rt.iof(first, "java/util/concurrent/Delayed")).toBe(1);
    } finally { await vcall(ex, "shutdownNow", "()Ljava/util/List;"); }
  });

  test("a pool's execute()d exception reaches the worker's handler; a scheduled pool's future keeps it", async () => {
    class Failing extends JObj {}
    rt.register({ name: "test/FailingRunnable", ctor: Failing, ifaces: ["java/lang/Runnable"],
      methods: { "run()V": () => { throw rt.mkThrowable("java/lang/IllegalStateException", "boom"); } } });
    class Handler extends JObj { seen: unknown[] = []; }
    rt.register({ name: "test/RecordingUEH", ctor: Handler, ifaces: ["java/lang/Thread$UncaughtExceptionHandler"], methods: {
      "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": function (this: Handler, t: unknown) { this.seen.push(t); },
    } });
    rt.linkNatives();
    const handler = new Handler(), Thread = rt.link("java/lang/Thread").ctor;
    const previous = await vcall(Thread, "getDefaultUncaughtExceptionHandler", "()Ljava/lang/Thread$UncaughtExceptionHandler;");
    await vcall(Thread, "setDefaultUncaughtExceptionHandler", "(Ljava/lang/Thread$UncaughtExceptionHandler;)V", handler);
    try {
      for (const ex of [await pool(await newObj("java/util/concurrent/LinkedBlockingQueue")), await newObj("java/util/concurrent/ScheduledThreadPoolExecutor", "(I)V", 1)]) {
        await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", new Failing());
        await vcall(ex, "shutdown", "()V");
        await vcall(ex, "awaitTermination", "(JLjava/util/concurrent/TimeUnit;)Z", 5n, seconds());
        await Promise.resolve();
      }
      expect(handler.seen.length).toBe(1);
      expect(handler.seen[0]).not.toBe(mainThread);
    } finally { await vcall(Thread, "setDefaultUncaughtExceptionHandler", "(Ljava/lang/Thread$UncaughtExceptionHandler;)V", previous); }
  });

  test("a pool executor runs tasks through a bytecode BlockingQueue", async () => {
    const queue = rt.make("test/AppQueue");
    const ex = await pool(queue);
    const task = rt.make("test/QueueRunnable") as RecordingRunnable;
    const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", task);
    await vcall(future, "get", "()Ljava/lang/Object;");
    expect(task.runs).toBe(1);
    expect(await vcall(ex, "getQueue", "()Ljava/util/concurrent/BlockingQueue;")).toBe(queue);
  });

  test("a native queue still mirrors pending tasks", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue");
    const ex = await pool(queue);
    const blocker = new BlockingRunnable();
    const blocked = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", blocker);
    await Promise.resolve();
    const task = new RecordingRunnable();
    const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", task);
    expect(await vcall(queue, "size", "()I")).toBe(1);
    blocker.release();
    await vcall(blocked, "get", "()Ljava/lang/Object;");
    await vcall(future, "get", "()Ljava/lang/Object;");
    expect(await vcall(queue, "size", "()I")).toBe(0);
    expect(task.runs).toBe(1);
  });

  test("submit synchronously uses an overridden task factory and executor", async () => {
    const ex = await newObj("test/ListeningExecutor") as ListeningExecutor;
    const future = await vcall(ex, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", rt.make("test/Answer"));
    expect(rt.iof(future, "test/OwnTask")).toBeTruthy();
    expect(ex.executed).toEqual([future]);
    expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("answer");
  });

  test("a pool gives its first task directly to a core worker", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue");
    const ex = await pool(queue);
    const task = rt.make("test/QueueRunnable");
    const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", task, "result");
    expect(await vcall(queue, "size", "()I")).toBe(0);
    expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("result");
  });

  test("a pool removes a runnable that has not started", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue");
    const ex = await pool(queue);
    const task = rt.make("test/QueueRunnable") as RecordingRunnable;
    await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", task);
    expect(await vcall(ex, "remove", "(Ljava/lang/Runnable;)Z", task)).toBe(1);
    expect(await vcall(ex, "remove", "(Ljava/lang/Runnable;)Z", task)).toBe(0);
    expect(await vcall(queue, "isEmpty", "()Z")).toBe(1);
    await Bun.sleep(10);
    expect(task.runs).toBe(0);
  });

  test("CompletableFuture supplyAsync runs on the supplied executor", async () => {
    const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
    const supplier = new ValueSupplier();
    const future = await vcall(rt.link("java/util/concurrent/CompletableFuture").ctor, "supplyAsync",
      "(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;", supplier, ex);
    expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("supplied");
  });

  test("executor work is eligible at the next cooperative turn", async () => {
    const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
    const task = new RecordingRunnable();
    await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", task);
    await Promise.resolve();
    await Promise.resolve();
    expect(task.runs).toBe(1);
  });

  test("executor backlogs yield to the browser event loop", async () => {
    const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
    const blocker = new BlockingRunnable();
    await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", blocker);
    await Promise.resolve();
    const task = new RecordingRunnable();
    const submissions: Promise<unknown>[] = [];
    for (let i = 0; i < 200; i++) submissions.push(vcall(ex, "execute", "(Ljava/lang/Runnable;)V", task));
    await Promise.all(submissions);
    const browserTurn = new Promise<void>((resolve) => setTimeout(resolve, 0));
    blocker.release();
    await browserTurn;
    expect(task.runs).toBeGreaterThan(0);
    expect(task.runs).toBeLessThan(200);
    while (task.runs < 200) await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("a pool grows when a wrapped synchronous queue refuses storage", async () => {
    class QueueProxy extends JObj { delegate: unknown; }
    rt.register({
      name: "test/HandoffQueue", ctor: QueueProxy, ifaces: ["java/util/concurrent/BlockingQueue"],
      methods: {
        "offer(Ljava/lang/Object;)Z": function (this: QueueProxy, item: unknown) {
          return vcall(this.delegate, "offer", "(Ljava/lang/Object;)Z", item);
        },
      },
    });
    const queue = rt.make("test/HandoffQueue") as QueueProxy;
    queue.delegate = await newObj("java/util/concurrent/SynchronousQueue");
    const ex = await newObj("java/util/concurrent/ThreadPoolExecutor",
      "(IIJLjava/util/concurrent/TimeUnit;Ljava/util/concurrent/BlockingQueue;)V", 0, 2, 0n, seconds(), queue);
    const first = new BlockingRunnable(), second = new BlockingRunnable();
    const a = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", first);
    const b = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", second);
    await Promise.resolve();
    expect(await vcall(ex, "getActiveCount", "()I")).toBe(2);
    expect(await vcall(ex, "getCorePoolSize", "()I")).toBe(0);
    expect(await vcall(ex, "getMaximumPoolSize", "()I")).toBe(2);
    expect(await vcall(queue.delegate, "size", "()I")).toBe(0);
    await expect(vcallAsync(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", new RecordingRunnable())).rejects.toBeDefined();
    const handler = await newObj("java/util/concurrent/ThreadPoolExecutor$CallerRunsPolicy");
    await vcall(ex, "setRejectedExecutionHandler", "(Ljava/util/concurrent/RejectedExecutionHandler;)V", handler);
    const overflow = new RecordingRunnable();
    await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", overflow);
    expect(overflow.runs).toBe(1);
    expect(await vcall(ex, "getRejectedExecutionHandler", "()Ljava/util/concurrent/RejectedExecutionHandler;")).toBe(handler);
    first.release(); second.release();
    await vcall(a, "get", "()Ljava/lang/Object;");
    await vcall(b, "get", "()Ljava/lang/Object;");
    await vcall(ex, "shutdown", "()V");
    await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", overflow);
    expect(overflow.runs).toBe(1);
  });

  test("scheduled shutdown policy cancels delayed work without running it", async () => {
    for (const beforeShutdown of [true, false]) {
      const ex = await newObj("java/util/concurrent/ScheduledThreadPoolExecutor", "(I)V", 1);
      const task = rt.make("test/QueueRunnable");
      const future = await vcall(ex, "schedule", "(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;", task, 60n, seconds());
      if (!beforeShutdown) await vcall(ex, "shutdown", "()V");
      await vcall(ex, "setExecuteExistingDelayedTasksAfterShutdownPolicy", "(Z)V", 0);
      if (beforeShutdown) await vcall(ex, "shutdown", "()V");
      expect(await vcall(future, "isCancelled", "()Z")).toBe(1);
      expect(await vcall(ex, "isTerminated", "()Z")).toBe(1);
    }
  });

  test("awaitTermination waits for a cancelled task that is still running", async () => {
    const ex = await newObj("java/util/concurrent/ScheduledThreadPoolExecutor", "(I)V", 1);
    const running = new BlockingRunnable();
    await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", running);
    await Promise.resolve();
    await vcall(ex, "shutdownNow", "()Ljava/util/List;");
    let done = false;
    const waiting = vcallAsync(ex, "awaitTermination", "(JLjava/util/concurrent/TimeUnit;)Z", 2n, seconds()).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 0));   // a waiting caller leaves the event loop running
    expect(done).toBe(false);
    running.release();
    expect(await waiting).toBe(1);
  });

  test("resizing a scheduled pool starts queued work and retires idle excess workers", async () => {
    const ex = await newObj("java/util/concurrent/ScheduledThreadPoolExecutor", "(I)V", 1);
    const first = new BlockingRunnable(), second = new BlockingRunnable(), third = new RecordingRunnable();
    const a = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", first);
    const b = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", second);
    expect(await vcall(ex, "getActiveCount", "()I")).toBe(1);
    await vcall(ex, "setCorePoolSize", "(I)V", 2);
    await Promise.resolve();
    expect(await vcall(ex, "getActiveCount", "()I")).toBe(2);
    await vcall(ex, "setCorePoolSize", "(I)V", 1);
    const c = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", third);
    first.release();
    await vcall(a, "get", "()Ljava/lang/Object;");
    await Bun.sleep(0);
    expect(third.runs).toBe(0);
    expect(await vcall(ex, "getPoolSize", "()I")).toBe(1);
    second.release();
    await vcall(b, "get", "()Ljava/lang/Object;");
    await vcall(c, "get", "()Ljava/lang/Object;");
    expect(third.runs).toBe(1);
    await vcall(ex, "setCorePoolSize", "(I)V", 0);
    expect(await vcall(ex, "getCorePoolSize", "()I")).toBe(0);
    expect(await vcall(ex, "getMaximumPoolSize", "()I")).toBe(0x7fffffff);
    await expect(vcallAsync(ex, "setCorePoolSize", "(I)V", -1)).rejects.toBeDefined();
  });
});

describe("executor-task-factory", () => {
  class FactoryExecutor extends rt.link("java/util/concurrent/AbstractExecutorService").ctor { tasks: unknown[] = []; }
  class Task extends JObj { runs = 0; }
  rt.register({ name: "test/FactoryTask", ctor: Task, ifaces: ["java/lang/Runnable", "java/util/concurrent/Callable"], methods: {
    "run()V": function (this: Task) { this.runs++; },
    "call()Ljava/lang/Object;": function (this: Task) { this.runs++; return "called"; },
  } });
  rt.register({ name: "test/FactoryExecutor", ctor: FactoryExecutor, sup: "java/util/concurrent/AbstractExecutorService", methods: {
    "newTaskFor(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/RunnableFuture;": async function (this: FactoryExecutor, task: unknown, result: unknown) {
      const f = await newObj("java/util/concurrent/FutureTask", "(Ljava/lang/Runnable;Ljava/lang/Object;)V", task, result);
      this.tasks.push(f); return f;
    },
    "newTaskFor(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/RunnableFuture;": async function (this: FactoryExecutor, task: unknown) {
      const f = await newObj("java/util/concurrent/FutureTask", "(Ljava/util/concurrent/Callable;)V", task);
      this.tasks.push(f); return f;
    },
    "execute(Ljava/lang/Runnable;)V": (task: unknown) => vcall(task, "run", "()V"),
  } });
  rt.linkNatives();

  test("submit preserves suspended newTaskFor and execute overrides for all overloads", async () => {
    const ex = await newObj("test/FactoryExecutor"), task = await newObj("test/FactoryTask");
    for (const [desc, args, result] of [
      ["(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", [task], null],
      ["(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", [task, "result"], "result"],
      ["(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", [task], "called"],
    ] satisfies [string, unknown[], unknown][]) {
      const f = await vcall(ex, "submit", desc, ...args);
      expect(f).toBe(ex.tasks.at(-1));
      expect(await vcall(f, "get", "()Ljava/lang/Object;")).toBe(result);
      await vcall(f, "run", "()V");
    }
    expect(task.runs).toBe(3);
    await expect(vcallAsync(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", null)).rejects.toBeDefined();
    expect(ex.tasks.length).toBe(3);
  });
  test("cancelling FutureTask before execution wakes get and prevents its runnable", async () => {
    const task = await newObj("test/FactoryTask");
    const f = await newObj("java/util/concurrent/FutureTask", "(Ljava/lang/Runnable;Ljava/lang/Object;)V", task, "unused");
    expect(await vcall(f, "cancel", "(Z)Z", 0)).toBe(1);
    await vcall(f, "run", "()V");
    expect(task.runs).toBe(0);
    expect(await vcall(f, "isCancelled", "()Z")).toBe(1);
    await expect(vcallAsync(f, "get", "()Ljava/lang/Object;")).rejects.toMatchObject({ constructor: rt.link("java/util/concurrent/CancellationException").ctor });
  });

  class CompletionTask extends rt.link("java/util/concurrent/FutureTask").ctor { notifications = 0; completed = false; }
  rt.register({ name: "test/CompletionTask", ctor: CompletionTask, sup: "java/util/concurrent/FutureTask", methods: {
    "done()V": async function (this: CompletionTask) {
      this.notifications++;
      this.completed = await vcall(this, "isDone", "()Z") === 1;
    },
  } });
  test("FutureTask dispatches the virtual completion callback once for success and cancellation", async () => {
    for (const cancel of [false, true]) {
      const task = await newObj("test/FactoryTask");
      const f = await newObj("test/CompletionTask", "(Ljava/lang/Runnable;Ljava/lang/Object;)V", task, "done");
      if (cancel) await vcall(f, "cancel", "(Z)Z", 0);
      await vcall(f, "run", "()V");
      await vcall(f, "run", "()V");
      expect(f.notifications).toBe(1);
      expect(f.completed).toBe(true);
      expect(task.runs).toBe(cancel ? 0 : 1);
    }
  });

  test("FutureTask completion retains the executing thread after a suspended callable", async () => {
    class SuspendedCallable extends JObj { fail = false; }
    rt.register({ name: "test/SuspendedCallable", ctor: SuspendedCallable, methods: {
      "call()Ljava/lang/Object;": async function (this: SuspendedCallable) {
        await Promise.resolve();
        if (this.fail) throw rt.mkThrowable("java/lang/IllegalStateException", "failed");
        return "completed";
      },
    } });
    class ThreadCompletion extends rt.link("java/util/concurrent/FutureTask").ctor { seen: JThread[] = []; }
    rt.register({ name: "test/ThreadCompletion", ctor: ThreadCompletion, sup: "java/util/concurrent/FutureTask", methods: {
      "done()V": function (this: ThreadCompletion) { this.seen.push(curThread); },
    } });
    rt.linkNatives();
    const worker = new JThread();
    for (const fail of [false, true]) {
      const callable = new SuspendedCallable();
      callable.fail = fail;
      const future = await newObj("test/ThreadCompletion", "(Ljava/util/concurrent/Callable;)V", callable);
      await vcallOn(worker, future, "run", "()V");
      expect(future.seen).toEqual([worker]);
      expect(curThread).toBe(mainThread);
      if (fail) await expect(vcallAsync(future, "get", "()Ljava/lang/Object;")).rejects.toMatchObject({ cause: { msg: "failed" } });
      else expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("completed");
    }
  });
});

describe("priority-blocking-queue", () => {
  rt.linkNatives();

  test("PriorityBlockingQueue keeps a compared item queued until insertion completes", async () => {
    let compareStarted!: () => void, finishCompare!: () => void;
    const started = new Promise<void>((resolve) => { compareStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishCompare = resolve; });
    class Entry extends JObj { key: number | null = null; }
    rt.register({ name: "test/PriorityQueueEntry", ctor: Entry, methods: {
      "compareTo(Ljava/lang/Object;)I": async function (this: Entry, other: Entry) {
        compareStarted();
        await gate;
        if (this.key === null || other.key === null) throw new Error("compared a released entry");
        return this.key - other.key;
      },
    } });
    const queue = await newObj("java/util/concurrent/PriorityBlockingQueue");
    const first = rt.make("test/PriorityQueueEntry") as Entry, second = rt.make("test/PriorityQueueEntry") as Entry;
    first.key = 1; second.key = 2;
    await vcall(queue, "offer", "(Ljava/lang/Object;)Z", first);
    const insertion = vcall(queue, "offer", "(Ljava/lang/Object;)Z", second);
    await started;
    let released = false;
    const removal = vcallAsync(queue, "remove", "(Ljava/lang/Object;)Z", first).then(() => {
      first.key = null;
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    finishCompare();
    await Promise.all([insertion, removal]);
    expect(await vcall(queue, "poll", "()Ljava/lang/Object;")).toBe(second);
  });
});

describe("runnable-future-interface", () => {
  rt.linkNatives();

  test("RunnableFuture exposes both parent interfaces to application implementations", () => {
    rt.register({ name: "test/RunnableFutureImpl", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/RunnableFuture"] });
    const task = rt.make("test/RunnableFutureImpl");
    expect(rt.iof(task, "java/lang/Runnable")).toBe(1);
    expect(rt.iof(task, "java/util/concurrent/Future")).toBe(1);
  });
});

describe("semaphore", () => {
  rt.linkNatives();

  test("Semaphore.drainPermits returns positive, zero and negative counts and empties the semaphore", async () => {
    for (const permits of [7, 0, -3]) {
      const semaphore = await newObj("java/util/concurrent/Semaphore", "(I)V", permits);
      expect(await vcall(semaphore, "drainPermits", "()I")).toBe(permits);
      expect(await vcall(semaphore, "availablePermits", "()I")).toBe(0);
      expect(await vcall(semaphore, "drainPermits", "()I")).toBe(0);
      expect(await vcall(semaphore, "tryAcquire", "()Z")).toBe(0);
      await vcall(semaphore, "release", "()V");
      expect(await vcall(semaphore, "tryAcquire", "()Z")).toBe(1);
    }
  });

  test("draining permits does not complete a waiting acquisition", async () => {
    const semaphore = await newObj("java/util/concurrent/Semaphore", "(I)V", 1);
    let completed = false;
    const waiting = vcallAsync(semaphore, "acquire", "(I)V", 2).then(() => { completed = true; });
    expect(await vcall(semaphore, "drainPermits", "()I")).toBe(1);
    await vcall(semaphore, "release", "()V");
    expect(completed).toBe(false);
    await vcall(semaphore, "release", "()V");
    await waiting;
    expect(completed).toBe(true);
    expect(await vcall(semaphore, "availablePermits", "()I")).toBe(0);
  });
});

describe("thread-enumeration", () => {
  class WaitingTask extends JObj { finish: (() => void) | null = null; }
  rt.register({ name: "test/EnumerationTask", ctor: WaitingTask, ifaces: ["java/lang/Runnable"], methods: {
    "run()V": function (this: WaitingTask) { return new Promise<void>(resolve => { this.finish = resolve; }); },
  } });
  rt.linkNatives();

  test("thread enumeration includes suspended live threads and removes completed threads", async () => {
    const cls = rt.link("java/lang/Thread").ctor;
    const count = await vcall(cls, "activeCount", "()I");
    const task = await newObj("test/EnumerationTask");
    const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", task);
    await vcall(thread, "start", "()V");
    await Bun.sleep(0);
    try {
      expect(curThread).toBe(mainThread);
      expect(await vcall(cls, "activeCount", "()I")).toBe(count + 1);
      const threads = jarray(new Array(count + 2).fill(null), "Ljava/lang/Thread;");
      expect(await vcall(cls, "enumerate", "([Ljava/lang/Thread;)I", threads)).toBe(count + 1);
      expect(threads).toContain(thread);
    } finally { task.finish?.(); }
    await vcall(thread, "join", "()V");
    expect(await vcall(cls, "activeCount", "()I")).toBe(count);
  });

  test("a suspended looper job releases ambient thread identity while preserving queue order", async () => {
    const thread = await newObj("java/lang/Thread"), looper = rt.make("android/os/Looper") as typeof mainLooper;
    looper.thread = thread;
    let started!: () => void, finish!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const events: string[] = [];
    const first = looper.run(() => {
      expect(curThread).toBe(thread); events.push("first"); started(); return held;
    });
    const second = looper.run(() => { expect(curThread).toBe(thread); events.push("second"); });
    await began;
    try {
      expect(curThread).toBe(mainThread);
      expect(events).toEqual(["first"]);
    } finally { finish(); }
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
    expect(curThread).toBe(mainThread);
  });
});

describe("thread-state", () => {
  rt.linkNatives();
  const state = async (thread: unknown) => vcall(await vcall(thread, "getState", "()Ljava/lang/Thread$State;"), "name", "()Ljava/lang/String;");

  test("Thread states distinguish new, runnable and terminated threads", async () => {
    const thread = await newObj("java/lang/Thread");
    expect(await state(thread)).toBe("NEW");
    expect(await state(mainThread)).toBe("RUNNABLE");
    await vcall(thread, "start", "()V");
    await vcall(thread, "join", "()V");
    expect(await state(thread)).toBe("TERMINATED");
    await expect(vcallAsync(thread, "start", "()V")).rejects.toBeDefined();
  });

  test("Thread states expose monitor contention, timed parking, wakeup and interruption", async () => {
    const thread = new JThread(); thread.alive = 1;
    const lock = {}, owner = new JThread(); owner.alive = 1;
    rt.monitors.enter(lock, owner);
    const entered = rt.monitors.enter(lock, thread);
    expect(await state(thread)).toBe("BLOCKED");
    rt.monitors.exit(lock, owner);
    await entered;
    rt.monitors.exit(lock, thread);
    let wake = () => {};
    const waiting = park(thread, (resume) => { wake = resume; return () => {}; });
    expect(await state(thread)).toBe("WAITING");
    wake(); await waiting;
    expect(await state(thread)).toBe("RUNNABLE");
    const timed = park(thread, () => () => {}, 10000);
    expect(await state(thread)).toBe("TIMED_WAITING");
    const interrupted = timed.then(() => false, () => true);
    await vcall(thread, "interrupt", "()V");
    expect(await interrupted).toBe(true);
    expect(await state(thread)).toBe("RUNNABLE");
  });
});

describe("timeunit-enum", () => {
  rt.linkNatives();
  const unit = rt.link("java/util/concurrent/TimeUnit").ctor;

  test("TimeUnit enum lookup preserves constant identity and returns independent arrays", async () => {
    const values = await vcall(unit, "values", "()[Ljava/util/concurrent/TimeUnit;");
    expect(values.length).toBe(7);
    const days = await vcall(unit, "valueOf", "(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;", "DAYS");
    expect(values[6]).toBe(days);
    expect(await vcall(days, "toHours", "(J)J", 2n)).toBe(48n);
    values[6] = null;
    expect((await vcall(unit, "values", "()[Ljava/util/concurrent/TimeUnit;"))[6]).toBe(days);
    for (const [name, exception] of [[null, "NullPointerException"], ["day", "IllegalArgumentException"]]) {
      const error = await vcallAsync(unit, "valueOf", "(Ljava/lang/String;)Ljava/util/concurrent/TimeUnit;", name).then(() => null, e => e);
      expect(rt.iof(error, `java/lang/${exception}`)).toBeTruthy();
    }
  });
});
