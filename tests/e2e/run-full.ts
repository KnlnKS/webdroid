// `bun run e2e --full` — capture webdroid, diff against the committed goldens, report.
// Never starts, queries, or requires an Android emulator. Every flow runs in its own browser;
// `--jobs` bounds how many at once, and each is scored as soon as it has captured.
import { cpus } from "node:os";
import { ENV_SCREEN } from "./drivers/webdroid";
import { sameScreen, screenOf, screenParam, waitHorizonMs } from "./types";
import { parseScreen } from "../../src/shell/config";
import { captureFlow, launchFor, loadManifest, prepareShots } from "./capture-webdroid";
import { assembleReport, scoreFlow } from "./score";
import { printSmoke } from "./lib/report";
import { parseArgs } from "./lib/args";
import { FLOWS } from "./flows";

const { flows, shots, jobs } = parseArgs(process.argv.slice(2), "bun run e2e --full");
const pinned = parseScreen(ENV_SCREEN);
console.log(`flows: ${flows.map((f) => f.app).join(", ")}  (${jobs} at a time)`);
if (shots) await prepareShots(shots);

type Outcome = { app: string; scored: boolean; lines: string[]; ms: number };

async function runFlow(app: string): Promise<Outcome> {
  const flow = flows.find((f) => f.app === app)!;
  const manifest = await loadManifest(app);
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const t0 = Date.now();
  const drv = await launchFor(flow, manifest, !!shots);
  let scored = false;
  try {
    const runs = await captureFlow(flow, drv, { jobs, shots, log });
    // A flow without goldens is a smoke target: rendered/wedged/missing/fps, no pixel score. So
    // is a flow the run pinned to some other geometry: the goldens are pixels at one size, so a
    // run at any other size measures cost, never fidelity — and saying so here means the gate
    // cannot be passed at the wrong size by accident.
    if (!manifest) printSmoke(app, runs, log);
    else if (pinned && !sameScreen(pinned, screenOf(manifest))) {
      log(`\n--- ${app} (smoke: ran at ${screenParam(pinned)}, goldens are ${screenParam(screenOf(manifest))}) ---`);
      printSmoke(app, runs, log);
    } else {
      lines.push(await scoreFlow(app));
      scored = true;
    }
  } finally {
    await drv.close();
  }
  return { app, scored, lines, ms: Date.now() - t0 };
}

// longest flows first, so the tail of the run is not one slow flow starting last
const weight = (app: string) => FLOWS.find((f) => f.app === app)!.steps.reduce((a, s) => a + waitHorizonMs(s.wait) + 1000, 0);
const queue = flows.map((f) => f.app).sort((a, b) => weight(b) - weight(a));
const outcomes: Outcome[] = [];
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let app = queue.shift(); app; app = queue.shift()) {
    const o = await runFlow(app);
    outcomes.push(o);
    console.log(`\n${o.lines.join("\n")}\n  (${(o.ms / 1000).toFixed(1)}s)`);
  }
}));

const scoredApps = outcomes.filter((o) => o.scored).map((o) => o.app);
if (!scoredApps.length) {
  console.log(`\nno scored flows; see tests/e2e/actual/<flow>/run.json  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
}
const { out, reports } = await assembleReport(scoredApps, screenParam(pinned ?? screenOf(await loadManifest(scoredApps[0]))));
// smoke flows (no goldens) never appear in the report, so compare against the scorable set
let scorable = 0;
for (const f of FLOWS) if (await loadManifest(f.app)) scorable++;
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
