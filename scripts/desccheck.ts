// Registered TS descriptors that AOSP does not declare: every native spec method must exist on
// its class or an AOSP supertype with the same name, descriptor and staticness, every String
// method implemented over JS strings must be an instance method of String, and every JNI
// delegate must be a native method its class declares. A spec method standing in for an AOSP
// bytecode body is a reimplementation (docs/architecture.md) unless provenance's TS_SPECS allows its class.
//   pnpm desccheck [--write-baseline]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { rt } from "../src/jvm/runtime.ts";
import { ACC } from "../src/jvm/dex.ts";
import { descToName } from "../src/jvm/abi.ts";
import type { ClassDef, DexFile } from "../src/jvm/dex.ts";
import { jarDexes } from "../src/android/framework.ts";
import { PLATFORM_JARS, tsSpecViolation } from "../src/jvm/provenance.ts";
import { stringMethods } from "../src/jvm/natives/jstring.ts";
import "../src/natives.ts";

const NO_INDEX = 0xffffffff, PRIVATE = 0x2, STRING = "java/lang/String";
/** a method declaration: its access flags, and whether it has a bytecode body */
type Declared = { flags: number; hasCode: boolean };
const aosp = (jar: string) => resolve(import.meta.dirname, "../vendor/aosp", jar);

export const hasPlatformJars = () => PLATFORM_JARS.every((jar) => existsSync(aosp(jar)));
/** every class the platform class path defines, by name, its first definition */
export function platformDefs(): Map<string, ClassDef> {
  const defs = new Map<string, ClassDef>();
  for (const jar of PLATFORM_JARS) for (const dex of jarDexes(readFileSync(aosp(jar)), jar))
    for (let i = 0; i < dex.classDefCount; i++) {
      const name = descToName(dex.type(dex.classDef2Type(i)));
      if (!defs.has(name)) defs.set(name, dex.classDef(i));
    }
  return defs;
}

/** `class → [descriptor problems]` for every registered class AOSP defines */
export function descriptorMismatches(): Map<string, string[]> {
  const defs = platformDefs();
  const declared = new Map<string, Map<string, Declared>>();
  const methodsOf = (name: string) => {
    let m = declared.get(name);
    if (m) return m;
    declared.set(name, m = new Map());
    const def = defs.get(name);
    if (def) for (const e of [...def.directMethods, ...def.virtualMethods]) {
      m.set(def.dex.method(e.methodIdx).name + def.dex.methodDesc(e.methodIdx), { flags: e.flags, hasCode: !!e.codeOff });
    }
    return m;
  };
  const supers = (def: ClassDef) => {
    const dex: DexFile = def.dex;
    return [...(def.superIdx === NO_INDEX ? [] : [def.superIdx]), ...def.interfaces].map((t) => descToName(dex.type(t)));
  };
  /** the declaration `sig` resolves to from `name`, through its supertypes */
  const resolve = (name: string, sig: string, own = true, seen = new Set<string>()): Declared | undefined => {
    if (seen.has(name)) return undefined;
    seen.add(name);
    const found = methodsOf(name).get(sig);
    if (found && (own || !(found.flags & PRIVATE))) return found;
    if (sig.startsWith("<init>")) return undefined;
    const def = defs.get(name);
    for (const s of def ? supers(def) : []) {
      const found = resolve(s, sig, false, seen);
      if (found) return found;
    }
    return undefined;
  };
  /** same-named declarations reachable from `name`, to tell a wrong descriptor from an extra method */
  const near = (name: string, method: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    const def = method === "<init>" ? undefined : defs.get(name);
    return [...[...methodsOf(name).keys()].filter((k) => k.startsWith(method + "(")),
      ...(def ? supers(def) : []).flatMap((s) => near(s, method, seen))];
  };
  const missing = (cls: string, key: string, sig: string) => {
    const alts = [...new Set(near(cls, sig.slice(0, sig.indexOf("("))))];
    return `missing ${key}${alts.length ? ` (AOSP: ${alts.join(" ")})` : ""}`;
  };

  const out = new Map<string, string[]>();
  const report = (cls: string, msg: string) => { let l = out.get(cls); if (!l) out.set(cls, l = []); l.push(msg); };
  for (const spec of rt.natives.values()) {
    if (!defs.has(spec.name)) continue;
    for (const key of Object.keys(spec.methods ?? {})) {
      const isStatic = key.startsWith("static ");
      const sig = isStatic ? key.slice(7) : key;
      const found = resolve(spec.name, sig);
      if (!found) report(spec.name, missing(spec.name, key, sig));
      else if (!!(found.flags & ACC.STATIC) !== isStatic) report(spec.name, `${isStatic ? "static" : "instance"} ${sig} is ${isStatic ? "instance" : "static"} in AOSP`);
      else if (found.hasCode && tsSpecViolation(spec.name, true)) report(spec.name, `reimplements ${key}`);
    }
  }
  for (const sig of stringMethods.keys()) {
    const found = resolve(STRING, sig);
    if (!found) report(STRING, "string " + missing(STRING, sig, sig));
    else if (found.flags & ACC.STATIC) report(STRING, `string ${sig} is static in AOSP`);
  }
  for (const key of rt.jni.keys()) {
    const [cls, sig] = key.split("|");
    if (!defs.has(cls)) continue;
    const found = methodsOf(cls).get(sig);
    if (!found) report(cls, "jni " + missing(cls, sig, sig));
    else if (!(found.flags & ACC.NATIVE)) report(cls, `jni ${sig} is not native in AOSP`);
  }
  return out;
}

/** the accepted mismatches `pnpm test` holds new ones against, without their AOSP hints */
export const BASELINE = resolve(import.meta.dirname, "../tests/fixtures/desccheck-baseline.json");
export const withoutHint = (msg: string) => msg.replace(/ \(AOSP: .*/, "");

if (import.meta.main) {
  if (!hasPlatformJars()) throw new Error("no vendor/aosp platform jars — run: pnpm gen-framework");
  const found = descriptorMismatches();
  if (process.argv.includes("--write-baseline")) {
    const sorted = [...found.keys()].sort().map((cls) => [cls, found.get(cls)!.map(withoutHint).sort()]);
    writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(sorted), null, 1) + "\n");
  }
  let n = 0;
  for (const cls of [...found.keys()].sort()) {
    console.log(cls);
    for (const msg of found.get(cls)!.sort()) { console.log("  " + msg); n++; }
  }
  console.log(`${n} mismatches in ${found.size} classes`);
}
