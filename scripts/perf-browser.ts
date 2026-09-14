// Serialized browser measurements without screenshot readbacks in the timed window.
// bun scripts/perf-browser.ts --flow flappybird --after play --exercise flaps --out /tmp/flappy.json
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { FLOWS } from "../tests/e2e/flows";
import { actOf, loadManifest, prefsStorage } from "../tests/e2e/capture-webdroid";
import { CONTEXT_OPTS, launchBrowser } from "../tests/e2e/drivers/webdroid";
import { environmentScript, performAction } from "../tests/e2e/lib/actions";
import { probeScript } from "../tests/e2e/lib/probe";
import { PINNED_CLOCK_MS, screenOf, screenParam } from "../tests/e2e/types";

const { values } = parseArgs({ options: {
  flow: { type: "string" }, after: { type: "string" }, exercise: { type: "string" },
  url: { type: "string", default: process.env.WEBDROID_URL ?? "http://localhost:4080" },
  out: { type: "string" }, gpu: { type: "string", default: "software" }, probe: { type: "boolean", default: false },
  ms: { type: "string", default: "15000" }, warmup: { type: "string", default: "3000" },
} });
const flow = FLOWS.find((f) => f.app === values.flow);
if (!flow || !values.after || !values.out) throw new Error("Required: --flow <flow> --after <step> --out <file.json>");
const after = flow.steps.findIndex((s) => s.id === values.after);
const exercises = (values.exercise?.split(",") ?? []).map((id) => {
  const step = flow.steps.find((s) => s.id === id);
  if (!step) throw new Error("Unknown exercise step: " + id);
  return step;
});
if (after < 0) throw new Error("Unknown setup step");
const gpu = values.gpu;
if (gpu !== "software" && gpu !== "hardware") throw new Error("--gpu must be software or hardware");
const ms = Number(values.ms), warmup = Number(values.warmup);
if (!(ms > 0 && ms <= 60000 && warmup >= 0 && warmup <= 60000)) throw new Error("Invalid measurement duration");
const manifest = await loadManifest(flow.app);
const screen = screenOf(manifest, flow.screen);
const browser = await launchBrowser(gpu);
try {
  const context = await browser.newContext(CONTEXT_OPTS);
  const cfg = { fixedMs: flow.liveClock ? null : PINNED_CLOCK_MS,
    storage: flow.seedPrefs ? [prefsStorage(flow.pkg, flow.seedPrefs)] : [], shots: false };
  await context.addInitScript({ content: values.probe ? probeScript(cfg) : environmentScript(cfg) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${m.location().url}: ${m.text()}`); });
  const browserSession = await browser.newBrowserCDPSession();
  const gpuInfo = await browserSession.send("SystemInfo.getInfo");
  const url = new URL(values.url);
  url.searchParams.set("screen", screenParam(screen));
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!globalThis.wd);
  await page.evaluate(() => document.fonts.ready);
  const setup: unknown[] = [];
  for (const step of flow.steps.slice(0, after + 1)) {
    const rec = manifest?.steps.find((s) => s.id === step.id);
    const started = performance.now();
    const hit = await page.evaluate(performAction, { a: actOf(flow, step, rec), screen, deadlineMs: 60000 });
    const actionMs = performance.now() - started;
    await page.waitForTimeout(step.settleDelayMs ?? 500);
    setup.push({ step: step.id, ms: performance.now() - started, actionMs, hit });
  }
  await page.waitForTimeout(warmup);
  let foreground: ReturnType<typeof page.mainFrame> | undefined;
  for (const frame of page.frames()) {
    if (await frame.evaluate((pkg) => {
      const owner = window.frameElement;
      return globalThis.wd?.app()?.host.pkg === pkg && !document.hidden && (!owner || owner.getClientRects().length > 0);
    }, flow.pkg).catch(() => false)) {
      foreground = frame;
      break;
    }
  }
  if (!foreground) throw new Error("No visible application realm found");
  if (!await foreground.evaluate(() => !!globalThis.wd.perf && !!globalThis.wd.mainDbg)) throw new Error("Foreground realm lacks performance diagnostics");
  const session = await context.newCDPSession(foreground);
  await session.send("Performance.enable");
  await session.send("HeapProfiler.collectGarbage");
  const before = await session.send("Performance.getMetrics");
  const heapBefore = await session.send("Runtime.getHeapUsage");
  const actions = exercises.map((exercise) => actOf(flow, exercise, manifest?.steps.find((s) => s.id === exercise.id)));
  // Repeated tap steps define one tap per interval; do not nest their original repeat loop.
  for (const action of actions) if (action.type === "tap") action.repeat = 1;
  const measurement = foreground.evaluate(async ({ ms, actions, screen, actionSource }) => {
    const act: typeof performAction = (0, eval)(`(${actionSource})`);
    const wd = globalThis.wd;
    const capacity = 8192;
    const raf = new Float64Array(capacity), presents = new Float64Array(capacity), inputPresent = new Float64Array(capacity);
    let nr = 0, np = 0, ni = 0, inputs = 0, hidden = document.hidden, queued = 0, depth = 0;
    let lastRaf = performance.now(), lastPresent = lastRaf, awaitingInput = 0, running = true;
    const phases: Record<string, number> = {};
    const raw = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
    const canvas = document.getElementById("screen");
    ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap) {
      const result = raw.call(this, bitmap);
      if (this.canvas === canvas) {
        const now = performance.now();
        if (np < capacity) presents[np] = now - lastPresent;
        np++; lastPresent = now;
        if (awaitingInput) { if (ni < capacity) inputPresent[ni++] = now - awaitingInput; awaitingInput = 0; }
      }
      return result;
    };
    const sample = () => {
      const now = performance.now();
      if (nr < capacity) raf[nr] = now - lastRaf;
      nr++; lastRaf = now;
      hidden ||= document.hidden;
      queued = Math.max(queued, wd.mainDbg.queued); depth = Math.max(depth, wd.mainDbg.depth);
      const phase = wd.mainDbg.phase;
      phases[phase] = (phases[phase] ?? 0) + 1;
      if (running) rafId = requestAnimationFrame(sample);
    };
    let rafId = requestAnimationFrame(sample);
    const start: Record<string, number> = { ...wd.perf };
    const ticks = wd.ticks, t0 = performance.now();
    let acting = false;
    const actionErrors: string[] = [];
    const firstAction = actions[0];
    const timer = !firstAction ? undefined : setInterval(() => {
      if (acting) return;
      const action = actions[inputs % actions.length];
      acting = true; inputs++; awaitingInput = performance.now();
      void act({ a: action, screen, deadlineMs: 5000 }).catch((e) => actionErrors.push(String(e))).finally(() => { acting = false; });
    }, firstAction.type === "tap" ? firstAction.everyMs ?? 600 : 1000);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const elapsed = performance.now() - t0;
    const end: Record<string, number> = { ...wd.perf };
    running = false; cancelAnimationFrame(rafId); clearInterval(timer);
    ImageBitmapRenderingContext.prototype.transferFromImageBitmap = raw;
    const perf = Object.fromEntries(Object.entries(end).map(([k, v]) => [k, v - (start[k] ?? 0)]));
    return { ms: elapsed, perf, ticks: wd.ticks - ticks, hidden, queued, depth, phases, inputs, actionErrors,
      rafCount: nr, presentCount: np, droppedSamples: Math.max(0, nr - capacity) + Math.max(0, np - capacity),
      rafIntervals: Array.from(raf.subarray(0, Math.min(nr, capacity))),
      presentIntervals: Array.from(presents.subarray(0, Math.min(np, capacity))),
      inputToNextPresentProxy: Array.from(inputPresent.subarray(0, ni)),
      app: wd.app()?.host.pkg, 
    };
  }, { ms, actions, screen, actionSource: performAction.toString() });
  const result = await measurement;
  const afterMetrics = await session.send("Performance.getMetrics");
  await session.send("HeapProfiler.collectGarbage");
  const heapAfter = await session.send("Runtime.getHeapUsage");
  const metrics = Object.fromEntries(afterMetrics.metrics.map(({ name, value }) => [name, value - (before.metrics.find((m) => m.name === name)?.value ?? 0)]));
  const alive = await foreground.evaluate(() => globalThis.wd.alive());
  const tree = await foreground.evaluate(() => globalThis.wd.tree());
  const processes = await Promise.all(page.frames().map(async (frame) => ({ url: frame.url(),
    diagnostics: await frame.evaluate(() => {
      const wd = globalThis.wd;
      return wd ? { pkg: wd.app()?.host.pkg, ticks: wd.ticks, missing: [...wd.rt.missing], native: [...wd.rt.nativeRequired],
        errors: wd.logs?.filter((l: string) => /^(error:|window.error:|unhandledrejection:)/.test(l)), perf: wd.perf ? { ...wd.perf } : null } : null;
    }).catch((e) => ({ failure: String(e) })),
  })));
  await mkdir(dirname(values.out), { recursive: true });
  await page.screenshot({ path: values.out.replace(/\.json$/, "") + ".png" });
  const output = { flow: flow.app, after: values.after, exercise: values.exercise, url: url.href, browser: browser.version(),
    gpu, gpuInfo: gpuInfo.gpu, probe: values.probe, screen, warmup, setup, result, alive, tree, metrics, heapBefore, heapAfter, processes, errors };
  await Bun.write(values.out, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: values.out, glFps: result.perf.glFrames * 1000 / result.ms,
    presentFps: result.presentCount * 1000 / result.ms, ticks: result.ticks, hidden: result.hidden, alive, errors }));
} finally { await browser.close(); }
