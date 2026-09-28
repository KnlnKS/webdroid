import { rm } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, type StepRun } from "./capture-webdroid";
import { defaultJobs, parseArgs } from "./lib/args";
import { FLOWS } from "./flows";
import type { Flow } from "./types";
import { loadPng } from "./lib/png";
import { diffImages } from "./lib/diff";
import { E2E_DIR, runQueue } from "./lib/util";
import { executionFlow, sameScreen, screenOf, screenParam, waitHorizonMs, type CaptureScreen, type Manifest } from "./types";

// Live flows depend on upstream content and networks, so they join the lane only when named or
// with --live; the default lane is reproducible from the repository and local APKs alone.
const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const live = process.argv.includes("--live");
const args = process.argv.slice(2).filter((arg) => arg !== "--live");
const { flows, jobs } = parseArgs(args, "bun run e2e", { defaultJobs: defaultJobs(5, 2), unnamed: live ? FLOWS : deterministic });

type VisualCheck = { step: string; contentDiffPct: number; maxContentDiffPct: number; androidSdk: string };
type Checked = { flow: Flow; runs: StepRun[]; visual: VisualCheck[]; errors: string[]; gaps: string[] };
type Outcome = Checked & { ms: number };

const expectedError = (flow: Flow, message: string) => (flow.expectedErrors ?? []).some((part) => message.includes(part));

function diagnostics(flow: Flow, runs: StepRun[]): { errors: string[]; gaps: string[] } {
  const errors: string[] = [];
  const gaps: string[] = [];
  const live = flow.clock === "live";
  const brief = (item: string) => item.split("\n", 1)[0]!.slice(0, 300);
  const seenProcessErrors = new Set<string>();
  for (const step of runs) {
    const prefix = `${String(step.index).padStart(2, "0")} ${step.id}`;
    const action = flow.steps[step.index]?.action;
    if (live && action?.type === "tapText" && !action.optional && step.semanticHit !== true)
      errors.push(`${prefix}: required text target ${JSON.stringify(action.text)} was not found`);
    if (step.mainLoopWedged) errors.push(`${prefix}: main loop wedged`);
    if (step.settleTimedOut) errors.push(`${prefix}: completion timed out`);
    if (step.error) errors.push(`${prefix}: ${brief(step.error)}`);
    if (step.evidence === "motion" && (step.perf?.presentations ?? 0) < 2) errors.push(`${prefix}: motion checkpoint presented no motion`);
    // a service lookup that got servicemanager's documented null is a boundary gap the app
    // handles, not a failure; it stays reported until a binder service answers for it
    for (const item of step.newMissing ?? []) (live || item.endsWith(" [binder]") ? gaps : errors).push(`${prefix}: missing ${item}`);
    for (const item of step.nativeRequired ?? []) (live ? gaps : errors).push(`${prefix}: native code required ${item}`);
    for (const item of step.newErrors ?? []) if (!expectedError(flow, item)) (live ? gaps : errors).push(`${prefix}: ${brief(item)}`);
    const processes = step.processes ?? [];
    if (!processes.length) errors.push(`${prefix}: no webdroid process diagnostics`);
    for (const process of processes) {
      const diagnostics = process.diagnostics;
      if (diagnostics.status !== "ok") {
        errors.push(`${prefix}: ${process.url} diagnostics ${diagnostics.status}`);
        continue;
      }
      for (const item of diagnostics.errors ?? []) {
        const key = `${process.url}:${item}`;
        if (seenProcessErrors.has(key)) continue;
        seenProcessErrors.add(key);
        if (!(step.newErrors ?? []).includes(item) && !expectedError(flow, item)) (live ? gaps : errors).push(`${prefix}: ${process.url}: ${brief(item)}`);
      }
    }
  }
  return { errors, gaps };
}

async function visualEvidence(flow: Flow, manifest: Manifest | undefined, screen: CaptureScreen): Promise<{ checks: VisualCheck[]; errors: string[] }> {
  const checks = flow.steps.filter((step) => step.fastEvidence?.kind === "visual");
  if (!checks.length) return { checks: [], errors: [] };
  if (!manifest) return { checks: [], errors: ["visual evidence requires a golden manifest"] };
  const reference = screenOf(manifest);
  if (!sameScreen(screen, reference))
    return { checks: [], errors: [`visual evidence requires Android reference geometry ${screenParam(reference)} with ${reference.statusBarDp}dp status inset; captured ${screenParam(screen)} with ${screen.statusBarDp}dp`] };
  const errors: string[] = [];
  const results: VisualCheck[] = [];
  for (const step of checks) {
    const evidence = step.fastEvidence;
    if (evidence?.kind !== "visual") continue;
    const recorded = manifest.steps.find((item) => item.id === step.id);
    if (!recorded) { errors.push(`${step.id}: golden manifest has no matching step`); continue; }
    const goldenPath = `${E2E_DIR}golden/${flow.app}/${recorded.file}`;
    const actualPath = `${E2E_DIR}actual-fast/${flow.app}/${recorded.file}`;
    if (!await Bun.file(goldenPath).exists()) { errors.push(`${step.id}: golden image is missing`); continue; }
    if (!await Bun.file(actualPath).exists()) { errors.push(`${step.id}: fast capture is missing`); continue; }
    const golden = await loadPng(goldenPath);
    const actual = await loadPng(actualPath);
    const diff = diffImages(golden, actual, manifest.crop, step.maskRects ?? []).contentDiffPct;
    results.push({ step: step.id, contentDiffPct: diff, maxContentDiffPct: evidence.maxContentDiffPct, androidSdk: manifest.device.sdk });
    if (diff > evidence.maxContentDiffPct)
      errors.push(`${step.id}: visual diff ${diff.toFixed(2)}% exceeds retained ${evidence.maxContentDiffPct.toFixed(2)}% limit`);
  }
  return { checks: results, errors };
}

function browserFailures(flow: Flow, errors: string[]): string[] {
  return errors.filter((error) => !expectedError(flow, URL.canParse(error) ? new URL(error).searchParams.get("msg") ?? error : error))
    .map((error) => `browser: ${error.slice(0, 300)}`);
}

/** One flow's outcome; an exception is that flow's failure, never the lane's. */
async function runFlow(flow: Flow): Promise<Outcome> {
  const started = performance.now();
  const checked = await checkFlow(flow).catch((error: unknown): Checked =>
    ({ flow, runs: [], visual: [], errors: [`flow aborted: ${String(error).split("\n", 1)[0]}`], gaps: [] }));
  const outcome = { ...checked, ms: performance.now() - started };
  console.log(`  ${flow.app}: ${outcome.runs.length} steps, ${(outcome.ms / 1000).toFixed(1)}s` +
    (outcome.errors.length ? `, ${outcome.errors.length} failure(s)` : "") +
    (outcome.gaps.length ? `, ${outcome.gaps.length} observed gap(s)` : ""));
  return outcome;
}

async function checkFlow(flow: Flow): Promise<Checked> {
  const selected = executionFlow(flow, "fast");
  const manifest = await loadManifest(flow.app);
  const driver = await launchFor(flow, manifest, false, flow.clock === "controlled");
  let runs: StepRun[] = [], captureErrors: string[] = [];
  try {
    ({ runs, errors: captureErrors } = await captureFlow(selected, driver, { jobs, mode: "fast", log: () => {} }));
  } finally {
    await driver.close();
  }
  const visual = await visualEvidence(selected, manifest, driver.screen);
  const observed = diagnostics(selected, runs);
  const browserErrors = browserFailures(flow, driver.errors);
  return { flow, runs, visual: visual.checks,
    errors: [...captureErrors, ...observed.errors, ...visual.errors, ...(flow.clock === "live" ? [] : browserErrors)],
    gaps: [...observed.gaps, ...(flow.clock === "live" ? browserErrors : [])] };
}

console.log(`fast flows: ${flows.map((flow) => flow.app).join(", ")} (${jobs} at a time)`);
const summaryPath = `${E2E_DIR}actual-fast/summary.json`;
const previous = new Map<string, number>();
try {
  const data: unknown = await Bun.file(summaryPath).json();
  if (data && typeof data === "object" && "flows" in data && Array.isArray(data.flows))
    for (const row of data.flows)
      if (row && typeof row.app === "string" && typeof row.durationMs === "number" && row.durationMs > 0)
        previous.set(row.app, row.durationMs);
} catch {}
await rm(summaryPath, { force: true });
const weight = (flow: Flow) => previous.get(flow.app) ?? executionFlow(flow, "fast").steps.reduce((total, step) =>
  total + (step.wait.kind === "state" ? step.wait.maxRealMs : waitHorizonMs(step.wait)) + 300, 0);
const started = performance.now();
const outcomes = await runQueue(flows, jobs, weight, runFlow);

for (const outcome of outcomes.filter((item) => item.errors.length)) {
  console.error(`\n${outcome.flow.app} failed:`);
  for (const error of outcome.errors) console.error(`  ${error}`);
}

const failed = outcomes.filter((item) => item.errors.length).length;
await Bun.write(`${E2E_DIR}actual-fast/summary.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  durationMs: Math.round(performance.now() - started),
  flows: FLOWS.map((flow) => {
    const outcome = outcomes.find((item) => item.flow.app === flow.app);
    return outcome
      ? { app: flow.app, status: outcome.errors.length ? "failed" : outcome.visual.length ? "compared" : flow.clock === "live" ? "observed" : "smoke",
          steps: outcome.runs.length, durationMs: Math.round(outcome.ms), visual: outcome.visual, errors: outcome.errors, gaps: outcome.gaps }
      : { app: flow.app, status: "not-selected" };
  }),
}, null, 2));
const compared = outcomes.filter((item) => item.visual.length).length;
const observed = outcomes.filter((item) => item.flow.clock === "live" && !item.visual.length).length;
const gaps = outcomes.reduce((count, item) => count + item.gaps.length, 0);
console.log(`\n${flows.length - failed}/${flows.length} fast flows reached their checkpoints in ${((performance.now() - started) / 1000).toFixed(1)}s` +
  ` (${compared} Android-compared, ${outcomes.length - compared - observed} smoke, ${observed} live observed, ${gaps} reported gaps; actual-fast/summary.json)`);
if (failed) process.exit(1);
