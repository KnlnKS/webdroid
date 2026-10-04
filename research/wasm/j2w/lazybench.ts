// Cold-start cost of lazy linking: runs the primitive statics of the AOSP number classes that compile without a gap, and splits the time into
// our compiler, V8's module compile and instantiation. Run: bun lazybench.ts (JavaScriptCore), or bundled for node (V8):
//   bun build lazybench.ts --target=node --outfile=/tmp/lb.mjs && node --import <polyfill> /tmp/lb.mjs
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { program, world } from "./build";
import { intrinsics } from "./intrinsics";
import { reach } from "./reach";
import { genCases } from "./cases";

const jars = PLATFORM_JARS.slice(0, 2).map((j) => join(process.env.WEBDROID_ROOT ?? join(import.meta.dir, "../../.."), "vendor/aosp", j));
const CLASSES = ["java/lang/Integer", "java/lang/Long", "java/lang/Short", "java/lang/Byte", "java/lang/Character", "java/lang/Boolean", "java/lang/Float", "java/lang/Double",
  "java/lang/Math", "java/lang/StrictMath", "libcore/util/FP16", "java/util/Objects", "java/util/Arrays"];
const prim = /^[IJFDZBSC]$/;
const prog = program(jars), probe = world(prog);
const cand = CLASSES.flatMap((c) => prog.get(c)?.methods ?? []).filter((m) => m.isStatic && m.codeOff && !m.isCtor && m.name !== "<clinit>" && m.params.every((p) => prim.test(p)) && prim.test(m.ret));
const isIntr = (m: { cls: string; key: string }) => intrinsics.has(m.cls + "." + m.key);
const clean = cand.filter((m) => { const r = reach(prog, [m], { instantiate: [], methods: [] }, isIntr); return r.methods.size <= 1000 && [...r.methods.values()].every((x) => !probe.gapsOf(x).length) && !r.unresolved.size; });
const closure = new Set(clean.flatMap((m) => [...reach(prog, [m], { instantiate: [], methods: [] }, isIntr).methods.keys()]));

/** runs `entries` cold on a fresh World and prints what it cost */
function run(label: string, entries: typeof cand, reachSize: number) {
  const w = world(prog), cases = genCases(entries, {}, 4), t0 = performance.now();
  let gaps = 0;
  w.onGap = () => gaps++;
  for (const c of cases) try { w.entry(c.m.cls, c.m.name, c.m.desc)(...c.args.map((a, j) => (c.m.params[j] === "J" || c.m.params[j] === "D" ? a : Number(a)))); } catch { /* Java exceptions, and gaps, are part of the cases */ }
  const total = performance.now() - t0, s = w.stats;
  console.log(`${process.versions.bun ? "JavaScriptCore" : "V8"} ${label}: ${entries.length} entries, ${cases.length} calls cold in ${total.toFixed(0)} ms (${gaps} stopped at a gap); closed-world reach is ${reachSize} methods`);
  console.log(`  lazy: ${s.methods} methods compiled in ${s.units} modules (${(100 * s.methods / reachSize).toFixed(1)}% of reach), ${s.classes} class modules, ${(s.bytes / 1024).toFixed(0)} KB of Wasm`);
  console.log(`  our compiler ${s.compileMs.toFixed(0)} ms (${(s.compileMs / s.methods).toFixed(2)} ms/method), Module ${s.moduleMs.toFixed(0)} ms, Instance ${s.instantiateMs.toFixed(0)} ms (${((s.moduleMs + s.instantiateMs) / (s.units + s.classes + 1) * 1000).toFixed(0)} us per module), class link ${s.classMs.toFixed(0)} ms`);
}
run("clean entries", clean, closure.size);
const everyClosure = new Set(cand.flatMap((m) => [...reach(prog, [m], { instantiate: [], methods: [] }, isIntr).methods.keys()]));
run("all entries", cand, everyClosure.size);
