import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { vfs } from "../src/jvm/natives/jio";
import { mangleMethod } from "../src/jvm/abi";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

rt.linkNatives();

test("FileChannel.read fills a ByteBuffer from streams and random-access files", async () => {
  vfs.write("/tmp/nio-channel.bin", new Uint8Array([1, 2, 3, 4, 5, 6]));
  const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/tmp/nio-channel.bin");
  const channel = await vcall(input, "getChannel", "()Ljava/nio/channels/FileChannel;");
  const buffer = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 4);
  expect(await vcall(channel, "read", "(Ljava/nio/ByteBuffer;)I", buffer)).toBe(4);
  expect(await vcall(buffer, "position", "()I")).toBe(4);
  expect(await vcall(buffer, "get", "(I)B", 3)).toBe(4);
  expect(await vcall(channel, "read", "(Ljava/nio/ByteBuffer;)I", buffer)).toBe(0);
  await vcall(buffer, "clear", "()Ljava/nio/Buffer;");
  expect(await vcall(channel, "read", "(Ljava/nio/ByteBuffer;)I", buffer)).toBe(2);
  expect(await vcall(channel, "read", "(Ljava/nio/ByteBuffer;)I", buffer)).toBe(-1);

  const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/tmp/nio-channel.bin", "r");
  const rafChannel = await vcall(raf, "getChannel", "()Ljava/nio/channels/FileChannel;");
  await vcall(buffer, "clear", "()Ljava/nio/Buffer;");
  expect(await vcall(rafChannel, "read", "(Ljava/nio/ByteBuffer;J)I", buffer, 4n)).toBe(2);
  expect(await vcall(buffer, "get", "(I)B", 1)).toBe(6);
  expect(await vcall(rafChannel, "position", "()J")).toBe(0n);
});

test("FloatBuffer bulk get honours offsets, lengths and underflow", async () => {
  const buffer = await scall("java/nio/FloatBuffer", "allocate", "(I)Ljava/nio/FloatBuffer;", 6);
  await vcall(buffer, "put", "([F)Ljava/nio/FloatBuffer;", Float32Array.from([1, 2, 3, 4, 5, 6]));
  await vcall(buffer, "flip", "()Ljava/nio/Buffer;");
  const out = new Float32Array(8);
  await vcall(buffer, "get", "([FII)Ljava/nio/FloatBuffer;", out, 2, 3);
  expect([...out]).toEqual([0, 0, 1, 2, 3, 0, 0, 0]);
  expect(await vcall(buffer, "position", "()I")).toBe(3);
  await expect(vcall(buffer, "get", "([FII)Ljava/nio/FloatBuffer;", out, 0, 4)).rejects.toMatchObject({});
});

test("the dropbox service exists and has every tag disabled", async () => {
  const dropbox = rt.make("android/os/DropBoxManager");
  expect(await vcall(dropbox, "isTagEnabled", "(Ljava/lang/String;)Z", "crash")).toBe(0);
  await vcall(dropbox, "addText", "(Ljava/lang/String;Ljava/lang/String;)V", "crash", "x");
});
