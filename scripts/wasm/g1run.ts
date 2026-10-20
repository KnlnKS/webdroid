// One G1 measurement in one fresh engine: a Bench workload as Wasm (lazy linking over the AOSP boot dex), timed per call. Bundled by g1.ts for node (argv[2] is the JSON config) and for a page (globalThis.g1run).
import { readdirSync, readFileSync } from "node:fs";
import type { AotStore } from "../../src/wasm/link/aot.ts";
import { FetchStore } from "../../src/wasm/link/aotstore.ts";
import { compileBytes } from "../../src/wasm/link/module.ts";
import { fakeAot, loadDexes, world } from "./lib.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { prepareApp } from "../../src/wasm/host/appcode.ts";
import { spawnCompileWorker } from "../../src/wasm/host/compiler.ts";
import { Persist, appKey, memoryBackend } from "../../src/wasm/host/persist.ts";
import type { World } from "../../src/wasm/link/world.ts";
import { attachHostClasses, mountPlatform, natives, startProcess } from "./harness.ts";
import { HEAP_LIMIT } from "../../src/jvm/abi.ts";
import { heapUsed } from "../../src/wasm/host/stats.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { WORKER_SCRIPTS } from "../../src/worker-scripts.ts";

/** the build is opened the way the app opens it: the index and the modules a start loads are compiled before the World runs. A page fetches them (and a module it lacks is a miss);
 *  node reads them, and reads any other module when it is wanted. An installed app (g1app.ts) brings its saved build and the list of platform modules its launches load. */
const inPage = !!(globalThis as { document?: unknown }).document;
const aotDir = (globalThis as { G1_AOT?: string }).G1_AOT ?? (inPage ? undefined : process.env.WEBDROID_AOT);
const appDir = (globalThis as { G1_APP?: string }).G1_APP ?? (inPage ? undefined : process.env.G1_APP);
let appFiles: Map<string, Uint8Array> | undefined;
let appReadMs = 0;
if (appDir) {
  const t0 = performance.now();
  const names = inPage ? await (await fetch("/app/files.json")).json() as string[] : readdirSync(appDir);
  appFiles = new Map(await Promise.all(names.map(async (n) => [n, inPage ? new Uint8Array(await (await fetch(`/app/${n}`)).arrayBuffer()) : new Uint8Array(readFileSync(`${appDir}/${n}`))] as [string, Uint8Array])));
  appReadMs = performance.now() - t0;
}
const startupList = async (read: (f: string) => Uint8Array | Promise<Uint8Array>): Promise<string[]> => JSON.parse(new TextDecoder().decode(appFiles?.get("startup.json") ?? await read("startup.json"))) as string[];
if (aotDir) {
  const t0 = performance.now();
  if (inPage) {
    const store = new FetchStore(`/aot/${aotDir.split("/").pop()}/`);
    await store.fetchBytes("index.json");
    await store.prefetch(await startupList((f) => store.fetchBytes(f)));
    (globalThis as { G1_STORE?: AotStore }).G1_STORE = store;
  } else {
    const ahead = new Map<string, WebAssembly.Module>(), file = (f: string) => new Uint8Array(readFileSync(`${aotDir}/${f}`));
    await Promise.all((await startupList(file)).map(async (f) => ahead.set(f, await compileBytes(file(f)))));
    (globalThis as { G1_STORE?: AotStore }).G1_STORE = { get: (f) => ahead.get(f) ?? file(f) };
  }
  (globalThis as { G1_AHEAD?: number }).G1_AHEAD = performance.now() - t0;
}

export interface G1Config { cls: string; workload: string; reps: number; dex: string; root: string }
export interface G1Result { bootMs?: number; ahead?: number; appReadMs?: number; worldSetupMs?: number; workerStartMs?: number; prestartedWorker?: boolean; workload: string; result: string; times: number[]; compileMs?: number; units?: number; boot?: Record<string, unknown>; setup?: Record<string, unknown>; first?: Record<string, unknown>; stats?: Record<string, unknown>; error?: string }

/** the heap in use, after a collection once it looks over the limit: reps of one workload in one World leave garbage the engine has not yet collected */
let heapBase = 0;
const collectedHeap = () => {
  const used = heapUsed();
  const gc = (globalThis as { gc?: () => void }).gc;
  if (used < heapBase + HEAP_LIMIT || !gc) return used;
  gc();
  return heapUsed();
};

function workloadProgram(cfg: G1Config) {
  const platform = new Program(PLATFORM_JARS.flatMap((j) => loadDexes(`${cfg.root}/vendor/aosp/${j}`))); platform.addExterns(externs);
  const dexes = loadDexes(cfg.dex);
  return { dexes, prog: new Program(dexes, platform) };
}

/** a launch of the installed app as the page makes one (host/boot.ts, host/appcode.ts): the app's Program over the platform's, the saved build found and its modules compiled
 *  before the World is made, the host's classes, and in a page the compile worker that takes the second tier */
async function installed(cfg: G1Config): Promise<{ world: World; startWorker?: () => Promise<void> }> {
  const { dexes, prog } = workloadProgram(cfg), key = aotDir!.split("/").pop()!, persist = new Persist(memoryBackend());
  await persist.save(await appKey(dexes, key), [...appFiles!].filter(([n]) => n !== "startup.json"));
  const code = await prepareApp({ dexes, aot: fakeAot(`/aot/${key}/`, key), persist, roots: { launch: [] },
    spawn: () => { if (!inPage) throw new Error("no compile worker in node"); return spawnCompileWorker(undefined, WORKER_SCRIPTS.compile.url); } });
  if (!code.hit) throw new Error("the installed app's build was not found");
  heapBase = heapUsed();
  const worker = inPage && !(globalThis as { G1_INLINE?: boolean }).G1_INLINE;
  const w = world(prog, { natives, heapUsed: collectedHeap, app: code.saved, ...(worker && { compiler: code.compiler }) });
  if (!w.appAttached) throw new Error("the installed app's build does not attach");
  attachHostClasses(w);
  let startWorker: (() => Promise<void>) | undefined;
  if (worker) {
    code.start(w);
    // This supplemental scenario forces worker readiness before the first-call timer.
    startWorker = async () => {
      code.compiler.submit(w, 0);
      for (const t0 = performance.now(); !code.compiler.ready && !code.compiler.retired && performance.now() - t0 < 60000;) await new Promise((r) => setTimeout(r, 10));
      if (!code.compiler.ready) throw new Error(`the compile worker did not start: ${code.compiler.retired ?? "timed out"}`);
    };
  }
  return { world: w, startWorker };
}

export async function g1run(cfg: G1Config): Promise<G1Result> {
  const out: G1Result = { workload: cfg.workload, result: "", times: [], ahead: (globalThis as { G1_AHEAD?: number }).G1_AHEAD, appReadMs };
  await mountPlatform(cfg.root);
  console.warn = () => {};
  let w: World, startWorker: (() => Promise<void>) | undefined;
  const setupAt = performance.now();
  if (appFiles) ({ world: w, startWorker } = await installed(cfg));
  else {
    const { prog } = workloadProgram(cfg);
    // the World takes the heap at its construction as the base of its limit, so the program model it is built over is on that side
    heapBase = heapUsed();
    w = world(prog, { natives, heapUsed: collectedHeap });
  }
  out.worldSetupMs = performance.now() - setupAt;
  const gaps: string[] = [], b0 = performance.now();
  w.onGap = gap => gaps.push(gap);
  try { await startProcess(w); } catch (e) { const t = w.throwable(e); const cause = t ? w.fieldReader("java/lang/Throwable", "cause", "Ljava/lang/Throwable;")(t) as object | null : null; throw new Error("boot: " + (t ? w.classNameOf(t) : String(e)) + (cause ? " <- " + w.classNameOf(cause) : "") + " " + w.lastMessage); }
  out.bootMs = performance.now() - b0; out.ahead = (globalThis as { G1_AHEAD?: number }).G1_AHEAD; out.boot = structuredClone(w.stats);
  out.prestartedWorker = !!startWorker;
  if (startWorker) { const t = performance.now(); await startWorker(); out.workerStartMs = performance.now() - t; }
  out.setup = structuredClone(w.stats);
  const t0 = performance.now();
  try {
    const call = w.entryAsync(cfg.cls, `w_${cfg.workload}`, "()I");
    // the first call includes linking and compiling everything the workload reaches
    out.result = String(await call());
    out.times.push(performance.now() - t0);
    out.first = structuredClone(w.stats);
    for (let i = 0; i < cfg.reps; i++) {
      const t = performance.now(), value = await call(), elapsed = performance.now() - t;
      if (String(value) !== out.result) throw new Error(`call ${i + 2} returned ${String(value)}, expected ${out.result}`);
      out.times.push(elapsed);
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
  } catch (e) { const t = w.throwable(e); out.error = gaps.length ? `gap ${gaps.join("; ")}` : t ? `uncaught ${w.classNameOf(t)}` : String(e).slice(0, 900); }
  if (gaps.length) out.error ??= `gap ${gaps.join("; ")}`;
  out.compileMs = w.stats.compileMs; out.units = w.stats.units; out.stats = structuredClone(w.stats);
  return out;
}
(globalThis as { g1run?: typeof g1run }).g1run = g1run;
const arg = (globalThis as { process?: { argv: string[] } }).process?.argv[2];
if (arg && !inPage) console.log("G1" + JSON.stringify(await g1run(JSON.parse(arg))));
