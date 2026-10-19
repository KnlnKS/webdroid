// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals; its methods' contiguous block of table slots starts with the lazy-link stub of each one's signature.
//  - Every call between modules is `call_indirect slot` after storing the slot in rt.callee, so a compiled method needs no relinking. A stub
//    calls host.link(callee), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry, then calls through the slot.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
import { symbolicInstruction, symbolicOperationKey, type SymbolicSite } from "../compiler/sites.ts";
import { compileSymbolicSite } from "../compiler/symbolic.ts";
import { HT, ModuleBuilder, T, ref, refNull, sleb, uleb, type FunctionType } from "../compiler/wasmbin.ts";
import { CALLEE, Code, OP } from "../compiler/code.ts";
import { type Program, ACC, kindOf, changedTypes, declaredMethod, declaresNaming, declaresStaticOf, methodAt, methodCount, javaName, methodKinds, type Kinds, type Loader, type Kind, type JClass, type MethodInfo, type FieldInfo, typeName } from "../compiler/program.ts";
import { Cha } from "../compiler/cha.ts";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_OTHER, f32bits, f64bits } from "../compiler/consts.ts";
import { Compiler, MATH_IMPORTS, declareBase, intrinsicFor, kindVT, type Base, type FnTrace, type Intrinsic } from "../compiler/j2w.ts";
import type { CompileService, GuestMemory, HostBridge, HostContext, HostNet, HostSpec, NativeBinder } from "./hostapi.ts";
import { Sched, defaultLoop, SYSTEM_LOADER, type HostLoop, type Strand } from "./sched.ts";
import { rtfns, type Synth } from "../compiler/rtfns.ts";
import { hostInfo, infoRecord, replayInfo, type InfoRecord } from "./classes.ts";

import { HostClasses } from "./hostclass.ts";
import { mhInvoke } from "./mhandles.ts";
import type { InvokeMode } from "../compiler/handles.ts";
import { hostText } from "./members.ts";
import { ASYNC } from "./inet.ts";
import { generateProxy, type ProxyDefinition } from "./proxy.ts";
import { hostObject } from "./annotations.ts";
import { classByName, dexOpen, dexOpenMemory, loaderObject, LOADER_OF_CLASS, Lookup } from "./loaders.ts";
import { initiatedInstruction, resolveInstruction, resolveClass, resolveForName, resolveCatch } from "./resolution.ts";
import { hasSignatureConstraints, validateSignatures } from "./signatures.ts";
import { SLOT, FIRST_FREE_SLOT, SCRATCH_BASE, INIT_DONE, INIT_FAILED, THROWERS, ALLOC_WINDOW, excMessage, javaFrames, isStackOverflow, deepStack, type JavaFrame, type Thrower } from "../compiler/exc.ts";
import { decodeInstruction, type PreparedInstruction } from "../../jvm/prepared.ts";
import { HEAP_LIMIT, parseMethodDesc } from "../../jvm/abi.ts";
import { mid, methodOf } from "../compiler/ids.ts";
import { dispatchMethodKey, dispatchSlotKey, overridesMethod, failed, symbolicDispatchFor, symbolicImplFor, symbolicMethod, resolveSymbolicMethod, unresolvedClass } from "../compiler/linkage.ts";
import { NO_INDEX, type DexFile } from "../../jvm/dex.ts";
import { compileModule, suspending } from "./module.ts";
import { AotRuntime, type AotBuild, type AotStore, type AppIndex } from "./aot.ts";
import { Numbers, type Marks, type Numbering } from "./numbers.ts";
import { SlotTable } from "./slots.ts";
import { Planner } from "./planning.ts";
import { Tiering } from "./tiering.ts";
import { AheadCompiler } from "./ahead.ts";
import { emitRestored, Sync, ROOT } from "../compiler/hostcalls.ts";

type BridgeStack = { stack?: Error; prior?: BridgeStack; done: boolean };

export interface WorldOptions {
  intrinsics: Map<string, Intrinsic>;
  /** the registered natives, bound to host imports by descriptor (host/natives.ts) */
  natives: NativeBinder;
  /** bytes in use on the heap; what it has grown by since the World was made is compared with the heap limit each time a window of allocation is used up */
  heapUsed: () => number;
  /** a collection of the host heap, when it has a way to ask for one: the limit applies to live data, and `heapUsed` counts the garbage not yet swept */
  collect?: () => void;
  /** how much the heap may grow before an allocation fails: ART's limit, a process's own, by default */
  heapLimit?: number;
  /** resolves names for libcore's getaddrinfo; without it a lookup is a gap */
  net?: HostNet;
  /** the native core's memory, which direct buffers are allocated in; a World that only builds code needs none */
  guest?: GuestMemory;
  /** a class that frees a native handle in its finalize() owns the handle it stores in a long field: called with the object and the handle each time one is stored there (no finalizer runs here) */
  claim?: (owner: object, handle: bigint) => void;
  /** classes of the platform the host implements whole: their initializers do not run (hostclass.ts) */
  hostWhole?: (name: string) => boolean;
  /** precompiled platform code (aot.ts); the Program holds exactly the platform dexes it was built from, apps are added with addDexes */
  aot?: AotStore;
  /** a build of that code: classes, slots and selectors are numbered but nothing is instantiated */
  build?: AotBuild;
  /** timers and event loop turns for threads that wait (sched.ts); the host's own where there is one */
  loop?: HostLoop;
  /** marks a moment on the host's timeline (src/timeline.ts: Ev) */
  note?: (ev: number, arg?: number) => void;
  /** the dex files of the archive at `path`, for the DexFile natives of class loaders (loaders.ts); undefined for a file that does not exist. Dex files it answers twice
   *  that are the same objects stay in one namespace. Without it a loader cannot open dex files. */
  dexes?: (path: string) => DexFile[] | undefined | Promise<DexFile[] | undefined>;
  /** whether the second tier waits, inline or in the worker: the host is starting an app, and what is hot now is mostly code that runs once */
  holdUpgrades?: () => boolean;
  /** whether the host is answering input, when work that lengthens a collection's pause waits */
  answering?: () => boolean;
  /** an app compiled ahead on top of `aot` (apps.ts): used when this World is where it starts, the platform build attached and nothing numbered since */
  app?: { index: AppIndex; store: AotStore };
  /** compiles second-tier units elsewhere (a worker); without it, or when it declines, they are compiled here */
  compiler?: CompileService;
  /** a World that compiles for another (a worker's): classes are numbered and linked by name only, nothing is instantiated, and no code runs */
  compileOnly?: boolean;
}
/** a class module's exports are the class's globals under "<id>:vt", "<id>:init" and "<id>:s:<field>"; a module of several classes (aot.ts) shares them */
export interface ClassRt { name: string; id: number; mod: string; slotBase: number; nMethods: number; exports: WebAssembly.Exports }
/** a lazy-link stub's signature, its name where a class module imports it */
const stubKey = (k: Kinds) => k.params.join("") + ":" + k.ret;
const kindsType = (mb: ModuleBuilder, k: Kinds) => mb.addFuncType(k.params.map((p) => kindVT(p)), k.ret === "V" ? [] : [kindVT(k.ret)]);
/** what ensure()'s body uses of the module it is compiled into (World.emitEnsure) */
interface InitScope { mb: ModuleBuilder; b: Base; initG: number; sid: number; iw: number; tag: number; statics(f: FieldInfo): number; literal(c: Code, s: string): void }
/** the vtable words of a class module above which its start function makes the vtables (World.classModule) */
const VT_DATA_WORDS = 4096;
/** the kinds of a vtable entry's parameters (the receiver first) and result, from its method key */
function entryKinds(key: string): Kinds {
  const p = parseMethodDesc(key.slice(key.indexOf("(")));
  return { params: ["L", ...p.params.map(kindOf)], ret: p.ret === "V" ? "V" : kindOf(p.ret) };
}
/** when a unit's compile began, and the compile time accounted by then (World.accountCompilation) */
export type Clock = { start: number; accounted: number };
export type Built = { bytes: Uint8Array | WebAssembly.Module; traces: FnTrace[] };
/** a class-hierarchy decision: calls of decl.name+desc run only the method `tk` of class `tc` (none if empty) */
interface Assumption { decl: string; name: string; desc: string; tc: string; tk: string; slots: Set<number> }

export class World {
  opts: WorldOptions;
  /** whether code is instantiated and runs here: a build's World and a compile worker's only number and name what code links */
  readonly instantiates: boolean;
  prog: Program;
  cha: Cha;
  table = new WebAssembly.Table({ element: "anyfunc", initial: 256 });
  readonly numbers = new Numbers();
  /** a gap (Numbers.gapList) ran */
  onGap: (what: string) => void = () => {};
  /** a site naming a class, method or field the loaded classes lack ran (linkage.ts): ART's message, and the class when that is what is missing */
  onUnresolved: (message: string, cls: string | undefined) => void = () => {};
  /** the gap site that ran last, which the UnsatisfiedLinkError the code throws next names */
  private lastGap = 0;
  /** the message the last implicit exception would carry; stored in the Throwable once Strings exist */
  lastMessage: string | null = null;
  stats = { phase: { prepare: 0, flow: 0, infer: 0, facts: 0, emit: 0, encode: 0, classBuild: 0 }, aot: { d: 0, c: 0, dead: 0, missed: 0, readMs: 0, ms: 0, bytes: 0 }, classes: 0, units: 0, methods: 0, bridgeCallerCaptures: 0, bytes: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, instances: 0, classMs: 0, invalidated: 0, upgrades: 0, merged: 0, retired: 0, collected: 0, ahead: 0 };
  readonly slots = new SlotTable(this, FIRST_FREE_SLOT);
  readonly planner = new Planner(this);
  readonly tiers = new Tiering(this);
  readonly ahead = new AheadCompiler(this);
  classes = new Map<string, ClassRt>();
  /** what this World built because no saved code had it: the methods compiled at their first call and the classes whose modules it made, in order (an app build made later includes them) */
  readonly demand = { methods: new Set<MethodInfo>(), classes: [] as string[], infos: [] as InfoRecord[] };
  private vslotCache = new Map<string, string[]>();
  traces = new Map<string, FnTrace>();
  /** the traces of functions by name: those of precompiled modules are read when a stack needs them */
  private frameTraces = { get: (name: string) => this.traces.get(name) ?? this.aot?.trace(name) };
  private stacks = new WeakMap<object, Error | JavaFrame[]>();
  private bridgeStacks = new WeakMap<Strand, BridgeStack>();
  assumptions = new Map<string, Assumption>();
  /** the slots whose code fails a site because a class is not loaded, by class name: loading it undoes them */
  absent = new Map<string, Set<number>>();
  /** the Method objects of proxy classes, which their compiled code reads by index (proxy.ts) */
  private nm = new WebAssembly.Table({ element: "externref", initial: 16 });
  private pinned = new Map<object, number>();
  /** scratch linear memory natives copy arrays through, and its allocation top */
  mem = new WebAssembly.Memory({ initial: Math.ceil(SCRATCH_BASE / 65536) + 1 });
  sp = new WebAssembly.Global({ value: "i32", mutable: true }, SCRATCH_BASE);
  natives: NativeBinder;
  bridge: HostBridge;
  /** the classes the host implements (hostclass.ts) */
  hosts = new HostClasses(this);
  host: Record<string, Function>;
  rt!: { tag: WebAssembly.Tag; alloc: WebAssembly.Global; hash: WebAssembly.Global; ctab: WebAssembly.Global; unsafeSlots: WebAssembly.Global; sid: WebAssembly.Global; thr: WebAssembly.Global; depth: WebAssembly.Global; iw: WebAssembly.Global; wait: WebAssembly.Global; callee: WebAssembly.Global; classId: (o: object) => number; link: (slot: number) => void; nop: Function };
  /** the threads: strands, monitors, waits (sched.ts) */
  sched!: Sched;
  aot?: AotRuntime;
  /** what the World had numbered when its constructor returned, or once an app build was attached: where a compile worker's numbering starts */
  base!: Marks;
  /** how many times the default namespace was extended or something a compile worker cannot follow was added: results made before are not adopted */
  epoch = 0;
  private touching: Set<string> | null = null;
  private imtCache = new Map<number, Map<number, number>>();

  constructor(prog: Program, opts: WorldOptions) {
    this.opts = opts;
    this.instantiates = !opts.build && !opts.compileOnly;
    this.prog = prog;
    this.natives = opts.natives;
    this.bridge = this.natives.bridge(this);
    this.cha = new Cha(prog);
    // the heap holds the engine's own data too (the program model is hundreds of MB), which is not the Java heap ART's limit is about
    const heap = opts.heapUsed, heapBase = heap(), limit = opts.heapLimit ?? HEAP_LIMIT;
    const names = (id: number) => javaName(this.numbers.names[id]);
    // a host call whose answer is pending parks the strand, which annotationWait settles with the answer
    const park = (value: unknown, none: null | 0): unknown => {
      if (!(value instanceof Promise)) return value;
      this.sched.parkNative(value); return none;
    };
    this.host = {
      ...Object.fromEntries(Object.keys(MATH_IMPORTS).map((f) => [f, Math[f as keyof typeof MATH_IMPORTS]])),
      fmod: (a: number, b: number) => a % b,
      gap: (id: number) => { this.lastGap = id; this.onGap(this.numbers.gapList[id]); },
      link: (slot: number) => this.tiers.linkSlot(slot),
      linkDue: (slot: number) => +(this.sched.canWait() && !this.inSynchronousJava() && (this.sched.turnDue() || !!this.aot?.needsPreparation(slot))),
      linkWait: suspending((slot: number) => this.sched.admitLink(() => this.tiers.linkSlot(slot), () => this.aot?.prepare(slot))),
      sync: (op: number, obj: object | null, a: number) => this.sched.sync(op, obj, a),
      block: suspending((op: number, obj: object | null, a: number, b: number) => {
        try { this.sched.running = this.sched.current(); return this.sched.block(op, obj, a, b); } finally { this.sched.idle(); }
      }),
      hot: (slot: number) => this.tiers.upgrade(slot),
      long: (slot: number) => { const s = this.slots.at(slot); if (s?.k === "method") this.longLoops.add(mid(s.m)); },
      imtMiss: (cls: number, sel: number) => this.imtMiss(cls, sel),
      heapCheck: () => (heap() - heapBase > limit && (opts.collect?.(), heap() - heapBase > limit) ? 1 : 0),
      info: (kind: number, a: number, b: number) => {
        const synths = this.slots.synthCount, answer = hostInfo(this, kind, a, b);
        if (this.slots.synthCount !== synths && !opts.compileOnly) this.demand.infos.push(infoRecord(this, kind, a, b));
        return answer;
      },
      text: (kind: number, a: number) => this.javaValue(hostText(this, kind, a)),
      obj: (kind: number, a: number, b: number, filter: object | null) => (kind === LOADER_OF_CLASS ? loaderObject(this, a) : this.javaValue(hostObject(this, kind, a, b, filter))),
      annotation: (kind: number, a: number, b: number, filter: object | null) => park(hostObject(this, kind, a, b, filter), null),
      proxy: (name: unknown, interfaces: object, loader: object | null, methods: object, exceptions: object) => this.javaValue(generateProxy(this, this.hostString(name) as string, interfaces, loader, methods, exceptions)),
      net: (node: unknown, family: number, flags: number) => opts.net ? opts.net(this, this.hostString(node) as string, family, flags) : ASYNC,
      netByte: (found: number[][], i: number, j: number) => j < 0 ? found[i].length : found[i][j],
      mhInvoke: (mh: object, args: object, site: string, mode: InvokeMode) => {
        const value = mhInvoke(this, mh, args, site, mode);
        return park(value instanceof Promise ? value.then((v) => this.javaValue(v)) : this.javaValue(value), null);
      },
      galloc: (owner: object, n: number) => this.allocGuest(owner, n),
      gwrote: (address: number, length: number) => opts.guest!.wrote(address >>> 0, length >>> 0),
      gblock: (address: number) => this.blockSizes.get(address >>> 0) ?? 0,
      intern: (js: string, s: object) => { let o = this.interned.get(js); if (!o) this.interned.set(js, o = s); return o; },
      claim: (owner: object, handle: bigint) => opts.claim?.(owner, handle),
      watch: (referent: unknown, cleaner: object) => { if (typeof referent === "object" && referent !== null) this.cleaners.register(referent, cleaner); },
      classByName: (name: string, scope: unknown, mode: number) => {
        const text = this.hostString(name) as string;
        return park(mode === Lookup.ForName ? resolveForName(this, text, scope as object | null, this.sched.current()) : classByName(this, text, scope, mode), 0);
      },
      dexOpen: (path: unknown, loader: object | null) => park(dexOpen(this, path, loader), null),
      dexOpenMemory: (buffers: object, arrays: object, starts: object, ends: object, loader: object | null) => park(dexOpenMemory(this, buffers, arrays, starts, ends, loader), null),
      // the class `n` frames out from the caller of the native; 0 when the stack is not that deep
      stackClass: (n: number) => {
        const frames = this.callerFrames(n + 2), f = frames[n + 1];
        return f ? this.idOf(f.cls.replace(/\./g, "/")) : 0;
      },
      excMessage: (kind: number, a: number, b: number, c: number, d: number, e: number) => {
        const message = this.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => id < 0 ? this.numbers.gapList[this.lastGap] : this.numbers.links.message(id)!);
        if (message !== null && (kind === SLOT.ncdfr || kind === SLOT.nsme || kind === SLOT.nsfer)) this.onUnresolved(message, kind === SLOT.ncdfr ? unresolvedClass(message) : undefined);
        return message;
      },
      capture: (exn: object) => {
        const stack = deepStack();
        this.stacks.set(exn, this.bridgeStacks.has(this.sched.current()) ? this.javaStack(stack.stack ?? "") : stack);
      },
      stFrames: (state: object | null) => state ? this.stackTrace(state) : [],
      // a frame's class, method and the source file its class def names (null without one)
      stString: (frames: JavaFrame[], i: number, which: number) => {
        const f = frames[i], c = which === 2 ? this.prog.get(f.cls.replace(/\./g, "/")) : undefined;
        return which === 0 ? javaName(f.cls) : which === 1 ? f.method : c?.def && c.def.sourceFileIdx !== NO_INDEX ? c.dex!.string(c.def.sourceFileIdx) : null;
      },
      stLine: (frames: JavaFrame[], i: number) => frames[i].line,
      // the length of an answer the code holds (stFrames, net), or the code a lookup answered instead
      len: (answer: unknown[] | number) => typeof answer === "number" ? answer : answer.length,
    };
    this.startRuntime();
    this.sched = new Sched(this, this.rt, opts.loop ?? defaultLoop);
    this.host.annotationWait = this.sched.settle();
    const catchBlock = (cls: number, index: number, pc: number, throwable: object) => {
      const method = methodAt(this.prog.require(this.nameOf(cls)), index);
      if (!method) throw new Error("Missing catch dispatcher method");
      return resolveCatch(this, method, pc, throwable, this.sched.current());
    };
    this.host.catchSync = this.symbolicSync.bind(this);
    this.host.catchBlock = (...args: Parameters<typeof catchBlock>) => this.synchronous(() => catchBlock(...args));
    this.host.catchBlockWait = this.sched.suspending(catchBlock);
    const signatures = (id: number) => validateSignatures(this, this.nameOf(id), this.sched.current());
    this.host.initSignatures = (id: number) => this.synchronous(() => signatures(id));
    this.host.initSignaturesWait = this.sched.suspending(signatures);
    this.aot = opts.build ? new AotRuntime(this, opts.build) : opts.aot ? AotRuntime.attach(this, opts.aot) : undefined;
    this.base = this.numbers.marks();
    if (opts.app) this.attachApp(opts.app);
  }
  /** whether an app build is in use */
  appAttached = false;
  /** uses `app`, an app build, if this World can (AotRuntime.extend): before the app's code first runs */
  attachApp(app: NonNullable<WorldOptions["app"]>): boolean {
    if (this.appAttached || !this.aot?.extend(app.index, app.store)) return false;
    this.base = this.numbers.marks();
    return this.appAttached = true;
  }

  // ---------- numbering
  /** numbers what `n` numbered, in its order; false, and nothing changed, unless this World has numbered exactly what `n` started from */
  adopt(n: Numbering): boolean {
    if (!this.numbers.adopt(n)) return false;
    this.slots.replay(n.tail);
    return true;
  }
  /** forgets what was numbered after `m` (a compile worker drops the numbering of a unit its caller did not take) */
  rollback(m: Marks): void {
    this.rt.unsafeSlots.value = null;
    const { names, tail } = this.numbers.rollback(m);
    for (const name of names) this.classes.delete(name);
    for (const t of tail) if (typeof t !== "string") this.classes.delete(t[0]);
    this.slots.rollback(tail);
  }
  /** the classes (and, as "!name", runtime functions) whose slots code made between `beginTouch` and `endTouch` names: they need their stubs before the code runs */
  beginTouch(): void { this.touching = new Set(); }
  endTouch(): Set<string> { const t = this.touching!; this.touching = null; return t; }

  /** gives every platform class (the Program's classes of the dexes `accept`s, in definition order) its id and its block of table slots, so that numbers do not depend on what runs first (aot.ts) */
  seedPlatform(accept: (dex: DexFile) => boolean): number {
    let n = 0;
    for (const c of this.prog.all()) {
      if (!c.dex || !accept(c.dex)) continue;
      if (this.idOf(c.name) !== n + 1) throw new Error("platform classes must be numbered first");
      this.slots.addBlock(c.name, methodCount(c) + 1); n++;
    }
    return n;
  }

  // ---------- ids, selectors, vtable layout
  nameOf(id: number): string { return this.numbers.names[id]; }
  idOf(name: string): number { return this.numbers.idOf(name); }
  selectorId(key: string): number { return this.numbers.selectorId(key); }
  linkId(message: string): number { return this.numbers.linkId(message); }
  gapId(what: string): number { return this.numbers.gapId(what); }
  /** the String objects made of JS strings, which are the constants and what String.intern answers */
  private interned = new Map<string, object>();
  /** a value a host function answers, as a Java value: a JS string becomes a String */
  private javaValue(v: unknown): unknown { return typeof v === "string" ? this.javaString(v) : v; }
  /** a String a host function is given, as the JS string it works with */
  hostString(v: unknown): unknown {
    return typeof v === "object" && v !== null && this.classNameOf(v) === "java/lang/String" ? this.bridge.toHost(v) : v;
  }
  private fromJs?: (s: string) => unknown;
  /** the Java String of a JS string (a JS string itself when Strings are JS strings) */
  javaString(s: string): unknown {
    return (this.fromJs ??= this.hostFn("str:from", ["L"], "L", (cx, c) => { c.lget(0).externConvertAny(); cx.str.fromHost(c); }))(s);
  }
  /** how `m` is implemented without its bytecode, if it is */
  /** whether `ins` must link at run time: `m`'s loader links by name and the class the instruction names has no ready definition it initiated */
  needsSymbolicSite(m: MethodInfo, ins: PreparedInstruction): boolean {
    return !this.prog.linksStatically(this.prog.loaderOf(m.cls)) && symbolicInstruction(m, ins) && !initiatedInstruction(this, m, ins);
  }
  intrinsic(m: MethodInfo): Intrinsic | undefined { return this.madeUp.get(mid(m)) ?? intrinsicFor(this.opts.intrinsics, this.natives, m); }
  /** the bodies of the methods of classes made at run time (addClass), by method id */
  private madeUp = new Map<string, Intrinsic>();
  needsInit(n: string): boolean {
    const c = this.prog.get(n); if (!c) return false;
    if (declaredMethod(c, "<clinit>()V") || c.def?.staticValuesOff || hasSignatureConstraints(this, n)) return true;
    return (c.sup ? this.needsInit(c.sup) : false) || (!c.isInterface && this.prog.defaultIfaces(n).some((i) => this.needsInit(i)));
  }
  /** the init word of the class with id `id` (0 before its module is built) */
  initWord(id: number): number { const rt = this.loadedClass(this.nameOf(id)); return rt ? (rt.exports[id + ":init"] as WebAssembly.Global).value as number : 0; }
  /** whether class initialization has finished, for a class whose module is already built */
  initialized(n: string): boolean { const rt = this.loadedClass(n); return (rt?.exports[rt.id + ":init"] as WebAssembly.Global | undefined)?.value === INIT_DONE; }
  /** the record of a class whose module is built or loaded; a platform module loaded for the classes beside it gives its other classes theirs here */
  private loadedClass(name: string): ClassRt | undefined { return this.classes.get(name) ?? (this.aot?.hasLoaded(name) ? this.link(name) : undefined); }
  /** Binary DEX method keys in slot order. Resolving signature Class identities must not renumber published dispatch slots. */
  vslots(n: string): string[] {
    let s = this.vslotCache.get(n); if (s) return s;
    const c = this.prog.get(n);
    s = n === "java/lang/Object" || !c ? [] : [...this.vslots(c.sup ?? "java/lang/Object")];
    if (c && !c.isInterface) {
      const byMethod = new Map<string, string[]>();
      const index = (key: string) => {
        const raw = dispatchMethodKey(key), slots = byMethod.get(raw);
        if (slots) slots.push(key); else byMethod.set(raw, [key]);
      };
      for (const key of s) index(key);
      for (const m of c.methods) if (!m.isStatic && !m.isCtor && !(m.flags & ACC.PRIVATE)) {
        const overrides = byMethod.get(javaName(m.key))?.some(key => {
          const inherited = c.sup ? symbolicImplFor(this.prog, c.sup, key, true) : undefined;
          return inherited && overridesMethod(this.prog, n, inherited);
        });
        if (!overrides) { const key = dispatchSlotKey(m); s.push(key); index(key); }
      }
      const addIface = (i: string) => {
        const ic = this.prog.get(i);
        if (!ic) return;
        for (const m of ic.methods) if (!(m.flags & (ACC.STATIC | ACC.PRIVATE))) {
          const key = javaName(m.key);
          if (!byMethod.get(key)?.some(slot => !!((symbolicImplFor(this.prog, n, slot, true)?.flags ?? 0) & ACC.PUBLIC))) { s!.push(key); index(key); }
        }
        ic.ifaces.forEach(addIface);
      };
      for (let k: JClass | undefined = c; k; k = k.sup ? this.prog.get(k.sup) : undefined) k.ifaces.forEach(addIface);
    }
    this.vslotCache.set(n, s); return s;
  }
  /** vtable index of virtual method `key` as seen from class `decl` */
  vslot(decl: string, key: string): number {
    const slots = this.vslots(decl), raw = javaName(key);
    let i = slots.indexOf(raw);
    if (i < 0) {
      const at = key.indexOf("("), target = resolveSymbolicMethod(this.prog, decl, key.slice(0, at), key.slice(at));
      // Several inaccessible declarations may share a binary prototype and distinct slots.
      i = slots.findIndex(slot => dispatchMethodKey(slot) === raw && !!target && symbolicImplFor(this.prog, decl, slot, true) === target);
    }
    if (i < 0) throw new Error(`no vtable slot for ${decl}.${key}`);
    return H.VTAB + i;
  }
  private vtWords(name: string, id: number): Int32Array {
    const prog = this.prog, arr = name[0] === "[", c = prog.get(name);
    const chain = arr ? ["java/lang/Object", name] : [...prog.chain(name)].reverse();   // Object first
    const depth = chain.length - 1;
    const keys = this.vslots(arr ? "java/lang/Object" : name), impl = (key: string) => symbolicDispatchFor(prog, arr ? "java/lang/Object" : name, key);
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
    const targets = keys.map(impl);
    keys.forEach((key, i) => { body[H.VTAB + i] = this.dispatchSlot(key, targets[i]); });
    // interface dispatch: a small hash table of the selectors known now, the rest learned from imtMiss
    const slow: number[] = [];
    if (!arr) keys.forEach((key, i) => {
      const sel = this.numbers.selectors.get(dispatchMethodKey(key)), target = sel ? targets[i] : undefined;
      if (!sel || !target || !failed(target) && !(target.flags & ACC.PUBLIC)) return;
      const s = sel % H.IMT_N, f = this.dispatchSlot(key, target);
      if (body[H.IMT + 2 * s] === 0) { body[H.IMT + 2 * s] = sel; body[H.IMT + 2 * s + 1] = f; } else slow.push(sel, f);
    });
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
    let cache = this.imtCache.get(cls);
    if (!cache) this.imtCache.set(cls, cache = new Map());
    let slot = cache.get(sel);
    if (slot === undefined) {
      const key = this.numbers.selKeys[sel], name = this.nameOf(cls);
      const receiver = name[0] === "[" ? "java/lang/Object" : name, at = key.indexOf("(");
      let m: MethodInfo | undefined;
      for (const owner of this.prog.chain(receiver)) {
        const candidate = symbolicMethod(this.prog.require(owner), key.slice(0, at), key.slice(at));
        if (candidate && !candidate.isStatic) { m = candidate; break; }
      }
      const target = m ?? symbolicDispatchFor(this.prog, receiver, key);
      cache.set(sel, slot = target && !failed(target) && !(target.flags & ACC.PUBLIC) ? this.interfaceAccessSlot(entryKinds(key)) : this.dispatchSlot(key, target));
    }
    return slot;
  }

  // ---------- slots
  slotOf(m: MethodInfo): number { return this.link(m.cls).slotBase + m.index; }
  ensureSlot(cls: string): number { const rt = this.link(cls); return rt.slotBase + rt.nMethods; }
  /** the slot of the generated function `name` (runtime functions, per-class allocators, abstract-method stubs), a lazy-link stub until first called;
   *  `eager`: its code is compiled now, for a caller about to call it, instead of after a stub's first call */
  synthSlot(name: string, d: Synth, eager = false): number {
    this.touching?.add("!" + name);
    const { slot, fresh } = this.slots.synthSlot(name);
    if (!fresh) return slot;
    const s = { k: "synth" as const, name, d, done: false };
    this.slots.set(slot, s);
    if (!this.instantiates) return slot;
    // the app build may hold its code, which its module puts in the slot
    if (this.aot?.installSynth(name)) { s.done = true; return slot; }
    if (eager) { this.tiers.linkSlot(slot); return slot; }
    this.table.set(slot, this.stubsFor([d])[0]);
    return slot;
  }
  /** asks again for the synthetic functions the hosts asked for in a World whose classes have other ids */
  replay(infos: InfoRecord[]): void { for (const r of infos) { try { replayInfo(this, r); } catch { /* a question the Program no longer answers */ } } }
  /** the synthetic function `name` a precompiled module calls, which its numbering has reserved but whose stub may not exist yet */
  ensureSynth(name: string): void {
    if (name.startsWith("conflict:")) {
      const [key, message] = JSON.parse(name.slice("conflict:".length)) as [string, string];
      this.conflictSlot(key, message); return;
    }
    const kinds = /^(abstract|interfaceAccess):([ILJ]*)>([ILJV])$/.exec(name);
    if (!kinds) { this.synthSlot(name, rtfns.get(name)!); return; }
    const k: Kinds = { params: [...kinds[2]] as Kind[], ret: kinds[3] as Kind | "V" };
    if (kinds[1] === "abstract") this.abstractSlot(k); else this.interfaceAccessSlot(k);
  }
  /** a stub for a method the class does not implement: AbstractMethodError, with the signature of the vtable entry it fills */
  private abstractSlot({ params, ret }: Kinds): number {
    return this.synthSlot(`abstract:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => { cx.callThrower(c, "ame"); } });
  }

  private dispatchSlot(key: string, target: ReturnType<typeof symbolicDispatchFor>): number {
    return target ? failed(target) ? this.conflictSlot(key, target.message) : this.slotOf(target) : this.abstractSlot(entryKinds(key));
  }

  /** A default conflict keeps the physical dispatch signature and throws only when invoked. */
  private conflictSlot(key: string, message: string): number {
    return this.synthSlot("conflict:" + JSON.stringify([key, message]), { ...entryKinds(key), body: (cx, c) => {
      cx.linkError(c, { thrower: "icce", message });
    } });
  }

  private interfaceAccessSlot({ params, ret }: Kinds): number {
    return this.synthSlot(`interfaceAccess:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => {
      cx.construct(c, cx.prog.resolve("java/lang/IllegalAccessError", "<init>", "()V")!); c.throw_(cx.tag);
    } });
  }

  // ---------- runtime and class modules
  compile(bytes: Uint8Array): WebAssembly.Module {
    const t0 = performance.now(), mod = compileModule(bytes);
    this.stats.moduleMs += performance.now() - t0; this.stats.bytes += bytes.length;
    return mod;
  }
  instantiate(mod: Uint8Array | WebAssembly.Module, imports: Record<string, Record<string, unknown>>): WebAssembly.Instance {
    const m = ArrayBuffer.isView(mod) ? this.compile(mod as Uint8Array) : mod as WebAssembly.Module, t0 = performance.now();
    const inst = new WebAssembly.Instance(m, imports as WebAssembly.Imports); // the lib's import values omit tags
    this.stats.instantiateMs += performance.now() - t0; this.stats.instances++;
    return inst;
  }
  private importLink(mb: ModuleBuilder): number {
    return mb.importFunc("rt", "link", mb.addFuncType([T.i32], []));
  }
  /** Lazy-link stubs, one per signature for every slot of it: a call through the table names its slot in rt.callee (CALLEE), which the stub links and
   *  calls again. A module's cost to the engine is mostly fixed, so the module making the stubs a request lacks also makes those of every signature
   *  the dexes loaded since the last one declare. */
  private stubs = new Map<string, Function>();
  private stubbedDexes = new Set<DexFile>();
  private stubsFor(kinds: Kinds[]): Function[] {
    const lacking = new Map<string, Kinds>(), want = (k: Kinds) => { const key = stubKey(k); if (!this.stubs.has(key)) lacking.set(key, k); };
    kinds.forEach(want);
    if (lacking.size) {
      for (const p of [this.prog.base, this.prog]) for (const [dex] of p?.loadedDexes() ?? []) {
        if (this.stubbedDexes.has(dex)) continue;
        this.stubbedDexes.add(dex);
        for (const s of dex.shorties()) {
          const params = [...s.slice(1)].map(kindOf), ret: Kind | "V" = s[0] === "V" ? "V" : kindOf(s[0]);
          want({ params, ret }); want({ params: ["L" as Kind, ...params], ret });
        }
      }
      const mb = new ModuleBuilder(); declareBase(mb);
      mb.importGlobal("rt", "callee", T.i32, true);
      mb.importTable("rt", "table", T.funcref, 0);
      const link = this.importLink(mb), made = [...lacking];
      made.forEach(([, k], i) => {
        const sig = kindsType(mb, k), c = new Code(k.params.length), slot = c.newLocal(T.i32);
        c.gget(CALLEE).ltee(slot).call(link);
        k.params.forEach((_, j) => c.lget(j));
        mb.export(String(i), "func", mb.addFunc(sig, c.lget(slot).callIndirect(sig).finish(), "stub"));
      });
      const x = this.instantiate(mb.build(), { rt: this.rtImports() }).exports;
      made.forEach(([k], i) => this.stubs.set(k, x[i] as Function));
    }
    return kinds.map((k) => this.stubs.get(stubKey(k))!);
  }
  /** the imports of a class module's shared stubs (classModule), named by signature */
  stubImports(mod: WebAssembly.Module): Record<string, Function> {
    const keys = WebAssembly.Module.imports(mod).filter((i) => i.module === "stub").map((i) => i.name);
    const fns = this.stubsFor(keys.map((key) => { const [params, ret] = key.split(":"); return { params: [...params] as Kind[], ret: ret as Kind | "V" }; }));
    return Object.fromEntries(keys.map((key, i) => [key, fns[i]]));
  }
  /** puts the lazy-link stub back in `slot`, unless it holds code nothing here can stand in for */
  restoreStub(slot: number, s = this.slots.at(slot)): boolean {
    const k = s?.k === "method" ? methodKinds(s.m) : s?.k === "synth" ? s.d : s?.k === "thrower" ? { params: THROWERS[s.name].params, ret: "V" as const } : undefined;
    if (k) this.table.set(slot, this.stubsFor([k])[0]);
    return !!k;
  }
  private addLinker(mb: ModuleBuilder, state: [number, number, number]): number {
    const sig = mb.addFuncType([T.i32], []), link = mb.importFunc("host", "link", sig);
    const due = mb.importFunc("host", "linkDue", mb.addFuncType([T.i32], [T.i32]));
    const wait = mb.importFunc("host", "linkWait", sig), sync = mb.importFunc("host", "sync", mb.addFuncType([T.i32, T.externref, T.f64], [T.i32]));
    const c = new Code(1);
    const saved = [c.newLocal(T.i32), c.newLocal(T.anyref), c.newLocal(T.i32)];
    const restore = () => {
      state.forEach((global, i) => c.lget(saved[i]).gset(global));
      c.i32(Sync.Resume).refNull(HT.extern).f64const(0n).call(sync).drop();
    };
    c.lget(0).call(due).if_();
    state.forEach((global, i) => c.gget(global).lset(saved[i]));
    // Promise reactions may idle another strand after admission restores it, before Wasm resumes.
    c.block().block(T.exnref).tryTable(null, [[3, 0, 0]]).lget(0).call(wait).end().br(1).end();
    restore(); c.throwRef(); c.end();
    restore();
    c.else_().lget(0).call(link).end();
    return mb.addFunc(sig, c.finish(), "$link");
  }
  private startRuntime(): void {
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    mb.export("tag", "tag", mb.addTag(b.tTagFn));
    const i32Init = (v: number) => { const o = [0x41]; sleb(v, o); return o; };
    mb.export("callee", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    const uleb2 = (v: number) => { const o: number[] = []; uleb(v, o); return o; };
    mb.export("alloc", "global", mb.addGlobal(T.i32, true, i32Init(-ALLOC_WINDOW)));
    mb.export("hash", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    // the Class objects by class id (grown by classOf) and the id of the running Java thread, which init words record
    mb.export("ctab", "global", mb.addGlobal(refNull(b.tData.ref), true, [...i32Init(256), 0xfb, 7, ...uleb2(b.tData.ref)]));
    mb.export("unsafeSlots", "global", mb.addGlobal(refNull(b.tVT), true, new Code(0).refNull(b.tVT).b));
    const sid = mb.addGlobal(T.i32, true, i32Init(ROOT)), thr = mb.addGlobal(T.anyref, true, [0xd0, 0x6e]), depth = mb.addGlobal(T.i32, true, i32Init(0));
    mb.export("sid", "global", sid); mb.export("thr", "global", thr); mb.export("depth", "global", depth);
    const link = this.addLinker(mb, [sid, thr, depth]);
    mb.export("link", "func", link);
    mb.export("iw", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    mb.export("wait", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    const cid = mb.addFunc(mb.addFuncType([refNull(b.tObj)], [T.i32]), new Code(1).lget(0).refAsNonNull().structGet(b.tObj, 0).i32(H.ID).arrayGet(b.tVT).finish(), "classId");
    mb.export("classId", "func", cid);
    mb.export("nop", "func", mb.addFunc(mb.addFuncType([], []), new Code(0).finish(), "nop"));
    for (const name of Object.keys(SLOT) as Thrower[]) {
      const params = THROWERS[name].params.map((k) => kindVT(k)), sig = mb.addFuncType(params, []);
      const c = new Code(params.length).i32(SLOT[name]).call(link);
      params.forEach((_, i) => c.lget(i));
      const f = mb.addFunc(sig, c.i32(SLOT[name]).callIndirect(sig).finish(), "stub:" + name);
      mb.addElemActive(0, SLOT[name], [f]);
      this.slots.set(SLOT[name], { k: "thrower", name, done: false });
    }
    const x = this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host }).exports as Record<string, any>;
    this.rt = { tag: x.tag, alloc: x.alloc, hash: x.hash, ctab: x.ctab, unsafeSlots: x.unsafeSlots, sid: x.sid, thr: x.thr, depth: x.depth, iw: x.iw, wait: x.wait, callee: x.callee, classId: x.classId, link: x.link, nop: x.nop };
  }

  rtImports() { const { tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, callee, link } = this.rt; return { table: this.table, nm: this.nm, tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, callee, link, mem: this.mem, sp: this.sp, gmem: this.opts.guest?.memory, gflags: this.opts.guest?.flags }; }

  /** the class module of `name`, built on first use */
  link(name: string): ClassRt {
    this.touching?.add(name);
    let rt = this.classes.get(name);
    if (rt) return rt;
    const late = this.cha.admit(name);
    if (late) this.joined(late);
    const aot = this.aot?.linkClass(name);
    if (aot) { this.classes.set(name, aot); this.repairVtable(name); return aot; }
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    let slotBase = this.aot?.reservedBase(name) ?? this.slots.preassigned.get(name);
    slotBase ??= this.slots.numberBlock(name, methods.length + 1);
    if (!this.instantiates) {
      this.classes.set(name, rt = { name, id, mod: this.opts.build ? this.aot!.extraMod : "c" + id, slotBase, nMethods: methods.length, exports: {} });
      return rt;
    }
    // the class's globals are made when something first reads them, in one module with those of the other classes linked meanwhile
    const w = this;
    let exports: WebAssembly.Exports | undefined;
    rt = { name, id, mod: "c" + id, slotBase, nMethods: methods.length,
      get exports() { if (!exports) w.buildClasses(); return exports!; }, set exports(x) { exports = x; } };
    this.classes.set(name, rt);
    this.unbuilt.push(rt);
    this.stubClass(rt, jc);
    this.stats.classes++; this.stats.classMs += performance.now() - t0;
    if (jc?.dex && id > (this.aot?.nSeeded ?? 0) && !name.includes("@")) this.demand.classes.push(name);
    return rt;
  }
  /** classes linked on demand whose globals no module holds yet (World.link) */
  private unbuilt: ClassRt[] = [];
  private buildClasses(): void {
    const t0 = performance.now();
    // a vtable can link the classes it names
    while (this.unbuilt.length) {
      const rts = this.unbuilt;
      this.unbuilt = [];
      const t1 = performance.now(), bytes = this.classModule(rts, true);
      this.stats.phase.classBuild += performance.now() - t1;
      const exports = this.instantiate(bytes, {}).exports;
      for (const rt of rts) rt.exports = exports;
    }
    this.stats.classMs += performance.now() - t0;
  }
  /** the vtable of a class module the platform build holds was made before this World's host classes: the entries of the methods they implement (abstract in the build) are put right */
  private repairVtable(name: string): void {
    if (!this.instantiates) return;
    const repairs = this.hosts.vtableRepairs(name);
    if (!repairs.length) return;
    const set = this.hostFn("vt:set:" + name, ["I", "I"], "V", (cx, c) => { c.gget(cx.vtGlobal(name)).refAsNonNull().lget(0).lget(1).arraySet(cx.tVT); });
    for (const [at, slot] of repairs) set(at, slot);
  }
  /** a host class defined after classes were linked from the build: repairs the vtables of the ones it concerns */
  repairLinked(): void { for (const [name, rt] of this.classes) if (rt.mod[0] === "g" || rt.mod[0] === "e") this.repairVtable(name); }
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
      const jc = this.prog.get(name);
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
      c.anyConvertExtern().i32(this.synthSlot("strLit", rtfns.get("strLit")!)).callIndirect(mb.addFuncType([T.anyref], [T.anyref]));
    };
    const nullInit = (t: number) => { const o = [0xd0]; sleb(t, o); return o; };
    const zero = (k: Kind) => (k === "I" ? [0x41, 0] : k === "J" ? [0x42, 0] : [0xd0, 0x6e]);
    const words = rts.map(({ name, id }) => name[0] === "[" || !this.prog.get(name)?.isInterface ? this.vtWords(name, id) : undefined);
    // The engine evaluates a constant initializer's operands one by one at instantiation, and admits at most 10,000 in array.new_fixed. A module with
    // many vtables makes them in its start function from one data segment instead, which costs a function to compile.
    const total = words.reduce((n, w) => n + (w?.length ?? 0), 0), fromData = total > VT_DATA_WORDS || words.some((w) => w && w.length > 10_000);
    const vts: { g: number; words: Int32Array }[] = [];
    for (const [i, rt] of rts.entries()) {
      const { name, id, slotBase } = rt, jc = this.prog.get(name), methods = jc?.methods ?? [], w = words[i];
      if (w) {
        const init = fromData ? nullInit(b.tVT) : [];
        if (!fromData) { for (const x of w) { init.push(0x41); sleb(x, init); } init.push(0xfb, 0x08); uleb(b.tVT, init); uleb(w.length, init); }
        const g = mb.addGlobal(refNull(b.tVT), true, init);
        if (fromData) vts.push({ g, words: w });
        mb.export(id + ":vt", "global", g);
      }
      // a class with nothing to initialize (no static values or <clinit>, nor supertypes that have) starts initialized: there is no event to wait for or report
      const initialize = !!jc && this.needsInit(name), initG = mb.addGlobal(T.i32, true, [0x41, initialize ? 0 : INIT_DONE]);
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
  private stubClass(rt: ClassRt, jc: JClass | undefined): void {
    const want: Kinds[] = (jc?.methods ?? []).map(methodKinds), ensure = rt.slotBase + rt.nMethods;
    if (jc && this.needsInit(rt.name)) want.push({ params: [], ret: "V" });
    else if (jc) this.table.set(ensure, this.rt.nop);
    this.stubsFor(want).forEach((f, i) => this.table.set(rt.slotBase + i, f));
  }
  /** the body of ensure() of class `cls` in a unit `cx` compiles (Compiler.buildUnit), which imports the class's globals */
  ensureBody(cx: Compiler, cls: string, c: Code): void {
    const jc = this.prog.require(cls), rt = this.link(cls);
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
    const rtfn = (name: string) => this.synthSlot(name, rtfns.get(name)!);
    if (hasSignatureConstraints(this, jc.name)) {
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
    if (jc.sup && this.needsInit(jc.sup)) call(this.ensureSlot(jc.sup));
    for (const i of this.prog.defaultIfaces(jc.name)) if (this.needsInit(i)) call(this.ensureSlot(i));
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

  // ---------- compiling methods on demand
  /** the classes linked so far, and those with a method that has been called (a method's slot is done once it has run or its precompiled code is installed) */
  usage(): { linked: string[]; called: string[] } {
    return { linked: [...this.classes.keys()], called: this.slots.calledClasses() };
  }
  unitClock(): Clock { return { start: performance.now(), accounted: this.stats.compileMs }; }
  /** instantiates a built unit, has `place` put its functions where they are called, then records what their code relies on */
  instantiateUnit<T>(cx: Pick<Compiler, "assumptions" | "absent">, imports: Record<string, any>, built: Built, slot: number | undefined, clock: Clock, place: (exports: Record<string, any>) => T): T {
    // Imports can compile nested units; charge that work once, to its own unit.
    this.accountCompilation(clock);
    const exports = this.instantiate(built.bytes, imports).exports;
    if (cx instanceof Compiler) for (const [key, sig] of cx.sharedOut) if (!this.sharedHelpers.has(key)) { this.sharedHelpers.set(key, sig); this.sharedFns[key] = exports[key] as Function; }
    const placed = place(exports);
    this.recordUnit(cx, built.traces, slot);
    return placed;
  }
  accountCompilation(clock: Clock): void {
    this.stats.compileMs += performance.now() - clock.start - (this.stats.compileMs - clock.accounted);
  }
  private recordUnit(cx: Pick<Compiler, "assumptions" | "absent">, traces: FnTrace[], slot?: number): void {
    for (const t of traces) if (t.m) this.traces.set(t.name, t);
    // a compile can link a class after deciding about its supertypes' implementations, and a worker's hierarchy has only the deferred classes it linked
    const late = this.cha.late.size && cx.assumptions.length ? this.lateBy(new Set(cx.assumptions.map(([decl]) => decl)), this.cha.late) : undefined;
    for (const [decl, name, desc, target, owner] of cx.assumptions) {
      const at = owner ? this.slotOf(owner) : slot;
      if (at === undefined) throw new Error("compiled assumption has no invalidation owner");
      const tc = target?.cls ?? "", tk = target?.key ?? "", by = late?.get(decl);
      if (by && !this.holds({ name, desc, tc, tk }, by)) { this.invalidate(at); continue; }
      const key = `${decl}.${name}${desc}`;
      let a = this.assumptions.get(key);
      if (!a) this.assumptions.set(key, a = { decl, name, desc, tc, tk, slots: new Set() });
      a.slots.add(at);
    }
    for (const [name, owner] of cx.absent) {
      const at = owner ? this.slotOf(owner) : slot;
      if (at === undefined) throw new Error("compiled absence has no invalidation owner");
      const slots = this.absent.get(name) ?? this.absent.set(name, new Set()).get(name)!;
      slots.add(at);
    }
  }
  /** the class globals compiled code imports from modules the caller has not named: each comes from the module of the class whose id starts its name (code made by another World,
   *  an app build's or a worker's, names classes only by id) */
  classImports(required: Iterable<readonly [string, string]>, imports: Record<string, Record<string, unknown>>): void {
    const given = new Set(Object.keys(imports));
    for (const [module, name] of required) {
      if (given.has(module)) continue;
      // module c<id> names one class linked on demand: its holder's exports serve all of it
      if (module[0] === "c") { imports[module] = this.link(this.nameOf(+module.slice(1))).exports; given.add(module); continue; }
      (imports[module] ??= {})[name] = this.link(this.nameOf(+name.slice(0, name.indexOf(":")))).exports[name];
    }
  }
  /** whether native method `id` ("class.name+descriptor") has a host binding here, making its import available */
  nativeBound(id: string): boolean {
    if (id.startsWith("settle:") || id === "land" || id.startsWith("land:")) return true;
    const m = methodOf(this.prog, /#(?:s|p)$/.test(id) ? id.slice(0, -2) : id);
    return !!m && this.natives.prepare(m);
  }
  /** the helpers first-tier units share (Compiler.shareHelpers): their signatures, and the functions the unit that defined them exports */
  sharedHelpers = new Map<string, FunctionType>();
  private sharedFns: Record<string, Function> = {};
  unitImports(cx: Compiler): Record<string, any> {
    const imports: Record<string, any> = { rt: this.rtImports(), host: this.host, h: this.sharedFns,
      n: this.nativeImports(cx.nativeImports.keys()), symbolic: this.symbolicImports([...cx.symbolicImports.values()].map(v => v.site)) };
    for (const [mod, rt] of cx.deps) imports[mod] = rt.exports;
    return imports;
  }
  /** the natives `ids` as the "n" import module; one closure per native serves every module */
  nativeImports(ids: Iterable<string>): Record<string, Function> {
    const out: Record<string, Function> = {}, miss: string[] = [];
    for (const id of ids) { const f = this.nativeFns.get(id); if (f) out[id] = f; else miss.push(id); }
    if (miss.length) for (const [id, f] of Object.entries(this.natives.imports(this.hostContext(), miss))) this.nativeFns.set(id, out[id] = f);
    return out;
  }
  symbolicResolutions = 0;
  private symbolicOperations = new Map<string, Function>();
  private symbolicTable = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  symbolicSites = new Map<string, { slot: WebAssembly.Global; ready?: boolean }>();
  symbolicStubModules = 0;
  symbolicImports(sites: SymbolicSite[]): Record<string, unknown> {
    const out: Record<string, unknown> = { table: this.symbolicTable };
    const fresh = sites.filter(([name]) => !this.symbolicSites.has(name));
    if (fresh.length) {
      const clock = this.unitClock();
      const cx = new Compiler(this), table = cx.mb.importTable("symbolic", "table", T.funcref, 0);
      const sync = cx.mb.importFunc("symbolic", "sync", cx.sig([], "I"));
      const binding: Record<string, unknown> = { table: this.symbolicTable, sync: this.symbolicSync.bind(this) };
      const pending = fresh.map(([name, cls, index, pc, inputs, output]) => {
        const method = methodAt(this.prog.require(cls), index);
        if (!method) throw new Error(`Missing symbolic site method ${name}`);
        const slot = this.symbolicTable.grow(1);
        const plain = cx.mb.importFunc("symbolic", name, cx.sig([], "V")), wait = cx.mb.importFunc("symbolic", name + "#s", cx.sig([], "V"));
        const resolver = this.symbolicResolver(method, pc, slot, inputs, output), params = inputs.map(i => i[1]);
        binding[name] = resolver.plain; binding[name + "#s"] = resolver.wait;
        return { name, slot, params, output, plain, wait, method };
      });
      const built = cx.buildSyntheticGroup(pending.map(({ name, slot, params, output, plain, wait }) => ({
        name, params, ret: output, body: (c: Code) => {
          emitRestored(cx, c, [], [], () => { c.call(sync).if_().call(plain).else_().call(wait).end(); });
          params.forEach((_, i) => c.lget(i)); c.i32(slot).callIndirect(cx.sig(params, output), table);
        },
      })));
      const imports = this.unitImports(cx); imports.symbolic = binding;
      this.stats.units++;
      this.instantiateUnit(cx, imports, built, this.slotOf(pending[0].method), clock, (exports) => {
        for (const { name, slot } of pending) {
          this.symbolicSites.set(name, { slot: new WebAssembly.Global({ value: "i32" }, slot) });
          this.symbolicTable.set(slot, exports[name] as Function);
        }
      });
      this.symbolicStubModules++;
    }
    for (const [name] of sites) out[name] = this.symbolicSites.get(name)!.slot;
    return out;
  }
  private symbolicSync(): number { return +(this.inSynchronousJava() || this.sched.current().root); }
  private symbolicResolver(method: MethodInfo, pc: number, slot: number, inputs: SymbolicSite[4], output: SymbolicSite[5]) {
    const run = () => {
      this.symbolicResolutions++;
      const owner = this.sched.current(), clock = this.unitClock(), ins = decodeInstruction(method.dex.code(method.codeOff).insns, pc);
      this.accountCompilation(clock);
      const install = () => {
        const clock = this.unitClock();
        const initiated = initiatedInstruction(this, method, ins);
        let key = initiated ? symbolicOperationKey(method, ins, inputs, output) : undefined;
        let operation = key === undefined ? undefined : this.symbolicOperations.get(key);
        if (operation) {
          this.symbolicOperations.delete(key!);
          this.accountCompilation(clock);
        }
        else {
          const { cx, built } = compileSymbolicSite(this, method, ins, inputs, output);
          this.stats.units++;
          operation = this.instantiateUnit(cx, this.unitImports(cx), built, this.slotOf(method), clock, (e) => e.m as Function);
          const mb = cx.mb;
          if (cx.assumptions.length || cx.absent.length || cx.gaps.length || cx.linkErrors.length || cx.nativeImports.size
            || built.traces.some(t => t.m) || mb.globals.length || mb.tables.length || mb.tags.length || mb.elems.length || mb.datas.length) {
            key = undefined;
          }
        }
        if (key !== undefined) {
          // an older initialization guard remains valid: class initialization never reverses, and calls still use the live method table
          this.symbolicOperations.set(key, operation);
          if (this.symbolicOperations.size > 2048) this.symbolicOperations.delete(this.symbolicOperations.keys().next().value!);
        }
        this.symbolicTable.set(slot, operation);
        if (initiated) {
          const binding = this.symbolicSites.get(`${method.cls}:${method.index}:${pc}`);
          if (binding) binding.ready = true;
          this.tiers.hotUnits.resolved(`${method.cls}:${method.index}:${pc}`);
        }
      };
      const ready = resolveInstruction(this, method, ins, owner);
      return ready instanceof Promise ? ready.then(install) : install();
    };
    return { plain: () => this.synchronous(run), wait: this.sched.suspending(run) };
  }
  private nativeFns = new Map<string, Function>();
  private hostCtx?: HostContext;
  private hostContext(): HostContext {
    return this.hostCtx ??= { mem: this.mem, sp: this.sp, bridge: this.bridge, gap: (what) => this.onGap(what), sched: this.sched, throwable: (cls, msg) => this.makeThrowable(cls, msg), raise: (e) => this.exception(e) };
  }
  private throwMakers = new Map<string, (msg: string | null) => object>();
  /** a Java throwable of class `cls` with `msg`, built by a synthetic Wasm function: the way a native raises one */
  makeThrowable(cls: string, msg: string | null): object {
    let make = this.throwMakers.get(cls);
    if (!make) {
      const f = this.hostFn("mk:" + cls, ["L"], "L", (cx, c) => {
        const ctor = this.prog.resolve(cls, "<init>", "()V"), detail = this.prog.resolveField("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")!, st = cx.structFor("java/lang/Throwable");
        const exn = c.newLocal(T.anyref);
        cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(exn);
        if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
        c.lget(exn).refCast(st).lget(0).structSet(st, cx.fieldIndex("java/lang/Throwable", detail)).lget(exn);
      });
      this.throwMakers.set(cls, make = (m) => f(m === null ? null : this.javaString(m)));
    }
    return this.synchronous(() => make!(msg));
  }
  /** the methods (ids) whose first-tier code ran a loop for 64 chunks in one entry: their second tier keeps loops in chunks, so a long activation of it is not held in the engine's baseline code */
  longLoops = new Set<string>();
  /** classes some compiled code allocates: the ones a virtual call is likely to find */
  allocated = new Set<string>();
  // ---------- compiling ahead of the first call, in idle time

  // ---------- open world
  /** A BaseDexClassLoader supplies its immutable library graph before opening its own DEX path. Metadata and ahead-of-time code may already exist. */
  bindLibraries(loader: Loader, before: Loader[], after: Loader[]): void {
    const priorBefore = loader.before ?? [], priorAfter = loader.after ?? [];
    const same = (a: Loader[], b: Loader[]) => a.length === b.length && a.every((l, i) => l === b[i]);
    if (same(priorBefore, before) && same(priorAfter, after)) return;
    const changed = this.prog.libraryChanges(loader, before, after);
    // An app build attached before Java bound the libraries it was compiled under stays valid once they are.
    this.rebindResolution(loader, changed, () => this.prog.libraries(loader, before, after, changed), () => this.prog.libraries(loader, priorBefore, priorAfter, changed), "Class loader libraries",
      () => loader === this.prog.root && !!this.aot?.boundAsBuilt());
  }
  /** The app's loader resolves through Java (loaders.ts standardPath): code of the default namespace linked as the Program resolves is undone, and its references resolve as they run. */
  dynamicRoot(): void {
    if (this.prog.dynamicRoot) return;
    this.prog.dynamicRoot = true;
    this.aot?.unbindApp();
    for (let b = 0; b < this.slots.blockClass.length; b++) {
      const dex = this.prog.get(this.slots.blockClass[b])?.dex;
      if (dex && this.prog.loaderOfDex(dex) === this.prog.root) for (let i = 0; i < this.slots.methodsIn(b); i++) this.invalidate(this.slots.blockBase[b] + i);
    }
    this.epoch++;
    this.opts.compiler?.namespaces();
  }
  initiateClass(loader: Loader, name: string, key: string): void {
    const prior = this.prog.initiatedBy(loader, name);
    if (prior === key) return;
    if (prior) throw this.exception(this.makeThrowable("java/lang/LinkageError", `Class loader already initiated ${name}`));
    if (this.prog.lookup(loader, name) === key) { this.prog.initiate(loader, name, key); return; }
    this.rebindResolution(loader, new Set([name]), () => this.prog.initiate(loader, name, key), () => this.prog.forgetInitiated(loader, name), "Class initiation");
  }
  resolveClass(loader: Loader, name: string, owner: Strand): string | Promise<string> {
    return resolveClass(this, loader, name, owner);
  }
  /** applies `change`, which resolves the `changed` names differently, unless that would change linked dispatch or hierarchy */
  private rebindResolution(loader: Loader, changed: ReadonlySet<string>, change: () => string[], undo: () => string[], reason: string, keepApp = () => false): void {
    // Inherited dispatch also depends on interfaces that have not themselves been linked.
    const changing = changed.size ? this.prog.resolutionClasses(loader, changed) : undefined;
    // With no class resolving through the loader yet (one binding its libraries before it opens its dexes), the graph still changes what later definitions
    // resolve to, in the compile worker too.
    if (!changing?.size) { change(); this.opts.compiler?.namespaces(); return; }
    const targets = new Map<Assumption, { target: MethodInfo; declared: MethodInfo }>();
    for (const a of this.assumptions.values()) {
      const target = a.tc ? this.prog.get(a.tc)?.byKey.get(a.tk) : undefined;
      const declared = this.prog.resolve(a.decl, a.name, a.desc);
      if (target && target.key === a.tk && target.desc === a.desc && declared && !declared.isStatic && declared.desc === a.desc) targets.set(a, { target, declared });
    }
    const dependentOn = (changed: Set<string>) => {
      const affected = new Map<string, boolean>();
      const depends = (name: string): boolean => {
        if (changed.has(name)) return true;
        const hit = affected.get(name); if (hit !== undefined) return hit;
        affected.set(name, true);
        const c = this.prog.get(name), result = !!c && (c.sup ? [c.sup, ...c.ifaces] : c.ifaces).some(depends);
        affected.set(name, result); return result;
      };
      return depends;
    };
    const types = changedTypes(changed), exact = !!types;
    const mentions = (descriptor: string) => !exact || [...javaName(descriptor).matchAll(/L([^;]+);/g)].some(m => changed.has(m[1]));
    const depends = dependentOn(changing);
    // Changed identities affect dispatch through matching signatures or inherited types, including unlinked interfaces.
    const hierarchy = exact ? dependentOn(new Set([...changing].filter(name => {
      const c = this.prog.get(name)!;
      return (c.sup ? [c.sup, ...c.ifaces] : c.ifaces).some(parent => changed.has(javaName(parent)));
    }))) : depends;
    // A class's slots come from the methods its superclass chain declares; testing their keys spares building its slots and members.
    const chainMentions = new Map<string, boolean>();
    const mentioned = (name: string): boolean => {
      let hit = chainMentions.get(name); if (hit !== undefined) return hit;
      const c = this.prog.get(name);
      hit = !!c && (!!c.sup && mentioned(c.sup) || !c.isInterface && declaresNaming(c, types));
      chainMentions.set(name, hit); return hit;
    };
    const dispatch = [...this.classes.keys()].filter(name => depends(name) && (hierarchy(name) || mentioned(name))).map(name => ({ name, methods: this.vslots(name).map(key => {
      return symbolicDispatchFor(this.prog, name, key);
    }) }));
    // Only the classes of the dexes that resolve through the changed loader have their types rewritten.
    const existing = [...this.classes].filter(([name]) => changing.has(name)).map(([name, rt]) => {
      const c = this.prog.get(name)!, statics = !types || declaresStaticOf(c, types) ? c.fields.filter(f => f.isStatic) : [];
      return { name, rt, sup: c.sup, ifaces: [...c.ifaces], statics: statics.map(field => ({ field, desc: field.desc })) };
    });
    const names = change();
    if (!names.length) return;
    this.vslotCache.clear();
    // A kept app build was made under the new graph: the classes laid out by its data modules already have the new hierarchy and dispatch.
    const kept = keepApp(), builtUnderNew = (name: string) => kept && this.classes.get(name)?.mod[0] === "e";
    for (const old of dispatch) {
      if (builtUnderNew(old.name)) continue;
      const methods = this.vslots(old.name).map(key => symbolicDispatchFor(this.prog, old.name, key));
      if (methods.length !== old.methods.length || methods.some((m, i) => {
        const prior = old.methods[i];
        return m !== prior && !(m && prior && failed(m) && failed(prior) && m.candidates.length === prior.candidates.length && m.candidates.every((candidate, index) => candidate === prior.candidates[index]));
      })) {
        undo(); this.vslotCache.clear();
        throw this.exception(this.makeThrowable("java/lang/LinkageError", `${reason} changed linked dispatch of ${old.name}`));
      }
    }
    // A changed superclass would change the physical GC layout of already linked instances. Constructor-time library binding must precede that resolution.
    for (const old of existing) {
      const cls = this.prog.get(old.name)!;
      if (builtUnderNew(old.name)) continue;
      if (cls.sup !== old.sup || cls.ifaces.join("\0") !== old.ifaces.join("\0")) {
        undo(); this.vslotCache.clear();
        throw this.exception(this.makeThrowable("java/lang/LinkageError", `${reason} changed linked hierarchy of ${old.name}`));
      }
    }
    // A class's globals keep the names its module gave them: an app build made under the new graph has them already.
    for (const old of existing) {
      for (const { field, desc } of old.statics) if (desc !== field.desc) {
        const oldKey = `${old.rt.id}:s:${field.name}:${desc}`, newKey = `${old.rt.id}:s:${field.name}:${field.desc}`;
        if (oldKey in old.rt.exports && !(newKey in old.rt.exports)) old.rt.exports = { ...old.rt.exports, [newKey]: old.rt.exports[oldKey] };
      }
    }
    this.epoch++;
    this.opts.compiler?.namespaces();
    this.cha.reindex(); this.planner.forgetImplementations();
    this.fieldReaders.clear();
    this.vslotCache.clear(); this.imtCache.clear();
    // Existing code and app builds used the previous namespace, except a kept build, which was made under this one. Platform code retains its defining boot namespace.
    const refreshed = new Set(names);
    // a slot without state has never been compiled here
    const builtUnder = (slot: number) => { const s = this.slots.peek(slot); return (!s || s.k === "method" && !s.hot && !this.demand.methods.has(s.m)) && !!this.aot?.fromAppBuild(slot); };
    for (let b = 0; b < this.slots.blockClass.length; b++) if (refreshed.has(this.slots.blockClass[b])) {
      for (let i = 0; i < this.slots.methodsIn(b); i++) if (!kept || !builtUnder(this.slots.blockBase[b] + i)) this.invalidate(this.slots.blockBase[b] + i);
    }
    if (names.some(name => this.prog.loaderOfDex(this.prog.get(name)!.dex!) === this.prog.root) && !kept) this.aot?.unbindApp();
    let lateBy: Map<string, string[]> | undefined;
    const subtypesOf = (decl: string) => (lateBy ??= this.lateBy(new Set([...this.assumptions.values()].map(a => a.decl)), this.cha.members())).get(decl) ?? [];
    const changedSubtypes = new Map<string, string[]>(), hierarchySubtypes = new Map<string, string[]>();
    for (const [key, a] of this.assumptions) {
      for (const slot of a.slots) {
        const state = this.slots.peek(slot);
        // Unmaterialized AOT slots and private helper owners can still hold live code.
        if (!this.helperInvalidations.has(slot) && state && (state.k === "ensure" || !state.done)) a.slots.delete(slot);
      }
      if (!a.slots.size) { this.assumptions.delete(key); continue; }
      const saved = targets.get(a), declared = this.prog.resolve(a.decl, a.name, a.desc);
      const sameTarget = saved && saved.target === this.prog.get(a.tc)?.byKey.get(a.tk) && saved.target.key === a.tk && saved.target.desc === a.desc;
      const samePrototype = declared && declared === saved?.declared && !declared.isStatic && declared.desc === a.desc;
      const narrow = !mentions(a.desc), cache = narrow ? hierarchySubtypes : changedSubtypes;
      let by = cache.get(a.decl);
      if (!by) cache.set(a.decl, by = subtypesOf(a.decl).filter(narrow ? hierarchy : depends));
      if (sameTarget && samePrototype && this.holds(a, by)) continue;
      for (const slot of a.slots) this.invalidate(slot);
      this.assumptions.delete(key);
    }
    for (const slots of this.absent.values()) for (const slot of slots) this.invalidate(slot);
    this.absent.clear();
  }
  /** load more dexes. A CHA decision that one of their classes falsifies is undone: its callers go back to lazy-link stubs, so the next call
   *  compiles against the new hierarchy. Frames already executing keep the old code. */
  addDexes(dexes: DexFile[], loader: Loader = this.prog.root): string[] {
    const added = this.prog.add(dexes, loader);
    this.epoch++;
    this.opts.compiler?.added(dexes, loader);
    if (loader === this.prog.root || loader === this.prog.boot) this.joined(this.cha.index(added));
    else this.cha.defer(dexes);
    this.loaded(added);
    return added;
  }
  private claimers = new Map<string, boolean>();
  /** whether a store into instance field `f` hands its owner a native handle: a long field of a class that frees it in finalize() */
  claims(f: FieldInfo): boolean {
    if (f.kind !== "J" || f.isStatic) return false;
    let yes = this.claimers.get(f.owner);
    if (yes === undefined) this.claimers.set(f.owner, yes = !!this.prog.get(f.owner)?.byKey.get("finalize()V")?.codeOff);
    return yes;
  }
  /** keeps a Java object in the table compiled code reads by index (the Method objects of a proxy class) */
  pin(object: object): number {
    let i = this.pinned.get(object);
    if (i === undefined) {
      i = this.pinned.size; this.pinned.set(object, i);
      if (i >= this.nm.length) this.nm.grow(this.nm.length);
      this.nm.set(i, object as never);
    }
    return i;
  }
  /** the native blocks of the direct buffers, freed when the object that owns each is collected, and their sizes by address */
  private blocks = new FinalizationRegistry<bigint>((address) => { this.blockSizes.delete(Number(address)); this.opts.guest!.free(address); });
  private blockSizes = new Map<number, number>();
  /** a zeroed native block of `n` bytes that lives as long as `owner`, a MemoryRef (memory.ts); its address, or 0 */
  private allocGuest(owner: object, n: number): bigint {
    const guest = this.opts.guest;
    if (!guest) throw new Error("this World has no guest memory");
    const address = guest.alloc(n);
    if (address) { this.blocks.register(owner, address); this.blockSizes.set(Number(address), n); }
    return address;
  }
  /** whether the guest memory is shared, which a module that imports it must declare */
  get guestShared(): boolean { return !!this.opts.guest && !(this.opts.guest.memory.buffer instanceof ArrayBuffer); }
  /** makes the class a registered spec implements in the host a Java class, now or once its superclass is defined (hostclass.ts) */
  addHostClass(spec: HostSpec): void { this.hosts.add(spec); this.opts.compiler?.added(null); }
  /** the classes this World made without a dex (the host's, their hidden halves, proxies): a compile worker applies the same specs and must end with the same ones */
  hostClassNames(): string[] { return [...this.prog.own()].filter((c) => !c.dex).map((c) => c.name).sort(); }
  private settlingHosts = false;
  readonly proxies = new Map<string, ProxyDefinition>();
  /** adds a class that no dex defines, with the body of each of its methods */
  addClass(jc: JClass, bodies: Map<MethodInfo, Intrinsic>, loader = this.prog.root, proxy?: ProxyDefinition): void {
    for (const [m, body] of bodies) this.madeUp.set(mid(m), body);
    this.prog.addClass(jc, loader);
    this.epoch++;
    // the host classes a dex arriving defines are defined by the worker's own settling of the same dex
    if (proxy) {
      this.proxies.set(jc.name, proxy); this.opts.compiler?.proxy(proxy);
    } else if (!this.settlingHosts) this.opts.compiler?.added(null);
    this.joined(this.cha.index([jc.name]));
    this.loaded([jc.name]);
  }
  private loaded(added: string[]): void {
    this.planner.forgetImplementations();
    if (this.absent.size) for (const name of added) {
      const slots = this.absent.get(name);
      if (!slots) continue;
      for (const slot of slots) this.invalidate(slot);
      this.absent.delete(name);
    }
    this.settlingHosts = true;
    try { this.hosts.loaded(); } finally { this.settlingHosts = false; }
  }
  /** undoes the decisions a concrete class among `reached`, which joining the class hierarchy made reachable, falsifies */
  private joined(reached: Set<string>): void {
    // a decision about the implementations of decl.name+desc changes only when a concrete subtype of decl that has one becomes reachable
    const now = this.lateBy(new Set([...this.assumptions.values()].map(a => a.decl)), reached);
    for (const [key, a] of this.assumptions) {
      const by = now.get(a.decl);
      if (!by || this.holds(a, by)) continue;
      for (const slot of a.slots) this.invalidate(slot);
      this.assumptions.delete(key);
    }
  }
  /** the concrete classes among `names` by each of their supertypes in `decls`, themselves included. Only the supertypes an assumption names are asked
   *  about, so no index of every class by every supertype is kept: an app's classes number in the hundreds of thousands, each with dozens of supertypes. */
  private lateBy(decls: ReadonlySet<string>, names: Iterable<string>): Map<string, string[]> {
    const out = new Map<string, string[]>(), memo = new Map<string, readonly string[]>(), none: readonly string[] = [];
    // most classes reach no decl or the decls of one supertype only: those share an array
    const within = (n: string): readonly string[] => {
      const memoed = memo.get(n);
      if (memoed) return memoed;
      const c = this.prog.get(n);
      let s: readonly string[] = decls.has(n) ? [n] : none, found: Set<string> | undefined;
      const join = (xs: readonly string[]) => {
        if (!xs.length || xs === s) return;
        if (!s.length) { s = xs; return; }
        found ??= new Set(s);
        for (const x of xs) found.add(x);
      };
      if (c) { if (c.sup) join(within(c.sup)); for (const i of c.ifaces) join(within(i)); }
      if (found) s = [...found];
      memo.set(n, s);
      return s;
    };
    for (const n of names) {
      const c = this.prog.get(n);
      if (!c || c.isInterface || c.flags & ACC.ABSTRACT) continue;
      for (const d of within(n)) { let a = out.get(d); if (!a) out.set(d, a = []); a.push(n); }
    }
    return out;
  }
  /** whether the implementation code relied on for decl.name+desc (`tc`'s method `tk`, none if empty) stands once the concrete classes `by`, all subtypes of decl, exist */
  holds(a: { name: string; desc: string; tc: string; tk: string }, by: string[]): boolean {
    const target = a.tc ? this.prog.get(a.tc)?.byKey.get(a.tk) : undefined;
    for (const n of by) { const m = this.prog.dispatchFor(n, a.name, a.desc); if (m && (failed(m) || m !== target)) return false; }
    return true;
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  invalidate(slot: number): void {
    this.tiers.hotUnits.forget(slot);
    const helper = this.helperInvalidations.get(slot);
    if (helper) { helper(); this.stats.invalidated++; return; }
    for (const x of this.tiers.groupOf.get(slot) ?? [slot]) {
      // a slot without state holds compiled code only if a loaded build module installed it
      const s = this.slots.peek(x) ?? (this.aot?.installed(x) ? this.slots.at(x) : undefined);
      if (s?.k === "ensure" || !s?.done || !this.restoreStub(x, s)) continue;
      s.done = false; if (s.k === "method") s.hot = false; this.stats.invalidated++;
      this.tiers.groupOf.delete(x);
    }
  }

  // ---------- calling in from JS, and exceptions
  /** a JS function that calls the Java method; a Java exception arrives as a WebAssembly.Exception (see `throwable`) */
  entry(cls: string, name: string, desc: string): (...args: unknown[]) => unknown {
    const { slot, ensure, params, ret } = this.entryCall(cls, name, desc), call = this.invoker(params, ret);
    return (...args) => this.synchronous(() => {
      this.tiers.refreshHotUnits();
      // an exception leaves the frames it unwound counted
      const depth = this.rt.depth.value;
      try { return this.hostString(call(slot, ensure, ...args.map((a) => this.javaValue(a)))); } catch (e) { throw this.boundary(e); } finally { this.rt.depth.value = depth; }
    });
  }
  /** `entry` for a call that may block: it runs on a stack of its own, as a new strand of the main thread, and answers a Promise */
  entryAsync(cls: string, name: string, desc: string): (...args: unknown[]) => Promise<unknown> {
    const { slot, ensure, params, ret } = this.entryCall(cls, name, desc), call = this.invoker(params, ret, true);
    return async (...args) => {
      const s = this.sched.strand();
      try { return this.hostString(await call(s, slot, ensure, ...args.map((a) => this.javaValue(a)))); } catch (e) { throw this.boundary(e); } finally { s.end(); }
    };
  }
  private entryCall(cls: string, name: string, desc: string) {
    const m = this.entryMethod(cls, name, desc);
    return { slot: this.slotOf(m), ensure: m.isStatic && this.needsInit(m.cls) ? this.ensureSlot(m.cls) : -1, ...methodKinds(m) };
  }
  private entryMethod(cls: string, name: string, desc: string): MethodInfo {
    const m = this.prog.resolve(cls, name, desc);
    if (!m) throw new Error(`entry ${cls}.${name}${desc} not found`);
    return m;
  }
  /** runs `f`, a call into Java, leaving the frame depth as it was when a Java exception unwinds it */
  unwound<T>(f: () => T): T {
    const depth = this.rt.depth.value;
    try { return f(); } catch (e) { this.rt.depth.value = depth; throw e; }
  }
  /** the Java throwable a call from JS threw, if `e` is one */
  throwable(e: unknown): object | undefined {
    return e instanceof WebAssembly.Exception && e.is(this.rt.tag) ? e.getArg(this.rt.tag, 0) as object : undefined;
  }
  /** the Wasm exception that throws Java throwable `t` */
  exception(t: object): WebAssembly.Exception { return new WebAssembly.Exception(this.rt.tag, [t]); }
  /** the class of a Java object that crossed to JS */
  classNameOf(obj: object): string { return this.nameOf(this.rt.classId(obj)); }
  /** V8 does not let Wasm catch its stack overflow RangeError, so Java handlers cannot see it; at the edge of the Java world it
   *  becomes the StackOverflowError a handler above this call would have received */
  boundary(e: unknown): unknown {
    if (!isStackOverflow(e)) return e;
    const depth = this.rt.depth.value;
    try { this.rt.callee.value = SLOT.soe; (this.table.get(SLOT.soe) as Function)(); } catch (x) { return x; } finally { this.rt.depth.value = depth; }
    return e;
  }
  private javaStack(stack: string, count = Infinity, lines = true): JavaFrame[] {
    // Each callFn enters a fresh engine stack. Keep only that stack's frames,
    // then append its suspended callers. The marker's name is explicit, even in minified builds.
    // A caller that has not suspended is still on the physical stack, beyond its call's marker.
    const segments = (text: string) => {
      const out: string[][] = [[]];
      for (const row of text.split("\n")) {
        if (row.includes("at webdroid:callFn (")) out.push([]);
        else if (row.includes("wasm-function[")) out[out.length - 1].push(row);
      }
      return out;
    };
    const physical = segments(stack), parts = [physical[0]];
    let next = 1;
    for (let caller = this.bridgeStacks.get(this.sched.current()); caller; caller = caller.prior)
      parts.push(caller.stack ? segments(caller.stack.stack ?? "")[0] : physical[next++] ?? []);
    return javaFrames(parts.flat().join("\n"), this.frameTraces, count, lines);
  }
  /** the innermost `count` Java frames, including callers suspended at host bridges */
  callerFrames(count: number): JavaFrame[] {
    for (const limit of [16, 48]) {
      const frames = this.javaStack(deepStack(limit).stack ?? "", count, false);
      if (frames.length >= count) return frames;
    }
    return this.javaStack(deepStack().stack ?? "", count, false);
  }
  /** captured frames without the throwable's own construction */
  stackTrace(state: object): JavaFrame[] {
    const captured = this.stacks.get(state);
    if (!captured) return [];
    const frames = Array.isArray(captured) ? captured : javaFrames(captured.stack ?? "", this.frameTraces);
    let skip = 0;
    while (skip < frames.length && /^(fillInStackTrace|nativeFillInStackTrace)$|^<init>$/.test(frames[skip].method) && (frames[skip].method !== "<init>" || this.prog.isSubclass(frames[skip].cls.replace(/\./g, "/"), "java/lang/Throwable"))) skip++;
    return frames.slice(skip);
  }
  private synchronousEntries = 0;
  inSynchronousJava(): boolean { return this.synchronousEntries > 0; }
  synchronous<T>(run: () => T): T {
    this.synchronousEntries++;
    try { return run(); } finally { this.synchronousEntries--; }
  }
  private freshStack<T>(run: () => T): T {
    this.tiers.refreshHotUnits();
    const prior = this.synchronousEntries; this.synchronousEntries = 0;
    try { return run(); } finally { this.synchronousEntries = prior; }
  }
  private hostFns = new Map<string, Function>();
  // Private helper owners do not consume method-table numbering shared with compile workers.
  private helperSlots: (Function | undefined)[] = [];
  private helperInvalidations = new Map<number, () => void>();
  private helperGetter(slot: number, rebuild: (slot: number) => Function): () => Function {
    let dirty = false;
    this.helperInvalidations.set(slot, () => { dirty = true; });
    return () => {
      // an invalidation while it rebuilds holds for the next call
      if (dirty) { dirty = false; this.helperSlots[-slot - 1] = rebuild(slot); }
      return this.helperSlots[-slot - 1]!;
    };
  }
  private helperUnit(cx: Compiler, imports: Record<string, any>, built: { bytes: Uint8Array; traces: FnTrace[] }, clock: Clock, rebuild: (slot: number) => Function, slot?: number): { get: () => Function; raw?: Function } {
    const dependent = cx.assumptions.some(a => !a[4]) || cx.absent.some(a => !a[1]);
    if (slot !== undefined || !dependent) return this.instantiateUnit(cx, imports, built, slot, clock, (e) => { const raw = e.m as Function; return { get: () => raw, raw }; });
    const at = -this.helperSlots.push(undefined);
    return this.instantiateUnit(cx, imports, built, at, clock, (e) => { this.helperSlots[-at - 1] = e.m as Function; return { get: this.helperGetter(at, rebuild) }; });
  }
  private hostRebuilder(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void): (slot: number) => Function {
    return slot => this.buildHostFn(name, params, ret, body, prepare, slot).get();
  }
  private buildHostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void, slot?: number) {
    const clock = this.unitClock(), cx = new Compiler(this); prepare?.(cx);
    const built = cx.buildSynthetic(name, params, c => body(cx, c), ret);
    this.stats.units++;
    return this.helperUnit(cx, this.unitImports(cx), built, clock, this.hostRebuilder(name, params, ret, body, prepare), slot);
  }
  /** a helper callable from the host: its function, or one that follows its rebuilds */
  private synchronousHelper({ get, raw: fixed }: { get: () => Function; raw?: Function }): Function {
    if (fixed) return this.sched.synchronousExport(fixed);
    let raw: Function | undefined, call: Function;
    return (...args: unknown[]) => {
      const current = get();
      if (raw !== current) { raw = current; call = this.sched.synchronousExport(raw); }
      return call(...args);
    };
  }
  /** runs the Cleaner of a native allocation once its referent has been collected (sun.misc.Cleaner.create), as ART's reference queue daemon does: as a call
   *  that may block, since a thunk may wait (FileChannelImpl's Unmapper unmaps a file mapping). The Cleaner reports a failing thunk itself. */
  private clean?: (cleaner: object) => Promise<unknown>;
  private cleaners = new FinalizationRegistry<object>((cleaner) => {
    (this.clean ??= this.entryAsync("sun/misc/Cleaner", "clean", "()V"))(cleaner).catch(() => {});
  });
  /** a function over Java values, generated once under `name` and callable from the host: an int is a number, a long a bigint, a reference an opaque value */
  hostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void): (...a: any[]) => any {
    let f = this.hostFns.get(name);
    if (!f) {
      this.hostFns.set(name, f = this.synchronousHelper(this.buildHostFn(name, params, ret, body, prepare)));
    }
    return f as never;
  }
  /** calls the method in table slot `slot`, first running the class initializer in slot `ensure` unless it is -1: one helper per signature serves every method of it */
  invoker(params: Kind[], ret: Kind | "V", suspend: true): (s: Strand, slot: number, ensure: number, ...a: unknown[]) => unknown;
  invoker(params: Kind[], ret: Kind | "V", suspend?: false): (slot: number, ensure: number, ...a: unknown[]) => unknown;
  invoker(params: Kind[], ret: Kind | "V", suspend = false): (...a: any[]) => unknown {
    const name = `inv${suspend ? "s" : ""}:${params.join("")}>${ret}`, all: Kind[] = ["I", "I", ...params];
    const body = (cx: Compiler, c: Code, arg: (i: number) => void) => {
      arg(1); c.i32(0).raw(OP.i32_ge_s).if_(); arg(1); c.callIndirect(cx.sig([], "V")).end();
      params.forEach((_, i) => arg(i + 2)); arg(0); c.callIndirect(cx.sig(params, ret));
    };
    return suspend ? this.callFn(name, all, ret, body) : this.hostFn(name, all, ret, (cx, c) => body(cx, c, (i) => { c.lget(i); }));
  }
  private callFns = new Map<string, (s: Strand, ...a: any[]) => unknown>();
  // The compiled call must not retain the emitter closure and its Compiler.
  // Build it in a separate activation from the persistent token/caller state.
  private callRebuilder(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare: ((cx: Compiler) => void) | undefined, state: { d: WebAssembly.Global; v: WebAssembly.Global; thr: WebAssembly.Global }): (slot: number) => Function {
    return slot => this.buildCallFn(name, params, ret, body, prepare, state, slot).get();
  }
  private buildCallFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void, state?: { d: WebAssembly.Global; v: WebAssembly.Global; thr: WebAssembly.Global }, slot?: number) {
    const clock = this.unitClock(), cx = new Compiler(this), vt = ret === "V" ? T.i32 : ret === "L" ? T.externref : kindVT(ret);
    prepare?.(cx);
    const d = state?.d ?? new WebAssembly.Global({ value: "i32", mutable: true }, 0), thr = state?.thr ?? new WebAssembly.Global({ value: "externref", mutable: true }, null);
    const v = state?.v ?? new WebAssembly.Global({ value: ret === "J" ? "i64" : ret === "L" ? "externref" : "i32", mutable: true }, ret === "J" ? 0n : ret === "L" ? null : 0);
    const built = cx.buildSynthetic(name, ["I", ...params], (c) => {
      const done = cx.global("call", "d", T.i32, true), value = cx.global("call", "v", vt, true), thrown = cx.global("call", "x", T.externref, true);
      const e = c.newLocal(T.anyref), res = ret === "V" ? -1 : c.newLocal(kindVT(ret));
      c.block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
      body(cx, c, (i) => { c.lget(i + 1); });
      if (res >= 0) { c.lset(res).lget(res); if (ret === "L") c.externConvertAny(); c.gset(value); }
      c.lget(0).gset(done);
      if (res >= 0) c.lget(res);
      c.ret().end().unreachable().end();
      c.lset(e).lget(e).externConvertAny().gset(thrown).i32(0).lget(0).raw(OP.i32_sub).gset(done).lget(e).throw_(cx.tag);
    }, ret);
    this.stats.units++;
    const { get, raw } = this.helperUnit(cx, { ...this.unitImports(cx), call: { d, v, x: thr } }, built, clock, this.callRebuilder(name, params, ret, body, prepare, { d, v, thr }), slot);
    return { get, raw, d, v, thr };
  }
  /** a Java call that may wait, made of `body` over the parameters (`arg(i)` pushes parameter i; the body leaves a result of kind `ret`), run on strand `s`: the result at once when the
   *  call did not wait (a Java exception is thrown as a WebAssembly.Exception), else a Promise of it. The module records how the call ended in globals of its own, which the
   *  call's token says are this call's: a promising export answers a Promise even when it never waited. */
  callFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void): (s: Strand, ...a: any[]) => unknown {
    let f = this.callFns.get(name);
    if (f) return f;
    const { get, raw, d, v, thr } = this.buildCallFn(name, params, ret, body, prepare);
    const enter = raw ? (s: Strand, ...args: unknown[]) => s.call(raw, ...args)
      : (s: Strand, ...args: unknown[]) => s.call(get(), ...args);
    Object.defineProperty(enter, "name", { value: "webdroid:callFn" });
    let token = 0;
    this.callFns.set(name, f = (s, ...args) => {
      token = token % 0x3fffffff + 1;
      // Java callers stay on the physical stack until the call suspends; only then are their frames captured.
      const javaCaller = !this.sched.current().root || this.inSynchronousJava();
      const caller: BridgeStack = { prior: this.bridgeStacks.get(s), done: false };
      this.bridgeStacks.set(s, caller);
      const leave = () => {
        caller.done = true;
        if (this.bridgeStacks.get(s) !== caller) return;
        let prior = caller.prior;
        while (prior?.done) prior = prior.prior;
        if (prior) this.bridgeStacks.set(s, prior); else this.bridgeStacks.delete(s);
      };
      const mine = token;
      let p: Promise<unknown>;
      try { p = this.freshStack(() => enter(s, mine, ...args)); } catch (error) { leave(); throw error; }
      const state = d.value as number;
      if (state !== mine && state !== -mine) {
        if (javaCaller && !caller.stack) { caller.stack = deepStack(); this.stats.bridgeCallerCaptures++; }
        const complete = () => {
          if (d.value === mine && ret === "L") v.value = null;
          else if (d.value === -mine) thr.value = null;
          leave();
        };
        p.then(complete, complete); return p;
      }
      leave();
      p.catch(() => {});
      // the globals are not to keep the last result alive
      if (state < 0) { const t = thr.value as object; thr.value = null; throw this.exception(t); }
      const result = ret === "V" ? undefined : v.value;
      if (ret === "L") v.value = null;
      return result;
    });
    return f;
  }
  private fieldReaders = new Map<string, (obj: object) => unknown>();
  /** a JS function reading instance field `name` of `cls` from a Java object that crossed to JS (a reference field gives an opaque object) */
  fieldReader<T = unknown>(cls: string, name: string, desc: string): (obj: object) => T {
    const key = cls + "." + name + ":" + desc;
    let read = this.fieldReaders.get(key);
    if (!read) {
      const f = this.prog.resolveField(cls, name, desc);
      if (!f) throw new Error(`field ${cls}.${name} not found`);
      this.fieldReaders.set(key, read = this.synchronousHelper(this.buildHostFn("get:" + key, ["L"], f.kind, (cx, c) => {
        const st = cx.structFor(cls);
        c.lget(0).refAsNonNull().refCast(st).structGet(st, cx.fieldIndex(cls, f));
      })) as (obj: object) => unknown);
    }
    return read as (obj: object) => T;
  }
}
