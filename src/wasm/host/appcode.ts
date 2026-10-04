// The app's compiled code before a launch (the counterpart of what src/shell/device.ts does with src/jvm/codecache.ts and aot.ts on the JS tier): a build saved by an earlier launch is
// loaded, and a launch without one has a worker compile the methods the app is likely to run for the next launch to find. A compile worker for the launch's second-tier units is made
// either way; `start` gives it the World. The options go to the World's constructor: the saved build only attaches while the World has numbered nothing since the platform build.
import type { World, WorldOptions } from "../link/world";
import type { DexFile } from "../../jvm/dex";
import type { FetchStore } from "../link/aotstore";
import { buildFiles, appKey, SavedBuild, type Persist } from "./persist";
import { CompileClient, containers, type WorkerPort } from "./compiler";
import type { BuildRoots, CompileResponse } from "./compile-serve";

export interface AppCodeRequest {
  /** the app's dex files */
  dexes: DexFile[];
  /** the platform build the code is made against */
  aot: FetchStore;
  persist?: Persist;
  spawn(): WorkerPort;
  /** where an app build starts, for a launch without a saved one */
  roots: BuildRoots;
}
export interface AppCode {
  /** whether a saved build was found and its modules compiled */
  hit: boolean;
  options: Pick<WorldOptions, "app" | "compiler">;
  /** the worker for second-tier units; give it the World once it exists */
  start(world: World): void;
  compiler: CompileClient;
  /** the build this launch made (and whether it was kept), when it had none to load */
  made?: Promise<{ kept: boolean; methods: number; modules: number; ms: number }>;
}

export async function prepareApp(req: AppCodeRequest): Promise<AppCode> {
  // a store that fails is a store without the build
  const key = await appKey(req.dexes, req.aot.key), files = await req.persist?.load(key).catch(() => undefined), saved = files && await SavedBuild.open(files);
  const compiler = new CompileClient(req.spawn());
  const code: AppCode = { hit: !!saved, compiler, options: { app: saved && { index: saved.index, store: saved }, compiler }, start: (world) => compiler.start(world, req.aot.base, saved?.index) };
  if (!saved) {
    code.made = make(req, key);
    code.made.catch((e) => console.warn("[webdroid] the app build failed", e));
  }
  return code;
}

/** a worker of its own builds the app: the page's launch goes on meanwhile */
function make(req: AppCodeRequest, key: string): NonNullable<AppCode["made"]> {
  return new Promise((resolve, reject) => {
    const port = req.spawn(), list = containers(req.dexes);
    port.onmessage = async ({ data }: MessageEvent<CompileResponse>) => {
      if (data.type === "loaded") port.postMessage({ type: "init", dexes: list, aot: { base: req.aot.base }, build: req.roots }, list.map(([, b]) => b.buffer as ArrayBuffer));
      if (data.type === "failed") { port.terminate(); reject(new Error(data.message)); }
      if (data.type !== "built") return;
      port.terminate();
      const kept = !!await req.persist?.save(key, buildFiles(data.build)).catch(() => false);
      resolve({ kept, methods: data.methods, modules: data.build.files.length, ms: data.ms });
    };
    port.onerror = (e) => reject(new Error(e.message));
  });
}
