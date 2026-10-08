import { beginCompile, endCompile } from "../../jvm/compiler-observer";
// One Compiler builds one Wasm module (a unit of methods, or a synthetic body) against a World; see link/world.ts for the linker.
import { ModuleBuilder, T, ref, refNull, uleb, type VT } from "./wasmbin";
import { Code, OP } from "./code";
import { Program, kindOf, type Kind, type MethodInfo } from "./program";
import { mid } from "./ids";
import { H, elemKindOf, type ElemKind } from "./consts";
import { declareSymbolicSites, type SymbolicSite } from "./sites";
import type { PreparedMethod } from "../../jvm/prepared";
import type { Typing } from "./infer";
import { compileMethod, MC } from "./method";
import type { ClassRt, World } from "../link/world";
import { rtfns, type Synth } from "./rtfns";
import type { LinkFailure } from "./linkage";
import { Block, FUEL, emitBlock } from "../link/sched";
import { SLOT, INIT_DONE, THROWERS, ALLOC_WINDOW, MAX_ARRAY_BYTES, MAX_DEPTH, HOT_BUDGET, COUNT_BASE, COUNT_SLOTS, type Thrower } from "../link/exc";
import { StructStrings, stringCtor, type StringRepr } from "../link/strings";
import { emitStoreCheck } from "../link/classes";
import type { NativeBinder } from "../link/hostapi";

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
export const kindVT = (_tObj: number, k: Kind): VT => (k === "I" ? T.i32 : k === "J" ? T.i64 : T.anyref);

export class Compiler implements Base {
  mb = new ModuleBuilder();
  tVT!: number; tObj!: number; tStr!: number; tTagFn!: number; tData!: Record<ElemKind, number>; tArr!: Record<ElemKind, number>;
  tag: number;
  imp: { initSignatures: number; initSignaturesWait: number; fmod: number; gap: number; imtMiss: number; heapCheck: number; excMessage: number; capture: number; stFrames: number; info: number; stackClass: number; stString: number; stLine: number; classByName: number; catchBlock: number; catchBlockWait: number; catchSync: number; dexOpen: number; dexOpenMemory: number; galloc: number; hot: number; long: number; mhInvoke: number; text: number; net: number; proxy: number; obj: number; annotation: number; annotationWait: number; watch: number; intern: number; claim: number; sync: number; block: number };
  /** gaps this module's code ran into */
  gaps: string[] = [];
  /** methods this module defines, by id: calls between them are direct, every other call goes through the table (all of them do in a precompiled module,
   *  whose methods the second tier replaces one by one) */
  fn = new Map<string, number>();
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
  private install = false;
  private codes = new Map<string, Code | null>();
  /** the frame weight of the methods of this unit that count no depth, with everything they call (a leaf, or a method that calls only such methods) */
  bound = new Map<string, number>();
  str: StringRepr;
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
  readonly deopt?: { make: number; version: number; last: number; blocked: number; allocation: number; monitor: number; capture: number; captureIndexed: number; beginCapture: number; endCapture: number; target: number; epoch: number; enabled: number };
  constructor(public w: World, deopt = !!w.opts.cold || !!w.opts.deopt) {
    const mb = this.mb;
    Object.assign(this, declareBase(mb));
    this.classStruct.set("java/lang/Object", this.tObj);
    mb.importTable("rt", "table", T.funcref, 0);
    mb.importTable("rt", "nm", T.externref, 0);
    this.str = new StructStrings(this);
    this.classStruct.set("java/lang/String", this.tStr);
    this.tag = mb.importTag("rt", "tag", this.tTagFn);
    const f = (name: string, p: VT[], r: VT[]) => mb.importFunc("host", name, mb.addFuncType(p, r));
    this.imp = { initSignatures: f("initSignatures", [T.i32], []), initSignaturesWait: f("initSignaturesWait", [T.i32], []), catchBlock: f("catchBlock", [T.i32, T.i32, T.i32, T.externref], [T.i32]), catchBlockWait: f("catchBlockWait", [T.i32, T.i32, T.i32, T.externref], [T.i32]), catchSync: f("catchSync", [], [T.i32]), fmod: f("fmod", [T.f64, T.f64], [T.f64]), gap: f("gap", [T.i32], []), imtMiss: f("imtMiss", [T.i32, T.i32], [T.i32]),
      heapCheck: f("heapCheck", [], [T.i32]), excMessage: f("excMessage", [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], [T.externref]), capture: f("capture", [T.externref], []),
      stFrames: f("stFrames", [T.externref], [T.i32]), stString: f("stString", [T.i32, T.i32], [T.externref]), stLine: f("stLine", [T.i32], [T.i32]),
      info: f("info", [T.i32, T.i32, T.i32], [T.i32]), stackClass: f("stackClass", [T.i32], [T.i32]), classByName: f("classByName", [T.externref, T.externref, T.i32], [T.i32]), dexOpen: f("dexOpen", [T.externref, T.externref], [T.externref]), dexOpenMemory: f("dexOpenMemory", [T.externref, T.externref, T.externref, T.externref, T.externref], [T.externref]), galloc: f("galloc", [T.externref, T.i32], [T.i64]), hot: f("hot", [T.i32], []), long: f("long", [T.i32], []), mhInvoke: f("mhInvoke", [T.externref, T.externref, T.externref, T.i32], [T.externref]), text: f("text", [T.i32, T.i32], [T.externref]), net: f("net", [T.i32, T.externref, T.i32, T.i32], [T.i32]),
      proxy: f("proxy", [T.externref, T.externref, T.externref, T.externref, T.externref], [T.externref]), obj: f("obj", [T.i32, T.i32, T.i32, T.externref], [T.externref]), annotation: f("annotation", [T.i32, T.i32, T.i32, T.externref], [T.externref]), annotationWait: f("annotationWait", [], [T.externref]), watch: f("watch", [T.externref, T.externref], []), claim: f("claim", [T.externref, T.i64], []), intern: f("intern", [T.externref, T.externref], [T.externref]),
      sync: f("sync", [T.i32, T.externref, T.f64], [T.i32]), block: f("block", [T.i32, T.externref, T.f64, T.i32], [T.i32]) };
    if (deopt) {
      const imp = (name: string, params: VT[], results: VT[]) => mb.importFunc("deopt", name, mb.addFuncType(params, results));
      this.deopt = { make: imp("make", [T.i32, T.i32], [T.externref]), version: imp("version", [T.externref], [T.i32]), last: imp("last", [T.externref], [T.i32]), blocked: imp("blocked", [T.externref], [T.i32]), allocation: imp("allocation", [T.externref, T.i32], []), monitor: imp("monitor", [T.externref, T.externref, T.i32], []), capture: imp("capture", [T.externref, T.i32, T.i32, T.i32, T.externref, T.externref, T.externref], [T.externref]), captureIndexed: imp("captureIndexed", [T.externref, T.i32, T.i32, T.i32, T.externref, T.externref, T.externref], [T.externref]), beginCapture: imp("beginCapture", [T.externref, T.i32], []), endCapture: imp("endCapture", [T.externref], []), target: imp("target", [T.externref], [T.funcref]), epoch: this.global("rt", "deoptEpoch", T.i32, true), enabled: this.global("rt", "deoptEnabled", T.i32, false) };
    }
    this.str.importBuiltins();
    // the imports that cannot run Java code
    const { initSignatures, initSignaturesWait, mhInvoke, proxy, obj, dexOpen, dexOpenMemory, classByName, net, sync, block, catchBlock, catchBlockWait } = this.imp, runsJava = new Set([initSignatures, initSignaturesWait, mhInvoke, proxy, obj, dexOpen, dexOpenMemory, classByName, net, sync, block, catchBlock, catchBlockWait]);
    this.hostSafe = new Set(Array.from({ length: mb.nImportedFuncs }, (_, i) => i).filter((i) => !runsJava.has(i)));
  }
  private hostSafe: Set<number>;
  /** whether the body `c` can run Java code beyond itself: it calls through a table, an import that may, or a method of this unit */
  runsJava(c: Code): boolean {
    const methods = new Set(this.fn.values());
    return c.indirect > 0 || c.targets.some((f) => (f < this.mb.nImportedFuncs ? !this.hostSafe.has(f) : methods.has(f)));
  }
  readonly deoptWork = { sites: 0, values: 0, layouts: 0, metadataBytes: 0, carriers: 0, carrierValues: 0, maxCarrierValues: 0 };
  private captureMaps = new Map<string, number>();
  /** Only an invalidated activation constructs these vectors; ordinary execution has no carrier. */
  captureValues(c: Code, values: { register: number; local: number; type: VT }[], registers: number): void {
    const bits = values.filter(v => v.type !== T.anyref), references = values.filter(v => v.type === T.anyref);
    const map = [...bits.map(v => v.register), ...references.map(v => v.register)], key = map.join(",");
    let data = this.captureMaps.get(key);
    if (data === undefined) {
      const bytes = new Uint8Array(map.length * 2), view = new DataView(bytes.buffer);
      map.forEach((r, i) => view.setUint16(2 * i, r, true));
      this.captureMaps.set(key, data = this.mb.addDataPassive(bytes));
      this.deoptWork.layouts++; this.deoptWork.metadataBytes += bytes.length;
    }
    const ordered = [...bits, ...references];
    c.i32(0).i32(map.length).arrayNewData(this.tData.i16, data).externConvertAny();
    this.captureCarrier(c, ordered, false, registers);
  }
  captureIndexedMap(c: Code, values: { register: number; local: number }[], indices: Map<number, number>): void {
    const bytes: number[] = [];
    for (const v of values) { uleb(v.register, bytes); uleb(indices.get(v.local)!, bytes); }
    const key = "indexed:" + bytes.join(",");
    let data = this.captureMaps.get(key);
    if (data === undefined) {
      this.captureMaps.set(key, data = this.mb.addDataPassive(Uint8Array.from(bytes)));
      this.deoptWork.layouts++; this.deoptWork.metadataBytes += bytes.length;
    }
    c.i32(0).i32(bytes.length).arrayNewData(this.tData.i8, data).externConvertAny();
  }
  captureIndexedValues(c: Code, values: { local: number; type: VT }[], map: number, registers: number): void {
    this.captureCarrier(c, values, true, registers, map);
  }
  private captureCarrier(c: Code, ordered: { local: number; type: VT }[], indexed: boolean, registers: number, map = -1): void {
    this.deoptWork.carriers++; this.deoptWork.carrierValues += ordered.length; this.deoptWork.maxCarrierValues = Math.max(this.deoptWork.maxCarrierValues, ordered.length);
    const bits = ordered.filter(v => v.type !== T.anyref), references = ordered.filter(v => v.type === T.anyref);
    // The canonical snapshot also owns bits, reference and kind arrays for every DEX register.
    const snapshotBytes = 17 * registers;
    const allocation = (c: Code, map: number, snapshot: () => void) => this.allocBytes(c, () => {
      c.i32(48 + 8 * ordered.length).lget(map).anyConvertExtern().refCast(indexed ? this.tData.i8 : this.tData.i16).arrayLen();
      if (!indexed) c.i32(1).raw(OP.i32_shl);
      c.raw(OP.i32_add); snapshot(); c.raw(OP.i32_add);
    });
    if (ordered.length <= 64) {
      const key = `capture:${+indexed}:${bits.length}:${references.length}`;
      const f = this.memo(key, () => {
        const params = [T.externref, T.i32, T.i32, T.i32, T.externref, T.i32, ...ordered.map(v => v.type === T.anyref ? T.anyref : T.i64)];
        const f = this.mb.reserveFunc(this.mb.addFuncType(params, [T.externref]), "$capture"), body = new Code(params.length);
        const depth = body.newLocal(T.i32), weights = this.emitEnter(body, depth);
        allocation(body, 4, () => body.lget(5));
        for (let i = 0; i < 5; i++) body.lget(i, false);
        this.captureVectors(body, ordered.map((v, i) => ({ local: i + 6, type: v.type === T.anyref ? T.anyref : T.i64 })));
        body.call(indexed ? this.deopt!.captureIndexed : this.deopt!.capture);
        this.emitLeave(body, depth, false);
        for (const at of weights) body.patch(at, 4 + params.length + body.localTypes.length);
        this.mb.setBody(f, body.finish());
        return f;
      });
      c.i32(snapshotBytes);
      for (const v of ordered) { if (v.type === T.anyref) c.lget(v.local, false); else this.captureBits(c, v); }
      c.call(f);
    } else {
      if (map < 0) {
        map = c.newLocal(T.externref); c.ltee(map);
      }
      allocation(c, map, () => c.i32(snapshotBytes));
      this.captureVectors(c, ordered); c.call(indexed ? this.deopt!.captureIndexed : this.deopt!.capture);
    }
  }
  private captureVectors(c: Code, values: { local: number; type: VT }[]): void {
    const vector = (list: typeof values, type: number, push: (v: typeof values[number]) => void) => {
      if (list.length <= 64) {
        for (const v of list) push(v);
        c.arrayNewFixed(type, list.length);
      } else {
        const array = c.newLocal(refNull(type));
        c.i32(list.length).arrayNewDefault(type).lset(array);
        list.forEach((v, i) => { c.lget(array).refAsNonNull().i32(i); push(v); c.arraySet(type); });
        c.lget(array).refAsNonNull();
      }
      c.externConvertAny();
    };
    vector(values.filter(v => v.type !== T.anyref), this.tData.i64, ({ local, type }) => {
      this.captureBits(c, { local, type });
    });
    vector(values.filter(v => v.type === T.anyref), this.tData.ref, ({ local }) => { c.lget(local, false); });
  }

  private captureBits(c: Code, { local, type }: { local: number; type: VT }): void {
    c.lget(local, false);
    if (type === T.f32) c.raw(OP.i32_reinterpret_f32);
    if (type === T.f64) c.raw(OP.i64_reinterpret_f64);
    if (type !== T.i64 && type !== T.f64) c.raw(OP.i64_extend_i32_s);
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
  /** a function of this module defined on first use under `key` */
  memo(key: string, make: () => number): number {
    let f = this.helpers.get(key);
    if (f === undefined) this.helpers.set(key, f = make());
    return f;
  }
  get prog(): Program { return this.w.prog; }

  // ---------- types
  vtOf(k: Kind): VT { return kindVT(this.tObj, k); }
  sig(params: Kind[], ret: Kind | "V"): number {
    const key = params.join("") + ">" + ret;
    let s = this.sigType.get(key);
    if (s === undefined) this.sigType.set(key, s = this.mb.addFuncType(params.map((k) => this.vtOf(k)), ret === "V" ? [] : [this.vtOf(ret)]));
    return s;
  }
  methodSig(m: MethodInfo): number {
    const ps: Kind[] = m.isStatic ? [] : ["L"]; for (const p of m.params) ps.push(kindOf(p));
    return this.sig(ps, m.ret === "V" ? "V" : kindOf(m.ret));
  }
  structFor(cls: string): number {
    let t = this.classStruct.get(cls); if (t !== undefined) return t;
    const c = this.prog.get(cls);
    if (!c || c.isInterface) { this.classStruct.set(cls, this.tObj); return this.tObj; }
    const sup = this.structFor(c.sup ?? "java/lang/Object");
    const own = this.prog.layout(cls);
    // a class with no own fields shares its super's struct type
    if (own.length === (c.sup ? this.prog.layout(c.sup).length : 0)) { this.classStruct.set(cls, sup); return sup; }
    const fields = [{ t: ref(this.tVT) as VT, mut: false }, { t: T.i64 as VT, mut: true }, ...own.map((f) => ({ t: this.vtOf(f.kind), mut: true }))];
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
  stringConst(s: string): number { return this.global("#", s, ref(-17), false); }
  vtGlobal(cls: string): number { return this.classGlobal(cls, "vt", refNull(this.tVT)); }
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
    this.owner = m; this.assumer = this.install ? m : this.head;
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
    // Raw host helpers have no Java method owner or guarded activation to deopt.
    if (!this.assumer) return "many";
    const t = this.w.cha.targets(decl, name, desc);
    if (t.length !== 1) return "many";
    this.assumptions.push([decl, name, desc, t[0], this.assumer]);
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
    const addr = COUNT_BASE + 4 * slot, n = c.scratch();
    if (iterations === undefined) {
      c.i32(addr).i32(addr).mem(OP.i32_load, 2).i32(1).raw(OP.i32_add).ltee(n).mem(OP.i32_store, 2);
      c.lget(n).i32(HOT_BUDGET).raw(OP.i32_eq).if_().i32(slot).call(this.imp.hot).end();
      return;
    }
    c.i32(addr).i32(addr).mem(OP.i32_load, 2).lget(iterations).raw(OP.i32_add).ltee(n).mem(OP.i32_store, 2);
    c.lget(n).lget(iterations).raw(OP.i32_sub).i32(HOT_BUDGET).raw(OP.i32_lt_u);
    c.lget(n).i32(HOT_BUDGET).raw(OP.i32_ge_u, OP.i32_and).if_().i32(slot).call(this.imp.hot).end();
  }
  /** a method that calls something counts its frame (exc.ts MAX_DEPTH): `entry` takes the depth before it, which is restored on return and at a handler */
  emitEnter(c: Code, entry: number): number[] {
    const g = this.global("rt", "depth", T.i32, true);
    c.gget(g).ltee(entry).i32(MAX_DEPTH).raw(OP.i32_ge_s).if_(); this.callThrower(c, "soe"); c.end();
    c.lget(entry);
    const weight = c.i32Patched();
    c.raw(OP.i32_add).gset(g);
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
    c.gget(this.classGlobal(cls, "init", T.i32)).i32(INIT_DONE).raw(OP.i32_ne).if_().i32(this.w.ensureSlot(cls)).callIndirect(this.sig([], "V")).end();
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
  /** calls thrower `name` with its arguments already pushed; it never returns, which the code says so the engine sees a check's failing arm end */
  callThrower(c: Code, name: Thrower): void {
    // a function of this module that makes the indirect call keeps each failing arm a plain call, which the engine inlines and sizes more cheaply
    const f = this.memo("throw:" + name, () => {
      const params = THROWERS[name].params, fn = this.mb.reserveFunc(this.sig(params, "V"), "$throw_" + name), t = new Code(params.length);
      params.forEach((_, i) => t.lget(i));
      t.i32(SLOT[name]).callIndirect(this.sig(params, "V")).unreachable();
      this.mb.setBody(fn, t.finish());
      return fn;
    });
    c.call(f).unreachable();
  }

  // ---------- allocation
  private allocBytes(c: Code, add: () => void): void {
    const g = this.global("rt", "alloc", T.i32, true);
    c.gget(g); add(); c.raw(OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
  }
  /** a function of this module with the given body: a call is much shorter than the sequence, which keeps the callers small for the engine's inliner */
  private local(key: string, params: Kind[], ret: Kind | "V", body: (c: Code) => void, result?: VT): number {
    return this.memo(key, () => {
      const type = result ? this.mb.addFuncType(params.map((k) => this.vtOf(k)), [result]) : this.sig(params, ret);
      const f = this.mb.reserveFunc(type, "$" + key), c = new Code(params.length);
      body(c);
      this.mb.setBody(f, c.finish());
      return f;
    });
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
    let f = this.helpers.get(name);
    if (f !== undefined) return f;
    const mb = this.mb, L = T.anyref, t = (p: VT[], r: VT[]) => mb.addFuncType(p, r);
    const [sigIdx, body] = this.helperBody(name, L, t);
    f = mb.reserveFunc(sigIdx, "$" + name);
    this.helpers.set(name, f);
    mb.setBody(f, body());
    return f;
  }
  private helperBody(name: string, L: VT, t: (p: VT[], r: VT[]) => number): [number, () => number[]] {
    const { tVT, tObj } = this, vtR = refNull(tVT);
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
        c.lget(bytes).i64(BigInt(MAX_ARRAY_BYTES)).raw(OP.i64_gt_u).if_().lget(bytes); this.callThrower(c, "oom"); c.end();
        c.gget(g).lget(bytes).raw(OP.i32_wrap_i64, OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
        return c.lget(0).finish();
      }];
      // allocSlow(): the allocation window is used up; the host decides whether the heap really is full. Garbage that only a finalizer frees (a native handle
      // its owner holds) counts until the event loop has run the finalizers, so a full heap gets two turns of the loop, each with a collection, before it is an error
      case "allocSlow": return [t([], []), () => {
        const c = new Code(0), g = this.global("rt", "alloc", T.i32, true);
        c.i32(-ALLOC_WINDOW).gset(g);
        for (let turn = 0; turn < 2; turn++) { c.call(this.imp.heapCheck).if_(); emitBlock(this, c, Block.Yield, null, null, () => c.i32(1)); c.drop(); }
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
   *  unit is the second tier: its methods do not count. With `install` the module puts its functions in the table itself, when it is instantiated,
   *  instead of exporting them (a precompiled module, aot.ts). */
  buildUnit(methods: MethodInfo[], copies: MethodInfo[] = [], hot = false, install = false): { bytes: Uint8Array; traces: FnTrace[] } {
    const span = beginCompile("wasm.emit");
    try {
    const { mb, w } = this, all = methods.concat(copies);
    this.counting = !hot;
    this.natives.declare(this, all);
    declareSymbolicSites(this, all);
    // the second tier's names differ from the first's, and a copy's from the installed method's, so a stack frame finds its own offsets (traces are keyed by name)
    const label = (m: MethodInfo, i: number) => (hot || i >= methods.length ? `${mid(m)}#${w.stats.units}` : mid(m));
    all.forEach((m, i) => this.fn.set(mid(m), mb.reserveFunc(this.methodSig(m), label(m, i))));
    const { phase } = w.stats, t0 = performance.now(), analysed = phase.prepare + phase.flow + phase.infer + phase.facts;
    this.direct = !install; this.install = install; this.head = methods[0];
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
    return this.finishModule(all.map((m, i) => ({ name: label(m, i), f: this.fn.get(mid(m))!, code: codes[i], m })));
    } finally { endCompile(span); }
  }
  buildResume(m: MethodInfo, pc: number) {
    const span = beginCompile("wasm.emit");
    try {
    if (this.fn.size || this.codes.size) throw new Error("resume needs a fresh compiler");
    if (!m.codeOff || this.intrinsic(m)) throw new Error("resume needs a bytecode body");
    this.natives.declare(this, [m]);
    declareSymbolicSites(this, [m]);
    const name = `${mid(m)}#resume${pc}`, ret = m.ret === "V" ? "V" : kindOf(m.ret);
    const bits = this.mb.importFunc("resume", "bits", this.mb.addFuncType([T.externref, T.i32], [T.i64]));
    const reference = this.mb.importFunc("resume", "reference", this.mb.addFuncType([T.externref, T.i32], [T.externref]));
    const mc = new MC(this, m, { pc, bits, reference });
    const f = this.mb.reserveFunc(this.mb.addFuncType([T.externref], ret === "V" ? [] : [this.vtOf(ret)]), name);
    this.fn.set(mid(m), f); this.direct = false; this.owner = this.head = this.assumer = m; this.counting = false;
    mc.run();
    const code = mc.weigh(); this.mb.setBody(f, code.finish()); this.mb.export("resume", "func", f);
    const built = this.finishModule([{ name, f, code, m }]);
    return { ...built, registers: mc.resumeRegisters };
    } finally { endCompile(span); }
  }
  buildSyntheticGroup(bodies: { name: string; params: Kind[]; ret: Kind | "V"; body: (c: Code) => void }[]) {
    const span = beginCompile("wasm.emit");
    try {
    const parts = bodies.map(body => ({ ...body, f: this.mb.reserveFunc(this.sig(body.params, body.ret), "$" + body.name), code: new Code(body.params.length) }));
    for (const part of parts) { part.body(part.code); this.mb.setBody(part.f, part.code.finish()); this.mb.export(part.name, "func", part.f); }
    return this.finishModule(parts.map(part => ({ name: "$" + part.name, f: part.f, code: part.code })));
    } finally { endCompile(span); }
  }
  /** a body made of generated code (the implicit-exception throwers, field readers); `ret` is its result kind */
  buildSynthetic(name: string, params: Kind[], body: (c: Code) => void, ret: Kind | "V" = "V", exportName = "m", abiParams?: VT[]): { bytes: Uint8Array; traces: FnTrace[] } {
    const span = beginCompile("wasm.emit");
    try {
    const f = this.mb.reserveFunc(abiParams ? this.mb.addFuncType(abiParams, ret === "V" ? [] : [this.vtOf(ret)]) : this.sig(params, ret), "$" + name), c = new Code(params.length);
    body(c);
    this.mb.setBody(f, c.finish());
    this.mb.export(exportName, "func", f);
    return this.finishModule([{ name: "$" + name, f, code: c }]);
    } finally { endCompile(span); }
  }
  /** one module of several synthetic functions, each put in its table slot when the module is instantiated (a build's, link/apps.ts). A function whose code relies on a class-hierarchy
   *  decision or on a class being absent is left out: nothing here could undo it. */
  buildSynthetics(fns: { name: string; slot: number; d: Synth }[]): { bytes: Uint8Array; traces: FnTrace[]; kept: string[] } {
    const span = beginCompile("wasm.emit");
    try {
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
    } finally { endCompile(span); }
  }
  outlines: { name: string; f: number; code: Code; m?: MethodInfo }[] = [];
  private finishModule(fns: { name: string; f: number; code: Code; m?: MethodInfo }[]): { bytes: Uint8Array; traces: FnTrace[] } {
    const roots = fns.length;
    fns = fns.concat(this.outlines);
    // V8 13.6 gives a module without a start function a quarter of the inlining budget, which halves a recursive method's speed (fib(32): 9.7 ms
    // against 5.4 ms); an empty start function restores it
    this.mb.start = this.mb.addFunc(this.mb.addFuncType([], []), [0, 0x0b], "$start");
    const t0 = performance.now(), span = beginCompile("wasm.encode");
    let bytes: Uint8Array;
    try { bytes = this.mb.build(); } finally { endCompile(span); }
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
export interface FnTrace { name: string; m?: MethodInfo; currentPcs?: () => readonly number[]; capturePcs?: () => readonly number[]; offsets: Int32Array; pcs: Int32Array }
