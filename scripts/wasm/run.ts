// The Wasm backend's tests and tools, each in a node process of its own: pnpm wasm <suite> [args], or `all` for the tests marked so; `pnpm wasm` lists
// them. They need a JDK (../java.ts finds one) and the Android SDK, whose d8 dexes every fixture.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWhole } from "../generated.ts";
import { nodeCommand } from "../node.ts";
import { AOT_ROOT, type AotManifest } from "../aot-key.ts";

const FUZZ_SEEDS = [1, 2, 3, 4, 5, 6];

/** a test passes or fails, a tool builds, times or prints. `all` runs the tests marked so, in table order. A suite with `aot` runs over a platform build
 *  (WEBDROID_AOT's, or a small one built once per run): "need" only there, "also" alone first unless WEBDROID_AOT names one */
type Suite = { doc: string; all?: true; tool?: true; aot?: "need" | "also"; run?(args: string[]): number };
const SUITES: Record<string, Suite> = {
  diff: { all: true, doc: "every static method of the W, S and N fixtures as Wasm and on the JDK" },
  classdiff: { all: true, doc: "class initialisation and the class model against the JDK" },
  customdiff: { all: true, doc: "invoke-custom and MethodHandle call sites" },
  linkdiff: { all: true, doc: "unresolved references fail at their use site as ART does" },
  loaders: { all: true, doc: "two DexClassLoaders defining one class name: distinct classes, statics and Class objects, found each through its own loader" },
  entry: { all: true, doc: "host code calls Java through jentry over a World, then (entrytier.ts) as a process does: the recorded answers and exceptions", run: (args) => exec("entry", args) || exec("entrytier", []) },
  hostclass: { all: true, aot: "also", doc: "classes the host implements: Java objects and their host objects are one object, a bytecode subclass of one, the recorded answers" },
  lazytest: { all: true, doc: "CHA undone by a later dex, implicit exceptions, heap limits, the tiers, stack traces" },
  fuzz: { all: true, doc: "random verifiable methods as Wasm and on the JDK (seeds 1 to 6 unless arguments are given)", run: (args) => args.length ? exec("fuzz", args) : FUZZ_SEEDS.map((seed) => exec("fuzz", ["--seed", String(seed)])).find(Boolean) ?? 0 },
  jbench: { all: true, doc: "the scripts/jbench workloads against their recorded results" },
  threads: { all: true, doc: "threads, monitors, parking, class initialization waits and natives that wait, on JSPI strands (Java cases against the JDK)" },
  nested: { all: true, doc: "natives that enter Java, a thousand times in one entry (the engine's stacks)" },
  "conform-quick": { all: true, doc: "conform quick: a few classes of each kind", run: () => exec("conform", ["quick"]) },
  sweep: { all: true, doc: "every method of the boot jars and FitNotes compiled alone, failures by cause (`pnpm smoke <apk>` sweeps others)" },
  aottest: { all: true, aot: "need", doc: "precompiled platform code stays sound as classes arrive" },
  persist: { all: true, aot: "need", doc: "the compile worker (second-tier units made elsewhere, adopted while the numbering holds), the app build attached to the platform build and the bounded store for it" },
  conform: { doc: "the scripts/conform suites against their baselines: conform <suite|quick> [class] [--update]" },
  fwtest: { doc: "the framework delegates of scripts/fwtest/ over a World" },
  g1: { tool: true, doc: "the jbench workloads timed in node and headless Chrome" },
  g1app: { tool: true, doc: "the build an app launch saves for the G1 dex, for `g1 --installed`" },
  g1art: { tool: true, doc: "the jbench workloads timed by app_process on the reference device, against a `g1 --json` report (--ref)" },
  "boot-probe": { tool: true, doc: "a headless Chrome page starts a process on the platform build (needs `pnpm aot`): modules loaded and missed, synchronous requests, compile time" },
  watdump: { tool: true, doc: "prints the code generated for a method: watdump <workload> <method-name-filter> (needs the dex g1 builds)" },
  aot: { tool: true, doc: "(pnpm aot) aot-build then aot-startup into vendor/wasm-aot/<key>, and makes it the build the server offers (--keep adds it beside that one, for ?aot=<key>)", run: buildAot },
  "aot-build": { tool: true, doc: "the platform assets alone (--out <dir> keeps them out of vendor/wasm-aot)" },
  "aot-startup": { tool: true, doc: "the modules a start of the process loads, into the build's startup.json (WEBDROID_AOT=<dir>)" },
  "aot-profile": { tool: true, doc: "regroups the build by what app launches use (--classes, then pnpm aot, then again without, with the server running) and writes its startup list" },
};

/** runs the script `name` (entrytier is the second process of entry) and answers its exit status */
function exec(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const [node, argv] = nodeCommand(join(import.meta.dirname, name + ".ts"), ...args);
  return spawnSync(node, argv, { stdio: "inherit", env }).status ?? 1;
}

/** builds the platform assets, records which of their modules a start loads and makes the build the current one, or with --keep adds it beside that one */
function buildAot(args: string[]): number {
  const at = args.indexOf("--out"), keyed = at < 0, keep = args.includes("--keep");
  const status = exec("aot-build", args.filter((a) => a !== "--keep"));
  if (status) return status;
  const manifest = keyed ? JSON.parse(readFileSync(join(AOT_ROOT, "latest.json"), "utf8")) as AotManifest : undefined, dir = manifest ? join(AOT_ROOT, manifest.key) : args[at + 1];
  if (!existsSync(join(dir, "startup.json"))) {
    const startup = exec("aot-startup", [], { ...process.env, WEBDROID_AOT: dir });
    if (startup) return startup;
  }
  if (manifest && !keep) {
    writeWhole(join(AOT_ROOT, "current.json"), JSON.stringify(manifest));
    for (const old of readdirSync(AOT_ROOT).filter((f) => f !== manifest.key && !f.endsWith(".json"))) rmSync(join(AOT_ROOT, old), { recursive: true, force: true });
  }
  return 0;
}

let builtAot: string | undefined;
process.on("exit", () => { if (builtAot) rmSync(builtAot, { recursive: true, force: true }); });
/** the platform build the AOT suites run over: WEBDROID_AOT's, or a small one built once per run (the build's status when it fails) */
function aotDir(): string | number {
  const built = process.env.WEBDROID_AOT ?? builtAot;
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), "wasm-aot-")), status = exec("aot-build", ["--out", dir, "--jars", "4"]);
  if (status) { rmSync(dir, { recursive: true, force: true }); return status; }
  return builtAot = dir;
}

function runSuite(name: string, args: string[]): number {
  const { run, aot } = SUITES[name];
  if (run) return run(args);
  if (aot === "also" && !process.env.WEBDROID_AOT) { const status = exec(name, args); if (status) return status; }
  if (!aot) return exec(name, args);
  const dir = aotDir();
  return typeof dir === "number" ? dir : exec(name, args, { ...process.env, WEBDROID_AOT: dir });
}

const [name, ...args] = process.argv.slice(2);
if (name !== "all" && !Object.hasOwn(SUITES, name ?? "")) {
  const list = (tool: boolean) => Object.entries(SUITES).filter(([, s]) => !s.tool === !tool).map(([n, s]) => `  ${n.padEnd(15)}${s.doc}${tool || s.all ? "" : " (not in all)"}`).join("\n");
  console.error(`usage: pnpm wasm <test|all|tool> [args]\ntests:\n${list(false)}\ntools:\n${list(true)}`);
  process.exit(2);
}
if (name !== "all") process.exit(runSuite(name, args));
const results: [string, number, number][] = [];
for (const suite of Object.keys(SUITES).filter((n) => SUITES[n].all)) {
  console.log(`\n=== ${suite}`);
  const t0 = performance.now();
  results.push([suite, runSuite(suite, []), (performance.now() - t0) / 1000]);
}
console.log("\n" + results.map(([s, status, secs]) => `${status ? "FAIL" : "ok  "} ${s.padEnd(13)} ${secs.toFixed(0)} s`).join("\n"));
process.exit(results.some(([, status]) => status) ? 1 : 0);
