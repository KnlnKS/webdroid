import { expect, test } from "bun:test";
import { rt, JObj } from "./runtime";
import { mkExecutor } from "./natives/jconc";
import { curThread, mainThread, vcall, type JThread } from "./natives/jlang";

class Task extends JObj { body: () => unknown = () => null; }
rt.register({ name: "test/ExecutorTask", ctor: Task, ifaces: ["java/lang/Runnable", "java/util/concurrent/Callable"], methods: {
  "run()V": async function (this: Task) { await this.body(); },
  "call()Ljava/lang/Object;": async function (this: Task) { return this.body(); },
} });
rt.link("test/ExecutorTask");
const task = (body: () => unknown) => { const t = new Task(); t.body = body; return t; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const submit = (executor: unknown, body: () => unknown) => vcall(executor, "submit", "(Ljava/util/concurrent/Callable;)Ljava/util/concurrent/Future;", task(body));
const get = (future: unknown) => vcall(future, "get", "()Ljava/lang/Object;");

test("unconfigurable scheduled executors retain scheduling and shutdown semantics", async () => {
  const delegate = mkExecutor(), unit = new (rt.link("java/util/concurrent/TimeUnit").ctor)();
  const wrapper = await vcall(rt.link("java/util/concurrent/Executors").ctor, "unconfigurableScheduledExecutorService", "(Ljava/util/concurrent/ScheduledExecutorService;)Ljava/util/concurrent/ScheduledExecutorService;", delegate);
  expect(wrapper).not.toBe(delegate);
  expect(rt.iof(wrapper, "java/util/concurrent/ScheduledExecutorService")).toBe(1);
  expect(rt.iof(wrapper, "java/util/concurrent/ThreadPoolExecutor")).toBe(0);
  const result = await vcall(wrapper, "schedule", "(Ljava/util/concurrent/Callable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;", task(() => "scheduled"), 1n, unit);
  expect(await get(result)).toBe("scheduled");
  await vcall(wrapper, "shutdown", "()V");
  expect(await vcall(delegate, "isShutdown", "()Z")).toBe(1);
  await expect(submit(wrapper, () => null)).rejects.toMatchObject({ msg: "executor shut down" });
});

test("single executor serializes suspended work on one reusable worker", async () => {
  const executor = mkExecutor(), starts: JThread[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = await submit(executor, async () => { starts.push(curThread); await blocked; return "first"; });
  const second = await submit(executor, () => { starts.push(curThread); return "second"; });
  await tick();
  expect(starts.length).toBe(1);
  expect(starts[0]).not.toBe(mainThread);
  const queue = await vcall(executor, "getQueue", "()Ljava/util/concurrent/BlockingQueue;");
  expect(await vcall(queue, "size", "()I")).toBe(1);
  release();
  expect(await get(first)).toBe("first");
  expect(await get(second)).toBe("second");
  expect(starts[1]).toBe(starts[0]);
  expect(await vcall(queue, "size", "()I")).toBe(0);
  await vcall(executor, "shutdown", "()V");
  await expect(submit(executor, () => null)).rejects.toMatchObject({ msg: "executor shut down" });
});

test("fixed pools bound concurrency and give concurrent workers distinct Java identities", async () => {
  const executor = await vcall(rt.link("java/util/concurrent/Executors").ctor, "newFixedThreadPool", "(I)Ljava/util/concurrent/ExecutorService;", 2);
  const starts: JThread[] = [], release: (() => void)[] = [];
  const futures = await Promise.all(Array.from({ length: 3 }, () => submit(executor, () => {
    starts.push(curThread);
    return new Promise<void>((resolve) => release.push(resolve));
  })));
  await tick();
  expect(starts.length).toBe(2);
  expect(new Set(starts).size).toBe(2);
  release[0](); await tick();
  expect(starts.length).toBe(3);
  expect(starts[2]).toBe(starts[0]);
  release[1](); release[2]();
  await Promise.all(futures.map(get));
  await vcall(executor, "shutdown", "()V");
});

test("queued cancellation skips work, keeps outcomes, and does not poison the next worker job", async () => {
  const executor = mkExecutor(); let ran = false, release!: () => void;
  const first = await submit(executor, () => { curThread.interrupted = 1; return new Promise<void>((resolve) => { release = resolve; }); });
  const cancelled = await submit(executor, () => { ran = true; });
  await tick();
  expect(await vcall(cancelled, "cancel", "(Z)Z", 0)).toBe(1);
  expect(await vcall(cancelled, "isDone", "()Z")).toBe(1);
  await expect(get(cancelled)).rejects.toMatchObject({ msg: null });
  release(); await get(first);
  const next = await submit(executor, () => curThread.interrupted);
  expect(await get(next)).toBe(0);
  expect(ran).toBe(false);
  const failed = await submit(executor, () => { throw rt.mkThrowable("java/lang/IllegalStateException", "task failed"); });
  await expect(get(failed)).rejects.toMatchObject({ cause: { msg: "task failed" } });
  await vcall(executor, "shutdown", "()V");
});

test("periodic work never overlaps itself and shutdownNow cancels delayed tasks", async () => {
  const executor = mkExecutor(2), unit = new (rt.link("java/util/concurrent/TimeUnit").ctor)();
  let starts = 0, active = 0, peak = 0;
  const periodic = await vcall(executor, "scheduleAtFixedRate", "(Ljava/lang/Runnable;JJLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;", task(async () => {
    starts++; active++; peak = Math.max(peak, active); await tick(); active--;
  }), 0n, 1n, unit);
  await tick(); await tick(); await tick();
  await vcall(periodic, "cancel", "(Z)Z", 0);
  await tick();
  expect(starts).toBeGreaterThan(0);
  expect(peak).toBe(1);
  let delayedRan = false;
  const delayed = await vcall(executor, "schedule", "(Ljava/lang/Runnable;JLjava/util/concurrent/TimeUnit;)Ljava/util/concurrent/ScheduledFuture;", task(() => { delayedRan = true; }), 1000n, unit);
  const abandoned = await vcall(executor, "shutdownNow", "()Ljava/util/List;");
  expect(await vcall(abandoned, "size", "()I")).toBe(1);
  await expect(get(delayed)).rejects.toMatchObject({ msg: null });
  expect(delayedRan).toBe(false);
});
