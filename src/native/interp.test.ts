import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { blockStats, coldTier, setA64 } from "./cpu";
import { run, runCold, RET, pattern } from "./a64.testkit";
import { mem } from "./mem";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

// The cold tier runs the emitter's own code for every word, so the two tiers must agree on every
// register and on memory; the programs are the decoder suite's, plus control flow the tier decodes itself.
const programs: { name: string; words: number[]; setup: (c: { r: Int32Array; h: Int32Array; si: Int32Array }, buf: number) => void; ignore?: number[] }[] = [
  { name: "multiplies", words: [0x9ba17c02, 0x9b217c03, 0x9ba11404, 0x9b211406, 0x9ba19407, 0x9b219408, 0x9bc17c09, 0x9b017c0a, 0x9b01fc0b, 0x1b017c0c, 0x9b01940d, RET],
    setup: (c) => { c.r[0] = 0x1050; c.r[1] = 0x2492493; c.r[5] = 0x123; } },
  { name: "rotates", words: [0x93c82508, 0x93cc256a, 0x93cca16d, 0x138f15ee, 0x13921e30, 0x93cb8173, 0x93cb0174, RET],
    setup: (c) => { c.r[8] = 0x84f61000 | 0; c.h[8] = 0x728; c.r[11] = 0x55667788; c.h[11] = 0x11223344; c.r[12] = 0xddeeff00 | 0; c.h[12] = 0x99aabbcc | 0; c.r[15] = 0x80000001 | 0; c.r[17] = 0x12345678; c.r[18] = 0x9abcdef0 | 0; } },
  // a counted loop with a compare, a conditional branch, cbnz, a literal load and adr:
  //   mov w0,#0; mov w1,#10; L: add w0,w0,w1; subs w1,w1,#1; b.ne L; cbnz w0,S; mov w2,#7; S: adr x3,L; ldr w4,LIT; ret; LIT: .word 0x12345678
  { name: "control flow", words: [0x52800000, 0x52800141, 0x0b010000, 0x71000421, 0x54ffffc1, 0x35000040, 0x528000e2, 0x10ffff83, 0x18000044, RET, 0x12345678],
    setup: () => {}, ignore: [3, 33] },
  // register-offset store and load through the pattern page, then tbz over a nop
  { name: "memory and tbz", words: [0xb821580b, 0xb8615804, 0x36000040, 0x528000e5, RET],
    setup: (c, buf) => { c.r[0] = buf + 0x800; c.r[1] = 0x21; c.r[11] = 0x11223344; c.r[2] = 0; } },
  // These masks retain bit 31, the case where an un-normalized JS bitwise result is negative.
  { name: "register branches", words: [0xaa1e03ea, 0x10000049, 0xd61f0120, 0x10000089, 0xd63f0120, 0xaa0a03fe, RET, 0x52800120, RET],
    setup: () => {}, ignore: [9, 39] },
  { name: "svc", words: [0x52801588, 0xd4000001, RET], setup: () => {} },
  { name: "branches read both register halves", words: [0xb4000045, 0x52800026, 0xb4000040, 0x52800021, 0xb5000040, 0x52800022, 0xb6400040, 0x52800023, 0xb7400040, 0x52800024, RET],
    setup: (c) => { c.r[0] = 0; c.h[0] = 1 << 8; } },
];
const state = (c: { r: Int32Array; h: Int32Array; si: Int32Array }) => [...c.r.subarray(0, 30), ...c.h.subarray(0, 30), ...c.si.subarray(0, 32)];

describe("the cold tier agrees with the compiled tier", () => {
  for (const p of programs) test(p.name, () => {
    const buf = pattern(), a = run(p.words, (c) => p.setup(c, buf)), sa = state(a), m1 = mem.u8.slice(buf + 0x800, buf + 0x900);
    for (let i = 0; i < 0x1000; i++) mem.u8[buf + i] = i & 0xff;
    const b = runCold(p.words, (c) => p.setup(c, buf)), sb = state(b), m2 = mem.u8.slice(buf + 0x800, buf + 0x900);
    if (p.name === "control flow") { expect(a.r[0]).toBe(55); expect(a.r[4]).toBe(0x12345678); expect(a.r[2]).toBe(0); }
    if (p.name === "register branches") expect(a.r[0]).toBe(9);
    if (p.name === "svc") expect(a.r[0]).toBe(4242);
    if (p.name === "branches read both register halves") expect([a.r[1], a.r[2], a.r[3], a.r[4], a.r[6]]).toEqual([1, 0, 1, 0, 0]);
    // ADR results differ because each tier's code lives at a different address.
    expect(sb.filter((_, i) => !p.ignore?.includes(i))).toEqual(sa.filter((_, i) => !p.ignore?.includes(i)));
    expect(m2).toEqual(m1);
  });

  test("a tier override is scoped to one run", () => {
    const saved = coldTier.heat;
    coldTier.heat = 3;
    try {
      runCold([RET]);
      expect(coldTier.heat).toBe(3);
      run([RET]);
      expect(coldTier.heat).toBe(3);
    } finally {
      coldTier.heat = saved;
    }
  });

  test("a hot entry promotes and a compiled block can return to the cold stub", () => {
    const compiled = blockStats.compiled, interpreted = coldTier.stats.instr;
    const c = runCold([0x52800000, 0x11000400, 0x71000c1f, 0x54ffffc1, RET], undefined, 1);
    expect(c.r[0]).toBe(3);
    expect(blockStats.compiled).toBeGreaterThan(compiled);
    expect(coldTier.stats.instr).toBeGreaterThan(interpreted);
  });
});
