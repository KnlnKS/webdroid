// Which engine runs Java: the JS tier (`?tier=js`, the default) or the Wasm tier (`?tier=wasm`; headless tools: WEBDROID_TIER). The Wasm tier's
// code is loaded by a dynamic import only when selected, so the default bundle carries none of it. `JavaClass` is what host code holds of a loaded
// class instead of the JS tier's `ClassInfo.ctor`, with an implementation for each tier.
import type { ClassInfo } from "./runtime";
import { mangleMethod, mangleStaticField } from "./abi";

export type Tier = "js" | "wasm";

export function parseTier(value: string | null | undefined): Tier {
  if (value == null || value === "js") return "js";
  if (value === "wasm") return "wasm";
  throw new Error(`invalid tier ${value}: js or wasm`);
}

export const tier: Tier = parseTier(typeof location !== "undefined" ? new URLSearchParams(location.search).get("tier")
  : typeof process !== "undefined" ? process.env.WEBDROID_TIER : undefined);

/** loads the Wasm tier's host; only under `tier === "wasm"` */
export async function loadTier(): Promise<void> {
  await (await import("../wasm/host/boot")).bootWasmTier();
}

export interface JavaClass {
  readonly name: string;
  /** a new instance, its constructor not yet run */
  "new"(): object;
  /** the value of static field `name` */
  static(name: string): unknown;
  /** static method `name``desc`, as a function of its arguments */
  call(name: string, desc: string): (...args: unknown[]) => unknown;
}

/** a class of the JS tier */
export function jsClass(info: ClassInfo): JavaClass {
  const ctor = info.ctor as Record<string, (...args: unknown[]) => unknown> & (new () => object);
  return {
    name: info.name,
    new: () => new ctor(),
    static: (name) => (ctor as Record<string, unknown>)[mangleStaticField(name)],
    call: (name, desc) => ctor[mangleMethod(name, desc)].bind(ctor),
  };
}
