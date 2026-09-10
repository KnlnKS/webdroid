import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { accountFuture } from "./accountfuture";
import { JThread, curThread, mainThread, newObj, setCurThread, vcall } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";

test("account futures link before immediate callback delivery and honor its handler", async () => {
  const callback = await newObj("android/accounts/AccountManagerCallback"), handler = await newObj("android/os/Handler");
  const thread = new JThread(), original = curThread;
  setCurThread(thread);
  const looper = await newObj("android/os/Looper"); setCurThread(original); handler.looper = looper;
  const received = Promise.withResolvers<void>();
  callback[mangleMethod("run", "(Landroid/accounts/AccountManagerFuture;)V")] = async (future: unknown) => {
    try {
      expect(curThread).toBe(thread);
      expect(await vcall(future, "getResult", "()Ljava/lang/Object;")).toBe("fixture"); received.resolve();
    } catch (error) { received.reject(error); }
  };
  const future = accountFuture(callback, handler, "fixture");
  expect(rt.iof(future, "android/accounts/AccountManagerFuture")).toBe(1);
  expect(await vcall(future, "isDone", "()Z")).toBe(1);
  await received.promise;
});

test("pending account futures reject main-thread waits without canceling the request", async () => {
  const f = accountFuture(null, null);
  try { await f.result(undefined, mainThread); throw new Error("main wait accepted"); }
  catch (error) { expect(rt.iof(error, "java/lang/IllegalStateException")).toBe(1); }
  expect(f.pending).toBe(true); f.finish({ kind: "result", value: 42 });
  expect(await f.result(undefined, mainThread)).toBe(42);
});

test("account future timeout and interruption cancel once and release pending work", async () => {
  for (const interrupt of [false, true]) {
    const f = accountFuture(null, null), thread = new JThread(); let releases = 0;
    f.cleanup = () => { releases++; };
    const waiting = f.result(interrupt ? undefined : 1, thread);
    if (interrupt) { thread.interrupted = 1; thread.wake?.(); }
    try { await waiting; throw new Error("wait completed"); }
    catch (error) { expect(rt.iof(error, "android/accounts/OperationCanceledException")).toBe(1); }
    expect(releases).toBe(1); expect(f.finish({ kind: "result", value: "late" })).toBe(0);
    expect(await vcall(f, "isCancelled", "()Z")).toBe(1); expect(thread.wake).toBeNull();
  }
});

test("an authenticator error wakes pending account future waiters", async () => {
  const f = accountFuture(null, null), error = rt.mkThrowable("java/io/IOException", "fixture");
  const waiting = f.result(undefined, new JThread()); f.finish({ kind: "error", error });
  await expect(waiting).rejects.toBe(error);
  expect(await vcall(f, "cancel", "(Z)Z", 1)).toBe(0);
});
