// The gzip trailer is only reachable through Inflater.getRemaining(), and it is off by one for
// every stream whose last deflate block does not end on a byte boundary — which is most of them.
import { test, expect } from "bun:test";
import { gzipSync } from "fflate";
import { rt } from "../runtime";
import { mangleMethod } from "../abi";
import "./jlang";
import "./jutil";
import "./jzip";

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
