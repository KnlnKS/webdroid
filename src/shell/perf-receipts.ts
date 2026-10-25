import { switchOn } from "../switches.ts";

type CounterReceipt = { at: number; sequence: number; resets: number; initial: Readonly<Record<string, number>>; counters: Readonly<Record<string, number>> };
export const COMPILE_COUNTERS = ["wasmCompileMs", "wasmModuleMs", "wasmMethods", "wasmClassBuildMs"] as const;
declare global { interface Window { readonly __wdCounterReceipt?: () => Readonly<CounterReceipt> } }

/** The page's compile counters under ?perfProbe=1 (scripts/lat), installed when perf is initialized, before any
 *  compiler can increment them; the result counts each perfReset. */
export function installCounterReceipt(counters: Record<string, number>): (() => void) | undefined {
  if (typeof window === "undefined" || !switchOn("perfProbe", false)) return;
  const copy = () => Object.freeze(Object.fromEntries(COMPILE_COUNTERS.map(key => [key, counters[key]])));
  const initial = copy();
  let sequence = 0, resets = 0;
  Object.defineProperty(window, "__wdCounterReceipt", { value: () => Object.freeze({ at: performance.timeOrigin + performance.now(),
    sequence: ++sequence, resets, initial, counters: copy() }) });
  return () => { resets++; };
}
