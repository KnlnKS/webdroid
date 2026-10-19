// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals; its methods' contiguous block of table slots starts with the lazy-link stub of each one's signature.
//  - Every call between modules is `call_indirect slot` after storing the slot in rt.callee, so a compiled method needs no relinking. A stub
//    calls host.link(callee), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry, then calls through the slot.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
import { symbolicInstruction } from "../compiler/sites.ts";
import { HT, ModuleBuilder, T, refNull, sleb, uleb, type FunctionType } from "../compiler/wasmbin.ts";
import { Code } from "../compiler/code.ts";
import { type Program, ACC, changedTypes, declaredMethod, declaresNaming, declaresStaticOf, methodAt, methodCount, javaName, methodKinds, type Kinds, type Loader, type Kind, type JClass, type MethodInfo, type FieldInfo } from "../compiler/program.ts";
import { Cha } from "../compiler/cha.ts";
import { H } from "../compiler/consts.ts";
import { Compiler, MATH_IMPORTS, declareBase, intrinsicFor, kindVT, type FnTrace, type Intrinsic } from "../compiler/j2w.ts";
import type { CompileService, GuestMemory, HostBridge, HostContext, HostNet, HostSpec, NativeBinder } from "./hostapi.ts";
import { Sched, defaultLoop, type HostLoop, type Strand } from "./sched.ts";
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
import { initiatedInstruction, resolveClass, resolveForName, resolveCatch } from "./resolution.ts";
import { hasSignatureConstraints, validateSignatures } from "./signatures.ts";
import { SLOT, FIRST_FREE_SLOT, SCRATCH_BASE, INIT_DONE, THROWERS, ALLOC_WINDOW, excMessage, isStackOverflow, type JavaFrame, type Thrower } from "../compiler/exc.ts";
import { type PreparedInstruction } from "../../jvm/prepared.ts";
import { HEAP_LIMIT } from "../../jvm/abi.ts";
import { mid, methodOf } from "../compiler/ids.ts";
import { failed, symbolicDispatchFor, unresolvedClass } from "../compiler/linkage.ts";
import { NO_INDEX, type DexFile } from "../../jvm/dex.ts";
import { compileModule, suspending } from "./module.ts";
import { AotRuntime, type AotBuild, type AotStore, type AppIndex } from "./aot.ts";
import { Numbers, type Marks, type Numbering } from "./numbers.ts";
import { SlotTable } from "./slots.ts";
import { Planner } from "./planning.ts";
import { Tiering } from "./tiering.ts";
import { AheadCompiler } from "./ahead.ts";
import { Dispatch } from "./dispatch.ts";
import { ClassModules } from "./classmodule.ts";
import { Stubs } from "./stubs.ts";
import { HostFunctions } from "./hostfns.ts";
import { StackTraces } from "./stacks.ts";
import { SymbolicSites } from "./symbolicsites.ts";
import { Sync, ROOT } from "../compiler/hostcalls.ts";


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
  readonly dispatch = new Dispatch(this);
  readonly classModules = new ClassModules(this);
  readonly stubs = new Stubs(this);
  readonly helpers = new HostFunctions(this);
  readonly stacks = new StackTraces(this);
  readonly symbolic = new SymbolicSites(this);
  classes = new Map<string, ClassRt>();
  /** what this World built because no saved code had it: the methods compiled at their first call and the classes whose modules it made, in order (an app build made later includes them) */
  readonly demand = { methods: new Set<MethodInfo>(), classes: [] as string[], infos: [] as InfoRecord[] };
  traces = new Map<string, FnTrace>();
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
      imtMiss: (cls: number, sel: number) => this.dispatch.imtMiss(cls, sel),
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
      watch: (referent: unknown, cleaner: object) => { if (typeof referent === "object" && referent !== null) this.helpers.cleaners.register(referent, cleaner); },
      classByName: (name: string, scope: unknown, mode: number) => {
        const text = this.hostString(name) as string;
        return park(mode === Lookup.ForName ? resolveForName(this, text, scope as object | null, this.sched.current()) : classByName(this, text, scope, mode), 0);
      },
      dexOpen: (path: unknown, loader: object | null) => park(dexOpen(this, path, loader), null),
      dexOpenMemory: (buffers: object, arrays: object, starts: object, ends: object, loader: object | null) => park(dexOpenMemory(this, buffers, arrays, starts, ends, loader), null),
      // the class `n` frames out from the caller of the native; 0 when the stack is not that deep
      stackClass: (n: number) => {
        const frames = this.stacks.callerFrames(n + 2), f = frames[n + 1];
        return f ? this.idOf(f.cls.replace(/\./g, "/")) : 0;
      },
      excMessage: (kind: number, a: number, b: number, c: number, d: number, e: number) => {
        const message = this.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => id < 0 ? this.numbers.gapList[this.lastGap] : this.numbers.links.message(id)!);
        if (message !== null && (kind === SLOT.ncdfr || kind === SLOT.nsme || kind === SLOT.nsfer)) this.onUnresolved(message, kind === SLOT.ncdfr ? unresolvedClass(message) : undefined);
        return message;
      },
      capture: (exn: object) => this.stacks.capture(exn),
      stFrames: (state: object | null) => state ? this.stacks.stackTrace(state) : [],
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
    this.host.catchSync = () => this.symbolic.symbolicSync();
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
    return (this.fromJs ??= this.helpers.hostFn("str:from", ["L"], "L", (cx, c) => { c.lget(0).externConvertAny(); cx.str.fromHost(c); }))(s);
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
    this.table.set(slot, this.stubs.stubsFor([d])[0]);
    return slot;
  }
  /** asks again for the synthetic functions the hosts asked for in a World whose classes have other ids */
  replay(infos: InfoRecord[]): void { for (const r of infos) { try { replayInfo(this, r); } catch { /* a question the Program no longer answers */ } } }
  /** the synthetic function `name` a precompiled module calls, which its numbering has reserved but whose stub may not exist yet */
  ensureSynth(name: string): void {
    if (name.startsWith("conflict:")) {
      const [key, message] = JSON.parse(name.slice("conflict:".length)) as [string, string];
      this.dispatch.conflictSlot(key, message); return;
    }
    const kinds = /^(abstract|interfaceAccess):([ILJ]*)>([ILJV])$/.exec(name);
    if (!kinds) { this.synthSlot(name, rtfns.get(name)!); return; }
    const k: Kinds = { params: [...kinds[2]] as Kind[], ret: kinds[3] as Kind | "V" };
    if (kinds[1] === "abstract") this.dispatch.abstractSlot(k); else this.dispatch.interfaceAccessSlot(k);
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
    if (aot) { this.classes.set(name, aot); this.classModules.repair(name); return aot; }
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    let slotBase = this.aot?.reservedBase(name) ?? this.slots.preassigned.get(name);
    slotBase ??= this.slots.numberBlock(name, methods.length + 1);
    if (!this.instantiates) {
      this.classes.set(name, rt = { name, id, mod: this.opts.build ? this.aot!.extraMod : "c" + id, slotBase, nMethods: methods.length, exports: {} });
      return rt;
    }
    this.classes.set(name, rt = this.classModules.lazy(name, id, slotBase, jc));
    this.stats.classes++; this.stats.classMs += performance.now() - t0;
    if (jc?.dex && id > (this.aot?.nSeeded ?? 0) && !name.includes("@")) this.demand.classes.push(name);
    return rt;
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
      n: this.nativeImports(cx.nativeImports.keys()), symbolic: this.symbolic.symbolicImports([...cx.symbolicImports.values()].map(v => v.site)) };
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
  private nativeFns = new Map<string, Function>();
  private hostCtx?: HostContext;
  private hostContext(): HostContext {
    return this.hostCtx ??= { mem: this.mem, sp: this.sp, bridge: this.bridge, gap: (what) => this.onGap(what), sched: this.sched, throwable: (cls, msg) => this.helpers.makeThrowable(cls, msg), raise: (e) => this.exception(e) };
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
    if (prior) throw this.exception(this.helpers.makeThrowable("java/lang/LinkageError", `Class loader already initiated ${name}`));
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
    const dispatch = [...this.classes.keys()].filter(name => depends(name) && (hierarchy(name) || mentioned(name))).map(name => ({ name, methods: this.dispatch.vslots(name).map(key => {
      return symbolicDispatchFor(this.prog, name, key);
    }) }));
    // Only the classes of the dexes that resolve through the changed loader have their types rewritten.
    const existing = [...this.classes].filter(([name]) => changing.has(name)).map(([name, rt]) => {
      const c = this.prog.get(name)!, statics = !types || declaresStaticOf(c, types) ? c.fields.filter(f => f.isStatic) : [];
      return { name, rt, sup: c.sup, ifaces: [...c.ifaces], statics: statics.map(field => ({ field, desc: field.desc })) };
    });
    const names = change();
    if (!names.length) return;
    this.dispatch.forget();
    // A kept app build was made under the new graph: the classes laid out by its data modules already have the new hierarchy and dispatch.
    const kept = keepApp(), builtUnderNew = (name: string) => kept && this.classes.get(name)?.mod[0] === "e";
    for (const old of dispatch) {
      if (builtUnderNew(old.name)) continue;
      const methods = this.dispatch.vslots(old.name).map(key => symbolicDispatchFor(this.prog, old.name, key));
      if (methods.length !== old.methods.length || methods.some((m, i) => {
        const prior = old.methods[i];
        return m !== prior && !(m && prior && failed(m) && failed(prior) && m.candidates.length === prior.candidates.length && m.candidates.every((candidate, index) => candidate === prior.candidates[index]));
      })) {
        undo(); this.dispatch.forget();
        throw this.exception(this.helpers.makeThrowable("java/lang/LinkageError", `${reason} changed linked dispatch of ${old.name}`));
      }
    }
    // A changed superclass would change the physical GC layout of already linked instances. Constructor-time library binding must precede that resolution.
    for (const old of existing) {
      const cls = this.prog.get(old.name)!;
      if (builtUnderNew(old.name)) continue;
      if (cls.sup !== old.sup || cls.ifaces.join("\0") !== old.ifaces.join("\0")) {
        undo(); this.dispatch.forget();
        throw this.exception(this.helpers.makeThrowable("java/lang/LinkageError", `${reason} changed linked hierarchy of ${old.name}`));
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
    this.helpers.forgetFieldReaders();
    this.dispatch.forget();
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
        if (!this.helpers.isHelper(slot) && state && (state.k === "ensure" || !state.done)) a.slots.delete(slot);
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
    if (this.helpers.invalidate(slot)) { this.stats.invalidated++; return; }
    for (const x of this.tiers.groupOf.get(slot) ?? [slot]) {
      // a slot without state holds compiled code only if a loaded build module installed it
      const s = this.slots.peek(x) ?? (this.aot?.installed(x) ? this.slots.at(x) : undefined);
      if (s?.k === "ensure" || !s?.done || !this.stubs.restoreStub(x, s)) continue;
      s.done = false; if (s.k === "method") s.hot = false; this.stats.invalidated++;
      this.tiers.groupOf.delete(x);
    }
  }

  // ---------- calling in from JS, and exceptions
  /** a JS function that calls the Java method; a Java exception arrives as a WebAssembly.Exception (see `throwable`) */
  entry(cls: string, name: string, desc: string): (...args: unknown[]) => unknown {
    const { slot, ensure, params, ret } = this.entryCall(cls, name, desc), call = this.helpers.invoker(params, ret);
    return (...args) => this.synchronous(() => {
      this.tiers.refreshHotUnits();
      // an exception leaves the frames it unwound counted
      const depth = this.rt.depth.value;
      try { return this.hostString(call(slot, ensure, ...args.map((a) => this.javaValue(a)))); } catch (e) { throw this.boundary(e); } finally { this.rt.depth.value = depth; }
    });
  }
  /** `entry` for a call that may block: it runs on a stack of its own, as a new strand of the main thread, and answers a Promise */
  entryAsync(cls: string, name: string, desc: string): (...args: unknown[]) => Promise<unknown> {
    const { slot, ensure, params, ret } = this.entryCall(cls, name, desc), call = this.helpers.invoker(params, ret, true);
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
  private synchronousEntries = 0;
  inSynchronousJava(): boolean { return this.synchronousEntries > 0; }
  synchronous<T>(run: () => T): T {
    this.synchronousEntries++;
    try { return run(); } finally { this.synchronousEntries--; }
  }
  freshStack<T>(run: () => T): T {
    this.tiers.refreshHotUnits();
    const prior = this.synchronousEntries; this.synchronousEntries = 0;
    try { return run(); } finally { this.synchronousEntries = prior; }
  }
  // ---------- functions over Java values that the host calls (hostfns.ts)
  hostFn(...a: Parameters<HostFunctions["hostFn"]>): ReturnType<HostFunctions["hostFn"]> { return this.helpers.hostFn(...a); }
  callFn(...a: Parameters<HostFunctions["callFn"]>): ReturnType<HostFunctions["callFn"]> { return this.helpers.callFn(...a); }
  fieldReader<T = unknown>(cls: string, name: string, desc: string): (obj: object) => T { return this.helpers.fieldReader<T>(cls, name, desc); }
  /** a Java throwable of class `cls` with `msg`: the way a native raises one */
  makeThrowable(cls: string, msg: string | null): object { return this.helpers.makeThrowable(cls, msg); }
}
