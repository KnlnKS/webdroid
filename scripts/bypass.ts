// Override bypasses (docs/bytecode-first-plan.md §5.6): a TS spec method whose AOSP body calls an
// overridable method on `this`, where the TS source never names that method, answers without the
// app's override. Only methods a corpus app overrides are reported; tests/fixtures/app-overrides.json
// records those, with how many apps override each, so the check needs no APKs.
//   bun run bypass [--corpus] [--write-baseline]
// --corpus rescans apks/ into the fixture; --write-baseline accepts the current findings.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACC, rt } from "../src/jvm/runtime";
import { descToName } from "../src/jvm/abi";
import type { ClassDef } from "../src/jvm/dex";
import { prepareMethod } from "../src/jvm/prepared";
import { jarDexes } from "../src/android/framework";
import { PLATFORM_JARS } from "../src/jvm/provenance";
import { openDexes } from "./lib";
import "../src/natives";

const NO_INDEX = 0xffffffff, FINAL = 0x10, PRIVATE = 0x2;
const root = resolve(import.meta.dir, "..");
export const OVERRIDES = resolve(root, "tests/fixtures/app-overrides.json");
export const BASELINE = resolve(root, "tests/fixtures/bypass-baseline.json");
export const hasPlatformJars = () => PLATFORM_JARS.every((jar) => existsSync(resolve(root, "vendor/aosp", jar)));

function platformDefs(): Map<string, ClassDef> {
  const defs = new Map<string, ClassDef>();
  for (const jar of PLATFORM_JARS) for (const dex of jarDexes(readFileSync(resolve(root, "vendor/aosp", jar)), jar))
    for (let i = 0; i < dex.classDefCount; i++) {
      const name = descToName(dex.type(dex.classDef2Type(i)));
      if (!defs.has(name)) defs.set(name, dex.classDef(i));
    }
  return defs;
}
const superOf = (def: ClassDef) => def.superIdx === NO_INDEX ? undefined : descToName(def.dex.type(def.superIdx));
const signature = (def: ClassDef, methodIdx: number) => def.dex.method(methodIdx).name + def.dex.methodDesc(methodIdx);

/** "Class.method(desc)" → the overridable methods AOSP's body calls on `this` that the TS source never names */
export function selfCallsSkipped(defs = platformDefs()): Map<string, string[]> {
  const flagsOf = (cls: string, sig: string, seen = new Set<string>()): number | undefined => {
    const def = defs.get(cls);
    if (!def || seen.has(cls)) return undefined;
    seen.add(cls);
    const own = [...def.directMethods, ...def.virtualMethods].find((e) => signature(def, e.methodIdx) === sig);
    if (own) return own.flags;
    for (const s of [superOf(def), ...def.interfaces.map((t) => descToName(def.dex.type(t)))]) {
      const f = s ? flagsOf(s, sig, seen) : undefined;
      if (f !== undefined) return f;
    }
    return undefined;
  };
  const out = new Map<string, string[]>();
  for (const spec of rt.natives.values()) {
    const def = defs.get(spec.name);
    if (!def || def.flags & FINAL) continue;
    for (const [key, impl] of Object.entries(spec.methods ?? {})) {
      const m = def.virtualMethods.find((e) => signature(def, e.methodIdx) === key);
      if (!m?.codeOff || typeof impl !== "function") continue;
      const code = def.dex.code(m.codeOff), self = code.regs - code.ins;
      const source = String((impl as { $g?: unknown }).$g ?? impl);
      const skipped = new Set<string>();
      for (const ins of prepareMethod(def.dex, code, def.dex.methodDesc(m.methodIdx), false).instructions) {
        if (!/^invoke-(virtual|interface)/.test(ins.name) || ins.regs[0] !== self) continue;
        const sig = signature(def, ins.b), name = sig.slice(0, sig.indexOf("("));
        const flags = flagsOf(spec.name, sig);
        if (sig === key || flags === undefined || flags & (FINAL | PRIVATE | ACC.STATIC) || source.includes(`"${name}"`)) continue;
        skipped.add(sig);
      }
      if (skipped.size) out.set(`${spec.name}.${key}`, [...skipped].sort());
    }
  }
  return out;
}

/** platform class → signature → how many corpus apps override it there or in a subclass */
async function corpusOverrides(defs: Map<string, ClassDef>, wanted: Map<string, Set<string>>): Promise<Record<string, Record<string, number>>> {
  const counts = new Map<string, Map<string, Set<string>>>();
  // the corpus apps work runs against (docs/bytecode-first-plan.md §9: never Genshin or the Clash games)
  for (const apk of readdirSync(resolve(root, "apks")).filter((f) => /\.x?apk$/.test(f) && !/Genshin|Clash/.test(f))) {
    let dexes;
    try { dexes = await openDexes(resolve(root, "apks", apk)); } catch { continue; }
    const app = new Map<string, ClassDef>();
    for (const dex of dexes) for (let i = 0; i < dex.classDefCount; i++) {
      const name = descToName(dex.type(dex.classDef2Type(i)));
      if (!app.has(name)) app.set(name, dex.classDef(i));
    }
    for (const def of app.values()) {
      const sigs = def.virtualMethods.map((e) => signature(def, e.methodIdx));
      for (let cls = superOf(def), hops = 0; cls && hops < 64; hops++) {
        const next = app.get(cls) ?? defs.get(cls);
        if (!app.has(cls) && wanted.has(cls)) {
          let byClass = counts.get(cls);
          if (!byClass) counts.set(cls, byClass = new Map());
          for (const sig of sigs) if (wanted.get(cls)!.has(sig)) { let apps = byClass.get(sig); if (!apps) byClass.set(sig, apps = new Set()); apps.add(apk); }
        }
        cls = next && superOf(next);
      }
    }
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([cls, m]) => [cls, Object.fromEntries([...m].sort(([a], [b]) => a < b ? -1 : 1).map(([sig, apps]) => [sig, apps.size]))]));
}

/** the skipped self-calls a corpus app overrides, as "Class.method(desc) → call(desc)" lines */
export function overrideBypasses(skipped: Map<string, string[]>, overrides: Record<string, Record<string, number>>): string[] {
  const out: string[] = [];
  for (const [method, sigs] of skipped) {
    const cls = method.slice(0, method.lastIndexOf(".", method.indexOf("(")));
    for (const sig of sigs) if (overrides[cls]?.[sig]) out.push(`${method} → ${sig}`);
  }
  return out.sort();
}

if (import.meta.main) {
  if (!hasPlatformJars()) throw new Error("no vendor/aosp platform jars — run: bun run gen-framework");
  const defs = platformDefs(), skipped = selfCallsSkipped(defs);
  if (process.argv.includes("--corpus")) {
    // an override counts at the class that declares the skipped call and every subclass with a spec
    const wanted = new Map<string, Set<string>>();
    for (const [method, sigs] of skipped) {
      const cls = method.slice(0, method.lastIndexOf(".", method.indexOf("(")));
      for (const s of sigs) { let w = wanted.get(cls); if (!w) wanted.set(cls, w = new Set()); w.add(s); }
    }
    writeFileSync(OVERRIDES, JSON.stringify(await corpusOverrides(defs, wanted), null, 1) + "\n");
  }
  const overrides = JSON.parse(readFileSync(OVERRIDES, "utf8"));
  const found = overrideBypasses(skipped, overrides);
  if (process.argv.includes("--write-baseline")) writeFileSync(BASELINE, JSON.stringify(found, null, 1) + "\n");
  for (const line of found) {
    const [method, sig] = line.split(" → "), cls = method.slice(0, method.lastIndexOf(".", method.indexOf("(")));
    console.log(`${line}  (${overrides[cls][sig]} apps)`);
  }
  console.log(`${found.length} bypasses of methods corpus apps override, in ${skipped.size} TS methods that skip a self-call`);
}
