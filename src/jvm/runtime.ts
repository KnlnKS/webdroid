// Class registry, linking, initialization, native registration, and the `R` helper
// surface that compiled code calls. See abi.ts for the value model.
//
// Lifecycle: link (ctor shell + fields + types) → init (compile methods, run <clinit>, which
// may suspend). Instances only exist after init, so prototype methods are always present
// when virtual dispatch happens.

import { yieldToLoop } from "./yield";
import { suspendWith } from "./suspend";
import { decodeString } from "./charset";
import { DexFile, NO_INDEX, type ClassDef, type EncVal, type EncodedMethod } from "./dex";
import { mangleField, mangleMethod, directName, mangleStaticField, descToName, defaultVal, defaultValue, charsToString, utf8, dotName, demangle, primElem, splitSig } from "./abi";
import { compileClass, compileLazyMethod, installLazy, methodKey, type Cells, type CompiledCtor, type ResumeBody } from "./compiler";
import { insnLen } from "./opcodes";
import { gapsOf, recordGaps, type Gap } from "./codecache";
import { isBytecode } from "./provenance";
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
export const flagGetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any) { return this[f] ? 1 : 0; });
export const fieldSetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any, v?: unknown) { this[f] = v; });
export const flagSetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any, v?: unknown) { this[f] = !!v; });

/** a shared table less the entries a class does not declare */
export function without(methods: NativeSpec["methods"], ...keys: string[][]): NonNullable<NativeSpec["methods"]> {
  const out = { ...methods };
  for (const key of keys.flat()) delete out[key];
  return out;
}

export function callSelf(m: NativeSpec["methods"], sig: string, self: unknown, ...args: unknown[]): unknown {
  return (m![sig] as (this: unknown, ...a: unknown[]) => unknown).call(self, ...args);
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
  initThread: unknown = null;         // thread running the in-flight clinit (JLS recursive-request check)
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
  lazy?: { dex: DexFile; m: EncodedMethod; mangled: string; isStatic: boolean; name: string; desc: string; stub: Cells & ((...a: unknown[]) => unknown); fallthrough: boolean }[];
  defaultsCopied = false;         // interface default methods already copied down
  constructor(public name: string, public owner?: Runtime) {}
  get isInterface(): boolean { return (this.flags & ACC.INTERFACE) !== 0; }
  assignableTo(target: ClassInfo): boolean {
    if (!this.types.has(target.name)) return false;
    if (!this.owner?.parent && !target.owner?.parent) return true;
    return this === target || !!this.superInfo?.assignableTo(target) || this.interfaces.some((i) => i.assignableTo(target));
  }
}

interface DexLink {
  dex: DexFile;
  cl: any[];            // typeIdx → linked ctor
  ic: any[];            // typeIdx → inited ctor
  s: readonly (string | undefined)[]; // string cache
  dp: any[];            // methodIdx → direct-invoke prototype fn
  fs: any[];            // fieldIdx → inited owner ctor (static fields declared off-refclass)
  cs: any[];            // callSiteIdx → linked invoke-custom target
  info: ClassInfo[];    // typeIdx → ClassInfo (linked)
  gs(i: number): string;
  link(i: number): any;             // sync: linked ctor
  linfo(i: number): ClassInfo;
  init(i: number, from?: number): Promise<any> | any;  // inited ctor (from = clinit accessor's type)
  rdp(i: number, from?: number): Promise<any> | any;   // resolve direct-dispatch fn
  rdp0(i: number): any;                 // resolve w/o init (same-class call sites)
  rdc(c: unknown[], k: number, i: number, from?: number): Promise<any> | any; // rdp into a hot method's site cache
  rdc0(c: unknown[], k: number, i: number): any;
  rsf(i: number, from?: number): Promise<any> | any;   // resolve+init static field owner ctor
  ics(i: number): any;                  // link an invoke-custom call site
}

function siteCache(c: unknown[], k: number, fn: Cells): unknown {
  fn.$c?.push(c, k);
  return (c[k] = fn);
}

/** development and test builds make a read of a field a native class lacks throw, when it happens */
const STRICT_FIELDS = process.env.NODE_ENV !== "production";
/** how long a cross-chain clinit wait runs before it is presumed a same-chain cycle */
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
  /** current-thread hooks (set by jlang): a compiled frame pins its thread after every await
   *  (st) and releases it when it suspends (su), so a parked worker never leaves its identity
   *  behind for the native main-thread drivers that resume next */
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
   * A compiled frame whose callee suspended: release the thread, and once `pending` settles
   * continue the saved frame in the method's resumable body, at resume point `r` (or at `next`
   * when 0).
   */
  /** a hot frame suspending at site `r` (0: a fuel yield, waiting on `fu`), with registers `v` */
  dfr(resume: () => ResumeBody, self: unknown, r: number, next: number, th: unknown, t: unknown, u: unknown, ex: unknown,
    fu: Promise<unknown>, ...v: unknown[]): Promise<unknown> {
    this.su(th);
    const pending = (r ? u instanceof Promise ? u : t : fu) as Promise<unknown>;
    const F = { v, next, r, $th: th, $s: 1, $t: t, $u: u, $ex: ex, val: undefined as unknown, e: false, x: undefined as unknown };
    return suspendWith(pending, (value, threw) => {
      if (threw) { F.e = true; F.x = value; } else F.val = value;
      return resume().call(self, F);
    });
  }
  fuel = 4096;
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
    if (isBytecode(spec.name)) return;   // provenance says AOSP's own bytecode answers for this
    if (this.classes.has(spec.name)) console.warn("[webdroid] native registered after link:", spec.name);
    this.natives.set(spec.name, spec);
    this.ifaceNames = null;
  }
  markers(...names: string[]) { for (const name of names) this.register({ name, ctor: class extends JObj {} }); }
  make(cls: string): any { return new (this.link(cls).ctor)(); }
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

  dexLink(dex: DexFile): DexLink {
    let d = this.links.get(dex);
    if (d) return d;
    const R = this;
    d = {
      dex,
      cl: new Array(dex.typeCount), ic: new Array(dex.typeCount),
      s: dex.cachedStrings, dp: [], fs: [], cs: [], info: new Array(dex.typeCount),
      gs(i) { return dex.string(i); },
      linfo(i) { return this.info[i] ?? (this.info[i] = R.link(descToName(dex.type(i)))); },
      link(i) { return (this.cl[i] = this.linfo(i).ctor); },
      init(i, from) {
        const info = this.linfo(i);
        // ART fails the resolution itself, so the call site re-throws every time: never cache
        if (info.stub) throw R.ncdfe(info.name);
        if (info.state === 2) return (this.ic[i] = info.ctor);
        // only cache once fully inited — a mid-init hit must keep going through init()
        const done = () => (info.state === 2 ? (this.ic[i] = info.ctor) : info.ctor);
        const p = R.initClass(info, from === undefined ? undefined : this.linfo(from));
        return p ? p.then(done) : done();
      },
      rdp(i, from) {
        const info = this.linfo(dex.method(i).cls);
        if (info.state === 2) return this.rdp0(i);
        const p = R.initClass(info, from === undefined ? undefined : this.linfo(from));
        return p ? p.then(() => this.rdp0(i)) : this.rdp0(i);
      },
      rdp0(i) {
        const m = dex.method(i);
        const info = this.linfo(m.cls);
        if (info.stub) throw R.ncdfe(info.name);
        R.ensureCompiled(info);
        const proto = info.ctor.prototype, mangled = mangleMethod(m.name, dex.methodDesc(i));
        const fn: Cells | undefined = proto[mangled];
        if (!fn) throw R.unimplemented(`${info.name}.${m.name}${dex.methodDesc(i)} (direct)`);
        fn.$c?.push(this.dp, i);
        const direct = directName(info.name, mangled);
        if (!Object.hasOwn(proto, direct)) { proto[direct] = fn; fn.$c?.push(proto, direct); }
        return (this.dp[i] = fn);
      },
      // dp is sparse, so V8 keeps it in dictionary mode; a hot site reads its own dense slot
      rdc(c, k, i, from) {
        const fn = this.dp[i] ?? this.rdp(i, from);
        return fn instanceof Promise ? fn : siteCache(c, k, fn);
      },
      rdc0(c, k, i) { return siteCache(c, k, this.dp[i] ?? this.rdp0(i)); },
      rsf(i, from) {
        const fr = dex.field(i);
        const start = this.linfo(fr.cls);
        if (start.stub) throw R.ncdfe(start.name);
        const owner = findStaticOwner(start, fr.name, dex.type(fr.type))?.info ?? start;
        if (owner.state === 2) return (this.fs[i] = owner.ctor);
        const set = () => (owner.state === 2 ? (this.fs[i] = owner.ctor) : owner.ctor);
        const p = R.initClass(owner, from === undefined ? undefined : this.linfo(from));
        return p ? p.then(set) : set();
      },
      ics(i) { return (this.cs[i] = R.linkCallSite(R, dex, i)); },
    };
    this.links.set(dex, d);
    return d;
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
  loadNativeLib: ((lib: string, bytes: Uint8Array, abi: string, owner?: Runtime, thread?: unknown) => Promise<void>) | null = null;
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
      : new Function("S", `return class extends S {constructor(){super();${fieldsInit}}}`)(info.superInfo?.ctor ?? JObj);
    info.ctor.$i = info;
    const staticNames = new Map<string, number>();
    for (const f of def.staticFields) {
      const name = dex.field(f.fieldIdx).name;
      staticNames.set(name, (staticNames.get(name) ?? 0) + 1);
    }
    for (const f of def.staticFields) {
      const fr = dex.field(f.fieldIdx);
      const desc = dex.type(fr.type), prop = mangleStaticField(fr.name, staticNames.get(fr.name)! > 1 ? desc : undefined);
      info.staticFieldTable.set(fr.name + ":" + desc, prop);
      info.ctor[prop] = defaultValue(desc);
    }
    return info;
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
    info.state = spec.clinit ? 0 : 2;
    info.compiled = true;
    if (this.platformClasses.has(info.name)) this.fallThrough(info);
  }

  /**
   * A native spec that leaves out a method the platform class declares answers with the
   * platform's: its body, compiled against the native object on first call, or its JNI binding
   * when the platform declares it native. Only gaps are filled: a virtual method or constructor
   * the prototype chain already reaches keeps its native implementation.
   */
  private fallThrough(info: ClassInfo) {
    const { dex, def } = this.classDefOf(info.name)!;
    const proto = info.ctor.prototype;
    // the platform's compile-time constants (encoded static values) for statics the spec omits
    if (def.staticValuesOff) dex.encodedArray(def.staticValuesOff).forEach((value, i) => {
      const prop = mangleStaticField(dex.field(def.staticFields[i].fieldIdx).name);
      if (!Object.hasOwn(info.ctor, prop)) info.ctor[prop] = this.encToJs(dex, value);
    });
    const lists = [def.directMethods, def.virtualMethods], R = this, cls = info.name;
    const fill = ([list, index, mangled, kind]: Gap) => {
      const m = lists[list][index], isStatic = (m.flags & ACC.STATIC) !== 0, target = isStatic ? info.ctor : proto;
      if (kind === 2) { target[mangled] = info.superInfo!.ctor.prototype[mangled]; return; }
      if (!isStatic) info.ownMethods.push(mangled);
      if (kind === 0) { installLazy(this, dex, info, m, true, mangled); return; }
      target[mangled] = function (this: unknown, ...args: unknown[]) {
        const { name, desc } = methodKey(dex, m.methodIdx), fn = R.jniFn(cls, name + desc);
        if (!fn) throw R.ulink(cls, name, desc);
        return (target[mangled] = fn).apply(this, args as never[]);
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
      if (name === "<clinit>" || (own ? Object.hasOwn(target, mangled) : mangled in target)) return;
      // a spec whose JS class does not extend its declared superclass's still inherits from it
      const gap: Gap = [l, index, mangled, !own && info.superInfo?.ctor?.prototype?.[mangled] ? 2 : m.flags & ACC.NATIVE ? 1 : 0];
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
    const p = timed
      ? Promise.race([info.initP!, new Promise<void>((res) => {
          // short escape: legit cross-chain waits resolve in microtasks; anything longer
          // is almost certainly a same-chain clinit cycle through methods we can't tag.
          // Remember it so the next several hundred accesses don't each pay the timeout.
          // The timer must be cleared when the race is won: left armed, it would mark a class
          // reentrant after a healthy wait, and later reads would stop waiting for a <clinit>
          // that really is in flight.
          esc = setTimeout(() => { console.warn("[webdroid] clinit wait timeout (cycle?)", info.name, "waited on by", from?.name); info.assumeReentrant = true; res(); },
                           CLINIT_WAIT_MS);
        })])
      : info.initP!;
    const done = () => { if (esc !== undefined) clearTimeout(esc); clear(); };
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
      // BufferedChannelKt's <clinit> builds NULL_SEGMENT).
      if (info.initThread === this.th()) return null;
      // clinit cycle (info's chain transitively waits on `from`) → JVM same-thread
      // semantics: proceed with partial statics instead of deadlocking. A loop in the wait
      // chain (two threads' clinits waiting on each other, which a JVM would deadlock on) also
      // proceeds with partial statics rather than hanging the page.
      for (let c = info.waitingOn, n = 0; c; c = c.waitingOn) if (c === from || ++n > 64) return null;
      // JVM: only the initializing thread may proceed on a class mid-<clinit>; every other
      // thread blocks until it completes, however long a heavy static initializer takes. The
      // timed escape stays for the same thread, where a cycle through untagged methods is
      // indistinguishable from a wait that will never end.
      return this.awaitInit(info, from, info.initThread === this.th());
    }
    if (info.state !== 0) {
      if (info.state === 3) throw Object.assign(this.mkThrowable("java/lang/NoClassDefFoundError",
        `Rejecting re-init on previously-failed class java.lang.Class<${dotName(info.name)}>`), { cause: info.initError });
      return null;
    }
    info.state = 1;
    info.initThread = this.th();

    // Initialize synchronously for as long as nothing actually suspends: only the step that
    // really yields gets a promise, and the rest of the sequence continues from there. An
    // always-async initializer would make every first touch of a class await, so no method
    // containing an sget, a new-instance or an invoke-static could run synchronously.
    const rest = (): Promise<void> | null => {
      const outer = this.clinitDepth++ === 0, started = outer ? performance.now() : 0;
      try { return this.runClinit(info); }
      finally { this.clinitDepth--; if (outer) perf.clinitMs += performance.now() - started; }
    };

    const settle = () => { info.state = 2; info.initP = null; info.initThread = null; info.assumeReentrant = false; };
    /** JLS 12.4.2: the class becomes erroneous; an Exception reaches the caller wrapped in an
     *  ExceptionInInitializerError, and every later initialization fails with NoClassDefFoundError */
    const failed = (e: unknown) => {
      settle();
      info.state = 3;
      const t = this.jx(e);
      console.warn("[webdroid clinit-failed]", info.name, t);
      return info.initError = this.iof(t, "java/lang/Error") ? t : Object.assign(this.mkThrowable("java/lang/ExceptionInInitializerError", null), { cause: t });
    };
    /** hand the remaining steps to the microtask queue, from the one that yielded */
    const async = (pending: Promise<unknown>, after: (() => Promise<void> | null) | null): Promise<void> => {
      info.initP = (async () => {
        try {
          await pending;
          const more = after?.();
          if (more) await more;
        } catch (e) { throw failed(e); }
        settle();
      })();
      return from ? this.awaitInit(info, from, false) : info.initP;
    };

    try {
      const sup = info.superInfo && info.superInfo.state !== 2 ? this.initClass(info.superInfo, info) : null;
      if (sup) return async(sup, rest);
      const pending = rest();
      if (pending) return async(pending, null);
    } catch (e) { throw failed(e); }
    settle();
    return null;
  }

  /** the class's own initialization: constant statics, then <clinit> or the native clinit hook */
  private runClinit(info: ClassInfo): Promise<void> | null {
    for (const i of info.interfaces) this.ensureCompiled(i);   // defaults copy down
    this.ensureCompiled(info);
    let r: unknown;
    if (info.native) {
      const spec = this.natives.get(info.name);
      if (spec?.clinit) r = spec.clinit();
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
      if (/array length|Invalid typed array/i.test(e.message)) {
        return this.mkThrowable("java/lang/NegativeArraySizeException", e.message);
      }
    }
    if (e instanceof Error) return this.mkThrowable("java/lang/InternalError", e.message + "\n" + e.stack);
    return this.mkThrowable("java/lang/InternalError", String(e));
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

  /** instance-of at a compiled site: caches the receiver's class with its answer (object arrays
   *  carry their element type per instance, so they are never cached) */
  iofc(v: unknown, name: string, ic: unknown[], k: number): number {
    const r = this.iof(v, name);
    if (v != null && !Array.isArray(v)) { ic[k] = (v as object).constructor; ic[k + 1] = r; }
    return r;
  }
  /** check-cast at a compiled site: caches a receiver class that passed */
  ccc(v: unknown, name: string, ic: unknown[], k: number): void {
    this.cc(v, name);
    if (!Array.isArray(v)) ic[k] = (v as object).constructor;
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
  /** object array with element-type tag */
  oa(len: number, t: string): unknown[] {
    if (len < 0) throw this.mkThrowable("java/lang/NegativeArraySizeException", String(len));
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
    return yieldToLoop();
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
  /** String.<init> replacement (see compiler special-case) */
  newStr(desc: string, args: unknown[]): string {
    switch (desc) {
      case "()V": return "";
      case "(Ljava/lang/String;)V": return args[0] as string;
      case "(Ljava/lang/StringBuilder;)V": case "(Ljava/lang/StringBuffer;)V":
        return String(args[0]);
      case "([C)V": return charsToString(args[0] as Uint16Array, 0, (args[0] as Uint16Array).length);
      case "([CII)V": return this.strChars(args[0] as Uint16Array, args[1] as number, args[2] as number);
      case "([B)V": return utf8.dec.decode(args[0] as Int8Array);
      case "([BI)V": case "([BIII)V": {
        const bytes = args[0] as Int8Array;
        if (!bytes) throw this.mkThrowable("java/lang/NullPointerException", "ascii");
        const high = (args[1] as number) << 8;
        const off = desc === "([BI)V" ? 0 : args[2] as number;
        const count = desc === "([BI)V" ? bytes.length : args[3] as number;
        if (off < 0 || count < 0 || off > bytes.length - count)
          throw this.mkThrowable("java/lang/StringIndexOutOfBoundsException", "offset/count");
        const chars = new Uint16Array(count);
        for (let i = 0; i < count; i++) chars[i] = high | (bytes[off + i] & 255);
        return charsToString(chars, 0, count);
      }
      case "([BII)V": {
        const b = args[0] as Int8Array;
        return utf8.dec.decode(b.subarray(args[1] as number, (args[1] as number) + (args[2] as number)));
      }
      case "([BLjava/lang/String;)V": case "([BLjava/nio/charset/Charset;)V":
        return decodeString(args[0] as Int8Array, args[1]);
      case "([BIILjava/lang/String;)V": case "([BIILjava/nio/charset/Charset;)V": {
        const b = args[0] as Int8Array;
        return decodeString(b.subarray(args[1] as number, (args[1] as number) + (args[2] as number)), args[3]);
      }
      // code points, not chars: each element is a whole Unicode scalar
      case "([III)V": {
        const cp = args[0] as Int32Array, off = args[1] as number, n = args[2] as number;
        let out = "";
        for (let i = 0; i < n; i++) out += String.fromCodePoint(cp[off + i]);
        return out;
      }
      default: throw this.unimplemented("String.<init>" + desc);
    }
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

function instanceFieldOf(start: ClassInfo, name: string): string | undefined {
  for (let info: ClassInfo | null = start; info; info = info.superInfo) {
    const prop = info.fieldTable.get(name);
    if (prop) return prop;
  }
  return undefined;
}

function findStaticOwner(start: ClassInfo, name: string, desc: string): { info: ClassInfo; prop: string } | null {
  let info: ClassInfo | null = start;
  while (info) {
    const prop = info.staticFieldTable.get(name + ":" + desc) ?? (info.native ? mangleStaticField(name) : null);
    if (prop && Object.hasOwn(info.ctor, prop)) return { info, prop };
    for (const iface of info.interfaces) {
      const r = findStaticOwner(iface, name, desc);
      if (r) return r;
    }
    info = info.superInfo;
  }
  return null;
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

/** A native implemented as a generator (see Runtime.drive), callable like any other method.
 *  It forwards every argument: caller-sensitive natives receive the caller's Runtime past their
 *  declared (often defaulted) parameters. */
export function driven<A extends unknown[], T>(g: (this: any, ...a: A) => Gen<T>): (this: any, ...a: A) => Driven<T> {
  // $g: the generator, whose source the override-bypass lint reads
  return Object.assign(function (this: unknown) { return rt.drive(g.apply(this, arguments as unknown as A)) as Driven<T>; }, { $g: g });
}
/** A driven generator's result: its value or a Promise of it (unknown for an untyped `Gen`). */
type Driven<T> = unknown extends T ? unknown : T | Promise<T>;
