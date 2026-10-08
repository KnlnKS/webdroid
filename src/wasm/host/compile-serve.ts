import { compilerJob, compilerInput, postCompilerReceipt, invalidateCompilerReceipt } from "../../shell/compiler-workers";
import { beginCompile, endCompile, measureCompile, compilerReceiptsEnabled } from "../../jvm/compiler-observer";
// The compile worker's side of the protocol (compile-worker.ts runs it in a page, the persist suite over a MessageChannel): a World over a copy of the app's dex files that compiles
// for the World on the page, which sends it jobs. It does two kinds of work with the code the page's compiler would make: the second-tier units of hot methods (link/unit.ts), and, once
// per app and platform build, the app build the page persists (link/apps.ts), which compiles the methods the app is likely to run (src/jvm/compileworker.ts picks them the same way).
import { Program, type MethodInfo } from "../compiler/program";
import { World } from "../link/world";
import { buildApp, type AppBuild } from "../link/apps";
import { UnitCompiler, type UnitResult, type UpgradeJob } from "../link/unit";
import type { AppIndex, Demand, Numbering } from "../link/aot";
import type { Intrinsic } from "../compiler/j2w";
import type { NativeBinder } from "../link/hostapi";
import { Program as Reach, callClosure, type MethodRoot } from "../../jvm/reach";
import { parseBaselineProfile } from "../../jvm/baselineprof";
import { rootsOf } from "../../jvm/roots";
import { dexesIn, type DexFile } from "../../jvm/dex";
import { descToName } from "../../jvm/abi";
import { methodOf } from "../compiler/ids";

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
/** the methods an app build compiles: the baseline profile's, those of the classes a launch instantiates, those of the manifest's other components, and what these call */
export interface BuildRoots { profile?: Uint8Array; manifest?: Uint8Array; launch: string[]; limit?: number }
/** dex files as they cross to the worker: the archives' bytes (an entry of a stored archive is a view of the whole archive) and their names */
export type Containers = [name: string, bytes: Uint8Array][];

export type CompileRequest =
  | { type: "init"; dexes: Containers; aot?: { base: string; app?: AppIndex }; sync?: Numbering; initialized?: string[]; hostClasses?: string[]; build?: BuildRoots; demand?: Demand; oneShot?: true }
  | { type: "add"; dexes: Containers }
  /** the app build again, with more built on demand since (the World of a worker that was asked for a build serves it once more) */
  | { type: "refine"; demand: Demand }
  | { type: "upgrade"; id: number; keep: boolean; sync: Numbering; job: UpgradeJob };
export type CompileResponse =
  /** the worker is listening: a module worker whose imports await something drops the messages sent before it is, so nothing is sent until this arrives */
  | { type: "loaded" }
  | { type: "ready"; ms: number }
  | { type: "built"; build: AppBuild; methods: number; ms: number }
  | { type: "unit"; id: number; result: UnitResult; ms: number }
  | { type: "failed"; id?: number; message: string };
export interface Port { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }

const CLOSURE_LIMIT = 20_000;

export function serveCompile(port: Port, env: CompileEnv): void {
  let w: World | undefined, units: UnitCompiler | undefined, appDexes: DexFile[] = [], roots: BuildRoots | undefined;
  type Job = { type: string; id?: number; ordinal: number; oneShot: boolean; ended: boolean };
  const send = (m: CompileResponse, transfer: Transferable[] = [], job?: Job) => {
    const complete = job && (m.type === "ready" || m.type === "unit" || m.type === "failed" || m.type === "built" && (job.oneShot || job.type === "refine"));
    if (complete && !job.ended) { compilerJob(job.type, job.id, m.type === "failed" ? "failed" : "end", undefined, job.ordinal); job.ended = true; }
    postCompilerReceipt(undefined, !!complete && !!job?.oneShot);
    port.postMessage(m, transfer);
  };
  const open = (dexes: Containers) => dexes.flatMap(([name, bytes]) => dexesIn(bytes, name));

  async function init(req: Extract<CompileRequest, { type: "init" }>, job: Job): Promise<number> {
    const t0 = performance.now();
    const dexes = await env.platform();
    if (compilerReceiptsEnabled) compilerJob("init", undefined, "inputs", await compilerInput(dexes.map(d => [d.name, d.bytes])), job.ordinal);
    const platform = measureCompile("residual.wasmSetup", () => {
      const platform = new Program(dexes); platform.addExterns(env.externs); appDexes = open(req.dexes); return platform;
    });
    const index = req.aot ? await env.fetchBytes(req.aot.base + "index.json") : undefined;
    if (compilerReceiptsEnabled && index) compilerJob("init", undefined, "inputs", await compilerInput([["platform-index", index]]), job.ordinal);
    const setup = beginCompile("residual.wasmSetup");
    try {
    w = new World(new Program(appDexes, platform), { intrinsics: env.intrinsics, natives: env.natives, heapUsed: env.heapUsed, hostWhole: env.hostWhole, compileOnly: true,
      ...index && { aot: { get: (file) => (file === "index.json" ? index : undefined) }, ...req.aot!.app && { app: { index: req.aot!.app, store: { get: () => undefined } } } } });
    // Initial app builds precede hostClasses arriving. Apply overlays from the start, as the page does.
    for (const spec of env.natives.source?.hostSpecs?.() ?? []) w.addHostClass(spec);
    if (req.hostClasses && req.hostClasses.join() !== w.hostClassNames().join()) throw new Error(`the worker's host classes are not the page's: ${w.hostClassNames().filter((n) => !req.hostClasses!.includes(n)).join()} against ${req.hostClasses.filter((n) => !w!.hostClassNames().includes(n)).join()}`);
    } finally { endCompile(setup); }
    // an app build numbers from where a World starts, before the page's numbering is followed
    roots = req.build;
    if (roots) {
      build(req.demand ?? { methods: [], classes: [], infos: [] }, req.oneShot, job);
      if (req.oneShot) return performance.now() - t0;
    }
    measureCompile("residual.wasmSetup", () => {
      units = new UnitCompiler(w!);
      if (req.sync && !units.sync(req.sync, true)) throw new Error("the page's numbering is not the worker's at the start");
      req.initialized?.forEach((c) => w!.preInitialized.add(c));
    });
    return performance.now() - t0;
  }

  /** Refine-capable builds restore numbering; a one-shot build is retired after its receipt. */
  function build(demand: Demand, oneShot = false, job?: Job): void {
    const t0 = performance.now();
    const result = measureCompile("residual.wasmBuild", () => {
      const methods = select(roots!, demand), built = buildApp(w!, methods, demand), ms = performance.now() - t0;
      if (!oneShot) w!.rollback(built.index.base);
      return { type: "built" as const, build: built, methods: methods.length, ms };
    });
    send(result, result.build.files.map(([, bytes]) => bytes.buffer as ArrayBuffer), job);
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
    const nameOf = (dex: DexFile, idx: number) => descToName(dex.type(dex.method(idx).cls));
    const rootOf = (dex: DexFile, idx: number): MethodRoot => ({ cls: nameOf(dex, idx), sig: dex.method(idx).name + dex.methodDesc(idx) });
    let called: MethodRoot[] = [];
    for (const [name, methods] of (roots.profile && parseBaselineProfile(roots.profile)) || []) {
      const dex = appDexes.find((d) => d.name === name);
      if (dex) for (const m of methods) if (m < dex.methodCount) { take(nameOf(dex, m), dex, m); called.push(rootOf(dex, m)); }
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

  port.onmessage = async ({ data: req }: MessageEvent<CompileRequest>) => {
    const id = "id" in req ? req.id : undefined, t0 = performance.now();
    const job: Job = { type: req.type, id, ordinal: compilerJob(req.type, id, "begin"), oneShot: req.type === "init" && !!req.oneShot, ended: false };
    try {
      if (req.type === "init" && req.oneShot && !req.build) throw new Error("one-shot compilation requires build roots");
      if (compilerReceiptsEnabled) {
        try {
          const inputs: Containers = "dexes" in req ? [...req.dexes] : [];
          const metadata = req.type === "init" ? { ...req, dexes: undefined, build: req.build && { ...req.build, profile: undefined, manifest: undefined } }
            : req.type === "add" ? { type: req.type } : req;
          if (req.type === "init") {
            if (req.build?.profile) inputs.push(["profile", req.build.profile]);
            if (req.build?.manifest) inputs.push(["manifest", req.build.manifest]);
          }
          inputs.push(["request", new TextEncoder().encode(JSON.stringify(metadata))]);
          compilerJob(req.type, id, "inputs", await compilerInput(inputs), job.ordinal);
        } catch { invalidateCompilerReceipt(); compilerJob(req.type, id, "inputs", null, job.ordinal); }
      }
      if (req.type === "init") {
        const ms = await init(req, job);
        if (!req.oneShot) send({ type: "ready", ms }, [], job);
      }
      else if (!w || !units) throw new Error("not initialized");
      else if (req.type === "add") {
        measureCompile("residual.wasmSetup", () => w!.addDexes(open(req.dexes)));
        compilerJob(req.type, id, "end", undefined, job.ordinal); job.ended = true; postCompilerReceipt();
      }
      else if (req.type === "refine") build(req.demand, false, job);
      else if (req.type === "upgrade") {
        const result = measureCompile("residual.wasmUpgrade", () => {
          if (!units!.sync(req.sync, req.keep)) throw new Error("the page's numbering is not the worker's");
          return units!.upgrade(req.job);
        });
        if (typeof result === "string") send({ type: "failed", id, message: result }, [], job);
        else send({ type: "unit", id: req.id, result, ms: performance.now() - t0 }, [], job);
      }
    } catch (e) { send({ type: "failed", id, message: String((e as Error)?.stack ?? e) }, [], job); }
  };
  send({ type: "loaded" });
}
