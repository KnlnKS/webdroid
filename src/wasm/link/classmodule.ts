// Class modules: the globals of a class (its vtable, init word and static fields) and the ensure() that initializes it (JLS 12.4.2).
import { HT, ModuleBuilder, T, ref, refNull, sleb, uleb } from "../compiler/wasmbin.ts";
import { Code, OP } from "../compiler/code.ts";
import { methodKinds, type Kinds, type Kind, type JClass, type FieldInfo } from "../compiler/program.ts";
import { f32bits, f64bits } from "../compiler/consts.ts";
import { Compiler, declareBase, kindVT, type Base } from "../compiler/j2w.ts";
import { SYSTEM_LOADER } from "./sched.ts";
import { rtfns } from "../compiler/rtfns.ts";
import { hasSignatureConstraints } from "./signatures.ts";
import { INIT_DONE, INIT_FAILED } from "../compiler/exc.ts";
import { stubKey, kindsType } from "./stubs.ts";
import type { ClassRt, World } from "./world.ts";

/** what ensure()'s body uses of the module it is compiled into (ClassModules.emitEnsure) */
interface InitScope { mb: ModuleBuilder; b: Base; initG: number; sid: number; iw: number; tag: number; statics(f: FieldInfo): number; literal(c: Code, s: string): void }
/** the vtable words of a class module above which its start function makes the vtables (ClassModules.classModule) */
const VT_DATA_WORDS = 4096;

export class ClassModules {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** the record of class `name` linked on demand: its globals are made when something first reads them, in one module with those of the other classes linked
   *  meanwhile, and its slots start with shared stubs */
  lazy(name: string, id: number, slotBase: number, jc: JClass | undefined): ClassRt {
    let exports: WebAssembly.Exports | undefined;
    const self = this, rt: ClassRt = { name, id, mod: "c" + id, from: "own", slotBase, nMethods: jc?.methods.length ?? 0,
      get exports() { if (!exports) self.buildClasses(); return exports!; }, set exports(x) { exports = x; } };
    this.unbuilt.push(rt);
    this.stubClass(rt, jc);
    return rt;
  }
  /** classes linked on demand whose globals no module holds yet (World.link) */
  private unbuilt: ClassRt[] = [];
  buildClasses(): void {
    const t0 = performance.now();
    // a vtable can link the classes it names
    while (this.unbuilt.length) {
      const rts = this.unbuilt;
      this.unbuilt = [];
      const t1 = performance.now(), bytes = this.classModule(rts, true);
      this.w.stats.phase.classBuild += performance.now() - t1;
      const exports = this.w.instantiate(bytes, {}).exports;
      for (const rt of rts) rt.exports = exports;
    }
    this.w.stats.classMs += performance.now() - t0;
  }
  /** the vtable of a class module the platform build holds was made before this World's host classes: the entries of the methods they implement (abstract in the build) are put right */
  repair(name: string): void {
    if (!this.w.instantiates) return;
    const repairs = this.w.hosts.vtableRepairs(name);
    if (!repairs.length) return;
    const set = this.w.helpers.hostFn("vt:set:" + name, ["I", "I"], "V", (cx, c) => { c.gget(cx.vtGlobal(name)).refAsNonNull().lget(0).lget(1).arraySet(cx.tVT); });
    for (const [at, slot] of repairs) set(at, slot);
  }
  /** a host class defined after classes were linked from the build: repairs the vtables of the ones it concerns */
  repairLinked(): void { for (const [name, rt] of this.w.classes) if (rt.from !== "own") this.repair(name); }
  /** The bytes of a module that defines classes `rts`: what a build (aot-build, apps.ts) stores beside its unit modules and instantiates in the same
   *  order (importing the same table). A `lean` module (a class linked on demand) holds only the class's globals, since a module with code costs the
   *  engine far more: its slots get shared stubs and its ensure() is compiled on first call. */
  classModule(rts: ClassRt[], lean = false): Uint8Array {
    const mb = new ModuleBuilder(), b = declareBase(mb);
    let sid = -1, iw = -1, tag = -1;
    if (!lean) {
      mb.importGlobal("rt", "callee", T.i32, true);
      mb.importTable("rt", "table", T.funcref, 0);
      sid = mb.importGlobal("rt", "sid", T.i32, true); iw = mb.importGlobal("rt", "iw", T.i32, true); tag = mb.importTag("rt", "tag", b.tTagFn);
    }
    // the String constants of the static values are imported before the module defines a global of its own, and the shared stubs a method's slot
    // starts with before it defines a function
    const consts = new Map<string, number>(), stubFns = new Map<string, number>();
    let fromChars = -1, nop = -1;
    if (!lean) for (const { name } of rts) {
      const jc = this.w.prog.get(name);
      for (const m of jc?.methods ?? []) {
        const k = methodKinds(m), key = stubKey(k);
        if (!stubFns.has(key)) stubFns.set(key, mb.importFunc("stub", key, kindsType(mb, k)));
      }
      if (jc?.def?.staticValuesOff) for (const v of jc.dex!.encodedArray(jc.def.staticValuesOff)) {
        if (typeof v !== "string" || consts.has(v)) continue;
        // a constant with a lone surrogate cannot be an import name: its units come from a data segment
        if (v.isWellFormed()) consts.set(v, mb.importGlobal("#", v, ref(HT.extern), false));
        else if (fromChars < 0) fromChars = mb.importFunc("wasm:js-string", "fromCharCodeArray", mb.addFuncType([refNull(b.tData.i16), T.i32, T.i32], [ref(HT.extern)]));
      }
    }
    const literal = (c: Code, v: string) => {
      if (v.isWellFormed()) c.gget(consts.get(v)!); else c.i32(0).i32(v.length).arrayNewData(b.tData.i16, mb.addDataPassive(Uint8Array.from({ length: 2 * v.length }, (_, k) => (v.charCodeAt(k >> 1) >> (8 * (k & 1))) & 255))).i32(0).i32(v.length).call(fromChars);
      c.anyConvertExtern().i32(this.w.synthSlot("strLit", rtfns.get("strLit")!)).callIndirect(mb.addFuncType([T.anyref], [T.anyref]));
    };
    const nullInit = (t: number) => { const o = [0xd0]; sleb(t, o); return o; };
    const zero = (k: Kind) => (k === "I" ? [0x41, 0] : k === "J" ? [0x42, 0] : [0xd0, 0x6e]);
    const words = rts.map(({ name, id }) => name[0] === "[" || !this.w.prog.get(name)?.isInterface ? this.w.dispatch.vtWords(name, id) : undefined);
    // The engine evaluates a constant initializer's operands one by one at instantiation, and admits at most 10,000 in array.new_fixed. A module with
    // many vtables makes them in its start function from one data segment instead, which costs a function to compile.
    const total = words.reduce((n, w) => n + (w?.length ?? 0), 0), fromData = total > VT_DATA_WORDS || words.some((w) => w && w.length > 10_000);
    const vts: { g: number; words: Int32Array }[] = [];
    for (const [i, rt] of rts.entries()) {
      const { name, id, slotBase } = rt, jc = this.w.prog.get(name), methods = jc?.methods ?? [], w = words[i];
      if (w) {
        const init = fromData ? nullInit(b.tVT) : [];
        if (!fromData) { for (const x of w) { init.push(0x41); sleb(x, init); } init.push(0xfb, 0x08); uleb(b.tVT, init); uleb(w.length, init); }
        const g = mb.addGlobal(refNull(b.tVT), true, init);
        if (fromData) vts.push({ g, words: w });
        mb.export(id + ":vt", "global", g);
      }
      // a class with nothing to initialize (no static values or <clinit>, nor supertypes that have) starts initialized: there is no event to wait for or report
      const initialize = !!jc && this.w.needsInit(name), initG = mb.addGlobal(T.i32, true, [0x41, initialize ? 0 : INIT_DONE]);
      mb.export(id + ":init", "global", initG);
      const statics = new Map<FieldInfo, number>();
      for (const f of jc?.fields ?? []) if (f.isStatic) {
        const g = mb.addGlobal(kindVT(f.kind), true, zero(f.kind)); statics.set(f, g); mb.export(id + ":s:" + f.name + ":" + f.desc, "global", g);
      }
      if (lean) continue;
      const stubs = methods.map((m) => stubFns.get(stubKey(methodKinds(m)))!);
      if (initialize) {
        const c = new Code(0);
        this.emitEnsure({ mb, b, initG, sid, iw, tag, statics: (f) => statics.get(f)!, literal }, jc!, rt, c);
        stubs.push(mb.addFunc(mb.addFuncType([], []), c.finish()));
      } else if (jc) stubs.push(nop < 0 ? (nop = mb.addFunc(mb.addFuncType([], []), new Code(0).finish())) : nop);
      if (stubs.length) mb.addElemActive(0, slotBase, stubs);
    }
    if (vts.length) {
      const all = new Int32Array(total), c = new Code(0);
      let at = 0;
      for (const v of vts) { all.set(v.words, at); at += v.words.length; }
      const seg = mb.addDataPassive(new Uint8Array(all.buffer));
      at = 0;
      for (const v of vts) { c.i32(4 * at).i32(v.words.length).arrayNewData(b.tVT, seg).gset(v.g); at += v.words.length; }
      mb.start = mb.addFunc(mb.addFuncType([], []), c.finish(), "$vt");
    }
    return mb.build();
  }
  /** the stubs of a class linked on demand, whose module holds no code: shared ones in its method slots and its ensure slot (a function that does nothing
   *  for a class with nothing to initialize) */
  stubClass(rt: ClassRt, jc: JClass | undefined): void {
    const want: Kinds[] = (jc?.methods ?? []).map(methodKinds), ensure = rt.slotBase + rt.nMethods;
    if (jc && this.w.needsInit(rt.name)) want.push({ params: [], ret: "V" });
    else if (jc) this.w.table.set(ensure, this.w.rt.nop);
    this.w.stubs.stubsFor(want).forEach((f, i) => this.w.table.set(rt.slotBase + i, f));
  }
  /** the body of ensure() of class `cls` in a unit `cx` compiles (Compiler.buildUnit), which imports the class's globals */
  ensureBody(cx: Compiler, cls: string, c: Code): void {
    const jc = this.w.prog.require(cls), rt = this.w.link(cls);
    this.emitEnsure({ mb: cx.mb, b: cx, initG: cx.initGlobal(cls), sid: cx.global("rt", "sid", T.i32, true), iw: cx.global("rt", "iw", T.i32, true), tag: cx.tag,
      statics: (f) => cx.staticGlobal(cls, f.name, f.desc), literal: (c, v) => cx.str.literal(c, v) }, jc, rt, c);
  }
  /** ensure(): class initialization (JLS 12.4.2). The init word says who is initializing the class: a request from that thread returns at
   *  once (re-entry and cycles see the half-initialized class), one from another waits in initWait (the scheduler's hook). Superclass and
   *  default-method superinterfaces first, then the dex's static values and <clinit>. A throw marks the class failed and goes to initFail
   *  (an Error propagates, anything else becomes ExceptionInInitializerError); later requests throw NoClassDefFoundError. */
  private emitEnsure(x: InitScope, jc: JClass, rt: ClassRt, c: Code): void {
    const { mb, b, initG, sid, iw, tag } = x, voidSig = mb.addFuncType([], []), e = c.newLocal(T.anyref);
    const call = (slot: number, sig = voidSig) => c.i32(slot).callIndirect(sig);
    const rtfn = (name: string) => this.w.synthSlot(name, rtfns.get(name)!);
    if (hasSignatureConstraints(this.w, jc.name)) {
      c.gget(initG).raw(OP.i32_eqz).if_();
      c.block().block(T.anyref).tryTable(null, [[0, tag, 0]]);
      c.i32(rt.id); call(rtfn("validateSignatures"), mb.addFuncType([T.i32], [])); c.br(2);
      c.end().unreachable().end().lset(e).i32(INIT_FAILED).gset(initG);
      c.lget(e); call(rtfn("initFail"), b.tTagFn); c.end().end();
    }
    c.block().block().loop();                                   // exit, claim, retry
    c.gget(initG).i32(INIT_DONE).raw(OP.i32_eq).brIf(2);
    c.gget(initG).i32(INIT_FAILED).raw(OP.i32_eq).if_(); c.i32(rt.id); call(rtfn("initErroneous"), mb.addFuncType([T.i32], [])); c.end();
    c.gget(initG).raw(OP.i32_eqz).brIf(1);
    c.gget(initG).i32(2).raw(OP.i32_shr_u).gget(sid).raw(OP.i32_eq).brIf(2);
    c.i32(rt.id); call(rtfn("initWait"), mb.addFuncType([T.i32], [T.i32])); c.brIf(2).br(0);
    c.end().end();
    c.gget(sid).i32(2).raw(OP.i32_shl).i32(1).raw(OP.i32_or).gset(initG);
    c.block(T.anyref).tryTable(null, [[0, tag, 0]]);
    if (jc.sup && this.w.needsInit(jc.sup)) call(this.w.ensureSlot(jc.sup));
    for (const i of this.w.prog.defaultIfaces(jc.name)) if (this.w.needsInit(i)) call(this.w.ensureSlot(i));
    if (jc.def?.staticValuesOff) {
      const sfields = jc.fields.filter((f) => f.isStatic);
      jc.dex!.encodedArray(jc.def.staticValuesOff).forEach((v, i) => {
        const fi = sfields[i];
        if (!fi || v === null || v === 0 || v === 0n || v === false) return;
        if (typeof v === "number" || typeof v === "boolean") {
          if (fi.desc === "F") c.i32(f32bits(v as number)); else if (fi.desc === "D") c.i64(f64bits(v as number));
          else if (fi.desc === "J") c.i64(BigInt(v as number)); else c.i32(Number(v));
        } else if (typeof v === "bigint") c.i64(fi.desc === "D" ? f64bits(Number(v)) : v);
        else if (typeof v === "string") x.literal(c, v);
        else return;
        c.gset(x.statics(fi));
      });
    }
    const ci = jc.byKey.get("<clinit>()V");
    if (ci) call(rt.slotBase + ci.index);
    const wake = () => { c.gget(iw).if_().i32(rt.id); call(rtfn("initWake"), mb.addFuncType([T.i32], [])); c.end(); };
    c.i32(INIT_DONE).gset(initG);
    if (jc.name === SYSTEM_LOADER) call(rtfn("threadLoaderReady"));
    wake(); c.br(2);
    c.end().unreachable().end();                                // the thrown Throwable is on the stack
    c.lset(e).i32(INIT_FAILED).gset(initG); wake(); c.lget(e); call(rtfn("initFail"), b.tTagFn);
    c.end();
  }
}
