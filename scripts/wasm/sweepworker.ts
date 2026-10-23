// A shard of the validation sweep (sweep.ts), in a worker thread: every `of`th method of each target, from the `shard`th, compiled alone.
import { parentPort, workerData } from "node:worker_threads";
import { platform, platformDexes, world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { Program, mid } from "../../src/wasm/compiler/program.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { compileModule, COMPILE_OPTIONS } from "../../src/wasm/link/module.ts";
import { AOSP } from "../aosp.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";

export type Shard = { targets: string[]; shard: number; of: number; verbose: boolean };
export type Swept = { total: number; clean: number; bodyless: number; seconds: number; causes: Record<string, string[]>; linked: Record<string, number>; links: string[] };

// Validate discarded units without allocating executable code; compilation supplies rejection diagnostics.
const validate = WebAssembly.validate as unknown as (bytes: BufferSource, options: typeof COMPILE_OPTIONS) => boolean;
const { targets, shard, of, verbose } = workerData as Shard;

function sweep(target: string): Swept {
  // the boot class path comes first, as in ART: an app's stubs of platform classes (R8 API outlines) never shadow the platform's, and an app sees only the platform
  const jar = PLATFORM_JARS.find((j) => `${AOSP}/${j}` === target), own = jar ? [] : loadDexes(target);
  const mine = new Set(jar ? platformDexes([jar]) : own), prog = new Program(own, platform());
  const w = world(prog, { compileOnly: true, hostClasses: false });
  const out: Swept = { total: 0, clean: 0, bodyless: 0, seconds: 0, causes: {}, linked: {}, links: [] };
  const t0 = performance.now();
  let index = 0;
  for (const c of prog.all()) if (c.dex && mine.has(c.dex)) for (const m of w.prog.get(c.name)?.methods ?? []) {
    if (index++ % of !== shard) continue;
    if (!m.codeOff) { out.bodyless++; continue; }
    out.total++;
    const id = mid(m), fail = (cause: string) => (out.causes[cause] ??= []).push(id);
    try {
      const cx = new Compiler(w), { bytes } = cx.buildUnit([m]);
      for (const t of new Set(cx.linkErrors)) out.linked[t] = (out.linked[t] ?? 0) + 1;
      if (cx.gaps.length) for (const g of new Set(cx.gaps.map((g) => (g.startsWith(id + ": ") ? g.slice(id.length + 2) : g).replace(/\d+/g, "N")))) fail(g);
      else {
        try {
          if (!validate(bytes as BufferSource, COMPILE_OPTIONS)) {
            compileModule(bytes);
            throw new Error("validator rejected module accepted by compiler");
          }
          out.clean++;
        } catch (e) { fail("invalid module: " + (e as Error).message.replace(/.*?: /, "").replace(/@\+\d+/g, "").replace(/\d+/g, "N")); }
      }
    } catch (e) { fail("compiler crash: " + (e as Error).message.replace(/\d+/g, "N")); }
  }
  if (verbose) out.links = w.numbers.links.messages;
  out.seconds = (performance.now() - t0) / 1000;
  return out;
}
parentPort!.postMessage(targets.map(sweep));
