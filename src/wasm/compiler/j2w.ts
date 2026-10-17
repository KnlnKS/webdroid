// One Compiler builds one Wasm module (a unit of methods, or a synthetic body) against a World; see link/world.ts for the linker.
import { HEAP_LIMIT, parseMethodDesc } from "../../jvm/abi.ts";
import { HT, ModuleBuilder, T, ref, refNull, type VT, type FunctionType } from "./wasmbin.ts";
import { Code, OP } from "./code.ts";
import { ACC, type Program, kindOf, type Kind, type MethodInfo } from "./program.ts";
import { mid } from "./ids.ts";
import { H, elemKindOf, type ElemKind } from "./consts.ts";
import { declareSymbolicSites, type SymbolicSite } from "./sites.ts";
import type { PreparedMethod } from "../../jvm/prepared.ts";
import type { Typing } from "./infer.ts";
import { compileMethod } from "./method.ts";
import type { ClassRt, World } from "../link/world.ts";
import { rtfns, type Synth } from "./rtfns.ts";
import type { LinkFailure } from "./linkage.ts";
import { Block, Sync, FUEL, emitBlock, emitSync } from "../link/sched.ts";
import { SLOT, INIT_DONE, THROWERS, ALLOC_WINDOW, MAX_DEPTH, HOT_BUDGET, COUNT_BASE, COUNT_SLOTS, WARM_AT, type Thrower } from "../link/exc.ts";
import { StructStrings, stringCtor } from "../link/strings.ts";
import { emitStoreCheck } from "../link/classes.ts";
import type { NativeBinder } from "../link/hostapi.ts";

export interface Intrinsic { (cx: Compiler, m: MethodInfo, c: Code): void }
/** how `m` is implemented without its bytecode: an intrinsic, a String constructor (a call site makes the string), or a host import */
export function intrinsicFor(intrinsics: Map<string, Intrinsic>, natives: NativeBinder, m: MethodInfo): Intrinsic | undefined {
  return intrinsics.get(mid(m)) ?? (m.isCtor && m.cls === "java/lang/String" ? stringCtor : natives.stub(m));
}

/** the types every module declares identically; Wasm canonicalises them across modules */
export interface Base { tVT: number; tObj: number; tStr: number; tTagFn: number; tData: Record<ElemKind, number>; tArr: Record<ElemKind, number> }
export function declareBase(mb: ModuleBuilder): Base {
  const tVT = mb.addType({ k: "array", elem: { t: T.i32, mut: true } });
  const tObj = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i64, mut: true }], final: false });
  const dataElem: Record<ElemKind, VT> = { i8: T.i8, i16: T.i16, i32: T.i32, i64: T.i64, ref: T.anyref };
  const tData = {} as Record<ElemKind, number>, tArr = {} as Record<ElemKind, number>;
  for (const k of ["i8", "i16", "i32", "i64", "ref"] as ElemKind[]) {
    tData[k] = mb.addType({ k: "array", elem: { t: dataElem[k], mut: true } });
    tArr[k] = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i64, mut: true }, { t: ref(tData[k]), mut: false }], sup: tObj, final: false });
  }
  // a String when it is a struct (structstrings.ts): the Object header, the chars, the cached hash code and the JS string the host has seen
  const tStr = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i64, mut: true }, { t: ref(tData.i16), mut: false }, { t: T.i32, mut: true }, { t: T.externref, mut: true }], sup: tObj, final: true });
  return { tVT, tObj, tStr, tData, tArr, tTagFn: mb.addFuncType([T.anyref], []) };
}
/** every reference slot is an anyref: a Java object is a struct subtype of $Obj, a String the JS string behind any.convert_extern (strings.ts) */
export const kindVT = (k: Kind): VT => (k === "I" ? T.i32 : k === "J" ? T.i64 : T.anyref);

const D_D = { params: [T.f64], results: [T.f64] }, DD_D = { params: [T.f64, T.f64], results: [T.f64] };
/** java.lang.Math's transcendental natives: the host's Math, imported as they are rather than wrapped as natives */
export const MATH_IMPORTS = { acos: D_D, asin: D_D, atan: D_D, cbrt: D_D, cos: D_D, cosh: D_D, exp: D_D, expm1: D_D, log: D_D, log10: D_D,
  log1p: D_D, sin: D_D, sinh: D_D, tan: D_D, tanh: D_D, atan2: DD_D, hypot: DD_D, pow: DD_D } satisfies Record<string, FunctionType>;
const HOST_IMPORTS = {
  ...MATH_IMPORTS,
  initSignatures: { params: [T.i32], results: [] },
  initSignaturesWait: { params: [T.i32], results: [] },
  catchBlock: { params: [T.i32, T.i32, T.i32, T.externref], results: [T.i32] },
  catchBlockWait: { params: [T.i32, T.i32, T.i32, T.externref], results: [T.i32] },
  catchSync: { params: [], results: [T.i32] },
  fmod: { params: [T.f64, T.f64], results: [T.f64] },
  gap: { params: [T.i32], results: [] },
  imtMiss: { params: [T.i32, T.i32], results: [T.i32] },
  heapCheck: { params: [], results: [T.i32] },
  excMessage: { params: [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], results: [T.externref] },
  capture: { params: [T.externref], results: [] },
  stFrames: { params: [T.externref], results: [T.i32] },
  stString: { params: [T.i32, T.i32], results: [T.externref] },
  stLine: { params: [T.i32], results: [T.i32] },
  info: { params: [T.i32, T.i32, T.i32], results: [T.i32] },
  stackClass: { params: [T.i32], results: [T.i32] },
  classByName: { params: [T.externref, T.externref, T.i32], results: [T.i32] },
  dexOpen: { params: [T.externref, T.externref], results: [T.externref] },
  dexOpenMemory: { params: [T.externref, T.externref, T.externref, T.externref, T.externref], results: [T.externref] },
  galloc: { params: [T.externref, T.i32], results: [T.i64] },
  gwrote: { params: [T.i32, T.i32], results: [] },
  gblock: { params: [T.i32], results: [T.i32] },
  hot: { params: [T.i32], results: [] },
  long: { params: [T.i32], results: [] },
  mhInvoke: { params: [T.externref, T.externref, T.externref, T.i32], results: [T.externref] },
  text: { params: [T.i32, T.i32], results: [T.externref] },
  net: { params: [T.i32, T.externref, T.i32, T.i32], results: [T.i32] },
  proxy: { params: [T.externref, T.externref, T.externref, T.externref, T.externref], results: [T.externref] },
  obj: { params: [T.i32, T.i32, T.i32, T.externref], results: [T.externref] },
  annotation: { params: [T.i32, T.i32, T.i32, T.externref], results: [T.externref] },
  annotationWait: { params: [], results: [T.externref] },
  watch: { params: [T.externref, T.externref], results: [] },
  claim: { params: [T.externref, T.i64], results: [] },
  intern: { params: [T.externref, T.externref], results: [T.externref] },
  sync: { params: [T.i32, T.externref, T.f64], results: [T.i32] },
  block: { params: [T.i32, T.externref, T.f64, T.i32], results: [T.i32] },
} satisfies Record<string, FunctionType>;
const HOST_IMPORT_NAMES = Object.keys(HOST_IMPORTS) as (keyof typeof HOST_IMPORTS)[];
/** each host import's function index: every module imports them first, in this order */
const HOST_IMPORT_INDEX = Object.fromEntries(HOST_IMPORT_NAMES.map((name, i) => [name, i])) as Record<keyof typeof HOST_IMPORTS, number>;
/** the host imports that can run Java code */
const RUNS_JAVA = new Set((["initSignatures", "initSignaturesWait", "mhInvoke", "proxy", "obj", "dexOpen", "dexOpenMemory", "classByName", "net", "sync", "block",
  "catchBlock", "catchBlockWait"] as const).map((name) => HOST_IMPORT_INDEX[name]));

/** the module-local functions of Compiler.local that are the same in every module */
const GENERIC_LOCALS = new Set(["count", "countLoop", "enter"]);
export class Compiler implements Base {
  w: World;
  mb = new ModuleBuilder();
  tVT!: number; tObj!: number; tStr!: number; tTagFn!: number; tData!: Record<ElemKind, number>; tArr!: Record<ElemKind, number>;
  tag: number;
  imp = HOST_IMPORT_INDEX;
  /** gaps this module's code ran into */
  gaps: string[] = [];
  /** methods this module defines, by id: calls between them are direct, every other call goes through the table (all of them do in a precompiled module,
   *  whose methods the second tier replaces one by one) */
  fn = new Map<string, number>();
  /** the names and descriptors of `fn`'s methods: a virtual call of any other can have no target in the module */
  private keys = new Set<string>();
  private direct = true;
  /** class modules this module imports from */
  deps = new Map<string, ClassRt>();
  /** CHA decisions this module's code relies on: decl, name, desc, the only target, the method that relies on it */
  assumptions: [string, string, string, MethodInfo | undefined, MethodInfo | undefined][] = [];
  /** the thrower of each link error this module's code raises at a site */
  linkErrors: string[] = [];
  /** classes whose absence this module's code fails a site on (linkage.ts), with the method that relies on it */
  absent: [string, MethodInfo | undefined][] = [];
  /** whether methods count their calls and loop iterations and ask the host to recompile them once they are hot (the first tier, see World.upgrade) */
  counting = true;
  /** the classes this module allocates */
  allocs = new Set<string>();
  /** the method being compiled */
  private owner?: MethodInfo;
  /** the installed method of the unit being compiled, which the CHA decisions of every method in it count against */
  private assumer?: MethodInfo;
  private codes = new Map<string, Code | null>();
  /** the frame weight of the methods of this unit that count no depth, with everything they call (a leaf, or a method that calls only such methods) */
  bound = new Map<string, number>();
  str: StructStrings;
  /** the production natives this module imports, by method id, and their import indices */
  nativeImports = new Map<string, number>();
  methodAnalyses = new Map<MethodInfo, { prepared: PreparedMethod; typing: Typing }>();
  symbolicTable?: number;
  symbolicImports = new Map<string, { slot: number; site: SymbolicSite }>();
  private memory = false;
  private guestMemory = false;
  private classStruct = new Map<string, number>();
  private sigType = new Map<string, number>();
  private globalImports = new Map<string, number>();
  private helpers = new Map<string, number>();
  /** the helpers a first-tier unit shares with others (shareHelpers): those it imports, and those it exports for later units */
  private sharing?: { imports: Map<string, number>; out: [string, FunctionType][] };
  private baseTypes: number;
  constructor(w: World) {
    this.w = w;
    const mb = this.mb;
    Object.assign(this, declareBase(mb));
    this.baseTypes = mb.types.length;
    this.classStruct.set("java/lang/Object", this.tObj);
    mb.importTable("rt", "table", T.funcref, 0);
    mb.importTable("rt", "nm", T.externref, 0);
    this.str = new StructStrings(this);
    this.classStruct.set("java/lang/String", this.tStr);
    this.tag = mb.importTag("rt", "tag", this.tTagFn);
    for (const name of HOST_IMPORT_NAMES) mb.importFunc("host", name, HOST_IMPORTS[name]);
    this.str.importBuiltins();
    this.fixedImports = mb.nImportedFuncs;
  }
  /** the imports every module has; of them only RUNS_JAVA can run Java code */
  private fixedImports: number;
  /** whether the body `c` can run Java code beyond itself: it calls through a table, an import that may, or a method of this unit */
  runsJava(c: Code): boolean {
    const methods = new Set(this.fn.values());
    return c.indirect > 0 || c.targets.some((f) => (f < this.mb.nImportedFuncs ? f >= this.fixedImports || RUNS_JAVA.has(f) : methods.has(f)));
  }
  get natives() { return this.w.natives; }
  intrinsic(m: MethodInfo): Intrinsic | undefined { return this.w.intrinsic(m); }
  /** the linear memory natives copy arrays through, and its allocation top */
  scratch(): number {
    if (!this.memory) { this.mb.importMemory("rt", "mem", 1); this.memory = true; }
    return this.global("rt", "sp", T.i32, true);
  }
  /** the native core's memory as this module's memory, for a runtime function that works on it (guest.ts) */
  guest(): void {
    if (this.guestMemory) return;
    if (this.memory) throw new Error("a module has one memory");
    if (!this.w.opts.guest) throw new Error("this World has no guest memory");
    const shared = this.w.guestShared;
    this.mb.importMemory("rt", "gmem", 1, shared ? 65535 : undefined, shared);
    this.memory = this.guestMemory = true;
  }
  /** a function of this module defined on first use under `key`; one that is the same in every module (of `type`) a sharing unit imports or exports */
  memo(key: string, make: () => number, type?: () => number): number {
    let f = this.helpers.get(key);
    if (f === undefined) this.helpers.set(key, f = type && this.sharing ? this.shared(key, type(), make) : make());
    return f;
  }
  /** Shares the helpers that are the same in every module with other first-tier units: each costs the engine about as much in every module as the
   *  unit's own code. A helper an earlier unit exports is imported (World.sharedHelpers); one none does is defined here and exported */
  shareHelpers(): void {
    const imports = new Map<string, number>();
    for (const [key, sig] of this.w.sharedHelpers) imports.set(key, this.mb.importFunc("h", key, sig));
    this.sharing = { imports, out: [] };
  }
  get sharedOut(): readonly [string, FunctionType][] { return this.sharing?.out ?? []; }
  private shared(key: string, type: number, make: () => number): number {
    const s = this.sharing!, imported = s.imports.get(key);
    if (imported !== undefined) return imported;
    const f = make(), { params, results } = this.mb.types[type].def as FunctionType;
    // a signature with a type of this module's own cannot be named by another
    if ([...params, ...results].every((t) => typeof t === "number" || t.ht < this.baseTypes)) { this.mb.export(key, "func", f); s.out.push([key, { params, results }]); }
    return f;
  }
  get prog(): Program { return this.w.prog; }

  // ---------- types
  vtOf(k: Kind): VT { return kindVT(k); }
  sig(params: Kind[], ret: Kind | "V"): number {
    const key = params.join("") + ">" + ret;
    let s = this.sigType.get(key);
    if (s === undefined) this.sigType.set(key, s = this.mb.addFuncType(params.map((k) => this.vtOf(k)), ret === "V" ? [] : [this.vtOf(ret)]));
    return s;
  }
  private descSigs = [new Map<string, number>(), new Map<string, number>()];
  /** the function type of a method with descriptor `desc`, with its receiver unless it is static */
  descSig(desc: string, isStatic: boolean): number {
    const memo = this.descSigs[+isStatic];
    let s = memo.get(desc);
    if (s === undefined) {
      const p = parseMethodDesc(desc), ps: Kind[] = isStatic ? [] : ["L"];
      for (const t of p.params) ps.push(kindOf(t));
      memo.set(desc, s = this.sig(ps, p.ret === "V" ? "V" : kindOf(p.ret)));
    }
    return s;
  }
  methodSig(m: MethodInfo): number { return this.descSig(m.desc, m.isStatic); }
  structFor(cls: string): number {
    let t = this.classStruct.get(cls); if (t !== undefined) return t;
    const c = this.prog.get(cls);
    if (!c || c.isInterface) { this.classStruct.set(cls, this.tObj); return this.tObj; }
    const sup = this.structFor(c.sup ?? "java/lang/Object");
    // a class with no own fields shares its super's struct type
    if (!c.fields.some(f => !f.isStatic)) { this.classStruct.set(cls, sup); return sup; }
    const fields = [{ t: ref(this.tVT) as VT, mut: false }, { t: T.i64 as VT, mut: true }, ...this.prog.layout(cls).map((f) => ({ t: this.vtOf(f.kind), mut: true }))];
    t = this.mb.addType({ k: "struct", fields, sup, final: false });
    this.classStruct.set(cls, t); return t;
  }
  /** struct field index of an instance field (header = 2 fields) */
  fieldIndex(cls: string, f: { owner: string; name: string; desc: string }): number {
    let idx = -1;
    this.prog.layout(cls).forEach((x, i) => { if (x.owner === f.owner && x.name === f.name && x.desc === f.desc) idx = i; });
    if (idx < 0) throw new Error(`field ${f.owner}.${f.name} not in layout of ${cls}`);
    return idx + 2;
  }

  // ---------- links to other modules
  classImports(): [module: string, name: string][] {
    return this.mb.imports.filter(im => im.kind === "global" && this.deps.has(im.mod)).map(im => [im.mod, im.name]);
  }
  global(mod: string, name: string, t: VT, mut: boolean): number {
    const key = mod + "." + name;
    let g = this.globalImports.get(key);
    if (g === undefined) this.globalImports.set(key, g = this.mb.importGlobal(mod, name, t, mut));
    return g;
  }
  private classGlobal(cls: string, name: string, t: VT): number {
    const rt = this.w.link(cls); this.deps.set(rt.mod, rt);
    return this.global(rt.mod, rt.id + ":" + name, t, true);
  }
  /** the immutable global holding String constant `s`, which the engine fills in at instantiation (WebAssembly.Module's importedStringConstants) */
  stringConst(s: string): number { return this.global("#", s, ref(HT.extern), false); }
  vtGlobal(cls: string): number { return this.classGlobal(cls, "vt", refNull(this.tVT)); }
  initGlobal(cls: string): number { return this.classGlobal(cls, "init", T.i32); }
  /** the global holding static field `name` of type `desc` of `owner`, which must declare it (a dex may declare one name with several types, so callers that know the type pass it) */
  staticGlobal(owner: string, name: string, desc?: string): number {
    const f = this.prog.get(owner)?.fields.find((x) => x.isStatic && x.name === name && (desc === undefined || x.desc === desc));
    if (!f) throw new Error(`static ${owner}.${name} not found`);
    return this.classGlobal(owner, "s:" + name + ":" + f.desc, this.vtOf(f.kind));
  }
  /** the frame weight of `m` and what it calls, if it is a direct call of this unit and counts no depth. A method is compiled before its first caller finishes
   *  its prologue; a method that is being compiled (a cycle) has no bound */
  boundOf(m: MethodInfo): number | undefined {
    if (!this.direct || !this.fn.has(mid(m))) return undefined;
    this.compiled(m);
    return this.bound.get(mid(m));
  }
  /** compiles `m` once, with the unit's state for it */
  compiled(m: MethodInfo): Code | undefined {
    const id = mid(m);
    if (this.codes.has(id)) return this.codes.get(id) ?? undefined;
    const owner = this.owner, assumer = this.assumer;
    this.codes.set(id, null);
    this.owner = m; this.assumer = this.direct ? this.head : m;
    const code = compileMethod(this, m);
    this.owner = owner; this.assumer = assumer;
    this.codes.set(id, code);
    return code;
  }
  private head?: MethodInfo;
  directFunc(m: MethodInfo): number | undefined { return this.direct ? this.fn.get(mid(m)) : undefined; }
  /** calls `m`: directly when this module defines it, else through its table slot (a lazy-link stub until it is compiled) */
  callMethod(c: Code, m: MethodInfo): void {
    const f = this.directFunc(m);
    if (f !== undefined) c.call(f); else c.i32(this.w.slotOf(m)).callIndirect(this.methodSig(m));
  }
  /** the only implementation of decl.name+desc among all loaded classes, or "many": none yet is a dispatch like any other, since a class made later (a proxy
   *  class, a dex) may implement it, even for a frame that is already running */
  devirt(decl: string, name: string, desc: string): MethodInfo | "many" {
    // Raw host helpers have no Java method owner; a target outside the module changes no code (callGuards), so no assumption is made for it
    if (!this.assumer || !this.direct || !this.keys.has(name + desc)) return "many";
    const t = this.w.cha.targets(decl, name, desc);
    if (t.length !== 1) return "many";
    // ART links no subclass of a final class and no override of a final method, so no later class can change these.
    const d = this.prog.get(decl);
    if (!d || d.isInterface || !(d.flags & ACC.FINAL || t[0].flags & ACC.FINAL && this.prog.isSubclass(decl, t[0].cls))) this.assumptions.push([decl, name, desc, t[0], this.assumer]);
    return t[0];
  }
  /** the likely implementations of a virtual call that this unit contains, for a guarded direct call (see World.likely) */
  guards(decl: string, name: string, desc: string): MethodInfo[] {
    return (this.w.plan.get(`${decl}.${name}${desc}`) ?? []).filter((m) => this.directFunc(m) !== undefined);
  }
  /** counts `m`'s calls and loop iterations in its word of the scratch memory and asks the host to upgrade the method when they reach the budget */
  emitCount(c: Code, m: MethodInfo, iterations?: number): void {
    const slot = this.w.slotOf(m);
    if (slot >= COUNT_SLOTS) return;
    this.scratch();
    // a call to this module's counter is a fraction of the sequence, which the engine compiles for every method a launch runs
    const count = (b: Code, add: (b: Code) => void, due: (b: Code, n: number) => void) => {
      const at = b.newLocal(T.i32), n = b.newLocal(T.i32);
      b.lget(0).i32(2).raw(OP.i32_shl).ltee(at).lget(at).mem(OP.i32_load, 2, COUNT_BASE); add(b); b.raw(OP.i32_add).ltee(n).mem(OP.i32_store, 2, COUNT_BASE);
      due(b, n); b.if_().lget(0).call(this.imp.hot).end();
    };
    c.i32(slot);
    if (iterations === undefined) {
      c.call(this.local("count", ["I"], "V", (b) => {
        b.i32(0).mem(OP.i32_load, 2, WARM_AT).if_().unreachable().end();
        count(b, (b) => b.i32(1), (b, n) => b.lget(n).i32(HOT_BUDGET).raw(OP.i32_eq));
      }));
      return;
    }
    // the budget is reached by this activation's iterations when the count crosses it
    c.lget(iterations).call(this.local("countLoop", ["I", "I"], "V", (b) => count(b, (b) => b.lget(1), (b, n) => {
      b.lget(n).lget(1).raw(OP.i32_sub).i32(HOT_BUDGET).raw(OP.i32_lt_u).lget(n).i32(HOT_BUDGET).raw(OP.i32_ge_u, OP.i32_and);
    })));
  }
  /** a method that calls something counts its frame (exc.ts MAX_DEPTH): `entry` takes the depth before it, which is restored on return and at a handler */
  emitEnter(c: Code, entry: number): number[] {
    const weight = c.i32Patched();
    c.call(this.local("enter", ["I"], "I", (b) => {
      const g = this.global("rt", "depth", T.i32, true), depth = b.newLocal(T.i32);
      b.gget(g).ltee(depth).i32(MAX_DEPTH).raw(OP.i32_ge_s).if_(); this.callThrower(b, "soe"); b.end();
      b.lget(depth).lget(0).raw(OP.i32_add).gset(g).lget(depth);
    })).lset(entry);
    return [weight];
  }
  /** sets the depth to what it was before the frame (`frame` false) or with the frame counted (the weight, patched in at the end of the method) */
  emitLeave(c: Code, entry: number, frame: boolean): number[] {
    c.lget(entry);
    const weight = frame ? [c.i32Patched()] : [];
    if (frame) c.raw(OP.i32_add);
    c.gset(this.global("rt", "depth", T.i32, true));
    return weight;
  }
  /** the fuel check of a loop head: every FUEL iterations of its activation (`count`, a local the method started at 0) the strand gives other strands and the
   *  event loop a turn (sched.ts). The count is a local because a global written on every iteration cost tight loops up to 2x */
  emitFuel(c: Code, count: number, tick?: () => void): void {
    c.lget(count).i32(1).raw(OP.i32_add).ltee(count).i32(FUEL - 1).raw(OP.i32_and).raw(OP.i32_eqz).if_(); this.callRt(c, "yieldNow"); tick?.(); c.end();
  }
  /** emit "ensure class initialized" at a use site, unless it cannot do anything: the class has nothing to run, is already initialized (it
   *  never goes back), is the compiled method's own class or a superclass (code of a class runs only once its initialization has begun), or is in `known`,
   *  the classes every path to here has already requested */
  emitEnsure(c: Code, cls: string, known?: Set<string>): void {
    if (known?.has(cls) || !this.w.needsInit(cls) || this.w.initialized(cls) || (this.owner && this.prog.chain(this.owner.cls).includes(cls))) return;
    c.gget(this.initGlobal(cls)).i32(INIT_DONE).raw(OP.i32_ne).if_().i32(this.w.ensureSlot(cls)).callIndirect(this.sig([], "V")).end();
  }
  idOf(name: string): number { return this.w.idOf(name); }
  /** calls the runtime function `name` (see rtfns.ts) with its arguments already pushed */
  callRt(c: Code, name: string): void {
    const d = rtfns.get(name)!;
    c.i32(this.w.synthSlot(name, d)).callIndirect(this.sig(d.params, d.ret));
    if (d.pure) c.indirect--;
  }
  /** host.info(kind, a, b): what the host knows about classes, see World.info */
  info(c: Code, kind: number, a: () => void, b: () => void = () => c.i32(0)): Code { c.i32(kind); a(); b(); return c.call(this.imp.info); }
  /** the global holding the table of Class objects */
  ctab(): number { return this.global("rt", "ctab", refNull(this.tData.ref), true); }
  gap(c: Code, what: string): void {
    this.gaps.push(what);
    c.i32(this.w.gapId(what)).call(this.imp.gap);
    this.callThrower(c, "ule");
  }
  /** the error ART raises where this site's class or member does not resolve, thrown when the site runs */
  linkError(c: Code, f: LinkFailure): void {
    this.linkErrors.push(f.thrower);
    if (f.absent) this.absent.push([f.absent, this.assumer]);
    c.i32(this.w.linkId(f.message));
    this.callThrower(c, f.thrower);
  }
  /** throws a new `cls` made by its constructor of no arguments, or of the String `message` */
  throwNew(c: Code, cls: string, message?: string): void {
    const local = c.newLocal(T.anyref);
    this.emitEnsure(c, cls); this.emitNew(c, cls); c.ltee(local);
    if (message !== undefined) this.str.literal(c, message);
    this.callMethod(c, this.prog.resolve(cls, "<init>", message === undefined ? "()V" : "(Ljava/lang/String;)V")!); c.lget(local).throw_(this.tag);
  }
  /** calls thrower `name` with its arguments already pushed; it never returns, which the code says so the engine sees a check's failing arm end */
  callThrower(c: Code, name: Thrower): void {
    // a function of this module that makes the indirect call keeps each failing arm a plain call, which the engine inlines and sizes more cheaply
    const params = THROWERS[name].params, f = this.memo("throw:" + name, () => {
      const fn = this.mb.reserveFunc(this.sig(params, "V"), "$throw_" + name), t = new Code(params.length);
      params.forEach((_, i) => t.lget(i));
      t.i32(SLOT[name]).callIndirect(this.sig(params, "V")).unreachable();
      this.mb.setBody(fn, t.finish());
      return fn;
    }, () => this.sig(params, "V"));
    c.call(f).unreachable();
  }

  // ---------- allocation
  private allocBytes(c: Code, add: () => void): void {
    const g = this.global("rt", "alloc", T.i32, true);
    c.gget(g); add(); c.raw(OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
  }
  /** a function of this module with the given body: a call is much shorter than the sequence, which keeps the callers small for the engine's inliner */
  private local(key: string, params: Kind[], ret: Kind | "V", body: (c: Code) => void, result?: VT): number {
    const type = () => result ? this.mb.addFuncType(params.map((k) => this.vtOf(k)), [result]) : this.sig(params, ret);
    return this.memo(key, () => {
      const f = this.mb.reserveFunc(type(), "$" + key), c = new Code(params.length);
      body(c);
      this.mb.setBody(f, c.finish());
      return f;
    }, GENERIC_LOCALS.has(key) ? type : undefined);
  }
  /** push a new zeroed instance of class `cls` (vt, hash 0, default fields) */
  emitNew(c: Code, cls: string): void {
    // a String is not an object with fields: ART's Unsafe.allocateInstance(String.class) is the empty string
    if (cls === "java/lang/String") { this.str.literal(c, ""); return; }
    this.w.allocated.add(cls); this.allocs.add(cls);
    c.call(this.local("new:" + cls, [], "L", (n) => {
      const lay = this.prog.layout(cls);
      this.allocBytes(n, () => n.i32(12 + lay.reduce((b, f) => b + (f.kind === "J" ? 8 : 4), 0)));
      n.gget(this.vtGlobal(cls)).refAsNonNull().i64(0n);
      for (const f of lay) { if (f.kind === "I") n.i32(0); else if (f.kind === "J") n.i64(0n); else n.anyNull(); }
      n.structNew(this.structFor(cls));
    }, ref(this.structFor(cls))));
  }
  /** push a new array of class `desc` whose length `pushLen` pushes; negative or oversized lengths throw */
  emitNewArray(c: Code, desc: string, pushLen: () => void): void {
    const ek = elemKindOf(desc), shift = { i8: 0, i16: 1, i32: 2, i64: 3, ref: 2 }[ek];
    pushLen();
    c.call(this.local("newarray:" + desc, ["I"], "L", (n) => {
      n.gget(this.vtGlobal(desc)).refAsNonNull().i64(0n).lget(0).i32(shift).call(this.helper("newLen")).arrayNewDefault(this.tData[ek]).structNew(this.tArr[ek]);
    }, ref(this.tArr[ek])));
  }
  /** a function of this module: is its (anyref) argument an instance of class, interface or array `name`? null is not */
  instanceOfFn(name: string): number {
    return this.local("instanceof:" + name, ["L"], "I", (c) => {
      const id = this.idOf(name);
      if (name === "java/lang/Object") { c.lget(0).refIsNull().raw(OP.i32_eqz); return; }
      if (name[0] === "[") {
        if (elemKindOf(name) === "ref") { c.lget(0).i32(id); this.callRt(c, "instArr"); } else c.lget(0).i32(id).i32(1).call(this.helper("iof"));
        return;
      }
      c.lget(0);
      if (this.prog.get(name)?.isInterface || this.prog.chain(name).length > H.MAXD) c.i32(id).call(this.helper("implements"));
      else c.i32(id).i32(this.prog.chain(name).length - 1).call(this.helper("iof"));
    });
  }
  /** a function of this module that returns its argument if it can be cast to `name` (null can) and throws ClassCastException otherwise */
  castFn(name: string): number {
    return this.local("cast:" + name, ["L"], "L", (c) => {
      c.lget(0).refIsNull().raw(OP.i32_eqz).if_().lget(0).call(this.instanceOfFn(name)).raw(OP.i32_eqz).if_();
      c.lget(0).call(this.helper("vtab")).i32(H.ID).arrayGet(this.tVT).i32(this.idOf(name)); this.callThrower(c, "cce");
      c.end().end().lget(0);
    });
  }

  // ---------- module-local helpers, defined on first use
  helper(name: string): number {
    const mb = this.mb, t = (p: VT[], r: VT[]) => mb.addFuncType(p, r);
    return this.memo(name, () => {
      const [sigIdx, body] = this.helperBody(name, t), f = mb.reserveFunc(sigIdx, "$" + name);
      // a helper may call itself
      this.helpers.set(name, f);
      mb.setBody(f, body());
      return f;
    }, () => this.helperBody(name, t)[0]);
  }
  private helperBody(name: string, t: (p: VT[], r: VT[]) => number): [number, () => number[]] {
    const { tVT, tObj } = this, vtR = refNull(tVT), L = T.anyref;
    const div = (wide: boolean, rem: boolean): [number, () => number[]] => {
      const W = wide ? T.i64 : T.i32;
      return [t([W, W], [W]), () => {
        const c = new Code(2);
        c.lget(1).raw(wide ? OP.i64_eqz : OP.i32_eqz).if_(); this.callThrower(c, "arith"); c.end();
        // x / -1 = -x and x % -1 = 0 without the INT_MIN trap
        c.lget(1); wide ? c.i64(-1n) : c.i32(-1); c.raw(wide ? OP.i64_eq : OP.i32_eq).if_(W);
        if (rem) wide ? c.i64(0n) : c.i32(0);
        else { wide ? c.i64(0n) : c.i32(0); c.lget(0).raw(wide ? OP.i64_sub : OP.i32_sub); }
        c.else_().lget(0).lget(1).raw(wide ? (rem ? OP.i64_rem_s : OP.i64_div_s) : (rem ? OP.i32_rem_s : OP.i32_div_s)).end();
        return c.finish();
      }];
    };
    const cmp = (W: number, lt: number, gt: number, eq: number, nanGreater: boolean): [number, () => number[]] => [t([W, W], [T.i32]), () => {
      const c = new Code(2);
      c.lget(0).lget(1).raw(eq).if_(T.i32).i32(0).else_();
      if (nanGreater) c.lget(0).lget(1).raw(lt).if_(T.i32).i32(-1).else_().i32(1).end();
      else c.lget(0).lget(1).raw(gt).if_(T.i32).i32(1).else_().i32(-1).end();
      return c.end().finish();
    }];
    switch (name) {
      case "idiv": return div(false, false);
      case "irem": return div(false, true);
      case "ldiv": return div(true, false);
      case "lrem": return div(true, true);
      case "cmplf": return cmp(T.f32, OP.f32_lt, OP.f32_gt, OP.f32_eq, false);
      case "cmpgf": return cmp(T.f32, OP.f32_lt, OP.f32_gt, OP.f32_eq, true);
      case "cmpld": return cmp(T.f64, OP.f64_lt, OP.f64_gt, OP.f64_eq, false);
      case "cmpgd": return cmp(T.f64, OP.f64_lt, OP.f64_gt, OP.f64_eq, true);
      // iof(obj, class id, depth): obj != null && vt[DEPTH] >= depth && vt[DISPLAY + depth] == id
      case "iof": return [t([L, T.i32, T.i32], [T.i32]), () => {
        const c = new Code(3), vt = c.newLocal(vtR);
        c.lget(0).refIsNull().if_().i32(0).ret().end();
        c.lget(0).call(this.helper("vtab")).lset(vt);
        c.lget(vt).refAsNonNull().i32(H.DEPTH).arrayGet(tVT).lget(2).raw(OP.i32_lt_s).if_().i32(0).ret().end();
        c.lget(vt).refAsNonNull().lget(2).i32(H.DISPLAY).raw(OP.i32_add).arrayGet(tVT).lget(1).raw(OP.i32_eq);
        return c.finish();
      }];
      // implements(obj, interface id): scan the interface ids after the slow-pair region (see World.vtWords)
      case "implements": return [t([L, T.i32], [T.i32]), () => {
        const c = new Code(2), vt = c.newLocal(vtR), p = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32);
        c.lget(0).refIsNull().if_().i32(0).ret().end();
        c.lget(0).call(this.helper("vtab")).lset(vt);
        c.lget(vt).refAsNonNull().i32(H.EXTRA).arrayGet(tVT).lset(p);
        c.lget(p).lget(vt).refAsNonNull().lget(p).arrayGet(tVT).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(2).raw(OP.i32_add).lset(p);
        c.lget(vt).refAsNonNull().lget(p).arrayGet(tVT).lset(n);
        c.lget(p).i32(1).raw(OP.i32_add).lset(p);
        c.block().loop();
        c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
        c.lget(vt).refAsNonNull().lget(p).lget(i).raw(OP.i32_add).arrayGet(tVT).lget(1).raw(OP.i32_eq).if_().i32(1).ret().end();
        c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(0);
        return c.finish();
      }];
      // imtslow(vt, selector): the slot of the implementation; scans the learned pairs, else asks the host and learns the answer
      case "imtslow": return [t([vtR, T.i32], [T.i32]), () => {
        const c = new Code(2), p = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), slot = c.newLocal(T.i32);
        c.lget(0).refAsNonNull().i32(H.EXTRA).arrayGet(tVT).lset(p);
        c.lget(0).refAsNonNull().lget(p).i32(1).raw(OP.i32_add).arrayGet(tVT).lset(n);
        c.block().loop();
        c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
        const at = (off: number) => c.lget(0).refAsNonNull().lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(off).raw(OP.i32_add);
        at(2).arrayGet(tVT).lget(1).raw(OP.i32_eq).if_().lget(0).refAsNonNull().lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(3).raw(OP.i32_add).arrayGet(tVT).ret().end();
        c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
        c.lget(0).refAsNonNull().i32(H.ID).arrayGet(tVT).lget(1).call(this.imp.imtMiss).lset(slot);
        // learn it while there is room (cap = vt[p], n = vt[p + 1])
        c.lget(n).lget(0).refAsNonNull().lget(p).arrayGet(tVT).raw(OP.i32_lt_s).if_();
        const put = (off: number, v: () => void) => { c.lget(0).refAsNonNull().lget(p).lget(n).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(off).raw(OP.i32_add); v(); c.arraySet(tVT); };
        put(2, () => c.lget(1)); put(3, () => c.lget(slot));
        c.lget(0).refAsNonNull().lget(p).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_add).arraySet(tVT).end();
        return c.lget(slot).finish();
      }];
      // aput:<element kind>(array, index, value): the store of an array element out of line, for code that runs once (method.ts emitAput)
      case "aput:i8": case "aput:i16": case "aput:i32": case "aput:i64": case "aput:ref": {
        const k = name.slice(5) as ElemKind;
        return [t([L, T.i32, k === "ref" ? L : k === "i64" ? T.i64 : T.i32], []), () => {
          const c = new Code(3), data = c.newLocal(ref(this.tData[k]));
          c.lget(0).refCast(this.tArr[k]).structGet(this.tArr[k], 2).lset(data);
          c.lget(1).lget(data).arrayLen().raw(OP.i32_ge_u).if_().lget(1).lget(data).arrayLen(); this.callThrower(c, "aioobe"); c.end();
          if (k === "ref") emitStoreCheck(this, c, 0, () => c.lget(2));
          return c.lget(data).lget(1).lget(2).arraySet(this.tData[k]).finish();
        }];
      }
      // the header word: the monitor (thin lock owner and count, or an inflated monitor's index) in its low half, the identity hash in its high half
      case "hash": return [t([L], [T.i32]), () => {
        const c = new Code(1), w = c.newLocal(T.i64), hv = c.newLocal(T.i32), g = this.global("rt", "hash", T.i32, true);
        c.lget(0).refTest(tObj).raw(OP.i32_eqz).if_().lget(0).call(this.helper("shash")).ret().end();
        c.lget(0).refCast(tObj).structGet(tObj, 1).ltee(w).i64(32n).raw(OP.i64_shr_u, OP.i32_wrap_i64).ltee(hv).raw(OP.i32_eqz).if_()
          .gget(g).i32(0x3c6ef372 | 0).raw(OP.i32_add).ltee(hv).gset(g)
          .lget(0).refCast(tObj).lget(w).lget(hv).raw(OP.i64_extend_i32_u).i64(32n).raw(OP.i64_shl, OP.i64_or).structSet(tObj, 1).end();
        return c.lget(hv).finish();
      }];
      // menter(obj), mexit(obj): the thin lock in the header word's low half (monitor.ts): the owning strand's id << 8 | count. `lock ^ id << 8` is the count when the
      // strand holds the lock, so one unsigned compare tells that from free, another strand's and inflated (negative); anything but those cases is the host's
      case "menter": case "mexit": {
        const enter = name === "menter";
        return [t([L], []), () => {
          const c = new Code(1), o = c.newLocal(ref(tObj)), w = c.newLocal(T.i64), l = c.newLocal(T.i32), s8 = c.newLocal(T.i32);
          c.gget(this.global("rt", "sid", T.i32, true)).i32(8).raw(OP.i32_shl).lset(s8);
          c.lget(0).refCast(tObj).ltee(o).structGet(tObj, 1).ltee(w).raw(OP.i32_wrap_i64).lset(l);
          const store = (v: () => void) => { c.lget(o).lget(w); v(); c.raw(enter ? OP.i64_add : OP.i64_sub).structSet(tObj, 1); };
          if (enter) {
            c.lget(l).raw(OP.i32_eqz).if_();
            store(() => c.lget(s8).i32(1).raw(OP.i32_or, OP.i64_extend_i32_u));
            c.ret().end();
            c.lget(l).lget(s8).raw(OP.i32_xor).i32(255).raw(OP.i32_lt_u).if_();
            store(() => c.i64(1n));
            c.ret().end();
          } else {
            c.lget(l).lget(s8).raw(OP.i32_xor).lset(s8);
            c.lget(s8).i32(256).raw(OP.i32_lt_u).if_();
            store(() => c.lget(l).raw(OP.i64_extend_i32_u).i64(1n).lget(s8).i32(1).raw(OP.i32_eq).select());
            c.ret().end();
          }
          c.lget(0); this.callRt(c, enter ? "menterSlow" : "mexitSlow");
          return c.finish();
        }];
      }
      // newLen(len, shift): the length itself once it is a legal array length and the allocation fits the budget
      case "newLen": return [t([T.i32, T.i32], [T.i32]), () => {
        const c = new Code(2), bytes = c.newLocal(T.i64), g = this.global("rt", "alloc", T.i32, true);
        c.lget(0).i32(0).raw(OP.i32_lt_s).if_().lget(0); this.callThrower(c, "nase"); c.end();
        c.lget(0).raw(OP.i64_extend_i32_u).lget(1).raw(OP.i64_extend_i32_u, OP.i64_shl).lset(bytes);
        c.lget(bytes).i64(BigInt(HEAP_LIMIT)).raw(OP.i64_gt_u).if_().lget(bytes); this.callThrower(c, "oom"); c.end();
        c.gget(g).lget(bytes).raw(OP.i32_wrap_i64, OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
        return c.lget(0).finish();
      }];
      // allocSlow(): the allocation window is used up; the host decides whether the heap really is full. Garbage that only a finalizer frees (a native handle
      // its owner holds) counts until the event loop has run the finalizers, so a full heap gets two turns of the loop, each with a collection, before it is an error
      case "allocSlow": return [t([], []), () => {
        const c = new Code(0), g = this.global("rt", "alloc", T.i32, true);
        c.i32(-ALLOC_WINDOW).gset(g);
        for (let turn = 0; turn < 2; turn++) {
          c.call(this.imp.heapCheck).if_();
          emitSync(this, c, Sync.CanSuspend); c.if_();
          emitBlock(this, c, Block.Yield, null, null, () => c.i32(1)); c.drop().end();
        }
        c.call(this.imp.heapCheck).if_().i64(BigInt(ALLOC_WINDOW)); this.callThrower(c, "oom"); c.end();
        c.end().end();
        return c.finish();
      }];
    }
    const s = this.str.helper(name, t);
    if (s) return s;
    throw new Error("unknown helper " + name);
  }

  // ---------- units
  /** compile `methods` into this module (the first is the one a lazy-link stub asks for); each is exported as "m<slot>". `copies` are compiled
   *  beside them for the unit's own calls and not exported; what they assume about the class hierarchy counts against `methods[0]`. A `hot`
   *  unit is the second tier: its methods do not count. With `install` the methods go straight into their table slots when the module is
   *  instantiated, and call each other through them, as precompiled code (true, aot.ts) or code merged from first-tier units ("merge"), which
   *  unlike precompiled code relies on the classes loaded now. `ensures`: classes whose ensure() the unit also defines, exported as the methods
   *  are (World.ensureBody) */
  buildUnit(methods: MethodInfo[], copies: MethodInfo[] = [], hot = false, install: boolean | "merge" = false, ensures: string[] = []): { bytes: Uint8Array; traces: FnTrace[] } {
    const { mb, w } = this, all = methods.concat(copies);
    this.counting = !hot;
    this.natives.declare(this, all);
    declareSymbolicSites(this, all);
    // the second tier's names differ from the first's, and a copy's from the installed method's, so a stack frame finds its own offsets (traces are keyed by name)
    const label = (m: MethodInfo, i: number) => (hot || install === "merge" || i >= methods.length ? `${mid(m)}#${w.stats.units}` : mid(m));
    all.forEach((m, i) => { this.fn.set(mid(m), mb.reserveFunc(this.methodSig(m), label(m, i))); this.keys.add(m.key); });
    const { phase } = w.stats, t0 = performance.now(), analysed = phase.prepare + phase.flow + phase.infer + phase.facts;
    this.direct = !install; this.head = methods[0];
    const codes = all.map((m) => this.compiled(m)!);
    phase.emit += performance.now() - t0 - (phase.prepare + phase.flow + phase.infer + phase.facts - analysed);
    const at: [number, number][] = [];
    all.forEach((m, i) => {
      const f = this.fn.get(mid(m))!; mb.setBody(f, codes[i].finish());
      if (i >= methods.length) return;
      if (install) at.push([w.slotOf(m), f]); else mb.export("m" + w.slotOf(m), "func", f);
    });
    // consecutive slots are one segment
    at.sort((a, b) => a[0] - b[0]);
    for (let i = 0, j = 0; i < at.length; i = j) {
      while (++j < at.length && at[j][0] === at[j - 1][0] + 1);
      mb.addElemActive(0, at[i][0], at.slice(i, j).map((x) => x[1]));
    }
    const inits = ensures.map((cls) => {
      const name = "$ensure:" + cls, f = mb.reserveFunc(this.sig([], "V"), name), code = new Code(0);
      w.ensureBody(this, cls, code);
      mb.setBody(f, code.finish()); mb.export("m" + w.ensureSlot(cls), "func", f);
      return { name, f, code };
    });
    return this.finishModule([...all.map((m, i) => ({ name: label(m, i), f: this.fn.get(mid(m))!, code: codes[i], m })), ...inits]);
  }
  buildSyntheticGroup(bodies: { name: string; params: Kind[]; ret: Kind | "V"; body: (c: Code) => void }[]) {
    const parts = bodies.map(body => ({ ...body, f: this.mb.reserveFunc(this.sig(body.params, body.ret), "$" + body.name), code: new Code(body.params.length) }));
    for (const part of parts) { part.body(part.code); this.mb.setBody(part.f, part.code.finish()); this.mb.export(part.name, "func", part.f); }
    return this.finishModule(parts.map(part => ({ name: "$" + part.name, f: part.f, code: part.code })));
  }
  /** a body made of generated code (the implicit-exception throwers, field readers); `ret` is its result kind */
  buildSynthetic(name: string, params: Kind[], body: (c: Code) => void, ret: Kind | "V" = "V"): { bytes: Uint8Array; traces: FnTrace[] } {
    const f = this.mb.reserveFunc(this.sig(params, ret), "$" + name), c = new Code(params.length);
    body(c);
    this.mb.setBody(f, c.finish());
    this.mb.export("m", "func", f);
    return this.finishModule([{ name: "$" + name, f, code: c }]);
  }
  /** one module of several synthetic functions, each put in its table slot when the module is instantiated (a build's, link/apps.ts). A function whose code relies on a class-hierarchy
   *  decision or on a class being absent is left out: nothing here could undo it. */
  buildSynthetics(fns: { name: string; slot: number; d: Synth }[]): { bytes: Uint8Array; traces: FnTrace[]; kept: string[] } {
    const mb = this.mb, parts: { name: string; slot: number; f: number; code: Code }[] = [];
    for (const { name, slot, d } of fns) {
      const f = mb.reserveFunc(this.sig(d.params, d.ret), "$" + name), code = new Code(d.params.length), assumed = this.assumptions.length, absent = this.absent.length;
      d.body(this, code);
      mb.setBody(f, code.finish());
      if (this.assumptions.length !== assumed || this.absent.length !== absent) { this.assumptions.length = assumed; this.absent.length = absent; continue; }
      parts.push({ name, slot, f, code });
    }
    parts.sort((a, b) => a.slot - b.slot);
    for (let i = 0, j = 0; i < parts.length; i = j) {
      while (++j < parts.length && parts[j].slot === parts[j - 1].slot + 1);
      mb.addElemActive(0, parts[i].slot, parts.slice(i, j).map((p) => p.f));
    }
    return { ...this.finishModule(parts.map((p) => ({ name: "$" + p.name, f: p.f, code: p.code }))), kept: parts.map((p) => p.name) };
  }
  outlines: { name: string; f: number; code: Code; m?: MethodInfo }[] = [];
  private finishing: (() => void)[] = [];
  /** `f` runs once the module's code is complete, before it is encoded */
  atFinish(f: () => void): void { this.finishing.push(f); }
  private finishModule(fns: { name: string; f: number; code: Code; m?: MethodInfo }[]): { bytes: Uint8Array; traces: FnTrace[] } {
    const roots = fns.length;
    fns = fns.concat(this.outlines);
    for (const f of this.finishing.splice(0)) f();
    // V8 13.6 gives a module without a start function a quarter of the inlining budget, which halves a recursive method's speed (fib(32): 9.7 ms
    // against 5.4 ms); an empty start function restores it
    this.mb.start = this.mb.addFunc(this.mb.addFuncType([], []), new Code(0).finish(), "$start");
    const t0 = performance.now(), bytes = this.mb.build(true);
    this.w.stats.phase.encode += performance.now() - t0;
    const traces = fns.map(({ name, f, code, m }) => {
      const start = this.mb.bodyOffsets[f - this.mb.nImportedFuncs] + code.prefixLen;
      return { name, m, offsets: Int32Array.from({ length: code.marks.length / 2 }, (_, i) => start + code.marks[2 * i]), pcs: Int32Array.from({ length: code.marks.length / 2 }, (_, i) => code.marks[2 * i + 1]) };
    });
    // AOT traces are keyed by Java slot. Chunk offsets join their owner's trace without changing that format.
    for (let i = 0; i < roots; i++) {
      const root = traces[i], parts = traces.slice(roots).filter((t) => t.name.startsWith(root.name + "#loop"));
      if (!parts.length) continue;
      const pairs: [number, number][] = [];
      for (const t of [root, ...parts]) for (let k = 0; k < t.offsets.length; k++) pairs.push([t.offsets[k], t.pcs[k]]);
      pairs.sort((a, b) => a[0] - b[0]);
      root.offsets = Int32Array.from(pairs, (p) => p[0]); root.pcs = Int32Array.from(pairs, (p) => p[1]);
    }
    return { bytes, traces: traces.slice(0, roots) };
  }
}

/** the side table that maps a Wasm frame offset of one function back to a DEX pc: offsets ascend, pcs[i] belongs to offsets[i] */
export interface FnTrace { name: string; m?: MethodInfo; offsets: Int32Array; pcs: Int32Array }
