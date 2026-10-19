// Unresolved references (java/lk): a class or member the dex names that the running program lacks must fail at its use site with the error and
// message ART gives, and execution up to it must be unaffected. The error class is compared with the JDK; the messages are ART's (class_linker.cc,
// common_throws.cc). A dex loaded later that defines the class undoes the failure. Needs javac, d8 and java. Run: pnpm wasm linkdiff
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { loadDexes, world } from "./lib.ts";
import { mountPlatform, natives, startProcess } from "./harness.ts";
import { CORE_PATHS, JAVA, ROOT } from "./paths.ts";
import { checker, filesIn, fixture, javac, onJdk, tempDir } from "./tools.ts";

const out = tempDir(), v1 = join(out, "v1"), v2 = join(out, "v2"), run = join(out, "run"), gone = join(out, "gone");
const src = (d: string, ...n: string[]) => n.map((x) => join(JAVA, "lk", d, `${x}.java`));
javac(v1, src("", "Lk", "LkX", "LkGone", "LkGoneEx", "LkP", "LkI", "LkC"));
javac(v2, src("v2", "LkP", "LkI", "LkC"), { classpath: [v1] });
javac(run, [join(JAVA, "Ref.java")]);
// the program that runs: Lk against the changed classes, without LkGone and LkGoneEx
for (const f of [...filesIn(v2, /\.class$/), ...filesIn(v1, /^LkX?\.class$/)]) copyFileSync(f, join(run, f.split("/").pop()!));
fixture({ out, classes: filesIn(run, /^Lk/) });
fixture({ out: gone, classes: filesIn(v1, /^LkGone/) });

const loc = join(out, "classes.dex"), at = (cls: string) => ` (declaration of '${cls}' appears in ${loc})`;
const gonePart = (d = "LLkGone;") => `java.lang.NoClassDefFoundError: Failed resolution of: ${d}`;
const nsm = (kind: string, sig: string) => `java.lang.NoSuchMethodError: No ${kind} method ${sig} in class LLkP; or its super classes${at("LkP")}`;
const nsf = (kind: string, name: string) => `java.lang.NoSuchFieldError: No ${kind} field ${name} of type I in class LLkP; or its superclasses${at("LkP")}`;
const icce = (m: string) => `java.lang.IncompatibleClassChangeError: ${m}${at("Lk")}`;
const expected: Record<string, string> = {
  newGone: gonePart(), staticGone: gonePart(), virtualGone: gonePart(), sgetGone: gonePart(), sputGone: gonePart(), igetGone: gonePart(), castGone: gonePart(),
  instGone: gonePart(), classGone: gonePart(), arrayGone: gonePart("[LLkGone;"),
  missStatic: nsm("static", "gs()V"), missVirtual: nsm("virtual", "gv()V"), missInit: nsm("direct", "<init>(I)V"),
  missSget: nsf("static", "gsf"), missIget: nsf("instance", "gif"), missIput: nsf("instance", "gif"),
  staticNowVirtual: icce("The method 'void LkP.sm2()' was expected to be of type static but instead was found to be of type virtual"),
  interfaceNowClass: icce("Found class LkI, but interface was expected"),
  classNowInterface: icce("Found interface LkC, but class was expected"),
};
await mountPlatform(ROOT);   // makes the ICU data resident, which natives cannot wait for
const w = world([join(out, "classes.dex"), ...CORE_PATHS], { natives });
await startProcess(w);
const hit: string[] = [];
w.onGap = (gap) => hit.push(gap);
const names = Object.keys(expected);
const jdk = onJdk(run, names.map((n) => `Lk.${n}`));
const suite = checker("linkdiff"), { check, fail } = suite;
check("catchGone", w.entry("LkX", "catchGone", "()Ljava/lang/String;")(), "rte");
names.forEach((n, i) => {
  let got: string;
  try { got = w.entry("Lk", n, "()Ljava/lang/String;")() as string; } catch (e) { got = `escaped ${w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e}`; }
  const kind = (s: string) => s.split(":")[0];
  check(`${n}: the error on Wasm and on the JDK`, kind(got), kind(jdk[i]));
  check(n, got, expected[n]);
});
const part = w.entry("Lk", "partial", "(I)I");
check("partial(5)", part(5), 11);
try { part(500); fail("partial(500) did not throw"); } catch (e) { check("partial(500)", w.classNameOf(w.throwable(e)!), "java/lang/NoClassDefFoundError"); }
if (hit.length) fail(`gaps hit: ${[...new Set(hit)].join("; ")}`);
// a dex loaded later that defines the class: the sites that failed resolve
w.addDexes(loadDexes(join(gone, "classes.dex")));
for (const n of ["newGone", "staticGone", "sgetGone", "classGone"]) {
  const got = w.entry("Lk", n, "()Ljava/lang/String;")() as string;
  if (/Error/.test(got)) fail(`${n} after the class is loaded: ${got}`);
}
suite.done(`${names.length} unresolved-reference cases match ART and the JDK`);
