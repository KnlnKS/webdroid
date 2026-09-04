// The gzip trailer is only reachable through Inflater.getRemaining(), and it is off by one for
// every stream whose last deflate block does not end on a byte boundary — which is most of them.
import { test, expect } from "bun:test";
import { gzipSync, zipSync } from "fflate";
import { rt } from "../runtime";
import { mangleMethod } from "../abi";
import "./jlang";
import "./jutil";
import "./jzip";
import { centralDir, centralDirFromTail, entryBytes } from "./jzip";

const GZIP_HEADER = 10, GZIP_TRAILER = 8;

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
