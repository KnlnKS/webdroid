// Builds the ahead-of-time assets (aot.ts) of the platform jars: one D (data) module per class group and one C (code) module per group,
// and the index that numbers everything.
//   pnpm aot [--out dir] [--jars N | --only jar,jar] [--d class|outer|pkg|pkgN|all] [--c class|outer|pkg|pkgN|all] [--max-module KiB] [--max-hot KiB] [--no-validate] [--force]
// Without --out the build goes to vendor/wasm-aot/<key> (../aot-key.ts) and is skipped when that exists; the default jars are the platform's code: the libcore jars and framework.jar.
// The Program holds every platform jar (class-hierarchy decisions are made over all of them); the chosen jars are numbered and compiled.
// A group is the classes of a package (or of the mode's unit) up to --max-module KiB of estimated module size: Chrome compiles a module above 8 MiB asynchronously only,
// and a page fetches and compiles what a start needs, so no module should be much larger than that.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance.ts";
import { world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { externs } from "../../src/wasm/link/intrinsics.ts";
import { natives } from "./harness.ts";
import { rt } from "../../src/jvm/runtime.ts";
import type { CHeader } from "../../src/wasm/link/aot.ts";
import { AotBuilder, codeBytes, codeModule, dataBytes, dataModule, invalidFunction, packModule, synthModules, validation } from "../../src/wasm/link/aotbuild.ts";
import type { MethodInfo } from "../../src/wasm/compiler/program.ts";
import { AOT_ROOT, buildKey, sourceKey } from "../aot-key.ts";
import { PLATFORM_PATHS } from "../aosp.ts";

const flag = (k: string, d: string) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const PLATFORM = ["core-oj", "core-libart", "okhttp", "bouncycastle", "apache-xml", "conscrypt", "core-icu4j", "framework"];
const nJars = flag("--jars", ""), dMode = flag("--d", "pkg"), cMode = flag("--c", "pkg"), maxModule = +flag("--max-module", "3072") * 1024, maxHot = +flag("--max-hot", "1024") * 1024;
const jarNames = flag("--only", nJars ? "" : PLATFORM.join(",")).split(",").filter(Boolean);
const jars = PLATFORM_JARS.filter((j, i) => (jarNames.length ? jarNames.some((n) => j.endsWith("/" + n + ".jar") || j === n + ".jar") : i < +nJars));
const hot = existsSync(join(AOT_ROOT, "hot.json")) ? JSON.parse(readFileSync(join(AOT_ROOT, "hot.json"), "utf8")) as { linked: string[]; called: string[] } : { linked: [], called: [] };

// ---- where it goes
let out = flag("--out", "");
if (!out) {
  const nativeKeys = [...rt.jni.keys(), ...[...rt.natives].flatMap(([cls, spec]) => Object.keys(spec.methods ?? {}).map((k) => `${cls}|${k}`))].sort();
  const source = sourceKey(), key = buildKey(source, nativeKeys, JSON.stringify([jars, dMode, cMode, maxModule, maxHot, hot]));
  out = join(AOT_ROOT, key);
  mkdirSync(AOT_ROOT, { recursive: true });
  writeFileSync(join(AOT_ROOT, "latest.json"), JSON.stringify({ key, source }));
  if (existsSync(join(out, "startup.json")) && !process.argv.includes("--force")) { console.log(`build ${key} is up to date`); process.exit(); }
}

/** whether the build compiles `m`: it has bytecode or an implementation of its own (the rest stay abstract, or become a gap on demand) */
const aotCompiles = (m: MethodInfo): boolean => !!m.codeOff || !!w.intrinsic(m);

/** the group key of a class: its own, its outermost class's, its package, or the first N components of the package */
function keyOf(mode: string, name: string): string {
  if (mode === "class") return name;
  if (mode === "outer") return name.split("$")[0];
  if (mode === "all") return "all";
  const pkg = name.slice(0, name.lastIndexOf("/") + 1), m = /^pkg(\d+)$/.exec(mode);
  return m ? pkg.split("/").slice(0, +m[1]).join("/") : pkg;
}
/** keys that start a new group when the one being filled would pass `limit` (an estimate of the module's bytes: `size` of each class, called in definition order) */
function chunked(mode: string, size: (name: string) => number, limit: number): (name: string) => string {
  const open = new Map<string, { n: number; bytes: number }>();
  return (name) => {
    const key = keyOf(mode, name), bytes = size(name), g = open.get(key) ?? (open.set(key, { n: 0, bytes: 0 }), open.get(key)!);
    if (g.bytes && g.bytes + bytes > limit) { g.n++; g.bytes = 0; }
    g.bytes += bytes;
    return g.n ? `${key}#${g.n}` : key;
  };
}
/** the classes `aot-profile.ts` saw launches use, assigned to modules of their own in the order of use (a module per `limit` bytes); the rest are grouped as `rest` says */
function hotChunked(names: string[], size: (name: string) => number, limit: number, tag: string, rest: (name: string) => string): (name: string) => string {
  const of = new Map<string, string>();
  let n = 0, bytes = 0;
  for (const name of names) {
    const b = size(name);
    if (bytes && bytes + b > limit) { n++; bytes = 0; }
    bytes += b;
    of.set(name, `${tag}#${n}`);
  }
  return (name) => of.get(name) ?? rest(name);
}
// Guarded capture sites made a 3 MiB estimated media group emit 8.31 MiB.
// Keep the physical 7 MiB cap; estimate those groups with their measured expansion.
const HARD_LIMIT = 7 * 1024 * 1024;
const classSize = (kind: "c" | "d") => (name: string): number => {
  const jc = prog.get(name)!;
  return kind === "d" ? dataBytes(jc) : jc.methods.reduce((n, m) => n + codeBytes(m), 0);
};

/** `names` with their superclasses and interfaces, each before the classes that need it: a class module needs the stubs of what its vtable names */
function withSupers(names: string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  const add = (n: string | null) => {
    const c = n ? prog.get(n) : undefined;
    if (!n || !c?.dex || seen.has(n)) return;
    seen.add(n); add(c.sup); c.ifaces.forEach(add); out.push(n);
  };
  names.forEach(add);
  return out;
}
const dexes = PLATFORM_PATHS.map(loadDexes);
const prog = new Program(dexes.flat()); prog.addExterns(externs);
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const w = world(prog, { natives, build: true });
const aot = new AotBuilder(w, { dGroup: hotChunked(withSupers(hot.linked.length ? hot.linked : hot.called), classSize("d"), maxHot, "hotD", chunked(dMode, classSize("d"), maxModule)), cGroup: hotChunked(hot.called.filter((n) => prog.get(n)?.dex), classSize("c"), maxHot, "hotC", chunked(cMode, classSize("c"), maxModule)), dexes: new Set(dexes.filter((_, i) => jars.includes(PLATFORM_JARS[i])).flat()) });
const t0 = performance.now();
let cBytes = 0, dBytes = 0, nMethods = 0, mapBytes = 0, largest = 0;
/** a module the estimate let grow past what Chrome compiles on the main thread (8 MiB) is a build error: the estimates (link/aotbuild.ts) need re-measuring */
const sized = (file: string, n: number) => { largest = Math.max(largest, n); if (n > HARD_LIMIT) throw new Error(`${file} is ${n} bytes, over ${HARD_LIMIT}; lower --max-module`); };
const validate = !process.argv.includes("--no-validate");
/** V8 rejects `bytes`, when the build validates */
const rejects = (bytes: Uint8Array) => validate && invalidFunction(bytes);
const classesOf = (keys: number[], k: number) => keys.flatMap((g, i) => (g === k ? [i] : []));

// ---- code modules first: they number the selectors, gaps and runtime functions the class modules' vtables then use
const empty = new Set<number>();
const cGroups = aot.cKeys.map((_, k) => classesOf(aot.cGroupOf, k));
cGroups.forEach((blocks, k) => {
  const methods = blocks.flatMap((b) => prog.get(w.slots.blockClass[b])!.methods.filter((m) => aotCompiles(m)));
  if (!methods.length) { empty.add(k); return; }
  let made: ReturnType<typeof codeModule>;
  try { made = codeModule(w, methods, { strict: true, validate }); } catch (e) { throw new Error(`C ${k}: ${(e as Error).message}`); }
  const { cx, built: { bytes, traces }, header: unit } = made;
  nMethods += methods.length;
  const header: CHeader = { ...unit, classes: blocks, mods: [...cx.deps.keys()],
    absent: blocks.flatMap((b) => prog.get(w.slots.blockClass[b])!.methods.filter((m) => !aotCompiles(m)).map((m) => w.slots.blockBase[b] + m.index)) };
  const plain = packModule(header, bytes), file = packModule(header, bytes, { w, traces });
  writeFileSync(join(out, `c${k}.wasm`), file); sized(`c${k}.wasm`, file.length);
  cBytes += file.length; mapBytes += file.length - plain.length;
});
aot.cGroupOf = aot.cGroupOf.map((g) => (empty.has(g) ? -1 : g));
const t1 = performance.now();

// ---- class modules
const dGroups = aot.dKeys.map((_, k) => classesOf(aot.dGroupOf, k));
dGroups.forEach((blocks, k) => {
  const { bytes, header } = dataModule(w, blocks.map((b) => w.slots.blockClass[b])), bad = rejects(bytes);
  if (bad) throw new Error(`D ${k}: ${bad.message}`);
  const file = packModule(header, bytes);
  writeFileSync(join(out, `d${k}.wasm`), file); sized(`d${k}.wasm`, file.length);
  dBytes += file.length;
});
// the classes the code reserved slots for beyond the platform's (arrays, ...) share one module, and the runtime functions the modules name, which a World would
// otherwise make a module for each of, a few; building either can name more of both
const extraNames = () => w.numbers.tail.flatMap((t) => (typeof t === "string" ? [] : [t[0]]));
let extras: number, extra: ReturnType<typeof dataModule>, synths: string[][], nSynths: number, yBytes: number;
do {
  yBytes = 0;
  synths = synthModules(w, (k, bytes) => { writeFileSync(join(out, `y${k}.wasm`), bytes); yBytes += bytes.length; });
  nSynths = w.slots.synths().length;
  const names = extraNames();
  extras = names.length;
  extra = dataModule(w, names);
} while (extraNames().length !== extras || w.slots.synths().length !== nSynths);
if (rejects(extra.bytes)) throw new Error("extra classes: module does not validate");
const xfile = packModule({ ...extra.header, classes: [] }, extra.bytes);
writeFileSync(join(out, `d${aot.dKeys.length}.wasm`), xfile); dBytes += xfile.length;
const t2 = performance.now();

const index = aot.finish(synths);
writeFileSync(join(out, "index.json"), JSON.stringify(index));
writeFileSync(join(out, "apps.json"), "[]");
// what profiled launches add (aot-profile.ts): until they run, no numbering prefix and no slots to warm
writeFileSync(join(out, "prefix.json"), "null");
writeFileSync(join(out, "warm.json"), "[]");
const kb = (n: number) => (n / 1024).toFixed(0) + " KB";
console.log(`${w.slots.seeded} classes of ${jars.length} jars (${nMethods} methods compiled) in ${aot.cKeys.length} C modules (${kb(cBytes)}, traces ${kb(mapBytes)}) and ${aot.dKeys.length} D modules (${kb(dBytes)}), ${synths.length} runtime function modules (${kb(yBytes)}), index ${kb(JSON.stringify(index).length)}`);
console.log(`largest module ${kb(largest)}, compile ${(t1 - t0).toFixed(0)} ms (${(w.stats.compileMs).toFixed(0)}), classes ${(t2 - t1).toFixed(0)} ms${validate ? `, V8 validate+compile ${validation.ms.toFixed(0)} ms` : ""}; ${index.numbering.selectors.length} selectors, ${index.numbering.gaps.length} gaps, ${index.numbering.tail.length} extra slots, ${index.numbering.names.length} extra ids`);
console.log("phases (ms):", Object.entries(w.stats.phase).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", "));
process.exit();
