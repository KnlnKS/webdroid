import { expect, test } from "bun:test";
import "../natives";
import { callSelf, JObj, rt } from "../jvm/runtime";
import { curThread, JThread, mainThread, newObj, setCurThread, vcall } from "../jvm/natives/jlang";
import { contextMethods } from "./context";
import { inMainJob, onMain } from "./mainloop";

class Runnable extends JObj { constructor(readonly run: () => void) { super(); } }
rt.register({ name: "webdroid/MainExecutorTestRunnable", ctor: Runnable, methods: {
  "run()V": function (this: Runnable) { this.run(); },
} });

test("Context main executor queues callbacks on the main thread after the active job", async () => {
  await rt.initClass(rt.link("android/os/HandlerExecutor"));
  await rt.initClass(rt.link("webdroid/MainExecutorTestRunnable"));
  const executor = callSelf(contextMethods, "getMainExecutor()Ljava/util/concurrent/Executor;", null);
  expect(callSelf(contextMethods, "getMainExecutor()Ljava/util/concurrent/Executor;", null)).toBe(executor);
  expect(rt.iof(executor, "java/util/concurrent/Executor")).toBe(1);
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
  const active = onMain(async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  const order: string[] = [];
  const previous = curThread;
  setCurThread(new JThread());
  try {
    await vcall(executor, "execute", "(Ljava/lang/Runnable;)V", new Runnable(() => {
      expect(curThread).toBe(mainThread);
      expect(inMainJob()).toBe(true);
      order.push("callback"); done.resolve();
    }));
    order.push("submitted");
    expect(order).toEqual(["submitted"]);
    gate.resolve();
    await active; await done.promise;
    expect(order).toEqual(["submitted", "callback"]);
  } finally { gate.resolve(); setCurThread(previous); }
});

test("HandlerExecutor rejects null handlers and tasks", async () => {
  await expect(newObj("android/os/HandlerExecutor", "(Landroid/os/Handler;)V", null)).rejects.toMatchObject({ msg: "handler" });
  const executor = callSelf(contextMethods, "getMainExecutor()Ljava/util/concurrent/Executor;", null);
  await expect(vcall(executor, "execute", "(Ljava/lang/Runnable;)V", null)).rejects.toMatchObject({ msg: "task" });
});
