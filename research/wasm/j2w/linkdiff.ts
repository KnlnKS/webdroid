// Unresolved references (java/lk): a class or member the dex names that the running program lacks must fail at its use site with the error and
// message ART gives, and execution up to it must be unaffected. The error class is compared with the JDK; the messages are ART's (class_linker.cc,
// common_throws.cc). A dex loaded later that defines the class undoes the failure. Needs javac, d8 and java. Run: bun linkdiff.ts
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, world } from "./build";
import { jsTier, natives, processState } from "./oracle";
import { underNode } from "./undernode";

await underNode(import.meta.path);

const here = import.meta.dir, root = join(here, "../../.."), jars = [...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(root, "vendor/aosp", j));
const out = mkdtempSync(join(tmpdir(), "j2w-lk-")), v1 = join(out, "v1"), v2 = join(out, "v2"), run = join(out, "run"), gone = join(out, "gone");
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { cwd: out, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input) });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
const src = (d: string, ...n: string[]) => n.map((x) => join(here, "java/lk", d, `${x}.java`));
for (const d of [v1, v2, run, gone]) mkdirSync(d);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", v1, ...src("", "Lk", "LkX", "LkGone", "LkGoneEx", "LkP", "LkI", "LkC")]);
sh(["javac", "--release", "8", "-Xlint:-options", "-cp", v1, "-d", v2, ...src("v2", "LkP", "LkI", "LkC")]);
sh(["javac", "--release", "8", "-Xlint:-options", "-d", run, join(here, "java/Ref.java")]);
const classes = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
// the program that runs: Lk against the changed classes, without LkGone and LkGoneEx
for (const f of [...classes(v2, /\.class$/), ...classes(v1, /^LkX?\.class$/)]) copyFileSync(f, join(run, f.split("/").pop()!));
sh(["d8", "--release", "--output", out, ...classes(run, /^Lk/)]);
sh(["d8", "--release", "--output", gone, ...classes(v1, /^LkGone/)]);

const loc = join(out, "classes.dex"), at = (cls: string) => ` (declaration of '${cls}' appears in ${loc})`;
const ncdfe = (d: string) => `java.lang.NoClassDefFoundError: Failed resolution of: ${d}`;
const nsm = (kind: string, sig: string) => `java.lang.NoSuchMethodError: No ${kind} method ${sig} in class LLkP; or its super classes${at("LkP")}`;
const nsf = (kind: string, name: string) => `java.lang.NoSuchFieldError: No ${kind} field ${name} of type I in class LLkP; or its superclasses${at("LkP")}`;
const icce = (m: string) => `java.lang.IncompatibleClassChangeError: ${m}${at("Lk")}`;
const gonePart = (d = "LLkGone;") => ncdfe(d);
const expected: Record<string, string> = {
  newGone: gonePart(), staticGone: gonePart(), virtualGone: gonePart(), sgetGone: gonePart(), sputGone: gonePart(), igetGone: gonePart(), castGone: gonePart(),
  instGone: gonePart(), classGone: gonePart(), arrayGone: gonePart("[LLkGone;"),
  missStatic: nsm("static", "gs()V"), missVirtual: nsm("virtual", "gv()V"), missInit: nsm("direct", "<init>(I)V"),
  missSget: nsf("static", "gsf"), missIget: nsf("instance", "gif"), missIput: nsf("instance", "gif"),
  staticNowVirtual: icce("The method 'void LkP.sm2()' was expected to be of type static but instead was found to be of type virtual"),
  interfaceNowClass: icce("Found class LkI, but interface was expected"),
  classNowInterface: icce("Found interface LkC, but class was expected"),
};
await jsTier(loadDexes(join(out, "classes.dex")));   // makes the ICU data resident, which natives cannot wait for
const w = world([join(out, "classes.dex"), ...jars], { natives });
processState(w);
const hit: string[] = [];
w.onGap = (id) => hit.push(w.gapList[id]);
const names = Object.keys(expected);
const jdk = sh(["java", "-cp", run, "Ref"], names.map((n) => `Lk.${n}`).join("\n") + "\n").trim().split("\n");
const catchGone = w.entry("LkX", "catchGone", "()Ljava/lang/String;")();
if (catchGone !== "rte") { console.log(`FAIL catchGone: ${catchGone}`); process.exit(1); }
let failed = 0;
names.forEach((n, i) => {
  let got: string;
  try { got = w.entry("Lk", n, "()Ljava/lang/String;")() as string; } catch (e) { got = `escaped ${w.throwable(e) ? w.classNameOf(w.throwable(e)!) : e}`; }
  const kind = (s: string) => s.split(":")[0];
  if (kind(got) !== kind(jdk[i])) { failed++; console.log(`FAIL ${n}: ${kind(got)} on Wasm, ${kind(jdk[i])} on the JDK`); }
  if (got !== expected[n]) { failed++; console.log(`FAIL ${n}:\n  got  ${got}\n  want ${expected[n]}`); }
});
const part = w.entry("Lk", "partial", "(I)I");
if (part(5) !== 11) { failed++; console.log(`FAIL partial(5) = ${part(5)}`); }
try { part(500); failed++; console.log("FAIL partial(500) did not throw"); } catch (e) { if (w.classNameOf(w.throwable(e)!) !== "java/lang/NoClassDefFoundError") { failed++; console.log(`FAIL partial(500): ${e}`); } }
if (hit.length) { failed++; console.log(`FAIL gaps hit: ${[...new Set(hit)].join("; ")}`); }
// a dex loaded later that defines the class: the sites that failed resolve
w.addDexes(loadDexes(join(gone, "classes.dex")));
for (const n of ["newGone", "staticGone", "sgetGone", "classGone"]) {
  const got = w.entry("Lk", n, "()Ljava/lang/String;")() as string;
  if (/Error/.test(got)) { failed++; console.log(`FAIL ${n} after the class is loaded: ${got}`); }
}
console.log(failed ? `${failed} failures` : `${names.length} unresolved-reference cases match ART and the JDK`);
process.exit(failed ? 1 : 0);
