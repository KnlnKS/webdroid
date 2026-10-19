export type CounterReceipt = { schema: 1; source: string; url: string; pid: number | null; bornAt: number; at: number; sequence: number; resets: number; clockUrl: string; realmBornAt: number; realmAt: number;
  initial: Readonly<Record<string, number>>; counters: Readonly<Record<string, number>> };
export const COMPILE_COUNTERS = ["wasmCompileMs", "wasmModuleMs", "wasmMethods", "wasmClassBuildMs"] as const;
declare global { interface Window { readonly __wdCounterReceipt?: () => Readonly<CounterReceipt> } }

/** Installed when perf is initialized, before any compiler can increment its counters. */
export function installCounterReceipt(counters: Record<string, number>, source: string): (() => void) | undefined {
  if (typeof window === "undefined" || new URLSearchParams(location.search).get("perfProbe") !== "1") return;
  const url = location.href, params = new URLSearchParams(location.search), pid = params.has("pid") ? Number(params.get("pid")) : null;
  const copy = () => Object.freeze(Object.fromEntries(COMPILE_COUNTERS.map(key => [key, counters[key]])));
  const clock = performance, clockUrl = url;
  const bornAt = clock.timeOrigin + clock.now(), realmBornAt = performance.timeOrigin + performance.now(), initial = copy();
  let sequence = 0, resets = 0;
  Object.defineProperty(window, "__wdCounterReceipt", { value: () => Object.freeze({ schema: 1 as const, source, url, pid, bornAt,
    at: clock.timeOrigin + clock.now(), realmAt: performance.timeOrigin + performance.now(), clockUrl, realmBornAt, sequence: ++sequence, resets, initial, counters: copy() }) });
  return () => { resets++; };
}
