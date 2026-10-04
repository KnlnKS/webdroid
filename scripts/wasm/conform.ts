// The conformance suites (scripts/conform) on the Wasm tier against their baselines tests/conformance/<suite>.json, with the JS tier's run of every class beside it.
// Each class runs in its own process on each tier (a class that never yields is killed, not waited for).
//   bun run wasm conform <suite|quick> [class-substring | --test name-substring] [--no-js] [--jobs n]
// A test that passes in the baseline and fails on the Wasm tier is a regression. A test the two tiers answer differently is a divergence: it must be pinned in
// tests/conformance/wasm-pins.json with its mechanism (the JS tier is wrong, or a limit the Wasm tier has), or the run fails it as unexplained, and a pin that
// no longer diverges is stale. A pin is a class regex, a test-name regex and a `why`; with `skipped` (a regex) it covers only the tests of methods the Wasm
// tier's runner skipped for a reason that matches. A `flaky` pin names tests whose result depends on timing and varies from run to run on both tiers: it is never stale.
import { existsSync } from "node:fs";
import { prepare } from "../conform/prepare";
import { hash, parseLines, type Outcome } from "../conform/results";
import { SUITES } from "../conform/suites";
import { consume } from "../args";
import { bundleForNode } from "./undernode";

/** a few classes of each kind of suite, in seconds: collections, time, util, concurrency, io */
const QUICK: [suite: string, classMatch: string][] = [
  ["guava", "TestsForQueuesInJavaUtil"], ["ojluni-time", "TCKDayOfWeek"], ["luni-util", "libcore.java.util.OptionalTest"], ["jsr166", "AtomicIntegerTest"], ["luni-io", "ByteArrayOutputStreamTest"],
];
const PINS_PATH = "tests/conformance/wasm-pins.json";
const CLASS_TIMEOUT_MS = Number(process.env.CONFORM_TIMEOUT ?? 600_000);
type Pins = Record<string, { class: string; test: string; skipped?: string; flaky?: boolean; why: string }[]>;

const args = process.argv.slice(2);
const { flag, option } = consume(args);
const withJs = !flag("--no-js"), jobs = Number(option("--jobs") ?? 4), testFilter = option("--test") ?? "";
const [target, match = ""] = args;
const plan: [string, string][] = target === "quick" ? QUICK : target in SUITES ? [[target, match]] : [];
if (!plan.length) { console.error(`usage: bun run wasm conform <${Object.keys(SUITES).join("|")}|quick> [class-substring] [--test name] [--no-js] [--jobs n]`); process.exit(2); }

const wasmCommand = await bundleForNode(`${import.meta.dir}/conformone.ts`, []);
const jsCommand = ["bun", `${import.meta.dir}/../conform/run.ts`];

/** one class on one tier: the lines it answers, or why it answered none */
async function runClass(command: string[], cls: string): Promise<{ tests: Map<string, Outcome>; skipped: Map<string, string>; seconds: number }> {
  const t0 = performance.now();
  const proc = Bun.spawn([...command, ...(testFilter ? [testFilter] : [])], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), CLASS_TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  if (process.env.CONFORM_DEBUG && err) console.log([...new Set(err.split("\n"))].join("\n"));
  const marker = out.indexOf("\u0001");
  const why = proc.signalCode ? `killed after ${CLASS_TIMEOUT_MS / 1000}s` : `no result: ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;
  return { ...parseLines(marker >= 0 ? out.slice(marker + 1) : `F\t${cls}\t${why}\n`), seconds: (performance.now() - t0) / 1000 };
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
const totals = { js: 0, wasm: 0, tests: 0, baseline: 0 };
for (const [suiteName, classMatch] of plan) {
  const { suite, classes, dexDir } = await prepare(suiteName), runner = suite.testng ? "NgRunner" : "ConformRunner";
  const selected = classMatch ? classes.filter((c) => c.includes(classMatch)) : classes;
  const baseline: Record<string, string[]> = existsSync(`tests/conformance/${suiteName}.json`) ? await Bun.file(`tests/conformance/${suiteName}.json`).json() : {};
  const wasm = new Map<string, Map<string, Outcome>>(), js = new Map<string, Map<string, Outcome>>(), skipped = new Map<string, Map<string, string>>();
  const seconds = { wasm: 0, js: 0 }, started = performance.now();
  const work = selected.flatMap((cls) => [[cls, "wasm"] as const, ...(withJs ? [[cls, "js"] as const] : [])]);
  await pool(work, async ([cls, tier]) => {
    const r = await runClass(tier === "wasm" ? [...wasmCommand, dexDir, runner, cls] : [...jsCommand, suiteName, "--one", cls], cls);
    (tier === "wasm" ? wasm : js).set(cls, r.tests);
    if (tier === "wasm") skipped.set(cls, r.skipped);
    seconds[tier] += r.seconds;
    const pass = [...r.tests.values()].filter((o) => o.ok).length;
    const note = r.skipped.size ? `, ${r.skipped.size} skipped: ${[...r.skipped.values()][0]}` : "";
    console.log(`  ${tier.padEnd(4)} ${cls}: ${pass} pass, ${r.tests.size - pass} fail${note} (${r.seconds.toFixed(1)}s)${r.tests.has(cls) ? ` class failed: ${r.tests.get(cls)!.message}` : ""}`);
  });

  const rules = (pins[suiteName] ?? []).map((p) => ({ ...p, cls: new RegExp(p.class), test: new RegExp(p.test), skipped: p.skipped ? new RegExp(p.skipped) : null, hits: 0 }));
  let wasmPass = 0, jsPass = 0, tests = 0, before = 0;
  const regressions: string[] = [], unexplained: string[] = [];
  for (const cls of selected) {
    const w = wasm.get(cls)!, j = js.get(cls), passed = new Set(baseline[cls] ?? []), explained = new Set<string>(), skips = skipped.get(cls)!;
    // a pin names a mechanism; one that is a skip applies to the tests of the methods the Wasm tier skipped for that reason
    const pinOf = (name: string) => {
      const stem = name.slice(0, name.search(/[[(]/)), reason = [...skips].find(([n]) => n.slice(0, n.search(/[[(]/)) === stem)?.[1];
      return rules.find((r) => r.cls.test(cls) && r.test.test(name) && (!r.skipped || (reason !== undefined && r.skipped.test(reason))));
    };
    before += passed.size;
    for (const o of w.values()) { tests++; if (o.ok) wasmPass++; }
    for (const name of new Set([...w.keys(), ...(j?.keys() ?? [])])) {
      const wo = w.get(name), jo = j?.get(name);
      if (jo?.ok) jsPass++;
      if (j && !!wo?.ok !== !!jo?.ok) {
        const rule = pinOf(name);
        if (rule) { rule.hits++; explained.add(hash(name)); }
        else unexplained.push(`${cls}: ${name}  wasm ${wo ? (wo.ok ? "passes" : `fails (${wo.message.slice(0, 200)})`) : "does not run it"}, js ${jo ? (jo.ok ? "passes" : "fails") : "does not run it"}`);
      }
      // a test the baseline passes and the JS tier fails too is the baseline's drift, not the Wasm tier's
      if (wo && !wo.ok && passed.has(hash(name)) && !explained.has(hash(name)) && !(jo && !jo.ok)) regressions.push(`${cls}: ${name}  ${wo.message.slice(0, 200)}`);
    }
    // a baseline test the JS tier no longer runs either is the baseline's drift
    const ran = new Set([...w.keys(), ...(j?.keys() ?? [])].map(hash)), vanished = [...passed].filter((h) => !ran.has(h) && !explained.has(h)).length;
    if (vanished && !testFilter) regressions.push(`${cls}: ${vanished} passing tests no longer ran`);
  }
  for (const r of rules) if (!r.hits && !r.flaky && !classMatch && !testFilter && withJs) unexplained.push(`pin ${r.class} ${r.test}  matches no divergence any more`);
  totals.wasm += wasmPass; totals.js += jsPass; totals.tests += tests; totals.baseline += before;
  const pinned = rules.reduce((n, r) => n + r.hits, 0);
  console.log(`${suiteName}: wasm ${wasmPass}/${tests}${withJs ? `, js ${jsPass}` : ""}, baseline ${before}; ${regressions.length} regressions, ${pinned} pinned divergences, ` +
    `${unexplained.length} unexplained (${((performance.now() - started) / 1000).toFixed(0)}s wall, ${seconds.wasm.toFixed(0)}s wasm${withJs ? ` ${seconds.js.toFixed(0)}s js` : ""})`);
  for (const r of grouped(regressions)) console.log(`  regressed ${r}`);
  for (const r of grouped(unexplained)) console.log(`  diverges ${r}`);
  failed ||= regressions.length > 0 || unexplained.length > 0;
}
if (plan.length > 1) console.log(`total: wasm ${totals.wasm}/${totals.tests}${withJs ? `, js ${totals.js}` : ""}, baseline ${totals.baseline}`);
process.exit(failed ? 1 : 0);
