// Score tests/e2e/actual/<flow> against tests/e2e/golden/<flow> and write the report.
// Reads only from disk — no emulator, no browser. (lib/diff.ts is the pixel math.)
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { nodeCommand } from "../../scripts/node.ts";
import { loadPng, savePng, hconcat } from "./lib/png.ts";
import { diffImages } from "./lib/diff.ts";
import { html, printFlow, type FlowReport, type StepReport } from "./lib/report.ts";
import { parseArgs } from "./lib/args.ts";
import { flowSchemaHash, screenOf, screenParam, uiFileFor, type Flow, type Manifest, type RecordedStep, type Step, type UiNode } from "./types.ts";
import { diffTrees } from "./lib/tree.ts";
import type { FlowRun } from "./capture-webdroid.ts";
import { E2E_DIR, readJson, runProcess, runQueue, sha1 } from "./lib/util.ts";

/**
 * The device half of the structural comparison. A full hierarchy if the recorder captured one;
 * otherwise the one node the manifest already carries for every text-anchored tap, which is
 * device truth that has been sitting in the goldens all along.
 *
 * That fallback is a step behind on purpose: a tap is resolved against the screen already on
 * display, so the bounds recorded for step N+1 describe the frame captured at step N.
 */
async function treeDiffFor(goldenDir: string, actualDir: string, rec: RecordedStep, next?: { rec: RecordedStep; step: Step }) {
  const actualFile = actualDir + '/' + uiFileFor(rec.file);
  if (!existsSync(actualFile)) return undefined;
  let golden: UiNode[];
  if (rec.uiFile && existsSync(goldenDir + '/' + rec.uiFile)) {
    golden = await readJson(goldenDir + '/' + rec.uiFile);
  } else if (next?.rec.bounds && next.step.action.type === 'tapText') {
    golden = [{ text: next.step.action.text, desc: '', cls: '', resId: '', bounds: next.rec.bounds,
      clickable: true, enabled: true, editable: false, scrollable: false }];
  } else return undefined;
  return diffTrees(golden, await readJson(actualFile));
}

async function diffFlow(flow: Flow): Promise<FlowReport> {
  const goldenDir = `${E2E_DIR}golden/${flow.app}`;
  const actualDir = `${E2E_DIR}actual/${flow.app}`;
  const sxsDir = `${E2E_DIR}report/${flow.app}-sxs`;
  if (!existsSync(`${goldenDir}/manifest.json`)) {
    throw new Error(`no goldens for "${flow.app}" — run \`pnpm e2e --record\` (needs an emulator)`);
  }
  const manifest: Manifest = await readJson(`${goldenDir}/manifest.json`);
  if (manifest.depth === "startup")
    throw new Error(`${flow.app}: Android reference covers startup only; run the quick E2E test`);
  await rm(sxsDir, { recursive: true, force: true });
  await mkdir(sxsDir, { recursive: true });

  const runPath = `${actualDir}/run.json`;
  if (!existsSync(runPath)) throw new Error(`${flow.app}: missing run.json; rerun \`pnpm e2e --full --test ${flow.app}\``);
  const runInfo: FlowRun = await readJson(runPath);
  if (runInfo.aborted) throw new Error(`${flow.app}: capture aborted at ${runInfo.aborted.step}: ${runInfo.aborted.error}`);
  if (runInfo.mode !== "full" || runInfo.flowSchemaHash !== flowSchemaHash([flow], "full") ||
      runInfo.screen !== screenParam(screenOf(manifest)) ||
      runInfo.statusBarDp !== screenOf(manifest).statusBarDp ||
      runInfo.steps.length !== flow.steps.length ||
      runInfo.steps.some((run, index) => run.id !== flow.steps[index]?.id)) {
    throw new Error(`${flow.app}: run.json does not match the current full flow and Android reference geometry; rerun \`pnpm e2e --full --test ${flow.app}\``);
  }
  const runById = new Map(runInfo.steps.map((run) => [run.id, run]));
  const steps: StepReport[] = [];
  let lastHash = "";
  let stepsTracked = 0;

  for (const [i, step] of flow.steps.entries()) {
    const rec = manifest.steps.find((s) => s.id === step.id);
    if (!rec) throw new Error(`golden manifest has no step "${step.id}" — re-record ${flow.app}`);
    const actualPath = `${actualDir}/${rec.file}`;
    if (!existsSync(actualPath)) {
      throw new Error(`missing ${actualPath} — run \`pnpm e2e --full --test ${flow.app}\``);
    }
    const golden = await loadPng(`${goldenDir}/${rec.file}`);
    const actual = await loadPng(actualPath);
    const d = diffImages(golden, actual, manifest.crop, step.maskRects ?? []);

    await savePng(`${sxsDir}/${rec.file}`, hconcat([d.goldenCrop, d.actualCrop, d.diffImg]));

    const h = sha1(actual.data);
    if (h !== lastHash) stepsTracked = steps.length + 1;
    lastHash = h;

    const nextStep = flow.steps[i + 1];
    const nextRec = nextStep && manifest.steps.find((s) => s.id === nextStep.id);
    const tree = await treeDiffFor(goldenDir, actualDir, rec, nextRec && { rec: nextRec, step: nextStep });
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
      goldenSettleTimedOut: rec.settleTimedOut, tree, error: run?.error, note: rec.note,
    });
  }

  const mean = (f: (s: StepReport) => number) => steps.reduce((a, s) => a + f(s), 0) / (steps.length || 1);
  const withTree = steps.filter((s) => s.tree);
  // A flow that never paired a single view has no structural signal to report, rather than a
  // bad one: Compose draws through canvas ops and exposes no View.text for either side to name.
  const paired = withTree.some((s) => s.tree!.matched > 0);
  return {
    app: flow.app, androidSdk: manifest.device.sdk, steps,
    meanTreeDiffPct: paired ? withTree.reduce((a, s) => a + s.tree!.diffPct, 0) / withTree.length : undefined,
    treeSteps: paired ? withTree.length : undefined,
    meanTolerantPct: mean((s) => s.tolerantPct),
    meanStrictPct: mean((s) => s.strictPct),
    meanContentDiffPct: mean((s) => s.contentDiffPct),
    meanRawContentDiffPct: mean((s) => s.rawContentDiffPct),
    stepsRendered: steps.filter((s) => !s.mainLoopWedged).length,
    stepsTracked, recordedAt: manifest.recordedAt,
    wedgedAtStep: steps.find((s) => s.mainLoopWedged)?.index,
  };
}

const flowJson = (app: string) => `${E2E_DIR}report/${app}.json`;

/** Score one flow in a subprocess — the pixel work is CPU-bound and must not stall the event
 *  loop the other flows' browsers are driven from — and return its printed summary. */
export async function scoreFlow(app: string): Promise<string> {
  const { code, stdout, stderr } = await runProcess(...nodeCommand(`${E2E_DIR}score.ts`, "--json", app));
  if (code) throw new Error(`scoring ${app} failed: ${stderr || stdout}`);
  return stdout.toString().trimEnd();
}

/** index.html + report.json from the per-flow JSON files the scoring passes wrote. */
export async function assembleReport(apps: string[], geometry: string): Promise<{ out: string; reports: FlowReport[] }> {
  const dir = `${E2E_DIR}report`;
  const reports: FlowReport[] = [];
  for (const app of apps) reports.push(await readJson(flowJson(app)));
  const generatedAt = new Date().toISOString();
  await writeFile(`${dir}/index.html`, html(reports, generatedAt, geometry));
  await writeFile(`${dir}/report.json`, JSON.stringify({ generatedAt, reports }, null, 2));
  return { out: `${dir}/index.html`, reports };
}

if (import.meta.main) {
  const json = process.argv[2] === "--json";
  const { flows, jobs } = parseArgs(process.argv.slice(json ? 3 : 2), "pnpm e2e --diff");
  await mkdir(`${E2E_DIR}report`, { recursive: true });
  if (json) {
    const r = await diffFlow(flows[0]);
    await writeFile(flowJson(flows[0].app), JSON.stringify(r));
    printFlow(r);
  } else {
    for (const summary of await runQueue(flows.map((f) => f.app), jobs, () => 0, scoreFlow)) console.log(summary);
    // scored flows all share the goldens' geometry — diffImages would have thrown otherwise
    const first: Manifest = await readJson(`${E2E_DIR}golden/${flows[0].app}/manifest.json`);
    const { out } = await assembleReport(flows.map((f) => f.app), screenParam(screenOf(first)));
    console.log(`\nreport: ${out}`);
  }
}
