import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

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
  await expect(vcall(ex, "submit", "(Ljava/lang/Runnable;)Ljava/util/concurrent/Future;", null)).rejects.toBeDefined();
  expect(ex.tasks.length).toBe(3);
});
test("cancelling FutureTask before execution wakes get and prevents its runnable", async () => {
  const task = await newObj("test/FactoryTask");
  const f = await newObj("java/util/concurrent/FutureTask", "(Ljava/lang/Runnable;Ljava/lang/Object;)V", task, "unused");
  expect(await vcall(f, "cancel", "(Z)Z", 0)).toBe(1);
  await vcall(f, "run", "()V");
  expect(task.runs).toBe(0);
  expect(await vcall(f, "isCancelled", "()Z")).toBe(1);
  await expect(vcall(f, "get", "()Ljava/lang/Object;")).rejects.toMatchObject({ constructor: rt.link("java/util/concurrent/CancellationException").ctor });
});
