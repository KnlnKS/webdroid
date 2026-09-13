import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { curThread, JThread, newObj, setCurThread, vcall } from "../src/jvm/natives/jlang";
import { JBinder, binderTransport, importBinder } from "../src/android/binder";

class Callback extends JObj { binder: unknown = null; }
rt.register({ name: "test/TwitchRemoteCallback", ctor: Callback, ifaces: ["android/os/IInterface"], methods: {
  "asBinder()Landroid/os/IBinder;": function (this: Callback) { return this.binder; },
} });
rt.linkNatives();
function callback(binder: unknown = new JBinder()) {
  const result = new Callback(); result.binder = binder; return result;
}
const register = (list: unknown, cb: unknown, cookie: unknown = null) => vcall(list, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", cb, cookie);
const unregister = (list: unknown, cb: unknown) => vcall(list, "unregister", "(Landroid/os/IInterface;)Z", cb);
const count = (list: unknown) => vcall(list, "getRegisteredCallbackCount", "()I");

test("RemoteCallbackList keys registrations by Binder and broadcasts a stable snapshot", async () => {
  const list = await newObj("android/os/RemoteCallbackList"), first = callback(), replacement = callback(first.binder);
  expect(await register(list, first, "old")).toBe(1);
  expect(await register(list, replacement, "new")).toBe(1);
  expect(await count(list)).toBe(1);
  expect(await vcall(list, "beginBroadcast", "()I")).toBe(1);
  expect(await unregister(list, first)).toBe(1);
  expect(await register(list, callback())).toBe(1);
  expect(await vcall(list, "getBroadcastItem", "(I)Landroid/os/IInterface;", 0)).toBe(replacement);
  expect(await vcall(list, "getBroadcastCookie", "(I)Ljava/lang/Object;", 0)).toBe("new");
  await expect(vcall(list, "beginBroadcast", "()I")).rejects.toBeDefined();
  await vcall(list, "finishBroadcast", "()V");
  await expect(vcall(list, "finishBroadcast", "()V")).rejects.toBeDefined();
  await vcall(list, "kill", "()V");
  expect(await count(list)).toBe(0);
  expect(await register(list, first)).toBe(0);
  expect(await vcall(list, "beginBroadcast", "()I")).toBe(0);
  await vcall(list, "finishBroadcast", "()V");
});

test("RemoteCallbackList removes dead remote Binders and unlinks replacement registrations", async () => {
  const saved = { ...binderTransport }, watches = new Set<() => void>();
  let alive = true;
  binderTransport.alive = () => alive;
  binderTransport.watch = (_pid, died) => { watches.add(died); return () => { watches.delete(died); }; };
  try {
    const list = await newObj("android/os/RemoteCallbackList"), cb = callback(importBinder({ pid: 987654, id: 1 }));
    expect(await register(list, cb)).toBe(1);
    expect(await register(list, cb)).toBe(1);
    expect(watches.size).toBe(1);
    const previousThread = curThread;
    setCurThread(new JThread()); const first = register(list, cb);
    setCurThread(new JThread()); const second = register(list, cb);
    setCurThread(previousThread);
    await Promise.all([first, second]);
    expect(watches.size).toBe(1);
    alive = false;
    for (const died of watches) died();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await count(list)).toBe(0);
    expect(await register(list, cb)).toBe(0);
  } finally { Object.assign(binderTransport, saved); }
});
