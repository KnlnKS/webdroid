// The gzip trailer is only reachable through Inflater.getRemaining(), and it is off by one for
// every stream whose last deflate block does not end on a byte boundary — which is most of them.
import { test, expect } from "bun:test";
import { gzipSync, zipSync } from "fflate";
import { rt } from "../runtime";
import { mangleMethod } from "../abi";
import { newObj, vcall } from "./jlang";
import "./jlang";
import "./jutil";
import "./jzip";
import { centralDir, centralDirFromTail, entryBytes } from "./jzip";

const GZIP_HEADER = 10, GZIP_TRAILER = 8;

test("Inflater counts delivered output separately from compressed input and trailer", async () => {
  const plain = new TextEncoder().encode("gzip size accounting ".repeat(701));
  const gz = gzipSync(plain);
  const input = new Int8Array(gz.buffer, gz.byteOffset + GZIP_HEADER, gz.length - GZIP_HEADER);
  const z = await newObj("java/util/zip/Inflater", "(Z)V", 1);
  for (const chunkSize of [input.length, 7]) {
    const output: number[] = [];
    for (let pos = 0; pos < input.length; pos += chunkSize) {
      await vcall(z, "setInput", "([BII)V", input, pos, Math.min(chunkSize, input.length - pos));
      while (!await vcall(z, "needsInput", "()Z")) {
        const b = new Int8Array(137);
        const n = await vcall(z, "inflate", "([BII)I", b, 1, b.length - 2);
        output.push(...new Uint8Array(b.buffer, 1, n));
        expect(await vcall(z, "getBytesWritten", "()J")).toBe(BigInt(output.length));
      }
    }
    expect(new Uint8Array(output)).toEqual(plain);
    expect(await vcall(z, "finished", "()Z")).toBe(1);
    expect(await vcall(z, "getBytesRead", "()J")).toBe(BigInt(input.length - GZIP_TRAILER));
    await vcall(z, "reset", "()V");
    expect(await vcall(z, "getBytesWritten", "()J")).toBe(0n);
    expect(await vcall(z, "getBytesRead", "()J")).toBe(0n);
  }
});

test("Inflater.getRemaining() leaves exactly the gzip trailer", () => {
  const inflater = rt.link("java/util/zip/Inflater");
  const getRemaining = mangleMethod("getRemaining", "()I");
  for (const text of ["mihon backup ".repeat(37), "a", "", "x".repeat(9999)]) {
    const gz = gzipSync(new TextEncoder().encode(text));
    const z = new inflater.ctor() as any;
    z.raw = true;
    z.feed(gz.subarray(GZIP_HEADER));
    expect(z[getRemaining]()).toBe(GZIP_TRAILER);
  }
});

test("a zip central directory can be indexed from its HTTP tail", () => {
  const files = {
    "padding.bin": new Uint8Array(100_000),
    "one.txt": new TextEncoder().encode("one"),
    "two.bin": Uint8Array.of(2, 3, 4),
  };
  const zip = zipSync(files, { level: 0 });
  const tail = zip.subarray(Math.max(0, zip.length - (22 + 0xffff)));
  const full = centralDir(zip);
  const ranged = centralDirFromTail(tail, zip.length);
  expect([...ranged.keys()]).toEqual([...full.keys()]);
  const one = ranged.get("one.txt");
  if (!one) throw new Error("one.txt missing");
  expect(new TextDecoder().decode(entryBytes(zip, one))).toBe("one");
});
