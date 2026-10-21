// Making the modules of a build (scripts/wasm/aot-build.ts makes the platform's, apps.ts an app's) and the headers that say what their code needs, which aot.ts reads:
// the size a module is estimated at, V8's verdict on one, and the code, data and synthetic-function modules.
import { Compiler, NeedsNumber, type FnTrace } from "../compiler/j2w.ts";
import { mid } from "../compiler/ids.ts";
import { uleb } from "../compiler/wasmbin.ts";
import type { JClass, MethodInfo } from "../compiler/program.ts";
import { compileModule } from "./module.ts";
import { AotRuntime, dexSig, VERSION, type AotBuild, type AotIndex, type CHeader, type DHeader, type SHeader, type UnitHeader } from "./aot.ts";
import { hostTakeover } from "./hostclass.ts";
import type { Marks } from "./numbers.ts";
import type { Touched, World } from "./world.ts";

const rle = (a: number[]): number[] => { const o: number[] = []; for (const v of a) { if (o.length && o[o.length - 2] === v) o[o.length - 1]++; else o.push(v, 1); } return o; };

/** The platform build's grouping, over a World made to build it (WorldOptions.build): the classes of the build's dexes are numbered first, in definition order,
 *  and given the D and C module of their group (-1 for no C module); the World links them as the build lays them out (AotRuntime) */
export class AotBuilder {
  private readonly w: World;
  private readonly dexSigs = new Set<string>();
  /** what the World had numbered once the platform classes were */
  private readonly seeded: Marks;
  readonly dGroupOf: number[] = [];
  cGroupOf: number[] = [];
  readonly dKeys: string[] = [];
  readonly cKeys: string[] = [];
  constructor(w: World, build: AotBuild) {
    this.w = w;
    const n = w.seedPlatform((d) => build.dexes.has(d) && !!this.dexSigs.add(dexSig(d)));
    this.seeded = w.numbers.marks();
    // the methods the host takes over keep their slots, as a process's World overrides them
    const host = hostTakeover(w.prog, w.natives.source?.hostSpecs?.() ?? [], w.opts.hostWhole);
    w.hosts.adoptTakeover(host.implemented, []);
    for (const m of host.taken) w.hosts.take(m);
    const dIds = new Map<string, number>(), cIds = new Map<string, number>(), id = (m: Map<string, number>, keys: string[], k: string | null) => {
      if (k === null) return -1;
      let i = m.get(k); if (i === undefined) { m.set(k, i = keys.length); keys.push(k); }
      return i;
    };
    for (let i = 1; i <= n; i++) {
      const name = w.nameOf(i);
      this.dGroupOf.push(id(dIds, this.dKeys, build.dGroup(name)));
      this.cGroupOf.push(id(cIds, this.cKeys, build.cGroup(name)));
    }
    w.aot = new AotRuntime(w, { dOf: Int32Array.from(this.dGroupOf), cOf: new Int32Array(0), extraGroup: this.dKeys.length });
  }
  /** the index of the finished build, whose runtime functions are in `synths` */
  finish(synths: string[][]): AotIndex {
    const w = this.w, withCode = [...w.prog.all()].filter((c) => c.dex);
    return { version: VERSION, dexes: [...new Set(withCode.map((c) => dexSig(c.dex!)))], programClasses: withCode.length, aotDexes: [...this.dexSigs], classes: w.slots.seeded,
      numbering: w.numbers.since(this.seeded), dOf: rle(this.dGroupOf), cOf: rle(this.cGroupOf), extraGroup: this.dKeys.length, intrinsics: [...w.opts.intrinsics.keys()], synths,
      ...w.hosts.takeoverRecord() };
  }
}

// the estimated bytes of a method with code in a code module (by its dex code units) and of a class in a data module, measured over the platform build
const C_BYTES_PER_METHOD = 150, C_BYTES_PER_UNIT = 14, D_BYTES_PER_CLASS = 330, D_BYTES_PER_METHOD = 52, D_BYTES_PER_FIELD = 19;
export const codeBytes = (m: MethodInfo): number => (m.codeOff ? C_BYTES_PER_METHOD + C_BYTES_PER_UNIT * m.dex.code(m.codeOff).insns.length : 0);
export const dataBytes = (jc: JClass | undefined): number => D_BYTES_PER_CLASS + (jc ? jc.methodCount * D_BYTES_PER_METHOD + jc.fields.length * D_BYTES_PER_FIELD : 0);

/** the time V8 took to judge modules */
export const validation = { ms: 0 };
/** why V8 rejects `bytes`, if it rejects the module, and the name of the function of `cx`'s module it names ("" for none) */
export function invalidFunction(bytes: Uint8Array, cx?: Compiler): { name: string; message: string } | undefined {
  const t = performance.now();
  try { compileModule(bytes); } catch (e) {
    const message = (e as Error).message, m = /function #(\d+)/.exec(message);
    return { name: m && cx ? cx.mb.funcNames[+m[1] - cx.mb.nImportedFuncs] ?? "" : "", message };
  } finally { validation.ms += performance.now() - t; }
  return undefined;
}

/** what code built by `cx` relies on, by the numbers of `w`: `slot` owns what no method of it does (a helper's code, a symbolic site's) */
function reliance(w: World, cx: Compiler, slot?: number): Pick<UnitHeader, "assumptions" | "allocs" | "missing" | "held"> {
  const owner = (m: MethodInfo | undefined): number => {
    const at = m ? w.slotOf(m) : slot;
    if (at === undefined) throw new Error("compiled code relies on something with no invalidation owner");
    return at;
  };
  const held = cx.held, seen = new Set<string>(), assumptions: UnitHeader["assumptions"] = [];
  for (const [decl, name, desc, target, m] of cx.assumptions) {
    const at = owner(m), key = `${decl}.${name}${desc}@${at}`;
    if (!seen.has(key)) { seen.add(key); assumptions.push([decl, name, desc, target?.cls ?? "", target?.key ?? "", at]); }
  }
  return { assumptions, allocs: [...cx.allocs], missing: cx.absent.map(([name, m]) => [name, owner(m)] as [string, number]), ...held.length && { held } };
}
/** what code made by `cx` for another World (naming the table slots `touched`) needs and relies on, by the numbers of `w` */
export function unitHeader(w: World, cx: Compiler, touched: Touched): UnitHeader {
  return { version: VERSION, ...touched, classImports: cx.classImports(), natives: [...cx.nativeImports.keys()], symbols: [...cx.symbolicImports.values()].map(v => v.site), ...reliance(w, cx) };
}
/** the header of a unit compiled here by `cx`, whose imports are made from what its compile linked (Units.of): what its code relies on, `slot` owning what no
 *  method of it does */
export function compiledHeader(w: World, cx: Compiler, slot?: number): UnitHeader {
  return { version: VERSION, touch: [], synth: [], classImports: [], natives: [], ...reliance(w, cx, slot) };
}
/** `wasm` with the custom sections the runtime reads: the header, and the traces of its functions (methods numbered by `w`) */
export function packModule(header: object, wasm: Uint8Array, traced?: { w: World; traces: FnTrace[] }): Uint8Array {
  const section = (name: string, body: Uint8Array) => {
    const n = new TextEncoder().encode(name), pre: number[] = [0], inner: number[] = [];
    uleb(n.length, inner);
    uleb(n.length + inner.length + body.length, pre);
    return [Uint8Array.from(pre), Uint8Array.from(inner), n, body];
  };
  // a function's trace is its slot, its length in bytes and then the count, ascending offsets and the pcs they belong to (both as differences), then its
  // inline frames (FnTrace.inline) as count and (slot, pc, at): a reader skips the functions it does not want
  const t: number[] = [], { w, traces = [] } = traced ?? {};
  for (const { m, offsets, pcs, inline = [] } of traces) {
    const body: number[] = [];
    uleb(offsets.length, body);
    let o = 0, p = 0;
    for (let i = 0; i < offsets.length; i++) { uleb(offsets[i] - o, body); o = offsets[i]; uleb((((pcs[i] - p) << 1) ^ ((pcs[i] - p) >> 31)) >>> 0, body); p = pcs[i]; }
    uleb(inline.length, body);
    for (const [im, pc, at] of inline) { uleb(w!.slotOf(im), body); uleb(pc, body); uleb(at, body); }
    uleb(w!.slotOf(m!), t); uleb(body.length, t);
    for (const x of body) t.push(x);
  }
  const parts = [wasm, ...section("aot", new TextEncoder().encode(JSON.stringify({ version: VERSION, ...header }))), ...(traced ? section("aottrace", Uint8Array.from(t)) : [])];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { out.set(x, at); at += x.length; }
  return out;
}

/** `methods` compiled as a module that installs them, and its header. A method the compiler emits invalid code for, or that a frozen World cannot number, is left out
 *  (`skipped`), to the on-demand compiler, which fails the same way if it is ever called; with `strict`, it fails the build. `validate`: V8 judges the module. */
function codeModule(w: World, methods: MethodInfo[], { strict = false, validate = true } = {}):
  { cx: Compiler; built: ReturnType<Compiler["buildUnit"]>; header: UnitHeader; skipped: Map<string, string> } {
  const skipped = new Map<string, string>();
  for (;;) {
    const cx = new Compiler(w);
    let built: ReturnType<Compiler["buildUnit"]>, touched: Touched;
    try { [built, touched] = w.touched(() => cx.buildUnit(methods.filter((m) => !skipped.has(mid(m))), { install: "build" })); } catch (e) {
      if (strict || !(e instanceof NeedsNumber) || !e.method || skipped.has(mid(e.method))) throw e;
      skipped.set(mid(e.method), e.message);
      continue;
    }
    const bad = validate ? invalidFunction(built.bytes, cx) : undefined;
    if (!bad) return { cx, built, header: unitHeader(w, cx, touched), skipped };
    if (strict || !bad.name || skipped.has(bad.name)) throw new Error(strict && bad.name ? `${bad.name}: ${bad.message}` : bad.message);
    skipped.set(bad.name, bad.message);
  }
}
/** the code module of `methods`, which are of the classes of blocks `classes`, as a file (codeModule): its header says the classes' other methods are absent, and
 *  with `platformData` that it imports class globals from the platform build's data modules whole */
export function codeFile(w: World, classes: number[], methods: MethodInfo[], { platformData = false, ...opts }: { strict?: boolean; validate?: boolean; platformData?: boolean } = {}):
  { file: Uint8Array; header: CHeader; bytes: Uint8Array } {
  const { cx, built, header: unit, skipped } = codeModule(w, methods, opts), held = new Set(methods);
  const absent = classes.flatMap((b) => w.prog.get(w.slots.blockClass[b])!.methods.filter((m) => !held.has(m) || skipped.has(mid(m))).map((m) => w.slots.blockBase[b] + m.index));
  const header: CHeader = { ...unit, classes, mods: platformData ? [...cx.deps.keys()] : [], absent };
  return { file: packModule(header, built.bytes, { w, traces: built.traces }), header, bytes: built.bytes };
}
/** the data module of the classes `names` (World.classModule), and its header */
export function dataModule(w: World, names: string[]): { bytes: Uint8Array; header: DHeader } {
  const [bytes, touched] = w.touched(() => w.classModules.classModule(names.map((n) => w.link(n))));
  return { bytes, header: { classes: names.map((n) => w.slots.blockOf(w.link(n).slotBase)), ...touched } };
}
/** synthetic functions to a module */
const SYNTH_GROUP = 64;
/** the World's synthetic functions as modules of a few dozen, which load together; a function V8 rejects is left to the on-demand compiler, as in `codeModule` */
export function synthModules(w: World, emit: (module: number, bytes: Uint8Array) => void): string[][] {
  const synths: string[][] = [];
  // building a group can name more synthetic functions (one that calls another): the list is read again for the next group
  for (let at = 0, all = w.slots.synths(); at < all.length; all = w.slots.synths()) {
    const end = Math.min(at + SYNTH_GROUP, all.length);
    let group = all.slice(at, end);
    for (;;) {
      const cx = new Compiler(w), [built, touched] = w.touched(() => cx.buildSynthetics(group.map(({ name, slot, d }) => ({ name, slot, params: d.params, ret: d.ret, body: (c) => d.body(cx, c) })))), bad = invalidFunction(built.bytes, cx);
      if (!bad) {
        if (built.kept.length) {
          const header: SHeader = { ...unitHeader(w, cx, touched), names: built.kept };
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
