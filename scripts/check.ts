// pnpm check [--no-e2e] [flow ...]: every correctness gate in one command. The platform build is rebuilt first when the server would not offer it and a dev
// server started unless WEBDROID_URL names one; the typecheck and the unit tests then run at once, then `wasm all`, then the quick e2e gate, each alone since
// a loaded host makes timing tests and flows fail. The first failure stops the run and shows that lane's output. Measurement (lat, perf, --full, --live,
// corpus, conform suites) is not a gate and runs on its own.
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { aotManifest } from "./aot-serve.ts";
import { cli } from "./args.ts";
import { output, run } from "./node.ts";

const { values: { "no-e2e": noE2e }, positionals: flows } = cli("pnpm check [--no-e2e] [flow ...]", { "no-e2e": { type: "boolean" } });
const children: ChildProcess[] = [], started = (c: ChildProcess) => children.push(c), t0 = performance.now();
const elapsed = (from: number) => `${((performance.now() - from) / 1000).toFixed(0)} s`;
// each child leads a process group of its own, so that stopping it stops what pnpm started under it
const stop = (status: number): never => { for (const c of children) try { process.kill(-c.pid!, "SIGTERM"); } catch {} process.exit(status); };
// those groups are not the terminal's, so an interrupt reaches only this process
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop(130));
const pnpm = (args: string[], env = process.env) => run("pnpm", args, { env, detached: true, started });

/** runs `pnpm args` with its output kept: on failure that output is shown and the run stops */
async function lane(name: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  const start = performance.now(), ran = await pnpm(args, env);
  console.log(`${ran.status ? "FAIL" : "ok  "} ${name.padEnd(10)} ${elapsed(start)}${ran.status ? "\n" + output(ran) : ""}`);
  if (ran.status) stop(1);
}

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

const url = noE2e ? undefined : server();
if (!aotManifest().ok) await lane("aot", ["aot"]);
// unit tests that time real input or delivery fail on a host the wasm suites load, as the e2e flows do
await Promise.all([lane("typecheck", ["typecheck"]), lane("test", ["test"])]);
await lane("wasm", ["wasm", "all"]);
if (url) await lane("e2e", ["e2e", ...flows], { ...process.env, WEBDROID_URL: await answering(await url) });
console.log(`all gates passed in ${elapsed(t0)}`);
stop(0);
