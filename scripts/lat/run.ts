// Tap latency gate (docs/bytecode-first-plan.md §4.8): pointerup to the first presented frame
// that shows the app's response, for every gated tap of a scenario.
//
//   bun run lat [scenario ...] [--gpu] [--warm] [--json <file>]
//
// Drives headless Chrome over raw CDP with only Page/Target enabled: Playwright's Runtime.enable
// makes V8 capture a detailed stack for every Java exception, about 5x their cost. The scenario
// runs inside the page and reports through document.title. `--warm` launches each scenario twice
// in one browser profile and gates the second launch, which runs with whatever the first persisted.
// A scenario is scripts/lat/scenarios/<name>.json:
//   { "apk": "FitNotes.apk", "steps": [{"tap":[x,y]} | {"m":"name","tap":[x,y]} | {"wait":ms}
//     | {"swipe":[x1,y1,x2,y2,ms]} | {"pick":"photo.jpg"}] }   (pick offers a synthetic photo)
// Coordinates are in the fixed 1080x2160@480 screen. Only "m" taps are gated.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";

const LIMIT_MS = 150;
const SCREEN = "1080x2160@480";
const BASE = process.env.WEBDROID_URL ?? "http://localhost:4090";
const SCENARIOS = join(import.meta.dir, "scenarios");

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? false : (args.splice(i, 1), true); };
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const gpu = flag("--gpu"), warm = flag("--warm"), jsonOut = option("--json");
const names = args.length ? args : readdirSync(SCENARIOS).filter((f) => f.endsWith(".json")).map((f) => basename(f, ".json"));

/** the wd.perf counters a tap's breakdown reports, as deltas from pointerup to the response */
const COUNTERS = ["inputMs", "compileMs", "classesCompiled", "clinitMs", "resParseMs", "coldCalls", "layoutMs", "drawMs", "frameMs", "presentations"];

type Tap = { m: string; afterUp: number | null; first: number | null; settled: number | null; frames: number; perf: Record<string, number> };

const inPage = (steps: unknown, counters: string[]) => `(${async function run(steps: any[], counters: string[]) {
  const w = globalThis as any;
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
  while (!(w.wd && w.wd.perf.draws > 0)) await sleep(50);
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
  await idle();
  const screen = () => document.getElementById("screen") as HTMLCanvasElement;
  const ev = (type: string, x: number, y: number) => {
    const c = screen(), r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent(type, { clientX: r.left + x * r.width / 1080, clientY: r.top + y * r.height / 2160, pointerId: 1, isPrimary: true, bubbles: true, pointerType: "touch" }));
  };
  const out: Record<string, unknown>[] = [];
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
    const [x, y] = s.tap;
    const base = sig(screen());
    if (s.m) frames = [];
    const t0 = performance.now();
    ev("pointerdown", x, y);
    await sleep(s.hold ?? 60);
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
    out.push({ m: s.m, afterUp: au === undefined ? null : Math.round(au.t - tu), first: changes.length ? Math.round(changes[0].t - t0) : null,
      settled: changes.length ? Math.round(changes.at(-1)!.t - t0) : null, frames: got.length,
      perf: Object.fromEntries(counters.map((k) => [k, Math.round((after[k] - before[k]) * 10) / 10])) });
    await idle();
  }
  document.title = "DONE:" + JSON.stringify(out);
}})(${JSON.stringify(steps)}, ${JSON.stringify(counters)}).catch((e) => { document.title = "DONE:ERROR " + e; });`;

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
  if (!port) throw new Error("Chrome did not open a debugging port");
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

async function launch(send: Awaited<ReturnType<typeof openBrowser>>["send"], apk: string, steps: unknown): Promise<Tap[]> {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `if (location.pathname === "/") addEventListener("DOMContentLoaded", () => { ${inPage(steps, COUNTERS)} });` }, sessionId);
  await send("Page.navigate", { url: `${BASE}/?apk=${encodeURIComponent(apk)}&screen=${encodeURIComponent(SCREEN)}` }, sessionId);
  try {
    for (const deadline = Date.now() + 600_000; Date.now() < deadline;) {
      await Bun.sleep(500);
      const { targetInfo } = await send("Target.getTargetInfo", { targetId });
      if (!targetInfo.title.startsWith("DONE:")) continue;
      const body = targetInfo.title.slice(5);
      if (body.startsWith("ERROR")) throw new Error(body);
      return JSON.parse(body);
    }
    throw new Error("scenario timed out");
  } finally { await send("Target.closeTarget", { targetId }); }
}

const report: { scenario: string; taps: Tap[] }[] = [];
let failed = false;
for (const name of names) {
  const { apk, steps } = JSON.parse(readFileSync(join(SCENARIOS, name + ".json"), "utf8"));
  const profile = mkdtempSync(join(tmpdir(), "wdlat-"));
  const browser = await openBrowser(profile);
  try {
    if (warm) await launch(browser.send, apk, steps);
    const taps = await launch(browser.send, apk, steps);
    report.push({ scenario: name, taps });
    for (const t of taps) {
      const over = t.afterUp === null || t.afterUp > LIMIT_MS;
      failed ||= over;
      const detail = Object.entries(t.perf).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
      console.log(`${over ? "FAIL" : "ok  "} ${name.padEnd(12)} ${t.m.padEnd(14)} ${String(t.afterUp ?? "none").padStart(5)} ms  ${detail}`);
    }
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  } finally {
    browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(report, null, 1));
console.log(failed ? `latency gate FAILED: a gated tap exceeded ${LIMIT_MS} ms or never responded` : `latency gate passed: every gated tap within ${LIMIT_MS} ms`);
process.exit(failed ? 1 : 0);
