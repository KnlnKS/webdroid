// pnpm check [--no-e2e] [flow ...]: every correctness gate in one command, as one pool of tasks: the platform build when the server would not offer it,
// the typecheck, the unit tests in shards, each part of `wasm all` and each e2e flow (FLOWS without live content unless named), in a browser of its
// own and scored when it has goldens; --corpus adds a launch of each corpus apk no flow launches, which fails when one tests/corpus-drawn.json holds
// drew does not draw. A dev server is started unless WEBDROID_URL names one. Tasks start while the host's cores and memory (WEBDROID_CHECK_GB, else 55% of
// it) hold what each declares it uses; the AOT parts and the browsers wait for the platform build. The first failure stops the run and shows that task's
// output. Measurement (lat, perf, --live, conform suites) is not a gate and runs on its own.
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { availableParallelism, totalmem } from "node:os";
import { aotManifest } from "./aot-serve.ts";
import { cli } from "./args.ts";
import { output, run, type Ran } from "./node.ts";
import { pool, timings, type PoolJob } from "./util.ts";
import { allParts, label, runPart } from "./wasm/parts.ts";

const { values: { "no-e2e": noE2e, corpus }, positionals: named } = cli("pnpm check [--no-e2e | --corpus] [flow ...]", { "no-e2e": { type: "boolean" }, corpus: { type: "boolean" } });
const children: ChildProcess[] = [], started = (c: ChildProcess) => children.push(c), t0 = performance.now();
const times = timings("check-times");
// each child leads a process group of its own, so that stopping it stops what pnpm started under it; the flows' browsers end with this process
const stop = (status: number): never => { times.save(); for (const c of children) try { process.kill(-c.pid!, "SIGTERM"); } catch {} process.exit(status); };
// those groups are not the terminal's, so an interrupt reaches only this process
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop(130));
const pnpm = (args: string[], env = process.env) => run("pnpm", args, { env, detached: true, started });
const failure = (ran: Ran) => ran.status ? output(ran) : null;

const freePort = () => new Promise<number>((done) => { const s = createServer().listen(0, () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });
/** WEBDROID_URL, or a dev server this run starts on a free port, which has until it is needed to answer */
async function server(): Promise<string> {
  if (process.env.WEBDROID_URL) return process.env.WEBDROID_URL;
  const port = await freePort();
  void pnpm(["dev"], { ...process.env, PORT: String(port) });
  return `http://localhost:${port}`;
}
/** `url` once it answers within a minute; otherwise the run stops */
async function answering(url: string): Promise<string> {
  for (const deadline = performance.now() + 60_000; performance.now() < deadline; await new Promise((r) => setTimeout(r, 250)))
    if (await fetch(url).then((r) => r.ok, () => false)) return url;
  console.log(`FAIL no dev server answered at ${url}`);
  return stop(1);
}

/** the unit-test shards, the jobs a wasm part that runs jobs of its own (WEBDROID_JOBS) runs, and the cores a flow's browser holds: its page sees
 *  twice as many, as a device with them, since what a launch starts by the cores (its compile shards, half of them) then fits what it holds */
const SHARDS = 3, PART_JOBS = 3, FLOW_CORES = 4;
const CORES = availableParallelism(), GB = Number(process.env.WEBDROID_CHECK_GB ?? totalmem() / 2 ** 30 * 0.55);
/** a gate: `failure` answers its output, or null when it passed; either is printed with its time, and the first failure stops the run. Its seconds are
 *  the last check's, else `estimate` */
function task(name: string, cores: number, gb: number, failure: () => Promise<string | null>, { estimate, after }: { estimate?: number; after?: PoolJob<void> } = {}): PoolJob<void> {
  return { cores, gb, secs: times.weight(name, estimate), after, run: async () => {
    const start = performance.now(), out = await failure().catch((e: unknown) => String((e as Error)?.stack ?? e)), secs = (performance.now() - start) / 1000;
    console.log(`${out === null ? "ok  " : "FAIL"} ${name.padEnd(28)} ${secs.toFixed(1).padStart(5)} s from ${((start - t0) / 1000).toFixed(0).padStart(2)} s${out === null ? "" : "\n" + out}`);
    if (out !== null) stop(1);
    times.record(name, secs);
  } };
}

process.env.WEBDROID_JOBS = String(PART_JOBS);
const url = noE2e ? undefined : server(), stale = !aotManifest().ok;
const aot = stale ? task("aot", 2, 2.5, async () => failure(await pnpm(["aot"]))) : undefined;
const tasks: PoolJob<void>[] = [
  ...aot ? [aot] : [],
  task("typecheck", 2, 1.5, async () => failure(await pnpm(["typecheck"]))),
  ...Array.from({ length: SHARDS }, (_, i) => task(`test ${i + 1}/${SHARDS}`, 4, 2.5, async () => failure(await pnpm(["test", `--shard=${i + 1}/${SHARDS}`, "--maxWorkers=4"])))),
  ...allParts().map((p) => task(`wasm ${label(p)}`, p.jobs ? PART_JOBS : 1, p.jobs ? 1.5 : 0.8,
    async () => failure(await runPart(p, false)), { after: p.aot ? aot : undefined })),
];
let summary: (() => Promise<string>) | undefined;
/** corpus apks that drew and the baseline does not hold */
const newly: string[] = [];
if (url) {
  process.env.WEBDROID_URL = await url;
  const [{ FLOWS, flowsNamed }, { flowEstimate, runFlow, summarize }] = await Promise.all([import("../tests/e2e/flows/index.ts"), import("../tests/e2e/run-flows.ts")]);
  const unknown = named.filter((name) => !flowsNamed(name).length);
  if (unknown.length) { console.log(`no flow is named ${unknown.join(", ")}`); stop(2); }
  const flows = named.length ? [...new Set(named.flatMap(flowsNamed))] : FLOWS.filter((flow) => flow.clock !== "live");
  const outcomes: Awaited<ReturnType<typeof runFlow>>[] = [];
  const ready = answering(process.env.WEBDROID_URL);
  for (const flow of flows) {
    tasks.push(task(`e2e ${flow.app}`, FLOW_CORES, 4.5, async () => {
      await ready;
      const outcome = await runFlow(flow, { alone: false, cores: 2 * FLOW_CORES, log: () => {} });
      outcomes.push(outcome);
      return outcome.errors.length ? outcome.errors.map((e) => "  " + e).join("\n") : null;
    }, { estimate: flowEstimate(flow), after: aot }));
  }
  summary = () => summarize(outcomes, performance.now() - t0);
  if (corpus) {
    const [{ corpusApks }, { drawnApks, launchApk, rowLine }, { launchBrowser }] = await Promise.all([import("./apk-corpus.ts"), import("./corpus.ts"), import("./page.ts")]);
    const drawn = drawnApks();
    let browser: ReturnType<typeof launchBrowser> | undefined;
    for (const apk of corpusApks().filter((apk) => !flows.some((flow) => flow.apk === apk)))
      tasks.push(task(`corpus ${apk}`, FLOW_CORES, 4, async () => {
        await ready;
        // beside the other tasks a first frame comes later than alone (Among Us draws in 9 s alone, past 12 s here); the wait ends at the frame
        const row = await launchApk(await (browser ??= launchBrowser()), apk, { waitMs: 30_000 });
        if (row.ok && !drawn.has(apk)) newly.push(apk);
        return row.ok || !drawn.has(apk) ? null : `  ${rowLine(row)}\n  it drew a frame when tests/corpus-drawn.json was updated`;
      }, { estimate: 10, after: aot }));
  }
}
// the pool starts what holds the most memory first: memory caps how many browsers run at once, so their chain is the run's longest
await pool(tasks, CORES, GB);
if (summary) console.log(await summary());
if (newly.length) console.log(`newly drawing: ${newly.join(", ")} (pnpm corpus --update ${newly.map((apk) => JSON.stringify(apk)).join(" ")} records them)`);
console.log(`all gates passed in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
stop(0);
