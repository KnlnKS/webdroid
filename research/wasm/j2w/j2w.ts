// DEX -> WebAssembly (GC) whole-program prototype compiler. Research code: see ../REPORT.md
import { ModuleBuilder, T, ref, refNull, type VT } from "./wasmbin";
import { Code, OP } from "./code";
import { Program, ACC, kindOf, type Kind, type MethodInfo, type JClass } from "./program";
import { reach, mid, type Reach } from "./reach";
import { descToName, parseMethodDesc } from "../../../src/jvm/abi";
import { prepareMethod, branchTargets, endsBlock, ifTarget, switchCases, type PreparedInstruction as Ins, type PreparedMethod } from "../../../src/jvm/prepared";
import { structure, Go, type Flow } from "../../../src/jvm/structure";
import type { DexFile } from "../../../src/jvm/dex";

import { H, f32bits, f64bits, type ElemKind } from "./consts";
import { compileMethod } from "./method";
import { sleb } from "./wasmbin";
import { ClassModel, implied } from "./classes";
import { InitModel } from "./init";

/** the name a built module exports an entry under */
export const exportName = (cls: string, name: string, desc: string) => `${cls.replace(/\//g, ".")}.${name}${desc}`;
/** the exceptions the compiler's own helpers throw, by helper name */
export const THROWN = { npe: "java/lang/NullPointerException", aioobe: "java/lang/ArrayIndexOutOfBoundsException", arith: "java/lang/ArithmeticException",
  cce: "java/lang/ClassCastException", nase: "java/lang/NegativeArraySizeException", ule: "java/lang/UnsatisfiedLinkError",
  ase: "java/lang/ArrayStoreException", ncdfe: "java/lang/NoClassDefFoundError", inste: "java/lang/InstantiationException" };
export const SEED_CLASSES = ["java/lang/Object", ...Object.values(THROWN), "java/lang/ExceptionInInitializerError", "java/lang/Class"];
/** methods the generated runtime code calls */
export const SEED_METHODS: [string, string, string][] = [["java/lang/Class", "isAssignableFrom", "(Ljava/lang/Class;)Z"]];
export interface Intrinsic { (cx: Compiler, m: MethodInfo, c: Code): void }
export interface Options { intrinsics: Map<string, Intrinsic>; stats?: boolean }

export class Compiler {
  mb = new ModuleBuilder();
  r!: Reach;
  tVT = 0; tObj = 0; tTagFn = 0; tag = 0;
  tData = {} as Record<ElemKind, number>; tArr = {} as Record<ElemKind, number>;
  classStruct = new Map<string, number>();
  classId = new Map<string, number>();
  vtGlobal = new Map<string, number>();
  staticGlobal = new Map<string, number>();           // "owner.name" -> global idx
  fn = new Map<string, number>();                      // method id -> func idx
  fnType = new Map<string, number>();
  sigType = new Map<string, number>();
  selector = new Map<string, number>();
  stats = { methods: 0, unstructured: 0, bytes: 0, tryMethods: 0, bodyBytes: 0 };
  helpers: Record<string, number> = {};
  vtData: number[][] = [];
  throwFns = new Map<string, number>();
  hostImports: Record<string, number> = {};
  /** constructs this compiler cannot translate yet: each compiles to a call of host.gap(id) and a throw, never to a guess */
  gaps = new Map<string, number>();
  cm = new ClassModel(this);
  init = new InitModel(this);
  constructor(public prog: Program, public opts: Options) {}

  gap(c: Code, what: string): void {
    let id = this.gaps.get(what); if (id === undefined) this.gaps.set(what, id = this.gaps.size);
    c.i32(id).call(this.hostImports.gap).call(this.helpers.ule).unreachable();
  }

  // ---------- type helpers
  vtOf(k: Kind): VT { return k === "I" ? T.i32 : k === "J" ? T.i64 : refNull(this.tObj); }
  sig(params: Kind[], ret: Kind | "V"): number {
    const key = params.join("") + ">" + ret;
    let s = this.sigType.get(key);
    if (s === undefined) s = this.mb.addFuncType(params.map((k) => this.vtOf(k)), ret === "V" ? [] : [this.vtOf(ret)]);
    this.sigType.set(key, s); return s;
  }
  methodSig(m: MethodInfo): number {
    const ps: Kind[] = m.isStatic ? [] : ["L"]; for (const p of m.params) ps.push(kindOf(p));
    return this.sig(ps, m.ret === "V" ? "V" : kindOf(m.ret));
  }
  structFor(cls: string): number {
    let t = this.classStruct.get(cls); if (t !== undefined) return t;
    if (cls === "java/lang/Object") { this.classStruct.set(cls, this.tObj); return this.tObj; }
    const c = this.prog.get(cls);
    if (!c || c.isInterface) { this.classStruct.set(cls, this.tObj); return this.tObj; }
    const sup = this.structFor(c.sup ?? "java/lang/Object");
    const own = this.prog.layout(cls);
    const fields = [{ t: ref(this.tVT) as VT, mut: false }, { t: T.i32 as VT, mut: true }, ...own.map((f) => ({ t: this.vtOf(f.kind), mut: true }))];
    // a class with no own fields shares its super's struct type
    const parentFields = c.sup ? this.prog.layout(c.sup).length : 0;
    if (own.length === parentFields) { this.classStruct.set(cls, sup); return sup; }
    t = this.mb.addType({ k: "struct", fields, sup, final: false });
    this.classStruct.set(cls, t); return t;
  }
  /** struct field index of an instance field (header = 2 fields) */
  fieldIndex(cls: string, f: { owner: string; name: string; desc: string }): number {
    const lay = this.prog.layout(cls);
    // match by owner chain: the last matching (owner,name) in layout order
    let idx = -1;
    lay.forEach((x, i) => { if (x.owner === f.owner && x.name === f.name && x.desc === f.desc) idx = i; });
    if (idx < 0) throw new Error(`field ${f.owner}.${f.name} not in layout of ${cls}`);
    return idx + 2;
  }

  // ---------- build
  build(entries: [string, string, string][]): Uint8Array {
    const { prog, mb } = this;
    // base types
    this.tVT = mb.addType({ k: "array", elem: { t: T.i32, mut: true } });
    this.tObj = mb.addType({ k: "struct", fields: [{ t: ref(this.tVT), mut: false }, { t: T.i32, mut: true }], final: false });
    this.classStruct.set("java/lang/Object", this.tObj);
    const dataElem: Record<ElemKind, VT> = { i8: T.i8, i16: T.i16, i32: T.i32, i64: T.i64, ref: refNull(this.tObj) };
    for (const k of ["i8", "i16", "i32", "i64", "ref"] as ElemKind[]) {
      this.tData[k] = mb.addType({ k: "array", elem: { t: dataElem[k], mut: true } });
      this.tArr[k] = mb.addType({ k: "struct", fields: [{ t: ref(this.tVT), mut: false }, { t: T.i32, mut: true }, { t: ref(this.tData[k]), mut: false }], sup: this.tObj, final: false });
    }
    this.tTagFn = mb.addFuncType([refNull(this.tObj)], []);
    // host imports (declared before any defined function)
    this.hostImports.fmod = mb.importFunc("host", "fmod", mb.addFuncType([T.f64, T.f64], [T.f64]));
    this.hostImports.gap = mb.importFunc("host", "gap", mb.addFuncType([T.i32], []));
    this.tag = mb.addTag(this.tTagFn); mb.export("jex", "tag", this.tag);

    const roots = entries.map(([c, n, d]) => { const m = prog.resolve(c, n, d); if (!m) throw new Error(`entry ${c}.${n}${d} not found`); return m; });
    const isIntr = (m: MethodInfo) => this.opts.intrinsics.has(m.cls + "." + m.key);
    this.r = reach(prog, roots, {
      instantiate: SEED_CLASSES, methods: SEED_METHODS,
    }, isIntr, implied);
    const r = this.r;
    this.cm.extendReach(r);
    // class ids: referenced classes + array classes, supers first
    const order: string[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => { if (seen.has(n)) return; seen.add(n); const c = prog.get(n); if (c?.sup) visit(c.sup); c?.ifaces.forEach(visit); if (n[0] !== "[") order.push(n); };
    for (const n of r.referenced) visit(n);
    for (const n of order) this.classId.set(n, this.classId.size + 1);
    // array descriptors: ensure the primitive arrays used by new-array exist; object arrays by descriptor
    const arrayTypes = new Set(r.arrayTypes);
    for (const a of arrayTypes) this.classId.set(a, this.classId.size + 1);
    // globals: vt per class, init state per class with init work, statics
    for (const [n] of this.classId) this.vtGlobal.set(n, mb.addGlobal(refNull(this.tVT), true, [0xd0, ...this.nullHt(this.tVT)]));
    // function indices
    for (const m of r.methods.values()) this.declareMethod(m);
    this.declareHelpers();
    this.cm.declare();
    for (const n of r.initClasses) this.init.declare(n);
    for (const key of r.staticFields) { const [owner, name] = [key.slice(0, key.lastIndexOf(".")), key.slice(key.lastIndexOf(".") + 1)]; this.declareStatic(owner, name); }
    // bodies
    this.emitHelpers();
    this.cm.emit();
    for (const m of r.methods.values()) this.emitMethod(m);
    for (const n of r.initClasses) this.init.emit(n);
    this.emitVTables();
    // table: identity
    const total = mb.nImportedFuncs + mb.funcTypes.length;
    const tbl = mb.addTable(T.funcref, total);
    mb.addElemActive(tbl, 0, Array.from({ length: total }, (_, i) => i));
    for (const [c, n, d] of entries) { const m = prog.resolve(c, n, d)!; mb.export(exportName(c, n, d), "func", this.fn.get(mid(m))!); }
    mb.export("table", "table", tbl);
    return mb.build();
  }
  nullHt(t: number): number[] { const o: number[] = []; sleb(t, o); return o; }
  emitMethod(m: MethodInfo): void { this.mb.setBody(this.fnOf(m), compileMethod(this, m)); }

  declareMethod(m: MethodInfo): void {
    const id = mid(m);
    if (this.fn.has(id)) return;
    const idx = this.mb.reserveFunc(this.methodSig(m), `${m.cls}.${m.name}`);
    this.fn.set(id, idx);
  }
  fnOf(m: MethodInfo): number { const f = this.fn.get(mid(m)); if (f === undefined) throw new Error("method not declared: " + mid(m)); return f; }
  declareStatic(owner: string, name: string): void {
    const key = owner + "." + name; if (this.staticGlobal.has(key)) return;
    const f = this.prog.get(owner)?.fields.find((x) => x.isStatic && x.name === name);
    if (!f) { this.staticGlobal.set(key, -1); return; }
    const init = f.kind === "I" ? [0x41, 0] : f.kind === "J" ? [0x42, 0] : [0xd0, ...this.nullHt(this.tObj)];
    this.staticGlobal.set(key, this.mb.addGlobal(this.vtOf(f.kind), true, init));
  }
  /** the dex's static initial values of class `n`, written into its static globals */
  emitStatics(code: Code, n: string): void {
    const c = this.prog.get(n)!;
    if (!c.def?.staticValuesOff) return;
    const vals = c.dex!.encodedArray(c.def.staticValuesOff);
    const sfields = c.fields.filter((f) => f.isStatic);
    vals.forEach((v, i) => {
      const fi = sfields[i]; if (!fi || v === null || v === 0 || v === 0n || v === false) return;
      const gi = this.staticGlobal.get(n + "." + fi.name); if (gi === undefined || gi < 0) return;
      if (typeof v === "number" || typeof v === "boolean") {
        const d = fi.desc;
        if (d === "F") code.i32(f32bits(v as number)); else if (d === "D") code.i64(f64bits(v as number));
        else if (d === "J") code.i64(BigInt(v as number)); else code.i32(Number(v));
        code.gset(gi);
      } else if (typeof v === "bigint") { if (fi.desc === "D") code.i64(f64bits(Number(v))); else code.i64(v); code.gset(gi); }
      else if (typeof v === "string") this.gaps.set(`${n}.${fi.name}: static string value`, this.gaps.size);
    });
  }
  /** emit "ensure class initialized" at a use site */
  emitEnsure(c: Code, cls: string): void { this.init.ensure(c, cls); }

  // ---------- helpers (throwing, instance-of, division, compares)
  declareHelpers(): void {
    const mb = this.mb, h = this.helpers;
    const L = (): VT => refNull(this.tObj);
    const add = (name: string, params: VT[], results: VT[]) => { h[name] = mb.reserveFunc(mb.addFuncType(params, results), "$" + name); };
    for (const k in THROWN) add(k, [], []);
    add("idiv", [T.i32, T.i32], [T.i32]); add("irem", [T.i32, T.i32], [T.i32]); add("ldiv", [T.i64, T.i64], [T.i64]); add("lrem", [T.i64, T.i64], [T.i64]);
    add("iof", [L(), T.i32, T.i32], [T.i32]);            // obj, class id, depth
    add("implements", [L(), T.i32], [T.i32]);            // obj, interface id
    add("imtslow", [ref(this.tVT), T.i32], [T.i32]);     // vt, selector -> func idx
    add("cmplf", [T.f32, T.f32], [T.i32]); add("cmpgf", [T.f32, T.f32], [T.i32]); add("cmpld", [T.f64, T.f64], [T.i32]); add("cmpgd", [T.f64, T.f64], [T.i32]);
    add("hash", [L()], [T.i32]);
    add("abstract", [], []);
  }
  /** emits allocation + no-arg ctor + throw of exception class `cls` */
  private emitThrower(name: string, cls: string): void {
    const c = new Code(0);
    const ctor = this.prog.resolve(cls, "<init>", "()V");
    const tmp = c.newLocal(refNull(this.tObj));
    this.emitNew(c, cls); c.lset(tmp);
    if (ctor && this.fn.has(mid(ctor))) { c.lget(tmp).call(this.fn.get(mid(ctor))!); }
    c.lget(tmp).throw_(this.tag);
    this.mb.setBody(this.helpers[name], c.finish());
  }
  /** push a new zeroed instance of class `cls` (vt, hash 0, default fields) */
  emitNew(c: Code, cls: string): void {
    const t = this.structFor(cls);
    const vtg = this.vtGlobal.get(cls); if (vtg === undefined) throw new Error("no vt for " + cls);
    const lay = this.prog.layout(cls);
    c.gget(vtg).refAsNonNull().i32(0);
    for (const f of lay) { if (f.kind === "I") c.i32(0); else if (f.kind === "J") c.i64(0n); else c.refNull(this.tObj); }
    c.structNew(t);
  }
  emitHelpers(): void {
    const h = this.helpers, mb = this.mb;
    for (const [k, cls] of Object.entries(THROWN)) this.emitThrower(k, cls);
    mb.setBody(h.abstract, (() => { const c = new Code(0); c.call(h.ule).unreachable(); return c.finish(); })());
    // division
    const div = (name: string, wide: boolean, rem: boolean) => {
      const c = new Code(2);
      const zero = wide ? OP.i64_eqz : OP.i32_eqz;
      c.lget(1).raw(zero).if_().call(h.arith).end();
      // y == -1 : x / -1 = -x (no overflow trap); x % -1 = 0
      c.lget(1); wide ? c.i64(-1n) : c.i32(-1); c.raw(wide ? OP.i64_eq : OP.i32_eq).if_(wide ? T.i64 : T.i32);
      if (rem) wide ? c.i64(0n) : c.i32(0);
      else { wide ? c.i64(0n) : c.i32(0); c.lget(0).raw(wide ? OP.i64_sub : OP.i32_sub); }
      c.else_().lget(0).lget(1).raw(wide ? (rem ? OP.i64_rem_s : OP.i64_div_s) : (rem ? OP.i32_rem_s : OP.i32_div_s)).end();
      mb.setBody(h[name], c.finish());
    };
    div("idiv", false, false); div("irem", false, true); div("ldiv", true, false); div("lrem", true, true);
    // compares
    const cmp = (name: string, lt: number, gt: number, eq: number, nanGreater: boolean) => {
      const c = new Code(2);
      c.lget(0).lget(1).raw(eq).if_(T.i32).i32(0).else_();
      // not equal: NaN -> -1 (cmpl) / +1 (cmpg)
      if (nanGreater) { c.lget(0).lget(1).raw(lt).if_(T.i32).i32(-1).else_().i32(1).end(); }
      else { c.lget(0).lget(1).raw(gt).if_(T.i32).i32(1).else_().i32(-1).end(); }
      c.end(); mb.setBody(h[name], c.finish());
    };
    cmp("cmplf", OP.f32_lt, OP.f32_gt, OP.f32_eq, false); cmp("cmpgf", OP.f32_lt, OP.f32_gt, OP.f32_eq, true);
    cmp("cmpld", OP.f64_lt, OP.f64_gt, OP.f64_eq, false); cmp("cmpgd", OP.f64_lt, OP.f64_gt, OP.f64_eq, true);
    // iof(obj, id, depth): obj != null && vt[1] >= depth && vt[2+depth] == id.  depth is constant per site, but passed for generality
    {
      const c = new Code(3); const vt = c.newLocal(refNull(this.tVT));
      c.lget(0).refIsNull().if_().i32(0).ret().end();
      c.lget(0).refAsNonNull().structGet(this.tObj, 0).lset(vt);
      c.lget(vt).refAsNonNull().i32(H.DEPTH).arrayGet(this.tVT).lget(2).raw(OP.i32_lt_s).if_().i32(0).ret().end();
      c.lget(vt).refAsNonNull().lget(2).i32(H.DISPLAY).raw(OP.i32_add).arrayGet(this.tVT).lget(1).raw(OP.i32_eq);
      mb.setBody(h.iof, c.finish());
    }
    // implements(obj, ifaceId): scan vt[extraBase]: [nSlow, pairs..., nIfaces, ids...]
    {
      const c = new Code(2); const vt = c.newLocal(refNull(this.tVT)); const p = c.newLocal(T.i32); const n = c.newLocal(T.i32); const i = c.newLocal(T.i32);
      c.lget(0).refIsNull().if_().i32(0).ret().end();
      c.lget(0).refAsNonNull().structGet(this.tObj, 0).lset(vt);
      c.lget(vt).refAsNonNull().i32(H.EXTRA).arrayGet(this.tVT).lset(p);
      // skip slow pairs
      c.lget(vt).refAsNonNull().lget(p).arrayGet(this.tVT).lset(n);
      c.lget(p).lget(n).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(1).raw(OP.i32_add).lset(p);
      c.lget(vt).refAsNonNull().lget(p).arrayGet(this.tVT).lset(n);
      c.lget(p).i32(1).raw(OP.i32_add).lset(p);
      c.block().loop();
      c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
      c.lget(vt).refAsNonNull().lget(p).lget(i).raw(OP.i32_add).arrayGet(this.tVT).lget(1).raw(OP.i32_eq).if_().i32(1).ret().end();
      c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(0);
      mb.setBody(h.implements, c.finish());
    }
    // imtslow(vt, sel): linear scan of slow pairs
    {
      const c = new Code(2); const p = c.newLocal(T.i32); const n = c.newLocal(T.i32); const i = c.newLocal(T.i32);
      c.lget(0).i32(H.EXTRA).arrayGet(this.tVT).lset(p);
      c.lget(0).lget(p).arrayGet(this.tVT).lset(n);
      c.lget(p).i32(1).raw(OP.i32_add).lset(p);
      c.block().loop();
      c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
      c.lget(0).lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).arrayGet(this.tVT).lget(1).raw(OP.i32_eq).if_()
        .lget(0).lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(1).raw(OP.i32_add).arrayGet(this.tVT).ret().end();
      c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().call(h.abstract).unreachable();
      mb.setBody(h.imtslow, c.finish());
    }
    // identity hash: assign from a counter
    {
      const g = mb.addGlobal(T.i32, true, [0x41, 0]);
      mb.setBody(h.hash, (() => { const cc = new Code(1); const hv = cc.newLocal(T.i32);
        cc.lget(0).refAsNonNull().structGet(this.tObj, 1).ltee(hv).raw(0x45).if_()
          .gget(g).i32(0x3c6ef372 | 0).raw(OP.i32_add).ltee(hv).gset(g)
          .lget(0).refAsNonNull().lget(hv).structSet(this.tObj, 1).end().lget(hv); return cc.finish(); })());
    }
  }

  // ---------- vtables
  private vslotCache = new Map<string, string[]>();
  vslots(n: string): string[] {
    let s = this.vslotCache.get(n); if (s) return s;
    const c = this.prog.get(n);
    s = n === "java/lang/Object" || !c ? [] : [...this.vslots(c.sup ?? "java/lang/Object")];
    if (c && !c.isInterface) {
      for (const m of c.methods) if (!m.isStatic && !m.isCtor && !(m.flags & ACC.PRIVATE) && !s.includes(m.key)) s.push(m.key);
      const addIface = (i: string) => { const ic = this.prog.get(i); if (!ic) return; for (const m of ic.methods) if (!m.isStatic && !s!.includes(m.key)) s!.push(m.key); ic.ifaces.forEach(addIface); };
      for (let k: JClass | undefined = c; k; k = k.sup ? this.prog.get(k.sup) : undefined) k.ifaces.forEach(addIface);
    }
    this.vslotCache.set(n, s); return s;
  }
  slotOf(decl: string, key: string): number {
    const i = this.vslots(decl).indexOf(key);
    if (i < 0) throw new Error(`no vtable slot for ${decl}.${key}`);
    return H.VTAB + i;
  }
  selectorId(key: string): number {
    let s = this.selector.get(key); if (!s) this.selector.set(key, s = this.selector.size + 1); return s;
  }
  private depthOf(n: string): number { return this.prog.chain(n).length - 1; }
  emitVTables(): void {
    const mb = this.mb, prog = this.prog;
    const words: number[] = [], spans: [string, number, number][] = [];
    for (const [key] of this.r.ifaceSelectors) this.selectorId(key);
    const objId = this.classId.get("java/lang/Object")!;
    for (const [n, id] of this.classId) {
      const arr = n[0] === "[";
      const c = prog.get(n);
      if (!arr && (!c || c.isInterface)) continue;
      const chain = arr ? ["java/lang/Object", n] : prog.chain(n).reverse();   // Object first
      const depth = chain.length - 1;
      if (depth > H.MAXD - 1) throw new Error("class hierarchy too deep for fixed display: " + n);
      const slots = this.vslots(arr ? "java/lang/Object" : n);
      const body: number[] = new Array(H.VTAB + slots.length).fill(0);
      body[H.ID] = id; body[H.DEPTH] = depth;
      chain.forEach((cn, i) => { body[H.DISPLAY + i] = cn === n ? id : this.classId.get(cn) ?? 0; });
      slots.forEach((key, i) => {
        const j = key.indexOf("("); const impl = arr ? prog.implFor("java/lang/Object", key.slice(0, j), key.slice(j)) : prog.implFor(n, key.slice(0, j), key.slice(j));
        const f = impl ? this.fn.get(mid(impl)) : undefined;
        body[H.VTAB + i] = f ?? this.helpers.abstract;
      });
      // IMT and slow pairs
      const slow: number[] = [];
      for (const [key, d] of this.r.ifaceSelectors) {
        const impl = arr ? undefined : prog.implFor(n, d.name, d.desc); const f = impl ? this.fn.get(mid(impl)) : undefined;
        if (f === undefined) continue;
        const sel = this.selectorId(key), s = sel % H.IMT_N;
        if (body[H.IMT + 2 * s] === 0) { body[H.IMT + 2 * s] = sel; body[H.IMT + 2 * s + 1] = f; } else slow.push(sel, f);
      }
      // interfaces implemented
      const ifs = this.cm.ifaceIds(n);
      body[H.EXTRA] = body.length;
      body.push(slow.length / 2, ...slow, ifs.size, ...ifs);
      spans.push([n, words.length, body.length]);
      words.push(...body);
    }
    const bytes = new Uint8Array(new Int32Array(words).buffer);
    const seg = mb.addDataPassive(bytes);
    const c = new Code(0);
    for (const [n, off, len] of spans) c.i32(off * 4).i32(len).arrayNewData(this.tVT, seg).gset(this.vtGlobal.get(n)!);
    this.cm.emitStart(c);
    const startFn = mb.addFunc(mb.addFuncType([], []), c.finish(), "$start");
    mb.start = startFn;
  }
}

