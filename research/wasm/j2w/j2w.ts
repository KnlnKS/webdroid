// One Compiler builds one Wasm module (a unit of methods, or a synthetic body) against a World; see lazy.ts for the linker.
import { ModuleBuilder, T, ref, refNull, type VT } from "./wasmbin";
import { Code, OP } from "./code";
import { Program, kindOf, type Kind, type MethodInfo } from "./program";
import { mid } from "./reach";
import { H, elemKindOf, type ElemKind } from "./consts";
import { compileMethod } from "./method";
import type { ClassRt, World } from "./lazy";
import { rtfns } from "./rtfns";
import type { LinkFailure } from "./linkage";
import { SLOT, INIT_DONE, THROWERS, ALLOC_WINDOW, MAX_ARRAY_BYTES, HOT_BUDGET, type Thrower } from "./exc";
import { JsStrings, stringCtor, stringHelper, type StringRepr } from "./strings";
import type { Natives } from "./natives";

export interface Intrinsic { (cx: Compiler, m: MethodInfo, c: Code): void }
/** how `m` is implemented without its bytecode: an intrinsic, a String constructor (a call site makes the string), or a host import */
export function intrinsicFor(intrinsics: Map<string, Intrinsic>, natives: Natives, m: MethodInfo): Intrinsic | undefined {
  return intrinsics.get(mid(m)) ?? (m.isCtor && m.cls === "java/lang/String" ? stringCtor : natives.stub(m));
}

/** the types every module declares identically; Wasm canonicalises them across modules */
export interface Base { tVT: number; tObj: number; tTagFn: number; tData: Record<ElemKind, number>; tArr: Record<ElemKind, number> }
export function declareBase(mb: ModuleBuilder): Base {
  const tVT = mb.addType({ k: "array", elem: { t: T.i32, mut: true } });
  const tObj = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i32, mut: true }], final: false });
  const dataElem: Record<ElemKind, VT> = { i8: T.i8, i16: T.i16, i32: T.i32, i64: T.i64, ref: T.anyref };
  const tData = {} as Record<ElemKind, number>, tArr = {} as Record<ElemKind, number>;
  for (const k of ["i8", "i16", "i32", "i64", "ref"] as ElemKind[]) {
    tData[k] = mb.addType({ k: "array", elem: { t: dataElem[k], mut: true } });
    tArr[k] = mb.addType({ k: "struct", fields: [{ t: ref(tVT), mut: false }, { t: T.i32, mut: true }, { t: ref(tData[k]), mut: false }], sup: tObj, final: false });
  }
  return { tVT, tObj, tData, tArr, tTagFn: mb.addFuncType([T.anyref], []) };
}
/** every reference slot is an anyref: a Java object is a struct subtype of $Obj, a String the JS string behind any.convert_extern (strings.ts) */
export const kindVT = (_tObj: number, k: Kind): VT => (k === "I" ? T.i32 : k === "J" ? T.i64 : T.anyref);

export class Compiler implements Base {
  mb = new ModuleBuilder();
  tVT!: number; tObj!: number; tTagFn!: number; tData!: Record<ElemKind, number>; tArr!: Record<ElemKind, number>;
  tag: number;
  imp: { fmod: number; gap: number; imtMiss: number; heapCheck: number; excMessage: number; capture: number; stFrames: number; info: number; stackClass: number; stString: number; stLine: number; classByName: number; pin: number; hot: number; mhInvoke: number; text: number; net: number; proxy: number };
  /** gaps this module's code ran into */
  gaps: string[] = [];
  /** methods this module defines, by id: calls between them are direct, every other call goes through the table */
  fn = new Map<string, number>();
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
  /** the slots whose budget globals this module imports */
  counted = new Set<number>();
  /** the method being compiled */
  private owner?: MethodInfo;
  /** the installed method of the unit being compiled, which the CHA decisions of every method in it count against */
  private assumer?: MethodInfo;
  str: StringRepr;
  /** the production natives this module imports, by method id, and their import indices */
  nativeImports = new Map<string, number>();
  private memory = false;
  private classStruct = new Map<string, number>();
  private sigType = new Map<string, number>();
  private globalImports = new Map<string, number>();
  private helpers = new Map<string, number>();
  constructor(public w: World) {
    const mb = this.mb;
    Object.assign(this, declareBase(mb));
    this.classStruct.set("java/lang/Object", this.tObj);
    mb.importTable("rt", "table", T.funcref, 0);
    mb.importTable("rt", "strs", T.externref, 0);
    mb.importTable("rt", "nm", T.externref, 0);
    this.str = new JsStrings(this);
    this.tag = mb.importTag("rt", "tag", this.tTagFn);
    const f = (name: string, p: VT[], r: VT[]) => mb.importFunc("host", name, mb.addFuncType(p, r));
    this.imp = { fmod: f("fmod", [T.f64, T.f64], [T.f64]), gap: f("gap", [T.i32], []), imtMiss: f("imtMiss", [T.i32, T.i32], [T.i32]),
      heapCheck: f("heapCheck", [], [T.i32]), excMessage: f("excMessage", [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], [T.externref]), capture: f("capture", [T.externref], []),
      stFrames: f("stFrames", [T.externref], [T.i32]), stString: f("stString", [T.i32, T.i32], [T.externref]), stLine: f("stLine", [T.i32], [T.i32]),
      info: f("info", [T.i32, T.i32, T.i32], [T.i32]), stackClass: f("stackClass", [T.i32], [T.i32]), classByName: f("classByName", [T.externref], [T.i32]), pin: f("pin", [T.externref], [T.i32]), hot: f("hot", [T.i32], []), mhInvoke: f("mhInvoke", [T.externref, T.externref, T.i32, T.i32], [T.externref]), text: f("text", [T.i32, T.i32], [T.externref]), net: f("net", [T.i32, T.externref, T.i32, T.i32], [T.i32]),
      proxy: f("proxy", [T.externref, T.externref, T.externref, T.externref], [T.externref]) };
    this.str.importBuiltins();
  }
  get natives() { return this.w.natives; }
  intrinsic(m: MethodInfo): Intrinsic | undefined { return this.w.intrinsic(m); }
  /** the linear memory natives copy arrays through, and its allocation top */
  scratch(): number {
    if (!this.memory) { this.mb.importMemory("rt", "mem", 1); this.memory = true; }
    return this.global("rt", "sp", T.i32, true);
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
    const fields = [{ t: ref(this.tVT) as VT, mut: false }, { t: T.i32 as VT, mut: true }, ...own.map((f) => ({ t: this.vtOf(f.kind), mut: true }))];
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
    return this.global(rt.mod, name, t, true);
  }
  vtGlobal(cls: string): number { return this.classGlobal(cls, "vt", refNull(this.tVT)); }
  /** the global holding static field `name` of type `desc` of `owner`, which must declare it (a dex may declare one name with several types, so callers that know the type pass it) */
  staticGlobal(owner: string, name: string, desc?: string): number {
    const f = this.prog.get(owner)?.fields.find((x) => x.isStatic && x.name === name && (desc === undefined || x.desc === desc));
    if (!f) throw new Error(`static ${owner}.${name} not found`);
    return this.classGlobal(owner, "s:" + name + ":" + f.desc, this.vtOf(f.kind));
  }
  /** calls `m`: directly when this module defines it, else through its table slot (a lazy-link stub until it is compiled) */
  callMethod(c: Code, m: MethodInfo): void {
    const f = this.fn.get(mid(m));
    if (f !== undefined) c.call(f); else c.i32(this.w.slotOf(m)).callIndirect(this.methodSig(m));
  }
  /** the only implementation of decl.name+desc among all loaded classes, or "many": none yet is a dispatch like any other, since a class made later (a proxy
   *  class, a dex) may implement it, even for a frame that is already running */
  devirt(decl: string, name: string, desc: string): MethodInfo | "many" {
    const t = this.w.cha.targets(decl, name, desc);
    if (t.length !== 1) return "many";
    this.assumptions.push([decl, name, desc, t[0], this.assumer]);
    return t[0];
  }
  /** the likely implementations of a virtual call that this unit contains, for a guarded direct call (see World.likely) */
  guards(decl: string, name: string, desc: string): MethodInfo[] {
    return (this.w.plan.get(`${decl}.${name}${desc}`) ?? []).filter((m) => this.fn.has(mid(m)));
  }
  /** counts down `m`'s budget by one and asks the host to upgrade the method when it reaches zero */
  emitCount(c: Code, m: MethodInfo): void {
    const slot = this.w.slotOf(m), g = this.global("cnt", String(slot), T.i32, true);
    this.counted.add(slot);
    c.gget(g).i32(1).raw(OP.i32_sub).gset(g).gget(g).raw(OP.i32_eqz).if_().i32(slot).call(this.imp.hot).end();
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
    this.w.allocated.add(cls);
    c.call(this.local("new:" + cls, [], "L", (n) => {
      const lay = this.prog.layout(cls);
      this.allocBytes(n, () => n.i32(8 + lay.reduce((b, f) => b + (f.kind === "J" ? 8 : 4), 0)));
      n.gget(this.vtGlobal(cls)).refAsNonNull().i32(0);
      for (const f of lay) { if (f.kind === "I") n.i32(0); else if (f.kind === "J") n.i64(0n); else n.anyNull(); }
      n.structNew(this.structFor(cls));
    }, ref(this.structFor(cls))));
  }
  /** push a new array of class `desc` whose length `pushLen` pushes; negative or oversized lengths throw */
  emitNewArray(c: Code, desc: string, pushLen: () => void): void {
    const ek = elemKindOf(desc), shift = { i8: 0, i16: 1, i32: 2, i64: 3, ref: 2 }[ek];
    pushLen();
    c.call(this.local("newarray:" + desc, ["I"], "L", (n) => {
      n.gget(this.vtGlobal(desc)).refAsNonNull().i32(0).lget(0).i32(shift).call(this.helper("newLen")).arrayNewDefault(this.tData[ek]).structNew(this.tArr[ek]);
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
      case "hash": return [t([L], [T.i32]), () => {
        const c = new Code(1), hv = c.newLocal(T.i32), g = this.global("rt", "hash", T.i32, true);
        c.lget(0).refTest(tObj).raw(OP.i32_eqz).if_().lget(0).call(this.helper("shash")).ret().end();
        c.lget(0).refCast(tObj).structGet(tObj, 1).ltee(hv).raw(OP.i32_eqz).if_()
          .gget(g).i32(0x3c6ef372 | 0).raw(OP.i32_add).ltee(hv).gset(g).lget(0).refCast(tObj).lget(hv).structSet(tObj, 1).end();
        return c.lget(hv).finish();
      }];
      // newLen(len, shift): the length itself once it is a legal array length and the allocation fits the budget
      case "newLen": return [t([T.i32, T.i32], [T.i32]), () => {
        const c = new Code(2), bytes = c.newLocal(T.i64), g = this.global("rt", "alloc", T.i32, true);
        c.lget(0).i32(0).raw(OP.i32_lt_s).if_().lget(0); this.callThrower(c, "nase"); c.end();
        c.lget(0).raw(OP.i64_extend_i32_u).lget(1).raw(OP.i64_extend_i32_u, OP.i64_shl).lset(bytes);
        c.lget(bytes).i64(BigInt(MAX_ARRAY_BYTES)).raw(OP.i64_gt_u).if_().lget(bytes); this.callThrower(c, "oom"); c.end();
        c.gget(g).lget(bytes).raw(OP.i32_wrap_i64, OP.i32_add).gset(g).gget(g).i32(0).raw(OP.i32_ge_s).if_().call(this.helper("allocSlow")).end();
        return c.lget(0).finish();
      }];
      // allocSlow(): the allocation window is used up; the host decides whether the heap really is
      case "allocSlow": return [t([], []), () => {
        const c = new Code(0), g = this.global("rt", "alloc", T.i32, true);
        c.i32(-ALLOC_WINDOW).gset(g).call(this.imp.heapCheck).if_().i64(BigInt(ALLOC_WINDOW)); this.callThrower(c, "oom"); c.end();
        return c.finish();
      }];
    }
    const s = stringHelper(this, name, t);
    if (s) return s;
    throw new Error("unknown helper " + name);
  }

  // ---------- units
  /** compile `methods` into this module (the first is the one a lazy-link stub asks for); each is exported as "m<slot>". `copies` are compiled
   *  beside them for the unit's own calls and not exported; what they assume about the class hierarchy counts against `methods[0]`. A `hot`
   *  unit is the second tier: its methods do not count. */
  buildUnit(methods: MethodInfo[], copies: MethodInfo[] = [], hot = false): { bytes: Uint8Array; traces: FnTrace[] } {
    const { mb, w } = this, all = methods.concat(copies);
    this.counting = !hot;
    this.natives.declare(this, all);
    // the second tier's names differ from the first's, and a copy's from the installed method's, so a stack frame finds its own offsets (traces are keyed by name)
    const label = (m: MethodInfo, i: number) => (hot || i >= methods.length ? `${mid(m)}#${w.stats.units}` : mid(m));
    all.forEach((m, i) => this.fn.set(mid(m), mb.reserveFunc(this.methodSig(m), label(m, i))));
    const codes = all.map((m) => { this.owner = m; this.assumer = methods[0]; return compileMethod(this, m); });
    all.forEach((m, i) => { const f = this.fn.get(mid(m))!; mb.setBody(f, codes[i].finish()); if (i < methods.length) mb.export("m" + w.slotOf(m), "func", f); });
    return this.finishModule(all.map((m, i) => ({ name: label(m, i), f: this.fn.get(mid(m))!, code: codes[i], m })));
  }
  /** a body made of generated code (the implicit-exception throwers, field readers); `ret` is its result kind */
  buildSynthetic(name: string, params: Kind[], body: (c: Code) => void, ret: Kind | "V" = "V"): { bytes: Uint8Array; traces: FnTrace[] } {
    const f = this.mb.reserveFunc(this.sig(params, ret), "$" + name), c = new Code(params.length);
    body(c);
    this.mb.setBody(f, c.finish());
    this.mb.export("m", "func", f);
    return this.finishModule([{ name: "$" + name, f, code: c }]);
  }
  private finishModule(fns: { name: string; f: number; code: Code; m?: MethodInfo }[]): { bytes: Uint8Array; traces: FnTrace[] } {
    // V8 13.6 gives a module without a start function a quarter of the inlining budget, which halves a recursive method's speed (fib(32): 9.7 ms
    // against 5.4 ms); an empty start function restores it
    this.mb.start = this.mb.addFunc(this.mb.addFuncType([], []), [0, 0x0b], "$start");
    const bytes = this.mb.build();
    return { bytes, traces: fns.map(({ name, f, code, m }) => {
      const start = this.mb.bodyOffsets[f - this.mb.nImportedFuncs] + code.prefixLen;
      return { name, m, offsets: Int32Array.from({ length: code.marks.length / 2 }, (_, i) => start + code.marks[2 * i]), pcs: Int32Array.from({ length: code.marks.length / 2 }, (_, i) => code.marks[2 * i + 1]) };
    }) };
  }
}

/** the side table that maps a Wasm frame offset of one function back to a DEX pc: offsets ascend, pcs[i] belongs to offsets[i] */
export interface FnTrace { name: string; m?: MethodInfo; offsets: Int32Array; pcs: Int32Array }
