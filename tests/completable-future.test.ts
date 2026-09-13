import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { curThread, mainThread, newObj, vcall } from "../src/jvm/natives/jlang";

class Supplier extends JObj { runs = 0; error: unknown = null; thread = mainThread; }
class Executor extends JObj { tasks: unknown[] = []; }
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
    const error = await vcall(future, method, "()Ljava/lang/Object;").then(() => null, e => e);
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
  const error = await vcall(future, "getNow", "(Ljava/lang/Object;)Ljava/lang/Object;", "fallback").then(() => null, e => e);
  expect(rt.iof(error, "java/util/concurrent/CancellationException")).toBeTruthy();
  const incomplete = await newObj("java/util/concurrent/CompletableFuture");
  expect(await vcall(incomplete, "getNow", "(Ljava/lang/Object;)Ljava/lang/Object;", "fallback")).toBe("fallback");
});
