// The Wasm tier's counters live in `perf` (src/perf.ts), which is what a page reports as run.json's counters.
import { perf } from "../../perf";
import type { World } from "../link/world";

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
  };
  for (const [name, read] of Object.entries(reads)) {
    let base = 0;
    Object.defineProperty(perf, name, { get: () => read() - base, set: (v: number) => { base = v === 0 ? read() : read() - v; }, enumerable: true, configurable: true });
  }
}
