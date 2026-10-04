// Argument generation and the Wasm-vs-oracle comparison shared by the differential harnesses.
import { kindOf, type MethodInfo } from "./program";
import { bitsOf, db, fb, fmt, unbits } from "./oracle";

const pool: Record<string, bigint[]> = {
  I: [0, 1, -1, 2, 3, 5, 7, 31, 32, 33, 63, 64, 100, 255, 65536, 123456789, 0x7fffffff, -0x80000000].map(BigInt),
  J: [0n, 1n, -1n, 3n, 0x7fffffffn, -0x80000000n, 123456789012345n, (1n << 63n) - 1n, -(1n << 63n)],
  F: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(fb),
  D: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, 1e300, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(db),
};
/** values a sub-int parameter can hold, so every tier sees the same legal input */
const narrow: Record<string, (v: bigint) => bigint> = { Z: (v) => v & 1n, B: (v) => BigInt.asIntN(8, v), S: (v) => BigInt.asIntN(16, v), C: (v) => BigInt.asUintN(16, v) };
const kindOfParam = (p: string) => (p === "F" || p === "D" ? p : kindOf(p));
const retKind = (m: MethodInfo) => (m.ret === "F" || m.ret === "D" ? m.ret : "I");

export type Case = { m: MethodInfo; args: bigint[] };
/** `small` lists the arguments of single-int-parameter methods whose cost grows with the argument */
export function genCases(methods: MethodInfo[], small: Record<string, number[]> = {}, perMethod = 40): Case[] {
  return methods.flatMap((m) => {
    if (small[m.name]) return small[m.name].map((n) => ({ m, args: [BigInt(n)] }));
    const ks = m.params.map(kindOfParam);
    return Array.from({ length: perMethod }, (_, i) => ({ m, args: ks.map((k, j) => (narrow[m.params[j]] ?? ((v) => v))(pool[k][(i * (j + 3) + j * 5 + (i >> 2)) % pool[k].length])) }));
  });
}

type Exports = Record<string, (...a: any[]) => unknown>;
/** Runs every case on the Wasm module and the JS tier (and `jdk`'s lines, when given); prints each disagreement. */
export async function compare(cases: Case[], exportOf: (m: MethodInfo) => string, exports: Exports,
  js: (cls: string, name: string, desc: string, args: unknown[]) => Promise<unknown>, jdk?: string[]) {
  let bad = 0, explained = 0, threw = 0;
  const fail = (what: string, c: Case, want: string, got: string) => { bad++; console.log(`MISMATCH ${what} ${c.m.cls}.${c.m.name}${c.m.desc}(${c.args.join(", ")}): ${want} vs ${got}`); };
  for (const [i, c] of cases.entries()) {
    const { m, args } = c, rk = retKind(m);
    const ref = jdk ? (jdk[i] === "throw" ? "throw" : fmt(rk, BigInt(jdk[i]))) : undefined;
    let wasm: string, tier: string;
    try { wasm = fmt(rk, BigInt(exports[exportOf(m)](...args.map((a, j) => (m.params[j] === "J" || m.params[j] === "D" ? a : Number(a)))) as bigint)); } catch { wasm = "throw"; }
    try { tier = fmt(rk, bitsOf(m.ret, await js(m.cls, m.name, m.desc, args.map((a, j) => unbits(m.params[j], a))))); } catch (e) {
      // Bun's JSC words a negative typed-array length differently from V8, which runtime.ts maps to NegativeArraySizeException
      tier = /InternalError: length cannot be negative/.test(String(e)) && wasm !== "throw" ? (explained++, wasm) : "throw";
    }
    if (wasm === "throw") threw++;
    if (wasm !== tier) fail("wasm/js", c, `js=${tier}`, `wasm=${wasm}`);
    if (ref !== undefined) { if (wasm !== ref) fail("wasm/jdk", c, `jdk=${ref}`, `wasm=${wasm}`); if (tier !== ref) fail("js/jdk", c, `jdk=${ref}`, `js=${tier}`); }
  }
  return { bad, explained, threw };
}
