// The Wasm backend's suites (run.ts lists them) and the node processes each runs as. They need a JDK (../java.ts finds one) and the Android SDK, whose
// d8 dexes every fixture.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AOT_ROOT, type AotManifest } from "../aot-key.ts";
import { aotManifest } from "../aot-serve.ts";
import { nodeCommand, run, type Ran } from "../node.ts";

/** a test passes or fails, a tool builds, times or prints. A suite runs as the processes `parts` names (its script with its arguments by default). A
 *  suite with `aot` runs over a platform build: "need" only there, "also" alone first. One with `jobs` runs WEBDROID_JOBS jobs of its own */
type Suite = { doc: string; all?: true; tool?: true; jobs?: true; aot?: "need" | "also"; parts?(args: string[]): [string, string[]][] };
export const SUITES: Record<string, Suite> = {
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
  "conform-quick": { all: true, jobs: true, doc: "conform quick: a few classes of each kind", parts: () => [["conform", ["quick"]]] },
  sweep: { all: true, jobs: true, doc: "every method of the boot jars and FitNotes compiled alone, failures by cause (`pnpm wasm sweep <apk>` sweeps others)" },
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
  "aot-startup": { tool: true, doc: "the modules the zygote's start loads, into the build's startup.json (WEBDROID_AOT=<dir>)" },
  "aot-profile": { tool: true, doc: "regroups the build by what app launches use (--classes, then pnpm aot, then again without, with the server running) and writes its startup list" },
};

/** a process of a suite: its script, the script's arguments, whether it runs over the platform build and whether it runs jobs of its own */
export type Part = { script: string; args: string[]; aot: boolean; jobs: boolean };
const exec = (script: string, args: string[], env: NodeJS.ProcessEnv, show: boolean) => run(...nodeCommand(join(import.meta.dirname, script + ".ts"), ...args), { env, show });

export function partsOf(name: string, args: string[]): Part[] {
  const { parts, aot, jobs = false } = SUITES[name], procs = parts?.(args) ?? [[name, args]];
  const over = (aot: boolean) => procs.map(([script, args]) => ({ script, args, aot, jobs }));
  return [...aot === "need" ? [] : over(false), ...aot ? over(true) : []];
}
/** the parts of every suite `all` runs */
export const allParts = (): Part[] => Object.keys(SUITES).filter((n) => SUITES[n].all).flatMap((suite) => partsOf(suite, []));
export const label = (p: Part): string => [p.script, ...p.args, p.aot ? "(aot)" : ""].join(" ").trim();

let built: Promise<Ran & { dir: string }> | undefined;
/** the platform build in `dir`, or else the one the server offers, made first (`pnpm aot`, its output shown when `show`) when these sources have none */
export function platformBuild(dir: string | undefined, show = false): Promise<Ran & { dir: string }> {
  if (dir) return Promise.resolve({ status: 0, stdout: "", stderr: "", dir });
  return built ??= (async () => {
    const made = aotManifest().ok ? { status: 0, stdout: "", stderr: "" } : await exec("aot", [], process.env, show);
    const { key } = made.status ? { key: "" } : JSON.parse(readFileSync(join(AOT_ROOT, "current.json"), "utf8")) as AotManifest;
    return { ...made, dir: join(AOT_ROOT, key) };
  })();
}

/** runs part `p`, its output shown when `show`, over platformBuild(`aot`) if it needs one; a part whose build failed fails with no output of its own */
export async function runPart(p: Part, show: boolean, aot = process.env.WEBDROID_AOT): Promise<Ran> {
  const build = p.aot ? await platformBuild(aot, show) : undefined;
  if (build?.status) return { status: build.status, stdout: "", stderr: "" };
  return exec(p.script, p.args, build ? { ...process.env, WEBDROID_AOT: build.dir } : process.env, show);
}
