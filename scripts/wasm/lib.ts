import { readFileSync } from "node:fs";
import "../../src/natives.ts";
import { loadDexes } from "../dexes.ts";
import type { AotStore } from "../../src/wasm/link/aot.ts";
import type { AppCodeRequest } from "../../src/wasm/host/appcode.ts";
import { AOSP, PLATFORM_PATHS } from "../aosp.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { dexesIn, dexesOfZip, type DexFile } from "../../src/jvm/dex.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { zipTree } from "../../src/zip.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { World, type WorldOptions } from "../../src/wasm/link/world.ts";
import { externs, intrinsics } from "../../src/wasm/link/intrinsics.ts";
import { Natives } from "../../src/wasm/host/natives.ts";
import { attachHostClasses, natives } from "../../src/wasm/host/nativesource.ts";
import { serveCompile, type CompileEnv } from "../../src/wasm/host/compile-serve.ts";
import type { WorkerPort } from "../../src/wasm/host/compiler.ts";
import { heapUsed } from "../../src/wasm/host/stats.ts";
import { platformProgram, useWorld, worldOptions } from "../../src/wasm/host/boot.ts";

/** the platform build under `key` at `base`, as prepareApp sees it, without its files */
export const fakeAot = (base: string, key: string): AppCodeRequest["aot"] => ({ base, key, bytes: () => undefined });
/** WEBDROID_AOT=<dir> runs the harnesses over the precompiled platform assets (aot-build.ts) in <dir> */
const AOT = globalThis.process?.env.WEBDROID_AOT;
const PLATFORM = new Set(PLATFORM_PATHS);
/** a Program over the dex and jar files at `paths`. A platform build numbers its code by every platform class, so under WEBDROID_AOT the platform
 *  jars among `paths` stand for all of them, in class path order ahead of the other paths. */
export function program(paths: string[]) {
  if (AOT && paths.some((p) => PLATFORM.has(p))) paths = [...PLATFORM_PATHS, ...paths.filter((p) => !PLATFORM.has(p))];
  const prog = new Program(paths.flatMap(loadDexes)); prog.addExterns(externs);
  return prog;
}
const read = new Map<string, DexFile[]>();
/** the dex files of the boot class path's `jars` in `aosp` (the checkout's), each jar read once: those the platform Program holds */
export const platformDexes = (jars: readonly string[] = PLATFORM_JARS, aosp = AOSP): DexFile[] =>
  jars.flatMap((jar) => read.get(`${aosp}/${jar}`) ?? read.set(`${aosp}/${jar}`, loadDexes(`${aosp}/${jar}`)).get(`${aosp}/${jar}`)!);
/** the platform's Program over all of them, made once as the tier makes it */
export const platform = (aosp = AOSP): Program => platformProgram(() => platformDexes(PLATFORM_JARS, aosp));

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
/** a current World over `src` (dex and jar paths, or a Program) as a realm makes one (boot.ts createWorld): with the registered natives, the build in WEBDROID_AOT,
 *  and the classes the host implements added after it is made. These change the World's Program, so a World over a Program another World has (or a platform
 *  build's) takes `hostClasses: false`. A `bare` World has neither natives nor host classes. */
export function world(src: string[] | Program, { bare, hostClasses = !bare, ...opts }: Partial<WorldOptions> & { bare?: boolean; hostClasses?: boolean } = {}) {
  const w = current(new World(Array.isArray(src) ? program(src) : src, { ...worldOptions(), ...bare && { natives: new Natives() }, dexes: vfsDexes,
    collect: () => (globalThis as { gc?: () => void }).gc?.(), ...AOT && { aot: { get: (file) => new Uint8Array(readFileSync(`${AOT}/${file}`)) } satisfies AotStore }, ...opts }));
  return hostClasses ? attachHostClasses(w) : w;
}

/** what a compile worker over the platform build in `dir`, which the World names `base`, is given (compile-serve.ts) */
export const compileEnv = (dir: string, base: string): CompileEnv => ({ platform: async () => platformDexes(), natives, intrinsics, externs, heapUsed,
  fetchBytes: async (url) => new Uint8Array(readFileSync(`${dir}/${url.slice(base.length)}`)) });
/** a compile worker over a MessageChannel in this thread, serving `env`; `received` sees the type of each request it is sent */
export function inThreadCompiler(env: CompileEnv, received?: (type: string) => void): WorkerPort {
  const { port1, port2 } = new MessageChannel();
  if (received) port2.addEventListener("message", ({ data }) => received(data.type));
  serveCompile(port2 as never, env);
  return { postMessage: (m, t) => port1.postMessage(m, t as never), set onmessage(f) { port1.onmessage = f as never; }, get onmessage() { return port1.onmessage as never; },
    onerror: null, terminate: () => { port1.close(); port2.close(); } };
}
