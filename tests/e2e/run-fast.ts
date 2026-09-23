import { rm } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, type StepRun } from "./capture-webdroid";
import { parseArgs } from "./lib/args";
import { FLOWS } from "./flows";
import type { Flow } from "./types";
import { loadPng } from "./lib/png";
import { diffImages } from "./lib/diff";
import { E2E_DIR } from "./lib/util";
import { apkHashes, flowSchemaHash, repositoryRevision, type CoverageIndex } from "./coverage";
import { screenParam, waitHorizonMs } from "./types";
import { BASE_URL } from "./lib/util";
import { isWebdroidProcessFrame } from "./lib/processes";

const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const coverage = process.argv.includes("--coverage");
const args = process.argv.slice(2).filter((arg) => arg !== "--coverage");
const { flows, jobs } = parseArgs(args, "bun run e2e:fast", deterministic);
if (coverage && flows.length !== deterministic.length)
  throw new Error("coverage collection must run the complete deterministic lane");

type Outcome = { flow: Flow; runs: StepRun[]; errors: string[]; ms: number; coverage: string[]; browser: string; screen: string };

function failures(runs: StepRun[]): string[] {
  const errors: string[] = [];
  const seenProcessErrors = new Set<string>();
  for (const step of runs) {
    const prefix = `${String(step.index).padStart(2, "0")} ${step.id}`;
    if (step.mainLoopWedged) errors.push(`${prefix}: main loop wedged`);
    if (step.settleTimedOut) errors.push(`${prefix}: completion timed out`);
    if (step.error) errors.push(`${prefix}: ${step.error}`);
    if (step.slow) errors.push(`${prefix}: motion fell below its retained frame-rate limit`);
    for (const item of step.newMissing ?? []) errors.push(`${prefix}: missing ${item}`);
    for (const item of step.nativeRequired ?? []) errors.push(`${prefix}: native code required ${item}`);
    for (const item of step.newErrors ?? []) errors.push(`${prefix}: ${item}`);
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
        if (!(step.newErrors ?? []).includes(item)) errors.push(`${prefix}: ${process.url}: ${item}`);
      }
    }
  }
  return errors;
}

async function visualFailures(flow: Flow): Promise<string[]> {
  const checks = flow.steps.filter((step) => step.fastEvidence?.kind === "visual");
  if (!checks.length) return [];
  const manifest = await loadManifest(flow.app);
  if (!manifest) return [`visual evidence requires a golden manifest`];
  const errors: string[] = [];
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
    if (diff > evidence.maxContentDiffPct)
      errors.push(`${step.id}: visual diff ${diff.toFixed(2)}% exceeds retained ${evidence.maxContentDiffPct.toFixed(2)}% limit`);
  }
  return errors;
}

function browserFailures(flow: Flow, errors: string[]): string[] {
  const expected = flow.expectedBrowserErrors ?? [];
  return errors.filter((error) => !expected.some((part) => error.includes(part)))
    .map((error) => `browser: ${error.slice(0, 300)}`);
}

async function runFlow(flow: Flow, effectiveJobs: number): Promise<Outcome> {
  const manifest = await loadManifest(flow.app);
  const collectCoverage = coverage && flow.sourceCoverage !== "unsupported";
  const driver = await launchFor(flow, manifest, false, flow.clock === "controlled", collectCoverage);
  const started = performance.now();
  let runs: StepRun[] = [];
  let sourceCoverage: string[] = [];
  const browser = driver.browserVersion();
  const screen = screenParam(driver.screen);
  try {
    runs = await captureFlow(flow, driver, { jobs: effectiveJobs, mode: "fast", log: () => {} });
    sourceCoverage = collectCoverage ? await driver.takeSourceCoverage() : [];
  } finally {
    await driver.close();
  }
  return { flow, runs, errors: [...failures(runs), ...await visualFailures(flow), ...browserFailures(flow, driver.errors)], ms: performance.now() - started,
    coverage: sourceCoverage, browser, screen };
}

async function retainFailure(outcome: Outcome): Promise<void> {
  const manifest = await loadManifest(outcome.flow.app);
  const driver = await launchFor(outcome.flow, manifest, false, false);
  try {
    await captureFlow(outcome.flow, driver, {
      jobs: 1,
      mode: "full",
      outRoot: "actual-fast/failures",
      log: (line) => console.log(`    ${line}`),
    });
  } finally {
    await driver.close();
  }
}

console.log(`fast flows: ${flows.map((flow) => flow.app).join(", ")} (${jobs} at a time)`);
await rm(`${E2E_DIR}actual-fast/failures`, { recursive: true, force: true });
const weight = (flow: Flow) => flow.steps.reduce((total, step) => total + waitHorizonMs(step.wait) + 300, 0);
const queue = [...flows].sort((a, b) => weight(b) - weight(a));
const outcomes: Outcome[] = [];
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let flow = queue.shift(); flow; flow = queue.shift()) {
    const outcome = await runFlow(flow, jobs);
    outcomes.push(outcome);
    console.log(`  ${flow.app}: ${flow.steps.length} steps, ${(outcome.ms / 1000).toFixed(1)}s` +
      (outcome.errors.length ? `, ${outcome.errors.length} failure(s)` : ""));
  }
}));

const order = new Map(deterministic.map((flow, index) => [flow.app, index]));
outcomes.sort((a, b) => (order.get(a.flow.app) ?? 0) - (order.get(b.flow.app) ?? 0));

for (const outcome of outcomes.filter((item) => item.errors.length)) {
  console.error(`\n${outcome.flow.app} failed; retaining a full-evidence rerun:`);
  for (const error of outcome.errors) console.error(`  ${error}`);
  await retainFailure(outcome);
}

const failed = outcomes.filter((item) => item.errors.length).length;
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
console.log(`\n${flows.length - failed}/${flows.length} fast flows passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
if (failed) process.exit(1);
