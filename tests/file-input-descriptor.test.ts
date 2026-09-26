import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mainThread, newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { JFileDescriptor, vfs } from "../src/jvm/natives/jio";
import { Cpu, setA64 } from "../src/native/cpu";
import { lookupHost } from "../src/native/host";
import { mem } from "../src/native/mem";
import { javaCloseFd, javaOpenFd, javaSeekFd, javaReadFd, renamePath, stdioInit } from "../src/native/stdio";

rt.linkNatives();
async function rejectsJava(value: Promise<unknown>, name: string) {
  const error = await value.then(() => null, error => error);
  expect(rt.iof(error, name)).toBe(1);
}

test("descriptor streams share native offsets and borrow ownership across rename and unlink", async () => {
  const path = "/input-descriptor", renamed = path + "-renamed";
  vfs.write(path, Uint8Array.of(1, 2, 3, 4));
  const owner = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", path);
  const fd = await vcall(owner, "getFD", "()Ljava/io/FileDescriptor;");
  const borrowed = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
  try {
    expect(await vcall(owner, "getFD", "()Ljava/io/FileDescriptor;")).toBe(fd);
    expect(renamePath(null, path, renamed)).toBe(0);
    vfs.delete(renamed);
    expect(await vcall(borrowed, "read", "()I")).toBe(1);
    const byte = new Uint8Array(1);
    expect(await javaReadFd(fd.fd, byte)).toBe(1);
    expect(byte[0]).toBe(2);
    const channel = await vcall(owner, "getChannel", "()Ljava/nio/channels/FileChannel;");
    expect(await vcall(channel, "position", "()J")).toBe(2n);
    expect(await vcall(channel, "size", "()J")).toBe(4n);
    const mode = rt.link("java/nio/channels/FileChannel$MapMode").ctor.s$READ_ONLY;
    const mapped = await vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 1n, 2n);
    expect(await vcall(mapped, "get", "(I)B", 1)).toBe(3);
    expect(await vcall(channel, "position", "()J")).toBe(2n);
    expect(await vcall(borrowed, "skip", "(J)J", -1n)).toBe(-1n);
    expect(await vcall(owner, "available", "()I")).toBe(3);
    const dst = new Int8Array(5);
    expect(await vcall(owner, "read", "([BII)I", dst, 1, 3)).toBe(3);
    expect([...dst]).toEqual([0, 2, 3, 4, 0]);
    expect(await vcall(owner, "read", "()I")).toBe(-1);
    await vcall(borrowed, "close", "()V");
    expect(javaSeekFd(fd.fd, 0, 0)).toBe(0);
    expect(await vcall(owner, "read", "()I")).toBe(1);
    await rejectsJava(vcallAsync(borrowed, "read", "()I"), "java/io/IOException");
    await vcall(channel, "close", "()V");
    expect(fd.fd).toBe(-1);
    expect(await vcall(channel, "isOpen", "()Z")).toBe(0);
  } finally { await vcall(owner, "close", "()V"); vfs.delete(path); vfs.delete(renamed); }
});

test("descriptor streams serialize lazy reads and reject invalid input", async () => {
  const path = "/input-descriptor-lazy", bytes = Uint8Array.of(5, 6, 7, 8);
  vfs.lazyFiles.set(path, { size: 4, read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, 2)) });
  const fd = new JFileDescriptor(); fd.fd = javaOpenFd(path, 0);
  const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
  try {
    const a = new Int8Array(3), b = new Int8Array(3);
    expect(await Promise.all([vcall(input, "read", "([B)I", a), vcall(input, "read", "([B)I", b)])).toEqual([2, 2]);
    expect([...a, ...b]).toEqual([5, 6, 0, 7, 8, 0]);
    expect(await vcall(input, "read", "([BII)I", a, 3, 0)).toBe(0);
    expect(await vcall(input, "markSupported", "()Z")).toBe(0);
    for (const [method, desc, args, error] of [
      ["read", "([BII)I", [a, -1, 1], "java/lang/IndexOutOfBoundsException"], ["read", "([BII)I", [a, 2, 2], "java/lang/IndexOutOfBoundsException"],
      ["read", "([B)I", [null], "java/lang/NullPointerException"], ["reset", "()V", [], "java/io/IOException"],
    ] satisfies [string, string, unknown[], string][]) {
      await rejectsJava(vcallAsync(input, method, desc, ...args), error);
    }
    javaCloseFd(fd.fd);
    await rejectsJava(vcallAsync(input, "read", "()I"), "java/io/IOException");
    await rejectsJava(vcallAsync(input, "available", "()I"), "java/io/IOException");
  } finally { javaCloseFd(fd.fd); await vcall(input, "close", "()V"); vfs.delete(path); }
});

test("descriptor streams wait for pipe bytes without closing borrowed descriptors", async () => {
  setA64(true); stdioInit();
  const cpu = new Cpu(mainThread, "input-descriptor-pipe"), buffer = mem.malloc(16);
  const call = (name: string, ...args: number[]) => {
    const fn = lookupHost(name, "libc.so");
    if (fn === undefined) throw new Error(name);
    return cpu.call(fn, args);
  };
  expect(await call("pipe", buffer)).toBe(0);
  const fd = new JFileDescriptor(); fd.fd = mem.ld32(buffer);
  const writer = mem.ld32(buffer + 4);
  const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
  try {
    const bytes = new Int8Array(2), pending = vcall(input, "read", "([B)I", bytes);
    mem.write(buffer + 8, Uint8Array.of(9, 10));
    expect(await call("write", writer, buffer + 8, 2)).toBe(2);
    expect(await pending).toBe(2);
    expect([...bytes]).toEqual([9, 10]);
    javaCloseFd(writer);
    expect(await vcall(input, "read", "()I")).toBe(-1);
    await vcall(input, "close", "()V");
    expect(await javaReadFd(fd.fd, new Uint8Array(1))).toBe(0);
  } finally { javaCloseFd(fd.fd); javaCloseFd(writer); mem.free(buffer); cpu.dispose(); }
});

test("descriptor constructors defer invalid descriptor failures and honor explicit ownership", async () => {
  await rejectsJava(newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", null), "java/lang/NullPointerException");
  const fd = new JFileDescriptor();
  const invalid = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
  await rejectsJava(vcallAsync(invalid, "read", "()I"), "java/io/IOException");
  await vcall(invalid, "close", "()V");
  const path = "/input-descriptor-owner";
  vfs.write(path, Uint8Array.of(1));
  fd.fd = javaOpenFd(path, 0);
  const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;Z)V", fd, 1);
  await vcall(input, "close", "()V");
  expect(fd.fd).toBe(-1);
  vfs.delete(path);
});
