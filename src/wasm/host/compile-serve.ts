// The compile worker's side of the protocol (compile-worker.ts runs it in a page, the persist suite over a MessageChannel): a World over a copy of the app's dex files that compiles
// for the World on the page, which sends it jobs. It does two kinds of work with the code the page's compiler would make: the second-tier units of hot methods (link/unit.ts), and, once
// per app and platform build, the app build the page persists (link/apps.ts), which compiles the methods the app is likely to run.
import { Program, methodOf, type MethodInfo, type LoaderId, type LoaderSnapshot } from "../compiler/program.ts";
import { defineProxy, type ProxyDefinition } from "../link/proxy.ts";
import { World } from "../link/world.ts";
import { buildPart, type AppPart } from "../link/apps.ts";
import { UnitCompiler, type UnitResult, type UpgradeJob } from "../link/unit.ts";
import type { AppIndex, Demand } from "../link/aot.ts";
import type { Numbering } from "../link/numbers.ts";
import type { Intrinsic } from "../compiler/j2w.ts";
import type { NativeBinder } from "../link/hostapi.ts";
import { parseBaselineProfile } from "../../jvm/baselineprof.ts";
import { rootClasses } from "../../jvm/roots.ts";
import { walkRefs } from "../../jvm/opcodes.ts";
import { dexesIn, type DexFile } from "../../jvm/dex.ts";
import type { AppRoots } from "../../jvm/tier.ts";

/** what the worker's realm provides: the platform's dex files, the registered natives and the intrinsics, which must be the page's for the code to be the page's */
export interface CompileEnv {
  platform(): Promise<DexFile[]>;
  natives: NativeBinder;
  intrinsics: Map<string, Intrinsic>;
  externs: string[];
  fetchBytes(url: string): Promise<Uint8Array>;
  heapUsed(): number;
}
/** the methods an app build compiles: the baseline profile's, then all of the app's when `whole`, else those of the classes a launch instantiates, those of the manifest's
 *  other components, and what these call, up to `limit` */
export type BuildRoots = AppRoots & { whole?: boolean; limit?: number };
/** dex files as they cross to the worker: the archives' bytes (an entry of a stored archive is a view of the whole archive) and their names */
export type Containers = [name: string, bytes: Uint8Array][];

/** what a worker's World starts from: the app's dexes over the platform's (and its build), the page's host classes, and its loaders with the dexes of theirs */
interface Start { dexes: Containers; aot?: { base: string; index?: Uint8Array; app?: AppIndex }; hostClasses?: string[]; loaders?: LoaderSnapshot; scopes?: [LoaderId, Containers][] }
export type CompileRequest =
  /** serve second-tier units, for a page's World whose numbering since the platform's is `sync` */
  | ({ type: "units"; sync?: Numbering; proxies?: ProxyDefinition[] } & Start)
  /** make shard `shard` of an app build, numbered from `prefix`: the worker serves nothing after */
  | ({ type: "build"; prefix?: Numbering; roots: BuildRoots; demand: Demand; shard?: [index: number, shards: number] } & Start)
  | { type: "add"; dexes: Containers; loader?: LoaderId; loaders?: LoaderSnapshot }
  | { type: "proxy"; definition: ProxyDefinition; loaders: LoaderSnapshot }
  | { type: "namespaces"; loaders: LoaderSnapshot }
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

/** the methods an app build compiles, in the order the app is likely to want them: those a launch compiled on demand first, then the likely ones */
function select(world: World, appDexes: DexFile[], roots: BuildRoots, demand: Demand): MethodInfo[] {
  const prog = world.prog, out = new Set<MethodInfo>(), mine = new Set(appDexes), keep = (m: MethodInfo) => mine.has(m.dex);
  const compiles = (m: MethodInfo) => !!m.codeOff || !!world.intrinsic(m);
  for (const id of demand.methods) {
    const m = methodOf(prog, id);
    if (m && compiles(m)) out.add(m);
  }
  let called: MethodInfo[] = [];
  for (const [name, methods] of (roots.profile && parseBaselineProfile(roots.profile)) || []) {
    const dex = appDexes.find((d) => d.name === name), types = dex && prog.typesOf(dex);
    if (dex && types) for (const idx of methods) if (idx < dex.methodCount) {
      const m = prog.resolve(types.typeName(dex.method(idx).cls), dex.method(idx).name, types.methodDesc(idx));
      if (!m) continue;
      if (m.dex === dex && m.methodIdx === idx && compiles(m)) out.add(m);
      called.push(m);
    }
  }
  if (roots.whole) {
    for (const cls of [roots.launch, [...prog.own()].filter((c) => c.dex && mine.has(c.dex)).map((c) => c.name)].flat())
      for (const m of prog.get(cls)?.methods ?? []) if (compiles(m)) out.add(m);
    return [...out];
  }
  const others = roots.manifest ? rootClasses(roots.manifest).classes.filter((c) => !roots.launch.includes(c)) : [];
  let budget = roots.limit ?? CLOSURE_LIMIT;
  for (const classes of [roots.launch, others]) {
    for (const cls of classes) {
      const c = prog.get(cls);
      if (c?.dex && mine.has(c.dex)) for (const m of c.methods) { if (m.codeOff) out.add(m); called.push(m); }
    }
    const closure = callClosure(prog, called, budget, keep);
    budget -= closure.length;
    called = [];
    for (const m of closure) out.add(m);
  }
  return [...out];
}

/** The methods `roots` call when they run, breadth first and at most `limit` of those `keep` takes: each call's target as its site declares it (a virtual call's
 *  declared class, without dispatch to subclasses) and the static initializers of the classes they touch */
function callClosure(prog: Program, roots: MethodInfo[], limit: number, keep: (m: MethodInfo) => boolean): MethodInfo[] {
  const seen = new Set<MethodInfo>(), touched = new Set<string>(), out: MethodInfo[] = [];
  let next: MethodInfo[] = [];
  const add = (m: MethodInfo | undefined, root = false) => {
    if (!m?.codeOff || !keep(m) || seen.has(m)) return;
    seen.add(m);
    if (!root) out.push(m);
    next.push(m);
  };
  const touch = (cls: string) => { if (!touched.has(cls)) { touched.add(cls); add(prog.resolve(cls, "<clinit>", "()V")); } };
  for (const m of roots) add(m, true);
  while (next.length && out.length < limit) {
    const level = next;
    next = [];
    for (const m of level) {
      const dex = m.dex, types = prog.typesOf(dex);
      touch(m.cls);
      walkRefs(dex.code(m.codeOff), {
        invoke(op, idx) {
          const owner = types.typeName(dex.method(idx).cls);
          if (op === 0x71 || op === 0x77) touch(owner);
          add(prog.resolve(owner, dex.method(idx).name, types.methodDesc(idx)));
        },
        type(op, idx) { if (op === 0x22) touch(types.typeName(idx)); },
        // sget/sput
        field(op, idx) { if (op >= 0x60) touch(types.typeName(dex.field(idx).cls)); },
      });
    }
  }
  return out.slice(0, limit);
}

export function serveCompile(port: Port, env: CompileEnv): void {
  let w: World | undefined, units: UnitCompiler | undefined;
  const send = (m: CompileResponse, transfer: Transferable[] = []) => port.postMessage(m, transfer);
  const open = (dexes: Containers) => dexes.flatMap(([name, bytes]) => dexesIn(bytes, name));

  /** a World over the platform and `dexes`, with the page's host classes and `proxies`; the Program follows the page's loaders first when `follow` says so */
  async function world(req: Start, dexes: DexFile[], follow: boolean, proxies: ProxyDefinition[] = []): Promise<World> {
    const index = req.aot && (req.aot.index ?? await env.fetchBytes(req.aot.base + "index.json"));
    const platform = new Program(await env.platform());
    platform.addExterns(env.externs);
    const program = new Program(dexes, platform), loaders = follow ? req.loaders : undefined;
    if (loaders) { program.followLoaderParents(loaders.parents, loaders.ownFirst); program.dynamicRoot = !!loaders.dynamicRoot; }
    if (follow) for (const [id, dexes] of req.scopes ?? []) program.add(open(dexes), program.loaderAt(id));
    if (loaders) {
      for (const [id, before, after] of loaders.libraries) program.libraries(program.loaderAt(id), before.map(id => program.loaderAt(id)), after.map(id => program.loaderAt(id)));
      for (const [id, name, key] of loaders.initiated) program.initiate(program.loaderAt(id), name, key);
    }
    const w = new World(program, { intrinsics: env.intrinsics, natives: env.natives, heapUsed: env.heapUsed, compileOnly: true,
      ...index && { aot: { get: (file) => (file === "index.json" ? index : undefined) }, ...req.aot!.app && { app: { index: req.aot!.app, store: { get: () => undefined } } } } });
    // Initial app builds precede hostClasses arriving. Apply overlays from the start, as the page does.
    for (const spec of env.natives.source?.hostSpecs?.() ?? []) w.addHostClass(spec);
    for (const definition of proxies) defineProxy(w, definition);
    if (req.hostClasses && req.hostClasses.join() !== w.hostClassNames().join()) throw new Error(`the worker's host classes are not the page's: ${w.hostClassNames().filter((n) => !req.hostClasses!.includes(n)).join()} against ${req.hostClasses.filter((n) => !w.hostClassNames().includes(n)).join()}`);
    return w;
  }

  async function start(req: Extract<CompileRequest, { type: "units" }>): Promise<void> {
    const t0 = performance.now();
    w = await world(req, open(req.dexes), true, req.proxies);
    units = new UnitCompiler(w);
    if (req.sync && !units.sync(req.sync, true)) throw new Error("the page's numbering is not the worker's at the start");
    send({ type: "ready", ms: performance.now() - t0 });
  }

  // An app build numbers from where the page's World was when the app's dexes arrived, before the page's numbering is followed; its app's libraries are bound after, as
  // the page's loader bound them.
  async function build(req: Extract<CompileRequest, { type: "build" }>): Promise<void> {
    const dexes = open(req.dexes), w = await world(req, dexes, false);
    if (req.prefix && !w.adopt(req.prefix)) throw new Error("the app's prefix does not follow the platform build");
    if (req.loaders) replayLoaders(w, req.loaders, req.scopes?.map(([id, dexes]) => [id, open(dexes)]));
    const t0 = performance.now(), methods = select(w, dexes, req.roots, req.demand), [shard, shards] = req.shard ?? [0, 1];
    const part = buildPart(w, methods, req.demand, shard, shards), ms = performance.now() - t0;
    send({ type: "built", part, methods: methods.length, ms }, part.files.map(([, bytes]) => bytes.buffer as ArrayBuffer));
  }

  const receive = async (req: CompileRequest) => {
    const id = "id" in req ? req.id : undefined, t0 = performance.now();
    try {
      if (req.type === "units") await start(req);
      else if (req.type === "build") await build(req);
      else if (!w || !units) throw new Error("not initialized");
      else if (req.type === "add") {
        if (req.loaders) replayLoaders(w, req.loaders);
        w.addDexes(open(req.dexes), w.prog.loaderAt(req.loader ?? 0));
      }
      else if (req.type === "proxy" || req.type === "namespaces") {
        replayLoaders(w, req.loaders);
        if (req.type === "proxy") defineProxy(w, req.definition);
      }
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

/** has `w` follow the page's loaders `state`, with the dexes of `scopes` added to theirs */
function replayLoaders(w: World, state: LoaderSnapshot, scopes: [LoaderId, DexFile[]][] = []): void {
  const prog = w.prog;
  prog.followLoaderParents(state.parents, state.ownFirst);
  for (const [id, dexes] of scopes) w.addDexes(dexes, prog.loaderAt(id));
  if (state.dynamicRoot) prog.dynamicRoot = true;
  for (const [id, before, after] of state.libraries) w.namespaces.bindLibraries(prog.loaderAt(id), before.map(id => prog.loaderAt(id)), after.map(id => prog.loaderAt(id)));
  for (const [id, name, key] of state.initiated) w.namespaces.initiateClass(prog.loaderAt(id), name, key);
}
