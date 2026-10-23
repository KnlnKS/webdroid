// The Wasm backend's tests and tools, each in a node process of its own: pnpm wasm <suite> [args], or `all` [--jobs n] for the tests marked so, run at
// once, longest first, the output of each that fails shown; `pnpm wasm` lists them. They need a JDK (../java.ts finds one) and the Android SDK, whose
// d8 dexes every fixture.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HALF_CORES, cli, jobsOf } from "../args.ts";
import { nodeCommand, output, run, type Ran } from "../node.ts";
import { runQueue, timings } from "../util.ts";

/** a test passes or fails, a tool builds, times or prints. A suite runs as the processes `parts` names (its script with its arguments by default). A
 *  suite with `aot` runs over a platform build (WEBDROID_AOT's, or a small one built once per run): "need" only there, "also" alone first unless
 *  WEBDROID_AOT names one */
type Suite = { doc: string; all?: true; tool?: true; aot?: "need" | "also"; parts?(args: string[]): [string, string[]][] };
const SUITES: Record<string, Suite> = {
  diff: { all: true, doc: "every static method of the W, S and N fixtures as Wasm and on the JDK" },
  classdiff: { all: true, doc: "class initialisation and the class model against the JDK" },
  customdiff: { all: true, doc: "invoke-custom and MethodHandle call sites" },
  linkdiff: { all: true, doc: "unresolved references fail at their use site as ART does" },
  loaders: { all: true, doc: "two DexClassLoaders defining one class name: distinct classes, statics and Class objects, found each through its own loader" },
  entry: { all: true, doc: "host code calls Java through jentry over a World, then (entrytier.ts) as a process does: the recorded answers and exceptions", parts: (args) => [["entry", args], ["entrytier", []]] },
  hostclass: { all: true, aot: "also", doc: "classes the host implements: Java objects and their host objects are one object, a bytecode subclass of one, the recorded answers" },
  lazytest: { all: true, doc: "CHA undone by a later dex, implicit exceptions, heap limits, the tiers, stack traces" },
  fuzz: { all: true, doc: "random verifiable methods as Wasm and on the JDK (seeds 1 to 6 unless arguments are given)", parts: (args) => args.length ? [["fuzz", args]] : [1, 2, 3, 4, 5, 6].map((seed) => ["fuzz", ["--seed", String(seed)]]) },
  jbench: { all: true, doc: "the java/Bench.java workloads against ART's answers (g1art --record); a gap fails" },
  threads: { all: true, doc: "threads, monitors, parking, class initialization waits and natives that wait, on JSPI strands (Java cases against the JDK)" },
  nested: { all: true, doc: "natives that enter Java, a thousand times in one entry (the engine's stacks)" },
  "conform-quick": { all: true, doc: "conform quick: a few classes of each kind", parts: () => [["conform", ["quick"]]] },
  sweep: { all: true, doc: "every method of the boot jars and FitNotes compiled alone, failures by cause (`pnpm smoke <apk>` sweeps others)" },
  aottest: { all: true, aot: "need", doc: "precompiled platform code stays sound as classes arrive" },
  persist: { all: true, aot: "need", doc: "the compile worker (second-tier units made elsewhere, adopted while the numbering holds), the app build attached to the platform build and the bounded store for it" },
  conform: { doc: "the scripts/conform suites against their baselines: conform <suite|quick> [class] [--update]" },
  fwtest: { doc: "the framework delegates of scripts/fwtest/ over a World" },
  g1: { tool: true, doc: "the jbench workloads timed in node and headless Chrome" },
  g1app: { tool: true, doc: "the build an app launch saves for the G1 dex, for `g1 --installed`" },
  g1art: { tool: true, doc: "the jbench workloads timed by app_process on the reference device, against a `g1 --json` report (--ref); --record writes the answers jbench expects" },
  "boot-probe": { tool: true, doc: "a headless Chrome page starts a process on the platform build (needs `pnpm aot`): modules loaded and missed, synchronous requests, compile time" },
  watdump: { tool: true, doc: "prints the code generated for a method: watdump <workload> <method-name-filter> (needs the dex g1 builds)" },
  aot: { tool: true, doc: "(pnpm aot) aot-build then aot-startup into vendor/wasm-aot/<key>, and makes it the build the server offers (--keep adds it beside that one, for ?aot=<key>)" },
  "aot-build": { tool: true, doc: "the platform assets alone (--out <dir> keeps them out of vendor/wasm-aot)" },
  "aot-startup": { tool: true, doc: "the modules a start of the process loads, into the build's startup.json (WEBDROID_AOT=<dir>)" },
  "aot-profile": { tool: true, doc: "regroups the build by what app launches use (--classes, then pnpm aot, then again without, with the server running) and writes its startup list" },
};

/** a process of a suite: its script, the script's arguments and whether it runs over the platform build */
type Part = { script: string; args: string[]; aot: boolean };
const exec = (script: string, args: string[], env: NodeJS.ProcessEnv, show: boolean) => run(...nodeCommand(join(import.meta.dirname, script + ".ts"), ...args), { env, show });

let built: Promise<Ran & { dir: string }> | undefined;
/** the platform build the AOT suites run over: WEBDROID_AOT's, or a small one made once per run, its output shown when `show` */
function aotBuild(show: boolean): Promise<Ran & { dir: string }> {
  const given = process.env.WEBDROID_AOT;
  if (given) return Promise.resolve({ status: 0, stdout: "", stderr: "", dir: given });
  return built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-aot-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    return { ...await exec("aot-build", ["--out", dir, "--jars", "4"], process.env, show), dir };
  })();
}

function partsOf(name: string, args: string[]): Part[] {
  const { parts, aot } = SUITES[name], procs = parts?.(args) ?? [[name, args]];
  const over = (aot: boolean) => procs.map(([script, args]) => ({ script, args, aot }));
  return [...!aot || aot === "also" && !process.env.WEBDROID_AOT ? over(false) : [], ...aot ? over(true) : []];
}

/** runs part `p`, its output shown when `show`; a part over a platform build that failed fails with no output of its own */
async function runPart(p: Part, show: boolean): Promise<Ran> {
  const build = p.aot ? await aotBuild(show) : undefined;
  if (build?.status) return { status: build.status, stdout: "", stderr: "" };
  return exec(p.script, p.args, build ? { ...process.env, WEBDROID_AOT: build.dir } : process.env, show);
}

const [name, ...args] = process.argv.slice(2);
if (name !== "all" && !Object.hasOwn(SUITES, name ?? "")) {
  const list = (tool: boolean) => Object.entries(SUITES).filter(([, s]) => !s.tool === !tool).map(([n, s]) => `  ${n.padEnd(15)}${s.doc}${tool || s.all ? "" : " (not in all)"}`).join("\n");
  console.error(`usage: pnpm wasm <test|all [--jobs n]|tool> [args]\ntests:\n${list(false)}\ntools:\n${list(true)}`);
  process.exit(2);
}
if (name !== "all") {
  for (const p of partsOf(name, args)) { const { status } = await runPart(p, true); if (status) process.exit(status); }
  process.exit(0);
}
// Every part is a job of its own, the longest of the last run's first, and the platform build starts at once beside them. A part that runs jobs of
// its own (sweep, conform) runs half as many as this does, since each at its own default kept `all` 3 s longer.
const { values } = cli("pnpm wasm all [--jobs n]", { jobs: { type: "string" } }, { args }), jobs = jobsOf(values.jobs, HALF_CORES);
process.env.WEBDROID_JOBS = String(Math.ceil(jobs / 2));
const parts = Object.keys(SUITES).filter((n) => SUITES[n].all).flatMap((suite) => partsOf(suite, []));
const times = timings("wasm-times"), t0 = performance.now();
const label = (p: Part) => [p.script, ...p.args, p.aot ? "(aot)" : ""].join(" ").trim();
const report = (name: string, secs: number, r: Ran) => {
  const out = r.status ? output(r) : "";
  console.log(`${r.status ? "FAIL" : "ok  "} ${name.padEnd(24)} ${secs.toFixed(1)} s${out && "\n" + out.split("\n").map((l) => "  | " + l).join("\n")}`);
};
if (parts.some((p) => p.aot)) void aotBuild(false).then((r) => r.status && report("aot-build", (performance.now() - t0) / 1000, r));
const results = await runQueue(parts, jobs, (p) => times.weight(label(p)), async (p) => {
  // a part's time is its own, not the build's it waited for
  if (p.aot) await aotBuild(false);
  const start = performance.now(), r = await runPart(p, false), secs = (performance.now() - start) / 1000;
  report(label(p), secs, r);
  times.record(label(p), secs);
  return r.status;
});
times.save();
const failed = results.filter(Boolean).length;
console.log(`${parts.length - failed}/${parts.length} passed in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
