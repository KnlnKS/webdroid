// One G1 measurement in one fresh engine: a Bench workload as Wasm (lazy linking over the AOSP boot dex) or on the production JS tier,
// timed per call. Bundled by g1.ts for node (argv[2] is the JSON config) and for a page (globalThis.g1run).
import { loadDexes, program, world } from "./build";
import { jsTier, natives, processState } from "./oracle";
import { HEAP_LIMIT, heapUsed } from "./exc";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";

export interface G1Config { mode: "wasm" | "js"; cls: string; workload: string; reps: number; dex: string; root: string }
export interface G1Result { bootMs?: number; ahead?: number; workload: string; mode: string; result: string; times: number[]; compileMs?: number; units?: number; boot?: Record<string, unknown>; stats?: Record<string, unknown>; error?: string }

/** the heap in use, after a collection once it looks over the limit: reps of one workload in one World leave garbage the engine has not yet collected */
let heapBase = 0;
const collectedHeap = () => {
  const used = heapUsed();
  const gc = (globalThis as { gc?: () => void }).gc;
  if (used < heapBase + HEAP_LIMIT || !gc) return used;
  gc();
  return heapUsed();
};

export async function g1run(cfg: G1Config): Promise<G1Result> {
  const out: G1Result = { workload: cfg.workload, mode: cfg.mode, result: "", times: [] };
  const js = await jsTier(loadDexes(cfg.dex));
  console.warn = () => {};
  const prog = cfg.mode === "wasm" ? program([cfg.dex, ...PLATFORM_JARS.map((j) => `${cfg.root}/vendor/aosp/${j}`)]) : null;
  // the World takes the heap at its construction as the base of its limit, so the program model it is built over is on that side
  heapBase = heapUsed();
  const w = prog ? world(prog, { natives, heapUsed: collectedHeap }) : null;
  let hit = 0;
  if (w) { const b0 = performance.now(); w.onGap = () => hit++; try { processState(w); } catch (e) { const t = w.throwable(e); const cause = t ? w.fieldReader("java/lang/Throwable", "cause", "Ljava/lang/Throwable;")(t) as object | null : null; throw new Error("boot: " + (t ? w.classNameOf(t) : String(e)) + (cause ? " <- " + w.classNameOf(cause) : "") + " " + w.lastMessage); } out.bootMs = performance.now() - b0; out.ahead = (globalThis as { G1_AHEAD?: number }).G1_AHEAD; out.boot = structuredClone(w.stats); }
  const name = `w_${cfg.workload}`;
  const t0 = performance.now();
  const call = w ? w.entry(cfg.cls, name, "()I") : () => js(cfg.cls, name, "()I", []);
  try {
    // the first call includes linking and compiling everything the workload reaches
    out.result = String(await call());
    out.times.push(performance.now() - t0);
    for (let i = 0; i < cfg.reps; i++) { const t = performance.now(); await call(); out.times.push(performance.now() - t); if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0)); }
  } catch (e) { const t = w?.throwable(e); out.error = hit ? `gap ${w!.gapList[0]}` : t ? `uncaught ${w!.classNameOf(t)}` : String(e).slice(0, 900); }
  if (w) { out.compileMs = w.stats.compileMs; out.units = w.stats.units; out.stats = structuredClone(w.stats); }
  return out;
}
(globalThis as { g1run?: typeof g1run }).g1run = g1run;
const arg = (globalThis as { process?: { argv: string[] } }).process?.argv[2];
if (arg && !(globalThis as { document?: unknown }).document) {
  const keep = setInterval(() => {}, 1 << 30); // the JS tier's yield channel is unref'd
  console.log("G1" + JSON.stringify(await g1run(JSON.parse(arg))));
  clearInterval(keep);
}
