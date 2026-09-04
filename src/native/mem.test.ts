import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { setA64 } from "./cpu";
import { MEM_SIZE_A64 } from "./abi";

// planes only exist in a 4 GiB process: the pool sits above the 2 GiB line
beforeAll(() => { setA64(true); if (mem.u8.length < MEM_SIZE_A64) mem.init(MEM_SIZE_A64); });
afterAll(() => setA64(false));

const UNIT = 1 << 25;
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
