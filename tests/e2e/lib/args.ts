// Flow selection shared by every entry point, so `--test` means the same thing everywhere.
import { cpus } from "node:os";
import { FLOWS } from "../flows";
import type { Flow } from "../types";

function fail(msg: string, known: Flow[]): never {
  console.error(`${msg}\n\nknown flows: ${known.map((f) => f.app).join(", ")}`);
  process.exit(2);
}

/**
 * Resolve one name to flows. Exact match wins; otherwise it is treated as a prefix, so
 * `--test mihon` selects both mihon-onboarding and mihon-app.
 */
function resolve(name: string, known: Flow[]): Flow[] {
  const n = name.trim();
  if (!n) fail("empty flow name");
  const exact = known.find((f) => f.app === n);
  if (exact) return [exact];
  const prefixed = known.filter((f) => f.app.startsWith(n));
  if (prefixed.length) return prefixed;
  fail(`unknown flow "${n}"`, known);
}

const DEFAULT_SHOTS_DIR = "webdroid-shots";
/** Half the machine: a flow's renderer, its SwiftShader process and Bun's own work each want a core. */
const DEFAULT_JOBS = Math.max(1, Math.floor(cpus().length / 2));

function printHelp(cmd: string, known: Flow[], extra = ""): void {
  console.log(`usage: ${cmd} [--test <flow>]... [--jobs N] [--shots [dir]]

  --test, -t <flow>   run only this flow. Repeatable, accepts a comma-separated list, and
                      matches on prefix (--test mihon selects both mihon flows).
                      Bare names work too: ${cmd} fitnotes
  --jobs, -j N        flows driven at once, each in its own browser (default ${DEFAULT_JOBS} here:
                      half the cpus). 1 reproduces an uncontended run for fps measurements.
  --shots [dir]       save every distinct webdroid frame during each step to
                      ./${DEFAULT_SHOTS_DIR} (or [dir]). Wiped at the start of every run,
                      and gitignored.
  --list              list the known flows and exit
  --help, -h          show this
${extra}
known flows: ${known.map((f) => f.app).join(", ")}`);
}

/**
 * The flows named on the command line, or all of them when none are named, plus the
 * `--shots [dir]` directory when that flag is present (every distinct webdroid frame DURING
 * each step, not just the settled one that gets diffed). Any flag this parser doesn't know
 * is an error rather than a silently ignored typo.
 */
export function parseArgs(argv: string[], cmd: string, known: Flow[] = FLOWS): { flows: Flow[]; shots?: string; jobs: number } {
  const picked: Flow[] = [];
  const unknownFlags: string[] = [];
  let shots: string | undefined;
  let jobs = DEFAULT_JOBS;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--shots") {
      const v = argv[i + 1];
      // its optional directory value must not also be read as a flow name
      if (v && !v.startsWith("-")) { shots = v; i++; } else shots = DEFAULT_SHOTS_DIR;
      continue;
    }
    if (a.startsWith("--shots=")) { shots = a.slice("--shots=".length) || DEFAULT_SHOTS_DIR; continue; }
    if (a === "--jobs" || a === "-j" || a.startsWith("--jobs=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      jobs = Math.floor(Number(v));
      if (!(jobs >= 1)) fail(`${a} needs a positive number`, known);
      continue;
    }
    if (a === "--help" || a === "-h") { printHelp(cmd, known); process.exit(0); }
    if (a === "--list") { console.log(known.map((f) => f.app).join("\n")); process.exit(0); }
    if (a === "--test" || a === "-t") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) fail(`${a} needs a flow name`, known);
      for (const part of v.split(",")) picked.push(...resolve(part, known));
    } else if (a.startsWith("--test=")) {
      for (const part of a.slice("--test=".length).split(",")) picked.push(...resolve(part, known));
    } else if (a.startsWith("-")) {
      unknownFlags.push(a);
    } else {
      picked.push(...resolve(a, known));
    }
  }

  if (unknownFlags.length) {
    console.error(`unknown option: ${unknownFlags.join(" ")}`);
    printHelp(cmd, known);
    process.exit(2);
  }

  // De-dupe so `--test mihon --test mihon-app` doesn't run mihon-app twice.
  const seen = new Set<string>();
  return { flows: (picked.length ? picked : known).filter((f) => !seen.has(f.app) && seen.add(f.app)), shots, jobs };
}
