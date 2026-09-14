import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { curThread, JThread, mainThread, newObj, vcall, vcallOn } from "../src/jvm/natives/jlang";

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
    if (fail) await expect(vcall(future, "get", "()Ljava/lang/Object;")).rejects.toMatchObject({ cause: { msg: "failed" } });
    else expect(await vcall(future, "get", "()Ljava/lang/Object;")).toBe("completed");
  }
});
