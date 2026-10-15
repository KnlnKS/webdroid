// An app compiled ahead on top of the platform build (aot.ts `extend`): the code of the methods it is likely to run, in code modules a<k>.wasm of the classes' groups, and the
// numbering that code relies on. A World at the platform build's state that has the app's dexes takes it as it takes the platform's own modules, and compiles the rest on demand.
import { Compiler } from "../compiler/j2w";
import { mid } from "../compiler/ids";
import { compileModule } from "./module";
import { APP_VERSION, packModule, unitHeader, type AppIndex, type CHeader, type DHeader, type Demand, type SHeader } from "./aot";
import { methodCount, type MethodInfo } from "../compiler/program";
import type { World } from "./world";

/** the estimated size of a code module (the bytes per dex code unit and per method aot-build measured) where the next class starts another */
const MODULE_BYTES = 1 << 20, BYTES_PER_METHOD = 150, BYTES_PER_UNIT = 14;
/** the same for a data module: a module is loaded whole when any of its classes is first used, so these are small; the figures are aot-build's */
const D_MODULE_BYTES = 128 << 10, D_BYTES_PER_CLASS = 330, D_BYTES_PER_METHOD = 52, D_BYTES_PER_FIELD = 19;
/** synthetic functions to a module */
const SYNTH_GROUP = 64;
export interface AppBuild { index: AppIndex; files: [name: string, bytes: Uint8Array][] }

/** why V8 rejects `bytes`, if it rejects the module, and the name of the function of `cx`'s module it names ("" for none) */
function invalidFunction(bytes: Uint8Array, cx?: Compiler): { name: string; message: string } | undefined {
  try { compileModule(bytes); } catch (e) {
    const message = (e as Error).message, m = /function #(\d+)/.exec(message);
    return { name: m && cx ? cx.mb.funcNames[+m[1] - cx.mb.nImportedFuncs] ?? "" : "", message };
  }
  return undefined;
}
/** the World's synthetic functions as modules of a few dozen, which load together; a function V8 rejects is left to the on-demand compiler, as in `compileChecked` */
export function synthModules(w: World, emit: (module: number, bytes: Uint8Array) => void): string[][] {
  const synths: string[][] = [];
  // building a group can name more synthetic functions (one that calls another): the list is read again for the next group
  for (let at = 0, all = w.synths(); at < all.length; all = w.synths()) {
    const end = Math.min(at + SYNTH_GROUP, all.length);
    let group = all.slice(at, end);
    for (;;) {
      const cx = new Compiler(w);
      w.beginTouch();
      const built = cx.buildSynthetics(group), touch = w.endTouch(), bad = invalidFunction(built.bytes, cx);
      if (!bad) {
        if (built.kept.length) {
          const header: SHeader = { ...unitHeader(w, cx, touch), names: built.kept };
          emit(synths.length, packModule(header, built.bytes));
          synths.push(built.kept);
        }
        break;
      }
      const name = bad.name.slice(1);
      if (!name || !group.some((g) => g.name === name)) break;
      group = group.filter((g) => g.name !== name);
    }
    at = end;
  }
  return synths;
}
/** `methods` as a module that installs them: a method the compiler emits invalid code for (`check` says so) is left out, to the on-demand compiler, which fails the same way if it is ever called */
function compileChecked(w: World, methods: MethodInfo[]): { cx: Compiler; built: ReturnType<Compiler["buildUnit"]>; touch: Set<string>; skipped: Map<string, string> } {
  const skipped = new Map<string, string>();
  for (;;) {
    const cx = new Compiler(w);
    w.beginTouch();
    const built = cx.buildUnit(methods.filter((m) => !skipped.has(mid(m))), [], false, true), touch = w.endTouch(), bad = invalidFunction(built.bytes, cx);
    if (!bad) return { cx, built, touch, skipped };
    if (!bad.name || skipped.has(bad.name)) throw new Error(bad.message);
    skipped.set(bad.name, bad.message);
  }
}

/** the build of `methods` (of the Program's classes after the platform's, in the order the app will want them) and the data modules of `demand.classes`, by a World that has just attached the platform build and numbered the app's prefix */
export function buildApp(w: World, methods: MethodInfo[], demand: Demand): AppBuild {
  const aot = w.aot;
  if (!aot) throw new Error("an app build needs the platform build");
  const prefix = w.since(aot.platformMarks), base = w.numbering(), byClass = new Map<string, MethodInfo[]>();
  for (const m of methods) { const list = byClass.get(m.cls); if (list) list.push(m); else byClass.set(m.cls, [m]); }
  // the methods of platform classes that a platform code module holds are a patch to that module: loaded after it, they replace what a class of the app made it undo or lack. The other
  // classes' methods are in modules of their own.
  const own: MethodInfo[][] = [], patches = new Map<number, MethodInfo[][]>();
  for (const [cls, list] of byClass) {
    const over = aot.platformModule(w.blockOf(w.link(cls).slotBase));
    if (over < 0) own.push(list); else (patches.get(over) ?? patches.set(over, []).get(over)!).push(list);
  }
  /** the classes' methods (all of a class together) in groups of about a module's size */
  const grouped = (lists: MethodInfo[][]): MethodInfo[][] => {
    const groups: MethodInfo[][] = [[]];
    let bytes = 0;
    for (const list of lists) {
      const size = list.reduce((n, m) => n + BYTES_PER_METHOD + BYTES_PER_UNIT * (m.codeOff ? m.dex.code(m.codeOff).insns.length : 0), 0);
      if (bytes && bytes + size > MODULE_BYTES) { groups.push([]); bytes = 0; }
      groups[groups.length - 1].push(...list); bytes += size;
    }
    return groups.filter((g) => g.length);
  };
  const files: AppBuild["files"] = [], cOf: AppIndex["cOf"] = [], patchOf: AppIndex["patches"] = [], touched = new Set<string>();
  const emit = (group: MethodInfo[], over: number) => {
    const { cx, built, touch, skipped } = compileChecked(w, group), module = files.length;
    const classes = [...new Set(group.map((m) => m.cls))].map((c) => w.blockOf(w.link(c).slotBase));
    const wanted = new Set(group);
    const absent = classes.flatMap((b) => w.prog.get(w.blockClass[b])!.methods.filter((m) => !wanted.has(m) || skipped.has(mid(m))).map((m) => w.blockBase[b] + m.index));
    for (const n of touch) touched.add(n);
    const header: CHeader = { ...unitHeader(w, cx, touch), classes, mods: [], absent };
    files.push([`a${module}.wasm`, packModule(header, built.bytes, built.traces.map((t) => ({ slot: w.slotOf(t.m!), offsets: t.offsets, pcs: t.pcs })))]);
    if (over < 0) for (const b of classes) cOf.push([b, module]); else patchOf.push([module, over]);
  };
  for (const group of grouped(own)) emit(group, -1);
  for (const [over, lists] of patches) for (const group of grouped(lists)) emit(group, over);
  const code = files.length, dOf: AppIndex["dOf"] = [];
  let group: string[] = [], size = 0;
  const flush = () => {
    if (!group.length) return;
    w.beginTouch();
    const bytes = w.classModule(group.map((n) => w.link(n))), touch = w.endTouch(), blocks = group.map((n) => w.blockOf(w.link(n).slotBase));
    group = []; size = 0;
    // a module V8 rejects leaves its classes to the on-demand builder
    if (invalidFunction(bytes)) return;
    const header: DHeader = { classes: blocks, touch: [...touch].filter((n) => n[0] !== "!").map((n) => w.idOf(n)), synth: [...touch].filter((n) => n[0] === "!").map((n) => n.slice(1)) };
    for (const b of blocks) dOf.push([b, files.length - code]);
    files.push([`e${files.length - code}.wasm`, packModule(header, bytes)]);
  };
  // the classes a code module names are all linked when it is loaded, so their modules are wanted as soon as it is
  for (const name of new Set([...demand.classes, ...touched])) {
    const jc = name[0] === "!" ? undefined : w.prog.get(name);
    // The platform also owns data for uncompiled classes reserved in its tail; an array class the app's code names is the app's
    if (!(jc?.dex || name[0] === "[") || aot.reservedBase(name) !== undefined) continue;
    const bytes = D_BYTES_PER_CLASS + (jc ? methodCount(jc) * D_BYTES_PER_METHOD + jc.fields.length * D_BYTES_PER_FIELD : 0);
    if (size && size + bytes > D_MODULE_BYTES) flush();
    group.push(name); size += bytes;
  }
  flush();
  // the synthetic functions the code names and those the host asked for: modules of a few dozen, which load together
  w.replay(demand.infos);
  const synths = synthModules(w, (k, bytes) => files.push([`s${k}.wasm`, bytes]));
  return { index: { version: APP_VERSION, prefix, base, dexes: aot.appDexes(), classes: aot.appClassCount, numbering: w.since(base), cOf, patches: patchOf, modules: code, synths, dOf, dModules: files.length - code, demand, libraries: aot.rootLibraries() }, files };
}
