import { rm } from "node:fs/promises";
import { captureFlow, launchFor, loadManifest, type StepRun } from "./capture-webdroid";
import { parseArgs } from "./lib/args";
import { FLOWS } from "./flows";
import type { Flow } from "./types";
import { loadPng } from "./lib/png";
import { diffImages } from "./lib/diff";
import { E2E_DIR } from "./lib/util";
import { apkHashes, flowSchemaHash, repositoryRevision, type CoverageIndex } from "./coverage";
import { screenParam } from "./types";

const deterministic = FLOWS.filter((flow) => flow.clock !== "live");
const coverage = process.argv.includes("--coverage");
const args = process.argv.slice(2).filter((arg) => arg !== "--coverage");
const { flows, jobs } = parseArgs(args, "bun run e2e:fast", deterministic);
if (coverage && flows.length !== deterministic.length)
  throw new Error("coverage collection must run the complete deterministic lane");

type Outcome = { flow: Flow; runs: StepRun[]; errors: string[]; ms: number; coverage: string[]; browser: string; screen: string };

function failures(runs: StepRun[]): string[] {
  const errors: string[] = [];
  for (const step of runs) {
    const prefix = `${String(step.index).padStart(2, "0")} ${step.id}`;
    if (step.mainLoopWedged) errors.push(`${prefix}: main loop wedged`);
    if (step.settleTimedOut) errors.push(`${prefix}: completion timed out`);
    if (step.error) errors.push(`${prefix}: ${step.error}`);
    for (const item of step.newMissing ?? []) errors.push(`${prefix}: missing ${item}`);
    for (const item of step.nativeRequired ?? []) errors.push(`${prefix}: native code required ${item}`);
    for (const item of step.newErrors ?? []) errors.push(`${prefix}: ${item}`);
  }
  return errors;
}

async function visualFailures(flow: Flow): Promise<string[]> {
  if (!flow.fastVisualLimits) return [];
  const manifest = await loadManifest(flow.app);
  if (!manifest) return [];
  const errors: string[] = [];
  for (const [id, limit] of Object.entries(flow.fastVisualLimits)) {
    const step = flow.steps.find((item) => item.id === id)!;
    const recorded = manifest.steps.find((item) => item.id === id)!;
    const golden = await loadPng(`${E2E_DIR}golden/${flow.app}/${recorded.file}`);
    const actual = await loadPng(`${E2E_DIR}actual-fast/${flow.app}/${recorded.file}`);
    const diff = diffImages(golden, actual, manifest.crop, step.maskRects ?? []).contentDiffPct;
    if (diff > limit) errors.push(`${id}: visual diff ${diff.toFixed(2)}% exceeds retained ${limit.toFixed(2)}% limit`);
  }
  return errors;
}

async function runFlow(flow: Flow): Promise<Outcome> {
  const manifest = await loadManifest(flow.app);
  const collectCoverage = coverage && flow.sourceCoverage !== "unsupported";
  const driver = await launchFor(flow, manifest, false, flow.clock === "controlled", collectCoverage);
  const started = performance.now();
  let runs: StepRun[] = [];
  try {
    runs = await captureFlow(flow, driver, { jobs, mode: "fast" });
    const sourceCoverage = collectCoverage ? await driver.takeSourceCoverage() : [];
    return { flow, runs, errors: [...failures(runs), ...await visualFailures(flow)], ms: performance.now() - started,
      coverage: sourceCoverage, browser: driver.browserVersion(), screen: screenParam(driver.screen) };
  } finally {
    await driver.close();
  }
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
const queue = [...flows];
const outcomes: Outcome[] = [];
const started = performance.now();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let flow = queue.shift(); flow; flow = queue.shift()) {
    const outcome = await runFlow(flow);
    outcomes.push(outcome);
    console.log(`  ${flow.app}: ${flow.steps.length} steps, ${(outcome.ms / 1000).toFixed(1)}s` +
      (outcome.errors.length ? `, ${outcome.errors.length} failure(s)` : ""));
  }
}));

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
