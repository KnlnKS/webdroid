// The Wasm backend's suites: bun run wasm <suite> [args], or `all`. They need javac, d8 and java (and the Android SDK for jbench and g1) on PATH.
// Most run under node because Reflection.getCallerClass and stack symbolisation read V8's wasm frames, which Bun's JavaScriptCore lacks.
//   diff         every static method of the W, S and N fixtures as Wasm and on the JDK
//   classdiff    class initialisation and the class model against the JDK
//   customdiff   invoke-custom and MethodHandle call sites
//   linkdiff     unresolved references fail at their use site as ART does
//   loaders      two DexClassLoaders defining one class name: distinct classes, statics and Class objects, found each through its own loader
//   lazytest     CHA undone by a later dex, implicit exceptions, heap limits, the tiers
//   aottest      precompiled platform code stays sound as classes arrive (builds a platform AOT first unless WEBDROID_AOT names one)
//   persist      the compile worker (second-tier units made elsewhere, adopted while the numbering holds), the app build attached to the platform build and the bounded store for it
//   entry        host code calls Java through jentry over a World and (entrytier) as a process does: the recorded answers and exceptions
//   hostclass    classes the host implements: Java objects and their host objects are one object, a bytecode subclass of one, the recorded answers (also over a platform build)
//   fuzz         random verifiable methods as Wasm and on the JDK (seeds 1 to 6 unless arguments are given)
//   jbench       the scripts/jbench workloads against their recorded results
//   nested       natives that enter Java, a thousand times in one entry (the engine's stacks)
//   threads      threads, monitors, parking, class initialization waits and natives that wait, on JSPI strands (Java cases against the JDK)
//   sweep        every method of the boot jars and FitNotes compiled alone, failures by cause
//   conform      the scripts/conform suites against their baselines: conform <suite|quick> [class] [--update]; conform-quick (a few classes of each kind) is in `all`
//   fwtest       the framework delegates of scripts/fwtest/ over a World (not part of `all`)
//   g1           the jbench workloads timed in node and headless Chrome (not part of `all`); g1startup writes the startup list of a build made with the G1 dex as its app
//   boot-probe   a headless Chrome page starts a process on the platform build: modules loaded and missed, synchronous requests (none allowed), compile time
//                (not part of `all`; needs a build from `bun run aot`)
// Tools: watdump prints the code generated for a method; `aot` (bun run aot) builds the platform assets under vendor/wasm-aot/<key> and the module list a start of the process
// loads (aot-build, then aot-startup), and makes that build the one the server offers. `aot-profile --classes`, `bun run aot`, `aot-profile` (in this order, with the server
// running) regroup the build by what launches of apps use and write its startup list.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AOT_ROOT, type AotManifest } from "./aot-key";
import { runUnderNode } from "./undernode";

interface Suite { node: boolean; all: boolean }
const SUITES: Record<string, Suite> = {
  diff: { node: true, all: true }, classdiff: { node: true, all: true }, customdiff: { node: true, all: true },
  linkdiff: { node: true, all: true }, loaders: { node: true, all: true }, entry: { node: true, all: true }, entrytier: { node: true, all: false }, hostclass: { node: true, all: true }, lazytest: { node: false, all: true }, fuzz: { node: true, all: true }, jbench: { node: true, all: true },
  threads: { node: true, all: true }, nested: { node: true, all: true }, conform: { node: false, all: false }, "conform-quick": { node: false, all: true }, fwtest: { node: true, all: false }, sweep: { node: false, all: true }, aottest: { node: true, all: true }, persist: { node: true, all: true }, g1: { node: false, all: false }, g1startup: { node: true, all: false }, g1app: { node: true, all: false }, watdump: { node: false, all: false },
  "aot-build": { node: true, all: false }, "aot-startup": { node: true, all: false }, "aot-profile": { node: false, all: false }, aot: { node: false, all: false }, "boot-probe": { node: false, all: false },
};
const FUZZ_SEEDS = [1, 2, 3, 4, 5, 6];

type Env = Record<string, string | undefined>;
async function exec(name: string, args: string[], env: Env): Promise<number> {
  const file = join(import.meta.dir, name + ".ts");
  if (SUITES[name].node) return runUnderNode(file, args, env);
  return Bun.spawnSync(["bun", file, ...args], { stdio: ["inherit", "inherit", "inherit"], env }).exitCode ?? 1;
}

/** builds the platform assets, records which of their modules a start loads and makes the build the current one */
async function buildAot(args: string[]): Promise<number> {
  const at = args.indexOf("--out"), keyed = at < 0;
  const status = await exec("aot-build", args, process.env);
  if (status) return status;
  const manifest = keyed ? JSON.parse(readFileSync(join(AOT_ROOT, "latest.json"), "utf8")) as AotManifest : undefined, dir = manifest ? join(AOT_ROOT, manifest.key) : args[at + 1];
  if (!existsSync(join(dir, "startup.json"))) {
    const startup = await exec("aot-startup", [], { ...process.env, WEBDROID_AOT: dir });
    if (startup) return startup;
  }
  if (manifest) {
    writeFileSync(join(AOT_ROOT, "current.json"), JSON.stringify(manifest));
    for (const old of readdirSync(AOT_ROOT).filter((f) => f !== manifest.key && !f.endsWith(".json"))) rmSync(join(AOT_ROOT, old), { recursive: true, force: true });
  }
  return 0;
}

async function runSuite(name: string, args: string[]): Promise<number> {
  if (name === "conform-quick") return exec("conform", ["quick"], process.env);
  if (name === "aot") return buildAot(args);
  if (name === "fuzz" && !args.length) {
    let status = 0;
    for (const seed of FUZZ_SEEDS) {
      const result = await exec(name, ["--seed", String(seed)], process.env);
      status ||= result;
    }
    return status;
  }
  if (name === "entry") return (await exec(name, args, process.env)) || exec("entrytier", [], process.env);
  if (name === "hostclass" && !process.env.WEBDROID_AOT && await exec(name, args, process.env)) return 1;
  if ((name !== "aottest" && name !== "persist" && name !== "hostclass") || process.env.WEBDROID_AOT) return exec(name, args, process.env);
  const dir = mkdtempSync(join(tmpdir(), "wasm-aot-"));
  try {
    return (await exec("aot-build", ["--out", dir, "--jars", "4"], process.env)) || await exec(name, args, { ...process.env, WEBDROID_AOT: dir });
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
