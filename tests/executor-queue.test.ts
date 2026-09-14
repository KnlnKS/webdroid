import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

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

test("a native pool submit queues before returning its future", async () => {
  const queue = await newObj("java/util/concurrent/LinkedBlockingQueue");
  const ex = await pool(queue);
  const task = rt.make("test/QueueRunnable");
  const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", task, "result");
  expect(await vcall(queue, "size", "()I")).toBe(1);
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

test("ForkJoinPool executes tasks and exposes their result", async () => {
  rt.register({
    name: "test/ConstTask", ctor: class extends (rt.link("java/util/concurrent/RecursiveTask").ctor as typeof JObj) {},
    sup: "java/util/concurrent/RecursiveTask", methods: { "compute()Ljava/lang/Object;": () => "done" },
  });
  const pool = await newObj("java/util/concurrent/ForkJoinPool", "(I)V", 2);
  const task = rt.make("test/ConstTask");
  expect(await vcall(pool, "invoke", "(Ljava/util/concurrent/ForkJoinTask;)Ljava/lang/Object;", task)).toBe("done");
  expect(await vcall(task, "getRawResult", "()Ljava/lang/Object;")).toBe("done");
  const submitted = await vcall(pool, "submit", "(Ljava/util/concurrent/ForkJoinTask;)Ljava/util/concurrent/ForkJoinTask;", rt.make("test/ConstTask"));
  expect(await vcall(submitted, "join", "()Ljava/lang/Object;")).toBe("done");
  const common = await vcall(rt.link("java/util/concurrent/ForkJoinPool").ctor, "commonPool", "()Ljava/util/concurrent/ForkJoinPool;");
  expect(common).toBe(await vcall(rt.link("java/util/concurrent/ForkJoinPool").ctor, "commonPool", "()Ljava/util/concurrent/ForkJoinPool;"));
});

test("submit(Runnable, result) completes with the supplied result", async () => {
  const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
  const task = new RecordingRunnable();
  const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", task, "done");
  expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("done");
  expect(task.runs).toBe(1);
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
