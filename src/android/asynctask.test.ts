import { expect, test } from "bun:test";
import "../natives";
import { JObj } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { newObj, vcall, mainThread, curThread } from "../jvm/natives/jlang";
import { onMain, inMainJob } from "./mainloop";

const put = (o: JObj, method: string, desc: string, fn: (...args: unknown[]) => unknown) => Object.assign(o, { [mangleMethod(method, desc)]: fn });
const status = async (task: unknown) => vcall(await vcall(task, "getStatus", "()Landroid/os/AsyncTask$Status;"), "name", "()Ljava/lang/String;");
const flush = async () => { await Bun.sleep(10); await onMain(() => {}); };

test("AsyncTask dispatches to the supplied executor with main callbacks and background identity", async () => {
  const task = await newObj("android/os/AsyncTask"), events: string[] = [];
  let queued: unknown;
  const executor = put(new JObj(), "execute", "(Ljava/lang/Runnable;)V", (r: unknown) => { queued = r; });
  put(task, "onPreExecute", "()V", () => { expect(inMainJob()).toBe(true); expect(curThread).toBe(mainThread); events.push("pre"); });
  put(task, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", async () => {
    expect(curThread).not.toBe(mainThread); events.push("background");
    await vcall(task, "publishProgress", "([Ljava/lang/Object;)V", [1]);
    return "result";
  });
  put(task, "onProgressUpdate", "([Ljava/lang/Object;)V", () => { expect(inMainJob()).toBe(true); expect(curThread).toBe(mainThread); events.push("progress"); });
  put(task, "onPostExecute", "(Ljava/lang/Object;)V", (value: unknown) => { expect(inMainJob()).toBe(true); expect(curThread).toBe(mainThread); expect(value).toBe("result"); events.push("post"); });
  await onMain(() => vcall(task, "executeOnExecutor", "(Ljava/util/concurrent/Executor;[Ljava/lang/Object;)Landroid/os/AsyncTask;", executor, []));
  expect(events).toEqual(["pre"]);
  expect(await status(task)).toBe("RUNNING");
  const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", queued);
  await vcall(thread, "start", "()V"); await vcall(thread, "join", "()V"); await flush();
  expect(await vcall(task, "get", "()Ljava/lang/Object;")).toBe("result");
  expect(events).toEqual(["pre", "background", "progress", "post"]);
  expect(await status(task)).toBe("FINISHED");
  await expect(vcall(task, "execute", "([Ljava/lang/Object;)Landroid/os/AsyncTask;", [])).rejects.toBeDefined();
});

test("AsyncTask cancellation skips queued work and invokes only the overridable cancelled overload", async () => {
  const task = await newObj("android/os/AsyncTask"); let queued: unknown, calls = 0;
  const executor = put(new JObj(), "execute", "(Ljava/lang/Runnable;)V", (r: unknown) => { queued = r; });
  put(task, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", () => { throw Error("cancelled work ran"); });
  put(task, "onCancelled", "()V", () => { expect(inMainJob()).toBe(true); calls++; });
  await onMain(() => vcall(task, "executeOnExecutor", "(Ljava/util/concurrent/Executor;[Ljava/lang/Object;)Landroid/os/AsyncTask;", executor, []));
  expect(await vcall(task, "cancel", "(Z)Z", 0)).toBe(1);
  const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", queued);
  await vcall(thread, "start", "()V"); await vcall(thread, "join", "()V"); await flush();
  expect(calls).toBe(1);
  expect(await status(task)).toBe("FINISHED");
  await expect(vcall(task, "get", "()Ljava/lang/Object;")).rejects.toBeDefined();
});

test("AsyncTask's default executor serializes background tasks", async () => {
  const first = await newObj("android/os/AsyncTask"), second = await newObj("android/os/AsyncTask");
  const order: number[] = []; let release!: () => void;
  put(first, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", () => { order.push(1); return new Promise(resolve => { release = () => resolve(null); }); });
  put(second, "doInBackground", "([Ljava/lang/Object;)Ljava/lang/Object;", () => { order.push(2); return null; });
  await onMain(async () => {
    await vcall(first, "execute", "([Ljava/lang/Object;)Landroid/os/AsyncTask;", []);
    await vcall(second, "execute", "([Ljava/lang/Object;)Landroid/os/AsyncTask;", []);
  });
  await flush(); expect(order).toEqual([1]); release();
  await vcall(second, "get", "()Ljava/lang/Object;"); await flush();
  expect(order).toEqual([1, 2]);
});
