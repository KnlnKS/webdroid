// The compile worker and the persisted app build: the protocol (compile-serve.ts over a MessageChannel, so the numbering handshake runs as it does with a Worker), second-tier units
// compiled elsewhere and adopted only while the numbering they rely on is the World's, an app build attached on top of the platform build and kept sound as dexes arrive, and the
// bounded store (persist.ts). Needs javac, d8 and a platform build in WEBDROID_AOT (`bun run wasm persist` makes a small one). The Chrome page runs the same over a real Worker and OPFS: boot-probe.
import { guestMemory } from "../../src/wasm/host/guest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import type { AotStore } from "../../src/wasm/link/aot";
import { DEOPT_ABI, sameMarks } from "../../src/wasm/link/aot";
import { Program } from "../../src/wasm/compiler/program";
import { World, type WorldOptions } from "../../src/wasm/link/world";
import { externs, intrinsics } from "../../src/wasm/link/intrinsics";
import { UnitCompiler } from "../../src/wasm/link/unit";
import { serveCompile, type CompileEnv } from "../../src/wasm/host/compile-serve";
import { CompileClient, type WorkerPort } from "../../src/wasm/host/compiler";
import { prepareApp } from "../../src/wasm/host/appcode";
import { fetchBundle } from "../../src/wasm/host/bundle";
import { Persist, SavedBuild, appKey, memoryBackend } from "../../src/wasm/host/persist";
import { heapUsed } from "../../src/wasm/host/stats";
import { loadDexes } from "./lib";
import { natives } from "./oracle";
import { AOSP, JAVA } from "./paths";
import { filesIn, shellIn } from "./tools";
import type { FetchStore } from "../../src/wasm/link/aotstore";
import type { DexFile } from "../../src/jvm/dex";

const AOT = process.env.WEBDROID_AOT;
if (!AOT) { console.log("persist: set WEBDROID_AOT to a build (aot-build.ts)"); process.exit(1); }
const out = mkdtempSync(join(tmpdir(), "j2w-persist-")), sh = shellIn(out);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(JAVA, "Pst.java"), join(JAVA, "Pst2.java")]);
sh(["d8", "--release", "--output", out, ...filesIn(out, /^Pst(\$\w+)?\.class$/)]);
sh(["mkdir", "-p", "out2"]);
sh(["d8", "--release", "--output", join(out, "out2"), "--classpath", out, ...filesIn(out, /^Pst2(\$\w+)?\.class$/)]);
const app = loadDexes(join(out, "classes.dex")), late = loadDexes(join(out, "out2/classes.dex"));

let failed = 0;
const check = (what: string, got: unknown, want: unknown) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };
const until = async (what: string, done: () => boolean, ms = 60000) => {
  const t0 = performance.now();
  while (!done()) { if (performance.now() - t0 > ms) { failed++; console.log(`FAIL ${what}: timed out`); return false; } await new Promise((r) => setTimeout(r, 2)); }
  return true;
};

const platformDexes = PLATFORM_JARS.flatMap((j) => loadDexes(join(AOSP, j)));
const platform = new Program(platformDexes); platform.addExterns(externs);
const aotStore: AotStore = { get: (file) => new Uint8Array(readFileSync(join(AOT, file))) };
const BASE = "aot://platform/";
const world = (dexes: DexFile[], opts: Partial<WorldOptions> = {}) => new World(new Program(dexes, platform), { intrinsics, natives, heapUsed, guest: guestMemory, aot: aotStore, ...opts });
/** a World as the tab makes one: the classes the host implements are added after the constructor (host/boot.ts) */
function hosted(dexes: DexFile[], opts: Partial<WorldOptions> = {}): World {
  const w = world(dexes, opts);
  for (const spec of natives.source!.hostSpecs!()) w.addHostClass(spec);
  return w;
}

const env: CompileEnv = { platform: async () => platformDexes, natives, intrinsics, externs, heapUsed, fetchBytes: async (url) => new Uint8Array(readFileSync(join(AOT, url.slice(BASE.length)))) };
const ports: WorkerPort[] = [];
const stopped = new WeakSet<WorkerPort>();
/** a compile worker over a MessageChannel in this thread */
function spawn(): WorkerPort {
  const { port1, port2 } = new MessageChannel();
  serveCompile(port2 as never, env);
  const port: WorkerPort = { postMessage: (m, t) => port1.postMessage(m, t as never), set onmessage(f) { port1.onmessage = f as never; }, get onmessage() { return port1.onmessage as never; },
    onerror: null, terminate: () => { stopped.add(port); port1.close(); port2.close(); } };
  ports.push(port);
  return port;
}
const answers = (w: World) => {
  const e = (name: string, desc: string, ...a: unknown[]) => w.entry("Pst", name, desc)(...a);
  return [e("chain", "()I"), e("fib", "(I)I", 15), e("hot", "(I)I", 3000), e("fill", "(I)I", 500), e("guarded", "(I)I", -3), e("viaTable", "(I)I", 21)];
};
const expected = answers(world(app));
check("fixture answers", expected.join(","), "6,610,65529,125374,-8,25");

// ---- the numbering handshake, without a worker: a unit made by a World that follows the page's numbering is the page's only while the page has numbered nothing else
{
  const page = world(app), worker = world(app, { compileOnly: true });
  page.entry("Pst", "hot", "(I)I")(10);
  const uc = new UnitCompiler(worker);
  check("the worker is where the page started", sameMarks(worker.numbering(), page.base), true);
  check("it follows the page's numbering", uc.sync(page.since(page.base), true), true);
  check("and then numbers the same", sameMarks(worker.numbering(), page.numbering()), true);
  const slot = page.slotOf(page.prog.resolve("Pst", "hot", "(I)I")!);
  const job = page.upgradeJob(slot)!, from = page.numbering();
  worker.selectorId("pst.extra()V");      // what a unit that needs a selector the page lacks would number
  const unit = uc.upgrade(job);
  if (typeof unit === "string") { failed++; console.log("FAIL upgrade:", unit); } else {
    check("the unit carries the selector it numbered", unit.numbering.selectors.join(), "pst.extra()V");
    check("it was numbered from the page's state", sameMarks(unit.numbering.from, from), true);
    page.selectorId("pst.other()V");        // the page numbered something meanwhile
    check("a unit that numbered something is not taken after the page did", page.adoptUnit(slot, job, unit, page.epoch), false);
    check("and the page's numbering is untouched", page.selKeys.at(-1), "pst.other()V");
    // the worker forgets its numbering and follows the page: the next unit is made over the page's state
    check("the worker takes the page's numbering after dropping its own", uc.sync(page.since(from), false), true);
    check("it forgot the selector it numbered", worker.selectors.has("pst.extra()V"), false);
    check("and has the page's", sameMarks(worker.numbering(), page.numbering()), true);
    const next = page.upgradeJob(slot)!, again = uc.upgrade(next);
    check("a unit made then is taken", typeof again !== "string" && page.adoptUnit(slot, next, again, page.epoch), true);
  }
}
{
  const page = world(app), worker = world(app, { compileOnly: true }), uc = new UnitCompiler(worker);
  page.entry("Pst", "hot", "(I)I")(10);
  uc.sync(page.since(page.base), true);
  const slot = page.slotOf(page.prog.resolve("Pst", "hot", "(I)I")!), job = page.upgradeJob(slot)!, unit = uc.upgrade(job);
  page.addDexes([]);
  check("a unit made before dex files were added is not taken", typeof unit !== "string" && page.adoptUnit(slot, job, unit, page.epoch - 1), false);
}

// ---- second-tier units from the worker
{
  const w = world(app), client = new CompileClient(spawn());
  const hooked = hosted(app, { compiler: client });
  client.start(hooked, BASE, undefined);
  await until("the worker starts", () => client.ready || !!client.retired);
  const hot = hooked.entry("Pst", "hot", "(I)I"), base = w.entry("Pst", "hot", "(I)I");
  for (let i = 0; i < 400 && !client.stats.adopted; i++) { check("hot answers while jobs run", hot(4000), base(4000)); await new Promise((r) => setTimeout(r, 1)); }
  await until("a unit is adopted", () => client.stats.adopted > 0);
  check("the page compiled no second tier itself", hooked.stats.upgrades, client.stats.adopted);
  check("the answers are the same after", answers(hooked).join(), expected.join());
  check("no job failed", client.stats.failed, 0);
  // a dex file in the default namespace follows to the worker; its units are made over the larger Program
  hooked.addDexes(late);
  check("a dex file added later undoes the devirtualised call", hooked.entry("Pst2", "sub", "()I")(), 500);
  check("the others are as before", hooked.entry("Pst", "chain", "()I")(), 6);
  const before = client.stats.jobs;
  for (let i = 0; i < 400 && client.stats.jobs === before; i++) { hot(4000); await new Promise((r) => setTimeout(r, 1)); }
  check("the worker went on serving", client.ready, true);
  console.log(`  second tier: ${client.stats.jobs} jobs, ${client.stats.adopted} adopted, ${client.stats.stale} stale, worker ${client.stats.workerMs.toFixed(1)} ms for them, started in ${client.stats.startMs.toFixed(0)} ms`);
  client.close();
}
{
  // something the worker cannot follow stops it, and the page compiles inline from then on
  const client = new CompileClient(spawn()), w = hosted(app, { compiler: client });
  client.start(w, BASE, undefined);
  await until("the worker starts", () => client.ready);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")), w.prog.newLoader(w.prog.root, null));
  check("a loader of its own retires the worker", client.ready, false);
  const call = w.entry("Pst", "hot", "(I)I");
  for (let i = 0; i < 4000 && !w.stats.upgrades; i++) call(4000);
  check("and the hot method is compiled inline", w.stats.upgrades > 0, true);
}

{
  // the worker applies the host's classes and overlays itself when the page has them; a page whose classes the worker does not end with is refused
  const port = spawn(), got: { type: string; message?: string }[] = [];
  port.onmessage = ({ data }) => got.push(data);
  await until("the worker loads", () => got.some((m) => m.type === "loaded"));
  port.postMessage({ type: "init", dexes: [], hostClasses: ["not/Hosted"], aot: { base: BASE } });
  await until("the worker answers", () => got.some((m) => m.type === "failed" || m.type === "ready"));
  check("a worker whose host classes are not the page's fails to start", got.some((m) => m.type === "failed" && /host classes/.test(m.message ?? "")), true);
}
{
  // the numbering of host classes and their hidden halves is the page's: hot code over a World with them is adopted whole
  const w = world(app), client = new CompileClient(spawn()), hooked = hosted(app, { compiler: client });
  check("host classes exist", hooked.hostClassNames().length > 0, true);
  client.start(hooked, BASE, undefined);
  await until("the worker starts", () => client.ready || !!client.retired);
  const hot = hooked.entry("Pst", "hot", "(I)I");
  for (let i = 0; i < 400 && !client.stats.adopted; i++) { hot(4000); await new Promise((r) => setTimeout(r, 1)); }
  check("a unit is adopted over a World with host classes", client.stats.adopted > 0, true);
  check("and the answers are the same", answers(hooked).join(), answers(w).join());
  client.close();
}

// ---- the app build
let saved: SavedBuild | undefined, savedFiles: Map<string, Uint8Array> | undefined;
{
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: { base: BASE, key: "platform" } as unknown as FetchStore, persist, spawn,
    roots: { launch: ["Pst", "Pst$Add", "Pst$Mul", "Pst$Base"] } };
  const t0 = performance.now(), first = await prepareApp(request);
  check("no build is saved for the app at first", first.hit, false);
  const made = await first.made!;
  check("the transferred build retires its worker", stopped.has(ports.at(-1)!), true);
  check("the build is kept", made.kept, true);
  console.log(`  app build: ${made.methods} methods in ${made.modules} module(s), ${made.ms.toFixed(0)} ms in the worker (${(performance.now() - t0).toFixed(0)} ms with the worker's start)`);
  const second = await prepareApp(request);
  check("a second launch finds it", second.hit, true);
  check("under a key made of the dex files and the platform build", await appKey(app, "platform") === await appKey(app, "platform") && await appKey(app, "platform") !== await appKey(app, "other") && await appKey(late, "platform") !== await appKey(app, "platform"), true);
  check("and a different platform build finds none", (await prepareApp({ ...request, aot: { base: BASE, key: "other" } as unknown as FetchStore })).hit, false);
  second.compiler.close();
  first.compiler.close();
  savedFiles = (await persist.load(await appKey(app, "platform")))!;
  saved = await SavedBuild.open(savedFiles);
  check("saved modules load with their matching activation policy", !!saved, true);
}

if (saved) {
  const index = saved.index, store = saved;
  const wrongPolicy = new Map(savedFiles!);
  wrongPolicy.set("index.json", new TextEncoder().encode(JSON.stringify({ ...index, deopt: index.deopt ? 0 : DEOPT_ABI })));
  check("saved module policy must match its index", await SavedBuild.open(wrongPolicy), undefined);
  check("app activation policy differs from platform", world(app, { app: { index: { ...index, deopt: index.deopt ? 0 : DEOPT_ABI }, store } }).appAttached, false);
  const plain = world(app);
  answers(plain);
  const w = world(app, { app: { index, store } });
  check("the app build attaches", w.appAttached, true);
  check("answers as without", answers(w).join(), expected.join());
  const loaded = w.aot!.loaded.filter((f) => f[0] === "a");
  check("its modules were loaded", loaded.length > 0, true);
  check("it compiled fewer methods on demand", w.stats.methods < plain.stats.methods, true);
  console.log(`  with the app build: ${w.stats.methods} methods compiled on demand against ${plain.stats.methods}, ${loaded.length} app module(s), ${w.stats.units} units`);
  // CHA: Base.f has one implementation in the build; a dex added later falsifies it
  const later = world(app, { app: { index, store } });
  check("chain before", later.entry("Pst", "chain", "()I")(), 6);
  later.addDexes(late);
  check("a falsified decision of the app build is undone", later.entry("Pst2", "sub", "()I")(), 500);
  check("from the code of the build", later.stats.invalidated >= 1, true);
  check("and the others hold", later.entry("Pst", "chain", "()I")(), 6);
  // the dex is in the Program from the start, behind the app's: the build still attaches, and the decision does not hold
  const together = world([...app, ...late], { app: { index, store } });
  check("the build attaches with later dex files in the Program", together.appAttached, true);
  check("their override is honoured by the code of the build", together.entry("Pst2", "sub", "()I")(), 500);
  check("which put the method back to be compiled on demand", together.stats.aot.dead >= 1, true);
  check("and the rest is as before", answers(together).join(), expected.join());
  // what does not match is not used
  check("other dex files find no build", world(late, { app: { index, store } }).appAttached, false);
  check("a changed base finds none", world(app, { app: { index: { ...index, base: { ...index.base, names: index.base.names + 1 } }, store } }).appAttached, false);
  check("a changed format finds none", world(app, { app: { index: { ...index, version: index.version + 1 }, store } }).appAttached, false);
  const stale = world(app);
  stale.entry("Pst", "chain", "()I")();
  check("a World that numbered something does not need the build to be sound", answers(stale).join(), expected.join());
  // a platform build that lacks some of its modules, and an app build that lacks some of its own
  const partial = world(app, { app: { index, store: { get: (f) => (f === "a0.wasm" ? undefined : store.get(f)) } } });
  check("a module that is missing is compiled on demand", answers(partial).join(), expected.join());
}

// ---- what a launch builds on demand goes into the next build
{
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: { base: BASE, key: "platform" } as unknown as FetchStore, persist, spawn,
    roots: { launch: ["Pst"] } };
  const first = await prepareApp(request);
  await first.made!;
  const second = await prepareApp(request), w = hosted(app, second.options);
  check("the first build attaches", w.appAttached, true);
  answers(w);
  check("the launch compiled methods the build lacked", w.demand.methods.size > 0, true);
  check("the classes its code names have modules in the build", (second.options.app?.index.dModules ?? 0) > 0 && w.stats.classes < 2, true);
  const built = await second.refine(w, 1);
  check("the build is made again with them", built?.kept, true);
  const third = await prepareApp(request), w3 = hosted(app, third.options);
  check("a launch after it finds it", w3.appAttached, true);
  check("answers as without", answers(w3).join(), expected.join());
  check("it compiled fewer methods on demand", w3.stats.methods < w.stats.methods, true);
  console.log(`  refined build: ${w3.stats.methods} methods built on demand against ${w.stats.methods}, ${third.options.app?.index.dModules} data module(s)`);
  check("nothing new to add the next time", await third.refine(w3, 1), undefined);
  for (const c of [first, second, third]) { c.compiler.close(); c.close(); }
}

// ---- a build the platform build ships
{
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: { base: "https://shipped.invalid/", key: "platform" } as unknown as FetchStore, persist, spawn, roots: { launch: ["Pst"] } };
  const key = await appKey(app, "platform"), origin = new Persist(memoryBackend());
  const made = await prepareApp({ ...request, persist: origin, aot: { base: BASE, key: "platform" } as unknown as FetchStore });
  await made.made!;
  const files = (await origin.load(key))!, realFetch = globalThis.fetch, requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(String(url));
    if (String(url) === `${request.aot.base}apps.json`) return Response.json([key]);
    if (String(url) === "https://empty.invalid/apps.json") return Response.json([]);
    const prefix = `${request.aot.base}app.${key}.`, name = String(url).slice(prefix.length);
    if (!String(url).startsWith(prefix)) return new Response("", { status: 404 });
    if (name === "json") return Response.json([...files.keys()]);
    return files.has(name) ? new Response(files.get(name) as BodyInit) : new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    const first = await prepareApp(request);
    check("a first launch finds the build the platform build ships", first.hit, true);
    check("discovery reads the catalog before app files", requests[0], `${request.aot.base}apps.json`);
    check("and keeps it for the next", (await persist.load(key))?.size, files.size);
    const next = await prepareApp(request), before = requests.length;
    check("the next launch reuses the saved shipped build", next.hit, true);
    const none = await prepareApp({ ...request, dexes: late, persist: new Persist(memoryBackend()) });
    check("an app it ships none for has none", none.hit, false);
    check("an unlisted app makes no file probes", requests.length, before);
    check("the catalog is reused at the same base", requests.filter((url) => url === `${request.aot.base}apps.json`).length, 1);
    check("an empty catalog ships no build", await fetchBundle("https://empty.invalid/", key), undefined);
    check("an empty catalog makes no file probes", requests.at(-1), "https://empty.invalid/apps.json");
    check("a missing catalog ships no build", await fetchBundle("https://missing.invalid/", key), undefined);
    check("a missing catalog makes no file probes", requests.at(-1), "https://missing.invalid/apps.json");
    for (const c of [made, first, next, none]) { c.compiler.close(); c.close(); }
  } finally { globalThis.fetch = realFetch; }
}

// ---- the store
{
  const fs = memoryBackend(), p = new Persist(fs, { entry: 100, total: 250 }), blob = (n: number) => new Uint8Array(n).fill(n);
  check("an entry is kept", await p.save("a", [["x", blob(60)], ["y", blob(30)]]), true);
  check("and loaded", (await p.load("a"))?.get("y")?.length, 30);
  check("an entry over the limit is not kept", await p.save("big", [["x", blob(101)]]), false);
  check("none is loaded for it", await p.load("big"), undefined);
  await p.save("b", [["x", blob(90)]]);
  await p.load("a");                                  // a is now the more recent
  await p.save("c", [["x", blob(90)]]);               // 90 + 90 + 90 > 250 - 90: b goes
  check("the least recently used entry is evicted for room", [await p.load("a") !== undefined, await p.load("b") !== undefined, await p.load("c") !== undefined].join(), "true,false,true");
  check("its files are gone", [...fs.files.keys()].some((k) => k.startsWith("b/")), false);
  fs.files.set("a/x", blob(5));
  check("a damaged entry is not loaded", await p.load("a"), undefined);
  check("and is removed", [...fs.files.keys()].some((k) => k.startsWith("a/")), false);
  check("replacing an entry leaves one", (await p.save("c", [["z", blob(10)]]), [...fs.files.keys()].filter((k) => k.startsWith("c/")).join()), "c/z");
}
for (const p of ports) p.terminate();
console.log(failed ? `${failed} failures` : "persist: all pass");
process.exit(failed ? 1 : 0);
