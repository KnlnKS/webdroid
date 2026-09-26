import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mkPfd } from "../src/android/os";
import { javaSeekFd, javaCloseFd } from "../src/native/stdio";
import { vfs, mkFile } from "../src/jvm/natives/jio";
import { guestAt, mem } from "../src/native/mem";
rt.linkNatives();

test("byte-backed descriptors have native storage and duplicates outlive the original", async () => {
  const pfd = mkPfd(Uint8Array.of(1, 2, 3), null);
  const fd = await vcall(pfd, "getFd", "()I");
  expect(fd).toBeGreaterThanOrEqual(0);
  expect(javaSeekFd(fd, 0, 2)).toBe(3);
  const duplicate = await vcall(pfd, "dup", "()Landroid/os/ParcelFileDescriptor;");
  await vcall(pfd, "close", "()V");
  await expect(vcallAsync(pfd, "getFd", "()I")).rejects.toBeDefined();
  const copyFd = await vcall(duplicate, "detachFd", "()I");
  expect(javaSeekFd(copyFd, 0, 1)).toBe(3);
  await vcall(duplicate, "close", "()V");
  expect(javaSeekFd(copyFd, 0, 0)).toBe(0);
  javaCloseFd(copyFd);
});
test("read-only file opens load lazy bytes and AutoCloseInputStream owns the descriptor", async () => {
  const path = "/data/local/tmp/pfd-lazy-test";
  vfs.mount(path, { size: 3, read: async (offset, length) => Uint8Array.of(7, 8, 9).slice(offset, offset + length) });
  try {
    const pfd = await vcall(rt.link("android/os/ParcelFileDescriptor").ctor, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", mkFile(path), 0x10000000);
    const input = await newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", pfd);
    expect(await vcall(input, "read", "()I")).toBe(7);
    expect(await vcall(pfd, "getStatSize", "()J")).toBe(3n);
    await vcall(input, "close", "()V");
    await expect(vcallAsync(pfd, "getFd", "()I")).rejects.toBeDefined();
  } finally { vfs.delete(path); }
});

test("Os.mmap exposes file bytes to native code and munmap releases the address", async () => {
  const pfd = mkPfd(Uint8Array.of(9, 8, 7), null);
  const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
  const address = await vcall(rt.link("android/system/Os").ctor, "mmap", "(JJIILjava/io/FileDescriptor;J)J", 0n, 3n, 1, 2, fd, 0n) as bigint;
  expect([...mem.bytes(guestAt(address), 3)]).toEqual([9, 8, 7]);
  await vcall(rt.link("android/system/Os").ctor, "munmap", "(JJ)V", address, 3n);
  await vcall(pfd, "close", "()V");
});
