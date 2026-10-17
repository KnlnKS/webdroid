// Actual pass — drives webdroid through the probe and replays the recorded steps.
// No Android/adb dependency: this must run with the emulator off and no SDK installed.
// The entry point is run.ts; this module only captures.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ENV_SCREEN, WebdroidDriver } from "./drivers/webdroid.ts";
import { E2E_DIR, readJson } from "./lib/util.ts";
import { PINNED_CLOCK_MS, evidenceOf, flowSchemaHash, isMotionWait, screenOf, screenParam, uiFileFor, type ExecutionFlow, type ExecutionStep, type Flow, type Manifest, type WaitPolicy } from "./types.ts";
import { parseScreen } from "../../src/shell/config.ts";
import type { Act, Hang, Settled, StepResult } from "./lib/probe.ts";
import { readProcesses, type ProcessSnapshot } from "./lib/processes.ts";

export type StepRun = {
  id: string; index: number; file: string;
  /** for a tapText step, whether wd.locateText found its target (false: an optional target was absent and skipped) */
  semanticHit?: boolean;
  /** which tier of the settle contract ended the step, and how long it took */
  settled: Settled["how"];
  settleMs: number;
  /** what kept the fast path waiting, as poll counts per reason */
  busy?: Record<string, number>;
  settleTimedOut: boolean;
  /** webdroid's main-looper queue stopped draining — the app is hung, not merely idle. */
  mainLoopWedged: boolean;
  hang?: Hang;
  /** Distinct frames recorded during the step when --shots is on. 1 means nothing moved. */
  frames?: number;
  /** Framework APIs this step was the first to ask for and not find. The dev loop's work list. */
  newMissing?: string[];
  /** placeholder methods (`stubs`/`noops`) this step was the first to reach; callers are in `processes` */
  newPlaceholders?: string[];
  /** Native libraries this step was the first to need as machine code ("libx.so (abi)"). */
  nativeRequired?: string[];
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
  frameHash?: string;
  presentation?: number;
  evidence?: "semantic" | "visual" | "motion";
  phases?: StepResult["phases"] & { hostWriteMs: number };
};

type CaptureMode = "full" | "fast";
/** What `actual/<flow>/run.json` holds: the steps plus how the run was driven. */
export type FlowRun = { mode: CaptureMode; flowSchemaHash: string; jobs: number; screen: string; statusBarDp: number; steps: StepRun[]; browserErrors?: string[]; hostFiles?: { path: string; size: number }[]; aborted?: { step: string; error: string } };
export class CaptureAborted extends Error {
  readonly runs: StepRun[];
  constructor(cause: unknown, runs: StepRun[]) { super(String(cause), { cause }); this.runs = runs; }
}

/** Wipe the frame-recorder directory. Call once per run, before any flow. */
export async function prepareShots(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  console.log(`--shots: recording webdroid frames to ${dir}/ (cleared)`);
}

/** The recorded goldens, or undefined for a flow that has none (a smoke run: not scored). */
export async function loadManifest(app: string): Promise<Manifest | undefined> {
  const path = `${E2E_DIR}golden/${app}/manifest.json`;
  return existsSync(path) ? readJson(path) : undefined;
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
export function launchFor(flow: Flow, manifest: Manifest | undefined, shots = false, controlled = false): Promise<WebdroidDriver> {
  return WebdroidDriver.launch({
    screen: { ...screenOf(manifest, flow.screen), ...parseScreen(ENV_SCREEN) },
    fixedMs: flow.clock === "live" ? null : PINNED_CLOCK_MS,
    storage: flow.seedPrefs ? [prefsStorage(flow.pkg, flow.seedPrefs)] : [],
    privateStorage: flow.privateStorage,
    shots,
    controlled,
    // the reproducible gate does not depend on what the network serves (Mihon's update check)
    offline: flow.clock !== "live",
  });
}

/** The probe action for a step. */
export function actOf(flow: Flow, step: ExecutionStep): Act {
  const a = step.action;
  switch (a.type) {
    case "launch": return { type: "boot", apk: flow.apk };
    case "tapText": return { type: "tapText", text: a.text, required: !a.optional };
    case "tapAt": return { type: "tap", x: a.x, y: a.y, repeat: a.repeat, everyMs: a.everyMs, whileText: a.whileText, appearMs: a.appearMs, quietMs: a.quietMs, unlessResource: a.unlessResource };
    case "typeInto": return { type: "type", x: a.x, y: a.y, text: a.text };
    case "back": return { type: "back", whileText: a.whileText, appearMs: a.appearMs };
    case "enter": return { type: "enter" };
    case "background": return { type: "background", ms: a.ms ?? 1000 };
    case "swipe": return { type: "swipe", from: a.from, to: a.to, ms: a.ms ?? 400, untilText: a.untilText, maxSwipes: a.maxSwipes, whileText: a.whileText, appearMs: a.appearMs };
    case "settle": return { type: "none" };
  }
}

/** Perform one step and settle it on the step's horizon. */
export function runStep(drv: WebdroidDriver, flow: Flow, step: ExecutionStep, mode: CaptureMode = "full"): Promise<StepResult> {
  const evidence = evidenceOf(step);
  const capture = mode === "full" || evidence.kind !== "semantic";
  // Controlled gestures need their virtual horizon to finish flings before the next input.
  const policy: WaitPolicy = mode === "fast" && flow.clock !== "controlled" && evidence.kind === "semantic" && step.wait.kind === "quiescent" && step.action.type !== "launch"
    ? { ...step.wait, maxVirtualMs: 0 }
    : step.wait;
  const quiescence = mode === "fast" && evidence.kind === "semantic"
    ? { stableMs: 50, intervalMs: 50, stableFrames: 2 }
    : undefined;
  return drv.step(actOf(flow, step), {
    wait: policy,
    capture,
    timing: mode === "fast" && flow.clock === "controlled" ? "controlled" : "real",
    quiescence,
  });
}

export async function captureFlow(flow: ExecutionFlow, drv: WebdroidDriver, {
  jobs = 1, shots, log = console.log, mode = "full",
}: { jobs?: number; shots?: string; log?: (s: string) => void; mode?: CaptureMode } = {}): Promise<{ runs: StepRun[]; errors: string[] }> {
  const manifest = await loadManifest(flow.app);
  if (!manifest) log(`  no goldens for ${flow.app} — smoke run (rendered/wedged/missing/perf; not scored)`);
  const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));

  const outDir = `${E2E_DIR}${mode === "fast" ? "actual-fast" : "actual"}/${flow.app}`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log(`=== webdroid: ${flow.app} (${flow.steps.length} steps) ===`);
  const runs: StepRun[] = [];
  const persist = (hostFiles?: FlowRun["hostFiles"], aborted?: FlowRun["aborted"]) => {
    const run: FlowRun = { mode, flowSchemaHash: flowSchemaHash([flow]), jobs, screen: screenParam(drv.screen), statusBarDp: drv.screen.statusBarDp, steps: runs, browserErrors: [...drv.errors], hostFiles, aborted };
    return writeFile(`${outDir}/run.json`, JSON.stringify(run, null, 2));
  };
  await persist();
  let executing = "";
  try {
    for (const [i, step] of flow.steps.entries()) {
      executing = step.id;
      const action = step.action;
      const rec = byId.get(step.id);
      if (!rec && manifest && manifest.depth !== "startup")
        throw new Error(`golden manifest has no step "${step.id}" — re-record ${flow.app}`);
      const file = rec?.file ?? `${String(i).padStart(2, "0")}-${step.id}.png`;
      const fastEvidence = evidenceOf(step);
      const evidence = mode === "full" ? "visual" : fastEvidence.kind;
      const r = await runStep(drv, flow, step, mode);
      const stepMs = Math.round(r.ms);
      const fps = r.ms ? (r.perf.frames ?? 0) * 1000 / r.ms : 0;
      // the launch step's window is mostly boot + lazy compilation, not the app's frame loop; and
      // a frame rate measured beside other flows' browsers measures the host, not the app
      const motion = mode === "fast" ? fastEvidence.kind === "motion" : isMotionWait(step.wait);
      const slow = !!(motion && action.type !== "launch" && flow.minFps && fps < flow.minFps && jobs === 1);
      const writeAt = performance.now();
      if (r.png) {
        await writeFile(`${outDir}/${file}`, Buffer.from(r.png, "base64"));
      }
      await writeFile(`${outDir}/${uiFileFor(file)}`, JSON.stringify(r.uiTree));
      if (shots && r.frames.length) {
        const dir = `${shots}/${flow.app}/${String(i).padStart(2, "0")}-${step.id}`;
        await mkdir(dir, { recursive: true });
        await Promise.all(r.frames.map((f, n) => writeFile(`${dir}/f${String(n).padStart(3, "0")}.png`, Buffer.from(f, "base64"))));
      }
      const hostWriteMs = performance.now() - writeAt;
      const frames = r.frames.length || undefined;
      runs.push({ id: step.id, index: i, file, semanticHit: r.semanticHit, settled: r.settled.how, settleMs: Math.round(r.settled.ms),
                  busy: Object.keys(r.settled.busy).length ? r.settled.busy : undefined,
                  settleTimedOut: r.settled.how === "timeout", mainLoopWedged: r.wedged, hang: r.hang, frames,
                  ms: stepMs, perf: r.perf, fps: motion ? Math.round(fps) : undefined,
                  glFps: motion && r.ms ? (r.perf.glFrames ?? 0) * 1000 / r.ms : undefined,
                  presentFps: motion && r.ms && r.perf.presentations !== undefined ? r.perf.presentations * 1000 / r.ms : undefined,
                  slow: slow || undefined,
                  newMissing: r.newMissing.length ? r.newMissing : undefined,
                  newPlaceholders: r.newPlaceholders.length ? r.newPlaceholders : undefined,
                  nativeRequired: r.nativeRequired.length ? r.nativeRequired : undefined,
                  newErrors: r.newErrors.length ? r.newErrors : undefined, web: r.web.length ? r.web : undefined, error: r.error,
                  processes: await readProcesses(drv.page), frameHash: r.frameHash ?? undefined,
                  presentation: r.presentation, evidence, phases: { ...r.phases, hostWriteMs } });
      await persist();
      const p = r.perf;
      const flags = [
        r.semanticHit === false ? "skipped" : "",
        r.settled.how === "timeout" ? `settle timeout (${Object.keys(r.settled.busy).join(" ")})` : r.settled.how === "pixels" ? "pixels" : "",
        r.wedged ? "MAIN LOOP WEDGED" : "",
        r.hang ? `HANG in ${r.hang.phase}` : "",
        frames ? `${frames} frame${frames === 1 ? "" : "s"}` : "",
        `${stepMs}ms`,
        motion ? `${fps.toFixed(0)}fps${jobs > 1 ? ` (${jobs} jobs)` : ""}` : "",
        p.glFrames ? `${p.glFrames} gl` : "",
        slow ? "SLOW" : "",
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
    // Persist the per-step run flags next to the frames so `pnpm e2e --diff` can apply the same
    // scoring rules as `pnpm e2e --full` — without this, a standalone diff has no idea the app hung
    // and would quietly report a better number for the same pixels.
    const hostFiles = flow.privateStorage ? await drv.page.evaluate(async () => {
      const scan = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<{ path: string; size: number }[]> => {
        const files: { path: string; size: number }[] = [];
        for await (const [name, handle] of dir.entries()) {
          const path = prefix + name;
          if (handle.kind === "directory") files.push(...await scan(handle as FileSystemDirectoryHandle, path + "/"));
          else files.push({ path, size: (await (handle as FileSystemFileHandle).getFile()).size });
        }
        return files;
      };
      return scan(await navigator.storage.getDirectory(), "");
    }) : undefined;
    await persist(hostFiles);
    const missingFiles = (flow.privateStorage?.expectedFiles ?? []).filter((expected) => !hostFiles?.some(({ path, size }) =>
      path.startsWith(expected.pathPrefix) && path.endsWith(expected.suffix) && size >= expected.minBytes))
      .map((expected) => `missing host file ${expected.pathPrefix}*${expected.suffix} (${expected.minBytes} bytes)`);
    return { runs, errors: missingFiles };
  } catch (cause) {
    await persist(undefined, { step: executing, error: String(cause) });
    throw new CaptureAborted(cause, runs);
  }
}
