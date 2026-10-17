// Flow selection shared by every entry point, so `--test` means the same thing everywhere.
import { cpus } from "node:os";
import { FLOWS } from "../flows/index.ts";
import type { Flow } from "../types.ts";

function fail(msg: string): never {
  console.error(`${msg}\n\nknown flows: ${FLOWS.map((f) => f.app).join(", ")}`);
  process.exit(2);
}

/**
 * Resolve one name to flows. Exact match wins; otherwise it is treated as a prefix, so
 * `--test mihon` selects both mihon-onboarding and mihon-app.
 */
function resolve(name: string): Flow[] {
  const n = name.trim();
  if (!n) fail("empty flow name");
  const exact = FLOWS.find((f) => f.app === n);
  if (exact) return [exact];
  const prefixed = FLOWS.filter((f) => f.app.startsWith(n));
  if (prefixed.length) return prefixed;
  fail(`unknown flow "${n}"`);
}

const DEFAULT_SHOTS_DIR = "webdroid-shots";
/** Full live flows can saturate the renderer and native worker threads before CPU count does. */
export const defaultJobs = (limit: number, coresPerJob = 3): number => Math.max(1, Math.min(limit, Math.floor(cpus().length / coresPerJob)));
const DEFAULT_JOBS = defaultJobs(4);

function printHelp(cmd: string, jobs: number): void {
  console.log(`usage: ${cmd} [--test <flow>]... [--jobs N] [--shots [dir]]

  --test, -t <flow>   run only this flow. Repeatable, accepts a comma-separated list, and
                      matches on prefix (--test mihon selects both mihon flows).
                      Bare names work too: ${cmd} fitnotes
  --jobs, -j N        flows driven at once, each in its own browser (default ${jobs} here).
                      1 reproduces an uncontended run for fps measurements.
  --shots [dir]       save every distinct webdroid frame during each step to
                      ./${DEFAULT_SHOTS_DIR} (or [dir]). Wiped at the start of every run,
                      and gitignored.
  --live              quick lane only: also run the flows that depend on live network content
  --list              list the known flows and exit
  --help, -h          show this
known flows: ${FLOWS.map((f) => f.app).join(", ")}`);
}

/**
 * The flows named on the command line, or all of them when none are named, plus the
 * `--shots [dir]` directory when that flag is present (every distinct webdroid frame DURING
 * each step, not just the settled one that gets diffed). Any flag this parser doesn't know
 * is an error rather than a silently ignored typo.
 */
export function parseArgs(argv: string[], cmd: string, { defaultJobs = DEFAULT_JOBS, unnamed = FLOWS }: { defaultJobs?: number; unnamed?: Flow[] } = {}): { flows: Flow[]; shots?: string; jobs: number } {
  const picked: Flow[] = [];
  const unknownFlags: string[] = [];
  let shots: string | undefined;
  let jobs = defaultJobs;

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
      if (!(jobs >= 1)) fail(`${a} needs a positive number`);
      continue;
    }
    if (a === "--help" || a === "-h") { printHelp(cmd, defaultJobs); process.exit(0); }
    if (a === "--list") { console.log(FLOWS.map((f) => f.app).join("\n")); process.exit(0); }
    if (a === "--test" || a === "-t") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) fail(`${a} needs a flow name`);
      for (const part of v.split(",")) picked.push(...resolve(part));
    } else if (a.startsWith("--test=")) {
      for (const part of a.slice("--test=".length).split(",")) picked.push(...resolve(part));
    } else if (a.startsWith("-")) {
      unknownFlags.push(a);
    } else {
      picked.push(...resolve(a));
    }
  }

  if (unknownFlags.length) {
    console.error(`unknown option: ${unknownFlags.join(" ")}`);
    printHelp(cmd, defaultJobs);
    process.exit(2);
  }

  // De-dupe so `--test mihon --test mihon-app` doesn't run mihon-app twice.
  const seen = new Set<string>();
  return { flows: (picked.length ? picked : unnamed).filter((f) => !seen.has(f.app) && seen.add(f.app)), shots, jobs };
}
