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
