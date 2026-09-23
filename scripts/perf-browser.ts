// Serialized browser measurements without screenshot readbacks in the timed window.
// bun scripts/perf-browser.ts --flow flappybird --after play --exercise flaps --out /tmp/flappy.json
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { FLOWS } from "../tests/e2e/flows";
import { actOf, loadManifest, prefsStorage } from "../tests/e2e/capture-webdroid";
import { CONTEXT_OPTS, launchBrowser } from "../tests/e2e/drivers/webdroid";
import { environmentScript, performAction } from "../tests/e2e/lib/actions";
import { readProcesses } from "../tests/e2e/lib/processes";
import { probeScript } from "../tests/e2e/lib/probe";
import { PINNED_CLOCK_MS, screenOf, screenParam, waitHorizonMs } from "../tests/e2e/types";

const { values } = parseArgs({ options: {
  flow: { type: "string" }, after: { type: "string" }, exercise: { type: "string" },
  "input-offsets": { type: "string" }, "start-exercise": { type: "string" }, "state-reader": { type: "string" }, "start-state": { type: "string" },
  url: { type: "string", default: process.env.WEBDROID_URL ?? "http://localhost:4080" },
  out: { type: "string" }, gpu: { type: "string", default: "software" }, probe: { type: "boolean", default: false },
  ms: { type: "string", default: "15000" }, warmup: { type: "string", default: "3000" },
  "align-presentation": { type: "boolean", default: false },
  "cpu-profile": { type: "boolean", default: false },
  "native-profile": { type: "boolean", default: false },
  "jvm-profile": { type: "boolean", default: false }, "jvm-tier": { type: "string", default: "auto" }, "jvm-hotness": { type: "string", default: "4096" },
  interval: { type: "string" }, "exercise-once": { type: "boolean", default: false }, "setup-shots": { type: "boolean", default: false },
  "setup-settle-cap": { type: "string" },
} });
const flow = FLOWS.find((f) => f.app === values.flow);
if (!flow || !values.after || !values.out) throw new Error("Required: --flow <flow> --after <step> --out <file.json>");
const outParts = parse(values.out);
const artifactPath = (suffix: string) => join(outParts.dir, outParts.name + suffix);
const after = flow.steps.findIndex((s) => s.id === values.after);
const exercises = (values.exercise?.split(",") ?? []).map((id) => {
  const step = flow.steps.find((s) => s.id === id);
  if (!step) throw new Error("Unknown exercise step: " + id);
  return step;
});
if (after < 0) throw new Error("Unknown setup step");
const gpu = values.gpu;
if (gpu !== "software" && gpu !== "hardware") throw new Error("--gpu must be software or hardware");
if (!values["jvm-tier"] || !["auto", "cold", "js", "wasm"].includes(values["jvm-tier"])) throw new Error("--jvm-tier must be auto, cold, js or wasm");
if (!values["jvm-hotness"] || !["1024", "4096", "16384"].includes(values["jvm-hotness"])) throw new Error("--jvm-hotness must be 1024, 4096 or 16384");
const ms = Number(values.ms), warmup = Number(values.warmup);
const setupSettleCap = values["setup-settle-cap"] === undefined ? undefined : Number(values["setup-settle-cap"]);
if (setupSettleCap !== undefined && (!Number.isFinite(setupSettleCap) || setupSettleCap < 0 || setupSettleCap > 60000)) throw new Error("Invalid setup settle cap");
const interval = values.interval === undefined ? undefined : Number(values.interval);
if (interval !== undefined && !(interval > 0 && interval <= 60000)) throw new Error("Invalid input interval");
if (!(ms > 0 && ms <= 60000 && warmup >= 0 && warmup <= 60000)) throw new Error("Invalid measurement duration");
let inputOffsets: number[] | null = null;
if (values["input-offsets"]) {
  const raw: unknown = await Bun.file(values["input-offsets"]).json();
  if (!Array.isArray(raw)) throw new Error("Input offsets must be a JSON array");
  const parsed = raw.map((value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= ms) throw new Error("Input offsets must be finite and within [0, ms)");
    return value;
  });
  if (parsed.length > 8192 || parsed.some((value, i) => i > 0 && value <= parsed[i - 1])) throw new Error("Input offsets must strictly increase and contain at most 8192 entries");
  if (parsed.length && !exercises.length) throw new Error("Input offsets require an exercise");
  if (values["exercise-once"] && parsed.length > exercises.length) throw new Error("Too many offsets for exercise-once");
  if (interval !== undefined) throw new Error("Use either input-offsets or interval");
  inputOffsets = parsed;
}
const startStep = values["start-exercise"] ? flow.steps.find((step) => step.id === values["start-exercise"]) : undefined;
if (values["start-exercise"] && !startStep) throw new Error("Unknown start exercise");
const stateReader = values["state-reader"] ? await Bun.file(values["state-reader"]).text() : undefined;
const startState: unknown = values["start-state"] ? await Bun.file(values["start-state"]).json() : undefined;
if (startState !== undefined && (!stateReader || values["align-presentation"])) throw new Error("start-state requires state-reader and cannot align-presentation");
const manifest = await loadManifest(flow.app);
const screen = screenOf(manifest, flow.screen);
const browser = await launchBrowser(gpu);
try {
  const context = await browser.newContext(CONTEXT_OPTS);
  const cfg = { fixedMs: flow.clock === "live" ? null : PINNED_CLOCK_MS,
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
  if (values["jvm-profile"]) url.searchParams.set("jvmProfile", "1");
  if (values["jvm-tier"] !== "auto") url.searchParams.set("jvmTier", values["jvm-tier"]);
  if (values["jvm-hotness"] !== "4096") url.searchParams.set("jvmHotness", values["jvm-hotness"]);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!globalThis.wd);
  await page.evaluate(() => document.fonts.ready);
  const setup: unknown[] = [];
  if (values["setup-shots"]) await mkdir(dirname(values.out), { recursive: true });
  for (const step of flow.steps.slice(0, after + 1)) {
    const rec = manifest?.steps.find((s) => s.id === step.id);
    const started = performance.now();
    const hit = await page.evaluate(performAction, { a: actOf(flow, step, rec), screen, deadlineMs: 60000 });
    const actionMs = performance.now() - started;
    const horizonMs = waitHorizonMs(step.wait);
    await page.waitForTimeout(setupSettleCap === undefined ? horizonMs : Math.min(horizonMs, setupSettleCap));
    const setupMs = performance.now() - started;
    const perf = values["setup-shots"] ? await page.evaluate(() => ({ ...globalThis.wd.perf })) : undefined;
    setup.push({ step: step.id, ms: setupMs, actionMs, hit, ...(perf ? { perf } : {}) });
    if (values["setup-shots"]) await page.screenshot({ path: artifactPath(`-setup-${step.id}.png`) });
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
  if (startStep) {
    const a = actOf(flow, startStep, manifest?.steps.find((step) => step.id === startStep.id));
    if (a.type === "tap") a.repeat = 1;
    await foreground.evaluate(performAction, { a, screen, deadlineMs: 5000 });
    if (startState === undefined) await page.waitForTimeout(100);
  }
  const inspectedFrame = foreground;
  const readState = () => stateReader === undefined ? Promise.resolve(undefined) : inspectedFrame.evaluate(async (source) => {
    try {
      const read = (0, eval)(source);
      if (typeof read !== "function") throw new Error("State reader must evaluate to a function");
      return await read();
    } catch (error) { return { failure: String(error) }; }
  }, stateReader);
  const stateBefore = startState === undefined ? await readState() : undefined;
  const before = await session.send("Performance.getMetrics");
  const heapBefore = await session.send("Runtime.getHeapUsage");
  const actions = exercises.map((exercise) => actOf(flow, exercise, manifest?.steps.find((s) => s.id === exercise.id)));
  // Repeated tap steps define one tap per interval; do not nest their original repeat loop.
  for (const action of actions) if (action.type === "tap") action.repeat = 1;
  if (values["cpu-profile"]) {
    await session.send("Profiler.enable");
    await session.send("Profiler.start");
  }
  if (values["native-profile"]) await foreground.evaluate(() => globalThis.wd.native.profileReset());
  const measurement = foreground.evaluate(async ({ ms, actions, screen, actionSource, interval, once, offsets, alignPresentation, startState, stateReader }) => {
    const act: typeof performAction = (0, eval)(`(${actionSource})`);
    let matchedState: unknown, stateWaitMs = 0;
    if (startState !== undefined) {
      const read: unknown = (0, eval)(stateReader ?? "");
      if (typeof read !== "function") throw new Error("State reader must evaluate to a function");
      const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
        if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) throw new Error("State must contain only JSON values");
        return item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, Reflect.get(item, key)])) : item;
      });
      const sampleState = (): unknown => {
        const value: unknown = read();
        if (value && (typeof value === "object" || typeof value === "function") && typeof Reflect.get(value, "then") === "function") throw new Error("Start-state reader must be synchronous");
        return value;
      };
      const expected = canonical(startState), waiting = performance.now();
      await new Promise<void>((resolve, reject) => {
        let frame = 0;
        const cleanup = () => { cancelAnimationFrame(frame); clearTimeout(timeout); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error("Start state not reached within 3000ms")); }, 3000);
        const check = () => {
          try {
            const actual = canonical(sampleState());
            if (performance.now() - waiting >= 3000) throw new Error("Start state not reached within 3000ms");
            if (actual === expected) { cleanup(); resolve(); }
            else frame = requestAnimationFrame(check);
          } catch (error) { cleanup(); reject(error); }
        };
        check();
      });
      matchedState = sampleState();
      if (canonical(matchedState) !== expected) throw new Error("Start state changed before measurement could begin");
      stateWaitMs = performance.now() - waiting;
    }
    const wd = globalThis.wd;
    const capacity = 8192;
    const raf = new Float64Array(capacity), presents = new Float64Array(capacity), inputPresent = new Float64Array(capacity);
    let nr = 0, np = 0, ni = 0, inputs = 0, hidden = document.hidden, queued = 0, depth = 0;
    let lastRaf = performance.now(), lastPresent = lastRaf, awaitingInput = 0, running = true;
    const phases: Record<string, number> = {};
    const raw = ImageBitmapRenderingContext.prototype.transferFromImageBitmap;
    const canvas = document.getElementById("screen");
    let recording = !alignPresentation, anchorTime = 0;
    let anchorResolve: (() => void) | undefined;
    const anchorStarted = performance.now();
    const anchor = alignPresentation ? new Promise<void>((resolve) => { anchorResolve = resolve; }) : null;
    ImageBitmapRenderingContext.prototype.transferFromImageBitmap = function (bitmap) {
      const result = raw.call(this, bitmap);
      if (this.canvas === canvas) {
        if (!recording) {
          if (anchorResolve) {
            anchorTime = performance.now();
            const resolve = anchorResolve; anchorResolve = undefined;
            resolve();
          }
          return result;
        }
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
    let rafId = alignPresentation ? 0 : requestAnimationFrame(sample);
    if (anchor) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([anchor, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("No screen presentation within 3000ms")), 3000);
        })]);
      } catch (error) {
        running = false; anchorResolve = undefined;
        cancelAnimationFrame(rafId);
        ImageBitmapRenderingContext.prototype.transferFromImageBitmap = raw;
        throw error;
      } finally { clearTimeout(timeout); }
    }
    const start: Record<string, number> = { ...wd.perf };
    const ticks = wd.ticks, t0 = performance.now();
    recording = true;
    if (alignPresentation) {
      lastRaf = lastPresent = t0;
      hidden = document.hidden;
      rafId = requestAnimationFrame(sample);
    }
    let acting = false;
    const actionErrors: string[] = [];
    const firstAction = actions[0];
    const intervalMs = interval ?? (firstAction?.type === "tap" ? firstAction.everyMs ?? 600 : 1000);
    const availableInputs = firstAction ? Math.max(0, Math.ceil(ms / intervalMs) - 1) : 0;
    const plannedInputs = offsets !== null ? offsets.length : once ? Math.min(actions.length, availableInputs) : availableInputs;
    const issuedOffsets: number[] = [];
    const fire = (index: number) => {
      if (!running || inputs >= plannedInputs || performance.now() - t0 >= ms) return;
      if (acting) {
        if (offsets !== null) actionErrors.push(`Scheduled input ${index} skipped: previous action still in flight`);
        return;
      }
      const action = actions[index % actions.length];
      acting = true; inputs++; awaitingInput = performance.now(); issuedOffsets.push(awaitingInput - t0);
      void act({ a: action, screen, deadlineMs: 5000 }).catch((e) => actionErrors.push(String(e))).finally(() => { acting = false; });
    };
    const timer = !firstAction || offsets !== null ? undefined : setInterval(() => fire(inputs), intervalMs);
    const scheduled = offsets?.map((offset, index) => setTimeout(() => fire(index), offset)) ?? [];
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    const elapsed = performance.now() - t0;
    const end: Record<string, number> = { ...wd.perf };
    running = false; cancelAnimationFrame(rafId); clearInterval(timer); scheduled.forEach(clearTimeout);
    ImageBitmapRenderingContext.prototype.transferFromImageBitmap = raw;
    const perf = Object.fromEntries(Object.entries(end).map(([k, v]) => [k, v - (start[k] ?? 0)]));
    return { ms: elapsed, perf, ticks: wd.ticks - ticks, hidden, queued, depth, phases, inputs, plannedInputs, issuedOffsets, actionInFlight: acting, actionErrors,
      ...(startState !== undefined ? { stateBefore: matchedState, stateWaitMs } : {}),
      ...(alignPresentation ? { anchorWaitMs: t0 - anchorStarted, anchorToStartMs: t0 - anchorTime } : {}),
      rafCount: nr, presentCount: np, droppedSamples: Math.max(0, nr - capacity) + Math.max(0, np - capacity),
      rafIntervals: Array.from(raf.subarray(0, Math.min(nr, capacity))),
      presentIntervals: Array.from(presents.subarray(0, Math.min(np, capacity))),
      inputToNextPresentProxy: Array.from(inputPresent.subarray(0, ni)),
      app: wd.app()?.host.pkg, 
    };
  }, { ms, actions, screen, actionSource: performAction.toString(), interval, once: values["exercise-once"], offsets: inputOffsets, alignPresentation: values["align-presentation"], startState, stateReader });
  const result = await measurement;
  const cpuProfile = values["cpu-profile"] ? (await session.send("Profiler.stop")).profile : undefined;
  const nativeProfile = values["native-profile"] ? await foreground.evaluate(() => globalThis.wd.native.profile(50)) : undefined;
  const afterMetrics = await session.send("Performance.getMetrics");
  const stateAfter = await readState();
  await session.send("HeapProfiler.collectGarbage");
  const heapAfter = await session.send("Runtime.getHeapUsage");
  const metrics = Object.fromEntries(afterMetrics.metrics.map(({ name, value }) => [name, value - (before.metrics.find((m) => m.name === name)?.value ?? 0)]));
  const alive = await foreground.evaluate(() => globalThis.wd.alive());
  const tree = await foreground.evaluate(() => globalThis.wd.tree());
  const processes = await readProcesses(page);
  const jvmProfile = values["jvm-profile"] ? await foreground.evaluate(() => globalThis.wd.jvmProfile()) : undefined;
  await mkdir(dirname(values.out), { recursive: true });
  const cpuProfilePath = cpuProfile ? artifactPath(".cpuprofile") : undefined;
  if (cpuProfile && cpuProfilePath) await Bun.write(cpuProfilePath, JSON.stringify(cpuProfile));
  await page.screenshot({ path: artifactPath(".png") });
  const output = { flow: flow.app, after: values.after, exercise: values.exercise, url: url.href, browser: browser.version(),
    gpu, gpuInfo: gpuInfo.gpu, probe: values.probe, screen, warmup, setup, setupSettleCap, result, alive, tree, metrics, heapBefore, heapAfter, processes, errors,
    ...(jvmProfile ? { jvmProfile } : {}),
    ...(cpuProfilePath ? { cpuProfilePath } : {}), ...(nativeProfile ? { nativeProfile } : {}),
    stateBefore: startState === undefined ? stateBefore : result.stateBefore, stateAfter, inputOffsets, startExercise: values["start-exercise"], stateReader: values["state-reader"],
    ...(startState !== undefined ? { startState, stateWaitMs: result.stateWaitMs } : {}),
    ...(values["align-presentation"] ? { alignPresentation: true } : {}), ...(interval !== undefined ? { interval } : {}), ...(values["exercise-once"] ? { exerciseOnce: true } : {}) };
  await Bun.write(values.out, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: values.out, glFps: result.perf.glFrames * 1000 / result.ms,
    presentFps: result.presentCount * 1000 / result.ms, ticks: result.ticks, hidden: result.hidden, alive, errors }));
} finally { await browser.close(); }
