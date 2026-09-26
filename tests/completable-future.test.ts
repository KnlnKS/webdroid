import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { curThread, mainThread, newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

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
