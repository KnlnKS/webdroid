// Boot every apk in the tree headlessly and rank the gaps by how many apks they block. A launch waits up to --wait for a first frame, then up to
// --observe for its processes to go idle. --update records which drew in tests/corpus-drawn.json, which `check --corpus` holds them to.
//   pnpm corpus [apk ...] [--json out.json] [--wait ms] [--observe ms] [--jobs n] [--update]
import { readFileSync, writeFileSync } from "node:fs";
import { cli, jobsOf } from "./args.ts";
import { runQueue } from "./util.ts";
import type { Browser } from "playwright";
import { corpusApks } from "./apk-corpus.ts";
import { CONTEXT_OPTS, bootApp, launchBrowser, openWebdroid, pageErrors, readProcesses } from "./page.ts";
import { appIdle, diagnosed, diagnosticErrors, type ProcessSnapshot } from "../tests/e2e/lib/processes.ts";

const DRAWN = new URL("../tests/corpus-drawn.json", import.meta.url);
/** the apks that drew a frame when the baseline was last updated */
export const drawnApks = (): Set<string> => new Set(JSON.parse(readFileSync(DRAWN, "utf8")));

export interface Row {
  apk: string;
  /** the app drew a frame */
  ok: boolean;
  ticks: number;
  bootMs: number;
  classes: number;
  missing: string[];
  nativeRequired: string[];
  errors: string[];
  diagnostics: "ok" | "unavailable";
  note: string;
  secs: number;
  processes?: ProcessSnapshot[];
  browserErrors?: string[];
}

/** a launch of `apk` in a page of its own in `browser` */
export async function launchApk(browser: Browser, apk: string, { waitMs = 12_000, observeMs = 5_000 } = {}): Promise<Row> {
  const row: Row = { apk, ok: false, ticks: 0, bootMs: 0, classes: 0, missing: [], nativeRequired: [], errors: [], diagnostics: "unavailable", note: "", secs: 0 };
  const page = await browser.newPage(CONTEXT_OPTS), start = performance.now(), errors = pageErrors(page);
  try {
    await openWebdroid(page);
    row.ok = await bootApp(page, apk, { ms: waitMs }).then(() => true, (e: Error) => { row.note = e.message.slice(0, 160); return false; });
    const idle = row.ok && await page.evaluate(appIdle, { ms: observeMs, stableMs: 500, pollMs: 100 });
    if (typeof idle === "string") row.note = idle;
    const s = await page.evaluate(async () => {
      const w = globalThis.wd, foreground = (await w.foregroundWorkerSnapshot())?.snapshot;
      return { ticks: foreground?.ticks ?? w.ticks, bootMs: w.perf.bootMs, classes: (foreground?.perf ?? w.perf).wasmClasses,
        missing: [...w.rt.missing], logs: (w.logs || []).filter((line: string) => /error/i.test(line)).slice(-6) };
    });
    row.ticks = s.ticks; row.bootMs = s.bootMs; row.classes = s.classes;
    row.missing = s.missing; row.errors = s.logs;
  } catch (e) {
    row.note = String(e).split("\n")[0].slice(0, 160);
  }
  const relevant = row.processes = await readProcesses(page);
  await page.close();
  const available = relevant.flatMap((process) => process.diagnostics.status === "ok" ? [process.diagnostics] : []);
  row.diagnostics = relevant.length > 0 && relevant.every((process) => diagnosed(process.diagnostics)) ? "ok" : "unavailable";
  row.missing = [...new Set([...row.missing, ...available.flatMap((diagnostics) => diagnostics.missing)])];
  row.nativeRequired = [...new Set(available.flatMap((diagnostics) => diagnostics.native))];
  row.errors = [...new Set([...row.errors, ...errors, ...diagnosticErrors(relevant)])];
  row.browserErrors = errors;
  row.secs = (performance.now() - start) / 1000;
  return row;
}

export const rowLine = (row: Row): string =>
  `${row.ok ? "draw" : "FAIL"} ${row.apk.padEnd(28)} ${row.secs.toFixed(1).padStart(5)} s ${String(row.classes).padStart(7)} classes  boot ${String(Math.round(row.bootMs)).padStart(5)}ms  ${row.missing.length} missing  ${row.nativeRequired.length} native  ${row.errors.length} errors  diagnostics ${row.diagnostics}${row.note ? "  " + row.note : ""}`;

if (import.meta.main) {
  const { values: { wait, observe, json: out, jobs, update }, positionals } = cli("pnpm corpus [apk ...] [--wait ms] [--observe ms] [--jobs n] [--json out.json] [--update]",
    { wait: { type: "string", default: "12000" }, observe: { type: "string", default: "5000" }, jobs: { type: "string" }, json: { type: "string" }, update: { type: "boolean" } });
  const apks = positionals.length ? positionals : corpusApks(), browser = await launchBrowser();
  const rows = await runQueue(apks, jobsOf(jobs, 2), () => 0, async (apk) => {
    const row = await launchApk(browser, apk, { waitMs: parseInt(wait), observeMs: parseInt(observe) });
    console.log(rowLine(row));
    return row;
  });
  await browser.close();
  console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} rendered a frame in ${(performance.now() / 1000).toFixed(0)} s`);

  const rank = (field: "missing" | "nativeRequired"): [string, string[]][] => {
    const reached = new Map<string, string[]>();
    for (const row of rows) for (const key of row[field]) reached.set(key, [...reached.get(key) ?? [], row.apk]);
    return [...reached].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const ranked = rank("missing"), rankedNative = rank("nativeRequired");
  for (const [title, items] of [["missing APIs", ranked], ["native requirements", rankedNative]] as const) {
    console.log(`\n=== ${items.length} distinct ${title}, by how many apks reach them`);
    for (const [key, apks] of items.slice(0, 40)) console.log(`  ${String(apks.length).padStart(2)}/${rows.length}  ${key}`);
  }
  if (update) {
    const drawn = drawnApks();
    for (const row of rows) if (row.ok) drawn.add(row.apk); else drawn.delete(row.apk);
    writeFileSync(DRAWN, JSON.stringify([...drawn].sort(), null, 1) + "\n");
  }
  if (out) {
    writeFileSync(out, JSON.stringify({ rows, ranked, rankedNative }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}
