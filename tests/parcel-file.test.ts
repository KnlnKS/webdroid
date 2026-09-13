import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mkPfd } from "../src/android/os";
import { javaSeekFd, javaCloseFd } from "../src/native/stdio";
import { vfs, mkFile } from "../src/jvm/natives/jio";
rt.linkNatives();

test("byte-backed descriptors have native storage and duplicates outlive the original", async () => {
  const pfd = mkPfd(Uint8Array.of(1, 2, 3), null);
  const fd = await vcall(pfd, "getFd", "()I");
  expect(fd).toBeGreaterThanOrEqual(0);
  expect(javaSeekFd(fd, 0, 2)).toBe(3);
  const duplicate = await vcall(pfd, "dup", "()Landroid/os/ParcelFileDescriptor;");
  await vcall(pfd, "close", "()V");
  await expect(vcall(pfd, "getFd", "()I")).rejects.toBeDefined();
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
    await expect(vcall(pfd, "getFd", "()I")).rejects.toBeDefined();
  } finally { vfs.delete(path); }
});
