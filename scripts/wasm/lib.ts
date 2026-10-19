import { readFileSync } from "node:fs";
import { dexesFrom } from "../dexes.ts";
import type { AotStore } from "../../src/wasm/link/aot.ts";
import type { AppCodeRequest } from "../../src/wasm/host/appcode.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { dexesIn, dexEntryNames, type DexFile } from "../../src/jvm/dex.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { zipTree } from "../../src/jvm/natives/jzip.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { World, type WorldOptions } from "../../src/wasm/link/world.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { Natives } from "../../src/wasm/host/natives.ts";
import { useWorld, worldOptions } from "../../src/wasm/host/boot.ts";

/** the platform build under `key` at `base`, as prepareApp sees it, without its files */
export const fakeAot = (base: string, key: string): AppCodeRequest["aot"] => ({ base, key, bytes: () => undefined });
export function loadDexes(path: string) {
  return dexesFrom(new Uint8Array(readFileSync(path)), path);
}
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aot-build.ts) in <dir> */
const AOT = typeof process === "undefined" ? (globalThis as { G1_AOT?: string }).G1_AOT : process.env.WEBDROID_AOT;
/** a page fetches the build as the app does (g1run.ts makes G1_STORE); node reads the files */
const aotStore = (dir: string): AotStore => (globalThis as { G1_STORE?: AotStore }).G1_STORE ?? { get: (file) => new Uint8Array(readFileSync(`${dir}/${file}`)) };
export function program(paths: string[]) {
  // precompiled code is numbered by the platform's classes, so all of them come first, in class path order, before the app's
  const platform = (p: string) => p.includes("/vendor/aosp/");
  if (AOT) {
    const root = paths.find(platform)?.split("/vendor/aosp/")[0];
    if (root) paths = [...PLATFORM_JARS.map((j) => `${root}/vendor/aosp/${j}`), ...paths.filter((p) => !platform(p))];
  }
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
/** the dex files of the jar or dex file the VFS holds at `path`, for DexFile.openDexFileNative; none for a file without any (a jar of resources) */
function vfsDexes(path: string): DexFile[] | undefined {
  const bytes = vfs.readFile(path);
  if (!(bytes instanceof Uint8Array)) return undefined;
  if (path.endsWith(".dex")) return dexesIn(bytes, path);
  const zip = zipTree(bytes), names = dexEntryNames(Object.keys(zip));
  return names.length ? names.flatMap((n) => dexesIn(zip[n], n)) : undefined;
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
