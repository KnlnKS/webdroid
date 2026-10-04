// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals, and one lazy-link stub per method, installed in a contiguous block of table slots.
//  - A stub calls host.link(slot), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry,
//    then calls through the slot; every call between modules is `call_indirect slot`, so a compiled method needs no relinking.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
//
// A build-time mode would call Compiler.buildUnit with a whole class group and install the exports without the stubs.
import { ModuleBuilder, T, refNull, sleb, uleb, type VT } from "./wasmbin";
import { Code, OP } from "./code";
import { Program, ACC, kindOf, type Kind, type JClass, type MethodInfo } from "./program";
import { Cha } from "./cha";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_OTHER, f32bits, f64bits } from "./consts";
import { Compiler, declareBase, intrinsicFor, kindVT, type FnTrace, type Intrinsic } from "./j2w";
import { Natives, type HostContext } from "./natives";
import { Bridge } from "./bridge";
import { rtfns, type Synth } from "./rtfns";
import { hostInfo, typeName } from "./classes";
import { mhInvoke } from "./handles";
import { SLOT, FIRST_FREE_SLOT, HOT_BUDGET, INIT_DONE, INIT_FAILED, THROWERS, ALLOC_WINDOW, HEAP_LIMIT, excMessage, throwerBody, javaFrames, isStackOverflow, namesWasmFrames, heapUsed, type JavaFrame, type Thrower } from "./exc";
import { decodeInstructions } from "../../../src/jvm/prepared";
import { descToName, parseMethodDesc } from "../../../src/jvm/abi";
import { mid } from "./reach";
import type { DexFile } from "../../../src/jvm/dex";

export interface WorldOptions {
  intrinsics: Map<string, Intrinsic>;
  /** the production natives, bound to host imports by descriptor (natives.ts) */
  natives?: Natives;
  /** bytes in use on the heap, compared with the heap limit each time a window of allocation is used up */
  heapUsed?: () => number;
  /** frames V8 keeps per exception; Java stacks are deeper than its default of 10 */
  stackTraceLimit?: number;
}
export interface ClassRt { name: string; id: number; mod: string; slotBase: number; methodSlots: Map<string, number>; nMethods: number; exports: WebAssembly.Exports }
type Slot = { k: "method"; m: MethodInfo; done: boolean; hot?: boolean; stub?: Function } | { k: "thrower"; name: Thrower; done: boolean; stub?: Function }
  | { k: "synth"; name: string; d: Synth; done: boolean; stub?: Function } | { k: "ensure" };
/** a hot method is recompiled with up to MAX_GROUP methods in its module: the small callees that ran (callee size in code units), and guards for at most MAX_GUARDS implementations per virtual call */
const MAX_GROUP = 24, SMALL_CALLEE = 100, MAX_GUARDS = 2;
interface Assumption { decl: string; name: string; desc: string; target?: MethodInfo; slots: Set<number> }

export class World {
  prog: Program;
  cha: Cha;
  table = new WebAssembly.Table({ element: "anyfunc", initial: 256 });
  /** constructs the compiler has no translation for: each compiles to host.gap(id) and a throw, never to a guess */
  gaps = new Map<string, number>();
  gapList: string[] = [];
  onGap: (id: number) => void = () => {};
  /** the message the last implicit exception would carry; stored in the Throwable once Strings exist */
  lastMessage: string | null = null;
  stats = { classes: 0, units: 0, methods: 0, bytes: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, classMs: 0, invalidated: 0, upgrades: 0 };
  private slots: (Slot | undefined)[] = [];
  private classes = new Map<string, ClassRt>();
  private ids = new Map<string, number>();
  private names = [""];
  private selectors = new Map<string, number>();
  private selKeys = [""];
  private vslotCache = new Map<string, string[]>();
  private traces = new Map<string, FnTrace>();
  private stacks = new WeakMap<object, Error>();
  private frames: JavaFrame[] = [];
  private assumptions = new Map<string, Assumption>();
  /** the slots whose code fails a site because a class is not loaded, by class name: loading it undoes them */
  private absent = new Map<string, Set<number>>();
  /** the messages of the link errors (linkage.ts) compiled code throws, by index */
  linkMessages: string[] = [];
  /** the strings of String constants, by index, and the table they are read from */
  private strings = new Map<string, number>();
  strs = new WebAssembly.Table({ element: "externref", initial: 64 });
  /** the byte[]s whose addresses VMRuntime.addressOf has given out (memory.ts), by the index the address holds */
  private nm = new WebAssembly.Table({ element: "externref", initial: 16 });
  private pinned = new Map<object, number>();
  /** scratch linear memory natives copy arrays through, and its allocation top */
  mem = new WebAssembly.Memory({ initial: 1 });
  sp = new WebAssembly.Global({ value: "i32", mutable: true }, 8);
  natives: Natives;
  bridge: Bridge;
  private host: Record<string, Function>;
  private rt!: { tag: any; alloc: WebAssembly.Global; hash: WebAssembly.Global; ctab: WebAssembly.Global; tid: WebAssembly.Global; thr: WebAssembly.Global; intr: WebAssembly.Global; classId: (o: object) => number };
  private synth = new Map<string, number>();
  private imtCache = new Map<number, number>();
  private compiled = new Map<MethodInfo, string[]>();

  constructor(prog: Program, public opts: WorldOptions) {
    this.prog = prog;
    this.natives = opts.natives ?? new Natives();
    this.bridge = new Bridge(this, this.natives.source);
    this.cha = new Cha(prog);
    if (opts.stackTraceLimit ?? 128) Error.stackTraceLimit = Math.max(Error.stackTraceLimit, opts.stackTraceLimit ?? 128);
    const names = (id: number) => this.names[id];
    this.host = {
      fmod: (a: number, b: number) => a % b,
      gap: (id: number) => this.onGap(id),
      link: (slot: number) => this.linkSlot(slot),
      hot: (slot: number) => this.upgrade(slot),
      imtMiss: (cls: number, sel: number) => this.imtMiss(cls, sel),
      heapCheck: () => ((opts.heapUsed ?? heapUsed)() > HEAP_LIMIT ? 1 : 0),
      info: (kind: number, a: number, b: number) => hostInfo(this, kind, a, b),
      mhInvoke: (mh: object, args: object, site: number, exact: number) => mhInvoke(this, mh, args, site, exact),
      // Class.forName's binary name ("a.B$C", "[La.B;") as a class id; 0 for a name no loaded dex defines
      pin: (array: object) => {
        let i = this.pinned.get(array);
        if (i === undefined) {
          i = this.pinned.size; this.pinned.set(array, i);
          if (i >= this.nm.length) this.nm.grow(this.nm.length);
          this.nm.set(i, array as never);
        }
        return i;
      },
      classByName: (name: string) => {
        const n = name.replace(/\./g, "/"), e = n.replace(/^\[+/, "");
        return n === "" || (n[0] === "[" ? !/^([ZBCSIJFD]|L.+;)$/.test(e) || (e[0] === "L" && !this.prog.get(e.slice(1, -1))?.def && !this.prog.get(e.slice(1, -1))) : !this.prog.get(n)) ? 0 : this.idOf(n);
      },
      // the class `n` frames out from the caller of the native; 0 when the stack is not that deep
      stackClass: (n: number) => {
        const frames = javaFrames(new Error().stack ?? "", this.traces), f = frames[n + 1];
        // JavaScriptCore's stack has no Wasm frame names: that is a missing capability, not a stack that is not n frames deep
        if (!namesWasmFrames()) this.onGap(this.gapId("caller class: the engine's stack names no Wasm frames"));
        return f ? this.idOf(f.cls.replace(/\./g, "/")) : 0;
      },
      excMessage: (kind: number, a: number, b: number, c: number, d: number, e: number) => (this.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => this.linkMessages[id])),
      capture: (exn: object) => { this.stacks.set(exn, new Error()); },
      stFrames: (state: object | null) => (this.frames = state ? this.stackTrace(state) : []).length,
      stString: (i: number, which: number) => (which ? this.frames[i].method : this.frames[i].cls),
      stLine: (i: number) => this.frames[i].line,
    };
    this.slots.length = FIRST_FREE_SLOT;
    this.startRuntime();
  }

  // ---------- ids, selectors, vtable layout
  nameOf(id: number): string { return this.names[id]; }
  idOf(name: string): number {
    let id = this.ids.get(name);
    if (id === undefined) { this.ids.set(name, id = this.names.length); this.names.push(name); }
    return id;
  }
  selectorId(key: string): number {
    let s = this.selectors.get(key);
    if (!s) { this.selectors.set(key, s = this.selKeys.length); this.selKeys.push(key); }
    return s;
  }
  linkId(message: string): number {
    const id = this.linkMessages.indexOf(message);
    return id >= 0 ? id : this.linkMessages.push(message) - 1;
  }
  gapId(what: string): number {
    let id = this.gaps.get(what);
    if (id === undefined) { this.gaps.set(what, id = this.gaps.size); this.gapList.push(what); }
    return id;
  }
  /** the index of String constant `s` in the shared table */
  stringId(s: string): number {
    let i = this.strings.get(s);
    if (i === undefined) {
      i = this.strings.size; this.strings.set(s, i);
      if (i >= this.strs.length) this.strs.grow(this.strs.length);
      this.strs.set(i, s as never);
    }
    return i;
  }
  /** how `m` is implemented without its bytecode, if it is */
  intrinsic(m: MethodInfo): Intrinsic | undefined { return intrinsicFor(this.opts.intrinsics, this.natives, m); }
  needsInit(n: string): boolean {
    const c = this.prog.get(n); if (!c) return false;
    if (c.byKey.has("<clinit>()V") || c.def?.staticValuesOff) return true;
    return (c.sup ? this.needsInit(c.sup) : false) || (!c.isInterface && this.prog.defaultIfaces(n).some((i) => this.needsInit(i)));
  }
  /** whether class initialization has finished, for a class whose module is already built */
  initialized(n: string): boolean { return (this.classes.get(n)?.exports.init as WebAssembly.Global | undefined)?.value === INIT_DONE; }
  /** virtual method keys of a class in slot order: superclass slots first, then its own and interface methods */
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
  /** vtable index of virtual method `key` as seen from class `decl` */
  vslot(decl: string, key: string): number {
    const i = this.vslots(decl).indexOf(key);
    if (i < 0) throw new Error(`no vtable slot for ${decl}.${key}`);
    return H.VTAB + i;
  }
  private vtWords(name: string, id: number): Int32Array {
    const prog = this.prog, arr = name[0] === "[", c = prog.get(name);
    const chain = arr ? ["java/lang/Object", name] : prog.chain(name).reverse();   // Object first
    const depth = chain.length - 1;
    const keys = this.vslots(arr ? "java/lang/Object" : name), impl = (key: string) => { const j = key.indexOf("("); return prog.implFor(arr ? "java/lang/Object" : name, key.slice(0, j), key.slice(j)); };
    const body: number[] = new Array(H.VTAB + keys.length).fill(0);
    body[H.ID] = id; body[H.DEPTH] = depth;
    // ancestors beyond the fixed display are tested like interfaces, from the id list at the end
    const ifs = new Set<number>();
    chain.forEach((cn, i) => { const cid = cn === name ? id : this.idOf(cn); if (i < H.MAXD) body[H.DISPLAY + i] = cid; else ifs.add(cid); });
    if (arr) {
      const comp = typeName(name.slice(1)), cc = prog.get(comp), d = cc && !cc.isInterface ? prog.chain(comp).length - 1 : -1;
      body[ELEM] = this.idOf(comp);
      body[ELEM_KIND] = !cc ? ELEM_OTHER : cc.isInterface || d >= H.MAXD ? ELEM_IFACE : d + 1;
    }
    keys.forEach((key, i) => { const m = impl(key); body[H.VTAB + i] = m ? this.slotOf(m) : this.abstractSlot(key); });
    // interface dispatch: a small hash table of the selectors known now, the rest learned from imtMiss
    const slow: number[] = [];
    if (!arr) for (const key of keys) {
      const sel = this.selectors.get(key), m = sel ? impl(key) : undefined;
      if (!sel || !m) continue;
      const s = sel % H.IMT_N, f = this.slotOf(m);
      if (body[H.IMT + 2 * s] === 0) { body[H.IMT + 2 * s] = sel; body[H.IMT + 2 * s + 1] = f; } else slow.push(sel, f);
    }
    const addI = (i: string) => { const ic = prog.get(i); if (ic) { ifs.add(this.idOf(i)); ic.ifaces.forEach(addI); } };
    if (arr) ["java/lang/Cloneable", "java/io/Serializable"].forEach(addI);
    else for (let k: JClass | undefined = c; k; k = k.sup ? prog.get(k.sup) : undefined) k.ifaces.forEach(addI);
    // extra region: [capacity, count, (selector, slot) x capacity, interface count, interface ids]
    const cap = slow.length / 2 + 16;
    body[H.EXTRA] = body.length;
    body.push(cap, slow.length / 2, ...slow, ...new Array(2 * cap - slow.length).fill(0), ifs.size, ...ifs);
    return Int32Array.from(body);
  }
  private imtMiss(cls: number, sel: number): number {
    const k = cls * 65536 + sel;
    let slot = this.imtCache.get(k);
    if (slot === undefined) {
      const key = this.selKeys[sel], j = key.indexOf("("), name = this.names[cls];
      const m = this.prog.implFor(name[0] === "[" ? "java/lang/Object" : name, key.slice(0, j), key.slice(j));
      this.imtCache.set(k, slot = m ? this.slotOf(m) : this.abstractSlot(key));
    }
    return slot;
  }

  // ---------- slots
  private reserveSlots(n: number): number {
    const base = this.slots.length;
    this.slots.length += n;
    const have = this.table.length;
    if (this.slots.length > have) this.table.grow(Math.max(this.slots.length - have, have));
    return base;
  }
  slotOf(m: MethodInfo): number {
    const rt = this.link(m.cls), i = rt.methodSlots.get(m.key);
    if (i === undefined) throw new Error("method not in its class: " + m.cls + "." + m.key);
    return i;
  }
  ensureSlot(cls: string): number { const rt = this.link(cls); return rt.slotBase + rt.nMethods; }
  /** the slot of the generated function `name` (runtime functions, per-class allocators, abstract-method stubs), a lazy-link stub until first called */
  synthSlot(name: string, d: Synth): number {
    let slot = this.synth.get(name);
    if (slot !== undefined) return slot;
    this.synth.set(name, slot = this.reserveSlots(1));
    this.slots[slot] = { k: "synth", name, d, done: false };
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    const params = d.params.map((k) => kindVT(b.tObj, k)), sig = mb.addFuncType(params, d.ret === "V" ? [] : [kindVT(b.tObj, d.ret)]);
    mb.addElemActive(0, slot, [mb.addFunc(sig, this.stubBody(slot, sig, params, link), "stub:" + name)]);
    this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host });
    return slot;
  }
  /** a stub for a method the class does not implement: AbstractMethodError, with the signature of the vtable entry it fills */
  private abstractSlot(key: string): number {
    const p = parseMethodDesc(key.slice(key.indexOf("(")));
    const params: Kind[] = ["L", ...p.params.map(kindOf)], ret: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    return this.synthSlot(`abstract:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => { cx.callThrower(c, "ame"); } });
  }

  // ---------- runtime and class modules
  private instantiate(bytes: Uint8Array, imports: WebAssembly.Imports): WebAssembly.Instance {
    const t0 = performance.now(), mod = new WebAssembly.Module(bytes as BufferSource, { builtins: ["js-string"] } as never), t1 = performance.now();
    const inst = new WebAssembly.Instance(mod, imports);
    this.stats.moduleMs += t1 - t0; this.stats.instantiateMs += performance.now() - t1;
    this.stats.bytes += bytes.length;
    return inst;
  }
  private stubBody(slot: number, sig: number, params: VT[], link: number): number[] {
    const c = new Code(params.length);
    c.i32(slot).call(link);
    params.forEach((_, i) => c.lget(i));
    return c.i32(slot).callIndirect(sig).finish();
  }
  private startRuntime(): void {
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    mb.export("tag", "tag", mb.addTag(b.tTagFn));
    const i32Init = (v: number) => { const o = [0x41]; sleb(v, o); return o; };
    const uleb2 = (v: number) => { const o: number[] = []; uleb(v, o); return o; };
    mb.export("alloc", "global", mb.addGlobal(T.i32, true, i32Init(-ALLOC_WINDOW)));
    mb.export("hash", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    // the Class objects by class id (grown by classOf) and the id of the running Java thread, which init words record
    mb.export("ctab", "global", mb.addGlobal(refNull(b.tData.ref), true, [...i32Init(256), 0xfb, 7, ...uleb2(b.tData.ref)]));
    mb.export("tid", "global", mb.addGlobal(T.i32, true, i32Init(1)));
    mb.export("thr", "global", mb.addGlobal(T.anyref, true, [0xd0, 0x6e]));
    mb.export("intr", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    const cid = mb.addFunc(mb.addFuncType([refNull(b.tObj)], [T.i32]), new Code(1).lget(0).refAsNonNull().structGet(b.tObj, 0).i32(H.ID).arrayGet(b.tVT).finish(), "classId");
    mb.export("classId", "func", cid);
    for (const name of Object.keys(SLOT) as Thrower[]) {
      const params = THROWERS[name].params.map((k) => kindVT(b.tObj, k)), sig = mb.addFuncType(params, []);
      const f = mb.addFunc(sig, this.stubBody(SLOT[name], sig, params, link), "stub:" + name);
      mb.addElemActive(0, SLOT[name], [f]);
      this.slots[SLOT[name]] = { k: "thrower", name, done: false };
    }
    const x = this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host }).exports as Record<string, any>;
    this.rt = { tag: x.tag, alloc: x.alloc, hash: x.hash, ctab: x.ctab, tid: x.tid, thr: x.thr, intr: x.intr, classId: x.classId };
  }

  private rtImports() { const { tag, alloc, hash, ctab, tid, thr, intr } = this.rt; return { table: this.table, strs: this.strs, nm: this.nm, tag, alloc, hash, ctab, tid, thr, intr, mem: this.mem, sp: this.sp }; }

  /** the class module of `name`, built on first use */
  link(name: string): ClassRt {
    let rt = this.classes.get(name);
    if (rt) return rt;
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    const slotBase = this.reserveSlots(methods.length + 1);
    rt = { name, id, mod: "c" + id, slotBase, methodSlots: new Map(methods.map((m, i) => [m.key, slotBase + i])), nMethods: methods.length, exports: {} };
    this.classes.set(name, rt);
    methods.forEach((m, i) => { this.slots[slotBase + i] = { k: "method", m, done: false }; });
    this.slots[slotBase + methods.length] = { k: "ensure" };
    rt.exports = this.instantiate(this.classModule(rt, jc), { rt: this.rtImports(), host: this.host }).exports;
    this.stats.classes++; this.stats.classMs += performance.now() - t0;
    return rt;
  }
  /** The bytes of a class module: what a build-time mode would store beside the unit modules of Compiler.buildUnit, and instantiate in
   *  the same order (importing the same table), instead of this linker doing both on demand. */
  classModule(rt: ClassRt, jc: JClass | undefined): Uint8Array {
    const { name, id, slotBase } = rt, methods = jc?.methods ?? [];
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    mb.importTable("rt", "strs", T.externref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    const tid = mb.importGlobal("rt", "tid", T.i32, true), tag = mb.importTag("rt", "tag", b.tTagFn);
    const nullInit = (t: number) => { const o = [0xd0]; sleb(t, o); return o; };
    const zero = (k: Kind) => (k === "I" ? [0x41, 0] : k === "J" ? [0x42, 0] : [0xd0, 0x6e]);
    const isArray = name[0] === "[";
    const vtG = isArray || !jc?.isInterface ? mb.addGlobal(refNull(b.tVT), true, nullInit(b.tVT)) : -1;
    if (vtG >= 0) mb.export("vt", "global", vtG);
    const initG = mb.addGlobal(T.i32, true, [0x41, 0]);
    mb.export("init", "global", initG);
    const statics = new Map<string, number>();
    for (const f of jc?.fields ?? []) if (f.isStatic) {
      const g = mb.addGlobal(kindVT(b.tObj, f.kind), true, zero(f.kind)); statics.set(f.name + ":" + f.desc, g); mb.export("s:" + f.name + ":" + f.desc, "global", g);
    }
    const stubs = methods.map((m, i) => {
      const params = (m.isStatic ? [] : ["L" as Kind]).concat(m.params.map(kindOf)).map((k) => kindVT(b.tObj, k));
      const sig = mb.addFuncType(params, m.ret === "V" ? [] : [kindVT(b.tObj, kindOf(m.ret))]);
      return mb.addFunc(sig, this.stubBody(slotBase + i, sig, params, link), "stub:" + name + "." + m.name);
    });
    if (jc && this.needsInit(name)) stubs.push(mb.addFunc(mb.addFuncType([], []), this.ensureBody(mb, b, jc, initG, statics, rt, tid, tag), "ensure:" + name));
    else if (jc) stubs.push(mb.addFunc(mb.addFuncType([], []), new Code(0).finish(), "ensure:" + name));
    if (vtG >= 0) {
      const words = this.vtWords(name, id), seg = mb.addDataPassive(new Uint8Array(words.buffer));
      mb.start = mb.addFunc(mb.addFuncType([], []), new Code(0).i32(0).i32(words.length).arrayNewData(b.tVT, seg).gset(vtG).finish(), "$vt");
    }
    if (stubs.length) mb.addElemActive(0, slotBase, stubs);
    return mb.build();
  }
  /** ensure(): class initialization (JLS 12.4.2). The init word says who is initializing the class: a request from that thread returns at
   *  once (re-entry and cycles see the half-initialized class), one from another waits in initWait (the scheduler's hook). Superclass and
   *  default-method superinterfaces first, then the dex's static values and <clinit>. A throw marks the class failed and goes to initFail
   *  (an Error propagates, anything else becomes ExceptionInInitializerError); later requests throw NoClassDefFoundError. */
  private ensureBody(mb: ModuleBuilder, b: ReturnType<typeof declareBase>, jc: JClass, initG: number, statics: Map<string, number>, rt: ClassRt, tid: number, tag: number): number[] {
    const c = new Code(0), voidSig = mb.addFuncType([], []), e = c.newLocal(T.anyref);
    const call = (slot: number, sig = voidSig) => c.i32(slot).callIndirect(sig);
    const rtfn = (name: string) => this.synthSlot(name, rtfns.get(name)!);
    c.block().block().loop();                                   // exit, claim, retry
    c.gget(initG).i32(INIT_DONE).raw(OP.i32_eq).brIf(2);
    c.gget(initG).i32(INIT_FAILED).raw(OP.i32_eq).if_(); c.i32(rt.id); call(rtfn("initErroneous"), mb.addFuncType([T.i32], [])); c.end();
    c.gget(initG).raw(OP.i32_eqz).brIf(1);
    c.gget(initG).i32(2).raw(OP.i32_shr_u).gget(tid).raw(OP.i32_eq).brIf(2);
    c.i32(rt.id); call(rtfn("initWait"), mb.addFuncType([T.i32], [])); c.br(0);
    c.end().end();
    c.gget(tid).i32(2).raw(OP.i32_shl).i32(1).raw(OP.i32_or).gset(initG);
    c.block(T.anyref).tryTable(null, [[0, tag, 0]]);
    if (jc.sup && this.needsInit(jc.sup)) call(this.ensureSlot(jc.sup));
    for (const i of this.prog.defaultIfaces(jc.name)) if (this.needsInit(i)) call(this.ensureSlot(i));
    if (jc.def?.staticValuesOff) {
      const sfields = jc.fields.filter((f) => f.isStatic);
      jc.dex!.encodedArray(jc.def.staticValuesOff).forEach((v, i) => {
        const fi = sfields[i], g = fi && statics.get(fi.name + ":" + fi.desc);
        if (!fi || g === undefined || v === null || v === 0 || v === 0n || v === false) return;
        if (typeof v === "number" || typeof v === "boolean") {
          if (fi.desc === "F") c.i32(f32bits(v as number)); else if (fi.desc === "D") c.i64(f64bits(v as number));
          else if (fi.desc === "J") c.i64(BigInt(v as number)); else c.i32(Number(v));
          c.gset(g);
        } else if (typeof v === "bigint") { c.i64(fi.desc === "D" ? f64bits(Number(v)) : v); c.gset(g); }
        else if (typeof v === "string") { c.i32(this.stringId(v)).tableGet(1).anyConvertExtern().gset(g); }
      });
    }
    const ci = jc.byKey.get("<clinit>()V");
    if (ci) call(rt.methodSlots.get(ci.key)!);
    c.i32(INIT_DONE).gset(initG).br(2);
    c.end().unreachable().end();                                // the thrown Throwable is on the stack
    c.lset(e).i32(INIT_FAILED).gset(initG).lget(e); call(rtfn("initFail"), b.tTagFn);
    return c.end().finish();
  }

  // ---------- compiling methods on demand
  /** host.link: compile what `slot` stands for and put it in the table. A method is compiled alone, cheaply, and counts its calls and loop
   *  iterations; `upgrade` recompiles the hot ones with their small callees. */
  private linkSlot(slot: number): void {
    const s = this.slots[slot];
    if (!s || s.k === "ensure" || s.done) return;
    const t0 = performance.now(), cx = new Compiler(this);
    const built = s.k === "method" ? cx.buildUnit([s.m]) : s.k === "synth" ? cx.buildSynthetic(s.name, s.d.params, (c) => s.d.body(cx, c), s.d.ret)
      : cx.buildSynthetic(s.name, THROWERS[s.name].params, (c) => throwerBody(cx, c, s.name));
    this.stats.units++; this.stats.methods += 1;
    this.install(s.k === "method" ? [slot] : [], false, cx, built, slot, t0);
  }
  /** host.hot: the method in `slot` has used up its budget; compile it again with its small callees copied in and guarded calls */
  private upgrade(slot: number): void {
    const s = this.slots[slot];
    if (s?.k !== "method" || !s.done || s.hot) return;
    const t0 = performance.now(), cx = new Compiler(this), { installed, copies } = this.group(s.m);
    const built = cx.buildUnit(installed, copies, true);
    this.stats.units++; this.stats.methods += installed.length + copies.length; this.stats.upgrades++;
    this.install(installed.map((m) => this.slotOf(m)), true, cx, built, slot, t0);
  }
  /** instantiates a built unit and puts its functions (`group`, by slot) in the table; a slot already compiled keeps its original stub */
  private install(group: number[], hot: boolean, cx: Compiler, built: { bytes: Uint8Array; traces: FnTrace[] }, slot: number, t0: number): void {
    const s = this.slots[slot]!;
    this.stats.compileMs += performance.now() - t0;
    let exports: Record<string, any>;
    try { exports = this.instantiate(built.bytes, this.unitImports(cx)).exports as Record<string, any>; } catch (e) { throw new Error(`linking ${s.k === "method" ? mid(s.m) : (s as { name: string }).name}: ${(e as Error).message}`); }
    const set = (at: number, name: string) => {
      const sl = this.slots[at] as Exclude<Slot, { k: "ensure" }>;
      if (!sl.done) sl.stub = this.table.get(at) as Function;
      sl.done = true;
      this.table.set(at, exports[name]);
    };
    if (s.k === "method") {
      for (const x of group) { set(x, "m" + x); this.groupOf.set(x, group); (this.slots[x] as { hot?: boolean }).hot = hot; }
    } else set(slot, "m");
    for (const t of built.traces) this.traces.set(t.name, t);
    for (const [decl, name, desc, target, owner] of cx.assumptions) {
      const key = `${decl}.${name}${desc}`;
      let a = this.assumptions.get(key);
      if (!a) this.assumptions.set(key, a = { decl, name, desc, target, slots: new Set() });
      a.slots.add(owner ? this.slotOf(owner) : slot);
    }
    for (const [name, owner] of cx.absent) {
      const slots = this.absent.get(name) ?? this.absent.set(name, new Set()).get(name)!;
      slots.add(owner ? this.slotOf(owner) : slot);
    }
  }
  private unitImports(cx: Compiler): Record<string, any> {
    const imports: Record<string, any> = { rt: this.rtImports(), host: this.host,
      n: this.natives.imports(this.hostContext(), cx.nativeImports.keys()) };
    for (const [mod, rt] of cx.deps) imports[mod] = rt.exports;
    imports.cnt = Object.fromEntries([...cx.counted].map((slot) => {
      const g = new WebAssembly.Global({ value: "i32", mutable: true }, HOT_BUDGET);
      this.counters.set(slot, g);
      return [slot, g];
    }));
    return imports;
  }
  private hostCtx?: HostContext;
  private hostContext(): HostContext {
    return this.hostCtx ??= { mem: this.mem, sp: this.sp, bridge: this.bridge, gap: (what) => this.onGap(this.gapId(what)), throwable: (cls, msg) => this.makeThrowable(cls, msg), raise: (e) => new (WebAssembly as any).Exception(this.rt.tag, [e]) };
  }
  private throwMakers = new Map<string, (msg: string | null) => object>();
  /** a Java throwable of class `cls` with `msg`, built by a synthetic Wasm function: the way a native raises what the production runtime raised */
  makeThrowable(cls: string, msg: string | null): object {
    let make = this.throwMakers.get(cls);
    if (!make) {
      const cx = new Compiler(this), ctor = this.prog.resolve(cls, "<init>", "()V"), detail = this.prog.resolveField("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")!, st = cx.structFor("java/lang/Throwable");
      const { bytes } = cx.buildSynthetic("mk:" + cls, ["L"], (c) => {
        const exn = c.newLocal(T.anyref);
        cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(exn);
        if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
        c.lget(exn).refCast(st).lget(0).structSet(st, cx.fieldIndex("java/lang/Throwable", detail)).lget(exn);
      }, "L");
      const f = (this.instantiate(bytes, this.unitImports(cx)).exports as Record<string, any>).m;
      this.throwMakers.set(cls, make = (m) => f(m));
    }
    return make(msg);
  }
  /** `m` and the small methods it calls directly, up to MAX_GROUP: V8 can inline calls inside a module but not through the table. One that is
   *  compiled already is copied into the unit and used only by the unit's own calls (`copies`). */
  private group(m: MethodInfo): { installed: MethodInfo[]; copies: MethodInfo[] } {
    const out = [m], installed = [m], copies: MethodInfo[] = [];
    this.plan = new Map();
    if (!m.codeOff || this.intrinsic(m)) return { installed, copies };
    this.noteAllocations(m);
    for (let i = 0; i < out.length && out.length < MAX_GROUP; i++) {
      if (!out[i].codeOff || this.intrinsic(out[i])) continue;
      if (i) this.noteAllocations(out[i]);
      // the callees that have run, busiest first: code the first tier never saw run is not worth compiling into the unit
      const callees = this.smallCallees(out[i]).concat(this.guarded(out[i])).filter((t) => !out.some((o) => mid(o) === mid(t)) && this.slots[this.slotOf(t)]?.k === "method" && this.ran(t) > 0);
      callees.sort((a, b) => this.ran(b) - this.ran(a));
      for (const t of callees) {
        if (out.length >= MAX_GROUP) break;
        if (out.some((o) => mid(o) === mid(t))) continue;
        out.push(t);
        (this.slots[this.slotOf(t)] as { done: boolean }).done ? copies.push(t) : installed.push(t);
      }
    }
    return { installed, copies };
  }
  /** calls and loop iterations counted for `t` so far: methods compiled by the second tier count as busy, the Wasm-written intrinsics always run */
  private ran(t: MethodInfo): number {
    const sl = this.slots[this.slotOf(t)] as { done: boolean; hot?: boolean };
    if (this.opts.intrinsics.has(mid(t))) return HOT_BUDGET;
    if (sl.hot) return HOT_BUDGET;
    const g = this.counters.get(this.slotOf(t));
    return sl.done && g ? HOT_BUDGET - g.value : 0;
  }
  /** classes some compiled code allocates: the ones a virtual call is likely to find */
  allocated = new Set<string>();
  /** per virtual call (declaring class, name, descriptor): the small implementations, among the allocated classes', its unit tests for first */
  plan = new Map<string, MethodInfo[]>();
  private groupOf = new Map<number, number[]>();
  private callees = new Map<MethodInfo, MethodInfo[]>();
  /** the first tier's budget counter of each compiled method, by slot */
  private counters = new Map<number, WebAssembly.Global>();
  /** methods `m` calls directly (static, direct including constructors, or a virtual call CHA resolves to one target) that are worth compiling beside it */
  private smallCallees(m: MethodInfo): MethodInfo[] {
    let out = this.callees.get(m);
    if (out) return out;
    out = [];
    const dex = m.dex;
    for (const ins of decodeInstructions(dex.code(m.codeOff).insns)) {
      const op = ins.op;
      if (!(op >= 0x6e && op <= 0x72) && !(op >= 0x74 && op <= 0x78)) continue;
      const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), decl = descToName(dex.type(mr.cls)), kind = ins.name.replace("/range", "");
      if (decl[0] === "[" || kind === "invoke-super") continue;
      const t = kind === "invoke-static" || kind === "invoke-direct" ? this.prog.resolve(decl, mr.name, desc)
        : (() => { const only = this.cha.targets(decl, mr.name, desc); return only.length === 1 ? only[0] : undefined; })();
      if (t && t !== m && this.inlinable(t) && !out.includes(t)) out.push(t);
    }
    this.callees.set(m, out);
    return out;
  }
  /** the classes `m` allocates join the allocated set before its virtual calls are planned: it is about to run */
  private noteAllocations(m: MethodInfo): void {
    for (const ins of decodeInstructions(m.dex.code(m.codeOff).insns)) {
      if (ins.op !== 0x22) continue;
      const name = descToName(m.dex.type(ins.b));
      if (this.prog.get(name)) this.allocated.add(name);
    }
  }
  /** the implementations of `m`'s virtual calls that are worth a guarded direct call, recorded in `plan` for the emitter */
  private guarded(m: MethodInfo): MethodInfo[] {
    const out: MethodInfo[] = [], dex = m.dex;
    for (const ins of decodeInstructions(dex.code(m.codeOff).insns)) {
      const op = ins.op;
      if (op !== 0x6e && op !== 0x72 && op !== 0x74 && op !== 0x78) continue;
      const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), decl = descToName(dex.type(mr.cls)), key = `${decl}.${mr.name}${desc}`;
      if (decl[0] === "[") continue;
      let t = this.plan.get(key);
      if (!t) this.plan.set(key, t = this.cha.targets(decl, mr.name, desc).length > 1 ? this.likely(decl, mr.name, desc) : []);
      for (const x of t) if (!out.includes(x)) out.push(x);
    }
    return out;
  }
  /** the small implementations of decl.name+desc among the allocated subclasses, most common first, unless there are more kinds than guards to test */
  private likely(decl: string, name: string, desc: string): MethodInfo[] {
    const count = new Map<MethodInfo, number>();
    for (const cls of this.allocated) {
      if (cls[0] === "[" || !this.prog.isSubclass(cls, decl)) continue;
      const t = this.prog.implFor(cls, name, desc);
      if (t) count.set(t, (count.get(t) ?? 0) + 1);
    }
    if (count.size > MAX_GUARDS) return [];
    return [...count].filter(([t]) => this.inlinable(t)).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }
  /** whether `t` is worth compiling into its callers' units: a short method, or one the compiler writes itself (the String methods over the js-string builtins) */
  private inlinable(t: MethodInfo): boolean {
    if (this.opts.intrinsics.has(mid(t))) return true;
    return !!t.codeOff && !(t.flags & ACC.NATIVE) && !this.intrinsic(t) && t.dex.code(t.codeOff).insns.length <= SMALL_CALLEE;
  }
  /** the gaps compiling `m` runs into, without installing it (a static check, and the unit a build-time mode would emit) */
  gapsOf(m: MethodInfo): string[] {
    let g = this.compiled.get(m);
    if (!g) { const cx = new Compiler(this); cx.buildUnit([m]); this.compiled.set(m, g = cx.gaps); }
    return g;
  }

  // ---------- open world
  /** load more dexes. A CHA decision that one of their classes falsifies is undone: its callers go back to lazy-link stubs, so the next call
   *  compiles against the new hierarchy. Frames already executing keep the old code. */
  addDexes(dexes: DexFile[]): string[] {
    const added = this.prog.add(dexes);
    this.cha.index(added);
    for (const [key, a] of this.assumptions) {
      const t = this.cha.targets(a.decl, a.name, a.desc);
      if (t.length === (a.target ? 1 : 0) && t[0] === a.target) continue;
      for (const slot of a.slots) this.invalidate(slot);
      this.assumptions.delete(key);
    }
    for (const name of added) for (const slot of this.absent.get(name) ?? []) this.invalidate(slot);
    for (const name of added) this.absent.delete(name);
    return added;
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  private invalidate(slot: number): void {
    for (const x of this.groupOf.get(slot) ?? [slot]) {
      const s = this.slots[x];
      if (s?.k === "ensure" || !s?.done || !s.stub) continue;
      this.table.set(x, s.stub); s.done = false; s.hot = false; this.stats.invalidated++;
      this.groupOf.delete(x);
    }
  }

  // ---------- calling in from JS, and exceptions
  /** a JS function that calls the Java method; a Java exception arrives as a WebAssembly.Exception (see `throwable`) */
  entry(cls: string, name: string, desc: string): (...args: unknown[]) => unknown {
    const m = this.prog.resolve(cls, name, desc);
    if (!m) throw new Error(`entry ${cls}.${name}${desc} not found`);
    const slot = this.slotOf(m);
    return (...args) => {
      try {
        if (m.isStatic && this.needsInit(m.cls)) (this.table.get(this.ensureSlot(m.cls)) as Function)();
        return (this.table.get(slot) as Function)(...args);
      } catch (e) { throw this.boundary(e); }
    };
  }
  /** the Java throwable a call from JS threw, if `e` is one */
  throwable(e: unknown): object | undefined {
    const X = (WebAssembly as any).Exception, x = e as any;
    return e instanceof X && x.is(this.rt.tag) ? x.getArg(this.rt.tag, 0) : undefined;
  }
  /** the class of a Java object that crossed to JS */
  classNameOf(obj: object): string { return this.names[this.rt.classId(obj)]; }
  /** V8 does not let Wasm catch its stack overflow RangeError, so Java handlers cannot see it; at the edge of the Java world it
   *  becomes the StackOverflowError a handler above this call would have received */
  private boundary(e: unknown): unknown {
    if (!isStackOverflow(e)) return e;
    try { (this.table.get(SLOT.soe) as Function)(); } catch (x) { return x; }
    return e;
  }
  /** the Java frames Throwable.nativeFillInStackTrace recorded under `state`, innermost first, without the frames of the throwable's own construction */
  stackTrace(state: object): JavaFrame[] {
    const err = this.stacks.get(state);
    if (!err) return [];
    const frames = javaFrames(err.stack ?? "", this.traces);
    let skip = 0;
    while (skip < frames.length && /^(fillInStackTrace|nativeFillInStackTrace)$|^<init>$/.test(frames[skip].method) && (frames[skip].method !== "<init>" || this.prog.isSubclass(frames[skip].cls.replace(/\./g, "/"), "java/lang/Throwable"))) skip++;
    return frames.slice(skip);
  }
  private hostFns = new Map<string, Function>();
  /** a function over Java values, generated once under `name` and callable from the host: an int is a number, a long a bigint, a reference an opaque value */
  hostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void): (...a: any[]) => any {
    let f = this.hostFns.get(name);
    if (!f) {
      const cx = new Compiler(this), { bytes } = cx.buildSynthetic(name, params, (c) => body(cx, c), ret);
      this.hostFns.set(name, f = (this.instantiate(bytes, this.unitImports(cx)).exports as Record<string, any>).m);
    }
    return f as never;
  }
  /** a JS function reading instance field `name` of `cls` from a Java object that crossed to JS (a reference field gives an opaque object) */
  fieldReader(cls: string, name: string, desc: string): (obj: object) => unknown {
    const f = this.prog.resolveField(cls, name, desc);
    if (!f) throw new Error(`field ${cls}.${name} not found`);
    const cx = new Compiler(this), st = cx.structFor(cls);
    const { bytes } = cx.buildSynthetic("get:" + name, ["L"], (c) => { c.lget(0).refAsNonNull().refCast(st).structGet(st, cx.fieldIndex(cls, f)); }, f.kind);
    return (this.instantiate(bytes, this.unitImports(cx)).exports as Record<string, any>).m;
  }
}
