import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { codeStats, invalidateRange, setA64 } from "./cpu";
import { mem } from "./mem";
import { RET, run } from "./a64.testkit";
import { JIT_HEAT, jitEvict, jitStats } from "./core";

const movW0 = (v: number) => 0x52800000 | (v << 5);

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

describe("the decode cache", () => {
  test("reused allocations and mappings discard code from their previous lifetime", () => {
    const c = run([RET]);
    const execute = (at: number) => { c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ } return c.w[0]; };
    for (const hot of [false, true]) for (const kind of ["malloc", "calloc", "realloc", "mapping", "commit"] as const) {
      const mapped = kind === "mapping" || kind === "commit";
      const source = kind === "realloc" ? mem.malloc(64) : 0;
      const base = mapped ? mem.mapPages(4096) : mem.malloc(128), at = base + 16;
      mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
      for (let i = 0; i < (hot ? JIT_HEAT + 2 : 1); i++) expect(execute(at)).toBe(1);
      let reused: number;
      if (kind === "commit") {
        mem.decommitPages(base, 4096); expect(mem.commitPages(base, 4096)).toBe(true); reused = base;
      } else if (kind === "mapping") {
        expect(mem.unmapPages(base, 4096)).toBe(true); reused = mem.mapPages(4096);
      } else {
        mem.free(base);
        reused = kind === "calloc" ? mem.calloc(1, 128) : kind === "realloc" ? mem.realloc(source, 128) : mem.malloc(128);
      }
      expect(reused).toBe(base);
      mem.u32[at >>> 2] = movW0(2); mem.u32[(at >>> 2) + 1] = RET;
      expect(execute(at)).toBe(2);
      if (mapped) mem.unmapPages(base, 4096); else mem.free(base);
    }
    const base = mem.malloc(128);
    mem.u32[base >>> 2] = RET; execute(base);
    const before = codeStats.invalidated;
    mem.free(base);
    expect(codeStats.invalidated).toBe(before + 1);
  });

  test("host writes invalidate every executed word they overlap in both tiers", () => {
    const writes: ((a: number, bytes: Uint8Array) => void)[] = [
      (a, b) => mem.st16(a, new DataView(b.buffer).getUint16(0, true)),
      (a, b) => mem.st32(a, new DataView(b.buffer).getInt32(0, true)),
      (a, b) => mem.stf32(a, new DataView(b.buffer).getFloat32(0, true)),
      (a, b) => mem.st64(a, new DataView(b.buffer).getBigInt64(0, true)),
      (a, b) => mem.stf64(a, new DataView(b.buffer).getFloat64(0, true)),
      (a, b) => mem.write(a, b),
      (a, b) => { const src = mem.malloc(b.length); mem.write(src, b); mem.memmove(a, src, b.length); mem.free(src); },
    ];
    const sizes = [2, 4, 4, 8, 8, 8, 8];
    const c = run([RET]);
    const execute = (at: number) => { c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ } return c.w[0]; };
    for (const hot of [false, true]) for (const offset of [0, 4]) for (const [i, write] of writes.entries()) {
      const at = mem.reserve(0x3000, 0x1000) + 0x1000 + offset;
      mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
      for (let j = 0; j < (hot ? JIT_HEAT + 2 : 1); j++) expect(execute(at)).toBe(1);
      const size = sizes[i], start = at - (size === 8 ? 4 : 1);
      const bytes = mem.bytes(start, size).slice();
      bytes[at - start] = movW0(2) & 255;
      write(start, bytes);
      expect(execute(at)).toBe(2);
    }
  });

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

  test("guest wide stores invalidate a later executed word across a page boundary", () => {
    const c = run([RET]), writer = mem.reserve(0x1000, 0x1000);
    mem.u32[writer >>> 2] = 0xf9000120; // str x0, [x9]
    mem.u32[(writer >>> 2) + 1] = RET;
    const execute = (at: number) => { c.setPc(at); while (c.runSlice(10000) !== 2) { /* spin */ } };
    for (const hot of [false, true]) {
      const at = mem.reserve(0x3000, 0x1000) + 0x1000;
      mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
      if (hot) {
        c.w[18] = at - 16;
        for (let i = 0; i <= JIT_HEAT; i++) execute(writer);
      }
      execute(at);
      expect(c.w[0]).toBe(1);
      c.w[0] = 0; c.w[1] = movW0(2); c.w[18] = at - 4;
      execute(writer); execute(at);
      expect(c.w[0]).toBe(2);
    }
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
