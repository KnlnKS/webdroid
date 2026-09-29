import { expect, test, describe } from "bun:test";
import "../src/natives";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";
import { JInputStream } from "../src/jvm/natives/jio";
import { vfs } from "../src/shell/vfs";
import { mangleMethod, jarray } from "../src/jvm/abi";
import { scall } from "./java";

rt.linkNatives();

describe("channel-streams", () => {
  test("Channels stream adapters preserve byte-buffer positions and stream ranges", async () => {
    const cls = rt.link("java/nio/channels/Channels").ctor;
    const input = await newObj("java/io/ByteArrayInputStream", "([B)V", Int8Array.of(1, 2, 3, 4));
    const reader = await vcall(cls, "newChannel", "(Ljava/io/InputStream;)Ljava/nio/channels/ReadableByteChannel;", input);
    const stream = await vcall(cls, "newInputStream", "(Ljava/nio/channels/ReadableByteChannel;)Ljava/io/InputStream;", reader);
    expect(await vcall(stream, "skip", "(J)J", 1n)).toBe(1n);
    const bytes = new Int8Array(5);
    expect(await vcall(stream, "read", "([BII)I", bytes, 1, 2)).toBe(2);
    expect([...bytes]).toEqual([0, 2, 3, 0, 0]);
    const output = await newObj("java/io/ByteArrayOutputStream");
    const writer = await vcall(cls, "newChannel", "(Ljava/io/OutputStream;)Ljava/nio/channels/WritableByteChannel;", output);
    const sink = await vcall(cls, "newOutputStream", "(Ljava/nio/channels/WritableByteChannel;)Ljava/io/OutputStream;", writer);
    await vcall(sink, "write", "([BII)V", bytes, 1, 2);
    expect(await vcall(output, "toByteArray", "()[B")).toEqual(Int8Array.of(2, 3));
    await vcall(stream, "close", "()V");
    expect(await vcall(reader, "isOpen", "()Z")).toBe(0);
  });
});

describe("charbuffer-sequence", () => {
  const wrap = (text: unknown) => vcall(rt.link("java/nio/CharBuffer").ctor, "wrap", "(Ljava/lang/CharSequence;)Ljava/nio/CharBuffer;", text);

  test("CharBuffer exposes its writable char-array backing", async () => {
    const buffer = await vcall(rt.link("java/nio/CharBuffer").ctor, "allocate", "(I)Ljava/nio/CharBuffer;", 2);
    const array = await vcall(buffer, "array", "()[C");
    array[0] = 65;
    expect(await vcall(buffer, "get", "(I)C", 0)).toBe(65);
    await vcall(buffer, "put", "(C)Ljava/nio/CharBuffer;", 66);
    expect(array[0]).toBe(66);
    expect(await vcall(buffer, "hasArray", "()Z")).toBe(1);
    expect(await vcall(await wrap("text"), "hasArray", "()Z")).toBe(0);
  });

  test("CharBuffer keeps a live read-only CharSequence view", async () => {
    const text = await newObj("java/lang/StringBuilder", "(Ljava/lang/String;)V", "abc");
    const b = await wrap(text);
    await vcall(text, "setCharAt", "(IC)V", 1, 120);
    expect(await vcall(b, "get", "(I)C", 1)).toBe(120);
    expect(await vcall(b, "toString", "()Ljava/lang/String;")).toBe("axc");
    expect(await vcall(b, "get", "()C")).toBe(97);
    expect(await vcall(b, "toString", "()Ljava/lang/String;")).toBe("xc");
    const slice = await vcall(b, "slice", "()Ljava/nio/CharBuffer;");
    await vcall(text, "setCharAt", "(IC)V", 2, 121);
    expect(await vcall(slice, "toString", "()Ljava/lang/String;")).toBe("xy");
    expect(await vcall(slice, "position", "()I")).toBe(0);
    expect(await vcall(slice, "capacity", "()I")).toBe(2);
    await expect(vcallAsync(slice, "put", "(C)Ljava/nio/CharBuffer;", 65)).rejects.toBeDefined();
    await expect(vcallAsync(b, "put", "(C)Ljava/nio/CharBuffer;", 65)).rejects.toBeDefined();
  });
  test("one-shot charset encoding consumes UTF-16 input and reports malformed surrogates", async () => {
    const charset = rt.link("java/nio/charset/StandardCharsets").ctor.s$UTF_8;
    const encoder = await vcall(charset, "newEncoder", "()Ljava/nio/charset/CharsetEncoder;");
    const b = await wrap("café🗺");
    const out = await vcall(encoder, "encode", "(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;", b);
    expect(new Uint8Array((await vcall(out, "array", "()[B")).buffer)).toEqual(new TextEncoder().encode("café🗺"));
    expect(await vcall(b, "remaining", "()I")).toBe(0);
    const bad = await wrap("a\ud800b");
    await expect(vcallAsync(encoder, "encode", "(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;", bad)).rejects.toMatchObject({ msg: "Input length = 1" });
    expect(await vcall(bad, "position", "()I")).toBe(1);
  });

  test("decoder replacement preserves valid replacement characters and unread overflow input", async () => {
    const decoder = await vcall(rt.link("java/nio/charset/StandardCharsets").ctor.s$UTF_8, "newDecoder", "()Ljava/nio/charset/CharsetDecoder;");
    await vcall(decoder, "replaceWith", "(Ljava/lang/String;)Ljava/nio/charset/CharsetDecoder;", "?");
    const input = await vcall(rt.link("java/nio/ByteBuffer").ctor, "wrap", "([B)Ljava/nio/ByteBuffer;", new Int8Array([0xef, 0xbf, 0xbd, 0xff, 0xf0, 0x9f, 0x90, 0x88]));
    const output = await vcall(rt.link("java/nio/CharBuffer").ctor, "allocate", "(I)Ljava/nio/CharBuffer;", 3);
    const decode = () => vcall(decoder, "decode", "(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;Z)Ljava/nio/charset/CoderResult;", input, output, 1);
    const error = await decode();
    expect(await vcall(error, "isMalformed", "()Z")).toBe(1);
    expect(input.pos).toBe(3);
    await rt.initClass(rt.link("java/nio/charset/CodingErrorAction"));
    await vcall(decoder, "onMalformedInput", "(Ljava/nio/charset/CodingErrorAction;)Ljava/nio/charset/CharsetDecoder;", rt.link("java/nio/charset/CodingErrorAction").ctor.s$REPLACE);
    expect(await vcall(await decode(), "isOverflow", "()Z")).toBe(1);
    expect(input.pos).toBe(4);
    await vcall(output, "flip", "()Ljava/nio/Buffer;");
    expect(await vcall(output, "toString", "()Ljava/lang/String;")).toBe("\ufffd?");
    await vcall(output, "clear", "()Ljava/nio/Buffer;");
    expect(await vcall(await decode(), "isUnderflow", "()Z")).toBe(1);
    await vcall(output, "flip", "()Ljava/nio/Buffer;");
    expect(await vcall(output, "toString", "()Ljava/lang/String;")).toBe("🐈");
  });

  test("streaming encode stops before a character that does not fit and keeps a split surrogate pair", async () => {
    const encoder = await vcall(rt.link("java/nio/charset/StandardCharsets").ctor.s$UTF_8, "newEncoder", "()Ljava/nio/charset/CharsetEncoder;");
    const input = await vcall(rt.link("java/nio/CharBuffer").ctor, "wrap", "([C)Ljava/nio/CharBuffer;", Uint16Array.from("aé🗺\ud83d".split(""), (c) => c.charCodeAt(0)));
    const output = await vcall(rt.link("java/nio/ByteBuffer").ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 4);
    const encode = (end: number) => vcall(encoder, "encode", "(Ljava/nio/CharBuffer;Ljava/nio/ByteBuffer;Z)Ljava/nio/charset/CoderResult;", input, output, end);
    expect(await vcall(await encode(0), "isOverflow", "()Z")).toBe(1);
    expect([input.pos, output.pos]).toEqual([2, 3]);
    await vcall(output, "clear", "()Ljava/nio/Buffer;");
    expect(await vcall(await encode(0), "isUnderflow", "()Z")).toBe(1);
    expect([input.pos, output.pos]).toEqual([4, 4]);
    expect(await vcall(await encode(1), "isMalformed", "()Z")).toBe(1);
  });
});

describe("intbuffer-bulk", () => {
  test("IntBuffer bulk range writes honor order, position and limits", async () => {
    for (const little of [false, true]) {
      const bytes = await vcall(rt.link("java/nio/ByteBuffer").ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 20);
      if (little) await vcall(bytes, "order", "(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;", rt.link("java/nio/ByteOrder").ctor.s$LITTLE_ENDIAN);
      const buffer = await vcall(bytes, "asIntBuffer", "()Ljava/nio/IntBuffer;");
      await vcall(buffer, "position", "(I)Ljava/nio/IntBuffer;", 1);
      await vcall(buffer, "put", "([III)Ljava/nio/IntBuffer;", Int32Array.of(9, 0x12345678, -42, 8), 1, 2);
      expect(await vcall(buffer, "position", "()I")).toBe(3);
      expect(await vcall(buffer, "get", "(I)I", 1)).toBe(0x12345678);
      expect(await vcall(buffer, "get", "(I)I", 2)).toBe(-42);
      await expect(vcallAsync(buffer, "put", "([III)Ljava/nio/IntBuffer;", new Int32Array(1), 1, 1)).rejects.toBeDefined();
      await expect(vcallAsync(buffer, "put", "([III)Ljava/nio/IntBuffer;", new Int32Array(3), 0, 3)).rejects.toBeDefined();
      expect(await vcall(buffer, "position", "()I")).toBe(3);
    }
  });
  test("ShortBuffer bulk puts over heap and byte-view storage preserve signed values, bounds and position", async () => {
    const heap = () => scall("java/nio/ShortBuffer", "allocate", "(I)Ljava/nio/ShortBuffer;", 3);
    const view = async () => vcall(await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 6), "asShortBuffer", "()Ljava/nio/ShortBuffer;");
    for (const make of [heap, view]) {
      const buffer = await make(), input = Int16Array.of(9, -32768, 32767, 8);
      expect(await vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 1, 2)).toBe(buffer);
      expect(await vcall(buffer, "position", "()I")).toBe(2);
      await expect(vcallAsync(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 3, 2)).rejects.toBeDefined();
      expect(await vcall(buffer, "position", "()I")).toBe(2);
      await vcall(buffer, "flip", "()Ljava/nio/Buffer;");
      const out = new Int16Array(2);
      await vcall(buffer, "get", "([S)Ljava/nio/ShortBuffer;", out);
      expect([...out]).toEqual([-32768, 32767]);
    }
  });
});

describe("nio", () => {
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
    expect(await vcall(direct, "hasArray", "()Z")).toBe(1); // ART backs it with a non-movable array
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
    await expect(vcallAsync(readOnly, "write", "(Ljava/nio/ByteBuffer;)I", buffer)).rejects.toMatchObject({
      constructor: rt.link("java/nio/channels/NonWritableChannelException").ctor,
    });
  });

  test("FileChannel truncation shrinks storage and the shared position without extending files", async () => {
    for (const kind of ["java/io/FileOutputStream", "java/io/RandomAccessFile"]) {
      const path = `/tmp/truncate-${kind.split("/").at(-1)}`;
      const file = kind.endsWith("RandomAccessFile") ? await newObj(kind, "(Ljava/lang/String;Ljava/lang/String;)V", path, "rw") : await newObj(kind, "(Ljava/lang/String;)V", path);
      await vcall(file, "write", "([B)V", new Int8Array([1, 2, 3]));
      const channel = await vcall(file, "getChannel", "()Ljava/nio/channels/FileChannel;");
      expect(await vcall(channel, "truncate", "(J)Ljava/nio/channels/FileChannel;", 2n)).toBe(channel);
      expect(await vcall(channel, "position", "()J")).toBe(2n);
      await vcall(channel, "truncate", "(J)Ljava/nio/channels/FileChannel;", 10n);
      expect(await vcall(channel, "size", "()J")).toBe(2n);
      await vcall(file, "close", "()V");
      expect([...vfs.read(path)!]).toEqual([1, 2]);
      await expect(vcallAsync(channel, "truncate", "(J)Ljava/nio/channels/FileChannel;", 0n)).rejects.toMatchObject({ constructor: rt.link("java/nio/channels/ClosedChannelException").ctor });
    }
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
    await expect(vcallAsync(buffer, "get", "([FII)Ljava/nio/FloatBuffer;", out, 0, 4)).rejects.toMatchObject({});
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
    await expect(vcallAsync(buffer, "get", "([SII)Ljava/nio/ShortBuffer;", out, 4, 2)).rejects.toMatchObject({});
    await expect(vcallAsync(buffer, "get", "([SII)Ljava/nio/ShortBuffer;", out, 0, 2)).rejects.toMatchObject({});
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
    await expect(vcallAsync(ro, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 0n, 4n)).rejects.toThrow();
  });
  test("READ_ONLY mappings of a mounted file load pages on first touch and outlive the descriptor", async () => {
    const size = 200_000, bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + (i >> 8)) & 255), reads: number[] = [];
    vfs.mount("/tmp/nio-paged.bin", { size, read: async (at, n) => { reads.push(at); return bytes.slice(at, at + n); } });
    const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/tmp/nio-paged.bin");
    const channel = await vcall(input, "getChannel", "()Ljava/nio/channels/FileChannel;");
    const mode = (rt.link("java/nio/channels/FileChannel$MapMode").ctor as any).s$READ_ONLY;
    const map = await vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 3n, BigInt(size - 3));
    await vcall(input, "close", "()V");
    const at = (i: number) => bytes[i + 3], int = (i: number) => (at(i) << 24 | at(i + 1) << 16 | at(i + 2) << 8 | at(i + 3));
    expect(reads).toEqual([]);
    expect(await vcall(map, "getInt", "(I)I", 65534)).toBe(int(65534));      // across the first page boundary
    expect(reads.length).toBe(2);
    expect(await vcall(map, "get", "()B")).toBe((at(0) << 24) >> 24);
    await vcall(map, "position", "(I)Ljava/nio/ByteBuffer;", 131000);
    const slice = await vcall(map, "slice", "()Ljava/nio/ByteBuffer;");
    expect(await vcall(slice, "getChar", "(I)C", 2000)).toBe(at(133000) << 8 | at(133001));
    await expect(vcallAsync(slice, "getInt", "(I)I", size - 3 - 131000 - 3)).rejects.toThrow();
    const ints = await vcall(slice, "asIntBuffer", "()Ljava/nio/IntBuffer;");
    expect(await vcall(ints, "get", "(I)I", 16000)).toBe(int(131000 + 64000));
    const chunk = new Int8Array(10);
    await vcall(map, "position", "(I)Ljava/nio/ByteBuffer;", 131067);
    await vcall(map, "get", "([BII)Ljava/nio/ByteBuffer;", chunk, 1, 8);
    expect([...chunk]).toEqual([0, ...Array.from({ length: 8 }, (_, i) => (at(131067 + i) << 24) >> 24), 0]);
    const copy = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 100);
    await vcall(slice, "limit", "(I)Ljava/nio/ByteBuffer;", 100);
    await vcall(copy, "put", "(Ljava/nio/ByteBuffer;)Ljava/nio/ByteBuffer;", slice);
    expect(await vcall(copy, "get", "(I)B", 99)).toBe((at(131099) << 24) >> 24);
    expect(new Set(reads).size).toBe(reads.length);                             // each page is read once
    vfs.delete("/tmp/nio-paged.bin");
  });
});
