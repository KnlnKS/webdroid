// G1 timing: all selected Bench and G1 workloads on the Wasm tier, first call and steady state, in node and in headless Chrome (so Liftoff and TurboFan
// tiering are both represented). A workload is a `case` of scripts/jbench/Bench.java or java/G1.java; all selected workloads are attempted and failures
// retained. Every measurement is a fresh process/context; every run of a workload must answer alike.
//   pnpm wasm g1 [workload ...] [--reps 100] [--runs 5] [--engines node,chrome] [--json out.json] [--ref earlier.json] [--v8-flags="--flag ..."] [--installed DIR [--inline]] [--phases]
// --ref compares with the numbers (and answers) of an earlier --json run and measures only its workloads, for A/B work on the compiler.
// --installed DIR runs the Wasm tier as a launch of the installed app (g1app.ts made DIR over the platform build in WEBDROID_AOT): its saved build attached, the host's classes, and in
// Chrome a forcibly prestarted compile worker; setup time is reported separately. The saved app's measured-demand startup list replaces the platform default in this supplemental
// scenario. With --inline the page compiles the second tier itself, as without --installed. Ordinary/on-demand remains the primary G1 scenario.
// Needs javac, d8, node and (for chrome) Playwright's Chrome. The host is shared: the load average is printed and a high one flags the table noisy.
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NODE_FLAGS } from "../node.ts";
import { fileResponse, serve } from "../serve.ts";
import type { G1Config, G1Result } from "./g1run.ts";
import { G1_DIR, JAVA, ROOT } from "./paths.ts";
import { PLATFORM_PATHS } from "../aosp.ts";
import { bundleFor, cutWorkloads } from "./tools.ts";
import { androidFixture } from "../java.ts";
import { sourceKey } from "../aot-key.ts";
import { createHash } from "node:crypto";
import { geo, med, sampleError } from "./g1report.ts";
import { cli } from "../args.ts";
import { WORKER_SCRIPTS } from "../../src/worker-scripts.ts";

const here = import.meta.dirname;
const text = (d: string) => ({ type: "string", default: d }) as const, flag = { type: "boolean", default: false } as const;
const { values: opts, positionals: only } = cli("pnpm wasm g1 [workload ...] [the options scripts/wasm/g1.ts lists]",
  { reps: text("100"), runs: text("5"), engines: text("node,chrome"), json: text(""), ref: text(""), "v8-flags": text(""), installed: text(""), inline: flag, phases: flag });
const reps = +opts.reps, runs = +opts.runs, engines = opts.engines.split(","), jsonOut = opts.json, refPath = opts.ref, v8Flags = opts["v8-flags"];
/** the workloads as an installed app: the saved build g1app.ts made in this directory (with WEBDROID_AOT its platform build) */
const installedDir = opts.installed, inlineTier = opts.inline;
if (process.env.G1_APP && process.env.G1_APP !== installedDir) throw new Error("G1_APP requires the same explicit --installed directory");
if (inlineTier && !installedDir) throw new Error("--inline requires --installed");
if (![reps, runs].every(n => Number.isInteger(n) && n > 0) || engines.some(e => !["node", "chrome"].includes(e)) || new Set(engines).size !== engines.length) throw new Error("positive integer reps/runs and distinct node/chrome engines required");

// ---- Bench.java and G1.java with each workload cut into its own static method (as jbench.ts does)
const out = G1_DIR, sources = [["Bench", join(ROOT, "scripts/jbench/Bench.java")], ["G1", join(JAVA, "G1.java")]];
mkdirSync(out, { recursive: true });
const names: string[] = [], classOf = new Map<string, string>(), cut = sources.map(([cls, file]) => {
  const { names: own, source } = cutWorkloads(readFileSync(file, "utf8"));
  for (const n of own) { names.push(n); classOf.set(n, cls); }
  return { cls, file, text: source };
});
const dex = join(out, "classes.dex");
if (only.some(name => !names.includes(name))) throw new Error(`unknown workload: ${only.filter(name => !names.includes(name)).join(", ")}`);
if (!existsSync(dex) || cut.some((c) => statSync(dex).mtimeMs < statSync(c.file).mtimeMs)) {
  for (const c of cut) writeFileSync(join(out, `${c.cls}.java`), c.text);
  androidFixture({ out, sources: cut.map((c) => join(out, `${c.cls}.java`)) });
}
const todo = names.filter((n) => !only.length || only.includes(n));

// ---- one bundle per engine (a page's node:fs is the preloaded files); node runs its bundle without the preload's polyfills, so with V8's base64 switched on where it is off
const base64 = spawnSync(process.execPath, ["-p", "typeof Uint8Array.fromBase64"], { encoding: "utf8" }).stdout.trim() === "function" ? [] : ["--js-base-64"];
const nodeRun = (b: string) => (cfg: G1Config): G1Result => {
  const r = spawnSync(process.execPath, [...NODE_FLAGS, ...base64, ...v8Flags.split(" ").filter(Boolean), b, JSON.stringify(cfg)],
    { env: { ...process.env, ...(installedDir && { G1_APP: installedDir }) }, encoding: "utf8", maxBuffer: 1 << 28 });
  const line = r.stdout.split("\n").find((l) => l.startsWith("G1"));
  if (!line) throw new Error(`${cfg.workload}: ${String(r.error ?? r.stderr).slice(0, 400)}`);
  const result = JSON.parse(line.slice(2)) as G1Result;
  if (r.status) result.error ??= `node exited ${r.status}: ${r.stderr.slice(0, 400)}`;
  return result;
};
async function chromeRun() {
  const { launchBrowser } = await import("../page.ts");
  const script = await bundleFor("browser", join(here, "g1run.ts"));
  const aotDir = process.env.WEBDROID_AOT;
  const preload = [dex, ...PLATFORM_PATHS];
  // an installed app's saved build, and the compile worker the page's launch starts (host/compile-worker.ts)
  const worker = installedDir ? await bundleFor("browser", join(ROOT, "src/wasm/host/compile-worker.ts")) : undefined;
  // cross-origin isolation gives performance.now() microsecond resolution instead of 0.1 ms
  const iso = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
  const server = await serve({ fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    if (p === "/") return new Response(`<script type=module>globalThis.G1_AOT=${JSON.stringify(aotDir ?? "")}||undefined;globalThis.G1_APP=${JSON.stringify(installedDir)}||undefined;globalThis.G1_INLINE=${inlineTier};const f={};await Promise.all(${JSON.stringify(preload)}.map(async(p)=>f[p]=new Uint8Array(await(await fetch("/f?p="+encodeURIComponent(p))).arrayBuffer())));globalThis.G1_FILES=f;await import("/g1.js");window.ready=true</script>`, { headers: { "content-type": "text/html", ...iso } });
    // G1_STARTUP=all: every module of the build is fetched and compiled before the first call, which shows what the rows cost when the page has what they run
    if (aotDir && p.endsWith("/startup.json") && process.env.G1_STARTUP === "all") return Response.json(readdirSync(aotDir).filter((f) => /^[cd]\d+\.wasm$/.test(f)), { headers: iso });
    if (aotDir && p.startsWith("/aot/")) return fileResponse(join(aotDir, p.split("/").pop()!), req, iso);
    if (p === "/g1.js") return new Response(script, { headers: { "content-type": "text/javascript", ...iso } });
    if (installedDir && p === "/app/files.json") return Response.json(readdirSync(installedDir), { headers: iso });
    if (installedDir && p.startsWith("/app/")) return fileResponse(join(installedDir, p.split("/").pop()!), req, iso);
    if (worker && p === WORKER_SCRIPTS.compile.url) return new Response(worker, { headers: { "content-type": "text/javascript", ...iso } });
    const file = p === "/f" ? u.searchParams.get("p")! : p.startsWith("/vendor/aosp/") ? join(ROOT, p) : null;
    return file ? fileResponse(file, req, iso) : new Response("", { status: 404 });
  } });
  const browser = await launchBrowser(`--expose-gc ${v8Flags}`);
  const version = browser.version();
  return { version, run: async (cfg: G1Config): Promise<G1Result> => {
    const page = await (await browser.newContext()).newPage();
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(String(e).slice(0, 500)));
    try {
      await page.goto(server.url.href);
      await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
      const r = await page.evaluate((c) => (globalThis as unknown as { g1run: (c: unknown) => Promise<unknown> }).g1run(c), cfg) as G1Result;
      if (errors.length) r.error ??= `page error: ${errors.join("; ")}`;
      return r;
    } finally { await page.context().close(); }
  }, close: async () => { await browser.close(); server.stop(); } };
}

// ---- measure
interface Sample { first: number; warm: number; steady: number; completedCalls:number; result: string; error?: string; compileMs?: number; bootMs?: number; ahead?: number; appReadMs?: number; worldSetupMs?: number; workerStartMs?: number; prestartedWorker?: boolean; boot?: Stats; setup?: Stats; firstStats?: Stats; stats?: Stats }
type Stats = Record<string, number> & { phase: Record<string, number>; aot: Record<string, number> }
const sample = (r: G1Result): Sample => ({ first: r.times[0], warm: med(r.times.slice(1, 11)), steady: med(r.times.slice(Math.max(1, r.times.length >> 1))), completedCalls:r.times.length, result: r.result, error: r.error, compileMs: r.compileMs, bootMs: r.bootMs, ahead: r.ahead, appReadMs: r.appReadMs, worldSetupMs: r.worldSetupMs, workerStartMs: r.workerStartMs, prestartedWorker: r.prestartedWorker, boot: r.boot as Stats, setup: r.setup as Stats, firstStats: r.first as Stats, stats: r.stats as Stats });
const loads: number[] = [loadavg()[0]];
type Row = { w: string; result: string; first: number[]; steady: number[] };
const ref: Record<string, { rows: Row[] }> | null = refPath ? JSON.parse(readFileSync(refPath, "utf8")).engines : null;
const startSource = sourceKey();
const report: Record<string, unknown> = { installed: installedDir || null, inline: inlineTier, source:startSource, dexSha256:createHash("sha256").update(readFileSync(dex)).digest("hex"), cores: cpus().length, reps, runs, loadStart: loadavg()[0], aot:process.env.WEBDROID_AOT??null, accepted:false, engines: {} };
const artifact = (dir: string, name: string) => ({ path: join(dir, name), sha256: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") });
report.scenario = installedDir ? "installed-measured-demand-preload" : "ordinary-on-demand";
report.classPathLayout = "bootstrap-platform/application";
report.startup = installedDir ? artifact(installedDir, "startup.json") : process.env.WEBDROID_AOT ? artifact(process.env.WEBDROID_AOT, "startup.json") : null;
report.appIndex = installedDir ? artifact(installedDir, "index.json") : null;
report.platformIndex = process.env.WEBDROID_AOT ? artifact(process.env.WEBDROID_AOT, "index.json") : null;
report.harnessSha256 = createHash("sha256").update(readFileSync(import.meta.filename)).update(readFileSync(join(here, "g1run.ts"))).update(readFileSync(join(here, "g1report.ts"))).digest("hex");
report.v8Flags = v8Flags;
report.startupOverride = process.env.G1_STARTUP ?? null;
report.primaryProtocol = !installedDir && !refPath && !v8Flags && !process.env.G1_STARTUP;

const aotDir = process.env.WEBDROID_AOT;
if (aotDir) {
  const manifestPath = ["current.json", "latest.json"].map(name => join(dirname(resolve(aotDir)), name)).find(path => {
    if (!existsSync(path)) return false;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return manifest.source === startSource && manifest.key === basename(resolve(aotDir));
  });
  if (!manifestPath) throw new Error("WEBDROID_AOT requires a matching source/key in adjacent current.json or latest.json");
  report.aotManifest = { ...artifact(dirname(manifestPath), basename(manifestPath)), ...JSON.parse(readFileSync(manifestPath, "utf8")) };
}
// Check outside timed calls: bundles are frozen, but subsequent processes still read fixtures and assets.
const inputKey = () => {
  const hash = createHash("sha256");
  for (const path of [dex, ...sources.map(([, path]) => path), ...readdirSync(here).filter(name => name.endsWith(".ts")).sort().map(name => join(here, name))]) hash.update(path).update(readFileSync(path));
  for (const dir of [aotDir, installedDir].filter((dir): dir is string => !!dir)) {
    for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
      const path = join(dir, name), stat = statSync(path);
      hash.update(JSON.stringify([path, stat.size, stat.mtimeMs, stat.ctimeMs]));
    }
  }
  return hash.digest("hex");
};
const startInputs = inputKey(), guardFailures: string[] = [];
report.inputStateSha256 = startInputs;
const checkSource = (where: string) => {
  if (guardFailures.length) return;
  try {
    if (sourceKey() !== startSource) guardFailures.push(`${where}: production source changed`);
    if (inputKey() !== startInputs) guardFailures.push(`${where}: harness, fixture or asset inputs changed`);
  } catch (error) { guardFailures.push(`${where}: ${String(error)}`); }
};

for (const engine of engines) {
  let run: (c: G1Config) => G1Result | Promise<G1Result>, label = `node ${process.version} (V8 ${process.versions.v8})`, close = async () => {};
  checkSource(`before ${engine} setup`);
  if (guardFailures.length) run = c => ({ workload: c.workload, result: "", times: [], error: guardFailures.join("; ") });
  else if (engine === "node") { const file = join(out, "g1run.mjs"); writeFileSync(file, await bundleFor("node", join(here, "g1run.ts"))); run = nodeRun(file); }
  else { const c = await chromeRun(); run = c.run; close = c.close; label = "Chrome " + c.version; }
  const refRows = new Map((ref?.[engine]?.rows ?? []).map((r) => [r.w, r]));
  const got = new Map(todo.filter((w) => !ref || refRows.has(w)).map((w) => [w, [] as Sample[]]));
  for (let i = 0; i < runs; i++) {
    checkSource(`before ${engine} pass ${i}`);
    for (const [w, samples] of got) {
      let result: G1Result;
      try {
        if (guardFailures.length) throw new Error(guardFailures.join("; "));
        result = await run({ cls: classOf.get(w)!, workload: w, reps, dex, root: ROOT }); }
      catch (error) { result = { workload: w, result: "", times: [], error: String(error).slice(0, 900) }; }
      samples.push(sample(result));
    }
    checkSource(`after ${engine} pass ${i}`);
    loads.push(loadavg()[0]);
  }
  const failures = [...got].flatMap(([workload, samples]) => {
    const expected = refRows.get(workload)?.result ?? samples.find((s) => !s.error)?.result ?? "";
    return samples.flatMap((s, run) => { const error = sampleError(s, expected, reps + 1); return error ? [{ workload, run, error, completedCalls: s.completedCalls }] : []; })
      .concat(samples.length === runs ? [] : [{ workload, run: -1, error: "incomplete run count", completedCalls: 0 }]);
  });
  const omittedWorkloads = todo.filter(w => !got.has(w));
  const rows = [], ratios = { first: [] as number[], steady: [] as number[] }, byClass = new Map<string, { first: number[]; steady: number[] }>();
  console.log(`\n${label}: ${runs} runs x ${reps} reps; medians, [min-max] over runs; ms${ref ? "; x = the reference's median over this one's" : ""}`);
  console.log(`scenario: ${report.scenario}; worker: ${installedDir && engine !== "node" && !inlineTier ? "prestarted before first call" : "inline"}; startup: ${JSON.stringify(report.startup)}`);
  console.log("workload".padEnd(11), "first".padStart(11), ...(ref ? ["x".padStart(6)] : []), "steady".padStart(12), ...(ref ? ["x".padStart(6)] : []), " warm(2-11)  compile");
  for (const [w, e] of got) {
    const invalid = failures.filter(f => f.workload === w);
    if (invalid.length) { console.log(w.padEnd(11), `FAILED (${invalid.map(f => `${f.run}: ${f.error}`).join("; ")})`); continue; }
    const f = (xs: Sample[], k: "first" | "steady" | "warm") => xs.map((x) => x[k]);
    const rng = (a: number[]) => `${med(a).toFixed(a[0] < 1 ? 3 : 1)} [${Math.min(...a).toFixed(a[0] < 1 ? 3 : 1)}-${Math.max(...a).toFixed(a[0] < 1 ? 3 : 1)}]`;
    const r = refRows.get(w), xf = r ? med(r.first) / med(f(e, "first")) : 0, xs = r ? med(r.steady) / med(f(e, "steady")) : 0;
    if (r) {
      ratios.first.push(xf); ratios.steady.push(xs);
      const bc = byClass.get(classOf.get(w)!) ?? (byClass.set(classOf.get(w)!, { first: [], steady: [] }), byClass.get(classOf.get(w)!)!);
      bc.first.push(xf); bc.steady.push(xs);
    }
    rows.push({ w, result: e[0].result, first: f(e, "first"), completedCalls: e.map((x) => x.completedCalls), boot: e.map((x) => x.bootMs ?? 0), ahead: e.map((x) => x.ahead ?? 0), appRead: e.map((x) => x.appReadMs ?? 0), worldSetup: e.map((x) => x.worldSetupMs ?? 0), workerStart: e.map((x) => x.workerStartMs ?? 0), prestartedWorker: e.map((x) => !!x.prestartedWorker), calls: e.map((x) => (x.stats?.methods ?? 0) - (x.setup?.methods ?? x.boot?.methods ?? 0)), steady: f(e, "steady"), warm: f(e, "warm"), ...(r && { firstRatio: xf, steadyRatio: xs }) });
    console.log(w.padEnd(11), rng(f(e, "first")).padStart(11), ...(r ? [xf.toFixed(2).padStart(6)] : []), rng(f(e, "steady")).padStart(12), ...(r ? [xs.toFixed(2).padStart(6)] : []), "  ", med(f(e, "warm")).toFixed(3), " ", med(e.map((x) => x.compileMs ?? 0)).toFixed(0));
  }
  if (opts.phases) {
    // what the engine and our compiler spent from World creation to the end of the first call, split at the end of process setup (medians over runs, ms)
    const keys = ["prepare", "flow", "infer", "facts", "emit", "encode"], total = (xs: number[]) => med(xs);
    console.log("\nphases (ms): boot = process setup, setup = prestarted worker work, first = the first call, rest = the calls after it;  compile = our compiler (prepare flow infer facts emit encode), module/inst = V8, class = class modules (build, link)");
    console.log("workload".padEnd(11), "part".padEnd(5), "methods".padStart(7), "units".padStart(6), "classes".padStart(7), "compile".padStart(8), ...keys.map((k) => k.padStart(7)), "module".padStart(7), "inst".padStart(6), "classB".padStart(7), "classMs".padStart(8), "KB".padStart(6), "aotD".padStart(5), "aotC".padStart(5), "dead".padStart(5), "miss".padStart(5), "aotMs".padStart(6), "read".padStart(5), "aotKB".padStart(6), "upg".padStart(4));
    for (const [w, e] of got) for (const part of ["boot", "setup", "first", "rest"] as const) {
      const v = (f: (s: Stats) => number) => total(e.map((x) => { const end = x.stats!, b = x.boot!, setup = x.setup ?? b, first = x.firstStats ?? end; return part === "boot" ? f(b) : part === "setup" ? f(setup) - f(b) : part === "first" ? f(first) - f(setup) : f(end) - f(first); }));
      if (!e.length || e.some(x => !x.stats || !x.boot)) continue;
      console.log(w.padEnd(11), part.padEnd(5), String(v((s) => s.methods)).padStart(7), String(v((s) => s.units)).padStart(6), String(v((s) => s.classes)).padStart(7), v((s) => s.compileMs).toFixed(0).padStart(8),
        ...keys.map((k) => v((s) => s.phase[k]).toFixed(0).padStart(7)), v((s) => s.moduleMs).toFixed(0).padStart(7), v((s) => s.instantiateMs).toFixed(0).padStart(6), v((s) => s.phase.classBuild).toFixed(0).padStart(7), v((s) => s.classMs).toFixed(0).padStart(8), (v((s) => s.bytes) / 1024).toFixed(0).padStart(6),
        String(v((s) => s.aot.d)).padStart(5), String(v((s) => s.aot.c)).padStart(5), String(v((s) => s.aot.dead)).padStart(5), String(v((s) => s.aot.missed)).padStart(5), v((s) => s.aot.ms).toFixed(0).padStart(6), v((s) => s.aot.readMs).toFixed(0).padStart(5), (v((s) => s.aot.bytes) / 1024).toFixed(0).padStart(6), String(v((s) => s.upgrades)).padStart(4));
    }
  }
  const complete = guardFailures.length === 0 && failures.length === 0 && omittedWorkloads.length === 0 && rows.length === todo.length && rows.length > 0;
  const geometric = complete && ref;
  if (geometric) for (const [cls, r] of byClass) console.log(`geometric-mean speedup (reference/this) over all ${r.steady.length} selected ${cls} workloads: first call ${geo(r.first).toFixed(2)}x, steady state ${geo(r.steady).toFixed(2)}x`);
  if (!complete) { console.log("Failed or omitted workloads remain in samples/failures."); process.exitCode = 1; }
  (report.engines as Record<string, unknown>)[engine] = { label, workerPolicy: installedDir && engine !== "node" && !inlineTier ? "prestarted-before-first-call" : "inline", selected:got.size, selectedWorkloads:todo, omittedWorkloads, complete, failures, reference:refPath||null, rows, samples:Object.fromEntries(got), geoFirst: geometric ? geo(ratios.first) : null, geoSteady: geometric ? geo(ratios.steady) : null };
  await close();
}
checkSource("final");
report.sourceStable = guardFailures.length === 0;
report.sourceGuardFailures = guardFailures;
if (guardFailures.length) {
  process.exitCode = 1;
  console.error(guardFailures.join("\n"));
  for (const result of Object.values(report.engines as Record<string, { complete: boolean; geoFirst: number | null; geoSteady: number | null }>)) {
    result.complete = false; result.geoFirst = null; result.geoSteady = null;
  }
}
const peak = Math.max(...loads), noisy = peak > 2;
report.loads = loads;
console.log(`\nload average (1 min) at each pass: ${loads.map((l) => l.toFixed(1)).join(" ")} on ${cpus().length} cores${noisy ? "  *** Elevated load average; idle provenance unverified ***" : ""}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
