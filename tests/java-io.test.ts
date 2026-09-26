import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import "../src/natives";
import { mkPfd, setProcessIdentity, setProcessName } from "../src/android/os";
import { newObj, vcall, vcallAsync, mainThread, vcallOn, JThread, curThread, setCurThread, callOn } from "../src/jvm/natives/jlang";
import { rt, JObj } from "../src/jvm/runtime";
import { mkFile, vfs, JFileDescriptor, JInputStream, readStreamFully } from "../src/jvm/natives/jio";
import { mangleMethod, jarray, hexBytes, i8 } from "../src/jvm/abi";
import { mkAssetFd } from "../src/android/resnative";
import { Cpu, setA64 } from "../src/native/cpu";
import { lookupHost } from "../src/native/host";
import { mem, guestAt } from "../src/native/mem";
import { javaCloseFd, javaOpenFd, javaSeekFd, javaReadFd, renamePath, stdioInit } from "../src/native/stdio";
import { exportParcel, importParcel } from "../src/android/binder";
import { DexFile } from "../src/jvm/dex";
import { JPath, pathIsConvex, pathTransform } from "../src/android/path";
import { JMatrix } from "../src/android/graphics";
import { BytesFile } from "../src/shell/lazyfile";
import { mkIter } from "../src/jvm/natives/jutil";

describe("android-pfd", () => {
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
});

describe("atomicfile", () => {
  rt.linkNatives();
  const make = (path: string) => newObj("android/util/AtomicFile", "(Ljava/io/File;)V", mkFile(path));
  const write = async (file: unknown, text: string) => {
    const stream = await vcall(file, "startWrite", "()Ljava/io/FileOutputStream;");
    const bytes = new TextEncoder().encode(text);
    await vcall(stream, "write", "([BII)V", bytes, 0, bytes.length);
    return stream;
  };
  test("AtomicFile commits new data and rolls failed replacements back", async () => {
    const path = "/data/test-atomic/replace", file = await make(path);
    let stream = await write(file, "first");
    expect(vfs.exists(path)).toBe(false);
    await vcall(file, "finishWrite", "(Ljava/io/FileOutputStream;)V", stream);
    stream = await write(file, "second");
    await vcall(file, "failWrite", "(Ljava/io/FileOutputStream;)V", stream);
    expect(new TextDecoder().decode(await vcall(file, "readFully", "()[B"))).toBe("first");
    expect(vfs.exists(path + ".new")).toBe(false);
    stream = await write(file, "third");
    await vcall(file, "finishWrite", "(Ljava/io/FileOutputStream;)V", stream);
    expect(new TextDecoder().decode(await vcall(file, "readFully", "()[B"))).toBe("third");
    await vcall(file, "delete", "()V");
    await expect(vcallAsync(file, "openRead", "()Ljava/io/FileInputStream;")).rejects.toBeDefined();
  });
  test("AtomicFile restores legacy backups and discards interrupted replacements on read", async () => {
    const path = "/data/test-atomic/recover", file = await make(path);
    vfs.write(path, new Uint8Array([1]));
    vfs.write(path + ".bak", new Uint8Array([2]));
    vfs.write(path + ".new", new Uint8Array([3]));
    expect(Array.from(await vcall(file, "readFully", "()[B"))).toEqual([2]);
    expect(vfs.exists(path + ".bak")).toBe(false);
    expect(vfs.exists(path + ".new")).toBe(false);
    await vcall(file, "delete", "()V");
  });
});

describe("channel-streams", () => {
  rt.linkNatives();
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
  rt.linkNatives();
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
});

describe("file-descriptor", () => {
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

  test("RandomAccessFile handles retain each other's out-of-order writes", async () => {
    const path = "/data/data/test/fd/ranges.bin";
    vfs.write(path, new Uint8Array(1024));
    const first = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "rw");
    const second = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "rw");
    await vcall(first, "write", "([B)V", Int8Array.from([1, 2, 3]));
    await vcall(second, "seek", "(J)V", 512n);
    await vcall(second, "write", "([B)V", Int8Array.from([4, 5, 6]));
    await vcall(first, "seek", "(J)V", 1023n);
    await vcall(first, "write", "(I)V", 7);
    await vcall(second, "close", "()V");
    await vcall(first, "close", "()V");
    const bytes = vfs.read(path)!;
    expect(bytes.length).toBe(1024);
    expect([...bytes.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([...bytes.subarray(512, 515)]).toEqual([4, 5, 6]);
    expect(bytes[1023]).toBe(7);
  });

  test("an open file sees a longer view of its shared backing", () => {
    const path = "/data/data/test/fd/growing.bin";
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    vfs.write(path, bytes.subarray(0, 3));
    const open = vfs.open(path)!;
    vfs.write(path, bytes);
    expect(open.len).toBe(6);
    expect([...open.data.subarray(0, open.len)]).toEqual([1, 2, 3, 4, 5, 6]);
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
});

describe("file-input-descriptor", () => {
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
});

describe("file-order", () => {
  rt.linkNatives();

  test("File natural ordering sorts paths case-sensitively and collapses equal paths", async () => {
    const files = await newObj("java/util/TreeSet");
    for (const path of ["/cache/z", "/cache/a", "/cache/Z", "/cache/a"])
      await vcall(files, "add", "(Ljava/lang/Object;)Z", mkFile(path));
    const iterator = await vcall(files, "iterator", "()Ljava/util/Iterator;");
    const paths: string[] = [];
    while (await vcall(iterator, "hasNext", "()Z"))
      paths.push(await vcall(await vcall(iterator, "next", "()Ljava/lang/Object;"), "getPath", "()Ljava/lang/String;"));
    expect(paths).toEqual(["/cache/Z", "/cache/a", "/cache/z"]);
    expect(await vcall(mkFile("/cache/a"), "compareTo", "(Ljava/io/File;)I", mkFile("/cache/z"))).toBe(-25);
    for (const [other, exception] of [[null, "NullPointerException"], ["/cache/a", "ClassCastException"]]) {
      const error = await vcallAsync(mkFile("/cache/a"), "compareTo", "(Ljava/lang/Object;)I", other).then(() => null, e => e);
      expect(rt.iof(error, `java/lang/${exception}`)).toBeTruthy();
    }
  });
});

describe("input-stream-wrapping", () => {
  class ForwardOnlyStream extends JInputStream { cursor = 0; bytes = new TextEncoder().encode("<svg/>"); }
  rt.register({ name: "test/ForwardOnlyStream", ctor: ForwardOnlyStream, sup: "java/io/InputStream", methods: {
    "read()I": function (this: ForwardOnlyStream) { return this.cursor < this.bytes.length ? this.bytes[this.cursor++] : -1; },
    "read([BII)I": function (this: ForwardOnlyStream, out: Int8Array, offset: number, count: number) {
      if (!count) return 0;
      const bytes = this.bytes.subarray(this.cursor, this.cursor + count);
      out.set(bytes, offset); this.cursor += bytes.length; return bytes.length || -1;
    },
  } });
  rt.linkNatives();
  const bytes = (values: number[]) => newObj("java/io/ByteArrayInputStream", "([B)V", Int8Array.from(values));
  const data = (source: unknown) => newObj("java/io/DataInputStream", "(Ljava/io/InputStream;)V", source);

  test("forward-only subclasses request buffering before probing and rewinding a stream", async () => {
    const source = new ForwardOnlyStream();
    expect(await vcall(source, "markSupported", "()Z")).toBe(0);
    await expect(vcallAsync(source, "reset", "()V")).rejects.toMatchObject({ msg: "mark/reset not supported" });
    const buffer = await newObj("java/io/BufferedInputStream", "(Ljava/io/InputStream;)V", source);
    await vcall(buffer, "mark", "(I)V", 3);
    expect(await vcall(buffer, "read", "()I")).toBe(60);
    expect(await vcall(buffer, "read", "()I")).toBe(115);
    await vcall(buffer, "reset", "()V");
    expect(new TextDecoder().decode(await readStreamFully(buffer))).toBe("<svg/>");
  });

  test("DataInputStream advances the original stream's cursor", async () => {
    const source = await bytes([0, 0, 1, 2, 3]), input = await data(source);
    expect(await vcall(input, "readInt", "()I")).toBe(258);
    expect(await vcall(source, "read", "()I")).toBe(3);
  });

  test("buffered data reads preserve sequence-stream overrides and marks across refills", async () => {
    const source = await newObj("java/io/SequenceInputStream", "(Ljava/io/InputStream;Ljava/io/InputStream;)V", await bytes([0, 0]), await bytes([1, 2, 3, 4, 5]));
    const buffer = await newObj("java/io/BufferedInputStream", "(Ljava/io/InputStream;I)V", source, 2);
    const input = await data(buffer);
    await vcall(input, "mark", "(I)V", 6);
    expect(await vcall(input, "readInt", "()I")).toBe(258);
    await vcall(input, "reset", "()V");
    expect(await vcall(input, "readInt", "()I")).toBe(258);
    expect(await vcall(input, "readUnsignedShort", "()I")).toBe(772);
    expect(await vcall(input, "readUnsignedByte", "()I")).toBe(5);
    await expect(vcallAsync(input, "reset", "()V")).rejects.toMatchObject({ msg: "Resetting to invalid mark" });
    expect(await vcall(input, "read", "()I")).toBe(-1);
    await vcall(input, "close", "()V");
    await expect(vcallAsync(input, "read", "()I")).rejects.toMatchObject({ msg: "Stream closed" });
  });

  test("DataInputStream.skipBytes handles short skips and EOF without consuming a following byte", async () => {
    const source = await bytes([1, 2, 3, 4, 5]), input = await data(source);
    expect(await vcall(input, "skipBytes", "(I)I", -1)).toBe(0);
    expect(await vcall(input, "skipBytes", "(I)I", 3)).toBe(3);
    expect(await vcall(source, "read", "()I")).toBe(4);
    expect(await vcall(input, "skipBytes", "(I)I", 99)).toBe(1);
    expect(await vcall(input, "skipBytes", "(I)I", 1)).toBe(0);
  });

  test("DataInputStream.skipBytes retains its thread across short suspended skips and propagates failure", async () => {
    const source = rt.make("java/io/InputStream"), thread = new JThread(), calls: unknown[] = [], chunks = [2n, 1n, 0n];
    Object.assign(source, { [mangleMethod("skip", "(J)J")]: async (n: bigint) => {
      calls.push([n, curThread === thread]);
      setCurThread(mainThread);
      await Promise.resolve();
      return chunks.shift();
    } });
    const input = await data(source);
    expect(await vcallOn(thread, input, "skipBytes", "(I)I", 5)).toBe(3);
    expect(calls).toEqual([[5n, true], [3n, true], [2n, true]]);
    const error = rt.mkThrowable("java/io/IOException", "skip failed");
    Object.assign(source, { [mangleMethod("skip", "(J)J")]: () => { throw error; } });
    expect(await vcall(input, "skipBytes", "(I)I", 0)).toBe(0);
    await expect(vcallAsync(input, "skipBytes", "(I)I", 1)).rejects.toBe(error);
  });
});

describe("intbuffer-bulk", () => {
  rt.linkNatives();
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
  test("ShortBuffer bulk ranges preserve signed values and bounds", async () => {
    const bytes = await vcall(rt.link("java/nio/ByteBuffer").ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 8);
    const buffer = await vcall(bytes, "asShortBuffer", "()Ljava/nio/ShortBuffer;");
    await vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", Int16Array.of(8, -32768, 32767, 9), 1, 2);
    expect(await vcall(buffer, "get", "(I)S", 0)).toBe(-32768);
    expect(await vcall(buffer, "get", "(I)S", 1)).toBe(32767);
    await expect(vcallAsync(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", Int16Array.of(1), 1, 1)).rejects.toBeDefined();
    expect(await vcall(buffer, "position", "()I")).toBe(2);
  });
});

describe("nio", () => {
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

  test("ShortBuffer bulk put honours offsets, bounds and position", async () => {
    const buffer = await scall("java/nio/ShortBuffer", "allocate", "(I)Ljava/nio/ShortBuffer;", 3);
    const input = Int16Array.from([9, 0x1234, -2, 8]);
    expect(await vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 1, 2)).toBe(buffer);
    expect(await vcall(buffer, "position", "()I")).toBe(2);
    await vcall(buffer, "flip", "()Ljava/nio/Buffer;");
    const out = new Int16Array(2);
    await vcall(buffer, "get", "([S)Ljava/nio/ShortBuffer;", out);
    expect([...out]).toEqual([0x1234, -2]);
    await expect(vcallAsync(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", input, 3, 2)).rejects.toMatchObject({});
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
    await expect(vcallAsync(ro, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 0n, 4n)).rejects.toThrow();
  });
});

describe("object-stream-blocks", () => {
  rt.linkNatives();
  test("ObjectInputStream consumes short block length headers before calculating the block end", async () => {
    const bytes = Int8Array.from([0xac, 0xed, 0, 5, 0x77, 4, 0, 0, 0, 123, 0x77, 2, 0, 0, 0x77, 2, 1, 200]);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", bytes);
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    expect(await vcall(input, "readInt", "()I")).toBe(123);
    expect(await vcall(input, "readInt", "()I")).toBe(456);
  });
});

describe("object-stream-external", () => {
  rt.loadDex(new DexFile(new Uint8Array(readFileSync(import.meta.dir + "/fixtures/SerializationProbe.dex"))));
  rt.linkNatives();
  const oracle = "aced00057372001a53657269616c697a6174696f6e50726f6265245061796c6f616400000000000000070c000078707716ffffffffffffffef075bcd150008c080eda0bdedba8071007e00017704000003e77871007e0001";
  const field = (value: object, cls: string, name: string) => Reflect.get(value, rt.link(cls).fieldTable.get(name)!);
  const makeValue = () => newObj("SerializationProbe$Value", "(JI)V", -17n, 123456789);
  async function input(bytes: Int8Array) {
    return newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", await newObj("java/io/ByteArrayInputStream", "([B)V", bytes));
  }
  async function encode(value: unknown) {
    const target = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "close", "()V");
    return vcall(target, "toByteArray", "()[B");
  }
  function checkValue(value: object) {
    expect(field(value, "SerializationProbe$Value", "seconds")).toBe(-17n);
    expect(field(value, "SerializationProbe$Value", "nanos")).toBe(123456789);
  }
  test("externalized objects read Java bytes, skip unread data, and resolve repeated references", async () => {
    for (const bytes of [i8(hexBytes(oracle)), await encode(await makeValue())]) {
      const stream = await input(bytes);
      const value = await vcall(stream, "readObject", "()Ljava/lang/Object;");
      checkValue(value);
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
    }
  });
  test("Serializable survives Parcel marshalling without object side tables", async () => {
    const parcel = await newObj("android/os/Parcel");
    await vcall(parcel, "writeSerializable", "(Ljava/io/Serializable;)V", await makeValue());
    await vcall(parcel, "writeValue", "(Ljava/lang/Object;)V", await makeValue());
    const binder = await newObj("android/os/Binder");
    const wire = exportParcel(parcel);
    expect(wire.objects).toEqual([]);
    await vcall(parcel, "writeStrongBinder", "(Landroid/os/IBinder;)V", binder);
    const transported = importParcel(structuredClone(exportParcel(parcel)));
    checkValue(await vcall(transported, "readSerializable", "()Ljava/io/Serializable;"));
    checkValue(await vcall(transported, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
    expect(await vcall(transported, "readStrongBinder", "()Landroid/os/IBinder;")).toBe(binder);
    const bytes = wire.bytes;
    const copy = await newObj("android/os/Parcel");
    await vcall(copy, "unmarshall", "([BII)V", bytes, 0, bytes.length);
    await vcall(copy, "setDataPosition", "(I)V", 0);
    checkValue(await vcall(copy, "readSerializable", "()Ljava/io/Serializable;"));
    checkValue(await vcall(copy, "readValue", "(Ljava/lang/ClassLoader;)Ljava/lang/Object;", null));
  });
  test("strings use modified UTF and long strings retain back references", async () => {
    for (const value of [null, "\0🚀", "x".repeat(70000)]) {
      const stream = await input(await encode(value));
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
      expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(value);
    }
  });
  test("incompatible serialVersionUID is rejected", async () => {
    const bytes = i8(hexBytes(oracle)); bytes[39] = 8;
    await expect(vcallAsync(await input(bytes), "readObject", "()Ljava/lang/Object;")).rejects.toMatchObject({ msg: expect.stringContaining("serialVersionUID") });
  });
  test("primitive UTF data crosses long block boundaries", async () => {
    const target = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
    const value = "\0🚀".repeat(800);
    await vcall(output, "writeUTF", "(Ljava/lang/String;)V", value);
    await vcall(output, "close", "()V");
    const stream = await input(await vcall(target, "toByteArray", "()[B"));
    expect(await vcall(stream, "readUTF", "()Ljava/lang/String;")).toBe(value);
  });
  test("default and custom fields preserve graph identity and initialize only the non-serializable superclass", async () => {
    const oracle = (await Bun.file(import.meta.dir + "/fixtures/SerializationProbe.hex").text()).trim();
    for (const bytes of [i8(hexBytes(oracle)), await encode(await newObj("SerializationProbe$Graph"))]) {
      const graph = await vcall(await input(bytes), "readObject", "()Ljava/lang/Object;");
      const get = (name: string) => field(graph, "SerializationProbe$Graph", name);
      expect([get("flag"), get("small"), get("letter"), get("medium"), get("integer"), get("large"), get("single"), get("wide")])
        .toEqual([1, -123, 65535, -32000, 1234567, -987654321012345n, 1.25, -9.75]);
      expect(get("cycle")).toBe(graph);
      expect(await vcall(get("set"), "size", "()I")).toBe(2);
      expect(await vcall(get("set"), "contains", "(Ljava/lang/Object;)Z", "two")).toBe(1);
      expect(await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 1)).toBe(get("numbers"));
      expect(await vcall(get("list"), "get", "(I)Ljava/lang/Object;", 2)).toBe(graph);
      expect(field(graph, "SerializationProbe$Base", "initialized")).toBe(31);
    }
  });
  test("stream replacement hooks skip null and run once for shared objects", async () => {
    const buffer = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("SerializationProbe$Replacing", "(Ljava/io/OutputStream;)V", buffer);
    for (const value of [null, "first", "first"]) await vcall(output, "writeObject", "(Ljava/lang/Object;)V", value);
    await vcall(output, "close", "()V");
    const bytes = await vcall(buffer, "toByteArray", "()[B");
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", bytes);
    const stream = await newObj("SerializationProbe$Resolving", "(Ljava/io/InputStream;)V", source);
    for (const expected of [null, "resolved", "resolved"]) expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(expected);
    expect(field(output, "SerializationProbe$Replacing", "calls")).toBe(1);
    expect(field(stream, "SerializationProbe$Resolving", "calls")).toBe(1);
  });

  test("primitive arrays retain their Java element types and values", async () => {
    for (const value of [Int8Array.of(-128, 127), Int16Array.of(-32768, 32767), Uint16Array.of(0, 65535),
      Int32Array.of(-2147483648, 2147483647), BigInt64Array.of(-9223372036854775808n, 9223372036854775807n),
      Float32Array.of(1.25, -Infinity), Float64Array.of(-9.75, NaN)]) {
      const stream = await input(await encode(value));
      const actual = await vcall(stream, "readObject", "()Ljava/lang/Object;");
      expect(actual).toBeInstanceOf(value.constructor);
      for (let i = 0; i < value.length; i++) expect(Object.is(actual[i], value[i])).toBe(true);
    }
  });

  test("linked maps retain secret keys through Java object streams", async () => {
    const map = await newObj("java/util/LinkedHashMap");
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", Int8Array.of(0, 1, -1, 3), "HmacSHA1");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "one", key);
    const stream = await input(await encode(map));
    const copy = await vcall(stream, "readObject", "()Ljava/lang/Object;");
    expect(await vcall(stream, "readObject", "()Ljava/lang/Object;")).toBe(copy);
    expect(await vcall(copy, "size", "()I")).toBe(1);
    const restored = await vcall(copy, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "one");
    expect(await vcall(restored, "getAlgorithm", "()Ljava/lang/String;")).toBe("HmacSHA1");
    expect(await vcall(restored, "getEncoded", "()[B")).toEqual(Int8Array.of(0, 1, -1, 3));
  });


  test("serialization retains the caller through nested objects and suspended short reads", async () => {
    const worker = new JThread(), ambient = curThread, calls: string[] = [];
    const record = (name: string) => { expect(curThread).toBe(worker); calls.push(name); };
    rt.register({ name: "test/ThreadExternal", ctor: class extends JObj {}, ifaces: ["java/io/Externalizable"], statics: { serialVersionUID: 1n }, methods: {
      "<init>()V": () => record("init"),
      "writeExternal(Ljava/io/ObjectOutput;)V": async (out: unknown) => {
        record("write"); await Promise.resolve();
        await vcallOn(worker, out, "writeUTF", "(Ljava/lang/String;)V", "\0🚀".repeat(800));
      },
      "readExternal(Ljava/io/ObjectInput;)V": async (input: unknown) => {
        record("read");
        expect(await vcallOn(worker, input, "readUTF", "()Ljava/lang/String;")).toBe("\0🚀".repeat(800));
      },
      "readResolve()Ljava/lang/Object;": function () { record("resolve"); return this; },
    } });
    class ShortInput extends JObj { bytes = new Int8Array(); pos = 0; }
    rt.register({ name: "test/ShortObjectInput", ctor: ShortInput, sup: "java/io/InputStream", methods: {
      "read([BII)I": async function (this: ShortInput, out: Int8Array, offset: number, length: number) {
        expect(curThread).toBe(worker); await Promise.resolve();
        const n = Math.min(length, 17, this.bytes.length - this.pos);
        out.set(this.bytes.subarray(this.pos, this.pos + n), offset); this.pos += n; return n || -1;
      },
    } });
    rt.linkNatives();
    const values = [await callOn(worker, () => newObj("test/ThreadExternal")), await callOn(worker, () => newObj("test/ThreadExternal"))];
    calls.length = 0;
    const buffer = await newObj("java/io/ByteArrayOutputStream");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", buffer);
    await vcallOn(worker, output, "writeObject", "(Ljava/lang/Object;)V", values);
    await vcallOn(worker, output, "close", "()V");
    const source = new ShortInput(); source.bytes = await vcall(buffer, "toByteArray", "()[B");
    const stream = await callOn(worker, () => newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source));
    expect(await vcallOn(worker, stream, "readObject", "()Ljava/lang/Object;")).toHaveLength(2);
    expect(calls).toEqual(["write", "write", "init", "read", "resolve", "init", "read", "resolve"]);
    expect(curThread).toBe(ambient);
  });
});

describe("objectstream", () => {
  rt.linkNatives();

  test("ObjectInputStream consumes complete short blocks and crosses block boundaries", async () => {
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([
      0xac, 0xed, 0, 5, 0x77, 4, 0x12, 0x34, 0x56, 0x78,
      0x77, 1, 0x11, 0x77, 3, 0x22, 0x33, 0x44,
    ]));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    expect(await vcall(input, "readInt", "()I")).toBe(0x12345678);
    expect(await vcall(input, "readInt", "()I")).toBe(0x11223344);
  });

  test("ObjectOutputStream writes a complete object before explicit flush", async () => {
    const set = await newObj("java/util/TreeSet", "()V");
    await vcall(set, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/UUID", "(JJ)V", 1n, 2n));
    const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", set);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    const iterator = await vcall(restored, "iterator", "()Ljava/util/Iterator;");
    const uuid = await vcall(iterator, "next", "()Ljava/lang/Object;");
    expect(await vcall(uuid, "getMostSignificantBits", "()J")).toBe(1n);
    expect(await vcall(uuid, "getLeastSignificantBits", "()J")).toBe(2n);
  });

  test("serialized linked maps retain entries, access order and secret keys", async () => {
    const map = await newObj("java/util/LinkedHashMap", "(IFZ)V", 16, 0.75, 1);
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", new Int8Array([1, -2, 3]), "AES");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", key);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "other", "value");
    const target = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", map);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(target, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    expect(await vcall(restored, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "other")).toBe("value");
    const restoredKey = await vcall(restored, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key");
    expect(await vcall(restoredKey, "getAlgorithm", "()Ljava/lang/String;")).toBe("AES");
    expect([...await vcall(restoredKey, "getEncoded", "()[B")]).toEqual([1, -2, 3]);
    const entries = await vcall(restored, "keySet", "()Ljava/util/Set;");
    const iterator = await vcall(entries, "iterator", "()Ljava/util/Iterator;");
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("other");
    expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("key");
  });

  test("unmodifiable random-access lists retain their serialized read-only view", async () => {
    const list = await newObj("java/util/ArrayList", "()V");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "saved");
    await vcall(list, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/concurrent/atomic/AtomicInteger", "(I)V", 7));
    const view = await vcall(rt.link("java/util/Collections").ctor, "unmodifiableList", "(Ljava/util/List;)Ljava/util/List;", list);
    const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
    const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
    await vcall(output, "writeObject", "(Ljava/lang/Object;)V", view);
    const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
    const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
    const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
    expect(rt.iof(restored, "java/util/RandomAccess")).toBe(1);
    expect(await vcall(restored, "get", "(I)Ljava/lang/Object;", 0)).toBe("saved");
    expect(await vcall(await vcall(restored, "get", "(I)Ljava/lang/Object;", 1), "get", "()I")).toBe(7);
    await expect(vcallAsync(restored, "add", "(Ljava/lang/Object;)Z", "new")).rejects.toThrow();
  });
});

describe("parcel-file", () => {
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
});

describe("path-copy", () => {
  rt.linkNatives();
  test("path copies retain contours and fill rules without sharing mutable geometry", async () => {
    const source = rt.make("android/graphics/Path") as JPath;
    await vcall(source, "moveTo", "(FF)V", 10, 20);
    await vcall(source, "lineTo", "(FF)V", 30, 40);
    source.fillRule = "evenodd";
    source.inverseFill = true;
    expect((await vcall(source, "getFillType", "()Landroid/graphics/Path$FillType;") as { ename: string }).ename).toBe("INVERSE_EVEN_ODD");
    const copy = await newObj("android/graphics/Path", "(Landroid/graphics/Path;)V", source) as JPath;
    const target = rt.make("android/graphics/Path") as JPath;
    await vcall(target, "set", "(Landroid/graphics/Path;)V", copy);
    await vcall(target, "set", "(Landroid/graphics/Path;)V", target);
    await vcall(target, "rLineTo", "(FF)V", 5, 6);
    expect(target.ops.at(-1)).toEqual(["l", 35, 46]);
    await vcall(target, "close", "()V");
    expect([target.curX, target.curY, target.fillRule, target.inverseFill]).toEqual([10, 20, "evenodd", true]);
    await vcall(copy, "offset", "(FF)V", 100, 200);
    expect(source.ops).toEqual([["m", 10, 20], ["l", 30, 40]]);
    expect(target.ops.slice(0, 2)).toEqual(source.ops);
  });

  test("appending a transformed path preserves independent geometry and its current contour", async () => {
    const source = rt.make("android/graphics/Path") as JPath;
    await vcall(source, "moveTo", "(FF)V", 1, 2);
    await vcall(source, "lineTo", "(FF)V", 3, 4);
    const target = rt.make("android/graphics/Path") as JPath;
    const matrix = rt.make("android/graphics/Matrix") as JMatrix;
    matrix.m = [0, 1, -1, 0, 10, 20];
    await vcall(target, "addPath", "(Landroid/graphics/Path;Landroid/graphics/Matrix;)V", source, matrix);
    await vcall(target, "rLineTo", "(FF)V", 5, 6);
    expect(target.ops).toEqual([["m", 8, 21], ["l", 6, 23], ["l", 11, 29]]);
    await vcall(target, "close", "()V");
    expect([target.curX, target.curY]).toEqual([8, 21]);
    await vcall(target, "addPath", "(Landroid/graphics/Path;)V", target);
    expect(target.ops.length).toBe(8);
    await vcall(target, "offset", "(FF)V", 1, 1);
    expect(target.ops[0]).toEqual(["m", 9, 22]);
    expect(source.ops).toEqual([["m", 1, 2], ["l", 3, 4]]);
  });

  test("Path convexity follows control points, closure and contour boundaries", async () => {
    const path = new JPath();
    expect(await vcall(path, "isConvex", "()Z")).toBe(1);
    path.ops = [["m", 0, 0], ["l", 10, 0]];
    expect(pathIsConvex(path)).toBe(1);
    path.ops.push(["l", 10, 10], ["l", 0, 10]);
    expect(pathIsConvex(path)).toBe(1);
    path.ops.push(["l", 5, 5]);
    expect(pathIsConvex(path)).toBe(0);
    path.ops = [["m", 0, 0], ["q", 10, 0, 10, 10], ["l", 0, 10], ["z"]];
    expect(pathIsConvex(path)).toBe(1);
    path.ops[1] = ["q", -10, 20, 10, 10];
    expect(pathIsConvex(path)).toBe(0);
    path.ops = [["rrect", 0, 0, 300, 200, 28, 28, 28, 28, 0, 0, 0, 0]];
    expect(pathIsConvex(path)).toBe(1);
    pathTransform(path, [0, 1, -1, 0, 300, 0]);
    expect(pathIsConvex(path)).toBe(1);
    path.ops.push(["m", 900, 900]);
    expect(pathIsConvex(path)).toBe(1);
    path.ops.push(["l", 901, 900]);
    expect(pathIsConvex(path)).toBe(0);
    path.ops = [["m", 0, 3], ["l", 2, -3], ["l", -3, 1], ["l", 3, 1], ["l", -2, -3], ["z"]];
    expect(pathIsConvex(path)).toBe(0);
    path.ops = [["m", Infinity, 0]];
    expect(pathIsConvex(path)).toBe(0);
  });
});

describe("procfs", () => {
  rt.linkNatives();

  test("Java and native-facing procfs expose the current process cmdline", async () => {
    setProcessIdentity(2468, 10001);
    setProcessName("com.example.app");
    for (const path of ["/proc/self/cmdline", "/proc/2468/cmdline"]) {
      const file = await newObj("java/io/File", "(Ljava/lang/String;)V", path);
      expect(await vcall(file, "exists", "()Z")).toBe(1);
      const stream = await newObj("java/io/FileInputStream", "(Ljava/io/File;)V", file);
      const bytes = new Int8Array(64);
      const length = await vcall(stream, "read", "([B)I", bytes);
      expect(new TextDecoder().decode(new Uint8Array(bytes.buffer, 0, length))).toBe("com.example.app\0");
    }
    expect(await vcall(await newObj("java/io/File", "(Ljava/lang/String;)V", "/proc/9999/cmdline"), "exists", "()Z")).toBe(0);
    const status = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/proc/2468/status");
    const bytes = new Int8Array(512);
    const length = await vcall(status, "read", "([B)I", bytes);
    const text = new TextDecoder().decode(new Uint8Array(bytes.buffer, 0, length));
    expect(text).toContain("Pid:\t2468\n");
    expect(text).toContain("Uid:\t10001\t10001\t10001\t10001\n");
    expect(text).toContain("Cpus_allowed_list:\t");
  });

  test("String.trim removes a proc cmdline terminator", () => {
    const trim = String.prototype[mangleMethod("trim", "()Ljava/lang/String;") as keyof String] as unknown as (this: string) => string;
    expect(trim.call("\0 com.example.app\0")).toBe("com.example.app");
  });
});

describe("pushbackreader", () => {
  rt.linkNatives();

  test("PushbackReader replays characters in order and enforces capacity", async () => {
    const source = await newObj("java/io/StringReader", "(Ljava/lang/String;)V", "abcd");
    const reader = await newObj("java/io/PushbackReader", "(Ljava/io/Reader;I)V", source, 2);
    expect(await vcall(reader, "read", "()I")).toBe(97);
    await vcall(reader, "unread", "([CII)V", Uint16Array.of(120, 121, 122), 1, 2);
    const out = new Uint16Array(4);
    expect(await vcall(reader, "read", "([CII)I", out, 0, 4)).toBe(4);
    expect(String.fromCharCode(...out)).toBe("yzbc");
    await vcall(reader, "unread", "(I)V", 81);
    await vcall(reader, "unread", "(I)V", 82);
    await expect(vcallAsync(reader, "unread", "(I)V", 83)).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
    expect(await vcall(reader, "read", "()I")).toBe(82);
    await vcall(reader, "close", "()V");
    await expect(vcallAsync(reader, "read", "()I")).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
  });
});

describe("rename", () => {
  describe("renamePath", () => {
    test("moves a loaded file and keeps a lazy source lazy", () => {
      vfs.write("/data/t/a.txt", new Uint8Array([1, 2, 3]));
      expect(renamePath(null, "/data/t/a.txt", "/data/t/b.txt")).toBe(0);
      expect(vfs.read("/data/t/a.txt")).toBeNull();
      expect([...vfs.read("/data/t/b.txt")!]).toEqual([1, 2, 3]);

      vfs.mount("/data/t/lazy.bin", new BytesFile(new Uint8Array([9])));
      expect(renamePath(null, "/data/t/lazy.bin", "/data/t/moved.bin")).toBe(0);
      expect(vfs.lazyFiles.has("/data/t/moved.bin")).toBe(true);
      expect(vfs.exists("/data/t/lazy.bin")).toBe(false);
    });

    test("reports a missing source and a directory target", () => {
      expect(renamePath(null, "/data/t/none", "/data/t/x")).toBe(-1);
      vfs.mkdir("/data/t/dir");
      vfs.write("/data/t/f", new Uint8Array(1));
      expect(renamePath(null, "/data/t/f", "/data/t/dir")).toBe(-1);
      expect(vfs.exists("/data/t/f")).toBe(true);
    });

    test("Java and native renames carry directory entries", async () => {
      rt.link("java/io/File");
      vfs.write("/data/t/old/sub/x", new Uint8Array([4]));
      vfs.mkdir("/data/t/old/empty");
      expect(await vcall(mkFile("/data/t/old"), "renameTo", "(Ljava/io/File;)Z", mkFile("/data/t/new"))).toBe(1);
      expect(vfs.exists("/data/t/old")).toBe(false);
      expect([...vfs.read("/data/t/new/sub/x")!]).toEqual([4]);
      expect(vfs.isDir("/data/t/new/empty")).toBe(true);
      expect(renamePath(null, "/data/t/new", "/data/t/new/inner")).toBe(-1);
    });
  });
});

describe("sequence-input", () => {
  class ClosingStream extends JInputStream { closed = false; }
  rt.register({ name: "test/ClosingStream", ctor: ClosingStream, sup: "java/io/InputStream", methods: {
    "close()V": function (this: ClosingStream) { this.closed = true; },
  } });
  rt.linkNatives();
  test("SequenceInputStream advances lazily and closes exhausted and remaining streams", async () => {
    const streams = [new Uint8Array(0), Uint8Array.of(1, 2), Uint8Array.of(3)].map(buf => Object.assign(rt.make("test/ClosingStream"), { buf }));
    const sequence = await newObj("java/io/SequenceInputStream", "(Ljava/util/Enumeration;)V", mkIter(streams));
    const bytes = new Int8Array(4);
    expect(await vcall(sequence, "read", "([BII)I", bytes, 1, 3)).toBe(2);
    expect([...bytes]).toEqual([0, 1, 2, 0]);
    expect(streams[0].closed).toBe(true);
    expect(streams[1].closed).toBe(false);
    expect(await vcall(sequence, "read", "()I")).toBe(3);
    expect(streams[1].closed).toBe(true);
    await vcall(sequence, "close", "()V");
    expect(streams[2].closed).toBe(true);
    expect(await vcall(sequence, "read", "()I")).toBe(-1);
  });
});

describe("shared-memory", () => {
  rt.linkNatives();

  test("shared memory maps and parcels its protected bytes", async () => {
    const type = rt.link("android/os/SharedMemory").ctor;
    const shared = await vcall(type, "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "sample", 3);
    const writable = await vcall(shared, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
    await vcall(writable, "put", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(3, 5, 7));
    await vcall(type, "unmap", "(Ljava/nio/ByteBuffer;)V", writable);
    expect(await vcall(shared, "setProtect", "(I)Z", 1)).toBe(1);
    expect(await vcall(shared, "setProtect", "(I)Z", 3)).toBe(0);
    const parcel = await newObj("android/os/Parcel", "()V");
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", shared, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    const readOnly = await vcall(restored, "mapReadOnly", "()Ljava/nio/ByteBuffer;");
    const result = new Int8Array(3);
    await vcall(readOnly, "get", "([B)Ljava/nio/ByteBuffer;", result);
    expect([...result]).toEqual([3, 5, 7]);
    expect(await vcall(readOnly, "isReadOnly", "()Z")).toBe(1);
    await vcall(type, "unmap", "(Ljava/nio/ByteBuffer;)V", readOnly);
  });
});

describe("string-reader", () => {
  test("StringReader marks and resets its character position", async () => {
    const reader = await newObj("java/io/StringReader", "(Ljava/lang/String;)V", "abc");
    expect(await vcall(reader, "markSupported", "()Z")).toBe(1);
    expect(await vcall(reader, "read", "()I")).toBe(97);
    await vcall(reader, "mark", "(I)V", 1);
    expect(await vcall(reader, "read", "()I")).toBe(98);
    await vcall(reader, "reset", "()V");
    expect(await vcall(reader, "read", "()I")).toBe(98);
  });
});

describe("zip-output", () => {
  rt.linkNatives();
  test("ZipOutputStream writes separate readable entries", async () => {
    const output = await newObj("java/io/ByteArrayOutputStream");
    const zip = await newObj("java/util/zip/ZipOutputStream", "(Ljava/io/OutputStream;)V", output);
    for (const [name, body] of [["first.txt", "alpha"], ["nested/second.txt", "beta"]]) {
      const entry = await newObj("java/util/zip/ZipEntry", "(Ljava/lang/String;)V", name);
      await vcall(zip, "putNextEntry", "(Ljava/util/zip/ZipEntry;)V", entry);
      const bytes = new TextEncoder().encode(body);
      await vcall(zip, "write", "([BII)V", new Int8Array(bytes.buffer), 0, bytes.length);
      await vcall(zip, "closeEntry", "()V");
    }
    await vcall(zip, "close", "()V");
    const bytes = await vcall(output, "toByteArray", "()[B") as Int8Array;
    const files = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    expect(new TextDecoder().decode(files["first.txt"])).toBe("alpha");
    expect(new TextDecoder().decode(files["nested/second.txt"])).toBe("beta");
  });
});
