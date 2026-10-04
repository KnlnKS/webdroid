import { readFileSync } from "node:fs";
import { dexesIn, isDexEntry } from "../../../src/jvm/dex";
import { zipTree } from "../../../src/jvm/natives/jzip";
import { Program } from "./program";
import { World, type WorldOptions } from "./lazy";
import { intrinsics, externs } from "./intrinsics";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return Object.keys(zip).filter(isDexEntry).sort().flatMap((n) => dexesIn(zip[n], n));
}
export function program(paths: string[]) {
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
export function world(src: string[] | Program, opts: Partial<WorldOptions> = {}) {
  return new World(Array.isArray(src) ? program(src) : src, { intrinsics, ...opts });
}
if (import.meta.main) {
  // bun build.ts <dex-or-jar...> --entry Cls.method(desc) ...: run the entries and print the compile statistics
  const args = process.argv.slice(2), entries: string[] = [], paths: string[] = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === "--entry") entries.push(args[++i]); else paths.push(args[i]); }
  const w = world(paths);
  for (const e of entries) {
    const m = /^(.*)\.(\w+)(\(.*)$/.exec(e)!;
    console.log(e, "=>", w.entry(m[1], m[2], m[3])());
  }
  console.log(JSON.stringify({ ...w.stats, gaps: w.gapList.slice(0, 40) }));
}
