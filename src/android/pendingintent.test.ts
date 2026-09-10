import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { JParcel } from "./parcel";
import { exportParcel, importParcel } from "./binder";
import { JContext } from "./context";
import { JIntent } from "./intent";
import { registerReceiver, unregisterReceiver } from "./broadcast";
import { onMain } from "./mainloop";
import { mangleMethod } from "../jvm/abi";

test("PendingIntent Parcel retains Binder identity and shared cancellation", async () => {
  const original = await vcall(rt.link("android/app/PendingIntent").ctor, "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", new JContext(), 17, new JIntent(), 0x4000000);
  const parcel = await newObj("android/os/Parcel") as JParcel;
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", original, 0);
  const wire = exportParcel(parcel);
  expect(wire.objects).toHaveLength(1);
  const copy = await vcall(importParcel(wire), "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", original)).toBe(1);
  await vcall(copy, "cancel", "()V");
  try { await vcall(original, "send", "()V"); throw new Error("expected cancellation"); }
  catch (error) { expect(rt.iof(error, "android/app/PendingIntent$CanceledException")).toBe(1); }
});

test("PendingIntent identity ignores extras and supports update, cancellation and one-shot retrieval", async () => {
  const context = new JContext(), intent = new JIntent(); intent.action = "test.PENDING_IDENTITY";
  intent.categories.add("b"); intent.categories.add("a"); intent.extras.map.set("value", 1);
  const get = (flags: number, code = 23) => vcall(rt.link("android/app/PendingIntent").ctor, "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, code, intent, flags);
  expect(await get(0x24000000)).toBeNull();
  const original = await get(0x4000000);
  intent.extras.map.set("value", 2); intent.categories = new Set(["a", "b"]);
  const same = await get(0x24000000);
  expect(await vcall(same, "equals", "(Ljava/lang/Object;)Z", original)).toBe(1);
  expect(await vcall(same, "hashCode", "()I")).toBe(await vcall(original, "hashCode", "()I"));
  const received: unknown[] = [], receiver = await newObj("android/content/BroadcastReceiver");
  receiver[mangleMethod("onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V")] = (_context: JContext, sent: JIntent) => { received.push(sent.extras.map.get("value")); };
  registerReceiver(context, receiver, { actions: [intent.action] });
  try {
    await vcall(original, "send", "()V"); await onMain(() => {});
    await get(0xc000000);
    await vcall(original, "send", "()V"); await onMain(() => {});
    expect(received).toEqual([1, 2]);
  } finally { unregisterReceiver(receiver); }
  const replacement = await get(0x14000000);
  expect(await vcall(replacement, "equals", "(Ljava/lang/Object;)Z", original)).toBe(0);
  await expect(vcall(original, "send", "()V")).rejects.toMatchObject({ msg: null });
  await vcall(replacement, "cancel", "()V");
  expect(await get(0x24000000)).toBeNull();
  const once = await get(0x44000000, 24);
  await vcall(once, "send", "()V");
  expect(await get(0x64000000, 24)).toBeNull();
  await expect(vcall(once, "send", "()V")).rejects.toMatchObject({ msg: null });
});
