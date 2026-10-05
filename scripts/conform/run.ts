// Conformance suites run headless in Bun (docs/bytecode-first-plan.md §5.1):
//   bun run conform <suite> [filter] [--update] [--bytecode <prefix,...>]
// Each suite's jars are fetched once into conform-cache/, compiled to dex with d8 alongside
// ConformRunner, and run on the platform class path. Results are compared with the checked-in
// baseline tests/conformance/<suite>.json, which holds a hash of every passing test's name per
// class: one that passed there and fails now is a regression. --update rewrites it from this run;
// --bytecode serves those prefixes from platform bytecode instead of native specs, for A/B cuts.
import { existsSync, readdirSync } from "node:fs";
import { CACHE, prepare } from "./prepare";
import { hash, parseLines } from "./results";
import { SUITES } from "./suites";
import { consume } from "../args";

const [suiteName, ...rest] = process.argv.slice(2);
const { option } = consume(rest);
const cut = option("--bytecode"), one = option("--one");
const update = rest.includes("--update"), filter = rest.find((a) => !a.startsWith("--")) ?? "";
if (!SUITES[suiteName]) throw new Error(`bun run conform <${Object.keys(SUITES).join("|")}> [filter] [--update]`);

const { suite, classes, dexDir } = await prepare(suiteName);

// a child process runs one class, so a class that never yields can be killed rather than stall the suite
if (one) {
  // the runtime: suite dex ahead of the platform class path, natives linked after both
  if (cut) (await import("../../src/jvm/provenance")).BYTECODE.push(...cut.split(","));
  const { rt } = await import("../../src/jvm/runtime");
  await import("../../src/natives");
  const { dexesIn } = await import("../../src/jvm/dex");
  const { loadPlatformJar } = await import("../../src/android/framework");
  const { PLATFORM_JARS } = await import("../../src/jvm/provenance");
  const { vcallAsync, scall } = await import("../../src/jvm/natives/jentry");
  const { stackTraceText } = await import("../../src/jvm/natives/jthrowable");
  await (await import("../lib")).mountLocalPlatformData();
  for (const f of readdirSync(dexDir).filter((f) => f.endsWith(".dex")).sort())
    for (const d of dexesIn(new Uint8Array(await Bun.file(`${dexDir}/${f}`).arrayBuffer()), f)) rt.loadDex(d);
  for (const [i, jar] of PLATFORM_JARS.entries()) loadPlatformJar(new Uint8Array(await Bun.file(`vendor/aosp/${jar}`).arrayBuffer()), i);
  rt.linkNatives();
  // vogar's -Djava.io.tmpdir: the tests' scratch files go under the device's temporary directory
  await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "java.io.tmpdir", "/data/local/tmp");
  // the suite's resource roots answer Class.getResource* as the test's class path would
  const roots = (suite.source?.resources ?? []).map((r) => `${CACHE}/src/${suiteName}/${suite.source!.root}/${r}`);
  const resource = (name: string) => roots.map((r) => `${r}/${name}`).find((p) => existsSync(p) && !p.endsWith(".java"));
  if (roots.length) rt.classpathSource = {
    has: (name) => !!resource(name), names: () => [],
    entry: async (name) => { const p = resource(name); return p ? new Uint8Array(await Bun.file(p).arrayBuffer()) : null; },
  };
  const debug = process.env.CONFORM_DEBUG;
  console.warn = () => {};
  if (debug) rt.throwables = [];
  const runner = rt.link(suite.testng ? "NgRunner" : "ConformRunner");
  await rt.initClass(runner);
  let text: string;
  try { text = await vcallAsync(runner.ctor, "run", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", one, filter); }
  catch (e) { text = `F\t${one}\t${await vcallAsync(e, "toString", "()Ljava/lang/String;").catch(() => String(e))}\n`; }
  if (debug) for (const t of rt.throwables!) {
    const trace = await stackTraceText(t as never);
    if (new RegExp(debug).test(trace)) { console.error(trace.split("\n").slice(0, 14).join("\n")); break; }
  }
  await Bun.write(Bun.stdout, "\u0001" + text);
  process.exit(0);
}

/** per class, each test name and whether it passed */
const results: Record<string, Map<string, boolean>> = {};
const CLASS_TIMEOUT_MS = 240_000, JOBS = 4;
const started = performance.now();
// a filter naming classes runs just those classes; otherwise it selects tests by name
const named = filter ? classes.filter((c) => c.includes(filter)) : [];
const testFilter = named.length ? "" : filter;
async function runClass(cls: string): Promise<void> {
  const t0 = performance.now();
  const proc = Bun.spawn(["bun", import.meta.path, suiteName, "--one", cls, ...(testFilter ? [testFilter] : []), ...(cut ? ["--bytecode", cut] : [])],
    { stdout: "pipe", stderr: process.env.CONFORM_DEBUG ? "inherit" : "ignore" });
  const timer = setTimeout(() => proc.kill(), CLASS_TIMEOUT_MS);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  const marker = out.indexOf("\u0001");
  const text = marker >= 0 ? out.slice(marker + 1) : `F\t${cls}\t${proc.signalCode ? `killed after ${CLASS_TIMEOUT_MS / 1000}s` : "no result"}\n`;
  const tests = results[cls] = new Map();
  let pass = 0, fail = 0;
  for (const [name, { ok, message }] of parseLines(text).tests) {
    if (process.env.CONFORM_DEBUG && !ok) console.log(name, message);
    tests.set(name, ok);
    if (ok) pass++; else fail++;
  }
  console.log(`${cls}: ${pass} pass, ${fail} fail (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}
const queue = [...(named.length ? named : classes)];
await Promise.all(Array.from({ length: JOBS }, async () => { while (queue.length) await runClass(queue.shift()!); }));

const baselinePath = `tests/conformance/${suiteName}.json`;
const baseline: Record<string, string[]> = existsSync(baselinePath) ? await Bun.file(baselinePath).json() : {};
let passes = 0, total = 0, before = 0;
const regressions: string[] = [];
for (const [cls, tests] of Object.entries(results)) {
  const passed = new Set(baseline[cls] ?? []);
  before += passed.size;
  for (const [name, ok] of tests) {
    total++;
    if (ok) passes++;
    else if (passed.has(hash(name))) regressions.push(`${cls}: ${name}`);
  }
  // a baseline pass that no longer runs at all (a suite that failed to build) regressed too
  const ran = new Set([...tests.keys()].map(hash));
  const vanished = [...passed].filter((h) => !ran.has(h)).length;
  if (vanished && !filter) regressions.push(`${cls}: ${vanished} passing tests no longer ran`);
}
console.log(`${suiteName}: ${passes}/${total} pass in ${((performance.now() - started) / 1000).toFixed(1)}s; ` +
  `baseline ${before} pass, ${regressions.length} regressions`);
for (const r of regressions.slice(0, 40)) console.log(`  regressed ${r}`);
if (update && !filter) await Bun.write(baselinePath, JSON.stringify(Object.fromEntries(Object.entries(results).sort().map(([cls, tests]) =>
  [cls, [...tests].filter(([, ok]) => ok).map(([name]) => hash(name)).sort()]))) + "\n");
process.exit(regressions.length ? 1 : 0);
