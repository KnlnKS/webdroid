import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AotStore } from "../../src/wasm/link/aot";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { dexesIn, isDexEntry } from "../../src/jvm/dex";
import { zipTree } from "../../src/jvm/natives/jzip";
import { Program } from "../../src/wasm/compiler/program";
import { World, type WorldOptions } from "../../src/wasm/link/world";
import { intrinsics, externs } from "../../src/wasm/link/intrinsics";
import { intrinsicFor } from "../../src/wasm/compiler/j2w";
import type { NativeBinder } from "../../src/wasm/link/hostapi";
import { Natives } from "../../src/wasm/host/natives";
import { hostNet } from "../../src/wasm/host/inet";
import { heapUsed } from "../../src/wasm/host/stats";
import type { MethodInfo } from "../../src/wasm/compiler/program";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return Object.keys(zip).filter(isDexEntry).sort().flatMap((n) => dexesIn(zip[n], n));
}
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aot-build.ts) in <dir> */
const AOT = typeof process === "undefined" ? (globalThis as { G1_AOT?: string }).G1_AOT : process.env.WEBDROID_AOT;
/** a page may have compiled modules ahead (g1.ts): they are in G1_MODULES by path */
const aotStore = (dir: string): AotStore => ({ get: (file) => (globalThis as { G1_MODULES?: Record<string, WebAssembly.Module> }).G1_MODULES?.[join(dir, file)] ?? new Uint8Array(readFileSync(join(dir, file))) });
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
export const isIntrinsic = (natives: NativeBinder) => (m: MethodInfo) => !!intrinsicFor(intrinsics, natives, m);
export function world(src: string[] | Program, opts: Partial<WorldOptions> = {}) {
  return new World(Array.isArray(src) ? program(src) : src, { intrinsics, natives: new Natives(), heapUsed, net: hostNet, ...(AOT && { aot: aotStore(AOT) }), ...opts });
}
