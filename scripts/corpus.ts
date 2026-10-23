// Boot every apk in the tree headlessly and rank the gaps by how many apks they block.
//   pnpm corpus [apk ...] [--json out.json] [--wait ms] [--observe ms] [--jobs n]
import { writeFileSync } from "node:fs";
import { cli, jobsOf } from "./args.ts";
import { runQueue } from "./util.ts";
import type { Page } from "playwright";
import { corpusApks } from "./apk-corpus.ts";
import { CONTEXT_OPTS, bootApp, launchBrowser, openWebdroid, pageErrors, readProcesses } from "./page.ts";
import { diagnosed, diagnosticErrors, type ProcessSnapshot } from "../tests/e2e/lib/processes.ts";

const { values: { wait, observe, json: out, jobs }, positionals } = cli("pnpm corpus [apk ...] [--wait ms] [--observe ms] [--jobs n] [--json out.json]",
  { wait: { type: "string", default: "12000" }, observe: { type: "string", default: "1500" }, jobs: { type: "string" }, json: { type: "string" } });
const waitMs = parseInt(wait), observeMs = parseInt(observe);
const apks = positionals.length ? positionals : corpusApks();

interface Row {
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
  processes?: ProcessSnapshot[];
  browserErrors?: string[];
}

const browser = await launchBrowser();

async function boot(page: Page, apk: string): Promise<Row> {
  const row: Row = { apk, ok: false, ticks: 0, bootMs: 0, classes: 0, missing: [], nativeRequired: [], errors: [], diagnostics: "unavailable", note: "" };
  const errors = pageErrors(page);
  try {
    await openWebdroid(page);
    row.ok = await bootApp(page, apk, { ms: waitMs }).then(() => true, (e: Error) => { row.note = e.message.slice(0, 160); return false; });
    await page.waitForTimeout(observeMs);
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
  const available = relevant.flatMap((process) => process.diagnostics.status === "ok" ? [process.diagnostics] : []);
  row.diagnostics = relevant.length > 0 && relevant.every((process) => diagnosed(process.diagnostics)) ? "ok" : "unavailable";
  row.missing = [...new Set([...row.missing, ...available.flatMap((diagnostics) => diagnostics.missing)])];
  row.nativeRequired = [...new Set(available.flatMap((diagnostics) => diagnostics.native))];
  row.errors = [...new Set([...row.errors, ...errors, ...diagnosticErrors(relevant)])];
  row.browserErrors = errors;
  return row;
}

const rows = await runQueue(apks, jobsOf(jobs, 2), () => 0, async (apk) => {
  const page = await browser.newPage(CONTEXT_OPTS);
  const row = await boot(page, apk);
  await page.close();
  console.log(`${row.ok ? "draw" : "FAIL"} ${apk.padEnd(28)} ${String(row.classes).padStart(7)} classes  boot ${String(Math.round(row.bootMs)).padStart(5)}ms  ${row.missing.length} missing  ${row.nativeRequired.length} native  ${row.errors.length} errors  diagnostics ${row.diagnostics}${row.note ? "  " + row.note : ""}`);
  return row;
});
await browser.close();

const booted = rows.filter((r) => r.ok).length;
console.log(`\n${booted}/${rows.length} rendered a frame`);

function rank(field: "missing" | "nativeRequired"): [string, string[]][] {
  const reached = new Map<string, string[]>();
  for (const row of rows) for (const key of row[field]) {
    const apks = reached.get(key) ?? [];
    apks.push(row.apk);
    reached.set(key, apks);
  }
  return [...reached].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

const ranked = rank("missing"), rankedNative = rank("nativeRequired");
for (const [title, items] of [["missing APIs", ranked], ["native requirements", rankedNative]] as const) {
  console.log(`\n=== ${items.length} distinct ${title}, by how many apks reach them`);
  for (const [key, apks] of items.slice(0, 40)) console.log(`  ${String(apks.length).padStart(2)}/${rows.length}  ${key}`);
}

if (out) {
  writeFileSync(out, JSON.stringify({ rows, ranked, rankedNative }, null, 1));
  console.log(`\nwrote ${out}`);
}
