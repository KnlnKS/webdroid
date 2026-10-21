// The page of boot-probe.ts, also loaded in an iframe of itself (`?frame`) as a second load of the same build.
import { fetchPlatformJars, jarDexes } from "../../src/android/framework.ts";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { openAot, platformProgram } from "../../src/wasm/host/boot.ts";
import { prepareApp } from "../../src/wasm/host/appcode.ts";
import { prefetchInWorker } from "../../src/wasm/host/aotload.ts";
import { spawnCompileWorker } from "../../src/wasm/host/compiler.ts";
import { openPersist } from "../../src/wasm/host/persist.ts";
import { dexesIn } from "../../src/jvm/dex.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { world } from "./lib.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { WORKER_SCRIPTS } from "../../src/worker-scripts.ts";

export interface ProbeResult {
  error?: string;
  attached: boolean;
  syncRequests: number;
  /** fetching and compiling the start's modules, off the main thread */
  aheadMs: number;
  /** from the World's creation to the end of the process's start */
  bootMs: number;
  /** our compiler, V8's Module and Instance, the platform build's reading and instantiating */
  compileMs: number; moduleMs: number; instantiateMs: number; aotMs: number;
  loaded: string[]; missed: string[]; failed: string[];
  /** methods compiled on demand */
  methods: number;
  /** whether the Program under the World extends the tab's platform Program */
  app: {
    /** the store the app's compiled code persisted in (OPFS or Cache Storage) */
    store: string;
    /** a build saved by an earlier load was found and attached to the World; otherwise a worker made one and the page kept it */
    hit: boolean; attached: boolean;
    /** finding the saved build and compiling its modules, off the main thread */
    prepareMs: number;
    /** the app's code modules the World loaded from it, and the methods the World compiled on demand */
    modules: number; compiledOnDemand: number;
    /** a build made by a worker: its methods, modules, time in the worker, and whether it was kept */
    made?: { methods: number; modules: number; ms: number; kept: boolean };
    /** second-tier units: jobs sent to the worker, adopted, stale; the page's own second-tier compiles */
    jobs: number; adopted: number; stale: number; inlineUpgrades: number; workerMs: number;
    /** the answers of the app's entry points, which must not depend on any of this */
    answers: string;
  };
}

let syncRequests = 0;
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, ...rest: [string?, string?]) {
  if (async === false) syncRequests++;
  return open.call(this, method, url, async ?? true, ...rest);
} as typeof open;

async function probe(): Promise<ProbeResult> {
  const t0 = performance.now(), store = await openAot(), aheadMs = performance.now() - t0;
  const jars = await fetchPlatformJars();
  await mountPlatform(jars);
  const platform = platformProgram(() => jars.flatMap((jar, i) => jarDexes(jar, PLATFORM_JARS[i])));
  const dexes = dexesIn(new Uint8Array(await (await fetch("/app.dex")).arrayBuffer()), "app.dex"), persist = await openPersist();
   const p0 = performance.now();
  const code = await prepareApp({ dexes, aot: store!, prefetch: (files) => prefetchInWorker(store!, files), persist, spawn: () => spawnCompileWorker(undefined, WORKER_SCRIPTS.compile.url), roots: { launch: ["Pst", "Pst$Add", "Pst$Mul", "Pst$Base"] } });
  const prepareMs = performance.now() - p0, b0 = performance.now(), w = world(new Program(dexes, platform), { aot: store, app: code.saved, compiler: code.compiler });
  code.start(w);  await startProcess(w);  const bootMs = performance.now() - b0, s = w.stats;
  // the app: a loop hot enough to ask for the second tier, and the entry points whose answers every load must agree on
  const hot = w.entry("Pst", "hot", "(I)I");
  // the worker takes a few seconds to load the platform's dex files; until it is ready hot methods wait in its queue
  while (!code.compiler.ready && !code.compiler.retired) await new Promise((r) => setTimeout(r, 20));
  const t1 = performance.now();
  while (code.compiler.stats.adopted + w.stats.upgrades === 0 && performance.now() - t1 < 10000) { hot(4000); await new Promise((r) => setTimeout(r, 2)); }
   const answers = [w.entry("Pst", "chain", "()I")(), w.entry("Pst", "fib", "(I)I")(15), hot(3000), w.entry("Pst", "fill", "(I)I")(500)].join(",");
  code.watch(w); const made = await code.made;  const c = code.compiler.stats;
  return { attached: !!w.aot, syncRequests, aheadMs, bootMs, compileMs: s.compileMs, moduleMs: s.moduleMs, instantiateMs: s.instantiateMs, aotMs: s.aot.ms,
    loaded: w.aot?.loaded.filter((f) => f[0] !== "a") ?? [], missed: [...w.aot?.missed ?? []], failed: store?.failed ?? [], methods: s.methods,
    app: { store: persist ? ("getDirectory" in (navigator.storage ?? {}) ? "opfs" : "cache") : "none", hit: code.hit, prepareMs, attached: w.appAttached, modules: w.aot?.loaded.filter((f) => f[0] === "a").length ?? 0, compiledOnDemand: w.stats.methods, made,
      jobs: c.jobs, adopted: c.adopted, stale: c.stale, inlineUpgrades: w.stats.upgrades - c.adopted, workerMs: c.workerMs, answers } };
}

const result = probe().catch((e): ProbeResult => ({ error: String(e?.stack ?? e), attached: false, syncRequests, aheadMs: 0, bootMs: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, aotMs: 0, loaded: [], missed: [], failed: [], methods: 0, app: undefined as never }));
if (new URLSearchParams(location.search).has("frame")) (window.parent as unknown as { probeFrame: Promise<ProbeResult> }).probeFrame = result;
else (window as unknown as { probe: Promise<ProbeResult> }).probe = result;
