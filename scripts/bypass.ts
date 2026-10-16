// Override bypasses (docs/architecture.md, static checks): a TS spec method whose AOSP body calls an
// overridable method on `this`, where neither the TS method nor the helpers it calls ever name that
// method, answers without the app's override. Only methods a corpus app overrides are reported; tests/fixtures/app-overrides.json
// records those, with how many apps override each, so the check needs no APKs.
//   pnpm bypass [--corpus] [--write-baseline]
// --corpus rescans apks/ into the fixture; --write-baseline accepts the current findings.
import { globSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { rt } from "../src/jvm/runtime.ts";
import { ACC } from "../src/jvm/dex.ts";
import { descToName } from "../src/jvm/abi.ts";
import type { ClassDef } from "../src/jvm/dex.ts";
import { prepareMethod } from "../src/jvm/prepared.ts";

import "../src/natives.ts";
import { openDexes } from "./lib.ts";
import { corpusApks } from "./apk-corpus.ts";
import { hasPlatformJars, platformDefs } from "./desccheck.ts";
export { hasPlatformJars };

const NO_INDEX = 0xffffffff, FINAL = 0x10, PRIVATE = 0x2;
const root = resolve(import.meta.dirname, "..");
export const OVERRIDES = resolve(root, "tests/fixtures/app-overrides.json");
export const BASELINE = resolve(root, "tests/fixtures/bypass-baseline.json");

const sources = globSync("src/**/*.ts", { cwd: root }).sort().map((file) => [resolve(root, file), readFileSync(resolve(root, file), "utf8")] as const);
/** the file registering a spec, whose helpers a method's source reaches: the one naming it as a
 *  spec, else one quoting its name, else (a name built in a loop) one quoting its simple name */
function specFile(cls: string): string | undefined {
  const simple = cls.slice(Math.max(cls.lastIndexOf("/"), cls.lastIndexOf("$")) + 1);
  for (const needle of [`name: "${cls}"`, `"${cls}"`, `"${simple}"`]) {
    const hit = sources.find(([, text]) => text.includes(needle));
    if (hit) return hit[0];
  }
}

const superOf = (def: ClassDef) => def.superIdx === NO_INDEX ? undefined : descToName(def.dex.type(def.superIdx));
const signature = (def: ClassDef, methodIdx: number) => def.dex.method(methodIdx).name + def.dex.methodDesc(methodIdx);

/** the text of each top-level function or const in a module, by name */
function declarations(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\n(?:export )?(?:async )?(?:function\*? ([A-Za-z_$][\w$]*)|(?:const|let) ([A-Za-z_$][\w$]*)\b)/g)) {
    let depth = 0, i = m.index! + m[0].length, quote = "";
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
      if (c === "/" && text[i + 1] === "/") i = text.indexOf("\n", i) - 1;
      else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) + 1;
      else if (c === '"' || c === "'" || c === "`") quote = c;
      else if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (depth === 0 && (c === ";" || c === "\n" && text[i + 1] !== " ")) break;
    }
    out.set(m[1] ?? m[2], text.slice(m.index!, i));
  }
  return out;
}
const moduleDecls = new Map<string, Map<string, string>>();
/** a spec module's declarations and those of its parts beside it (textview-compound.ts for textview.ts) */
function specDecls(file: string): Map<string, string> {
  const dir = dirname(file), parts = readdirSync(dir).filter((f) => f.startsWith(`${basename(file, ".ts")}-`) && f.endsWith(".ts"));
  const decls = declarations(readFileSync(file, "utf8"));
  for (const part of parts) for (const [name, decl] of declarations(readFileSync(resolve(dir, part), "utf8"))) if (!decls.has(name)) decls.set(name, decl);
  return decls;
}
/** `source` with the module-level helpers it names, three calls deep */
function withHelpers(cls: string, source: string): string {
  const file = specFile(cls);
  if (!file) return source;
  let decls = moduleDecls.get(file);
  if (!decls) moduleDecls.set(file, decls = specDecls(file));
  const seen = new Set<string>();
  for (let depth = 0, frontier = source; depth < 3 && frontier; depth++) {
    let next = "";
    for (const id of new Set(frontier.match(/[A-Za-z_$][\w$]*/g))) {
      const decl = decls.get(id);
      if (decl && !seen.has(id)) { seen.add(id); next += "\n" + decl; }
    }
    source += next; frontier = next;
  }
  return source;
}

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
      const source = withHelpers(spec.name, String((impl as { $g?: unknown }).$g ?? impl));
      const skipped = new Set<string>();
      for (const ins of prepareMethod(code).instructions) {
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
  for (const apk of corpusApks(resolve(root, "apks"))) {
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
  if (!hasPlatformJars()) throw new Error("no vendor/aosp platform jars — run: pnpm gen-framework");
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
