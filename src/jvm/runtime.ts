// Class registry, linking, initialization, native registration, and the `R` helper
// surface that compiled code calls. See abi.ts for the value model.
//
// Lifecycle: link (sync: ctor shell + fields + types) → init (async: compile methods,
// run <clinit>). Instances only exist after init, so prototype methods are always
// present when virtual dispatch happens.

import { yieldToLoop } from "./yield";
import { decodeString } from "./charset";
import { DexFile, NO_INDEX, type ClassDef, type EncVal, type EncodedMethod } from "./dex";
import { mangleField, mangleMethod, mangleStaticField, descToName, defaultVal, defaultValue, charsToString, utf8, dotName, demangle, primElem, splitSig } from "./abi";
import { compileClass, compileLazyMethod, methodKey, type Cells, type CompiledCtor } from "./compiler";
import { isBytecode } from "./provenance";
import { perf } from "../perf";
import { jvmCoverage } from "./coverage";
import { Monitors } from "./monitor";

export const ACC = { STATIC: 0x8, NATIVE: 0x100, INTERFACE: 0x200 } as const;
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

export function callSelf(m: NativeSpec["methods"], sig: string, self: unknown, ...args: unknown[]): unknown {
  return (m![sig] as (this: unknown, ...a: unknown[]) => unknown).call(self, ...args);
}

export class ClassInfo {
  staticFieldTable = new Map<string, string>();
  ctor: any;
  superInfo: ClassInfo | null = null;
  interfaces: ClassInfo[] = [];
  types = new Set<string>();          // all names this is assignable to
  state = 0;                          // 0 linked, 1 initing, 2 inited
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
  /** method bodies not yet generated (see compiler emitLazy); undefined when eager */
  lazy?: { m: EncodedMethod; mangled: string; isStatic: boolean; name: string; desc: string; stub: Cells & ((...a: unknown[]) => unknown) }[];
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
  R: Runtime;
  cl: any[];            // typeIdx → linked ctor
  ic: any[];            // typeIdx → inited ctor
  s: readonly (string | undefined)[]; // string cache
  dp: any[];            // methodIdx → direct-invoke prototype fn
  fs: any[];            // fieldIdx → inited owner ctor (static fields declared off-refclass)
  info: ClassInfo[];    // typeIdx → ClassInfo (linked)
  gs(i: number): string;
  link(i: number): any;             // sync: linked ctor
  linfo(i: number): ClassInfo;
  init(i: number, from?: number): Promise<any> | any;  // inited ctor (from = clinit accessor's type)
  rdp(i: number, from?: number): Promise<any> | any;   // resolve direct-dispatch fn
  rdp0(i: number): any;                 // resolve w/o init (same-class call sites)
  rsf(i: number, from?: number): Promise<any> | any;   // resolve+init static field owner ctor
}

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
  classpathSource: { has(name: string): boolean; entry(name: string): Promise<Uint8Array | null> } | null = null;
  hasClasspath(name: string): boolean { return Object.hasOwn(this.classpath, name) || !!this.classpathSource?.has(name); }
  readClasspath(name: string): Uint8Array | null | Promise<Uint8Array | null> {
    return Object.hasOwn(this.classpath, name) ? this.classpath[name] : this.classpathSource?.entry(name) ?? null;
  }
  classpathLocations = new Map<string, string>();
  /** set by jlang: make core exceptions without going through class init */
  mkThrowable: (cls: string, msg: string | null) => any = (cls, msg) => {
    const e = new Error(`${cls}: ${msg}`);
    (e as any).$javaClass = cls;
    return e;
  };
  onMissing: (what: string) => void = () => {};
  /** current-thread hooks (set by jlang): a compiled frame pins its thread after every await
   *  (st) and releases it when it suspends (su), so a parked worker never leaves its identity
   *  behind for the native main-thread drivers that resume next */
  th: () => unknown = () => null;
  monitors = new Monitors((name) => this.mkThrowable("java/lang/" + name, null));
  me(obj: object | string | null | 0) { return this.monitors.enter(obj, this.th()); }
  mx(obj: object | string | null | 0) { this.monitors.exit(obj, this.th()); }
  /** set by jreflect: a reflect.Proxy answers a method it has not materialised yet from the name and descriptor the caller holds */
  proxyMethod: ((obj: unknown, name: string, desc: string) => ((...a: unknown[]) => unknown) | null) | null = null;
  st: (t: unknown) => void = () => {};
  su: (t: unknown) => void = () => {};
  /**
   * Run a native written as a generator whose `yield` takes a Java result that may be a Promise:
   * it stays synchronous until one is, and only then returns a Promise. Like a compiled frame, a
   * resumed native runs on the thread that entered it and releases that thread when it finishes.
   */
  drive<T>(g: Gen<T>): T | Promise<T> { return this.driveStep(g, undefined, false, this.th(), false); }
  private driveStep<T>(g: Gen<T>, input: unknown, threw: boolean, thread: unknown, resumed: boolean): T | Promise<T> {
    for (;;) {
      let step: IteratorResult<unknown, T>;
      try { step = threw ? g.throw(input) : g.next(input); }
      catch (e) { if (resumed) this.su(thread); throw e; }
      if (step.done) { if (resumed) this.su(thread); return step.value; }
      const value = step.value;
      if (value instanceof Promise) return value.then(
        (v) => { this.st(thread); return this.driveStep(g, v, false, thread, true); },
        (e) => { this.st(thread); return this.driveStep(g, e, true, thread, true); });
      input = value; threw = false;
    }
  }
  /** The frame a resumption is re-entering a compiled method with (see dfr). */
  rf: unknown = null;
  /**
   * A compiled frame whose callee suspended: release the thread, and once `pending` settles
   * re-enter `fn` with the saved frame, continuing at resume point `r` (or at `next` when 0).
   */
  dfr(fn: (...a: unknown[]) => unknown, self: unknown, pending: Promise<unknown>, r: number, next: number,
    v: unknown[], th: unknown, t: unknown, u: unknown, ex: unknown): Promise<unknown> {
    this.su(th);
    const F = { v, next, r, $th: th, $s: 1, $t: t, $u: u, $ex: ex, val: undefined as unknown, e: false, x: undefined as unknown };
    const resume = () => {
      const args = new Array<unknown>(fn.length);
      args[fn.length - 1] = F;
      this.rf = F;
      return fn.apply(self, args);
    };
    return pending.then((val) => { F.val = val; return resume(); }, (x) => { F.e = true; F.x = x; return resume(); });
  }
  onUncaught: ((e: unknown) => void) | null = null;
  fuel = 4096;

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
      if (!this.dexIndex.has(name)) {
        this.dexIndex.set(name, dexIndex * CLASS_INDEX_BASE + i);
        if (platform) this.platformClasses.add(name);
      }
    }
  }

  dexAtClassLocation(location: number): DexFile { return this.dexes[Math.floor(location / CLASS_INDEX_BASE)]; }

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
  linkNatives(onError?: (name: string, e: unknown) => void) {
    for (const name of [...this.natives.keys()]) { try { this.link(name); } catch (e) { onError?.(name, e); } }
  }

  dexLink(dex: DexFile): DexLink {
    let d = this.links.get(dex);
    if (d) return d;
    const R = this;
    d = {
      dex, R,
      cl: new Array(dex.typeCount), ic: new Array(dex.typeCount),
      s: dex.cachedStrings, dp: [], fs: [], info: new Array(dex.typeCount),
      gs(i) { return dex.string(i); },
      linfo(i) { return this.info[i] ?? (this.info[i] = R.link(descToName(dex.type(i)))); },
      link(i) { return (this.cl[i] = this.linfo(i).ctor); },
      init(i, from) {
        const info = this.linfo(i);
        // ART fails the resolution itself, so the call site re-throws every time: never cache
        if (info.stub) throw R.ncdfe(info.name);
        // only cache once fully inited — a mid-init hit must keep going through init()
        const done = () => (info.state === 2 ? (this.ic[i] = info.ctor) : info.ctor);
        if (info.state === 2) return (this.ic[i] = info.ctor);
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
        const fn: Cells | undefined = info.ctor.prototype[mangleMethod(m.name, dex.methodDesc(i))];
        if (!fn) throw R.unimplemented(`${info.name}.${m.name}${dex.methodDesc(i)} (direct)`);
        fn.$c?.push(this.dp, i);
        return (this.dp[i] = fn);
      },
      rsf(i, from) {
        const fr = dex.field(i);
        const start = this.linfo(fr.cls);
        if (start.stub) throw R.ncdfe(start.name);
        const owner = findStaticOwner(start, fr.name, dex.type(fr.type))?.info ?? start;
        const set = () => (owner.state === 2 ? (this.fs[i] = owner.ctor) : owner.ctor);
        if (owner.state === 2) return set();
        const p = R.initClass(owner, from === undefined ? undefined : this.linfo(from));
        return p ? p.then(set) : set();
      },
    };
    this.links.set(dex, d);
    return d;
  }

  /** compile-time: mangled property name for an instance field ref */
  resolveInstanceField(dex: DexFile, fieldIdx: number): string {
    const fr = dex.field(fieldIdx);
    const clsName = descToName(dex.type(fr.cls));
    try {
      let info: ClassInfo | null = this.link(clsName);
      while (info) {
        const m = info.fieldTable.get(fr.name);
        if (m) return m;
        info = info.superInfo;
      }
    } catch { /* class missing — fall through */ }
    this.noteMissing(`field ${clsName}.${fr.name}`);
    return mangleField(clsName, fr.name);
  }

  /** compile-time: static field access site info */
  resolveStaticField(dex: DexFile, fieldIdx: number): { prop: string; typeIdx: number } {
    const fr = dex.field(fieldIdx);
    let prop = mangleStaticField(fr.name);
    try {
      const start = this.link(descToName(dex.type(fr.cls)));
      const field = findStaticOwner(start, fr.name, dex.type(fr.type));
      if (field) { prop = field.prop; return { prop, typeIdx: field.info === start ? fr.cls : -1 }; }
    } catch { /* class missing */ }
    return { prop, typeIdx: fr.cls }; // fails at runtime when reached, correct laziness
  }

  /** JNI registry: implementations for dex-declared native methods (key "cls|name+desc") */
  jni = new Map<string, (...a: never[]) => unknown>();
  registerJni(cls: string, sig: string, fn: (...a: never[]) => unknown) { this.jni.set(cls + "|" + sig, fn); }
  jniFn(cls: string, sig: string): ((...a: never[]) => unknown) | null { return this.jni.get(cls + "|" + sig) ?? this.jniResolver?.(cls, sig) ?? null; }
  /** set by the native tier: resolve a native by its JNI short-name export (`Java_pkg_Cls_m`) in a loaded library */
  jniResolver: ((cls: string, sig: string) => ((...a: never[]) => unknown) | null) | null = null;
  /** library names (System.loadLibrary spelling) whose natives a TS shim provides */
  nativeLibs = new Set<string>();
  claimNativeLib(name: string) { this.nativeLibs.add(name); }
  /** .so files the app tried to load that only exist as machine code: file → abi */
  nativeRequired = new Map<string, string>();
  onNativeRequired: (lib: string, abi: string) => void = () => {};
  /** set by src/native/loader.ts: loads a machine-code library for an ABI it can run (loadLibrary consults it before giving up) */
  /** `thread` is the Java thread that asked: its Cpu runs the initialisers, whichever thread is current by then */
  loadNativeLib: ((lib: string, bytes: Uint8Array, abi: string, owner?: Runtime, thread?: unknown) => Promise<void>) | null = null;
  /** the ABIs the native tier can actually execute, most-preferred first. Empty until
   *  src/native/loader.ts is imported, which is the only thing that can answer it. */
  nativeAbis: readonly string[] = [];
  /** a native method nothing registered — what calling it throws */
  ulink(cls: string, name: string, desc: string): Error {
    this.noteMissing(cls + "." + name + desc + " [native]");
    return this.mkThrowable("java/lang/UnsatisfiedLinkError", "No implementation found for " + dotName(cls) + "." + name + desc);
  }

  noteMissing(what: string) {
    if (!this.missing.has(what)) {
      this.missing.add(what);
      console.warn("[webdroid missing]", what);
      this.onMissing(what);
    }
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
    const dex = this.dexAtClassLocation(loc), defIdx = loc & (CLASS_INDEX_BASE - 1);
    const def = dex.classDef(defIdx);
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
      target[mangled] = fn;
      if (!isStatic) info.ownMethods.push(mangled);
    }
    // A static written as a getter is resolved on first READ, not here: link order is
    // registration order, so a static whose value is an instance of another class would
    // otherwise link that class before its own module had registered it — and get a stub.
    // First read replaces the accessor with the value, so identity still holds.
    for (const fname of Object.keys(spec.statics ?? {})) {
      const key = mangleStaticField(fname);
      const d = Object.getOwnPropertyDescriptor(spec.statics!, fname)!;
      if (!d.get) { ctorAny[key] = d.value; continue; }
      const pin = (value: unknown) => Object.defineProperty(ctorAny, key, { value, writable: true, configurable: true });
      Object.defineProperty(ctorAny, key, {
        configurable: true,
        get: () => { const v = d.get!.call(spec.statics); pin(v); return v; },
        set: pin,
      });
    }
    const fl = spec.fields ?? [];
    if (Array.isArray(fl)) for (const n of fl) info.fieldTable.set(n, n);
    else for (const [jname, prop] of Object.entries(fl)) info.fieldTable.set(jname, prop);
    ctorAny.$i = info;
    info.state = spec.clinit ? 0 : 2;
    info.compiled = true;
  }

  private linkArray(desc: string): ClassInfo {
    const info = new ClassInfo(desc);
    this.classes.set(desc, info);
    info.types.add(desc).add("java/lang/Object").add("java/lang/Cloneable").add("java/io/Serializable");
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
          // The timer MUST be cleared when the race is won -- left armed it fired for every
          // healthy wait too, marking classes reentrant that never cycled (so later reads
          // stopped waiting for a clinit that really was in flight) and logging a cycle
          // warning per class per boot.
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
      // BufferedChannelKt's <clinit> builds NULL_SEGMENT) and used to eat the escape timeout.
      if (info.initThread === this.th()) return null;
      // clinit cycle (info's chain transitively waits on `from`) → JVM same-thread
      // semantics: proceed with partial statics instead of deadlocking
      // walk the wait chain; a loop in it (two threads' clinits waiting on each other, which a
      // JVM would deadlock on) also proceeds with partial statics rather than hanging the page
      for (let c = info.waitingOn, n = 0; c; c = c.waitingOn) if (c === from || ++n > 64) return null;
      // JVM: only the initializing thread may proceed on a class mid-<clinit>; every other
      // thread blocks until it completes, however long a heavy static initializer takes. The
      // timed escape stays for the same thread, where a cycle through untagged methods is
      // indistinguishable from a wait that will never end.
      return this.awaitInit(info, from, info.initThread === this.th());
    }
    if (info.state !== 0) return null;
    info.state = 1;
    info.initThread = this.th();

    // Initialize synchronously for as long as nothing actually suspends. This used to be one
    // `(async () => …)()`, which returns a promise whatever the body does — so EVERY first
    // touch of a class forced its toucher to await, and no method containing an sget, a
    // new-instance or an invoke-static could ever compile sync. Only the step that really
    // yields gets a promise now, and the rest of the sequence continues from there.
    const rest = (): Promise<void> | null => {
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
    };

    const settle = () => { info.state = 2; info.initP = null; info.initThread = null; info.assumeReentrant = false; };
    const failed = (e: unknown) => {
      settle();   // ExceptionInInitializerError-ish: don't retry forever
      console.warn("[webdroid clinit-failed]", info.name, e);
    };
    /** hand the remaining steps to the microtask queue, from the one that yielded */
    const async = (pending: Promise<unknown>, after: (() => Promise<void> | null) | null): Promise<void> => {
      info.initP = (async () => {
        try {
          await pending;
          const more = after?.();
          if (more) await more;
          info.state = 2;
        } catch (e) { failed(e); throw e; } finally {
          info.initP = null; info.initThread = null; info.assumeReentrant = false;
        }
      })();
      return from ? this.awaitInit(info, from, false) : info.initP;
    };

    try {
      const sup = info.superInfo && info.superInfo.state !== 2 ? this.initClass(info.superInfo, info) : null;
      if (sup) return async(sup, rest);
      const pending = rest();
      if (pending) return async(pending, null);
    } catch (e) { failed(e); throw e; }
    settle();
    return null;
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
      if (/null|undefined/.test(m) && /read|call|properties/i.test(m)) {
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
  /** fuel check target — yields to the browser event loop */
  private lastYield = 0;
  /** ms between back-edge yields. The frame loop stretches it while a draw pass is in flight:
   *  a yield there only costs a macrotask, since nothing is presented until the pass ends. */
  yieldGap = 8;
  /** Back-edge yield. fuel is a GLOBAL counter, so it trips far more often than once per
   *  100k iterations of any one loop, and each trip was a macrotask (4ms once the chain is
   *  nested) taken while holding the main-looper job. Only actually yield if we have not
   *  yielded recently; otherwise just refill and keep going. */
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
  /** String.<init> replacement (see compiler special-case) */
  newStr(desc: string, args: unknown[]): string {
    switch (desc) {
      case "()V": return "";
      case "(Ljava/lang/String;)V": return args[0] as string;
      case "(Ljava/lang/StringBuilder;)V": case "(Ljava/lang/StringBuffer;)V":
        return String(args[0]);
      case "([C)V": return charsToString(args[0] as Uint16Array, 0, (args[0] as Uint16Array).length);
      case "([CII)V": return charsToString(args[0] as Uint16Array, args[1] as number, args[2] as number);
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

/** A native implemented as a generator (see Runtime.drive), callable like any other method. */
export function driven(g: (this: any, ...a: any[]) => Gen): (this: any, ...a: any[]) => unknown {
  switch (g.length) {
    case 0: return function (this: unknown) { return rt.drive(g.call(this)); };
    case 1: return function (this: unknown, a: unknown) { return rt.drive(g.call(this, a)); };
    case 2: return function (this: unknown, a: unknown, b: unknown) { return rt.drive(g.call(this, a, b)); };
    default: return function (this: unknown, ...a: unknown[]) { return rt.drive(g.apply(this, a)); };
  }
}
