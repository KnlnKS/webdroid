// The Wasm tier's host as the places that load code see it: loaded by a dynamic import, so a page opens the tier's build while the rest starts.
// `JavaClass` is what host code holds of a loaded class.
import type { DexFile } from "./dex";

export interface ThreadState { name: string; state: string; blocker?: string; owner?: string; strands?: number[] }
/** what the Wasm tier's host provides the places that load code */
export interface TierBackend {
  threads(): ThreadState[];
  /** settles once the platform modules a start of the process loads are compiled: no Java runs before */
  ready?: Promise<void>;
  loadDex(dex: DexFile, platform: boolean): void;
  /** the app's dex files are all loaded: prepare its compiled code (a build an earlier launch saved) before Java first runs */
  appCode?(roots: { profile?: Uint8Array; manifest?: Uint8Array; launch: string[] }): Promise<void>;
  /** has the engine compile the platform code launches use until `stop` says to: whether it went through all of it (World.warm) */
  warm?(stop: () => boolean): Promise<boolean>;
  /** the app has shown its first frame */
  launched?(): void;
  /** compiles code the app is likely to call soon in slices, while `idle` says the app's main thread still waits */
  ahead?(idle: () => boolean): Promise<void>;
}
let backend: TierBackend | undefined;
export const wasmThreads = (): ThreadState[] => backend?.threads() ?? [];
let loading: Promise<void> | undefined;
/** loads the Wasm tier's host. A page asks as soon as it runs, so that the tier's build is opened while the rest starts. */
export function loadTier(): Promise<void> {
  return loading ??= import("../wasm/host/boot").then(async (host) => { backend = await host.bootWasmTier(); });
}

/** a process Worker's Wasm modules come from the page's store of the platform build: the page serves the port, the Worker uses it */
export function serveAot(port: MessagePort): void {
  void import("../wasm/host/boot").then((host) => host.serveAot(port));
}
/** and the page's compile host (wasm/host/compilehost.ts) starts its compile workers */
export function serveCompileWorkers(port: MessagePort): void {
  void import("../wasm/host/compilehost").then((host) => host.serveCompileWorkers(port));
}
export async function usePagePorts(aot: MessagePort, compile: MessagePort): Promise<void> {
  (await import("../wasm/host/boot")).usePagePorts(aot, compile);
}

/** the Wasm tier's compiled app code, once the app's dex files are loaded */
export async function loadAppCode(roots: { profile?: Uint8Array; manifest?: Uint8Array; launch: string[] }): Promise<void> { await backend?.appCode?.(roots); }
/** settles once the Wasm tier can run Java */
export const tierReady = (): Promise<void> => loadTier().then(() => backend?.ready);
/** the app's first frame is on the screen: the Wasm tier sees what the launch had to compile and build for the next one */
export function appLaunched(): void { backend?.launched?.(); }
/** the main thread has waited a while: spend the time compiling ahead while `idle` holds */
export function compileAhead(idle: () => boolean): void { void backend?.ahead?.(idle); }
/** the zygote's warm-up of the platform code launches use */
export const warmCode = (stop: () => boolean): Promise<boolean> => backend?.warm?.(stop) ?? Promise.resolve(true);

/** `dex` made known to the one World, whose loaders share a namespace */
export function loadDex(dex: DexFile, platform = false): void {
  // the browser's platform classes are the tab's build and Program, not something a World is given, and may be loaded before the tab's build is open
  if (!backend && platform) return;
  if (!backend) throw new Error("loadTier() has not run");
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
