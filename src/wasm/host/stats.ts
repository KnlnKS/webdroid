// The Wasm tier's counters live in `perf` (src/perf.ts), which is what a page reports as run.json's counters.
import { perf } from "../../perf";

export const count = (name: "wasmEntries" | "wasmFacadeMisses" | "wasmGaps" | "wasmNativeSuspended" | "wasmSuspendErrors"): void => { perf[name]++; };

/** bytes in use on the JS heap, which holds the Wasm GC heap in V8 */
export function heapUsed(): number {
  const p = (globalThis as { performance?: { memory?: { usedJSHeapSize: number } } }).performance?.memory;
  if (p) return p.usedJSHeapSize;
  return typeof process !== "undefined" ? process.memoryUsage().heapUsed : 0;
}
