import { diagnostics, browserFailures } from "./lib/diagnostics.ts";
// `pnpm e2e --full` — capture webdroid, diff against the committed goldens, report.
// Never starts, queries, or requires an Android emulator. Every flow runs in its own browser;
// `--jobs` bounds how many at once, and each is scored as soon as it has captured.
import { cpus } from "node:os";
import { ENV_SCREEN } from "./drivers/webdroid.ts";
import { executionFlow, sameScreen, screenOf, screenParam, waitHorizonMs } from "./types.ts";
import { parseScreen } from "../../src/shell/config.ts";
import { captureFlow, launchFor, loadManifest, prepareShots } from "./capture-webdroid.ts";
import { assembleReport, scoreFlow } from "./score.ts";
import { printSmoke } from "./lib/report.ts";
import { parseArgs } from "./lib/args.ts";
import { FLOWS } from "./flows/index.ts";
import { runQueue } from "./lib/util.ts";

const { flows, shots, jobs } = parseArgs(process.argv.slice(2), "pnpm e2e --full");
const pinned = parseScreen(ENV_SCREEN);
console.log(`flows: ${flows.map((f) => f.app).join(", ")}  (${jobs} at a time)`);
if (shots) await prepareShots(shots);

type Outcome = { app: string; scored: boolean; failed: boolean; lines: string[]; ms: number };

/** Capture and score one flow; an exception is that flow's failure, never the run's. */
async function runFlow(app: string): Promise<Outcome> {
  const lines: string[] = [];
  const t0 = Date.now();
  const result = await captureAndScore(app, (s) => lines.push(s))
    .catch((error: unknown) => { lines.push(`\n--- ${app} aborted: ${String(error).split("\n", 1)[0]}`); return { scored: false, failed: true }; });
  const outcome = { app, ...result, lines, ms: Date.now() - t0 };
  console.log(`\n${lines.join("\n")}\n  (${(outcome.ms / 1000).toFixed(1)}s)`);
  return outcome;
}

async function captureAndScore(app: string, log: (line: string) => void): Promise<{ scored: boolean; failed: boolean }> {
  const flow = executionFlow(flows.find((f) => f.app === app)!, "full");
  const manifest = await loadManifest(app);
  const drv = await launchFor(flow, manifest, !!shots);
  let scored = false, failed = false;
  try {
    const { runs, errors } = await captureFlow(flow, drv, { jobs, shots, log });
    const observed = diagnostics(flow, runs);
    const browserErrors = browserFailures(flow, drv.errors);
    const failures = [...errors, ...observed.errors, ...(flow.clock === "live" ? [] : browserErrors)];
    const gaps = [...observed.gaps, ...(flow.clock === "live" ? browserErrors : [])];
    for (const error of failures) log(`  ${app}: ${error}`);
    for (const gap of gaps) log(`  ${app}: observed gap: ${gap}`);
    failed = failures.length > 0;
    // A flow without goldens is a smoke target: rendered/wedged/missing/fps, no pixel score. So
    // is a flow the run pinned to some other geometry: the goldens are pixels at one size, so a
    // run at any other size measures cost, never fidelity — and saying so here means the gate
    // cannot be passed at the wrong size by accident.
    if (!manifest || manifest.depth === "startup") printSmoke(app, runs, log);
    else if (pinned && !sameScreen(drv.screen, screenOf(manifest))) {
      log(`\n--- ${app} (smoke: ran at ${screenParam(pinned)}, goldens are ${screenParam(screenOf(manifest))}) ---`);
      printSmoke(app, runs, log);
    } else {
      log(await scoreFlow(app));
      scored = true;
    }
  } finally {
    await drv.close();
  }
  return { scored, failed };
}

const weight = (app: string) => FLOWS.find((f) => f.app === app)!.steps.reduce((a, s) => a + waitHorizonMs(s.wait) + 1000, 0);
const t0 = Date.now();
const outcomes = await runQueue(flows.map((f) => f.app), jobs, weight, runFlow);
const failed = outcomes.filter((o) => o.failed).map((o) => o.app);

const scoredApps = outcomes.filter((o) => o.scored).map((o) => o.app);
if (!scoredApps.length) {
  console.log(`\nno scored flows; see tests/e2e/actual/<flow>/run.json  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed.length ? 1 : 0);
}
const { out, reports } = await assembleReport(scoredApps, screenParam(pinned ?? screenOf(await loadManifest(scoredApps[0]))));
// Smoke flows and launch-only references never appear in the full report.
let scorable = 0;
for (const f of FLOWS) {
  const manifest = await loadManifest(f.app);
  if (manifest && manifest.depth !== "startup") scorable++;
}
if (reports.length < scorable) {
  console.log(`\nnote: a flow subset was selected, so the report now covers only ` +
    `${reports.map((r) => r.app).join(", ")} — the other flows' sections were replaced, not merged.`);
}
const overall = reports.reduce((a, r) => a + r.meanContentDiffPct, 0) / (reports.length || 1);
console.log(`\n${"=".repeat(60)}`);
for (const r of reports) {
  console.log(`  ${r.app.padEnd(18)} content ${r.meanContentDiffPct.toFixed(2).padStart(6)}%   ` +
    `strict ${r.meanStrictPct.toFixed(2).padStart(6)}%   tolerant ${r.meanTolerantPct.toFixed(2).padStart(6)}%   ` +
    `rendered ${r.stepsRendered}/${r.steps.length}` +
    (r.wedgedAtStep !== undefined ? `   WEDGED at step ${String(r.wedgedAtStep).padStart(2, "0")}` : ""));
}
console.log(`  ${"OVERALL".padEnd(18)} content ${overall.toFixed(2)}%   (the target metric)`);
console.log(`${"=".repeat(60)}\nreport: ${out}   (${((Date.now() - t0) / 1000).toFixed(1)}s, ${jobs} jobs, ${cpus().length} cpus)`);
if (shots) console.log(`frames: ${shots}/`);
if (failed.length) { console.error(`failed: ${failed.join(", ")}`); process.exit(1); }
