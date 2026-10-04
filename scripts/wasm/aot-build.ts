// Builds the ahead-of-time assets (aot.ts) of the first platform jars: one D (data) module per class group and one C (code) module per group,
// and the index that numbers everything.
//   bun run aot -- [--out dir] [--jars N | --only jar,jar] [--d class|outer|pkg|pkgN|all] [--c class|outer|pkg|pkgN|all] [--no-validate] [--app app.dex]
// The Program holds every platform jar (class-hierarchy decisions are made over all of them); the first N jars (or the named ones) are numbered and compiled.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { loadDexes, world } from "./lib";
import { Program } from "../../src/wasm/compiler/program";
import { externs } from "../../src/wasm/link/intrinsics";
import { natives } from "./oracle";
import { Compiler } from "../../src/wasm/compiler/j2w";
import { packModule, type CHeader, type DHeader } from "../../src/wasm/link/aot";
import type { MethodInfo } from "../../src/wasm/compiler/program";
import { compileModule } from "../../src/wasm/link/module";
import { mid } from "../../src/wasm/compiler/ids";
import { AOSP, ROOT } from "./paths";

const flag = (k: string, d: string) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const out = flag("--out", join(ROOT, "vendor/wasm-aot/default")), nJars = +flag("--jars", "4"), dMode = flag("--d", "pkg"), cMode = flag("--c", "pkg");

/** whether the build compiles `m`: it has bytecode or an implementation of its own (the rest stay abstract, or become a gap on demand) */
const aotCompiles = (m: MethodInfo): boolean => !!m.codeOff || !!w.intrinsic(m);

/** the group key of a class: its own, its outermost class's, its package, or the first N components of the package */
export function keyOf(mode: string, name: string): string {
  if (mode === "class") return name;
  if (mode === "outer") return name.split("$")[0];
  if (mode === "all") return "all";
  const pkg = name.slice(0, name.lastIndexOf("/") + 1), m = /^pkg(\d+)$/.exec(mode);
  return m ? pkg.split("/").slice(0, +m[1]).join("/") : pkg;
}

const jarNames = flag("--only", "").split(",").filter(Boolean);
const jars = PLATFORM_JARS.filter((j, i) => (jarNames.length ? jarNames.some((n) => j.endsWith("/" + n + ".jar") || j === n + ".jar") : i < nJars));
const dexes = PLATFORM_JARS.map((j) => loadDexes(join(AOSP, j)));
// an app compiled at build time, as at install: its classes are numbered after the platform's and the Program starts with the same dexes
const appDexes = flag("--app", "") ? loadDexes(flag("--app", "")) : [];
const prog = new Program([...dexes.flat(), ...appDexes]); prog.addExterns(externs);
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const w = world(prog, { natives, build: { dGroup: (n) => keyOf(dMode, n), cGroup: (n) => keyOf(cMode, n), dexes: new Set([...dexes.filter((_, i) => jars.includes(PLATFORM_JARS[i])).flat(), ...appDexes]) } });
const aot = w.aot!;
const t0 = performance.now();
let cBytes = 0, dBytes = 0, nMethods = 0, v8Ms = 0, mapBytes = 0;
const validate = !process.argv.includes("--no-validate");
/** V8's verdict on a module: the function it rejects, if any */
const check = (bytes: Uint8Array): { fn: number; message: string } | undefined => {
  if (!validate) return undefined;
  const t = performance.now();
  try { compileModule(bytes); } catch (e) {
    const message = (e as Error).message, m = /function #(\d+)/.exec(message);
    return { fn: m ? +m[1] : -1, message };
  } finally { v8Ms += performance.now() - t; }
};
const skipped: string[] = [];
const idsOf = (names: Iterable<string>) => [...names].filter((n) => n[0] !== "!").map((n) => w.idOf(n));
const synthOf = (names: Iterable<string>) => [...names].filter((n) => n[0] === "!").map((n) => n.slice(1));
const classesOf = (keys: number[], k: number) => keys.flatMap((g, i) => (g === k ? [i] : []));

// ---- code modules first: they number the selectors, gaps and runtime functions the class modules' vtables then use
const empty = new Set<number>();
const cGroups = aot.cKeys.map((_, k) => classesOf(aot.cGroupOf, k));
cGroups.forEach((blocks, k) => {
  const methods = blocks.flatMap((b) => prog.get(w.blockClass[b])!.methods.filter((m) => aotCompiles(m)));
  if (!methods.length) { empty.add(k); return; }
  // a method the compiler emits invalid code for is left to the on-demand compiler, which fails the same way if it is ever called
  const skip = new Set<string>();
  let cx: Compiler, built: ReturnType<Compiler["buildUnit"]>, touch: Set<string>;
  for (;;) {
    cx = new Compiler(w);
    aot.beginTouch();
    built = cx.buildUnit(methods.filter((m) => !skip.has(mid(m))), [], false, true);
    touch = aot.endTouch();
    const bad = check(built.bytes);
    if (!bad) break;
    const name = bad.fn >= 0 ? cx.mb.funcNames[bad.fn - cx.mb.nImportedFuncs] : "";
    if (!name || skip.has(name)) throw new Error(`C ${k}: ${bad.message}`);
    skip.add(name); skipped.push(`${name}: ${bad.message}`);
  }
  const { bytes, traces } = built;
  nMethods += methods.length - skip.size;
  const seen = new Set<string>(), assumptions: CHeader["assumptions"] = [];
  for (const [decl, name, desc, target, owner] of cx.assumptions) {
    const slot = w.slotOf(owner!), key = `${decl}.${name}${desc}@${slot}`;
    if (!seen.has(key)) { seen.add(key); assumptions.push([decl, name, desc, target?.cls ?? "", target?.key ?? "", slot]); }
  }
  const header: CHeader = { classes: blocks, touch: idsOf(touch), synth: synthOf(touch), natives: [...cx.nativeImports.keys()], mods: [...cx.deps.keys()],
    assumptions, allocs: [...cx.allocs], gaps: [...new Set(cx.gaps)].map((g) => w.gapId(g)), missing: cx.absent.map(([name, owner]) => [name, w.slotOf(owner!)] as [string, number]),
    absent: blocks.flatMap((b) => prog.get(w.blockClass[b])!.methods.filter((m) => !aotCompiles(m) || skip.has(mid(m))).map((m) => w.blockBase[b] + m.index)) };
  const plain = packModule(header, bytes), file = packModule(header, bytes, traces.map((t) => ({ slot: w.slotOf(t.m!), offsets: t.offsets, pcs: t.pcs })));
  writeFileSync(join(out, `c${k}.wasm`), file);
  cBytes += file.length; mapBytes += file.length - plain.length;
});
aot.cGroupOf = aot.cGroupOf.map((g) => (empty.has(g) ? -1 : g));
const t1 = performance.now();

// ---- class modules
const dGroups = aot.dKeys.map((_, k) => classesOf(aot.dGroupOf, k));
dGroups.forEach((blocks, k) => {
  const names = blocks.map((b) => w.blockClass[b]);
  aot.beginTouch();
  const bytes = w.classModule(names.map((n) => w.link(n)));
  const touch = aot.endTouch();
  const header: DHeader = { classes: blocks, touch: idsOf(touch), synth: synthOf(touch) };
  const bad = check(bytes);
  if (bad) throw new Error(`D ${k}: ${bad.message}`);
  const file = packModule(header, bytes);
  writeFileSync(join(out, `d${k}.wasm`), file);
  dBytes += file.length;
});
// the classes the code reserved slots for beyond the platform's (arrays, ...) share one module; building it can reserve more
const extraNames = () => aot.tail.flatMap((t) => (typeof t === "string" ? [] : [t[0]]));
let extras: number, xbytes: Uint8Array, xtouch: Set<string>;
do {
  const names = extraNames();
  extras = names.length;
  aot.beginTouch();
  xbytes = w.classModule(names.map((n) => w.link(n)));
  xtouch = aot.endTouch();
} while (extraNames().length !== extras);
if (check(xbytes)) throw new Error("extra classes: module does not validate");
const xfile = packModule({ classes: [], touch: idsOf(xtouch), synth: synthOf(xtouch) } satisfies DHeader, xbytes);
writeFileSync(join(out, `d${aot.dKeys.length}.wasm`), xfile); dBytes += xfile.length;
const t2 = performance.now();

const index = aot.finish();
writeFileSync(join(out, "index.json"), JSON.stringify(index));
const kb = (n: number) => (n / 1024).toFixed(0) + " KB";
console.log(`${aot.nSeeded} classes of ${jars.length} jars${appDexes.length ? " and the app" : ""} (${nMethods} methods compiled) in ${aot.cKeys.length} C modules (${kb(cBytes)}, traces ${kb(mapBytes)}) and ${aot.dKeys.length} D modules (${kb(dBytes)}), index ${kb(JSON.stringify(index).length)}`);
console.log(`compile ${(t1 - t0).toFixed(0)} ms (${(w.stats.compileMs).toFixed(0)}), classes ${(t2 - t1).toFixed(0)} ms${validate ? `, V8 validate+compile ${v8Ms.toFixed(0)} ms` : ""}; ${index.selectors.length} selectors, ${index.gaps.length} gaps, ${index.tail.length} extra slots, ${index.extraNames.length} extra ids`);
if (skipped.length) console.log(`${skipped.length} methods left to the on-demand compiler:\n  ${skipped.join("\n  ")}`);
console.log("phases (ms):", Object.entries(w.stats.phase).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(", "));
process.exit();
