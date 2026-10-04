// bun build.ts <dex-or-jar...> --entry Cls.method(desc) ... -o out.wasm
import { readFileSync, writeFileSync } from "node:fs";
import { dexesIn, isDexEntry } from "../../../src/jvm/dex";
import { zipTree } from "../../../src/jvm/natives/jzip";
import { Program } from "./program";
import { Compiler, intrinsicFor } from "./j2w";
import { intrinsics, externs } from "./intrinsics";
import { Natives, type HostContext } from "./natives";
import type { MethodInfo } from "./program";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return Object.keys(zip).filter(isDexEntry).sort().flatMap((n) => dexesIn(zip[n], n));
}
/** what reach treats as a leaf: a method implemented without its bytecode */
export const isIntrinsic = (natives: Natives) => (m: MethodInfo) => !!intrinsicFor(intrinsics, natives, m);
const hostImports = (cx: Compiler, ctx: HostContext, gap: (id: number) => void) => ({ host: { fmod: (a: number, b: number) => a % b, gap }, ...cx.natives.imports(ctx) });
/** compiles with the js-string builtins, which a module of this compiler imports */
export const compileModule = (bytes: Uint8Array) => WebAssembly.compile(bytes, { builtins: ["js-string"] } as object);
/** a fresh instance: host functions bound, the string constants stored in its table */
export async function instantiate(module: WebAssembly.Module, cx: Compiler, gap: (id: number) => void = () => {}) {
  const ctx: HostContext = {}, instance = await WebAssembly.instantiate(module, hostImports(cx, ctx, gap) as never);
  const ex = instance.exports as Record<string, any>;
  ctx.tag = ex.jex; ctx.mkthrow = ex.mkthrow;
  cx.str.pool.forEach((s, i) => ex.strs.set(i, s));
  return instance;
}
export function program(paths: string[]) {
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
export function compile(src: string[] | Program, entries: [string, string, string][], natives?: Natives) {
  const prog = Array.isArray(src) ? program(src) : src;
  const cx = new Compiler(prog, { intrinsics, natives });
  const t0 = performance.now();
  const bytes = cx.build(entries);
  return { bytes, cx, ms: performance.now() - t0 };
}
if (import.meta.main) {
  const args = process.argv.slice(2); const out = args[args.indexOf("-o") + 1];
  const entries: [string, string, string][] = []; const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--entry") { const e = args[++i]; const m = /^(.*)\.(\w+)(\(.*)$/.exec(e)!; entries.push([m[1], m[2], m[3]]); }
    else if (args[i] === "-o") i++; else paths.push(args[i]);
  }
  const { bytes, cx, ms } = compile(paths, entries);
  writeFileSync(out, bytes);
  console.log(JSON.stringify({ bytes: bytes.length, ms: +ms.toFixed(1), methods: cx.stats.methods, unstructured: cx.stats.unstructured, nGaps: cx.gaps.size, gaps: [...cx.gaps.keys()].slice(0, 40), unresolved: [...cx.r.unresolved].slice(0, 40) }));
}
