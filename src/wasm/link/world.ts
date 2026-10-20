// The linker: classes and methods become Wasm modules when first needed, all sharing one funcref table.
//
//  - A class module (one per class, built the first time any code names the class) defines the class's vtable, init flag and static
//    fields as exported globals; its methods' contiguous block of table slots starts with the lazy-link stub of each one's signature.
//  - Every call between modules is `call_indirect slot` after storing the slot in rt.callee, so a compiled method needs no relinking. A stub
//    calls the runtime's linker (runtime.ts), which compiles that method into a unit module (Compiler.buildUnit) and replaces the slot's entry, then calls through the slot.
//  - Vtables hold table slots. CHA decisions are recorded per slot and undone (the stub is put back) when a dex added later falsifies them.
import { symbolicInstruction } from "../compiler/sites.ts";
import { type Program, declaredMethod, methodCount, methodKinds, type Loader, type JClass, type MethodInfo, type FieldInfo } from "../compiler/program.ts";
import { Cha } from "../compiler/cha.ts";
import { intrinsicFor, type FnTrace, type Intrinsic } from "../compiler/j2w.ts";
import type { CompileService, GuestMemory, HostBridge, HostNet, HostSpec, NativeBinder } from "./hostapi.ts";
import { Sched, defaultLoop, type HostLoop, type Strand } from "./sched.ts";
import { rtfns, type Synth } from "../compiler/rtfns.ts";
import { replayInfo, type InfoRecord } from "./classes.ts";
import { HostClasses } from "./hostclass.ts";
import type { ProxyDefinition } from "./proxy.ts";
import { initiatedInstruction, resolveClass } from "./resolution.ts";
import { hasSignatureConstraints } from "./signatures.ts";
import { SLOT, FIRST_FREE_SLOT, SCRATCH_BASE, INIT_DONE, isStackOverflow } from "../compiler/exc.ts";
import type { PreparedInstruction } from "../../jvm/prepared.ts";
import { mid } from "../compiler/ids.ts";
import type { DexFile } from "../../jvm/dex.ts";
import { compileModule } from "./module.ts";
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
import { Units } from "./units.ts";
import { startRuntime, type Runtime } from "./runtime.ts";
import { hostImports, type HostImports } from "./hostimports.ts";
import { Assumptions } from "./assumptions.ts";
import { Namespaces } from "./namespaces.ts";

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
/** the statics' import module `mod` of a linked class, and who laid it out: this World's class modules, or the platform build's or the app build's data modules */
export interface ClassRt { name: string; id: number; mod: string; from: "own" | "platform" | "app"; slotBase: number; nMethods: number; exports: WebAssembly.Exports }
/** when a unit's compile began, and the compile time accounted by then (Units.account) */
export type Clock = { start: number; accounted: number };
export type Built = { bytes: Uint8Array | WebAssembly.Module; traces: FnTrace[] };

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
  readonly units = new Units(this);
  readonly assumptions = new Assumptions(this);
  readonly namespaces = new Namespaces(this);
  classes = new Map<string, ClassRt>();
  /** what this World built because no saved code had it: the methods compiled at their first call and the classes whose modules it made, in order (an app build made later includes them) */
  readonly demand = { methods: new Set<MethodInfo>(), classes: [] as string[], infos: [] as InfoRecord[] };
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
  host!: HostImports;
  rt!: Runtime;
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
    this.rt = startRuntime(this);
    this.sched = new Sched(this, this.rt, opts.loop ?? defaultLoop);
    this.host = hostImports(this);
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
  /** a value a host function answers, as a Java value: a JS string becomes a String */
  javaValue(v: unknown): unknown { return typeof v === "string" ? this.javaString(v) : v; }
  /** a String a host function is given, as the JS string it works with */
  hostString(v: unknown): unknown {
    return typeof v === "object" && v !== null && this.classNameOf(v) === "java/lang/String" ? this.bridge.toHost(v) : v;
  }
  private fromJs?: (s: string) => unknown;
  /** the Java String of a JS string (a JS string itself when Strings are JS strings) */
  javaString(s: string): unknown {
    return (this.fromJs ??= this.helpers.hostFn("str:from", ["L"], "L", (cx, c) => { c.lget(0).externConvertAny(); cx.str.fromHost(c); }))(s);
  }
  /** whether `ins` must link at run time: `m`'s loader links by name and the class the instruction names has no ready definition it initiated */
  needsSymbolicSite(m: MethodInfo, ins: PreparedInstruction): boolean {
    return !this.prog.linksStatically(this.prog.loaderOf(m.cls)) && symbolicInstruction(m, ins) && !initiatedInstruction(this, m, ins);
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
  ensureSynth(name: string): void { if (!this.dispatch.ensureNamed(name)) this.synthSlot(name, rtfns.get(name)!); }

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
  rtImports() { const { tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, callee, link } = this.rt; return { table: this.table, nm: this.nm, tag, alloc, hash, ctab, unsafeSlots, sid, thr, depth, iw, wait, callee, link, mem: this.mem, sp: this.sp, gmem: this.opts.guest?.memory, gflags: this.opts.guest?.flags }; }

  /** the class module of `name`, built on first use */
  link(name: string): ClassRt {
    this.touching?.add(name);
    let rt = this.classes.get(name);
    if (rt) return rt;
    const late = this.cha.admit(name);
    if (late) this.assumptions.joined(late);
    const aot = this.aot?.linkClass(name);
    if (aot) { this.classes.set(name, aot); this.classModules.repair(name); return aot; }
    const t0 = performance.now();
    const jc = this.prog.get(name), id = this.idOf(name), methods = jc?.methods ?? [];
    let slotBase = this.aot?.reservedBase(name) ?? this.slots.preassigned.get(name);
    slotBase ??= this.slots.numberBlock(name, methods.length + 1);
    if (!this.instantiates) {
      this.classes.set(name, rt = { name, id, ...this.opts.build ? { mod: this.aot!.extraMod, from: "platform" as const } : { mod: "c" + id, from: "own" as const }, slotBase, nMethods: methods.length, exports: {} });
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
  /** the methods (ids) whose first-tier code ran a loop for 64 chunks in one entry: their second tier keeps loops in chunks, so a long activation of it is not held in the engine's baseline code */
  longLoops = new Set<string>();
  /** classes some compiled code allocates: the ones a virtual call is likely to find */
  allocated = new Set<string>();
  // ---------- open world
  resolveClass(loader: Loader, name: string, owner: Strand): string | Promise<string> {
    return resolveClass(this, loader, name, owner);
  }
  /** load more dexes. A CHA decision that one of their classes falsifies is undone: its callers go back to lazy-link stubs, so the next call
   *  compiles against the new hierarchy. Frames already executing keep the old code. */
  addDexes(dexes: DexFile[], loader: Loader = this.prog.root): string[] {
    const added = this.prog.add(dexes, loader);
    this.epoch++;
    this.opts.compiler?.added(dexes, loader);
    if (loader === this.prog.root || loader === this.prog.boot) this.assumptions.joined(this.cha.index(added));
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
  /** whether the guest memory is shared, which a module that imports it must declare */
  get guestShared(): boolean { return !!this.opts.guest && !(this.opts.guest.memory.buffer instanceof ArrayBuffer); }
  /** makes the class a registered spec implements in the host a Java class, now or once its superclass is defined (hostclass.ts) */
  addHostClass(spec: HostSpec): void { this.hosts.add(spec); this.opts.compiler?.retire(`host class ${spec.name} was added`); }
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
    } else if (!this.settlingHosts) this.opts.compiler?.retire(`class ${jc.name} was added without a dex`);
    this.assumptions.joined(this.cha.index([jc.name]));
    this.loaded([jc.name]);
  }
  private loaded(added: string[]): void {
    this.planner.forgetImplementations();
    this.assumptions.loaded(added);
    this.settlingHosts = true;
    try { this.hosts.loaded(); } finally { this.settlingHosts = false; }
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
    return (...args) => this.sched.synchronous(() => {
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
  /** throws a new Java throwable of class `cls` with `msg`: the way a native raises one */
  raise(cls: string, msg: string | null): never { throw this.exception(this.helpers.makeThrowable(cls, msg)); }
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
}
