import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AotStore } from "./aot";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { dexesIn, isDexEntry } from "../../../src/jvm/dex";
import { zipTree } from "../../../src/jvm/natives/jzip";
import { Program } from "./program";
import { World, type WorldOptions } from "./lazy";
import { intrinsics, externs } from "./intrinsics";
import { intrinsicFor } from "./j2w";
import type { Natives } from "./natives";
import type { MethodInfo } from "./program";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return Object.keys(zip).filter(isDexEntry).sort().flatMap((n) => dexesIn(zip[n], n));
}
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aotbuild.ts) in <dir> */
const AOT = typeof process === "undefined" ? (globalThis as { G1_AOT?: string }).G1_AOT : process.env.WEBDROID_AOT;
export const aotStore = (dir: string): AotStore => ({ get: (file) => new Uint8Array(readFileSync(join(dir, file))) });
export function program(paths: string[]) {
  // precompiled code is numbered by the platform's classes, so all of them come first, in class path order, before the app's
  const platform = (p: string) => p.includes("/vendor/aosp/");
  if (AOT) {
    const root = paths.find(platform)?.split("/vendor/aosp/")[0];
    if (root) paths = [...PLATFORM_JARS.map((j) => join(root, "vendor/aosp", j)), ...paths.filter((p) => !platform(p))];
  }
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
/** what reach treats as a leaf: a method implemented without its bytecode */
export const isIntrinsic = (natives: Natives) => (m: MethodInfo) => !!intrinsicFor(intrinsics, natives, m);
export function world(src: string[] | Program, opts: Partial<WorldOptions> = {}) {
  return new World(Array.isArray(src) ? program(src) : src, { intrinsics, ...(AOT && { aot: aotStore(AOT) }), ...opts });
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
