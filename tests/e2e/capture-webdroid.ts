// Actual pass — drives webdroid through the probe and replays the recorded steps.
// No Android/adb dependency: this must run with the emulator off and no SDK installed.
// The entry point is run.ts; this module only captures.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ENV_CORES, ENV_SCREEN, WebdroidDriver } from "./drivers/webdroid.ts";
import { E2E_DIR, readJson } from "./lib/util.ts";
import { PINNED_CLOCK_MS, evidenceOf, flowSchemaHash, isMotionWait, sameScreen, screenOf, screenParam, uiFileFor, type ExecutionFlow, type ExecutionStep, type Flow, type Manifest, type RecordedStep, type WaitPolicy } from "./types.ts";
import { parseScreen } from "../../src/shell/config.ts";
import type { Act, Hang, Settled, StepResult } from "./lib/probe.ts";
import type { ProcessSnapshot } from "./lib/processes.ts";
import { readProcesses } from "../../scripts/page.ts";

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

/** What `actual/<flow>/run.json` holds: the steps plus how the run was driven; `scored`, every step was captured to compare with the goldens;
 *  `alone`, no other flow ran beside it. */
export type FlowRun = { scored: boolean; flowSchemaHash: string; alone: boolean; screen: string; statusBarDp: number; steps: StepRun[]; browserErrors?: string[]; hostFiles?: { path: string; size: number }[]; aborted?: { step: string; error: string } };
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

/** A browser prepared for one flow: the goldens' geometry (unless the run is pinned elsewhere
 *  to measure cost), the flow's clock, and its seed prefs already in its data, at the path the emulator pass writes them to. */
export function launchFor(flow: Flow, manifest: Manifest | undefined, { shots = false, cores = ENV_CORES }: { shots?: boolean; cores?: number } = {}): Promise<WebdroidDriver> {
  return WebdroidDriver.launch({
    screen: { ...screenOf(manifest, flow.screen), ...parseScreen(ENV_SCREEN) },
    fixedMs: flow.clock === "live" ? null : PINNED_CLOCK_MS,
    files: flow.seedPrefs ? [[`/data/data/${flow.pkg}/shared_prefs/${flow.pkg}_preferences.xml`, flow.seedPrefs]] : [],
    privateStorage: flow.privateStorage,
    shots,
    controlled: flow.clock === "controlled",
    // the reproducible gate does not depend on what the network serves (Mihon's update check)
    offline: flow.clock !== "live",
    cores,
  });
}

/** The probe action for a step. */
function actOf(flow: Flow, step: ExecutionStep): Act {
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

/** Perform one step and settle it: a `scored` step on its horizon as the reference waited, and on a controlled clock past the `reference` step's
 *  dwell; a step that only reaches its checkpoint settles as soon as the screen is still. */
export function runStep(drv: WebdroidDriver, flow: Flow, step: ExecutionStep, { scored = true, reference }: { scored?: boolean; reference?: RecordedStep } = {}): Promise<StepResult> {
  const evidence = evidenceOf(step), quick = !scored && evidence.kind === "semantic";
  // Controlled gestures need their virtual horizon to finish flings before the next input.
  const policy: WaitPolicy = quick && flow.clock !== "controlled" && step.wait.kind === "quiescent" && step.action.type !== "launch"
    ? { ...step.wait, maxVirtualMs: 0 }
    : step.wait;
  return drv.step(actOf(flow, step), {
    wait: policy,
    capture: !quick,
    timing: flow.clock === "controlled" ? "controlled" : "real",
    quiescence: quick ? { stableMs: 50, intervalMs: 50, stableFrames: 2 } : undefined,
    dwellMs: reference?.dwellMs,
  });
}

/** `flow`'s steps in `drv`, into actual/<flow>: every step of a flow with goldens at this geometry is captured to be scored, else only the steps
 *  whose evidence is visual or motion */
export async function captureFlow(flow: ExecutionFlow, drv: WebdroidDriver, {
  alone = true, shots, log = console.log,
}: { alone?: boolean; shots?: string; log?: (s: string) => void } = {}): Promise<{ runs: StepRun[]; errors: string[]; scored: boolean }> {
  const manifest = await loadManifest(flow.app);
  const scored = !!manifest && manifest.depth !== "startup" && sameScreen(drv.screen, screenOf(manifest));
  const byId = new Map((manifest?.steps ?? []).map((s) => [s.id, s]));

  const outDir = `${E2E_DIR}actual/${flow.app}`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log(`=== webdroid: ${flow.app} (${flow.steps.length} steps${scored ? "" : ", not scored"}) ===`);
  const runs: StepRun[] = [];
  const persist = (hostFiles?: FlowRun["hostFiles"], aborted?: FlowRun["aborted"]) => {
    const run: FlowRun = { scored, flowSchemaHash: flowSchemaHash([flow]), alone, screen: screenParam(drv.screen), statusBarDp: drv.screen.statusBarDp, steps: runs, browserErrors: [...drv.errors], hostFiles, aborted };
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
      const evidence = evidenceOf(step).kind;
      const r = await runStep(drv, flow, step, { scored, reference: scored ? rec : undefined });
      const stepMs = Math.round(r.ms);
      const fps = r.ms ? (r.perf.frames ?? 0) * 1000 / r.ms : 0;
      // the launch step's window is mostly boot + lazy compilation, not the app's frame loop; and
      // a frame rate measured beside other flows' browsers measures the host, not the app
      const motion = evidence === "motion" || isMotionWait(step.wait);
      const slow = !!(motion && action.type !== "launch" && flow.minFps && fps < flow.minFps && alone);
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
        motion ? `${fps.toFixed(0)}fps${alone ? "" : " (beside other flows)"}` : "",
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
    // scoring rules as the run — without this, a standalone diff has no idea the app hung
    // and would quietly report a better number for the same pixels.
    const hostFiles = flow.privateStorage ? await drv.page.evaluate(async () => {
      const scan = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<{ path: string; size: number }[]> => {
        const files: { path: string; size: number }[] = [];
        for await (const [name, handle] of dir.entries()) {
          const path = prefix + name;
          if (handle.kind === "directory") files.push(...await scan(handle as FileSystemDirectoryHandle, path + "/"));
          // the app may still be writing: a file listed here (a journal, say) can be gone by its read
          else try { files.push({ path, size: (await (handle as FileSystemFileHandle).getFile()).size }); }
          catch (e) { if ((e as DOMException).name !== "NotFoundError") throw e; }
        }
        return files;
      };
      return scan(await navigator.storage.getDirectory(), "");
    }) : undefined;
    await persist(hostFiles);
    const missingFiles = (flow.privateStorage?.expectedFiles ?? []).filter((expected) => !hostFiles?.some(({ path, size }) =>
      path.startsWith(expected.pathPrefix) && path.endsWith(expected.suffix) && size >= expected.minBytes))
      .map((expected) => `missing host file ${expected.pathPrefix}*${expected.suffix} (${expected.minBytes} bytes)`);
    return { runs, errors: missingFiles, scored };
  } catch (cause) {
    await persist(undefined, { step: executing, error: String(cause) });
    throw new CaptureAborted(cause, runs);
  }
}
