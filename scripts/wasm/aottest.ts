// Precompiled platform code (aot.ts) stays sound when classes arrive after the build: it relies on no class-hierarchy decision, so a dex that
// overrides a method it calls takes effect through dispatch, whether the dex is added later or present from the start, and the code stays installed.
// Needs javac, d8 and a build of the platform in WEBDROID_AOT (aot-build.ts), which `pnpm wasm aottest` makes when it is unset.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packModule, VERSION, type AotStore, type CHeader, type DHeader } from "../../src/wasm/link/aot.ts";
import { hostLoop } from "../../src/wasm/host/boot.ts";
import { compileModule } from "../../src/wasm/link/module.ts";
import { WarmWorld, type WarmCall } from "../../src/wasm/link/warmshim.ts";
import { program, world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { buildApp } from "../../src/wasm/link/apps.ts";
import { natives } from "./harness.ts";
import { nativeSource } from "../../src/wasm/host/nativesource.ts";
import { Natives } from "../../src/wasm/host/natives.ts";
import { JAVA } from "./paths.ts";
import { PLATFORM_PATHS } from "../aosp.ts";
import { checker } from "./tools.ts";
import { filesIn, fixture, tempDir } from "../java.ts";

const build = process.env.WEBDROID_AOT;
if (!build) { console.log("aottest: set WEBDROID_AOT to a build (aot-build.ts)"); process.exit(1); }
const jars = PLATFORM_PATHS;
const out = fixture({ sources: [join(JAVA, "Aot.java"), join(JAVA, "Aot2.java")], classes: /^Aot(\$\w+)?\.class$/ });
fixture({ out: join(out, "out2"), classpath: [out], classes: filesIn(out, /^Aot2(\$\w+)?\.class$/) });

const suite = checker("aottest"), { check } = suite;
const key = "java/util/ArrayList.indexOf(Ljava/lang/Object;)I";
const fileOf = (f: string) => new Uint8Array(readFileSync(join(build, f)));

const slotOf = (w: ReturnType<typeof world>, cls: string, name: string, desc: string) => w.slotOf(w.prog.resolve(cls, name, desc)!);
const installed = (w: ReturnType<typeof world>, slot: number) => { const s = w.slots.at(slot); return s?.k === "method" && s.done; };
const containsInstalled = (w: ReturnType<typeof world>) => installed(w, slotOf(w, "java/util/ArrayList", "contains", "(Ljava/lang/Object;)Z"));
{
  const w = world([join(out, "classes.dex"), ...jars], { natives });
  check("the build is attached", !!w.aot, true);
  check("ArrayList.contains before", w.entry("Aot", "plain", "()I")(), 0);
  check("it ran precompiled", w.stats.aot.c > 0, true);
  check("it relies on no hierarchy decision", w.assumptions.decisions.has(key), false);
  check("bodies run in place keep their frames, initialization order and stores", w.entry("Aot", "inlined", "()I")(), 31);
  w.assumptions.undoCode(slotOf(w, "Aot", "first", "(LAot$Pair;)I"));
  check("undoing a method undoes the code that runs its body in place", installed(w, slotOf(w, "Aot", "inlined", "()I")), false);
  // the warm Worker mirrors a module's imports from its bytes and compiles its methods by calling them into the warm trap
  const warm = new WarmWorld(), mirrored = w.aot!.loaded.filter((f) => /^c\d+\.wasm$/.test(f)).map((f) => warm.load(compileModule(fileOf(f)), fileOf(f)));
  check("the warm shim mirrors every loaded code module", mirrored.filter((m) => typeof m === "string").join(), "");
  const [, method, args] = (mirrored as WarmCall[][]).flat()[0];
  let trapped = false;
  try { method(...args); } catch (e) { trapped = e instanceof WebAssembly.RuntimeError; }
  check("a warmed method traps as it is entered", trapped, true);
  const library = w.prog.newLoader(w.prog.root, null);
  w.addDexes(loadDexes(join(out, "classes.dex")), library);
  w.namespaces.bindLibraries(library, [w.prog.newLoader(w.prog.boot, null)], []);
  check("a descriptor-only rebind keeps the result", w.entry("Aot", "plain", "()I")(), 0);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("a subclass overriding indexOf takes effect", w.entry("Aot2", "sub", "()I")(), 1);
  check("and the plain list is as before", w.entry("Aot2", "plain", "()I")(), 0);
  check("the precompiled contains stays installed", containsInstalled(w), true);
}
{
  const w = world([join(out, "classes.dex"), join(out, "out2/classes.dex"), ...jars], { natives });
  check("the build is attached with the app's classes in the Program", !!w.aot, true);
  check("the subclass takes effect", w.entry("Aot2", "sub", "()I")(), 1);
  check("the plain list is as before", w.entry("Aot", "plain", "()I")(), 0);
  check("the precompiled contains is installed", containsInstalled(w), true);
}

// A class the host implements takes the place of the build's code for the methods it names, however the module that holds them is loaded.
{
  const host = new Natives({ ...nativeSource, find: (cls, k, isStatic, hasBody) => (cls === "java/util/ArrayList" && k === key.slice(key.indexOf(".") + 1) ? () => 42 : nativeSource.find(cls, k, isStatic, hasBody)) });
  const w = world([join(out, "classes.dex"), ...jars], { natives: host });
  w.addHostClass({ name: "java/util/ArrayList", sup: null, ifaces: [], methods: [key.slice(key.indexOf(".") + 1)], fields: [], ctor: class {} });
  check("the host's indexOf answers where the build's code would", w.entry("Aot", "plain", "()I")(), 1);
  check("the build's code ran for the rest", w.stats.aot.c > 0, true);
}

// A page has fetched only some of the modules (FetchStore): the code of the others is compiled on demand and runs as before, whatever the order the files arrive in.
const modules = /^[cd]\d+\.wasm$/;
{
  let withheld = "", available = false;
  const requested = new Set<string>();
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => { requested.add(f); return f === withheld && !available ? undefined : fileOf(f); } } });
  const block = w.numbers.ids.get("java/util/ArrayList")! - 1, slot = w.slots.blockBase[block];
  const c = w.aot!.platformModule(block), head = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(`c${c}.wasm`)), "aot")[0]))) as CHeader;
  withheld = `d${head.mods[0].slice(1)}.wasm`;
  check("preflight D miss leaves C pending", w.aot!.install(slot), false);
  check("preflight requests every D dependency despite an earlier miss", head.mods.every(m => requested.has(`d${m.slice(1)}.wasm`)), true);
  check("preflight D miss is not a permanent rejection", w.stats.aot.dead, 0);
  check("preflight D miss publishes no fallback globals", w.stats.classes, 0);
  available = true;
  check("preflight D arrival permits C", w.aot!.install(slot), true);
  check("preflight D recovery Java result", w.entry("Aot", "plain", "()I")(), 0);
  available = false;
  const published = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => { requested.add(f); return f === withheld && !available ? undefined : fileOf(f); } } });
  check("preflight before publication", published.aot!.install(slot), false);
  const data = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(withheld)), "aot")[0]))) as DHeader;
  const cls = published.link(published.slots.blockClass[data.classes[0]]), globals = cls.exports;
  check("preflight fixture publishes fallback class data", published.aot!.hasLoaded(cls.name), false);
  available = true; requested.clear();
  check("publication after preflight permits C over live globals", published.aot!.install(slot), true);
  check("published fallback does not request retired data", requested.has(withheld), false);
  check("publication after preflight keeps globals", published.link(cls.name).exports, globals);
  check("publication after preflight Java result", published.entry("Aot", "plain", "()I")(), 0);
}
// Cached patches bind fallback globals and retain their invalidation owners even when the platform unit cannot load.
{
  const app = loadDexes(join(out, "classes.dex")), platform = program(jars);
  const producer = world(new Program(app, platform), { natives, compileOnly: true });
  const method = producer.prog.resolve("java/util/ArrayList", "contains", "(Ljava/lang/Object;)Z")!;
  const built = buildApp(producer, [method], { methods: [], classes: [], infos: [] }), files = new Map(built.files);
  const c = producer.aot!.platformModule(producer.slots.blockOf(producer.slotOf(method)));
  const incompatible = packModule({ version: VERSION + 1 }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  let available = false;
  const page = world(new Program(app, platform), { natives, app: { index: built.index, store: { get: f => files.get(f) } },
    aot: { get: f => f === `c${c}.wasm` ? incompatible : /^d\d+\.wasm$/.test(f) && !available ? undefined : fileOf(f) } });
  const cls = page.link("java/util/ArrayList"), globals = cls.exports, slot = page.slotOf(page.prog.resolve(method.cls, method.name, method.desc)!);
  available = true;
  check("patch loads after incompatible platform code", page.aot!.install(slot), true);
  const state = page.slots.at(slot);
  check("patch owns a later materialized slot", state?.k === "method" && state.done, true);
  const code = page.table.get(slot);
  check("fallback patch Java result", page.entry("Aot", "plain", "()I")(), 0);
  check("fallback patch retains published globals", page.link(cls.name).exports, globals);
  check("fallback patch executes without recompilation", page.table.get(slot), code);
  page.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("fallback patch invalidates for a later subclass", page.entry("Aot2", "sub", "()I")(), 1);
}
// Demand preparation fetches code then its original data, but publishes nothing and has a finite fallback path.
{
  const held = new Set<string>(), delivered = new Map<string, WebAssembly.Module>();
  const requests: string[][] = [];
  let mode: "deliver" | "missing" | "fail" | "stall" = "deliver";
  let finishLate = () => {};
  const store: AotStore = {
    get: f => delivered.get(f) ?? (held.has(f) ? undefined : fileOf(f)),
    prefetch: files => {
      requests.push(files);
      if (mode === "stall") return new Promise<void>(done => { finishLate = () => { for (const f of files) delivered.set(f, compileModule(fileOf(f))); done(); }; });
      if (mode === "missing") return Promise.resolve();
      if (mode === "fail") return Promise.reject(new Error("delivery failed"));
      return Promise.resolve().then(() => { for (const f of files) delivered.set(f, compileModule(fileOf(f))); });
    },
  };
  const make = () => world([join(out, "classes.dex"), ...jars], { natives, aot: store });
  const w = make(), block = w.numbers.ids.get("java/util/ArrayList")! - 1, slot = w.slots.blockBase[block];
  const cfile = `c${w.aot!.platformModule(block)}.wasm`;
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(cfile)), "aot")[0]))) as CHeader;
  held.add(cfile); held.add(`d${head.mods[0].slice(1)}.wasm`);
  check("missing delivery requests preparation", w.aot!.needsPreparation(slot), true);
  const pending = w.aot!.prepare(slot)!;
  check("concurrent preparation shares delivery", w.aot!.prepare(slot), pending);
  await pending;
  check("preparation fetches code then required data", requests.length, 2);
  check("preparation publishes no globals", w.stats.classes, 0);
  check("prepared code installs original data", w.aot!.install(slot), true);
  check("prepared Java result", w.entry("Aot", "plain", "()I")(), 0);
  requests.length = 0;
  const published = make();
  const dataFile = `d${head.mods[0].slice(1)}.wasm`;
  delivered.delete(dataFile);
  const dh = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(dataFile)), "aot")[0]))) as DHeader;
  const cls = published.link(published.slots.blockClass[dh.classes[0]]), globals = cls.exports;
  check("published fallback does not prepare", published.aot!.prepare(slot), undefined);
  check("published fallback prepares no files", requests.length, 0);
  const otherData = `d${head.mods.find(m => `d${m.slice(1)}.wasm` !== dataFile)!.slice(1)}.wasm`;
  held.add(otherData); delivered.delete(otherData);
  await published.aot!.prepare(slot);
  check("mixed data preparation fetches only the missing live group", requests.flat().join(), otherData);
  check("mixed data preparation permits cached code", published.aot!.install(slot), true);
  held.delete(otherData);
  requests.length = 0;
  delivered.set(dataFile, compileModule(fileOf(dataFile)));
  check("preparation cannot replace published globals", published.link(cls.name).exports, globals);
  delivered.set(cfile, compileModule(packModule({ version: VERSION - 1 }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0))));
  const stale = make();
  check("an older module format does not prepare", stale.aot!.prepare(slot), undefined);
  check("an older module format prepares no files", requests.length, 0);
  delivered.clear(); requests.length = 0;
  held.delete(dataFile);
  const automatic = world([join(out, "classes.dex"), ...jars], { natives, aot: store, loop: { ...hostLoop, due: () => false } });
  automatic.link("java/util/ArrayList");
  const ctor = automatic.prog.get("java/util/ArrayList")!.byKey.get("<init>()V")!, ctorSlot = automatic.slotOf(ctor);
  automatic.stubs.restoreStub(ctorSlot);
  check("fresh stub admits delivery before its turn expires", await automatic.entryAsync("Aot", "plain", "()I")(), 0);
  check("fresh stub prepares demanded code once", requests.filter(fs => fs.includes(cfile)).length, 1);
  delivered.clear(); requests.length = 0;
  const changed = make(), changing = changed.aot!.prepare(slot);
  changed.addDexes(loadDexes(join(out, "out2/classes.dex")));
  await changing;
  check("delivery wait revalidates a newly added overriding class", await changed.entryAsync("Aot2", "sub", "()I")(), 1);
  delivered.clear(); requests.length = 0; mode = "missing";
  const absent = make();
  await absent.aot!.prepare(slot);
  check("completed delivery without a file falls back", absent.aot!.install(slot), false);
  delivered.clear(); requests.length = 0; mode = "fail";
  const failed = make();
  await failed.aot!.prepare(slot);
  check("failed delivery falls back", failed.aot!.install(slot), false);
  check("failed delivery Java result", failed.entry("Aot", "plain", "()I")(), 0);
  delivered.clear(); requests.length = 0; mode = "stall";
  held.add(dataFile);
  const stalled = make();
  await stalled.aot!.prepare(slot);
  check("stalled delivery returns to fallback", stalled.aot!.install(slot), false);
  check("expired preparation does not wait again", stalled.aot!.prepare(slot), undefined);
  finishLate(); await Promise.resolve(); await Promise.resolve();
  check("late completion does not start data delivery after deadline", requests.flat().join(), cfile);
  check("late completion publishes no globals", stalled.stats.classes, 0);
}
// Late code binds existing globals; late data must never replace them.
{
  let available = false;
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => /^c\d+\.wasm$/.test(f) && !available ? undefined : fileOf(f) } });
  const m = w.prog.get("java/util/ArrayList")!.byKey.get("contains(Ljava/lang/Object;)Z")!, slot = w.slotOf(m);
  check("late C first miss", w.aot!.install(slot), false);
  check("late C fallback runs first", w.entry("Aot", "plain", "()I")(), 0);
  const globals = w.link("java/util/ArrayList").exports;
  const misses = w.stats.aot.missed;
  available = true;
  check("late C installs against original D", w.aot!.install(slot), true);
  check("late C installed method", w.aot!.installed(slot), true);
  check("late C counts first miss once", w.stats.aot.missed, misses);
  check("late C retains original globals", w.link("java/util/ArrayList").exports, globals);
  check("late C Java result", w.entry("Aot", "plain", "()I")(), 0);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("late C still invalidates for subclass", w.entry("Aot2", "sub", "()I")(), 1);
}
{
  let available = false;
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => /^d\d+\.wasm$/.test(f) && !available ? undefined : fileOf(f) } });
  const cls = w.link("java/util/ArrayList"), globals = cls.exports;
  const m = w.prog.get("java/util/ArrayList")!.byKey.get("contains(Ljava/lang/Object;)Z")!, slot = w.slotOf(m);
  available = true;
  check("late C binds published fallback globals", w.aot!.install(slot), true);
  check("late D retains published class", w.link("java/util/ArrayList"), cls);
  check("late D retains published globals", cls.exports, globals);
  check("late D fallback Java result", w.entry("Aot", "plain", "()I")(), 0);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("fallback-bound platform code invalidates for subclass", w.entry("Aot2", "sub", "()I")(), 1);
}
{
  let available = false, rejected = false;
  const index = JSON.parse(new TextDecoder().decode(fileOf("index.json")));
  const wrong = packModule({ version: VERSION - 1 }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => /^c\d+\.wasm$/.test(f) ? !available ? undefined : !rejected ? wrong : fileOf(f) : fileOf(f) } });
  const slot = w.slotOf(w.prog.get("java/util/ArrayList")!.byKey.get("contains(Ljava/lang/Object;)Z")!);
  check("late format first miss", w.aot!.install(slot), false);
  available = true;
  check("late incompatible format rejected", w.aot!.install(slot), false);
  check("late incompatible format records rejection", w.stats.aot.dead, 1);
  rejected = true;
  check("late format rejection stays terminal", w.aot!.install(slot), false);
  const stale = new TextEncoder().encode(JSON.stringify({ ...index, version: VERSION + 1 }));
  check("unsupported AOT index version rejected", !!world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => f === "index.json" ? stale : fileOf(f) } }).aot, false);
  const previous = new TextEncoder().encode(JSON.stringify({ ...index, version: VERSION - 1 }));
  check("previous zero-argument stub index rejected", !!world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => f === "index.json" ? previous : fileOf(f) } }).aot, false);
  const legacyD = packModule({ version: VERSION - 1 }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  let replaceLegacy = false;
  const oldData = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => /^d\d+\.wasm$/.test(f) && !replaceLegacy ? legacyD : fileOf(f) } });
  const oldSlot = oldData.slotOf(oldData.prog.get("java/util/ArrayList")!.byKey.get("contains(Ljava/lang/Object;)Z")!);
  check("previous D stub format cannot authorize C", oldData.aot!.install(oldSlot), false);
  check("previous D stub format instantiates no original globals", oldData.stats.aot.d, 0);
  check("previous D stub format uses ordinary Java fallback", oldData.entry("Aot", "plain", "()I")(), 0);
  replaceLegacy = true;
  const c = oldData.aot!.platformModule(oldData.slots.blockOf(oldSlot)), ch = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(`c${c}.wasm`)), "aot")[0]))) as CHeader;
  const dh = JSON.parse(new TextDecoder().decode(new Uint8Array(WebAssembly.Module.customSections(compileModule(fileOf(`d${ch.mods[0].slice(1)}.wasm`)), "aot")[0]))) as DHeader;
  const name = oldData.slots.blockClass[dh.classes.at(-1)!];
  oldData.link(name);
  check("late format replacement cannot install rejected original globals", oldData.aot!.hasLoaded(name), false);
  const foreign = new TextEncoder().encode(JSON.stringify({ ...index, dexes: index.dexes.map(() => "foreign-platform") }));
  check("foreign platform index rejected", !!world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => f === "index.json" ? foreign : fileOf(f) } }).aot, false);
}
// An app build made under the root's shared libraries keeps the classes its data modules laid out when Java binds those libraries after they were linked: the app's own
// copy of a class the library defines first is the superclass before the binding, the library's after it, as the build has it.
{
  const lib3 = tempDir(), app3 = tempDir(), lib = (v: number) => `public class Aot3Lib { public int v() { return ${v}; } }`;
  writeFileSync(join(lib3, "Aot3Lib.java"), lib(5));
  writeFileSync(join(app3, "Aot3Lib.java"), lib(3));
  writeFileSync(join(app3, "Aot3.java"), "public class Aot3 extends Aot3Lib { public static int run() { return new Aot3().v() + 1; } }");
  for (const d of [lib3, app3]) fixture({ out: d, sources: filesIn(d, /\.java$/) });
  const platform = program(jars), app = () => loadDexes(join(app3, "classes.dex"));
  const bind = (w: ReturnType<typeof world>) => {
    const library = w.prog.newLoader(w.prog.boot, null);
    w.addDexes(loadDexes(join(lib3, "classes.dex")), library);
    w.namespaces.bindLibraries(w.prog.root, [library], []);
  };
  const producer = world(new Program(app(), platform), { natives, compileOnly: true });
  bind(producer);
  const methods = ["run()I", "<init>()V"].map((k) => producer.prog.get("Aot3")!.byKey.get(k)!);
  const built = buildApp(producer, methods, { methods: [], classes: ["Aot3"], infos: [] }), files = new Map(built.files);
  const page = world(new Program(app(), program(jars)), { natives, app: { index: built.index, store: { get: (f) => files.get(f) } } });
  check("the library build is attached", page.appAttached, true);
  check("the build lays out the subclass", page.link("Aot3").mod[0], "e");
  let error = "";
  try { bind(page); } catch (e) { error = String(e); }
  check("binding the build's libraries keeps it", error, "");
  check("the subclass reaches the library's superclass", page.entry("Aot3", "run", "()I")(), 6);
}
const stores: [string, (seen: Set<string>) => AotStore, (w: ReturnType<typeof world>) => boolean][] = [
  ["a build with every other module", () => ({ get: (f) => (modules.test(f) && /[13579]\.wasm$/.test(f) ? undefined : fileOf(f)) }), (w) => w.stats.aot.missed > 0 && w.stats.aot.c + w.stats.aot.d > 0],
  ["a build without any module", () => ({ get: (f) => (modules.test(f) ? undefined : fileOf(f)) }), (w) => w.stats.aot.missed > 0 && w.stats.aot.c + w.stats.aot.d === 0],
  ["modules that arrive after they were first wanted", (seen) => ({ get: (f) => (modules.test(f) && /[2468]\.wasm$/.test(f) && !seen.has(f) ? (seen.add(f), undefined) : fileOf(f)) }), (w) => w.stats.aot.missed > 0],
];
for (const [what, make, expected] of stores) {
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: make(new Set()) });
  check(`${what}: attached`, !!w.aot, true);
  check(`${what}: ArrayList.contains`, w.entry("Aot", "plain", "()I")(), 0);
  check(`${what}: as expected`, expected(w), true);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check(`${what}: a subclass overriding indexOf takes effect`, w.entry("Aot2", "sub", "()I")(), 1);
  check(`${what}: and the plain list is as before`, w.entry("Aot2", "plain", "()I")(), 0);
}
suite.done(`all ${suite.checks} checks pass`);
