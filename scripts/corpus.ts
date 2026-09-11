// Boot every apk in the tree headlessly and rank the gaps by how many apks they block.
//   bun run corpus [apk ...] [--json out.json] [--wait ms]      (needs `bun run dev`)
import { type Page } from "playwright";
import { readdirSync } from "node:fs";
import { argv } from "./args";
import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser, CONTEXT_OPTS } from "../tests/e2e/drivers/webdroid";

const args = process.argv.slice(2);
const { opt, positional } = argv(args, ["--json", "--wait"]);
const waitMs = parseInt(opt("--wait", "12000")!);
const apks = positional.length ? positional : readdirSync("apks").filter((f) => /\.x?apk$/.test(f)).sort();

interface Row {
  apk: string;
  ok: boolean;
  ticks: number;
  drew: boolean;
  bootMs: number;
  classes: number;
  missing: string[];
  errors: string[];
  note: string;
}

const browser = await launchBrowser();
const rows: Row[] = [];

async function boot(page: Page, apk: string): Promise<Row> {
  const row: Row = { apk, ok: false, ticks: 0, drew: false, bootMs: 0, classes: 0, missing: [], errors: [], note: "" };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  try {
    await page.goto(`${BASE_URL}/?apk=${encodeURIComponent(apk)}`, { waitUntil: "load", timeout: 60000 });
    // a frame having been drawn is the only evidence that matters; ticks alone can spin on a
    // shell that never got an activity up
    await page.waitForFunction("window.wd && window.wd.perf.draws > 0", null, { timeout: waitMs }).catch(() => {});
    await page.waitForTimeout(1500);
    const s = await page.evaluate(`(() => {
      const w = window.wd;
      return { ticks: w.ticks, draws: w.perf.draws, bootMs: w.perf.bootMs, classes: w.perf.classesCompiled,
               missing: [...w.rt.missing], logs: (w.logs || []).filter(l => /error|Error/.test(l)).slice(-6) };
    })()`) as { ticks: number; draws: number; bootMs: number; classes: number; missing: string[]; logs: string[] };
    row.ticks = s.ticks; row.drew = s.draws > 0; row.bootMs = s.bootMs; row.classes = s.classes;
    row.missing = s.missing; row.errors = [...errors, ...s.logs].slice(0, 6);
    row.ok = row.drew;
  } catch (e) {
    row.note = String(e).split("\n")[0].slice(0, 160);
    row.errors = errors.slice(0, 6);
  }
  return row;
}

for (const apk of apks) {
  const page = await browser.newPage(CONTEXT_OPTS);
  const row = await boot(page, apk);
  await page.close();
  rows.push(row);
  console.log(`${row.ok ? "ok  " : "FAIL"} ${apk.padEnd(28)} ${String(row.classes).padStart(7)} classes  boot ${String(row.bootMs).padStart(5)}ms  ${row.missing.length} missing${row.note ? "  " + row.note : ""}`);
}
await browser.close();

const booted = rows.filter((r) => r.ok).length;
console.log(`\n${booted}/${rows.length} rendered a frame`);

// rank a gap by how many apks it blocks, not by how often one apk asks
const blocks = new Map<string, string[]>();
for (const r of rows) for (const m of r.missing) {
  const l = blocks.get(m) ?? [];
  l.push(r.apk);
  blocks.set(m, l);
}
const ranked = [...blocks].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
console.log(`\n=== ${ranked.length} distinct gaps, by how many apks reach them`);
for (const [m, who] of ranked.slice(0, 40)) console.log(`  ${String(who.length).padStart(2)}/${rows.length}  ${m}`);

const out = args.includes("--json") ? opt("--json", "") : "";
if (out) {
  await Bun.write(out, JSON.stringify({ rows, ranked: ranked.map(([m, w]) => [m, w]) }, null, 1));
  console.log(`\nwrote ${out}`);
}
