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

test("output channels share the stream cursor without requiring read permission", async () => {
  const path = "/channel-output-test";
  vfs.write(path, Uint8Array.of(9, 9, 9));
  const file = await newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", path);
  const channel = await vcall(file, "getChannel", "()Ljava/nio/channels/FileChannel;");
  expect(await vcall(channel, "size", "()J")).toBe(0n);
  await vcall(file, "write", "([B)V", Int8Array.of(1, 2, 3));
  expect(await vcall(channel, "position", "()J")).toBe(3n);
  expect(await vcall(channel, "size", "()J")).toBe(3n);
  await vcall(channel, "position", "(J)Ljava/nio/channels/FileChannel;", 1n);
  await vcall(file, "write", "(I)V", 7);
  expect(await vcall(channel, "position", "()J")).toBe(2n);
  await vcall(channel, "position", "(J)Ljava/nio/channels/FileChannel;", 5n);
  expect(await vcall(channel, "size", "()J")).toBe(3n);
  await vcall(file, "write", "(I)V", 8);
  const mode = rt.link("java/nio/channels/FileChannel$MapMode").ctor.s$READ_ONLY;
  await expect(vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 0n, 1n))
    .rejects.toBeInstanceOf(rt.link("java/nio/channels/NonReadableChannelException").ctor);
  await vcall(file, "close", "()V");
  expect(Array.from(vfs.read(path)!)).toEqual([1, 7, 3, 0, 0, 8]);
  const append = await newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", path, 1);
  const appendChannel = await vcall(append, "getChannel", "()Ljava/nio/channels/FileChannel;");
  expect(await vcall(appendChannel, "position", "()J")).toBe(6n);
  await vcall(appendChannel, "position", "(J)Ljava/nio/channels/FileChannel;", 0n);
  await vcall(append, "write", "(I)V", 9);
  expect(await vcall(appendChannel, "position", "()J")).toBe(7n);
  await vcall(append, "flush", "()V");
  await vcall(append, "flush", "()V");
  await vcall(appendChannel, "close", "()V");
  expect(Array.from(vfs.read(path)!)).toEqual([1, 7, 3, 0, 0, 8, 9]);
  vfs.files.delete(path);
});

test("file streams and their channels close together, including late channel access", async () => {
  const path = "/channel-close-test";
  vfs.write(path, Uint8Array.of(1));
  for (const kind of ["FileInputStream", "FileOutputStream", "RandomAccessFile"]) {
    for (const close of ["stream", "channel", "before-channel"]) {
      const file = await newObj("java/io/" + kind,
        kind === "RandomAccessFile" ? "(Ljava/lang/String;Ljava/lang/String;)V" : "(Ljava/lang/String;)V", path, "rw");
      if (close === "before-channel") await vcall(file, "close", "()V");
      const channel = await vcall(file, "getChannel", "()Ljava/nio/channels/FileChannel;");
      await vcall(close === "channel" ? channel : file, "close", "()V");
      expect(await vcall(channel, "isOpen", "()Z")).toBe(0);
      for (const method of ["size", "position"]) {
        await expect(vcall(channel, method, "()J")).rejects.toBeInstanceOf(rt.link("java/nio/channels/ClosedChannelException").ctor);
      }
      await expect(kind === "FileOutputStream" ? vcall(file, "write", "(I)V", 2) : vcall(file, "read", "()I"))
        .rejects.toBeInstanceOf(rt.link("java/io/IOException").ctor);
      await vcall(channel, "close", "()V");
    }
  }
  vfs.files.delete(path);
});
