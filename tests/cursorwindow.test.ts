import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("CursorWindow preserves absolute rows and typed fields through a parcel", async () => {
  const window = await newObj("android/database/CursorWindow", "(Ljava/lang/String;)V", "results");
  expect(await vcall(window, "setNumColumns", "(I)Z", 3)).toBe(1);
  await vcall(window, "setStartPosition", "(I)V", 8);
  expect(await vcall(window, "allocRow", "()Z")).toBe(1);
  expect(await vcall(window, "putLong", "(JII)Z", 9007199254740993n, 8, 0)).toBe(1);
  expect(await vcall(window, "putString", "(Ljava/lang/String;II)Z", "hello", 8, 1)).toBe(1);
  expect(await vcall(window, "putBlob", "([BII)Z", new Int8Array([1, -1]), 8, 2)).toBe(1);

  const parcel = rt.make("android/os/Parcel");
  await vcall(window, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await vcall(rt.link("android/database/CursorWindow").ctor, "newFromParcel", "(Landroid/os/Parcel;)Landroid/database/CursorWindow;", parcel);
  expect(await vcall(restored, "getStartPosition", "()I")).toBe(8);
  expect(await vcall(restored, "getLong", "(II)J", 8, 0)).toBe(9007199254740993n);
  expect(await vcall(restored, "getString", "(II)Ljava/lang/String;", 8, 1)).toBe("hello");
  expect(Array.from(await vcall(restored, "getBlob", "(II)[B", 8, 2) as Int8Array)).toEqual([1, -1]);
  expect(await vcall(restored, "putNull", "(II)Z", 8, 1)).toBe(0);
});
