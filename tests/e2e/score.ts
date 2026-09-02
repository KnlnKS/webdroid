// Score tests/e2e/actual/<flow> against tests/e2e/golden/<flow> and write the report.
// Reads only from disk — no emulator, no browser. (lib/diff.ts is the pixel math.)
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadPng, savePng, hconcat } from "./lib/png";
import { diffImages } from "./lib/diff";
import { html, printFlow, type FlowReport, type StepReport } from "./lib/report";
import { selectFlows } from "./lib/args";
import type { Flow, Manifest } from "./types";
import type { StepRun } from "./capture-webdroid";
import { E2E_DIR, sha1 } from "./lib/util";

export async function diffFlow(flow: Flow, runs?: StepRun[]): Promise<FlowReport> {
  const goldenDir = `${E2E_DIR}golden/${flow.app}`;
  const actualDir = `${E2E_DIR}actual/${flow.app}`;
  const sxsDir = `${E2E_DIR}report/${flow.app}-sxs`;
  if (!existsSync(`${goldenDir}/manifest.json`)) {
    throw new Error(`no goldens for "${flow.app}" — run \`bun run e2e:record\` (needs an emulator)`);
  }
  const manifest: Manifest = await Bun.file(`${goldenDir}/manifest.json`).json();
  await rm(sxsDir, { recursive: true, force: true });
  await mkdir(sxsDir, { recursive: true });

  // Fall back to the flags the capture pass left on disk, so `e2e:diff` scores identically.
  let runInfo = runs;
  if (!runInfo) {
    if (existsSync(`${actualDir}/run.json`)) runInfo = await Bun.file(`${actualDir}/run.json`).json();
    else console.warn(`  ${flow.app}: actual/ has no run.json — scoring pixels only, wedge flags unknown; rerun \`bun run e2e --test ${flow.app}\``);
  }
  const runById = new Map((runInfo ?? []).map((r) => [r.id, r]));
  const steps: StepReport[] = [];
  let lastHash = "";
  let stepsTracked = 0;

  for (const step of flow.steps) {
    const rec = manifest.steps.find((s) => s.id === step.id);
    if (!rec) throw new Error(`golden manifest has no step "${step.id}" — re-record ${flow.app}`);
    const actualPath = `${actualDir}/${rec.file}`;
    if (!existsSync(actualPath)) {
      throw new Error(`missing ${actualPath} — run \`bun run e2e --test ${flow.app}\``);
    }
    const golden = await loadPng(`${goldenDir}/${rec.file}`);
    const actual = await loadPng(actualPath);
    const d = diffImages(golden, actual, manifest.crop, step.maskRects ?? []);

    await savePng(`${sxsDir}/${rec.file}`, hconcat([d.goldenCrop, d.actualCrop, d.diffImg]));

    const h = sha1(actual.data);
    if (h !== lastHash) stepsTracked = steps.length + 1;
    lastHash = h;

    const run = runById.get(step.id);
    // A wedged step is not a rendering near-miss — the app was not executing, so the frame on
    // screen is one it drew several steps ago. Scoring the measured difference hands out
    // partial credit for background pixels that happen to survive from an older screen (a
    // frozen FitNotes home scores ~66% against the golden's graph). Score it as the non-render
    // it is, and keep the measurement alongside so nothing is hidden.
    const wedged = run?.mainLoopWedged ?? false;
    steps.push({
      index: rec.index, id: step.id, label: step.label, file: rec.file,
      strictPct: d.strictPct, tolerantPct: d.tolerantPct,
      contentDiffPct: wedged ? 100 : d.contentDiffPct,
      rawContentDiffPct: d.contentDiffPct,
      goldenInk: d.goldenInk, actualInk: d.actualInk, bgMismatch: d.bgMismatch,
      comparedPixels: d.comparedPixels, maskedPixels: d.maskedPixels,
      semanticHit: run?.semanticHit, settleTimedOut: run?.settleTimedOut ?? false,
      mainLoopWedged: run?.mainLoopWedged,
      goldenSettleTimedOut: rec.settleTimedOut, error: run?.error, note: rec.note,
    });
  }

  const mean = (f: (s: StepReport) => number) => steps.reduce((a, s) => a + f(s), 0) / (steps.length || 1);
  return {
    app: flow.app, steps,
    meanTolerantPct: mean((s) => s.tolerantPct),
    meanStrictPct: mean((s) => s.strictPct),
    meanContentDiffPct: mean((s) => s.contentDiffPct),
    meanRawContentDiffPct: mean((s) => s.rawContentDiffPct),
    stepsRendered: steps.filter((s) => !s.mainLoopWedged).length,
    stepsTracked, recordedAt: manifest.recordedAt,
    wedgedAtStep: steps.find((s) => s.mainLoopWedged)?.index,
  };
}

export async function writeReport(reports: FlowReport[]): Promise<string> {
  const dir = `${E2E_DIR}report`;
  await mkdir(dir, { recursive: true });
  const generatedAt = new Date().toISOString();
  await Bun.write(`${dir}/index.html`, html(reports, generatedAt));
  await Bun.write(`${dir}/report.json`, JSON.stringify({ generatedAt, reports }, null, 2));
  return `${dir}/index.html`;
}

if (import.meta.main) {
  const flows = selectFlows(process.argv.slice(2), "bun run e2e:diff");
  const reports: FlowReport[] = [];
  for (const f of flows) {
    const r = await diffFlow(f);
    printFlow(r);
    reports.push(r);
  }
  const out = await writeReport(reports);
  console.log(`\nreport: ${out}`);
}
