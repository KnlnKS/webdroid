// Class registry, linking, initialization, native registration, and the `R` helper
// surface that compiled code calls. See abi.ts for the value model.
//
// Lifecycle: link (ctor shell + fields + types) → init (compile methods, run <clinit>, which
// may suspend). Instances only exist after init, so prototype methods are always present
// when virtual dispatch happens.

import { yieldToLoop } from "./yield";
import { currentStrand, enterStrand, inStrand, ownStrand, suspendWith, watchStrand, yieldAs } from "./suspend";
import { decodeString } from "./charset";
import { DexFile, NO_INDEX, type ClassDef, type EncVal, type EncodedMethod } from "./dex";
import { mangleField, mangleMethod, directName, mangleStaticField, descToName, defaultVal, defaultValue, charsToString, dotName, demangle, primElem, splitSig, hash36 } from "./abi";
import { compileClass, compileLazyMethod, installLazy, methodKey, type LazyMethod } from "./compiler";
import type { CompiledCtor, ResumeBody } from "./tiering";
import { DexLink, instanceFieldOf, findStaticOwner } from "./link";
import { insnLen } from "./opcodes";
import { gapsOf, recordGaps, markPlatformDex, type Gap } from "./codecache";
import { isBytecode, isStageD } from "./provenance";
import { perf } from "../perf";
import { jvmCoverage } from "./coverage";
import { Monitors, type Monitor } from "./monitor";

export const ACC = { PRIVATE: 0x2, STATIC: 0x8, NATIVE: 0x100, INTERFACE: 0x200, ABSTRACT: 0x400 } as const;
// DEX type IDs cap distinct class definitions at 65,535 per file.
const CLASS_INDEX_BASE = 0x10000;

/** Root of the unified JS/Java object hierarchy (java.lang.Object). */
export class JObj {
  declare static $i: ClassInfo;
}
// a Java object inspects as its class and message, not its reachable heap (debuggers, test diffs)
Object.defineProperty(JObj.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: JObj & { msg?: unknown }) { return `${(this.constructor as typeof JObj).$i?.name ?? "?"}${this.msg !== undefined ? ": " + String(this.msg) : ""}`; },
});

export interface NativeSpec {
  name: string;
  sup?: string;
  ifaces?: string[];
  ctor: new (...args: any[]) => object;
  /** "name(Ldesc;)V" or "static name(...)..." or "<init>(...)V" → impl fn (this = receiver) or alias to prototype prop */
  methods?: Record<string, ((...a: never[]) => unknown) | string>;
  statics?: Record<string, unknown>;
  serialization?: { uid: bigint; fields: { name: string; desc: string; prop: string }[] };
  /** java-visible public instance fields: java name → JS property name on the TS class */
  fields?: Record<string, string> | string[];
  /** run once at init — for expensive static setup */
  clinit?: () => void | Promise<void>;
  /** the platform class's `<clinit>` runs at init, so its statics are the platform's */
  platformClinit?: boolean;
  /** the class's own type-variable names ("E", "K,V"). A bytecode class carries these in its
   *  signature annotation; a native one declares them here, and each interface it implements is
   *  reported parameterized with as many of them as that interface declares — which is how a
   *  serializer walking List<Foo> up to Collection<E> finds Foo. */
  typeVars?: string;
  /** Static native entries receiving the calling runtime as a final host-only argument. */
  callerSensitive?: string[];
}

/** A native written as a generator yields each Java result, value or Promise (Runtime.drive). */
export type Gen<T = any> = Generator<unknown, T, any>;
/** the value of `v` once it settles, typed: `yield* awaited(x)` where `yield x` is any */
export function* awaited<T>(v: T | Promise<T>): Gen<T> { return yield v; }
/** makes a method's TS body from its AOSP body; `C` is the class, not yet holding instances */
export type Intrinsic = (base: (this: any, ...args: any[]) => any, C?: any) => (this: any, ...args: any[]) => any;

/** A class constructor holds the class's statics and static methods. V8 turns one into a dictionary
 *  as <clinit> first stores to them, after which `new C()` and static loads take a slow path (4x for
 *  BigInteger's constructor). An object made a prototype, as every superclass already is, gets
 *  fast properties back. */
function fastStatics(C: object) {
  function Holder() {}
  Holder.prototype = C;
  return new (Holder as unknown as new () => object)();
}

const placeholderMethods = new WeakSet<Function>();

export function stubs(value: unknown, ...sigs: string[]): Record<string, () => unknown> {
  const fn = () => value;
  placeholderMethods.add(fn);
  return Object.fromEntries(sigs.map((s) => [s, fn]));
}
export const noops = (...sigs: string[]) => stubs(undefined, ...sigs);
export const isPlaceholderMethod = (value: unknown): boolean =>
  typeof value === "function" && placeholderMethods.has(value);
type Accessor = (this: any, v?: unknown) => unknown;
const accessors = (t: Record<string, string>, make: (f: string) => Accessor) => Object.fromEntries(Object.entries(t).map(([s, f]) => [s, make(f)]));
export const fieldGetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any) { return this[f]; });
export const fieldSetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any, v?: unknown) { this[f] = v; });

/** a shared table less the entries a class does not declare */
export function without(methods: NativeSpec["methods"], ...keys: string[][]): NonNullable<NativeSpec["methods"]> {
  const out = { ...methods };
  for (const key of keys.flat()) delete out[key];
  return out;
}

export class ClassInfo {
  staticFieldTable = new Map<string, string>();
  ctor: any;
  superInfo: ClassInfo | null = null;
  interfaces: ClassInfo[] = [];
  types = new Set<string>();          // all names this is assignable to
  state = 0;                          // 0 linked, 1 initing, 2 inited, 3 erroneous (<clinit> failed)
  initError: unknown = null;          // what the failed <clinit> threw
  initP: Promise<void> | null = null; // in-flight clinit (state 1): cross-chain waiters await it
  assumeReentrant = false;            // a wait on this clinit timed out once: stop waiting (same-chain cycle)
  initThread: unknown = null;         // thread and call chain running the in-flight clinit
  initStrand = 0;                     // (JLS recursive-request check)
  stub = false;                       // auto-stubbed unknown class (Class.forName must throw CNFE)
  waitingOn: ClassInfo | null = null; // class this one's clinit currently awaits (cycle detection)
  fieldTable = new Map<string, string>(); // own instance fields: name → mangled
  ownMethods: string[] = [];          // mangled prototype methods declared here
  dex?: DexFile; def?: ClassDef;
  native = false;
  flags = 0;
  jclass: any = null;                 // java.lang.Class instance (lazy, made by jlang)
  compiled = false;
  /** method bodies not yet generated (see compiler installLazy); undefined when eager */
  lazy?: LazyMethod[];
  defaultsCopied = false;         // interface default methods already copied down
  constructor(public name: string, public owner?: Runtime) {}
  get isInterface(): boolean { return (this.flags & ACC.INTERFACE) !== 0; }
  assignableTo(target: ClassInfo): boolean {
    if (!this.types.has(target.name)) return false;
    if (!this.owner?.parent && !target.owner?.parent) return true;
    return this === target || !!this.superInfo?.assignableTo(target) || this.interfaces.some((i) => i.assignableTo(target));
  }
}

/** the app heap's limit, as Runtime.maxMemory reports it */
export const HEAP_LIMIT = 512 * 1024 * 1024;
/** development and test builds make a read of a field a native class lacks throw, when it happens */
const STRICT_FIELDS = process.env.NODE_ENV !== "production";
/** how long a <clinit>'s chain may go without running before a same-thread wait on it is presumed a cycle */
const CLINIT_WAIT_MS = 60;

export class Runtime {
  classes = new Map<string, ClassInfo>();
  natives = new Map<string, NativeSpec>();
  dexes: DexFile[] = [];
  dexIndex = new Map<string, number>();
  cv(method: string): void { jvmCoverage.hit(method); }
  private refCache = new Map<string, Map<string, string>>();
  /** every method the loaded dexes reference on class `cls`, name+desc → desc: the surface a
   *  framework interface has as far as this app is concerned, which is what a proxy over it or a
   *  JNI method id on it can be checked against when no bytecode declares the interface */
  methodRefs(cls: string): Map<string, string> {
    let m = this.refCache.get(cls);
    if (m) return m;
    this.refCache.set(cls, (m = new Map()));
    const descriptor = cls.startsWith("[") ? cls : `L${cls};`;
    for (const dex of this.dexes) for (const i of dex.methodsOf(descriptor)) {
      const r = dex.method(i);
      const d = dex.methodDesc(i);
      m.set(r.name + d, d);
    }
    return m;
  }
  links = new Map<DexFile, DexLink>();
  missing = new Set<string>();
  /** the booted apk's entries: what ClassLoader.getResourceAsStream and ServiceLoader read */
  classpath: Record<string, Uint8Array> = {};
  classpathSource: { has(name: string): boolean; entry(name: string): Promise<Uint8Array | null>; names(): string[] } | null = null;
  /** the boot class path's own entries by name, with the jar holding each: the boot class
   *  loader answers them ahead of the apk */
  bootResources = new Map<string, { jar: string; read(): Uint8Array }>();
  hasClasspath(name: string): boolean { return this.bootResources.has(name) || Object.hasOwn(this.classpath, name) || !!this.classpathSource?.has(name); }
  classpathNames(): string[] { return [...Object.keys(this.classpath), ...this.classpathSource?.names() ?? []]; }
  readClasspath(name: string): Uint8Array | null | Promise<Uint8Array | null> {
    const boot = this.bootResources.get(name);
    if (boot) return boot.read();
    return Object.hasOwn(this.classpath, name) ? this.classpath[name] : this.classpathSource?.entry(name) ?? null;
  }
  classpathLocations = new Map<string, string>();
  /** set by jlang: make core exceptions without going through class init */
  mkThrowable: (cls: string, msg: string | null) => any = (cls, msg) => {
    const e = new Error(`${cls}: ${msg}`);
    (e as any).$javaClass = cls;
    return e;
  };
  /** report listeners: the reports reach the console either way */
  onMissing: (what: string) => void = () => {};
  onNativeRequired: (lib: string, abi: string) => void = () => {};
  onUncaught: (throwable: unknown) => void = () => {};
  /** current-thread hooks (set by jlang): a resumed activation pins its thread (st) and releases it
   *  when it finishes or suspends again (su), so a parked worker never leaves its identity behind
   *  for what the event loop runs next. One running from its caller's call leaves the thread to
   *  that caller, which goes on as its own thread whether or not the callee suspended. */
  th: () => unknown = () => null;
  st: (t: unknown) => void = () => {};
  su: (t: unknown) => void = () => {};
  monitors = new Monitors((name) => this.mkThrowable("java/lang/" + name, null));
  /** monitor-enter and monitor-exit, given the monitor the compiled site loaded from the object: a
   *  load shared by every lock, in Monitors, was megamorphic and cost about 10 ns a synchronized call */
  me(obj: object | string | null | 0, m?: Monitor) {
    const thread = this.th();
    if (m !== undefined && (m.depth === 0 || m.owner === thread)) { m.owner = thread; m.depth++; return; }
    return this.monitors.enter(obj, thread);
  }
  mx(obj: object | string | null | 0, m?: Monitor) {
    const thread = this.th();
    if (m !== undefined && m.owner === thread && (m.depth > 1 || m.entrants.length === 0)) {
      if (--m.depth === 0) m.owner = null;
      return;
    }
    this.monitors.exit(obj, thread);
  }
  /**
   * Run a native written as a generator whose `yield` takes a Java result that may be a Promise:
   * it stays synchronous until one is, and only then returns a Promise. Like a compiled frame, a
   * resumed native runs on the thread that entered it and releases that thread when it finishes
   * or suspends again.
   */
  drive<T>(g: Gen<T>): T | Promise<T> { return this.driveStep(g, undefined, false, this.th(), false); }
  private driveStep<T>(g: Gen<T>, input: unknown, threw: boolean, thread: unknown, resumed: boolean): T | Promise<T> {
    for (;;) {
      let step: IteratorResult<unknown, T>;
      try { step = threw ? g.throw(input) : g.next(input); }
      catch (e) { if (resumed) this.su(thread); throw e; }
      if (step.done) { if (resumed) this.su(thread); return step.value; }
      const value = step.value;
      if (value instanceof Promise) {
        if (resumed) this.su(thread);
        return suspendWith(value, (v, threw) => { this.st(thread); return this.driveStep(g, v, threw, thread, true); }) as Promise<T>;
      }
      input = value; threw = false;
    }
  }
  /**
   * A compiled frame whose callee suspended: once `pending` settles, continue the saved frame in
   * the method's resumable body, at resume point `r` (or at `next` when 0).
   */
  /** a hot frame suspending at site `r` (0: a fuel yield, waiting on `fu`), with registers `v` */
  dfr(resume: () => ResumeBody, self: unknown, r: number, next: number, th: unknown, t: unknown, u: unknown, ex: unknown,
    fu: Promise<unknown>, ...v: unknown[]): Promise<unknown> {
    const pending = (r ? u instanceof Promise ? u : t : fu) as Promise<unknown>;
    const F = { v, next, r, $th: th, $s: 1, $t: t, $u: u, $ex: ex, val: undefined as unknown, e: false, x: undefined as unknown };
    return suspendWith(pending, (value, threw) => {
      if (threw) { F.e = true; F.x = value; } else F.val = value;
      return resume().call(self, F);
    });
  }
  fuel = 4096;
  /** the classes whose throwables skip their stack capture while a call their handlers discard
   *  runs (discard.ts); one object, which forked realms share */
  quiet = { types: null as string | null };
  private clinitDepth = 0;

  hotSourceBytes = 0;
  parent: Runtime | null = null;
  platformClasses = new Set<string>();
  platformParent = false;
  classLoader: unknown = null;
  // Share host services and thread hooks; loader definitions and compiled call sites stay private.
  fork(): Runtime {
    return Object.assign(Object.create(this) as Runtime, {
      parent: this, classes: new Map(), dexes: [], dexIndex: new Map(), links: new Map(), refCache: new Map(), jni: new Map(),
      classpath: {}, classpathLocations: new Map(),
    });
  }

  loadDex(dex: DexFile, platform = false) {
    if (dex.classDefCount >= CLASS_INDEX_BASE) throw new Error(`${dex.name}: too many class definitions`);
    this.refCache.clear();
    const dexIndex = this.dexes.length;
    this.dexes.push(dex);
    if (platform) markPlatformDex(dex.id);
    for (let i = 0; i < dex.classDefCount; i++) {
      const name = descToName(dex.type(dex.classDef2Type(i)));
      if (this.dexIndex.has(name)) continue;
      this.dexIndex.set(name, dexIndex * CLASS_INDEX_BASE + i);
      if (!platform) continue;
      this.platformClasses.add(name);
      // a class linked before the platform arrived: a stub now has a definition, and a native
      // spec now has platform methods to fall through to
      const linked = this.classes.get(name);
      if (linked?.stub) this.classes.delete(name);
      else if (linked?.native && linked.compiled) this.fallThrough(linked);
    }
  }

  dexAtClassLocation(location: number): DexFile { return this.dexes[Math.floor(location / CLASS_INDEX_BASE)]; }
  /** the first dex definition of `name`, whether or not a native spec answers for it */
  classDefOf(name: string): { dex: DexFile; def: ClassDef } | null {
    const loc = this.dexIndex.get(name);
    if (loc === undefined) return null;
    const dex = this.dexAtClassLocation(loc);
    return { dex, def: dex.classDef(loc & (CLASS_INDEX_BASE - 1)) };
  }

  private ifaceNames: Set<string> | null = null;
  /** Which registered natives are interfaces: an `ifaces` entry names one by definition, and an
   *  interface never declares a superclass. Class.isInterface is what a serializer walking a
   *  generic supertype tests before it looks at the implemented interfaces at all. */
  private nativeIfaces(): Set<string> {
    if (this.ifaceNames) return this.ifaceNames;
    const named = new Set<string>();
    for (const spec of this.natives.values()) for (const i of spec.ifaces ?? []) named.add(i);
    this.ifaceNames = new Set([...named].filter((n) => !this.natives.get(n)?.sup));
    return this.ifaceNames;
  }

  register(spec: NativeSpec) {
    if (isBytecode(spec.name)) {   // provenance says AOSP's own bytecode answers for this
      if (isStageD(spec.name)) console.warn("[webdroid] native spec Stage D always withholds:", spec.name);
      return;
    }
    if (this.classes.has(spec.name)) console.warn("[webdroid] native registered after link:", spec.name);
    this.natives.set(spec.name, spec);
    this.ifaceNames = null;
  }
  /** §4.7 intrinsics: per bytecode class and mangled method, what makes a TS body over the class's
   *  own fields from the AOSP body it stands for (which it calls for cases it does not cover) */
  intrinsics = new Map<string, Map<string, Intrinsic>>();
  intrinsic(cls: string, table: Record<string, Intrinsic>) {
    const methods = this.intrinsics.get(cls) ?? new Map<string, Intrinsic>();
    for (const [sig, make] of Object.entries(table)) methods.set(mangleMethod(...splitSig(sig.replace(/^static /, ""))), make);
    this.intrinsics.set(cls, methods);
  }
  markers(...names: string[]) { for (const name of names) this.register({ name, ctor: class extends JObj {} }); }
  /** an instance of `cls`, its constructor not run: the class linked and its methods defined */
  make(cls: string): any {
    const info = this.link(cls);
    this.ensureCompiled(info);
    return new info.ctor();
  }
  /** Link every native spec, yielding to the event loop every `sliceMs` when one is given: a
   *  process realm's boot shares the page's main thread with the presented app. */
  linkNatives(onError?: (name: string, e: unknown) => void): void;
  linkNatives(onError: ((name: string, e: unknown) => void) | undefined, sliceMs: number): Promise<void>;
  linkNatives(onError?: (name: string, e: unknown) => void, sliceMs?: number): void | Promise<void> {
    const names = [...this.natives.keys()];
    const link = (from: number, until: number): number => {
      let i = from;
      for (; i < names.length && performance.now() < until; i++) { try { this.link(names[i]); } catch (e) { onError?.(names[i], e); } }
      return i;
    };
    if (sliceMs === undefined) { link(0, Infinity); return; }
    return (async () => { for (let i = 0; i < names.length; await yieldToLoop()) i = link(i, performance.now() + sliceMs); })();
  }

  /** what a link table depends on: the shape of every native spec a platform class backs, and the
   *  dex indexed so far, which the zygote reads before an app's dex arrives */
  linkFingerprint(): string {
    let text = "";
    for (const name of [...this.natives.keys()].filter((n) => this.dexIndex.has(n)).sort()) {
      const spec = this.natives.get(name)!;
      text += `${name}<${spec.sup ?? ""}|${spec.ifaces ?? ""}|${!!spec.platformClinit}|${Object.keys(spec.methods ?? {})};`;
    }
    for (const d of this.dexes) text += d.id;
    return hash36(text);
  }

  dexLink(dex: DexFile): DexLink {
    let link = this.links.get(dex);
    if (!link) this.links.set(dex, link = new DexLink(this, dex));
    return link;
  }

  /** the property an instance field of `cls` (or a superclass) lives in, bytecode or spec */
  fieldProp(cls: string, name: string): string | undefined { return instanceFieldOf(this.link(cls), name); }

  /** compile-time: mangled property name for an instance field ref */
  resolveInstanceField(dex: DexFile, fieldIdx: number): string {
    const fr = dex.field(fieldIdx);
    const clsName = descToName(dex.type(fr.cls));
    try {
      const info = this.link(clsName), prop = instanceFieldOf(info, fr.name);
      if (prop) return prop;
      const absent = mangleField(clsName, fr.name);
      this.absentField(info, info.ctor?.prototype, fr.name, absent);
      return absent;
    } catch { /* class missing: link reported it */ }
    return mangleField(clsName, fr.name);
  }

  /** compile-time: static field access site info */
  resolveStaticField(dex: DexFile, fieldIdx: number): { prop: string; typeIdx: number } {
    const fr = dex.field(fieldIdx), prop = mangleStaticField(fr.name);
    try {
      const start = this.link(descToName(dex.type(fr.cls)));
      const field = findStaticOwner(start, fr.name, dex.type(fr.type));
      if (field) return { prop: field.prop, typeIdx: field.info === start ? fr.cls : -1 };
      // a native class declares every static it has (a <clinit> hook may still be adding some)
      if (start.state === 2) this.absentField(start, start.ctor, fr.name, prop);
    } catch { /* class missing */ }
    return { prop, typeIdx: fr.cls }; // fails at runtime when reached, correct laziness
  }

  /** A field a native class lacks. Compiling is not running (profiles compile ahead), so outside
   *  production the report and a NoSuchFieldError wait for the first read, and a write makes it
   *  an ordinary property; production reports it now and reads undefined. */
  private absentField(info: ClassInfo, holder: Record<string, unknown> | undefined, name: string, prop: string) {
    if (!info.native || info.stub || !holder) return;
    const what = `field ${info.name}.${name}`;
    if (!STRICT_FIELDS) return this.noteMissing(what);
    if (prop in holder) return;
    const R = this;
    Object.defineProperty(holder, prop, {
      configurable: true,
      get() { R.noteMissing(what); throw R.mkThrowable("java/lang/NoSuchFieldError", `${info.name}.${name} is not a field of the native class`); },
      set(value: unknown) { Object.defineProperty(this, prop, { value, writable: true, enumerable: true, configurable: true }); },
    });
  }

  /** set by jinvoke: run an invoke-custom call site's bootstrap, giving the function it calls */
  linkCallSite: (runtime: Runtime, dex: DexFile, callSite: number) => (...a: never[]) => unknown =
    (runtime) => { throw runtime.unimplemented("invoke-custom"); };

  /** JNI registry: implementations for dex-declared native methods (key "cls|name+desc") */
  jni = new Map<string, (...a: never[]) => unknown>();
  registerJni(cls: string, sig: string, fn: (...a: never[]) => unknown) {
    const key = cls + "|" + sig;
    this.jni.set(key, this.trackPlaceholder(`${cls}.${sig}`, fn, (f) => { if (this.jni.get(key) === f) this.jni.set(key, fn); }));
  }
  /** register the native halves of one class, by their exact descriptors */
  registerJnis(cls: string, table: Record<string, unknown>) {
    for (const [sig, fn] of Object.entries(table)) this.registerJni(cls, sig, fn as (...a: never[]) => unknown);
  }
  jniFn(cls: string, sig: string): ((...a: never[]) => unknown) | null { return this.jni.get(cls + "|" + sig) ?? this.jniResolver?.(cls, sig) ?? null; }
  /** set by the native tier: resolve a native by its JNI short-name export (`Java_pkg_Cls_m`) in a loaded library */
  jniResolver: ((cls: string, sig: string) => ((...a: never[]) => unknown) | null) | null = null;
  /** library names (System.loadLibrary spelling) whose natives a TS shim provides */
  nativeLibs = new Set<string>();
  claimNativeLib(name: string) { this.nativeLibs.add(name); }
  /** .so files the app tried to load that only exist as machine code: file → abi */
  nativeRequired = new Map<string, string>();
  /** set by src/native/loader.ts: loads a machine-code library for an ABI it can run (loadLibrary
   *  consults it before giving up). `thread` is the Java thread that asked: its Cpu runs the
   *  initialisers, whichever thread is current by then. */
  loadNativeLib: ((lib: string, bytes: Uint8Array, abi: string, owner?: Runtime) => Promise<void>) | null = null;
  /** the ABIs the native tier can actually execute, most-preferred first. Empty until
   *  src/native/loader.ts is imported, which is the only thing that can answer it. */
  nativeAbis: readonly string[] = [];
  /** a native method nothing registered — what calling it throws */
  ulink(cls: string, name: string, desc: string): Error {
    this.noteMissing(cls + "." + name + desc + " [native]");
    return this.mkThrowable("java/lang/UnsatisfiedLinkError", "No implementation found for " + dotName(cls) + "." + name + desc);
  }

  /** the Java frames calling into the runtime here, innermost first (set by jlang) */
  javaFrames: () => string[] = () => [];
  /** when an array, every throwable filling in its stack is appended (a diagnostic, capped at 500) */
  throwables: unknown[] | null = null;
  /** where each missing entry was first reached */
  missingAt = new Map<string, string[]>();
  noteMissing(what: string) {
    if (!this.missing.has(what)) {
      this.missing.add(what);
      const at = this.javaFrames().slice(0, 12);
      this.missingAt.set(what, at);
      console.warn("[webdroid missing]", what, at.length ? "\n  at " + at.join("\n  at ") : "");
      this.onMissing(what);
    }
  }

  /** the app is about to get an UnsatisfiedLinkError for a library that exists only as `abi` machine code */
  noteNativeRequired(lib: string, abi: string) {
    this.nativeRequired.set(lib, abi);
    console.warn("[webdroid native required]", lib, abi);
    this.onNativeRequired(lib, abi);
  }

  /** placeholders (`stubs`/`noops`) reached, as "cls.name(desc)", and the Java frames first reaching each */
  placeholders = new Set<string>();
  placeholderAt = new Map<string, string[]>();
  /** `fn` itself, or for a placeholder a wrapper that records its first hit and then asks
   *  `uninstall` to put `fn` back, so later calls cost what they did before */
  private trackPlaceholder<F extends Function>(what: string, fn: F, uninstall: (wrapper: F) => void): F {
    if (!placeholderMethods.has(fn)) return fn;
    const R = this;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      uninstall(wrapper as unknown as F);
      if (!R.placeholders.has(what)) { R.placeholders.add(what); R.placeholderAt.set(what, R.javaFrames().slice(0, 12)); }
      return fn.apply(this, args);
    };
    placeholderMethods.add(wrapper);
    return wrapper as unknown as F;
  }

  /** placeholder for a missing super method: logs + returns a thrower for .call() */
  nsm(what: string): (...a: unknown[]) => never {
    return () => { throw this.unimplemented(what); };
  }

  unimplemented(what: string): Error {
    this.noteMissing(what);
    return this.mkThrowable("java/lang/UnsupportedOperationException", "webdroid missing: " + what);
  }

  /** what a call site into an auto-stubbed class throws (link() already logged the class) */
  ncdfe(name: string): Error {
    // link first: an unlinked exception class inherits its super's ClassInfo, so compiled
    // `catch (NoClassDefFoundError)` — which matches on ClassInfo.types — would miss it
    this.link("java/lang/NoClassDefFoundError");
    return this.mkThrowable("java/lang/NoClassDefFoundError", "Failed resolution of: L" + name + ";");
  }

  /** sync: get linked ClassInfo (creates ctor shell, fields, types) */
  link(name: string): ClassInfo {
    let info = this.classes.get(name);
    if (info) return info;
    if (this.parent && (this.natives.has(name) || !this.dexIndex.has(name) && (!this.platformParent || this.platformClasses.has(name)))) return this.parent.link(name);
    if (name[0] === "[") return this.linkArray(name);
    info = new ClassInfo(name, this);
    this.classes.set(name, info);

    const native = this.natives.get(name);
    if (native) {
      info.native = true;
      if (this.nativeIfaces().has(name)) info.flags |= ACC.INTERFACE;
      info.ctor = native.ctor;
      this.adopt(info, name !== "java/lang/Object" ? native.sup ?? "java/lang/Object" : null, native.ifaces ?? []);
      // a spec declared over a bytecode superclass inherits its fields and methods
      const sup = info.superInfo;
      if (sup && !sup.native && Object.getPrototypeOf(native.ctor) === JObj) {
        Object.setPrototypeOf(native.ctor, sup.ctor);
        Object.setPrototypeOf(native.ctor.prototype, sup.ctor.prototype);
        this.ensureCompiled(sup);
      }
      this.setupNativeMembers(info, native);
      this.copyDefaults(info);
      return info;
    }

    const loc = this.dexIndex.get(name);
    if (loc === undefined) {
      // auto-stub: unknown framework class → empty JObj subclass, logged for triage. It keeps
      // instanceof/check-cast/catch matching/field types working; resolving it from a call
      // site (DexLink.init/rdp0/rsf) throws NoClassDefFoundError as ART does.
      this.noteMissing("class " + name);
      info.stub = true;
      info.native = true;
      // Object stubbing means the natives never loaded; it must not become its own super,
      // or every super-chain walk (copyDefaults, findStaticOwner) runs until the stack ends.
      info.superInfo = name === "java/lang/Object" ? null : this.link("java/lang/Object");
      info.types.add(name).add("java/lang/Object");
      info.ctor = new Function("S", `return class ${name.replace(/[^A-Za-z0-9_$]/g, "_")}$stub extends S {}`)(JObj);
      info.ctor.$i = info;
      info.state = 2;
      info.compiled = true;
      return info;
    }
    const { dex, def } = this.classDefOf(name)!;
    info.dex = dex;
    info.def = def;
    info.flags = def.flags;
    this.adopt(info, def.superIdx === NO_INDEX ? null : descToName(dex.type(def.superIdx)), def.interfaces.map((i) => descToName(dex.type(i))));
    // instance field table + ctor shell with field defaults
    let fieldsInit = "";
    for (const f of def.instanceFields) {
      const fr = dex.field(f.fieldIdx);
      const fname = fr.name;
      const mangled = mangleField(name, fname);
      info.fieldTable.set(fname, mangled);
      fieldsInit += `this.${mangled}=${defaultVal(dex.type(fr.type))};`;
    }
    info.ctor = info.isInterface ? class {}
      : new Function("S", fieldsInit ? `return class extends S {constructor(){super();${fieldsInit}}}` : "return class extends S {}")(info.superInfo?.ctor ?? JObj);
    info.ctor.$i = info;
    if (this.platformClasses.has(name) && def.virtualMethods.some((m) => m.codeOff && dex.method(m.methodIdx).name === "finalize" && dex.methodDesc(m.methodIdx) === "()V"))
      this.claimOnStore(info, def, dex);
    const staticNames = new Map<string, number>();
    for (const f of def.staticFields) {
      const name = dex.field(f.fieldIdx).name;
      staticNames.set(name, (staticNames.get(name) ?? 0) + 1);
    }
    for (const f of def.staticFields) {
      const fr = dex.field(f.fieldIdx);
      const desc = dex.type(fr.type), prop = mangleStaticField(fr.name, staticNames.get(fr.name)! > 1 ? desc : undefined);
      info.staticFieldTable.set(fr.name + ":" + desc, prop);
      // a float or double static starts as a double: V8 turns a function whose own property changes
      // from a small integer to a double into a dictionary, and its static calls stop inlining
      if (desc === "D" || desc === "F") info.ctor[prop] = 0.5;
      info.ctor[prop] = defaultValue(desc);
    }
    return info;
  }

  /** the handle-table owner hook (src/android/handles.ts) */
  claimHandle?: (owner: object, h: bigint) => void;
  /** A platform class whose finalize() frees the native handle in one of its long fields: storing
   *  a handle there makes the object its owner, since no finalizer runs here. */
  private claimOnStore(info: ClassInfo, def: ClassDef, dex: DexFile): void {
    const R = this;
    for (const f of def.instanceFields) {
      const fr = dex.field(f.fieldIdx);
      if (dex.type(fr.type) !== "J") continue;
      const prop = info.fieldTable.get(fr.name)!, slot = prop + "$v";
      Object.defineProperty(info.ctor.prototype, prop, {
        get(this: Record<string, bigint>) { return this[slot]; },
        set(this: Record<string, bigint>, h: bigint) { this[slot] = h; R.claimHandle?.(this, h); },
      });
    }
  }

  /** link the supertypes and take on every name the class is assignable to */
  private adopt(info: ClassInfo, sup: string | null, ifaces: string[]) {
    info.superInfo = sup ? this.link(sup) : null;
    info.types.add(info.name);
    if (info.superInfo) for (const t of info.superInfo.types) info.types.add(t);
    for (const i of ifaces) {
      const ii = this.link(i);
      info.interfaces.push(ii);
      for (const t of ii.types) info.types.add(t);
    }
  }

  private setupNativeMembers(info: ClassInfo, spec: NativeSpec) {
    const proto = spec.ctor.prototype as Record<string, unknown>;
    const ctorAny = spec.ctor as any;
    const methods = { ...spec.methods } as Record<string, unknown>;
    // AOSP's (Context, AttributeSet) constructor delegates to the defStyle ones, so a widget
    // that spells only the two-arg form must not let a SUBCLASS reach the superclass's
    // three-arg native instead and skip its attribute parsing (Material passes its own
    // default style to every widget it wraps).
    const two = methods["<init>(Landroid/content/Context;Landroid/util/AttributeSet;)V"];
    if (two) for (const extra of ["I)V", "II)V"]) {
      const k = "<init>(Landroid/content/Context;Landroid/util/AttributeSet;" + extra;
      methods[k] ??= two;
    }
    for (const [key, impl] of Object.entries(methods)) {
      let k = key, isStatic = false;
      if (k.startsWith("static ")) { isStatic = true; k = k.slice(7); }
      const [mname, desc] = splitSig(k);
      const mangled = mangleMethod(mname, desc);
      const target: Record<string, unknown> = isStatic ? ctorAny : proto;
      const fn = typeof impl === "string" ? proto[impl] : impl;
      if (typeof fn !== "function") throw new Error(`bad native impl ${spec.name}.${key}`);
      target[mangled] = this.trackPlaceholder(`${spec.name}.${k}`, fn, (f) => { if (target[mangled] === f) target[mangled] = fn; });
      if (!isStatic) info.ownMethods.push(mangled);
      if (mname === "<init>") proto[directName(spec.name, mangled)] = target[mangled];
    }
    // A static written as a getter is resolved on first READ, not here: link order is
    // registration order, so a static whose value is an instance of another class would
    // otherwise link that class before its own module had registered it — and get a stub.
    // First read replaces the accessor with the value, so identity still holds.
    for (const fname of Object.keys(spec.statics ?? {})) {
      const key = mangleStaticField(fname);
      const d = Object.getOwnPropertyDescriptor(spec.statics!, fname)!;
      if (!d.get) { ctorAny[key] = d.value; continue; }
      const pin = (owner: object, value: unknown) => Object.defineProperty(owner, key, { value, writable: true, configurable: true });
      Object.defineProperty(ctorAny, key, {
        configurable: true,
        get: () => { const v = d.get!.call(spec.statics); pin(ctorAny, v); return v; },
        // a subclass declaring a static of the same name writes through this inherited
        // accessor; that value is its own field, not this class's
        set(this: object, v: unknown) { pin(this, v); },
      });
    }
    const fl = spec.fields ?? [];
    if (Array.isArray(fl)) for (const n of fl) info.fieldTable.set(n, n);
    else for (const [jname, prop] of Object.entries(fl)) info.fieldTable.set(jname, prop);
    // serialized state is the class's own instance fields, which JNI and reflection also reach
    for (const f of spec.serialization?.fields ?? []) if (!info.fieldTable.has(f.name)) info.fieldTable.set(f.name, f.prop);
    ctorAny.$i = info;
    info.state = spec.clinit || spec.platformClinit ? 0 : 2;
    info.compiled = true;
    if (this.platformClasses.has(info.name)) this.fallThrough(info);
  }

  /**
   * A native spec that leaves out a method the platform class declares answers with the
   * platform's: its body, compiled against the native object on first call, or its JNI binding
   * when the platform declares it native. Only gaps are filled: a virtual method or constructor
   * the prototype chain already reaches, other than java.lang.Object's, keeps its native
   * implementation.
   */
  private fallThrough(info: ClassInfo) {
    const { dex, def } = this.classDefOf(info.name)!;
    const proto = info.ctor.prototype;
    // the platform's compile-time constants (encoded static values) for statics the spec omits
    if (def.staticValuesOff) dex.encodedArray(def.staticValuesOff).forEach((value, i) => {
      const prop = mangleStaticField(dex.field(def.staticFields[i].fieldIdx).name);
      if (!Object.hasOwn(info.ctor, prop)) info.ctor[prop] = this.encToJs(dex, value);
    });
    const lists = [def.directMethods, def.virtualMethods], R = this, cls = info.name, platformClinit = this.natives.get(cls)?.platformClinit;
    // the rest of a platform <clinit>'s statics, which it sets
    if (platformClinit) for (const f of def.staticFields) {
      const fr = dex.field(f.fieldIdx), prop = mangleStaticField(fr.name);
      if (!Object.hasOwn(info.ctor, prop)) info.ctor[prop] = defaultValue(dex.type(fr.type));
    }
    const fill = ([list, index, mangled, kind]: Gap) => {
      const m = lists[list][index], isStatic = (m.flags & ACC.STATIC) !== 0, target = isStatic ? info.ctor : proto;
      if (kind === 2) { target[mangled] = info.superInfo!.ctor.prototype[mangled]; return; }
      if (!isStatic) info.ownMethods.push(mangled);
      if (kind === 0) { installLazy(this, dex, info, m, true, mangled); return; }
      // resolved on first call, and kept: a call site that captured this stub keeps calling it
      let fn: ((...a: never[]) => unknown) | null = null;
      target[mangled] = function (this: unknown, ...args: unknown[]) {
        if (!fn) {
          const { name, desc } = methodKey(dex, m.methodIdx);
          if (!(fn = R.jniFn(cls, name + desc))) throw R.ulink(cls, name, desc);
          target[mangled] = fn;
        }
        return fn.apply(this, args as never[]);
      };
    };
    const known = gapsOf(cls);
    if (known) { known.forEach(fill); return; }
    const found: Gap[] = [];
    lists.forEach((list, l) => list.forEach((m, index) => {
      if (m.flags & ACC.ABSTRACT) return;
      const { name, mangled } = methodKey(dex, m.methodIdx);
      const isStatic = (m.flags & ACC.STATIC) !== 0, target = isStatic ? info.ctor : proto;
      // statics and private methods belong to their class; the rest may be inherited
      const own = isStatic || l === 0 && name !== "<init>";
      // what a subclass reaches from java.lang.Object alone is no implementation of the spec's
      const base = proto === JObj.prototype ? undefined : JObj.prototype[mangled as never];
      if (name === "<clinit>" ? !platformClinit : own ? Object.hasOwn(target, mangled) : mangled in target && target[mangled] !== base) return;
      // a spec whose JS class does not extend its declared superclass's still inherits from it
      const inherited = own ? undefined : info.superInfo?.ctor?.prototype?.[mangled];
      const gap: Gap = [l, index, mangled, inherited && inherited !== base ? 2 : m.flags & ACC.NATIVE ? 1 : 0];
      found.push(gap);
      fill(gap);
    }));
    recordGaps(cls, found);
  }

  /** the fields `m` reads or writes on native classes that those classes do not have: a
   *  platform body touching them would read undefined, or leave its write unseen */
  absentFields(dex: DexFile, m: EncodedMethod): string[] {
    const absent = new Set<string>(), insns = dex.code(m.codeOff).insns;
    for (let pc = 0; pc < insns.length; pc += insnLen(insns, pc)) {
      const op = insns[pc] & 0xff;
      if (op < 0x52 || op > 0x6d) continue;
      const fr = dex.field(insns[pc + 1]), owner = descToName(dex.type(fr.cls));
      let info: ClassInfo;
      try { info = this.link(owner); } catch { continue; }
      if (!info.native || info.stub) continue;
      if (op < 0x60 ? !instanceFieldOf(info, fr.name) : !findStaticOwner(info, fr.name, dex.type(fr.type))) absent.add(`${owner}.${fr.name}`);
    }
    return [...absent];
  }

  private linkArray(desc: string): ClassInfo {
    const info = new ClassInfo(desc);
    this.classes.set(desc, info);
    info.types.add(desc).add("java/lang/Object").add("java/lang/Cloneable").add("java/io/Serializable");
    info.superInfo = this.link("java/lang/Object");
    info.ctor = null;
    info.state = 2;
    return info;
  }

  /** record from's clinit waiting on info; race a timeout escape for undetected cycles */
  private awaitInit(info: ClassInfo, from: ClassInfo | undefined, timed: boolean): Promise<void> {
    if (from) from.waitingOn = info;
    const clear = () => { if (from && from.waitingOn === info) from.waitingOn = null; };
    let esc: ReturnType<typeof setTimeout> | undefined;
    const watch = timed ? watchStrand(info.initStrand) : undefined;
    const p = watch
      ? Promise.race([info.initP!, new Promise<void>((res) => {
          // escape: a job interleaved on the initializing thread waits while the <clinit>'s chain
          // runs or waits only for its turn, however long a loaded page (or a background realm)
          // makes that; a chain stalled for a whole window is more likely in a cycle through this
          // job (a host callback that lost its chain), and the request proceeds as JLS re-entry.
          // Remember it so the next several hundred accesses don't each pay the timeout.
          // The timer must be cleared when the race is won: left armed, it would mark a class
          // reentrant after a healthy wait, and later reads would stop waiting for a <clinit>
          // that really is in flight.
          const arm = () => { esc = setTimeout(() => {
            if (watch.ran()) return arm();
            console.warn("[webdroid] clinit wait timeout (cycle?)", info.name, "waited on by", from?.name); info.assumeReentrant = true; res();
          }, CLINIT_WAIT_MS); };
          arm();
        })])
      : info.initP!;
    const done = () => { if (esc !== undefined) clearTimeout(esc); watch?.stop(); clear(); };
    return p.then((v) => { done(); return v; }, (e) => { done(); throw e; });
  }

  /** returns promise only if init work needed. `from` = class whose <clinit> performs the access */
  initClass(info: ClassInfo, from?: ClassInfo): Promise<void> | null {
    if (info.owner && info.owner !== this) return info.owner.initClass(info, from);
    // Preparation (defining the methods) is NOT initialization: every reentrancy escape below
    // returns without running <clinit>, and a caller that then looks a method up on a
    // still-uncompiled prototype silently inherits the SUPERCLASS's method instead.
    this.ensureCompiled(info);
    if (info.state === 1) {
      if (!info.initP || info === from || info.assumeReentrant) return null; // sync-prefix / self / known-cycle reentrancy
      // JLS 12.4.2 step 3: a request from the thread already initializing this class is
      // recursive and completes at once with the statics as they are. The `from` tag only
      // sees <clinit>-to-<clinit> edges; <clinit> → constructor → sget of its own class is the
      // common shape (kotlinx's ChannelSegment reads BufferedChannelKt.SEGMENT_SIZE while
      // BufferedChannelKt's <clinit> builds NULL_SEGMENT). Main-loop jobs and host turns share
      // their Java thread, so "the thread" is that thread as the chain that started the <clinit>,
      // across its suspensions: another job on it would not run on a device before init finished.
      if (info.initThread === this.th() && info.initStrand === currentStrand()) return null;
      // clinit cycle (info's chain transitively waits on `from`) → JVM same-thread
      // semantics: proceed with partial statics instead of deadlocking. A loop in the wait
      // chain (two threads' clinits waiting on each other, which a JVM would deadlock on) also
      // proceeds with partial statics rather than hanging the page.
      for (let c = info.waitingOn, n = 0; c; c = c.waitingOn) if (c === from || ++n > 64) return null;
      // JVM: only the initializing thread may proceed on a class mid-<clinit>; every other
      // thread blocks until it completes, however long a heavy static initializer takes. Another
      // chain on the same thread waits with the timed escape: the <clinit>'s own chain continued
      // from a host callback that did not carry it, or a <clinit> awaiting work only this chain
      // would deliver, is indistinguishable from a wait that will never end.
      return this.awaitInit(info, from, info.initThread === this.th());
    }
    if (info.state !== 0) {
      if (info.state === 3) throw Object.assign(this.mkThrowable("java/lang/NoClassDefFoundError",
        `Rejecting re-init on previously-failed class java.lang.Class<${dotName(info.name)}>`), { cause: info.initError });
      return null;
    }
    info.state = 1;
    info.initThread = this.th();
    info.initStrand = ownStrand();

    // Initialize synchronously for as long as nothing actually suspends: only the step that
    // really yields gets a promise, and the rest of the sequence continues from there. An
    // always-async initializer would make every first touch of a class await, so no method
    // containing an sget, a new-instance or an invoke-static could run synchronously.
    const rest = (): Promise<void> | null => {
      const outer = this.clinitDepth++ === 0, started = outer ? performance.now() : 0;
      try { return this.runClinit(info); }
      finally { this.clinitDepth--; if (outer) perf.clinitMs += performance.now() - started; }
    };

    const settle = () => { info.state = 2; info.initP = null; info.initThread = null; info.initStrand = 0; info.assumeReentrant = false; fastStatics(info.ctor); };
    /** JLS 12.4.2: the class becomes erroneous; an Exception reaches the caller wrapped in an
     *  ExceptionInInitializerError, and every later initialization fails with NoClassDefFoundError */
    const failed = (e: unknown) => {
      settle();
      info.state = 3;
      const t = this.jx(e);
      const what = (x: unknown): string => { const o = x as { constructor?: { $i?: { name: string } }; msg?: unknown; cause?: unknown } | null;
        return o ? `${o.constructor?.$i?.name ?? "?"}: ${o.msg}${o.cause && o.cause !== o ? " <- " + what(o.cause) : ""}` : String(x); };
      console.warn("[webdroid clinit-failed]", info.name, what(t), (t as { jsErr?: Error }).jsErr?.stack?.split("\n").slice(1, 6).join(" | ") ?? "");
      return info.initError = this.iof(t, "java/lang/Error") ? t : Object.assign(this.mkThrowable("java/lang/ExceptionInInitializerError", null), { cause: t });
    };
    /** hand the remaining steps to the microtask queue, from the one that yielded */
    const async = (pending: Promise<unknown>, after: (() => Promise<void> | null) | null): Promise<void> => {
      info.initP = (async () => {
        try {
          await pending;
          // the <clinit> run here is its chain's, and releases its thread
          const more = inStrand(info.initStrand, () => { try { return after?.(); } finally { this.su(null); } });
          if (more) await more;
        } catch (e) { throw failed(e); }
        settle();
      })();
      return from ? this.awaitInit(info, from, false) : info.initP;
    };

    // a host turn's chain takes its identity here, so the <clinit>'s suspensions and callbacks keep it
    const outer = enterStrand(info.initStrand);
    try {
      const sup = info.superInfo && info.superInfo.state !== 2 ? this.initClass(info.superInfo, info) : null;
      if (sup) return async(sup, rest);
      const pending = rest();
      if (pending) return async(pending, null);
    } catch (e) { throw failed(e); }
    finally { enterStrand(outer); }
    settle();
    return null;
  }

  /** the class's own initialization: constant statics, then <clinit> or the native clinit hook */
  private runClinit(info: ClassInfo): Promise<void> | null {
    this.quiet.types = null;
    for (const i of info.interfaces) this.ensureCompiled(i);   // defaults copy down
    this.ensureCompiled(info);
    let r: unknown;
    if (info.native) {
      const spec = this.natives.get(info.name);
      if (spec?.clinit) r = spec.clinit();
      else if (spec?.platformClinit && Object.hasOwn(info.ctor, "$clinit")) { this.st(info.initThread); r = info.ctor.$clinit.call(info.ctor); }
    } else if (info.def) {
      const dex = info.dex!;
      if (info.def.staticValuesOff) {
        const vals = dex.encodedArray(info.def.staticValuesOff);
        for (let i = 0; i < vals.length; i++) {
          const fr = dex.field(info.def.staticFields[i].fieldIdx);
          info.ctor[info.staticFieldTable.get(fr.name + ":" + dex.type(fr.type))!] = this.encToJs(dex, vals[i]);
        }
      }
      // own property only: JS constructors inherit statics, and a subclass without a
      // <clinit> must not re-run its super's (which would replace identity-compared
      // sentinels the super's callers already hold)
      const clinit = Object.hasOwn(info.ctor, "$clinit") ? info.ctor.$clinit : undefined;
      this.st(info.initThread); // <clinit> runs on the initiating thread, whatever ran meanwhile
      if (clinit) r = clinit.call(info.ctor);
    }
    return r instanceof Promise ? r : null;
  }

  ensureCompiled(info: ClassInfo): void {
    if (info.owner && info.owner !== this) return info.owner.ensureCompiled(info);
    // The JS prototype chain only carries inherited methods once the super is compiled too.
    if (info.superInfo && !info.superInfo.compiled) this.ensureCompiled(info.superInfo);
    if (info.compiled || !info.def) { this.copyDefaults(info); return; }
    info.compiled = true;
    const t0 = performance.now();
    const dex = info.dex!;
    compileClass(this, dex, info);
    perf.compileMs += performance.now() - t0;
    perf.classesCompiled++;
    for (const m of info.def.virtualMethods) {
      if (m.codeOff) info.ownMethods.push(methodKey(dex, m.methodIdx).mangled);
    }
    this.copyDefaults(info);
  }

  /** copy inherited interface defaults so both class dispatch and interface super calls resolve */
  /** the default body an interface of `info` gives `mangled`: what a platform body that cannot
   *  run on a native class yields to, as HashMap's computeIfAbsent does to Map's */
  interfaceDefault(info: ClassInfo, mangled: string): unknown {
    const seen = new Set<ClassInfo>();
    const walk = (i: ClassInfo): unknown => {
      for (const iface of i.interfaces) {
        if (seen.has(iface)) continue;
        seen.add(iface);
        this.ensureCompiled(iface);
        if (iface.ownMethods.includes(mangled)) return iface.ctor.prototype[mangled];
        const body = walk(iface);
        if (body) return body;
      }
      return i.superInfo ? walk(i.superInfo) : undefined;
    };
    return walk(info);
  }

  private copyDefaults(info: ClassInfo) {
    if (!info.ctor || info.defaultsCopied) return;
    info.defaultsCopied = true;
    const seen = new Set<ClassInfo>();
    const walk = (i: ClassInfo) => {
      for (const iface of i.interfaces) {
        if (seen.has(iface)) continue;
        seen.add(iface);
        this.ensureCompiled(iface);
        for (const m of iface.ownMethods) {
          if (!(m in info.ctor.prototype)) info.ctor.prototype[m] = iface.ctor.prototype[m];
        }
        walk(iface);
      }
      if (i.superInfo) walk(i.superInfo);
    };
    walk(info);
  }

  encToJs(dex: DexFile, v: EncVal): unknown {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) return v.map((x) => this.encToJs(dex, x));
      if (v.kind === "type") return this.classFor(descToName(dex.type(v.idx)));
      if (v.kind === "enum") {
        const fr = dex.field(v.idx);
        const info = this.link(descToName(dex.type(fr.cls)));
        const field = findStaticOwner(info, fr.name, dex.type(fr.type));
        return field?.info.ctor[field.prop];
      }
      return null;
    }
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  }

  /** java.lang.Class object for a class name — filled in by jlang module */
  classFor: (name: string) => any = (name) => ({ $classFor: name });

  // ───────────────────────────── helpers called from compiled code (`R.…`)

  /** Compile a lazily-emitted method body on first call, install it, and hand it back. */
  lz(C: CompiledCtor, i: number): ReturnType<typeof compileLazyMethod> {
    const t0 = performance.now();
    const fn = compileLazyMethod(this, C, i);
    perf.compileMs += performance.now() - t0;
    return fn;
  }

  /** normalize a thrown JS value to a Java throwable */
  jx(e: unknown): any {
    if (e instanceof JObj) return e;
    if (typeof e === "object" && e !== null && (e as any).$javaClass) return e;
    if (e instanceof TypeError) {
      const m = e.message;
      // V8: "Cannot read properties of null"; JavaScriptCore (Bun): "null is not an object"
      if (/null|undefined/.test(m) && /read|call|properties|is not an object/i.test(m)) {
        return this.mkThrowable("java/lang/NullPointerException", m);
      }
      if (/is not a function/.test(m)) {
        const nd = demangle(/\.(\S+) is not a function/.exec(m)?.[1] ?? "");
        this.noteMissing(nd ? `${nd[0]}${nd[1]} is not a function` : m);
        return this.mkThrowable("java/lang/NoSuchMethodError", m);
      }
    }
    if (e instanceof RangeError) {
      if (/call stack/i.test(e.message)) return this.mkThrowable("java/lang/StackOverflowError", null);
      // a typed array too long for the engine, or one it cannot back, is too big for the heap
      const length = /Invalid typed array length: (\d+)/.exec(e.message);
      if (length || /Array buffer allocation failed/.test(e.message)) return this.oom(length ? Number(length[1]) : NaN);
      if (/array length|Invalid typed array/i.test(e.message)) {
        return this.mkThrowable("java/lang/NegativeArraySizeException", e.message);
      }
    }
    if (e instanceof Error) return this.mkThrowable("java/lang/InternalError", e.message + "\n" + e.stack);
    return this.mkThrowable("java/lang/InternalError", String(e));
  }

  oom(bytes: number): unknown {
    return this.mkThrowable("java/lang/OutOfMemoryError", `Failed to allocate a ${bytes} byte allocation with ${HEAP_LIMIT} free bytes`);
  }

  /** instance-of: 1/0 */
  iof(v: unknown, name: string): number {
    if (v === null || v === undefined) return 0;
    if (typeof v === "string") return STRING_TYPES.has(name) ? 1 : 0;
    if (typeof v === "number" || typeof v === "bigint") return BOX_UNIVERSE.has(name) ? 1 : 0;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return this.arrayIof(v as ArrLike, name);
    const info: ClassInfo | undefined = (v as any).constructor?.$i;
    if (!info?.types.has(name)) return 0;
    return info.owner?.parent || this.parent ? +info.assignableTo(this.link(name)) : 1;
  }

  arrayIof(v: ArrLike, name: string): number {
    if (name === "java/lang/Object" || name === "java/lang/Cloneable" || name === "java/io/Serializable") return 1;
    if (name[0] !== "[") return 0;
    const vDesc: string = arrayDesc(v);
    if (vDesc === name) return 1;
    // covariance for object arrays: [Lsub; → [Lsup;  and [[X → [Ljava/lang/Object;
    let d1 = 0, d2 = 0, a = vDesc, b = name;
    while (a[d1] === "[") d1++;
    while (b[d2] === "[") d2++;
    if (d2 < d1 && b.slice(d2) === "Ljava/lang/Object;") return 1;
    if (d1 !== d2) return 0;
    const ea = a.slice(d1), eb = b.slice(d2);
    if (ea[0] === "L" && eb[0] === "L") {
      if (eb === "Ljava/lang/Object;") return 1;
      const ei = this.link(descToName(ea));
      return ei?.types.has(descToName(eb)) ? 1 : 0;
    }
    return 0;
  }

  /** instance-of at a compiled site: caches the receiver's class with its answer in the first free
   *  of two entries, else the second (object arrays carry their element type per instance, so
   *  they are never cached) */
  iofc(v: unknown, name: string, ic: unknown[], k: number): number {
    const r = this.iof(v, name);
    if (v != null && !Array.isArray(v)) { const at = ic[k] === undefined ? k : k + 2; ic[at] = (v as object).constructor; ic[at + 1] = r; }
    return r;
  }
  /** check-cast at a compiled site: caches a receiver class that passed, as iofc does */
  ccc(v: unknown, name: string, ic: unknown[], k: number): void {
    this.cc(v, name);
    if (!Array.isArray(v)) ic[ic[k] === undefined ? k : k + 2] = (v as object).constructor;
  }
  /** check-cast */
  cc<T>(v: T, name: string): T {
    if (v === null || v === undefined || (v as unknown) === 0) return v;
    if (!this.iof(v, name)) {
      throw this.mkThrowable("java/lang/ClassCastException",
        `${describeVal(v)} cannot be cast to ${name}`);
    }
    return v;
  }

  npe(): never { throw this.mkThrowable("java/lang/NullPointerException", null); }
  /** a compiled body dispatched to a pc that is not a block leader */
  badPc(pc: number): never { throw new Error("bad pc " + pc); }
  dz(): never { throw this.mkThrowable("java/lang/ArithmeticException", "divide by zero"); }
  aio(i: number, len: number): never {
    throw this.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", `length=${len}; index=${i}`);
  }
  f2i(v: number): number {
    return v !== v ? 0 : v >= 2147483647 ? 2147483647 : v <= -2147483648 ? -2147483648 : v | 0;
  }
  f2l(v: number): bigint {
    if (v !== v) return 0n;
    if (v >= 9223372036854775807) return 9223372036854775807n;
    if (v <= -9223372036854775808) return -9223372036854775808n;
    return BigInt(Math.trunc(v));
  }
  /** object array with element-type tag; like ART's, one past the heap limit is an OutOfMemoryError */
  oa(len: number, t: string): unknown[] {
    if (len < 0) throw this.mkThrowable("java/lang/NegativeArraySizeException", String(len));
    if (len * 4 > HEAP_LIMIT) throw this.oom(len * 4);
    const a = new Array(len).fill(null);
    (a as any).$t = t;
    return a;
  }
  /** long shift counts, so a shift does not allocate its BigInt amount */
  readonly shifts: readonly bigint[] = Array.from({ length: 64 }, (_, i) => BigInt(i));
  /** `1L << n` for every n: the bit-mask idiom then allocates nothing */
  readonly bits: readonly bigint[] = Array.from({ length: 64 }, (_, i) => BigInt.asIntN(64, 1n << BigInt(i)));
  private lastYield = 0;
  /** ms between back-edge yields. The frame loop stretches it while a draw pass is in flight:
   *  a yield there only costs a macrotask, since nothing is presented until the pass ends. */
  yieldGap = 8;
  /** Back-edge fuel check target. fuel is a GLOBAL counter shared by every loop, so it trips
   *  far more often than any one loop would; only actually yield to the event loop if we have
   *  not yielded recently, otherwise just refill and keep going. */
  refuel(): Promise<void> | null {
    this.fuel = 4096;   // a loop of native calls costs tens of µs an iteration: check the clock often enough to yield within ~10 ms
    const now = performance.now();
    if (now - this.lastYield < this.yieldGap) return null;
    this.lastYield = now;
    return yieldAs(yieldToLoop());
  }
  /** java.lang.Class for the type at dex typeIdx (compiled const-class) */
  classForIdx(D: DexLink, typeIdx: number): unknown {
    return this.classFor(descToName(D.dex.type(typeIdx)));
  }
  /** new String(char[], int, int), the constructor readers and parsers call per token */
  strChars(chars: Uint16Array | null, off: number, len: number): string {
    if (!chars) this.npe();
    if (off < 0 || len < 0 || off > chars.length - len) throw this.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${off}, count ${len}, length ${chars.length}`);
    return charsToString(chars, off, len);
  }
  /** String's constructors by descriptor: what the compiler emits for String.<init>, and JNI's NewObject */
  readonly newStr = {
    "()V": () => "",
    "(Ljava/lang/String;)V": (s: string) => s,
    "(Ljava/lang/StringBuilder;)V": (sb: object) => String(sb),
    "(Ljava/lang/StringBuffer;)V": (sb: object) => String(sb),
    "([C)V": (chars: Uint16Array) => charsToString(chars, 0, chars.length),
    "([CII)V": (chars: Uint16Array, off: number, n: number) => this.strChars(chars, off, n),
    // String(byte[] value, byte coder): the compact form StringLatin1 and StringUTF16 build
    "([BB)V": (bytes: Int8Array, coder: number) => {
      const n = coder ? bytes.length >> 1 : bytes.length, chars = new Uint16Array(n);
      if (coder) for (let i = 0; i < n; i++) chars[i] = (bytes[2 * i] & 255) | ((bytes[2 * i + 1] & 255) << 8);
      else for (let i = 0; i < n; i++) chars[i] = bytes[i] & 255;
      return charsToString(chars, 0, n);
    },
    "([BI)V": (bytes: Int8Array, high: number) => this.hibyteStr(bytes, high, 0, bytes?.length),
    "([BIII)V": (bytes: Int8Array, high: number, off: number, n: number) => this.hibyteStr(bytes, high, off, n),
    "([B)V": (bytes: Int8Array) => decodeString(bytes, "UTF-8"),
    "([BII)V": (bytes: Int8Array, off: number, n: number) => decodeString(bytes, "UTF-8", this.byteRange(bytes, off, n), n),
    "([BLjava/lang/String;)V": (bytes: Int8Array, cs: string) => decodeString(bytes, cs),
    "([BLjava/nio/charset/Charset;)V": (bytes: Int8Array, cs: object) => decodeString(bytes, cs),
    "([BIILjava/lang/String;)V": (bytes: Int8Array, off: number, n: number, cs: string) => decodeString(bytes, cs, this.byteRange(bytes, off, n), n),
    "([BIILjava/nio/charset/Charset;)V": (bytes: Int8Array, off: number, n: number, cs: object) => decodeString(bytes, cs, this.byteRange(bytes, off, n), n),
    // code points, not chars: each element is a whole Unicode scalar
    "([III)V": (cp: Int32Array, off: number, n: number) => {
      let out = "";
      for (let i = 0; i < n; i++) out += String.fromCodePoint(cp[off + i]);
      return out;
    },
  } satisfies Record<string, (...args: never[]) => string>;
  /** the deprecated String(byte[] ascii, int hibyte, ...): each char is hibyte over a byte */
  private hibyteStr(bytes: Int8Array | null, high: number, off: number, n: number): string {
    if (!bytes) throw this.mkThrowable("java/lang/NullPointerException", "ascii");
    this.byteRange(bytes, off, n);
    const chars = new Uint16Array(n), hi = high << 8;
    for (let i = 0; i < n; i++) chars[i] = hi | (bytes[off + i] & 255);
    return charsToString(chars, 0, n);
  }
  /** String's checkBoundsOffCount over a byte array: the offset */
  private byteRange(bytes: Int8Array, off: number, count: number): number {
    if (off < 0 || count < 0 || off > bytes.length - count)
      throw this.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${off}, count ${count}, length ${bytes.length}`);
    return off;
  }
  /** virtual call on an array receiver (clone etc.) */
  arrCall(a: any, name: string): unknown {
    switch (name) {
      case "clone": {
        if (Array.isArray(a)) { const c: unknown[] = a.slice(); (c as any).$t = (a as any).$t; return c; }
        return a.slice();
      }
      case "getClass": return this.classFor(arrayDesc(a));
      case "hashCode": return 1;
      case "toString": return arrayDesc(a) + "@1";
      case "equals": return 0;
      default: throw this.unimplemented("array." + name);
    }
  }

  /** fill-array-data: raw per-element little-endian ints (BigInt for width 8) */
  fad(arr: unknown, vals: (number | bigint)[]) {
    if (arr instanceof Float32Array) arr.set(new Float32Array(Int32Array.from(vals as number[]).buffer));
    else if (arr instanceof Float64Array) arr.set(new Float64Array(BigInt64Array.from(vals as bigint[]).buffer));
    else {
      const a = arr as { [i: number]: number | bigint };
      for (let i = 0; i < vals.length; i++) a[i] = vals[i];
    }
  }
}

type ArrLike = unknown[] | { length: number };
function arrayDesc(v: unknown): string {
  if (Array.isArray(v)) return (v as any).$t ? "[" + (v as any).$t : "[Ljava/lang/Object;";
  const e = primElem(v);
  return e ? "[" + e : "[Ljava/lang/Object;";
}
function describeVal(v: unknown): string {
  if (typeof v === "string") return "java.lang.String";
  if (typeof v === "number" || typeof v === "bigint") return "raw:" + v;
  const i: ClassInfo | undefined = (v as any)?.constructor?.$i;
  return i?.name ?? arrayDesc(v);
}

const STRING_TYPES = new Set(["java/lang/String", "java/lang/Object", "java/lang/CharSequence", "java/lang/Comparable", "java/io/Serializable"]);
// unboxed JS numbers/bigints occasionally reach reflective isInstance checks (e.g.
// Compose SaveableStateRegistry probing Serializable); grant the types every box shares
const BOX_UNIVERSE = new Set(["java/lang/Object", "java/io/Serializable", "java/lang/Comparable", "java/lang/Number"]);

export const rt = new Runtime();
const declaredFields = new Map<string, string>();
/** the property holding `cls`'s instance field `name`, whether a spec maps it or bytecode keeps it;
 *  "" when the class has none */
export function declaredField(cls: string, name: string): string {
  const key = cls + "." + name;
  let prop = declaredFields.get(key);
  if (prop === undefined) declaredFields.set(key, prop = instanceFieldOf(rt.link(cls), name) ?? "");
  return prop;
}
function fieldOf(cls: string, name: string): string {
  const prop = declaredField(cls, name);
  if (!prop) throw new Error(`${cls} has no field ${name}`);
  return prop;
}
/** assigns `values` to `o`'s fields as `cls` declares or inherits them */
export function setDeclared<T extends JObj>(o: T, cls: string, values: Record<string, unknown>): T {
  for (const name in values) (o as unknown as Record<string, unknown>)[fieldOf(cls, name)] = values[name];
  return o;
}
/** `o`'s field `name` as `cls` declares or inherits it */
export const getDeclared = <T = unknown>(o: unknown, cls: string, name: string): T => (o as Record<string, T>)[fieldOf(cls, name)]!;

/** A native implemented as a generator (see Runtime.drive), callable like any other method.
 *  It forwards every argument: caller-sensitive natives receive the caller's Runtime past their
 *  declared (often defaulted) parameters. */
export function driven<A extends unknown[], T>(g: (this: any, ...a: A) => Gen<T>): (this: any, ...a: A) => Driven<T> {
  // $g: the generator, whose source the override-bypass lint reads
  return Object.assign(function (this: unknown) { return rt.drive(g.apply(this, arguments as unknown as A)) as Driven<T>; }, { $g: g });
}
/** A driven generator's result: its value or a Promise of it (unknown for an untyped `Gen`). */
type Driven<T> = unknown extends T ? unknown : T | Promise<T>;
