import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { setA64, type Cpu } from "./cpu.ts";
import { runCases, RET } from "./a64.testkit.ts";
import { INSTRUCTIONS, CASES, INPUT_BYTES, inputs } from "./a64simd.oracle.cases.ts";

// The emitter against a real AArch64 core: scripts/simd-oracle.ts ran every instruction in
// a64simd.oracle.cases.ts on this Mac and recorded v0-v3, x2-x5 and NZCV afterwards. Results
// are compared bit for bit, except that an arithmetic NaN is compared as "is NaN": which
// payload a JS engine produces is its own business, and moves are bit-exact regardless.
beforeAll(() => setA64(true));
afterAll(() => setA64(false));

const fixture = gunzipSync(readFileSync(new URL("./fixtures/a64simd.bin.gz", import.meta.url)));
const dv = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength);
const count = dv.getUint32(4, true), cases = dv.getUint32(8, true);

function sameLane(exp: Uint8Array, got: Uint8Array, o: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (exp[o + i] !== got[o + i]) return false;
  return true;
}
function nanBoth(exp: Uint8Array, got: Uint8Array, o: number, n: number): boolean {
  const e = new DataView(exp.buffer, exp.byteOffset + o, n), g = new DataView(got.buffer, got.byteOffset + o, n);
  return n === 4 ? e.getFloat32(0, true) !== e.getFloat32(0, true) && g.getFloat32(0, true) !== g.getFloat32(0, true)
    : e.getFloat64(0, true) !== e.getFloat64(0, true) && g.getFloat64(0, true) !== g.getFloat64(0, true);
}
/** every 8-byte lane bit-identical, or both NaN as a double, or both of its 4-byte halves NaN-or-equal as floats */
function matches(exp: Uint8Array, got: Uint8Array, o: number): boolean {
  if (sameLane(exp, got, o, 8)) return true;
  if (nanBoth(exp, got, o, 8)) return true;
  return [0, 4].every((h) => sameLane(exp, got, o + h, 4) || nanBoth(exp, got, o + h, 4));
}

describe("a64 simd: the hardware oracle", () => {
  expect(count).toBe(INSTRUCTIONS.length);
  expect(cases).toBe(CASES);
  for (let i = 0; i < count; i++) {
    const word = dv.getUint32(12 + i * 4, true);
    test(INSTRUCTIONS[i], () => {
      const bad: string[] = [];
      const caseInputs = Array.from({ length: cases }, (_, k) => inputs(k));
      const setups = caseInputs.map((inp) => (c: Cpu) => {
        const src = new DataView(inp.buffer);
        for (let w = 0; w < 16; w++) c.si[w] = src.getInt32(w * 4, true);
        for (let r = 2; r <= 5; r++) { c.w[2 * r] = src.getInt32(64 + (r - 2) * 8, true); c.w[2 * r + 1] = src.getInt32(68 + (r - 2) * 8, true); }
        const f = src.getUint32(96, true);
        c.n = (f >>> 31) & 1; c.z = (f >>> 30) & 1; c.c = (f >>> 29) & 1; c.v = (f >>> 28) & 1;
      });
      runCases([word, RET], setups, (tier, c, k) => {
        const exp = fixture.subarray(12 + count * 4 + (i * cases + k) * INPUT_BYTES, 12 + count * 4 + (i * cases + k + 1) * INPUT_BYTES);
          const got = new Uint8Array(INPUT_BYTES), gv = new DataView(got.buffer);
          for (let w = 0; w < 16; w++) gv.setInt32(w * 4, c.si[w], true);
          for (let r = 2; r <= 5; r++) { gv.setInt32(64 + (r - 2) * 8, c.w[2 * r], true); gv.setInt32(68 + (r - 2) * 8, c.w[2 * r + 1], true); }
          gv.setUint32(96, ((c.n << 31) | (c.z << 30) | (c.c << 29) | (c.v << 28)) >>> 0, true);
          for (let o = 0; o < 96; o += 8) if (!matches(exp, got, o)) bad.push(`${tier} case ${k} ${o < 64 ? `v${o >> 4}[${(o & 15) >> 3}]` : `x${2 + ((o - 64) >> 3)}`}: expected ${hex(exp, o)} got ${hex(got, o)}`);
          if (!sameLane(exp, got, 96, 4)) bad.push(`${tier} case ${k} nzcv: expected ${(exp[99] >> 4).toString(2)} got ${(got[99] >> 4).toString(2)}`);
      });
      expect(bad).toEqual([]);
    });
  }
});
const hex = (b: Uint8Array, o: number) => [...b.subarray(o, o + 8)].reverse().map((x) => x.toString(16).padStart(2, "0")).join("");
