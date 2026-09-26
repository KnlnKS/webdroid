import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { JBinder } from "../src/android/binder";

class Callback extends JObj { constructor(readonly binder: JBinder) { super(); } }
rt.register({ name: "test/RemoteCallback", ctor: Callback, ifaces: ["android/os/IInterface"], methods: {
  "asBinder()Landroid/os/IBinder;": function (this: Callback) { return this.binder; },
} });

rt.linkNatives();

test("RemoteCallbackList snapshots callbacks and cookies during broadcasts", async () => {
  const list = await newObj("android/os/RemoteCallbackList");
  const firstBinder = new JBinder();
  const first = new Callback(firstBinder), replacement = new Callback(firstBinder);
  const second = new Callback(new JBinder()), cookie = new JObj();
  expect(await vcall(list, "register", "(Landroid/os/IInterface;)Z", first)).toBe(1);
  expect(await vcall(list, "register", "(Landroid/os/IInterface;Ljava/lang/Object;)Z", second, cookie)).toBe(1);
  expect(await vcall(list, "register", "(Landroid/os/IInterface;)Z", replacement)).toBe(1);

  expect(await vcall(list, "beginBroadcast", "()I")).toBe(2);
  expect(await vcall(list, "getBroadcastItem", "(I)Landroid/os/IInterface;", 0)).toBe(replacement);
  expect(await vcall(list, "getBroadcastItem", "(I)Landroid/os/IInterface;", 1)).toBe(second);
  expect(await vcall(list, "getBroadcastCookie", "(I)Ljava/lang/Object;", 1)).toBe(cookie);
  await vcall(list, "finishBroadcast", "()V");

  expect(await vcall(list, "unregister", "(Landroid/os/IInterface;)Z", first)).toBe(1);
  expect(await vcall(list, "getRegisteredCallbackCount", "()I")).toBe(1);
});

test("RemoteCallbackList rejects null callbacks", async () => {
  const list = await newObj("android/os/RemoteCallbackList");
  await expect(vcallAsync(list, "register", "(Landroid/os/IInterface;)Z", null)).rejects.toMatchObject({
    constructor: { $i: { name: "java/lang/NullPointerException" } },
  });
});
