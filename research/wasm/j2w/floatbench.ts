// G1 sub-question: do float values belong in f32/f64 locals, or in i32/i64 bits with a reinterpret around every operation (what the compiler
// emits today)? Builds the same DEX-shaped loop both ways and times it in V8 under each tier. Run: bun floatbench.ts (needs node)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModuleBuilder, T } from "./wasmbin";
import { Code, OP } from "./code";

// double kernel: for (i = 0; i < n; i++) { x = i * 0.5; s = s + x * x - s * 0.001 } return s      (the same for float with f32 ops)
function kernel(native: boolean, wide: boolean): Uint8Array {
  const mb = new ModuleBuilder(), W = wide ? T.f64 : T.f32, B = wide ? T.i64 : T.i32;
  const f = mb.addFunc(mb.addFuncType([T.i32], [native ? W : B]), [], "k");
  const c = new Code(1), i = c.newLocal(T.i32), s = c.newLocal(native ? W : B), x = c.newLocal(native ? W : B);
  const to = native ? () => {} : () => c.raw(wide ? OP.f64_reinterpret_i64 : OP.f32_reinterpret_i32), from = native ? () => {} : () => c.raw(wide ? OP.i64_reinterpret_f64 : OP.i32_reinterpret_f32);
  const get = (l: number) => { c.lget(l); to(); };
  const lit = (v: number) => { wide ? c.raw(0x44, ...new Uint8Array(new Float64Array([v]).buffer)) : c.raw(0x43, ...new Uint8Array(new Float32Array([v]).buffer)); };
  const conv = wide ? OP.f64_convert_i32_s : OP.f32_convert_i32_s, [add, sub, mul] = wide ? [OP.f64_add, OP.f64_sub, OP.f64_mul] : [OP.f32_add, OP.f32_sub, OP.f32_mul];
  c.block().loop().lget(i).lget(0).raw(OP.i32_ge_s).brIf(1);
  c.lget(i).raw(conv); lit(0.5); c.raw(mul); from(); c.lset(x);
  get(s); get(x); get(x); c.raw(mul, add); get(s); lit(0.001); c.raw(mul, sub); from(); c.lset(s);
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().lget(s);
  mb.setBody(f, c.finish()); mb.export("k", "func", f);
  return mb.build();
}
const dir = mkdtempSync(join(tmpdir(), "fb-"));
const files: string[] = [];
for (const wide of [false, true]) for (const native of [false, true]) { const p = join(dir, `${wide ? "f64" : "f32"}-${native ? "native" : "bits"}.wasm`); writeFileSync(p, kernel(native, wide)); files.push(p); }
writeFileSync(join(dir, "run.mjs"), `
import { readFileSync } from "node:fs";
for (const p of process.argv.slice(2)) {
  const { instance } = await WebAssembly.instantiate(readFileSync(p));
  const k = instance.exports.k, times = [];
  for (let r = 0; r < 6; r++) { const t = performance.now(); k(30_000_000); times.push(performance.now() - t); }
  console.log(p.split("/").pop().padEnd(18), "first call", times[0].toFixed(0).padStart(5), "ms, best later", Math.min(...times.slice(1)).toFixed(0).padStart(5), "ms");
}`);
for (const [name, flags] of [["default tiering", []], ["Liftoff only", ["--liftoff-only"]], ["TurboFan only", ["--no-liftoff"]]] as const) {
  console.log(name);
  const r = Bun.spawnSync(["node", ...flags, join(dir, "run.mjs"), ...files]);
  console.log(r.stdout.toString() + r.stderr.toString());
}
