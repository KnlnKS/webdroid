// Which engine runs Java: the JS tier (`?tier=js`, the default) or the Wasm tier (`?tier=wasm`; headless tools: WEBDROID_TIER). The Wasm tier's
// code is loaded by a dynamic import only when selected, so the default bundle carries none of it. `JavaClass` is what host code holds of a loaded
// class instead of the JS tier's `ClassInfo.ctor`, with an implementation for each tier.
import type { ClassInfo } from "./runtime";
import { lateMethod, mangleMethod, mangleStaticField } from "./abi";

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
  /** the value of static field `name`; `desc` names the field exactly, which a class declaring `name` twice needs */
  static(name: string, desc?: string): unknown;
  /** sets static field `name`, as `static` names it; false if the class declares no such field */
  setStatic(name: string, value: unknown, desc?: string): boolean;
  /** does an instance have method `name``desc`, declared or inherited */
  has(name: string, desc: string): boolean;
  /** static method `name``desc`, as a function of its arguments */
  call(name: string, desc: string): (...args: unknown[]) => unknown;
  /** method `name``desc` of this class run on `self` without virtual dispatch (a super constructor call) */
  special(name: string, desc: string): (self: object, ...args: unknown[]) => unknown;
}

const classes = new WeakMap<ClassInfo, JavaClass>();
/** a class of the JS tier */
export function jsClass(info: ClassInfo): JavaClass {
  let cls = classes.get(info);
  if (cls) return cls;
  const ctor = info.ctor as Record<string, unknown> & (new () => object);
  const prop = (name: string, desc?: string) => desc ? info.staticFieldTable.get(name + ":" + desc) ?? (info.native ? mangleStaticField(name) : undefined) : mangleStaticField(name);
  const missing = (name: string, desc: string) => new Error(`${info.name}.${name}${desc} is not defined`);
  cls = {
    name: info.name,
    new: () => new ctor(),
    static: (name, desc) => ctor[prop(name, desc) ?? ""],
    setStatic: (name, value, desc) => {
      const key = prop(name, desc);
      if (key !== undefined) ctor[key] = value;
      return key !== undefined;
    },
    has: (name, desc) => mangleMethod(name, desc) in ctor.prototype,
    call: (name, desc) => {
      const fn = ctor[mangleMethod(name, desc)] ?? lateMethod.find?.(ctor, name, desc);
      if (typeof fn !== "function") throw missing(name, desc);
      return (fn as (...args: unknown[]) => unknown).bind(ctor);
    },
    special: (name, desc) => {
      const fn = (ctor.prototype as Record<string, unknown>)[mangleMethod(name, desc)];
      if (typeof fn !== "function") throw missing(name, desc);
      return (self, ...args) => (fn as (...args: unknown[]) => unknown).apply(self, args);
    },
  };
  classes.set(info, cls);
  return cls;
}
