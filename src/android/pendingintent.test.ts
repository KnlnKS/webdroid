import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { JParcel } from "./parcel";
import { exportParcel, importParcel } from "./binder";
import { JContext } from "./context";
import { JIntent } from "./intent";

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
