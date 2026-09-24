import { rm } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, type StepRun } from "./capture-webdroid";
import { defaultJobs, parseArgs } from "./lib/args";
import { FLOWS } from "./flows";
import type { Flow } from "./types";
import { loadPng } from "./lib/png";
import { diffImages } from "./lib/diff";
import { E2E_DIR } from "./lib/util";
import { apkHashes, flowSchemaHash, repositoryRevision, type CoverageIndex } from "./coverage";
import { screenOf, screenParam, wait, waitHorizonMs, type Manifest } from "./types";
import { BASE_URL } from "./lib/util";
import { isWebdroidProcessFrame } from "./lib/processes";

const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const coverage = process.argv.includes("--coverage");
const args = process.argv.slice(2).filter((arg) => arg !== "--coverage");
const { flows, jobs } = parseArgs(args, "bun run e2e", coverage ? deterministic : FLOWS, defaultJobs(5, 2));
if (coverage && flows.length !== deterministic.length)
  throw new Error("coverage collection must run the complete deterministic lane");

type VisualCheck = { step: string; contentDiffPct: number; maxContentDiffPct: number; androidSdk: string };
type Outcome = { flow: Flow; runs: StepRun[]; visual: VisualCheck[]; errors: string[]; gaps: string[]; ms: number; coverage: string[]; browser: string; screen: string };

function diagnostics(flow: Flow, runs: StepRun[]): { errors: string[]; gaps: string[] } {
  const errors: string[] = [];
  const gaps: string[] = [];
  const live = flow.clock === "live";
  const brief = (item: string) => item.split("\n", 1)[0]!.slice(0, 300);
  const seenProcessErrors = new Set<string>();
  for (const step of runs) {
    const prefix = `${String(step.index).padStart(2, "0")} ${step.id}`;
    const definition = flow.steps[step.index];
    const action = definition?.webdroidAction ?? definition?.action;
    if (live && action?.type === "tapText" && !action.optional && step.semanticHit !== true)
      errors.push(`${prefix}: required text target ${JSON.stringify(action.text)} was not found`);
    if (step.mainLoopWedged) errors.push(`${prefix}: main loop wedged`);
    if (step.settleTimedOut) errors.push(`${prefix}: completion timed out`);
    if (step.error) errors.push(`${prefix}: ${brief(step.error)}`);
    if (step.slow) errors.push(`${prefix}: motion fell below its retained frame-rate limit`);
    for (const item of step.newMissing ?? []) (live ? gaps : errors).push(`${prefix}: missing ${item}`);
    for (const item of step.nativeRequired ?? []) (live ? gaps : errors).push(`${prefix}: native code required ${item}`);
    for (const item of step.newErrors ?? []) (live ? gaps : errors).push(`${prefix}: ${brief(item)}`);
    const processes = (step.processes ?? []).filter((process) => isWebdroidProcessFrame(process.url, BASE_URL));
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
        if (!(step.newErrors ?? []).includes(item)) (live ? gaps : errors).push(`${prefix}: ${process.url}: ${brief(item)}`);
      }
    }
  }
  return { errors, gaps };
}

function quickFlow(flow: Flow): Flow {
  return flow.clock === "live"
    ? { ...flow, steps: flow.steps.map((step) => ({ ...step, action: step.fastAction ?? step.webdroidAction ?? step.action, webdroidAction: undefined, wait: step.fastWait ?? wait.liveSample(500) })) }
    : flow;
}

async function visualEvidence(flow: Flow, manifest: Manifest | undefined, screen: string): Promise<{ checks: VisualCheck[]; errors: string[] }> {
  const checks = flow.steps.filter((step) => step.fastEvidence?.kind === "visual");
  if (!checks.length) return { checks: [], errors: [] };
  if (!manifest) return { checks: [], errors: ["visual evidence requires a golden manifest"] };
  if (screen !== screenParam(screenOf(manifest)))
    return { checks: [], errors: [`visual evidence requires Android reference geometry ${screenParam(screenOf(manifest))}; captured ${screen}`] };
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
  const expected = flow.expectedBrowserErrors ?? [];
  return errors.filter((error) => {
    const message = URL.canParse(error) ? new URL(error).searchParams.get("msg") ?? error : error;
    return !expected.some((part) => message.includes(part));
  })
    .map((error) => `browser: ${error.slice(0, 300)}`);
}

async function runFlow(flow: Flow, effectiveJobs: number): Promise<Outcome> {
  const selected = quickFlow(flow);
  const manifest = await loadManifest(flow.app);
  const collectCoverage = coverage && flow.sourceCoverage !== "unsupported";
  const driver = await launchFor(flow, manifest, false, flow.clock === "controlled", collectCoverage);
  const started = performance.now();
  let runs: StepRun[] = [];
  let sourceCoverage: string[] = [];
  const browser = driver.browserVersion();
  const screen = screenParam(driver.screen);
  try {
    runs = await captureFlow(selected, driver, { jobs: effectiveJobs, mode: "fast", log: () => {} });
    sourceCoverage = collectCoverage ? await driver.takeSourceCoverage() : [];
  } finally {
    await driver.close();
  }
  const visual = await visualEvidence(selected, manifest, screen);
  const observed = diagnostics(selected, runs);
  const browserErrors = browserFailures(flow, driver.errors);
  return { flow, runs, visual: visual.checks,
    errors: [...observed.errors, ...visual.errors, ...(flow.clock === "live" ? [] : browserErrors)],
    gaps: [...observed.gaps, ...(flow.clock === "live" ? browserErrors : [])], ms: performance.now() - started,
    coverage: sourceCoverage, browser, screen };
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
const weight = (flow: Flow) => quickFlow(flow).steps.reduce((total, step) =>
  total + (step.wait.kind === "state" ? step.wait.maxRealMs : waitHorizonMs(step.wait)) + 300, 0);
const queue = [...flows].sort((a, b) => (previous.get(b.app) ?? weight(b)) - (previous.get(a.app) ?? weight(a)));
const outcomes: Outcome[] = [];
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let flow = queue.shift(); flow; flow = queue.shift()) {
    const outcome = await runFlow(flow, jobs);
    outcomes.push(outcome);
    console.log(`  ${flow.app}: ${outcome.runs.length} steps, ${(outcome.ms / 1000).toFixed(1)}s` +
      (outcome.errors.length ? `, ${outcome.errors.length} failure(s)` : "") +
      (outcome.gaps.length ? `, ${outcome.gaps.length} observed gap(s)` : ""));
  }
}));

const order = new Map(FLOWS.map((flow, index) => [flow.app, index]));
outcomes.sort((a, b) => (order.get(a.flow.app) ?? 0) - (order.get(b.flow.app) ?? 0));

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
if (coverage && !failed) {
  const byFile: Record<string, string[]> = {};
  for (const outcome of outcomes)
    for (const file of outcome.coverage) (byFile[file] ??= []).push(outcome.flow.app);
  for (const coveredFlows of Object.values(byFile)) coveredFlows.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const index: CoverageIndex = {
    generatedAt: new Date().toISOString(),
    complete: outcomes.length === deterministic.length,
    sourceRevision: repositoryRevision(new URL("../..", import.meta.url).pathname),
    schemaHash: flowSchemaHash(deterministic),
    browser: outcomes[0]?.browser ?? "unknown",
    mode: "v8-precise-sourcemap",
    apkHashes: await apkHashes(deterministic),
    screens: Object.fromEntries(outcomes.map((outcome) => [outcome.flow.app, outcome.screen])),
    unsupportedFlows: outcomes.filter((outcome) => outcome.flow.sourceCoverage === "unsupported").map((outcome) => outcome.flow.app),
    flows: Object.fromEntries(outcomes.map((outcome) => [outcome.flow.app, outcome.coverage])),
    files: byFile,
  };
  await Bun.write(`${E2E_DIR}coverage-index.json`, JSON.stringify(index, null, 2));
  console.log(`coverage: ${E2E_DIR}coverage-index.json (${Object.keys(byFile).length} source files)`);
}
const compared = outcomes.filter((item) => item.visual.length).length;
const observed = outcomes.filter((item) => item.flow.clock === "live" && !item.visual.length).length;
const gaps = outcomes.reduce((count, item) => count + item.gaps.length, 0);
console.log(`\n${flows.length - failed}/${flows.length} fast flows reached their checkpoints in ${((performance.now() - started) / 1000).toFixed(1)}s` +
  ` (${compared} Android-compared, ${outcomes.length - compared - observed} smoke, ${observed} live observed, ${gaps} reported gaps; actual-fast/summary.json)`);
if (failed) process.exit(1);
