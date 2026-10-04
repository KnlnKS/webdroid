// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). The World is made when the first dex arrives: the Program takes the classes
// of the first dex as its own and stubs the few the compiler's helpers need that it lacks, so the platform's core library is loaded before an app.
// The framework does not boot here yet: its blocking natives need S3.
import { pageShared } from "../../shell/pageshared";
import { FetchStore } from "../link/aotstore";
import { rt, fieldNames } from "../../jvm/runtime";
import { useEntry } from "../../jvm/natives/jentry";
import type { TierBackend } from "../../jvm/tier";
import type { DexFile } from "../../jvm/dex";
import { Program } from "../compiler/program";
import { World } from "../link/world";
import { externs, intrinsics } from "../link/intrinsics";
import { hostNet } from "./inet";
import { guestMemory } from "./guest";
import { wasmJni } from "./jni";
import { useJniVm } from "../../native/jnivm";
import { hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry";
import { natives, nativeSource } from "./nativesource";
import { count, heapUsed } from "./stats";


declare global { interface Window { __wdAot?: Promise<FetchStore | undefined>; __wdPlatformProgram?: Program } }

/** a World over `dexes`, with the registered natives and the host's resolver */
export function createWorld(dexes: DexFile[]): World {
  const prog = new Program(dexes);
  prog.addExterns(externs);
  const w = new World(prog, { intrinsics, natives, heapUsed, net: hostNet, guest: guestMemory, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
  w.onGap = (id) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${w.gapList[id]}`); };
  for (const spec of nativeSource.hostSpecs!()) w.addHostClass(spec);
  return w;
}

export async function bootWasmTier(): Promise<TierBackend> {
  let world: World | undefined;
  return {
    loadDex(dex) {
      if (world) { world.addDexes([dex]); return; }
      world = createWorld([dex]);
      useEntry(wasmEntry(world));
      useJniVm(wasmJni(world));
      fieldNames.find = fieldNamesOf(world);
      rt.mkThrowable = hostThrowable;
      const make = rt.make.bind(rt);
      rt.make = (cls) => rt.natives.has(cls) ? make(cls) : hostObject(world!, cls);
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
    const [, startup] = await Promise.all([store.fetchBytes("index.json"), store.fetchBytes("startup.json")]);
    await store.prefetch(JSON.parse(new TextDecoder().decode(startup)) as string[]);
    return store;
  });
}

/** The platform's Program, made by the first process of the tab from the boot class path's dexes and shared by the others: it is immutable, and each process extends it with
 *  its own dexes (`new Program(appDexes, platform)`), so the class model and class-hierarchy index of the 40,000 platform classes exist once per tab. */
export function platformProgram(dexes: () => DexFile[]): Program {
  return pageShared("__wdPlatformProgram", () => { const p = new Program(dexes()); p.addExterns(externs); return p; });
}
