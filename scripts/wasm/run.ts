// The Wasm backend's tests and tools, each in a node process of its own: pnpm wasm <test|tool> [args], or `all` for the tests marked so. They need javac,
// d8 and java (and the Android SDK for the fixtures built against android.jar) on PATH.
// Tests (in `all` unless noted):
//   diff         every static method of the W, S and N fixtures as Wasm and on the JDK
//   classdiff    class initialisation and the class model against the JDK
//   customdiff   invoke-custom and MethodHandle call sites
//   linkdiff     unresolved references fail at their use site as ART does
//   loaders      two DexClassLoaders defining one class name: distinct classes, statics and Class objects, found each through its own loader
//   lazytest     CHA undone by a later dex, implicit exceptions, heap limits, the tiers, stack traces
//   aottest      precompiled platform code stays sound as classes arrive (builds a platform AOT first unless WEBDROID_AOT names one)
//   persist      the compile worker (second-tier units made elsewhere, adopted while the numbering holds), the app build attached to the platform build and the bounded store for it
//   entry        host code calls Java through jentry over a World, then (entrytier.ts) as a process does: the recorded answers and exceptions
//   hostclass    classes the host implements: Java objects and their host objects are one object, a bytecode subclass of one, the recorded answers (also over a platform build)
//   fuzz         random verifiable methods as Wasm and on the JDK (seeds 1 to 6 unless arguments are given)
//   jbench       the scripts/jbench workloads against their recorded results
//   nested       natives that enter Java, a thousand times in one entry (the engine's stacks)
//   threads      threads, monitors, parking, class initialization waits and natives that wait, on JSPI strands (Java cases against the JDK)
//   sweep        every method of the boot jars and FitNotes compiled alone, failures by cause (`pnpm smoke <apk>` sweeps others)
//   conform      the scripts/conform suites against their baselines: conform <suite|quick> [class] [--update]; conform-quick (a few classes of each kind) is in `all`
//   fwtest       the framework delegates of scripts/fwtest/ over a World (not in `all`)
// Tools:
//   g1           the jbench workloads timed in node and headless Chrome; g1startup writes the startup list of a build made with the G1 dex as its app, and
//                g1app the build an app launch saves for the G1 dex, for `g1 --installed`
//   boot-probe   a headless Chrome page starts a process on the platform build: modules loaded and missed, synchronous requests (none allowed), compile time
//                (needs a build from `pnpm aot`)
//   watdump      prints the code generated for a method
//   aot          (pnpm aot) builds the platform assets under vendor/wasm-aot/<key> and the module list a start of the process loads (aot-build, then
//                aot-startup), and makes that build the one the server offers. `aot-profile --classes`, `pnpm aot`, `aot-profile` (in this order, with the
//                server running) regroup the build by what launches of apps use and write its startup list.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWhole } from "../generated.ts";
import { nodeCommand } from "../node.ts";
import { AOT_ROOT, type AotManifest } from "./aot-key.ts";

/** the tests `all` runs, in this order */
const ALL = ["diff", "classdiff", "customdiff", "linkdiff", "loaders", "entry", "hostclass", "lazytest", "fuzz", "jbench", "threads", "nested", "conform-quick", "sweep", "aottest", "persist"];
/** tests pass or fail */
const TESTS = [...ALL, "conform", "fwtest"];
/** tools build, time or print */
const TOOLS = ["g1", "g1startup", "g1app", "boot-probe", "watdump", "aot", "aot-build", "aot-startup", "aot-profile"];
const FUZZ_SEEDS = [1, 2, 3, 4, 5, 6];

/** runs the script `name` (entrytier is the second process of entry) and answers its exit status */
function exec(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [node, argv] = nodeCommand(join(import.meta.dirname, name + ".ts"), ...args);
  return spawnSync(node, argv, { stdio: "inherit", env }).status ?? 1;
}

/** builds the platform assets, records which of their modules a start loads and makes the build the current one */
function buildAot(args: string[]): number {
  const at = args.indexOf("--out"), keyed = at < 0;
  const status = exec("aot-build", args);
  if (status) return status;
  const manifest = keyed ? JSON.parse(readFileSync(join(AOT_ROOT, "latest.json"), "utf8")) as AotManifest : undefined, dir = manifest ? join(AOT_ROOT, manifest.key) : args[at + 1];
  if (!existsSync(join(dir, "startup.json"))) {
    const startup = exec("aot-startup", [], { ...process.env, WEBDROID_AOT: dir });
    if (startup) return startup;
  }
  if (manifest) {
    writeWhole(join(AOT_ROOT, "current.json"), JSON.stringify(manifest));
    for (const old of readdirSync(AOT_ROOT).filter((f) => f !== manifest.key && !f.endsWith(".json"))) rmSync(join(AOT_ROOT, old), { recursive: true, force: true });
  }
  return 0;
}

function runSuite(name: string, args: string[]): number {
  if (name === "conform-quick") return exec("conform", ["quick"]);
  if (name === "aot") return buildAot(args);
  if (name === "fuzz" && !args.length) return FUZZ_SEEDS.map((seed) => exec(name, ["--seed", String(seed)])).find(Boolean) ?? 0;
  if (name === "entry") return exec(name, args) || exec("entrytier", []);
  if (name === "hostclass" && !process.env.WEBDROID_AOT && exec(name, args)) return 1;
  if ((name !== "aottest" && name !== "persist" && name !== "hostclass") || process.env.WEBDROID_AOT) return exec(name, args);
  const dir = mkdtempSync(join(tmpdir(), "wasm-aot-"));
  try {
    return exec("aot-build", ["--out", dir, "--jars", "4"]) || exec(name, args, { ...process.env, WEBDROID_AOT: dir });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const [name, ...args] = process.argv.slice(2);
if (name !== "all" && !TESTS.includes(name) && !TOOLS.includes(name)) {
  console.error(`usage: pnpm wasm <test> [args], with a test of ${[...TESTS, "all"].join("|")}\n       pnpm wasm <tool> [args], with a tool of ${TOOLS.join("|")}`);
  process.exit(2);
}
if (name !== "all") process.exit(runSuite(name, args));
const results: [string, number, number][] = [];
for (const suite of ALL) {
  console.log(`\n=== ${suite}`);
  const t0 = performance.now();
  results.push([suite, runSuite(suite, []), (performance.now() - t0) / 1000]);
}
console.log("\n" + results.map(([s, status, secs]) => `${status ? "FAIL" : "ok  "} ${s.padEnd(11)} ${secs.toFixed(0)} s`).join("\n"));
process.exit(results.some(([, status]) => status) ? 1 : 0);
