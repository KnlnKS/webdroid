import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JInputStream, vfs } from "../src/jvm/natives/jio";
import { jarray, mangleMethod } from "../src/jvm/abi";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => vcall(rt.link(cls).ctor, name, desc, ...args);

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

test("File comparison orders normalized paths through both overloads", async () => {
  const a = await newObj("java/io/File", "(Ljava/lang/String;)V", "/tmp/a");
  const b = await newObj("java/io/File", "(Ljava/lang/String;)V", "/tmp/b");
  expect(await vcall(a, "compareTo", "(Ljava/io/File;)I", b)).toBe(-1);
  expect(await vcall(b, "compareTo", "(Ljava/lang/Object;)I", a)).toBe(1);
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

test("FileChannel.write drains a ByteBuffer at the shared file position", async () => {
  const output = await newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", "/tmp/nio-channel-write.bin");
  const channel = await vcall(output, "getChannel", "()Ljava/nio/channels/FileChannel;");
  const buffer = await scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", Int8Array.from([1, 2, 3]));
  expect(await vcall(channel, "write", "(Ljava/nio/ByteBuffer;)I", buffer)).toBe(3);
  expect(await vcall(buffer, "position", "()I")).toBe(3);
  expect(await vcall(channel, "position", "()J")).toBe(3n);
  await vcall(output, "close", "()V");
  expect([...vfs.read("/tmp/nio-channel-write.bin")!]).toEqual([1, 2, 3]);

  const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/tmp/nio-channel-write.bin");
  const readOnly = await vcall(input, "getChannel", "()Ljava/nio/channels/FileChannel;");
  const copy = await newObj("java/io/ByteArrayOutputStream", "()V");
  const target = await scall("java/nio/channels/Channels", "newChannel", "(Ljava/io/OutputStream;)Ljava/nio/channels/WritableByteChannel;", copy);
  expect(await vcall(readOnly, "transferTo", "(JJLjava/nio/channels/WritableByteChannel;)J", 1n, 100n, target)).toBe(2n);
  expect(Array.from(await vcall(copy, "toByteArray", "()[B"))).toEqual([2, 3]);
  expect(await vcall(readOnly, "position", "()J")).toBe(0n);
  await expect(vcall(readOnly, "write", "(Ljava/nio/ByteBuffer;)I", buffer)).rejects.toMatchObject({
    constructor: rt.link("java/nio/channels/NonWritableChannelException").ctor,
  });
});

test("Channels adapt input and output streams without copying their state", async () => {
  const input = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([1, 2, 3]));
  const readable = await scall("java/nio/channels/Channels", "newChannel",
    "(Ljava/io/InputStream;)Ljava/nio/channels/ReadableByteChannel;", input);
  const dst = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 3);
  expect(await vcall(readable, "read", "(Ljava/nio/ByteBuffer;)I", dst)).toBe(3);
  expect(await vcall(dst, "position", "()I")).toBe(3);

  const output = await newObj("java/io/ByteArrayOutputStream", "()V");
  const writable = await scall("java/nio/channels/Channels", "newChannel",
    "(Ljava/io/OutputStream;)Ljava/nio/channels/WritableByteChannel;", output);
  await vcall(dst, "flip", "()Ljava/nio/Buffer;");
  expect(await vcall(writable, "write", "(Ljava/nio/ByteBuffer;)I", dst)).toBe(3);
  expect(Array.from(await vcall(output, "toByteArray", "()[B"))).toEqual([1, 2, 3]);
  await vcall(writable, "close", "()V");
  expect(await vcall(writable, "isOpen", "()Z")).toBe(0);
});

test("Files.newOutputStream honors default, append, and delete-on-close options", async () => {
  const path = await scall("java/nio/file/Paths", "get", "(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;",
    "/tmp/nio-output.bin", jarray([], "Ljava/lang/String;"));
  vfs.write("/tmp/nio-output.bin", new Uint8Array([1, 2]));
  let output = await scall("java/nio/file/Files", "newOutputStream",
    "(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;", path, jarray([], "Ljava/nio/file/OpenOption;"));
  await vcall(output, "write", "(I)V", 3);
  await vcall(output, "close", "()V");
  expect([...vfs.read("/tmp/nio-output.bin")!]).toEqual([3]);

  const options = rt.link("java/nio/file/StandardOpenOption").ctor;
  output = await scall("java/nio/file/Files", "newOutputStream",
    "(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;", path,
    jarray([Reflect.get(options, "s$APPEND"), Reflect.get(options, "s$DELETE_ON_CLOSE")], "Ljava/nio/file/OpenOption;"));
  await vcall(output, "write", "(I)V", 4);
  await vcall(output, "close", "()V");
  expect(vfs.exists("/tmp/nio-output.bin")).toBe(false);
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

test("ShortBuffer bulk get honours byte order, bounds and position", async () => {
  const bytes = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 6);
  await vcall(bytes, "putShort", "(S)Ljava/nio/ByteBuffer;", 0x1234);
  await vcall(bytes, "putShort", "(S)Ljava/nio/ByteBuffer;", -2);
  await vcall(bytes, "putShort", "(S)Ljava/nio/ByteBuffer;", 7);
  await vcall(bytes, "flip", "()Ljava/nio/Buffer;");
  const buffer = await vcall(bytes, "asShortBuffer", "()Ljava/nio/ShortBuffer;");
  const out = new Int16Array(5);
  expect(await vcall(buffer, "get", "([SII)Ljava/nio/ShortBuffer;", out, 1, 2)).toBe(buffer);
  expect([...out]).toEqual([0, 0x1234, -2, 0, 0]);
  expect(await vcall(buffer, "position", "()I")).toBe(2);
  await expect(vcall(buffer, "get", "([SII)Ljava/nio/ShortBuffer;", out, 4, 2)).rejects.toMatchObject({});
  await expect(vcall(buffer, "get", "([SII)Ljava/nio/ShortBuffer;", out, 0, 2)).rejects.toMatchObject({});
});

test("ShortBuffer bulk put honours offsets, bounds and position", async () => {
  const buffer = await scall("java/nio/ShortBuffer", "allocate", "(I)Ljava/nio/ShortBuffer;", 3);
  const input = Int16Array.from([9, 0x1234, -2, 8]);
  expect(await vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 1, 2)).toBe(buffer);
  expect(await vcall(buffer, "position", "()I")).toBe(2);
  await vcall(buffer, "flip", "()Ljava/nio/Buffer;");
  const out = new Int16Array(2);
  await vcall(buffer, "get", "([S)Ljava/nio/ShortBuffer;", out);
  expect([...out]).toEqual([0x1234, -2]);
  await expect(vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 3, 2)).rejects.toMatchObject({});
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
