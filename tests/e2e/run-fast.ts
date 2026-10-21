import { diagnostics } from "./lib/diagnostics.ts";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, CaptureAborted, type StepRun } from "./capture-webdroid.ts";
import { defaultJobs, parseArgs } from "./lib/args.ts";
import { FLOWS } from "./flows/index.ts";
import type { Flow } from "./types.ts";
import { loadPng } from "./lib/png.ts";
import { diffImages } from "./lib/diff.ts";
import { E2E_DIR, readJson } from "./lib/util.ts";
import { runQueue } from "../../scripts/util.ts";
import { executionFlow, sameScreen, screenOf, screenParam, waitHorizonMs, type CaptureScreen, type Manifest } from "./types.ts";

// Live flows depend on upstream content and networks, so they join the lane only when named or
// with --live; the default lane is reproducible from the repository and local APKs alone.
const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const live = process.argv.includes("--live");
const args = process.argv.slice(2).filter((arg) => arg !== "--live");
const { flows, jobs } = parseArgs(args, "pnpm e2e", { defaultJobs: defaultJobs(5, 2), unnamed: live ? FLOWS : deterministic });

type VisualCheck = { step: string; contentDiffPct: number; maxContentDiffPct: number; androidSdk: string };
type Checked = { flow: Flow; runs: StepRun[]; visual: VisualCheck[]; errors: string[]; gaps: string[] };
type Outcome = Checked & { ms: number };

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
    if (!existsSync(goldenPath)) { errors.push(`${step.id}: golden image is missing`); continue; }
    if (!existsSync(actualPath)) { errors.push(`${step.id}: fast capture is missing`); continue; }
    const golden = await loadPng(goldenPath);
    const actual = await loadPng(actualPath);
    const diff = diffImages(golden, actual, manifest.crop, step.maskRects ?? []).contentDiffPct;
    results.push({ step: step.id, contentDiffPct: diff, maxContentDiffPct: evidence.maxContentDiffPct, androidSdk: manifest.device.sdk });
    if (diff > evidence.maxContentDiffPct)
      errors.push(`${step.id}: visual diff ${diff.toFixed(2)}% exceeds retained ${evidence.maxContentDiffPct.toFixed(2)}% limit`);
  }
  return { checks: results, errors };
}

/** One flow's outcome; an exception is that flow's failure, never the lane's. */
async function runFlow(flow: Flow): Promise<Outcome> {
  const started = performance.now();
  const checked = await checkFlow(flow).catch((error: unknown): Checked => {
    const runs = error instanceof CaptureAborted ? error.runs : [];
    const observed = runs.length ? diagnostics(executionFlow(flow, "fast"), runs) : { errors: [], gaps: [] };
    return { flow, runs, visual: [], errors: [...observed.errors, `flow aborted: ${String(error).split("\n", 1)[0]}`], gaps: observed.gaps };
  });
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
  const observed = diagnostics(selected, runs, driver.errors);
  return { flow, runs, visual: visual.checks, errors: [...captureErrors, ...observed.errors, ...visual.errors], gaps: observed.gaps };
}

console.log(`fast flows: ${flows.map((flow) => flow.app).join(", ")} (${jobs} at a time)`);
const summaryPath = `${E2E_DIR}actual-fast/summary.json`;
const previous = new Map<string, number>();
try {
  const data: unknown = await readJson(summaryPath);
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
await mkdir(`${E2E_DIR}actual-fast`, { recursive: true });
await writeFile(summaryPath, JSON.stringify({
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
