// The G1 dex as an installed app: the build production saves for an app (host/appcode.ts: made by the compile worker, refined with what a launch compiled on demand) after a
// launch that ran the workloads, written to a directory `g1 --installed DIR` attaches as a launch finds a saved build. Beside it, startup.json lists the platform modules a start
// and the workloads' first calls load, as a launch profile would for this app (aot-profile.ts), so a page compiles them ahead.
//   WEBDROID_AOT=<platform build> bun run wasm g1app --out DIR [workload ...]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Program } from "../../src/wasm/compiler/program";
import { externs, intrinsics } from "../../src/wasm/link/intrinsics";
import type { FetchStore } from "../../src/wasm/link/aotstore";
import type { World } from "../../src/wasm/link/world";
import { prepareApp, type AppCode } from "../../src/wasm/host/appcode";
import { serveCompile, type CompileEnv } from "../../src/wasm/host/compile-serve";
import type { WorkerPort } from "../../src/wasm/host/compiler";
import { Persist, appKey, memoryBackend } from "../../src/wasm/host/persist";
import { heapUsed } from "../../src/wasm/host/stats";
import { loadDexes, world } from "./lib";
import { addHostClasses, mountPlatform, natives, startProcess } from "./harness";
import { G1_DIR, PLATFORM_PATHS, ROOT } from "./paths";

const AOT = process.env.WEBDROID_AOT, at = process.argv.indexOf("--out"), out = at < 0 ? "" : process.argv[at + 1];
if (!AOT || !out) throw new Error("usage: WEBDROID_AOT=<platform build> g1app --out DIR [workload ...]");
const workloads = process.argv.slice(2).filter((a, i, v) => !a.startsWith("--") && v[i - 1] !== "--out");
const app = loadDexes(join(G1_DIR, "classes.dex")), platformDexes = PLATFORM_PATHS.flatMap(loadDexes);
const platform = new Program(platformDexes); platform.addExterns(externs);
const BASE = "aot://platform/", key = basename(AOT);
const env: CompileEnv = { platform: async () => platformDexes, natives, intrinsics, externs, heapUsed, fetchBytes: async (url) => new Uint8Array(readFileSync(join(AOT, url.slice(BASE.length)))) };
/** a compile worker over a MessageChannel in this thread */
const spawn = (): WorkerPort => {
  const { port1, port2 } = new MessageChannel();
  serveCompile(port2 as never, env);
  return { postMessage: (m, t) => port1.postMessage(m, t as never), set onmessage(f) { port1.onmessage = f as never; }, get onmessage() { return port1.onmessage as never; },
    onerror: null, terminate: () => { port1.close(); port2.close(); } };
};
const persist = new Persist(memoryBackend()), request = { dexes: app, aot: { base: BASE, key } as unknown as FetchStore, persist, spawn, roots: { launch: [] } };
/** a launch as the page makes one: the app over the platform's Program, the saved build attached, the host's classes */
const launch = (code: AppCode): World => addHostClasses(world(new Program(app, platform), { natives, app: code.saved }));
const run = async (w: World, reps: number) => {
  for (const workload of workloads) {
    const cls = ["Bench", "G1"].find((c) => w.prog.get(c)?.byKey.has(`w_${workload}()I`));
    if (!cls) throw new Error(`no workload ${workload}`);
    const call = w.entryAsync(cls, `w_${workload}`, "()I");
    for (let i = 0; i <= reps; i++) await call();
  }
};

await mountPlatform(ROOT);
// the first launch: no saved build; the worker makes one from the roots, and the launch's own compiling refines it
const first = await prepareApp(request);
const w1 = launch(first);
first.watch(w1);
await first.made;
await startProcess(w1);
await run(w1, 100);
const refined = await first.refine(w1, 1);
first.close();
if (!refined?.kept) throw new Error("the refined app build was not kept");
const files = (await persist.load(await appKey(app, key)))!;
// a later launch finds the build: what it loads of the platform's, from its start to the first call of each workload
const second = await prepareApp(request);
if (!second.hit) throw new Error("the saved build is not found");
const w2 = launch(second);
if (!w2.appAttached) throw new Error("the saved build does not attach");
await startProcess(w2);
await run(w2, 0);
second.close();
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
for (const [name, bytes] of files) writeFileSync(join(out, name), bytes);
writeFileSync(join(out, "startup.json"), JSON.stringify(w2.aot!.loaded.filter((f) => /^[cd]\d+\.wasm$/.test(f))));
console.log(`app build of ${workloads.length} workloads: ${refined.methods} methods in ${refined.modules} files; ${files.size} files saved; platform modules a start and the first calls load: ${w2.aot!.loaded.length}`);
process.exit();
