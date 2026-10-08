// Tap latency proxy: pointerup to the first changed quantized screen bitmap. A release or ripple
// can change it before the intended content responds; semantic response needs a separate check.
//
//   bun run lat [scenario ...] [--gpu] [--warm] [--timeline] [--json <file>] [--query jvmProfile=1] [--cpuprofile <file>]
//
// Drives headless Chrome over raw CDP with only Page/Target enabled: Playwright's Runtime.enable
// makes V8 capture a detailed stack for every Java exception, about 5x their cost. The scenario
// runs inside the page, signals through document.title and exports copied diagnostics without enabling Runtime. `--warm` launches each scenario twice
// in one browser profile and gates the second: it starts from fresh app data (wd.reset) but with
// the compiled code the first launch persisted.
// A scenario is scripts/lat/scenarios/<name>.json:
//   { "apk": "FitNotes.apk", "steps": [{"tap":[x,y]} | {"text":"Save"} | {"m":"name","tap":[x,y] | "text":…} | {"wait":ms}
//     | {"swipe":[x1,y1,x2,y2,ms]} | {"pick":"photo.jpg"}] }   (pick offers a synthetic photo)
// Coordinates are in the fixed 1080x2160@480 screen. Only "m" taps are gated; each launch also
// reports navigation to its first frame and to idle, ungated. --cpuprofile writes
// the gated launch's V8 profile; each gated pointerup then runs __wdMarkUp (1 ms) so
// scripts/lat/profsum.ts can window the profile to one tap.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import { consume } from "../args";

const LIMIT_MS = 150;
const SCREEN = "1080x2160@480";
const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const SCENARIOS = join(import.meta.dir, "scenarios");

const args = process.argv.slice(2);
const { flag, option } = consume(args);
const gpu = flag("--gpu"), warm = flag("--warm"), timeline = flag("--timeline"), jsonOut = option("--json"), query = option("--query"), cpuProfile = option("--cpuprofile");
const launchQuery = new URLSearchParams(query);
if (!launchQuery.has("tier")) launchQuery.set("tier", process.env.WEBDROID_TIER ?? "js");
if (!launchQuery.has("processMode")) launchQuery.set("processMode", "iframe");
if (!["js", "wasm"].includes(launchQuery.get("tier")!)) throw new Error("lat tier must be js or wasm");
const names = args.length ? args : readdirSync(SCENARIOS).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"));

/** the wd.perf counters a tap's breakdown reports, as deltas from pointerup to the response */
const COUNTERS = ["inputMs", "compileMs", "classesCompiled", "clinitMs", "resParseMs", "methodsReached", "methodsCold", "coldCalls", "drawMs", "frameMs", "presentations", "presentLagMs",
  // populated under ?jvmProfile=1 only
  // the Wasm tier
  "wasmMethods", "wasmCompileMs", "wasmModules", "wasmModuleMs", "wasmBytes", "wasmAotLoaded", "wasmAotMissed", "wasmAotMs", "wasmClasses", "wasmSuspensions", "wasmCrossings", "wasmEntries",
  "jvmDecodeMs", "jvmCfgMs", "jvmTypeMs", "jvmColdBuildMs", "jvmHotEmitMs", "jvmJsCompileMs", "jvmClassLinkMs", "jvmColdRunMs", "jvmHotRunMs"];

type Tap = { m: string; afterUp: number | null; first: number | null; settled: number | null; frames: number; perf: Record<string, number>; processesBefore: unknown; processesAfter: unknown };
/** Root draw proxy and realm presentation marks; compile counters below still belong to the root. */
type Launch = { firstFrame: number; appPresentationMarks: { url: string; pkg: string; tier: string; at: number; visible: boolean }[];
  idle: number; perf: Record<string, number>; marks: string[] };
type Capture = { launch?: Launch; taps: Tap[]; processesBefore?: unknown; processesAfter?: unknown;
  codeReadiness?: { phase: "saved" | "attached"; realms: unknown[] }; error?: string };

const inPage = (steps: unknown, counters: string[], save: boolean, replay: boolean) => `(${async function run(steps: any[], counters: string[], save: boolean, replay: boolean) {
  const w = globalThis as any;
  const result: Capture = w.__wdLat = { taps: [] };
  const realms = () => [window, ...[...document.querySelectorAll("iframe")].flatMap(f => {
    try { return f.contentWindow && new URL(f.contentWindow.location.href).origin === location.origin && f.contentWindow.location.pathname === "/process" ? [f.contentWindow] : []; }
    catch { return []; }
  })];
  const readRealm = (win: Window) => {
    const wd = (win as any).wd, cold = win.__wdCold;
    if (!wd) return { url: win.location.href, status: "unavailable" };
    return { url: win.location.href, status: "ok", tier: wd.tier, pkg: wd.app()?.pkg ?? null, ticks: wd.ticks,
      pid: new URLSearchParams(win.location.search).get("pid"), process: new URLSearchParams(win.location.search).get("process"),
      missing: [...wd.rt.missing], missingAt: Object.fromEntries([...wd.rt.missingAt ?? []].map(([name, frames]) => [name, frames.slice()])), placeholders: [...wd.rt.placeholders],
      placeholderAt: Object.fromEntries([...wd.rt.placeholderAt].map(([name, frames]) => [name, frames.slice()])), native: wd.nativeRequirements(), logs: wd.logs?.slice() ?? null,
      perf: { ...wd.perf }, queue: { ...wd.mainDbg }, coverage: wd.jvmCoverage?.snapshot?.() ?? null,
      code: wd.code?.() ?? null, wasm: cold ? { enabled: cold.enabled, appSaved: cold.appSaved ?? null, appAttached: cold.appAttached ?? null,
        aotKey: cold.aotKey ?? null, appBuilds: cold.appBuilds?.map(b => ({ ...b })) ?? [], worker: cold.worker ? { ...cold.worker } : null } : null };
  };
  const diagnostics = w.__wdLatRead = async () => {
    let workers;
    try { workers = w.wd?.workerProcesses ? await w.wd.workerProcesses() : []; }
    catch (error) { workers = [{ error: String(error) }]; }
    return { at: performance.now(), frames: realms().map(readRealm), workers };
  };
  const appRealms = () => realms().filter(win => !!(win as any).wd?.app());
  const readiness = async (win: Window, save: boolean) => {
    const wd = (win as any).wd, cold = win.__wdCold;
    if (wd.tier === "wasm") {
      if (save) {
        if (!cold?.appSettle) throw new Error("Wasm app save hook unavailable: " + win.location.href);
        await cold.appSettle();
        if (!cold.appBuilds?.some(b => b.kept) && !cold.appSaved) throw new Error("Wasm app build was not saved: " + win.location.href);
      } else if (!cold?.appSaved || !cold.appAttached) throw new Error("Wasm warm replay did not attach saved app code: " + win.location.href);
      return readRealm(win);
    }
    if (save) await wd.codeSettle();
    const code = wd.code(), paths: string[] = [];
    for (const name of await win.caches.keys()) for (const request of await (await win.caches.open(name)).keys())
      if (code.dir && new URL(request.url).pathname.startsWith(code.dir)) paths.push(request.url);
    if (!paths.length || save && code.pending !== 0 || !save && code.loaded === 0)
      throw new Error("JS app code is not " + (save ? "saved" : "loaded") + ": " + win.location.href);
    return { ...readRealm(win), savedPaths: paths.sort() };
  };
  const small = new OffscreenCanvas(54, 108), sctx = small.getContext("2d", { willReadFrequently: true })!;
  const sig = (src: CanvasImageSource) => {
    sctx.drawImage(src, 0, 0, 54, 108);
    const d = sctx.getImageData(0, 0, 54, 108).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + (d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3)) | 0;
    return h;
  };
  let frames: { t: number; bmp: Promise<ImageBitmap>; perf: Record<string, number> }[] | null = null;
  const raw = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
  ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bmp: ImageBitmap | null) {
    if (bmp && frames && (this.canvas as HTMLCanvasElement).id === "screen")
      frames.push({ t: performance.now(), bmp: createImageBitmap(bmp, { resizeWidth: 54, resizeHeight: 108, resizeQuality: "pixelated" }), perf: snapshot() });
    return raw.call(this, bmp);
  };
  const snapshot = () => Object.fromEntries(counters.map((k) => [k, w.wd?.perf[k] ?? 0]));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  while (!(w.wd && w.wd.perf.draws > 0)) await sleep(5);
  const firstFrame = Math.round(performance.now()), launchPerf = Object.fromEntries(Object.entries(snapshot()).filter(([, v]) => v));
  const idle = async (maxMs = 8000) => {
    const until = performance.now() + maxMs;
    let quiet = 0, draws = w.wd.perf.draws;
    while (performance.now() < until) {
      const now = performance.now(), cur = w.wd.perf.draws;
      quiet = w.wd.mainDbg.queued === 0 && cur === draws ? quiet || now : 0;
      if (quiet && now - quiet >= 600) return;
      draws = cur;
      await sleep(100);
    }
  };
  for (const until = performance.now() + 60_000; !appRealms().some(win => (win as any).wd.perf.presentations > 0);) {
    if (performance.now() > until) throw new Error("First app presentation unavailable (Worker launches require a separate presentation protocol)");
    await sleep(50);
  }
  await idle();
  // the launch timeline: the marks (src/perf.ts) of this realm and of the frames in it, in ms since this navigation
  const marksOf = (win: Window, realm: string) => win.performance.getEntriesByType("mark").filter((e) => e.name.startsWith("wd:"))
    .map((e) => `${realm}:${e.name.slice(3)}:${Math.round(win.performance.timeOrigin + e.startTime - performance.timeOrigin)}`);
  const marks = [...marksOf(window, "page"), ...[...document.querySelectorAll("iframe")].flatMap((f, i) => f.contentWindow ? marksOf(f.contentWindow, "frame" + i) : [])];
  const appPresentationMarks = appRealms().flatMap(win => win.performance.getEntriesByName("wd:firstPresented").map(e => ({ url: win.location.href,
    pkg: (win as any).wd.app().pkg, tier: (win as any).wd.tier, at: Math.round(win.performance.timeOrigin + e.startTime - performance.timeOrigin),
    visible: !win.frameElement || !!win.frameElement.getBoundingClientRect().height })));
  result.launch = { firstFrame, appPresentationMarks,
    idle: Math.round(performance.now()), perf: launchPerf, marks };
  result.processesBefore = await diagnostics();
  if (replay) {
    if (new URLSearchParams(location.search).get("processMode") === "worker") throw new Error("Worker warm readiness is unavailable");
    result.codeReadiness = { phase: "attached", realms: await Promise.all(appRealms().map(win => readiness(win, false))) };
  }
  const screen = () => document.getElementById("screen") as HTMLCanvasElement;
  const ev = (type: string, x: number, y: number) => {
    const c = screen(), r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x * r.width / 1080, clientY: r.top + y * r.height / 2160, pointerId: 1, isPrimary: true, bubbles: true, pointerType: "touch" }));
  };
  const out = result.taps;
  for (const s of steps) {
    if (s.wait) { await sleep(s.wait); await idle(); continue; }
    if (s.pick) {
      // a synthetic photo, so the picker has an image to hand the app
      const img = new OffscreenCanvas(1600, 1200), g = img.getContext("2d")!, grad = g.createLinearGradient(0, 0, 1600, 1200);
      grad.addColorStop(0, "#3a6ea5"); grad.addColorStop(1, "#f2c14e");
      g.fillStyle = grad; g.fillRect(0, 0, 1600, 1200);
      const bytes = new Uint8Array(await (await img.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("lat-picked", { create: true });
      const h = await d.getFileHandle(s.pick, { create: true }), wr = await h.createWritable();
      await wr.write(bytes); await wr.close();
      w.showOpenFilePicker = async () => [h];
      continue;
    }
    if (s.swipe) {
      const [x1, y1, x2, y2, ms] = s.swipe, n = Math.max(2, Math.round(ms / 8));
      ev("pointerdown", x1, y1);
      for (let i = 1; i <= n; i++) { await sleep(ms / n); ev("pointermove", x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n); }
      ev("pointerup", x2, y2);
      await sleep(300); await idle();
      continue;
    }
    let [x, y] = s.tap ?? [];
    if (s.text) {
      let at = null;
      for (let tries = 0; !at && tries < 30; tries++) { at = await w.wd.locateText(s.text); if (!at) await sleep(100); }
      if (!at) throw new Error(`no text "${s.text}" on screen`);
      ({ x, y } = at);
    }
    const processesBefore = s.m ? await diagnostics() : undefined;
    const base = sig(screen());
    if (s.m) frames = [];
    const t0 = performance.now();
    ev("pointerdown", x, y);
    await sleep(s.hold ?? 60);
    if (s.m && w.__wdProfiling) (function __wdMarkUp() { const t = performance.now(); while (performance.now() - t < 1); })();
    const tu = performance.now(), before = snapshot();
    ev("pointerup", x, y);
    if (!s.m) { await sleep(300); await idle(); continue; }
    for (let last = performance.now(); performance.now() - last < 800 && performance.now() - t0 < 8000;) {
      await sleep(20);
      const f = frames!.at(-1);
      if (f) last = Math.max(last, f.t);
    }
    const got = frames!; frames = null;
    const changes: typeof got = [];
    let prev = base;
    for (const f of got) { const sg = sig(await f.bmp); if (sg !== prev) changes.push(f); prev = sg; }
    // the breakdown is the work done from pointerup until the frame that answered it
    const au = changes.find((f) => f.t >= tu), after = au?.perf ?? snapshot();
    const tap: Tap = { m: s.m, afterUp: au === undefined ? null : Math.round(au.t - tu), first: changes.length ? Math.round(changes[0].t - t0) : null,
      settled: changes.length ? Math.round(changes.at(-1)!.t - t0) : null, frames: got.length,
      perf: Object.fromEntries(counters.map((k) => [k, Math.round((after[k] - before[k]) * 10) / 10]).filter(([, v]) => v)) as Record<string, number>, processesBefore, processesAfter: null };
    out.push(tap);
    await idle();
    tap.processesAfter = await diagnostics();
  }
  result.processesAfter = await diagnostics();
  if (save) result.codeReadiness = { phase: "saved", realms: await Promise.all(appRealms().map(win => readiness(win, true))) };
  document.title = "DONE";
}})(${JSON.stringify(steps)}, ${JSON.stringify(counters)}, ${save}, ${replay}).catch(async e => {
  const result = globalThis.__wdLat; result.error = String(e);
  try { result.processesAfter = await globalThis.__wdLatRead(); } catch (error) { result.diagnosticError = String(error); }
  document.title = "DONE";
});`;

/** one headless Chrome over raw CDP, with its own profile directory */
async function openBrowser(profile: string) {
  const proc = Bun.spawn([chromium.executablePath(), "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--site-per-process", "--force-device-scale-factor=1", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,1500", "--no-first-run", "--no-default-browser-check",
    ...(gpu ? ["--enable-gpu", "--use-angle=metal"] : ["--use-gl=angle", "--use-angle=swiftshader"]), "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await Bun.sleep(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { /* not yet */ }
  }
  if (!port) { proc.kill(); throw new Error("Chrome did not open a debugging port"); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>();
  ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); pending.get(m.id)?.(m); pending.delete(m.id); });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  return { send, close: () => { ws.close(); proc.kill(); } };
}

async function launch(send: Awaited<ReturnType<typeof openBrowser>>["send"], apk: string, steps: unknown, profile?: string, save = false, replay = false): Promise<Capture> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `${profile ? "globalThis.__wdProfiling=1;" : ""}if (location.pathname === "/") addEventListener("DOMContentLoaded", () => { ${inPage(steps, COUNTERS, save, replay)} });` }, sessionId);
  if (profile) { await send("Profiler.enable", {}, sessionId); await send("Profiler.setSamplingInterval", { interval: 200 }, sessionId); await send("Profiler.start", {}, sessionId); }
  const url = new URL("/", BASE);
  url.search = new URLSearchParams({ ...Object.fromEntries(launchQuery), apk, screen: SCREEN }).toString();
  await send("Page.navigate", { url: url.href }, sessionId);
  try {
    for (const deadline = Date.now() + 600_000; Date.now() < deadline;) {
      await Bun.sleep(500);
      const { targetInfo } = await send("Target.getTargetInfo", { targetId });
      if (targetInfo.title !== "DONE") continue;
      if (profile) await Bun.write(profile, JSON.stringify((await send("Profiler.stop", {}, sessionId)).profile));
      const read = await send("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__wdLat)", returnByValue: true }, sessionId);
      return JSON.parse(read.result.value);
    }
    const partial = await send("Runtime.evaluate", { expression: "JSON.stringify(globalThis.__wdLat ?? {taps:[]})", returnByValue: true }, sessionId);
    return { ...JSON.parse(partial.result.value), error: "scenario timed out" };
  } finally { await send("Target.closeTarget", { targetId }); }
}

/** wipe app data (installs, preferences, databases, files) and keep everything else */
async function resetData(send: Awaited<ReturnType<typeof openBrowser>>["send"]): Promise<void> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", async () => {
    while (!globalThis.wd) await new Promise((r) => setTimeout(r, 50));
    await globalThis.wd.reset(); document.title = "RESET"; });` }, sessionId);
  await send("Page.navigate", { url: `${BASE}/?screen=${encodeURIComponent(SCREEN)}` }, sessionId);
  try {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(200))
      if ((await send("Target.getTargetInfo", { targetId })).targetInfo.title === "RESET") return;
    throw new Error("reset timed out");
  } finally { await send("Target.closeTarget", { targetId }); }
}

type Report = Capture & { scenario: string; apk?: string; tier: string; processMode: string; warm: boolean; query: string; expectedTaps?: string[]; preparation?: Capture;
  responseProxy: string; launchProxy: string };
const report: Report[] = [];
let failed = false;
for (const name of names) {
  const row: Report = { scenario: name, tier: launchQuery.get("tier")!, processMode: launchQuery.get("processMode")!, warm, query: launchQuery.toString(), taps: [],
    responseProxy: "pointerup to first changed quantized screen bitmap; release/ripple may precede intended content",
    launchProxy: "firstFrame/perf are root draw observations; appPresentationMarks identify realm bitmap transfers, with visibility observed later at startup snapshot" };
  report.push(row);
  let profile: string | undefined, browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    const { apk, steps } = JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8"));
    row.apk = apk; row.expectedTaps = steps.flatMap((step: { m?: string }) => step.m ? [step.m] : []);
    if (row.processMode === "worker") throw new Error("Worker app presentation and persisted-code readiness need a separate capture protocol");
    profile = mkdtempSync(join(tmpdir(), "wdlat-"));
    browser = await openBrowser(profile);
    if (warm) {
      row.preparation = await launch(browser.send, apk, steps, undefined, true);
      if (row.preparation.error) throw new Error("warm preparation: " + row.preparation.error);
      await resetData(browser.send);
    }
    Object.assign(row, await launch(browser.send, apk, steps, cpuProfile && `${cpuProfile.replace(/\.cpuprofile$/, "")}-${name}.cpuprofile`, false, warm));
    if (row.error) throw new Error(row.error);
    const { launch: started, taps } = row;
    if (!started || taps.length !== row.expectedTaps!.length || taps.some((tap, i) => tap.m !== row.expectedTaps![i])) throw new Error("incomplete scenario capture");
    const counters = Object.entries(started.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ");
    console.log(`     ${name.padEnd(12)} ${"launch".padEnd(14)} ${String(started.firstFrame).padStart(5)} ms  idle=${started.idle} ${counters}`);
    if (timeline) for (const [realm, name, ms] of started.marks.map((m) => m.split(":")).sort((a, b) => +a[2] - +b[2])) console.log(`       ${ms.padStart(6)} ms  ${realm.padEnd(7)} ${name}`);
    for (const t of taps) {
      const over = t.afterUp === null || t.afterUp > LIMIT_MS;
      failed ||= over;
      const detail = Object.entries(t.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`${over ? "FAIL" : "ok  "} ${name.padEnd(12)} ${t.m.padEnd(14)} ${String(t.afterUp ?? "none").padStart(5)} ms  ${detail}`);
    }
  } catch (e) {
    failed = true;
    row.error = e instanceof Error ? e.message : String(e);
    console.log(`FAIL ${name}: ${row.error}`);
  } finally {
    browser?.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(report, null, 1));
console.log(failed ? `latency gate FAILED: a scenario failed, or a gated tap exceeded ${LIMIT_MS} ms or never responded` : `latency proxy passed: every gated tap within ${LIMIT_MS} ms`);
process.exit(failed ? 1 : 0);
