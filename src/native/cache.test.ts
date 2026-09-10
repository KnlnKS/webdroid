import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { codeStats, invalidateRange, setA64 } from "./cpu";
import { mem } from "./mem";
import { RET, run } from "./a64.testkit";
import { JIT_HEAT, jitEvict, jitStats } from "./core";

const movW0 = (v: number) => 0x52800000 | (v << 5);

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

describe("the decode cache", () => {
  test("a store into an executed word drops the page and the new code runs", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
    let c = run([RET]);
    c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
    expect(c.w[0]).toBe(1);
    for (let value = 2; value <= 6; value++) {
      const before = codeStats.invalidated;
      mem.st32(at, movW0(value));
      expect(codeStats.invalidated).toBe(before + 1);
      c = run([RET]);
      c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
      expect(c.w[0]).toBe(value);
    }
  });

  test("a store into the page's data leaves its decoded code alone", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(7); mem.u32[(at >>> 2) + 1] = RET;
    const c = run([RET]);
    c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ }
    const before = codeStats.invalidated;
    mem.st32(at + 0x800, 0x12345678);
    expect(codeStats.invalidated).toBe(before);
    expect(mem.ld32(at + 0x800)).toBe(0x12345678);
  });

  test("an evicted region re-heats and comes back", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(9); mem.u32[(at >>> 2) + 1] = RET;
    const c = run([RET]);
    const heat = () => { for (let i = 0; i <= JIT_HEAT; i++) { c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ } } };
    let before = jitStats.regions;
    heat();
    expect(jitStats.regions).toBe(before + 1);
    while (jitStats.modules) jitEvict();
    before = jitStats.regions;
    heat();
    expect(jitStats.regions).toBe(before + 1);
    expect(c.w[0]).toBe(9);
  });
  test("cacheflush drops every page in the range", () => {
    const a = mem.reserve(0x2000, 0x1000);
    mem.u32[a >>> 2] = RET; mem.u32[(a + 0x1000) >>> 2] = RET;
    const c = run([RET]);
    c.setPc(a); while (c.runSlice(10000) !== 2) { /* spin */ }
    c.setPc(a + 0x1000); while (c.runSlice(10000) !== 2) { /* spin */ }
    const before = codeStats.invalidated;
    invalidateRange(a, 0x2000, "test");
    expect(codeStats.invalidated).toBe(before + 2);
  });
});

describe("region discovery", () => {
  // Scanning a block registers its successors, so a region's block count grows while it is being
  // scanned. Block 0 here stops one instruction short of the budget and forks, and each block
  // reached after that would once have scanned an instruction of its own, past the end of the
  // emitter's per-instruction arrays.
  test("blocks discovered past the instruction budget emit nothing", () => {
    const nop = 0xd503201f, cbzX0 = 0xb4000040; // cbz x0, #+8
    const words: number[] = Array(318).fill(nop);
    words.push(cbzX0); // 318: taken -> 320, fall -> 319
    words.push(RET); //   319
    words.push(cbzX0); // 320: taken -> 322, fall -> 321
    words.push(RET); //   321
    words.push(RET); //   322
    const before = jitStats.regions;
    expect(run(words, (c) => { c.w[0] = 0; }).w[0]).toBe(0);
    expect(jitStats.regions).toBeGreaterThan(before);
  });
});

describe("a branch to a null pointer", () => {
  // Below LOW lies the core's own stack, not anything the guest may run, and a region hands its
  // target back to run_slice as a bare number: a null target has to fault in both tiers rather
  // than be decoded, or be read as a status and leave the pc where it was.
  const brX0 = 0xd61f0000;
  test("faults in the interpreter", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = brX0;
    const c = run([RET]);
    c.w[0] = 0; c.w[1] = 0;
    c.setPc(at);
    expect(() => { while (c.runSlice(10000) !== 2) { /* spin */ } }).toThrow(/null page/);
  });
  test("faults out of a compiled region", () => {
    // a fault never drains the JIT, so the region has to compile against a real target first
    const at = mem.reserve(0x1000, 0x1000), land = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = brX0;
    mem.u32[land >>> 2] = RET;
    const c = run([RET]);
    const before = jitStats.regions;
    for (let i = 0; i < JIT_HEAT + 2; i++) {
      c.w[0] = land; c.w[1] = 0;
      c.setPc(at);
      while (c.runSlice(10000) !== 2) { /* spin */ }
    }
    expect(jitStats.regions).toBeGreaterThan(before);
    c.w[0] = 0; c.w[1] = 0;
    c.setPc(at);
    expect(() => { while (c.runSlice(10000) !== 2) { /* spin */ } }).toThrow(/null page/);
  });
});
