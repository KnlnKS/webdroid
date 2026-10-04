// Primitive-only static methods of the AOSP libraries, compiled from the boot dex unchanged, against the JS tier running the same bytecode.
// A method takes part when everything it reaches compiles without a gap; the rest are counted by their first blocker.
// Run: bun libdiff.ts [class-prefix ...]
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { compile, hostImports, loadDexes, program } from "./build";
import { compare, genCases } from "./cases";
import { exportName, SEED_CLASSES, SEED_METHODS } from "./j2w";
import { implied } from "./classes";
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
const closures = new Map(cand.map((m) => [m, reach(prog, [m], { instantiate: SEED_CLASSES, methods: SEED_METHODS }, isIntr, implied)] as const));
const small = cand.filter((m) => closures.get(m)!.methods.size <= MAX_REACH);
const { bytes, cx } = compile(prog, small.map((m) => [m.cls, m.name, m.desc]));
const { instance } = await WebAssembly.instantiate(bytes, hostImports());
const blocker = (m: (typeof cand)[number]) => {
  const r = closures.get(m)!, hit = [...cx.gaps.keys(), ...r.unresolved].find((b) => r.methods.has(b.split(": ")[0]) || b.startsWith("missing"));
  return hit;
};
const clean = small.filter((m) => !blocker(m)), blocked = new Map<string, number>();
for (const m of cand) { const b = closures.get(m)!.methods.size > MAX_REACH ? `closure > ${MAX_REACH} methods` : blocker(m); if (b) blocked.set(b.replace(/^.*: /, ""), (blocked.get(b.replace(/^.*: /, "")) ?? 0) + 1); }
console.log(`${cand.length} candidates: ${clean.length} clean; blocked by ${[...blocked].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} x${n}`).join(", ")}`);
const cases = genCases(clean), { bad, threw } = await compare(cases, (m) => exportName(m.cls, m.name, m.desc), instance.exports as any, js);
console.log(`${clean.length} methods, ${cases.length} cases (${threw} throwing), ${bad} diffs (wasm vs js tier)`);
process.exit(bad ? 1 : 0);
