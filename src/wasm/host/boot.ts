// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). Each realm (the page, every process frame) has a World over the tab's one platform build
// and platform Program; what is the realm's own is the app's dex files, its classes' statics and its heap.
import { pageShared } from "../../shell/pageshared";
import { FetchStore } from "../link/aotstore";
import { rt, fieldNames } from "../../jvm/runtime";
import { useEntry } from "../../jvm/natives/jentry";
import type { TierBackend } from "../../jvm/tier";
import type { DexFile } from "../../jvm/dex";
import { Program } from "../compiler/program";
import { fetchPlatformJars, jarDexes } from "../../android/framework";
import { PLATFORM_JARS } from "../../jvm/provenance";
import { parkTimeout, unparkTimeout, turnElapsed, wakeSoon, yieldToLoop } from "../../jvm/yield";
import { World, type WorldOptions } from "../link/world";
import type { HostLoop } from "../link/sched";
import { externs, intrinsics } from "../link/intrinsics";
import { hostNet } from "./inet";
import { hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry";
import { natives, nativeSource } from "./nativesource";
import { count, heapUsed } from "./stats";
import { declareWaiting } from "./suspend";


declare global { interface Window { __wdAot?: Promise<FetchStore | undefined>; __wdPlatformProgram?: Program } }

/** timers and turns of the event loop for threads that wait: the shell's own, so a thread's wait is a timed park an idle observer ignores and a yield keeps the main looper's order */
const hostLoop: HostLoop = {
  yield: (soon) => soon ? wakeSoon() : yieldToLoop(),
  due: () => turnElapsed() >= 8,
  after: (ms, fn) => { const id = parkTimeout(fn, ms); return () => unparkTimeout(id); },
};

/** a World over `prog`, with the registered natives and the host's resolver; `extra` is what the app's code adds (appcode.ts) */
export function createWorld(prog: Program, extra: Partial<WorldOptions> = {}): World {
  const w = new World(prog, { intrinsics, natives, heapUsed, net: hostNet, loop: hostLoop, claim: (owner, handle) => rt.claimHandle?.(owner, handle), ...extra });
  w.onGap = (id) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${w.gapList[id]}`); };
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  return w;
}

/** The realm's World, over the platform build the tab opened and the platform Program its processes share; the app's dex files join it as they arrive. */
export async function bootWasmTier(): Promise<TierBackend> {
  const [store, jars] = await Promise.all([openAot(), fetchPlatformJars()]);
  const platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  const world = createWorld(new Program([], platform), { aot: store });
  useEntry(wasmEntry(world));
  fieldNames.find = fieldNamesOf(world);
  rt.mkThrowable = hostThrowable;
  rt.make = (cls) => { const spec = rt.natives.get(cls); return spec ? new spec.ctor() : hostObject(world, cls); };
  return {
    loadDex(dex, isPlatform) {
      if (!isPlatform) world.addDexes([dex]);
    },
  };
}

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
    await store.prefetch(JSON.parse(new TextDecoder().decode(startup)) as string[]);
    return store;
  });
}

/** The platform's Program, made by the first process of the tab from the boot class path's dexes and shared by the others: it is immutable, and each process extends it with
 *  its own dexes (`new Program(appDexes, platform)`), so the class model and class-hierarchy index of the 40,000 platform classes exist once per tab. */
export function platformProgram(dexes: () => DexFile[]): Program {
  return pageShared("__wdPlatformProgram", () => { const p = new Program(dexes()); p.addExterns(externs); return p; });
}
