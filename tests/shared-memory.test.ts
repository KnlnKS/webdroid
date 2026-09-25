import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("SharedMemory maps the same bytes and parcels its protected contents", async () => {
  const memory = await vcall(rt.link("android/os/SharedMemory").ctor, "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "data", 3);
  const writable = await vcall(memory, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
  await vcall(writable, "put", "([B)Ljava/nio/ByteBuffer;", Int8Array.from([4, 5, 6]));
  await vcall(rt.link("android/os/SharedMemory").ctor, "unmap", "(Ljava/nio/ByteBuffer;)V", writable);
  expect(await vcall(memory, "setProtect", "(I)Z", 1)).toBe(1);
  expect(await vcall(memory, "setProtect", "(I)Z", 3)).toBe(0);

  const parcel = await newObj("android/os/Parcel", "()V");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", memory, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  const readonly = await vcall(restored, "mapReadOnly", "()Ljava/nio/ByteBuffer;");
  const bytes = new Int8Array(3);
  await vcall(readonly, "get", "([B)Ljava/nio/ByteBuffer;", bytes);
  expect([...bytes]).toEqual([4, 5, 6]);
  expect(await vcall(readonly, "isReadOnly", "()Z")).toBe(1);
});
