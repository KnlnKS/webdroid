import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { vfs } from "../src/jvm/natives/jio";
import { mkAssetFd } from "../src/android/resnative";
rt.linkNatives();

const FD = "()Ljava/io/FileDescriptor;";
const scall = (cls: string, name: string, desc: string, ...a: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...a);

test("a stream over a RandomAccessFile's descriptor writes at the file's shared pointer", async () => {
  vfs.write("/data/data/test/fd/raf.bin", new Uint8Array(0));
  const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/data/data/test/fd/raf.bin", "rw");
  const d = await vcall(raf, "getFD", FD);
  expect(await vcall(d, "valid", "()Z")).toBe(1);
  expect(await vcall(raf, "getFD", FD)).toBe(d);
  const out = await newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", d);
  await vcall(raf, "seek", "(J)V", 4n);
  await vcall(out, "write", "([BII)V", new Int8Array([1, 2, 3]), 0, 3);
  expect(await vcall(raf, "getFilePointer", "()J")).toBe(7n);
  await vcall(raf, "seek", "(J)V", 0n);
  await vcall(out, "write", "(I)V", 9);
  expect([...vfs.read("/data/data/test/fd/raf.bin")!]).toEqual([9, 0, 0, 0, 1, 2, 3]);
});

test("a file stream's and an archive entry's descriptors duplicate onto open native files", async () => {
  vfs.write("/data/data/test/fd/in.bin", new Uint8Array([5, 6, 7]));
  const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/data/data/test/fd/in.bin");
  const pfd = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(input, "getFD", FD));
  expect(await vcall(pfd, "getFd", "()I")).toBeGreaterThanOrEqual(0);
  const entry = mkAssetFd(new Uint8Array([1, 2, 3, 4]));
  const dup = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(entry, "getFileDescriptor", FD));
  const end = await scall("android/system/Os", "lseek", "(Ljava/io/FileDescriptor;JI)J", await vcall(dup, "getFileDescriptor", FD), 0n, 2);
  expect(end).toBe(4n);
});
