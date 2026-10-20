// The compile worker and the persisted app build: the protocol (compile-serve.ts over a MessageChannel, so the numbering handshake runs as it does with a Worker), second-tier units
// compiled elsewhere and adopted only while the numbering they rely on is the World's, an app build attached on top of the platform build and kept sound as dexes arrive, and the
// bounded store (persist.ts). Needs javac, d8 and a platform build in WEBDROID_AOT (`pnpm wasm persist` makes a small one). The Chrome page runs the same over a real Worker and OPFS: boot-probe.
import { vfs } from "../../src/shell/vfs.ts";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AotStore } from "../../src/wasm/link/aot.ts";
import { APP_VERSION, VERSION, packModule } from "../../src/wasm/link/aot.ts";
import { sameMarks } from "../../src/wasm/link/numbers.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { World, type WorldOptions } from "../../src/wasm/link/world.ts";
import { externs, intrinsics } from "../../src/wasm/link/intrinsics.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { compileModule } from "../../src/wasm/link/module.ts";
import { UnitCompiler } from "../../src/wasm/link/unit.ts";
import { buildApp, buildPart, mergeApp } from "../../src/wasm/link/apps.ts";
import { serveCompile, type CompileEnv } from "../../src/wasm/host/compile-serve.ts";
import { CompileClient, type WorkerPort } from "../../src/wasm/host/compiler.ts";
import { prepareApp } from "../../src/wasm/host/appcode.ts";
import { fetchBundle } from "../../src/wasm/host/bundle.ts";
import { Persist, SavedBuild, appKey, memoryBackend } from "../../src/wasm/host/persist.ts";
import { heapUsed } from "../../src/wasm/host/stats.ts";
import { current, fakeAot } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { worldOptions } from "../../src/wasm/host/boot.ts";
import { addHostClasses, mountPlatform, natives, startProcess } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { checker } from "./tools.ts";
import { filesIn, fixture } from "../java.ts";
import type { DexFile } from "../../src/jvm/dex.ts";

const AOT = process.env.WEBDROID_AOT;
if (!AOT) { console.log("persist: set WEBDROID_AOT to a build (aot-build.ts)"); process.exit(1); }
const out = fixture({ sources: [join(JAVA, "Pst.java"), join(JAVA, "Pst2.java")], classes: /^Pst(\$\w+)?\.class$/ });
fixture({ out: join(out, "out2"), classpath: [out], classes: filesIn(out, /^Pst2(\$\w+)?\.class$/) });
const app = loadDexes(join(out, "classes.dex")), late = loadDexes(join(out, "out2/classes.dex"));
await mountPlatform(ROOT);

const suite = checker("persist"), { check, fail } = suite;
const until = async (what: string, done: () => boolean, ms = 60000) => {
  const t0 = performance.now();
  while (!done()) { if (performance.now() - t0 > ms) { fail(`${what}: timed out`); return false; } await new Promise((r) => setTimeout(r, 2)); }
  return true;
};

const platformDexes = PLATFORM_PATHS.flatMap(loadDexes);
const platform = new Program(platformDexes); platform.addExterns(externs);
const aotStore: AotStore = { get: (file) => new Uint8Array(readFileSync(join(AOT, file))) };
const BASE = "aot://platform/";
const world = (dexes: DexFile[], opts: Partial<WorldOptions> = {}) => current(new World(new Program(dexes, platform), { ...worldOptions(), aot: aotStore, ...opts }));
/** a World as the tab makes one: the classes the host implements are added after the constructor (host/boot.ts) */
const hosted = (dexes: DexFile[], opts: Partial<WorldOptions> = {}): World => addHostClasses(world(dexes, opts));

// A combined image links the app's default namespace as the Program resolves it.
{
  const dexes = loadDexes(join(out, "classes.dex"));
  const image = world(dexes, { aot: undefined, compileOnly: true, build: { dexes: new Set([...platformDexes, ...dexes]), appDexes: new Set(dexes), dGroup: name => name, cGroup: name => name } });
  check("combined image retains platform boot ownership", image.prog.loaderOf("java/lang/Object") === image.prog.boot, true);
  check("combined image retains app root ownership", image.prog.loaderOf("Pst") === image.prog.root, true);
  const cx = new Compiler(image), bytes = cx.buildUnit([image.prog.resolve("Pst", "chain", "()I")!]).bytes;
  compileModule(bytes);
  check("combined image app code links its default namespace statically", cx.symbolicImports.size, 0);
  const boot = new Compiler(image);
  boot.buildUnit([image.prog.resolve("java/lang/Object", "hashCode", "()I")!]);
  check("combined image does not defer platform methods", boot.symbolicImports.size, 0);
}

// Optional probe for a CLI-built --app image, kept separate from the platform store.
const combinedAt = process.argv.indexOf("--combined-image");
if (combinedAt >= 0) {
  const dir = process.argv[combinedAt + 1], dex = process.argv[combinedAt + 2];
  if (!dir || !dex) throw new Error("--combined-image requires image directory and app dex");
  const input = loadDexes(dex), store: AotStore = { get: file => { try { return new Uint8Array(readFileSync(join(dir, file))); } catch { return undefined; } } };
  const image = world(input, { aot: store }), control = world(loadDexes(dex), { aot: undefined });
  check("CLI combined image attaches", !!image.aot, true);
  check("CLI combined image retains app root", image.prog.loaderOf("Pst") === image.prog.root, true);
  for (const [name, desc, args] of [["chain", "()I", []], ["hot", "(I)I", [10]], ["viaTable", "(I)I", [3]]] as [string, string, number[]][]) {
    const expected = await control.entryAsync("Pst", name, desc)(...args);
    check(`CLI combined image ${name}`, await image.entryAsync("Pst", name, desc)(...args), expected);
  }
  const method = image.prog.resolve("Pst", "hot", "(I)I")!, module = image.aot?.platformModule(image.slots.blockOf(image.slotOf(method)));
  check("CLI combined image executes its app code module", module !== undefined && module >= 0 && image.aot!.loaded.includes(`c${module}.wasm`), true);
  const resolutions = image.symbolic.symbolicResolutions, expected = await control.entryAsync("Pst", "hot", "(I)I")(10);
  check("CLI combined image warm result", await image.entryAsync("Pst", "hot", "(I)I")(10), expected);
  check("CLI combined image warm resolutions", image.symbolic.symbolicResolutions, resolutions);
}

const env: CompileEnv = { platform: async () => platformDexes, natives, intrinsics, externs, heapUsed, fetchBytes: async (url) => new Uint8Array(readFileSync(join(AOT, url.slice(BASE.length)))) };
// A one-shot Builder and a refine-capable worker must produce the same numbered code.
{
  const run = async (oneShot: boolean, refine = false, build = true) => {
    const responses: import("../../src/wasm/host/compile-serve.ts").CompileResponse[] = [];
    const port: import("../../src/wasm/host/compile-serve.ts").Port = { onmessage: null, postMessage: m => responses.push(m as typeof responses[number]) };
    serveCompile(port, env);
    await port.onmessage!({ data: { type: "init", dexes: [["classes.dex", new Uint8Array(readFileSync(join(out, "classes.dex")))]],
      aot: { base: BASE }, ...(build && { build: { launch: ["Pst"], limit: 500 } }), ...(oneShot && { oneShot: true }) } } as MessageEvent);
    if (refine) await port.onmessage!({ data: { type: "refine", demand: { methods: [], classes: [], infos: [] } } } as MessageEvent);
    return responses;
  };
  const initial = await run(false, true), once = await run(true), bad = await run(true, false, false);
  const builds = initial.filter((r): r is Extract<typeof r, { type: "built" }> => r.type === "built");
  const one = once.find((r): r is Extract<typeof r, { type: "built" }> => r.type === "built");
  const equalBuild = (a: typeof one, b: typeof one) => !!a && !!b && a.methods === b.methods && "index" in a.part && "index" in b.part && JSON.stringify(a.part.index) === JSON.stringify(b.part.index)
    && a.part.files.length === b.part.files.length && a.part.files.every(([name, bytes], i) => name === b.part.files[i][0] && Buffer.compare(bytes, b.part.files[i][1]) === 0);
  check("one-shot build equals refine-capable payload", equalBuild(builds[0], one), true);
  check("refine-capable worker remains usable", builds.length, 2);
  check("refine-capable init retains ready", initial.filter(r => r.type === "ready").length, 1);
  check("one-shot init finishes at built", once.map(r => r.type).join(","), "loaded,built");
  check("one-shot without roots fails", bad.map(r => r.type).join(","), "loaded,failed");
}
const ports: WorkerPort[] = [];
const stopped = new WeakSet<WorkerPort>();
/** a compile worker over a MessageChannel in this thread */
function spawn(): WorkerPort { return spawnWithEnv(env); }
function spawnWithEnv(workerEnv: CompileEnv, received?: string[]): WorkerPort {
  const { port1, port2 } = new MessageChannel();
  if (received) port2.addEventListener("message", ({ data }) => received.push(data.type));
  serveCompile(port2 as never, workerEnv);
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

// A build made in shards, each World compiling its share with the numbering they share frozen, runs as the app does.
{
  const part = (shard: number) => {
    const w = world(app, { compileOnly: true });
    return buildPart(w, [...w.prog.own()].flatMap((c) => c.methods.filter((m) => m.codeOff)), { methods: [], classes: [], infos: [] }, shard, 3);
  };
  const [lead, ...rest] = [0, 1, 2].map(part);
  if (!("index" in lead)) throw new Error("the first shard made no index");
  const built = mergeApp(lead, rest), files = new Map(built.files), w = world(app, { app: { index: built.index, store: { get: (f) => files.get(f) } } });
  check("a build made in shards attaches", w.appAttached, true);
  check("and answers as without", answers(w).join(), expected.join());
  check("with another shard's code loaded", rest.flatMap((p) => p.files).some(([name]) => w.aot!.loaded.includes(name)), true);
}

// App data must not reinstall the platform's reserved, uncompiled classes.
{
  const producer = world(app, { compileOnly: true });
  const name = producer.slots.blockClass.find(n => producer.idOf(n) > producer.aot!.nSeeded && producer.prog.get(n)?.dex && producer.aot!.reservedBase(n) !== undefined);
  if (name) {
    const built = buildApp(producer, [], { classes: [name, "Pst$Base"], methods: [], infos: [] }), files = new Map(built.files);
    const page = world(app, { app: { index: built.index, store: { get: f => files.get(f) } } });
    const owner = page.link(name), slot = owner.slotBase + owner.nMethods, initialize = page.table.get(slot);
    page.link("Pst$Base");
    check("app data preserves the platform's class initializer", page.table.get(slot), initialize);
  }
}

// A partial final group can discover dependencies that discover another group.
{
  const w = world(app, { compileOnly: true });
  const padding = 64 - w.slots.synths().length % 64;
  for (let i = 0; i < padding; i++) w.synthSlot(`pst:padding:${i}`, { params: [], ret: "V", body: () => {} });
  const leaf = { params: [], ret: "V" as const, body: () => {} };
  w.synthSlot("pst:parent", { ...leaf, body: (cx, c) => {
    const slot = cx.w.synthSlot("pst:child", { ...leaf, body: (next, code) => {
      code.i32(next.w.synthSlot("pst:leaf", leaf)).callIndirect(next.sig([], "V"));
    } });
    c.i32(slot).callIndirect(cx.sig([], "V"));
  } });
  const built = buildApp(w, [], { classes: [], methods: [], infos: [] });
  const kept = new Set(built.index.synths.flat());
  check("partial synthetic group keeps its discovered child", kept.has("pst:child"), true);
  check("discovered synthetic group keeps its own dependency", kept.has("pst:leaf"), true);
}

// ---- the numbering handshake, without a worker: a unit made by a World that follows the page's numbering is the page's only while the page has numbered nothing else
{
  // hierarchy certificates carry what a dynamic namespace resolved through Java
  const page = world(app), worker = world(app, { compileOnly: true });
  page.prog.dynamicRoot = worker.prog.dynamicRoot = true;
  page.entry("Pst", "hot", "(I)I")(10);
  const uc = new UnitCompiler(worker);
  check("the worker is where the page started", sameMarks(worker.numbers.marks(), page.base), true);
  check("it follows the page's numbering", uc.sync(page.numbers.since(page.base), true), true);
  check("and then numbers the same", sameMarks(worker.numbers.marks(), page.numbers.marks()), true);
  const slot = page.slotOf(page.prog.resolve("Pst", "hot", "(I)I")!);
  const job = page.tiers.upgradeJob(slot)!, from = page.numbers.marks();
  check("worker carries prepared hierarchy certificates", !!job.prepared?.length, true);
  if (job.prepared?.length) {
    const bad = { ...job, prepared: job.prepared.map(([key, sup, ifaces], i) => [key, i ? sup : "fixture/WrongSuperclass", ifaces] as [string, string | null, string[]]) };
    const rejected = world(app, { compileOnly: true }), rejecting = new UnitCompiler(rejected);
    rejected.prog.dynamicRoot = true;
    bad.resolved = [...job.resolved ?? [], ["Pst", "fixture/RejectedIdentity", "Pst"]];
    if (!bad.prepared.some(([key]) => key === "Pst")) {
      const cls = rejected.prog.get("Pst")!;
      bad.prepared.push(["Pst", cls.sup, [...cls.ifaces]]);
    }
    check("worker rejects a mismatched prepared hierarchy", typeof rejecting.upgrade(bad), "string");
    check("rejected hierarchy leaves initiating identity untouched", rejected.prog.initiatedBy(rejected.prog.root, "fixture/RejectedIdentity"), undefined);
    check("worker rejects missing hierarchy certificates", typeof uc.upgrade({ ...job, prepared: undefined }), "string");
  }
  worker.selectorId("pst.extra()V");      // what a unit that needs a selector the page lacks would number
  const unit = uc.upgrade(job);
  if (typeof unit === "string") { fail(`upgrade: ${unit}`); } else {
    check("the unit carries the selector it numbered", unit.numbering.selectors.join(), "pst.extra()V");
    check("it was numbered from the page's state", sameMarks(unit.numbering.from, from), true);
    page.selectorId("pst.other()V");        // the page numbered something meanwhile
    check("a unit that numbered something is not taken after the page did", page.tiers.adoptUnit(slot, job, unit, page.epoch), false);
    check("and the page's numbering is untouched", page.numbers.selKeys.at(-1), "pst.other()V");
    // the worker forgets its numbering and follows the page: the next unit is made over the page's state
    check("the worker takes the page's numbering after dropping its own", uc.sync(page.numbers.since(from), false), true);
    check("it forgot the selector it numbered", worker.numbers.selectors.has("pst.extra()V"), false);
    check("and has the page's", sameMarks(worker.numbers.marks(), page.numbers.marks()), true);
    const next = page.tiers.upgradeJob(slot)!, again = uc.upgrade(next);
    if (typeof again !== "string") {
      check("a worker unit without a stub format is rejected", page.tiers.adoptUnit(slot, next, { ...again, header: { ...again.header, version: undefined } }, page.epoch), false);
      check("a worker unit with the previous stub format is rejected", page.tiers.adoptUnit(slot, next, { ...again, header: { ...again.header, version: VERSION - 1 } }, page.epoch), false);
    }
    check("a unit made then is taken", typeof again !== "string" && page.tiers.adoptUnit(slot, next, again, page.epoch), true);
  }
}
{
  const page = world(app), worker = world(app, { compileOnly: true }), uc = new UnitCompiler(worker);
  page.entry("Pst", "hot", "(I)I")(10);
  uc.sync(page.numbers.since(page.base), true);
  const slot = page.slotOf(page.prog.resolve("Pst", "hot", "(I)I")!), job = page.tiers.upgradeJob(slot)!, unit = uc.upgrade(job);
  page.addDexes([]);
  check("a unit made before dex files were added is not taken", typeof unit !== "string" && page.tiers.adoptUnit(slot, job, unit, page.epoch - 1), false);
}

// ---- second-tier units from the worker
{
  const w = world(app), beforeSpawn = ports.length, client = new CompileClient(spawn);
  const hooked = hosted(app, { compiler: client });
  client.start(hooked, BASE, undefined);
  check("an unused upgrade service creates no worker", ports.length, beforeSpawn);
  hooked.addDexes(late);
  const hot = hooked.entry("Pst", "hot", "(I)I"), base = w.entry("Pst", "hot", "(I)I");
  for (let i = 0; i < 400 && !client.stats.adopted; i++) { check("hot answers while jobs run", hot(4000), base(4000)); await new Promise((r) => setTimeout(r, 1)); }
  await until("a unit is adopted", () => client.stats.adopted > 0);
  check("the first hot request creates one worker", ports.length, beforeSpawn + 1);
  check("late DEX before worker startup is visible", hooked.entry("Pst2", "sub", "()I")(), 500);
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
  const initializing = Promise.withResolvers<void>(), received: string[] = [];
  const client = new CompileClient(() => spawnWithEnv({ ...env, platform: async () => { await initializing.promise; return platformDexes; } }, received));
  const path = "/data/local/tmp/persist-proxy.dex";
  vfs.mount(path, new BytesFile(new Uint8Array(readFileSync(join(out, "classes.dex")))));
  const w = hosted(app, { compiler: client, holdUpgrades: () => true, dexes: name => name === path ? app : undefined });
  await startProcess(w);
  await w.entryAsync("Pst", "setupLoader", "(Ljava/lang/String;)V")(path);
  const make = w.entryAsync("Pst", "makeProxy", "(I)I");
  check("bootstrap Proxy before worker startup executes", await make(3), 1);
  check("BootClassLoader Proxy before worker startup executes", await make(0), 2);
  client.start(w, BASE, undefined);
  w.entry("Pst", "hot", "(I)I")(10);
  client.submit(w, w.slotOf(w.prog.resolve("Pst", "hot", "(I)I")!));
  await until("the worker receives initialization", () => received.includes("init"));
  check("app Proxy while worker initializes executes", await make(1), 12);
  await until("the worker receives a Proxy during initialization", () => received.includes("proxy"));
  initializing.resolve();
  await until("the worker with initial Proxies starts", () => client.ready || !!client.retired);
  check("a new Proxy after worker startup executes", await make(2), 12);
  check("Proxy definitions keep the worker ready", client.ready, true);
  const proxyClass = [...w.prog.own()].filter(c => c.sup === "java/lang/reflect/Proxy").at(-1)!;
  const method = proxyClass.byKey.get("apply(I)I")!;
  const slot = w.slotOf(method), before = w.table.get(slot);
  check("the worker accepts a Proxy body", client.submit(w, slot), true);
  await until("a Proxy body is adopted", () => w.table.get(slot) !== before);
  check("worker Proxy code reads the page's pinned Method", await w.entryAsync("Pst", "callProxy", "(I)I")(20), 27);
  check("Proxy jobs have no failures", client.stats.failed, 0);
  client.close();
}
{
  const initializing = Promise.withResolvers<void>(), received: string[] = [];
  const client = new CompileClient(() => spawnWithEnv({ ...env, platform: async () => { await initializing.promise; return platformDexes; } }, received));
  const w = hosted(app, { compiler: client, holdUpgrades: () => true });
  const first = w.prog.newLoader(w.prog.root, null), second = w.prog.newLoader(w.prog.boot, null);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")), first);
  w.namespaces.bindLibraries(second, [w.prog.root], []);
  client.start(w, BASE, undefined);
  const key = (id: number) => `Pst2@${id}`;
  check("initial namespaced DEX executes", await w.entryAsync(key(first.id), "sub", "()I")(), 500);
  client.submit(w, w.slotOf(w.prog.resolve(key(first.id), "sub", "()I")!));
  await until("namespaced worker receives initialization", () => received.includes("init"));
  w.addDexes(loadDexes(join(out, "out2/classes.dex")), second);
  await until("namespaced DEX reaches the initializing worker", () => received.includes("add"));
  initializing.resolve();
  await until("namespaced worker starts", () => client.ready || !!client.retired);
  const third = w.prog.newLoader(w.prog.boot, null);
  w.namespaces.bindLibraries(third, [], [w.prog.root]);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")), third);
  for (const loader of [second, third]) {
    const call = w.entryAsync(key(loader.id), "sub", "()I");
    check("namespaced source result", await call(), 500);
    if (loader === second) {
      w.namespaces.bindLibraries(second, [], [w.prog.root]);
      await until("a linked namespace change reaches the worker", () => received.includes("namespaces"));
      check("source result after library rebinding", await call(), 500);
    }
    const slot = w.slotOf(w.prog.resolve(key(loader.id), "sub", "()I")!), before = w.table.get(slot);
    check("namespaced worker accepts the method", client.submit(w, slot), true);
    await until("namespaced code is adopted", () => w.table.get(slot) !== before || !!client.retired);
    check("namespaced code replaces the source body", w.table.get(slot) !== before, true);
    check("namespaced worker result", await call(), 500);
  }
  check("same DEX has distinct defining identities", w.idOf(key(second.id)) !== w.idOf(key(third.id)), true);
  check("namespaces keep the worker ready", client.ready, true);
  check("namespaced jobs have no failures", client.stats.failed, 0);
  client.close();
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
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: fakeAot(BASE, "platform"), persist, spawn,
    roots: { launch: ["Pst", "Pst$Add", "Pst$Mul", "Pst$Base"] } };
  const t0 = performance.now(), first = await prepareApp(request);
  check("no build is saved for the app at first", first.hit, false);
  first.watch(hosted(app, { app: first.saved, compiler: first.compiler }));
  const made = await first.made!;
  check("the transferred build retires its worker", stopped.has(ports.at(-1)!), true);
  check("the build is kept", made.kept, true);
  console.log(`  app build: ${made.methods} methods in ${made.modules} module(s), ${made.ms.toFixed(0)} ms in the worker (${(performance.now() - t0).toFixed(0)} ms with the worker's start)`);
  const second = await prepareApp(request);
  check("a second launch finds it", second.hit, true);
  check("under a key made of the dex files and the platform build", await appKey(app, "platform") === await appKey(app, "platform") && await appKey(app, "platform") !== await appKey(app, "other") && await appKey(late, "platform") !== await appKey(app, "platform"), true);
  check("and a different platform build finds none", (await prepareApp({ ...request, aot: fakeAot(BASE, "other") })).hit, false);
  second.compiler.close();
  first.close();
  savedFiles = (await persist.load(await appKey(app, "platform")))!;
  saved = await SavedBuild.open(savedFiles);
  check("saved modules load", !!saved, true);
}

if (saved) {
  const index = saved.index, store = saved;
  const oldIndex = { ...index, version: APP_VERSION - 1 }, oldSaved = new Map(savedFiles!);
  oldSaved.set("index.json", new TextEncoder().encode(JSON.stringify(oldIndex)));
  check("previous app index is rejected by persistence", await SavedBuild.open(oldSaved), undefined);
  check("previous app index is rejected before attachment", world(app, { app: { index: oldIndex, store } }).appAttached, false);
  const oldData = new Map(savedFiles!);
  const dataName = [...oldData.keys()].find(name => /^e\d+\.wasm$/.test(name))!;
  oldData.set(dataName, packModule({ version: VERSION - 1 }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)));
  check("previous data stub format is rejected by persistence", await SavedBuild.open(oldData), undefined);
  const plain = world(app);
  answers(plain);
  const w = world(app, { app: { index, store } });
  check("the app build attaches", w.appAttached, true);
  check("answers as without", answers(w).join(), expected.join());
  const loaded = w.aot!.loaded.filter((f) => f[0] === "a");
  check("its modules were loaded", loaded.length > 0, true);
  check("it compiled fewer methods on demand", w.stats.methods < plain.stats.methods, true);
  console.log(`  with the app build: ${w.stats.methods} methods compiled on demand against ${plain.stats.methods}, ${loaded.length} app module(s), ${w.stats.units} units`);
  // A later override must be honoured without losing sound code from the saved build.
  const later = world(app, { app: { index, store } });
  check("chain before", later.entry("Pst", "chain", "()I")(), 6);
  later.addDexes(late);
  check("a falsified decision of the app build is undone", later.entry("Pst2", "sub", "()I")(), 500);
  const resolutions = later.symbolic.symbolicResolutions;
  check("and the others hold", later.entry("Pst", "chain", "()I")(), 6);
  check("late dex preserves resolved symbolic identities", later.symbolic.symbolicResolutions, resolutions);
  // the dex is in the Program from the start, behind the app's: the build still attaches, and the decision does not hold
  const together = world([...app, ...late], { app: { index, store } });
  check("the build attaches with later dex files in the Program", together.appAttached, true);
  check("their override is honoured by the code of the build", together.entry("Pst2", "sub", "()I")(), 500);
  check("sound code from the build remains in use", together.stats.aot.c > 0, true);
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
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: fakeAot(BASE, "platform"), persist, spawn,
    roots: { launch: ["Pst"], whole: false, limit: 500 } };
  const first = await prepareApp(request);
  first.watch(hosted(app, { app: first.saved, compiler: first.compiler }));
  await first.made!;
  const second = await prepareApp(request), w = hosted(app, { app: second.saved, compiler: second.compiler });
  check("the first build attaches", w.appAttached, true);
  answers(w);
  check("the launch compiled methods the build lacked", w.demand.methods.size > 0, true);
  check("the classes its code names have modules in the build", (second.saved?.index.dModules ?? 0) > 0 && w.stats.classes < 2, true);
  const built = await second.refine(w, 1);
  check("the build is made again with them", built?.kept, true);
  const third = await prepareApp(request), w3 = hosted(app, { app: third.saved, compiler: third.compiler });
  check("a launch after it finds it", w3.appAttached, true);
  check("answers as without", answers(w3).join(), expected.join());
  check("it compiled fewer methods on demand", w3.stats.methods < w.stats.methods, true);
  console.log(`  refined build: ${w3.stats.methods} methods built on demand against ${w.stats.methods}, ${third.saved?.index.dModules} data module(s)`);
  check("nothing new to add the next time", await third.refine(w3, 1), undefined);
  for (const c of [first, second, third]) { c.compiler.close(); c.close(); }
}

// ---- a build the platform build ships
{
  const persist = new Persist(memoryBackend()), request = { dexes: app, aot: fakeAot("https://shipped.invalid/", "platform"), persist, spawn, roots: { launch: ["Pst"] } };
  const key = await appKey(app, "platform"), origin = new Persist(memoryBackend());
  const made = await prepareApp({ ...request, persist: origin, aot: fakeAot(BASE, "platform") });
  made.watch(hosted(app, { app: made.saved, compiler: made.compiler }));
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
    check("the first build came from the bundle", first.source, "bundle");
    check("discovery reads the catalog before app files", requests[0], `${request.aot.base}apps.json`);
    check("the shipped build save completes", await first.persisted, true);
    check("and keeps it for the next", (await persist.load(key))?.size, files.size);
    const next = await prepareApp(request), before = requests.length;
    check("the next launch reuses the saved shipped build", next.hit, true);
    check("the next build came from persistence", next.source, "persist");
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
  await Promise.all([p.save("e", [["x", blob(20)]]), p.save("f", [["x", blob(20)]])]);
  check("overlapping saves keep both entries", [await p.load("e") !== undefined, await p.load("f") !== undefined].join(), "true,true");
  check("replacing an entry leaves one", (await p.save("c", [["z", blob(10)]]), [...fs.files.keys()].filter((k) => k.startsWith("c/")).join()), "c/z");
  const prefix = { from: { names: 1, tail: 2, selectors: 3, gaps: 0, links: 0 }, names: ["A$$host", "B"], tail: [["B", 4]] as [string, number][], selectors: ["m()V"], gaps: [], links: [] };
  check("no prefix is kept before one is saved", await p.prefix("platform"), undefined);
  await p.savePrefix("platform", prefix);
  check("a saved prefix is read back under its platform build", JSON.stringify(await p.prefix("platform")), JSON.stringify(prefix));
  check("and not under another", await p.prefix("other"), undefined);
  check("the prefix leaves the bounded entries alone", [await p.load("c") !== undefined, (await p.save("d", [["x", blob(100)]]), await p.prefix("platform") !== undefined)].join(), "true,true");
}
for (const p of ports) p.terminate();
suite.done();
