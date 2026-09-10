import { expect, test } from "bun:test";
import "../../natives";
import { rt } from "../runtime";
import { newObj, vcall } from "./jlang";
import { vfs } from "./jio";

test("read-only file mappings retain byte ranges and survive channel closure", async () => {
  const path = "/channel-map-test";
  vfs.write(path, Uint8Array.of(9, 1, 2, 3, 4, 8));
  const file = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "r");
  const channel = await vcall(file, "getChannel", "()Ljava/nio/channels/FileChannel;");
  expect(await vcall(file, "getChannel", "()Ljava/nio/channels/FileChannel;")).toBe(channel);
  expect(await vcall(channel, "size", "()J")).toBe(6n);
  const mode = rt.link("java/nio/channels/FileChannel$MapMode").ctor.s$READ_ONLY;
  const map = (start: bigint, size: bigint) => vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, start, size);
  const buffer = await map(1n, 4n);
  expect(await vcall(buffer, "getInt", "()I")).toBe(0x01020304);
  expect(await vcall(channel, "position", "()J")).toBe(0n);
  expect(await vcall(buffer, "isReadOnly", "()Z")).toBe(1);
  const readOnlyError = rt.link("java/nio/ReadOnlyBufferException").ctor;
  for (const name of ["duplicate", "asReadOnlyBuffer"]) {
    const view = await vcall(buffer, name, "()Ljava/nio/ByteBuffer;");
    await expect(vcall(view, "put", "(IB)Ljava/nio/ByteBuffer;", 0, 99)).rejects.toBeInstanceOf(readOnlyError);
  }
  await vcall(buffer, "rewind", "()Ljava/nio/Buffer;");
  rt.link("java/nio/IntBuffer");
  const ints = await vcall(buffer, "asIntBuffer", "()Ljava/nio/IntBuffer;");
  await expect(vcall(ints, "put", "(II)Ljava/nio/IntBuffer;", 0, 99)).rejects.toBeInstanceOf(readOnlyError);
  await expect(map(5n, 2n)).rejects.toBeDefined();
  await vcall(channel, "close", "()V");
  expect(await vcall(buffer, "getInt", "(I)I", 0)).toBe(0x01020304);
  await expect(map(0n, 1n)).rejects.toBeDefined();
  vfs.files.delete(path);
});
