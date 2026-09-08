import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { setA64 } from "./cpu";
import { MEM_SIZE_A64 } from "./abi";
import { spawnSync } from "node:child_process";

test("allocator reuse preserves unsigned pointers above 2 GiB", () => {
  const result = spawnSync(process.execPath, [new URL("./fixtures/high-heap.ts", import.meta.url).pathname], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
});

// planes only exist in a 4 GiB process: the pool sits above the 2 GiB line
beforeAll(() => { setA64(true); if (mem.u8.length < MEM_SIZE_A64) mem.init(MEM_SIZE_A64); });
afterAll(() => setA64(false));

const UNIT = 1 << 25;
test("large aligned allocations reuse freed pages without leaking or overwriting neighbors", () => {
  const size = 1 << 20, alignment = 2 * size, before = mem.stats();
  let p = mem.memalign(alignment, size);
  const first = p, neighbor = mem.memalign(4096, size);
  expect(p).not.toBe(0);
  expect(neighbor).not.toBe(0);
  expect(p % alignment).toBe(0);
  expect(p + size <= neighbor || neighbor + size <= p).toBe(true);
  mem.u8.fill(0x5a, neighbor, neighbor + size);
  try {
    for (let i = 0; i < 12; i++) {
      expect(p).toBe(first);
      expect(mem.usableSize(p)).toBe(size);
      expect(mem.stats().used).toBe(before.used + 2 * size);
      mem.u8.fill(0xa5, p, p + size);
      expect(mem.u8.subarray(neighbor, neighbor + size).every(v => v === 0x5a)).toBe(true);
      mem.free(p);
      p = 0;
      expect(mem.stats().used).toBe(before.used + size);
      expect(mem.stats().blocks).toBe(before.blocks + 1);
      p = mem.memalign(alignment, size);
    }
  } finally {
    mem.free(p);
    mem.free(neighbor);
  }
  expect(mem.stats().used).toBe(before.used);
  expect(mem.stats().blocks).toBe(before.blocks);
});

describe("address planes", () => {
  test("a reservation commits a contiguous prefix that survives a move", () => {
    const p0: number[] = [];
    const plane = (): bigint => { for (;;) { const v = mem.mapVa(0x1ffff000, true); if (typeof v === "bigint") return v; p0.push(v); } };   // plane 0 fills first
    const a = plane(), b = plane();
    expect(a >> 32n).not.toBe(b >> 32n);
    expect(mem.unmapVa(a + 0x10000000n, 0xffff000)).toBe(true);                  // the trim to 256 MiB
    expect(mem.commitVa(a, 0x1000)).toBe(true);
    expect(() => mem.txVa(a + 0x2000n)).toThrow(/not committed/);                 // past the prefix
    const pa = mem.txVa(a);
    mem.st32(pa, 0x11223344);
    expect(mem.va(pa)).toBe(a);                                                    // the reverse map
    expect(mem.commitVa(b, UNIT)).toBe(true);                                      // b takes the unit after a's
    expect(mem.commitVa(a, 2 * UNIT)).toBe(true);                                  // a cannot extend in place: it moves
    const pa2 = mem.txVa(a);
    expect(pa2).not.toBe(pa);
    expect(mem.ld32(pa2)).toBe(0x11223344);                                        // and keeps its data
    expect(mem.txVa(a + BigInt(UNIT))).toBe(pa2 + UNIT);                           // contiguous across units
    expect(mem.ld32(pa2 + UNIT)).toBe(0);
    expect(mem.commitVa(a, 0x10000000 + 1)).toBe(false);                            // past the reservation
    expect(mem.unmapVa(a, 0x10000000)).toBe(true);
    expect(() => mem.txVa(a)).toThrow(/unmapped/);
    expect(mem.unmapVa(b, 0x1ffff000)).toBe(true);
    expect(mem.stats().planes).toBe(0);
    for (const v of p0) mem.unmapVa(BigInt(v), 0x1ffff000);
  });
});
