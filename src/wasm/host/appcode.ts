// The app's compiled code before a launch: a build saved by an earlier launch is loaded, and a launch without one has a worker compile the methods the app is likely
// to run for the next launch to find, once the launch is under way (`watch`) and its loader's shared libraries, which the build resolves through, are bound. A launch
// also notes what its World compiled and built on demand despite the build, and once that has settled a worker makes the build again with it, so the launches after
// the next find it too. A compile worker for the launch's second-tier units is made either way; `start` gives it the World. The World attaches the saved build only
// while it has numbered what it had when the app's dexes arrived, as when the build was made (the zygote's numbering).
import type { World, WorldOptions } from "../link/world.ts";
import { libraryLoaders, parseAotFile, type Demand } from "../link/aot.ts";
import type { Numbering } from "../link/numbers.ts";
import { mid } from "../compiler/ids.ts";
import type { DexFile } from "../../jvm/dex.ts";
import type { FetchStore } from "./aotstore.ts";
import { buildFiles, appKey, LaunchRecord, SavedBuild, type Persist } from "./persist.ts";
import { fetchBundle } from "./bundle.ts";
import { switchOn } from "../../switches.ts";
import { CompileClient, containers, dexesByLoader, type WorkerPort } from "./compiler.ts";
import type { WarmAnswer, WarmRequest } from "./warm-worker.ts";
import type { BuildRoots, CompileRequest, CompileResponse, Containers } from "./compile-serve.ts";
import { mergeApp } from "../link/apps.ts";
import type { LoaderId, LoaderSnapshot, MethodInfo } from "../compiler/program.ts";

export interface AppCodeRequest {
  /** the app's dex files */
  dexes: DexFile[];
  /** the platform build the code is made against */
  aot: Pick<FetchStore, "base" | "key" | "bytes">;
  /** fetches the platform modules earlier launches loaded (aotload.ts prefetchInWorker) */
  prefetch?(files: string[]): Promise<void>;
  persist?: Persist;
  spawn(): WorkerPort;
  /** where an app build starts, for a launch without a saved one; whether it takes all of the app is decided here unless `whole` says */
  roots: BuildRoots;
  /** what the World had numbered after the platform build when the app's dexes arrived (nothing by default): where a build's numbering starts */
  prefix?: Numbering;
  signal?: AbortSignal;
  /** has the warm Worker compile build code the launch is about to run (warm-worker.ts) */
  warm?(request: WarmRequest, transfer?: Transferable[]): void;
  /** the process was launched to show the app, whose taps wait on its code */
  shown?: boolean;
}
/** a merge waits this long at most for the warm Worker */
const WARM_WAIT_MS = 1000;
/** has the warm Worker compile a merged unit's methods, which replace code the engine had compiled, before the World takes it (CompileClient) */
const warmMerge = (warm: NonNullable<AppCodeRequest["warm"]>) => (module: WebAssembly.Module, bytes: Uint8Array) => new Promise<WarmAnswer | undefined>((resolve) => {
  const { port1, port2 } = new MessageChannel(), timer = setTimeout(() => done(), WARM_WAIT_MS);
  const done = (answer?: WarmAnswer) => { clearTimeout(timer); port1.close(); resolve(answer); };
  port1.onmessage = ({ data }: MessageEvent<WarmAnswer>) => done(data);
  warm({ modules: [[module, bytes]], all: true, answer: port2 }, [bytes.buffer, port2]);
});
export interface AppCode {
  /** whether a saved build was found and its modules compiled */
  hit: boolean;
  /** settles once the platform modules earlier launches of the app loaded are compiled, which no Java should run before */
  launchReady: Promise<void>;
  /** where the build came from: saved by an earlier launch, shipped with the platform build, or made before this launch */
  source: "persist" | "bundle" | "built" | "none";
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
/** a build's files, and whether they were kept */
type Made = { files: Map<string, Uint8Array>; kept: Promise<boolean>; methods: number; ms: number };
const NO_DEMAND: Demand = { methods: [], classes: [], synths: [] };

/** The shards of a build a launch waits for: one per two logical cores (11 shards on 14 cores, efficiency cores among them, took FitNotes 1.14 s against 0.85 s for 6),
 *  one per SHARD_METHODS method references of the app, and as many as fit in 3/8 of the device's memory up to SHARD_BUDGET_MB. A shard holds a Program and World over
 *  the platform and the app; its heap peaks at about SHARD_BASE_MB and a MB per SHARD_REFS_PER_MB references (FitNotes' 26k: 134–147 MB each; Komikku's 157k: 330–
 *  510 MB, less the more run). Komikku's first frame came at 6.3, 5.5, 5.4 and 5.0 s with 4, 6, 8 and 10 shards, which took the compile host to 1.8, 2.5, 2.9 and 3.5 GB. */
const SHARD_BASE_MB = 96, SHARD_REFS_PER_MB = 500, SHARD_BUDGET_MB = 3072, SHARD_METHODS = 5_000;
/** the method references of an app whose builds take all its methods: a build of this many takes a few seconds in a few shards */
const WHOLE_LIMIT = 250_000;
function shardCount(refs: number): number {
  const nav = globalThis.navigator as { hardwareConcurrency?: number; deviceMemory?: number } | undefined;
  const memory = Math.min(SHARD_BUDGET_MB, (nav?.deviceMemory ?? 4) * 384);
  return Math.max(1, Math.min((nav?.hardwareConcurrency ?? 4) >> 1, Math.floor(memory / (SHARD_BASE_MB + refs / SHARD_REFS_PER_MB)), Math.ceil(refs / SHARD_METHODS)));
}

/** the least new on-demand work that is worth a new build, how often the launch is looked at, and for how long */
const MIN_FRESH = 8;
/** a refine rebuilds all the build holds, so it waits for the new demand to be this share of it */
const REFINE_SHARE = 1 / 8;
const TICK_MS = 2000, WATCH_MS = 120_000, MAX_REFINES = 3;

/** a build a launch found to start from */
interface Found { files: Map<string, Uint8Array>; saved: SavedBuild; source: Exclude<AppCode["source"], "none">; persisted: Promise<boolean>; made?: Made }
/** The build a launch starts from: the one an earlier launch saved, or one the platform build ships for the app, which this device keeps for the launches after;
 *  without either, `make`'s, which a launch waits for */
async function findBuild(req: AppCodeRequest, key: string, stored: Map<string, Uint8Array> | undefined, make: () => Promise<Made> | undefined): Promise<Found | undefined> {
  const open = async (files: Map<string, Uint8Array> | undefined, source: Found["source"], persisted: () => Promise<boolean>, made?: Made): Promise<Found | undefined> => {
    const saved = files && await SavedBuild.open(files);
    return saved ? { files: files!, saved, source, persisted: persisted(), made } : undefined;
  };
  const bundle = async () => {
    // `?bundles=0` measures a first launch as one of an app the platform build ships nothing for
    const files = switchOn("bundles", true) ? await fetchBundle(req.aot.base, key) : undefined;
    return open(files, "bundle", () => req.persist?.save(key, [...files!]).catch(() => false) ?? Promise.resolve(false));
  };
  const built = async () => {
    const made = await make()?.catch((e) => { console.warn("[webdroid] the app build failed", e); });
    return made ? open(made.files, "built", () => made.kept, made) : undefined;
  };
  return await open(stored, "persist", async () => true) ?? await bundle() ?? await built();
}

export async function prepareApp(req: AppCodeRequest): Promise<AppCode> {
  const key = await appKey(req.dexes, req.aot.key);
  // a store that fails is a store without the build
  const [stored, record] = await Promise.all([req.persist?.load(key).catch(() => undefined), LaunchRecord.load(req.persist, key)]);
  const launchReady = record.files.length && req.prefetch ? req.prefetch(record.files) : Promise.resolve();
  req.warm?.({ files: record.files, slots: record.slots });
  const refs = req.dexes.reduce((n, d) => n + d.methodCount, 0), roots = { whole: refs <= WHOLE_LIMIT, ...req.roots };
  const builder = new Builder(req, key, roots), builds: Built[] = [];
  // a shown launch without a build waits for one of the whole app, as an install compiles an app ahead (dex2oat): its first taps run compiled code. A larger app's
  // build covers too little of its launch to wait for (TikTok waited 14 s for its roots' closure and still compiled 60k methods on demand)
  const found = await findBuild(req, key, stored, () => {
    if (!req.shown || !roots.whole) return undefined;
    return builder.build(NO_DEMAND, undefined, undefined, shardCount(refs));
  });
  const saved = found?.saved, source = found?.source ?? "none", persisted = found?.persisted ?? Promise.resolve(false);
  if (found?.made) { const { methods, files, ms } = found.made, modules = files.size - 1; void persisted.then((kept) => builds.unshift({ kept, methods, modules, ms })); }
  // once kept, the modules' bytes are the warm Worker's; a build the slots were not recorded against is warmed whole, in the order the app wants its methods, when
  // the app is shown: a background process's whole build is CPU taken from the launch it serves
  const warmAll = !!saved && !record.ran(saved.index.id);
  if (found && req.warm && (req.shown || !warmAll)) void persisted.then(() => {
    const modules = [...found.files].filter(([name]) => parseAotFile(name)?.kind === "a").map(([name, bytes]): [WebAssembly.Module, Uint8Array] => [found.saved.get(name)!, bytes]);
    // the transfer detaches the files' bytes
    found.files.clear();
    req.warm!({ modules, all: warmAll }, [...new Set(modules.map(([, bytes]) => bytes.buffer))]);
  });
  req.signal?.throwIfAborted();
  // merges wait for the launch's first frame, and leave the memory to a build while one is made
  const compiler = new CompileClient(() => req.spawn(), { holdMerges: () => !watching || builder.busy, warm: req.warm && warmMerge(req.warm) });
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
  const merged = { methods: new Set(initial?.methods), classes: new Set(initial?.classes), synths: new Set(initial?.synths) };
  const size = () => merged.methods.size + merged.classes.size + merged.synths.size;
  let covered = size(), seen = { world: undefined as World | undefined, methods: 0, classes: 0, synths: 0 };
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

  /** how much `world` built on demand that the saved build lacks and a build could hold: methods of the platform (its own Program's root), the app's loader and its libraries */
  function fresh(world: World): number {
    world.ahead.noteRuns();
    const d = world.demand, prog = world.prog, libraries = libraryLoaders(prog);
    const buildable = (m: MethodInfo) => { const l = m.dex && prog.loaderOfDex(m.dex); return !!l && (l === prog.boot || l === prog.root || l === prog.base?.root || libraries.has(l)); };
    if (seen.world !== world) seen = { world, methods: 0, classes: 0, synths: 0 };
    if (d.methods.size > seen.methods) {
      let i = 0;
      for (const m of d.methods) if (i++ >= seen.methods && (m.codeOff || world.intrinsic(m)) && buildable(m)) merged.methods.add(mid(m));
      seen.methods = d.methods.size;
    }
    for (; seen.classes < d.classes.length; seen.classes++) merged.classes.add(d.classes[seen.classes]);
    for (; seen.synths < d.synths.length; seen.synths++) merged.synths.add(d.synths[seen.synths]);
    return size() - covered;
  }
  async function rebuild(world: World): Promise<Built> {
    // the attached build's methods this launch ran lead, as on-demand ones do, so the classes a launch runs fill the first modules again
    const ran = !saved || !world.aot ? [] : world.aot.ranSlots().app.flatMap((s) => { const e = world.slots.at(s); return e?.k === "method" ? [mid(e.m)] : []; });
    const at = size(), made = await builder.build({ methods: [...new Set([...ran, ...merged.methods])], classes: [...merged.classes], synths: [...merged.synths] }, hostClasses, rootLibraries(world));
    const built: Built = { kept: await made.kept, methods: made.methods, modules: made.files.size - 1, ms: made.ms };
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
  /** keeps the platform modules this launch loaded and the build code it ran for the next one */
  function recordLaunch(world: World): void {
    const aot = world.aot;
    if (!aot) return;
    const ran = aot.ranSlots();
    record.add([...aot.loaded, ...aot.missed], saved?.index.id ?? 0, [...ran.platform, ...ran.app]);
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
      // the launch has gone quiet: what it compiled since the last look is all there is for now, and what it ran is kept, unless it is answering input
      if (now === last && !world.opts.answering?.()) recordLaunch(world);
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
/** the loaders of the libraries the app's loader searches, and theirs */
/** The libraries the app's loader searches, which code built for it resolves through: the loader numbering, their graph and their dexes. */
function rootLibraries(world: World): RootLibraries | undefined {
  const prog = world.prog, closure = libraryLoaders(prog);
  closure.delete(prog.boot);
  if (!closure.size) return undefined;
  const groups = dexesByLoader(prog, (l) => closure.has(l));
  const ids = new Set<LoaderId>([0, ...[...closure].map(l => prog.loaderId(l))]), snapshot = prog.loaderSnapshot();
  return { loaders: { ...snapshot, libraries: snapshot.libraries.filter(([id]) => ids.has(id)), initiated: snapshot.initiated.filter(([id]) => ids.has(id)) },
    scopes: [...groups].map(([id, dexes]) => [id, containers(dexes)]) };
}

/** A build owns fresh numbering contexts, one per shard; each worker is retired once it has transferred its part. A build nobody waits for has one, leaving the other
 *  cores to the app. */
class Builder {
  private req: AppCodeRequest; private key: string; private roots: BuildRoots;
  private closed = false;
  /** the build being made: its workers, and how to fail it */
  private running?: { ports: WorkerPort[]; fail(error: Error): void };
  private lease?: AbortController;
  constructor(req: AppCodeRequest, key: string, roots: BuildRoots) { this.req = req; this.key = key; this.roots = roots; }
  get busy(): boolean { return !!this.running; }
  /** builds with `demand`; the worker checks that the host's classes it applies are the ones `hostClasses` names */
  build(demand: Demand, hostClasses?: string[], libraries?: RootLibraries, shards = 1): Promise<Made> {
    if (this.closed) return Promise.reject(new Error("App code closed"));
    if (this.running) return Promise.reject(new Error("An app build is already pending"));
    let fail!: (error: Error) => void;
    const failed = new Promise<never>((_, reject) => { fail = reject; }), run = this.running = { ports: [] as WorkerPort[], fail };
    failed.catch(() => {});
    const make = async (): Promise<Made> => {
      if (this.running !== run) throw new Error("App code closed");
      const t0 = performance.now(), init = (shard: number): [CompileRequest, Transferable[]] => {
        const dexes = containers(this.req.dexes), scopes = libraries?.scopes.map(([id, dexes]): [LoaderId, Containers] => [id, dexes.map(([name, bytes]) => [name, bytes.slice()])]);
        return [{ type: "build", dexes, aot: { base: this.req.aot.base, index: this.req.aot.bytes("index.json") }, prefix: this.req.prefix, hostClasses, roots: this.roots, demand,
          shard: [shard, shards], ...libraries && { loaders: libraries.loaders, scopes } }, [dexes, ...scopes?.map(([, dexes]) => dexes) ?? []].flatMap((dexes) => dexes.map(([, b]) => b.buffer as ArrayBuffer))];
      };
      const [lead, ...rest] = await Promise.race([Promise.all(Array.from({ length: shards }, (_, shard) => this.runShard(run, init(shard)))), failed]);
      if (!("index" in lead.part)) throw new Error("the first shard's part has no index");
      const files = buildFiles(mergeApp(lead.part, rest.map((r) => r.part))), kept = this.req.persist?.save(this.key, files).then(Boolean, () => false) ?? Promise.resolve(false);
      return { files: new Map(files), kept, methods: lead.methods, ms: performance.now() - t0 };
    };
    // All process Workers share this origin's lock. Acquire before constructing their duplicate Program/World, and retain the lease until the worker has been retired.
    const locks = globalThis.navigator?.locks, lease = this.lease = locks && new AbortController();
    const made = locks ? Promise.race([locks.request("webdroid:wasm-app-build", { signal: lease!.signal }, make), failed]) : make();
    return made.finally(() => { this.stop(run); if (this.running === run) this.running = undefined; });
  }
  /** has a worker of its own make a shard's part from `init` */
  private runShard(run: NonNullable<Builder["running"]>, [init, transfer]: [CompileRequest, Transferable[]]): Promise<Extract<CompileResponse, { type: "built" }>> {
    return new Promise((resolve, reject) => {
      const port = this.req.spawn();
      run.ports.push(port);
      port.onmessage = ({ data }: MessageEvent<CompileResponse>) => {
        if (!run.ports.includes(port)) return;
        if (data.type === "loaded") port.postMessage(init, transfer);
        else if (data.type === "failed") reject(new Error(data.message));
        else if (data.type === "built") { this.stop(run, [port]); resolve(data); }
      };
      port.onerror = (e) => reject(new Error(e.message));
    });
  }
  /** retires `run`'s workers, or those of `ports` */
  private stop(run: NonNullable<Builder["running"]>, ports = run.ports): void {
    for (const port of ports) { port.onmessage = null; port.onerror = null; port.terminate(); }
    run.ports = run.ports.filter((port) => !ports.includes(port));
  }
  close(error = new Error("App code closed"), terminal = true): void {
    if (this.closed) return;
    this.closed = terminal;
    const run = this.running;
    this.running = undefined;
    run?.fail(error);
    this.lease?.abort(); this.lease = undefined;
    if (run) this.stop(run);
  }
}
