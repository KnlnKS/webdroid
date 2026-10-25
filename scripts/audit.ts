// What an apk actually needs from us, computed before it runs.
//
//   pnpm run audit <apk> [--framework] [--all] [--limit N] [--json out.json]
//
// Manifest components and services files are the roots; rapid type analysis resolves virtual
// and interface sites. With --framework the AOSP dex joins the program and the report becomes
// the native methods this apk would need if those classes ran as AOSP bytecode.
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { apkRoots, openApk } from "./lib.ts";
import { loadDexes } from "./dexes.ts";
import { AOSP } from "./aosp.ts";
import { dexesOfZip, type DexFile } from "../src/jvm/dex.ts";
import { cli } from "./args.ts";
import { Program, reach } from "./reach.ts";
import { rt } from "../src/jvm/runtime.ts";
import "../src/natives.ts";
import { FRAMEWORK_RE, nativeClassSupport, nativeFieldSupport, nativeMethodSupport, rankCalls } from "./native-surface.ts";

const { values: { framework, all, limit: limitArg, json: out, from, cut }, positionals: [apk] } = cli("pnpm audit <apk> [--framework] [--all] [--limit N] [--json out.json] [--from class[#method]]... [--cut prefix]...", {
  framework: { type: "boolean" }, all: { type: "boolean" }, limit: { type: "string", default: "40" }, json: { type: "string" },
  from: { type: "string", multiple: true, default: [] }, cut: { type: "string", multiple: true, default: [] },
}, { min: 1 });
const limit = parseInt(limitArg);

const t0 = performance.now();
const zip = openApk(apk);
const appDexes = dexesOfZip(zip);
const p = new Program();
for (const d of appDexes) p.add(d);
const appClasses = p.size;

let fwDexes: DexFile[] = [];
if (framework) {
  fwDexes = loadDexes(`${AOSP}/framework.jar`);
  for (const d of fwDexes) p.add(d);
}

// --from <class> asks the same question of a framework subtree instead of an apk: what
// would running THIS as bytecode need? Same closure, different roots.
const roots = from.length
  ? { classes: from.map((f) => f.split("#")[0]), why: new Map(from.map((c) => [c.split("#")[0], "--from"])), methods: from.flatMap((f) => {
      const [c, only] = f.split("#");
      const def = p.def(c), dex = p.dexOf(c);
      if (!def || !dex) throw new Error(`--from ${c}: no such class`);
      const want = only ? new Set(only.split("+")) : null;
      return [...def.directMethods, ...def.virtualMethods]
        .map((m) => [dex.method(m.methodIdx).name, dex.methodDesc(m.methodIdx)] as const)
        .filter(([n]) => !want || want.has(n))
        .map(([n, d]) => c + "." + n + d);
    }), named: [] }
  : apkRoots(zip, p, appDexes);
const t1 = performance.now();
const r = reach(p, roots.methods, [...roots.classes, ...roots.named]);
const t2 = performance.now();

console.log(`${apk}: ${appClasses} app classes${fwDexes.length ? ` + ${p.size - appClasses} framework` : ""}, ` +
  `${roots.classes.length} manifest/service roots, ${roots.named.length} named by a string constant`);
console.log(`reachable: ${r.methods.size} method bodies, ${r.instantiated.size} instantiated types, ${r.classes.size} classes touched ` +
  `(load ${(t1 - t0).toFixed(0)}ms, closure ${(t2 - t1).toFixed(0)}ms)`);

const isFramework = (k: string) => FRAMEWORK_RE.test(k);
/** a class we already answer for, so it is not work whatever the program says */
const registeredClass = (k: string) => nativeClassSupport(rt, k.split(".")[0]) !== "missing";
const registered = (k: string) => nativeMethodSupport(rt, k) !== "missing";
const registeredField = (k: string) => nativeFieldSupport(rt, k) !== "missing";
const rank = rankCalls;

const show = (title: string, rows: [string, number][]) => {
  console.log(`\n=== ${title}: ${rows.length}`);
  for (const [k, n] of rows.slice(0, all ? rows.length : limit)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (!all && rows.length > limit) console.log(`  … ${rows.length - limit} more (--all)`);
};

// A class the program never defines is the hard stop: today it auto-stubs and every call
// site into it throws NoClassDefFoundError.
show(fwDexes.length ? "absent classes (not in the apk, not in AOSP, no native)" : "absent classes (no dex, no native)",
  rank(r.absentClasses, (k) => isFramework(k) && !registeredClass(k)));

if (fwDexes.length) {
  // With the framework in the program, an unresolved call means AOSP does not have it
  // either — a genuinely missing API, not one we have yet to write.
  const nat = rank(r.nativeMethods, () => true);
  show("native methods on the reachable path (the JNI line this apk stands on)", nat);
  // the shim work is bought per class, not per method: one delegate table serves all of them
  const byClass = new Map<string, [number, number]>();
  for (const [k, n] of nat) {
    const c = k.slice(0, k.indexOf("."));
    const e = byClass.get(c) ?? [0, 0];
    byClass.set(c, [e[0] + 1, e[1] + n]);
  }
  const rows = [...byClass].sort((a, b) => b[1][0] - a[1][0]);
  console.log(`\n=== the same, by class: ${rows.length} classes to shim`);
  for (const [c, [m, sites]] of rows.slice(0, all ? rows.length : limit || 25)) {
    console.log(`  ${String(m).padStart(4)} methods ${String(sites).padStart(5)} sites  ${c}`);
  }
  show("unresolved after AOSP (no dex anywhere, no native)", rank(r.unresolvedMethods, (k) => isFramework(k) && !registered(k)));
} else {
  const missing = rank(r.unresolvedMethods, (k) => isFramework(k) && !registered(k));
  show("framework methods reached and not implemented", missing);
}
show("framework fields reached and not implemented", rank(r.unresolvedFields, (k) => isFramework(k) && !registeredField(k)));

// --cut <prefix>: what moving this subtree to AOSP bytecode would cost. The native line is
// only half of it — a cut is also bounded by what the hand-written framework ABOVE it still
// names, because those sites hold the TS class and read its JS properties, and bytecode
// spells the same fields f$name$hash. Cutting a leaf under a TS framework moves the problem.
if (cut.length) {
  const src = new Map(globSync("src/**/*.ts").map((f) => [f, readFileSync(f, "utf8")]));   // file → text, read once
  const rows: [string, string, number][] = [];
  for (const [name, spec] of rt.natives) {
    if (!cut.some((c) => name.startsWith(c))) continue;
    const ctor = spec.ctor.name;
    // an anonymous or shared ctor cannot be counted by name; report it as unknown
    let refs = 0;
    if (/^[A-Z]\w+$/.test(ctor)) {
      const re = new RegExp("\\b" + ctor + "\\b", "g");
      for (const [, text] of src) refs += (text.match(re) ?? []).length;
    }
    rows.push([name, ctor, refs]);
  }
  rows.sort((a, b) => b[2] - a[2]);
  const total = rows.reduce((n, r) => n + r[2], 0);
  console.log(`\n=== cut [${cut.join(" ")}]: ${rows.length} native specs to withhold, ${total} references from src/ to rehome`);
  for (const [name, ctor, n] of rows.slice(0, all ? rows.length : limit || 25)) {
    console.log(`  ${String(n).padStart(5)}  ${name}  (${ctor || "anonymous"})`);
  }
}

if (out) {
  writeFileSync(out, JSON.stringify({
    apk, appClasses, frameworkClasses: p.size - appClasses,
    roots: [...roots.why], reflective: roots.named.length,
    reachableMethods: r.methods.size, instantiated: r.instantiated.size, classesTouched: r.classes.size,
    absentClasses: rank(r.absentClasses, isFramework),
    nativeMethods: rank(r.nativeMethods, () => true),
    unresolvedMethods: rank(r.unresolvedMethods, isFramework),
    unresolvedFields: rank(r.unresolvedFields, isFramework),
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
