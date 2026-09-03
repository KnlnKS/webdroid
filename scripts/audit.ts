// What an apk actually needs from us, computed before it runs.
//
//   bun run audit <apk> [--framework] [--all] [--limit N] [--json out.json]
//
// The old audit walked method_ids — every framework method the constant pool mentions,
// reachable or not, with no answer at all for interface dispatch. This walks the program:
// manifest components and services files are the roots, rapid type analysis resolves the
// virtual and interface sites against the types some reachable new-instance creates, and
// what comes out is the work queue, ranked, with fields included.
//
// With --framework the real AOSP dex joins the program, and the question changes from
// "which android.* method have we not written" to "which native method would we have to
// implement if this class ran as AOSP's own bytecode" — a set the platform build fixes,
// not one the next apk grows.
import { openApk, dexesOf, DEX_RE } from "./lib";
import { Program, reach } from "../src/jvm/reach";
import { rootsOf, reflectiveRoots } from "../src/jvm/roots";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import "../src/natives";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const apk = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--limit" && args[args.indexOf(a) - 1] !== "--json");
if (!apk) throw new Error("usage: bun run audit <apk> [--framework] [--all] [--limit N] [--json out.json]");
const limit = parseInt(opt("--limit", "40")!);

const FRAMEWORK_RE = /^(android|java|javax|dalvik|sun|libcore|com\/android\/internal|org\/xmlpull|org\/json|org\/apache\/http)\//;

const t0 = performance.now();
const zip = await openApk(apk, /classes\d*\.dex$|AndroidManifest\.xml$|^META-INF\/services\//);
const appDexes = dexesOf(zip);
const p = new Program();
for (const d of appDexes) p.add(d);
const appClasses = p.size;

let fwDexes: DexFile[] = [];
if (flag("--framework")) {
  const jar = "vendor/aosp/framework.jar";
  if (!existsSync(jar)) throw new Error(`no ${jar} — run \`bun run gen-framework\` first`);
  const fz = unzipSync(new Uint8Array(await Bun.file(jar).arrayBuffer()), { filter: (f) => DEX_RE.test(f.name) });
  fwDexes = Object.keys(fz).sort().map((n) => new DexFile(fz[n], n));
  for (const d of fwDexes) p.add(d);
}

const services: Record<string, string> = {};
for (const [name, bytes] of Object.entries(zip)) {
  if (name.startsWith("META-INF/services/")) services[name] = new TextDecoder().decode(bytes);
}

// --from <class> asks the same question of a framework subtree instead of an apk: what
// would running THIS as bytecode need? Same closure, different roots.
const from = args.filter((a, i) => args[i - 1] === "--from");
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
    }) }
  : rootsOf(zip["AndroidManifest.xml"], p, services);
const refl = from.length ? [] : reflectiveRoots(p, appDexes);
const t1 = performance.now();
const r = reach(p, roots.methods, [...roots.classes, ...refl]);
const t2 = performance.now();

console.log(`${apk}: ${appClasses} app classes${fwDexes.length ? ` + ${p.size - appClasses} framework` : ""}, ` +
  `${roots.classes.length} manifest/service roots, ${refl.length} named by a string constant`);
console.log(`reachable: ${r.methods.size} method bodies, ${r.instantiated.size} instantiated types, ${r.classes.size} classes touched ` +
  `(load ${(t1 - t0).toFixed(0)}ms, closure ${(t2 - t1).toFixed(0)}ms)`);

for (const n of [...rt.natives.keys()]) { try { rt.link(n); } catch { /* */ } }
const split = (key: string) => { const i = key.indexOf("."); return [key.slice(0, i), key.slice(i + 1)] as const; };
const ctorOf = (cls: string) => (rt.natives.has(cls) ? rt.classes.get(cls)?.ctor : null) ?? null;

/** does a native spec answer this call today? `in` walks the chain, so inherited counts */
const registered = (key: string) => {
  const [cls, rest] = split(key);
  const ctor = ctorOf(cls);
  const paren = rest.indexOf("(");
  if (!ctor || paren < 0) return false;
  const mangled = mangleMethod(rest.slice(0, paren), rest.slice(paren));
  return mangled in ctor.prototype || mangled in ctor;
};

/** a static or instance field a native spec already carries */
const registeredField = (key: string) => {
  const [cls, name] = split(key);
  const ctor = ctorOf(cls);
  if (!ctor) return false;
  const info = rt.classes.get(cls)!;
  return mangleStaticField(name) in ctor || info.fieldTable.has(name) ||
    (rt.natives.get(cls)?.fields?.[name] !== undefined);
};

const isFramework = (k: string) => FRAMEWORK_RE.test(k);
/** a class we already answer for, so it is not work whatever the program says */
const registeredClass = (k: string) => rt.natives.has(k.split(".")[0]);
const rank = (m: Map<string, number>, keep: (k: string) => boolean) =>
  [...m].filter(([k]) => keep(k)).sort((a, b) => b[1] - a[1]);

const show = (title: string, rows: [string, number][]) => {
  console.log(`\n=== ${title}: ${rows.length}`);
  for (const [k, n] of rows.slice(0, flag("--all") ? rows.length : limit)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (!flag("--all") && rows.length > limit) console.log(`  … ${rows.length - limit} more (--all)`);
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
  for (const [c, [m, sites]] of rows.slice(0, flag("--all") ? rows.length : limit || 25)) {
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
const cut = args.filter((a, i) => args[i - 1] === "--cut");
if (cut.length) {
  const src = new Map<string, string>();   // file → text, read once
  const files: string[] = [];
  for await (const f of new Bun.Glob("src/**/*.ts").scan(".")) files.push(f);
  for (const f of files) src.set(f, await Bun.file(f).text());
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
  for (const [name, ctor, n] of rows.slice(0, flag("--all") ? rows.length : limit || 25)) {
    console.log(`  ${String(n).padStart(5)}  ${name}  (${ctor || "anonymous"})`);
  }
}

const out = opt("--json");
if (out) {
  await Bun.write(out, JSON.stringify({
    apk, appClasses, frameworkClasses: p.size - appClasses,
    roots: [...roots.why], reflective: refl.length,
    reachableMethods: r.methods.size, instantiated: r.instantiated.size, classesTouched: r.classes.size,
    absentClasses: rank(r.absentClasses, isFramework),
    nativeMethods: rank(r.nativeMethods, () => true),
    unresolvedMethods: rank(r.unresolvedMethods, isFramework),
    unresolvedFields: rank(r.unresolvedFields, isFramework),
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
