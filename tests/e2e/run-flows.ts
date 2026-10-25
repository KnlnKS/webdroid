// pnpm e2e: each flow once, in a browser of its own. Its checkpoints, its diagnostics and its steps' visual or motion evidence gate it; a flow
// with goldens at its geometry is captured whole and scored against them as soon as it has run. Never starts or needs an Android emulator.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, prepareShots, CaptureAborted, type StepRun } from "./capture-webdroid.ts";
import { FLOWS } from "./flows/index.ts";
import { diagnostics } from "./lib/diagnostics.ts";
import { diffImages } from "./lib/diff.ts";
import { loadPng } from "./lib/png.ts";
import type { FlowReport } from "./lib/report.ts";
import { E2E_DIR } from "./lib/util.ts";
import { assembleReport, scoreFlow } from "./score.ts";
import { executionFlow, sameScreen, screenOf, screenParam, waitHorizonMs, type CaptureScreen, type Flow, type Manifest } from "./types.ts";
import { runQueue, timings } from "../../scripts/util.ts";

type VisualCheck = { step: string; contentDiffPct: number; maxContentDiffPct: number; androidSdk: string };
/** a flow's steps, visual checks, failures and observed gaps, its score against the goldens when it has them, and how long it took */
export type Outcome = { flow: Flow; runs: StepRun[]; visual: VisualCheck[]; errors: string[]; gaps: string[]; report?: FlowReport; ms: number };

/** each visual-evidence step's content diff against its limit: the flow's score's when it was scored, else diffed here */
async function visualEvidence(flow: Flow, manifest: Manifest | undefined, screen: CaptureScreen, report?: FlowReport): Promise<{ checks: VisualCheck[]; errors: string[] }> {
  const checks = flow.steps.filter((step) => step.evidence?.kind === "visual");
  if (!checks.length) return { checks: [], errors: [] };
  if (!manifest) return { checks: [], errors: ["visual evidence requires a golden manifest"] };
  const reference = screenOf(manifest);
  if (!sameScreen(screen, reference))
    return { checks: [], errors: [`visual evidence requires Android reference geometry ${screenParam(reference)} with ${reference.statusBarDp}dp status inset; captured ${screenParam(screen)} with ${screen.statusBarDp}dp`] };
  const errors: string[] = [];
  const results: VisualCheck[] = [];
  for (const step of checks) {
    const evidence = step.evidence;
    if (evidence?.kind !== "visual") continue;
    const recorded = manifest.steps.find((item) => item.id === step.id);
    if (!recorded) { errors.push(`${step.id}: golden manifest has no matching step`); continue; }
    let diff = report?.steps.find((item) => item.id === step.id)?.rawContentDiffPct;
    if (diff === undefined) {
      const goldenPath = `${E2E_DIR}golden/${flow.app}/${recorded.file}`;
      const actualPath = `${E2E_DIR}actual/${flow.app}/${recorded.file}`;
      if (!existsSync(goldenPath)) { errors.push(`${step.id}: golden image is missing`); continue; }
      if (!existsSync(actualPath)) { errors.push(`${step.id}: capture is missing`); continue; }
      diff = diffImages(await loadPng(goldenPath), await loadPng(actualPath), manifest.crop, step.maskRects ?? []).contentDiffPct;
    }
    results.push({ step: step.id, contentDiffPct: diff, maxContentDiffPct: evidence.maxContentDiffPct, androidSdk: manifest.device.sdk });
    if (diff > evidence.maxContentDiffPct)
      errors.push(`${step.id}: visual diff ${diff.toFixed(2)}% exceeds retained ${evidence.maxContentDiffPct.toFixed(2)}% limit`);
  }
  return { checks: results, errors };
}

const pct = (n: number) => `${n.toFixed(2)}%`;

/** how a flow runs: whether no other flow runs beside it, the cores its page sees, where its frames go and where its line is logged */
type FlowOptions = { alone?: boolean; cores?: number; shots?: string; log?: (line: string) => void };

/** One flow's outcome, its line given to `log`; an exception is that flow's failure, never the run's. */
export async function runFlow(flow: Flow, { log = console.log, ...options }: FlowOptions = {}): Promise<Outcome> {
  const started = performance.now(), selected = executionFlow(flow, "webdroid");
  const checked = await checkFlow(flow, options).catch((error: unknown): Omit<Outcome, "ms"> => {
    const runs = error instanceof CaptureAborted ? error.runs : [];
    const observed = runs.length ? diagnostics(selected, runs) : { errors: [], gaps: [] };
    return { flow, runs, visual: [], errors: [...observed.errors, `flow aborted: ${String(error).split("\n", 1)[0]}`], gaps: observed.gaps };
  });
  const outcome = { ...checked, ms: performance.now() - started };
  log(`  ${flow.app}: ${outcome.runs.length} steps, ${(outcome.ms / 1000).toFixed(1)}s` +
    (outcome.report ? `, content ${pct(outcome.report.meanContentDiffPct)}` : "") +
    (outcome.errors.length ? `, ${outcome.errors.length} failure(s)` : "") +
    (outcome.gaps.length ? `, ${outcome.gaps.length} observed gap(s)` : ""));
  return outcome;
}

async function checkFlow(flow: Flow, { alone, cores, shots }: FlowOptions): Promise<Omit<Outcome, "ms">> {
  const selected = executionFlow(flow, "webdroid");
  const manifest = await loadManifest(flow.app);
  const driver = await launchFor(flow, manifest, { shots: !!shots, cores });
  let captured: Awaited<ReturnType<typeof captureFlow>>;
  try {
    captured = await captureFlow(selected, driver, { alone, shots, log: () => {} });
  } finally {
    await driver.close();
  }
  const errors = [...captured.errors];
  const report = captured.scored ? await scoreFlow(flow.app).catch((error: unknown) => { errors.push(String((error as Error)?.message ?? error)); return undefined; }) : undefined;
  const visual = await visualEvidence(selected, manifest, driver.screen, report);
  const observed = diagnostics(selected, captured.runs, driver.errors);
  errors.push(...observed.errors, ...visual.errors);
  return { flow, runs: captured.runs, visual: visual.checks, errors, gaps: observed.gaps, report };
}

const SUMMARY = `${E2E_DIR}actual/summary.json`;
/** the seconds a flow takes until a run has timed it: what its steps' waits add up to */
export const flowEstimate = (flow: Flow): number => executionFlow(flow, "webdroid").steps.reduce((total, step) =>
  total + (step.wait.kind === "state" ? step.wait.maxRealMs : waitHorizonMs(step.wait)) + 300, 0) / 1000;

/** `flows`, `jobs` at a time (each step's distinct frames into `shots`); exits 1 when one fails */
export async function runFlows(flows: Flow[], jobs: number, shots?: string): Promise<void> {
  console.log(`flows: ${flows.map((flow) => flow.app).join(", ")} (${jobs} at a time)`);
  if (shots) await prepareShots(shots);
  const times = timings("e2e-times"), started = performance.now();
  await rm(SUMMARY, { force: true });
  const outcomes = await runQueue(flows, jobs, (flow) => times.weight(flow.app, flowEstimate(flow)), async (flow) => {
    const outcome = await runFlow(flow, { alone: jobs === 1, shots });
    times.record(flow.app, outcome.ms / 1000);
    return outcome;
  });
  times.save();
  console.log(`\n${await summarize(outcomes, performance.now() - started)}`);
  if (outcomes.some((item) => item.errors.length)) process.exit(1);
}

/** prints each failure of `outcomes`, which took `ms`, writes actual/summary.json and the report of the scored ones: the lines that sum them up */
export async function summarize(outcomes: Outcome[], ms: number): Promise<string> {
  for (const outcome of outcomes.filter((item) => item.errors.length)) {
    console.error(`\n${outcome.flow.app} failed:`);
    for (const error of outcome.errors) console.error(`  ${error}`);
  }
  const failed = outcomes.filter((item) => item.errors.length).length;
  const status = (outcome: Outcome) => outcome.errors.length ? "failed" : outcome.report ? "scored" : outcome.visual.length ? "compared" : outcome.flow.clock === "live" ? "observed" : "smoke";
  await mkdir(`${E2E_DIR}actual`, { recursive: true });
  await writeFile(SUMMARY, JSON.stringify({
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(ms),
    flows: FLOWS.map((flow) => {
      const outcome = outcomes.find((item) => item.flow.app === flow.app);
      return outcome
        ? { app: flow.app, status: status(outcome), steps: outcome.runs.length, durationMs: Math.round(outcome.ms), contentDiffPct: outcome.report?.meanContentDiffPct,
            visual: outcome.visual, errors: outcome.errors, gaps: outcome.gaps }
        : { app: flow.app, status: "not-selected" };
    }),
  }, null, 2));
  const reports = outcomes.flatMap((item) => item.report ? [item.report] : []);
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(status(outcome), (counts.get(status(outcome)) ?? 0) + 1);
  const gaps = outcomes.reduce((count, item) => count + item.gaps.length, 0);
  const lines = reports.map((r) => `  ${r.app.padEnd(18)} content ${pct(r.meanContentDiffPct).padStart(7)}   strict ${pct(r.meanStrictPct).padStart(7)}   ` +
    `tolerant ${pct(r.meanTolerantPct).padStart(7)}   rendered ${r.stepsRendered}/${r.steps.length}${r.wedgedAtStep !== undefined ? `   WEDGED at step ${String(r.wedgedAtStep).padStart(2, "0")}` : ""}`);
  if (reports.length) lines.push(`  ${"mean".padEnd(18)} content ${pct(reports.reduce((a, r) => a + r.meanContentDiffPct, 0) / reports.length).padStart(7)}   (${await assembleReport(reports)})`);
  return [...lines, `${outcomes.length - failed}/${outcomes.length} flows reached their checkpoints in ${(ms / 1000).toFixed(1)}s (` +
    [...counts].map(([key, n]) => `${n} ${key}`).join(", ") + `, ${gaps} reported gaps; actual/summary.json)`].join("\n");
}
