// Flow selection shared by every entry point, so `--test` means the same thing everywhere.
import { FLOWS } from "../flows";
import type { Flow } from "../types";

const KNOWN = () => FLOWS.map((f) => f.app);

function fail(msg: string): never {
  console.error(`${msg}\n\nknown flows: ${KNOWN().join(", ")}`);
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

/**
 * `--shots [dir]` — save every distinct webdroid frame DURING each step, not just the settled
 * one that gets diffed. Returns the directory, or undefined when the flag is absent.
 */
export function shotsDir(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--shots") {
      const v = argv[i + 1];
      return v && !v.startsWith("-") ? v : DEFAULT_SHOTS_DIR;
    }
    if (a.startsWith("--shots=")) return a.slice("--shots=".length) || DEFAULT_SHOTS_DIR;
  }
  return undefined;
}

function printHelp(cmd: string, extra = ""): void {
  console.log(`usage: ${cmd} [--test <flow>]... [--shots [dir]]

  --test, -t <flow>   run only this flow. Repeatable, accepts a comma-separated list, and
                      matches on prefix (--test mihon selects both mihon flows).
                      Bare names work too: ${cmd} fitnotes
  --shots [dir]       save every distinct webdroid frame during each step to
                      ./${DEFAULT_SHOTS_DIR} (or [dir]). Wiped at the start of every run,
                      and gitignored.
  --list              list the known flows and exit
  --help, -h          show this
${extra}
known flows: ${KNOWN().join(", ")}`);
}

/**
 * Flows named on the command line, or all of them when none are named. Any flag this
 * parser doesn't know is an error rather than a silently ignored typo.
 */
export function selectFlows(argv: string[], cmd: string): Flow[] {
  const picked: Flow[] = [];
  const unknownFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--shots") {
      // Skip its optional directory value so it isn't read as a flow name.
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--shots=")) continue;
    if (a === "--help" || a === "-h") { printHelp(cmd); process.exit(0); }
    if (a === "--list") { console.log(KNOWN().join("\n")); process.exit(0); }
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
    printHelp(cmd);
    process.exit(2);
  }

  // De-dupe so `--test mihon --test mihon-app` doesn't run mihon-app twice.
  const seen = new Set<string>();
  const flows = (picked.length ? picked : FLOWS).filter((f) => !seen.has(f.app) && seen.add(f.app));
  return flows;
}
