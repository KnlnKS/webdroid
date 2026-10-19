// The compile worker's side of the protocol (compile-worker.ts runs it in a page, the persist suite over a MessageChannel): a World over a copy of the app's dex files that compiles
// for the World on the page, which sends it jobs. It does two kinds of work with the code the page's compiler would make: the second-tier units of hot methods (link/unit.ts), and, once
// per app and platform build, the app build the page persists (link/apps.ts), which compiles the methods the app is likely to run.
import { Program, type MethodInfo, type LoaderId, type LoaderSnapshot } from "../compiler/program.ts";
import { defineProxy, type ProxyDefinition } from "../link/proxy.ts";
import { World } from "../link/world.ts";
import { buildPart, type AppPart } from "../link/apps.ts";
import { UnitCompiler, type UnitResult, type UpgradeJob } from "../link/unit.ts";
import type { AppIndex, Demand } from "../link/aot.ts";
import type { Numbering } from "../link/numbers.ts";
import type { Intrinsic } from "../compiler/j2w.ts";
import type { NativeBinder } from "../link/hostapi.ts";
import { Program as Reach, callClosure, type MethodRoot } from "../../jvm/reach.ts";
import { parseBaselineProfile } from "../../jvm/baselineprof.ts";
import { rootsOf } from "../../jvm/roots.ts";
import { dexesIn, type DexFile } from "../../jvm/dex.ts";
import { methodOf } from "../compiler/ids.ts";
import type { AppRoots } from "../../jvm/tier.ts";

/** what the worker's realm provides: the platform's dex files, the registered natives and the intrinsics, which must be the page's for the code to be the page's */
export interface CompileEnv {
  platform(): Promise<DexFile[]>;
  natives: NativeBinder;
  intrinsics: Map<string, Intrinsic>;
  externs: string[];
  fetchBytes(url: string): Promise<Uint8Array>;
  heapUsed(): number;
  hostWhole?(name: string): boolean;
}
/** the methods an app build compiles: the baseline profile's, then all of the app's when `whole`, else those of the classes a launch instantiates, those of the manifest's
 *  other components, and what these call, up to `limit` */
export type BuildRoots = AppRoots & { whole?: boolean; limit?: number };
/** dex files as they cross to the worker: the archives' bytes (an entry of a stored archive is a view of the whole archive) and their names */
export type Containers = [name: string, bytes: Uint8Array][];

export type CompileRequest =
  | { type: "init"; dexes: Containers; aot?: { base: string; index?: Uint8Array; app?: AppIndex }; sync?: Numbering; prefix?: Numbering; hostClasses?: string[]; loaders?: LoaderSnapshot; scopes?: [LoaderId, Containers][]; proxies?: ProxyDefinition[]; build?: BuildRoots; demand?: Demand; oneShot?: true; shard?: [index: number, shards: number] }
  | { type: "add"; dexes: Containers; loader?: LoaderId; loaders?: LoaderSnapshot }
  | { type: "proxy"; definition: ProxyDefinition; loaders: LoaderSnapshot }
  | { type: "namespaces"; loaders: LoaderSnapshot }
  /** the app build again, with more built on demand since (the World of a worker that was asked for a build serves it once more) */
  | { type: "refine"; demand: Demand }
  | { type: "upgrade"; id: number; keep: boolean; sync: Numbering; job: UpgradeJob };
export type CompileResponse =
  /** the worker is listening: a module worker whose imports await something drops the messages sent before it is, so nothing is sent until this arrives */
  | { type: "loaded" }
  | { type: "ready"; ms: number }
  | { type: "built"; part: AppPart; methods: number; ms: number }
  | { type: "unit"; id: number; result: UnitResult; ms: number }
  | { type: "failed"; id?: number; message: string };
export interface Port { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

const CLOSURE_LIMIT = 20_000;

export function serveCompile(port: Port, env: CompileEnv): void {
  let w: World | undefined, units: UnitCompiler | undefined, appDexes: DexFile[] = [], roots: BuildRoots | undefined;
  const send = (m: CompileResponse, transfer: Transferable[] = []) => port.postMessage(m, transfer);
  const open = (dexes: Containers) => dexes.flatMap(([name, bytes]) => dexesIn(bytes, name));

  async function init(req: Extract<CompileRequest, { type: "init" }>): Promise<number> {
    const t0 = performance.now(), index = req.aot && (req.aot.index ?? await env.fetchBytes(req.aot.base + "index.json"));
    const platform = new Program(await env.platform());
    platform.addExterns(env.externs); appDexes = open(req.dexes);
    const program = new Program(appDexes, platform);
    // an app build follows the loaders once its World has started, below
    if (!req.build) {
      if (req.loaders) { program.followLoaderParents(req.loaders.parents, req.loaders.ownFirst); program.dynamicRoot = !!req.loaders.dynamicRoot; }
      for (const [id, dexes] of req.scopes ?? []) program.add(open(dexes), program.loaderAt(id));
      if (req.loaders) {
        for (const [id, before, after] of req.loaders.libraries) program.libraries(program.loaderAt(id), before.map(id => program.loaderAt(id)), after.map(id => program.loaderAt(id)));
        for (const [id, name, key] of req.loaders.initiated) program.initiate(program.loaderAt(id), name, key);
      }
    }
    w = new World(program, { intrinsics: env.intrinsics, natives: env.natives, heapUsed: env.heapUsed, hostWhole: env.hostWhole, compileOnly: true,
      ...index && { aot: { get: (file) => (file === "index.json" ? index : undefined) }, ...req.aot!.app && { app: { index: req.aot!.app, store: { get: () => undefined } } } } });
    // Initial app builds precede hostClasses arriving. Apply overlays from the start, as the page does.
    for (const spec of env.natives.source?.hostSpecs?.() ?? []) w.addHostClass(spec);
    for (const definition of req.proxies ?? []) defineProxy(w, definition);
    if (req.hostClasses && req.hostClasses.join() !== w.hostClassNames().join()) throw new Error(`the worker's host classes are not the page's: ${w.hostClassNames().filter((n) => !req.hostClasses!.includes(n)).join()} against ${req.hostClasses.filter((n) => !w!.hostClassNames().includes(n)).join()}`);
    // an app build numbers from where the page's World was when the app's dexes arrived, before the page's numbering is followed; its app's libraries are bound after, as the
    // page's loader bound them
    roots = req.build;
    if (roots && req.prefix && !w.adopt(req.prefix)) throw new Error("the app's prefix does not follow the platform build");
    if (roots && req.loaders) {
      w.prog.followLoaderParents(req.loaders.parents, req.loaders.ownFirst);
      for (const [id, dexes] of req.scopes ?? []) w.addDexes(open(dexes), w.prog.loaderAt(id));
      followLoaders(w, req.loaders);
    }
    if (roots) {
      build(req.demand ?? { methods: [], classes: [], infos: [] }, req.oneShot, req.shard);
      if (req.oneShot) return performance.now() - t0;
    }
    units = new UnitCompiler(w);
    if (req.sync && !units.sync(req.sync, true)) throw new Error("the page's numbering is not the worker's at the start");
    return performance.now() - t0;
  }

  /** a build that may be refined restores the numbering; a one-shot build's worker is retired after it */
  function build(demand: Demand, oneShot = false, [shard, shards] = [0, 1]): void {
    const t0 = performance.now(), methods = select(roots!, demand), base = w!.numbers.marks(), part = buildPart(w!, methods, demand, shard, shards), ms = performance.now() - t0;
    if (!oneShot) w!.rollback(base);
    send({ type: "built", part, methods: methods.length, ms }, part.files.map(([, bytes]) => bytes.buffer as ArrayBuffer));
  }

  /** the methods an app build compiles, in the order the app is likely to want them: those a launch compiled on demand first, then the likely ones */
  function select(roots: BuildRoots, demand: Demand): MethodInfo[] {
    const world = w!, reach = new Reach(), out = new Set<MethodInfo>();
    for (const id of demand.methods) {
      const m = methodOf(world.prog, id);
      if (m && (m.codeOff || world.intrinsic(m))) out.add(m);
    }
    appDexes.forEach((d) => reach.add(d));
    const take = (cls: string, dex: DexFile, methodIdx: number) => {
      const m = world.prog.get(cls)?.methods.find((x) => x.dex === dex && x.methodIdx === methodIdx);
      if (m && (m.codeOff || world.intrinsic(m))) out.add(m);
    };
    const nameOf = (dex: DexFile, idx: number) => dex.typeName(dex.method(idx).cls);
    const rootOf = (dex: DexFile, idx: number): MethodRoot => ({ cls: nameOf(dex, idx), sig: dex.method(idx).name + dex.methodDesc(idx) });
    let called: MethodRoot[] = [];
    for (const [name, methods] of (roots.profile && parseBaselineProfile(roots.profile)) || []) {
      const dex = appDexes.find((d) => d.name === name);
      if (dex) for (const m of methods) if (m < dex.methodCount) { take(nameOf(dex, m), dex, m); called.push(rootOf(dex, m)); }
    }
    if (roots.whole) {
      const mine = new Set(appDexes);
      for (const cls of [roots.launch, [...world.prog.own()].filter((c) => c.dex && mine.has(c.dex)).map((c) => c.name)].flat())
        for (const m of world.prog.get(cls)?.methods ?? []) if (m.codeOff || world.intrinsic(m)) out.add(m);
      return [...out];
    }
    const others = roots.manifest ? rootsOf(roots.manifest, reach).classes.filter((c) => !roots.launch.includes(c)) : [];
    let budget = roots.limit ?? CLOSURE_LIMIT;
    for (const classes of [roots.launch, others]) {
      for (const cls of classes) {
        const def = reach.def(cls), dex = reach.dexOf(cls);
        if (def && dex) for (const m of [...def.directMethods, ...def.virtualMethods]) {
          if (m.codeOff) take(cls, dex, m.methodIdx);
          called.push(rootOf(dex, m.methodIdx));
        }
      }
      const closure = callClosure(reach, called, budget);
      budget -= closure.length;
      called = [];
      for (const { cls, dex, methodIdx } of closure) take(cls, dex, methodIdx);
    }
    return [...out];
  }

  const receive = async (req: CompileRequest) => {
    const id = "id" in req ? req.id : undefined, t0 = performance.now();
    try {
      if (req.type === "init") {
        if (req.oneShot && !req.build) throw new Error("one-shot compilation requires build roots");
        const ms = await init(req);
        if (!req.oneShot) send({ type: "ready", ms });
      }
      else if (!w || !units) throw new Error("not initialized");
      else if (req.type === "add") {
        if (req.loaders) followLoaders(w, req.loaders);
        w.addDexes(open(req.dexes), w.prog.loaderAt(req.loader ?? 0));
      }
      else if (req.type === "proxy" || req.type === "namespaces") {
        followLoaders(w, req.loaders);
        if (req.type === "proxy") defineProxy(w, req.definition);
      }
      else if (req.type === "refine") build(req.demand);
      else if (req.type === "upgrade") {
        if (!units.sync(req.sync, req.keep)) throw new Error("the page's numbering is not the worker's");
        const result = units.upgrade(req.job);
        if (typeof result === "string") send({ type: "failed", id, message: result });
        else send({ type: "unit", id: req.id, result, ms: performance.now() - t0 }, [(result.module as Uint8Array).buffer as ArrayBuffer]);
      }
    } catch (e) { send({ type: "failed", id, message: String((e as Error)?.stack ?? e) }); }
  };
  // Initialization awaits platform bytes; later definitions and jobs must follow its snapshot.
  let pending = Promise.resolve();
  port.onmessage = ({ data }: MessageEvent<CompileRequest>) => { pending = pending.then(() => receive(data)); };
  send({ type: "loaded" });
}

function followLoaders(w: World, state: LoaderSnapshot): void {
  const prog = w.prog;
  prog.followLoaderParents(state.parents, state.ownFirst);
  if (state.dynamicRoot) prog.dynamicRoot = true;
  for (const [id, before, after] of state.libraries) w.bindLibraries(prog.loaderAt(id), before.map(id => prog.loaderAt(id)), after.map(id => prog.loaderAt(id)));
  for (const [id, name, key] of state.initiated) w.initiateClass(prog.loaderAt(id), name, key);
}
