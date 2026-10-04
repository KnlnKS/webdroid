// Precompiled platform code (aot.ts) stays sound when classes arrive after the build: a dex added later that overrides a method the build
// devirtualised puts the code that relied on it back on demand, and a dex present from the start keeps such code from being installed.
// Needs javac, d8 and a build of the platform in WEBDROID_AOT (aotbuild.ts). Run: WEBDROID_AOT=<dir> bun aottest.ts
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, world } from "./build";

if (!process.env.WEBDROID_AOT) { console.log("aottest: set WEBDROID_AOT to a build (aotbuild.ts)"); process.exit(1); }
const root = join(import.meta.dir, "../../.."), jars = PLATFORM_JARS.map((j) => join(root, "vendor/aosp", j));
const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-aot-"));
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: out }); if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`); };
sh(["javac", "--release", "8", "-Xlint:-options", "-d", out, join(here, "java/Aot.java"), join(here, "java/Aot2.java")]);
const classes = (re: RegExp) => readdirSync(out).filter((f) => re.test(f)).map((f) => join(out, f));
sh(["d8", "--release", "--output", out, ...classes(/^Aot\.class$/)]);
sh(["mkdir", "-p", "out2"]);
sh(["d8", "--release", "--output", join(out, "out2"), "--classpath", out, ...classes(/^Aot2(\$\w+)?\.class$/)]);

let failed = 0;
const check = (what: string, got: unknown, want: unknown) => { if (got !== want) { failed++; console.log(`FAIL ${what}: got ${String(got)}, want ${String(want)}`); } };
const key = "java/util/ArrayList.indexOf(Ljava/lang/Object;)I";

{
  const w = world([join(out, "classes.dex"), ...jars]);
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
  const w = world([join(out, "classes.dex"), join(out, "out2/classes.dex"), ...jars]);
  check("the build is attached with the app's classes in the Program", !!w.aot, true);
  check("the subclass takes effect", w.entry("Aot2", "sub", "()I")(), 1);
  check("code that relied on the one indexOf is not installed", w.stats.aot.dead >= 1, true);
  check("the plain list is as before", w.entry("Aot", "plain", "()I")(), 0);
}
console.log(failed ? `${failed} failures` : "aottest: all pass");
process.exit(failed ? 1 : 0);
