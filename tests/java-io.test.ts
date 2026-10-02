import { expect, test, describe } from "bun:test";
import { unzipSync } from "fflate";
import "../src/natives";
import { mkPfd, pfdBackingBytes } from "../src/android/os";
import { parcelled, unparcelled } from "../src/android/binder";
import { newObj, vcall, vcallAsync, mainThread, vcallOn, JThread, curThread, setCurThread } from "../src/jvm/natives/jlang";
import { rt, JObj } from "../src/jvm/runtime";
import { newFile, fdInt, setFdInt, mkFd, readStreamFully } from "../src/jvm/natives/jio";
import { vfs } from "../src/shell/vfs";
import { mangleMethod } from "../src/jvm/abi";
import { mkAssetFd } from "../src/android/resnative";
import { E } from "../src/native/abi";
import { Cpu, setA64 } from "../src/native/cpu";
import { defineHost } from "../src/native/host";
import { mem, guestAt } from "../src/native/mem";
import { FS_SYSCALLS, javaCloseFd, javaOpenFd, javaSeekFd, javaReadFd, javaPwriteFd, javaTruncateFd, renamePath } from "../src/native/fs";
import { kernelInit } from "../src/native/syscall";
import { BytesFile } from "../src/shell/lazyfile";
import { mkEnumeration } from "../src/jvm/natives/jcoll";
import { scall, loadLibcore } from "./java";

rt.linkNatives();

describe("android-pfd", () => {
  test("document descriptors share seekable writes and commit on last close", async () => {
    rt.link("android/os/ParcelFileDescriptor");
    const written: Uint8Array[] = [];
    const sink = (bytes: Uint8Array) => { written.push(bytes.slice()); };
    const key = `test-pfd-${Math.random()}`;
    const first = await mkPfd(new Uint8Array(8), sink, key);
    const second = await mkPfd(new Uint8Array(8), sink, key);
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
    await pfdBackingBytes(key);
    expect(written).toEqual([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]);
  });
});

describe("atomicfile", () => {
  const make = async (path: string) => { await loadLibcore(); return newObj("android/util/AtomicFile", "(Ljava/io/File;)V", await newFile(path)); };
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

describe("file-descriptor", () => {
  const FD = "()Ljava/io/FileDescriptor;";

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
    await loadLibcore();
    vfs.write("/data/data/test/fd/in.bin", new Uint8Array([5, 6, 7]));
    const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/data/data/test/fd/in.bin");
    const pfd = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(input, "getFD", FD));
    expect(await vcall(pfd, "getFd", "()I")).toBeGreaterThanOrEqual(0);
    const entry = await mkAssetFd(new Uint8Array([1, 2, 3, 4]));
    const dup = await scall("android/os/ParcelFileDescriptor", "dup", "(Ljava/io/FileDescriptor;)Landroid/os/ParcelFileDescriptor;", await vcall(entry, "getFileDescriptor", FD));
    const end = await scall("android/system/Os", "lseek", "(Ljava/io/FileDescriptor;JI)J", await vcall(dup, "getFileDescriptor", FD), 0n, 2);
    expect(end).toBe(4n);
  });
});

describe("file-input-descriptor", () => {
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
      expect(await javaReadFd(fdInt(fd), byte)).toBe(1);
      expect(byte[0]).toBe(2);
      const channel = await vcall(owner, "getChannel", "()Ljava/nio/channels/FileChannel;");
      expect(await vcall(channel, "position", "()J")).toBe(2n);
      expect(await vcall(channel, "size", "()J")).toBe(4n);
      const modes = rt.link("java/nio/channels/FileChannel$MapMode"); await rt.initClass(modes);
      const mode = modes.ctor.s$READ_ONLY;
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
      expect(javaSeekFd(fdInt(fd), 0, 0)).toBe(0);
      expect(await vcall(owner, "read", "()I")).toBe(1);
      await rejectsJava(vcallAsync(borrowed, "read", "()I"), "java/io/IOException");
      await vcall(channel, "close", "()V");
      expect(fdInt(fd)).toBe(-1);
      expect(await vcall(channel, "isOpen", "()Z")).toBe(0);
    } finally { await vcall(owner, "close", "()V"); vfs.delete(path); vfs.delete(renamed); }
  });

  test("descriptor streams serialize lazy reads and reject invalid input", async () => {
    const path = "/input-descriptor-lazy", bytes = Uint8Array.of(5, 6, 7, 8);
    vfs.lazyFiles.set(path, { size: 4, read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, 2)) });
    const fd = await mkFd(javaOpenFd(path, 0));
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
      javaCloseFd(fdInt(fd));
      await rejectsJava(vcallAsync(input, "read", "()I"), "java/io/IOException");
      await rejectsJava(vcallAsync(input, "available", "()I"), "java/io/IOException");
    } finally { javaCloseFd(fdInt(fd)); await vcall(input, "close", "()V"); vfs.delete(path); }
  });

  test("descriptor streams wait for pipe bytes without closing borrowed descriptors", async () => {
    setA64(true); kernelInit();
    const cpu = new Cpu(mainThread, "input-descriptor-pipe"), buffer = mem.malloc(16);
    const call = (name: string, ...args: number[]) => cpu.call(defineHost(name, FS_SYSCALLS[name]), args);
    expect(await call("pipe2", buffer, 0)).toBe(0);
    const fd = await mkFd(mem.ld32(buffer));
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
      expect(await javaReadFd(fdInt(fd), new Uint8Array(1))).toBe(0);
    } finally { javaCloseFd(fdInt(fd)); javaCloseFd(writer); mem.free(buffer); cpu.dispose(); }
  });

  test("descriptor constructors defer invalid descriptor failures and honor explicit ownership", async () => {
    await rejectsJava((async () => newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", null))(), "java/lang/NullPointerException");
    const fd = await mkFd(-1);
    const invalid = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", fd);
    await rejectsJava(vcallAsync(invalid, "read", "()I"), "java/io/IOException");
    await vcall(invalid, "close", "()V");
    const path = "/input-descriptor-owner";
    vfs.write(path, Uint8Array.of(1));
    setFdInt(fd, javaOpenFd(path, 0));
    const input = await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;Z)V", fd, 1);
    await vcall(input, "close", "()V");
    expect(fdInt(fd)).toBe(-1);
    vfs.delete(path);
  });
});

describe("file-relative", () => {
  test("a relative directory lists relative children and reports a plain File parent", async () => {
    await loadLibcore();
    vfs.write("/relative-list/child", new Uint8Array(0));
    const dir = await newObj("java/io/File", "(Ljava/lang/String;)V", "relative-list");
    const [child] = await vcall(dir, "listFiles", "()[Ljava/io/File;") as JObj[];
    expect(await vcall(child, "getPath", "()Ljava/lang/String;")).toBe("relative-list/child");
    expect(await vcall(await vcall(child, "getParentFile", "()Ljava/io/File;"), "getPath", "()Ljava/lang/String;")).toBe("relative-list");
  });
});

describe("input-stream-wrapping", () => {
  class ForwardOnlyStream extends JObj { cursor = 0; bytes = new TextEncoder().encode("<svg/>"); }
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
    const source = rt.make("test/ForwardOnlyStream");
    expect(await vcall(source, "markSupported", "()Z")).toBe(0);
    await expect(vcallAsync(source, "reset", "()V")).rejects.toMatchObject({ msg: "mark/reset not supported" });
    const buffer = await newObj("java/io/BufferedInputStream", "(Ljava/io/InputStream;)V", source);
    await vcall(buffer, "mark", "(I)V", 3);
    expect(await vcall(buffer, "read", "()I")).toBe(60);
    expect(await vcall(buffer, "read", "()I")).toBe(115);
    await vcall(buffer, "reset", "()V");
    expect(new TextDecoder().decode(await readStreamFully(buffer))).toBe("<svg/>");
  });

  test("DataInputStream.readUTF decodes modified UTF-8", async () => {
    // NUL as C0 80 and U+1F680 as a surrogate pair of three-byte halves, as Java's writeUTF emits them
    const input = await data(await bytes([0, 8, 0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xba, 0x80]));
    expect(await vcall(input, "readUTF", "()Ljava/lang/String;")).toBe("\0🚀");
  });

  test("InputStreamReader's UTF-16 takes the byte order from either mark", async () => {
    for (const [values, text] of [[[0xff, 0xfe, 0x68, 0, 0x69, 0], "hi"], [[0xfe, 0xff, 0, 0x68], "h"], [[0, 0x68], "h"]] as const) {
      const reader = await newObj("java/io/InputStreamReader", "(Ljava/io/InputStream;Ljava/lang/String;)V", await bytes([...values]), "UTF-16");
      const out = new Uint16Array(4), n = await vcall(reader, "read", "([CII)I", out, 0, 4);
      expect(String.fromCharCode(...out.subarray(0, n))).toBe(text);
    }
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

describe("parcel-file", () => {
  test("byte-backed descriptors have native storage and duplicates outlive the original", async () => {
    const pfd = await mkPfd(Uint8Array.of(1, 2, 3));
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
  test("an imported writable descriptor writes back once its reader closes", async () => {
    await loadLibcore();
    const path = "/data/local/tmp/pfd-write-back-test";
    vfs.write(path, Uint8Array.of(1, 2, 3), false);
    try {
      const PFD = "android/os/ParcelFileDescriptor";
      const pfd = await scall(PFD, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", await newFile(path), 0x30000000);
      const reader = await unparcelled(PFD, await parcelled(pfd));
      const fd = await vcall(reader, "getFd", "()I");
      javaTruncateFd(fd, 0); javaPwriteFd(fd, Uint8Array.of(9), 0);
      await vcall(reader, "close", "()V");
      for (let i = 0; i < 50 && vfs.read(path)?.length !== 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(vfs.read(path)).toEqual(Uint8Array.of(9));
      await vcall(pfd, "close", "()V");
    } finally { vfs.delete(path); }
  });
  test("read-only file opens load lazy bytes and AutoCloseInputStream owns the descriptor", async () => {
    await loadLibcore();
    const path = "/data/local/tmp/pfd-lazy-test";
    vfs.mount(path, { size: 3, read: async (offset, length) => Uint8Array.of(7, 8, 9).slice(offset, offset + length) });
    try {
      const pfd = await vcall(rt.link("android/os/ParcelFileDescriptor").ctor, "open", "(Ljava/io/File;I)Landroid/os/ParcelFileDescriptor;", await newFile(path), 0x10000000);
      const input = await newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", pfd);
      expect(await vcall(input, "read", "()I")).toBe(7);
      expect(await vcall(pfd, "getStatSize", "()J")).toBe(3n);
      await vcall(input, "close", "()V");
      await expect(vcallAsync(pfd, "getFd", "()I")).rejects.toBeDefined();
    } finally { vfs.delete(path); }
  });

  test("Os.mmap exposes file bytes to native code and munmap releases the address", async () => {
    await loadLibcore();
    const pfd = await mkPfd(Uint8Array.of(9, 8, 7));
    const fd = await vcall(pfd, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
    const address = await scall("android/system/Os", "mmap", "(JJIILjava/io/FileDescriptor;J)J", 0n, 3n, 1, 2, fd, 0n) as bigint;
    expect([...mem.bytes(guestAt(address), 3)]).toEqual([9, 8, 7]);
    await scall("android/system/Os", "munmap", "(JJ)V", address, 3n);
    await vcall(pfd, "close", "()V");
  });
});

describe("pushbackreader", () => {
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
      expect(renamePath(null, "/data/t/none", "/data/t/x")).toBe(-E.NOENT);
      vfs.mkdir("/data/t/dir");
      vfs.write("/data/t/f", new Uint8Array(1));
      expect(renamePath(null, "/data/t/f", "/data/t/dir")).toBe(-E.ISDIR);
      expect(vfs.exists("/data/t/f")).toBe(true);
    });

    test("Java and native renames carry directory entries", async () => {
      await loadLibcore();
      vfs.write("/data/t/old/sub/x", new Uint8Array([4]));
      vfs.mkdir("/data/t/old/empty");
      expect(await vcall(await newFile("/data/t/old"), "renameTo", "(Ljava/io/File;)Z", await newFile("/data/t/new"))).toBe(1);
      expect(vfs.exists("/data/t/old")).toBe(false);
      expect([...vfs.read("/data/t/new/sub/x")!]).toEqual([4]);
      expect(vfs.isDir("/data/t/new/empty")).toBe(true);
      expect(renamePath(null, "/data/t/new", "/data/t/new/inner")).toBe(-E.INVAL);
    });
  });
});

describe("sequence-input", () => {
  class ClosingStream extends JObj { closed = false; }
  rt.register({ name: "test/ClosingStream", ctor: ClosingStream, sup: "java/io/ByteArrayInputStream", methods: {
    "close()V": function (this: ClosingStream) { this.closed = true; },
  } });
  rt.linkNatives();
  test("SequenceInputStream advances lazily and closes exhausted and remaining streams", async () => {
    const streams: ClosingStream[] = await Promise.all([[], [1, 2], [3]].map((b) => newObj("test/ClosingStream", "([B)V", Int8Array.from(b))));
    const sequence = await newObj("java/io/SequenceInputStream", "(Ljava/util/Enumeration;)V", mkEnumeration(streams));
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
  test("shared memory maps and parcels its protected bytes", async () => {
    const shared = await scall("android/os/SharedMemory", "create", "(Ljava/lang/String;I)Landroid/os/SharedMemory;", "sample", 3);
    const writable = await vcall(shared, "mapReadWrite", "()Ljava/nio/ByteBuffer;");
    await vcall(writable, "put", "([B)Ljava/nio/ByteBuffer;", Int8Array.of(3, 5, 7));
    await scall("android/os/SharedMemory", "unmap", "(Ljava/nio/ByteBuffer;)V", writable);
    expect(await vcall(shared, "setProtect", "(I)Z", 1)).toBe(1);
    expect(await vcall(shared, "setProtect", "(I)Z", 3)).toBe(0);
    const parcel = await scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", shared, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    const readOnly = await vcall(restored, "mapReadOnly", "()Ljava/nio/ByteBuffer;");
    const result = new Int8Array(3);
    await vcall(readOnly, "get", "([B)Ljava/nio/ByteBuffer;", result);
    expect([...result]).toEqual([3, 5, 7]);
    expect(await vcall(readOnly, "isReadOnly", "()Z")).toBe(1);
    await scall("android/os/SharedMemory", "unmap", "(Ljava/nio/ByteBuffer;)V", readOnly);
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
