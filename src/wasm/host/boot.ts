// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). Each realm (the page, every process frame) has a World over the tab's one platform build
// and platform Program; what is the realm's own is the app's dex files, its classes' statics and its heap.
import { mark } from "../../perf";
import { pageShared } from "../../shell/pageshared";
import { FetchStore } from "../link/aotstore";
import { rt, fieldNames } from "../../jvm/runtime";
import { useEntry, type Entry } from "../../jvm/natives/jentry";
import type { TierBackend } from "../../jvm/tier";
import { dexesIn, dexEntryNames, type DexFile } from "../../jvm/dex";
import { centralDir, entryBytes } from "../../jvm/natives/jzip";
import { vfs } from "../../shell/vfs";
import { Program } from "../compiler/program";
import { fetchPlatformJars, jarDexes } from "../../android/framework";
import { PLATFORM_JARS, hostWhole } from "../../jvm/provenance";
import { parkTimeout, unparkTimeout, turnElapsed, wakeSoon, yieldToLoop } from "../../jvm/yield";
import { World, type WorldOptions } from "../link/world";
import type { HostLoop } from "../link/sched";
import { externs, intrinsics } from "../link/intrinsics";
import { hostNet } from "./inet";
import { guestMemory } from "./guest";
import { wasmJni } from "./jni";
import { useJniVm } from "../../native/jnivm";
import { hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry";
import { natives, nativeSource } from "./nativesource";
import { bindWorld, count, heapUsed } from "./stats";
import { declareWaiting } from "./suspend";
import { prepareApp, type AppCode } from "./appcode";
import { prefetchInWorker } from "./aotload";
import { openPersist } from "./persist";
import type { WorkerPort } from "./compiler";
import { onProcessExit, processExited } from "../../process-exit";


/** what the JS heap of a tab, which every process's Java heap and the program models share, may grow by before an allocation fails */
const TAB_HEAP = 2048 * 1024 * 1024;

declare global { interface Window { __wdAot?: Promise<FetchStore | undefined>; __wdPlatformProgram?: Program } }

/** until the app's first frame, or this long, the hot methods are compiled by the worker only: what runs hot while a process starts is mostly run-once code */
let starting = typeof location !== "undefined";
const START_MS = 15_000;
if (starting) setTimeout(() => { starting = false; }, START_MS);

/** timers and turns of the event loop for threads that wait: the shell's own, so a thread's wait is a timed park an idle observer ignores and a yield keeps the main looper's order */
const hostLoop: HostLoop = {
  yield: (soon) => soon ? wakeSoon() : yieldToLoop(),
  due: () => turnElapsed() >= 8,
  after: (ms, fn) => { const id = parkTimeout(fn, ms); return () => unparkTimeout(id); },
};

/** a World over `prog`, with the registered natives and the host's resolver; `extra` is what the app's code adds (appcode.ts) */
export function createWorld(prog: Program, extra: Partial<WorldOptions> = {}): World {
  const w = new World(prog, { holdUpgrades: () => starting, intrinsics, natives, heapUsed, net: hostNet, loop: hostLoop, heapLimit: TAB_HEAP, hostWhole, guest: guestMemory, claim: (owner, handle) => rt.claimHandle?.(owner, handle), ...extra });
  bindWorld(w);
  w.onGap = (id) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${w.gapList[id]}`); };
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  return w;
}

/** The realm's World, over the platform build the tab opened and the platform Program its processes share; the app's dex files join it as they arrive. Outside a page (the
 *  harnesses under node) there is no build to fetch: the World is made when the first dex arrives and takes the platform's dex files as they are loaded. */
export async function bootWasmTier(): Promise<TierBackend> {
  let world: World | undefined, code: AppCode | undefined, platform: Program | undefined, store: FetchStore | undefined;
  let usage: (() => ReturnType<World["usage"]>) | undefined;
  const lifetime = new AbortController();
  const close = () => {
    lifetime.abort(); code?.close();
    if (usage) { store?.worlds.delete(usage); usage = undefined; }
  };
  onProcessExit(close);
  if (processExited()) close();
  if (typeof window !== "undefined") window.addEventListener("pagehide", close, { once: true });
  const appDexes: DexFile[] = [], opened = new Map<string, DexFile[] | undefined>();
  const dexes = (path: string) => openDexes(path, appDexes, opened);
  const install = (made: World) => {
    world = made;
    if (!lifetime.signal.aborted && store) { usage = () => made.usage(); store.worlds.add(usage); }
    mark("worldMade");
    code?.start(made);
    rt.mkThrowable = hostThrowable;
    rt.make = (cls) => { const spec = rt.natives.get(cls); return spec ? new spec.ctor() : hostObject(made, cls); };
    return made;
  };
  if (typeof location === "undefined") {
    const start = (made: World) => { useEntry(wasmEntry(install(made))); useJniVm(wasmJni(made)); fieldNames.find = fieldNamesOf(made); };
    return { loadDex(dex) { if (world) world.addDexes([dex]); else { const p = new Program([dex]); p.addExterns(externs); start(createWorld(p, { dexes })); } } };
  }
  // The hooks come first and the build is fetched after them: Java is not run before the tier is ready (the zygote waits for the app's code), and the page fetches the build while it
  // downloads the package
  const opening = Promise.all([openAot(), fetchPlatformJars()]);
  // The World is made when Java is first needed, so that the app's dex files are in its Program from the start: only then can the app build a previous launch saved be attached
  const current = (): World => {
    if (!platform) throw new Error("the Wasm tier is not ready");
    return world ?? install(createWorld(new Program(appDexes, platform), { aot: store, dexes, ...code?.options }));
  };
  let entry: Entry | undefined;
  const lazyEntry = (name: keyof Entry) => (...args: unknown[]) => ((entry ??= wasmEntry(current()))[name] as (...a: unknown[]) => unknown)(...args);
  useEntry(Object.fromEntries(ENTRY_NAMES.map((n) => [n, lazyEntry(n)])) as unknown as Entry);
  const lazy = <T extends object>(make: () => T): T => { let v: T | undefined; return new Proxy({} as T, { get: (_, k) => ((v ??= make()) as Record<PropertyKey, unknown>)[k] }); };
  useJniVm(lazy(() => wasmJni(current())));
  let names: ReturnType<typeof fieldNamesOf> | undefined;
  fieldNames.find = (cls, name) => (names ??= fieldNamesOf(current()))(cls, name);
  rt.mkThrowable = hostThrowable;
  rt.make = (cls) => { const spec = rt.natives.get(cls); return spec ? new spec.ctor() : hostObject(current(), cls); };
  const [aot, jars] = await opening;
  store = aot;
  platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  mark("platformReady");
  return {
    loadDex(dex, isPlatform) {
      if (isPlatform) return;
      appDexes.push(dex);
      world?.addDexes([dex]);
    },
    launched() { starting = false; if (world) code?.watch(world); },
    async appCode(roots) {
      if (world || !store || !appDexes.length) return;
      try {
        code = await prepareApp({ dexes: appDexes, aot: store, persist: await openPersist(), spawn: () => new Worker("/wasm-compile-worker.js", { type: "module" }) as unknown as WorkerPort, roots, signal: lifetime.signal });
      } catch (error) { if (processExited() || lifetime.signal.aborted) return; throw error; }
      if (lifetime.signal.aborted) { code.close(); return; }
      mark(code.hit ? "appCodeSaved" : "appCode");
      void code.made?.then(() => mark("appBuilt"), () => {});
      // the World is made while the build's modules are still arriving; no Java runs until they have
      current();
      await store.ready;
    },
  };
}
const ENTRY_NAMES = ["vcall", "scall", "newObj", "staticField", "linkInit", "linkClass", "initClass", "iof", "classNameOf", "callOn", "after"] as const satisfies readonly (keyof Entry)[];

/** the dex files of the archive at `path`, for the DexFile natives of class loaders: the app's own are the ones the World holds already, any other archive is read from the file system
 *  when its bytes are resident */
function openDexes(path: string, app: DexFile[], opened: Map<string, DexFile[] | undefined>): DexFile[] | undefined {
  if (!opened.has(path)) {
    const bytes = /^\/data\/app\/.*\.apk$/.test(path) && app.length ? null : vfs.readFile(path);
    opened.set(path, bytes === null ? app : bytes instanceof Uint8Array ? bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b ? dexesOf(bytes, path) : dexesIn(bytes, path) : undefined);
  }
  return opened.get(path);
}
const dexesOf = (zip: Uint8Array, label: string): DexFile[] => {
  const dir = centralDir(zip);
  return dexEntryNames(dir.keys()).flatMap((name) => dexesIn(entryBytes(zip, dir.get(name)!), `${label}:${name}`));
};

/** The platform build (scripts/wasm/aot-build.ts) the server holds for these sources, with the modules a start of the process loads compiled: fetched once by the tab,
 *  and the compiled modules are shared by the process frames, which are same-origin. Undefined when the server has no build for the sources, which leaves all code to
 *  the on-demand compiler. */
export function openAot(): Promise<FetchStore | undefined> {
  return pageShared("__wdAot", async () => {
    const current = await fetch("/aot/current.json");
    if (!current.ok) return undefined;
    const store = new FetchStore(`/aot/${(await current.json() as { key: string }).key}/`);
    const [, startup, waiting] = await Promise.all([store.fetchBytes("index.json"), store.fetchBytes("startup.json"), store.fetchBytes("waiting.json")]);
    // the natives the modules import as Suspending were chosen when the build was made
    declareWaiting(JSON.parse(new TextDecoder().decode(waiting)) as string[]);
    mark("aotIndex");
    store.ready = prefetchInWorker(store, JSON.parse(new TextDecoder().decode(startup)) as string[]).then(() => mark("aotOpened"));
    return store;
  });
}

/** The platform's Program, made by the first process of the tab from the boot class path's dexes and shared by the others: it is immutable, and each process extends it with
 *  its own dexes (`new Program(appDexes, platform)`), so the class model and class-hierarchy index of the 40,000 platform classes exist once per tab. */
export function platformProgram(dexes: () => DexFile[]): Program {
  return pageShared("__wdPlatformProgram", () => { const p = new Program(dexes()); p.addExterns(externs); return p; });
}
