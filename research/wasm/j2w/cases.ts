// Argument generation and the Wasm-vs-oracle comparison shared by the differential harnesses.
import { mangleField, mangleMethod } from "../../../src/jvm/abi";
import { kindOf, type MethodInfo } from "./program";
import { bitsOf, db, fb, fmt, unbits } from "./oracle";

const pool: Record<string, bigint[]> = {
  I: [0, 1, -1, 2, 3, 5, 7, 9, 10, 16, 31, 32, 33, 36, 48, 57, 63, 64, 65, 90, 97, 100, 122, 255, 65536, 123456789, 0x7fffffff, -0x80000000].map(BigInt),
  J: [0n, 1n, -1n, 3n, 0x7fffffffn, -0x80000000n, 123456789012345n, (1n << 63n) - 1n, -(1n << 63n)],
  F: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(fb),
  D: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, 1e300, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(db),
};
/** values a sub-int parameter can hold, so every tier sees the same legal input */
const STR = "Ljava/lang/String;";
const strings = ["", "a", "hello", "Hello, World", "-123", "+7", "0x1F", "2147483648", "12abc", "  padded  ", "caf\u00e9", "\ud83d\ude00x", "\ud800", "ABCxyz", "1e3", "true", "3.14", "NaN", "a,b,,c", null];
/** the JS tier's String overrides answer for a null argument (JS coerces it to "null") where Java throws, so String methods are given none */
const nonNull = strings.filter((s) => s !== null);
const narrow: Record<string, (v: bigint) => bigint> = { Z: (v) => v & 1n, B: (v) => BigInt.asIntN(8, v), S: (v) => BigInt.asIntN(16, v), C: (v) => BigInt.asUintN(16, v) };
const kindOfParam = (p: string) => (p === "F" || p === "D" ? p : p === STR ? "S" : kindOf(p));
const retKind = (m: MethodInfo) => (m.ret === "F" || m.ret === "D" ? m.ret : "I");

/** the parameters of the exported function: a String method takes its receiver first */
export const paramsOf = (m: MethodInfo) => (m.isStatic ? m.params : [STR, ...m.params]);
export type Case = { m: MethodInfo; args: (bigint | string | null)[] };
/** a String result as one comparable token: null apart from the text "null" */
const show = (v: unknown) => (v === null ? "null" : JSON.stringify(v));
const result = (m: MethodInfo, v: unknown, toBits: (v: unknown) => bigint) => (m.ret === STR ? show(v) : fmt(retKind(m), toBits(v)));
/** `small` lists the arguments of single-int-parameter methods whose cost grows with the argument */
export function genCases(methods: MethodInfo[], small: Record<string, number[]> = {}, perMethod = 40): Case[] {
  return methods.flatMap((m) => {
    if (Object.hasOwn(small, m.name)) return small[m.name].map((n) => ({ m, args: [BigInt(n)] }));
    const ks = paramsOf(m).map(kindOfParam);
    const pick = (k: string, i: number, j: number) => { const p = k === "S" ? (!m.isStatic ? nonNull : strings) : pool[k]; return p[(i * (j + 3) + j * 5 + (i >> 2)) % p.length]; };
    return Array.from({ length: perMethod }, (_, i) => ({ m, args: ks.map((k, j) => k === "S" ? pick(k, i, j) as string | null : (narrow[paramsOf(m)[j]] ?? ((v) => v))(pick(k, i, j) as bigint)) }));
  });
}

/** Runs every case on the Wasm tier (`wasm` returns the callable of a method) and the JS tier (and `jdk`'s lines, when given); prints each disagreement.
 *  A case that reaches a compiler gap (`gapHits` grew) is blocked, not compared. */
export async function compare(cases: Case[], run: (m: MethodInfo) => (...a: any[]) => unknown,
  js: (cls: string, name: string, desc: string, args: unknown[], instance?: boolean) => Promise<unknown>, jdk?: string[], gapHits: unknown[] = []) {
  let bad = 0, explained = 0, threw = 0, blocked = 0;
  const fail = (what: string, c: Case, want: string, got: string) => { bad++; console.log(`MISMATCH ${what} ${c.m.cls}.${c.m.name}${c.m.desc}(${c.args.join(", ")}): ${want} vs ${got}`); };
  for (const [i, c] of cases.entries()) {
    const { m, args } = c, rk = retKind(m);
    const ref = jdk ? (jdk[i] === "throw" ? "throw" : fmt(rk, BigInt(jdk[i]))) : undefined;
    let wasm: string, tier: string;
    const seen = gapHits.length;
    try { wasm = result(m, run(m)(...args.map((a, j) => (paramsOf(m)[j] === "J" || paramsOf(m)[j] === "D" || typeof a !== "bigint" ? a : Number(a)))), (v) => BigInt(v as bigint)); } catch (e) { if (process.env.J2W_V) { const w = (globalThis as any).__dbgw, t = w?.throwable(e); console.log(m.name, t ? w.classNameOf(t) + " " + String((w.bridge.toHost(t) as any)[mangleField("java/lang/Throwable", "detailMessage")]) : String((e as Error)?.stack ?? e).slice(0, 2500)); }; wasm = "throw"; }
    try { tier = result(m, await js(m.cls, m.name, m.desc, args.map((a, j) => typeof a === "bigint" ? unbits(paramsOf(m)[j], a) : a), !m.isStatic), (v) => bitsOf(m.ret, v)); } catch (e) {
      // Bun's JSC words a negative typed-array length differently from V8, which runtime.ts maps to NegativeArraySizeException
      tier = /InternalError: length cannot be negative/.test(String(e)) && wasm !== "throw" ? (explained++, wasm) : "throw";
    }
    if (gapHits.length > seen) { blocked++; continue; }
    if (wasm === "throw") threw++;
    if (wasm !== tier) fail("wasm/js", c, `js=${tier}`, `wasm=${wasm}`);
    if (ref !== undefined) { if (wasm !== ref) fail("wasm/jdk", c, `jdk=${ref}`, `wasm=${wasm}`); if (tier !== ref) fail("js/jdk", c, `jdk=${ref}`, `js=${tier}`); }
  }
  return { bad, explained, threw, blocked };
}
