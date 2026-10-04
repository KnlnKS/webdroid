// bun build.ts <dex-or-jar...> --entry Cls.method(desc) ... -o out.wasm
import { readFileSync, writeFileSync } from "node:fs";
import { dexesIn, isDexEntry } from "../../../src/jvm/dex";
import { zipTree } from "../../../src/jvm/natives/jzip";
import { Program } from "./program";
import { Compiler } from "./j2w";
import { intrinsics, externs } from "./intrinsics";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return Object.keys(zip).filter(isDexEntry).sort().flatMap((n) => dexesIn(zip[n], n));
}
export function compile(paths: string[], entries: [string, string, string][]) {
  const dexes = paths.flatMap(loadDexes);
  const prog = new Program(dexes); prog.addExterns(externs);
  const cx = new Compiler(prog, { intrinsics });
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
  console.log(JSON.stringify({ bytes: bytes.length, ms: +ms.toFixed(1), methods: cx.stats.methods, unstructured: cx.stats.unstructured, unresolved: cx.stats.unresolved.slice(0, 40), nUnresolved: cx.stats.unresolved.length }));
}
