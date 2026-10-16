// JSON + standalone HTML report. The HTML embeds nothing but relative PNG links, so the whole
// report/ directory is portable.
import type { StepRun } from "../capture-webdroid.ts";
import type { TreeDiff } from "./tree.ts";
export type StepReport = {
  index: number; id: string; label: string; file: string;
  strictPct: number; tolerantPct: number;
  /** Scored content diff: forced to 100 when the step never rendered (main loop wedged). */
  contentDiffPct: number;
  /** What the pixels actually measured, before the non-render rule. */
  rawContentDiffPct: number;
  goldenInk: number; actualInk: number; bgMismatch?: boolean;
  comparedPixels: number; maskedPixels: number;
  semanticHit?: boolean; settleTimedOut: boolean; goldenSettleTimedOut?: boolean;
  mainLoopWedged?: boolean;
  /** Structural diff against the device hierarchy, when there is one to compare against. */
  tree?: TreeDiff;
  error?: string; note?: string;
};

export type FlowReport = {
  app: string;
  androidSdk: string;
  steps: StepReport[];
  meanTolerantPct: number;
  meanStrictPct: number;
  meanContentDiffPct: number;
  /** Mean of the raw measurements, ignoring the non-render rule — diagnostic only. */
  meanRawContentDiffPct: number;
  /** Steps webdroid was actually executing for. */
  stepsRendered: number;
  /** Steps before webdroid's screen stopped changing — how far the flow actually got. */
  stepsTracked: number;
  /** First step at which webdroid's main looper stopped draining, if it did. */
  wedgedAtStep?: number;
  /** Mean share of nameable device views webdroid puts somewhere else, over the steps that have
   *  a hierarchy to compare against. Undefined when none do. */
  meanTreeDiffPct?: number;
  treeSteps?: number;
  recordedAt: string;
};

const pct = (n: number) => n.toFixed(2).padStart(6) + "%";

/** A flow with no goldens: what ran, what hung, what was missing — nothing about pixels. */
export function printSmoke(app: string, runs: StepRun[], log = console.log): void {
  log(`\n--- ${app} (smoke, not scored) ---`);
  let wedgedAt: number | undefined;
  const missing = new Set<string>(), native = new Set<string>();
  for (const s of runs) {
    if (s.mainLoopWedged && wedgedAt === undefined) wedgedAt = s.index;
    for (const m of s.newMissing ?? []) missing.add(m);
    for (const n of s.nativeRequired ?? []) native.add(n);
    const flags = [
      s.fps !== undefined ? `${s.fps}fps` : "",
      s.slow ? "SLOW" : "",
      s.settleTimedOut ? "settle-timeout" : "",
      s.mainLoopWedged ? "WEDGED" : "",
      s.error ? "error" : "",
      s.newMissing?.length ? `${s.newMissing.length} missing` : "",
      s.newErrors?.length ? `${s.newErrors.length} errors` : "",
    ].filter(Boolean).join(" ");
    log(`  ${String(s.index).padStart(2, "0")} ${s.id}${flags ? "  [" + flags + "]" : ""}`);
  }
  const fps = runs.map((s) => s.fps).filter((f): f is number => f !== undefined);
  log(`  rendered ${runs.filter((s) => !s.mainLoopWedged).length}/${runs.length}` +
    (wedgedAt !== undefined ? ` · wedged at ${String(wedgedAt).padStart(2, "0")}` : "") +
    (fps.length ? ` · min fps ${Math.min(...fps)}` : "") +
    (missing.size ? ` · missing: ${[...missing].join(", ")}` : " · nothing missing") +
    (native.size ? ` · native code required: ${[...native].join(", ")}` : ""));
}

export function printFlow(r: FlowReport): void {
  console.log(`\n--- ${r.app} (Android API ${r.androidSdk}) ---`);
  console.log("  ##  strict  tolerant  content  step");
  for (const s of r.steps) {
    const flags = [
      s.semanticHit === false ? "skipped" : "",
      s.settleTimedOut ? "settle-timeout" : "",
      s.goldenSettleTimedOut ? "golden-settle-timeout" : "",
      s.mainLoopWedged ? `WEDGED, not rendered (measured ${s.rawContentDiffPct.toFixed(1)}%)` : "",
      s.error ? "error" : "",
    ].filter(Boolean).join(" ");
    console.log(`  ${String(s.index).padStart(2, "0")} ${pct(s.strictPct)} ${pct(s.tolerantPct)} ${pct(s.contentDiffPct)}  ${s.label}${flags ? "  [" + flags + "]" : ""}`);
  }
  console.log(`  MEAN  ${pct(r.meanStrictPct)} ${pct(r.meanTolerantPct)} ${pct(r.meanContentDiffPct)}   over ${r.steps.length} steps` +
    (r.stepsRendered < r.steps.length
      ? `  (${r.steps.length - r.stepsRendered} never rendered, scored 100%; raw mean ${r.meanRawContentDiffPct.toFixed(2)}%)`
      : ""));
  if (r.stepsTracked < r.steps.length) {
    console.log(`  TRACKED  webdroid's screen stopped changing after step ${r.stepsTracked} of ${r.steps.length}`);
  }
  if (r.meanTreeDiffPct === undefined && r.steps.some((s) => s.tree)) {
    console.log("  STRUCTURE  nothing to compare: no view on either side carries text or an id");
  }
  if (r.meanTreeDiffPct !== undefined) {
    console.log(`  STRUCTURE ${pct(r.meanTreeDiffPct)} of nameable device views misplaced, over ${r.treeSteps} steps`);
    // the worst offender names itself, which is the whole point of measuring structure
    const worst = r.steps.flatMap((s) => (s.tree?.worst ?? []).map((w) => ({ step: s.index, ...w })))
      .sort((a, b) => b.off - a.off).slice(0, 3);
    for (const w of worst) console.log(`    ${String(w.step).padStart(2, "0")} ${w.key} off by ${w.off}px  device [${w.golden}] here [${w.actual}]`);
    const missing = [...new Set(r.steps.flatMap((s) => s.tree?.missing ?? []))].slice(0, 3);
    if (missing.length) console.log(`    no counterpart: ${missing.join(", ")}`);
  }
}

export function html(reports: FlowReport[], generatedAt: string, geometry: string): string {
  const bar = (v: number) =>
    `<span class="bar"><i style="width:${Math.min(100, v).toFixed(1)}%"></i></span>`;
  const rows = (r: FlowReport) => r.steps.map((s) => `
    <tr>
      <td class="n">${String(s.index).padStart(2, "0")}</td>
      <td>${esc(s.label)}
        ${s.semanticHit === false ? '<em class="tag">skipped</em>' : ""}
        ${s.settleTimedOut ? '<em class="tag warn">settle timeout</em>' : ""}
        ${s.mainLoopWedged ? '<em class="tag bad">not rendered &mdash; main loop wedged</em>' : ""}
        ${s.error ? `<em class="tag bad">${esc(s.error)}</em>` : ""}
        ${s.note ? `<em class="tag">${esc(s.note)}</em>` : ""}</td>
      <td class="num">${s.strictPct.toFixed(2)}%</td>
      <td class="num">${s.tolerantPct.toFixed(2)}%</td>
      <td class="num">${s.contentDiffPct.toFixed(2)}% ${bar(s.contentDiffPct)}
        <div class="ink">${s.mainLoopWedged ? `scored as non-render &middot; measured ${s.rawContentDiffPct.toFixed(2)}%` : `ink ${s.actualInk.toLocaleString()} / ${s.goldenInk.toLocaleString()}${s.bgMismatch ? " &middot; bg mismatch" : ""}`}</div></td>
      <td><a href="../${r.app}-sxs/${s.file}"><img loading="lazy" src="../${r.app}-sxs/${s.file}"></a></td>
    </tr>`).join("");

  return `<title>webdroid visual diff</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --fg:#dfe3ea; --dim:#8b93a1; --line:#262a31; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
  h1 { font-size:20px; margin:0 0 4px }
  h2 { font-size:16px; margin:36px 0 8px; }
  .meta { color:var(--dim); font-size:12px; margin-bottom:24px }
  .summary { display:flex; gap:16px; flex-wrap:wrap; margin:16px 0 8px }
  .card { background:#1b1e24; border:1px solid var(--line); border-radius:10px; padding:14px 18px; min-width:210px }
  .card b { display:block; font-size:26px; font-weight:600 }
  .card span { color:var(--dim); font-size:12px }
  table { border-collapse:collapse; width:100%; }
  th, td { border-bottom:1px solid var(--line); padding:7px 9px; vertical-align:top; text-align:left }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.04em }
  td.n, td.num { font-variant-numeric:tabular-nums; white-space:nowrap }
  td.num { text-align:right }
  img { width:340px; border-radius:4px; display:block }
  .bar { display:inline-block; width:70px; height:7px; background:#2a2f38; border-radius:4px; margin-left:8px; overflow:hidden; vertical-align:middle }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#3fb950,#d29922 55%,#f85149) }
  .tag { display:inline-block; font-style:normal; font-size:11px; color:#c9a227; border:1px solid #4a3f16;
         background:#2a2413; border-radius:4px; padding:0 6px; margin-left:6px }
  .ink { color:var(--dim); font-size:11px; font-weight:400 }
  .tag.warn { color:#d29922 } .tag.bad { color:#f85149; border-color:#4a1f1c; background:#2a1513 }
  a { color:inherit }
</style>
<h1>webdroid vs. real Android — visual diff</h1>
<div class="meta">generated ${esc(generatedAt)} &middot; ${esc(geometry)} &middot; system bars cropped &middot;
  <b>content</b> = tolerant mismatch over the union of both images' non-background pixels
  (the target metric &mdash; a blank render scores ~100% here, ~3% on whole-frame numbers).
  A step webdroid never rendered, because its main loop was wedged, scores a flat 100%: a
  frozen frame is a non-render, not a near-miss;
  strict = any RGB difference; tolerant = pixelmatch threshold 0.1 over the whole frame</div>
<div class="summary">
${reports.map((r) => `<div class="card"><b>${r.meanContentDiffPct.toFixed(1)}%</b>
  <span>${esc(r.app)} &middot; mean content diff &middot; rendered ${r.stepsRendered}/${r.steps.length} steps
  ${r.wedgedAtStep !== undefined ? `&middot; wedged at step ${String(r.wedgedAtStep).padStart(2, "0")}` : ""}</span></div>`).join("")}
</div>
${reports.map((r) => `<h2>${esc(r.app)} <span class="meta">Android API ${esc(r.androidSdk)} &middot; recorded ${esc(r.recordedAt)}</span></h2>
<table><thead><tr><th></th><th>step</th><th>strict</th><th>tolerant</th><th>content</th>
  <th>golden &middot; webdroid &middot; diff</th></tr></thead>
<tbody>${rows(r)}</tbody></table>`).join("")}`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
