// Precompiled platform code (aot.ts) stays sound when classes arrive after the build: a dex added later that overrides a method the build
// devirtualised puts the code that relied on it back on demand, and a dex present from the start keeps such code from being installed.
// Needs javac, d8 and a build of the platform in WEBDROID_AOT (aot-build.ts), which `bun run wasm aottest` makes when it is unset.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { loadDexes, world } from "./lib";
import { natives } from "./oracle";
import { AOSP, JAVA } from "./paths";
import { filesIn, shellIn } from "./tools";

if (!process.env.WEBDROID_AOT) { console.log("aottest: set WEBDROID_AOT to a build (aot-build.ts)"); process.exit(1); }
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
console.log(failed ? `${failed} failures` : "aottest: all pass");
process.exit(failed ? 1 : 0);
