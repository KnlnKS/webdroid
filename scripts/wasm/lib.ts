import { readFileSync } from "node:fs";
import { loadDexes } from "../dexes.ts";
import type { AotStore } from "../../src/wasm/link/aot.ts";
import type { AppCodeRequest } from "../../src/wasm/host/appcode.ts";
import { PLATFORM_PATHS } from "../aosp.ts";
import { dexesIn, dexesOfZip, type DexFile } from "../../src/jvm/dex.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { zipTree } from "../../src/zip.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { World, type WorldOptions } from "../../src/wasm/link/world.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { Natives } from "../../src/wasm/host/natives.ts";
import { useWorld, worldOptions } from "../../src/wasm/host/boot.ts";

/** the platform build under `key` at `base`, as prepareApp sees it, without its files */
export const fakeAot = (base: string, key: string): AppCodeRequest["aot"] => ({ base, key, bytes: () => undefined });
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aot-build.ts) in <dir> */
const AOT = typeof process === "undefined" ? (globalThis as { G1_AOT?: string }).G1_AOT : process.env.WEBDROID_AOT;
/** a page fetches the build as the app does (g1run.ts makes G1_STORE); node reads the files */
const aotStore = (dir: string): AotStore => (globalThis as { G1_STORE?: AotStore }).G1_STORE ?? { get: (file) => new Uint8Array(readFileSync(`${dir}/${file}`)) };
const PLATFORM = new Set(PLATFORM_PATHS);
/** a Program over the dex and jar files at `paths`. A platform build numbers its code by every platform class, so under WEBDROID_AOT the platform
 *  jars among `paths` stand for all of them, in class path order ahead of the other paths. */
export function program(paths: string[]) {
  if (AOT && paths.some((p) => PLATFORM.has(p))) paths = [...PLATFORM_PATHS, ...paths.filter((p) => !PLATFORM.has(p))];
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
/** the dex files of the jar or dex file the VFS holds at `path`, for DexFile.openDexFileNative; none for a file without any (a jar of resources) */
function vfsDexes(path: string): DexFile[] | undefined {
  const bytes = vfs.readFile(path);
  if (!(bytes instanceof Uint8Array)) return undefined;
  const dexes = path.endsWith(".dex") ? dexesIn(bytes, path) : dexesOfZip(zipTree(bytes));
  return dexes.length ? dexes : undefined;
}
/** `w` made the realm's Java now and whenever its entries are called: the objects natives make are the current World's */
export function current(w: World): World {
  useWorld(w);
  const { entry, entryAsync } = w;
  w.entry = (...a) => { const f = entry.apply(w, a); return (...args) => f(...(useWorld(w), args)); };
  w.entryAsync = (...a) => { const f = entryAsync.apply(w, a); return (...args) => f(...(useWorld(w), args)); };
  return w;
}
/** a current World over `src` (dex and jar paths, or a Program) */
export function world(src: string[] | Program, opts: Partial<WorldOptions> = {}) {
  return current(new World(Array.isArray(src) ? program(src) : src, { ...worldOptions(), natives: new Natives(), dexes: vfsDexes, collect: () => (globalThis as { gc?: () => void }).gc?.(), ...(AOT && { aot: aotStore(AOT) }), ...opts }));
}
