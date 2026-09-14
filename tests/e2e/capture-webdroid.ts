// Actual pass — drives webdroid through the probe and replays the recorded steps.
// No Android/adb dependency: this must run with the emulator off and no SDK installed.
// The entry point is run.ts; this module only captures.
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ENV_SCREEN, WebdroidDriver } from "./drivers/webdroid";
import { E2E_DIR } from "./lib/util";
import { PINNED_CLOCK_MS, screenOf, uiFileFor, type Flow, type Manifest, type RecordedStep, type Step } from "./types";
import { parseScreen } from "../../src/shell/config";
import type { Act, Settled, StepResult } from "./lib/probe";
import { readProcesses, type ProcessSnapshot } from "./lib/processes";

export type StepRun = {
  id: string; index: number; file: string;
  /** true when wd.tapText found the target itself; false when it did not. */
  semanticHit?: boolean;
  /** which tier of the settle contract ended the step, and how long it took */
  settled: Settled["how"];
  settleMs: number;
  /** what kept the fast path waiting, as poll counts per reason */
  busy?: Record<string, number>;
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
  /** Shell ticks per second over the step; not completed GL frames or presentations. */
  fps?: number;
  glFps?: number;
  presentFps?: number;
  slow?: boolean;
  /** Uncaught throwables and frame-phase errors this step was the first to log. */
  newErrors?: string[];
  /** WebView frames on screen at the end of the step — the only evidence a page loaded. */
  web?: { url: string | null; title: string; loaded: boolean }[];
  error?: string;
  processes?: ProcessSnapshot[];
};

/** What `actual/<flow>/run.json` holds: the steps plus how the run was driven. */
export type FlowRun = { jobs: number; screen: string; steps: StepRun[]; browserErrors?: string[] };

/** Wipe the frame-recorder directory. Call once per run, before any flow. */
export async function prepareShots(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  console.log(`--shots: recording webdroid frames to ${dir}/ (cleared)`);
}

/** The recorded goldens, or undefined for a flow that has none (a smoke run: not scored). */
export async function loadManifest(app: string): Promise<Manifest | undefined> {
  const path = `${E2E_DIR}golden/${app}/manifest.json`;
  return existsSync(path) ? Bun.file(path).json() : undefined;
}

/**
 * A flow's seed prefs in webdroid's own store, so the two passes start on the same screen. The
 * flow carries the Android shared_prefs XML the emulator writes as a file; webdroid keeps prefs
 * as JSON under `wd:prefs:<pkg>:<name>` (see JSharedPrefs.persist), so parse rather than
 * duplicate the data in a second format.
 */
export function prefsStorage(pkg: string, xml: string): [string, string] {
  const map: Record<string, unknown> = {};
  for (const m of xml.matchAll(/<(string|boolean|int|long|float)\s+name="([^"]+)"(?:\s+value="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const [, kind, name, attr, text] = m;
    map[name] = kind === "string" ? (text ?? "")
      : kind === "boolean" ? attr === "true"
      : kind === "long" ? { $l: attr }
      : Number(attr);
  }
  return [`wd:prefs:${pkg}:${pkg}_preferences`, JSON.stringify(map)];
}

/** A browser prepared for one flow: the goldens' geometry (unless the run is pinned elsewhere
 *  to measure cost), the flow's clock, and its seed prefs already in storage. */
export function launchFor(flow: Flow, manifest: Manifest | undefined, shots = false): Promise<WebdroidDriver> {
  return WebdroidDriver.launch({
    screen: parseScreen(ENV_SCREEN) ?? screenOf(manifest, flow.screen),
    fixedMs: flow.liveClock ? null : PINNED_CLOCK_MS,
    storage: flow.seedPrefs ? [prefsStorage(flow.pkg, flow.seedPrefs)] : [],
    shots,
  });
}

/** The probe action for a step, with the recorded coordinate as the tapText fallback. */
export function actOf(flow: Flow, step: Step, rec?: RecordedStep): Act {
  const a = step.action;
  switch (a.type) {
    case "launch": return { type: "boot", apk: flow.apk };
    case "tapText": return { type: "tapText", text: a.text, fallback: a.optional ? undefined : rec?.resolved };
    case "tapAt": return { type: "tap", x: a.x, y: a.y, repeat: a.repeat, everyMs: a.everyMs };
    case "typeInto": return { type: "type", x: a.x, y: a.y, text: a.text };
    case "back": return { type: "back" };
    case "enter": return { type: "enter" };
    case "background": return { type: "background", ms: a.ms ?? 1000 };
    case "swipe": return { type: "swipe", from: a.from, to: a.to, ms: a.ms ?? 400, untilText: a.untilText, maxSwipes: a.maxSwipes };
    case "settle": return { type: "none" };
  }
}

/** Perform one step and settle it on the step's horizon. */
export function runStep(drv: WebdroidDriver, flow: Flow, step: Step, rec?: RecordedStep): Promise<StepResult> {
  return drv.step(actOf(flow, step, rec), { horizonMs: step.settleDelayMs ?? 0, animated: !!step.animated });
}

export async function captureFlow(flow: Flow, drv: WebdroidDriver, { jobs = 1, shots, log = console.log }: { jobs?: number; shots?: string; log?: (s: string) => void } = {}): Promise<StepRun[]> {
  const manifest = await loadManifest(flow.app);
  if (!manifest) log(`  no goldens for ${flow.app} — smoke run (rendered/wedged/missing/perf; not scored)`);
  const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));

  const outDir = `${E2E_DIR}actual/${flow.app}`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log(`=== webdroid: ${flow.app} (${flow.steps.length} steps) ===`);
  const runs: StepRun[] = [];
  for (const [i, step] of flow.steps.entries()) {
    const rec = byId.get(step.id);
    if (!rec && manifest) throw new Error(`golden manifest has no step "${step.id}" — re-record ${flow.app}`);
    const file = rec?.file ?? `${String(i).padStart(2, "0")}-${step.id}.png`;
    const r = await runStep(drv, flow, step, rec);
    const stepMs = Math.round(r.ms);
    const fps = r.ms ? (r.perf.frames ?? 0) * 1000 / r.ms : 0;
    // the launch step's window is mostly boot + lazy compilation, not the app's frame loop; and
    // a frame rate measured beside other flows' browsers measures the host, not the app
    const slow = !!(step.animated && step.action.type !== "launch" && flow.minFps && fps < flow.minFps && jobs === 1);
    await Bun.write(`${outDir}/${file}`, Buffer.from(r.png, "base64"));
    // the structural half of the comparison; score.ts reads it back off disk like the png
    await Bun.write(`${outDir}/${uiFileFor(file)}`, JSON.stringify(r.uiTree));
    if (shots && r.frames.length) {
      const dir = `${shots}/${flow.app}/${String(i).padStart(2, "0")}-${step.id}`;
      await mkdir(dir, { recursive: true });
      await Promise.all(r.frames.map((f, n) => Bun.write(`${dir}/f${String(n).padStart(3, "0")}.png`, Buffer.from(f, "base64"))));
    }
    const frames = r.frames.length || undefined;
    runs.push({ id: step.id, index: i, file, semanticHit: r.semanticHit, settled: r.settled.how, settleMs: Math.round(r.settled.ms),
                busy: Object.keys(r.settled.busy).length ? r.settled.busy : undefined,
                settleTimedOut: r.settled.how === "timeout", mainLoopWedged: r.wedged, frames,
                ms: stepMs, perf: r.perf, fps: step.animated ? Math.round(fps) : undefined,
                glFps: step.animated && r.ms ? (r.perf.glFrames ?? 0) * 1000 / r.ms : undefined,
                presentFps: step.animated && r.ms && r.perf.presentations !== undefined ? r.perf.presentations * 1000 / r.ms : undefined,
                slow: slow || undefined,
                newMissing: r.newMissing.length ? r.newMissing : undefined,
                nativeRequired: r.nativeRequired.length ? r.nativeRequired : undefined,
                unreadAttrs: r.unreadAttrs.length ? r.unreadAttrs : undefined,
                newErrors: r.newErrors.length ? r.newErrors : undefined, web: r.web.length ? r.web : undefined, error: r.error,
                processes: await readProcesses(drv.page) });
    const p = r.perf;
    const flags = [
      r.semanticHit === false && !(step.action.type === "tapText" && step.action.optional) ? "coord-fallback" : "",
      r.settled.how === "timeout" ? `settle timeout (${Object.keys(r.settled.busy).join(" ")})` : r.settled.how === "pixels" ? "pixels" : "",
      r.wedged ? "MAIN LOOP WEDGED" : "",
      frames ? `${frames} frame${frames === 1 ? "" : "s"}` : "",
      `${stepMs}ms`,
      step.animated ? `${fps.toFixed(0)}fps${jobs > 1 ? ` (${jobs} jobs)` : ""}` : "",
      p.glFrames ? `${p.glFrames} gl/${Math.round(p.glFrameMs)}ms${p.glSkipped ? " skipped " + p.glSkipped : ""}` : "",
      slow ? "SLOW" : "",
      p.layoutPasses ? `${p.layoutPasses} layout/${Math.round(p.layoutMs)}ms` : "",
      p.draws ? `${p.draws} draw/${Math.round(p.drawMs)}ms` : "",
      p.measureText ? `${p.measureText} measureText` : "",
      p.rnReplay ? `${p.rnReplay} rnOps` : "",
      ...r.web.map((w) => `web: ${w.loaded ? "loaded" : "loading"} ${w.url}`),
      r.error ? `error: ${r.error}` : "",
    ].filter(Boolean).join(", ");
    log(`  ${String(i).padStart(2, "0")} ${step.label}${flags ? "  [" + flags + "]" : ""}`);
    for (const m of r.newMissing) log(`       missing: ${m}`);
    for (const n of r.nativeRequired) log(`       native code required: ${n}`);
    for (const e of r.newErrors) log(`       ${e.slice(0, 200)}`);
  }
  // Persist the per-step run flags next to the frames so `bun run e2e:diff` can apply the same
  // scoring rules as `bun run e2e` — without this, a standalone diff has no idea the app hung
  // and would quietly report a better number for the same pixels.
  const run: FlowRun = { jobs, screen: `${drv.screen.width}x${drv.screen.height}@${drv.screen.densityDpi}`, steps: runs, browserErrors: [...drv.errors] };
  await Bun.write(`${outDir}/run.json`, JSON.stringify(run, null, 2));
  return runs;
}
