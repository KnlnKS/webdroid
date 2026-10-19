// The Wasm tier's host as the places that load code see it: loaded by a dynamic import, so a page opens the tier's build while the rest starts.
// `JavaClass` is what host code holds of a loaded class.
import type { DexFile } from "./dex.ts";
import type { WasmStatus } from "../wasm/host/boot.ts";

/** what an app build starts from: its baseline profile, its manifest, and the classes a launch instantiates first */
export type AppRoots = { profile?: Uint8Array; manifest?: Uint8Array; launch: string[] };
export interface ThreadState { name: string; state: string; blocker?: string; owner?: string; strands?: number[] }
/** what the Wasm tier's host provides the places that load code */
export interface TierBackend {
  threads(): ThreadState[];
  /** settles once the platform modules a start of the process loads are compiled: no Java runs before */
  ready: Promise<void>;
  /** `dex` joins the realm's classes; `platform`: the boot class path's, which a harness's World takes and a page's has from its build */
  loadDex(dex: DexFile, platform: boolean): void;
  /** the app's dex files are read while the zygote runs: begin preparing its compiled code; `shown` when the process was launched to show the app */
  beginAppCode(dexes: DexFile[], roots: AppRoots, shown: boolean, status?: (text: string) => void): void;
  /** the app's dex files are all loaded: prepare the compiled code beginAppCode asked for (a build an earlier launch saved) before Java first runs */
  appCode(): Promise<void>;
  /** the app has shown its first frame */
  launched(): void;
  /** compiles code the app is likely to call soon in slices, while `idle` says the app's main thread still waits */
  ahead(idle: () => boolean): Promise<void>;
  /** where the realm's compiled code stands, as a harness reads it */
  status(): WasmStatus | undefined;
}
let backend: TierBackend | undefined;
export const wasmThreads = (): ThreadState[] => backend?.threads() ?? [];
export const tierStatus = (): WasmStatus | undefined => backend?.status();
let loading: Promise<void> | undefined;
/** loads the Wasm tier's host. A page asks as soon as it runs, so that the tier's build is opened while the rest starts. */
export function loadTier(): Promise<void> {
  return loading ??= import("../wasm/host/boot.ts").then(async (host) => { backend = await host.bootWasmTier(); });
}

/** how a process Worker's tier reaches the page's: the page's store of the platform build, its compile host (wasm/host/compilehost.ts),
 *  which starts the compile workers, and its warm Worker, which compiles the build code launches are about to run */
export type TierPorts = { aot: MessagePort; compile: MessagePort; warm: MessagePort };
/** the page serves a new process Worker's tier ports: their Worker ends, and closing the page's */
export function serveTierPorts(): { ports: TierPorts; close(): void } {
  const aot = new MessageChannel(), compile = new MessageChannel(), warm = new MessageChannel();
  void import("../wasm/host/boot.ts").then((host) => { host.serveAot(aot.port1); host.serveWarm(warm.port1); });
  void import("../wasm/host/compilehost.ts").then((host) => host.serveCompileWorkers(compile.port1));
  // the warm Worker took its end
  return { ports: { aot: aot.port2, compile: compile.port2, warm: warm.port2 }, close: () => { aot.port1.close(); compile.port1.close(); } };
}
export async function useTierPorts(ports: TierPorts): Promise<void> {
  (await import("../wasm/host/boot.ts")).useTierPorts(ports);
}

/** the Wasm tier begins preparing the app's code from its dex files before they are loaded */
export function beginAppCode(dexes: DexFile[], roots: AppRoots, shown: boolean, status?: (text: string) => void): void { backend?.beginAppCode(dexes, roots, shown, status); }
/** the Wasm tier's compiled app code, once the app's dex files are loaded; a process that began none (a system one) waits for the platform's modules */
export async function loadAppCode(): Promise<void> { await backend?.appCode(); }
/** settles once the Wasm tier can run Java */
export const tierReady = (): Promise<void> => loadTier().then(() => backend?.ready);
/** the app's first frame is on the screen: the Wasm tier sees what the launch had to compile and build for the next one */
export function appLaunched(): void { backend?.launched(); }
/** the main thread has waited a while: spend the time compiling ahead while `idle` holds */
export function compileAhead(idle: () => boolean): void { void backend?.ahead(idle); }

/** `dex` made known to the one World, whose loaders share a namespace */
export function loadDex(dex: DexFile, platform = false): void {
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
