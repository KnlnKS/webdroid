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
  name: "test/BlockingRunnable", ctor: BlockingRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: BlockingRunnable) { return this.promise; } },
});
// the shape of an app's own BlockingQueue: implements the interface, carries no native storage
rt.register({ name: "test/AppQueue", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/BlockingQueue"] });
rt.register({
  name: "test/ValueSupplier", ctor: ValueSupplier, ifaces: ["java/util/function/Supplier"],
  methods: { "get()Ljava/lang/Object;": function (this: ValueSupplier) { return this.value; } },
});
rt.linkNatives();

const seconds = () => (rt.link("java/util/concurrent/TimeUnit").ctor as any).s$SECONDS;
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
  const blocker = rt.make("test/BlockingRunnable") as BlockingRunnable;
  const blocked = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", blocker);
  await Promise.resolve();
  const task = rt.make("test/QueueRunnable") as RecordingRunnable;
  const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", task);
  expect(await vcall(queue, "size", "()I")).toBe(1);
  blocker.release();
  await vcall(blocked, "get", "()Ljava/lang/Object;");
  await vcall(future, "get", "()Ljava/lang/Object;");
  expect(await vcall(queue, "size", "()I")).toBe(0);
  expect(task.runs).toBe(1);
});

test("submit(Runnable, result) completes with the supplied result", async () => {
  const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
  const task = rt.make("test/QueueRunnable") as RecordingRunnable;
  const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;Ljava/lang/Object;)Ljava/util/concurrent/Future;", task, "done");
  expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("done");
  expect(task.runs).toBe(1);
});

test("CompletableFuture supplyAsync runs on the supplied executor", async () => {
  const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
  const supplier = rt.make("test/ValueSupplier");
  const future = await vcall(rt.link("java/util/concurrent/CompletableFuture").ctor, "supplyAsync",
    "(Ljava/util/function/Supplier;Ljava/util/concurrent/Executor;)Ljava/util/concurrent/CompletableFuture;", supplier, ex);
  expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("supplied");
});

test("executor work is eligible at the next cooperative turn", async () => {
  const ex = await pool(await newObj("java/util/concurrent/LinkedBlockingQueue"));
  const task = rt.make("test/QueueRunnable") as RecordingRunnable;
  await vcall(ex, "execute", "(Ljava/lang/Runnable;)V", task);
  await Promise.resolve();
  await Promise.resolve();
  expect(task.runs).toBe(1);
});
