import { captureFlow, launchFor, loadManifest, type StepRun } from "./capture-webdroid";
import { parseArgs } from "./lib/args";
import { FLOWS } from "./flows";
import type { Flow } from "./types";

const deterministic = FLOWS.filter((flow) => flow.clock === "controlled");
const { flows, jobs } = parseArgs(process.argv.slice(2), "bun run e2e:fast", deterministic);

type Outcome = { flow: Flow; runs: StepRun[]; errors: string[]; ms: number };

function failures(runs: StepRun[], browserErrors: string[]): string[] {
  const errors = [...browserErrors];
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

async function runFlow(flow: Flow): Promise<Outcome> {
  const manifest = await loadManifest(flow.app);
  const driver = await launchFor(flow, manifest, false, true);
  const started = performance.now();
  let runs: StepRun[] = [];
  try {
    runs = await captureFlow(flow, driver, { jobs, mode: "fast" });
    return { flow, runs, errors: failures(runs, driver.errors), ms: performance.now() - started };
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
console.log(`\n${flows.length - failed}/${flows.length} fast flows passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
if (failed) process.exit(1);
