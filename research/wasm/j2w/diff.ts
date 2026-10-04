// Differential test: every static method of W.java runs as Wasm (this compiler) and on the JDK; results must be bit-identical.
// Needs javac, d8 and java on PATH. Run: bun diff.ts [method-name-filter]
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, loadDexes } from "./build";
import { Program, kindOf } from "./program";
import { parseMethodDesc } from "../../../src/jvm/abi";

const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(here, "java/W.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--output", out, join(out, "W.class")]);

const dex = join(out, "classes.dex");
const methods = new Program(loadDexes(dex)).require("W").methods.filter((m) => m.isStatic && m.codeOff);
const { bytes, cx } = compile([dex], methods.map((m) => ["W", m.name, m.desc]));
if (cx.stats.unresolved.length || cx.stats.unstructured) throw new Error("compile gaps: " + JSON.stringify(cx.stats));
const { instance } = await WebAssembly.instantiate(bytes, { host: { fmod: (a: number, b: number) => a % b } });

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer), f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const fb = (x: number) => (f32[0] = x, BigInt(u32[0] | 0)), db = (x: number) => (f64[0] = x, BigInt.asIntN(64, u64[0]));
const pool: Record<string, bigint[]> = {
  I: [0, 1, -1, 2, 3, 5, 7, 31, 32, 33, 63, 64, 100, 255, 65536, 123456789, 0x7fffffff, -0x80000000].map(BigInt),
  J: [0n, 1n, -1n, 3n, 0x7fffffffn, -0x80000000n, 123456789012345n, (1n << 63n) - 1n, -(1n << 63n)],
  F: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(fb),
  D: [0, -0, 1, -1, 0.5, 3.5, 1e10, -1e10, 1e300, NaN, Infinity, -Infinity, 3e9, -3e9, 40000.7].map(db),
};
const small: Record<string, number[]> = {
  fib: [0, 1, 2, 10, 20], sieve: [0, 1, 2, 10, 1000, 100000], xorshift: [0, 1, 10, 1000], mandel: [0, 1, 5, 24], swsum: [0, 1, 7, 100, 1000],
  floats: [0, 1, 10, 1000, 100000], collatz: [1, 2, 3, 27, 1000], nested: [0, 1, 5, 12, 30], mix: [0, 1, 10, 1000], arrays: [0, 1, 5, 100], objs: [0, 1, 5, 100], tryNeg: [-1, 0, 5, -100],
};
const kindOfParam = (p: string) => (p === "F" || p === "D" ? p : kindOf(p));

type Case = { m: (typeof methods)[number]; args: bigint[] };
const cases: Case[] = [];
const only = process.argv[2];
for (const m of methods) {
  if (only && !m.name.includes(only)) continue;
  const ks = m.params.map(kindOfParam);
  if (small[m.name]) for (const n of small[m.name]) cases.push({ m, args: [BigInt(n)] });
  else for (let i = 0; i < 40; i++) cases.push({ m, args: ks.map((k, j) => pool[k][(i * (j + 3) + j * 5 + (i >> 2)) % pool[k].length]) });
}

const fmt = (k: string, v: bigint) => {
  if (k === "F") { u32[0] = Number(BigInt.asUintN(32, v)); return isNaN(f32[0]) ? "NaN" : String(v); }
  if (k === "D") { u64[0] = BigInt.asUintN(64, v); return isNaN(f64[0]) ? "NaN" : String(v); }
  return String(v);
};
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `W.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
let bad = 0;
cases.forEach(({ m, args }, i) => {
  const rk = m.ret === "F" || m.ret === "D" ? m.ret : "I", want = jdk[i] === "throw" ? "throw" : fmt(rk, BigInt(jdk[i]));
  const wasmArgs = args.map((a, j) => (m.params[j] === "J" || m.params[j] === "D" ? a : Number(a)));
  let got: string;
  try { got = fmt(rk, BigInt((instance.exports as any)[`W.${m.name}`](...wasmArgs))); } catch { got = "throw"; }
  if (got !== want) { bad++; console.log(`MISMATCH W.${m.name}(${args.join(", ")}): jdk=${want} wasm=${got}`); }
});
console.log(`${cases.length - bad}/${cases.length} cases match across ${methods.length} methods`);
process.exit(bad ? 1 : 0);
