// G1 timing: every jbench workload the Wasm tier already reproduces, first call and steady state, Wasm against the production JS tier,
// in node and in headless Chrome (so Liftoff and TurboFan tiering are both represented). A workload is a `case` of scripts/jbench/Bench.java;
// new ones join as soon as their Wasm result matches the JS tier's. Every measurement is a fresh engine; runs interleave JS and Wasm.
//   bun g1.ts [workload ...] [--reps 100] [--runs 5] [--engines node,chrome] [--json out.json] [--ref earlier.json] [--v8-flags "--flag ..."] [--installed DIR [--inline]]
// --ref takes the JS tier's numbers (and which workloads match) from an earlier --json run and measures only Wasm, for A/B work on the compiler.
// --installed DIR runs the Wasm tier as a launch of the installed app (g1app.ts made DIR over the platform build in WEBDROID_AOT): its saved build attached, the host's classes, and in
// Chrome a forcibly prestarted compile worker; setup time is reported separately. The saved app's measured-demand startup list replaces the platform default in this supplemental
// scenario. With --inline the page compiles the second tier itself, as without --installed. Ordinary/on-demand remains the primary G1 scenario.
// Needs javac, d8, node and (for chrome) Playwright's Chrome. The host is shared: the load average is printed and a high one flags the table noisy.
import { cpus, loadavg } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import type { G1Config, G1Result } from "./g1run";
import { AOSP, G1_DIR, JAVA, ROOT } from "./paths";
import { cutWorkloads, dexAndroid, shellIn } from "./tools";
import { sourceKey } from "./aot-key";
import { createHash } from "node:crypto";

const here = import.meta.dir;
const flag = (k: string, d: string) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const reps = +flag("--reps", "100"), runs = +flag("--runs", "5"), engines = flag("--engines", "node,chrome").split(","), jsonOut = flag("--json", ""), refPath = flag("--ref", ""), v8Flags = flag("--v8-flags", "");
/** the workloads as an installed app: the saved build g1app.ts made in this directory (with WEBDROID_AOT its platform build) */
const installedDir = flag("--installed", ""), inlineTier = process.argv.includes("--inline");
const only = process.argv.slice(2).filter((a, i, v) => !a.startsWith("--") && !v[i - 1]?.startsWith("--"));

// ---- Bench.java and G1.java with each workload cut into its own static method (as jbench.ts does)
const out = G1_DIR, sources = [["Bench", join(ROOT, "scripts/jbench/Bench.java")], ["G1", join(JAVA, "G1.java")]];
mkdirSync(out, { recursive: true });
const sh = shellIn(out);
const names: string[] = [], classOf = new Map<string, string>(), cut = sources.map(([cls, file]) => {
  const { names: own, source } = cutWorkloads(readFileSync(file, "utf8"));
  for (const n of own) { names.push(n); classOf.set(n, cls); }
  return { cls, file, text: source };
});
const dex = join(out, "classes.dex");
if (!existsSync(dex) || cut.some((c) => statSync(dex).mtimeMs < statSync(c.file).mtimeMs)) {
  for (const c of cut) writeFileSync(join(out, `${c.cls}.java`), c.text);
  dexAndroid(sh, out, cut.map((c) => `${c.cls}.java`));
}
const todo = names.filter((n) => !only.length || only.includes(n));

// ---- one bundle per engine: oracle.ts's platform import becomes g1platform.ts, and a page's node:fs the preloaded files
const bundle = async (browser: boolean) => {
  const r = await Bun.build({ entrypoints: [join(here, "g1run.ts")], target: browser ? "browser" : "node", outdir: join(out, browser ? "page" : "node"), define: { "import.meta.main": "false" },
    plugins: [{ name: "g1", setup(b) {
      b.onResolve({ filter: /tests\/platform$/ }, () => ({ path: join(here, "g1platform.ts") }));
      if (browser) b.onResolve({ filter: /^node:fs$/ }, () => ({ path: join(here, "g1fs.ts") }));
    } }] });
  if (!r.success) throw new Error(r.logs.join("\n"));
  return r.outputs[0].path;
};
const base64 = Bun.spawnSync(["node", "-p", "typeof Uint8Array.fromBase64"]).stdout.toString().trim() === "function" ? [] : ["--js-base-64"];
const nodeRun = (b: string) => (cfg: G1Config): G1Result => {
  const r = Bun.spawnSync(["node", "--expose-gc", "--experimental-wasm-jspi", ...base64, ...v8Flags.split(" ").filter(Boolean), b, JSON.stringify(cfg)], { env: { ...process.env, G1_ROOT: ROOT, ...(installedDir && { G1_APP: installedDir }) } });
  const line = r.stdout.toString().split("\n").find((l) => l.startsWith("G1"));
  if (!line) throw new Error(`${cfg.workload}/${cfg.mode}: ${r.stderr.toString().slice(0, 400)}`);
  return JSON.parse(line.slice(2));
};
async function chromeRun() {
  const { chromium } = await import("playwright");
  const bundlePath = await bundle(true);
  const aotDir = process.env.WEBDROID_AOT;
  const preload = [dex, ...PLATFORM_JARS.map((j) => join(AOSP, j))];
  // an installed app's saved build, and the compile worker the page's launch starts (host/compile-worker.ts)
  const worker = installedDir ? await Bun.build({ entrypoints: [join(here, "../../src/wasm/host/compile-worker.ts")], target: "browser" }) : undefined;
  if (worker && !worker.success) throw new Error(worker.logs.join("\n"));
  // cross-origin isolation gives performance.now() microsecond resolution instead of 0.1 ms
  const iso = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" };
  const server = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url), p = u.pathname;
    if (p === "/") return new Response(`<script type=module>globalThis.G1_ROOT=${JSON.stringify(ROOT)};globalThis.G1_AOT=${JSON.stringify(aotDir ?? "")}||undefined;globalThis.G1_APP=${JSON.stringify(installedDir)}||undefined;globalThis.G1_INLINE=${inlineTier};const f={};await Promise.all(${JSON.stringify(preload)}.map(async(p)=>f[p]=new Uint8Array(await(await fetch("/f?p="+encodeURIComponent(p))).arrayBuffer())));globalThis.G1_FILES=f;await import("/g1.js");window.ready=true</script>`, { headers: { "content-type": "text/html", ...iso } });
    // G1_STARTUP=all: every module of the build is fetched and compiled before the first call, which shows what the rows cost when the page has what they run
    if (aotDir && p.endsWith("/startup.json") && process.env.G1_STARTUP === "all") return Response.json(readdirSync(aotDir).filter((f) => /^[cd]\d+\.wasm$/.test(f)), { headers: iso });
    if (aotDir && p.startsWith("/aot/")) { const file = join(aotDir, p.split("/").pop()!); return existsSync(file) ? new Response(Bun.file(file), { headers: { "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/json", ...iso } }) : new Response("", { status: 404 }); }
    if (p === "/g1.js") return new Response(Bun.file(bundlePath), { headers: { "content-type": "text/javascript", ...iso } });
    if (installedDir && p === "/app/files.json") return Response.json(readdirSync(installedDir), { headers: iso });
    if (installedDir && p.startsWith("/app/")) return new Response(Bun.file(join(installedDir, p.split("/").pop()!)), { headers: iso });
    if (worker && p === "/wasm-compile-worker.js") return new Response(worker.outputs[0], { headers: { "content-type": "text/javascript", ...iso } });
    const file = p === "/f" ? u.searchParams.get("p")! : p.startsWith("/vendor/aosp/") ? join(ROOT, p) : null;
    return file && existsSync(file) ? new Response(Bun.file(file), { headers: iso }) : new Response("", { status: 404 });
  } });
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: [`--js-flags=--expose-gc ${v8Flags}`] });
  const version = browser.version();
  return { version, run: async (cfg: G1Config): Promise<G1Result> => {
    const page = await (await browser.newContext()).newPage();
    page.on("pageerror", (e) => console.log("PAGEERR", String(e).slice(0, 500)));
    await page.goto(`http://localhost:${server.port}/`);
    await page.waitForFunction("window.ready === true", null, { timeout: 120000 });
    const r = await page.evaluate((c) => (globalThis as unknown as { g1run: (c: unknown) => Promise<unknown> }).g1run(c), cfg) as G1Result;
    await page.context().close();
    return r;
  }, close: async () => { await browser.close(); server.stop(); } };
}

// ---- measure
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const geo = (a: number[]) => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length);
interface Sample { first: number; warm: number; steady: number; completedCalls:number; result: string; error?: string; compileMs?: number; bootMs?: number; ahead?: number; appReadMs?: number; worldSetupMs?: number; workerStartMs?: number; prestartedWorker?: boolean; boot?: Stats; setup?: Stats; firstStats?: Stats; stats?: Stats }
type Stats = Record<string, number> & { phase: Record<string, number>; aot: Record<string, number> }
const sample = (r: G1Result): Sample => ({ first: r.times[0], warm: med(r.times.slice(1, 11)), steady: med(r.times.slice(Math.max(1, r.times.length >> 1))), completedCalls:r.times.length, result: r.result, error: r.error, compileMs: r.compileMs, bootMs: r.bootMs, ahead: r.ahead, appReadMs: r.appReadMs, worldSetupMs: r.worldSetupMs, workerStartMs: r.workerStartMs, prestartedWorker: r.prestartedWorker, boot: r.boot as Stats, setup: r.setup as Stats, firstStats: r.first as Stats, stats: r.stats as Stats });
const loads: number[] = [loadavg()[0]];
type Row = { w: string; result: string; jsFirst: number[]; jsSteady: number[] };
const ref: Record<string, { rows: Row[] }> | null = refPath ? JSON.parse(readFileSync(refPath, "utf8")).engines : null;
const report: Record<string, unknown> = { installed: installedDir || null, inline: inlineTier, source:sourceKey(), dexSha256:createHash("sha256").update(readFileSync(dex)).digest("hex"), cores: cpus().length, reps, runs, loadStart: loadavg()[0], cold:process.argv.includes("--cold"), aot:process.env.WEBDROID_AOT??null, accepted:false, engines: {} };
const artifact = (dir: string, name: string) => ({ path: join(dir, name), sha256: createHash("sha256").update(readFileSync(join(dir, name))).digest("hex") });
report.scenario = installedDir ? "installed-measured-demand-preload" : "ordinary-on-demand";
report.startup = installedDir ? artifact(installedDir, "startup.json") : process.env.WEBDROID_AOT ? artifact(process.env.WEBDROID_AOT, "startup.json") : null;
report.appIndex = installedDir ? artifact(installedDir, "index.json") : null;
report.platformIndex = process.env.WEBDROID_AOT ? artifact(process.env.WEBDROID_AOT, "index.json") : null;
report.harnessSha256 = createHash("sha256").update(readFileSync(import.meta.path)).update(readFileSync(join(here, "g1run.ts"))).digest("hex");
report.v8Flags = v8Flags;
report.startupOverride = process.env.G1_STARTUP ?? null;

for (const engine of engines) {
  let run: (c: G1Config) => G1Result | Promise<G1Result>, label = "node " + Bun.spawnSync(["node", "-p", "process.version + ' (V8 ' + process.versions.v8 + ')'"]).stdout.toString().trim(), close = async () => {};
  if (engine === "node") run = nodeRun(await bundle(false));
  else { const c = await chromeRun(); run = c.run; close = c.close; label = "Chrome " + c.version; }
  const refRows = new Map((ref?.[engine]?.rows ?? []).map((r) => [r.w, r]));
  const got = new Map<string, { js: Sample[]; wasm: Sample[]; blocked: boolean }>();
  for (const w of todo) if (!ref || refRows.has(w)) {
    const r = refRows.get(w);
    got.set(w, { js: r ? r.jsFirst.map((first, i) => ({ first, warm: 0, steady: r.jsSteady[i], completedCalls:0, result: r.result })) : [], wasm: [], blocked: false });
  }
  for (let i = 0; i < runs; i++) {
    for (const w of got.keys()) for (const mode of (i%2?["wasm","js"]:["js","wasm"]) as ("js"|"wasm")[]) {
      const entry = got.get(w)!;
      if (ref && mode === "js") continue;
      if (entry.blocked && (mode === "wasm" || i > 0)) continue;
      const r = sample(await run({ mode, cls: classOf.get(w)!, workload: w, reps, dex, root: ROOT, cold:process.argv.includes("--cold") }));
      entry[mode].push(r);
      if (mode === "wasm" && i === 0 && ((r.error && !r.result) || r.result !== entry.js[0].result)) entry.blocked = true;
    }
    loads.push(loadavg()[0]);
  }
  const rows = [], ratios = { first: [] as number[], steady: [] as number[] }, byClass = new Map<string, { first: number[]; steady: number[] }>();
  console.log(`\n${label}: ${runs} runs x ${reps} reps; medians, [min-max] over runs; ms`);
  console.log(`scenario: ${report.scenario}; worker: ${installedDir && engine !== "node" && !inlineTier ? "prestarted before first call" : "inline"}; startup: ${JSON.stringify(report.startup)}`);
  console.log("workload".padEnd(11), "js first".padStart(9), "wasm first".padStart(11), "x".padStart(6), "js steady".padStart(11), "wasm steady".padStart(12), "x".padStart(6), " wasm warm(2-11)  compile");
  for (const [w, e] of got) {
    if (e.blocked) { console.log(w.padEnd(11), `blocked (${e.wasm[0]?.error ?? "result differs"})`); continue; }
    const f = (xs: Sample[], k: "first" | "steady" | "warm") => xs.map((x) => x[k]);
    const rng = (a: number[]) => `${med(a).toFixed(a[0] < 1 ? 3 : 1)} [${Math.min(...a).toFixed(a[0] < 1 ? 3 : 1)}-${Math.max(...a).toFixed(a[0] < 1 ? 3 : 1)}]`;
    const xf = med(f(e.js, "first")) / med(f(e.wasm, "first")), xs = med(f(e.js, "steady")) / med(f(e.wasm, "steady"));
    ratios.first.push(xf); ratios.steady.push(xs);
    const bc = byClass.get(classOf.get(w)!) ?? (byClass.set(classOf.get(w)!, { first: [], steady: [] }), byClass.get(classOf.get(w)!)!);
    bc.first.push(xf); bc.steady.push(xs);
    rows.push({ w, result: e.js[0].result, firstRatio: xf, steadyRatio: xs, jsFirst: f(e.js, "first"), wasmFirst: f(e.wasm, "first"), jsCompletedCalls: e.js.map((x) => x.completedCalls), wasmCompletedCalls: e.wasm.map((x) => x.completedCalls), wasmBoot: e.wasm.map((x) => x.bootMs ?? 0), wasmAhead: e.wasm.map((x) => x.ahead ?? 0), wasmAppRead: e.wasm.map((x) => x.appReadMs ?? 0), wasmWorldSetup: e.wasm.map((x) => x.worldSetupMs ?? 0), wasmWorkerStart: e.wasm.map((x) => x.workerStartMs ?? 0), prestartedWorker: e.wasm.map((x) => !!x.prestartedWorker), wasmCalls: e.wasm.map((x) => (x.stats?.methods ?? 0) - (x.setup?.methods ?? x.boot?.methods ?? 0)), jsSteady: f(e.js, "steady"), wasmSteady: f(e.wasm, "steady"), wasmWarm: f(e.wasm, "warm") });
    const cut = e.wasm.find((x) => x.error);
    if (cut) console.log(`  note: ${w} stopped early (${cut.error}); its steady state is over the calls that completed`);
    console.log(w.padEnd(11), rng(f(e.js, "first")).padStart(9), rng(f(e.wasm, "first")).padStart(11), xf.toFixed(2).padStart(6), rng(f(e.js, "steady")).padStart(11), rng(f(e.wasm, "steady")).padStart(12), xs.toFixed(2).padStart(6), "  ", med(f(e.wasm, "warm")).toFixed(3), " ", med(e.wasm.map((x) => x.compileMs ?? 0)).toFixed(0));
  }
  if (process.argv.includes("--phases")) {
    // what the engine and our compiler spent from World creation to the end of the first call, split at the end of process setup (medians over runs, ms)
    const keys = ["prepare", "flow", "infer", "facts", "emit", "encode"], total = (xs: number[]) => med(xs);
    console.log("\nphases (ms): boot = process setup, setup = prestarted worker work, first = the first call, rest = the calls after it;  compile = our compiler (prepare flow infer facts emit encode), module/inst = V8, class = class modules (build, link)");
    console.log("workload".padEnd(11), "part".padEnd(5), "methods".padStart(7), "units".padStart(6), "classes".padStart(7), "compile".padStart(8), ...keys.map((k) => k.padStart(7)), "module".padStart(7), "inst".padStart(6), "classB".padStart(7), "classMs".padStart(8), "KB".padStart(6), "aotD".padStart(5), "aotC".padStart(5), "dead".padStart(5), "miss".padStart(5), "aotMs".padStart(6), "read".padStart(5), "aotKB".padStart(6), "upg".padStart(4));
    for (const [w, e] of got) for (const part of ["boot", "setup", "first", "rest"] as const) {
      const v = (f: (s: Stats) => number) => total(e.wasm.map((x) => { const end = x.stats!, b = x.boot!, setup = x.setup ?? b, first = x.firstStats ?? end; return part === "boot" ? f(b) : part === "setup" ? f(setup) - f(b) : part === "first" ? f(first) - f(setup) : f(end) - f(first); }));
      if (!e.wasm.length || !e.wasm[0].stats) continue;
      console.log(w.padEnd(11), part.padEnd(5), String(v((s) => s.methods)).padStart(7), String(v((s) => s.units)).padStart(6), String(v((s) => s.classes)).padStart(7), v((s) => s.compileMs).toFixed(0).padStart(8),
        ...keys.map((k) => v((s) => s.phase[k]).toFixed(0).padStart(7)), v((s) => s.moduleMs).toFixed(0).padStart(7), v((s) => s.instantiateMs).toFixed(0).padStart(6), v((s) => s.phase.classBuild).toFixed(0).padStart(7), v((s) => s.classMs).toFixed(0).padStart(8), (v((s) => s.bytes) / 1024).toFixed(0).padStart(6),
        String(v((s) => s.aot.d)).padStart(5), String(v((s) => s.aot.c)).padStart(5), String(v((s) => s.aot.dead)).padStart(5), String(v((s) => s.aot.missed)).padStart(5), v((s) => s.aot.ms).toFixed(0).padStart(6), v((s) => s.aot.readMs).toFixed(0).padStart(5), (v((s) => s.aot.bytes) / 1024).toFixed(0).padStart(6), String(v((s) => s.upgrades)).padStart(4));
    }
  }
  for (const [cls, r] of byClass) console.log(`geometric-mean speedup (js/wasm) over ${r.steady.length} matching ${cls} workloads: first call ${geo(r.first).toFixed(2)}x, steady state ${geo(r.steady).toFixed(2)}x`);
  const failures=[...got].flatMap(([workload,e])=>["js","wasm"].flatMap(mode=>e[mode as "js"|"wasm"].flatMap((s,run)=>s.error||s.result!==e.js[0]?.result||((!ref||mode==="wasm")&&s.completedCalls!==reps+1)?[{workload,mode,run,error:s.error??(s.result!==e.js[0]?.result?"result differs":"incomplete call count"),completedCalls:s.completedCalls}]:[])));
  (report.engines as Record<string, unknown>)[engine] = { label, workerPolicy: installedDir && engine !== "node" && !inlineTier ? "prestarted-before-first-call" : "inline", selected:got.size, selectedWorkloads:todo, blocked:[...got].filter(([,e])=>e.blocked).map(([w])=>w), failures, reference:refPath||null, rows, samples:Object.fromEntries(got), geoFirst: ratios.first.length ? geo(ratios.first) : null, geoSteady: ratios.steady.length ? geo(ratios.steady) : null };
  await close();
}
const peak = Math.max(...loads), noisy = peak > 2;
report.loads = loads;
console.log(`\nload average (1 min) at each pass: ${loads.map((l) => l.toFixed(1)).join(" ")} on ${cpus().length} cores${noisy ? "  *** NOISY: other agents were running; indicative only ***" : ""}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
