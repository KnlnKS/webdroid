import { expect, test } from "bun:test";
import "../src/natives";
import { mkPfd } from "../src/android/os";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";

test("document descriptors share seekable writes and commit on last close", async () => {
  rt.link("android/os/ParcelFileDescriptor");
  const written: Uint8Array[] = [];
  const sink = (bytes: Uint8Array) => { written.push(bytes.slice()); };
  const key = `test-pfd-${Math.random()}`;
  const first = mkPfd(new Uint8Array(8), sink, key);
  const second = mkPfd(new Uint8Array(8), sink, key);
  const stream = async (pfd: typeof first) => {
    const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
    return newObj("java/io/FileOutputStream", "(Ljava/io/FileDescriptor;)V", fd);
  };
  const a = await stream(first), b = await stream(second);
  await vcall(a, "write", "([BII)V", new Int8Array([1, 2, 3, 4]), 0, 4);
  const channel = await vcall(b, "getChannel", "()Ljava/nio/channels/FileChannel;");
  await vcall(channel, "position", "(J)Ljava/nio/channels/FileChannel;", 4n);
  await vcall(b, "write", "([BII)V", new Int8Array([5, 6, 7, 8]), 0, 4);
  await vcall(a, "close", "()V");
  await vcall(b, "close", "()V");
  await vcall(first, "close", "()V");
  expect(written).toHaveLength(0);
  await vcall(second, "close", "()V");
  expect(written).toEqual([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]);
});
