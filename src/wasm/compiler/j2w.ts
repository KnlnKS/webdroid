// One Compiler builds one Wasm module (a unit of methods, or a synthetic body) against a World; see link/world.ts for the linker.
import { parseMethodDesc } from "../../jvm/abi.ts";
import { HT, ModuleBuilder, T, ref, refNull, type VT, type FunctionType } from "./wasmbin.ts";
import { Code, OP, type InlineFrame } from "./code.ts";
import { kindOf, methodKinds, mid, type FieldInfo, type Program, type Kind, type MethodInfo } from "./program.ts";
import { H, ELEM, MATH_ARITY, elemKindOf, FUEL, INIT_DONE, MAX_DEPTH, HOT_BUDGET, COUNT_BASE, COUNT_SLOTS, SAMPLE_EVERY, WARM_AT, type ElemKind } from "./consts.ts";
import { declareSymbolicSites, siteKey, type SymbolicSite } from "./sites.ts";
import { prepareMethod, type PreparedMethod } from "../../jvm/prepared.ts";
import { inferTyping, type Typing } from "./infer.ts";
import { compileMethod } from "./method.ts";
import type { ClassRt, World } from "../link/world.ts";
import { rtfns, type RtName } from "./rtfns.ts";
import { finalDispatch, type LinkFailure } from "./linkage.ts";
import { SLOT, THROWERS, type Thrower } from "./exc.ts";
import { STRING, StructStrings, stringSites } from "./strings.ts";
import { helpers as HELPERS, type HelperName } from "./helpers.ts";
import type { NativeBinder } from "../link/hostapi.ts";

export interface Intrinsic { (cx: Compiler, m: MethodInfo, c: Code): void }
/** a String constructor is never called: each call site makes the String with its factory (Compiler.construct) */
const stringCtor: Intrinsic = (_cx, _m, c) => { c.unreachable(); };
/** how `m` is implemented without its bytecode: an intrinsic, a String constructor (a call site makes the string), or a host import */
export function intrinsicFor(intrinsics: Map<string, Intrinsic>, natives: NativeBinder, m: MethodInfo): Intrinsic | undefined {
  return intrinsics.get(mid(m)) ?? (m.isCtor && m.cls === STRING ? stringCtor : natives.stub(m));
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
  // a String when it is a struct (strings.ts): the Object header, the chars, the cached hash code and the JS string the host has seen
  const tStr = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i64, mut: true }, { t: ref(tData.i16), mut: false }, { t: T.i32, mut: true }, { t: T.externref, mut: true }], sup: tObj, final: true });
  return { tVT, tObj, tStr, tData, tArr, tTagFn: mb.addFuncType([T.anyref], []) };
}
/** every reference slot is an anyref: a Java object is a struct subtype of $Obj, a String the JS string behind any.convert_extern (strings.ts) */
export const kindVT = (k: Kind): VT => (k === "I" ? T.i32 : k === "J" ? T.i64 : T.anyref);

export const MATH_IMPORTS = Object.fromEntries(Object.entries(MATH_ARITY).map(([f, n]): [string, FunctionType] => [f, { params: Array(n).fill(T.f64), results: [T.f64] }])) as Record<keyof typeof MATH_ARITY, FunctionType>;
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
  stFrames: { params: [T.externref], results: [T.externref] },
  stString: { params: [T.externref, T.i32, T.i32], results: [T.externref] },
  stLine: { params: [T.externref, T.i32], results: [T.i32] },
  len: { params: [T.externref], results: [T.i32] },
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
  text: { params: [T.i32, T.i32, T.i32], results: [T.externref] },
  net: { params: [T.externref, T.i32, T.i32], results: [T.externref] },
  netByte: { params: [T.externref, T.i32, T.i32], results: [T.i32] },
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
/** what compiled code imports as "host" (link/hostimports.ts) */
export type HostImport = keyof typeof HOST_IMPORTS;
const HOST_IMPORT_NAMES = Object.keys(HOST_IMPORTS) as HostImport[];
/** each host import's function index: every module imports them first, in this order */
const HOST_IMPORT_INDEX = Object.fromEntries(HOST_IMPORT_NAMES.map((name, i) => [name, i])) as Record<HostImport, number>;
/** the host imports that can run Java code */
const RUNS_JAVA = new Set((["initSignatures", "initSignaturesWait", "mhInvoke", "proxy", "obj", "dexOpen", "dexOpenMemory", "classByName", "net", "sync", "block",
  "catchBlock", "catchBlockWait"] as const).map((name) => HOST_IMPORT_INDEX[name]));

/** how many methods a Compiler compiles inside one another's compile, at most, to bound a callee's frame (boundOf) */
const MAX_NESTING = 64;
/** what a frozen numbering (Numbers.frozen) would have had to number, and the method whose compile asked for it (the innermost, when compiling it compiled others) */
export class NeedsNumber extends Error { method?: MethodInfo }
/** the linker state a Compiler reads and records into */
export type LinkEnv = Pick<World, "prog" | "natives" | "intrinsic" | "link" | "claims" | "allocated" | "longLoops" | "idOf" | "slotOf" | "selectorId" | "ensureSlot"
  | "synthSlot" | "gapId" | "linkId" | "needsInit" | "initialized" | "needsSymbolicSite" | "guestShared"> & {
  opts: Pick<World["opts"], "build" | "guest" | "intrinsics">; hosts: Pick<World["hosts"], "mayReach" | "takes">;
  stats: Pick<World["stats"], "phase">; cha: Pick<World["cha"], "targets">; dispatch: Pick<World["dispatch"], "vslot">;
  classModules: Pick<World["classModules"], "ensureBody">; units: Pick<World["units"], "sharedHelpers">;
};
/** what compiling a method reads of its code (Compiler.analysis) */
export interface Analysis { prepared: PreparedMethod; typing: Typing; strings: ReadonlyMap<number, "alloc" | "init"> }
/** per call site (caller and DEX pc): the implementations worth a guarded direct call (Planner.group) */
export type CallPlan = ReadonlyMap<string, readonly MethodInfo[]>;
/** a function of Compiler.buildSynthetics */
export interface SyntheticFn { name: string; params: Kind[]; ret: Kind | "V"; body: (c: Code) => void; slot?: number; exportAs?: string }
/** how Compiler.buildUnit compiles its methods */
export interface UnitOptions {
  /** compiled beside the methods for the unit's own calls and not exported; what they assume about the class hierarchy counts against the first method */
  copies?: MethodInfo[];
  /** the second tier: its methods do not count */
  hot?: boolean;
  /** the methods go straight into their table slots when the module is instantiated, as precompiled code ("build", aot.ts), which calls the methods it
   *  defines directly (Compiler.directFunc), or code merged from first-tier units ("merge"), which calls them through the slots and unlike
   *  precompiled code relies on the classes loaded now */
  install?: "build" | "merge";
  /** classes whose ensure() the unit also defines, exported as the methods are (World.ensureBody) */
  ensures?: string[];
  plan?: CallPlan;
}
const NO_PLAN: CallPlan = new Map();
export class Compiler implements Base {
  w: LinkEnv;
  mb = new ModuleBuilder();
  tVT!: number; tObj!: number; tStr!: number; tTagFn!: number; tData!: Record<ElemKind, number>; tArr!: Record<ElemKind, number>;
  tag: number;
  imp = HOST_IMPORT_INDEX;
  /** gaps this module's code ran into */
  gaps: string[] = [];
  /** methods this module defines, by id: calls between them may be direct (directFunc), every other call goes through the table */
  fn = new Map<string, number>();
  /** the names and descriptors of `fn`'s methods: a virtual call of any other can have no target in the module */
  private keys = new Set<string>();
  /** how the unit's methods are installed (UnitOptions.install); a first-tier or hot unit installs only its head */
  private install?: "build" | "merge";
  /** the slots of the methods whose code holds another method's, by its slot (dependsOn) */
  private holders = new Map<number, Set<number>>();
  /** `holders` as a unit header carries them: a method's slot, then its holders' */
  get held(): number[][] { return [...this.holders].map(([callee, by]) => [callee, ...by]); }
  private plan = NO_PLAN;
  /** class modules this module imports from */
  deps = new Map<string, ClassRt>();
  /** CHA decisions this module's code relies on: decl, name, desc, the only target, the method that relies on it */
  assumptions: [string, string, string, MethodInfo | undefined, MethodInfo | undefined][] = [];
  /** the thrower of each link error this module's code raises at a site */
  linkErrors: string[] = [];
  /** classes whose absence this module's code fails a site on (linkage.ts), with the method that relies on it */
  absent: [string, MethodInfo | undefined][] = [];
  /** whether methods count their calls and loop iterations and ask the host to recompile them once they are hot (the first tier, see Tiering.upgrade) */
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
  private analyses = new Map<MethodInfo, Analysis>();
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
  /** the number of the unit this Compiler builds: its functions' names carry it, apart from other units of the same methods (buildUnit) */
  private readonly seq: number;
  constructor(w: LinkEnv, seq = 0) {
    this.w = w; this.seq = seq;
    const mb = this.mb;
    Object.assign(this, declareBase(mb));
    this.baseTypes = mb.types.length;
    this.classStruct.set("java/lang/Object", this.tObj);
    this.globalImports.set("rt.callee", mb.importGlobal("rt", "callee", T.i32, true));
    mb.importTable("rt", "table", T.funcref, 0);
    mb.importTable("rt", "nm", T.externref, 0);
    this.str = new StructStrings(this);
    this.classStruct.set(STRING, this.tStr);
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
  /** a function of this module named "$" + `key`, defined on first use; a `shared` one is the same in every module. A call is much shorter than the sequence,
   *  which keeps the callers small for the engine's inliner */
  defineFn(key: string, params: readonly VT[], results: readonly VT[], body: (c: Code) => void, shared = false): number {
    const type = () => this.mb.addFuncType(params, results);
    return this.memo(key, () => {
      const f = this.mb.reserveFunc(type(), "$" + key), c = new Code(params.length);
      // a helper may call itself
      this.helpers.set(key, f);
      body(c);
      this.mb.setBody(f, c.finish());
      return f;
    }, shared ? type : undefined);
  }
  /** a function of this module defined on first use under `key`; one that is the same in every module (of `type`) a sharing unit imports or exports */
  memo(key: string, make: () => number, type?: () => number): number {
    let f = this.helpers.get(key);
    if (f === undefined) this.helpers.set(key, f = type && this.sharing ? this.shared(key, type(), make) : make());
    return f;
  }
  /** Shares the helpers that are the same in every module with other first-tier units: each costs the engine about as much in every module as the
   *  unit's own code. A helper an earlier unit exports is imported (Units.sharedHelpers); one none does is defined here and exported */
  shareHelpers(): void {
    const imports = new Map<string, number>();
    for (const [key, sig] of this.w.units.sharedHelpers) imports.set(key, this.mb.importFunc("h", key, sig));
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
    // a deep chain of first calls is left to count its frames, not to the compiler's stack
    if (this.directFunc(m) === undefined || this.nesting > MAX_NESTING) return undefined;
    this.compiled(m);
    return this.bound.get(mid(m));
  }
  /** compiles `m` once, with the unit's state for it */
  compiled(m: MethodInfo): Code | undefined {
    const id = mid(m);
    if (this.codes.has(id)) return this.codes.get(id) ?? undefined;
    const owner = this.owner, assumer = this.assumer;
    this.codes.set(id, null);
    this.owner = m; this.assumer = this.install ? m : this.head; this.nesting++;
    let code: Code | undefined;
    try { code = compileMethod(this, m); }
    catch (e) { if (e instanceof NeedsNumber) e.method ??= m; throw e; }
    finally { this.owner = owner; this.assumer = assumer; this.nesting--; }
    this.codes.set(id, code);
    return code;
  }
  private head?: MethodInfo;
  private nesting = 0;
  /** the function of `m` that a call of it from the method being compiled may call directly: one of this module's, except in merged code, and in precompiled
   *  code one the host has not taken (mayHold), whose code the caller then holds (Assumptions.undoCode undoes the caller with it) */
  directFunc(m: MethodInfo): number | undefined {
    const f = this.fn.get(mid(m));
    if (f === undefined || !this.install) return f;
    return this.install === "build" && this.mayHold(m) ? f : undefined;
  }
  /** whether the Java method being compiled may hold code of `m`'s, which must be the method's own and not one the host may take: a World without a build knows
   *  none of them, and code without a Java method (a symbolic site, a synthetic body) has no slot to undo with `m` (dependsOn) */
  private mayHold(m: MethodInfo): boolean {
    return !!this.owner && !this.w.hosts.takes(m);
  }
  /** the method being compiled holds code of `m`'s, a direct call or its body run in place (inline.ts): undoing `m`'s code undoes the installed method it
   *  counts against (Assumptions.undoCode) */
  dependsOn(m: MethodInfo): void {
    const by = this.assumer;
    if (!by || m === by) return;
    const callee = this.w.slotOf(m);
    (this.holders.get(callee) ?? this.holders.set(callee, new Set()).get(callee)!).add(this.w.slotOf(by));
  }
  /** calls `m`: directly when this module defines it, else through its table slot (a lazy-link stub until it is compiled) */
  callMethod(c: Code, m: MethodInfo): void {
    const f = this.directFunc(m);
    if (f === undefined) { c.i32(this.w.slotOf(m)).callIndirect(this.methodSig(m)); return; }
    c.call(f);
    if (this.install) this.dependsOn(m);
  }
  /** whether a call of `m` may run its bytecode in place (inline.ts): the code is the method's, not an intrinsic's or the host's */
  inlines(m: MethodInfo): boolean { return !this.w.intrinsic(m) && this.mayHold(m); }
  /** the only implementation of decl.name+desc among all loaded classes, or "many": none yet is a dispatch like any other, since a class made later (a proxy
   *  class, a dex) may implement it, even for a frame that is already running */
  devirt(decl: string, name: string, desc: string): MethodInfo | "many" {
    // Raw host helpers have no Java method owner; a target outside the module changes no code (callGuards), so no assumption is made for it
    if (!this.assumer || this.install || !this.keys.has(name + desc)) return "many";
    const t = this.w.cha.targets(decl, name, desc);
    if (t.length !== 1) return "many";
    // no later class can change a final dispatch
    if (!finalDispatch(this.prog, decl, t[0])) this.assumptions.push([decl, name, desc, t[0], this.assumer]);
    return t[0];
  }
  /** the likely implementations of a virtual call that this unit contains, for a guarded direct call (see Planner.group) */
  guards(m: MethodInfo, ins: { pc: number }): MethodInfo[] {
    return (this.plan.get(siteKey(m, ins)) ?? []).filter((t) => this.directFunc(t) !== undefined);
  }
  /** counts an entry of `m` in its word of the scratch memory and asks the host to upgrade the method when the count reaches the budget; sets the local
   *  `sampled`, if given, when this activation records its call targets (profile.ts) */
  emitCount(c: Code, m: MethodInfo, sampled = -1): void {
    if (!this.pushCounter(c, m)) return;
    const count = (b: Code) => this.count(b, (b) => b.i32(1), (b, n) => b.lget(n).i32(HOT_BUDGET).raw(OP.i32_eq));
    if (sampled < 0) c.call(this.defineFn("count", [T.i32], [], count, true));
    else c.call(this.defineFn("countSampled", [T.i32], [T.i32], (b) => b.lget(count(b)).i32(SAMPLE_EVERY - 1).raw(OP.i32_and).i32(1).raw(OP.i32_eq), true)).lset(sampled);
  }
  /** emits `body`, a counted method's, in a block that an activation leaves at once, with its result zero, while the scratch memory's warm word is set:
   *  the shim's Worker compiles code that way (warmshim.ts) and the burner runs it to have the engine optimize it with its feedback (burn.ts). Leaving
   *  through the block's end has the engine charge the activation the whole function's size toward its upgrade */
  emitWarmExit(c: Code, m: MethodInfo, body: () => void): void {
    if (!this.counting || this.w.slotOf(m) >= COUNT_SLOTS) { body(); return; }
    this.scratch();
    const { ret } = methodKinds(m);
    c.block(ret === "V" ? null : kindVT(ret)).i32(0).mem(OP.i32_load, 2, WARM_AT).if_();
    if (ret !== "V") c.zero(ret);
    c.br(1).end();
    body();
    c.end();
  }
  /** counts a deferred loop's `iterations` toward `m`'s budget, which they reach when the count crosses it */
  emitLoopCount(c: Code, m: MethodInfo, iterations: number): void {
    if (!this.pushCounter(c, m)) return;
    c.lget(iterations).call(this.defineFn("countLoop", [T.i32, T.i32], [], (b) => this.count(b, (b) => b.lget(1), (b, n) => {
      b.lget(n).lget(1).raw(OP.i32_sub).i32(HOT_BUDGET).raw(OP.i32_lt_u).lget(n).i32(HOT_BUDGET).raw(OP.i32_ge_u, OP.i32_and);
    }), true));
  }
  /** pushes `m`'s counter, if it has one */
  private pushCounter(c: Code, m: MethodInfo): boolean {
    const slot = this.w.slotOf(m);
    if (slot >= COUNT_SLOTS) return false;
    this.scratch();
    c.i32(slot);
    return true;
  }
  /** the body of a counter helper, returning the local of the new count: a call to it is a fraction of the sequence, which the engine compiles for every
   *  method a launch runs */
  private count(b: Code, add: (b: Code) => void, due: (b: Code, n: number) => void): number {
    const at = b.newLocal(T.i32), n = b.newLocal(T.i32);
    b.lget(0).i32(2).raw(OP.i32_shl).ltee(at).lget(at).mem(OP.i32_load, 2, COUNT_BASE); add(b); b.raw(OP.i32_add).ltee(n).mem(OP.i32_store, 2, COUNT_BASE);
    due(b, n); b.if_().lget(0).call(this.imp.hot).end();
    return n;
  }
  /** a method that calls something counts its frame (exc.ts MAX_DEPTH): `entry` takes the depth before it, which is restored on return and at a handler */
  emitEnter(c: Code, entry: number): number[] {
    const weight = c.i32Patched();
    c.call(this.defineFn("enter", [T.i32], [T.i32], (b) => {
      const g = this.global("rt", "depth", T.i32, true), depth = b.newLocal(T.i32);
      b.gget(g).ltee(depth).i32(MAX_DEPTH).raw(OP.i32_ge_s).if_(); this.callThrower(b, "soe"); b.end();
      b.lget(depth).lget(0).raw(OP.i32_add).gset(g).lget(depth);
    }, true)).lset(entry);
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
  callRt(c: Code, name: RtName): void {
    const d = rtfns.get(name);
    if (!d) throw new Error(`runtime function ${name} is not registered: the link module that defines it is not loaded`);
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
    this.callNamed(c, cls, "<init>", message === undefined ? "()V" : "(Ljava/lang/String;)V"); c.lget(local).throw_(this.tag);
  }
  /** calls thrower `name` with its arguments already pushed; it never returns, which the code says so the engine sees a check's failing arm end */
  callThrower(c: Code, name: Thrower): void {
    // a function of this module that makes the indirect call keeps each failing arm a plain call, which the engine inlines and sizes more cheaply
    const params = THROWERS[name].params;
    c.call(this.defineFn("throw:" + name, params.map(kindVT), [], (t) => {
      params.forEach((_, i) => t.lget(i));
      t.i32(SLOT[name]).callIndirect(this.sig(params, "V")).unreachable();
    }, true)).unreachable();
  }

  // ---------- Java operations, as compiled methods and the bodies link generates lower them
  /** replaces the vtable on the stack with the table slot that a virtual or interface call of `key` through `decl` runs: a class's vtable slot, Object's for
   *  a method Object declares, else the interface method table's (`vt` gives the local the probe keeps the vtable in) */
  emitDispatchSlot(c: Code, decl: string, key: string, vt = () => c.newLocal(ref(this.tVT))): void {
    const d = this.prog.get(decl);
    const owner = d && !d.isInterface ? decl : this.prog.get("java/lang/Object")!.byKey.has(key) ? "java/lang/Object" : undefined;
    if (owner) { c.i32(this.w.dispatch.vslot(owner, key)).arrayGet(this.tVT); return; }
    const sel = this.w.selectorId(key), s = sel % H.IMT_N, l = vt();
    // vt[IMT+2s] == sel ? vt[IMT+2s+1] : imtslow(vt, sel)
    c.lset(l).lget(l).i32(H.IMT + 2 * s).arrayGet(this.tVT).i32(sel).raw(OP.i32_eq).if_(T.i32)
      .lget(l).i32(H.IMT + 2 * s + 1).arrayGet(this.tVT).else_().lget(l).i32(sel).call(this.helper("imtslow")).end();
  }
  /** stores what `value` pushes into instance field `f` of the object `obj` pushes as `decl`'s struct; the object takes over a native handle stored into a
   *  field that holds one (World.claims) */
  emitFieldStore(c: Code, decl: string, f: FieldInfo, obj: () => void, value: () => void): void {
    obj(); value(); c.structSet(this.structFor(decl), this.fieldIndex(decl, f));
    if (this.w.claims(f)) { obj(); c.externConvertAny(); value(); c.call(this.imp.claim); }
  }
  /** throws NullPointerException when the reference on the stack, which it takes, is null */
  nullCheck(c: Code): void { c.refIsNull().if_(); this.callThrower(c, "npe"); c.end(); }
  /** throws ArrayIndexOutOfBoundsException unless the index `index` pushes is below the length `length` pushes */
  boundsCheck(c: Code, index: () => void, length: () => void): void {
    index(); length(); c.raw(OP.i32_ge_u).if_(); index(); length(); this.callThrower(c, "aioobe"); c.end();
  }
  /** replaces an element array and an index on the stack with the element of an array of `letter`'s type (a descriptor's first letter), extended as Java's
   *  byte, short, char and boolean are */
  emitElementLoad(c: Code, letter: string): void {
    const d = this.tData[elemKindOf("[" + letter)];
    if (letter === "B" || letter === "S") c.arrayGetS(d); else if (letter === "Z" || letter === "C") c.arrayGetU(d); else c.arrayGet(d);
  }
  /** stores what `value` pushes at the index `index` pushes into the element array `data` pushes, of the array in local `arr`; a reference passes the store
   *  check first */
  emitElementStore(c: Code, ek: ElemKind, arr: number, data: () => void, index: () => void, value: () => void): void {
    if (ek === "ref") this.emitStoreCheck(c, arr, value);
    data(); index(); value(); c.arraySet(this.tData[ek]);
  }
  /** call the method of `cls` that `name` and `desc` resolve to */
  callNamed(c: Code, cls: string, name: string, desc: string): void {
    const m = this.prog.resolve(cls, name, desc);
    if (!m) throw new Error(`${cls}.${name}${desc} does not resolve`);
    this.callMethod(c, m);
  }

  // ---------- allocation
  /** counts the bytes `add` pushes against the allocation window, and calls allocSlow once it is used up */
  allocBytes(c: Code, add: () => void): void {
    const g = this.global("rt", "alloc", T.i32, true);
    c.gget(g); add(); c.raw(OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
  }
  /** push the Class of `name` */
  constClass(c: Code, name: string): void { c.i32(this.idOf(name)); this.callRt(c, "classOf"); }
  /** the element array of the array object on the stack */
  arrayData(c: Code, ek: ElemKind = "ref"): Code { return c.refCast(this.tArr[ek]).structGet(this.tArr[ek], 2); }
  /** the class id of the (anyref) object on the stack */
  vtId(c: Code): Code { return c.call(this.helper("vtab")).i32(H.ID).arrayGet(this.tVT); }
  /** before storing the value pushed by `value` into the reference array wrapper in local `arr`: ArrayStoreException when it does not fit */
  emitStoreCheck(c: Code, arr: number, value: () => void): void {
    // Object[] takes anything; a value of exactly the component class (nearly every store into a typed array) needs no call
    const comp = c.scratch();
    c.lget(arr).refCast(this.tArr.ref).structGet(this.tArr.ref, 0).i32(ELEM).arrayGet(this.tVT).ltee(comp).i32(this.idOf("java/lang/Object")).raw(OP.i32_ne).if_();
    value(); c.refIsNull().raw(OP.i32_eqz).if_();
    value(); this.vtId(c).lget(comp).raw(OP.i32_ne).if_().lget(arr); value(); this.callRt(c, "astore"); c.end();
    c.end().end();
  }
  /** push a new object of constructor `ctor`'s class, initialized by it with the arguments `args` pushes; a String is made by its factory, as at an invoke-direct */
  construct(c: Code, ctor: MethodInfo, args: () => void = () => {}): void {
    if (ctor.cls === STRING) {
      const make = this.str.factory(ctor.desc);
      if (make === undefined) this.gap(c, `String.<init>${ctor.desc}`); else { args(); c.call(make); }
      return;
    }
    const o = c.newLocal(T.anyref);
    this.emitEnsure(c, ctor.cls); this.emitNew(c, ctor.cls); c.ltee(o); args(); this.callMethod(c, ctor); c.lget(o);
  }
  /** push a new zeroed instance of class `cls` (vt, hash 0, default fields) */
  emitNew(c: Code, cls: string): void {
    // a String is not an object with fields: ART's Unsafe.allocateInstance(String.class) is the empty string
    if (cls === STRING) { this.str.literal(c, ""); return; }
    this.w.allocated.add(cls); this.allocs.add(cls);
    c.call(this.defineFn("new:" + cls, [], [ref(this.structFor(cls))], (n) => {
      const lay = this.prog.layout(cls);
      this.allocBytes(n, () => n.i32(12 + lay.reduce((b, f) => b + (f.kind === "J" ? 8 : 4), 0)));
      n.gget(this.vtGlobal(cls)).refAsNonNull().i64(0n);
      for (const f of lay) n.zero(f.kind);
      n.structNew(this.structFor(cls));
    }));
  }
  /** push a new array of class `desc` whose length `pushLen` pushes; negative or oversized lengths throw */
  emitNewArray(c: Code, desc: string, pushLen: () => void): void {
    const ek = elemKindOf(desc), shift = { i8: 0, i16: 1, i32: 2, i64: 3, ref: 2 }[ek];
    pushLen();
    c.call(this.defineFn("newarray:" + desc, [T.i32], [ref(this.tArr[ek])], (n) => {
      n.gget(this.vtGlobal(desc)).refAsNonNull().i64(0n).lget(0).i32(shift).call(this.helper("newLen")).arrayNewDefault(this.tData[ek]).structNew(this.tArr[ek]);
    }));
  }
  /** replaces the anyref on the stack with whether it is an instance of class, interface or array `name` (null is not) */
  emitInstanceOf(c: Code, name: string): void {
    if (name === "java/lang/Object") { c.refIsNull().raw(OP.i32_eqz); return; }
    const t = this.typeTest(name);
    c.i32(t.id);
    if (t.kind === "refArray") this.callRt(c, "instArr");
    else if (t.kind === "interface") c.call(this.helper("implements"));
    else c.i32(t.depth).call(this.helper("iof"));
  }
  /** leaves the anyref on the stack if it can be cast to `name` (null can) and throws ClassCastException otherwise */
  emitCast(c: Code, name: string): void {
    if (name === "java/lang/Object") return;
    const t = this.typeTest(name);
    c.i32(t.id);
    if (t.kind === "refArray") c.call(this.helper("castArr"));
    else if (t.kind === "interface") c.call(this.helper("castImpl"));
    else c.i32(t.depth).call(this.helper("cast"));
  }
  /** `name`'s class id, and how a value is tested against it: by its depth in the class display (iof), as an interface, or as an array of references */
  private typeTest(name: string): { id: number; kind: "class"; depth: number } | { id: number; kind: "interface" } | { id: number; kind: "refArray" } {
    const id = this.idOf(name);
    if (name[0] === "[") return elemKindOf(name) === "ref" ? { id, kind: "refArray" } : { id, kind: "class", depth: 1 };
    const depth = this.prog.chain(name).length - 1;
    return this.prog.get(name)?.isInterface || depth >= H.MAXD ? { id, kind: "interface" } : { id, kind: "class", depth };
  }

  // ---------- module-local helpers, defined on first use
  helper(name: HelperName): number {
    const f = this.helpers.get(name);
    if (f !== undefined) return f;
    const { params, results, body } = HELPERS.get(name)!(this);
    return this.defineFn(name, params, results, body, true);
  }

  /** `m`'s decoded code, typing and String sites, timed as phases: kept from the declaring of its symbolic sites until its compile takes them (`last`) */
  analysis(m: MethodInfo, last = false): Analysis {
    let a = this.analyses.get(m);
    if (a) { if (last) this.analyses.delete(m); return a; }
    const phase = this.w.stats.phase, item = m.dex.code(m.codeOff), t0 = performance.now(), prepared = prepareMethod(item), t1 = performance.now();
    a = { prepared, typing: inferTyping(m.dex, item, m.desc, m.isStatic, prepared), strings: stringSites(m.dex, prepared) };
    phase.prepare += t1 - t0; phase.infer += performance.now() - t1;
    if (!last) this.analyses.set(m, a);
    return a;
  }

  // ---------- units
  /** compile `methods` into this module (the first is the one a lazy-link stub asks for); each is exported as "m<slot>" unless the unit installs them */
  buildUnit(methods: MethodInfo[], { copies = [], hot = false, install, ensures = [], plan = NO_PLAN }: UnitOptions = {}): { bytes: Uint8Array; traces: FnTrace[] } {
    const { mb, w } = this, all = methods.concat(copies);
    this.counting = !hot; this.plan = plan;
    this.natives.declare(this, all);
    declareSymbolicSites(this, all);
    // Traces are keyed by name, so a stack frame finds its own function's offsets only where no other function of the method shares it: a build's (which
    // AotRuntime.trace finds by method id) installs over code compiled on demand before its module arrived, and a copy or a later tier runs beside the first.
    const label = (m: MethodInfo) => (install === "build" ? mid(m) : `${mid(m)}#${this.seq}`);
    all.forEach((m) => { this.fn.set(mid(m), mb.reserveFunc(this.methodSig(m), label(m))); this.keys.add(m.key); });
    const { phase } = w.stats, t0 = performance.now(), analysed = phase.prepare + phase.flow + phase.infer + phase.facts;
    this.install = install; this.head = methods[0];
    const codes = all.map((m) => this.compiled(m)!);
    phase.emit += performance.now() - t0 - (phase.prepare + phase.flow + phase.infer + phase.facts - analysed);
    const at: [number, number][] = [];
    all.forEach((m, i) => {
      const f = this.fn.get(mid(m))!; mb.setBody(f, codes[i].finish());
      if (i >= methods.length) return;
      if (install) at.push([w.slotOf(m), f]); else mb.export("m" + w.slotOf(m), "func", f);
    });
    this.installSlots(at);
    const inits = ensures.map((cls) => {
      const name = "$ensure:" + cls, f = mb.reserveFunc(this.sig([], "V"), name), code = new Code(0);
      w.classModules.ensureBody(this, cls, code);
      mb.setBody(f, code.finish()); mb.export("m" + w.ensureSlot(cls), "func", f);
      return { name, f, code };
    });
    return this.finishModule([...all.map((m, i) => ({ name: label(m), f: this.fn.get(mid(m))!, code: codes[i], m })), ...inits]);
  }
  /** functions installed in their table slots when the module is instantiated, consecutive slots as one segment */
  private installSlots(at: [slot: number, f: number][]): void {
    at.sort((a, b) => a[0] - b[0]);
    for (let i = 0, j = 0; i < at.length; i = j) {
      while (++j < at.length && at[j][0] === at[j - 1][0] + 1);
      this.mb.addElemActive(0, at[i][0], at.slice(i, j).map((x) => x[1]));
    }
  }
  /** a module of generated functions (throwers, runtime functions, symbolic sites, host helpers). One with a `slot` is put in it when the module is instantiated
   *  (a build's, link/apps.ts), and left out if its code relies on a class-hierarchy decision or on a class being absent, which nothing could undo; the
   *  others are exported, under `exportAs` or their name */
  buildSynthetics(fns: SyntheticFn[]): { bytes: Uint8Array; traces: FnTrace[]; kept: string[] } {
    const mb = this.mb, parts: { name: string; f: number; code: Code }[] = [], at: [number, number][] = [];
    for (const { name, params, ret, body, slot, exportAs } of fns) {
      const f = mb.reserveFunc(this.sig(params, ret), "$" + name), code = new Code(params.length), assumed = this.assumptions.length, absent = this.absent.length;
      body(code);
      mb.setBody(f, code.finish());
      if (slot === undefined) mb.export(exportAs ?? name, "func", f);
      else if (this.assumptions.length !== assumed || this.absent.length !== absent) { this.assumptions.length = assumed; this.absent.length = absent; continue; }
      else at.push([slot, f]);
      parts.push({ name, f, code });
    }
    this.installSlots(at);
    return { ...this.finishModule(parts.map((p) => ({ name: "$" + p.name, f: p.f, code: p.code }))), kept: parts.map((p) => p.name) };
  }
  /** a module of one generated function, exported as "m"; `ret` is its result kind */
  buildSynthetic(name: string, params: Kind[], body: (c: Code) => void, ret: Kind | "V" = "V") { return this.buildSynthetics([{ name, params, ret, body, exportAs: "m" }]); }
  /** the functions of outlined loops (outline.ts), with the function of the method each is part of */
  outlines: { name: string; f: number; code: Code; m: MethodInfo; owner: string }[] = [];
  private finishModule(fns: { name: string; f: number; code: Code; m?: MethodInfo }[]): { bytes: Uint8Array; traces: FnTrace[] } {
    const roots = fns.length;
    fns = fns.concat(this.outlines);
    // V8 13.6 gives a module without a start function a quarter of the inlining budget, which halves a recursive method's speed (fib(32): 9.7 ms
    // against 5.4 ms); an empty start function restores it
    this.mb.start = this.mb.addFunc(this.mb.addFuncType([], []), new Code(0).finish(), "$start");
    const t0 = performance.now(), bytes = this.mb.build(true);
    this.w.stats.phase.encode += performance.now() - t0;
    const traces = fns.map(({ name, f, code, m }) => {
      const start = this.mb.bodyOffsets[f - this.mb.nImportedFuncs] + code.prefixLen, n = code.marks.length / 2, offsets = new Int32Array(n), pcs = new Int32Array(n);
      for (let i = 0; i < n; i++) { offsets[i] = start + code.marks[2 * i]; pcs[i] = code.marks[2 * i + 1]; }
      return { name, m, offsets, pcs, ...code.inline && { inline: code.inline } };
    });
    // AOT traces are keyed by Java slot: an outlined loop's offsets join its method's trace without changing that format
    const chunks = new Map<string, FnTrace[]>();
    this.outlines.forEach(({ owner }, i) => (chunks.get(owner) ?? chunks.set(owner, []).get(owner)!).push(traces[roots + i]));
    for (let i = 0; i < roots; i++) {
      const root = traces[i], parts = chunks.get(root.name);
      if (!parts) continue;
      const pairs: [number, number][] = [];
      for (const t of [root, ...parts]) for (let k = 0; k < t.offsets.length; k++) pairs.push([t.offsets[k], t.pcs[k]]);
      pairs.sort((a, b) => a[0] - b[0]);
      root.offsets = Int32Array.from(pairs, (p) => p[0]); root.pcs = Int32Array.from(pairs, (p) => p[1]);
    }
    return { bytes, traces: traces.slice(0, roots) };
  }
}

/** the side table that maps a Wasm frame offset of one function back to a DEX pc: offsets ascend, pcs[i] belongs to offsets[i]; a pc below -1 names a frame
 *  of `inline` (Code.inline) */
export interface FnTrace { name: string; m?: MethodInfo; offsets: Int32Array; pcs: Int32Array; inline?: InlineFrame[] }
