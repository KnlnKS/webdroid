// The Wasm tier's entry (src/jvm/tier.ts loads it). Each realm (the page, every process Worker) has a World over the platform build
// and platform Program; what is the realm's own is the app's dex files, its classes' statics and its heap.
import { mark, perf } from "../../perf.ts";
import { switchValue } from "../../switches.ts";
import { wallMillis } from "../../guest-clock.ts";
import { note } from "../../timeline.ts";
import { FetchStore } from "./aotstore.ts";
import { rt } from "../../jvm/runtime.ts";
import { java, useJavaHost, type JavaHost } from "../../jvm/javahost.ts";
import type { TierBackend, TierPorts } from "../../jvm/tier.ts";
import { dexesIn, dexesOfZip, type DexFile } from "../../jvm/dex.ts";
import { vfs } from "../../shell/vfs.ts";
import { appArchives, packedArchives } from "../../shell/packedarchive.ts";
import { Program } from "../compiler/program.ts";
import { fetchPlatformJars, jarDexes } from "../../android/framework.ts";
import { PLATFORM_JARS } from "../../jvm/provenance.ts";
import { dotName } from "../../jvm/abi.ts";
import { parkTimeout, unparkTimeout, turnElapsed, wakeSoon, yieldToLoop, yieldStats, sinceInput, answeringFor } from "../../jvm/yield.ts";
import { World, type WorldOptions } from "../link/world.ts";
import { objectOfLoader } from "../link/loaders.ts";
import { TURN_MS, type HostLoop } from "../link/sched.ts";
import type { Numbering } from "../link/numbers.ts";
import { externs, intrinsics } from "../link/intrinsics.ts";
import { endWaits } from "../link/module.ts";
import { hostNet } from "./inet.ts";
import { guestMemory } from "./guest.ts";
import { wasmJni } from "./jni.ts";
import { boxRef, classRef, hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry.ts";
import { addHostSpec, attachHostClasses, natives } from "./nativesource.ts";
import { claimHandle } from "../../android/handles.ts";
import { wasmThreadStates, bindWorld, count, heapUsed } from "./stats.ts";
import { prepareApp, type AppCode, type AppCodeRequest, type Built } from "./appcode.ts";
import { prefetchInWorker, serveStore } from "./aotload.ts";
import { openPersist } from "./persist.ts";
import { spawnCompileWorker, type CompileClient } from "./compiler.ts";
import { WORKER_SCRIPTS } from "../../worker-scripts.ts";
import { onProcessExit, processExited } from "../../process-exit.ts";
import type { WarmAnswer } from "./warm-worker.ts";

/** what the JS heap of a tab, which every process's Java heap and the program models share, may grow by before an allocation fails */
const TAB_HEAP = 2048 * 1024 * 1024;
/** what a process asks of its app code: where a build starts, and whether the app is shown */
type Asked = Pick<AppCodeRequest, "roots" | "shown">;

/** the Wasm tier's code status, where a harness reads it: a page's window or a process Worker's global */
export type WasmStatus = { stats: World["stats"]; worker?: CompileClient["stats"]; appSaved?: boolean; appSource?: AppCode["source"]; appPersisted?: () => Promise<boolean>; appAttached?: boolean; appRejected?: string; appBuilds?: Built[]; appSettle?: () => Promise<Built | undefined>; aotKey?: string; ran?: () => number[]; demandMark?: () => number[]; demandSince?: (mark: number[]) => [string, boolean, boolean, boolean][] };
declare global {
  var __wdWasm: WasmStatus | undefined;
  /** the realm's AOT store, which a diagnostic reads without opening it (shell/aot-profile.ts) */
  var __wdAot: Promise<FetchStore | undefined> | undefined;
  interface Window { __wdWasm?: WasmStatus }
}

/** until the app's first frame, or this long, the hot methods are compiled by the worker only: what runs hot while a process starts is mostly run-once code */
let starting = typeof location !== "undefined";
const START_MS = 15_000;
/** a slice of idle work: an input that arrives meanwhile waits no longer than this */
const IDLE_SLICE_MS = 4;
/** work done in idle time a slice at a time, from `afterInputMs` after an input; whether any is left */
type IdleWork = { name: string; afterInputMs: number; step: (until: number) => boolean };
/** the idle work that failed, which stays off for the rest of the process: its code is then made on demand as before */
const failedWork = new Set<string>();
let aheading = false;

/** timers and turns of the event loop for threads that wait: the shell's own, so a thread's wait is a timed park an idle observer ignores and a yield keeps the main looper's order */
export const hostLoop: HostLoop = {
  yield: (soon) => soon ? wakeSoon() : yieldToLoop(),
  due: () => turnElapsed() >= TURN_MS,
  after: (ms, fn) => { const id = parkTimeout(fn, ms); return () => unparkTimeout(id); },
  now: () => wallMillis(),
};

/** the options of every World that runs Java in a realm, the tier's own and the harnesses': the registered natives and the host's network, loop and native memory */
export const worldOptions = (): WorldOptions => ({ intrinsics, natives, heapUsed, net: hostNet, loop: hostLoop, guest: guestMemory, claim: claimHandle });
/** a World over `prog`, with the registered natives and the host's resolver; `extra` is what the app's code adds (appcode.ts) */
function createWorld(prog: Program, extra: Partial<WorldOptions> = {}): World {
  const w = new World(prog, { ...worldOptions(), holdUpgrades: () => starting, answering: () => answeringFor() > 0, heapLimit: TAB_HEAP, note: note as (ev: number, arg?: number) => void, ...extra });
  bindWorld(w);
  globalThis.__wdWasm = { stats: w.stats, demandMark: () => w.ahead.demandMark(), demandSince: (mark) => w.ahead.demandSince(mark) };
  w.onGap = (gap) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${gap}`); };
  // the class a site cannot link is noted as missing
  w.onUnresolved = (message, cls) => rt.noteMissing(cls ? "class " + cls : message);
  return attachHostClasses(w);
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
  // the page's end ends its waits as well, which the engine would otherwise keep, with all they reach, past the page
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => { close(); endWaits(new Error("the page closed")); }, { once: true });
  const appDexes: DexFile[] = [], opened = new Map<string, DexFile[] | undefined | Promise<DexFile[] | undefined>>();
  const dexes = (path: string) => openDexes(path, appDexes, opened);
  const install = (made: World) => {
    world = made;
    if (!lifetime.signal.aborted && store) { usage = () => made.usage(); store.worlds.add(usage); }
    useWorld(made); mark("worldMade");
    if (globalThis.__wdWasm) Object.assign(globalThis.__wdWasm, { aotKey: store?.key, ran: () => made.aot?.ranSlots().platform ?? [] });
    return made;
  };
  if (typeof location === "undefined") {
    return { threads, loadDex(dex, isPlatform) {
      if (world) world.addDexes([dex], isPlatform ? world.prog.boot : world.prog.root);
      else {
        const p = new Program([]);
        p.add([dex], isPlatform ? p.boot : p.root); p.addExterns(externs);
        install(createWorld(p, { dexes }));
      }
    }, ready: Promise.resolve(), beginAppCode() {}, appCode: async () => {}, launched() {}, ahead: async () => {}, status: () => globalThis.__wdWasm };
  }
  // The hooks come first and the build is fetched after them: Java is not run before the tier is ready (the zygote waits for the app's code), and the page fetches the build while it
  // downloads the package
  const opening = Promise.all([openAot(), fetchPlatformJars()]);
  // What a process numbers before its app's code arrives depends on timing (whether a build module has arrived, or its methods are compiled on demand), and a saved app build continues
  // exactly that numbering: a process numbers what earlier ones did first, in their order, and adds what it numbers besides. A device's first process takes what the
  // profiled launches numbered (scripts/wasm/aot-profile.ts; null when they disagree or none ran), so its app's build can begin before the zygote has run.
  const persisting = openPersist();
  const remembered = Promise.all([opening, persisting]).then(async ([[aot], persist]) =>
    aot && (await persist?.prefix(aot.key) ?? JSON.parse(new TextDecoder().decode(await aot.fetchBytes("prefix.json"))) as Numbering | null)).catch(() => null);
  let seen: Numbering | undefined;
  /** the app code beginAppCode asked for, and the code it began preparing under the prefix it took */
  let asked: Asked | undefined, begun: { prefix: string; code: Promise<AppCode> } | undefined;
  const prepare = async (app: Asked, dexes: DexFile[], prefix: Numbering) =>
    prepareApp({ ...app, dexes, aot: store!, prefetch: (files) => prefetchInWorker(store!, files), persist: await persisting, spawn: () => spawnCompileWorker(compileHost, WORKER_SCRIPTS.compile.url), prefix, signal: lifetime.signal,
      warm: warmPort && warming() ? (request, transfer) => warmPort!.postMessage(request, transfer ?? []) : undefined });
  // a process that never presents a frame, such as a service's, is launched when the start window ends
  const launched = () => { clearTimeout(startWindow); starting = false; if (world) code?.watch(world); };
  const startWindow = setTimeout(launched, START_MS);
  // The World is made when Java is first needed: the zygote's, before the app is known, whose dexes and saved build join it as they arrive
  const current = (): World => {
    if (!platform) throw new Error("the Wasm tier is not ready");
    if (world) return world;
    const w = createWorld(new Program(appDexes, platform), { aot: store, dexes });
    if (seen) w.adopt(seen);
    return install(w);
  };
  usePending(current);
  const [aot, jars] = await opening;
  store = aot;
  seen = await remembered ?? undefined;
  platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  mark("platformReady");
  return {
    threads,
    ready: store?.ready ?? Promise.resolve(),
    status: () => globalThis.__wdWasm,
    loadDex(dex, isPlatform) {
      if (isPlatform) throw new Error("a page's platform classes are its build's");
      appDexes.push(dex);
      world?.addDexes([dex]);
    },
    launched,
    async ahead(idle) {
      if (aheading || starting || !world) return;
      aheading = true;
      const w = world, work: IdleWork[] = [
        // linking makes little garbage, and burning's compiles run on the engine's background threads: they begin once an input's frames are drawn
        { name: "linking ahead", afterInputMs: 250, step: (until) => !!w.aot?.linkAhead(until) },
        { name: "burning", afterInputMs: 250, step: (until) => w.burner.burn(until) },
        // a launch from a saved build has the code that earlier launches ran: what it lacks is compiled as it runs, without the garbage of compiling more
        ...appDexes.length && !code?.hit ? [{ name: "compiling ahead", afterInputMs: 1000, step: (until: number) => w.ahead.compile(until) }] : [],
      ];
      // the main thread's wait that began this may be its last until the next input
      const early = work[0].afterInputMs - sinceInput();
      if (early > 0) await new Promise((resolve) => setTimeout(resolve, early + 1));
      for (const { name, afterInputMs, step } of work) {
        // only while no other thread of the process has work to run (an app's main thread often waits for its background threads, which share this one), and
        // not while the app may still be answering an input
        const quiet = () => idle() && !yieldStats.pending() && sinceInput() > afterInputMs;
        try { if (!failedWork.has(name)) while (quiet() && step(performance.now() + IDLE_SLICE_MS)) await new Promise((resolve) => setTimeout(resolve)); }
        catch (e) { failedWork.add(name); console.warn(`[webdroid] ${name} failed`, e); }
      }
      aheading = false;
    },
    beginAppCode(dexes, roots, shown) {
      asked = { roots, shown };
      // the zygote numbers what earlier processes did (`seen`) unless it needs more, which appCode finds
      if (code || begun || !store || !seen || !dexes.length) return;
      begun = { prefix: JSON.stringify(seen), code: prepare(asked, dexes, seen) };
      begun.code.catch(() => {});
    },
    async appCode() {
      if (code || !store) return;
      // System realms have no app DEX, but their first Java entry still needs the
      // prefetched platform modules before AOT.ready can mark a module missed.
      if (!appDexes.length) { await store.ready; return; }
      if (!asked) throw new Error("the app's dexes were loaded without beginAppCode");
      // a saved build continues what the World numbered before the app's dexes arrived
      const w = current(), prefix = w.numbers.since(w.base), numbered = JSON.stringify(prefix), early = begun;
      if (numbered !== JSON.stringify(seen)) void persisting.then((persist) => persist?.savePrefix(store!.key, prefix)).catch(() => {});
      begun = undefined;
      try {
        if (early?.prefix === numbered) code = await early.code;
        else { void early?.code.then((c) => c.close(), () => {}); code = await prepare(asked, appDexes, prefix); }
      } catch (error) { if (processExited() || lifetime.signal.aborted) return; throw error; }
      if (lifetime.signal.aborted) { code.close(); return; }
      const made = code;
      w.compiler = made.compiler;
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
let using: World | undefined;
/** makes `w` the realm's Java: what jentry, JNI and the runtime's natives reach */
export function useWorld(w: World): World {
  if (using === w) return w;
  using = w;
  let jni: JavaHost["jni"] | undefined;
  useJavaHost({
    ...wasmEntry(w), ...objectsIn(() => w),
    // made when first used: a World without the platform has none
    get jni() { return jni ??= wasmJni(w); },
    fieldName: fieldNamesOf(w),
    // the frames of Java code: a method the host implements is not one
    javaFrames: () => w.stacks.callerFrames(16).filter((f) => w.prog.get(f.cls)?.dex !== null).map((f) => dotName(f.cls) + "." + f.method),
    userClassLoader: () => {
      const f = w.stacks.callerFrame((f) => w.prog.loaderOf(f.cls) !== w.prog.boot);
      return f ? w.bridge.toHost(objectOfLoader(w, w.prog.loaderOf(f.cls))) as object | null : null;
    },
    toHost: (o) => w.bridge.toHost(o),
    registered: (spec) => addHostSpec(w, spec),
  });
  return w;
}
/** the realm's Java until its World is made: whatever first reaches Java makes it (`world`), and useWorld installs its host in place of this one */
function usePending(world: () => World): void {
  const made = (): JavaHost => { world(); return java; };
  // no Java has run
  const own: Partial<JavaHost> = { ...objectsIn(world), javaFrames: () => [], userClassLoader: () => null, toHost: (o) => o, registered() {}, contended: () => false, tasks: undefined };
  useJavaHost(new Proxy(own as JavaHost, { get: (_, k: keyof JavaHost) => k in own ? own[k] : made()[k] }));
}
/** the Java objects the runtime makes, in the World `world()` answers */
const objectsIn = (world: () => World): Pick<JavaHost, "throwable" | "make" | "classFor" | "box"> => ({
  throwable: hostThrowable,
  make: (cls) => { const spec = rt.natives.get(cls); return spec ? new spec.ctor() : hostObject(world(), cls); },
  classFor: (cls) => world().bridge.toHost(classRef(world(), cls)),
  box: (desc, v) => world().bridge.toHost(boxRef(world(), desc, v)),
});

/** the dex files of the archive at `path`, for the DexFile natives of class loaders: the app's own are the ones the World holds already, any other archive is read from the file system
 *  after its bytes have arrived */
export function openDexes(path: string, app: DexFile[], opened: Map<string, DexFile[] | undefined | Promise<DexFile[] | undefined>>): DexFile[] | undefined | Promise<DexFile[] | undefined> {
  path = vfs.norm(path);
  if (!opened.has(path)) {
    const own = appArchives.has(path) && app.length > 0;
    const packed = own ? undefined : packedArchives.get(path);
    const bytes = own || packed ? null : vfs.readFile(path);
    const decode = (bytes: Uint8Array | null) => {
      if (bytes === null) return own ? app : undefined;
      try { return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b ? jarDexes(bytes, path) : dexesIn(bytes, path); }
      catch (e) { throw rt.mkThrowable("java/io/IOException", `Failed to open dex files from ${path} because: ${e instanceof Error ? e.message : e}`); }
    };
    const dexes = packed ? packed.prepare(true).then(() => dexesOfZip(packed.zip, path))
      : bytes instanceof Promise ? bytes.then(decode) : decode(bytes);
    opened.set(path, dexes instanceof Promise ? dexes.catch(error => { opened.delete(path); throw error; }) : dexes);
  }
  return opened.get(path);
}

let aotPort: MessagePort | undefined, compileHost: MessagePort | undefined, warmPort: MessagePort | undefined;
/** a process Worker's store takes its modules from the page's (`serveAot`), the page's compile host starts its compile workers, and the page's warm Worker
 *  compiles the build code its launch is about to run (`serveWarm`) */
export function useTierPorts({ aot, compile, warm }: TierPorts): void {
  aotPort = aot; compileHost = compile; warmPort = warm;
  warm.onmessage = ({ data }: MessageEvent<WarmAnswer>) => countWarm(data);
}
export function serveAot(port: MessagePort): void { void openAot().then((store) => serveStore(store, port), () => serveStore(undefined, port)); }
const countWarm = ({ warmed, skipped }: WarmAnswer) => { perf.wasmWarmed += warmed; perf.wasmWarmSkipped += skipped; };
let warmer: Worker | null | undefined;
/** whether the page runs a warm Worker: where V8 compiles a function on its first call and shares the code between Workers, and the machine has cores to spare */
const warming = (): boolean => navigator.hardwareConcurrency >= 4 && /Chrome\//.test(navigator.userAgent);
/** Gives a process Worker's port to the page's warm Worker, made with the first. Until processes ask, it warms what launches of the platform build ran. */
export function serveWarm(port: MessagePort): void {
  if (warmer === undefined) {
    warmer = warming() ? new Worker(WORKER_SCRIPTS.warm.url, { type: "module" }) : null;
    if (warmer) {
      warmer.onmessage = ({ data }: MessageEvent<WarmAnswer>) => countWarm(data);
      void openAot().then((store) => { if (store) warmer!.postMessage({ base: store.base }); });
    }
  }
  if (warmer) warmer.postMessage({ port }, [port]); else port.close();
}

/** The platform build (scripts/wasm/aot-build.ts) the server holds for these sources, with the modules a start of the process loads compiled. Undefined when the
 *  server has no build for the sources, which leaves all code to the on-demand compiler. */
export function openAot(): Promise<FetchStore | undefined> {
  return globalThis.__wdAot ??= (async () => {
    // ?aot=<key> runs the build `pnpm aot --keep` added beside the current one, for matched comparisons of builds
    const other = switchValue("aot"), current = await fetch(`/aot/current.json${other ? `?key=${other}` : ""}`);
    if (!current.ok) return undefined;
    const store = new FetchStore(`/aot/${(await current.json() as { key: string }).key}/`, aotPort);
    const [, startup] = await Promise.all([store.fetchBytes("index.json"), store.fetchBytes("startup.json")]);
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
