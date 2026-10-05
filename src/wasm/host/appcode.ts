// The app's compiled code before a launch (the counterpart of what src/shell/device.ts does with src/jvm/codecache.ts and aot.ts on the JS tier): a build saved by an earlier launch is
// loaded, and a launch without one has a worker compile the methods the app is likely to run for the next launch to find. A launch also notes what its World compiled and built
// on demand despite the build (`watch`), and once that has settled a worker makes the build again with it, so the launches after the next find it too. A compile worker for the
// launch's second-tier units is made either way; `start` gives it the World. The options go to the World's constructor: the saved build only attaches while the World has
// numbered nothing since the platform build.
import type { World, WorldOptions } from "../link/world";
import type { Demand } from "../link/aot";
import { mid } from "../compiler/ids";
import type { DexFile } from "../../jvm/dex";
import type { FetchStore } from "../link/aotstore";
import { buildFiles, appKey, SavedBuild, type Persist } from "./persist";
import { fetchBundle } from "./bundle";
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
  signal?: AbortSignal;
}
export interface AppCode {
  /** whether a saved build was found and its modules compiled */
  hit: boolean;
  options: Pick<WorldOptions, "app" | "compiler">;
  /** the worker for second-tier units; give it the World once it exists */
  start(world: World): void;
  compiler: CompileClient;
  /** the build this launch made (and whether it was kept), when it had none to load */
  made?: Promise<Built>;
  /** makes the build again with what `world` has compiled and built on demand, if that is at least `min` things the saved build lacks; the build it made, if it did */
  refine(world: World, min?: number): Promise<Built | undefined>;
  /** from the first frame of the app on: looks at the launch every so often, and refines once it has gone quiet */
  watch(world: World): void;
  /** stops watching and both compiler workers; outstanding builds reject */
  close(): void;
}
export interface Built { kept: boolean; methods: number; modules: number; ms: number }

/** the least new on-demand work that is worth a new build, how often the launch is looked at, and for how long */
export const MIN_FRESH = 8;
const TICK_MS = 2000, WATCH_MS = 120_000, MAX_REFINES = 3;

export async function prepareApp(req: AppCodeRequest): Promise<AppCode> {
  // a store that fails is a store without the build
  const key = await appKey(req.dexes, req.aot.key);
  let files = await req.persist?.load(key).catch(() => undefined);
  if (!files) {
    // the platform build may ship a build for this app; this device keeps it for the launches after
    files = await fetchBundle(req.aot.base, key);
    if (files) void req.persist?.save(key, [...files]).catch(() => {});
  }
  const saved = files && await SavedBuild.open(files);
  req.signal?.throwIfAborted();
  const compiler = new CompileClient(req.spawn()), builder = new Builder(req, key);
  let closed = false, watching = false, timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    req.signal?.removeEventListener("abort", close);
    clearTimeout(timer); timer = undefined;
    compiler.close(); builder.close();
  };
  req.signal?.addEventListener("abort", close, { once: true });
  if (req.signal?.aborted) close();
  /** the classes the host implements, as the World began with them: a worker that builds applies the same ones */
  let hostClasses: string[] | undefined;
  /** what the saved build was asked to include, which the next one includes too */
  let covered: Demand = saved?.index.demand ?? { methods: [], classes: [], infos: [] };
  const code: AppCode = { hit: !!saved, compiler, options: { app: saved && { index: saved.index, store: saved }, compiler }, start: (world) => { if (closed) return; hostClasses = world.hostClassNames(); compiler.start(world, req.aot.base, saved?.index); },
    refine, watch: (world) => { if (!closed && !watching && req.persist) { watching = true; watch(world); } }, close };
  if (!saved && !closed) {
    code.made = builder.build({ methods: [], classes: [], infos: [] });
    code.made.catch((e) => { if (!closed) console.warn("[webdroid] the app build failed", e); });
  }

  /** what `world` built on demand that the saved build lacks, with the build's own demand before it */
  function demanded(world: World): { merged: Demand; fresh: number } {
    const methods = new Set(covered.methods), classes = new Set(covered.classes), infos = new Map(covered.infos.map((r) => [r.join("\0"), r])), before = methods.size + classes.size + infos.size;
    for (const m of world.demand.methods) if (m.codeOff || world.intrinsic(m)) methods.add(mid(m));
    for (const c of world.demand.classes) classes.add(c);
    for (const r of world.demand.infos) infos.set(r.join("\0"), r);
    return { merged: { methods: [...methods], classes: [...classes], infos: [...infos.values()] }, fresh: methods.size + classes.size + infos.size - before };
  }
  async function refine(world: World, min = MIN_FRESH): Promise<Built | undefined> {
    if (closed) return undefined;
    const { merged, fresh } = demanded(world);
    if (fresh < min) return undefined;
    const built = await builder.build(merged, hostClasses);
    if (built.kept) covered = merged;
    return built;
  }
  function watch(world: World): void {
    let last = -1, refines = 0, building = false;
    const until = performance.now() + WATCH_MS;
    const again = () => { if (!closed) timer = setTimeout(tick, TICK_MS); };
    const tick = () => {
      timer = undefined;
      if (closed) return;
      if (performance.now() > until && !building && !builder.busy) { builder.close(undefined, false); return; }
      if (building || builder.busy) { again(); return; }
      const { fresh } = demanded(world);
      // the launch has gone quiet: what it compiled since the last look is all there is for now
      if (fresh >= MIN_FRESH && fresh === last) {
        building = true;
        refine(world).catch((e) => { if (!closed) console.warn("[webdroid] the app build failed", e); })
          .finally(() => { building = false; if (++refines >= MAX_REFINES) builder.close(undefined, false); else again(); });
        return;
      }
      last = fresh;
      again();
    };
    again();
  }
  return code;
}

/** the worker that builds the app, started by the first build and kept for the ones after it */
class Builder {
  private closed = false;
  private port?: WorkerPort;
  private waiting?: { resolve(built: Built): void; reject(error: Error): void };
  constructor(private req: AppCodeRequest, private key: string) {}
  get busy(): boolean { return !!this.waiting; }
  /** builds with `demand`; the worker checks that the host's classes it applies are the ones `hostClasses` names */
  build(demand: Demand, hostClasses?: string[]): Promise<Built> {
    if (this.closed) return Promise.reject(new Error("App code closed"));
    if (this.waiting) return Promise.reject(new Error("An app build is already pending"));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve: (built) => { this.waiting = undefined; resolve(built); }, reject: (error) => { this.waiting = undefined; reject(error); } };
      try {
        if (this.port) { this.port.postMessage({ type: "refine", demand }); return; }
        const port = this.req.spawn();
        if (this.closed) { port.terminate(); return; }
        this.port = port;
        const list = containers(this.req.dexes);
        port.onmessage = async ({ data }: MessageEvent<CompileResponse>) => {
          if (this.closed || this.port !== port) return;
          if (data.type === "loaded") port.postMessage({ type: "init", dexes: list, aot: { base: this.req.aot.base }, hostClasses, build: this.req.roots, demand }, list.map(([, b]) => b.buffer as ArrayBuffer));
          if (data.type === "failed") this.close(new Error(data.message), false);
          if (data.type !== "built") return;
          const pending = this.waiting;
          const kept = !!await this.req.persist?.save(this.key, buildFiles(data.build)).catch(() => false);
          if (!this.closed && this.waiting === pending) pending?.resolve({ kept, methods: data.methods, modules: data.build.files.length, ms: data.ms });
        };
        port.onerror = (e) => this.close(new Error(e.message), false);
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error)), false); }
    });
  }
  close(error = new Error("App code closed"), terminal = true): void {
    if (this.closed) return;
    this.closed = terminal;
    if (this.port) { this.port.onmessage = null; this.port.onerror = null; this.port.terminate(); this.port = undefined; }
    this.waiting?.reject(error);
  }
}
