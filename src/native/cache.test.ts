import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { codeStats, invalidateRange, setA64 } from "./cpu";
import { mem } from "./mem";
import { run } from "./a64.testkit";

const RET = 0xd65f03c0;
const movW0 = (v: number) => 0x52800000 | (v << 5);

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

describe("the decode cache", () => {
  test("a store into an executed word drops the page and the new code runs", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
    let c = run([], () => {});
    c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
    expect(c.w[0]).toBe(1);
    for (let value = 2; value <= 6; value++) {
      const before = codeStats.invalidated;
      mem.st32(at, movW0(value));
      expect(codeStats.invalidated).toBe(before + 1);
      c = run([], () => {});
      c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
      expect(c.w[0]).toBe(value);
    }
  });

  test("a store into the page's data leaves its decoded code alone", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(7); mem.u32[(at >>> 2) + 1] = RET;
    const c = run([], () => {});
    c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
    const before = codeStats.invalidated;
    mem.st32(at + 0x800, 0x12345678);
    expect(codeStats.invalidated).toBe(before);
    expect(mem.ld32(at + 0x800)).toBe(0x12345678);
  });

  test("cacheflush drops every page in the range", () => {
    const a = mem.reserve(0x2000, 0x1000);
    mem.u32[a >>> 2] = RET; mem.u32[(a + 0x1000) >>> 2] = RET;
    const c = run([], () => {});
    c.setPc(a); while (c.runSlice(10000) !== 2) { /* spin */ }
    c.setPc(a + 0x1000); while (c.runSlice(10000) !== 2) { /* spin */ }
    const before = codeStats.invalidated;
    invalidateRange(a, 0x2000, "test");
    expect(codeStats.invalidated).toBe(before + 2);
  });
});
