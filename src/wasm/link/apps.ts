// An app compiled ahead on top of the platform build (aot.ts `extend`): the code of the methods it is likely to run, in code modules a<k>.wasm of the classes' groups, and the
// numbering that code relies on. A World at the platform build's state that has the app's dexes takes it as it takes the platform's own modules, and compiles the rest on demand.
import { Compiler } from "../compiler/j2w";
import { mid } from "../compiler/ids";
import { compileModule } from "./module";
import { APP_VERSION, packModule, unitHeader, type AppIndex, type CHeader } from "./aot";
import type { MethodInfo } from "../compiler/program";
import type { World } from "./world";

/** the estimated size of a code module (the bytes per dex code unit and per method aot-build measured) where the next class starts another */
const MODULE_BYTES = 1 << 20, BYTES_PER_UNIT = 14, BYTES_PER_METHOD = 150;
export interface AppBuild { index: AppIndex; files: [name: string, bytes: Uint8Array][] }

/** the function V8 rejects in `bytes`, if it rejects the module */
export function invalidFunction(bytes: Uint8Array): { fn: number; message: string } | undefined {
  try { compileModule(bytes); } catch (e) {
    const message = (e as Error).message, m = /function #(\d+)/.exec(message);
    return { fn: m ? +m[1] : -1, message };
  }
  return undefined;
}
/** `methods` as a module that installs them: a method the compiler emits invalid code for (`check` says so) is left out, to the on-demand compiler, which fails the same way if it is ever called */
export function compileChecked(w: World, methods: MethodInfo[], check: (bytes: Uint8Array) => { fn: number; message: string } | undefined = invalidFunction):
  { cx: Compiler; built: ReturnType<Compiler["buildUnit"]>; touch: Set<string>; skipped: Map<string, string> } {
  const skipped = new Map<string, string>();
  for (;;) {
    const cx = new Compiler(w);
    w.beginTouch();
    const built = cx.buildUnit(methods.filter((m) => !skipped.has(mid(m))), [], false, true), touch = w.endTouch(), bad = check(built.bytes);
    if (!bad) return { cx, built, touch, skipped };
    const name = bad.fn >= 0 ? cx.mb.funcNames[bad.fn - cx.mb.nImportedFuncs] : "";
    if (!name || skipped.has(name)) throw new Error(bad.message);
    skipped.set(name, bad.message);
  }
}

/** the build of `methods` (of the Program's classes after the platform's, in the order the app will want them), by a World that has just attached the platform build */
export function buildApp(w: World, methods: MethodInfo[]): AppBuild {
  const aot = w.aot;
  if (!aot) throw new Error("an app build needs the platform build");
  const base = w.numbering(), byClass = new Map<string, MethodInfo[]>();
  for (const m of methods) { const list = byClass.get(m.cls); if (list) list.push(m); else byClass.set(m.cls, [m]); }
  const groups: MethodInfo[][] = [[]];
  let bytes = 0;
  for (const list of byClass.values()) {
    const size = list.reduce((n, m) => n + BYTES_PER_METHOD + BYTES_PER_UNIT * (m.codeOff ? m.dex.code(m.codeOff).insns.length : 0), 0);
    if (bytes && bytes + size > MODULE_BYTES) { groups.push([]); bytes = 0; }
    groups[groups.length - 1].push(...list); bytes += size;
  }
  const files: AppBuild["files"] = [], cOf: AppIndex["cOf"] = [];
  for (const group of groups.filter((g) => g.length)) {
    const { cx, built, touch, skipped } = compileChecked(w, group), module = files.length;
    const classes = [...new Set(group.map((m) => m.cls))].map((c) => w.blockOf(w.link(c).slotBase));
    const wanted = new Set(group);
    const absent = classes.flatMap((b) => w.prog.get(w.blockClass[b])!.methods.filter((m) => !wanted.has(m) || skipped.has(mid(m))).map((m) => w.blockBase[b] + m.index));
    const header: CHeader = { ...unitHeader(w, cx, touch), classes, mods: [], absent };
    files.push([`a${module}.wasm`, packModule(header, built.bytes, built.traces.map((t) => ({ slot: w.slotOf(t.m!), offsets: t.offsets, pcs: t.pcs })))]);
    for (const b of classes) cOf.push([b, module]);
  }
  return { index: { version: APP_VERSION, base, dexes: aot.appDexes(), classes: aot.appClassCount, numbering: w.since(base), cOf, modules: files.length }, files };
}
