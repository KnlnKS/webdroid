// The registry host code shares with the Wasm tier: the native specs and JNI functions the natives modules register, what Java reaches that
// nothing implements, the class path's resources, and the conversions natives make (strings, thrown JS errors).

import { Strand, suspendWith } from "./suspend.ts";
import { decodeString } from "./charset.ts";
import { charsToString, dotName, oomMessage } from "./abi.ts";
import { isBytecode, isStageD } from "./provenance.ts";

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
  /** "name(Ldesc;)V" or "static name(...)..." or "<init>(...)V" → impl fn (this = receiver) or alias to prototype prop */
  methods?: Record<string, ((...a: never[]) => unknown) | string>;
  statics?: Record<string, unknown>;
  /** java-visible public instance fields: java name → JS property name on the TS class */
  fields?: Record<string, string> | string[];
  /** the platform class's `<clinit>` runs at init, so its statics are the platform's */
  platformClinit?: boolean;
}

/** A native written as a generator yields each Java result, value or Promise (Runtime.drive). */
export type Gen<T = any> = Generator<unknown, T, any>;
/** the value of `v` once it settles, typed: `yield* awaited(x)` where `yield x` is any */
export function* awaited<T>(v: T | Promise<T>): Gen<T> { return yield v; }
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
  /** makes a Java exception by class name (set by the Wasm tier's host); before a World, an Error that carries the class and message as a throwable does */
  mkThrowable: (cls: string, msg: string | null) => any = (cls, msg) => Object.assign(new Error(`${cls}: ${msg}`), { $javaClass: cls, msg });
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
   * suspends again.
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
        return suspendWith(value, (v, threw) => { this.st(strand); return this.driveStep(g, v, threw, strand, true); }) as Promise<T>;
      }
      input = value; threw = false;
    }
  }
  register(spec: NativeSpec) {
    if (isBytecode(spec.name)) {   // provenance says AOSP's own bytecode answers for this
      if (isStageD(spec.name)) console.warn("[webdroid] native spec Stage D always withholds:", spec.name);
      return;
    }
    this.natives.set(spec.name, spec);
    this.registered?.(spec);
  }
  /** a spec registered after the World was made (a module a split bundle loads later) */
  registered?: (spec: NativeSpec) => void;
  /** an instance of `cls`, its constructor not run (set by the Wasm tier's host) */
  make: (cls: string) => any = (cls) => { throw new Error(`no World makes ${cls}`); };

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
  loadNativeLib: ((lib: string, bytes: Uint8Array, abi: string, caller?: unknown) => Promise<void>) | null = null;
  /** the ABIs the native tier can actually execute, most-preferred first. Empty until
   *  src/native/loader.ts is imported, which is the only thing that can answer it. */
  nativeAbis: readonly string[] = [];
  /** a native method nothing registered — what calling it throws */
  ulink(cls: string, name: string, desc: string): Error {
    this.noteMissing(cls + "." + name + desc + " [native]");
    return this.mkThrowable("java/lang/UnsatisfiedLinkError", "No implementation found for " + dotName(cls) + "." + name + desc);
  }

  /** the Java frames calling into the runtime here, innermost first, and the loader of the innermost one whose class is not the platform's (set by the World) */
  javaFrames: () => string[] = () => [];
  userClassLoader: () => object | null = () => null;
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
  trackPlaceholder<F extends Function>(what: string, fn: F, uninstall: (wrapper: F) => void = () => {}): F {
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

  unimplemented(what: string): Error {
    this.noteMissing(what);
    return this.mkThrowable("java/lang/UnsupportedOperationException", "webdroid missing: " + what);
  }

  /** the handle-table owner hook (src/android/handles.ts) */
  claimHandle?: (owner: object, h: bigint) => void;
  /** java.lang.Class object for a class name (set by the Wasm tier's host) */
  classFor: (name: string) => any = (name) => { throw new Error(`no World has the Class of ${name}`); };

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
    "(Ljava/lang/StringBuilder;)V": (sb: { s: string } | null) => (sb ?? this.npe()).s,
    "(Ljava/lang/StringBuffer;)V": (sb: { s: string } | null) => (sb ?? this.npe()).s,
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
}

export const rt = new Runtime();

const declaredFields = new Map<string, string>();
/** the property holding `cls`'s instance field `name`, whether a spec maps it or bytecode keeps it;
 *  "" when the class has none */
export function declaredField(cls: string, name: string): string {
  const key = cls + "." + name;
  let prop = declaredFields.get(key);
  if (prop === undefined) declaredFields.set(key, prop = fieldNames.find?.(cls, name) ?? "");
  return prop;
}
/** a reader of `cls`'s instance field `name` for a native that reads it on every call, such as the
 *  handle of a Java object's native peer: the property is resolved on first use */
export function peerField<T>(cls: string, name: string): (o: object) => T {
  let prop = "";
  return (o) => (o as Record<string, T>)[prop ||= declaredField(cls, name)];
}
/** how the World names an instance field, which a facade of the object answers under that name */
export const fieldNames = { find: null as ((cls: string, name: string) => string | undefined) | null };
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
 *  `$g` is the generator itself, which the Wasm host runs on a suspendable strand. */
export function driven<A extends unknown[], T>(g: (this: any, ...a: A) => Gen<T>): (this: any, ...a: A) => Driven<T> {
  return Object.assign(function (this: unknown) { return rt.drive(g.apply(this, arguments as unknown as A)) as Driven<T>; }, { $g: g });
}
/** A driven generator's result: its value or a Promise of it (unknown for an untyped `Gen`). */
type Driven<T> = unknown extends T ? unknown : T | Promise<T>;
/** Marks native `fn`, which answers a Promise for some calls though it is neither `driven` nor async (it hands on an `after`
 *  or `awaited` result): the Wasm tier imports it as Suspending rather than parking the strand that called it. */
export const waits = <F extends Function>(fn: F): F => Object.assign(fn, { $waits: true });
export const isWaiting = (fn: Function): boolean => (fn as { $waits?: boolean }).$waits === true;
