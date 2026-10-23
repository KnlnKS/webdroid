// pnpm e2e: the one command line of every lane (README.md), the quick gate by default.
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { cli, jobsOf } from "../../scripts/args.ts";
import { FLOWS } from "./flows/index.ts";
import type { Flow } from "./types.ts";

const USAGE = `pnpm e2e [--full | --diff | --record] [--test <flow>]... [flow ...] [options]

  --test, -t <flow>   run only this flow. Repeatable, accepts a comma-separated list, and
                      matches on prefix (--test mihon selects both mihon flows); bare names work too
  --jobs, -j N        flows driven at once, each in its own browser (not with --record)
  --live              quick gate only: also run the flows that depend on live network content
  --shots             --full only: save every distinct webdroid frame of each step to ./webdroid-shots
  --shots-dir <dir>   --shots into <dir>. Wiped at the start of every run, and gitignored
  --startup           --record only: record the launch of one live flow
  --json              --diff only: score one flow and print its report as JSON (what --full runs per flow)
  --list              list the known flows
  --help, -h          show this`;
const { values: o, positionals } = cli(USAGE, {
  full: { type: "boolean" }, diff: { type: "boolean" }, record: { type: "boolean" },
  test: { type: "string", short: "t", multiple: true }, jobs: { type: "string", short: "j" }, live: { type: "boolean" },
  shots: { type: "boolean" }, "shots-dir": { type: "string" }, startup: { type: "boolean" }, json: { type: "boolean" },
  list: { type: "boolean" }, help: { type: "boolean", short: "h" },
});
const known = `known flows: ${FLOWS.map((f) => f.app).join(", ")}`;
const usage = (message: string): never => { console.error(`${message}\n\nusage: ${USAGE}\n${known}`); process.exit(2); };
if (o.help) { console.log(`usage: ${USAGE}\n${known}`); process.exit(0); }
if (o.list) { console.log(FLOWS.map((f) => f.app).join("\n")); process.exit(0); }

const modes = (["full", "diff", "record"] as const).filter((mode) => o[mode]);
if (modes.length > 1) usage("choose one E2E mode: --full, --diff or --record");
const mode = modes.length ? modes[0] : "fast";
const shots = o.shots || o["shots-dir"] ? o["shots-dir"] ?? "webdroid-shots" : undefined;
if (shots && mode !== "full") usage("--shots requires --full");
if (o.jobs && mode === "record") usage("Android recording is sequential; --jobs is unavailable with --record");
if (o.live && mode !== "fast") usage("--live selects flows for the quick gate");
if (o.startup && mode !== "record") usage("--startup requires --record");
if (o.json && mode !== "diff") usage("--json requires --diff");
// Flows saturate the renderer and the processes' Workers before CPU count does: at 3 quick flows at once a GMS Worker
// already misses its diagnostics now and then, and full live flows load more
const jobs = jobsOf(o.jobs, Math.max(1, Math.min(mode === "fast" ? 2 : 4, Math.floor(cpus().length / (mode === "fast" ? 2 : 3)))));

/** the flows a name selects: the one it names exactly, else those it is a prefix of */
function resolve(name: string): Flow[] {
  const exact = FLOWS.find((f) => f.app === name), prefixed = FLOWS.filter((f) => name && f.app.startsWith(name));
  return exact ? [exact] : prefixed.length ? prefixed : usage(name ? `unknown flow "${name}"` : "empty flow name");
}
// live flows depend on upstream content and networks, so the quick gate runs them only when named or with --live
const named = [...o.test ?? [], ...positionals].flatMap((names) => names.split(",")).flatMap((name) => resolve(name.trim()));
const seen = new Set<string>();
const flows = (named.length ? named : mode === "fast" && !o.live ? FLOWS.filter((flow) => flow.clock !== "live") : FLOWS)
  .filter((flow) => !seen.has(flow.app) && seen.add(flow.app));

const absent = mode === "diff" ? [] : flows.filter((flow) => !existsSync(`apks/${flow.apk}`));
if (absent.length) { console.error(absent.map((flow) => `${flow.app}: apks/${flow.apk} is missing`).join("\n")); process.exit(2); }

if (mode === "fast") await (await import("./run-fast.ts")).runFast(flows, jobs);
else if (mode === "full") await (await import("./run-full.ts")).runFull(flows, jobs, shots);
else if (mode === "diff") await (await import("./score.ts")).score(flows, jobs, !!o.json);
else await (await import("./capture-emulator.ts")).record(flows, !!o.startup);
