import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("KeyEvent survives a Parcelable round trip", async () => {
  const event = await newObj("android/view/KeyEvent", "(II)V", 1, 87);
  const parcel = await newObj("android/os/Parcel", "()V");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", event, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(restored).not.toBe(event);
  expect(await vcall(restored, "getAction", "()I")).toBe(1);
  expect(await vcall(restored, "getKeyCode", "()I")).toBe(87);
});
