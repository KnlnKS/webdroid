// The registry host code shares with the Wasm tier: the native specs and JNI functions the natives modules register, what Java reaches that
// nothing implements, the class path's resources, and the throwables natives make of thrown JS errors.

import { Strand } from "./suspend.ts";
import { never, processExited } from "../process-exit.ts";
import { dotName, oomMessage, type NativeImpl } from "./abi.ts";
import { java } from "./javahost.ts";

/** Root of the host's Java objects: a native spec's class, or an object a native makes by class name (`$i` names the Java class). */
export class JObj {
  declare static $i: { name: string };
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
  /** "name(Ldesc;)V" or "static name(...)..." or "<init>(...)V" → impl fn (this = receiver) */
  methods?: Record<string, (...a: never[]) => unknown>;
  statics?: Record<string, unknown>;
  /** java-visible public instance fields: java name → JS property name on the TS class */
  fields?: Record<string, string>;
  /** the platform class's `<clinit>` runs at init, so its statics are the platform's */
  platformClinit?: boolean;
}

/** A native written as a generator yields each Java result, value or Promise (Runtime.drive). */
export type Gen<T = any> = Generator<unknown, T, any>;
/** the value of `v` once it settles, typed: `yield* awaited(x)` where `yield x` is any */
export function* awaited<T>(v: T | Promise<T>): Gen<T> { return yield v; }

/** what an authoring helper (driven, waits, retries, javaValues, ranged, stubs) declares of a native function, which its registration reads */
type Declared = Omit<NativeImpl, "fn"> & { body?: Function };
const declarations = new WeakMap<Function, Declared>();
const declare = <F extends Function>(fn: F, d: Declared): F => { declarations.set(fn, { ...declarations.get(fn), ...d }); return fn; };
/** the code a native was written as: the generator of a `driven` one */
export const bodyOf = (fn: Function): Function => declarations.get(fn)?.body ?? fn;
const AsyncFunction = (async () => {}).constructor;

export function stubs(value: unknown, ...sigs: string[]): Record<string, () => unknown> {
  const fn = declare(() => value, { placeholder: true });
  return Object.fromEntries(sigs.map((s) => [s, fn]));
}
export const noops = (...sigs: string[]) => stubs(undefined, ...sigs);
/** natives that by design do nothing here: no placeholder, so reaching one is no gap */
export function noEffect(...sigs: string[]): Record<string, () => void> {
  const fn = () => {};
  return Object.fromEntries(sigs.map((s) => [s, fn]));
}
type Accessor = (this: any, v?: unknown) => unknown;
const accessors = (t: Record<string, string>, make: (f: string) => Accessor) => Object.fromEntries(Object.entries(t).map(([s, f]) => [s, make(f)]));
export const fieldGetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any) { return this[f]; });
export const fieldSetters = (t: Record<string, string>) => accessors(t, (f) => function (this: any, v?: unknown) { this[f] = v; });


export class Runtime {
  natives = new Map<string, NativeSpec>();
  missing = new Set<string>();
  /** the booted apk's entries: what ClassLoader.getResourceAsStream and ServiceLoader read */
  classpath: Record<string, Uint8Array> = {};
  classpathSource: { has(name: string): boolean; entry(name: string): Promise<Uint8Array | null>; entrySize(name: string): number; names(): string[] } | null = null;
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
  /** makes a Java exception by class name; before a World, an Error that carries the class and message as a throwable does */
  mkThrowable(cls: string, msg: string | null): any { return java.throwable(cls, msg); }
  /** an instance of `cls`, its constructor not run */
  make(cls: string): any { return java.make(cls); }
  /** java.lang.Class object for a class name */
  classFor(name: string): any { return java.classFor(name); }
  /** report listeners: the reports reach the console either way */
  onMissing: (what: string) => void = () => {};
  onNativeRequired: (lib: string, abi: string) => void = () => {};
  onUncaught: (throwable: unknown) => void = () => {};
  /** the running strand, a thread as one call chain (set by jentry) */
  cur = new Strand(null, true);
  /** strand hooks (set by jentry): a resumed native takes its strand (st) and releases it when it finishes or suspends again (su) */
  st: (s: Strand) => void = () => {};
  su: () => void = () => {};
  /** `f` with `s` as the running strand */
  within<T>(s: Strand, f: () => T): T {
    const was = this.cur;
    this.cur = s;
    try { return f(); } finally { if (this.cur === s) this.cur = was; }
  }
  /**
   * Run a native written as a generator whose `yield` takes a Java result that may be a Promise:
   * it stays synchronous until one is, and only then returns a Promise. Like a compiled frame, a
   * resumed native runs as the strand that entered it and releases it when it finishes or
   * suspends again; nothing resumes once the process has exited.
   */
  drive<T>(g: Gen<T>): T | Promise<T> { return this.driveStep(g, undefined, false, this.cur, false); }
  private driveStep<T>(g: Gen<T>, input: unknown, threw: boolean, strand: Strand, resumed: boolean): T | Promise<T> {
    for (;;) {
      let step: IteratorResult<unknown, T>;
      try { step = threw ? g.throw(input) : g.next(input); }
      catch (e) { if (resumed) this.su(); throw e; }
      if (step.done) { if (resumed) this.su(); return step.value; }
      const value = step.value;
      if (value instanceof Promise) {
        if (resumed) this.su();
        return value.then((v) => this.resumeStep(g, v, false, strand), (e) => this.resumeStep(g, e, true, strand));
      }
      input = value; threw = false;
    }
  }
  private resumeStep<T>(g: Gen<T>, input: unknown, threw: boolean, strand: Strand): T | Promise<T> {
    if (processExited()) return never();
    this.st(strand);
    return this.driveStep(g, input, threw, strand, true);
  }
  /** a class the host implements, once */
  register(spec: NativeSpec) {
    if (this.natives.has(spec.name)) throw new Error(`${spec.name} is registered twice`);
    this.natives.set(spec.name, spec);
    for (const [key, fn] of Object.entries(spec.methods ?? {})) this.specImpls.set(spec.name + "|" + key, this.impl(`${spec.name}.${key}`, fn));
    java.registered(spec);
  }
  /** the specs' methods by "cls|key", a static one's key prefixed "static " */
  private specImpls = new Map<string, NativeImpl>();
  specNative(cls: string, key: string, isStatic: boolean): NativeImpl | undefined { return this.specImpls.get(cls + "|" + (isStatic ? "static " : "") + key); }
  /** `fn` as registered: what its authoring helpers declared, and for a placeholder a stand-in that records its first hit */
  private impl(what: string, fn: Function): NativeImpl {
    const d = declarations.get(fn), impl: NativeImpl = { fn: fn as NativeImpl["fn"], wait: fn.constructor === AsyncFunction ? "always" : d?.wait, raw: d?.raw, ranges: d?.ranges };
    if (!d?.placeholder) return impl;
    impl.placeholder = true;
    const R = this;
    impl.fn = function (this: unknown, ...args: unknown[]) {
      impl.fn = fn as NativeImpl["fn"];
      if (!R.placeholders.has(what)) { R.placeholders.add(what); R.placeholderAt.set(what, java.javaFrames().slice(0, 12)); }
      return fn.apply(this, args);
    };
    return impl;
  }

  /** JNI registry: implementations for dex-declared native methods (key "cls|name+desc") */
  jni = new Map<string, NativeImpl>();
  /** `replace`: `fn` replaces the native registered before (JNI's RegisterNatives does), which is otherwise a conflict */
  registerJni(cls: string, sig: string, fn: (...a: never[]) => unknown, replace = false) {
    const key = cls + "|" + sig;
    if (!replace && this.jni.has(key)) throw new Error(`${cls}.${sig} is registered twice`);
    this.jni.set(key, this.impl(`${cls}.${sig}`, fn));
  }
  /** register the native halves of one class, by their exact descriptors */
  registerJnis(cls: string, table: Record<string, unknown>) {
    for (const [sig, fn] of Object.entries(table)) this.registerJni(cls, sig, fn as (...a: never[]) => unknown);
  }
  /** classes whose natives one resolver makes from their descriptors (the GL bindings), each registered when first asked for */
  private families = new Map<string, (sig: string) => ((...a: never[]) => unknown) | null>();
  registerJniFamily(cls: string, resolve: (sig: string) => ((...a: never[]) => unknown) | null) { this.families.set(cls, resolve); }
  jniNative(cls: string, sig: string): NativeImpl | null {
    const key = cls + "|" + sig, own = this.jni.get(key);
    if (own) return own;
    const made = this.families.get(cls)?.(sig);
    if (made) { this.registerJni(cls, sig, made); return this.jni.get(key)!; }
    return this.jniResolver?.(cls, sig) ?? null;
  }
  /** set by the native tier: resolve a native by its JNI short-name export (`Java_pkg_Cls_m`) in a loaded library */
  jniResolver: ((cls: string, sig: string) => NativeImpl | null) | null = null;
  /** library names (System.loadLibrary spelling) whose natives a TS shim provides */
  nativeLibs = new Set<string>();
  claimNativeLib(name: string) { this.nativeLibs.add(name); }
  /** .so files the app tried to load that only exist as machine code: file → abi */
  nativeRequired = new Map<string, string>();
  /** set by src/native/loader.ts: loads a machine-code library for an ABI it can run (loadLibrary
   *  consults it before giving up). `thread` is the Java thread that asked: its Cpu runs the
   *  initialisers, whichever thread is current by then. */
  loadNativeLib: ((lib: string, bytes: Uint8Array, abi: string, caller?: unknown) => Promise<void>) | null = null;
  /** the ABIs the native tier can actually execute, most-preferred first. Empty until
   *  src/native/loader.ts is imported, which is the only thing that can answer it. */
  nativeAbis: readonly string[] = [];
  /** a native method nothing registered — what calling it throws */
  ulink(cls: string, name: string, desc: string): Error {
    this.noteMissing(cls + "." + name + desc + " [native]");
    return this.mkThrowable("java/lang/UnsatisfiedLinkError", "No implementation found for " + dotName(cls) + "." + name + desc);
  }

  /** where each missing entry was first reached */
  missingAt = new Map<string, string[]>();
  noteMissing(what: string) {
    if (!this.missing.has(what)) {
      this.missing.add(what);
      const at = java.javaFrames().slice(0, 12);
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

  unimplemented(what: string): Error {
    this.noteMissing(what);
    return this.mkThrowable("java/lang/UnsupportedOperationException", "webdroid missing: " + what);
  }


  /** normalize a thrown JS value to a Java throwable */
  jx(e: unknown): any {
    if (e instanceof JObj) return e;
    if (typeof e === "object" && e !== null && (e as any).$javaClass) return e;
    if (e instanceof TypeError) {
      const m = e.message;
      // V8: "Cannot read properties of null"; JavaScriptCore (Safari): "null is not an object"
      if (/null|undefined/.test(m) && /read|call|properties|is not an object/i.test(m)) {
        return this.mkThrowable("java/lang/NullPointerException", m);
      }
      if (/is not a function/.test(m)) {
        this.noteMissing(m);
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
    return this.mkThrowable("java/lang/OutOfMemoryError", oomMessage(bytes));
  }

  npe(): never { throw this.mkThrowable("java/lang/NullPointerException", null); }
}

export const rt = new Runtime();

const declaredFields = new Map<string, string>();
/** the property holding `cls`'s instance field `name`, whether a spec maps it or bytecode keeps it;
 *  "" when the class has none */
export function declaredField(cls: string, name: string): string {
  const key = cls + "." + name;
  let prop = declaredFields.get(key);
  if (prop === undefined) declaredFields.set(key, prop = java.fieldName(cls, name) ?? "");
  return prop;
}
/** `cls`'s instance field `name` for a native that reads or writes it on every call, such as the
 *  handle of a Java object's native peer: the property is resolved on first use */
export function instanceField<T>(cls: string, name: string): { get(o: object): T; set(o: object, v: T): void } {
  let prop = "";
  return {
    get: (o) => (o as Record<string, T>)[prop ||= declaredField(cls, name)],
    set: (o, v) => { (o as Record<string, T>)[prop ||= declaredField(cls, name)] = v; },
  };
}
export const peerField = <T>(cls: string, name: string): ((o: object) => T) => instanceField<T>(cls, name).get;
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

/** A native implemented as a generator (see Runtime.drive), callable like any other method; it may wait. */
export function driven<A extends unknown[], T>(g: (this: any, ...a: A) => Gen<T>): (this: any, ...a: A) => Driven<T> {
  return declare(function (this: unknown) { return rt.drive(g.apply(this, arguments as unknown as A)) as Driven<T>; }, { wait: "maybe", body: g });
}
/** A driven generator's result: its value or a Promise of it (unknown for an untyped `Gen`). */
type Driven<T> = unknown extends T ? unknown : T | Promise<T>;
/** Marks native `fn`, which answers a Promise for some calls though it is neither `driven` nor async (it hands on an `after`
 *  or `awaited` result): the Wasm tier imports it as Suspending rather than parking the strand that called it. */
export const waits = <F extends Function>(fn: F): F => declare(fn, { wait: "maybe" });
/** Marks native `fn`, which answers a Promise only while something it reads loads (a font), having had no other effect: the Wasm tier
 *  imports it plainly, over views of its arrays, and calls it again over fresh views once the Promise settles. */
export const retries = <F extends Function>(fn: F): F => declare(fn, { wait: "retry" });
/** Marks native `fn`, which takes and answers Java values as the Wasm tier holds them (NativeImpl.raw) */
export const javaValues = <F extends Function>(fn: F): F => declare(fn, { raw: true });
/** Marks native `fn`, which touches each array `ranges` names only in its (offset, length) range: (array, offset, length) parameter positions, receiver not
 *  counted. The Wasm tier copies that range alone. */
export const ranged = <F extends Function>(fn: F, ...ranges: [number, number, number][]): F => declare(fn, { ranges });
