// A gated tap's latency is pointerup to the first presented frame that visibly answers it: the first
// frame whose response region departs from the frame before pointerup in the tiles that the settled
// response also changed, outside the pressed view's feedback. Nothing runs Java on the app between
// pointerdown and the settled frame: the app's Worker sends downscaled crops of the response
// regions with each frame it presents, read only once the window closes, and the scenario's UI state
// is checked once afterwards.
//
//   pnpm lat [scenario ...] [--engine chrome|webkit] [--gpu] [--warm] [--ecores] [--repeat N] [--timeline] [--json <file>] [--query <params>] [--cpuprofile <file>] (one file per Worker too) [--heapsample] (with --cpuprofile: live-heap allocation samples, .heapprofile) [--trace <file>] [--demand] (each tap's on-demand compiled methods in --json)
//
// Drives headless Chrome over raw CDP with only Page/Target enabled: Playwright's Runtime.enable
// makes V8 capture a detailed stack for every Java exception, about 5x their cost. The scenario
// runs inside the page (page.ts), signals through document.title and exports copied diagnostics without enabling Runtime. `--warm` launches each scenario twice
// in one browser profile and gates the second: it starts from fresh app data (wd.reset) but with
// the compiled code the first launch persisted. `--ecores` (macOS) runs Chrome under a background QoS clamp, so every thread, the app Workers included,
// runs on the efficiency cores: a slower device (a busy loop ran about 6x slower on an M4 Pro). CDP CPU throttling slows only pages, never Workers.
// A scenario is scripts/lat/scenarios/<name>.json:
//   { "apk": "FitNotes.apk", "steps": [{"tap":[x,y]} | {"text":"Save"} | {"m":"name","tap":[x,y] | "text":…} | {"wait":ms}
//     | {"swipe":[x1,y1,x2,y2,ms]} | {"fps":[x1,y1,x2,y2],"ms":8000,"name":"…"} | {"pick":"photo.jpg"} | {"privateStorage":true} | {"back":true}],
//     "repeat": [steps] }   (pick offers a synthetic photo; fps scrolls back and forth for ms and reports presentation intervals and page long tasks;
//     --repeat N appends "repeat" N times and reports the median of its taps' third and later visits)
// "gate": false makes a scenario a report, run only when named (heavy apps: YouTube, Reddit, ChatGPT, TikTok).
// Coordinates are in the fixed 1080x2160@480 screen. Only "m" taps are gated, and a scenario also fails when its launch loaded no build
// module or a realm reported an uncaught error; each launch also
// reports root frame proxies and actual app presentation separately. --cpuprofile writes
// the gated launch's V8 profile; each gated pointerup then runs __wdMarkUp (1 ms) so
// scripts/lat/profsum.ts can window the profile to one tap. --trace writes the gated launch's browser-wide trace (every
// thread: page, Workers, GPU, V8 collections), for chrome://tracing or Perfetto; WEBDROID_TRACE_CATEGORIES (comma-separated) replaces
// its categories, e.g. disabled-by-default-v8.gc,v8 for a small GC-only trace; each gated pointerup is a `lat:<name>` user-timing mark in it. WEBDROID_JS_FLAGS and WEBDROID_CHROME_ARGS (space-separated)
// pass V8 flags and Chrome arguments for A/B runs. With --timeline, --json taps carry the Worker's and the page's timelines and the page's long tasks.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, webkit } from "playwright";
import { compileDeltas, type Expectation } from "./expect.ts";
import type { Capture, Diagnostics, LatConfig, Tap } from "./page.ts";
import { cli } from "../args.ts";
import { Ev } from "../../src/timeline.ts";
import { bundle } from "../bundle.ts";
import { BASE_URL, CONTEXT_OPTS, SOFTWARE_GL, chromeArgs } from "../page.ts";
import { diagnosticErrors } from "../../tests/e2e/lib/processes.ts";

const LIMIT_MS = 150;
const SCREEN = "1080x2160@480";
const SCENARIOS = join(import.meta.dirname, "scenarios");

const flag = { type: "boolean", default: false } as const, value = { type: "string" } as const;
const { values: { heapsample: heapSample, gpu, warm, demand, timeline, json: jsonOut, query, cpuprofile: cpuProfile, trace: traceOut, engine, ecores, repeat: repeatArg }, positionals: args } = cli(
  "pnpm lat [scenario ...] [the options scripts/lat/run.ts lists]",
  { heapsample: flag, gpu: flag, warm: flag, demand: flag, timeline: flag, ecores: flag, json: value, query: value, cpuprofile: value, trace: value, engine: { type: "string", default: "chrome" }, repeat: { type: "string", default: "0" } });
const repeat = +repeatArg;
if (!["chrome", "webkit"].includes(engine)) throw new Error("lat engine must be chrome or webkit");
if (ecores && (engine !== "chrome" || process.platform !== "darwin")) throw new Error("lat --ecores runs Chrome under macOS's taskpolicy");
const launchQuery = new URLSearchParams(query);
if (!launchQuery.has("perfProbe")) launchQuery.set("perfProbe", "1");
// a cold launch is a first launch of any app: the platform build's bundled app builds stay out unless asked for
if (!launchQuery.has("bundles")) launchQuery.set("bundles", "0");
/** a scenario with "gate": false (a heavy app whose launch waits on live content) is a report: run only when named, and its taps and failures do not fail the gate */
const gates = (name: string): boolean => JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8")).gate !== false;
const names = args.length ? args : readdirSync(SCENARIOS).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json")).filter(gates);

/** the wd.perf counters a tap's breakdown reports, as deltas from pointerup to the response */
const COUNTERS = ["inputMs", "resParseMs", "drawMs", "frameMs", "presentations", "presentLagMs",
  "nativeMs", "nativeInstr", "jitMs", "jitRegions", "wasmMethods", "wasmClassBuildMs", "wasmCompileMs", "wasmModules", "wasmModuleMs", "wasmBytes", "wasmAotLoaded", "wasmAotMissed", "wasmAotMs", "wasmClasses", "wasmSuspensions", "wasmCrossings", "wasmEntries", "wasmAhead", "wasmRetired", "wasmCollected", "wasmBurned", "earlyFrames"];


type CdpEvent = { method: string; params: any; sessionId?: string };
/** Chrome's protocol: commands to the browser or one of its sessions, and every session's events */
type Cdp = { send(method: string, params?: object, sessionId?: string): Promise<any>; events: Set<(m: CdpEvent) => void> };
/** a page under measurement: its title, which it sets once done (undefined once it crashed), and its globals */
type Tab = { title(): Promise<string | undefined>; read<T>(name: string): Promise<T | undefined>; close(): Promise<void> };
/** a headless browser with its own profile directory, WebKit through Playwright or Chrome over raw CDP: a tab opens at `url` with `script`
 *  run first in each of its documents, and on Chrome `prepare` runs on its session before it navigates */
type Browser = { version: string; cdp?: Cdp; open(url: string, script: string, prepare?: (session: string) => Promise<void>): Promise<Tab>; close(): Promise<void> };

async function openWebkit(profile: string): Promise<Browser> {
  const context = await webkit.launchPersistentContext(profile, { headless: true, viewport: CONTEXT_OPTS.viewport, colorScheme: "light" });
  return { version: context.browser()!.version(), close: () => context.close(), async open(url, script) {
    const page = await context.newPage();
    let crashed = false;
    page.on("crash", () => { crashed = true; });
    await page.addInitScript(script); await page.goto(url, { waitUntil: "commit" });
    return { title: async () => crashed ? undefined : page.title(), read: (name) => page.evaluate((name) => Reflect.get(globalThis, name), name), close: () => page.close() };
  } };
}

async function openChrome(profile: string): Promise<Browser> {
  const chromeLog = process.env.WEBDROID_CHROME_LOG;
  const [command, ...argv] = [...ecores ? ["taskpolicy", "-c", "background"] : [], chromium.executablePath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    ...chromeArgs(), "--autoplay-policy=no-user-gesture-required",
    `--window-size=${CONTEXT_OPTS.viewport.width},${CONTEXT_OPTS.viewport.height}`, "--no-first-run", "--no-default-browser-check",
    ...(gpu ? ["--enable-gpu", "--use-angle=metal"] : SOFTWARE_GL), ...(process.env.WEBDROID_CHROME_ARGS?.split(" ").filter(Boolean) ?? []), "about:blank"];
  // Chrome's own output (with WEBDROID_JS_FLAGS=--trace-gc, each V8 collection)
  const logs = chromeLog ? [openSync(chromeLog, "w"), openSync(chromeLog + ".err", "w")] : ["ignore", "ignore"] as const;
  const proc = spawn(command, argv, { stdio: ["ignore", ...logs] });
  for (const fd of logs) if (typeof fd === "number") closeSync(fd);
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { /* not yet */ }
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not open a debugging port"); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 1;
  const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>(), events = new Set<(m: CdpEvent) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id === undefined) for (const on of events) on(m);
    else { pending.get(m.id)?.(m); pending.delete(m.id); }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  // the profile is removed after close, so close waits for Chrome's last writes to it
  const exited = new Promise((r) => proc.once("exit", r));
  return { cdp: { send, events }, version: (await send("Browser.getVersion")).product, close: async () => { ws.close(); proc.kill(); await exited; }, async open(url, script, prepare) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    // a crashed page answers nothing
    let crashed = false;
    const crash = (m: CdpEvent) => { if (m.method === "Inspector.targetCrashed" && m.sessionId === sessionId) crashed = true; };
    events.add(crash);
    await send("Page.enable", {}, sessionId);
    // as the WebKit context: a light host, whatever the machine's appearance, so a scenario's theme taps change something
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
    await prepare?.(sessionId);
    await send("Inspector.enable", {}, sessionId);
    await send("Page.navigate", { url }, sessionId);
    return {
      title: async () => crashed ? undefined : (await send("Target.getTargetInfo", { targetId })).targetInfo.title,
      read: async (name) => JSON.parse((await send("Runtime.evaluate", { expression: `JSON.stringify(globalThis.${name} ?? null)`, returnByValue: true }, sessionId)).result.value) ?? undefined,
      close: async () => { events.delete(crash); await Promise.race([send("Target.closeTarget", { targetId }).catch(() => {}), delay(10_000)]); },
    };
  } };
}

/** whether `tab`'s title became `done` within `ms`, or its page crashed first */
async function outcome(tab: Tab, done: string, ms: number): Promise<"done" | "crashed" | "timeout"> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    await delay(500);
    const title = await tab.title();
    if (title === undefined) return "crashed";
    if (title === done) return "done";
  }
  return "timeout";
}

/** V8's sampling profiler, and with --heapsample its allocation sampler, on a page and every Worker it starts, each paused until its profiler runs:
 *  the page's profile is written to `file` and each Worker's beside it */
function profiler({ send, events }: Cdp, file: string) {
  const profiled = new Map<string, string>(), instrumented = new Set<string>();
  const instrument = async (session: string, label: string) => {
    instrumented.add(session);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
    profiled.set(session, label);
    await send("Profiler.enable", {}, session); await send("Profiler.setSamplingInterval", { interval: 200 }, session); await send("Profiler.start", {}, session);
    if (heapSample) { await send("HeapProfiler.enable", {}, session); await send("HeapProfiler.startSampling", { samplingInterval: 16384 }, session); }
  };
  const attached = (m: CdpEvent) => {
    if (m.method !== "Target.attachedToTarget" || !m.sessionId || !instrumented.has(m.sessionId)) return;
    const { sessionId: worker, targetInfo } = m.params, pid = new URL(targetInfo.url).searchParams.get("pid");
    void instrument(worker, pid ?? `${targetInfo.type}-${worker.slice(0, 6)}`).catch(() => {})
      .finally(() => send("Runtime.runIfWaitingForDebugger", {}, worker).catch(() => {}));
  };
  return {
    start: (session: string) => { events.add(attached); return instrument(session, ""); },
    stop: () => events.delete(attached),
    async write() {
      for (const [session, label] of profiled) {
        // a Worker that has ended may never answer
        const stopped = await Promise.race([send("Profiler.stop", {}, session).catch(() => undefined), delay(10_000)]);
        if (stopped) writeFileSync(label ? file.replace(/\.cpuprofile$/, `-${label}.cpuprofile`) : file, JSON.stringify(stopped.profile));
        // the sampled allocations still live at the end, by allocating stack
        const heap = heapSample && await Promise.race([send("HeapProfiler.getSamplingProfile", {}, session).catch(() => undefined), delay(10_000)]);
        if (heap) writeFileSync(file.replace(/\.cpuprofile$/, `${label ? "-" + label : ""}.heapprofile`), JSON.stringify(heap.profile));
      }
    },
  };
}

const PAGE = await bundle(join(import.meta.dirname, "page.ts"), { format: "iife" });
/** one launch of `apk` through `steps`: `profile` writes its CPU profile, `save` keeps the code it compiles, `replay` starts from the code kept, `trace` writes a browser trace */
async function launch(browser: Browser, apk: string, steps: unknown[], expectedLaunch: Expectation,
  { profile, save = false, replay = false, trace }: { profile?: string; save?: boolean; replay?: boolean; trace?: string } = {}): Promise<Capture> {
  const config: LatConfig = { steps, counters: COUNTERS, save, replay, expectedLaunch, E: Ev };
  const injection = `globalThis.__wdLatConfig=${JSON.stringify(config)};${profile ? "globalThis.__wdProfiling=1;" : ""}${demand && !save ? "globalThis.__wdDemand=1;" : ""}${PAGE}`;
  const url = new URL("/", BASE_URL);
  url.search = new URLSearchParams({ ...Object.fromEntries(launchQuery), apk, screen: SCREEN }).toString();
  // only Chrome is profiled or traced
  const { cdp } = browser, profiling = profile && cdp ? profiler(cdp, profile) : undefined;
  const tab = await browser.open(url.href, injection, async (session) => {
    await profiling?.start(session);
    if (trace) await cdp?.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: [...new Set([...process.env.WEBDROID_TRACE_CATEGORIES?.split(",") ?? ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.execute", "gpu", "viz", "cc", "v8", "v8.wasm", "disabled-by-default-v8.gc"], "blink.user_timing"])] } });
  });
  try {
    const end = await outcome(tab, "DONE", 600_000);
    if (end === "done") {
      await profiling?.write();
      if (trace && cdp) await writeTrace(cdp, trace);
      return await tab.read<Capture>("__wdLat") ?? { taps: [], error: "the page kept no capture" };
    }
    // the wait ends with what the page reported last
    const partial = end === "crashed" ? undefined : await Promise.race([tab.read<Capture>("__wdLat").catch(() => undefined), delay(10_000)]);
    return { ...partial ?? { taps: [] }, error: end === "crashed" ? "the page crashed" : "scenario timed out" };
  } finally { profiling?.stop(); await tab.close(); }
}

async function writeTrace({ send, events }: Cdp, file: string): Promise<void> {
  const done = new Promise<string>((resolve) => events.add(function on(m) {
    if (m.method === "Tracing.tracingComplete") { events.delete(on); resolve(m.params.stream); }
  }));
  await send("Tracing.end");
  const handle = await done, out = openSync(file, "w");
  for (let eof = false; !eof;) {
    const chunk = await send("IO.read", { handle, size: 1 << 22 });
    writeSync(out, chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
    eof = chunk.eof;
  }
  closeSync(out); await send("IO.close", { handle });
}

/** wipe app data (installs, preferences, databases, files) and keep everything else */
async function resetData(browser: Browser): Promise<void> {
  const tab = await browser.open(`${BASE_URL}/?screen=${encodeURIComponent(SCREEN)}`, `addEventListener("DOMContentLoaded", async () => {
    while (!globalThis.wd) await new Promise((r) => setTimeout(r, 50));
    await globalThis.wd.reset(); document.title = "RESET"; });`);
  try { if (await outcome(tab, "RESET", 60_000) !== "done") throw new Error("reset did not finish"); }
  finally { await tab.close(); }
}

const median = (xs: number[]) => xs.length ? Math.round(xs.slice().sort((a, b) => a - b)[xs.length >> 1] * 10) / 10 : null;
/** for each tap a scenario repeats (--repeat), the medians of its answered third and later visits */
function repeatMedians(taps: Tap[]) {
  return [...Map.groupBy(taps, (t) => t.m)].filter(([, v]) => v.length >= 3).map(([m, v]) => {
    const later = v.slice(2).flatMap((t) => t.intended !== null && t.timeline?.answer ? [{ ms: t.intended, ...t.timeline.answer }] : []);
    return { m, visits: v.length, answered: later.length, ms: median(later.map((x) => x.ms)), busy: median(later.map((x) => x.busy)), frame: median(later.map((x) => x.frame)) };
  });
}
type Report = Capture & { repeats?: ReturnType<typeof repeatMedians>; engine: string; browser?: string; scenario: string; apk?: string; warm: boolean; ecores: boolean; query: string; expectedTaps?: string[]; preparation?: Capture;
  accepted: false; intendedObservation: string; instrumentation: string; launchProxy: string; browserErrors?: string[] };
/** every realm's error lines, and each realm whose diagnostics did not arrive */
const browserErrors = (after?: Diagnostics): string[] => after ? diagnosticErrors(after.processes) : [];
const report: Report[] = [];
let failed = false;
for (const name of names) {
  const row: Report = { scenario: name, engine, warm, ecores, query: launchQuery.toString(), taps: [],
    accepted: false, intendedObservation: "first response: pointerup to the first presented app frame whose response regions depart from the pre-pointerup frame in tiles the settled frame also changed, outside the pressed view's bounds + 72 px; no guest probes between pointerdown and the settled frame; settled UI state and pixels confirmed afterwards",
    instrumentation: (engine === "chrome" ? "raw CDP Page/Target; Runtime read after capture" : "Playwright WebKit instrumentation") + "; response-region crops of every presented frame read after the window; compile counters end when the window closes",
    launchProxy: "firstFrame/perf remain root draw proxies; firstApp is visible app-owned transfer, renderedApp is scenario content after semantic receipt; compileCounters cover copied main realms and separate partial Worker receipts" };
  report.push(row);
  let profile: string | undefined, browser: Browser | undefined;
  const gated = gates(name);
  try {
    const { apk, steps: scenarioSteps, launch: expectedLaunch, responses, repeat: again = [] } = JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8"));
    const steps = [...scenarioSteps, ...Array.from({ length: repeat }, () => again).flat()].map((step: any) => step.m ? { ...step, expect: responses?.[step.expect ?? step.m] } : step);
    const validExpectation = (e: Expectation | undefined) => !!e?.nodes?.length && !!e.pixels?.length;
    if (!validExpectation(expectedLaunch) || steps.some((step: any) => step.m && !validExpectation(step.expect))) throw new Error("scenario intended-state expectations missing");
    if (engine === "webkit" && (cpuProfile || traceOut)) throw new Error("WebKit profiling and tracing require a separate protocol");
    row.apk = apk; row.expectedTaps = steps.flatMap((step: { m?: string }) => step.m ? [step.m] : []);
    profile = mkdtempSync(join(tmpdir(), "wdlat-"));
    browser = await (engine === "webkit" ? openWebkit : openChrome)(profile); row.browser = browser.version;
    if (warm) {
      row.preparation = await launch(browser, apk, steps, expectedLaunch, { save: true });
      if (row.preparation.error) throw new Error("warm preparation: " + row.preparation.error);
      await resetData(browser);
    }
    Object.assign(row, await launch(browser, apk, steps, expectedLaunch, { profile: cpuProfile && `${cpuProfile.replace(/\.cpuprofile$/, "")}-${name}.cpuprofile`,
      replay: warm, trace: traceOut && `${traceOut.replace(/\.json$/, "")}-${name}.json` }));
    if (row.error) throw new Error(row.error);
    const { launch: started, taps } = row;
    if (!started || taps.length !== row.expectedTaps!.length || taps.some((tap, i) => tap.m !== row.expectedTaps![i])) throw new Error("incomplete scenario capture");
    // a launch that loaded none of the build's modules compiled everything on demand, and is not the path being measured
    if (!started.perf.wasmAotLoaded) throw new Error("the launch loaded no build module (wasmAotLoaded=0)");
    row.browserErrors = browserErrors(row.processesAfter);
    if (row.browserErrors.length) throw new Error(`browser errors: ${row.browserErrors.slice(0, 3).join("; ").slice(0, 300)}`);
    const counters = Object.entries(started.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ");
    console.log(`     ${name.padEnd(12)} ${"launch".padEnd(14)} ${String(started.firstFrame).padStart(5)} ms  idle=${started.idle} ${counters}`);
    if (timeline) for (const [realm, name, ms] of started.marks.map((m) => m.split(":")).sort((a, b) => +a[2] - +b[2])) console.log(`       ${ms.padStart(6)} ms  ${realm.padEnd(7)} ${name}`);
    for (const t of taps) {
      t.compile = compileDeltas(t.compileBefore, t.compileAfter, t.compileWindow);
      const answer = t.timeline?.answer;
      const over = t.intended === null || t.intended > LIMIT_MS || !t.compile.mainRealmCoverage;
      failed ||= over && gated;
      const detail = Object.entries(t.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
      const r = t.response, settled = r ? ` settled=${r.settled === null ? "none" : Math.round(r.settled)} frames=${r.frames} p95=${r.intervals.p95} missed=${r.intervals.missed}${r.error ? ` (${r.error})` : ""}` : "";
      console.log(`${!over ? "ok  " : gated ? "FAIL" : "over"} ${name.padEnd(12)} ${t.m.padEnd(14)} ${String(t.intended === null ? "none" : Math.round(t.intended)).padStart(5)} ms ${settled}${answer ? ` busy=${answer.busy} frame=${answer.frame}` : ""} ${detail}`);
    }
    if (repeat) for (const r of row.repeats = repeatMedians(taps))
      console.log(`     ${name.padEnd(12)} ${r.m.padEnd(14)} visits 3-${r.visits} (${r.answered} answered): median ${r.ms} ms busy=${r.busy} frame=${r.frame}`);
    const span = (x: any) => x ? `${x.p50}/${x.p95}/${x.max}` : "-";
    for (const f of row.fps ?? []) {
      console.log(`     ${name.padEnd(12)} ${f.m.padEnd(14)} ${String(f.fps).padStart(5)} fps p50=${f.p50} p95=${f.p95} p99=${f.p99} >25ms=${f.over25} longTasks=${f.longTasks}/${f.longTaskMs}ms`);
      const fr = f.frames;
      if (fr && !fr.error) console.log(`       frames: vsyncs=${fr.vsyncs} missed busy=${fr.missedBusy} idle=${fr.missedIdle}; p50/p95/max ms: doFrame ${span(fr.doFrame)} draw ${span(fr.draw)} composite ${span(fr.composite)} vsync→present ${span(fr.vsyncToPresent)} input→dispatch ${span(fr.inputToDispatch)} busy-at-vsync ${span(fr.busyAtVsync)}`);
    }
  } catch (e) {
    failed ||= gated;
    row.error = e instanceof Error ? e.message : String(e);
    console.log(`${gated ? "FAIL" : "fail (report)"} ${name}: ${row.error}`);
  } finally {
    await browser?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
console.log(failed ? `latency gate FAILED: a scenario failed, or a gated tap exceeded ${LIMIT_MS} ms or never responded` : `intended-response observations passed: every gated tap within ${LIMIT_MS} ms`);
process.exit(failed ? 1 : 0);
