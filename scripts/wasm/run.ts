// The Wasm backend's suites: bun run wasm <suite> [args], or `all`. They need javac, d8 and java (and the Android SDK for jbench and g1) on PATH.
// Most run under node because Reflection.getCallerClass and stack symbolisation read V8's wasm frames, which Bun's JavaScriptCore lacks.
//   diff         every static method of the W, S and N fixtures as Wasm, on the JS tier and on the JDK
//   libdiff      primitive-only static methods of the AOSP libraries, Wasm against the JS tier
//   classdiff    class initialisation and the class model against the JS tier and the JDK
//   customdiff   invoke-custom and MethodHandle call sites
//   linkdiff     unresolved references fail at their use site as ART does
//   lazytest     CHA undone by a later dex, implicit exceptions, heap limits, the tiers
//   aottest      precompiled platform code stays sound as classes arrive (builds a platform AOT first unless WEBDROID_AOT names one)
//   entry        host code calls Java through jentry on the JS tier, over a World and (entrytier) through ?tier=wasm: the same answers and exceptions
//   fuzz         random verifiable methods as Wasm, on the JS tier and on the JDK (seeds 1 to 6 unless arguments are given)
//   jbench       the scripts/jbench workloads, Wasm against the JS tier
//   sweep        every method of the boot jars and FitNotes compiled alone, failures by cause
//   g1           the jbench workloads timed in node and headless Chrome (not part of `all`)
// Tools: watdump prints the code generated for a method, aot-build writes the AOT assets of the platform jars, aot-startup the module list a start of the process loads.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnderNode } from "./undernode";

interface Suite { node: boolean; all: boolean }
const SUITES: Record<string, Suite> = {
  diff: { node: true, all: true }, libdiff: { node: true, all: true }, classdiff: { node: true, all: true }, customdiff: { node: true, all: true },
  linkdiff: { node: true, all: true }, entry: { node: true, all: true }, entrytier: { node: true, all: false }, lazytest: { node: false, all: true }, fuzz: { node: true, all: true }, jbench: { node: true, all: true },
  sweep: { node: false, all: true }, aottest: { node: true, all: true }, g1: { node: false, all: false }, watdump: { node: false, all: false },
  "aot-build": { node: true, all: false }, "aot-startup": { node: true, all: false },
};
const FUZZ_SEEDS = [1, 2, 3, 4, 5, 6];

type Env = Record<string, string | undefined>;
async function exec(name: string, args: string[], env: Env): Promise<number> {
  const file = join(import.meta.dir, name + ".ts");
  if (SUITES[name].node) return runUnderNode(file, args, env);
  return Bun.spawnSync(["bun", file, ...args], { stdio: ["inherit", "inherit", "inherit"], env }).exitCode ?? 1;
}

async function runSuite(name: string, args: string[]): Promise<number> {
  if (name === "fuzz" && !args.length) {
    let status = 0;
    for (const seed of FUZZ_SEEDS) status ||= await exec(name, ["--seed", String(seed)], process.env);
    return status;
  }
  if (name === "entry") {
    const dir = mkdtempSync(join(tmpdir(), "wasm-entry-out-")), env = { ...process.env, WASM_ENTRY_OUT: join(dir, "tier.json") };
    try { return (await exec(name, args, env)) || await exec("entrytier", [], { ...env, WEBDROID_TIER: "wasm" }); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (name !== "aottest" || process.env.WEBDROID_AOT) return exec(name, args, process.env);
  const dir = mkdtempSync(join(tmpdir(), "wasm-aot-"));
  try {
    return (await exec("aot-build", ["--out", dir], process.env)) || await exec(name, args, { ...process.env, WEBDROID_AOT: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const [name, ...args] = process.argv.slice(2);
if (name !== "all" && !(name in SUITES)) {
  console.error(`usage: bun run wasm <${[...Object.keys(SUITES), "all"].join("|")}> [args]`);
  process.exit(2);
}
if (name !== "all") process.exit(await runSuite(name, args));
const results: [string, number, number][] = [];
for (const suite of Object.keys(SUITES).filter((s) => SUITES[s].all)) {
  console.log(`\n=== ${suite}`);
  const t0 = performance.now();
  results.push([suite, await runSuite(suite, []), (performance.now() - t0) / 1000]);
}
console.log("\n" + results.map(([s, status, secs]) => `${status ? "FAIL" : "ok  "} ${s.padEnd(11)} ${secs.toFixed(0)} s`).join("\n"));
process.exit(results.some(([, status]) => status) ? 1 : 0);
