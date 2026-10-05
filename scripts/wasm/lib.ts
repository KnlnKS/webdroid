import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AotStore } from "../../src/wasm/link/aot";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { dexesIn, dexEntryNames, type DexFile } from "../../src/jvm/dex";
import { vfs } from "../../src/shell/vfs";
import { zipTree } from "../../src/jvm/natives/jzip";
import { Program } from "../../src/wasm/compiler/program";
import { World, type WorldOptions } from "../../src/wasm/link/world";
import { intrinsics, externs } from "../../src/wasm/link/intrinsics";
import { intrinsicFor } from "../../src/wasm/compiler/j2w";
import type { NativeBinder } from "../../src/wasm/link/hostapi";
import { Natives } from "../../src/wasm/host/natives";
import { hostNet } from "../../src/wasm/host/inet";
import { guestMemory } from "../../src/wasm/host/guest";
import { heapUsed } from "../../src/wasm/host/stats";
import type { MethodInfo } from "../../src/wasm/compiler/program";

export function loadDexes(path: string) {
  const bytes = new Uint8Array(readFileSync(path));
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes);
  return dexEntryNames(Object.keys(zip)).flatMap((n) => dexesIn(zip[n], n));
}
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aot-build.ts) in <dir> */
const AOT = typeof process === "undefined" ? (globalThis as { G1_AOT?: string }).G1_AOT : process.env.WEBDROID_AOT;
/** a page fetches the build as the app does (g1run.ts makes G1_STORE); node reads the files */
const aotStore = (dir: string): AotStore => (globalThis as { G1_STORE?: AotStore }).G1_STORE ?? { get: (file) => new Uint8Array(readFileSync(join(dir, file))) };
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
/** the dex files of the jar or dex file the VFS holds at `path`, for DexFile.openDexFileNative; none for a file without any (a jar of resources) */
function vfsDexes(path: string): DexFile[] | undefined {
  const bytes = vfs.readFile(path);
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes), names = dexEntryNames(Object.keys(zip));
  return names.length ? names.flatMap((n) => dexesIn(zip[n], n)) : undefined;
}
export function world(src: string[] | Program, opts: Partial<WorldOptions> = {}) {
  return new World(Array.isArray(src) ? program(src) : src, { intrinsics, natives: new Natives(), heapUsed, dexes: vfsDexes, collect: () => (globalThis as { gc?: () => void }).gc?.(), net: hostNet, guest: guestMemory, ...(AOT && { aot: aotStore(AOT) }), ...opts });
}
