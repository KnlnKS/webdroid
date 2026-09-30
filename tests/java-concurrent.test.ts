import { expect, test, describe } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync, curThread, mainThread, JThread, park } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
import { jarray } from "../src/jvm/abi";
import { mainLooper } from "../src/android/os";

describe("blocking-queue-drain", () => {
  rt.linkNatives();

  test("bounded queues reject overflow and wake blocked producers after removal", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue", "(I)V", 1);
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
  });

  test("LinkedBlockingQueue drains a bounded prefix and then the remaining elements", async () => {
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue", "(I)V", 8);
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
    const queue = await newObj("java/util/concurrent/LinkedBlockingQueue", "(I)V", 8);
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

describe("runnable-future-interface", () => {
  rt.linkNatives();

  test("RunnableFuture exposes both parent interfaces to application implementations", () => {
    rt.register({ name: "test/RunnableFutureImpl", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/RunnableFuture"] });
    const task = rt.make("test/RunnableFutureImpl");
    expect(rt.iof(task, "java/lang/Runnable")).toBe(1);
    expect(rt.iof(task, "java/util/concurrent/Future")).toBe(1);
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

