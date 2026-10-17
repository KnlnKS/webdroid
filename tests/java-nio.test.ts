import { expect, test, describe } from "vite-plus/test";
import "../src/natives.ts";
import { newObj, vcall, vcallAsync, staticField } from "../src/jvm/natives/jentry.ts";
import { vfs } from "../src/shell/vfs.ts";
import { jarray } from "../src/jvm/abi.ts";
import { scall } from "./java.ts";
import { decodeString, encodeString } from "../src/jvm/charset.ts";


describe("charset", () => {
  test("UTF-16 and UTF-32 match the reference device's byte orders, marks and replacements", async () => {
    const hex = (b: Int8Array) => [...b].map((x) => (x & 255).toString(16).padStart(2, "0")).join("");
    const text = (name: string, h: string) => decodeString(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))), name);
    expect(hex(encodeString("A\u00e9\ud83d\ude00", "UTF-32"))).toBe("fffe000041000000e900000000f60100");
    expect(hex(encodeString("A\ud800x", "UTF-32BE"))).toBe("000000410000fffd00000078");
    expect(hex(encodeString("", "UTF-16"))).toBe("");
    expect(text("UTF-32", "0000004142000000")).toBe("A\ufffd");
    expect(text("utf_32", "fffe000041000000")).toBe("A");
    expect(text("UTF-32BE", "0000feff00000041")).toBe("\ufeffA");
    const encoder = await vcall(await scall("java/nio/charset/Charset", "forName", "(Ljava/lang/String;)Ljava/nio/charset/Charset;", "UTF-16LE"), "newEncoder", "()Ljava/nio/charset/CharsetEncoder;");
    expect(hex(await vcall(encoder, "replacement", "()[B"))).toBe("fdff");
    expect(await vcall(encoder, "maxBytesPerChar", "()F")).toBe(2);
  });
});

describe("mapped-files", () => {

  test("FileChannel READ_WRITE mappings share the file's bytes and force persists them", async () => {
    vfs.write("/tmp/nio-map.bin", new Uint8Array([1, 2, 3, 4]));
    const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/tmp/nio-map.bin", "rw");
    const channel = await vcall(raf, "getChannel", "()Ljava/nio/channels/FileChannel;");
    const mode = await staticField("java/nio/channels/FileChannel$MapMode", "READ_WRITE");
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
  test("gathering writes and scattering reads move direct buffers through IOVecWrapper's iovecs", async () => {
    const raf = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", "/tmp/nio-vector.bin", "rw");
    const channel = await vcall(raf, "getChannel", "()Ljava/nio/channels/FileChannel;");
    const direct = async (bytes: number[]) => {
      const b = await scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", bytes.length);
      for (const x of bytes) await vcall(b, "put", "(B)Ljava/nio/ByteBuffer;", x);
      await vcall(b, "flip", "()Ljava/nio/Buffer;");
      return b;
    };
    const out = jarray(new Array(2).fill(null), "Ljava/nio/ByteBuffer;");
    out[0] = await direct([1, 2, 3]); out[1] = await direct([4, 5]);
    expect(await vcall(channel, "write", "([Ljava/nio/ByteBuffer;)J", out)).toBe(5n);
    expect([...vfs.read("/tmp/nio-vector.bin")!]).toEqual([1, 2, 3, 4, 5]);
    await vcall(channel, "position", "(J)Ljava/nio/channels/FileChannel;", 0n);
    const into = jarray(new Array(2).fill(null), "Ljava/nio/ByteBuffer;");
    into[0] = await scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", 2);
    into[1] = await scall("java/nio/ByteBuffer", "allocateDirect", "(I)Ljava/nio/ByteBuffer;", 3);
    expect(await vcall(channel, "read", "([Ljava/nio/ByteBuffer;)J", into)).toBe(5n);
    expect([await vcall(into[0], "get", "(I)B", 1), await vcall(into[1], "get", "(I)B", 2)]).toEqual([2, 5]);
    await vcall(raf, "close", "()V");
    vfs.delete("/tmp/nio-vector.bin");
  });
  test("READ_ONLY mappings of a mounted file load pages on first touch and outlive the descriptor", async () => {
    const size = 200_000, bytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + (i >> 8)) & 255), reads: number[] = [];
    vfs.mount("/tmp/nio-paged.bin", { size, read: async (at, n) => { reads.push(at); return bytes.slice(at, at + n); } });
    const input = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/tmp/nio-paged.bin");
    const channel = await vcall(input, "getChannel", "()Ljava/nio/channels/FileChannel;");
    const mode = await staticField("java/nio/channels/FileChannel$MapMode", "READ_ONLY");
    const map = await vcall(channel, "map", "(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;", mode, 3n, BigInt(size - 3));
    await vcall(input, "close", "()V");
    const at = (i: number) => bytes[i + 3], int = (i: number) => (at(i) << 24 | at(i + 1) << 16 | at(i + 2) << 8 | at(i + 3));
    expect(reads).toEqual([]);
    expect(await vcall(map, "getInt", "(I)I", 65531)).toBe(int(65531));      // across the file's first page boundary
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
