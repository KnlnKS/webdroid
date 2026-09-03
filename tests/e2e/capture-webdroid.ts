// Actual pass — drives webdroid through Playwright and replays the recorded steps.
// No Android/adb dependency: this must run with the emulator off and no SDK installed.
// The entry point is run.ts; this module only captures.
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { WebdroidDriver } from "./drivers/webdroid";
import { E2E_DIR, sleep } from "./lib/util";
import { PINNED_CLOCK_MS, type Flow, type Manifest, type RecordedStep, type Step } from "./types";

export type StepRun = {
  id: string; index: number; file: string;
  /** true when wd.tapText found the target itself; false when we fell back to the recorded
   *  coordinate. A fallback is a finding in its own right — webdroid's view tree lacked it. */
  semanticHit?: boolean;
  settleTimedOut: boolean;
  /** webdroid's main-looper queue stopped draining — the app is hung, not merely idle. */
  mainLoopWedged: boolean;
  /** Distinct frames recorded during the step when --shots is on. 1 means nothing moved. */
  frames?: number;
  /** Framework APIs this step was the first to ask for and not find. The dev loop's work list. */
  newMissing?: string[];
  /** Native libraries this step was the first to need as machine code ("libx.so (abi)"). */
  nativeRequired?: string[];
  /** framework attributes this step was the first to use and find unread */
  unreadAttrs?: string[];
  /** Wall-clock ms this step took to settle, and the perf counters it burned getting there. */
  ms?: number;
  perf?: Record<string, number>;
  /** Shell frames per second over the step — the number that matters for an animated step. */
  fps?: number;
  slow?: boolean;
  /** Uncaught throwables and frame-phase errors this step was the first to log. */
  newErrors?: string[];
  /** WebView frames on screen at the end of the step — the only evidence a page loaded. */
  web?: { url: string | null; title: string; loaded: boolean }[];
  error?: string;
};

/** Wipe the frame-recorder directory. Call once per run, before any flow. */
export async function prepareShots(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  console.log(`--shots: recording webdroid frames to ${dir}/ (cleared)`);
}

/**
 * Perform one step's action and its dwell. Returns whether a tapText found its target in
 * webdroid's own view tree (undefined for every other action).
 */
export async function applyStep(drv: WebdroidDriver, flow: Flow, step: Step, rec?: RecordedStep): Promise<boolean | undefined> {
  const a = step.action;
  let semanticHit: boolean | undefined;
  switch (a.type) {
    case "launch": await drv.boot(flow.apk); break;
    case "tapText":
      semanticHit = await drv.tapText(a.text);
      if (!semanticHit && rec?.resolved) await drv.tapNorm(rec.resolved.x, rec.resolved.y);
      break;
    case "tapAt":
      for (let i = 0; i < (a.repeat ?? 1); i++) {
        if (i) await sleep(a.everyMs ?? 500);
        await drv.tapNorm(a.x, a.y);
      }
      break;
    case "typeInto": await drv.tapNorm(a.x, a.y); await sleep(250); await drv.type(a.text); break;
    case "back": await drv.back(); break;
    case "swipe": await drv.swipe(a.from, a.to, a.ms ?? 400); break;
    case "settle": break;
  }
  if (step.settleDelayMs) await sleep(step.settleDelayMs);
  return semanticHit;
}

/** An animated step is captured once after its dwell; everything else waits for stability. */
export const settleStep = (drv: WebdroidDriver, step: Step) => step.animated ? drv.snapshot() : drv.settle();

/** The recorded goldens, or undefined for a flow that has none (a smoke run: not scored). */
export async function loadManifest(app: string): Promise<Manifest | undefined> {
  const path = `${E2E_DIR}golden/${app}/manifest.json`;
  return existsSync(path) ? Bun.file(path).json() : undefined;
}

export async function captureFlow(flow: Flow, drv: WebdroidDriver): Promise<StepRun[]> {
  const manifest = await loadManifest(flow.app);
  if (!manifest) console.log(`  no goldens for ${flow.app} — smoke run (rendered/wedged/missing/perf; not scored)`);
  const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));

  const outDir = `${E2E_DIR}actual/${flow.app}`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`\n=== webdroid: ${flow.app} (${flow.steps.length} steps) ===`);
  await drv.setClock(flow.liveClock ? Date.now() : PINNED_CLOCK_MS);
  await drv.reset();
  if (flow.seedPrefs) await drv.seedPrefs(flow.pkg, flow.seedPrefs);

  const runs: StepRun[] = [];
  let seenMissing = new Set(await drv.missing());
  let seenNative = new Set(await drv.nativeRequired());
  let seenAttrs = new Set(await drv.unreadAttrs());
  const errorLines = async () => (await drv.logs()).filter((l) => l.startsWith("error:"));
  let seenErrors = new Set(await errorLines());
  for (const [i, step] of flow.steps.entries()) {
    const rec = byId.get(step.id);
    if (!rec && manifest) throw new Error(`golden manifest has no step "${step.id}" — re-record ${flow.app}`);
    const file = rec?.file ?? `${String(i).padStart(2, "0")}-${step.id}.png`;
    // Start recording BEFORE the action so the frames cover the transition, not just the end.
    await drv.beginStep(flow.app, i, step.id);
    await drv.perfReset();
    const tStep = Date.now();
    let semanticHit: boolean | undefined;
    let error: string | undefined;
    try {
      semanticHit = await applyStep(drv, flow, step, rec);
    } catch (e) {
      // A step that throws must not abort the run: the remaining steps still capture whatever
      // is on screen, so the report shows exactly where webdroid stopped tracking the flow.
      error = String((e as Error)?.message ?? e).slice(0, 300);
    }

    const { png, timedOut, wedged } = await settleStep(drv, step);
    const frames = await drv.endStep();
    const stepMs = Date.now() - tStep;
    const stepPerf = await drv.perf();
    const all = await drv.missing();
    const newMissing = all.filter((m) => !seenMissing.has(m));
    seenMissing = new Set(all);
    const native = await drv.nativeRequired();
    const newNative = native.filter((n) => !seenNative.has(n));
    seenNative = new Set(native);
    const attrs = await drv.unreadAttrs();
    const newAttrs = attrs.filter((a) => !seenAttrs.has(a));
    seenAttrs = new Set(attrs);
    const errs = await errorLines();
    const newErrors = errs.filter((e) => !seenErrors.has(e));
    seenErrors = new Set(errs);
    const web = (await drv.web()).map(({ url, title, loaded }) => ({ url, title, loaded }));
    const fps = stepMs ? (stepPerf.frames ?? 0) * 1000 / stepMs : 0;
    // the launch step's window is mostly boot + lazy compilation, not the app's frame loop
    const slow = !!(step.animated && step.action.type !== "launch" && flow.minFps && fps < flow.minFps);
    await Bun.write(`${outDir}/${file}`, png);
    runs.push({ id: step.id, index: i, file, semanticHit, settleTimedOut: timedOut,
                mainLoopWedged: wedged, frames: frames || undefined,
                ms: stepMs, perf: stepPerf, fps: step.animated ? Math.round(fps) : undefined, slow: slow || undefined,
                newMissing: newMissing.length ? newMissing : undefined,
                nativeRequired: newNative.length ? newNative : undefined,
                unreadAttrs: newAttrs.length ? newAttrs : undefined,
                newErrors: newErrors.length ? newErrors : undefined, web: web.length ? web : undefined, error });
    const flags = [
      semanticHit === false ? "coord-fallback" : "",
      timedOut ? "settle timeout" : "",
      wedged ? "MAIN LOOP WEDGED" : "",
      frames ? `${frames} frame${frames === 1 ? "" : "s"}` : "",
      `${stepMs}ms`,
      step.animated ? `${fps.toFixed(0)}fps` : "",
      stepPerf.glFrames ? `${stepPerf.glFrames} gl/${Math.round(stepPerf.glFrameMs)}ms${stepPerf.glSkipped ? " skipped " + stepPerf.glSkipped : ""}` : "",
      slow ? "SLOW" : "",
      stepPerf.layoutPasses ? `${stepPerf.layoutPasses} layout/${Math.round(stepPerf.layoutMs)}ms` : "",
      stepPerf.draws ? `${stepPerf.draws} draw/${Math.round(stepPerf.drawMs)}ms` : "",
      stepPerf.measureText ? `${stepPerf.measureText} measureText` : "",
      stepPerf.rnReplay ? `${stepPerf.rnReplay} rnOps` : "",
      ...web.map((w) => `web: ${w.loaded ? "loaded" : "loading"} ${w.url}`),
      error ? `error: ${error}` : "",
    ].filter(Boolean).join(", ");
    console.log(`  ${String(i).padStart(2, "0")} ${step.label}${flags ? "  [" + flags + "]" : ""}`);
    for (const m of newMissing) console.log(`       missing: ${m}`);
    for (const n of newNative) console.log(`       native code required: ${n}`);
    for (const e of newErrors) console.log(`       ${e.slice(0, 200)}`);
  }
  // Persist the per-step run flags next to the frames so `bun run e2e:diff` can apply the same
  // scoring rules as `bun run e2e` — without this, a standalone diff has no idea the app hung
  // and would quietly report a better number for the same pixels.
  await Bun.write(`${outDir}/run.json`, JSON.stringify(runs, null, 2));
  return runs;
}
