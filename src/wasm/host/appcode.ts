// The app's compiled code before a launch: a build saved by an earlier launch is loaded, and a launch without one has a worker compile the methods the app is likely
// to run for the next launch to find, once the launch is under way (`watch`) and its loader's shared libraries, which the build resolves through, are bound. A launch
// also notes what its World compiled and built on demand despite the build, and once that has settled a worker makes the build again with it, so the launches after
// the next find it too. A compile worker for the launch's second-tier units is made either way; `start` gives it the World. The World attaches the saved build only
// while it has numbered what it had when the app's dexes arrived, as when the build was made (the zygote's numbering).
import type { World, WorldOptions } from "../link/world.ts";
import type { Demand, Numbering } from "../link/aot.ts";
import { mid } from "../compiler/ids.ts";
import type { DexFile } from "../../jvm/dex.ts";
import type { FetchStore } from "../link/aotstore.ts";
import { buildFiles, appKey, SavedBuild, type Persist } from "./persist.ts";
import { fetchBundle } from "./bundle.ts";
import { switchOn } from "../../switches.ts";
import { prefetchInWorker } from "./aotload.ts";
import { CompileClient, containers, dexesByLoader, type WorkerPort } from "./compiler.ts";
import type { BuildRoots, CompileResponse, Containers } from "./compile-serve.ts";
import type { Loader, LoaderId, LoaderSnapshot } from "../compiler/program.ts";

export interface AppCodeRequest {
  /** the app's dex files */
  dexes: DexFile[];
  /** the platform build the code is made against */
  aot: FetchStore;
  persist?: Persist;
  spawn(): WorkerPort;
  /** where an app build starts, for a launch without a saved one */
  roots: BuildRoots;
  /** what the World had numbered after the platform build when the app's dexes arrived (nothing by default): where a build's numbering starts */
  prefix?: Numbering;
  signal?: AbortSignal;
}
export interface AppCode {
  /** whether a saved build was found and its modules compiled */
  hit: boolean;
  /** settles once the platform modules earlier launches of the app loaded are compiled, which no Java should run before */
  launchReady: Promise<void>;
  source: "persist" | "bundle" | "none";
  persisted: Promise<boolean>;
  /** the saved build, for the World to attach */
  saved?: NonNullable<WorldOptions["app"]>;
  /** the worker for second-tier units; give it the World once it exists */
  start(world: World): void;
  compiler: CompileClient;
  /** the build this launch made from its start on (and whether it was kept), when it had none to load */
  made?: Promise<Built>;
  /** makes the build again with what `world` has compiled and built on demand, if that is at least `min` things the saved build lacks; the build it made, if it did */
  refine(world: World, min?: number): Promise<Built | undefined>;
  /** from the first frame of the app on: makes the build the launch had none of, looks at the launch every so often, and refines once it has gone quiet */
  watch(world: World): void;
  /** waits for a build in progress, then builds again with everything `world` built on demand and decided since (a profile run exports the result: scripts/wasm/aot-profile.ts) */
  settle(world: World): Promise<Built | undefined>;
  /** the builds made so far, the last first */
  builds: Built[];
  /** stops watching and both compiler workers; outstanding builds reject */
  close(): void;
}
export interface Built { kept: boolean; methods: number; modules: number; ms: number }

/** the least new on-demand work that is worth a new build, how often the launch is looked at, and for how long */
const MIN_FRESH = 8;
/** a refine rebuilds all the build holds, so it waits for the new demand to be this share of it */
const REFINE_SHARE = 1 / 8;
const TICK_MS = 2000, WATCH_MS = 120_000, MAX_REFINES = 3;

export async function prepareApp(req: AppCodeRequest): Promise<AppCode> {
  // a store that fails is a store without the build
  const key = await appKey(req.dexes, req.aot.key), launchKey = key + "-launch";
  let [files, launch] = await Promise.all([req.persist?.load(key).catch(() => undefined), req.persist?.load(launchKey).catch(() => undefined)]);
  const launchFiles: string[] = launch?.has("files.json") ? JSON.parse(new TextDecoder().decode(launch.get("files.json"))) : [];
  const launchReady = launchFiles.length ? prefetchInWorker(req.aot, launchFiles) : Promise.resolve();
  let source: AppCode["source"] = files ? "persist" : "none";
  // `?bundles=0` measures a first launch as one of an app the platform build ships nothing for
  if (!files && switchOn("bundles", true)) {
    // the platform build may ship a build for this app; this device keeps it for the launches after
    files = await fetchBundle(req.aot.base, key);
    if (files) source = "bundle";
  }
  const saved = files && await SavedBuild.open(files);
  if (!saved) source = "none";
  const persisted = saved && source === "persist" ? Promise.resolve(true)
    : saved && files && req.persist ? req.persist.save(key, [...files]).catch(() => false) : Promise.resolve(false);
  req.signal?.throwIfAborted();
  // merges wait for the launch's first frame, and leave the memory to a build while one is made
  const compiler = new CompileClient(() => req.spawn(), () => !watching || builder.busy), builder = new Builder(req, key);
  let closed = false, watching = false, timer: ReturnType<typeof setTimeout> | undefined, release = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    req.signal?.removeEventListener("abort", close);
    clearTimeout(timer); timer = undefined;
    compiler.close(); builder.close(); release();
  };
  req.signal?.addEventListener("abort", close, { once: true });
  if (req.signal?.aborted) close();
  /** the classes the host implements, as the World began with them: a worker that builds applies the same ones */
  let hostClasses: string[] | undefined;
  /** what the saved build was asked to include and what the World built on demand since, merged as the launch goes: a look at it reads only what is new.
   *  `covered` is how much of it the saved build holds. */
  const initial = saved?.index.demand;
  const merged = { methods: new Set(initial?.methods), classes: new Set(initial?.classes), infos: new Map(initial?.infos.map((r) => [r.join("\0"), r])) };
  const size = () => merged.methods.size + merged.classes.size + merged.infos.size;
  let covered = size(), seen = { world: undefined as World | undefined, methods: 0, classes: 0, infos: 0 };
  const builds: Built[] = [];
  const code: AppCode = { hit: !!saved, launchReady, source, persisted, compiler, saved: saved ? { index: saved.index, store: saved } : undefined, start: (world) => { if (closed) return; hostClasses = world.hostClassNames(); compiler.start(world, req.aot.base, saved?.index); },
    refine, watch: (world) => {
      if (closed || watching) return;
      watching = true;
      claim(() => {
        if (!saved) { fresh(world); (code.made = rebuild(world)).catch((e) => { if (!closed) console.warn("[webdroid] the app build failed", e); }); }
        if (req.persist) watch(world); else void code.made?.then(release, release);
      });
    }, settle, builds, close };

  /** Every process of an app builds under the same key, each worker holding a World over the app's dexes and replacing the others' build: the first
   *  process to launch makes it until its watch ends. */
  function claim(start: () => void): void {
    const locks = globalThis.navigator?.locks;
    if (!locks) { start(); return; }
    const released = new Promise<void>((resolve) => { release = resolve; });
    void locks.request(`webdroid:wasm-app:${key}`, { ifAvailable: true }, (lock) => {
      if (!lock || closed) return;
      start();
      return released;
    }).catch(() => {});
  }

  /** how much `world` built on demand that the saved build lacks */
  function fresh(world: World): number {
    world.noteAheadRuns();
    const d = world.demand;
    if (seen.world !== world) seen = { world, methods: 0, classes: 0, infos: 0 };
    if (d.methods.size > seen.methods) {
      let i = 0;
      for (const m of d.methods) if (i++ >= seen.methods && (m.codeOff || world.intrinsic(m))) merged.methods.add(mid(m));
      seen.methods = d.methods.size;
    }
    for (; seen.classes < d.classes.length; seen.classes++) merged.classes.add(d.classes[seen.classes]);
    for (; seen.infos < d.infos.length; seen.infos++) { const r = d.infos[seen.infos]; merged.infos.set(r.join("\0"), r); }
    return size() - covered;
  }
  async function rebuild(world: World): Promise<Built> {
    const at = size(), built = await builder.build({ methods: [...merged.methods], classes: [...merged.classes], infos: [...merged.infos.values()] }, hostClasses, rootLibraries(world));
    builds.unshift(built);
    if (built.kept) covered = at;
    return built;
  }
  async function refine(world: World, min = MIN_FRESH): Promise<Built | undefined> {
    return closed || fresh(world) < min ? undefined : rebuild(world);
  }
  async function settle(world: World): Promise<Built | undefined> {
    recordLaunch(world);
    await code.made?.catch(() => {});
    while (builder.busy && !closed) await new Promise((r) => setTimeout(r, 100));
    return refine(world, 1);
  }
  /** keeps the platform modules this launch loaded for the next one, once they include any the last launch did not */
  function recordLaunch(world: World): void {
    const aot = world.aot;
    if (!aot) return;
    const known = new Set(launchFiles), loaded = [...aot.loaded, ...aot.missed].filter((f) => /^[cd]\d+\.wasm$/.test(f));
    if (loaded.every((f) => known.has(f))) return;
    const merged = [...new Set([...loaded, ...launchFiles])];
    void req.persist?.save(launchKey, [["files.json", new TextEncoder().encode(JSON.stringify(merged))]]).then((kept) => { if (kept) launchFiles.splice(0, Infinity, ...merged); }, () => {});
  }
  function watch(world: World): void {
    let last = -1, refines = 0, building = false;
    const until = performance.now() + WATCH_MS;
    const again = () => { if (!closed) timer = setTimeout(tick, TICK_MS); };
    const tick = () => {
      timer = undefined;
      if (closed) return;
      if (performance.now() > until && !building && !builder.busy) { builder.close(undefined, false); release(); return; }
      if (building || builder.busy) { again(); return; }
      const now = fresh(world);
      // the launch has gone quiet: what it compiled since the last look is all there is for now
      if (now === last) recordLaunch(world);
      if (now >= Math.max(MIN_FRESH, covered * REFINE_SHARE) && now === last) {
        building = true;
        refine(world, 1).catch((e) => { if (!closed) console.warn("[webdroid] the app build failed", e); })
          .finally(() => { building = false; if (++refines >= MAX_REFINES) { builder.close(undefined, false); release(); } else again(); });
        return;
      }
      last = now;
      again();
    };
    again();
  }
  return code;
}

type RootLibraries = { loaders: LoaderSnapshot; scopes: [LoaderId, Containers][] };
/** The libraries the app's loader searches, which code built for it resolves through: the loader numbering, their graph and their dexes. */
function rootLibraries(world: World): RootLibraries | undefined {
  const prog = world.prog, closure = new Set<Loader>();
  const add = (l: Loader) => {
    if (l === prog.boot || closure.has(l)) return;
    closure.add(l);
    for (const library of [...l.before ?? [], ...l.after ?? []]) add(library);
  };
  for (const library of [...prog.root.before ?? [], ...prog.root.after ?? []]) add(library);
  if (!closure.size) return undefined;
  const groups = dexesByLoader(prog, (l) => closure.has(l));
  const ids = new Set<LoaderId>([0, ...[...closure].map(l => prog.loaderId(l))]), snapshot = prog.loaderSnapshot();
  return { loaders: { ...snapshot, libraries: snapshot.libraries.filter(([id]) => ids.has(id)), initiated: snapshot.initiated.filter(([id]) => ids.has(id)) },
    scopes: [...groups].map(([id, dexes]) => [id, containers(dexes)]) };
}

/** A build owns a fresh numbering context; its worker is retired after transferring the result. */
class Builder {
  private req: AppCodeRequest; private key: string;
  private closed = false;
  private port?: WorkerPort;
  private waiting?: { resolve(built: Built): void; reject(error: Error): void };
  private lease?: AbortController;
  constructor(req: AppCodeRequest, key: string) { this.req = req; this.key = key; }
  get busy(): boolean { return !!this.waiting; }
  /** builds with `demand`; the worker checks that the host's classes it applies are the ones `hostClasses` names */
  build(demand: Demand, hostClasses?: string[], libraries?: RootLibraries): Promise<Built> {
    if (this.closed) return Promise.reject(new Error("App code closed"));
    if (this.waiting) return Promise.reject(new Error("An app build is already pending"));
    const result = new Promise<Built>((resolve, reject) => {
      this.waiting = { resolve: (built) => { this.waiting = undefined; resolve(built); }, reject: (error) => { this.waiting = undefined; reject(error); } };
    });
    const pending = this.waiting;
    const start = () => {
      if (this.waiting !== pending || this.closed) return result.catch(() => {});
      try {
        const port = this.req.spawn();
        if (this.closed) { port.terminate(); return result.catch(() => {}); }
        this.port = port;
        const list = containers(this.req.dexes);
        port.onmessage = async ({ data }: MessageEvent<CompileResponse>) => {
          if (this.closed || this.port !== port) return;
          if (data.type === "loaded") port.postMessage({ type: "init", dexes: list, aot: { base: this.req.aot.base }, prefix: this.req.prefix, hostClasses, build: this.req.roots, demand, oneShot: true, ...libraries },
            [list, ...libraries?.scopes.map(([, dexes]) => dexes) ?? []].flatMap(dexes => dexes.map(([, b]) => b.buffer as ArrayBuffer)));
          if (data.type === "failed") this.close(new Error(data.message), false);
          if (data.type !== "built") return;
          const pending = this.waiting;
          this.stopWorker();
          const kept = !!await this.req.persist?.save(this.key, buildFiles(data.build)).catch(() => false);
          if (!this.closed && this.waiting === pending) pending?.resolve({ kept, methods: data.methods, modules: data.build.files.length, ms: data.ms });
        };
        port.onerror = (e) => this.close(new Error(e.message), false);
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error)), false); }
      return result.catch(() => {});
    };
    // All process Workers share this origin's lock. Acquire before constructing their
    // duplicate Program/World, and retain the lease until the worker has been retired.
    const locks = globalThis.navigator?.locks;
    if (locks) {
      const lease = this.lease = new AbortController();
      void locks.request("webdroid:wasm-app-build", { signal: lease.signal }, start)
        .catch(error => { if (this.lease === lease) this.close(error instanceof Error ? error : new Error(String(error)), false); });
    } else void start();
    return result;
  }
  private stopWorker(): void {
    if (this.port) { this.port.onmessage = null; this.port.onerror = null; this.port.terminate(); this.port = undefined; }
  }
  close(error = new Error("App code closed"), terminal = true): void {
    if (this.closed) return;
    this.closed = terminal;
    const lease = this.lease; this.lease = undefined; lease?.abort();
    this.stopWorker();
    this.waiting?.reject(error);
  }
}
