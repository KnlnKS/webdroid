// Each scripts/jbench workload, cut out of Bench.java as its own static method, runs lazily compiled over the AOSP boot dex and must answer as
// scripts/jbench/expected.json records: only the methods a workload executes are compiled, and the first construct the compiler has no translation for is reported.
// Needs the Android SDK (android.jar, d8) and javac. Run from the repository root: pnpm wasm jbench [workload ...] [-v]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { program, world } from "./lib.ts";
import { mountPlatform, natives, startProcess } from "./harness.ts";
import { PLATFORM_PATHS, ROOT } from "./paths.ts";
import { cutWorkloads } from "./tools.ts";
import { androidFixture, tempDir } from "../java.ts";

const text = readFileSync(join(ROOT, "scripts/jbench/Bench.java"), "utf8"), expected = JSON.parse(readFileSync(join(ROOT, "scripts/jbench/expected.json"), "utf8")) as Record<string, number>, out = tempDir();
const verbose = process.argv.includes("-v"), only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const { names, source } = cutWorkloads(text);
writeFileSync(join(out, "Bench.java"), source);
androidFixture({ out, sources: [join(out, "Bench.java")] });

const dex = join(out, "classes.dex"), prog = program([dex, ...PLATFORM_PATHS]);
await mountPlatform(ROOT);
const todo = names.filter((n) => !only.length || only.includes(n));

// a fresh World per workload: its state (class initialisers cut short by a gap) must not leak into the next, and the numbers are cold-start costs
const tally = { MATCH: 0, DIFF: 0, BLOCKED: 0 };
const total = { methods: 0, units: 0, compileMs: 0, instantiateMs: 0, classes: 0, classMs: 0 };
console.log(`${"workload".padEnd(15)} ${"wasm".padStart(10)} ${"expected".padStart(10)}  status`);
for (const name of todo) {
  let got: string, hit: string[] = [];
  const want = String(expected[name]);
  const w = world(prog, { natives });
  w.onGap = (gap) => hit.push(gap);
  await startProcess(w);
  const t0 = performance.now();
  try { got = String(await w.entryAsync("Bench", `w_${name}`, "()I")()); } catch (e) {
    got = "trap";
    const t = w.throwable(e);
    if (verbose && !hit.length) console.log("   ", t ? "uncaught " + w.classNameOf(t) : String(e).slice(0, 200));
  }
  const ms = performance.now() - t0;
  for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += w.stats[k];
  const status = got === want ? "MATCH" : hit.length ? "BLOCKED" : "DIFF";
  tally[status]++;
  console.log(`${name.padEnd(15)} ${(status === "BLOCKED" ? "-" : got).padStart(10)} ${want.padStart(10)}  ${status.padEnd(7)} ${String(w.stats.methods).padStart(4)} methods ${ms.toFixed(0).padStart(5)} ms${status === "BLOCKED" ? `  first gap: ${hit[0]}` : ""}`);
  if (status === "DIFF") process.exitCode = 1;
}
console.log(`${tally.MATCH} MATCH, ${tally.DIFF} DIFF, ${tally.BLOCKED} BLOCKED of ${todo.length}`);
console.log(`total: ${total.methods} methods compiled in ${total.compileMs.toFixed(0)} ms (instantiate ${total.instantiateMs.toFixed(0)} ms), ${total.classes} class modules (${total.classMs.toFixed(0)} ms)`);
process.exit();
