// The Wasm tier's counters live in `perf` (src/perf.ts), which is what a page reports as run.json's counters.
import { perf } from "../../perf.ts";
import type { ThreadState } from "../../jvm/tier.ts";
import type { Strand, ThreadRec } from "../link/sched.ts";
import type { World } from "../link/world.ts";

export const count = (name: "wasmEntries" | "wasmFacadeMisses" | "wasmGaps" | "wasmNativeSuspended" | "wasmSuspendErrors"): void => { perf[name]++; };

/** bytes in use on the JS heap, which holds the Wasm GC heap in V8 */
export function heapUsed(): number {
  const p = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance?.memory;
  if (p) return p.usedJSHeapSize;
  return typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;
}

/** natives called from Java: the generated wrapper of every native counts here */
export const crossings = { n: 0 };

/** makes the Wasm counters of `perf` read `w`'s statistics; a reset (perfReset) starts them from zero again */
export function bindWorld(w: World): void {
  const { stats, sched } = w;
  const reads = {
    wasmMethods: () => stats.methods, wasmCompileMs: () => stats.compileMs, wasmModules: () => stats.instances, wasmModuleMs: () => stats.moduleMs + stats.instantiateMs,
    wasmBytes: () => stats.bytes, wasmAotLoaded: () => stats.aot.d + stats.aot.c, wasmAotMissed: () => stats.aot.missed, wasmAotMs: () => stats.aot.ms + stats.aot.readMs,
    wasmClasses: () => stats.classes, wasmSuspensions: () => sched.suspensions, wasmCrossings: () => crossings.n,
    wasmUpgrades: () => stats.upgrades, wasmAhead: () => stats.ahead, wasmRetired: () => stats.retired, wasmCollected: () => stats.collected, wasmBurned: () => stats.burned,
    wasmPrepareMs: () => stats.phase.prepare, wasmFlowMs: () => stats.phase.flow, wasmInferMs: () => stats.phase.infer,
    wasmFactsMs: () => stats.phase.facts, wasmEmitMs: () => stats.phase.emit, wasmEncodeMs: () => stats.phase.encode, wasmClassBuildMs: () => stats.phase.classBuild,
  };
  for (const [name, read] of Object.entries(reads)) {
    let base = 0;
    Object.defineProperty(perf, name, { get: () => read() - base, set: (v: number) => { base = v === 0 ? read() : read() - v; }, enumerable: true, configurable: true });
  }
}

/** Inspect host records only: reading Java Thread.name would compile and run Java while diagnosing a hang.
 * Other threads are labeled by a live strand, not by their Java names. */
export function wasmThreadStates(w: World): ThreadState[] {
  const threads = new Map<ThreadRec, Strand[]>();
  for (const s of w.sched.strands) if (s?.thread.alive) {
    const live = threads.get(s.thread);
    if (live) live.push(s); else threads.set(s.thread, [s]);
  }
  const name = (s: Strand): string => s.thread === w.sched.mainRec ? "main" : `wasm:${threads.get(s.thread)?.[0].id ?? s.id}`;
  return [...threads].map(([t, live]) => ({
    name: name(live[0]), state: t.blocked ? "BLOCKED" : t.waiting === 3 ? "WAITING" : t.waiting === 4 ? "TIMED_WAITING" : "RUNNABLE",
    strands: live.map(s => s.id),
    owner: [...new Set(live.flatMap(s => s.waitsOn ? [name(s.waitsOn)] : []))].join(", ") || undefined,
  }));
}
