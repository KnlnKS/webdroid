import { afterAll, beforeAll, expect, test } from "bun:test";
import { setA64 } from "./cpu";
import { mem } from "./mem";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

test("A64 transient mappings stay out of the malloc arena", () => {
  const warmup = mem.malloc(16);
  mem.free(warmup);
  const before = mem.stats();
  const small = mem.mapVa(0x000f_f000, false);
  if (typeof small !== "number") throw new Error("small mapping left the fast path");
  expect(mem.unmapPages(small, 0x000f_f000)).toBe(true);

  const mapping = mem.mapVa(0x0010_0000, false);
  const reservation = mem.mapVa(0x7000_0000, true);
  if (typeof mapping !== "bigint" || typeof reservation !== "bigint") {
    throw new Error("large A64 mapping did not receive a virtual plane");
  }
  const allocation = mem.malloc(0x1000);

  const interleaved = mem.stats();
  expect(mapping >> 32n).not.toBe(0n);
  expect(reservation >> 32n).not.toBe(0n);
  expect(interleaved.planes).toBe(before.planes + 2);
  expect(interleaved.chunks).toBe(before.chunks + 1);
  expect(interleaved.peak - before.peak).toBeLessThan(0x10_0000);

  mem.free(allocation);
  expect(mem.unmapVa(mapping, 0x0010_0000)).toBe(true);
  expect(mem.unmapVa(reservation, 0x7000_0000)).toBe(true);
  expect(mem.stats().planes).toBe(before.planes);
});
