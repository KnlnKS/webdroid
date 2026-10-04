// Precompiled platform code (aot.ts) stays sound when classes arrive after the build: a dex added later that overrides a method the build
// devirtualised puts the code that relied on it back on demand, and a dex present from the start keeps such code from being installed.
// Needs javac, d8 and a build of the platform in WEBDROID_AOT (aot-build.ts), which `bun run wasm aottest` makes when it is unset.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import type { AotStore } from "../../src/wasm/link/aot";
import { loadDexes, world } from "./lib";
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
sh(["d8", "--release", "--output", out, ...filesIn(out, /^Aot\.class$/)]);
sh(["mkdir", "-p", "out2"]);
sh(["d8", "--release", "--output", join(out, "out2"), "--classpath", out, ...filesIn(out, /^Aot2(\$\w+)?\.class$/)]);

let failed = 0;
const check = (what: string, got: unknown, want: unknown) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };
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
console.log(failed ? `${failed} failures` : "aottest: all pass");
process.exit(failed ? 1 : 0);
