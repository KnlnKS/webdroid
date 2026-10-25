// pnpm e2e: the one command line of the harness (README.md): a run of the flows by default.
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { cli, jobsOf } from "../../scripts/args.ts";
import { FLOWS, flowsNamed } from "./flows/index.ts";
import type { Flow } from "./types.ts";

const USAGE = `pnpm e2e [--diff | --record] [--test <flow>]... [flow ...] [options]

  --test, -t <flow>   run only this flow. Repeatable, accepts a comma-separated list, and
                      matches on prefix (--test mihon selects both mihon flows); bare names work too
  --jobs, -j N        flows driven at once, each in its own browser (not with --record)
  --live              also run the flows that depend on live network content
  --shots             save every distinct webdroid frame of each step to ./webdroid-shots
  --shots-dir <dir>   --shots into <dir>. Wiped at the start of every run, and gitignored
  --startup           --record only: record the launch of one live flow
  --json              --diff only: score one flow in this process into report/<flow>.json (what a run does per flow)
  --list              list the known flows
  --help, -h          show this`;
const { values: o, positionals } = cli(USAGE, {
  diff: { type: "boolean" }, record: { type: "boolean" },
  test: { type: "string", short: "t", multiple: true }, jobs: { type: "string", short: "j" }, live: { type: "boolean" },
  shots: { type: "boolean" }, "shots-dir": { type: "string" }, startup: { type: "boolean" }, json: { type: "boolean" },
  list: { type: "boolean" }, help: { type: "boolean", short: "h" },
});
const known = `known flows: ${FLOWS.map((f) => f.app).join(", ")}`;
const usage = (message: string): never => { console.error(`${message}\n\nusage: ${USAGE}\n${known}`); process.exit(2); };
if (o.help) { console.log(`usage: ${USAGE}\n${known}`); process.exit(0); }
if (o.list) { console.log(FLOWS.map((f) => f.app).join("\n")); process.exit(0); }

if (o.diff && o.record) usage("choose one of --diff and --record");
const mode = o.diff ? "diff" : o.record ? "record" : "run";
const shots = o.shots || o["shots-dir"] ? o["shots-dir"] ?? "webdroid-shots" : undefined;
if (shots && mode !== "run") usage("--shots records a run's frames");
if (o.jobs && mode === "record") usage("Android recording is sequential; --jobs is unavailable with --record");
if (o.live && mode !== "run") usage("--live selects flows for a run");
if (o.startup && mode !== "record") usage("--startup requires --record");
if (o.json && mode !== "diff") usage("--json requires --diff");
// Flows saturate the renderer and the processes' Workers before CPU count does: at 3 flows at once a GMS Worker
// already misses its diagnostics now and then
const jobs = jobsOf(o.jobs, Math.max(1, Math.min(mode === "run" ? 2 : 4, Math.floor(cpus().length / (mode === "run" ? 2 : 3)))));

const resolve = (name: string): Flow[] => {
  const flows = flowsNamed(name);
  return flows.length ? flows : usage(name ? `unknown flow "${name}"` : "empty flow name");
};
// live flows depend on upstream content and networks, so a run takes them only when named or with --live
const named = [...o.test ?? [], ...positionals].flatMap((names) => names.split(",")).flatMap((name) => resolve(name.trim()));
const seen = new Set<string>();
const flows = (named.length ? named : mode === "run" && !o.live ? FLOWS.filter((flow) => flow.clock !== "live") : FLOWS)
  .filter((flow) => !seen.has(flow.app) && seen.add(flow.app));

const absent = mode === "diff" ? [] : flows.filter((flow) => !existsSync(`apks/${flow.apk}`));
if (absent.length) { console.error(absent.map((flow) => `${flow.app}: apks/${flow.apk} is missing`).join("\n")); process.exit(2); }

if (mode === "run") await (await import("./run-flows.ts")).runFlows(flows, jobs, shots);
else if (mode === "diff") await (await import("./score.ts")).score(flows, jobs, !!o.json);
else await (await import("./capture-emulator.ts")).record(flows, !!o.startup);
