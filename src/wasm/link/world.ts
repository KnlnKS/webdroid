// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals, and one lazy-link stub per method, installed in a contiguous block of table slots.
//  - A stub calls host.link(slot), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry,
//    then calls through the slot; every call between modules is `call_indirect slot`, so a compiled method needs no relinking.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
//
// A build-time mode would call Compiler.buildUnit with a whole class group and install the exports without the stubs.
import { ColdInterpreter } from "../cold/interpreter";
import { ColdSlowOps } from "../cold/slowops";
import { resumeUnit, type ResumeState } from "../compiler/resume";
import type { ColdSnapshot } from "../cold/state";
import { coldUnit, supportsColdBody } from "../cold/runtime";
import { ModuleBuilder, T, ref, refNull, sleb, uleb, type VT } from "../compiler/wasmbin";
import { Code, OP } from "../compiler/code";
import { Program, ACC, kindOf, methodAt, methodCount, javaName, type Loader, type Kind, type JClass, type MethodInfo, type FieldInfo } from "../compiler/program";
import { Cha } from "../compiler/cha";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_OTHER, f32bits, f64bits } from "../compiler/consts";
import { Compiler, declareBase, intrinsicFor, kindVT, type FnTrace, type Intrinsic } from "../compiler/j2w";
import type { CompileService, GuestMemory, HostBridge, HostContext, HostNet, HostSpec, NativeBinder } from "./hostapi";
import { Sched, defaultLoop, ROOT, SYSTEM_LOADER, type HostLoop, type Strand } from "./sched";
import { rtfns, type Synth } from "../compiler/rtfns";
import { hostInfo, infoRecord, replayInfo, typeName, type InfoRecord } from "./classes";
import { HostClasses } from "./hostclass";
import { mhInvoke } from "./mhandles";
import { hostText } from "./members";
import { ASYNC } from "./inet";
import { generateProxy } from "./proxy";
import { hostObject } from "./annotations";
import { classByName, dexOpen, loaderObject, LOADER_OF_CLASS } from "./loaders";
import { resolveClass } from "./resolution";
import { SLOT, FIRST_FREE_SLOT, HOT_BUDGET, COUNT_BASE, COUNT_SLOTS, INIT_DONE, INIT_FAILED, THROWERS, ALLOC_WINDOW, HEAP_LIMIT, excMessage, throwerBody, javaFrames, isStackOverflow, namesWasmFrames, wasmFrameNames, type JavaFrame, type Thrower } from "./exc";
import { branchTargets, decodeInstructions } from "../../jvm/prepared";
import { descToName, parseMethodDesc } from "../../jvm/abi";
import { mid, methodOf } from "../compiler/ids";
import { unresolvedClass } from "../compiler/linkage";
import type { DexFile } from "../../jvm/dex";
import { compileModule, hasJspi, suspending } from "./module";
import { AotRuntime, DEOPT_ABI, sameMarks, type AotBuild, type AotStore, type AppIndex, type Marks, type Numbering, type Tail } from "./aot";
import type { UnitResult, UpgradeJob } from "./unit";

type BridgeStack = { stack: Error; prior?: BridgeStack; done: boolean };
type CompiledActivation = Pick<ColdSnapshot, "item" | "method" | "owner" | "sync" | "depth" | "executedPc" | "edges">;

export interface WorldOptions {
  intrinsics: Map<string, Intrinsic>;
  /** the registered natives, bound to host imports by descriptor (host/natives.ts) */
  natives: NativeBinder;
  /** bytes in use on the heap; what it has grown by since the World was made is compared with the heap limit each time a window of allocation is used up */
  heapUsed: () => number;
  /** a collection of the host heap, when it has a way to ask for one: the limit applies to live data, and `heapUsed` counts the garbage not yet swept */
  collect?: () => void;
  /** how much the heap may grow before an allocation fails, where the heap is shared with other realms (a tab's processes): ART's limit, a process's own, by default */
  heapLimit?: number;
  /** resolves names for libcore's getaddrinfo; without it a lookup is a gap */
  net?: HostNet;
  /** the native core's memory, which direct buffers are allocated in; a World that only builds code needs none */
  guest?: GuestMemory;
  /** a class that frees a native handle in its finalize() owns the handle it stores in a long field: called with the object and the handle each time one is stored there (no finalizer runs here) */
  claim?: (owner: object, handle: bigint) => void;
  /** classes of the platform the host implements whole: their initializers do not run (hostclass.ts) */
  hostWhole?: (name: string) => boolean;
  /** frames V8 keeps per exception; Java stacks are deeper than its default of 10 */
  stackTraceLimit?: number;
  /** precompiled platform code (aot.ts); the Program holds exactly the platform dexes it was built from, apps are added with addDexes */
  aot?: AotStore;
  /** a build of that code: classes, slots and selectors are numbered but nothing is instantiated */
  build?: AotBuild;
  /** timers and event loop turns for threads that wait (sched.ts); the host's own where there is one */
  loop?: HostLoop;
  /** the dex files of the archive at `path`, for the DexFile natives of class loaders (loaders.ts); undefined for a file that does not exist. Dex files it answers twice
   *  that are the same objects stay in one namespace. Without it a loader cannot open dex files. */
  dexes?: (path: string) => DexFile[] | undefined | Promise<DexFile[] | undefined>;
  /** whether the inline second-tier compile waits: the host is starting an app, and what is hot now is mostly code that runs once */
  holdUpgrades?: () => boolean;
  /** an app compiled ahead on top of `aot` (apps.ts): used when this World is where it starts, the platform build attached and nothing numbered since */
  app?: { index: AppIndex; store: AotStore };
  /** compiles second-tier units elsewhere (a worker); without it, or when it declines, they are compiled here */
  compiler?: CompileService;
  /** a World that compiles for another (a worker's): classes are numbered and linked by name only, nothing is instantiated, and no code runs */
  compileOnly?: boolean;
  /** Experimental shared opcode loop; unsupported bodies are compiled before execution. */
  cold?: boolean;
  /** Emit guarded activation handoffs; runtime execution still follows cold. */
  deopt?: boolean;
}
/** a class module's exports are the class's globals under "<id>:vt", "<id>:init" and "<id>:s:<field>"; a module of several classes (aot.ts) shares them */
export interface ClassRt { name: string; id: number; mod: string; slotBase: number; nMethods: number; exports: WebAssembly.Exports }
type Slot = { k: "method"; m: MethodInfo; done: boolean; hot?: boolean; pending?: boolean; stub?: Function } | { k: "thrower"; name: Thrower; done: boolean; stub?: Function }
  | { k: "synth"; name: string; d?: Synth; done: boolean; stub?: Function } | { k: "ensure" };
/** a hot method is recompiled with up to MAX_GROUP methods in its module: the small callees (size in code units) that ran at least COPY_MIN times, and guards for at most MAX_GUARDS
 *  implementations per virtual call. A small method without a loop asks LEAF_WAITS more budgets before it is compiled alone */
const MAX_GROUP = 24, SMALL_CALLEE = 100, MAX_GUARDS = 2, LEAF_WAITS = 3, COPY_MIN = 64;
/** second-tier compiling may take at most this share of the time the program has been hot (since the first request for it), a compile being expected to need UPGRADE_MS
 *  (a mean of measured compiles would carry the first compile's warm-up of the compiler into every later decision) */
const UPGRADE_SHARE = 0.3, UPGRADE_MS = 1;
/** `stands`: whether the classes added since the platform build leave it true, once a precompiled module has checked */
/** a class-hierarchy decision: calls of decl.name+desc run only the method `tk` of class `tc` (none if empty); `stands` is its answer for the classes added so far, once asked */
interface Assumption { decl: string; name: string; desc: string; tc: string; tk: string; slots: Set<number>; stands?: boolean }

export class World {
  prog: Program;
  cha: Cha;
  table = new WebAssembly.Table({ element: "anyfunc", initial: 256 });
  /** constructs the compiler has no translation for: each compiles to host.gap(id) and a throw, never to a guess */
  gaps = new Map<string, number>();
  /** the gaps of the code in this World by id; precompiled code numbers all of its gaps, but only those of modules that are loaded are listed */
  gapList: string[] = [];
  onGap: (id: number) => void = () => {};
  /** a site naming a class, method or field the loaded classes lack ran (linkage.ts): ART's message, and the class when that is what is missing */
  onUnresolved: (message: string, cls: string | undefined) => void = () => {};
  /** the gap site that ran last, which the UnsatisfiedLinkError the code throws next names */
  private lastGap = 0;
  /** the message the last implicit exception would carry; stored in the Throwable once Strings exist */
  lastMessage: string | null = null;
  stats = { phase: { prepare: 0, flow: 0, infer: 0, facts: 0, emit: 0, encode: 0, classBuild: 0 }, aot: { d: 0, c: 0, dead: 0, missed: 0, readMs: 0, ms: 0, bytes: 0 }, classes: 0, units: 0, methods: 0, coldMethods: 0, coldCalls: 0, coldResumes: 0, coldDeopts: 0, coldResumeEntries: 0, coldSlowAdapters: 0, coldSlowModules: 0, coldSlowCalls: 0, coldSlowWaits: 0, coldTypingMethods: 0, coldSnapshotRegisters: 0, coldCallerCaptures: 0, bridgeCallerCaptures: 0, bytes: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, instances: 0, classMs: 0, invalidated: 0, upgrades: 0 };
  private slots: (Slot | undefined)[] = [];
  /** the table slots a class owns: [blockBase[i], blockBase[i] + blockSize[i]), in ascending order. A method's slot is the block's base plus its index, the last slot is the class's `ensure` */
  blockBase: number[] = [];
  private blockSize: number[] = [];
  blockClass: string[] = [];
  private classes = new Map<string, ClassRt>();
  /** what this World built because no saved code had it: the methods compiled at their first call and the classes whose modules it made, in order (an app build made later includes them) */
  readonly demand = { methods: new Set<MethodInfo>(), classes: [] as string[], infos: [] as InfoRecord[] };
  ids = new Map<string, number>();
  names = [""];
  selectors = new Map<string, number>();
  selKeys = [""];
  private vslotCache = new Map<string, string[]>();
  traces = new Map<string, FnTrace>();
  /** the traces of functions by name: those of precompiled modules are read when a stack needs them */
  private frameTraces = { get: (name: string) => {
    const t = this.traces.get(name) ?? this.aot?.trace(name);
    if (t?.m && !t.capturePcs) t.capturePcs = () => (this.captureScopes.get(this.sched.current()) ?? []).filter(s => s.state.method === t.m).map(s => s.pc).reverse();
    return t;
  } } as Map<string, FnTrace>;
  private stacks = new WeakMap<object, Error | JavaFrame[]>();
  private bridgeStacks = new WeakMap<Strand, BridgeStack>();
  private bridgeCaller?: Error;
  private frames: JavaFrame[] = [];
  assumptions = new Map<string, Assumption>();
  /** the slots whose code fails a site because a class is not loaded, by class name: loading it undoes them */
  absent = new Map<string, Set<number>>();
  /** the messages of the link errors (linkage.ts) compiled code throws, by index */
  linkMessages: string[] = [];
  /** the Method objects of proxy classes, which their compiled code reads by index (proxy.ts) */
  private nm = new WebAssembly.Table({ element: "externref", initial: 16 });
  private pinned = new Map<object, number>();
  /** scratch linear memory natives copy arrays through, and its allocation top */
  mem = new WebAssembly.Memory({ initial: Math.ceil((COUNT_BASE + 4 * COUNT_SLOTS) / 65536) + 1 });
  sp = new WebAssembly.Global({ value: "i32", mutable: true }, COUNT_BASE + 4 * COUNT_SLOTS);
  natives: NativeBinder;
  bridge: HostBridge;
  /** the classes the host implements (hostclass.ts) */
  hosts = new HostClasses(this);
  host: Record<string, Function>;
  private rt!: { tag: WebAssembly.Tag; alloc: WebAssembly.Global; hash: WebAssembly.Global; ctab: WebAssembly.Global; sid: WebAssembly.Global; thr: WebAssembly.Global; depth: WebAssembly.Global; iw: WebAssembly.Global; wait: WebAssembly.Global; classId: (o: object) => number };
  /** the threads: strands, monitors, waits (sched.ts) */
  sched!: Sched;
  private synth = new Map<string, number>();
  /** the synthetic functions whose stub module exists */
  private stubbed = new Set<number>();
  aot?: AotRuntime;
  /** what the World had numbered when its constructor returned: where a compile worker's numbering starts */
  base!: Marks;
  /** the slot reservations after the platform classes, in order */
  tail: Tail[] = [];
  /** the blocks of classes a replayed numbering (`adopt`) gave slots before their modules were made */
  preassigned = new Map<string, number>();
  /** the classes a worker is told are initialized (the World that compiles for another never runs them) */
  preInitialized = new Set<string>();
  /** how many times the default namespace was extended or something a compile worker cannot follow was added: results made before are not adopted */
  epoch = 0;
  private deoptEpoch = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  private touching: Set<string> | null = null;
  private imtCache = new Map<number, number>();
  private compiled = new Map<MethodInfo, string[]>();

  constructor(prog: Program, public opts: WorldOptions) {
    this.prog = prog;
    this.natives = opts.natives;
    this.bridge = this.natives.bridge(this);
    this.cha = new Cha(prog);
    // the heap holds the engine's own data too (the program model is hundreds of MB), which is not the Java heap ART's limit is about
    const heap = opts.heapUsed, heapBase = heap(), limit = opts.heapLimit ?? HEAP_LIMIT;
    if (opts.stackTraceLimit ?? 128) Error.stackTraceLimit = Math.max(Error.stackTraceLimit, opts.stackTraceLimit ?? 128);
    const names = (id: number) => javaName(this.names[id]);
    this.host = {
      fmod: (a: number, b: number) => a % b,
      gap: (id: number) => { this.lastGap = id; this.onGap(id); },
      link: (slot: number) => this.linkSlot(slot),
      sync: (op: number, obj: object | null, a: number) => this.sched.sync(op, obj, a),
      // without JSPI (Bun) nothing can wait, which the first attempt says
      block: hasJspi() ? suspending((op: number, obj: object | null, a: number, b: number) => {
        try { this.sched.running = this.sched.current(); return this.sched.block(op, obj, a, b); } finally { this.sched.idle(); }
      }) : () => { throw new Error("blocking needs JSPI (WebAssembly.Suspending)"); },
      hot: (slot: number) => this.upgrade(slot),
      long: (slot: number) => { const s = this.slotAt(slot); if (s?.k === "method") this.longLoops.add(mid(s.m)); },
      imtMiss: (cls: number, sel: number) => this.imtMiss(cls, sel),
      heapCheck: () => (heap() - heapBase > limit && (opts.collect?.(), heap() - heapBase > limit) ? 1 : 0),
      info: (kind: number, a: number, b: number) => {
        const synths = this.synth.size, answer = hostInfo(this, kind, a, b);
        if (this.synth.size !== synths && !opts.compileOnly) this.demand.infos.push(infoRecord(this, kind, a, b));
        return answer;
      },
      text: (kind: number, a: number) => this.javaValue(hostText(this, kind, a)),
      obj: (kind: number, a: number, b: number, filter: object | null) => (kind === LOADER_OF_CLASS ? loaderObject(this, a) : this.javaValue(hostObject(this, kind, a, b, filter))),
      annotation: (kind: number, a: number, b: number, filter: object | null) => {
        const value = hostObject(this, kind, a, b, filter);
        if (!(value instanceof Promise)) return value;
        this.sched.parkNative(value); return null;
      },
      annotationWait: suspending(() => null),
      proxy: (name: unknown, interfaces: object, loader: object | null, methods: object, exceptions: object) => this.javaValue(generateProxy(this, this.hostString(name) as string, interfaces, loader, methods, exceptions)),
      net: (op: number, node: unknown, a: number, b: number) => opts.net ? opts.net(this, op, this.hostString(node) as string, a, b) : ASYNC,
      mhInvoke: (mh: object, args: object, site: string, exact: number) => {
        const value = mhInvoke(this, mh, args, site, exact);
        if (!(value instanceof Promise)) return this.javaValue(value);
        this.sched.parkNative(value.then(v => this.javaValue(v))); return null;
      },
      galloc: (owner: object, n: number) => this.allocGuest(owner, n),
      intern: (js: string, s: object) => { let o = this.interned.get(js); if (!o) this.interned.set(js, o = s); return o; },
      claim: (owner: object, handle: bigint) => opts.claim?.(owner, handle),
      watch: (referent: unknown, cleaner: object) => { if (typeof referent === "object" && referent !== null) this.cleaners.register(referent, cleaner); },
      classByName: (name: string, scope: unknown, mode: number) => classByName(this, this.hostString(name) as string, scope, mode),
      dexOpen: (path: unknown, loader: object | null) => {
        const value = dexOpen(this, path, loader);
        if (!(value instanceof Promise)) return value;
        this.sched.parkNative(value); return null;
      },
      // the class `n` frames out from the caller of the native; 0 when the stack is not that deep
      stackClass: (n: number) => {
        const frames = this.callerFrames(n + 2), f = frames[n + 1];
        // JavaScriptCore's stack has no Wasm frame names: that is a missing capability, not a stack that is not n frames deep
        if (!namesWasmFrames()) this.onGap(this.gapId("caller class: the engine's stack names no Wasm frames"));
        return f ? this.idOf(f.cls.replace(/\./g, "/")) : 0;
      },
      excMessage: (kind: number, a: number, b: number, c: number, d: number, e: number) => {
        const message = this.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => id < 0 ? this.gapList[this.lastGap] : this.linkMessages[id]);
        if (message !== null && (kind === SLOT.ncdfr || kind === SLOT.nsme || kind === SLOT.nsfer)) this.onUnresolved(message, kind === SLOT.ncdfr ? unresolvedClass(message) : undefined);
        return message;
      },
      capture: (exn: object) => {
        const stack = new Error();
        this.stacks.set(exn, this.bridgeStacks.has(this.sched.current()) || this.cold?.hasActive(this.sched.current()) || this.captureScopes.get(this.sched.current())?.length ? this.javaStack(stack.stack ?? "") : stack);
      },
      stFrames: (state: object | null) => (this.frames = state ? this.stackTrace(state) : []).length,
      stString: (i: number, which: number) => (which ? this.frames[i].method : javaName(this.frames[i].cls)),
      stLine: (i: number) => this.frames[i].line,
    };
    this.slots.length = FIRST_FREE_SLOT;
    this.startRuntime();
    this.sched = new Sched(this, this.rt, opts.loop ?? defaultLoop);
    this.host.annotationWait = this.sched.settle();
    this.aot = opts.build ? new AotRuntime(this, opts.build) : opts.aot ? AotRuntime.attach(this, opts.aot) : undefined;
    this.appAttached = !!opts.app && !!this.aot?.extend(opts.app.index, opts.app.store);
    this.base = this.numbering();
  }
  /** whether the app build given in the options is in use */
  readonly appAttached: boolean;

  // ---------- numbering
  /** the sizes of everything numbered so far */
  numbering(): Marks { return { names: this.names.length, tail: this.tail.length, selectors: this.selKeys.length, gaps: this.gaps.size, links: this.linkMessages.length }; }
  /** what was numbered after `m` */
  since(m: Marks): Numbering {
    return { from: m, names: this.names.slice(m.names), tail: this.tail.slice(m.tail), selectors: this.selKeys.slice(m.selectors), gaps: [...this.gaps.keys()].slice(m.gaps), links: this.linkMessages.slice(m.links) };
  }
  /** numbers what `n` numbered, in its order; false, and nothing changed, unless this World has numbered exactly what `n` started from */
  adopt(n: Numbering): boolean {
    if (!sameMarks(this.numbering(), n.from)) return false;
    for (const name of n.names) this.idOf(name);
    for (const t of n.tail) {
      if (typeof t === "string") this.reserveSynth(t); else this.preassigned.set(t[0], this.addBlock(t[0], t[1]));
      this.tail.push(t);
    }
    n.selectors.forEach((k) => this.selectorId(k));
    n.gaps.forEach((g) => this.gapId(g));
    n.links.forEach((m) => this.linkId(m));
    return true;
  }
  /** forgets what was numbered after `m` (a compile worker drops the numbering of a unit its caller did not take) */
  rollback(m: Marks): void {
    for (let i = this.names.length - 1; i >= m.names; i--) { this.ids.delete(this.names[i]); this.classes.delete(this.names[i]); }
    this.names.length = m.names;
    for (let i = this.selKeys.length - 1; i >= m.selectors; i--) this.selectors.delete(this.selKeys[i]);
    this.selKeys.length = m.selectors;
    [...this.gaps.keys()].slice(m.gaps).forEach((g) => this.gaps.delete(g));
    this.gapList.length = Math.min(this.gapList.length, m.gaps);
    this.linkMessages.length = m.links;
    let top = this.slots.length;
    while (this.tail.length > m.tail) {
      const t = this.tail.pop()!;
      if (typeof t === "string") {
        top = this.synth.get(t)!;
        this.synth.delete(t); this.stubbed.delete(top);
      } else {
        top = this.blockBase.pop()!; this.blockSize.pop(); this.blockClass.pop();
        this.preassigned.delete(t[0]); this.classes.delete(t[0]);
      }
    }
    this.slots.length = top;
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
      this.addBlock(c.name, methodCount(c) + 1); n++;
    }
    return n;
  }
  /** replays the reservation of a runtime function's slot (aot.ts) */
  reserveSynth(name: string): void { this.synth.set(name, this.reserveSlots(1)); }
  /** reserves the slots of a class: one per method and one for its `ensure` */
  addBlock(name: string, size: number): number {
    const base = this.reserveSlots(size);
    this.blockBase.push(base); this.blockSize.push(size); this.blockClass.push(name);
    return base;
  }
  /** the index of the class block that owns `slot` (platform classes come first, in id order), or -1 */
  blockOf(slot: number): number {
    let lo = 0, hi = this.blockBase.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.blockBase[m] <= slot) lo = m; else hi = m - 1; }
    return lo < this.blockBase.length && slot >= this.blockBase[lo] && slot < this.blockBase[lo] + this.blockSize[lo] ? lo : -1;
  }
  /** how many methods the class of block `b` has (its `ensure` slot is the last of the block) */
  methodsIn(b: number): number { return this.blockSize[b] - 1; }
  /** the slot's entry, if it has been made */
  peek(slot: number): Slot | undefined { return this.slots[slot]; }
  /** the slot's entry; the slots of classes are made when first asked for */
  slotAt(slot: number): Slot | undefined {
    let s = this.slots[slot];
    if (s) return s;
    const b = this.blockOf(slot);
    if (b < 0) return undefined;
    const i = slot - this.blockBase[b];
    if (i === this.blockSize[b] - 1) return this.slots[slot] = { k: "ensure" };
    const m = methodAt(this.prog.get(this.blockClass[b])!, i)!;
    return this.slots[slot] = { k: "method", m, done: !!this.aot?.installed(b, m) };
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
    if (id === undefined) this.gaps.set(what, id = this.gaps.size);
    this.gapList[id] ??= what;
    return id;
  }
  /** the String objects made of JS strings, which are the constants and what String.intern answers */
  private interned = new Map<string, object>();
  /** a value a host function answers, as a Java value: a JS string becomes a String */
  javaValue<V>(v: V): V | unknown { return typeof v === "string" ? this.javaString(v) : v; }
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
  intrinsic(m: MethodInfo): Intrinsic | undefined { return this.madeUp.get(mid(m)) ?? intrinsicFor(this.opts.intrinsics, this.natives, m); }
  /** the bodies of the methods of classes made at run time (addClass), by method id */
  private madeUp = new Map<string, Intrinsic>();
  needsInit(n: string): boolean {
    const c = this.prog.get(n); if (!c) return false;
    if (c.byKey.has("<clinit>()V") || c.def?.staticValuesOff) return true;
    return (c.sup ? this.needsInit(c.sup) : false) || (!c.isInterface && this.prog.defaultIfaces(n).some((i) => this.needsInit(i)));
  }
  /** the init word of the class with id `id` (0 before its module is built) */
  initWord(id: number): number { const rt = this.loadedClass(this.names[id]); return rt ? (rt.exports[id + ":init"] as WebAssembly.Global).value as number : 0; }
  /** whether class initialization has finished, for a class whose module is already built */
  initialized(n: string): boolean { if (this.preInitialized.has(n)) return true; const rt = this.loadedClass(n); return (rt?.exports[rt.id + ":init"] as WebAssembly.Global | undefined)?.value === INIT_DONE; }
  /** the record of a class whose module is built or loaded; a platform module loaded for the classes beside it gives its other classes theirs here */
  private loadedClass(name: string): ClassRt | undefined { return this.classes.get(name) ?? (this.aot?.hasLoaded(name) ? this.link(name) : undefined); }
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
  reserveSlots(n: number): number {
    const base = this.slots.length;
    this.slots.length += n;
    const have = this.table.length;
    if (this.slots.length > have) this.table.grow(Math.max(this.slots.length - have, have));
    return base;
  }
  slotOf(m: MethodInfo): number { return this.link(m.cls).slotBase + m.index; }
  ensureSlot(cls: string): number { const rt = this.link(cls); return rt.slotBase + rt.nMethods; }
  /** the slot of the generated function `name` (runtime functions, per-class allocators, abstract-method stubs), a lazy-link stub until first called */
  synthSlot(name: string, d: Synth): number {
    this.touching?.add("!" + name);
    let slot = this.synth.get(name);
    if (slot === undefined) { this.synth.set(name, slot = this.reserveSlots(1)); this.tail.push(name); }
    if (this.stubbed.has(slot)) return slot;
    this.stubbed.add(slot);
    this.slots[slot] = { k: "synth", name, d, done: false };
    if (this.aot?.building || this.opts.compileOnly) return slot;
    // the app build may hold its code, which its module puts in the slot
    if (this.aot?.installSynth(name)) { (this.slots[slot] as { done: boolean }).done = true; return slot; }
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    const params = d.params.map((k) => kindVT(b.tObj, k)), sig = mb.addFuncType(params, d.ret === "V" ? [] : [kindVT(b.tObj, d.ret)]);
    mb.addElemActive(0, slot, [mb.addFunc(sig, this.stubBody(slot, sig, params, link), "stub:" + name)]);
    this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host });
    return slot;
  }
  /** the slot of synthetic function `name`, if it has one */
  synthSlotOf(name: string): number | undefined { return this.synth.get(name); }
  /** whether the synthetic function in `slot` has its stub or code */
  isStubbed(slot: number): boolean { return this.stubbed.has(slot); }
  /** records that the code of synthetic function `name` is in its slot */
  holdsSynth(name: string, slot: number): void { this.stubbed.add(slot); this.slots[slot] = { k: "synth", name, done: true }; }
  /** the synthetic functions of this World that have their descriptors, in numbering order: what a build makes code for */
  synths(): { name: string; slot: number; d: Synth }[] {
    const out: { name: string; slot: number; d: Synth }[] = [];
    for (const [name, slot] of this.synth) { const s = this.slots[slot]; if (s?.k === "synth" && s.d) out.push({ name, slot, d: s.d }); }
    return out.sort((a, b) => a.slot - b.slot);
  }
  /** asks again for the synthetic functions the hosts asked for in a World whose classes have other ids */
  replay(infos: InfoRecord[]): void { for (const r of infos) { try { replayInfo(this, r); } catch { /* a question the Program no longer answers */ } } }
  /** the synthetic function `name` a precompiled module calls, which its numbering has reserved but whose stub may not exist yet */
  ensureSynth(name: string): void {
    const m = /^abstract:([ILJ]*)>([ILJV])$/.exec(name);
    this.synthSlot(name, m ? { params: [...m[1]] as Kind[], ret: m[2] as Kind | "V", body: (cx, c) => { cx.callThrower(c, "ame"); } } : rtfns.get(name)!);
  }
  /** a stub for a method the class does not implement: AbstractMethodError, with the signature of the vtable entry it fills */
  private abstractSlot(key: string): number {
    const p = parseMethodDesc(key.slice(key.indexOf("(")));
    const params: Kind[] = ["L", ...p.params.map(kindOf)], ret: Kind | "V" = p.ret === "V" ? "V" : kindOf(p.ret);
    return this.synthSlot(`abstract:${params.join("")}>${ret}`, { params, ret, body: (cx, c) => { cx.callThrower(c, "ame"); } });
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
  /** a lazy-link stub for method `m` in `slot`, to put back where precompiled code was removed */
  restoreStub(slot: number, m: MethodInfo): Function {
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    const params = (m.isStatic ? [] : ["L" as Kind]).concat(m.params.map(kindOf)).map((k) => kindVT(b.tObj, k));
    const sig = mb.addFuncType(params, m.ret === "V" ? [] : [kindVT(b.tObj, kindOf(m.ret))]);
    mb.export("f", "func", mb.addFunc(sig, this.stubBody(slot, sig, params, link), "stub"));
    return this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host }).exports.f as Function;
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
    mb.export("sid", "global", mb.addGlobal(T.i32, true, i32Init(ROOT)));
    mb.export("thr", "global", mb.addGlobal(T.anyref, true, [0xd0, 0x6e]));
    mb.export("depth", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    mb.export("iw", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    mb.export("wait", "global", mb.addGlobal(T.i32, true, i32Init(0)));
    const cid = mb.addFunc(mb.addFuncType([refNull(b.tObj)], [T.i32]), new Code(1).lget(0).refAsNonNull().structGet(b.tObj, 0).i32(H.ID).arrayGet(b.tVT).finish(), "classId");
    mb.export("classId", "func", cid);
    for (const name of Object.keys(SLOT) as Thrower[]) {
      const params = THROWERS[name].params.map((k) => kindVT(b.tObj, k)), sig = mb.addFuncType(params, []);
      const f = mb.addFunc(sig, this.stubBody(SLOT[name], sig, params, link), "stub:" + name);
      mb.addElemActive(0, SLOT[name], [f]);
      this.slots[SLOT[name]] = { k: "thrower", name, done: false };
    }
    const x = this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host }).exports as Record<string, any>;
    this.rt = { tag: x.tag, alloc: x.alloc, hash: x.hash, ctab: x.ctab, sid: x.sid, thr: x.thr, depth: x.depth, iw: x.iw, wait: x.wait, classId: x.classId };
  }

  rtImports() { const { tag, alloc, hash, ctab, sid, thr, depth, iw, wait } = this.rt; return { deoptEnabled: +!!this.opts.cold, deoptEpoch: this.deoptEpoch, table: this.table, nm: this.nm, tag, alloc, hash, ctab, sid, thr, depth, iw, wait, mem: this.mem, sp: this.sp, gmem: this.opts.guest?.memory }; }

  /** the class module of `name`, built on first use */
  link(name: string): ClassRt {
    this.touching?.add(name);
    let rt = this.classes.get(name);
    if (rt) return rt;
    const aot = this.aot?.linkClass(name);
    if (aot) { this.classes.set(name, aot); this.noteInit(aot); this.repairVtable(name); return aot; }
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    let slotBase = this.aot?.reservedBase(name) ?? this.preassigned.get(name);
    if (slotBase === undefined) { slotBase = this.addBlock(name, methods.length + 1); this.tail.push([name, methods.length + 1]); }
    rt = { name, id, mod: this.aot?.building ? this.aot.extraMod : "c" + id, slotBase, nMethods: methods.length, exports: {} };
    this.classes.set(name, rt);
    if (this.aot?.building || this.opts.compileOnly) return rt;
    const bytes = this.classModule([rt]);
    this.stats.phase.classBuild += performance.now() - t0;
    rt.exports = this.instantiate(bytes, { rt: this.rtImports(), host: this.host }).exports;
    this.noteInit(rt);
    this.stats.classes++; this.stats.classMs += performance.now() - t0;
    if (jc?.dex && id > (this.aot?.nSeeded ?? 0) && !name.includes("@")) this.demand.classes.push(name);
    return rt;
  }
  /** the vtable of a class module the platform build holds was made before this World's host classes: the entries of the methods they implement (abstract in the build) are put right */
  private repairVtable(name: string): void {
    if (this.opts.compileOnly || this.aot?.building) return;
    const repairs = this.hosts.vtableRepairs(name);
    if (!repairs.length) return;
    const set = this.hostFn("vt:set:" + name, ["I", "I"], "V", (cx, c) => { c.gget(cx.vtGlobal(name)).refAsNonNull().lget(0).lget(1).arraySet(cx.tVT); });
    for (const [at, slot] of repairs) set(at, slot);
  }
  /** a host class defined after classes were linked from the build: repairs the vtables of the ones it concerns */
  repairLinked(): void { for (const [name, rt] of this.classes) if (rt.mod[0] === "g" || rt.mod[0] === "e") this.repairVtable(name); }
  /** The bytes of a module that defines classes `rts`: what a build-time mode stores beside the unit modules of Compiler.buildUnit, and instantiates
   *  in the same order (importing the same table), instead of this linker doing both on demand. */
  classModule(rts: ClassRt[]): Uint8Array {
    const mb = new ModuleBuilder(), b = declareBase(mb);
    mb.importTable("rt", "table", T.funcref, 0);
    const link = mb.importFunc("host", "link", mb.addFuncType([T.i32], []));
    const sid = mb.importGlobal("rt", "sid", T.i32, true), iw = mb.importGlobal("rt", "iw", T.i32, true), tag = mb.importTag("rt", "tag", b.tTagFn);
    // the String constants of the static values are imported before the module defines a global of its own
    const consts = new Map<string, number>();
    let fromChars = -1;
    for (const { name } of rts) {
      const jc = this.prog.get(name);
      if (jc?.def?.staticValuesOff) for (const v of jc.dex!.encodedArray(jc.def.staticValuesOff)) {
        if (typeof v !== "string" || consts.has(v)) continue;
        // a constant with a lone surrogate cannot be an import name: its units come from a data segment
        if (v.isWellFormed()) consts.set(v, mb.importGlobal("#", v, ref(-17), false));
        else if (fromChars < 0) fromChars = mb.importFunc("wasm:js-string", "fromCharCodeArray", mb.addFuncType([refNull(b.tData.i16), T.i32, T.i32], [ref(-17)]));
      }
    }
    const nullInit = (t: number) => { const o = [0xd0]; sleb(t, o); return o; };
    const zero = (k: Kind) => (k === "I" ? [0x41, 0] : k === "J" ? [0x42, 0] : [0xd0, 0x6e]);
    const vts: number[][] = [];
    for (const rt of rts) {
      const { name, id, slotBase } = rt, jc = this.prog.get(name), methods = jc?.methods ?? [];
      const vtG = name[0] === "[" || !jc?.isInterface ? mb.addGlobal(refNull(b.tVT), true, nullInit(b.tVT)) : -1;
      if (vtG >= 0) mb.export(id + ":vt", "global", vtG);
      // a class with nothing to initialize (no static values or <clinit>, nor supertypes that have) starts initialized: there is no event to wait for or report
      const initialize = !!jc && this.needsInit(name), initG = mb.addGlobal(T.i32, true, [0x41, initialize ? 0 : INIT_DONE]);
      mb.export(id + ":init", "global", initG);
      const statics = new Map<string, number>();
      for (const f of jc?.fields ?? []) if (f.isStatic) {
        const g = mb.addGlobal(kindVT(b.tObj, f.kind), true, zero(f.kind)); statics.set(f.name + ":" + f.desc, g); mb.export(id + ":s:" + f.name + ":" + f.desc, "global", g);
      }
      const stubs = methods.map((m, i) => {
        const params = (m.isStatic ? [] : ["L" as Kind]).concat(m.params.map(kindOf)).map((k) => kindVT(b.tObj, k));
        const sig = mb.addFuncType(params, m.ret === "V" ? [] : [kindVT(b.tObj, kindOf(m.ret))]);
        return mb.addFunc(sig, this.stubBody(slotBase + i, sig, params, link));
      });
      if (initialize) stubs.push(mb.addFunc(mb.addFuncType([], []), this.ensureBody(mb, b, jc!, initG, statics, consts, fromChars, rt, sid, iw, tag)));
      else if (jc) stubs.push(mb.addFunc(mb.addFuncType([], []), new Code(0).finish()));
      if (vtG >= 0) {
        const words = this.vtWords(name, id), seg = mb.addDataPassive(new Uint8Array(words.buffer));
        vts.push(new Code(0).i32(0).i32(words.length).arrayNewData(b.tVT, seg).gset(vtG).b);
      }
      if (stubs.length) mb.addElemActive(0, slotBase, stubs);
    }
    if (vts.length) mb.start = mb.addFunc(mb.addFuncType([], []), [0, ...vts.flat(), 0x0b], "$vt");
    return mb.build();
  }
  /** ensure(): class initialization (JLS 12.4.2). The init word says who is initializing the class: a request from that thread returns at
   *  once (re-entry and cycles see the half-initialized class), one from another waits in initWait (the scheduler's hook). Superclass and
   *  default-method superinterfaces first, then the dex's static values and <clinit>. A throw marks the class failed and goes to initFail
   *  (an Error propagates, anything else becomes ExceptionInInitializerError); later requests throw NoClassDefFoundError. */
  private ensureBody(mb: ModuleBuilder, b: ReturnType<typeof declareBase>, jc: JClass, initG: number, statics: Map<string, number>, consts: Map<string, number>, fromChars: number, rt: ClassRt, sid: number, iw: number, tag: number): number[] {
    const c = new Code(0), voidSig = mb.addFuncType([], []), e = c.newLocal(T.anyref);
    const call = (slot: number, sig = voidSig) => c.i32(slot).callIndirect(sig);
    const rtfn = (name: string) => this.synthSlot(name, rtfns.get(name)!);
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
        const fi = sfields[i], g = fi && statics.get(fi.name + ":" + fi.desc);
        if (!fi || g === undefined || v === null || v === 0 || v === 0n || v === false) return;
        if (typeof v === "number" || typeof v === "boolean") {
          if (fi.desc === "F") c.i32(f32bits(v as number)); else if (fi.desc === "D") c.i64(f64bits(v as number));
          else if (fi.desc === "J") c.i64(BigInt(v as number)); else c.i32(Number(v));
          c.gset(g);
        } else if (typeof v === "bigint") { c.i64(fi.desc === "D" ? f64bits(Number(v)) : v); c.gset(g); }
        else if (typeof v === "string") {
          if (v.isWellFormed()) c.gget(consts.get(v)!); else c.i32(0).i32(v.length).arrayNewData(b.tData.i16, mb.addDataPassive(Uint8Array.from({ length: 2 * v.length }, (_, k) => (v.charCodeAt(k >> 1) >> (8 * (k & 1))) & 255))).i32(0).i32(v.length).call(fromChars);
          c.anyConvertExtern(); call(rtfn("strLit"), mb.addFuncType([T.anyref], [T.anyref])); c.gset(g);
        }
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
    return c.end().finish();
  }

  // ---------- compiling methods on demand
  /** host.link: compile what `slot` stands for and put it in the table. A method is compiled alone, cheaply, and counts its calls and loop
   *  iterations; `upgrade` recompiles the hot ones with their small callees. */
  private linkSlot(slot: number): void {
    const s = this.slotAt(slot);
    if (!s || s.k === "ensure" || s.done) return;
    if (s.k === "method" && this.aot?.install(slot) && s.done) return;
    const t0 = performance.now();
    if (s.k === "method" && this.opts.cold && this.installCold(slot, s.m, t0)) return;
    const cx = new Compiler(this);
    if (s.k === "method") this.demand.methods.add(s.m);
    const built = s.k === "method" ? cx.buildUnit([s.m]) : s.k === "synth" ? cx.buildSynthetic(s.name, s.d!.params, (c) => s.d!.body(cx, c), s.d!.ret)
      : cx.buildSynthetic(s.name, THROWERS[s.name].params, (c) => throwerBody(cx, c, s.name));
    this.stats.units++; this.stats.methods += 1;
    this.install(s.k === "method" ? [slot] : [], false, cx, this.unitImports(cx), built, slot, t0);
  }
  private cold?: ColdInterpreter;
  private coldValidation?: ColdSlowOps;
  /** Shared by slow execution and compiled resume, before transferring an activation. */
  validateColdSnapshot(state: ColdSnapshot, owner: Strand): void {
    (this.coldValidation ??= new ColdSlowOps(this)).validate(state, owner);
  }
  private coldResumes = new Map<MethodInfo, Map<number, { fn: Function; take: (s: ResumeState) => ResumeState }>>();
  /** Called only between committed cold operations; the adapter tail-calls the returned entry. */
  promoteCold(m: MethodInfo, cold: ColdInterpreter, frame: object, edges: number): { fn: Function; state: ResumeState } | undefined {
    if (cold !== this.cold) throw new Error("foreign cold interpreter");
    const slot = this.slotOf(m), sl = this.slotAt(slot);
    if (sl?.k !== "method" || (!sl.hot && edges < HOT_BUDGET)) return;
    const snapshot = cold.snapshot(frame); this.stats.coldSnapshotRegisters += snapshot.item.regs;
    if (snapshot.method !== m) throw new Error("cold resume method mismatch");
    const state: ResumeState = { ...snapshot, method: m, activation: frame };
    // A String constructor must commit its aliases before the compiled representation can take over.
    if (state.uninitialized.length || m.flags & ACC.SYNCHRONIZED) return;
    this.validateColdSnapshot(state, this.sched.current());
    let entries = this.coldResumes.get(m);
    if (!entries) this.coldResumes.set(m, entries = new Map());
    let entry = entries.get(state.pc);
    if (!entry) {
      const t0 = performance.now(), unit = resumeUnit(new Compiler(this), m, state.pc);
      this.stats.compileMs += performance.now() - t0;
      const instance = this.instantiate(unit.built.bytes, { ...this.unitImports(unit.cx), ...unit.imports });
      this.recordUnit(unit.cx, unit.built.traces, slot);
      entry = { fn: instance.exports.resume as Function, take: unit.take({
        validate: s => { this.validateColdSnapshot(s, this.sched.current()); },
        claim: s => { cold.transfer(s.activation); this.rt.depth.value = s.depth; this.stats.coldResumes++; },
      }) };
      entries = this.coldResumes.get(m);
      if (!entries) this.coldResumes.set(m, entries = new Map());
      entries.set(state.pc, entry); this.stats.coldResumeEntries++; this.stats.units++; this.stats.methods++;
    }
    const loaded = entry.take(state);
    this.deoptFrames.set(loaded, { version: Number(this.deoptEpoch.value), blocked: 0, claimed: false, monitors: loaded.monitors.map(m => ({ ...m })) });
    return { fn: entry.fn, state: loaded };
  }
  private deoptFrames = new WeakMap<object, { version: number; blocked: number; claimed: boolean; monitors: ColdSnapshot["monitors"] }>();
  private captureScopes = new WeakMap<Strand, { state: CompiledActivation; pc: number }[]>();
  private deoptCaptures = new WeakMap<object, { source: CompiledActivation; entered: boolean }>();
  private coldDeoptEntries = new Map<MethodInfo, Function>();
  private deoptFrame(state: CompiledActivation) {
    const frame = this.deoptFrames.get(state);
    if (!this.opts.cold || !frame || frame.claimed || state.owner !== this.sched.current()) throw new Error("foreign compiled activation");
    return frame;
  }
  private captureReaders?: { length: (a: object) => number; register: (a: object, i: number) => number; byte: (a: object, i: number) => number; bits: (a: object, i: number) => bigint; reference: (a: object, i: number) => object | null };
  private captureReader() {
    if (this.captureReaders) return this.captureReaders;
    const mb = new ModuleBuilder(), b = declareBase(mb);
    const exports: [string, number, VT][] = [["register", b.tData.i16, T.i32], ["byte", b.tData.i8, T.i32], ["bits", b.tData.i64, T.i64], ["reference", b.tData.ref, T.anyref]];
    for (const [name, type, result] of exports) {
      const c = new Code(2); c.lget(0).refCast(type).lget(1);
      if (name === "register" || name === "byte") c.arrayGetU(type); else c.arrayGet(type);
      mb.export(name, "func", mb.addFunc(mb.addFuncType([T.anyref, T.i32], [result]), c.finish(), "$capture:" + name));
    }
    const c = new Code(1); c.lget(0).refCast(T.arrayref - 0x80).arrayLen();
    mb.export("length", "func", mb.addFunc(mb.addFuncType([T.anyref], [T.i32]), c.finish(), "$capture:length"));
    return this.captureReaders = this.instantiate(mb.build(), {}).exports as unknown as NonNullable<World["captureReaders"]>;
  }
  readonly deoptImports = {
    beginCapture: (state: CompiledActivation, pc: number) => {
      this.deoptFrame(state);
      let scopes = this.captureScopes.get(state.owner!);
      if (!scopes) this.captureScopes.set(state.owner!, scopes = []);
      scopes.push({ state, pc });
    },
    endCapture: (state: CompiledActivation) => {
      const scopes = this.captureScopes.get(this.sched.current());
      if (scopes?.at(-1)?.state !== state) throw new Error("compiled capture scope mismatch");
      scopes.pop();
    },
    make: (slot: number, depth: number): CompiledActivation | null => {
      if (!this.opts.cold) return null;
      const sl = this.slotAt(slot);
      if (sl?.k !== "method") throw new Error("compiled activation method missing");
      const state: CompiledActivation = { item: sl.m.dex.code(sl.m.codeOff), method: sl.m, owner: this.sched.current(), sync: this.inSynchronousJava(), depth, executedPc: 0, edges: 0 };
      this.deoptFrames.set(state, { version: Number(this.deoptEpoch.value), blocked: 0, claimed: false, monitors: [] });
      return state;
    },
    version: (s: CompiledActivation | null) => s ? this.deoptFrame(s).version : Number(this.deoptEpoch.value),
    last: (s: CompiledActivation | null) => s?.executedPc ?? 0,
    blocked: (s: CompiledActivation) => this.deoptFrame(s).blocked,
    allocation: (s: CompiledActivation | null, delta: number) => { if (s) this.deoptFrame(s).blocked += delta; },
    monitor: (s: CompiledActivation | null, object: object, enter: number) => {
      if (!s) return;
      const monitors = this.deoptFrame(s).monitors, index = monitors.findIndex(m => m.object === object);
      if (enter) { if (index < 0) monitors.push({ object, count: 1 }); else monitors[index].count++; }
      else { if (index < 0) throw new Error("compiled monitor ownership mismatch"); if (!--monitors[index].count) monitors.splice(index, 1); }
    },
    snapshot: (s: CompiledActivation, pc: number, executedPc: number, depth: number): ColdSnapshot => {
      const frame = this.deoptFrame(s);
      if (frame.blocked) throw new Error("unsafe compiled String aliases");
      const state: ColdSnapshot = { ...s, pc, executedPc, depth, bits: new BigInt64Array(s.item.regs), references: Array(s.item.regs).fill(null), kinds: new Uint8Array(s.item.regs), result: undefined, exception: undefined, uninitialized: [], monitors: frame.monitors.map(m => ({ ...m })) };
      this.deoptCaptures.set(state, { source: s, entered: false }); this.stats.coldSnapshotRegisters += s.item.regs;
      return state;
    },
    bits: (s: ColdSnapshot, r: number, value: bigint) => { s.bits[r] = value; },
    reference: (s: ColdSnapshot, r: number, value: object | null) => { s.references[r] = value; s.kinds[r] = 1; },
    capture: (s: CompiledActivation, pc: number, last: number, depth: number, map: object, bits: object, references: object): ColdSnapshot => {
      this.deoptFrame(s);
      const read = this.captureReader(), n = read.length(map), nb = read.length(bits), nr = read.length(references);
      if (n !== nb + nr || n > s.item.regs) throw new Error("compiled capture layout mismatch");
      const state = this.deoptImports.snapshot(s, pc, last, depth);
      let bi = 0, ri = 0;
      const seen = new Uint8Array(s.item.regs);
      for (let i = 0; i < n; i++) {
        const r = read.register(map, i);
        if (r >= s.item.regs || seen[r]++) throw new Error("compiled capture register mismatch");
        if (i >= nb) this.deoptImports.reference(state, r, read.reference(references, ri++));
        else this.deoptImports.bits(state, r, read.bits(bits, bi++));
      }
      if (bi !== nb || ri !== nr) throw new Error("compiled capture value mismatch");
      return state;
    },
    captureIndexed: (s: CompiledActivation, pc: number, last: number, depth: number, map: object, bits: object, references: object): ColdSnapshot => {
      this.deoptFrame(s);
      const read = this.captureReader(), n = read.length(map), nb = read.length(bits), nr = read.length(references);
      const state = this.deoptImports.snapshot(s, pc, last, depth), seen = new Uint8Array(s.item.regs);
      let offset = 0;
      const word = () => {
        let value = 0;
        for (let shift = 0; shift < 35 && offset < n; shift += 7) {
          const b = read.byte(map, offset++); value += (b & 127) * 2 ** shift;
          if (b < 128 && value <= 0xffffffff) return value;
        }
        throw new Error("compiled indexed capture word mismatch");
      };
      while (offset < n) {
        const r = word(), i = word();
        if (r >= s.item.regs || seen[r]++ || i >= nb + nr) throw new Error("compiled indexed capture register mismatch");
        if (i < nb) this.deoptImports.bits(state, r, read.bits(bits, i));
        else this.deoptImports.reference(state, r, read.reference(references, i - nb));
      }
      return state;
    },
    target: (s: ColdSnapshot): Function => {
      const capture = this.deoptCaptures.get(s);
      if (!capture || capture.entered || !s.method || !s.owner) throw new Error("foreign deoptimization snapshot");
      const frame = this.deoptFrame(capture.source);
      this.validateColdSnapshot(s, this.sched.current());
      let fn = this.coldDeoptEntries.get(s.method);
      if (!fn) {
        const unit = coldUnit(this, s.method, this.cold ??= new ColdInterpreter((bytes, imports) => this.instantiate(bytes, imports)), true);
        fn = this.instantiate(unit.built.bytes, { ...this.unitImports(unit.cx), ...unit.imports }).exports.resume as Function;
        this.recordUnit(unit.cx, unit.built.traces, this.slotOf(s.method));
        this.coldDeoptEntries.set(s.method, fn); this.stats.units++;
      }
      this.validateColdSnapshot(s, this.sched.current()); frame.claimed = true;
      return fn;
    },
  };
  enterColdDeopt(state: ColdSnapshot, cold: ColdInterpreter): object {
    const capture = this.deoptCaptures.get(state);
    if (cold !== this.cold || !capture || capture.entered || !this.deoptFrames.get(capture.source)?.claimed) throw new Error("deoptimization already entered or foreign");
    this.validateColdSnapshot(state, this.sched.current());
    capture.entered = true;
    const frame = cold.restore(state.item, state); this.rt.depth.value = state.depth; this.stats.coldDeopts++; this.stats.coldCalls++;
    return frame;
  }
  canDeopt(m: MethodInfo): boolean { return !(m.flags & ACC.SYNCHRONIZED) && supportsColdBody(m, false); }
  private installCold(slot: number, m: MethodInfo, t0: number): boolean {
    if (!m.codeOff || this.intrinsic(m) || m.flags & ACC.SYNCHRONIZED || !supportsColdBody(m)) return false;
    const cold = this.cold ??= new ColdInterpreter((bytes, imports) => this.instantiate(bytes, imports));
    const unit = coldUnit(this, m, cold);
    if (!unit) return false;
    this.install([slot], false, unit.cx, { ...this.unitImports(unit.cx), ...unit.imports }, unit.built, slot, t0);
    this.demand.methods.add(m); this.stats.coldMethods++; this.stats.methods++; this.stats.units++;
    return true;
  }
  /** host.hot: the method in `slot` has used up its budget; compile it again with its small callees copied in and guarded calls */
  private upgrade(slot: number): void {
    const s = this.slotAt(slot);
    if (s?.k !== "method" || !s.done || s.hot) return;
    this.requested.add(slot);
    // a compile worker takes the job when there is one: the method keeps running its first-tier code until the unit arrives, and asks again if the unit is not taken
    const reset = () => { new Int32Array(this.mem.buffer, COUNT_BASE + 4 * slot, 1)[0] = 0; };
    if (s.pending) { reset(); return; }
    // a small method without a loop is worth most copied into the units of the callers that run it in their loops: alone it waits a few budgets for them
    if (this.leaf(s.m)) {
      const waited = this.leafWaits.get(slot) ?? 0;
      if (waited < LEAF_WAITS) { this.leafWaits.set(slot, waited + 1); reset(); return; }
    }
    if (this.opts.compiler?.submit(this, slot)) { s.pending = true; reset(); return; }
    if (this.opts.holdUpgrades?.()) { reset(); return; }
    // the second tier is paid for out of the time the program runs: its compiling is kept to a share of it. A method that asks too soon waits in line and asks
    // again after another budget. The next compile the share allows goes to the outermost waiting method on the stack, whose unit can take in what it calls,
    // else to the one that has waited longest and asked again since, so it is still hot
    const t0 = performance.now();
    this.hotSince ??= t0;
    const wait = () => { this.refused.set(slot, (this.refused.get(slot) ?? 0) + 1); reset(); };
    if (this.upgradeMs + UPGRADE_MS > UPGRADE_SHARE * (t0 - this.hotSince)) { wait(); return; }
    let pick = this.outermostWaiting() ?? slot;
    if (pick === slot) for (const [w, n] of this.refused) {
      if (!this.waits(w)) { this.refused.delete(w); continue; }
      if (n >= 2) { pick = w; break; }
    }
    this.refused.delete(pick);
    if (pick !== slot) wait();
    const m = (this.slotAt(pick) as { m: MethodInfo }).m, cx = new Compiler(this), { installed, copies } = this.group(m);
    const built = cx.buildUnit(installed, copies, true);
    this.stats.units++; this.stats.methods += installed.length + copies.length; this.stats.upgrades++;
    this.install(installed.map((m) => this.slotOf(m)), true, cx, this.unitImports(cx), built, pick, t0);
    this.upgradeMs += performance.now() - t0;
  }
  /** the outermost Java frame of the running stack whose method waits for the second tier (V8 names Wasm frames by function, which are named by method id) */
  private outermostWaiting(): number | undefined {
    if (!this.refused.size || !namesWasmFrames()) return undefined;
    let found: number | undefined;
    for (const name of wasmFrameNames(new Error().stack ?? "")) {
      const m = methodOf(this.prog, name.replace(/^\$dispatch:/, "").split("#")[0]), slot = m && this.slotOf(m);
      if (slot !== undefined && this.refused.has(slot) && this.waits(slot)) found = slot;
    }
    return found;
  }
  /** whether the method in `slot` runs first-tier code and no second-tier unit for it is on its way */
  private waits(slot: number): boolean { const s = this.slotAt(slot); return s?.k === "method" && s.done && !s.hot && !s.pending; }
  private requested = new Set<number>();
  /** the methods refused a second-tier compile, longest waiting first, with how often */
  private refused = new Map<number, number>();
  private leafWaits = new Map<number, number>();
  private leaves = new Map<MethodInfo, boolean>();
  private leaf(m: MethodInfo): boolean {
    let r = this.leaves.get(m);
    if (r === undefined) {
      const code = m.codeOff ? m.dex.code(m.codeOff) : undefined;
      this.leaves.set(m, r = !!code && this.inlinable(m) && !decodeInstructions(code.insns).some((ins) => branchTargets(code, ins).some((t) => t <= ins.pc)));
    }
    return r;
  }
  /** the second-tier compile of the method in `slot` as a job for a compile worker: what it needs from this World's state, which only this World has */
  upgradeJob(slot: number): UpgradeJob | undefined {
    const s = this.slotAt(slot);
    if (s?.k !== "method" || !s.done || s.hot) return undefined;
    const { installed, copies } = this.group(s.m);
    return { unit: this.stats.units++, installed: installed.map(mid), copies: copies.map(mid), plan: [...this.plan].map(([key, ms]) => [key, ms.map(mid)]), cold: !!this.opts.cold, initialized: this.newlyInitialized(), long: [...installed, ...copies].map(mid).filter((id) => this.longLoops.has(id)) };
  }
  /** the classes linked so far, and those with a method that has been called (a method's slot is done once it has run or its precompiled code is installed) */
  usage(): { linked: string[]; called: string[] } {
    const called = this.blockClass.filter((name, b) => { const n = this.prog.get(name)?.methods.length ?? 0; for (let i = 0; i < n; i++) if ((this.slots[this.blockBase[b] + i] as { done?: boolean } | undefined)?.done) return true; return false; });
    return { linked: [...this.classes.keys()], called };
  }
  /** the classes linked whose initialization has not finished or not been reported yet, with their init words: a class with nothing to initialize starts initialized and is not one */
  private unreported: { rt: ClassRt; init: WebAssembly.Global }[] = [];
  private noteInit(rt: ClassRt): void {
    const init = rt.exports[rt.id + ":init"] as WebAssembly.Global | undefined;
    if (init && init.value !== INIT_DONE) this.unreported.push({ rt, init });
  }
  /** the classes whose initialization finished since the last job */
  newlyInitialized(): string[] {
    const out: string[] = [];
    this.unreported = this.unreported.filter((u) => {
      if (this.classes.get(u.rt.name) !== u.rt) return false;
      if (u.init.value !== INIT_DONE) return true;
      out.push(u.rt.name);
      return false;
    });
    return out;
  }
  /** the second-tier compile of the method in `slot` will not come: it may ask for it again, or be compiled inline */
  release(slot: number): void { const s = this.slotAt(slot); if (s?.k === "method") s.pending = false; }
  /** installs the second-tier unit a compile worker made for `slot`, if it is still sound here: nothing was added to the Program since `epoch`, and the numbering its code relies on
   *  is this World's (it was numbered from `result.numbering.from`) */
  adoptUnit(slot: number, job: UpgradeJob, result: UnitResult, epoch: number): boolean {
    const s = this.slotAt(slot), head = result.header, t0 = performance.now();
    this.release(slot);
    if ((head.deopt ?? 0) !== (job.cold ? DEOPT_ABI : 0) || !!job.cold !== !!this.opts.cold || epoch !== this.epoch || s?.k !== "method" || !s.done || s.hot || !head.natives.every((id) => this.nativeBound(id))) return false;
    const n = result.numbering;
    if ((n.names.length || n.tail.length || n.selectors.length || n.gaps.length || n.links.length) && !this.adopt(n)) return false;
    for (const id of head.touch) this.link(this.names[id]);
    for (const name of head.synth) this.ensureSynth(name);
    const method = (id: string) => methodOf(this.prog, id);
    const target = (cls: string, key: string) => (cls ? this.prog.get(cls)?.byKey.get(key) : undefined);
    const owner = (at: number) => (this.slotAt(at) as { m: MethodInfo }).m;
    const unit = { assumptions: head.assumptions.map(([decl, name, desc, tc, tk, at]) => [decl, name, desc, target(tc, tk), owner(at)] as Compiler["assumptions"][number]),
      absent: head.missing.map(([name, at]) => [name, owner(at)] as [string, MethodInfo]) };
    const mod = result.module, imports: Record<string, any> = { rt: this.rtImports(), host: this.host, n: this.nativeImports(head.natives), deopt: this.deoptImports };
    this.classImports(mod, imports);
    const traces = result.traces.map((t) => ({ name: t.name, m: t.m ? method(t.m) : undefined, offsets: t.offsets, pcs: t.pcs }));
    for (const c of head.allocs) this.allocated.add(c);
    this.stats.methods += job.installed.length + job.copies.length; this.stats.upgrades++;
    this.install(job.installed.map((id) => this.slotOf(method(id)!)), true, unit, imports, { bytes: mod, traces }, slot, t0);
    return true;
  }
  private hotSince?: number;
  private upgradeMs = 0;
  /** instantiates a built unit and puts its functions (`group`, by slot) in the table; a slot already compiled keeps its original stub */
  private install(group: number[], hot: boolean, cx: Pick<Compiler, "assumptions" | "absent">, imports: Record<string, any>, built: { bytes: Uint8Array | WebAssembly.Module; traces: FnTrace[] }, slot: number, t0: number): void {
    const s = this.slotAt(slot)!;
    this.stats.compileMs += performance.now() - t0;
    let exports: Record<string, any>;
    try { exports = this.instantiate(built.bytes, imports).exports as Record<string, any>; } catch (e) { throw new Error(`linking ${s.k === "method" ? mid(s.m) : (s as { name: string }).name}: ${(e as Error).message}`); }
    const set = (at: number, name: string) => {
      const sl = this.slotAt(at) as Exclude<Slot, { k: "ensure" }>;
      if (!sl.done) sl.stub = this.table.get(at) as Function;
      sl.done = true;
      this.table.set(at, exports[name]);
    };
    if (s.k === "method") {
      for (const x of group) { set(x, "m" + x); this.groupOf.set(x, group); (this.slotAt(x) as { hot?: boolean }).hot = hot; if (x < COUNT_SLOTS) new Int32Array(this.mem.buffer, COUNT_BASE + 4 * x, 1)[0] = 0; }
    } else set(slot, "m");
    this.recordUnit(cx, built.traces, slot);
  }
  private recordUnit(cx: Pick<Compiler, "assumptions" | "absent">, traces: FnTrace[], slot: number): void {
    for (const t of traces) this.traces.set(t.name, t);
    for (const [decl, name, desc, target, owner] of cx.assumptions) {
      const key = `${decl}.${name}${desc}`;
      let a = this.assumptions.get(key);
      if (!a) this.assumptions.set(key, a = { decl, name, desc, tc: target?.cls ?? "", tk: target?.key ?? "", slots: new Set() });
      a.slots.add(owner ? this.slotOf(owner) : slot);
    }
    for (const [name, owner] of cx.absent) {
      const slots = this.absent.get(name) ?? this.absent.set(name, new Set()).get(name)!;
      slots.add(owner ? this.slotOf(owner) : slot);
    }
  }
  /** the class globals module `mod` imports from modules the caller has not named: each comes from the module of the class whose id starts its name (code made by another World,
   *  an app build's or a worker's, names classes only by id) */
  classImports(mod: WebAssembly.Module, imports: Record<string, Record<string, unknown>>): void {
    const given = new Set(Object.keys(imports));
    for (const { module, name } of WebAssembly.Module.imports(mod)) {
      if (given.has(module)) continue;
      (imports[module] ??= {})[name] = this.link(this.names[+name.slice(0, name.indexOf(":"))]).exports[name];
    }
  }
  /** whether native method `id` ("class.name+descriptor") has a host binding here, making its import available */
  nativeBound(id: string): boolean {
    if (id.startsWith("settle:") || id === "land" || id.startsWith("land:")) return true;
    const m = methodOf(this.prog, /#(?:s|p)$/.test(id) ? id.slice(0, -2) : id);
    return !!m && this.natives.prepare(m);
  }
  private unitImports(cx: Compiler): Record<string, any> {
    const imports: Record<string, any> = { rt: this.rtImports(), host: this.host,
      n: this.nativeImports(cx.nativeImports.keys()), deopt: this.deoptImports };
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
  hostContext(): HostContext {
    return this.hostCtx ??= { mem: this.mem, sp: this.sp, bridge: this.bridge, gap: (what) => this.onGap(this.gapId(what)), sched: this.sched, throwable: (cls, msg) => this.makeThrowable(cls, msg), raise: (e) => this.exception(e) };
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
      this.throwMakers.set(cls, make = (m) => f(m === null ? null : this.javaString(m)));
    }
    return this.synchronous(() => make!(msg));
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
      // the callees that have run often, busiest first: code the first tier saw run a few times is not worth compiling into the unit
      const callees = this.smallCallees(out[i]).concat(this.guarded(out[i])).filter((t) => !out.some((o) => mid(o) === mid(t)) && this.slotAt(this.slotOf(t))?.k === "method" && this.ran(t) >= COPY_MIN);
      callees.sort((a, b) => this.ran(b) - this.ran(a));
      for (const t of callees) {
        if (out.length >= MAX_GROUP) break;
        if (out.some((o) => mid(o) === mid(t))) continue;
        out.push(t);
        (this.slotAt(this.slotOf(t)) as { done: boolean }).done ? copies.push(t) : installed.push(t);
      }
    }
    return { installed, copies };
  }
  /** calls and loop iterations counted for `t` so far: methods compiled by the second tier count as busy, the Wasm-written intrinsics always run */
  private ran(t: MethodInfo): number {
    const sl = this.slotAt(this.slotOf(t)) as { done: boolean; hot?: boolean };
    if (this.opts.intrinsics.has(mid(t))) return HOT_BUDGET;
    // a method that has asked for the second tier has used up a budget, whatever its count since
    if (sl.hot || this.requested.has(this.slotOf(t))) return HOT_BUDGET;
    return sl.done ? this.count(this.slotOf(t)) : 0;
  }
  /** the methods (ids) whose first-tier code ran a loop for 64 chunks in one entry: their second tier keeps loops in chunks, so a long activation of it is not held in the engine's baseline code */
  longLoops = new Set<string>();
  /** classes some compiled code allocates: the ones a virtual call is likely to find */
  allocated = new Set<string>();
  /** per virtual call (declaring class, name, descriptor): the small implementations, among the allocated classes', its unit tests for first */
  plan = new Map<string, MethodInfo[]>();
  groupOf = new Map<number, number[]>();
  private callees = new Map<MethodInfo, MethodInfo[]>();
  /** calls and loop iterations counted so far for the method in `slot` */
  count(slot: number): number { return slot < COUNT_SLOTS ? new Int32Array(this.mem.buffer, COUNT_BASE + 4 * slot, 1)[0] : 0; }
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
  /** the small implementations of decl.name+desc among the allocated subclasses that have run, busiest first, unless more of them have run than guards test */
  private likely(decl: string, name: string, desc: string): MethodInfo[] {
    // an implementation whose class is not linked has not run (and asking would link it)
    const ran = [...this.implementations(decl, name, desc).keys()].filter((t) => (this.classes.has(t.cls) || this.aot?.hasLoaded(t.cls)) && this.ran(t) > 0);
    if (ran.length > MAX_GUARDS) return [];
    return ran.filter((t) => this.inlinable(t)).sort((a, b) => this.ran(b) - this.ran(a));
  }
  private implemented = new Map<string, { seen: number; count: Map<MethodInfo, number> }>();
  /** the implementations of decl.name+desc among the allocated subclasses, with how many of those classes use each. The allocated classes only grow, so each is looked at once */
  private implementations(decl: string, name: string, desc: string): Map<MethodInfo, number> {
    const key = `${decl}.${name}${desc}`;
    let memo = this.implemented.get(key);
    if (!memo) this.implemented.set(key, memo = { seen: 0, count: new Map() });
    let i = 0;
    for (const cls of this.allocated) {
      if (i++ < memo.seen || cls[0] === "[" || !this.prog.isSubclass(cls, decl)) continue;
      const t = this.prog.implFor(cls, name, desc);
      if (t) memo.count.set(t, (memo.count.get(t) ?? 0) + 1);
    }
    memo.seen = i;
    return memo.count;
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
  /** A BaseDexClassLoader supplies its immutable library graph before opening its own DEX path. Metadata and ahead-of-time code may already exist. */
  bindLibraries(loader: Loader, before: Loader[], after: Loader[]): void {
    const priorBefore = loader.before ?? [], priorAfter = loader.after ?? [];
    const same = (a: Loader[], b: Loader[]) => a.length === b.length && a.every((l, i) => l === b[i]);
    if (same(priorBefore, before) && same(priorAfter, after)) return;
    this.rebindResolution(() => this.prog.libraries(loader, before, after), () => this.prog.libraries(loader, priorBefore, priorAfter), "Class loader libraries");
  }
  initiateClass(loader: Loader, name: string, key: string): void {
    const prior = this.prog.initiatedBy(loader, name);
    if (prior === key) return;
    if (prior) throw this.exception(this.makeThrowable("java/lang/LinkageError", `Class loader already initiated ${name}`));
    if (this.prog.lookup(loader, name) === key) { this.prog.initiate(loader, name, key); return; }
    this.rebindResolution(() => this.prog.initiate(loader, name, key), () => this.prog.forgetInitiated(loader, name), "Class initiation");
  }
  resolveClass(loader: Loader, name: string, owner: Strand): string | Promise<string> {
    return resolveClass(this, loader, name, owner);
  }
  private rebindResolution(change: () => string[], undo: () => string[], reason: string): void {
    const dispatch = [...this.classes.keys()].map(name => ({ name, methods: this.vslots(name).map(key => {
      const at = key.indexOf("(");
      return this.prog.implFor(name, key.slice(0, at), key.slice(at));
    }) }));
    const own = new Set([...this.prog.own()].filter(c => c.dex).map(c => c.name));
    const existing = [...this.classes].filter(([name]) => own.has(name)).map(([name, rt]) => ({ name, rt, sup: this.prog.get(name)!.sup, ifaces: [...this.prog.get(name)!.ifaces], fields: this.prog.get(name)!.fields.map(f => ({ field: f, desc: f.desc })) }));
    const names = change();
    if (!names.length) return;
    this.vslotCache.clear();
    for (const old of dispatch) {
      const methods = this.vslots(old.name).map(key => { const at = key.indexOf("("); return this.prog.implFor(old.name, key.slice(0, at), key.slice(at)); });
      if (methods.length !== old.methods.length || methods.some((m, i) => m !== old.methods[i])) {
        undo(); this.vslotCache.clear();
        throw this.exception(this.makeThrowable("java/lang/LinkageError", `${reason} changed linked dispatch of ${old.name}`));
      }
    }
    // A changed superclass would change the physical GC layout of already linked instances. Constructor-time library binding must precede that resolution.
    for (const old of existing) {
      const cls = this.prog.get(old.name)!;
      if (cls.sup !== old.sup || cls.ifaces.join("\0") !== old.ifaces.join("\0")) {
        undo(); this.vslotCache.clear();
        throw this.exception(this.makeThrowable("java/lang/LinkageError", `${reason} changed linked hierarchy of ${old.name}`));
      }
    }
    for (const old of existing) {
      for (const { field, desc } of old.fields) if (field.isStatic && desc !== field.desc) {
        const oldKey = `${old.rt.id}:s:${field.name}:${desc}`, newKey = `${old.rt.id}:s:${field.name}:${field.desc}`;
        old.rt.exports = { ...old.rt.exports, [newKey]: old.rt.exports[oldKey] };
      }
    }
    this.epoch++;
    this.opts.compiler?.added(null);
    this.cha = new Cha(this.prog); this.implemented.clear();
    this.coldResumes.clear(); this.compiled.clear(); this.fieldReaders.clear();
    this.vslotCache.clear(); this.imtCache.clear();
    // Existing code and app builds used the previous namespace. Platform code retains its defining boot namespace.
    const changed = new Set(names);
    for (let b = 0; b < this.blockClass.length; b++) if (changed.has(this.blockClass[b])) {
      for (let i = 0; i < this.methodsIn(b); i++) this.invalidate(this.blockBase[b] + i);
    }
    if (names.some(name => this.prog.loaderOfDex(this.prog.get(name)!.dex!) === this.prog.root)) this.aot?.unbindApp();
    for (const assumption of this.assumptions.values()) for (const slot of assumption.slots) this.invalidate(slot);
    this.assumptions.clear(); this.late.clear();
    this.noteLate([...this.prog.own()].map(c => c.name));
    for (const slots of this.absent.values()) for (const slot of slots) this.invalidate(slot);
    this.absent.clear();
  }
  /** load more dexes. A CHA decision that one of their classes falsifies is undone: its callers go back to lazy-link stubs, so the next call
   *  compiles against the new hierarchy. Frames already executing keep the old code. */
  addDexes(dexes: DexFile[], loader: Loader = this.prog.root): string[] {
    const added = this.prog.add(dexes, loader);
    this.epoch++;
    this.opts.compiler?.added(loader === this.prog.root ? dexes : null);
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
  /** the native blocks of the direct buffers, freed when the object that owns each is collected */
  private blocks = new FinalizationRegistry<bigint>((address) => this.opts.guest!.free(address));
  /** a zeroed native block of `n` bytes that lives as long as `owner`, a MemoryRef (memory.ts); its address, or 0 */
  private allocGuest(owner: object, n: number): bigint {
    const guest = this.opts.guest;
    if (!guest) throw new Error("this World has no guest memory");
    const address = guest.alloc(n);
    if (address) this.blocks.register(owner, address);
    return address;
  }
  /** whether the guest memory is shared, which a module that imports it must declare */
  get guestShared(): boolean { return !!this.opts.guest && !(this.opts.guest.memory.buffer instanceof ArrayBuffer); }
  /** makes the class a registered spec implements in the host a Java class, now or once its superclass is defined (hostclass.ts) */
  addHostClass(spec: HostSpec): void { this.hosts.add(spec); this.opts.compiler?.added(null); }
  /** the classes this World made without a dex (the host's, their hidden halves, proxies): a compile worker applies the same specs and must end with the same ones */
  hostClassNames(): string[] { return [...this.prog.own()].filter((c) => !c.dex).map((c) => c.name).sort(); }
  private settlingHosts = false;
  /** adds a class that no dex defines, with the body of each of its methods */
  addClass(jc: JClass, bodies: Map<MethodInfo, Intrinsic>, loader = this.prog.root): void {
    for (const [m, body] of bodies) this.madeUp.set(mid(m), body);
    this.prog.addClass(jc, loader);
    this.epoch++;
    // the host classes a dex arriving defines are defined by the worker's own settling of the same dex
    if (!this.settlingHosts) this.opts.compiler?.added(null);
    this.loaded([jc.name]);
  }
  private loaded(added: string[]): void {
    this.coldResumes.clear(); this.implemented.clear();
    this.cha.index(added);
    // a decision about the implementations of decl.name+desc changes only when a concrete subtype of decl is added that has one
    const now = this.noteLate(added);
    for (const [key, a] of this.assumptions) {
      const by = now.get(a.decl);
      if (!by || this.holds(a, by)) continue;
      for (const slot of a.slots) this.invalidate(slot);
      this.assumptions.delete(key);
    }
    for (const name of added) for (const slot of this.absent.get(name) ?? []) this.invalidate(slot);
    for (const name of added) this.absent.delete(name);
    this.settlingHosts = true;
    try { this.hosts.loaded(); } finally { this.settlingHosts = false; }
  }
  /** the concrete classes added since compiled code was made, by each of their supertypes (themselves included) */
  late = new Map<string, string[]>();
  /** records the concrete classes among `added` and returns them by supertype */
  noteLate(added: string[]): Map<string, string[]> {
    const now = new Map<string, string[]>(), up = new Map<string, string[]>();
    const supers = (n: string): string[] => {
      let s = up.get(n);
      if (!s) {
        const c = this.prog.get(n), out = new Set([n]);
        if (c) for (const p of c.sup ? [c.sup, ...c.ifaces] : c.ifaces) for (const x of supers(p)) out.add(x);
        up.set(n, s = [...out]);
      }
      return s;
    };
    for (const n of added) {
      const c = this.prog.get(n);
      if (!c || c.isInterface || c.flags & ACC.ABSTRACT) continue;
      for (const s of supers(n)) {
        let a = now.get(s); if (!a) now.set(s, a = []); a.push(n);
        let b = this.late.get(s); if (!b) this.late.set(s, b = []); b.push(n);
      }
    }
    return now;
  }
  /** whether the implementation code relied on for decl.name+desc (`tc`'s method `tk`, none if empty) stands once the concrete classes `by`, all subtypes of decl, exist */
  holds(a: { name: string; desc: string; tc: string; tk: string }, by: string[]): boolean {
    const target = a.tc ? this.prog.get(a.tc)?.byKey.get(a.tk) : undefined;
    for (const n of by) { const m = this.prog.implFor(n, a.name, a.desc); if (m && m !== target) return false; }
    return true;
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  invalidate(slot: number): void {
    this.deoptEpoch.value = Number(this.deoptEpoch.value) + 1;
    for (const x of this.groupOf.get(slot) ?? [slot]) {
      const s = this.slotAt(x);
      if (s?.k === "method") this.coldResumes.delete(s.m);
      if (s?.k === "ensure" || !s?.done) continue;
      const stub = s.stub ?? this.aot?.stub(x);
      if (!stub) continue;
      this.table.set(x, stub); s.done = false; if (s.k === "method") s.hot = false; this.stats.invalidated++;
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
      // an exception leaves the frames it unwound counted
      const depth = this.rt.depth.value;
      try {
        if (m.isStatic && this.needsInit(m.cls)) (this.table.get(this.ensureSlot(m.cls)) as Function)();
        const r = (this.table.get(slot) as Function)(...args.map((a) => typeof a === "string" ? this.javaString(a) : a));
        return typeof r === "object" && r !== null && this.classNameOf(r) === "java/lang/String" ? this.bridge.toHost(r) : r;
      } catch (e) { throw this.boundary(e); } finally { this.rt.depth.value = depth; }
    };
  }
  /** `entry` for a call that may block: it runs on a stack of its own, as a new strand of the main thread, and answers a Promise */
  entryAsync(cls: string, name: string, desc: string): (...args: unknown[]) => Promise<unknown> {
    const m = this.prog.resolve(cls, name, desc);
    if (!m) throw new Error(`entry ${cls}.${name}${desc} not found`);
    const slot = this.slotOf(m);
    return async (...args) => {
      const s = this.sched.strand();
      try {
        if (m.isStatic && this.needsInit(m.cls)) await this.freshStack(() => s.call(this.table.get(this.ensureSlot(m.cls)) as Function));
        const r = await this.freshStack(() => s.call(this.table.get(slot) as Function, ...args.map((a) => typeof a === "string" ? this.javaString(a) : a)));
        return typeof r === "object" && r !== null && this.classNameOf(r) === "java/lang/String" ? this.bridge.toHost(r) : r;
      } catch (e) { throw this.boundary(e); } finally { s.end(); }
    };
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
  classNameOf(obj: object): string { return this.names[this.rt.classId(obj)]; }
  /** V8 does not let Wasm catch its stack overflow RangeError, so Java handlers cannot see it; at the edge of the Java world it
   *  becomes the StackOverflowError a handler above this call would have received */
  boundary(e: unknown): unknown {
    if (!isStackOverflow(e)) return e;
    const depth = this.rt.depth.value;
    try { (this.table.get(SLOT.soe) as Function)(); } catch (x) { return x; } finally { this.rt.depth.value = depth; }
    return e;
  }
  private javaStack(stack: string, count = Infinity, lines = true): JavaFrame[] {
    // Each callFn enters a fresh engine stack. Keep only that stack's frames,
    // then append its suspended callers; parse once so recursive cold PCs retain
    // their activation order. The marker's name is explicit, even in minified builds.
    const local = (text: string) => {
      const rows = text.split("\n"), boundary = rows.findIndex(row => row.includes("at webdroid:callFn ("));
      return (boundary < 0 ? rows : rows.slice(0, boundary)).filter(row => row.includes("wasm-function[")).join("\n");
    };
    const parts = [local(stack)];
    for (let caller = this.bridgeStacks.get(this.sched.current()); caller; caller = caller.prior)
      parts.push(local(caller.stack.stack ?? ""));
    return javaFrames(parts.join("\n"), this.frameTraces, count, lines);
  }
  /** the innermost `count` Java frames, including callers suspended at host bridges */
  callerFrames(count: number): JavaFrame[] {
    const full = Error.stackTraceLimit;
    try {
      for (const limit of [16, 48]) {
        if (limit >= full) break;
        Error.stackTraceLimit = limit;
        const frames = this.javaStack(new Error().stack ?? "", count, false);
        if (frames.length >= count) return frames;
      }
    } finally { Error.stackTraceLimit = full; }
    return this.javaStack(new Error().stack ?? "", count, false);
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
    const prior = this.synchronousEntries; this.synchronousEntries = 0;
    try { return run(); } finally { this.synchronousEntries = prior; }
  }
  private hostFns = new Map<string, Function>();
  /** runs the Cleaner of a native allocation once its referent has been collected (sun.misc.Cleaner.create), as ART's reference queue daemon does */
  private cleaners = new FinalizationRegistry<object>((cleaner) => {
    const clean = this.prog.resolve("sun/misc/Cleaner", "clean", "()V");
    if (clean) try { this.hostFn("cleaner:clean", ["L"], "V", (cx, c) => { c.lget(0); cx.callMethod(c, clean); })(cleaner); } catch { /* the Cleaner reports a failing thunk itself */ }
  });
  /** a function over Java values, generated once under `name` and callable from the host: an int is a number, a long a bigint, a reference an opaque value */
  hostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void): (...a: any[]) => any {
    let f = this.hostFns.get(name);
    if (!f) {
      const cx = new Compiler(this); prepare?.(cx);
      const { bytes } = cx.buildSynthetic(name, params, (c) => body(cx, c), ret);
      this.hostFns.set(name, f = (this.instantiate(bytes, this.unitImports(cx)).exports as Record<string, any>).m);
    }
    return f as never;
  }
  private callFns = new Map<string, (s: Strand, ...a: any[]) => unknown>();
  /** A cold activation keeps the same physical caller frames across its slow
   * operations. Its DEX PCs are resolved from the live activation when read. */
  withBridgeCaller<T>(stack: Error, run: () => T): T {
    const prior = this.bridgeCaller; this.bridgeCaller = stack;
    try { return run(); } finally { this.bridgeCaller = prior; }
  }
  // The compiled call must not retain the emitter closure and its Compiler.
  // Build it in a separate activation from the persistent token/caller state.
  private buildCallFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void) {
    const cx = new Compiler(this), vt = ret === "V" ? T.i32 : ret === "L" ? T.externref : kindVT(cx.tObj, ret);
    prepare?.(cx);
    const d = new WebAssembly.Global({ value: "i32", mutable: true }, 0), thr = new WebAssembly.Global({ value: "externref", mutable: true }, null);
    const v = new WebAssembly.Global({ value: ret === "J" ? "i64" : ret === "L" ? "externref" : "i32", mutable: true }, ret === "J" ? 0n : ret === "L" ? null : 0);
    const { bytes } = cx.buildSynthetic(name, ["I", ...params], (c) => {
      const done = cx.global("call", "d", T.i32, true), value = cx.global("call", "v", vt, true), thrown = cx.global("call", "x", T.externref, true);
      const e = c.newLocal(T.anyref), res = ret === "V" ? -1 : c.newLocal(kindVT(cx.tObj, ret));
      c.block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
      body(cx, c, (i) => { c.lget(i + 1); });
      if (res >= 0) { c.lset(res).lget(res); if (ret === "L") c.externConvertAny(); c.gset(value); }
      c.lget(0).gset(done);
      if (res >= 0) c.lget(res);
      c.ret().end().unreachable().end();
      c.lset(e).lget(e).externConvertAny().gset(thrown).i32(0).lget(0).raw(OP.i32_sub).gset(done).lget(e).throw_(cx.tag);
    }, ret);
    const fn = (this.instantiate(bytes, { ...this.unitImports(cx), call: { d, v, x: thr } }).exports as Record<string, any>).m as Function;
    return { fn, d, v, thr };
  }
  /** a Java call that may wait, made of `body` over the parameters (`arg(i)` pushes parameter i; the body leaves a result of kind `ret`), run on strand `s`: the result at once when the
   *  call did not wait (a Java exception is thrown as a WebAssembly.Exception), else a Promise of it. The module records how the call ended in globals of its own, which the
   *  call's token says are this call's: a promising export answers a Promise even when it never waited. */
  callFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void): (s: Strand, ...a: any[]) => unknown {
    let f = this.callFns.get(name);
    if (f) return f;
    const { fn, d, v, thr } = this.buildCallFn(name, params, ret, body, prepare);
    const enter = (s: Strand, ...args: unknown[]) => s.call(fn, ...args);
    Object.defineProperty(enter, "name", { value: "webdroid:callFn" });
    let token = 0;
    this.callFns.set(name, f = (s, ...args) => {
      token = token % 0x3fffffff + 1;
      const stack = this.bridgeCaller ?? new Error();
      if (!this.bridgeCaller) this.stats.bridgeCallerCaptures++;
      this.bridgeCaller = undefined;
      const caller: BridgeStack = { stack, prior: this.bridgeStacks.get(s), done: false };
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
      const cx = new Compiler(this), st = cx.structFor(cls);
      const { bytes } = cx.buildSynthetic("get:" + name, ["L"], (c) => { c.lget(0).refAsNonNull().refCast(st).structGet(st, cx.fieldIndex(cls, f)); }, f.kind);
      this.fieldReaders.set(key, read = (this.instantiate(bytes, this.unitImports(cx)).exports as Record<string, any>).m as (obj: object) => unknown);
    }
    return read as (obj: object) => T;
  }
}
