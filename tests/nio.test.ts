import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JInputStream, vfs } from "../src/jvm/natives/jio";
import { mangleMethod } from "../src/jvm/abi";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

rt.linkNatives();

test("heap ByteBuffers expose their backing array and slice offset", async () => {
  const buffer = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 4);
  expect(await vcall(buffer, "hasArray", "()Z")).toBe(1);
  const array = await vcall(buffer, "array", "()[B");
  await vcall(buffer, "position", "(I)Ljava/nio/Buffer;", 1);
  const slice = await vcall(buffer, "slice", "()Ljava/nio/ByteBuffer;");
  expect(await vcall(slice, "array", "()[B")).toBe(array);
  expect(await vcall(slice, "arrayOffset", "()I")).toBe(1);

  const readOnly = await vcall(buffer, "asReadOnlyBuffer", "()Ljava/nio/ByteBuffer;");
  expect(await vcall(readOnly, "hasArray", "()Z")).toBe(0);
  const direct = await scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", 4);
  expect(await vcall(direct, "hasArray", "()Z")).toBe(0);
});

test("InputStream.skip reads through a bytecode-style subclass", async () => {
  class ChunkStream extends JInputStream {
    offset = 0;
    readonly data = Int8Array.from([1, 2, 3, 4, 5]);
    [mangleMethod("read", "([BII)I")](out: Int8Array, off: number, len: number) {
      if (this.offset === this.data.length) return -1;
      const count = Math.min(len, this.data.length - this.offset);
      out.set(this.data.subarray(this.offset, this.offset + count), off);
      this.offset += count;
      return count;
    }
  }
  const stream = new ChunkStream();
  expect(await vcall(stream, "skip", "(J)J", 3n)).toBe(3n);
  expect(stream.offset).toBe(3);
  expect(await vcall(stream, "skip", "(J)J", 10n)).toBe(2n);
  expect(await vcall(stream, "skip", "(J)J", -1n)).toBe(0n);
});

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

test("FileChannel READ_WRITE mappings share the file's bytes and force persists them", async () => {
  vfs.write("/tmp/nio-map.bin", new Uint8Array([1, 2, 3, 4]));
  const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/tmp/nio-map.bin", "rw");
  const channel = await vcall(raf, "getChannel", "()Ljava/nio/channels/FileChannel;");
  const mode = (rt.link("java/nio/channels/FileChannel$MapMode").ctor as any).s$READ_WRITE;
  const map = await vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 2n, 6n);
  expect(await vcall(map, "capacity", "()I")).toBe(6);
  expect(vfs.read("/tmp/nio-map.bin")!.length).toBe(8);           // the mapping extended the file
  expect(await vcall(map, "get", "(I)B", 0)).toBe(3);
  await vcall(map, "put", "(IB)Ljava/nio/ByteBuffer;", 1, 9);
  expect(vfs.read("/tmp/nio-map.bin")![3]).toBe(9);               // the store is in the file's storage at once
  await vcall(raf, "seek", "(J)V", 8n);
  await vcall(raf, "write", "(I)V", 7);                            // the file grows past the mapping; the mapping follows the storage
  await vcall(map, "put", "(IB)Ljava/nio/ByteBuffer;", 5, 5);
  await vcall(map, "force", "()Ljava/nio/MappedByteBuffer;");
  expect([...vfs.read("/tmp/nio-map.bin")!]).toEqual([1, 2, 3, 9, 0, 0, 0, 5, 7]);
  await vcall(raf, "close", "()V");
  expect([...vfs.read("/tmp/nio-map.bin")!]).toEqual([1, 2, 3, 9, 0, 0, 0, 5, 7]);
  const reader = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/tmp/nio-map.bin", "r");
  const ro = await vcall(reader, "getChannel", "()Ljava/nio/channels/FileChannel;");
  await expect(vcall(ro, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 0n, 4n)).rejects.toThrow();
});
