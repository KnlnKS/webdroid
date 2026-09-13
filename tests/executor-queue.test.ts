import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

class RecordingRunnable extends JObj { runs = 0; }
rt.register({
  name: "test/QueueRunnable", ctor: RecordingRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: RecordingRunnable) { this.runs++; } },
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
  const task = rt.make("test/QueueRunnable") as RecordingRunnable;
  const future = await vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", task);
  expect(await vcall(queue, "size", "()I")).toBe(1);
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
