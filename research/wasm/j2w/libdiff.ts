// Primitive-only static methods of the AOSP libraries, compiled from the boot dex unchanged, against the JS tier running the same bytecode.
// A method takes part when everything it reaches compiles without a gap; the rest are counted by their first blocker.
// Run: bun libdiff.ts [class-prefix ...]
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { loadDexes, program, world } from "./build";
import { compare, genCases } from "./cases";
import { intrinsics } from "./intrinsics";
import { jsTier } from "./oracle";
import { reach } from "./reach";

const CLASSES = ["java/lang/Integer", "java/lang/Long", "java/lang/Short", "java/lang/Byte", "java/lang/Character", "java/lang/Boolean", "java/lang/Float", "java/lang/Double",
  "java/lang/Math", "java/lang/StrictMath", "libcore/util/FP16", "java/util/Objects", "java/util/Arrays", "java/lang/StringUTF16", "java/lang/Long$LongCache"];
const MAX_REACH = 1000;
const jars = PLATFORM_JARS.slice(0, 2).map((j) => join(import.meta.dir, "../../../vendor/aosp", j));
const prog = program(jars), js = await jsTier(jars.flatMap(loadDexes));
const prim = /^[IJFDZBSC]$/, only = process.argv.slice(2);
const cand = CLASSES.filter((c) => !only.length || only.some((p) => c.startsWith(p))).flatMap((c) => prog.get(c)?.methods ?? [])
  .filter((m) => m.isStatic && m.codeOff && !m.isCtor && m.name !== "<clinit>" && m.params.every((p) => prim.test(p)) && prim.test(m.ret));
const isIntr = (m: { cls: string; key: string }) => intrinsics.has(m.cls + "." + m.key);
const closures = new Map(cand.map((m) => [m, reach(prog, [m], { instantiate: [], methods: [] }, isIntr)] as const));
const small = cand.filter((m) => closures.get(m)!.methods.size <= MAX_REACH);
const w = world(prog);
const blocker = (m: (typeof cand)[number]) => {
  const r = closures.get(m)!;
  return [...[...r.methods.values()].flatMap((x) => w.gapsOf(x)), ...r.unresolved].find((b) => r.methods.has(b.split(": ")[0]) || b.startsWith("missing"));
};
const clean = small.filter((m) => !blocker(m)), blocked = new Map<string, number>();
for (const m of cand) { const b = closures.get(m)!.methods.size > MAX_REACH ? `closure > ${MAX_REACH} methods` : blocker(m); if (b) blocked.set(b.replace(/^.*: /, ""), (blocked.get(b.replace(/^.*: /, "")) ?? 0) + 1); }
console.log(`${cand.length} candidates: ${clean.length} clean; blocked by ${[...blocked].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} x${n}`).join(", ")}`);
const cases = genCases(clean), { bad, threw } = await compare(cases, (m) => w.entry(m.cls, m.name, m.desc), js);
console.log(`${clean.length} methods, ${cases.length} cases (${threw} throwing), ${bad} diffs (wasm vs js tier)`);
console.log(`static check compiled ${w.stats.units} units; run linked ${w.stats.classes} class modules`);
process.exit(bad ? 1 : 0);
