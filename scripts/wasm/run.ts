// The Wasm backend's tests and tools (parts.ts), each in a node process of its own: pnpm wasm <suite> [args], or `all` [--jobs n] for the tests marked so,
// run at once, longest first, the output of each that fails shown; `pnpm wasm` lists them.
import { HALF_CORES, cli, jobsOf } from "../args.ts";
import { output, type Ran } from "../node.ts";
import { runQueue, timings } from "../util.ts";
import { SUITES, allParts, label, partsOf, platformBuild, runPart } from "./parts.ts";

const [name, ...args] = process.argv.slice(2);
if (name !== "all" && !Object.hasOwn(SUITES, name ?? "")) {
  const list = (tool: boolean) => Object.entries(SUITES).filter(([, s]) => !s.tool === !tool).map(([n, s]) => `  ${n.padEnd(15)}${s.doc}${tool || s.all ? "" : " (not in all)"}`).join("\n");
  console.error(`usage: pnpm wasm <test|all [--jobs n] [--aot <build>]|tool> [args]\ntests:\n${list(false)}\ntools:\n${list(true)}`);
  process.exit(2);
}
if (name !== "all") {
  for (const p of partsOf(name, args)) { const { status } = await runPart(p, true); if (status) process.exit(status); }
  process.exit(0);
}
// Every part is a job of its own, the longest of the last run's first, and the platform build starts at once beside them. A part that runs jobs of
// its own (sweep, conform) runs half as many as this does, since each at its own default kept `all` 3 s longer.
const { values } = cli("pnpm wasm all [--jobs n] [--aot <build>]", { jobs: { type: "string" }, aot: { type: "string" } }, { args }), jobs = jobsOf(values.jobs, HALF_CORES);
const aot = values.aot ?? process.env.WEBDROID_AOT;
process.env.WEBDROID_JOBS = String(Math.ceil(jobs / 2));
const parts = allParts(), times = timings("wasm-times"), t0 = performance.now();
const report = (name: string, secs: number, r: Ran) => {
  const out = r.status ? output(r) : "";
  console.log(`${r.status ? "FAIL" : "ok  "} ${name.padEnd(24)} ${secs.toFixed(1)} s${out && "\n" + out.split("\n").map((l) => "  | " + l).join("\n")}`);
};
if (parts.some((p) => p.aot)) void platformBuild(aot).then((r) => r.status && report("aot-build", (performance.now() - t0) / 1000, r));
const results = await runQueue(parts, jobs, (p) => times.weight(label(p)), async (p) => {
  // a part's time is its own, not the build's it waited for
  if (p.aot) await platformBuild(aot);
  const start = performance.now(), r = await runPart(p, false, aot), secs = (performance.now() - start) / 1000;
  report(label(p), secs, r);
  times.record(label(p), secs);
  return r.status;
});
times.save();
const failed = results.filter(Boolean).length;
console.log(`${parts.length - failed}/${parts.length} passed in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
