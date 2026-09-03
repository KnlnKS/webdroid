// `bun run e2e` — capture webdroid, diff against the committed goldens, report.
// Never starts, queries, or requires an Android emulator.
import { ENV_SCREEN, WebdroidDriver } from "./drivers/webdroid";
import { sameScreen, screenOf, screenParam } from "./types";
import { parseScreen } from "../../src/shell/config";
import { captureFlow, loadManifest, prepareShots, type StepRun } from "./capture-webdroid";
import { diffFlow, writeReport } from "./score";
import { printFlow, printSmoke, type FlowReport } from "./lib/report";
import { parseArgs } from "./lib/args";
import { FLOWS } from "./flows";

const { flows, shots } = parseArgs(process.argv.slice(2), "bun run e2e");
if (flows.length) console.log(`flows: ${flows.map((f) => f.app).join(", ")}`);

const drv = await WebdroidDriver.launch();
if (shots) { await prepareShots(shots); drv.enableShots(shots); }
const runs = new Map<string, StepRun[]>();
try {
  for (const f of flows) runs.set(f.app, await captureFlow(f, drv));
} finally {
  await drv.close();
}

const reports: FlowReport[] = [];
for (const f of flows) {
  // A flow without goldens is a smoke target: rendered/wedged/missing/fps, no pixel score.
  const manifest = await loadManifest(f.app);
  if (!manifest) { printSmoke(f.app, runs.get(f.app) ?? []); continue; }
  // So is a flow the run pinned to some other geometry. The goldens are pixels at one size, so
  // a run at any other size measures cost, never fidelity — and saying so here means the gate
  // cannot be passed at the wrong size by accident.
  const pinned = parseScreen(ENV_SCREEN);
  if (pinned && !sameScreen(pinned, screenOf(manifest))) {
    console.log(`\n--- ${f.app} (smoke: ran at ${screenParam(pinned)}, goldens are ${screenParam(screenOf(manifest))}) ---`);
    printSmoke(f.app, runs.get(f.app) ?? []);
    continue;
  }
  const r = await diffFlow(f, runs.get(f.app));
  printFlow(r);
  reports.push(r);
}
if (!reports.length) {
  console.log("\nno scored flows; see tests/e2e/actual/<flow>/run.json");
  process.exit(0);
}

const out = await writeReport(reports, screenParam(drv.screen));
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
console.log(`${"=".repeat(60)}\nreport: ${out}`);
if (shots) console.log(`frames: ${shots}/`);
