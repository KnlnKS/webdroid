// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals, and one lazy-link stub per method, installed in a contiguous block of table slots.
//  - A stub calls host.link(slot), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry,
//    then calls through the slot; every call between modules is `call_indirect slot`, so a compiled method needs no relinking.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
import { needsSymbolicSite, symbolicOperationKey, type SymbolicSite } from "../compiler/sites.ts";
import { compileSymbolicSite } from "../compiler/symbolic.ts";
import { HT, ModuleBuilder, T, ref, refNull, sleb, uleb, type VT, type FunctionType } from "../compiler/wasmbin.ts";
import { Code, OP } from "../compiler/code.ts";
import { type Program, ACC, kindOf, declaredMethod, declaredMethods, methodAt, methodCount, javaName, methodKinds, type Kinds, type Loader, type Kind, type JClass, type MethodInfo, type FieldInfo } from "../compiler/program.ts";
import { Cha } from "../compiler/cha.ts";
import { H, ELEM, ELEM_KIND, ELEM_IFACE, ELEM_OTHER, f32bits, f64bits } from "../compiler/consts.ts";
import { Compiler, MATH_IMPORTS, declareBase, intrinsicFor, kindVT, type Base, type FnTrace, type Intrinsic } from "../compiler/j2w.ts";
import type { CompileService, GuestMemory, HostBridge, HostContext, HostNet, HostSpec, NativeBinder } from "./hostapi.ts";
import { emitRestored, Sched, Sync, defaultLoop, ROOT, SYSTEM_LOADER, type HostLoop, type Strand } from "./sched.ts";
import { rtfns, type Synth } from "../compiler/rtfns.ts";
import { hostInfo, infoRecord, replayInfo, typeName, type InfoRecord } from "./classes.ts";
import { HostClasses } from "./hostclass.ts";
import { mhInvoke } from "./mhandles.ts";
import { hostText } from "./members.ts";
import { ASYNC } from "./inet.ts";
import { generateProxy, type ProxyDefinition } from "./proxy.ts";
import { hostObject } from "./annotations.ts";
import { classByName, dexOpen, dexOpenMemory, loaderObject, LOADER_OF_CLASS, Lookup } from "./loaders.ts";
import { definitionReady, initiatedInstruction, initiatedType, instructionClass, resolveInstruction, resolveClass, resolveForName, resolveCatch } from "./resolution.ts";
import { hasSignatureConstraints, validateSignatures } from "./signatures.ts";
import { SLOT, FIRST_FREE_SLOT, HOT_BUDGET, COUNT_BASE, COUNT_SLOTS, SCRATCH_BASE, WARM_AT, INIT_DONE, INIT_FAILED, THROWERS, ALLOC_WINDOW, excMessage, throwerBody, javaFrames, isStackOverflow, wasmFrameNames, deepStack, type JavaFrame, type Thrower } from "./exc.ts";
import { branchTargets, decodeInstruction, decodeInstructions, type PreparedInstruction } from "../../jvm/prepared.ts";
import { insnLen } from "../../jvm/opcodes.ts";
import { HEAP_LIMIT, parseMethodDesc } from "../../jvm/abi.ts";
import { mid, methodOf } from "../compiler/ids.ts";
import { dispatchMethodKey, dispatchSlotKey, overridesMethod, failed, symbolicDispatchFor, symbolicImplFor, symbolicOverride, symbolicMethod, resolveSymbolicMethod, unresolvedClass } from "../compiler/linkage.ts";
import { NO_INDEX, type DexFile } from "../../jvm/dex.ts";
import { compileModule, suspending } from "./module.ts";
import { AotRuntime, VERSION, sameMarks, type AotBuild, type AotStore, type AppIndex, type Marks, type Numbering, type Tail } from "./aot.ts";
import type { UnitResult, UpgradeJob } from "./unit.ts";
import { HotUnits } from "./hotunits.ts";

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
type Slot = { k: "method"; m: MethodInfo; done: boolean; hot?: boolean; pending?: boolean; stub?: Function } | { k: "thrower"; name: Thrower; done: boolean; stub?: Function }
  | { k: "synth"; name: string; d?: Synth; done: boolean; stub?: Function } | { k: "ensure"; done?: boolean };
/** what ensure()'s body uses of the module it is compiled into (World.emitEnsure) */
interface InitScope { mb: ModuleBuilder; b: Base; initG: number; sid: number; iw: number; tag: number; statics(f: FieldInfo): number; literal(c: Code, s: string): void }
/** the vtable words of a class module above which its start function makes the vtables (World.classModule) */
const VT_DATA_WORDS = 4096;
/** the most methods a first-tier unit holds (World.batch) */
const BATCH = 32;
/** the methods a unit compiled ahead of their first call holds (World.ahead), how many methods its calls are taken from, and the most it compiles in a World */
const AHEAD_UNIT = 16, AHEAD_ROOTS = 4096, AHEAD_MAX = 8192;
/** the engine charges a module some tens of KB of external memory however small, and external memory drives full collections: once MERGE_AT first-tier units
 *  are loose, a compile worker merges up to MERGE_MAX of their methods into one module */
const MERGE_AT = 1024, MERGE_MAX = 512;
/** A unit merged away is freed by the collection after nothing holds it, and freeing a module costs that collection's pause some 40 µs (the engine's
 *  second-pass weak callbacks free its native code): the thousands a launch's merges leave would stop the thread for 100-170 ms at once. They are dropped
 *  a batch at a time instead, the next once a collection has freed one of the last, or after RETIRE_WAIT_MS: RETIRE_BATCH while the app answers input,
 *  RETIRE_MAX otherwise, since units held until they are freed keep their external memory, which drives full collections */
const RETIRE_BATCH = 32, RETIRE_MAX = 512, RETIRE_WAIT_MS = 5000;
/** the most lazy-link stubs a module of shared stubs adds to the pool of a signature (World.poolStubs) */
const STUB_POOL = 1024;
type StubRequest = Kinds & { slot: number };
/** the kinds of a vtable entry's parameters (the receiver first) and result, from its method key */
function entryKinds(key: string): Kinds {
  const p = parseMethodDesc(key.slice(key.indexOf("(")));
  return { params: ["L", ...p.params.map(kindOf)], ret: p.ret === "V" ? "V" : kindOf(p.ret) };
}
/** a hot method is recompiled with up to MAX_GROUP methods in its module: the small callees (size in code units) that ran at least COPY_MIN times, and guards for at most MAX_GUARDS
 *  implementations per virtual call. A small method without a loop asks LEAF_WAITS more budgets before it is compiled alone */
const MAX_GROUP = 24, SMALL_CALLEE = 100, MAX_GUARDS = 2, LEAF_WAITS = 3, COPY_MIN = 64;
/** a virtual call with more implementations than this gets no guards: the busiest few of the whole app rarely are a given site's */
const MEGAMORPHIC = 32;
/** second-tier compiling may take at most this share of the time the program has been hot (since the first request for it), a compile being expected to need UPGRADE_MS
 *  (a mean of measured compiles would carry the first compile's warm-up of the compiler into every later decision) */
const UPGRADE_SHARE = 0.3, UPGRADE_MS = 1;
/** when a unit's compile began, and the compile time accounted by then (World.accountCompilation) */
type Clock = { start: number; accounted: number };
type Built = { bytes: Uint8Array | WebAssembly.Module; traces: FnTrace[] };
/** a class-hierarchy decision: calls of decl.name+desc run only the method `tk` of class `tc` (none if empty) */
interface Assumption { decl: string; name: string; desc: string; tc: string; tk: string; slots: Set<number> }

export class World {
  opts: WorldOptions;
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
  stats = { phase: { prepare: 0, flow: 0, infer: 0, facts: 0, emit: 0, encode: 0, classBuild: 0 }, aot: { d: 0, c: 0, dead: 0, missed: 0, readMs: 0, ms: 0, bytes: 0 }, classes: 0, units: 0, methods: 0, bridgeCallerCaptures: 0, bytes: 0, compileMs: 0, moduleMs: 0, instantiateMs: 0, instances: 0, classMs: 0, invalidated: 0, upgrades: 0, merged: 0, retired: 0, collected: 0, ahead: 0 };
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
  private frameTraces = { get: (name: string) => this.traces.get(name) ?? this.aot?.trace(name) };
  private stacks = new WeakMap<object, Error | JavaFrame[]>();
  private bridgeStacks = new WeakMap<Strand, BridgeStack>();
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
  mem = new WebAssembly.Memory({ initial: Math.ceil(SCRATCH_BASE / 65536) + 1 });
  sp = new WebAssembly.Global({ value: "i32", mutable: true }, SCRATCH_BASE);
  natives: NativeBinder;
  bridge: HostBridge;
  /** the classes the host implements (hostclass.ts) */
  hosts = new HostClasses(this);
  host: Record<string, Function>;
  private rt!: { tag: WebAssembly.Tag; alloc: WebAssembly.Global; hash: WebAssembly.Global; ctab: WebAssembly.Global; unsafeSlots: WebAssembly.Global; sid: WebAssembly.Global; thr: WebAssembly.Global; depth: WebAssembly.Global; iw: WebAssembly.Global; wait: WebAssembly.Global; classId: (o: object) => number; link: (slot: number) => void; nop: Function };
  /** the threads: strands, monitors, waits (sched.ts) */
  sched!: Sched;
  private synth = new Map<string, number>();
  /** the synthetic functions whose stub module exists */
  private stubbed = new Set<number>();
  aot?: AotRuntime;
  /** what the World had numbered when its constructor returned, or once an app build was attached: where a compile worker's numbering starts */
  base!: Marks;
  /** the slot reservations after the platform classes, in order */
  tail: Tail[] = [];
  /** the blocks of classes a replayed numbering (`adopt`) gave slots before their modules were made */
  preassigned = new Map<string, number>();
  /** how many times the default namespace was extended or something a compile worker cannot follow was added: results made before are not adopted */
  epoch = 0;
  private touching: Set<string> | null = null;
  private imtCache = new Map<number, Map<number, number>>();
  private hotUnits = new HotUnits();
  private refreshing = false;
  hotRefreshes = 0;

  constructor(prog: Program, opts: WorldOptions) {
    this.opts = opts;
    this.prog = prog;
    this.natives = opts.natives;
    this.bridge = this.natives.bridge(this);
    this.cha = new Cha(prog);
    // the heap holds the engine's own data too (the program model is hundreds of MB), which is not the Java heap ART's limit is about
    const heap = opts.heapUsed, heapBase = heap(), limit = opts.heapLimit ?? HEAP_LIMIT;
    const names = (id: number) => javaName(this.names[id]);
    // a host call whose answer is pending parks the strand, which annotationWait settles with the answer
    const park = (value: unknown, none: null | 0): unknown => {
      if (!(value instanceof Promise)) return value;
      this.sched.parkNative(value); return none;
    };
    this.host = {
      ...Object.fromEntries(Object.keys(MATH_IMPORTS).map((f) => [f, Math[f as keyof typeof MATH_IMPORTS]])),
      fmod: (a: number, b: number) => a % b,
      gap: (id: number) => { this.lastGap = id; this.onGap(id); },
      link: (slot: number) => this.linkSlot(slot),
      stubSlot: (at: number) => this.stubSlots[at],
      linkDue: (slot: number) => +(this.sched.canWait() && !this.inSynchronousJava() && (this.sched.turnDue() || !!this.aot?.needsPreparation(slot))),
      linkWait: suspending((slot: number) => this.sched.admitLink(() => this.linkSlot(slot), () => this.aot?.prepare(slot))),
      sync: (op: number, obj: object | null, a: number) => this.sched.sync(op, obj, a),
      block: suspending((op: number, obj: object | null, a: number, b: number) => {
        try { this.sched.running = this.sched.current(); return this.sched.block(op, obj, a, b); } finally { this.sched.idle(); }
      }),
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
      annotation: (kind: number, a: number, b: number, filter: object | null) => park(hostObject(this, kind, a, b, filter), null),
      proxy: (name: unknown, interfaces: object, loader: object | null, methods: object, exceptions: object) => this.javaValue(generateProxy(this, this.hostString(name) as string, interfaces, loader, methods, exceptions)),
      net: (op: number, node: unknown, a: number, b: number) => opts.net ? opts.net(this, op, this.hostString(node) as string, a, b) : ASYNC,
      mhInvoke: (mh: object, args: object, site: string, exact: number) => {
        const value = mhInvoke(this, mh, args, site, exact);
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
        const message = this.lastMessage = excMessage(kind, a, b, c, d, e, names, (id) => id < 0 ? this.gapList[this.lastGap] : this.linkMessages[id]);
        if (message !== null && (kind === SLOT.ncdfr || kind === SLOT.nsme || kind === SLOT.nsfer)) this.onUnresolved(message, kind === SLOT.ncdfr ? unresolvedClass(message) : undefined);
        return message;
      },
      capture: (exn: object) => {
        const stack = deepStack();
        this.stacks.set(exn, this.bridgeStacks.has(this.sched.current()) ? this.javaStack(stack.stack ?? "") : stack);
      },
      stFrames: (state: object | null) => (this.frames = state ? this.stackTrace(state) : []).length,
      // a frame's class, method and the source file its class def names (null without one)
      stString: (i: number, which: number) => {
        const f = this.frames[i], c = which === 2 ? this.prog.get(f.cls.replace(/\./g, "/")) : undefined;
        return which === 0 ? javaName(f.cls) : which === 1 ? f.method : c?.def && c.def.sourceFileIdx !== NO_INDEX ? c.dex!.string(c.def.sourceFileIdx) : null;
      },
      stLine: (i: number) => this.frames[i].line,
    };
    this.slots.length = FIRST_FREE_SLOT;
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
    this.base = this.numbering();
    if (opts.app) this.attachApp(opts.app);
  }
  /** whether an app build is in use */
  appAttached = false;
  /** uses `app`, an app build, if this World can (AotRuntime.extend): before the app's code first runs */
  attachApp(app: NonNullable<WorldOptions["app"]>): boolean {
    if (this.appAttached || !this.aot?.extend(app.index, app.store)) return false;
    this.base = this.numbering();
    return this.appAttached = true;
  }

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
    this.rt.unsafeSlots.value = null;
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
    key = javaName(key);
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
  intrinsic(m: MethodInfo): Intrinsic | undefined { return this.madeUp.get(mid(m)) ?? intrinsicFor(this.opts.intrinsics, this.natives, m); }
  /** the bodies of the methods of classes made at run time (addClass), by method id */
  private madeUp = new Map<string, Intrinsic>();
  needsInit(n: string): boolean {
    const c = this.prog.get(n); if (!c) return false;
    if (declaredMethod(c, "<clinit>()V") || c.def?.staticValuesOff || hasSignatureConstraints(this, n)) return true;
    return (c.sup ? this.needsInit(c.sup) : false) || (!c.isInterface && this.prog.defaultIfaces(n).some((i) => this.needsInit(i)));
  }
  /** the init word of the class with id `id` (0 before its module is built) */
  initWord(id: number): number { const rt = this.loadedClass(this.names[id]); return rt ? (rt.exports[id + ":init"] as WebAssembly.Global).value as number : 0; }
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
      const sel = this.selectors.get(dispatchMethodKey(key)), target = sel ? targets[i] : undefined;
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
      const key = this.selKeys[sel], name = this.names[cls];
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
  private reserveSlots(n: number): number {
    const base = this.slots.length;
    this.slots.length += n;
    const have = this.table.length;
    if (this.slots.length > have) this.table.grow(Math.max(this.slots.length - have, have));
    return base;
  }
  slotOf(m: MethodInfo): number { return this.link(m.cls).slotBase + m.index; }
  ensureSlot(cls: string): number { const rt = this.link(cls); return rt.slotBase + rt.nMethods; }
  /** the slot of the generated function `name` (runtime functions, per-class allocators, abstract-method stubs), a lazy-link stub until first called;
   *  `eager`: its code is compiled now, for a caller about to call it, instead of after a stub's first call */
  synthSlot(name: string, d: Synth, eager = false): number {
    this.touching?.add("!" + name);
    let slot = this.synth.get(name);
    if (slot === undefined) { this.synth.set(name, slot = this.reserveSlots(1)); this.tail.push(name); }
    if (this.stubbed.has(slot)) return slot;
    this.stubbed.add(slot);
    this.slots[slot] = { k: "synth", name, d, done: false };
    if (this.aot?.building || this.opts.compileOnly) return slot;
    // the app build may hold its code, which its module puts in the slot
    if (this.aot?.installSynth(name)) { (this.slots[slot] as { done: boolean }).done = true; return slot; }
    if (eager) { this.linkSlot(slot); return slot; }
    this.table.set(slot, this.poolStubs([{ params: d.params, ret: d.ret, slot }])[0]);
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
      const cls = "java/lang/IllegalAccessError", e = c.newLocal(T.anyref);
      cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(e).lget(e);
      cx.callMethod(c, cx.prog.resolve(cls, "<init>", "()V")!); c.lget(e).throw_(cx.tag);
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
  /** a lazy-link stub for method `m` in `slot`, to put back where precompiled code was removed */
  restoreStub(slot: number, m: MethodInfo): Function { return this.poolStubs([{ ...methodKinds(m), slot }])[0]; }
  private importLink(mb: ModuleBuilder): number {
    return mb.importFunc("rt", "link", mb.addFuncType([T.i32], []));
  }
  private stubBody(slot: number, sig: number, params: VT[], link: number): number[] {
    const c = new Code(params.length).i32(slot).call(link);
    params.forEach((_, i) => c.lget(i));
    return c.i32(slot).callIndirect(sig).finish();
  }
  /** Lazy-link stubs shared by slots: modules of stubs, a pool per signature, each stub asking the host which slot it stands for (host.stubSlot), linking it
   *  and calling it. The engine's cost of a module with code is mostly fixed, so slots get their stubs without a module each, and one module adds to
   *  every pool a request lacks. A stub stays its slot's (Slot.stub puts it back). */
  private stubPools = new Map<string, { chunks: { fns: Function[]; base: number; used: number }[]; size: number }>();
  private stubSlots: number[] = [];
  private poolStubs(want: StubRequest[]): Function[] {
    const key = (w: StubRequest) => w.params.join("") + ":" + w.ret, need = new Map<string, { w: StubRequest; n: number }>();
    for (const w of want) { const k = key(w), e = need.get(k); if (e) e.n++; else need.set(k, { w, n: 1 }); }
    const grow: { k: string; w: StubRequest; size: number }[] = [];
    for (const [k, { w, n }] of need) {
      const p = this.stubPools.get(k), free = p ? p.chunks.reduce((a, c) => a + c.fns.length - c.used, 0) : 0;
      if (free < n) grow.push({ k, w, size: Math.max(n - free, Math.min(STUB_POOL, 4 * (p?.size ?? 4))) });
    }
    if (grow.length) {
      const mb = new ModuleBuilder(); declareBase(mb);
      mb.importTable("rt", "table", T.funcref, 0);
      const link = this.importLink(mb), slotOf = mb.importFunc("host", "stubSlot", mb.addFuncType([T.i32], [T.i32]));
      let at = this.stubSlots.length, e = 0;
      const made = grow.map(({ k, w, size }) => {
        const vts = w.params.map((k) => kindVT(k)), sig = mb.addFuncType(vts, w.ret === "V" ? [] : [kindVT(w.ret)]), first = e, base = at;
        // a stub's body, in bytes: (local i32) i32.const at, call slotOf, local.tee, call link, the params and the slot, call_indirect
        const tail = [0x10]; uleb(slotOf, tail); tail.push(0x22); uleb(vts.length, tail); tail.push(0x10); uleb(link, tail);
        vts.forEach((_, j) => { tail.push(0x20); uleb(j, tail); });
        tail.push(0x20); uleb(vts.length, tail); tail.push(0x11); uleb(sig, tail); tail.push(0, 0x0b);
        for (let i = 0; i < size; i++, at++, e++) {
          const body = [1, 1, 0x7f, 0x41]; sleb(at, body);
          mb.export(String(e), "func", mb.addFunc(sig, body.concat(tail), "stub"));
        }
        return { k, size, first, base };
      });
      const x = this.instantiate(mb.build(), { rt: this.rtImports(), host: this.host }).exports;
      this.stubSlots.length = at;
      for (const { k, size, first, base } of made) {
        const p = this.stubPools.get(k) ?? this.stubPools.set(k, { chunks: [], size: 0 }).get(k)!;
        p.chunks.push({ fns: Array.from({ length: size }, (_, i) => x[first + i] as Function), base, used: 0 }); p.size = size;
      }
    }
    return want.map((w) => {
      const p = this.stubPools.get(key(w))!;
      while (p.chunks[0].used === p.chunks[0].fns.length) p.chunks.shift();
      const c = p.chunks[0];
      this.stubSlots[c.base + c.used] = w.slot;
      return c.fns[c.used++];
    });
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
      const f = mb.addFunc(sig, this.stubBody(SLOT[name], sig, params, link), "stub:" + name);
      mb.addElemActive(0, SLOT[name], [f]);
      this.slots[SLOT[name]] = { k: "thrower", name, done: false };
    }
    const x = this.instantiate(mb.build(), { rt: { table: this.table }, host: this.host }).exports as Record<string, any>;
    this.rt = { tag: x.tag, alloc: x.alloc, hash: x.hash, ctab: x.ctab, unsafeSlots: x.unsafeSlots, sid: x.sid, thr: x.thr, depth: x.depth, iw: x.iw, wait: x.wait, classId: x.classId, link: x.link, nop: x.nop };
  }

  rtImports() { const { tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, link } = this.rt; return { table: this.table, nm: this.nm, tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, link, mem: this.mem, sp: this.sp, gmem: this.opts.guest?.memory, gflags: this.opts.guest?.flags }; }

  /** the class module of `name`, built on first use */
  link(name: string): ClassRt {
    this.touching?.add(name);
    let rt = this.classes.get(name);
    if (rt) return rt;
    const aot = this.aot?.linkClass(name);
    if (aot) { this.classes.set(name, aot); this.repairVtable(name); return aot; }
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    let slotBase = this.aot?.reservedBase(name) ?? this.preassigned.get(name);
    if (slotBase === undefined) { slotBase = this.addBlock(name, methods.length + 1); this.tail.push([name, methods.length + 1]); }
    if (this.aot?.building || this.opts.compileOnly) {
      this.classes.set(name, rt = { name, id, mod: this.aot?.building ? this.aot.extraMod : "c" + id, slotBase, nMethods: methods.length, exports: {} });
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
    if (this.opts.compileOnly || this.aot?.building) return;
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
    let link = -1, sid = -1, iw = -1, tag = -1;
    if (!lean) {
      mb.importTable("rt", "table", T.funcref, 0);
      link = this.importLink(mb);
      sid = mb.importGlobal("rt", "sid", T.i32, true); iw = mb.importGlobal("rt", "iw", T.i32, true); tag = mb.importTag("rt", "tag", b.tTagFn);
    }
    // the String constants of the static values are imported before the module defines a global of its own
    const consts = new Map<string, number>();
    let fromChars = -1;
    if (!lean) for (const { name } of rts) {
      const jc = this.prog.get(name);
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
      const stubs = methods.map((m, i) => {
        const { params, ret } = methodKinds(m);
        const vt = params.map((k) => kindVT(k)), sig = mb.addFuncType(vt, ret === "V" ? [] : [kindVT(ret)]);
        return mb.addFunc(sig, this.stubBody(slotBase + i, sig, vt, link));
      });
      if (initialize) {
        const c = new Code(0);
        this.emitEnsure({ mb, b, initG, sid, iw, tag, statics: (f) => statics.get(f)!, literal }, jc!, rt, c);
        stubs.push(mb.addFunc(mb.addFuncType([], []), c.finish()));
      } else if (jc) stubs.push(mb.addFunc(mb.addFuncType([], []), new Code(0).finish()));
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
    const want: StubRequest[] = (jc?.methods ?? []).map((m, i) => ({ ...methodKinds(m), slot: rt.slotBase + i })), ensure = rt.slotBase + rt.nMethods;
    if (jc && this.needsInit(rt.name)) want.push({ params: [], ret: "V", slot: ensure });
    else if (jc) this.table.set(ensure, this.rt.nop);
    this.poolStubs(want).forEach((f, i) => this.table.set(want[i].slot, f));
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
  /** host.link: compile what `slot` stands for and put it in the table. A method is compiled alone, cheaply, and counts its calls and loop
   *  iterations; `upgrade` recompiles the hot ones with their small callees. */
  private linkSlot(slot: number): void {
    const s = this.slotAt(slot);
    if (!s || s.done) return;
    if (s.k === "ensure") { this.linkEnsure(slot); return; }
    if (s.k === "method" && this.aot?.install(slot) && s.done) return;
    const clock = this.unitClock();
    const cx = new Compiler(this), batch = s.k === "method" ? this.batch(s.m) : [];
    cx.shareHelpers();
    for (const m of batch) this.demand.methods.add(m);
    this.noteRun(batch);
    const built = s.k === "method" ? cx.buildUnit(batch) : s.k === "synth" ? cx.buildSynthetic(s.name, s.d!.params, (c) => s.d!.body(cx, c), s.d!.ret)
      : cx.buildSynthetic(s.name, THROWERS[s.name].params, (c) => throwerBody(cx, c, s.name));
    this.stats.units++; this.stats.methods += Math.max(1, batch.length);
    const group = batch.map((m) => this.slotOf(m));
    this.install(group, false, cx, this.unitImports(cx), built, slot, clock);
    if (group.length && this.opts.compiler) {
      this.loose.push(group);
      if (this.loose.length >= this.mergeAt) this.opts.compiler.merge(this);
    }
  }
  /** first-tier units of methods (their slots) not merged yet, oldest first, and those of the merge on its way */
  private loose: number[][] = [];
  private merging: number[][] = [];
  private mergeAt = MERGE_AT;
  private mergeable(g: number[]): boolean {
    return g.every((at) => { const s = this.peek(at); return s?.k === "method" && s.done && !s.hot && !s.pending && this.groupOf.get(at) === g; });
  }
  /** the oldest loose units, merged into one module by a compile worker; the merged code calls through the table, so each method can be reset alone */
  mergeJob(): UpgradeJob | undefined {
    this.loose.push(...this.merging.filter((g) => this.mergeable(g)));
    this.merging = [];
    if (this.loose.length < this.mergeAt) return undefined;
    const clock = this.unitClock(), groups: number[][] = [];
    let n = 0, size = 0;
    for (; n < this.loose.length && size < MERGE_MAX; n++) {
      const g = this.loose[n];
      if (this.mergeable(g)) { groups.push(g); size += g.length; }
    }
    this.loose.splice(0, n);
    const units = groups.map((g) => g.map((at) => (this.peek(at) as { m: MethodInfo }).m)), refs = this.jobRefs(units), taken = new Set(refs.units);
    groups.forEach((g, i) => (taken.has(units[i]) ? this.merging : this.loose).push(g));
    this.accountCompilation(clock);
    // what is not ready waits for more units to be linked
    if (!refs.units.length) { this.mergeAt = this.loose.length + MERGE_AT / 4; return undefined; }
    this.mergeAt = MERGE_AT;
    return this.job(refs.units.flat(), [], refs, undefined, true);
  }
  /** `m` and the methods without code that its first run will call: its static and direct calls before its first branch, and theirs. They are compiled beside
   *  it rather than in a module each, which costs the engine far more than the functions */
  private batch(m: MethodInfo): MethodInfo[] {
    const out = [m];
    for (let i = 0; i < out.length && out.length < BATCH; i++) {
      const c = out[i];
      if (!c.codeOff || this.intrinsic(c)) continue;
      for (const ins of this.entryCalls(c)) {
        if (out.length >= BATCH) break;
        if (needsSymbolicSite(this, c, ins)) continue;
        const mr = c.dex.method(ins.b), t = this.prog.resolve(c.dex.typeName(mr.cls), mr.name, c.dex.methodDesc(ins.b));
        if (!t || out.includes(t) || !t.codeOff || t.flags & ACC.NATIVE || this.intrinsic(t)) continue;
        const at = this.slotOf(t), ts = this.slotAt(at);
        if (ts?.k !== "method" || ts.done || ts.pending || this.aot?.install(at) && ts.done) continue;
        out.push(t);
      }
    }
    return out;
  }
  /** ensure() of a class linked on demand, in one unit with its <clinit>, which only ensure() calls */
  private linkEnsure(slot: number): void {
    this.settleInits();
    const cls = this.blockClass[this.blockOf(slot)], ci = this.prog.require(cls).byKey.get("<clinit>()V"), clock = this.unitClock();
    const at = ci && this.slotOf(ci), clinit = at === undefined ? undefined : this.slotAt(at);
    const own = clinit?.k === "method" && !clinit.done && !(this.aot?.install(at!) && clinit.done) ? clinit.m : undefined;
    const cx = new Compiler(this);
    cx.shareHelpers();
    const built = cx.buildUnit(own ? [own] : [], [], false, false, [cls]);
    if (own) { this.demand.methods.add(own); this.stats.methods++; }
    this.stats.units++;
    this.install(own ? [at!] : [], false, cx, this.unitImports(cx), built, slot, clock);
    this.initializing.push([slot, cls, own ? at! : -1]);
  }
  /** ensure() units whose class may still be initializing: their slot, class and the <clinit> slot compiled beside them (-1 if none) */
  private initializing: [number, string, number][] = [];
  /** Once a class is initialized its ensure() returns at once and its <clinit> is not called again: the slot gets the shared no-op, the <clinit> its stub,
   *  and the unit is retired */
  private settleInits(): void {
    const done: Function[] = [];
    this.initializing = this.initializing.filter(([slot, cls, at]) => {
      if (!this.initialized(cls)) return true;
      done.push(this.table.get(slot) as Function);
      this.table.set(slot, this.rt.nop);
      const s = at < 0 ? undefined : this.slotAt(at);
      if (s?.k === "method" && s.done && s.stub) { this.table.set(at, s.stub); s.done = false; s.hot = false; this.groupOf.delete(at); this.hotUnits.forget(at); }
      return false;
    });
    if (done.length) this.retire(done);
  }
  /** host.hot: the method in `slot` has used up its budget; compile it again with its small callees copied in and guarded calls */
  private upgrade(slot: number): void {
    this.refreshHotUnits();
    const s = this.slotAt(slot);
    if (s?.k !== "method" || !s.done || s.hot) return;
    this.requested.add(slot);
    // a compile worker takes the job when there is one: the method keeps running its first-tier code until the unit arrives, and asks again if the unit is not taken
    const reset = () => { this.counts()[slot] = 0; };
    if (s.pending) { reset(); return; }
    // a small method without a loop is worth most copied into the units of the callers that run it in their loops: alone it waits a few budgets for them
    if (this.leaf(s.m)) {
      const waited = this.leafWaits.get(slot) ?? 0;
      if (waited < LEAF_WAITS) { this.leafWaits.set(slot, waited + 1); reset(); return; }
    }
    if (this.opts.holdUpgrades?.()) { reset(); return; }
    const taken = this.opts.compiler?.submit(this, slot);
    if (taken) { if (taken === true) s.pending = true; reset(); return; }
    // the second tier is paid for out of the time the program runs: its compiling is kept to a share of it. A method that asks too soon waits in line and asks
    // again after another budget. The next compile the share allows goes to the outermost waiting method on the stack, whose unit can take in what it calls,
    // else to the one that has waited longest and asked again since, so it is still hot
    const t0 = performance.now(), clock = this.unitClock();
    const wait = () => { this.refused.set(slot, (this.refused.get(slot) ?? 0) + 1); reset(); };
    if (!this.upgradeAllowed(t0)) { wait(); return; }
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
    this.install(installed.map((m) => this.slotOf(m)), true, cx, this.unitImports(cx), built, pick, clock);
    this.upgradeMs += performance.now() - t0;
  }
  private upgradeAllowed(now: number): boolean {
    this.hotSince ??= now;
    return this.upgradeMs + UPGRADE_MS <= UPGRADE_SHARE * (now - this.hotSince);
  }
  /** Coalesce executed-site readiness at an existing Java entry or promotion boundary. */
  private refreshHotUnits(): void {
    if (!this.hotUnits.hasPending() || this.refreshing || this.opts.build || this.opts.compileOnly || this.opts.holdUpgrades?.()) return;
    for (const unit of this.hotUnits.pending()) {
      const slot = unit.slots[0], s = this.peek(slot);
      if (!this.hotUnits.live(unit, this.table) || s?.k !== "method" || !s.done || !s.hot) { this.hotUnits.forget(slot); continue; }
      if (s.pending) continue;
      this.refreshing = true;
      let start: number | undefined;
      let clock: Clock | undefined;
      try {
        const taken = this.opts.compiler?.submit(this, slot);
        if (taken) { if (taken === true) s.pending = true; return; }
        start = performance.now();
        if (!this.upgradeAllowed(start)) return;
        const epoch = this.epoch;
        clock = this.unitClock();
        const cx = new Compiler(this);
        const members = unit.slots.map(at => (this.peek(at) as { m: MethodInfo }).m);
        const { installed, copies } = this.group(s.m, members);
        const built = cx.buildUnit(installed, copies, true);
        this.stats.units++; this.stats.methods += installed.length + copies.length;
        const imports = this.unitImports(cx);
        if (epoch !== this.epoch || !this.hotUnits.live(unit, this.table)) return;
        // A refresh must consume readiness, rather than recompile the same adapter forever.
        if (![...unit.ready].some(name => !cx.symbolicImports.has(name))) { this.hotUnits.forget(slot); return; }
        this.install(installed.map(m => this.slotOf(m)), true, cx, imports, built, slot, clock);
        this.stats.upgrades++; this.hotRefreshes++;
      } finally {
        if (clock) this.accountCompilation(clock);
        if (start !== undefined) this.upgradeMs += performance.now() - start;
        this.refreshing = false;
      }
      return;
    }
  }
  /** the outermost Java frame of the running stack whose method waits for the second tier (V8 names Wasm frames by function, which are named by method id) */
  private outermostWaiting(): number | undefined {
    if (!this.refused.size) return undefined;
    let found: number | undefined;
    for (const name of wasmFrameNames(deepStack().stack ?? "")) {
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
    const refresh = this.hotUnits.get(slot);
    if (s?.k !== "method" || !s.done || (s.hot && (!refresh?.ready.size || refresh.slots[0] !== slot || !this.hotUnits.live(refresh, this.table)))) return undefined;
    const clock = this.unitClock(), members = s.hot ? refresh!.slots.map(at => (this.peek(at) as { m: MethodInfo }).m) : undefined;
    const { installed, copies } = this.group(s.m, members);
    const refs = this.jobRefs([[...installed, ...copies]]);
    this.accountCompilation(clock);
    return refs.units.length ? this.job(installed, copies, refs, s.hot ? refresh!.generation : undefined) : undefined;
  }
  private job(installed: MethodInfo[], copies: MethodInfo[], refs: Pick<UpgradeJob, "resolved" | "prepared">, refresh?: number, merge?: boolean): UpgradeJob {
    return { refresh, merge, resolved: refs.resolved, prepared: refs.prepared, unit: this.stats.units++, installed: installed.map(mid), copies: copies.map(mid), plan: [...this.plan].map(([key, ms]) => [key, ms.map(mid)]), long: [...installed, ...copies].map(mid).filter((id) => this.longLoops.has(id)) };
  }
  /** what a compile worker must be told of this World's class loading to compile `units` as it would: the initiating identities their code resolves, and the
   *  hierarchies of those classes. A unit that reaches a class whose definition is not ready is left out */
  private jobRefs(units: MethodInfo[][]): { units: MethodInfo[][]; resolved: [string, string, string][]; prepared: [string, string | null, string[]][] } {
    const resolved: [string, string, string][] = [], prepared: [string, string | null, string[]][] = [];
    const seen = new Map<string, Set<string>>(), hierarchies = new Set<string>(), ready = new Map<string, boolean>();
    const own = (key: string) => { const cls = this.prog.get(key)!; return !!cls.dex && !!cls.def && this.prog.loaderOf(key) !== this.prog.boot; };
    const isReady = (key: string): boolean => {
      let r = ready.get(key);
      if (r === undefined) {
        ready.set(key, true);
        const cls = this.prog.get(key);
        r = !!cls && definitionReady(this, key) && (!own(key) || [...cls.sup ? [cls.sup] : [], ...cls.ifaces].every(isReady));
        ready.set(key, r);
      }
      return r;
    };
    const resolve = (referrer: string, name: string, key: string) => {
      const names = seen.get(referrer) ?? seen.set(referrer, new Set()).get(referrer)!;
      if (names.has(name)) return;
      names.add(name); resolved.push([referrer, name, key]);
      if (hierarchies.has(key)) return;
      hierarchies.add(key);
      const cls = this.prog.get(key)!;
      prepared.push([key, cls.sup, [...cls.ifaces]]);
      if (!own(key)) return;
      const indices = [...cls.def!.superIdx === 0xffffffff ? [] : [cls.def!.superIdx], ...cls.def!.interfaces];
      const targets = [...cls.sup ? [cls.sup] : [], ...cls.ifaces];
      indices.forEach((index, i) => resolve(key, cls.dex!.rawTypeName(index), targets[i]));
    };
    const owners = (m: MethodInfo) => !m.codeOff || this.intrinsic(m) ? [] : this.planning(m).references.flatMap((name) => initiatedType(this, m.cls, name) ?? []);
    const taken: MethodInfo[][] = [];
    for (const u of units) {
      const os = u.map(owners);
      if (!os.every((o) => o.every((x) => isReady(x.key)))) continue;
      taken.push(u);
      u.forEach((m, i) => os[i].forEach((o) => resolve(m.cls, o.name, o.key)));
    }
    return { units: taken, resolved, prepared };
  }
  /** the classes linked so far, and those with a method that has been called (a method's slot is done once it has run or its precompiled code is installed) */
  usage(): { linked: string[]; called: string[] } {
    const called = this.blockClass.filter((name, b) => { const n = this.prog.get(name)?.methods.length ?? 0; for (let i = 0; i < n; i++) if ((this.slots[this.blockBase[b] + i] as { done?: boolean } | undefined)?.done) return true; return false; });
    return { linked: [...this.classes.keys()], called };
  }
  /** the second-tier compile of the method in `slot` will not come: it may ask for it again, or be compiled inline */
  release(slot: number): void { const s = this.slotAt(slot); if (s?.k === "method") s.pending = false; }
  /** A failed optional refresh keeps its hot code and stops tracking that generation. */
  failedRefresh(slot: number, generation: number): void {
    const unit = this.hotUnits.get(slot);
    if (!unit || unit.generation !== generation || !this.hotUnits.live(unit, this.table)) return;
    this.hotUnits.forget(slot);
  }
  /** installs the second-tier unit a compile worker made for `slot`, if it is still sound here: nothing was added to the Program since `epoch`, and the numbering its code relies on
   *  is this World's (it was numbered from `result.numbering.from`) */
  adoptUnit(slot: number, job: UpgradeJob, result: UnitResult, epoch: number): boolean {
    if (job.merge) return this.adoptMerged(job, result, epoch);
    const s = this.slotAt(slot), head = result.header, clock = this.unitClock();
    this.release(slot);
    const refresh = this.hotUnits.get(slot);
    if (!this.sound(result, epoch) || s?.k !== "method" || !s.done) return false;
    if (job.refresh === undefined ? s.hot : !s.hot || refresh?.generation !== job.refresh || !this.hotUnits.live(refresh, this.table)) return false;
    if (job.refresh !== undefined && ![...refresh!.ready].some(name => !(head.symbols ?? []).some(([site]) => site === name))) { this.hotUnits.forget(slot); return false; }
    if (job.refresh !== undefined) {
      const installed = new Set(job.installed);
      if (refresh!.slots.some(at => !installed.has(mid((this.peek(at) as { m: MethodInfo }).m)))) return false;
      for (const id of job.installed) {
        const method = methodOf(this.prog, id);
        if (!method) return false;
        const at = this.slotOf(method);
        if (!refresh!.slots.includes(at) && (this.peek(at) as { done?: boolean } | undefined)?.done) return false;
      }
      for (const [referrer, name, key] of job.resolved ?? []) if (this.prog.initiatedBy(this.prog.loaderOf(referrer), name) !== key || !definitionReady(this, key)) return false;
      for (const [key, sup, ifaces] of job.prepared ?? []) {
        const cls = this.prog.get(key);
        if (!cls || !definitionReady(this, key) || cls.sup !== sup || cls.ifaces.length !== ifaces.length || cls.ifaces.some((name, i) => name !== ifaces[i])) return false;
      }
    }
    const r = this.received(result);
    if (!r) return false;
    this.stats.methods += job.installed.length + job.copies.length; this.stats.upgrades++;
    this.install(job.installed.map((id) => this.slotOf(methodOf(this.prog, id)!)), true, r.unit, r.imports, r.built, slot, clock);
    if (job.refresh !== undefined) this.hotRefreshes++;
    return true;
  }
  /** whether a worker's unit was made for this World as it is: nothing was added to the Program since `epoch`, and its natives are bound here */
  private sound(result: UnitResult, epoch: number): boolean {
    const head = result.header;
    return head.version === VERSION && epoch === this.epoch && head.natives.every((id) => this.nativeBound(id));
  }
  /** takes the numbering of a worker's unit and links what it names; its module and imports, undefined if the numbering does not follow this World's */
  private received(result: UnitResult) {
    const head = result.header, n = result.numbering;
    if ((n.names.length || n.tail.length || n.selectors.length || n.gaps.length || n.links.length) && !this.adopt(n)) return undefined;
    for (const id of head.touch) this.link(this.names[id]);
    for (const name of head.synth) this.ensureSynth(name);
    const target = (cls: string, key: string) => (cls ? this.prog.get(cls)?.byKey.get(key) : undefined);
    const owner = (at: number) => (this.slotAt(at) as { m: MethodInfo }).m;
    const unit = { assumptions: head.assumptions.map(([decl, name, desc, tc, tk, at]) => [decl, name, desc, target(tc, tk), owner(at)] as Compiler["assumptions"][number]),
      absent: head.missing.map(([name, at]) => [name, owner(at)] as [string, MethodInfo]), symbols: head.symbols ?? [] };
    const imports: Record<string, any> = { rt: this.rtImports(), host: this.host, n: this.nativeImports(head.natives), symbolic: this.symbolicImports(head.symbols ?? []) };
    this.classImports(head.classImports, imports);
    const traces = result.traces.map((t) => ({ name: t.name, m: t.m ? methodOf(this.prog, t.m) : undefined, offsets: t.offsets, pcs: t.pcs }));
    for (const c of head.allocs) this.allocated.add(c);
    return { unit, imports, built: { bytes: result.module, traces } };
  }
  /** installs merged first-tier code in the slots of the units it was merged from that still hold them; the others keep what they have */
  private adoptMerged(job: UpgradeJob, result: UnitResult, epoch: number): boolean {
    const groups = this.merging, clock = this.unitClock();
    this.merging = [];
    const r = this.sound(result, epoch) ? this.received(result) : undefined;
    if (!r) { this.loose.push(...groups.filter((g) => this.mergeable(g))); return false; }
    const liveGroups = groups.filter((g) => this.mergeable(g)), live = liveGroups.flat(), merged = new Set(live);
    if (!live.length) return true;
    // one function of each unit holds its instance, and so its module
    this.retire(liveGroups.map((g) => this.table.get(g[0]) as Function));
    const kept = job.installed.map((id) => this.slotOf(methodOf(this.prog, id)!)).filter((at) => !merged.has(at)).map((at) => [at, this.table.get(at)] as const);
    this.instantiateUnit(r.unit, r.imports, r.built, live[0], clock);
    for (const [at, f] of kept) this.table.set(at, f);
    for (const at of live) this.groupOf.set(at, [at]);
    this.stats.merged += live.length;
    return true;
  }
  private retired: Function[] = [];
  private retiring = false;
  private retiredCollected = new FinalizationRegistry<number>((batch) => { this.stats.collected++; if (batch === this.retireBatch) this.dropRetired(); });
  private retireBatch = 0;
  private retire(units: Function[]): void {
    this.retired.push(...units);
    if (!this.retiring) this.dropRetired();
  }
  private dropRetired(): void {
    const batch = this.retired.splice(0, this.opts.answering?.() ? RETIRE_BATCH : RETIRE_MAX), id = ++this.retireBatch;
    this.retiring = batch.length > 0;
    if (!batch.length) return;
    for (const f of batch) this.retiredCollected.register(f, id);
    this.stats.retired += batch.length;
    (this.opts.loop ?? defaultLoop).after(RETIRE_WAIT_MS, () => { if (this.retireBatch === id) this.dropRetired(); });
  }
  private hotSince?: number;
  private upgradeMs = 0;
  /** instantiates a built unit and puts its functions (`group`, by slot) in the table; a slot already compiled keeps its original stub */
  private install(group: number[], hot: boolean, cx: Pick<Compiler, "assumptions" | "absent"> & { symbols?: SymbolicSite[] }, imports: Record<string, any>, built: Built, slot: number, clock: Clock): void {
    const s = this.slotAt(slot)!;
    let exports: Record<string, any>;
    try { exports = this.instantiateUnit(cx, imports, built, slot, clock); } catch (e) { throw new Error(`linking ${s.k === "method" ? mid(s.m) : (s as { name: string }).name}: ${(e as Error).message}`); }
    const set = (at: number, name: string) => {
      const sl = this.slotAt(at) as Exclude<Slot, { k: "ensure" }>;
      if (!sl.done) sl.stub = this.table.get(at) as Function;
      sl.done = true;
      this.table.set(at, exports[name]);
    };
    if (s.k === "method" || s.k === "ensure") {
      for (const x of group) { set(x, "m" + x); this.groupOf.set(x, group); (this.slotAt(x) as { hot?: boolean }).hot = hot; if (x < COUNT_SLOTS) this.counts()[x] = 0; }
      if (hot) {
        const names = cx instanceof Compiler ? cx.symbolicImports.keys() : (cx.symbols ?? []).map(([name]) => name);
        const unit = this.hotUnits.publish(group, names, this.table);
        for (const name of unit?.sites ?? []) if (this.symbolicSites.get(name)?.ready) this.hotUnits.resolved(name);
      } else group.forEach(at => this.hotUnits.forget(at));
      if (s.k === "ensure") { s.done = true; this.table.set(slot, exports["m" + slot]); }
    } else set(slot, "m");
  }
  private unitClock(): Clock { return { start: performance.now(), accounted: this.stats.compileMs }; }
  private instantiateUnit(cx: Pick<Compiler, "assumptions" | "absent">, imports: Record<string, any>, built: Built, slot: number | undefined, clock: Clock): Record<string, any> {
    // Imports can compile nested units; charge that work once, to its own unit.
    this.accountCompilation(clock);
    const exports = this.instantiate(built.bytes, imports).exports;
    if (cx instanceof Compiler) for (const [key, sig] of cx.sharedOut) if (!this.sharedHelpers.has(key)) { this.sharedHelpers.set(key, sig); this.sharedFns[key] = exports[key] as Function; }
    this.recordUnit(cx, built.traces, slot);
    return exports;
  }
  private accountCompilation(clock: Clock): void {
    this.stats.compileMs += performance.now() - clock.start - (this.stats.compileMs - clock.accounted);
  }
  private recordUnit(cx: Pick<Compiler, "assumptions" | "absent">, traces: FnTrace[], slot?: number): void {
    for (const t of traces) if (t.m) this.traces.set(t.name, t);
    for (const [decl, name, desc, target, owner] of cx.assumptions) {
      const at = owner ? this.slotOf(owner) : slot;
      if (at === undefined) throw new Error("compiled assumption has no invalidation owner");
      const key = `${decl}.${name}${desc}`;
      let a = this.assumptions.get(key);
      if (!a) this.assumptions.set(key, a = { decl, name, desc, tc: target?.cls ?? "", tk: target?.key ?? "", slots: new Set() });
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
      if (module[0] === "c") { imports[module] = this.link(this.names[+module.slice(1)]).exports; given.add(module); continue; }
      (imports[module] ??= {})[name] = this.link(this.names[+name.slice(0, name.indexOf(":"))]).exports[name];
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
  private unitImports(cx: Compiler): Record<string, any> {
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
  private symbolicSites = new Map<string, { slot: WebAssembly.Global; ready?: boolean }>();
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
      const exports = this.instantiateUnit(cx, imports, built, this.slotOf(pending[0].method), clock);
      this.symbolicStubModules++;
      for (const { name, slot } of pending) {
        this.symbolicSites.set(name, { slot: new WebAssembly.Global({ value: "i32" }, slot) });
        this.symbolicTable.set(slot, exports[name] as Function);
      }
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
          operation = this.instantiateUnit(cx, this.unitImports(cx), built, this.slotOf(method), clock).m as Function;
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
          this.hotUnits.resolved(`${method.cls}:${method.index}:${pc}`);
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
    return this.hostCtx ??= { mem: this.mem, sp: this.sp, bridge: this.bridge, gap: (what) => this.onGap(this.gapId(what)), sched: this.sched, throwable: (cls, msg) => this.makeThrowable(cls, msg), raise: (e) => this.exception(e) };
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
  /** `m` and the small methods it calls directly, up to MAX_GROUP: V8 can inline calls inside a module but not through the table. One that is
   *  compiled already is copied into the unit and used only by the unit's own calls (`copies`). */
  private group(m: MethodInfo, members: MethodInfo[] = [m]): { installed: MethodInfo[]; copies: MethodInfo[] } {
    const out = [...members], installed = [...members], copies: MethodInfo[] = [], ids = new Set(out.map(mid));
    this.plan = new Map();
    if (!m.codeOff || this.intrinsic(m)) return { installed, copies };
    this.noteAllocations(m);
    for (let i = 0; i < out.length && out.length < MAX_GROUP; i++) {
      if (!out[i].codeOff || this.intrinsic(out[i])) continue;
      if (i) this.noteAllocations(out[i]);
      // the callees that have run often, busiest first: code the first tier saw run a few times is not worth compiling into the unit
      const callees: { t: MethodInfo; id: string; ran: number }[] = [];
      for (const t of this.callees(out[i])) {
        const id = mid(t);
        if (ids.has(id) || this.slotAt(this.slotOf(t))?.k !== "method") continue;
        const ran = this.ran(t);
        if (ran >= COPY_MIN) callees.push({ t, id, ran });
      }
      callees.sort((a, b) => b.ran - a.ran);
      for (const { t, id } of callees) {
        if (out.length >= MAX_GROUP) break;
        if (ids.has(id)) continue;
        out.push(t); ids.add(id);
        (this.slotAt(this.slotOf(t)) as { done: boolean }).done ? copies.push(t) : installed.push(t);
      }
    }
    return { installed, copies };
  }
  /** calls and loop iterations counted for `t` so far: methods compiled by the second tier count as busy, the Wasm-written intrinsics always run */
  private ran(t: MethodInfo): number {
    const slot = this.slotOf(t), sl = this.slotAt(slot) as { done: boolean; hot?: boolean };
    // a method that has asked for the second tier has used up a budget, whatever its count since
    if (sl.hot || this.requested.has(slot) || this.opts.intrinsics.has(mid(t))) return HOT_BUDGET;
    return sl.done ? this.count(slot) : 0;
  }
  /** the methods (ids) whose first-tier code ran a loop for 64 chunks in one entry: their second tier keeps loops in chunks, so a long activation of it is not held in the engine's baseline code */
  longLoops = new Set<string>();
  /** classes some compiled code allocates: the ones a virtual call is likely to find */
  allocated = new Set<string>();
  /** per virtual call (declaring class, name, descriptor): the small implementations, among the allocated classes', its unit tests for first */
  plan = new Map<string, MethodInfo[]>();
  groupOf = new Map<number, number[]>();
  /** a method's call sites, and the classes it allocates and refers to */
  private planningSites = new Map<MethodInfo, { calls: PreparedInstruction[]; allocations: string[]; references: string[] }>();
  private planning(m: MethodInfo) {
    let sites = this.planningSites.get(m);
    if (!sites) {
      const seen = new Set<string>(), allocations = new Set<string>(), references = new Set<string>(), calls: PreparedInstruction[] = [];
      for (const ins of decodeInstructions(m.dex.code(m.codeOff).insns)) {
        const name = !ins.name.startsWith("invoke-polymorphic") && instructionClass(m, ins);
        if (name) references.add(name);
        if (ins.op === 0x22) allocations.add(m.dex.typeName(ins.b));
        if (!(ins.op >= 0x6e && ins.op <= 0x72) && !(ins.op >= 0x74 && ins.op <= 0x78)) continue;
        const key = `${ins.op}:${ins.b}`;
        if (!seen.has(key)) { seen.add(key); calls.push(ins); }
      }
      this.planningSites.set(m, sites = { calls, allocations: [...allocations], references: [...references] });
    }
    return sites;
  }
  /** a method's static and direct calls before its first branch (return, throw, goto, switch or if), which every run makes: only that much is decoded */
  private entrySites = new Map<MethodInfo, PreparedInstruction[]>();
  private entryCalls(m: MethodInfo): PreparedInstruction[] {
    let entry = this.entrySites.get(m);
    if (!entry) {
      const insns = m.dex.code(m.codeOff).insns;
      entry = [];
      for (let pc = 0; pc < insns.length;) {
        const op = insns[pc] & 0xff;
        if (!op && insns[pc] >> 8) { pc += insnLen(insns, pc); continue; }
        if (op >= 0x0e && op <= 0x11 || op >= 0x27 && op <= 0x2c || op >= 0x32 && op <= 0x3d) break;
        const ins = decodeInstruction(insns, pc);
        if (op === 0x70 || op === 0x71 || op === 0x76 || op === 0x77) entry.push(ins);
        pc += ins.len;
      }
      this.entrySites.set(m, entry);
    }
    return entry;
  }
  /** calls and loop iterations counted so far for the method in `slot` */
  count(slot: number): number { return slot < COUNT_SLOTS ? this.counts()[slot] : 0; }
  private countView?: Int32Array;
  /** the call and loop counters, a view kept until the memory grows */
  private counts(): Int32Array {
    if (this.countView?.buffer !== this.mem.buffer) this.countView = new Int32Array(this.mem.buffer, COUNT_BASE, COUNT_SLOTS);
    return this.countView;
  }
  /** the platform build's methods that have run here (a method's count restarts once a unit replaces its code): what a zygote has the engine compile before an
   *  app needs them (warm) */
  calledMethods(): string[] {
    const counts = this.counts(), out: string[] = [];
    for (let slot = 0; slot < COUNT_SLOTS; slot++) {
      if (!counts[slot] && !this.groupOf.has(slot)) continue;
      const s = this.slotAt(slot);
      if (s?.k === "method" && this.aot?.seeded(s.m.cls)) out.push(mid(s.m));
    }
    return out;
  }
  /** where the demand and the linked classes stand, for demandSince; then the linked classes' methods with code that have no code yet, how many were compiled ahead, and the call frontier's sizes */
  demandMark(): number[] {
    let uncompiled = 0;
    for (const [name, rt] of this.classes) for (const m of this.prog.get(name)?.methods ?? []) {
      if (!m.codeOff || m.flags & ACC.NATIVE) continue;
      const s = this.peek(rt.slotBase + m.index);
      if ((!s || s.k === "method" && !s.done) && !this.aot?.holds(rt.slotBase + m.index)) uncompiled++;
    }
    // the methods without code that the methods with code call: every target of a call, and only a call's one target
    const frontier = this.markFrontier = new Set(), single = this.markSingle = new Set();
    for (const s of this.slots) {
      if (s?.k !== "method" || !s.done || !s.m.codeOff) continue;
      for (const { t, targets } of this.calls(s.m)) {
        for (const x of targets ?? (t ? [t] : [])) {
          const at = this.classes.get(x.cls);
          const xs = at && this.peek(at.slotBase + x.index);
          if (x.codeOff && !(xs?.k === "method" && xs.done)) { frontier.add(x); if (x === t) single.add(x); }
        }
      }
    }
    return [this.demand.methods.size, this.classes.size, uncompiled, this.stats.ahead, frontier.size, single.size];
  }
  private markFrontier = new Set<MethodInfo>();
  private markSingle = new Set<MethodInfo>();
  /** the methods compiled on demand since `mark`, each with whether its class was linked by then and whether a method with code called it then (any target, the one target) */
  demandSince([methods, classes]: number[]): [string, boolean, boolean, boolean][] {
    const before = new Set<string>();
    for (const name of this.classes.keys()) { if (before.size >= classes) break; before.add(name); }
    return [...this.demand.methods].slice(methods).map((m) => [mid(m), before.has(m.cls), this.markFrontier.has(m), this.markSingle.has(m)]);
  }
  /** Has the engine compile the build's code of methods `ids` before they first run, as a zygote does with what launches use: each is installed and called
   *  while the warm word makes first-tier code trap on entry, before it does anything. Methods whose code is elsewhere are left to their first call. Goes from `ids[from]` until `until`
   *  and returns where it stopped. */
  warm(ids: string[], from = 0, until = Infinity): number {
    const word = new Int32Array(this.mem.buffer, WARM_AT, 1), zero = (k: Kind) => k === "J" ? 0n : k === "L" ? null : 0;
    let n = from;
    word[0] = 1;
    try {
      for (; n < ids.length && performance.now() < until; n++) {
        const id = ids[n];
        const m = methodOf(this.prog, id);
        if (!m?.codeOff || !this.aot?.seeded(m.cls) || this.intrinsic(m)) continue;
        const slot = this.slotOf(m), s = this.slotAt(slot);
        // only first-tier code counts its calls, and with them traps on entry
        if (slot >= COUNT_SLOTS || s?.k !== "method" || s.hot || !this.aot.install(slot) || !s.done) continue;
        const f = this.table.get(slot) as ((...args: unknown[]) => unknown) | null;
        if (!f) continue;
        try { f(...(m.isStatic ? [] : [null]), ...m.params.map((p) => zero(kindOf(p)))); } catch (e) { if (e instanceof WebAssembly.RuntimeError) continue; throw e; }
        throw new Error(`warming ${id} ran it`);
      }
    } finally { word[0] = 0; }
    return n;
  }
  // ---------- compiling ahead of the first call, in idle time
  /** methods that ran, the latest last, then methods compiled ahead: what is compiled ahead are the methods they call */
  private aheadRoots: MethodInfo[] = [];
  /** methods to compile ahead, the next last */
  private aheadQueue: MethodInfo[] = [];
  /** the slots of methods compiled ahead that have not been seen to run: a build is made of what runs */
  private aheadUnran = new Set<number>();
  private noteRun(ms: MethodInfo[]): void {
    if (this.opts.build || this.opts.compileOnly) return;
    this.aheadRoots.push(...ms);
    if (this.aheadRoots.length > AHEAD_ROOTS) this.aheadRoots.splice(0, this.aheadRoots.length - AHEAD_ROOTS / 2);
  }
  /** the methods compiled ahead that have run since joining the World's demand, and their calls are compiled ahead in turn */
  noteAheadRuns(): void {
    for (const at of this.aheadUnran) {
      const s = this.peek(at);
      if (s?.k !== "method" || !s.done) { this.aheadUnran.delete(at); continue; }
      if (!s.hot && !this.requested.has(at) && !(at < COUNT_SLOTS && this.counts()[at])) continue;
      this.aheadUnran.delete(at);
      this.demand.methods.add(s.m);
      this.noteRun([s.m]);
    }
  }
  /** the slot of `t` if it is worth compiling ahead: its class is linked and neither compiled code nor a build's module holds it */
  private aheadSlot(t: MethodInfo): number {
    const rt = this.classes.get(t.cls);
    if (!rt || !t.codeOff || t.flags & ACC.NATIVE || this.intrinsic(t)) return -1;
    const slot = rt.slotBase + t.index, s = this.slotAt(slot);
    return s?.k !== "method" || s.done || s.pending || this.aot?.holds(slot) ? -1 : slot;
  }
  /** Idle time: compiles the first-tier code of the methods that the methods that ran call when the call has one target, then what those call, in units of AHEAD_UNIT,
   *  until `until`, so that an interaction's first calls find their code rather than compile it. Whether any is left. */
  ahead(until: number): boolean {
    this.noteAheadRuns();
    while (performance.now() < until && this.stats.ahead < AHEAD_MAX) {
      const unit: MethodInfo[] = [];
      while (unit.length < AHEAD_UNIT) {
        const t = this.aheadQueue.pop();
        if (t) { if (!unit.includes(t) && this.aheadSlot(t) >= 0) unit.push(t); continue; }
        const root = this.aheadRoots.pop();
        if (!root) break;
        if (root.codeOff) for (const { t } of this.calls(root)) if (t && this.aheadSlot(t) >= 0) this.aheadQueue.push(t);
      }
      if (!unit.length) return false;
      const clock = this.unitClock(), cx = new Compiler(this);
      cx.shareHelpers();
      const built = cx.buildUnit(unit), group = unit.map((m) => this.slotOf(m));
      this.stats.units++; this.stats.methods += unit.length; this.stats.ahead += unit.length;
      this.install(group, false, cx, this.unitImports(cx), built, group[0], clock);
      for (const at of group) this.aheadUnran.add(at);
      // what these call is likely next in turn, after what the methods that ran call
      this.aheadRoots.unshift(...unit);
    }
    return this.stats.ahead < AHEAD_MAX;
  }
  /** `m`'s calls: the method each one reaches when that is known (a static or direct call, or a virtual call with one implementation) and a virtual call's implementations */
  private *calls(m: MethodInfo): Generator<{ t?: MethodInfo; targets?: MethodInfo[]; decl: string; name: string; desc: string }> {
    const dex = m.dex;
    // Cache bytecode references, not eligibility or targets: loader initiation can change both.
    for (const ins of this.planning(m).calls) {
      if (needsSymbolicSite(this, m, ins)) continue;
      const mr = dex.method(ins.b), desc = dex.methodDesc(ins.b), decl = dex.typeName(mr.cls), kind = ins.name.replace("/range", "");
      if (decl[0] === "[" || kind === "invoke-super") continue;
      const targets = kind === "invoke-static" || kind === "invoke-direct" ? undefined : this.cha.targets(decl, mr.name, desc);
      yield { t: targets ? targets.length === 1 ? targets[0] : undefined : this.prog.resolve(decl, mr.name, desc), targets, decl, name: mr.name, desc };
    }
  }
  /** Direct callees followed by guarded implementations, preserving their planning order. */
  private callees(m: MethodInfo): MethodInfo[] {
    const direct: MethodInfo[] = [], guarded: MethodInfo[] = [];
    for (const { t, targets, decl, name, desc } of this.calls(m)) {
      if (t && t !== m && this.inlinable(t) && !direct.includes(t)) direct.push(t);
      if (!targets) continue;
      const key = `${decl}.${name}${desc}`;
      let choices = this.plan.get(key);
      if (!choices) this.plan.set(key, choices = targets.length > 1 ? this.likely(decl, name, desc) : []);
      for (const choice of choices) if (!guarded.includes(choice)) guarded.push(choice);
    }
    return direct.concat(guarded);
  }
  /** the classes `m` allocates join the allocated set before its virtual calls are planned: it is about to run */
  private noteAllocations(m: MethodInfo): void {
    for (const name of this.planning(m).allocations) if (this.prog.get(name)) this.allocated.add(name);
  }
  /** the busiest small implementations, bounded by the number of guards emitted */
  private likely(decl: string, name: string, desc: string): MethodInfo[] {
    const chosen: MethodInfo[] = [], scores: number[] = [], targets = this.implementations(decl, name, desc);
    if (!targets) return chosen;
    for (const t of targets) {
      // Asking for a count would link a class that has not run.
      if (!this.classes.has(t.cls) && !this.aot?.hasLoaded(t.cls)) continue;
      const score = this.ran(t);
      if (score < COPY_MIN || !this.inlinable(t)) continue;
      let at = chosen.length;
      while (at > 0 && scores[at - 1] < score) at--;
      if (at >= MAX_GUARDS) continue;
      for (let i = Math.min(chosen.length, MAX_GUARDS - 1); i > at; i--) { chosen[i] = chosen[i - 1]; scores[i] = scores[i - 1]; }
      chosen[at] = t; scores[at] = score;
    }
    return chosen;
  }
  private implemented = new Map<string, Map<string, { seen: number; targets: Set<MethodInfo> | null }>>();
  private allocatedIndex?: { seen: number; cursor: SetIterator<string>; types: Map<string, string | string[]> };
  /** Index each allocation once across its supertypes, preserving allocation order. */
  private allocatedSubtypes(decl: string): readonly string[] {
    const index = this.allocatedIndex ??= { seen: 0, cursor: this.allocated.values(), types: new Map() };
    // Never exhaust the iterator: later allocations must remain visible.
    while (index.seen < this.allocated.size) {
      const cls = index.cursor.next().value!;
      index.seen++;
      if (cls[0] === "[") continue;
      for (const parent of this.prog.supertypes(cls)) {
        const list = index.types.get(parent);
        if (list === undefined) index.types.set(parent, cls);
        else if (typeof list === "string") index.types.set(parent, [list, cls]);
        else list.push(cls);
      }
    }
    let classes = index.types.get(decl);
    if (typeof classes === "string") index.types.set(decl, classes = [classes]);
    return classes ?? [];
  }
  /** the implementations of a virtual call among the allocated classes, null once there are more than MEGAMORPHIC */
  private implementations(decl: string, name: string, desc: string): Set<MethodInfo> | null {
    const classes = this.allocatedSubtypes(decl);
    let methods = this.implemented.get(decl);
    if (!methods) this.implemented.set(decl, methods = new Map());
    const key = name + desc;
    let memo = methods.get(key);
    if (!memo) methods.set(key, memo = { seen: 0, targets: new Set() });
    if (memo.seen === classes.length || !memo.targets) return memo.targets;
    const declared = this.prog.resolve(decl, name, desc);
    for (let i = memo.seen; i < classes.length; i++) {
      const cls = classes[i];
      const t = declared && !(declared.flags & (ACC.PUBLIC | ACC.PROTECTED)) ? symbolicOverride(this.prog, cls, declared) : this.prog.implFor(cls, name, desc);
      if (t && memo.targets.add(t).size > MEGAMORPHIC) { memo.targets = null; break; }
    }
    memo.seen = classes.length;
    return memo.targets;
  }
  /** whether `t` is worth compiling into its callers' units: a short method, or one the compiler writes itself (the String methods over the js-string builtins) */
  private inlinable(t: MethodInfo): boolean {
    if (this.opts.intrinsics.has(mid(t))) return true;
    return !!t.codeOff && !(t.flags & ACC.NATIVE) && !this.intrinsic(t) && t.dex.code(t.codeOff).insns.length <= SMALL_CALLEE;
  }

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
    for (let b = 0; b < this.blockClass.length; b++) {
      const dex = this.prog.get(this.blockClass[b])?.dex;
      if (dex && this.prog.loaderOfDex(dex) === this.prog.root) for (let i = 0; i < this.methodsIn(b); i++) this.invalidate(this.blockBase[b] + i);
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
    // The graph still changes what later definitions resolve to, in the compile worker too.
    if (!changed.size) { change(); this.opts.compiler?.namespaces(); return; }
    const targets = new Map<Assumption, { target: MethodInfo; declared: MethodInfo }>();
    for (const a of this.assumptions.values()) {
      const target = a.tc ? this.prog.get(a.tc)?.byKey.get(a.tk) : undefined;
      const declared = this.prog.resolve(a.decl, a.name, a.desc);
      if (target && target.key === a.tk && target.desc === a.desc && declared && !declared.isStatic && declared.desc === a.desc) targets.set(a, { target, declared });
    }
    // Inherited dispatch also depends on interfaces that have not themselves been linked.
    const changing = this.prog.resolutionClasses(loader, changed);
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
    const exact = ![...changed].some(name => name.startsWith("[") || name.includes("@"));
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
      hit = !!c && (!!c.sup && mentioned(c.sup) || !c.isInterface && declaredMethods(c).some(([key, flags]) => !(flags & (ACC.STATIC | ACC.PRIVATE)) && !key.startsWith("<init>") && mentions(key)));
      chainMentions.set(name, hit); return hit;
    };
    const dispatch = [...this.classes.keys()].filter(name => depends(name) && (hierarchy(name) || mentioned(name))).map(name => ({ name, methods: this.vslots(name).map(key => {
      return symbolicDispatchFor(this.prog, name, key);
    }) }));
    // Only the classes of the dexes that resolve through the changed loader have their types rewritten.
    const existing = [...this.classes].filter(([name]) => changing.has(name)).map(([name, rt]) => ({ name, rt, sup: this.prog.get(name)!.sup, ifaces: [...this.prog.get(name)!.ifaces], fields: this.prog.get(name)!.fields.map(f => ({ field: f, desc: f.desc })) }));
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
      for (const { field, desc } of old.fields) if (field.isStatic && desc !== field.desc) {
        const oldKey = `${old.rt.id}:s:${field.name}:${desc}`, newKey = `${old.rt.id}:s:${field.name}:${field.desc}`;
        if (oldKey in old.rt.exports && !(newKey in old.rt.exports)) old.rt.exports = { ...old.rt.exports, [newKey]: old.rt.exports[oldKey] };
      }
    }
    this.epoch++;
    this.opts.compiler?.namespaces();
    this.cha = new Cha(this.prog); this.implemented.clear(); this.allocatedIndex = undefined;
    this.fieldReaders.clear();
    this.vslotCache.clear(); this.imtCache.clear();
    // Existing code and app builds used the previous namespace, except a kept build, which was made under this one. Platform code retains its defining boot namespace.
    const refreshed = new Set(names);
    // a slot without state has never been compiled here
    const builtUnder = (slot: number) => { const s = this.peek(slot); return (!s || s.k === "method" && !s.hot && !this.demand.methods.has(s.m)) && !!this.aot?.fromAppBuild(slot); };
    for (let b = 0; b < this.blockClass.length; b++) if (refreshed.has(this.blockClass[b])) {
      for (let i = 0; i < this.methodsIn(b); i++) if (!kept || !builtUnder(this.blockBase[b] + i)) this.invalidate(this.blockBase[b] + i);
    }
    if (names.some(name => this.prog.loaderOfDex(this.prog.get(name)!.dex!) === this.prog.root) && !kept) this.aot?.unbindApp();
    this.noteLate([...this.prog.own()].map(c => c.name));
    const lateBy = this.lateBy(new Set([...this.assumptions.values()].map(a => a.decl)));
    const changedSubtypes = new Map<string, string[]>(), hierarchySubtypes = new Map<string, string[]>();
    for (const [key, a] of this.assumptions) {
      for (const slot of a.slots) {
        const state = this.peek(slot);
        // Unmaterialized AOT slots and private helper owners can still hold live code.
        if (!this.helperInvalidations.has(slot) && state && (state.k === "ensure" || !state.done)) a.slots.delete(slot);
      }
      if (!a.slots.size) { this.assumptions.delete(key); continue; }
      const saved = targets.get(a), declared = this.prog.resolve(a.decl, a.name, a.desc);
      const sameTarget = saved && saved.target === this.prog.get(a.tc)?.byKey.get(a.tk) && saved.target.key === a.tk && saved.target.desc === a.desc;
      const samePrototype = declared && declared === saved?.declared && !declared.isStatic && declared.desc === a.desc;
      const narrow = !mentions(a.desc), cache = narrow ? hierarchySubtypes : changedSubtypes;
      let by = cache.get(a.decl);
      if (!by) cache.set(a.decl, by = (lateBy.get(a.decl) ?? []).filter(narrow ? hierarchy : depends));
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
    this.loaded([jc.name]);
  }
  private loaded(added: string[]): void {
    this.implemented.clear(); this.allocatedIndex = undefined;
    this.cha.index(added);
    // a decision about the implementations of decl.name+desc changes only when a concrete subtype of decl is added that has one
    this.noteLate(added);
    const now = this.lateBy(new Set([...this.assumptions.values()].map(a => a.decl)), added);
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
  /** the classes added since compiled code was made */
  private lateKnown = new Set<string>();
  noteLate(added: string[]): void { for (const n of added) if (this.prog.get(n)) this.lateKnown.add(n); }
  /** the concrete classes among `names` (the late ones by default) by each of their supertypes in `decls`, themselves included. Only the
   *  supertypes an assumption names are asked about, so no index of every late class by every supertype is kept: an app's classes number
   *  in the hundreds of thousands, each with dozens of supertypes. */
  private lateBy(decls: ReadonlySet<string>, names: Iterable<string> = this.lateKnown): Map<string, string[]> {
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
  /** the concrete late classes that are subtypes of `decl` */
  lateSubtypes(decl: string): string[] { return this.lateBy(new Set([decl])).get(decl) ?? []; }
  /** whether the implementation code relied on for decl.name+desc (`tc`'s method `tk`, none if empty) stands once the concrete classes `by`, all subtypes of decl, exist */
  holds(a: { name: string; desc: string; tc: string; tk: string }, by: string[]): boolean {
    const target = a.tc ? this.prog.get(a.tc)?.byKey.get(a.tk) : undefined;
    for (const n of by) { const m = this.prog.dispatchFor(n, a.name, a.desc); if (m && (failed(m) || m !== target)) return false; }
    return true;
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  invalidate(slot: number): void {
    this.hotUnits.forget(slot);
    const helper = this.helperInvalidations.get(slot);
    if (helper) { helper(); this.stats.invalidated++; return; }
    for (const x of this.groupOf.get(slot) ?? [slot]) {
      const s = this.slotAt(x);
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
    const m = this.entryMethod(cls, name, desc), slot = this.slotOf(m);
    return (...args) => this.synchronous(() => {
      this.refreshHotUnits();
      // an exception leaves the frames it unwound counted
      const depth = this.rt.depth.value;
      try {
        if (m.isStatic && this.needsInit(m.cls)) (this.table.get(this.ensureSlot(m.cls)) as Function)();
        return this.hostString((this.table.get(slot) as Function)(...args.map((a) => this.javaValue(a))));
      } catch (e) { throw this.boundary(e); } finally { this.rt.depth.value = depth; }
    });
  }
  /** `entry` for a call that may block: it runs on a stack of its own, as a new strand of the main thread, and answers a Promise */
  entryAsync(cls: string, name: string, desc: string): (...args: unknown[]) => Promise<unknown> {
    const m = this.entryMethod(cls, name, desc), slot = this.slotOf(m);
    return async (...args) => {
      const s = this.sched.strand();
      try {
        if (m.isStatic && this.needsInit(m.cls)) await this.freshStack(() => s.call(this.table.get(this.ensureSlot(m.cls)) as Function));
        return this.hostString(await this.freshStack(() => s.call(this.table.get(slot) as Function, ...args.map((a) => this.javaValue(a)))));
      } catch (e) { throw this.boundary(e); } finally { s.end(); }
    };
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
    this.refreshHotUnits();
    const prior = this.synchronousEntries; this.synchronousEntries = 0;
    try { return run(); } finally { this.synchronousEntries = prior; }
  }
  private hostFns = new Map<string, Function>();
  // Private helper owners do not consume method-table numbering shared with compile workers.
  private helperSlots: (Function | undefined)[] = [];
  private helperInvalidations = new Map<number, () => void>();
  private rawHelper(raw: Function): () => Function { return () => raw; }
  private helperGetter(slot: number, rebuild: (slot: number) => Function): () => Function {
    let dirty = false;
    this.helperInvalidations.set(slot, () => { dirty = true; });
    return () => {
      if (dirty) { this.helperSlots[-slot - 1] = rebuild(slot); dirty = false; }
      return this.helperSlots[-slot - 1]!;
    };
  }
  private helperUnit(cx: Compiler, imports: Record<string, any>, built: { bytes: Uint8Array; traces: FnTrace[] }, clock: Clock, rebuild: (slot: number) => Function, slot?: number): { get: () => Function; raw?: Function } {
    const dependent = cx.assumptions.some(a => !a[4]) || cx.absent.some(a => !a[1]);
    if (slot !== undefined || !dependent) {
      const raw = this.instantiateUnit(cx, imports, built, slot, clock).m as Function;
      return { get: this.rawHelper(raw), raw };
    }
    slot = -this.helperSlots.push(undefined);
    this.helperSlots[-slot - 1] = this.instantiateUnit(cx, imports, built, slot, clock).m as Function;
    return { get: this.helperGetter(slot, rebuild) };
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
