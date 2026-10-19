// Boot every apk in the tree headlessly and rank the gaps by how many apks they block.
//   pnpm corpus [apk ...] [--json out.json] [--wait ms] [--observe ms]
import { writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { argv } from "./args.ts";
import { corpusApks } from "./apk-corpus.ts";
import { CONTEXT_OPTS, launchBrowser, webdroidUrl } from "./browser.ts";
import { readProcesses, type ProcessSnapshot } from "../tests/e2e/lib/processes.ts";

const args = process.argv.slice(2);
const { opt, positional } = argv(args, ["--json", "--wait", "--observe"]);
const waitMs = parseInt(opt("--wait", "12000")!);
const observeMs = parseInt(opt("--observe", "1500")!);
const apks = positional.length ? positional : corpusApks();

interface Row {
  apk: string;
  ok: boolean;
  ticks: number;
  drew: boolean;
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
const rows: Row[] = [];

async function boot(page: Page, apk: string): Promise<Row> {
  const row: Row = { apk, ok: false, ticks: 0, drew: false, bootMs: 0, classes: 0, missing: [], nativeRequired: [], errors: [], diagnostics: "unavailable", note: "" };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.location().url}: ${message.text()}`); });
  try {
    const url = webdroidUrl(); url.searchParams.set("apk", apk);
    await page.goto(url.href, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!globalThis.wd, null, { timeout: waitMs });
    await page.evaluate(file => { void globalThis.wd!.boot(file); }, apk);
    const readRender = () => page.evaluate(async () => {
      const w = globalThis.wd!, foreground = (await w.foregroundWorkerSnapshot?.())?.snapshot, perf = foreground?.perf ?? w.perf;
      return { ticks: foreground?.ticks ?? w.ticks, draws: perf.draws, bootMs: w.perf.bootMs, classes: perf.wasmClasses,
        missing: [...w.rt.missing], logs: (w.logs || []).filter((line: string) => /error/i.test(line)).slice(-6) };
    });
    const deadline = Date.now() + waitMs;
    let s = await readRender();
    while (!s.draws && Date.now() < deadline) {
      await page.waitForTimeout(100);
      s = await readRender();
    }
    if (!s.draws) row.note = `no rendered frame within ${waitMs}ms`;
    await page.waitForTimeout(observeMs);
    s = await readRender();
    row.ticks = s.ticks; row.drew = s.draws > 0; row.bootMs = s.bootMs; row.classes = s.classes;
    row.missing = s.missing; row.errors = s.logs;
    row.ok = row.drew;
  } catch (e) {
    row.note = String(e).split("\n")[0].slice(0, 160);
  }
  const relevant = row.processes = await readProcesses(page);
  const available = relevant.flatMap((process) => process.diagnostics.status === "ok" ? [process.diagnostics] : []);
  row.diagnostics = relevant.length > 0 && relevant.every(process => ["ok", "exited"].includes(process.diagnostics.status)) ? "ok" : "unavailable";
  row.missing = [...new Set([...row.missing, ...available.flatMap((diagnostics) => diagnostics.missing)])];
  row.nativeRequired = [...new Set(available.flatMap((diagnostics) => diagnostics.native))];
  const diagnosticErrors = relevant.flatMap((process) => process.diagnostics.status === "ok"
    ? process.diagnostics.errors ?? []
    : process.diagnostics.status === "exited" ? []
    : [process.diagnostics.status === "failure" ? process.diagnostics.message : "diagnostics unavailable"]);
  row.errors = [...new Set([...row.errors, ...errors, ...diagnosticErrors])];
  row.browserErrors = errors;
  return row;
}

for (const apk of apks) {
  const page = await browser.newPage(CONTEXT_OPTS);
  const row = await boot(page, apk);
  await page.close();
  rows.push(row);
  console.log(`${row.ok ? "draw" : "FAIL"} ${apk.padEnd(28)} ${String(row.classes).padStart(7)} classes  boot ${String(row.bootMs).padStart(5)}ms  ${row.missing.length} missing  ${row.nativeRequired.length} native  ${row.errors.length} errors  diagnostics ${row.diagnostics}${row.note ? "  " + row.note : ""}`);
}
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

const out = opt("--json");
if (out) {
  writeFileSync(out, JSON.stringify({ rows, ranked, rankedNative }, null, 1));
  console.log(`\nwrote ${out}`);
}
