import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { codeStats, invalidateRange, setA64 } from "./cpu.ts";
import { mem } from "./mem.ts";
import { finish, RET, run } from "./a64.testkit.ts";
import { JIT_HEAT, jitEvict, jitStats } from "./core.ts";
import { LOW, RET_SENTINEL } from "./abi.ts";

const movW0 = (v: number) => 0x52800000 | (v << 5);

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

describe("the decode cache", () => {
  test("reused allocations and mappings discard code from their previous lifetime", () => {
    const c = run([RET]);
    const execute = (at: number) => { c.setPc(at); finish(c); return c.w[0]; };
    for (const hot of [false, true]) for (const kind of ["malloc", "calloc", "realloc", "mapping", "commit", "discard"] as const) {
      const mapped = kind === "mapping" || kind === "commit" || kind === "discard";
      const source = kind === "realloc" ? mem.malloc(64) : 0;
      const base = mapped ? mem.mapPages(4096) : mem.malloc(128), at = base + 16;
      mem.u32[at >>> 2] = movW0(1); mem.u32[(at >>> 2) + 1] = RET;
      for (let i = 0; i < (hot ? JIT_HEAT + 2 : 1); i++) expect(execute(at)).toBe(1);
      let reused: number;
      if (kind === "discard") {
        mem.dropVa(BigInt(base), 4096); reused = base;
      } else if (kind === "commit") {
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
    const execute = (at: number) => { c.setPc(at); finish(c); return c.w[0]; };
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
    c.setPc(at); finish(c);
    expect(c.w[0]).toBe(1);
    for (let value = 2; value <= 6; value++) {
      const before = codeStats.invalidated;
      mem.st32(at, movW0(value));
      expect(codeStats.invalidated).toBe(before + 1);
      c = run([RET]);
      c.setPc(at); finish(c);
      expect(c.w[0]).toBe(value);
    }
  });

  test("a region that branches to another page runs the new code after a store drops it", () => {
    const at = mem.reserve(0x2000, 0x1000), callee = at + 0x1000;
    mem.u32[at >>> 2] = 0x14000000 | ((callee - at) >>> 2); // b callee
    mem.u32[callee >>> 2] = movW0(1); mem.u32[(callee >>> 2) + 1] = RET;
    const c = run([RET]);
    const execute = () => { c.setPc(at); finish(c); return c.w[0]; };
    const compiled = jitStats.regions;
    for (let i = 0; i <= JIT_HEAT; i++) expect(execute()).toBe(1);
    expect(jitStats.regions).toBeGreaterThan(compiled);
    mem.st32(callee, movW0(2));
    expect(execute()).toBe(2);
  });

  test("a store into the page's data leaves its decoded code alone", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(7); mem.u32[(at >>> 2) + 1] = RET;
    const c = run([RET]);
    c.setPc(at); finish(c);
    const before = codeStats.invalidated;
    mem.st32(at + 0x800, 0x12345678);
    expect(codeStats.invalidated).toBe(before);
    expect(mem.ld32(at + 0x800)).toBe(0x12345678);
  });

  test("guest wide stores invalidate a later executed word across a page boundary", () => {
    const c = run([RET]), writer = mem.reserve(0x1000, 0x1000);
    mem.u32[writer >>> 2] = 0xf9000120; // str x0, [x9]
    mem.u32[(writer >>> 2) + 1] = RET;
    const execute = (at: number) => { c.setPc(at); finish(c); };
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

  test("instruction synchronization observes a store to the active region's successor", () => {
    const c = run([RET]), at = mem.reserve(0x1000, 0x1000), target = at + 24;
    const words = [
      0xb900012a, // str w10, [x9]
      0xd50b7b29, // dc cvau, x9
      0xd5033b9f, // dsb ish
      0xd50b7529, // ic ivau, x9
      0xd5033b9f, // dsb ish
      0xd5033fdf, // isb
      movW0(1), RET,
    ];
    mem.u32.set(words, at >>> 2);
    const execute = (destination: number) => {
      c.w.fill(0); c.si.fill(0x12345678);
      c.cpsr = 0xa0000000; c.fpcr = 0x400000; c.fpsr = 0x10; c.excl = 0;
      c.w[18] = destination; c.w[20] = movW0(2); c.w[60] = RET_SENTINEL;
      c.setPc(at);
      const start = c.ic;
      for (let i = 0; i < 16; i++) {
        if (c.runSlice(1000) === 2) return { regs: [...c.w], vectors: [...c.si], pc: c.pc,
          cpsr: c.cpsr, fpcr: c.fpcr, fpsr: c.fpsr, excl: c.excl, instructions: c.ic - start };
      }
      throw new Error("self-modifying region did not return");
    };
    const expected = execute(target);
    expect(c.w[0]).toBe(2);
    expect(expected.instructions).toBe(words.length);
    mem.st32(target, movW0(1));
    const compiled = jitStats.regions;
    for (let i = 0; i <= JIT_HEAT; i++) execute(at + 0x800);
    expect(jitStats.regions).toBeGreaterThan(compiled);
    const actual = execute(target);
    expect(mem.ld32(target)).toBe(movW0(2));
    expect(actual).toEqual(expected);
  });

  test("an evicted region re-heats and comes back", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = movW0(9); mem.u32[(at >>> 2) + 1] = RET;
    const c = run([RET]);
    const heat = () => { for (let i = 0; i <= JIT_HEAT; i++) { c.setPc(at); finish(c); } };
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
    c.setPc(a); finish(c);
    c.setPc(a + 0x1000); finish(c);
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

test("compiled scalar and vector memory operations retain low-address faults", () => {
  const data = mem.reserve(0x1000, 0x1000), c = run([RET]);
  // LDR X0, LDR Q0, LD1 V16/V17 and post-index ST1 V15, all through X9.
  for (const word of [0xf9400120, 0x3dc00120, 0x4c40a130, 0x4c9f792f]) {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u32[at >>> 2] = word; mem.u32[(at >>> 2) + 1] = RET;
    const execute = (address: number) => {
      c.w[18] = address; c.w[19] = 0;
      c.setPc(at);
      finish(c);
    };
    for (const hot of [false, true]) {
      if (hot) {
        const before = jitStats.regions;
        for (let i = 0; i < JIT_HEAT + 2; i++) execute(data);
        expect(jitStats.regions).toBeGreaterThan(before);
      }
      for (const address of [0, LOW - 1]) {
        expect(() => execute(address)).toThrow(`signal 11 code 1 addr 0x${address.toString(16)}`);
        expect(c.w[18]).toBe(address);
      }
    }
  }
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
    expect(() => { finish(c); }).toThrow("signal 11 code 1 addr 0x0");
    expect(c.pc).toBe(0);
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
      finish(c);
    }
    expect(jitStats.regions).toBeGreaterThan(before);
    c.w[0] = 0; c.w[1] = 0;
    c.setPc(at);
    expect(() => { finish(c); }).toThrow("signal 11 code 1 addr 0x0");
    expect(c.pc).toBe(0);
  });
});


test("compiled memory faults retain the failing instruction address", () => {
  const at = mem.reserve(4096, 4096), data = mem.malloc(16), c = run([RET]);
  mem.u32.set([0xd503201f, 0xb9000120, RET], at >>> 2); // nop; str w0, [x9]; ret
  const execute = () => { c.setPc(at); finish(c); };
  try {
    c.w[18] = data; c.w[19] = 0;
    const before = jitStats.regions;
    for (let i = 0; i < JIT_HEAT + 2; i++) execute();
    expect(jitStats.regions).toBeGreaterThan(before);
    for (const high of [0, 256]) {
      c.w[18] = 0; c.w[19] = high;
      expect(execute).toThrow(`signal 11 code 1 addr 0x${(high * 2 ** 32).toString(16)}`);
      expect(c.pc).toBe(at + 4);
    }
  } finally { mem.free(data); }
});
