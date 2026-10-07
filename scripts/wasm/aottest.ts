// Precompiled platform code (aot.ts) stays sound when classes arrive after the build: a dex added later that overrides a method the build
// devirtualised puts the code that relied on it back on demand, and a dex present from the start keeps such code from being installed.
// Needs javac, d8 and a build of the platform in WEBDROID_AOT (aot-build.ts), which `bun run wasm aottest` makes when it is unset.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { packModule, VERSION, DEOPT_ABI, type AotStore, type CHeader, type DHeader } from "../../src/wasm/link/aot";
import { compileModule } from "../../src/wasm/link/module";
import { loadDexes, program, world } from "./lib";
import { Program } from "../../src/wasm/compiler/program";
import { buildApp } from "../../src/wasm/link/apps";
import { Persist, SavedBuild, buildFiles, memoryBackend } from "../../src/wasm/host/persist";
import { natives } from "./oracle";
import { nativeSource } from "../../src/wasm/host/nativesource";
import { Natives } from "../../src/wasm/host/natives";
import { AOSP, JAVA } from "./paths";
import { filesIn, shellIn } from "./tools";

const build = process.env.WEBDROID_AOT;
if (!build) { console.log("aottest: set WEBDROID_AOT to a build (aot-build.ts)"); process.exit(1); }
const jars = PLATFORM_JARS.map((j) => join(AOSP, j));
const out = mkdtempSync(join(tmpdir(), "j2w-aot-"));
const sh = shellIn(out);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(JAVA, "Aot.java"), join(JAVA, "Aot2.java")]);
sh(["d8", "--release", "--output", out, ...filesIn(out, /^Aot(\$\w+)?\.class$/)]);
sh(["mkdir", "-p", "out2"]);
sh(["d8", "--release", "--output", join(out, "out2"), "--classpath", out, ...filesIn(out, /^Aot2(\$\w+)?\.class$/)]);

let failed = 0, checks = 0;
const check = (what: string, got: unknown, want: unknown) => { checks++; if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };
const key = "java/util/ArrayList.indexOf(Ljava/lang/Object;)I";
const fileOf = (f: string) => new Uint8Array(readFileSync(join(build, f)));

{
  const w = world([join(out, "classes.dex"), ...jars], { natives });
  check("the build is attached", !!w.aot, true);
  check("ArrayList.contains before", w.entry("Aot", "plain", "()I")(), 0);
  check("it ran precompiled", w.stats.aot.c > 0, true);
  check("it relies on the one indexOf", w.assumptions.has(key), true);
  w.addDexes(loadDexes(join(out, "out2/classes.dex")));
  check("the decision is undone", w.stats.invalidated >= 1, true);
  check("a subclass overriding indexOf takes effect", w.entry("Aot2", "sub", "()I")(), 1);
  check("and the plain list is as before", w.entry("Aot2", "plain", "()I")(), 0);
}

// A persisted verdict may cover the entire app, only its prefix, or an obsolete loader graph.
{
  const app = loadDexes(join(out, "classes.dex")), late = loadDexes(join(out, "out2/classes.dex")), platform = program(jars);
  const make = (dexes = app, saved?: SavedBuild) => world(new Program(dexes, platform), { natives, ...(saved && { app: { index: saved.index, store: saved } }) });
  const observed = make();
  check("inherited platform target", observed.entry("Aot", "inherited", "()I")(), 0);
  const verdicts = observed.aot!.verdictList();
  check("the launch records a true indexOf verdict", verdicts.some(([k, , , stands]) => k === key && stands), true);
  const built = buildApp(make(), [], { methods: [], classes: [], infos: [], verdicts });
  const persist = new Persist(memoryBackend());
  await persist.save("verdict", buildFiles(built));
  const saved = (await SavedBuild.open((await persist.load("verdict"))!))!;
  check("the persisted verdict survives loading", saved.index.demand.verdicts?.some(([k, , , stands]) => k === key && stands), true);
  const matching = make(app, saved);
  check("the matching app attaches", matching.appAttached, true);
  let checks = 0;
  const holds = matching.holds.bind(matching);
  matching.holds = (a, by) => { if (a.name === "indexOf" && by.includes("Aot$MyList")) checks++; return holds(a, by); };
  check("cached inherited target", matching.entry("Aot", "inherited", "()I")(), 0);
  check("the cached target avoids rechecking the app", checks, 0);
  matching.addDexes(late);
  check("later override invalidates cached platform code", matching.entry("Aot2", "sub", "()I")(), 1);
  const prefix = make([...app, ...late], saved);
  check("a prefix app build still attaches", prefix.appAttached, true);
  check("a prefix verdict does not hide the extra override", prefix.entry("Aot2", "sub", "()I")(), 1);
  check("the enlarged app records the falsified target", prefix.aot!.verdictList().some(([k, , , stands]) => k === key && !stands), true);
  const rebound = make(app, saved), library = rebound.prog.newLoader(rebound.prog.boot, null);
  rebound.addDexes(late, library);
  rebound.bindLibraries(rebound.prog.root, [library], []);
  check("loader rebinding retires persisted verdicts", rebound.aot!.verdictList().length, 0);
  const cls = rebound.prog.definedBy(library, "Aot2")!;
  check("the rebound library override takes effect", rebound.entry(cls, "sub", "()I")(), 1);
  check("obsolete loader verdicts are not exported again", rebound.aot!.verdictList().length, 0);
}
{
  const w = world([join(out, "classes.dex"), join(out, "out2/classes.dex"), ...jars], { natives });
  check("the build is attached with the app's classes in the Program", !!w.aot, true);
  check("the subclass takes effect", w.entry("Aot2", "sub", "()I")(), 1);
  check("code that relied on the one indexOf is not installed", w.stats.aot.dead >= 1, true);
  check("the plain list is as before", w.entry("Aot", "plain", "()I")(), 0);
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
  const block = w.ids.get("java/util/ArrayList")! - 1, slot = w.blockBase[block];
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
  const cls = published.link(published.names[data.classes[0]]), globals = cls.exports;
  available = true; requested.clear();
  check("publication after preflight keeps C blocked", published.aot!.install(slot), false);
  check("published fallback rejects before requesting more data", head.mods.every(m => !requested.has(`d${m.slice(1)}.wasm`)), true);
  check("publication after preflight keeps globals", published.link(cls.name).exports, globals);
  check("publication after preflight Java result", published.entry("Aot", "plain", "()I")(), 0);
}
// Late code is reusable only against the original data globals; late data must never replace fallback globals.
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
  check("late C installed method", w.aot!.installed(w.blockOf(slot), m), true);
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
  check("late D cannot authorize C", w.aot!.install(slot), false);
  check("late D retains published class", w.link("java/util/ArrayList"), cls);
  check("late D retains published globals", cls.exports, globals);
  check("late D fallback Java result", w.entry("Aot", "plain", "()I")(), 0);
}
{
  let available = false, rejected = false;
  const index = JSON.parse(new TextDecoder().decode(fileOf("index.json")));
  const wrong = packModule({ deopt: index.deopt === DEOPT_ABI ? 0 : DEOPT_ABI }, Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const w = world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => /^c\d+\.wasm$/.test(f) ? !available ? undefined : !rejected ? wrong : fileOf(f) : fileOf(f) } });
  const slot = w.slotOf(w.prog.get("java/util/ArrayList")!.byKey.get("contains(Ljava/lang/Object;)Z")!);
  check("late policy first miss", w.aot!.install(slot), false);
  available = true;
  check("late incompatible policy rejected", w.aot!.install(slot), false);
  check("late incompatible policy records rejection", w.stats.aot.dead, 1);
  rejected = true;
  check("late policy rejection stays terminal", w.aot!.install(slot), false);
  const stale = new TextEncoder().encode(JSON.stringify({ ...index, version: VERSION + 1 }));
  check("unsupported AOT index version rejected", !!world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => f === "index.json" ? stale : fileOf(f) } }).aot, false);
  const foreign = new TextEncoder().encode(JSON.stringify({ ...index, dexes: index.dexes.map(() => "foreign-platform") }));
  check("foreign platform index rejected", !!world([join(out, "classes.dex"), ...jars], { natives, aot: { get: f => f === "index.json" ? foreign : fileOf(f) } }).aot, false);
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
console.log(failed ? `${failed} failures / ${checks} checks` : `aottest: all ${checks} checks pass`);
process.exit(failed ? 1 : 0);
