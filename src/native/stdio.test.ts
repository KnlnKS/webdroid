import { expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { mem } from "./mem";
import { fdWriteBack, javaCloseFd, javaOpenFd, javaFdBytes, javaSeekFd, javaDupFd, renamePath, stdioInit } from "./stdio";

test("record-lock queries report no conflicting process lock through the guest pointer", async () => {
  setA64(true);
  stdioInit();
  const cpu = new Cpu(mainThread, "fcntl-test");
  const path = "/fcntl-test";
  vfs.write(path, new Uint8Array(0));
  const fd = javaOpenFd(path, 2);
  const lock = mem.hostAlloc(32);
  const fcntl = lookupHost("fcntl", "libc.so");
  if (fcntl === undefined) throw new Error("fcntl was not registered");
  try {
    for (const cmd of [5, 12]) {
      mem.memset(lock, 0, 32);
      mem.st16(lock, 1);
      mem.st64(lock + 8, 128n);
      mem.st64(lock + 16, 1n);
      expect(await cpu.call(fcntl, [fd, cmd, lock])).toBe(0);
      expect(mem.ld16u(lock)).toBe(2);
      expect(mem.ld64(lock + 8)).toBe(128n);
      expect(mem.ld64(lock + 16)).toBe(1n);
    }
  } finally { javaCloseFd(fd); vfs.delete(path); cpu.dispose(); }
});

test("independent file opens share writes, growth and truncation without sharing position", async () => {
  setA64(true); stdioInit();
  const cpu = new Cpu(mainThread, "shared-file-test"), path = "/shared-file-test";
  vfs.write(path, Uint8Array.of(1, 2));
  const writer = javaOpenFd(path, 2), reader = javaOpenFd(path, 0), buf = mem.hostAlloc(8192);
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  try {
    mem.st8(buf, 7);
    expect(await call("pwrite", writer, buf, 1, 5000)).toBe(1);
    expect(await call("pread", reader, buf, 2, 4999)).toBe(2);
    expect([...mem.bytes(buf, 2)]).toEqual([0, 7]);
    expect(vfs.read(path)?.length).toBe(5001);
    expect(await call("read", reader, buf, 1)).toBe(1);
    expect(mem.ld8u(buf)).toBe(1);
    expect(await call("ftruncate", writer, 1)).toBe(0);
    expect(await call("pread", reader, buf, 1, 1)).toBe(0);
    vfs.write(path, Uint8Array.of(4, 5, 6));
    expect(await call("pread", reader, buf, 3, 0)).toBe(3);
    expect([...mem.bytes(buf, 3)]).toEqual([4, 5, 6]);
  } finally { javaCloseFd(writer); javaCloseFd(reader); vfs.delete(path); cpu.dispose(); }
});

test("open files and mappings retain their identity through rename and unlink", () => {
  const from = "/mapped-file-test", to = "/mapped-file-renamed";
  vfs.write(from, Uint8Array.of(1));
  const fd = javaOpenFd(from, 2), writeBack = fdWriteBack(fd)!;
  expect(renamePath(null, from, to)).toBe(0);
  writeBack(0, Uint8Array.of(2));
  expect(vfs.read(to)).toEqual(Uint8Array.of(2));
  expect(vfs.read(from)).toBeNull();
  javaCloseFd(fd);
  writeBack(1, Uint8Array.of(3));
  expect(vfs.read(to)).toEqual(Uint8Array.of(2, 3));
  vfs.delete(to); vfs.write(to, Uint8Array.of(9));
  writeBack(0, Uint8Array.of(4));
  expect(vfs.read(to)).toEqual(Uint8Array.of(9));
  vfs.delete(to);
});

test("descriptor bytes retain shared positions and read lazy files through short reads", async () => {
  const path = "/descriptor-bytes", bytes = Uint8Array.of(1, 2, 3, 4, 5);
  for (const lazy of [false, true]) {
    if (lazy) vfs.lazyFiles.set(path, { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, 2)) });
    else vfs.write(path, bytes);
    const fd = javaOpenFd(path, 0), dup = javaDupFd(fd);
    try {
      expect(javaSeekFd(fd, 1, 0)).toBe(1);
      expect(await javaFdBytes(dup)).toEqual(Uint8Array.of(2, 3, 4, 5));
      expect(javaSeekFd(fd, 0, 1)).toBe(1);
      expect(await javaFdBytes(fd)).toEqual(Uint8Array.of(2, 3, 4, 5));
      expect(javaSeekFd(fd, 9, 0)).toBe(9);
      expect(await javaFdBytes(fd)).toEqual(new Uint8Array(0));
    } finally { javaCloseFd(fd); javaCloseFd(dup); vfs.delete(path); }
    expect(await javaFdBytes(fd)).toBeNull();
  }
});

test("descriptor bytes await pipe data without closing the caller's descriptor", async () => {
  setA64(true); stdioInit();
  const cpu = new Cpu(mainThread, "descriptor-pipe-test"), buffer = mem.malloc(16);
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  expect(await call("pipe", buffer)).toBe(0);
  const reader = mem.ld32(buffer), writer = mem.ld32(buffer + 4);
  try {
    const pending = javaFdBytes(reader);
    mem.write(buffer + 8, Uint8Array.of(4, 5, 6));
    expect(await call("write", writer, buffer + 8, 3)).toBe(3);
    javaCloseFd(writer);
    expect(await pending).toEqual(Uint8Array.of(4, 5, 6));
    expect(await javaFdBytes(reader)).toEqual(new Uint8Array(0));
  } finally { javaCloseFd(reader); mem.free(buffer); cpu.dispose(); }
});
