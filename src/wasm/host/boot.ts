// The Wasm tier's entry (src/jvm/tier.ts loads it). Each realm (the page, every process Worker) has a World over the platform build
// and platform Program; what is the realm's own is the app's dex files, its classes' statics and its heap.
import { mark } from "../../perf";
import { note } from "../../timeline";
import { FetchStore } from "../link/aotstore";
import { rt, fieldNames } from "../../jvm/runtime";
import { useEntry, type Entry } from "../../jvm/natives/jentry";
import { appArchives } from "../../jvm/natives/jdex";
import type { TierBackend } from "../../jvm/tier";
import { dexesIn, dexEntryNames, type DexFile } from "../../jvm/dex";
import { centralDir, entryBytes } from "../../jvm/natives/jzip";
import { vfs } from "../../shell/vfs";
import { packedArchives } from "../../shell/packedarchive";
import { Program } from "../compiler/program";
import { fetchPlatformJars, jarDexes } from "../../android/framework";
import { PLATFORM_JARS, hostWhole } from "../../jvm/provenance";
import { parkTimeout, unparkTimeout, turnElapsed, wakeSoon, yieldToLoop, yieldStats, sinceInput } from "../../jvm/yield";
import { World, type WorldOptions } from "../link/world";
import type { HostLoop } from "../link/sched";
import type { Numbering } from "../link/aot";
import { externs, intrinsics } from "../link/intrinsics";
import { hostNet } from "./inet";
import { guestMemory } from "./guest";
import { wasmJni } from "./jni";
import { useJniVm } from "../../native/jnivm";
import { wasmBox } from "../../jvm/natives/jbox";
import { boxRef, classRef, hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry";
import { hostSpec, natives, nativeSource } from "./nativesource";
import { wasmThreadStates, bindWorld, count, heapUsed } from "./stats";
import { declareWaiting } from "./suspend";
import { prepareApp, type AppCode, type Built } from "./appcode";
import { prefetchInWorker, serveStore } from "./aotload";
import { openPersist } from "./persist";
import { COMPILE_WORKER_URL, spawnCompileWorker, type CompileClient } from "./compiler";
import { onProcessExit, processExited } from "../../process-exit";

/** what the JS heap of a tab, which every process's Java heap and the program models share, may grow by before an allocation fails */
const TAB_HEAP = 2048 * 1024 * 1024;

/** the Wasm tier's code status, where a harness reads it: a page's window or a process Worker's global */
type WasmStatus = { stats: World["stats"]; worker?: CompileClient["stats"]; appSaved?: boolean; appSource?: AppCode["source"]; appPersisted?: () => Promise<boolean>; appAttached?: boolean; appRejected?: string; appBuilds?: Built[]; appSettle?: () => Promise<Built | undefined>; aotKey?: string; called?: () => string[]; demandMark?: () => number[]; demandSince?: (mark: number[]) => [string, boolean, boolean, boolean][] };
declare global {
  var __wdWasm: WasmStatus | undefined;
  /** the realm's AOT store, which a diagnostic reads without opening it (shell/aot-profile.ts) */
  var __wdAot: Promise<FetchStore | undefined> | undefined;
  interface Window { __wdWasm?: WasmStatus }
}

/** until the app's first frame, or this long, the hot methods are compiled by the worker only: what runs hot while a process starts is mostly run-once code */
let starting = typeof location !== "undefined";
const START_MS = 15_000;
/** a slice of idle time spent compiling ahead (World.ahead): an input that arrives meanwhile waits no longer than this */
const AHEAD_SLICE_MS = 4, AHEAD_AFTER_INPUT_MS = 1000;
let aheading = false;

/** timers and turns of the event loop for threads that wait: the shell's own, so a thread's wait is a timed park an idle observer ignores and a yield keeps the main looper's order */
const hostLoop: HostLoop = {
  yield: (soon) => soon ? wakeSoon() : yieldToLoop(),
  due: () => turnElapsed() >= 8,
  after: (ms, fn) => { const id = parkTimeout(fn, ms); return () => unparkTimeout(id); },
};

/** a World over `prog`, with the registered natives and the host's resolver; `extra` is what the app's code adds (appcode.ts) */
function createWorld(prog: Program, extra: Partial<WorldOptions> = {}): World {
  const w = new World(prog, { holdUpgrades: () => starting, intrinsics, natives, heapUsed, net: hostNet, loop: hostLoop, heapLimit: TAB_HEAP, hostWhole, guest: guestMemory, note: note as (ev: number, arg?: number) => void, claim: (owner, handle) => rt.claimHandle?.(owner, handle), ...extra });
  bindWorld(w);
  globalThis.__wdWasm = { stats: w.stats, demandMark: () => w.demandMark(), demandSince: (mark) => w.demandSince(mark) };
  w.onGap = (id) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${w.gapList[id]}`); };
  // the class a site cannot link is noted as missing
  w.onUnresolved = (message, cls) => rt.noteMissing(cls ? "class " + cls : message);
  // the frames of Java code: a method the host implements is not one
  rt.javaFrames = () => w.callerFrames(16).filter((f) => w.prog.get(f.cls.replace(/\./g, "/"))?.dex !== null).map((f) => f.cls + "." + f.method);
  rt.userClassLoader = () => {
    for (const f of w.callerFrames(Infinity)) { const loader = w.prog.loaderOf(f.cls.replace(/\./g, "/")); if (loader !== w.prog.boot) return loader.object; }
    return null;
  };
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  rt.registered = (spec) => w.addHostClass(hostSpec(spec));
  return w;
}

/** The realm's World, over the platform build the tab opened and the platform Program its processes share; the app's dex files join it as they arrive. Outside a page (the
 *  harnesses under node) there is no build to fetch: the World is made when the first dex arrives and takes the platform's dex files as they are loaded. */
export async function bootWasmTier(): Promise<TierBackend> {
  let world: World | undefined, code: AppCode | undefined, platform: Program | undefined, store: FetchStore | undefined;
  const threads = () => world ? wasmThreadStates(world) : [];
  let usage: (() => ReturnType<World["usage"]>) | undefined;
  const lifetime = new AbortController();
  const close = () => {
    lifetime.abort(); code?.close();
    if (usage) { store?.worlds.delete(usage); usage = undefined; }
  };
  onProcessExit(close);
  if (processExited()) close();
  if (typeof window !== "undefined") window.addEventListener("pagehide", close, { once: true });
  const appDexes: DexFile[] = [], opened = new Map<string, DexFile[] | undefined | Promise<DexFile[] | undefined>>();
  const dexes = (path: string) => openDexes(path, appDexes, opened);
  const install = (made: World) => {
    world = made;
    if (!lifetime.signal.aborted && store) { usage = () => made.usage(); store.worlds.add(usage); }
    mark("worldMade");
    if (globalThis.__wdWasm) Object.assign(globalThis.__wdWasm, { aotKey: store?.key, called: () => made.calledMethods() });
    return made;
  };
  if (typeof location === "undefined") {
    return { threads, loadDex(dex, isPlatform) {
      if (world) world.addDexes([dex], isPlatform ? world.prog.boot : world.prog.root);
      else {
        const p = new Program([]);
        p.add([dex], isPlatform ? p.boot : p.root); p.addExterns(externs);
        useWorld(install(createWorld(p, { dexes })));
      }
    } };
  }
  // The hooks come first and the build is fetched after them: Java is not run before the tier is ready (the zygote waits for the app's code), and the page fetches the build while it
  // downloads the package
  const opening = Promise.all([openAot(), fetchPlatformJars()]);
  // What a process numbers before its app's code arrives depends on timing (whether a build module has arrived, or its methods are compiled on demand), and a saved app build continues
  // exactly that numbering: a process numbers what earlier ones did first, in their order, and adds what it numbers besides
  const persisting = openPersist();
  const remembered = Promise.all([opening, persisting]).then(([[aot], persist]) => aot && persist?.prefix(aot.key)).catch(() => undefined);
  let seen: Numbering | undefined;
  // a process that never presents a frame, such as a service's, is launched when the start window ends
  const launched = () => { starting = false; if (world) code?.watch(world); };
  setTimeout(launched, START_MS);
  // The World is made when Java is first needed: the zygote's, before the app is known, whose dexes and saved build join it as they arrive
  const current = (): World => {
    if (!platform) throw new Error("the Wasm tier is not ready");
    if (world) return world;
    const w = createWorld(new Program(appDexes, platform), { aot: store, dexes });
    if (seen) w.adopt(seen);
    return install(w);
  };
  let entry: Entry | undefined;
  const lazyEntry = (name: keyof Entry) => (...args: unknown[]) => ((entry ??= wasmEntry(current()))[name] as (...a: unknown[]) => unknown)(...args);
  useEntry(Object.fromEntries(ENTRY_NAMES.map((n) => [n, lazyEntry(n)])) as unknown as Entry);
  useJniVm(lazy(() => wasmJni(current())));
  let names: ReturnType<typeof fieldNamesOf> | undefined;
  fieldNames.find = (cls, name) => (names ??= fieldNamesOf(current()))(cls, name);
  hook(current);
  const [aot, jars] = await opening;
  store = aot;
  seen = await remembered;
  platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  mark("platformReady");
  return {
    threads,
    ready: store?.ready,
    loadDex(dex, isPlatform) {
      if (isPlatform) return;
      appDexes.push(dex);
      world?.addDexes([dex]);
    },
    launched,
    async ahead(idle) {
      // a launch from a saved build has the code that earlier launches ran: what it lacks is compiled as it runs, without the garbage of compiling more
      if (aheading || starting || !world || !appDexes.length || code?.hit) return;
      // a failure leaves it off for the rest of the process: the code is compiled on demand as before
      aheading = true;
      // only while no other thread of the process has work to run (an app's main thread often waits for its background threads, which share this one), and not
      // while the app may still be answering an input
      const quiet = () => idle() && !yieldStats.pending() && sinceInput() > AHEAD_AFTER_INPUT_MS;
      try { while (quiet() && world.ahead(performance.now() + AHEAD_SLICE_MS)) await new Promise((resolve) => setTimeout(resolve)); aheading = false; }
      catch (e) { console.warn("[webdroid] compiling ahead failed", e); }
    },
    async warm(stop) {
      // a build without the list (or the guarded build) leaves the platform's code to its first calls
      const list = await store?.fetchBytes("warm.json").catch(() => undefined);
      if (!list) return true;
      const ids = JSON.parse(new TextDecoder().decode(list)) as string[], w = current();
      // in slices, so that a package arriving ends it: the code of what its launch runs is compiled as it runs either way
      let at = 0;
      for (; at < ids.length && !stop(); await new Promise((resolve) => setTimeout(resolve))) at = w.warm(ids, at, performance.now() + 10);
      mark("warmed");
      return at === ids.length;
    },
    async appCode(roots) {
      if (code || !store) return;
      // System realms have no app DEX, but their first Java entry still needs the
      // prefetched platform modules before AOT.ready can mark a module missed.
      if (!appDexes.length) { await store.ready; return; }
      // a saved build continues what the World numbered before the app's dexes arrived
      const w = current(), prefix = w.since(w.base);
      if (JSON.stringify(prefix) !== JSON.stringify(seen)) void persisting.then((persist) => persist?.savePrefix(store!.key, prefix)).catch(() => {});
      try {
        code = await prepareApp({ dexes: appDexes, aot: store, persist: await persisting, spawn: () => spawnCompileWorker(compileHost, COMPILE_WORKER_URL), roots, prefix, signal: lifetime.signal });
      } catch (error) { if (processExited() || lifetime.signal.aborted) return; throw error; }
      if (lifetime.signal.aborted) { code.close(); return; }
      const made = code;
      w.opts.compiler = made.compiler;
      if (made.saved) w.attachApp(made.saved);
      mark(made.hit ? "appCodeSaved" : "appCode");
      made.start(w);
      if (globalThis.__wdWasm) Object.assign(globalThis.__wdWasm, { worker: made.compiler.stats, appSaved: made.hit, appSource: made.source, appPersisted: () => made.persisted, appAttached: w.appAttached, appRejected: w.aot?.appRejected, appBuilds: made.builds, appSettle: () => made.settle(w) });
      // no app code runs until the modules of the build and of earlier launches have arrived
      store.ready = Promise.all([store.ready, made.launchReady]).then(() => {});
      await store.ready;
    },
  };
}
const lazy = <T extends object>(make: () => T): T => { let v: T | undefined; return new Proxy({} as T, { get: (_, k) => ((v ??= make()) as Record<PropertyKey, unknown>)[k] }); };
let using: World | undefined;
/** makes `w` the realm's Java: what jentry, JNI and the runtime's natives reach (JNI once it is first used: a World without the platform has none) */
export function useWorld(w: World): World {
  if (using === w) return w;
  using = w;
  useEntry(wasmEntry(w)); useJniVm(lazy(() => wasmJni(w))); fieldNames.find = fieldNamesOf(w);
  hook(() => w);
  return w;
}
/** the runtime's ways to make Java objects, in the World `world()` answers */
function hook(world: () => World): void {
  rt.mkThrowable = hostThrowable;
  rt.make = (cls) => { const spec = rt.natives.get(cls); return spec ? new spec.ctor() : hostObject(world(), cls); };
  rt.classFor = (cls) => world().bridge.toHost(classRef(world(), cls));
  wasmBox.make = (desc, v) => world().bridge.toHost(boxRef(world(), desc, v));
}
const ENTRY_NAMES = ["vcall", "scall", "newObj", "staticField", "linkInit", "linkClass", "initClass", "iof", "classNameOf", "callOn", "after"] as const satisfies readonly (keyof Entry)[];

/** the dex files of the archive at `path`, for the DexFile natives of class loaders: the app's own are the ones the World holds already, any other archive is read from the file system
 *  after its bytes have arrived */
export function openDexes(path: string, app: DexFile[], opened: Map<string, DexFile[] | undefined | Promise<DexFile[] | undefined>>): DexFile[] | undefined | Promise<DexFile[] | undefined> {
  path = vfs.norm(path);
  if (!opened.has(path)) {
    const own = appArchives.has(path) && app.length > 0;
    const packed = own ? undefined : packedArchives.get(path);
    const bytes = own || packed ? null : vfs.readFile(path);
    const decode = (bytes: Uint8Array | null) => bytes === null ? own ? app : undefined : bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b ? dexesOf(bytes, path) : dexesIn(bytes, path);
    const dexes = packed ? packed.prepare(true).then(() => dexEntryNames(Object.keys(packed.zip)).flatMap(name => dexesIn(packed.zip[name], `${path}:${name}`)))
      : bytes instanceof Promise ? bytes.then(decode) : decode(bytes);
    opened.set(path, dexes instanceof Promise ? dexes.catch(error => { opened.delete(path); throw error; }) : dexes);
  }
  return opened.get(path);
}
const dexesOf = (zip: Uint8Array, label: string): DexFile[] => {
  const dir = centralDir(zip);
  return dexEntryNames(dir.keys()).flatMap((name) => dexesIn(entryBytes(zip, dir.get(name)!), `${label}:${name}`));
};

let aotPort: MessagePort | undefined, compileHost: MessagePort | undefined;
/** a process Worker's store takes its modules from the page's (`serveAot`), and the page's compile host starts its compile workers */
export function usePagePorts(aot: MessagePort, compile: MessagePort): void { aotPort = aot; compileHost = compile; }
export function serveAot(port: MessagePort): void { void openAot().then((store) => serveStore(store, port), () => serveStore(undefined, port)); }

/** The platform build (scripts/wasm/aot-build.ts) the server holds for these sources, with the modules a start of the process loads compiled. Undefined when the
 *  server has no build for the sources, which leaves all code to the on-demand compiler. */
export function openAot(): Promise<FetchStore | undefined> {
  return globalThis.__wdAot ??= (async () => {
    const current = await fetch("/aot/current.json");
    if (!current.ok) return undefined;
    const manifest = await current.json() as { key: string };
    const store = new FetchStore(`/aot/${manifest.key}/`, aotPort);
    const [, startup, waiting] = await Promise.all([store.fetchBytes("index.json"), store.fetchBytes("startup.json"), store.fetchBytes("waiting.json")]);
    // the natives the modules import as Suspending were chosen when the build was made
    declareWaiting(JSON.parse(new TextDecoder().decode(waiting)) as string[]);
    mark("aotIndex");
    store.ready = prefetchInWorker(store, JSON.parse(new TextDecoder().decode(startup)) as string[]).then(() => mark("aotOpened"));
    return store;
  })();
}

/** The platform's Program from the boot class path's dexes: it is immutable, and the process extends it with its own dexes (`new Program(appDexes, platform)`). */
let platform: Program | undefined;
export function platformProgram(dexes: () => DexFile[]): Program {
  if (!platform) { platform = new Program(dexes()); platform.addExterns(externs); }
  return platform;
}
