// The Wasm tier's entry (src/jvm/tier.ts loads it under ?tier=wasm). The World is made when the first dex arrives: the Program takes the classes
// of the first dex as its own and stubs the few the compiler's helpers need that it lacks, so the platform's core library is loaded before an app.
// The framework does not boot here yet: its blocking natives need S3.
import { rt, fieldNames } from "../../jvm/runtime";
import { useEntry } from "../../jvm/natives/jentry";
import type { TierBackend } from "../../jvm/tier";
import type { DexFile } from "../../jvm/dex";
import { Program } from "../compiler/program";
import { World } from "../link/world";
import { externs, intrinsics } from "../link/intrinsics";
import { hostNet } from "./inet";
import { hostObject, hostThrowable, fieldNamesOf, wasmEntry } from "./entry";
import { natives } from "./nativesource";
import { count, heapUsed } from "./stats";

/** a World over `dexes`, with the registered natives and the host's resolver */
export function createWorld(dexes: DexFile[]): World {
  const prog = new Program(dexes);
  prog.addExterns(externs);
  const w = new World(prog, { intrinsics, natives, heapUsed, net: hostNet });
  w.onGap = (id) => { count("wasmGaps"); rt.noteMissing(`wasm gap: ${w.gapList[id]}`); };
  return w;
}

export async function bootWasmTier(): Promise<TierBackend> {
  let world: World | undefined;
  return {
    loadDex(dex) {
      if (world) { world.addDexes([dex]); return; }
      world = createWorld([dex]);
      useEntry(wasmEntry(world));
      fieldNames.find = fieldNamesOf(world);
      rt.mkThrowable = hostThrowable;
      const make = rt.make.bind(rt);
      rt.make = (cls) => rt.natives.has(cls) ? make(cls) : hostObject(world!, cls);
    },
  };
}
