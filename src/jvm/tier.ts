// Which engine runs Java: the JS tier (`?tier=js`, the default) or the Wasm tier (`?tier=wasm`; headless tools: WEBDROID_TIER). The Wasm tier's
// code is loaded by a dynamic import only when selected, so the default bundle carries none of it. `JavaClass` is what host code holds of a loaded
// class instead of the JS tier's `ClassInfo.ctor`, with an implementation for each tier.
import type { ClassInfo, Runtime } from "./runtime";
import type { DexFile } from "./dex";
import { lateMethod, mangleMethod, mangleStaticField } from "./abi";

export type Tier = "js" | "wasm";

export function parseTier(value: string | null | undefined): Tier {
  if (value == null || value === "js") return "js";
  if (value === "wasm") return "wasm";
  throw new Error(`invalid tier ${value}: js or wasm`);
}

export const tier: Tier = parseTier(typeof location !== "undefined" ? new URLSearchParams(location.search).get("tier")
  : typeof process !== "undefined" ? process.env.WEBDROID_TIER : undefined);

export interface ThreadState { name: string; state: string; blocker?: string; owner?: string; strands?: number[] }
/** what the Wasm tier's host provides the places that load code */
export interface TierBackend {
  threads(): ThreadState[];
  /** settles once the platform modules a start of the process loads are compiled: no Java runs before */
  ready?: Promise<void>;
  loadDex(dex: DexFile, platform: boolean): void;
  /** the app's dex files are all loaded: prepare its compiled code (a build an earlier launch saved) before Java first runs */
  appCode?(roots: { profile?: Uint8Array; manifest?: Uint8Array; launch: string[] }): Promise<void>;
  /** has the engine compile the platform code launches use while `stop` says no app is starting (World.warm) */
  warm?(stop: () => boolean): Promise<void>;
  /** the app has shown its first frame */
  launched?(): void;
}
let backend: TierBackend | undefined;
export const wasmThreads = (): ThreadState[] => backend?.threads() ?? [];
let loading: Promise<void> | undefined;
/** loads the Wasm tier's host; only under `tier === "wasm"`. A page asks as soon as it runs, so that the tier's build is opened while the rest starts. */
export function loadTier(): Promise<void> {
  return loading ??= import("../wasm/host/boot").then(async (host) => { backend = await host.bootWasmTier(); });
}

/** a process Worker's Wasm modules come from the page's store of the platform build: the page serves the port, the Worker uses it */
export function serveAot(port: MessagePort): void {
  if (tier === "wasm") void import("../wasm/host/boot").then((host) => host.serveAot(port)); else port.close();
}
export async function useAotPort(port: MessagePort): Promise<void> {
  if (tier === "wasm") (await import("../wasm/host/boot")).useAotPort(port); else port.close();
}

/** the Wasm tier's compiled app code, once the app's dex files are loaded; the JS tier has its own (jvm/aot.ts) */
export async function loadAppCode(roots: { profile?: Uint8Array; manifest?: Uint8Array; launch: string[] }): Promise<void> { await backend?.appCode?.(roots); }
/** settles once the Wasm tier can run Java */
export const tierReady = (): Promise<void> => loadTier().then(() => backend?.ready);
/** the app's first frame is on the screen: the Wasm tier sees what the launch had to compile and build for the next one */
export function appLaunched(): void { backend?.launched?.(); }
/** the zygote's warm-up of the platform code launches use */
export const warmCode = (stop: () => boolean): Promise<void> => backend?.warm?.(stop) ?? Promise.resolve();

/** `dex` made known to the Java that runs: to `runtime` on the JS tier, to the one Wasm World on the Wasm tier, whose loaders share a namespace */
export function loadDex(runtime: Runtime, dex: DexFile, platform = false): void {
  if (tier !== "wasm") return runtime.loadDex(dex, platform);
  // the browser's platform classes are the tab's build and Program, not something a World is given, and may be loaded before the tab's build is open
  if (!backend && platform) return;
  if (!backend) throw new Error("?tier=wasm: loadTier() has not run");
  backend.loadDex(dex, platform);
}

export interface JavaClass {
  readonly name: string;
  /** a new instance, its constructor not yet run */
  "new"(): object;
  /** the value of static field `name`; `desc` names the field exactly, which a class declaring `name` twice needs */
  static(name: string, desc?: string): unknown;
  /** sets static field `name`, as `static` names it; false if the class declares no such field */
  setStatic(name: string, value: unknown, desc?: string): boolean;
  /** sets the static fields `entries` name, all of type `desc`, as `setStatic` does (the fields the class does not declare are skipped): a class with hundreds of constants */
  setStatics(entries: [name: string, value: unknown][], desc: string): void;
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
    setStatics: (entries, desc) => { for (const [name, value] of entries) cls!.setStatic(name, value, desc); },
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
