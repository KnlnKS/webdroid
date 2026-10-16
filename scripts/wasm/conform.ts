// The conformance suites (scripts/conform) on the Wasm tier against their baselines tests/conformance/<suite>.json, which hold a hash of every passing test's name per class.
// Each class runs in its own process (a class that never yields is killed, not waited for).
//   bun run conform <suite|quick> [class-substring | --test name-substring] [--update] [--jobs n] [--out directory]
// A baseline test that fails or no longer runs is a regression, unless tests/conformance/wasm-pins.json pins it (a class regex, a test-name regex and a `why`).
// A pin that matches no failure is stale, except a `flaky` one, whose result depends on timing. --update rewrites a whole suite's baseline from this run.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "../conform/prepare.ts";
import { hash, parseLines, type Outcome } from "../conform/results.ts";
import { SUITES } from "../conform/suites.ts";
import { consume } from "../args.ts";
import { bundleForNode } from "./undernode.ts";
import { arrayProviderFailures, classSetupFailures } from "./conform-coverage.ts";

/** a few classes of each kind of suite, in seconds: collections, time, util, concurrency, io */
const QUICK: [suite: string, classMatch: string][] = [
  ["guava", "TestsForQueuesInJavaUtil"], ["ojluni-time", "TCKDayOfWeek"], ["luni-util", "libcore.java.util.OptionalTest"], ["jsr166", "AtomicIntegerTest"], ["luni-io", "ByteArrayOutputStreamTest"],
];
const PINS_PATH = "tests/conformance/wasm-pins.json";
const CLASS_TIMEOUT_MS = Number(process.env.CONFORM_TIMEOUT ?? 600_000);
type Pins = Record<string, { class: string; test: string; flaky?: boolean; why: string }[]>;

const args = process.argv.slice(2);
const { flag, option } = consume(args);
const update = flag("--update"), jobs = Number(option("--jobs") ?? 4), testFilter = option("--test") ?? "", outputDir = option("--out");
const [target, match = ""] = args;
const plan: [string, string][] = target === "quick" ? QUICK : target in SUITES ? [[target, match]] : [];
if (!plan.length) { console.error(`usage: bun run conform <${Object.keys(SUITES).join("|")}|quick> [class-substring] [--test name] [--update] [--jobs n] [--out directory]`); process.exit(2); }

const command = await bundleForNode(`${import.meta.dir}/conformone.ts`, []);

/** one class: the lines it answers, or why it answered none */
async function runClass(args: string[], cls: string): Promise<{ tests: Map<string, Outcome>; skipped: Map<string, string>; seconds: number; executions: { pass: number; fail: number; skipped: number } }> {
  const t0 = performance.now();
  // CONFORM_DEBUG asks the child for its gaps and the natives that waited
  const proc = Bun.spawn([...command, ...args, ...(testFilter ? [testFilter] : [])], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), CLASS_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  if (process.env.CONFORM_DEBUG && err) console.log([...new Set(err.split("\n"))].join("\n"));
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    await Bun.write(join(outputDir, `${cls}.txt`), out);
  }
  const marker = out.indexOf("\u0001");
  const why = proc.signalCode ? `killed after ${CLASS_TIMEOUT_MS / 1000}s` : `no result: ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
  const lines = marker >= 0 ? out.slice(marker + 1) : `F\t${cls}\t${why}\n`;
  const executions = { pass: 0, fail: 0, skipped: 0 };
  for (const line of lines.split("\n")) {
    if (line.startsWith("P\t")) executions.pass++;
    else if (line.startsWith("F\t")) executions.fail++;
    else if (line.startsWith("S\t")) executions.skipped++;
  }
  return { ...parseLines(lines), executions, seconds: (performance.now() - t0) / 1000 };
}
async function pool<T>(items: T[], f: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await f(queue.shift()!); }));
}

/** findings counted by test method and reason, with the first of each as the example (parameters and the numbers in a message vary within a group) */
function grouped(lines: string[]): string[] {
  const groups = new Map<string, { n: number; first: string }>();
  for (const l of lines) {
    const key = l.replace(/\[.*?\]\(/, "(").replace(/\d+/g, "#");
    const g = groups.get(key);
    if (g) g.n++; else groups.set(key, { n: 1, first: l });
  }
  return [...groups.values()].slice(0, 40).map((g) => `${g.n > 1 ? `x${g.n} ` : ""}${g.first}`);
}
const pins: Pins = existsSync(PINS_PATH) ? await Bun.file(PINS_PATH).json() : {};
let failed = false;
const totals = { pass: 0, tests: 0, baseline: 0 };
for (const [suiteName, classMatch] of plan) {
  const { suite, classes, dexDir } = await prepare(suiteName), runner = suite.testng ? "NgRunner" : "ConformRunner";
  const selected = classMatch ? classes.filter((c) => c.includes(classMatch)) : classes;
  const baselinePath = `tests/conformance/${suiteName}.json`;
  const baseline: Record<string, string[]> = existsSync(baselinePath) ? await Bun.file(baselinePath).json() : {};
  const results = new Map<string, Map<string, Outcome>>(), skipped = new Map<string, Map<string, string>>();
  const executions = { pass: 0, fail: 0, skipped: 0 };
  let seconds = 0;
  const started = performance.now();
  await pool(selected, async (cls) => {
    const r = await runClass([dexDir, runner, cls], cls);
    results.set(cls, r.tests);
    skipped.set(cls, r.skipped);
    executions.pass += r.executions.pass;
    executions.fail += r.executions.fail;
    executions.skipped += r.executions.skipped;
    seconds += r.seconds;
    const note = r.executions.skipped ? `, ${r.executions.skipped} skipped: ${[...r.skipped.values()][0]}` : "";
    console.log(`  ${cls}: ${r.executions.pass} pass, ${r.executions.fail} fail${note} (${r.seconds.toFixed(1)}s)${r.tests.has(cls) ? ` class failed: ${r.tests.get(cls)!.message}` : ""}`);
  });

  const rules = (pins[suiteName] ?? []).map((p) => ({ ...p, cls: new RegExp(p.class), test: new RegExp(p.test), hits: 0 }));
  let pass = 0, tests = 0, before = 0;
  const regressions: string[] = [];
  for (const cls of selected) {
    const r = results.get(cls)!, passed = new Set(baseline[cls] ?? []);
    const pinned = (name: string) => { const rule = rules.find((p) => p.cls.test(cls) && p.test.test(name)); if (rule) rule.hits++; return !!rule; };
    regressions.push(...arrayProviderFailures(cls, skipped.get(cls)!));
    if (!testFilter) regressions.push(...classSetupFailures(cls, r, passed.size));
    before += passed.size;
    for (const [name, o] of r) {
      tests++;
      if (o.ok) pass++;
      else if (passed.has(hash(name)) && !pinned(name)) regressions.push(`${cls}: ${name}  ${o.message.slice(0, 200)}`);
    }
    const ran = new Set([...r.keys()].map(hash)), vanished = [...passed].filter((h) => !ran.has(h)).length;
    if (vanished && !testFilter) regressions.push(`${cls}: ${vanished} passing tests no longer ran`);
  }
  const stale = classMatch || testFilter ? [] : rules.filter((r) => !r.hits && !r.flaky);
  totals.pass += pass; totals.tests += tests; totals.baseline += before;
  console.log(`${suiteName}: ${pass}/${tests}, baseline ${before}; ${regressions.length} regressions, ${rules.reduce((n, r) => n + r.hits, 0)} pinned failures, ` +
    `${stale.length} stale pins (${((performance.now() - started) / 1000).toFixed(0)}s wall, ${seconds.toFixed(0)}s in classes)`);
  console.log(`  executions: ${executions.pass + executions.fail}, ${executions.pass} pass, ${executions.fail} fail, ${executions.skipped} skipped (comparison above uses unique test names)`);
  for (const r of grouped(regressions)) console.log(`  regressed ${r}`);
  for (const r of stale) console.log(`  stale pin ${r.class} ${r.test}`);
  failed ||= regressions.length > 0 || stale.length > 0;
  if (update && !classMatch && !testFilter) await Bun.write(baselinePath, JSON.stringify(Object.fromEntries([...results].sort(([a], [b]) => a < b ? -1 : 1).map(([cls, r]) =>
    [cls, [...r].filter(([, o]) => o.ok).map(([name]) => hash(name)).sort()]))) + "\n");
}
if (plan.length > 1) console.log(`total: ${totals.pass}/${totals.tests}, baseline ${totals.baseline}`);
process.exit(failed ? 1 : 0);
