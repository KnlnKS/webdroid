// Argument generation and the Wasm-vs-JDK comparison shared by the differential harnesses.
import { mangleField } from "../../src/jvm/abi.ts";
import { kindOf, type MethodInfo } from "../../src/wasm/compiler/program.ts";
import { db, fb, fmt } from "./harness.ts";

const pool: Record<string, bigint[]> = {
  I: [0, 1, -1, 2, 3, 5, 7, 9, 10, 16, 31, 32, 33, 36, 48, 57, 63, 64, 65, 90, 97, 100, 122, 255, 65536, 123456789, 0x7fffffff, -0x80000000].map(BigInt),
  J: [0n, 1n, -1n, 3n, 0x7fffffffn, -0x80000000n, 123456789012345n, (1n << 63n) - 1n, -(1n << 63n)],
  F: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(fb),
  D: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, 1e300, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(db),
};
/** values a sub-int parameter can hold, so both sides see the same legal input */
const narrow: Record<string, (v: bigint) => bigint> = { Z: (v) => v & 1n, B: (v) => BigInt.asIntN(8, v), S: (v) => BigInt.asIntN(16, v), C: (v) => BigInt.asUintN(16, v) };
const kindOfParam = (p: string) => (p === "F" || p === "D" ? p : kindOf(p));
const retKind = (m: MethodInfo) => (m.ret === "F" || m.ret === "D" ? m.ret : "I");

export type Case = { m: MethodInfo; args: bigint[] };
/** a case as the line the JDK's Ref runs */
export const caseLine = (c: Case) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`;
/** `small` lists the arguments of single-int-parameter methods whose cost grows with the argument */
export function genCases(methods: MethodInfo[], small: Record<string, number[]> = {}, perMethod = 40): Case[] {
  return methods.flatMap((m) => {
    if (Object.hasOwn(small, m.name)) return small[m.name].map((n) => ({ m, args: [BigInt(n)] }));
    const ks = m.params.map(kindOfParam), pick = (k: string, i: number, j: number) => pool[k][(i * (j + 3) + j * 5 + (i >> 2)) % pool[k].length];
    return Array.from({ length: perMethod }, (_, i) => ({ m, args: ks.map((k, j) => (narrow[m.params[j]] ?? ((v) => v))(pick(k, i, j))) }));
  });
}

/** Runs every case on the Wasm tier (`run` returns the callable of a method) against `jdk`'s line for it; prints each disagreement.
 *  A case that reaches a compiler gap (`gapHits` grew) is blocked, not compared. */
export async function compare(cases: Case[], run: (m: MethodInfo) => (...a: any[]) => unknown, jdk: string[], gapHits: unknown[] = []) {
  let bad = 0, threw = 0, blocked = 0;
  for (const [i, { m, args }] of cases.entries()) {
    const want = jdk[i] === "throw" ? "throw" : fmt(retKind(m), BigInt(jdk[i])), seen = gapHits.length;
    let wasm: string;
    try { wasm = fmt(retKind(m), BigInt(await run(m)(...args.map((a, j) => (m.params[j] === "J" || m.params[j] === "D" ? a : Number(a)))) as bigint)); } catch (e) {
      if (process.env.J2W_V) { const w = (globalThis as any).__dbgw, t = w?.throwable(e); console.log(m.name, t ? w.classNameOf(t) + " " + String((w.bridge.toHost(t) as any)[mangleField("java/lang/Throwable", "detailMessage")]) : String((e as Error)?.stack ?? e).slice(0, 2500)); }
      wasm = "throw";
    }
    if (gapHits.length > seen) { blocked++; continue; }
    if (wasm === "throw") threw++;
    if (wasm !== want) { bad++; console.log(`MISMATCH ${m.cls}.${m.name}${m.desc}(${args.join(", ")}): jdk=${want} wasm=${wasm}`); }
  }
  return { bad, threw, blocked };
}
