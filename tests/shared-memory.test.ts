import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("shared memory maps and parcels its protected bytes", async () => {
  const type = rt.link("android/os/SharedMemory").ctor;
  const shared = await vcall(type, "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "sample", 3);
  const writable = await vcall(shared, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
  await vcall(writable, "put", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(3, 5, 7));
  await vcall(type, "unmap", "(Ljava/nio/ByteBuffer;)V", writable);
  expect(await vcall(shared, "setProtect", "(I)Z", 1)).toBe(1);
  expect(await vcall(shared, "setProtect", "(I)Z", 3)).toBe(0);
  const parcel = await newObj("android/os/Parcel", "()V");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", shared, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  const readOnly = await vcall(restored, "mapReadOnly", "()Ljava/nio/ByteBuffer;");
  const result = new Int8Array(3);
  await vcall(readOnly, "get", "([B)Ljava/nio/ByteBuffer;", result);
  expect([...result]).toEqual([3, 5, 7]);
  expect(await vcall(readOnly, "isReadOnly", "()Z")).toBe(1);
  await vcall(type, "unmap", "(Ljava/nio/ByteBuffer;)V", readOnly);
});
