// java.lang.* natives. Convention: Java booleans are 0/1 numbers, longs are BigInt,
// Strings are JS string primitives (String.prototype carries mangled Java methods).

import { rt, JObj, type ClassInfo, type NativeSpec } from "../runtime";
import { mangleMethod, descToName, charsToString, jarray, PRIM_NAME, intBitsToFloat, floatToIntBits, longBitsToDouble, doubleToLongBits } from "../abi";

// dynamic virtual call from native code, with promise guard
export async function vcall(obj: any, name: string, desc: string, ...args: unknown[]): Promise<any> {
  const fn = obj[mangleMethod(name, desc)];
  if (typeof fn !== "function") throw rt.unimplemented(`vcall ${describe(obj)}.${name}${desc}`);
  const r = fn.apply(obj, args);
  return r instanceof Promise ? await r : r;
}
function describe(o: unknown): string {
  return typeof o === "string" ? "String" : ((o as any)?.constructor?.$i?.name ?? String(o));
}
/** link + run <clinit>: the class is ready to be instantiated or have its statics read */
export async function linkInit(cls: string): Promise<ClassInfo> {
  const info = rt.link(cls);
  const p = rt.initClass(info);
  if (p) await p;
  return info;
}
/** `new Cls(args)` from native code: init the class, construct, run the Java constructor `desc` (none when null) */
export async function newObj(cls: string, desc: string | null = "()V", ...args: unknown[]): Promise<any> {
  const o = new (await linkInit(cls)).ctor();
  if (desc !== null) await vcall(o, "<init>", desc, ...args);
  return o;
}
/** a boxed primitive (Integer, Long, Float …) — every box class keeps its value in `v` */
export function box<T extends { v: unknown }>(Ctor: new () => T, v: T["v"]): T {
  const b = new Ctor();
  b.v = v;
  return b;
}

// identity hash
let hashCounter = 1;
const hashes = new WeakMap<object, number>();
export function idHash(o: unknown): number {
  if (o === null || o === undefined) return 0;
  if (typeof o === "string") return stringHash(o);
  if (typeof o !== "object" && typeof o !== "function") return stringHash(String(o));
  let h = hashes.get(o as object);
  if (h === undefined) { h = (hashCounter = (hashCounter * 1103515245 + 12345) & 0x7fffffff); hashes.set(o as object, h); }
  return h;
}
const regexMemo = new Map<string, RegExp>();
/** Java regex source + JS flags → RegExp, memoised: String.matches and Matcher rebuild theirs per call.
 *  Callers that use sticky/global flags must set lastIndex before every exec. */
const POSIX: Record<string, string> = {
  Lower: "a-z", Upper: "A-Z", ASCII: "\\x00-\\x7F", Alpha: "a-zA-Z", Digit: "0-9", Alnum: "a-zA-Z0-9",
  Punct: "!-\\/:-@\\[-`{-~", Graph: "!-~", Print: " -~", Blank: " \\t", Cntrl: "\\x00-\\x1F\\x7F", XDigit: "0-9a-fA-F", Space: " \\t\\n\\x0B\\f\\r",
  javaLowerCase: "\\p{Ll}", javaUpperCase: "\\p{Lu}", javaWhitespace: "\\s", javaLetter: "\\p{L}", javaDigit: "\\p{Nd}", javaLetterOrDigit: "\\p{L}\\p{Nd}",
};
/**
 * java.util.regex syntax that JS RegExp lacks, rewritten in place: embedded flag groups
 * `(?ismx)` (folded into the flags — Java scopes them from that point on, JS cannot), `\Q...\E`
 * literals, `\A`/`\Z`/`\z` anchors, `\h`, possessive quantifiers (made greedy), and the
 * POSIX/java.lang.Character classes `\p{Alpha}`. Returns the JS source plus extra flags.
 */
function javaToJs(src: string): [string, string] {
  let extra = "";
  let out = src.replace(/\(\?([a-zA-Z]+)(?:-[a-zA-Z]+)?\)/g, (_m, on: string) => {
    for (const c of on) if ("ims".includes(c) && !extra.includes(c)) extra += c;
    return "";
  });
  out = out.replace(/\\Q([\s\S]*?)(?:\\E|$)/g, (_m, lit: string) => lit.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"));
  out = out.replace(/\\([AZzh])/g, (_m, c: string) => c === "A" ? "^" : c === "h" ? "[ \\t\\xA0]" : "$");
  out = out.replace(/([*+?}])\+/g, "$1");
  out = out.replace(/\\([pP])\{(?:Is|In)?([A-Za-z]+)\}/g, (m, neg: string, name: string) => {
    const cls = POSIX[name];
    return cls ? (neg === "P" ? `[^${cls}]` : `[${cls}]`) : m;
  });
  return [out, extra];
}
export function javaRegex(source: string, flags: string): RegExp {
  const key = flags + "/" + source;
  let re = regexMemo.get(key);
  if (!re) {
    if (regexMemo.size > 4096) regexMemo.clear();
    try { re = new RegExp(source, flags); }
    catch (e) {
      const [js, extra] = javaToJs(source);
      let f = flags;
      for (const c of extra) if (!f.includes(c)) f += c;
      try { re = new RegExp(js, f); }
      catch { re = new RegExp(js, f.replace("u", "")); }
    }
    regexMemo.set(key, re);
  }
  return re;
}
/** String.matches / Pattern.matches: whole-input match, invalid pattern → false */
export function javaMatches(p: string, s: string): number {
  try { return javaRegex("^(?:" + p + ")$", "su").test(s) ? 1 : 0; } catch { return 0; }
}
export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function jclsName(o: unknown): string {
  if (typeof o === "string") return "java/lang/String";
  const i: ClassInfo | undefined = (o as any)?.constructor?.$i;
  return i?.name ?? "java/lang/Object";
}

rt.register({
  name: "java/lang/Object",
  ctor: JObj,
  methods: {
    "<init>()V": function () {},
    "hashCode()I": function () { return idHash(this); },
    "equals(Ljava/lang/Object;)Z": function (o: unknown) { return this === o ? 1 : 0; },
    // AccessibleObject semantics are moot here; harmless on any receiver
    "setAccessible(Z)V": () => {},
    "toString()Ljava/lang/String;": function () {
      return jclsName(this).replace(/\//g, ".") + "@" + idHash(this).toString(16);
    },
    "getClass()Ljava/lang/Class;": function () { return rt.classFor(jclsName(this)); },
    "clone()Ljava/lang/Object;": function (this: any) {
      if (Array.isArray(this)) { const c: unknown[] = (this as unknown[]).slice(); (c as any).$t = (this as any).$t; return c; }
      if (ArrayBuffer.isView(this)) return (this as any).slice();
      const c = Object.create(Object.getPrototypeOf(this));
      Object.assign(c, this);
      return c;
    },
    "notify()V": function () { monNotify(this, false); },
    "notifyAll()V": function () { monNotify(this, true); },
    "wait()V": function () { return monWait(this, 0); },
    "wait(J)V": function (ms: bigint) { return monWait(this, Number(ms)); },
    "wait(JI)V": function (ms: bigint, ns: number) { return monWait(this, Number(ms) + (ns > 0 ? 1 : 0)); },
  },
});

// wait/notify on cooperative threads
const waiters = new WeakMap<object, (() => void)[]>();
function monWait(obj: object, ms: number): Promise<boolean> {
  let list = waiters.get(obj);
  if (!list) waiters.set(obj, (list = []));
  const l = list;
  return park(curThread, (wake) => {
    l.push(wake);
    return () => { const i = l.indexOf(wake); if (i >= 0) l.splice(i, 1); };
  }, ms > 0 ? ms : undefined);
}
function monNotify(obj: object, all: boolean) {
  const list = waiters.get(obj);
  if (!list?.length) return;
  const picked = all ? list.splice(0) : list.splice(0, 1);
  for (const w of picked) queueMicrotask(w);
}

export class JClass extends JObj {
  ci: ClassInfo | null = null;
  primName: string | null = null;
  arrDesc: string | null = null;
}
const classCache = new Map<string, JClass>();
rt.classFor = (name: string): JClass => {
  let c = classCache.get(name);
  if (c) return c;
  c = new JClass();
  if (name[0] === "[") c.arrDesc = name;
  else if (["int", "long", "float", "double", "boolean", "byte", "char", "short", "void"].includes(name)) c.primName = name;
  else c.ci = rt.link(name);
  classCache.set(name, c);
  return c;
};
function jclassName(c: JClass): string {
  if (c.primName) return c.primName;
  if (c.arrDesc) return c.arrDesc.replace(/\//g, ".");
  return c.ci!.name.replace(/\//g, ".");
}
rt.register({
  name: "java/lang/Class",
  ctor: JClass,
  ifaces: ["java/io/Serializable", "java/lang/reflect/Type", "java/lang/reflect/GenericDeclaration", "java/lang/reflect/AnnotatedElement"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JClass) { return jclassName(this); },
    "toString()Ljava/lang/String;": function (this: JClass) { return "class " + jclassName(this); },
    "getSimpleName()Ljava/lang/String;": function (this: JClass) {
      const n = jclassName(this);
      const i = Math.max(n.lastIndexOf("."), n.lastIndexOf("$"));
      return i >= 0 ? n.slice(i + 1) : n;
    },
    "hashCode()I": function () { return idHash(this); },
    "isInstance(Ljava/lang/Object;)Z": function (this: JClass, o: unknown) {
      return rt.iof(o, this.ci?.name ?? this.arrDesc ?? "?");
    },
    "isAssignableFrom(Ljava/lang/Class;)Z": function (this: JClass, other: JClass) {
      if (!other) rt.npe();
      if (other === this) return 1;
      return other.ci?.types.has(this.ci?.name ?? "??") ? 1 : 0;
    },
    "isInterface()Z": function (this: JClass) { return this.ci?.isInterface ? 1 : 0; },
    "isArray()Z": function (this: JClass) { return this.arrDesc ? 1 : 0; },
    "isPrimitive()Z": function (this: JClass) { return this.primName ? 1 : 0; },
    "getSuperclass()Ljava/lang/Class;": function (this: JClass) {
      const s = this.ci?.superInfo;
      return s ? rt.classFor(s.name) : null;
    },
    "getComponentType()Ljava/lang/Class;": function (this: JClass) {
      if (!this.arrDesc) return null;
      const e = this.arrDesc.slice(1);
      return rt.classFor(e[0] === "L" ? descToName(e) : e[0] === "[" ? e : PRIM_NAME[e]);
    },
    "newInstance()Ljava/lang/Object;": async function (this: JClass) {
      const info = this.ci!;
      const p = rt.initClass(info);
      if (p) await p;
      // <init> mangles without a class component, so an inherited <init>()V would run the
      // SUPERclass ctor and leave every own field null — silently. Only accept our own.
      if (info.def && !Object.prototype.hasOwnProperty.call(info.ctor.prototype, mangleMethod("<init>", "()V")))
        throw rt.mkThrowable("java/lang/InstantiationException", info.name.replace(/\//g, "."));
      const o = new info.ctor();
      await vcall(o, "<init>", "()V");
      return o;
    },
    "getClassLoader()Ljava/lang/ClassLoader;": function () { return bootLoader; },
    "desiredAssertionStatus()Z": function () { return 0; },
    "getInterfaces()[Ljava/lang/Class;": function (this: JClass) {
      return jarray((this.ci?.interfaces ?? []).map((i) => rt.classFor(i.name)), "Ljava/lang/Class;");
    },
    "getCanonicalName()Ljava/lang/String;": function (this: JClass) {
      return jclassName(this).replace(/\$/g, ".");
    },
    "isMemberClass()Z": function (this: JClass) { return this.ci?.name.includes("$") && !/\$\d/.test(this.ci.name) ? 1 : 0; },
    "isAnonymousClass()Z": function (this: JClass) { return /\$\d+$/.test(this.ci?.name ?? "") ? 1 : 0; },
    "isLocalClass()Z": () => 0,
    "isSynthetic()Z": () => 0,
    "isEnum()Z": function (this: JClass) { return this.ci?.types.has("java/lang/Enum") ? 1 : 0; },
    "isAnnotation()Z": () => 0,
    "getTypeName()Ljava/lang/String;": function (this: JClass) {
      return (this.ci?.name ?? this.primName ?? this.arrDesc ?? "?").replace(/\//g, ".");
    },
    "getGenericInterfaces()[Ljava/lang/reflect/Type;": () => jarray([], "Ljava/lang/reflect/Type;"),
    "getEnclosingClass()Ljava/lang/Class;": function (this: JClass) {
      const n = this.ci?.name ?? "";
      const i = n.lastIndexOf("$");
      return i > 0 ? rt.classFor(n.slice(0, i)) : null;
    },
    "cast(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JClass, o: unknown) {
      return rt.cc(o, this.ci?.name ?? this.arrDesc ?? "java/lang/Object");
    },
    "asSubclass(Ljava/lang/Class;)Ljava/lang/Class;": function (this: JClass) { return this; },
    // forName/getConstructor(s)/getDeclaredConstructor(s)/getModifiers live in jreflect (installClassReflection)
  },
});

class JClassLoader extends JObj {}
const loadClass = (n: string) => (JClass as any).$i.ctor[mangleMethod("forName", "(Ljava/lang/String;)Ljava/lang/Class;")](n);
rt.register({
  name: "java/lang/ClassLoader",
  ctor: JClassLoader,
  methods: {
    "<init>()V": function () {},
    "loadClass(Ljava/lang/String;)Ljava/lang/Class;": loadClass,
    "loadClass(Ljava/lang/String;Z)Ljava/lang/Class;": loadClass,
    "getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;": (path: string) => classpathStream(path.replace(/^\//, "")),
  },
});
const bootLoader = new JClassLoader();
/** a classpath entry as an InputStream, or null when the apk has no such file */
export async function classpathStream(path: string): Promise<unknown> {
  const bytes = rt.classpath[path];
  return bytes ? newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)) : null;
}

class JThrowable extends JObj {
  msg: string | null = null;
  cause: JThrowable | null = null;
  suppressed: JThrowable[] = [];
  jsStack: string | undefined = new Error().stack;
  /** memoised getStackTrace(), or what setStackTrace() was handed */
  trace: unknown[] | null = null;
}
/** JVM-shaped stack trace text: header from the (overridable) toString, frames from the JS stack. */
/**
 * A throwable's frames, out of the JS stack the throw actually has. An EMPTY trace is not a
 * thing any JVM produces, and library code counts on that: kotlinx.coroutines' stack-trace
 * recovery does `copyOfRange(trace, 1, trace.size)` on the way out of a *caught* exception,
 * which on an empty array throws — turning a handled failure into a fatal one.
 */
function jsStackTrace(js: string | undefined): unknown[] {
  const out = (js ?? "").split("\n").slice(1, 33).map((line) => {
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?)(?::(\d+))?(?::\d+)?\)?$/.exec(line);
    const e = new JStackTraceElement();
    const [decl, meth] = (m?.[1] ?? "<unknown>").split(/\.(?=[^.]*$)/);
    e.declaring = meth ? decl! : "webdroid";
    e.method = meth ?? decl!;
    e.file = m?.[2] ?? null;
    e.line = Number(m?.[3] ?? 0);
    return e;
  });
  if (!out.length) out.push(new JStackTraceElement());
  return jarray(out, "Ljava/lang/StackTraceElement;");
}

export async function stackTraceText(t: JThrowable): Promise<string> {
  const frames = (js: string | undefined) =>
    (js ?? "").split("\n").slice(1, 41).map((l) => "\n\tat " + l.trim().replace(/^at /, "")).join("");
  let out = String(await vcall(t, "toString", "()Ljava/lang/String;")) + frames(t.jsStack);
  const seen = new Set<JThrowable>([t]);
  for (let c = t.cause; c && !seen.has(c); c = c.cause) {
    seen.add(c);
    out += "\nCaused by: " + String(await vcall(c, "toString", "()Ljava/lang/String;")) + frames(c.jsStack);
  }
  return out;
}
rt.register({
  name: "java/lang/Throwable",
  ctor: JThrowable,
  ifaces: ["java/io/Serializable"],
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: JThrowable, m: string) { this.msg = m; },
    "<init>(Ljava/lang/String;Ljava/lang/Throwable;)V": function (this: JThrowable, m: string, c: JThrowable) { this.msg = m; this.cause = c; },
    "<init>(Ljava/lang/Throwable;)V": function (this: JThrowable, c: JThrowable) {
      this.cause = c; this.msg = c ? jclsName(c).replace(/\//g, ".") + ": " + c.msg : null;
    },
    "<init>(Ljava/lang/String;Ljava/lang/Throwable;ZZ)V": function (this: JThrowable, m: string, c: JThrowable) { this.msg = m; this.cause = c; },
    "getMessage()Ljava/lang/String;": function (this: JThrowable) { return this.msg; },
    "getLocalizedMessage()Ljava/lang/String;": function (this: JThrowable) { return this.msg; },
    "getCause()Ljava/lang/Throwable;": function (this: JThrowable) { return this.cause; },
    "initCause(Ljava/lang/Throwable;)Ljava/lang/Throwable;": function (this: JThrowable, c: JThrowable) { this.cause = c; return this; },
    "toString()Ljava/lang/String;": function (this: JThrowable) {
      const n = jclsName(this).replace(/\//g, ".");
      return this.msg !== null ? n + ": " + this.msg : n;
    },
    "printStackTrace()V": function (this: JThrowable) {
      console.warn("[java] " + jclsName(this) + ": " + this.msg, this.jsStack, this.cause ? "caused by " + jclsName(this.cause) + ": " + this.cause.msg : "");
    },
    // Apps route caught exceptions through these (logcat/Timber's Throwable.asLog()).
    // Missing, they turn a *handled* exception into an unhandled one that kills the
    // enclosing coroutine scope.
    "printStackTrace(Ljava/io/PrintWriter;)V": async function (this: JThrowable, w: unknown) {
      await vcall(w, "println", "(Ljava/lang/String;)V", await stackTraceText(this));
    },
    "printStackTrace(Ljava/io/PrintStream;)V": async function (this: JThrowable, s: unknown) {
      await vcall(s, "println", "(Ljava/lang/String;)V", await stackTraceText(this));
    },
    "fillInStackTrace()Ljava/lang/Throwable;": function (this: JThrowable) { this.jsStack = new Error().stack; this.trace = null; return this; },
    "getStackTrace()[Ljava/lang/StackTraceElement;": function (this: JThrowable) { return this.trace ??= jsStackTrace(this.jsStack); },
    "setStackTrace([Ljava/lang/StackTraceElement;)V": function (this: JThrowable, t: unknown[]) { this.trace = t ?? null; },
    "addSuppressed(Ljava/lang/Throwable;)V": function (this: JThrowable, t: JThrowable) { this.suppressed.push(t); },
    "getSuppressed()[Ljava/lang/Throwable;": function (this: JThrowable) { return jarray(this.suppressed.slice(), "Ljava/lang/Throwable;"); },
  },
});

/** log a throwable that escaped every handler and tell the shell (status line) */
export function reportUncaught(e: unknown) {
  const je = rt.jx(e);
  // the cause chain travels with the throwable and is usually where the real failure is named
  let causes = "";
  for (let c = je?.cause, depth = 0; c && depth < 8; c = c.cause, depth++) {
    causes += `\n  caused by ${(c.constructor as any)?.$i?.name ?? "?"}: ${c.msg ?? ""}`;
  }
  console.error("[uncaught]", (je?.constructor as any)?.$i?.name ?? "?", (je?.msg ?? "") + causes, (je as any)?.jsStack ?? (e as any)?.stack ?? "");
  rt.onUncaught?.(je);
}

const excCtors = new Map<string, new () => JThrowable>([["java/lang/Throwable", JThrowable]]);
/** Register a throwable class under an already-registered parent (native here or elsewhere). */
export function defineException(name: string, sup: string) {
  const parent = excCtors.get(sup) ?? (rt.link(sup).ctor as new () => JThrowable);
  const c = class extends parent {};
  excCtors.set(name, c);
  rt.register({ name, sup, ctor: c });
}
defineException("java/lang/Error", "java/lang/Throwable");
defineException("java/lang/Exception", "java/lang/Throwable");
defineException("java/lang/RuntimeException", "java/lang/Exception");
for (const n of ["NullPointerException", "ClassCastException", "ArithmeticException", "ArrayIndexOutOfBoundsException",
  "StringIndexOutOfBoundsException", "IndexOutOfBoundsException", "IllegalArgumentException", "IllegalStateException",
  "UnsupportedOperationException", "NumberFormatException", "NegativeArraySizeException", "ArrayStoreException",
  "SecurityException"]) {
  defineException("java/lang/" + n, "java/lang/RuntimeException");
}
defineException("java/lang/IllegalMonitorStateException", "java/lang/RuntimeException");
defineException("java/lang/InterruptedException", "java/lang/Exception");
defineException("java/lang/CloneNotSupportedException", "java/lang/Exception");
defineException("java/lang/ReflectiveOperationException", "java/lang/Exception");
defineException("java/lang/ClassNotFoundException", "java/lang/ReflectiveOperationException");
defineException("java/lang/NoSuchMethodException", "java/lang/ReflectiveOperationException");
defineException("java/lang/NoSuchFieldException", "java/lang/ReflectiveOperationException");
defineException("java/lang/InstantiationException", "java/lang/ReflectiveOperationException");
defineException("java/lang/IllegalAccessException", "java/lang/ReflectiveOperationException");
defineException("java/lang/StackOverflowError", "java/lang/Error");
defineException("java/lang/OutOfMemoryError", "java/lang/Error");
defineException("java/lang/AssertionError", "java/lang/Error");
defineException("java/lang/LinkageError", "java/lang/Error");
defineException("java/lang/NoClassDefFoundError", "java/lang/LinkageError");
defineException("org/xmlpull/v1/XmlPullParserException", "java/lang/Exception");
defineException("java/lang/NoSuchMethodError", "java/lang/LinkageError");
defineException("java/lang/NoSuchFieldError", "java/lang/LinkageError");
defineException("java/lang/UnsatisfiedLinkError", "java/lang/LinkageError");
defineException("java/lang/AbstractMethodError", "java/lang/LinkageError");
defineException("java/lang/InternalError", "java/lang/Error");
defineException("java/lang/ExceptionInInitializerError", "java/lang/LinkageError");
defineException("java/io/IOException", "java/lang/Exception");
defineException("java/io/FileNotFoundException", "java/io/IOException");
defineException("java/io/EOFException", "java/io/IOException");
defineException("java/io/UnsupportedEncodingException", "java/io/IOException");
defineException("java/net/SocketException", "java/io/IOException");
defineException("java/net/ConnectException", "java/net/SocketException");
defineException("java/net/SocketTimeoutException", "java/io/IOException");
defineException("java/net/UnknownHostException", "java/io/IOException");
defineException("java/io/InterruptedIOException", "java/io/IOException");
defineException("java/util/NoSuchElementException", "java/lang/RuntimeException");
defineException("java/util/ConcurrentModificationException", "java/lang/RuntimeException");

rt.mkThrowable = (cls: string, msg: string | null) => {
  let ctor = excCtors.get(cls);
  if (!ctor) {
    // exception classes registered outside excCtors (framework natives)
    try {
      const info = rt.link(cls);
      if (info.ctor && (info.ctor === JThrowable || info.ctor.prototype instanceof JThrowable)) ctor = info.ctor;
    } catch { /* fall through */ }
  }
  const e = new (ctor ?? excCtors.get("java/lang/RuntimeException")!)();
  e.msg = msg;
  return e;
};

// marker interfaces (registered early so link of String/implementors works + iof)
// Closeable extends AutoCloseable, and that inheritance is load-bearing: R8 merges every
// close-this-thing helper into one method that tests `instanceof AutoCloseable` first, so a
// Closeable that is not one falls off the end of the chain into its throw.
for (const [i, ext] of [["java/lang/Runnable"], ["java/lang/Comparable"], ["java/lang/CharSequence"],
  ["java/lang/Cloneable"], ["java/lang/Iterable"], ["java/lang/Appendable"], ["java/lang/AutoCloseable"],
  ["java/io/Serializable"], ["java/io/Closeable", "java/lang/AutoCloseable"], ["java/io/Flushable"],
  ["java/io/DataInput"], ["java/io/DataOutput"]] as const) {
  rt.register({ name: i, ctor: class extends JObj {}, ifaces: ext ? [ext] : undefined });
}

// ── arrays: Object-typed call sites (Kotlin generics) dispatch mangled Object
// methods directly on JS arrays — give every array prototype the basics
for (const proto of [Array.prototype, Int8Array.prototype, Uint8Array.prototype, Int16Array.prototype,
  Uint16Array.prototype, Int32Array.prototype, Float32Array.prototype, Float64Array.prototype,
  BigInt64Array.prototype] as object[]) {
  for (const [sig, name] of [["getClass()Ljava/lang/Class;", "getClass"], ["hashCode()I", "hashCode"],
    ["toString()Ljava/lang/String;", "toString"], ["equals(Ljava/lang/Object;)Z", "equals"],
    ["clone()Ljava/lang/Object;", "clone"]] as [string, string][]) {
    const paren = sig.indexOf("(");
    Object.defineProperty(proto, mangleMethod(sig.slice(0, paren), sig.slice(paren)), {
      value: function (this: unknown, other?: unknown) { return name === "equals" ? (this === other ? 1 : 0) : rt.arrCall(this, name); },
      writable: true, configurable: true, enumerable: false,
    });
  }
}

// ── String (patch JS String.prototype with mangled methods)
function sm(sig: string, fn: (this: string, ...a: any[]) => unknown) {
  const paren = sig.indexOf("(");
  Object.defineProperty(String.prototype, mangleMethod(sig.slice(0, paren), sig.slice(paren)), {
    value: fn, writable: true, configurable: true, enumerable: false,
  });
}
function sioobe(i: number): never {
  throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", "index " + i);
}
sm("length()I", function () { return this.length; });
sm("isEmpty()Z", function () { return this.length === 0 ? 1 : 0; });
sm("charAt(I)C", function (i: number) {
  if (i >>> 0 >= this.length) sioobe(i);
  return this.charCodeAt(i);
});
sm("codePointAt(I)I", function (i: number) { return this.codePointAt(i) ?? 0; });
sm("hashCode()I", function () { return stringHash(this as string); });
sm("equals(Ljava/lang/Object;)Z", function (o: unknown) { return (this as string) === o ? 1 : 0; });
sm("equalsIgnoreCase(Ljava/lang/String;)Z", function (o: string | null) {
  return o !== null && this.toLowerCase() === o.toLowerCase() ? 1 : 0;
});
sm("compareTo(Ljava/lang/String;)I", function (o: string) {
  const n = Math.min(this.length, o.length);
  for (let i = 0; i < n; i++) {
    const d = this.charCodeAt(i) - o.charCodeAt(i);
    if (d) return d;
  }
  return this.length - o.length;
});
sm("compareTo(Ljava/lang/Object;)I", function (o: string) { return (this as any)[mangleMethod("compareTo", "(Ljava/lang/String;)I")](o); });
sm("compareToIgnoreCase(Ljava/lang/String;)I", function (o: string) {
  const a = this.toLowerCase(), b = o.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
});
sm("indexOf(I)I", function (c: number) { return this.indexOf(String.fromCharCode(c)); });
sm("indexOf(II)I", function (c: number, from: number) { return this.indexOf(String.fromCharCode(c), from); });
sm("indexOf(Ljava/lang/String;)I", function (s: string) { return this.indexOf(s); });
sm("indexOf(Ljava/lang/String;I)I", function (s: string, from: number) { return this.indexOf(s, from); });
sm("lastIndexOf(I)I", function (c: number) { return this.lastIndexOf(String.fromCharCode(c)); });
sm("lastIndexOf(Ljava/lang/String;)I", function (s: string) { return this.lastIndexOf(s); });
sm("lastIndexOf(II)I", function (c: number, from: number) { return this.lastIndexOf(String.fromCharCode(c), from); });
sm("lastIndexOf(Ljava/lang/String;I)I", function (v: string, from: number) { return this.lastIndexOf(v, from); });
sm("substring(I)Ljava/lang/String;", function (i: number) {
  if (i < 0 || i > this.length) sioobe(i);
  return this.slice(i);
});
sm("substring(II)Ljava/lang/String;", function (a: number, b: number) {
  if (a < 0 || b > this.length || a > b) sioobe(a);
  return this.slice(a, b);
});
sm("subSequence(II)Ljava/lang/CharSequence;", function (a: number, b: number) { return this.slice(a, b); });
sm("startsWith(Ljava/lang/String;)Z", function (s: string) { return this.startsWith(s) ? 1 : 0; });
sm("startsWith(Ljava/lang/String;I)Z", function (s: string, i: number) { return this.startsWith(s, i) ? 1 : 0; });
sm("endsWith(Ljava/lang/String;)Z", function (s: string) { return this.endsWith(s) ? 1 : 0; });
sm("contains(Ljava/lang/CharSequence;)Z", function (s: unknown) { return this.includes(String(s)) ? 1 : 0; });
sm("trim()Ljava/lang/String;", function () { return this.trim(); });
sm("strip()Ljava/lang/String;", function () { return this.trim(); });
sm("toLowerCase()Ljava/lang/String;", function () { return this.toLowerCase(); });
sm("toUpperCase()Ljava/lang/String;", function () { return this.toUpperCase(); });
sm("toLowerCase(Ljava/util/Locale;)Ljava/lang/String;", function () { return this.toLowerCase(); });
sm("toUpperCase(Ljava/util/Locale;)Ljava/lang/String;", function () { return this.toUpperCase(); });
sm("toString()Ljava/lang/String;", function () { return this as string; });
sm("toCharArray()[C", function () {
  const a = new Uint16Array(this.length);
  for (let i = 0; i < this.length; i++) a[i] = this.charCodeAt(i);
  return a;
});
sm("getChars(II[CI)V", function (srcBegin: number, srcEnd: number, dst: Uint16Array, dstBegin: number) {
  for (let i = srcBegin; i < srcEnd; i++) dst[dstBegin + i - srcBegin] = this.charCodeAt(i);
});
const utf8Bytes = function (this: string) { return new Int8Array(new TextEncoder().encode(this).buffer); };
sm("getBytes()[B", utf8Bytes);
sm("getBytes(Ljava/lang/String;)[B", utf8Bytes);
sm("getBytes(Ljava/nio/charset/Charset;)[B", utf8Bytes);
sm("replace(CC)Ljava/lang/String;", function (a: number, b: number) {
  return this.split(String.fromCharCode(a)).join(String.fromCharCode(b));
});
sm("replace(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/lang/String;", function (a: unknown, b: unknown) {
  return this.split(String(a)).join(String(b));
});
sm("concat(Ljava/lang/String;)Ljava/lang/String;", function (s: string) { return (this as string) + s; });
sm("intern()Ljava/lang/String;", function () { return this as string; });
sm("regionMatches(ILjava/lang/String;II)Z", function (toff: number, o: string, ooff: number, len: number) {
  if (toff < 0 || ooff < 0 || toff + len > this.length || ooff + len > o.length) return 0;
  return this.substr(toff, len) === o.substr(ooff, len) ? 1 : 0;
});
sm("regionMatches(ZILjava/lang/String;II)Z", function (ignore: number, toff: number, o: string, ooff: number, len: number) {
  if (toff < 0 || ooff < 0 || toff + len > this.length || ooff + len > o.length) return 0;
  const a = this.substr(toff, len), b = o.substr(ooff, len);
  return (ignore ? a.toLowerCase() === b.toLowerCase() : a === b) ? 1 : 0;
});
sm("contentEquals(Ljava/lang/CharSequence;)Z", function (o: unknown) { return (this as string) === String(o) ? 1 : 0; });
sm("codePointCount(II)I", function (a: number, b: number) { return b - a; });
sm("offsetByCodePoints(II)I", function (i: number, n: number) { return i + n; });
sm("chars()Ljava/util/stream/IntStream;", function () { throw rt.unimplemented("String.chars"); });
sm("getClass()Ljava/lang/Class;", function () { return rt.classFor("java/lang/String"); });
sm("matches(Ljava/lang/String;)Z", function (p: string) { return javaMatches(p, this as string); });
sm("replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) {
  return this.replace(javaRegex(p, "gsu"), r.replace(/\\\$/g, "$$$$"));
});
sm("replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) {
  return this.replace(javaRegex(p, "su"), r);
});
function javaSplit(s: string, pattern: string, limit: number): string[] {
  const plain = /^[^\\\[\](){}.*+?^$|]+$/.test(pattern);
  const parts = plain ? s.split(pattern) : s.split(javaRegex(pattern, "su"));
  if (limit === 0) { while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); }
  return jarray(parts, "Ljava/lang/String;");
}
sm("split(Ljava/lang/String;)[Ljava/lang/String;", function (p: string) { return javaSplit(this as string, p, 0); });
sm("split(Ljava/lang/String;I)[Ljava/lang/String;", function (p: string, l: number) { return javaSplit(this as string, p, l); });

class JStringStatics extends JObj {}
export function javaFormat(fmt: string, args: unknown[]): string {
  let ai = 0;
  return fmt.replace(/%(\d+\$)?([-+ 0#,]*)(\d+)?(?:\.(\d+))?([sdfxXeobnch%])/g,
    (m, argn, flags: string, width: string, prec: string, conv: string) => {
      if (conv === "%") return "%";
      if (conv === "n") return "\n";
      const idx = argn ? parseInt(argn) - 1 : ai++;
      let v = args[idx];
      // BigInteger prints its whole signed magnitude; int/long print two's-complement at their width.
      const big = rt.iof(v, "java/math/BigInteger") ? (v as { v: bigint }).v : null;
      if (v !== null && typeof v === "object" && "v" in (v as object)) {
        const inner = (v as { v: unknown }).v;
        if (typeof inner === "number" || typeof inner === "bigint") v = inner; // unbox Integer/Long/Double…
      }
      const radix = (r: number) => big !== null ? (big < 0n ? "-" : "") + (big < 0n ? -big : big).toString(r)
        : (typeof v === "bigint" ? BigInt.asUintN(64, v) : (Number(v) >>> 0)).toString(r);
      let s: string;
      switch (conv) {
        case "d": s = String(v); if (flags.includes(",")) s = Number(v).toLocaleString("en-US"); break;
        case "f": s = Number(v).toFixed(prec ? parseInt(prec) : 6); break;
        case "e": s = Number(v).toExponential(prec ? parseInt(prec) : 6); break;
        case "x": s = radix(16); break;
        case "X": s = radix(16).toUpperCase(); break;
        case "o": s = radix(8); break;
        case "c": s = String.fromCharCode(Number(v)); break;
        case "b": s = v === null || v === 0 ? "false" : "true"; break;
        case "h": s = v === null ? "null" : idHash(v).toString(16); break;
        default: s = v === null ? "null" : String(v);
          if (prec) s = s.slice(0, parseInt(prec));
      }
      if (width) {
        const w = parseInt(width);
        if (s.length < w) s = flags.includes("-") ? s.padEnd(w) : flags.includes("0")
          ? s.replace(/^-?/, (sign) => sign + "0".repeat(w - s.length)) : s.padStart(w);
      }
      return s;
    });
}
rt.register({
  name: "java/lang/String",
  ctor: JStringStatics, // statics holder; instances are JS primitives
  ifaces: ["java/lang/CharSequence", "java/lang/Comparable", "java/io/Serializable"],
  methods: {
    "static valueOf(I)Ljava/lang/String;": (v: number) => String(v),
    "static valueOf(J)Ljava/lang/String;": (v: bigint) => String(v),
    "static valueOf(F)Ljava/lang/String;": (v: number) => fmtFloat(v),
    "static valueOf(D)Ljava/lang/String;": (v: number) => fmtDouble(v),
    "static valueOf(Z)Ljava/lang/String;": (v: number) => (v ? "true" : "false"),
    "static valueOf(C)Ljava/lang/String;": (v: number) => String.fromCharCode(v),
    "static valueOf(Ljava/lang/Object;)Ljava/lang/String;": (v: unknown) =>
      v === null ? "null" : vcall(v, "toString", "()Ljava/lang/String;"),
    "static valueOf([C)Ljava/lang/String;": (v: Uint16Array) => charsToString(v, 0, v.length),
    "static valueOf([CII)Ljava/lang/String;": (v: Uint16Array, o: number, n: number) => charsToString(v, o, n),
    "static format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;": (f: string, a: unknown[]) => javaFormat(f, a),
    "static format(Ljava/util/Locale;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;":
      (_l: unknown, f: string, a: unknown[]) => javaFormat(f, a),
    "static join(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/String;":
      (sep: string, parts: string[]) => parts.join(String(sep)),
  },
  // A getter, because java.util.Comparator is not registered yet when this spec is built.
  statics: { get CASE_INSENSITIVE_ORDER() { return mkCmp(caseInsensitive); } },
});
/** A Comparator is a plain JObj carrying `compare` — all a vcall from a sort needs. */
export const mkCmp = (compare: (a: unknown, b: unknown) => unknown) => {
  const o = new (rt.link("java/util/Comparator").ctor as new () => JObj)();
  (o as unknown as Record<string, unknown>)[mangleMethod("compare", "(Ljava/lang/Object;Ljava/lang/Object;)I")] = compare;
  return o;
};
const caseInsensitive = (a: unknown, b: unknown) => {
  const x = String(a).toUpperCase().toLowerCase(), y = String(b).toUpperCase().toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};
// make String's ClassInfo know its real JS type
{
  const info = rt.link("java/lang/String");
  info.ctor = String;
  (String as any).$i = info;
  // copy statics from holder — a lazy one stays lazy across the hop, since reading it here
  // would resolve it before the class it names has registered (see setupNativeMembers)
  for (const k of Object.getOwnPropertyNames(JStringStatics)) {
    if (!k.startsWith("m$") && !k.startsWith("s$")) continue;
    if (Object.getOwnPropertyDescriptor(JStringStatics, k)!.get) {
      Object.defineProperty(String, k, { configurable: true, get: () => (JStringStatics as any)[k] });
    } else (String as any)[k] = (JStringStatics as any)[k];
  }
}

// Java Double.toString: shortest round-tripping digits (JS agrees), laid out plain with at least
// one fraction digit inside [1e-3, 1e7) and as "d.dddE±n" outside (BigDecimal.valueOf(double)
// is specified in terms of this string, so the layout is load-bearing, not cosmetic).
export function fmtDouble(v: number): string {
  if (v !== v) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (v === 0) return 1 / v < 0 ? "-0.0" : "0.0";
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e7) {
    const s = String(v);
    return s.includes(".") ? s : s + ".0";
  }
  const [m, e] = v.toExponential().split("e");
  return (m.includes(".") ? m : m + ".0") + "E" + (e[0] === "+" ? e.slice(1) : e);
}
// Float.toString: the shortest digits that round-trip through a 32-bit float, not the double's.
export function fmtFloat(v: number): string {
  if (v !== v || v === 0 || !Number.isFinite(v)) return fmtDouble(v);
  for (let p = 1; p < 9; p++) {
    const d = Number(v.toPrecision(p));
    if (Math.fround(d) === v) return fmtDouble(d);
  }
  return fmtDouble(Number(v.toPrecision(9)));
}

export class JSB extends JObj {
  s = "";
}
function sbSpec(name: string): NativeSpec {
  const c = name === "java/lang/StringBuilder" ? class SB extends JSB {} : class SBuf extends JSB {};
  const L = "Ljava/lang/" + name.slice(10) + ";"; // return own type
  const app = (fn: (this: JSB, v: any) => void) => function (this: JSB, v: any) { fn.call(this, v); return this; };
  const appendObj = async function (this: JSB, v: unknown) {
    this.s += v === null ? "null" : await vcall(v, "toString", "()Ljava/lang/String;");
    return this;
  };
  const appendRange = async function (this: JSB, v: unknown, a: number, b: number) {
    const str = v === null ? "null" : String(await vcall(v, "toString", "()Ljava/lang/String;"));
    this.s += str.slice(a, b);
    return this;
  };
  const appendChar = app(function (v) { this.s += String.fromCharCode(v); });
  return {
    name, ctor: c,
    ifaces: ["java/lang/CharSequence", "java/lang/Appendable"],
    methods: {
      "<init>()V": function () {},
      "<init>(I)V": function () {},
      "<init>(Ljava/lang/String;)V": function (this: JSB, s: string) { this.s = s; },
      "<init>(Ljava/lang/CharSequence;)V": function (this: JSB, s: unknown) { this.s = String(s); },
      [`append(Ljava/lang/String;)${L}`]: app(function (v) { this.s += v === null ? "null" : v; }),
      [`append(Ljava/lang/Object;)${L}`]: appendObj,
      [`append(Ljava/lang/CharSequence;)${L}`]: appendObj,
      [`append(Ljava/lang/StringBuffer;)${L}`]: appendObj,
      "append(Ljava/lang/CharSequence;)Ljava/lang/Appendable;": appendObj,
      "append(C)Ljava/lang/Appendable;": appendChar,
      "append(Ljava/lang/CharSequence;II)Ljava/lang/Appendable;": appendRange,
      [`append(Ljava/lang/CharSequence;II)${L}`]: appendRange,
      [`append(I)${L}`]: app(function (v) { this.s += v; }),
      [`append(J)${L}`]: app(function (v) { this.s += v; }),
      [`append(F)${L}`]: app(function (v) { this.s += fmtFloat(v); }),
      [`append(D)${L}`]: app(function (v) { this.s += fmtDouble(v); }),
      [`append(Z)${L}`]: app(function (v) { this.s += v ? "true" : "false"; }),
      [`append(C)${L}`]: appendChar,
      [`append([C)${L}`]: app(function (v: Uint16Array) { this.s += charsToString(v, 0, v.length); }),
      [`append([CII)${L}`]: function (this: JSB, v: Uint16Array, o: number, n: number) { this.s += charsToString(v, o, n); return this; },
      "toString()Ljava/lang/String;": function (this: JSB) { return this.s; },
      "length()I": function (this: JSB) { return this.s.length; },
      "charAt(I)C": function (this: JSB, i: number) { return this.s.charCodeAt(i); },
      [`appendCodePoint(I)L${name};`]: function (this: JSB, cp: number) { this.s += String.fromCodePoint(cp); return this; },
      [`replace(IILjava/lang/String;)L${name};`]: function (this: JSB, a: number, b: number, r: string) {
        this.s = this.s.slice(0, a) + r + this.s.slice(Math.min(b, this.s.length));
        return this;
      },
      "setLength(I)V": function (this: JSB, n: number) {
        this.s = n <= this.s.length ? this.s.slice(0, n) : this.s.padEnd(n, "\0");
      },
      [`reverse()${L}`]: function (this: JSB) { this.s = [...this.s].reverse().join(""); return this; },
      [`insert(ILjava/lang/String;)${L}`]: function (this: JSB, i: number, v: string) {
        this.s = this.s.slice(0, i) + (v === null ? "null" : v) + this.s.slice(i); return this;
      },
      [`insert(IC)${L}`]: function (this: JSB, i: number, v: number) {
        this.s = this.s.slice(0, i) + String.fromCharCode(v) + this.s.slice(i); return this;
      },
      [`insert(II)${L}`]: function (this: JSB, i: number, v: number) {
        this.s = this.s.slice(0, i) + v + this.s.slice(i); return this;
      },
      [`deleteCharAt(I)${L}`]: function (this: JSB, i: number) {
        this.s = this.s.slice(0, i) + this.s.slice(i + 1); return this;
      },
      [`delete(II)${L}`]: function (this: JSB, a: number, b: number) {
        this.s = this.s.slice(0, a) + this.s.slice(b); return this;
      },
      "indexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.indexOf(v); },
      "lastIndexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.lastIndexOf(v); },
      "substring(I)Ljava/lang/String;": function (this: JSB, i: number) { return this.s.slice(i); },
      "substring(II)Ljava/lang/String;": function (this: JSB, a: number, b: number) { return this.s.slice(a, b); },
      "subSequence(II)Ljava/lang/CharSequence;": function (this: JSB, a: number, b: number) { return this.s.slice(a, b); },
      "setCharAt(IC)V": function (this: JSB, i: number, c: number) {
        this.s = this.s.slice(0, i) + String.fromCharCode(c) + this.s.slice(i + 1);
      },
    },
  };
}
rt.register(sbSpec("java/lang/StringBuilder"));
rt.register(sbSpec("java/lang/StringBuffer"));

class JNumber extends JObj {}
rt.register({
  name: "java/lang/Number", ctor: JNumber, ifaces: ["java/io/Serializable"],
  methods: { "<init>()V": function () {} },
});

export class JInt extends JNumber { v = 0; }
export class JLong extends JNumber { v = 0n; }
export class JFloat extends JNumber { v = 0; }
export class JDouble extends JNumber { v = 0; }
export class JByte extends JNumber { v = 0; }
export class JShort extends JNumber { v = 0; }
export class JBool extends JObj { v = 0; }
export class JChar extends JObj { v = 0; }

const intCache: JInt[] = [];
export function boxInt(v: number): JInt {
  if (v < -128 || v > 255) return box(JInt, v);
  return intCache[v + 128] ??= box(JInt, v);
}
/** compareTo for every box class: `v` holds the number/bigint */
const cmpV = function (this: { v: number | bigint }, o: { v: number | bigint }) { return this.v < o.v ? -1 : this.v > o.v ? 1 : 0; };
function nfe(s: unknown): never {
  throw rt.mkThrowable("java/lang/NumberFormatException", `For input string: "${s}"`);
}
function parseIntJ(s: string, radix = 10): number {
  if (typeof s !== "string" || !/^[+-]?[0-9a-zA-Z]+$/.test(s)) nfe(s);
  const v = parseInt(s, radix);
  if (Number.isNaN(v) || v > 2147483647 || v < -2147483648) nfe(s);
  return v | 0;
}
const numCommon = (kind: "I" | "J" | "F" | "D" | "B" | "S") => ({
  "intValue()I": function (this: { v: number | bigint }) { return typeof this.v === "bigint" ? Number(BigInt.asIntN(32, this.v)) : this.v | 0; },
  "longValue()J": function (this: { v: number | bigint }) { return typeof this.v === "bigint" ? this.v : BigInt(Math.trunc(this.v)); },
  "floatValue()F": function (this: { v: number | bigint }) { return Math.fround(Number(this.v)); },
  "doubleValue()D": function (this: { v: number | bigint }) { return Number(this.v); },
  "byteValue()B": function (this: { v: number | bigint }) { return (Number(this.v) << 24) >> 24; },
  "shortValue()S": function (this: { v: number | bigint }) { return (Number(this.v) << 16) >> 16; },
  "hashCode()I": function (this: { v: number | bigint }) {
    if (kind === "J") { const x = this.v as bigint; return Number(BigInt.asIntN(32, x ^ (x >> 32n))); }
    return Number(this.v) | 0;
  },
  "toString()Ljava/lang/String;": function (this: { v: number | bigint }) {
    return kind === "F" ? fmtFloat(this.v as number) : kind === "D" ? fmtDouble(this.v as number) : String(this.v);
  },
});
rt.register({
  name: "java/lang/Integer", ctor: JInt, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 2147483647, MIN_VALUE: -2147483648, SIZE: 32, BYTES: 4, get TYPE() { return rt.classFor("int"); } },
  methods: {
    ...numCommon("I"),
    "<init>(I)V": function (this: JInt, v: number) { this.v = v; },
    "equals(Ljava/lang/Object;)Z": function (this: JInt, o: unknown) { return o instanceof JInt && o.v === this.v ? 1 : 0; },
    "compareTo(Ljava/lang/Integer;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "static lowestOneBit(I)I": (v: number) => v & -v,
    "static valueOf(I)Ljava/lang/Integer;": boxInt,
    "static valueOf(Ljava/lang/String;)Ljava/lang/Integer;": (s: string) => boxInt(parseIntJ(s)),
    "static parseInt(Ljava/lang/String;)I": (s: string) => parseIntJ(s),
    "static parseInt(Ljava/lang/String;I)I": (s: string, r: number) => parseIntJ(s, r),
    "static valueOf(Ljava/lang/String;I)Ljava/lang/Integer;": (s: string, r: number) => boxInt(parseIntJ(s, r)),
    "static toString(I)Ljava/lang/String;": (v: number) => String(v),
    "static toString(II)Ljava/lang/String;": (v: number, r: number) => v.toString(r),
    "static toHexString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(16),
    "static toBinaryString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(2),
    "static toOctalString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(8),
    "static compare(II)I": (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0),
    "static min(II)I": (a: number, b: number) => Math.min(a, b),
    "static max(II)I": (a: number, b: number) => Math.max(a, b),
    "static sum(II)I": (a: number, b: number) => (a + b) | 0,
    "static bitCount(I)I": (v: number) => {
      v = v - ((v >> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
      return (Math.imul((v + (v >> 4)) & 0x0f0f0f0f, 0x01010101)) >> 24;
    },
    "static numberOfLeadingZeros(I)I": (v: number) => Math.clz32(v),
    "static numberOfTrailingZeros(I)I": (v: number) => (v === 0 ? 32 : 31 - Math.clz32(v & -v)),
    "static highestOneBit(I)I": (v: number) => (v === 0 ? 0 : 1 << (31 - Math.clz32(v))),
    "static reverse(I)I": (v: number) => {
      v = ((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555);
      v = ((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333);
      v = ((v & 0x0f0f0f0f) << 4) | ((v >>> 4) & 0x0f0f0f0f);
      return ((v << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) | 0;
    },
    "static rotateLeft(II)I": (v: number, n: number) => ((v << n) | (v >>> (32 - n))) | 0,
    "static hashCode(I)I": (v: number) => v,
    "static signum(I)I": (v: number) => Math.sign(v),
  },
});
function parseLongJ(s: string): bigint {
  if (typeof s !== "string" || !/^[+-]?\d+$/.test(s)) nfe(s);
  const v = BigInt(s);
  if (v > 9223372036854775807n || v < -9223372036854775808n) nfe(s);
  return v;
}
rt.register({
  name: "java/lang/Long", ctor: JLong, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 9223372036854775807n, MIN_VALUE: -9223372036854775808n, SIZE: 64, BYTES: 8, get TYPE() { return rt.classFor("long"); } },
  methods: {
    ...numCommon("J"),
    "<init>(J)V": function (this: JLong, v: bigint) { this.v = v; },
    "equals(Ljava/lang/Object;)Z": function (this: JLong, o: unknown) { return o instanceof JLong && o.v === this.v ? 1 : 0; },
    "compareTo(Ljava/lang/Long;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "static valueOf(J)Ljava/lang/Long;": (v: bigint) => box(JLong, v),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Long;": (s: string) => box(JLong, parseLongJ(s)),
    "static parseLong(Ljava/lang/String;)J": parseLongJ,
    "static lowestOneBit(J)J": (v: bigint) => v & -v,
    "static numberOfLeadingZeros(J)I": (v: bigint) => { const x = BigInt.asUintN(64, v); const hi = Number(x >> 32n); return hi ? Math.clz32(hi) : 32 + Math.clz32(Number(x & 0xffffffffn)); },
    "static toString(JI)Ljava/lang/String;": (v: bigint, radix: number) => v.toString(radix),
    "static compareUnsigned(JJ)I": (a: bigint, b: bigint) => { const x = BigInt.asUintN(64, a), y = BigInt.asUintN(64, b); return x < y ? -1 : x > y ? 1 : 0; },
    "static divideUnsigned(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, BigInt.asUintN(64, a) / BigInt.asUintN(64, b)),
    "static remainderUnsigned(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, BigInt.asUintN(64, a) % BigInt.asUintN(64, b)),
    "static rotateRight(JI)J": (v: bigint, d: number) => { const n = BigInt(d & 63); const x = BigInt.asUintN(64, v); return BigInt.asIntN(64, (x >> n) | (x << (64n - n))); },

    "static highestOneBit(J)J": (v: bigint) => { if (v === 0n) return 0n; let x = BigInt.asUintN(64, v); let r = 1n << 62n; while (!(x & (1n << 63n))) { x <<= 1n; r >>= 1n; } return BigInt.asIntN(64, r << 1n); },
    "static reverse(J)J": (v: bigint) => { let x = BigInt.asUintN(64, v), r = 0n; for (let i = 0n; i < 64n; i++) { r = (r << 1n) | (x & 1n); x >>= 1n; } return BigInt.asIntN(64, r); },
    "static getLong(Ljava/lang/String;J)Ljava/lang/Long;": (_prop: string, def: bigint) => box(JLong, def), // system properties: none defined
    "static toString(J)Ljava/lang/String;": (v: bigint) => String(v),
    "static toHexString(J)Ljava/lang/String;": (v: bigint) => BigInt.asUintN(64, v).toString(16),
    "static compare(JJ)I": (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0),
    "static min(JJ)J": (a: bigint, b: bigint) => (a < b ? a : b),
    "static max(JJ)J": (a: bigint, b: bigint) => (a > b ? a : b),
    "static signum(J)I": (v: bigint) => (v < 0n ? -1 : v > 0n ? 1 : 0),
    "static hashCode(J)I": (v: bigint) => Number(BigInt.asIntN(32, v ^ (v >> 32n))),
    "static numberOfTrailingZeros(J)I": (v: bigint) => {
      if (v === 0n) return 64;
      let n = 0; while ((v & 1n) === 0n) { v >>= 1n; n++; }
      return n;
    },
    "static bitCount(J)I": (v: bigint) => {
      let n = 0; v = BigInt.asUintN(64, v);
      while (v) { n += Number(v & 1n); v >>= 1n; }
      return n;
    },
    "static rotateLeft(JI)J": (v: bigint, n: number) =>
      BigInt.asIntN(64, (v << BigInt(n & 63)) | (BigInt.asUintN(64, v) >> BigInt(64 - (n & 63)))),
    "static reverseBytes(J)J": (v: bigint) => {
      const u = BigInt.asUintN(64, v);
      let r = 0n;
      for (let i = 0; i < 8; i++) r |= ((u >> BigInt(i * 8)) & 0xffn) << BigInt((7 - i) * 8);
      return BigInt.asIntN(64, r);
    },
  },
});
function parseFloatJ(s: string): number {
  if (typeof s !== "string") nfe(s);
  const t = s.trim().replace(/[fFdD]$/, "");
  if (!/^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(t) && !/^[+-]?(Infinity|NaN)$/.test(t)) nfe(s);
  return parseFloat(t);
}
const isNaNZ = (v: number) => (v !== v ? 1 : 0);
const isInfZ = (v: number) => (v === Infinity || v === -Infinity ? 1 : 0);
/** Float/Double.compare: NaN sorts above everything, including itself equal */
const cmpFloat = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : a === b ? 0 : a !== a ? (b !== b ? 0 : 1) : -1);
rt.register({
  name: "java/lang/Float", ctor: JFloat, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 3.4028234663852886e38, MIN_VALUE: 1.401298464324817e-45, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN, get TYPE() { return rt.classFor("float"); } },
  methods: {
    ...numCommon("F"),
    "<init>(F)V": function (this: JFloat, v: number) { this.v = v; },
    "equals(Ljava/lang/Object;)Z": function (this: JFloat, o: unknown) { return o instanceof JFloat && Object.is(o.v, this.v) ? 1 : 0; },
    "compareTo(Ljava/lang/Float;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "static valueOf(F)Ljava/lang/Float;": (v: number) => box(JFloat, v),
    "static parseFloat(Ljava/lang/String;)F": (s: string) => Math.fround(parseFloatJ(s)),
    "static hashCode(F)I": floatToIntBits,
    "static floatToIntBits(F)I": floatToIntBits,
    "static floatToRawIntBits(F)I": floatToIntBits,
    "static intBitsToFloat(I)F": intBitsToFloat,
    "static isNaN(F)Z": isNaNZ,
    "static isInfinite(F)Z": isInfZ,
    "static compare(FF)I": cmpFloat,
    "static toString(F)Ljava/lang/String;": fmtFloat,
    "isNaN()Z": function (this: JFloat) { return isNaNZ(this.v); },
  },
});
rt.register({
  name: "java/lang/Double", ctor: JDouble, sup: "java/lang/Number",
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 1.7976931348623157e308, MIN_VALUE: 4.9e-324, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN, get TYPE() { return rt.classFor("double"); } },
  methods: {
    ...numCommon("D"),
    "<init>(D)V": function (this: JDouble, v: number) { this.v = v; },
    "equals(Ljava/lang/Object;)Z": function (this: JDouble, o: unknown) { return o instanceof JDouble && Object.is(o.v, this.v) ? 1 : 0; },
    "compareTo(Ljava/lang/Double;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "static valueOf(D)Ljava/lang/Double;": (v: number) => box(JDouble, v),
    "static parseDouble(Ljava/lang/String;)D": parseFloatJ,
    "static doubleToLongBits(D)J": doubleToLongBits,
    "static doubleToRawLongBits(D)J": doubleToLongBits,
    "static longBitsToDouble(J)D": longBitsToDouble,
    "static isNaN(D)Z": isNaNZ,
    "static isInfinite(D)Z": isInfZ,
    "static compare(DD)I": cmpFloat,
    "static hashCode(D)I": (v: number) => { const b = doubleToLongBits(v); return Number(BigInt.asIntN(32, b ^ (b >> 32n))); },
    "static toString(D)Ljava/lang/String;": fmtDouble,
    "isNaN()Z": function (this: JDouble) { return isNaNZ(this.v); },
    "isInfinite()Z": function (this: JDouble) { return isInfZ(this.v); },
  },
});
rt.register({
  name: "java/lang/Byte", ctor: JByte, sup: "java/lang/Number",
  statics: { MAX_VALUE: 127, MIN_VALUE: -128, get TYPE() { return rt.classFor("byte"); } },
  methods: {
    ...numCommon("B"),
    "static valueOf(B)Ljava/lang/Byte;": (v: number) => box(JByte, v),
    "static parseByte(Ljava/lang/String;)B": (s: string) => parseIntJ(s) << 24 >> 24,
    "equals(Ljava/lang/Object;)Z": function (this: JByte, o: unknown) { return o instanceof JByte && o.v === this.v ? 1 : 0; },
  },
});
rt.register({
  name: "java/lang/Short", ctor: JShort, sup: "java/lang/Number",
  statics: { MAX_VALUE: 32767, MIN_VALUE: -32768, get TYPE() { return rt.classFor("short"); } },
  methods: {
    ...numCommon("S"),
    "static valueOf(S)Ljava/lang/Short;": (v: number) => box(JShort, v),
    "equals(Ljava/lang/Object;)Z": function (this: JShort, o: unknown) { return o instanceof JShort && o.v === this.v ? 1 : 0; },
  },
});
export const TRUE = new JBool(); TRUE.v = 1;
export const FALSE = new JBool();
rt.register({
  name: "java/lang/Boolean", ctor: JBool,
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { TRUE, FALSE, get TYPE() { return rt.classFor("boolean"); } },
  methods: {
    "<init>(Z)V": function (this: JBool, v: number) { this.v = v; },
    "booleanValue()Z": function (this: JBool) { return this.v; },
    "equals(Ljava/lang/Object;)Z": function (this: JBool, o: unknown) { return o instanceof JBool && o.v === this.v ? 1 : 0; },
    "hashCode()I": function (this: JBool) { return this.v ? 1231 : 1237; },
    "toString()Ljava/lang/String;": function (this: JBool) { return this.v ? "true" : "false"; },
    "static valueOf(Z)Ljava/lang/Boolean;": (v: number) => (v ? TRUE : FALSE),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Boolean;": (s: string) => (s?.toLowerCase() === "true" ? TRUE : FALSE),
    "static parseBoolean(Ljava/lang/String;)Z": (s: string) => (s?.toLowerCase() === "true" ? 1 : 0),
    "static toString(Z)Ljava/lang/String;": (v: number) => (v ? "true" : "false"),
    "static hashCode(Z)I": (v: number) => (v ? 1231 : 1237),
    "compareTo(Ljava/lang/Boolean;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "static compare(ZZ)I": (a: number, b: number) => (a === b ? 0 : a ? 1 : -1),
    "static logicalAnd(ZZ)Z": (a: number, b: number) => (a && b ? 1 : 0),
    "static logicalOr(ZZ)Z": (a: number, b: number) => (a || b ? 1 : 0),
    "static logicalXor(ZZ)Z": (a: number, b: number) => ((a ? 1 : 0) ^ (b ? 1 : 0)),
  },
});
rt.register({
  name: "java/lang/Character", ctor: JChar,
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 0xffff, MIN_VALUE: 0, get TYPE() { return rt.classFor("char"); } },
  methods: {
    "static charCount(I)I": (cp: number) => (cp >= 0x10000 ? 2 : 1),
    "static toChars(I)[C": (cp: number) => { const str = String.fromCodePoint(cp); const a = new Uint16Array(str.length); for (let k = 0; k < str.length; k++) a[k] = str.charCodeAt(k); return a; },
    "static codePointAt(Ljava/lang/CharSequence;I)I": (cs: unknown, i2: number) => String(cs).codePointAt(i2) ?? 0,
    "static isSupplementaryCodePoint(I)Z": (cp: number) => (cp >= 0x10000 ? 1 : 0),
    "static isHighSurrogate(C)Z": (c: number) => (c >= 0xd800 && c <= 0xdbff ? 1 : 0),
    "static isLowSurrogate(C)Z": (c: number) => (c >= 0xdc00 && c <= 0xdfff ? 1 : 0),
    "static isSurrogate(C)Z": (c: number) => (c >= 0xd800 && c <= 0xdfff ? 1 : 0),
    "static toCodePoint(CC)I": (h: number, l: number) => ((h - 0xd800) << 10) + (l - 0xdc00) + 0x10000,
    "static isISOControl(I)Z": (c: number) => ((c >= 0 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f) ? 1 : 0),
    "static isDefined(I)Z": () => 1,
    "<init>(C)V": function (this: JChar, v: number) { this.v = v; },
    "charValue()C": function (this: JChar) { return this.v; },
    "equals(Ljava/lang/Object;)Z": function (this: JChar, o: unknown) { return o instanceof JChar && o.v === this.v ? 1 : 0; },
    "hashCode()I": function (this: JChar) { return this.v; },
    "toString()Ljava/lang/String;": function (this: JChar) { return String.fromCharCode(this.v); },
    "static valueOf(C)Ljava/lang/Character;": (v: number) => box(JChar, v),
    "static toString(C)Ljava/lang/String;": (v: number) => String.fromCharCode(v),
    "static isDigit(C)Z": (c: number) => (c >= 48 && c <= 57 ? 1 : 0),
    "static isLetter(C)Z": (c: number) => (/\p{L}/u.test(String.fromCharCode(c)) ? 1 : 0),
    "static isLetterOrDigit(C)Z": (c: number) => (/[\p{L}\p{Nd}]/u.test(String.fromCharCode(c)) ? 1 : 0),
    "static isWhitespace(C)Z": (c: number) => (/\s/.test(String.fromCharCode(c)) ? 1 : 0),
    "static isSpaceChar(C)Z": (c: number) => (/\s/.test(String.fromCharCode(c)) ? 1 : 0),
    "static isUpperCase(C)Z": (c: number) => { const s = String.fromCharCode(c); return s !== s.toLowerCase() && s === s.toUpperCase() ? 1 : 0; },
    "static isLowerCase(C)Z": (c: number) => { const s = String.fromCharCode(c); return s !== s.toUpperCase() && s === s.toLowerCase() ? 1 : 0; },
    "static toUpperCase(C)C": (c: number) => String.fromCharCode(c).toUpperCase().charCodeAt(0),
    "static toLowerCase(C)C": (c: number) => String.fromCharCode(c).toLowerCase().charCodeAt(0),
    "static digit(CI)I": (c: number, r: number) => { const d = parseInt(String.fromCharCode(c), r); return Number.isNaN(d) ? -1 : d; },
    // the code-point overload: same digit, an int rather than a char
    "static digit(II)I": (cp: number, r: number) => { const d = parseInt(String.fromCodePoint(cp), r); return Number.isNaN(d) ? -1 : d; },
    "static getNumericValue(C)I": (c: number) => { const d = parseInt(String.fromCharCode(c), 36); return Number.isNaN(d) ? -1 : d; },
    "static forDigit(II)C": (d: number, r: number) => d.toString(r).charCodeAt(0),
  },
});

class JMath extends JObj {}
const mm: Record<string, (...a: never[]) => unknown> = {};
for (const t of ["I", "J", "F", "D"]) {
  mm[`static abs(${t})${t}`] = t === "J" ? (v: bigint) => (v < 0n ? -v : v) : (v: number) => Math.abs(v);
  mm[`static max(${t}${t})${t}`] = t === "J" ? (a: bigint, b: bigint) => (a > b ? a : b) : (a: number, b: number) => Math.max(a, b);
  mm[`static min(${t}${t})${t}`] = t === "J" ? (a: bigint, b: bigint) => (a < b ? a : b) : (a: number, b: number) => Math.min(a, b);
}
for (const f of ["sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "log10", "cbrt", "sinh", "cosh", "tanh", "floor", "ceil"] as const) {
  mm[`static ${f}(D)D`] = (v: number) => Math[f](v);
}
rt.register({
  name: "java/lang/Math", ctor: JMath,
  statics: { PI: Math.PI, E: Math.E },
  methods: {
    ...mm,
    "static pow(DD)D": (a: number, b: number) => Math.pow(a, b),
    "static multiplyExact(II)I": (a: number, b: number) => Math.imul(a, b),
    "static multiplyExact(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, a * b),
    "static multiplyExact(JI)J": (a: bigint, b: number) => BigInt.asIntN(64, a * BigInt(b)),
    "static addExact(II)I": (a: number, b: number) => (a + b) | 0,
    "static addExact(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, a + b),
    "static subtractExact(II)I": (a: number, b: number) => (a - b) | 0,
    "static subtractExact(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, a - b),
    "static toIntExact(J)I": (a: bigint) => Number(BigInt.asIntN(32, a)),
    "static floorDiv(II)I": (a: number, b: number) => Math.floor(a / b) | 0,
    "static floorDiv(JJ)J": (a: bigint, b: bigint) => { let q = a / b; if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; return q; },
    "static floorMod(II)I": (a: number, b: number) => ((a % b) + b) % b | 0,
    "static floorMod(JJ)J": (a: bigint, b: bigint) => ((a % b) + b) % b,
    "static atan2(DD)D": (a: number, b: number) => Math.atan2(a, b),
    "static hypot(DD)D": (a: number, b: number) => Math.hypot(a, b),
    "static random()D": () => Math.random(),
    // Math.round SATURATES at the type's bounds and maps NaN to 0 (JLS 15.1.4); `|0` wraps,
    // and BigInt(NaN) throws. Compose reaches these through Dp.roundToPx on infinite
    // constraints, where the difference is a wrapped negative padding instead of a clamp.
    "static round(D)J": (v: number) => rt.f2l(Math.round(v)),
    "static round(F)I": (v: number) => rt.f2i(Math.round(v)),
    "static rint(D)D": (v: number) => { const r = Math.round(v); return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r; },
    "static signum(D)D": (v: number) => Math.sign(v),
    "static signum(F)F": (v: number) => Math.sign(v),
    "static toRadians(D)D": (v: number) => (v * Math.PI) / 180,
    "static toDegrees(D)D": (v: number) => (v * 180) / Math.PI,
  },
});

class JSystem extends JObj {}
function arraycopy(src: any, sp: number, dst: any, dp: number, len: number) {
  if (src === null || dst === null) rt.npe();
  if (len === 0) return;
  if (ArrayBuffer.isView(src)) {
    (dst as { set(a: unknown, o: number): void }).set((src as Uint8Array).subarray(sp, sp + len), dp);
  } else if (src === dst && dp > sp) {
    for (let i = len - 1; i >= 0; i--) dst[dp + i] = src[sp + i];
  } else {
    for (let i = 0; i < len; i++) dst[dp + i] = src[sp + i];
  }
}
const loadedLibs = new Set<string>();
/** what a device this shape carries, most-preferred first. Which of them we can EXECUTE is the
 *  native tier's answer (rt.nativeAbis), and a library we can run beats one we cannot. */
const ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86_64", "x86"];
/** the ABI an apk's lib/ would be loaded from: the first the tier runs, else the first present
 *  — so the UnsatisfiedLinkError names the machine code the device would actually have used */
function pickAbi(has: (abi: string) => boolean): string | null {
  return rt.nativeAbis.find(has) ?? ABIS.find(has) ?? null;
}
const E_MACHINE: Record<number, string> = { 0xb7: "arm64-v8a", 0x28: "armeabi", 0x3e: "x86_64", 0x03: "x86" };
/** every way this ends without the library loaded: the app is going to get an
 *  UnsatisfiedLinkError, and the shell says which machine code it would have taken. */
function needsNative(lib: string, abi: string): void {
  rt.nativeRequired.set(lib, abi);
  rt.onNativeRequired(lib, abi);
}
/** dlopen: a lib whose natives a TS shim claims loads; anything else is machine code we cannot run, said so */
async function dlopen(lib: string, abi: () => string | null, bytes: (a: string) => Uint8Array | null = () => null): Promise<void> {
  if (rt.nativeLibs.has(lib.replace(/^lib|\.so$/g, "")) || loadedLibs.has(lib)) {
    if (!loadedLibs.has(lib)) { loadedLibs.add(lib); console.log("[webdroid] loadLibrary", lib); }
    return;
  }
  const a = abi();
  // an ABI the native tier can run (src/native/loader.ts) loads for real; the rest is honest
  const b = a && rt.loadNativeLib ? bytes(a) : null;
  if (a && b && rt.loadNativeLib) {
    loadedLibs.add(lib);
    console.log("[webdroid] loadLibrary", lib, a);
    // a load that faults part-way is machine code we could not run too, whatever the reason:
    // an ABI the tier rejects, an instruction it cannot decode, a symbol it cannot resolve
    try { return await rt.loadNativeLib(lib, b, a); }
    catch (e) { loadedLibs.delete(lib); needsNative(lib, a); throw e; }
  }
  if (a) needsNative(lib, a);
  throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${lib}" ${a ? "is " + a + " machine code" : "not found"}`);
}
const loadLibrary = async (n: string) => dlopen(`lib${n}.so`, () => pickAbi((a) => !!rt.classpath[`lib/${a}/lib${n}.so`]),
  (a) => rt.classpath[`lib/${a}/lib${n}.so`] ?? null);
const sysProps: Record<string, string> = {
  "java.version": "0", "os.name": "Linux", "line.separator": "\n",
  "java.vm.name": "webdroid", "file.separator": "/", "path.separator": ":",
  "java.io.tmpdir": "/data/local/tmp", "user.dir": "/",
};
rt.register({
  name: "java/lang/System", ctor: JSystem,
  statics: { out: null, err: null, "in": null }, // filled by jio
  methods: {
    "static arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V": arraycopy,
    "static currentTimeMillis()J": () => BigInt(Date.now()),
    "static nanoTime()J": () => BigInt(Math.floor(performance.now() * 1e6)),
    "static identityHashCode(Ljava/lang/Object;)I": idHash,
    "static getProperty(Ljava/lang/String;)Ljava/lang/String;": (k: string) => sysProps[k] ?? null,
    "static getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (k: string, d: string) => sysProps[k] ?? d,
    "static setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (k: string, v: string) => { const o = sysProps[k] ?? null; sysProps[k] = v; return o; },
    "static getenv(Ljava/lang/String;)Ljava/lang/String;": () => null,
    // Android has never installed one; code that asks is deciding whether it may reflect
    "static getSecurityManager()Ljava/lang/SecurityManager;": () => null,
    "static gc()V": () => {},
    "static exit(I)V": (c: number) => { console.warn("System.exit", c); },
    "static loadLibrary(Ljava/lang/String;)V": loadLibrary,
    "static load(Ljava/lang/String;)V": async (path: string) => {
      // jio imports this module, so its vfs is reached lazily rather than through a static cycle
      const { vfs } = await import("./jio");
      await dlopen(path.slice(path.lastIndexOf("/") + 1), () => {
        const b = vfs.read(path);
        return b ? E_MACHINE[b[18] | (b[19] << 8)] ?? "unknown" : null;
      }, () => vfs.read(path));
    },
    "static mapLibraryName(Ljava/lang/String;)Ljava/lang/String;": (n: string) => `lib${n}.so`,
    "static lineSeparator()Ljava/lang/String;": () => "\n",
  },
});

class JRuntimeCls extends JObj {}
const theRuntime = new JRuntimeCls();
rt.register({
  name: "java/lang/Runtime", ctor: JRuntimeCls,
  methods: {
    "static getRuntime()Ljava/lang/Runtime;": () => theRuntime,
    "availableProcessors()I": () => (globalThis.navigator?.hardwareConcurrency ?? 4),
    "maxMemory()J": () => 536870912n,
    "totalMemory()J": () => 268435456n,
    "freeMemory()J": () => 134217728n,
    "gc()V": () => {},
    // There is no process table behind this. A device answers for a program it cannot find the
    // same way, and callers probing for one (root checks, getprop readers) have that catch.
    "exec([Ljava/lang/String;)Ljava/lang/Process;": (cmd: unknown[]) => {
      throw rt.mkThrowable("java/io/IOException", `Cannot run program "${cmd?.[0] ?? ""}": error=2, No such file or directory`);
    },
    "loadLibrary0(Ljava/lang/Class;Ljava/lang/String;)V": async (_c: unknown, n: string) => loadLibrary(n),
  },
});

export class JThread extends JObj {
  jname = "Thread";
  daemon = 0;
  alive = 0;
  prio = 5;
  target: unknown = null;   // Runnable
  locals = new Map<object, unknown>();
  interrupted = 0;
  wake: (() => void) | null = null;
  done: Promise<void> | null = null;
  looper: unknown = null;   // android Looper, set by android/os
}
export const mainThread = new JThread();
mainThread.jname = "main";
mainThread.alive = 1;
export let curThread = mainThread;
rt.th = () => curThread;
rt.st = (t) => { curThread = t as JThread; };
rt.su = () => { curThread = mainThread; };
class JDefaultUEH extends JObj {}
rt.register({
  name: "webdroid/DefaultUEH", ctor: JDefaultUEH, ifaces: ["java/lang/Thread$UncaughtExceptionHandler"],
  methods: {
    // AOSP's LoggingHandler prints the whole trace; the "Caused by" chain is what names the real fault
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": async (_t: unknown, e: unknown) => {
      console.error("[uncaughtException]", e instanceof JThrowable ? await stackTraceText(e) : e);
    },
  },
});
let defaultUEH: unknown = new JDefaultUEH();
export function setCurThread(t: JThread) { curThread = t; }
let threadCounter = 0;
const nextThreadName = () => "Thread-" + threadCounter++;

// Parks `t` until `wake` is called (notify/signal), the timeout elapses, or the thread is
// interrupted: resolves true on a wake, false on a timeout, rejects with InterruptedException on
// an interrupt — including one already pending, which Java checks before blocking. `arm`
// enqueues the waiter and returns its dequeue, so neither a timeout nor an interrupt leaves a
// dead entry behind to swallow a later notify meant for someone else.
export function park(t: JThread, arm: (wake: () => void) => () => void, timeoutMs?: number): Promise<boolean> {
  const ie = () => rt.mkThrowable("java/lang/InterruptedException", null);
  if (t.interrupted) { t.interrupted = 0; return Promise.reject(ie()); }
  return new Promise<boolean>((resolve, reject) => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const disarm = arm(() => { t.wake = null; clearTimeout(id); resolve(true); });
    // a delay past 2^31-1 ms overflows setTimeout and fires at once; treat it as untimed
    if (timeoutMs !== undefined && timeoutMs < 0x7fffffff) id = setTimeout(() => { disarm(); t.wake = null; resolve(false); }, timeoutMs);
    t.wake = () => { disarm(); t.wake = null; clearTimeout(id); t.interrupted = 0; reject(ie()); };
  });
}

function join(t: JThread, ms: number): Promise<void> | undefined {
  const done = t.done;
  if (!done || ms <= 0) return done ?? undefined;
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    void done.then(() => { clearTimeout(id); resolve(); });
  });
}


rt.register({
  name: "java/lang/Thread", ctor: JThread,
  ifaces: ["java/lang/Runnable"],
  methods: {
    "<init>()V": function (this: JThread) { this.jname = nextThreadName(); },
    "<init>(Ljava/lang/Runnable;)V": function (this: JThread, r: unknown) { this.target = r; this.jname = nextThreadName(); },
    "<init>(Ljava/lang/Runnable;Ljava/lang/String;)V": function (this: JThread, r: unknown, n: string) { this.target = r; this.jname = n; },
    "<init>(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "getName()Ljava/lang/String;": function (this: JThread) { return this.jname; },
    "setName(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "setDaemon(Z)V": function (this: JThread, d: number) { this.daemon = d; },
    "isDaemon()Z": function (this: JThread) { return this.daemon; },
    "setPriority(I)V": function (this: JThread, p: number) { this.prio = p; },
    "getPriority()I": function (this: JThread) { return this.prio; },
    "isAlive()Z": function (this: JThread) { return this.alive; },
    "getId()J": function (this: JThread) { return BigInt(idHash(this)); },
    "isInterrupted()Z": function (this: JThread) { return this.interrupted; },
    "interrupt()V": function (this: JThread) { this.interrupted = 1; this.wake?.(); },
    "start()V": function (this: JThread) {
      this.alive = 1;
      // the body begins now, not after the caller's whole main-looper job: a thread that
      // publishes its Handler has it by the time the next lifecycle call posts to it
      this.done = new Promise((resolve) => {
        queueMicrotask(async () => {
          const prev = curThread;
          curThread = this;
          try { await vcall(this, "run", "()V"); }
          catch (e) { console.error("[thread " + this.jname + "]", e); }
          finally { this.alive = 0; curThread = prev; resolve(); }
        });
      });
    },
    "run()V": async function (this: JThread) {
      if (this.target) await vcall(this.target, "run", "()V");
    },
    "join()V": function (this: JThread) { return this.done ?? undefined; },
    "join(J)V": function (this: JThread, ms: bigint) { return join(this, Number(ms)); },
    "join(JI)V": function (this: JThread, ms: bigint, ns: number) { return join(this, Number(ms) + (ns > 0 ? 1 : 0)); },
    "getThreadGroup()Ljava/lang/ThreadGroup;": () => mainGroup,
    "getContextClassLoader()Ljava/lang/ClassLoader;": () => bootLoader,
    "setContextClassLoader(Ljava/lang/ClassLoader;)V": () => {},
    "getStackTrace()[Ljava/lang/StackTraceElement;": () => jsStackTrace(new Error().stack),
    "static currentThread()Ljava/lang/Thread;": () => curThread,
    "static getDefaultUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": () => defaultUEH,
    "getUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": () => defaultUEH,
    "setUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": () => {},
    "static setDefaultUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": (h: unknown) => { defaultUEH = h; },
    "static sleep(J)V": (ms: bigint) => park(curThread, () => () => {}, Number(ms)),
    "static yield()V": () => new Promise((r) => setTimeout(r, 0)),
    "static interrupted()Z": () => { const v = curThread.interrupted; curThread.interrupted = 0; return v; },
  },
});

// One ThreadGroup for the process: crash handlers and thread factories walk up to it, and its
// parent chain ends here (ART's "main" group under "system").
class JThreadGroup extends JObj { gname = "main"; }
const mainGroup = new JThreadGroup();
rt.register({
  name: "java/lang/ThreadGroup", ctor: JThreadGroup,
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JThreadGroup, n: string) { this.gname = n; },
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V": function (this: JThreadGroup, _p: unknown, n: string) { this.gname = n; },
    "getName()Ljava/lang/String;": function (this: JThreadGroup) { return this.gname; },
    "getParent()Ljava/lang/ThreadGroup;": function (this: JThreadGroup) { return this === mainGroup ? null : mainGroup; },
    "activeCount()I": () => 1,
    "enumerate([Ljava/lang/Thread;)I": (a: unknown[]) => { if (a.length) a[0] = curThread; return a.length ? 1 : 0; },
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": (_t: unknown, e: unknown) => { console.error("[uncaught]", e); },
    "toString()Ljava/lang/String;": function (this: JThreadGroup) { return `java.lang.ThreadGroup[name=${this.gname},maxpri=10]`; },
  },
});

class JThreadLocal extends JObj {}
rt.register({
  name: "webdroid/SuppliedThreadLocal", ctor: class extends JThreadLocal { supplier: unknown = null; }, sup: "java/lang/ThreadLocal",
  methods: { "initialValue()Ljava/lang/Object;": function (this: { supplier: unknown }) { return vcall(this.supplier, "get", "()Ljava/lang/Object;"); } },
});
rt.register({
  name: "java/lang/ThreadLocal", ctor: JThreadLocal,
  methods: {
    "<init>()V": function () {},
    // curThread is a global: pin the thread BEFORE initialValue suspends, or the value is
    // stored on whichever thread happened to be current when it resolved and read back as null.
    "get()Ljava/lang/Object;": async function (this: JThreadLocal) {
      const t = curThread;
      if (!t.locals.has(this)) {
        const v = await vcall(this, "initialValue", "()Ljava/lang/Object;");
        if (!t.locals.has(this)) t.locals.set(this, v);
      }
      return t.locals.get(this) ?? null;
    },
    "set(Ljava/lang/Object;)V": function (this: JThreadLocal, v: unknown) { curThread.locals.set(this, v); },
    "remove()V": function (this: JThreadLocal) { curThread.locals.delete(this); },
    "initialValue()Ljava/lang/Object;": function () { return null; },
    "static withInitial(Ljava/util/function/Supplier;)Ljava/lang/ThreadLocal;": (sup: unknown) => {
      if (sup == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const t = new (rt.link("webdroid/SuppliedThreadLocal").ctor)();
      t.supplier = sup;
      return t;
    },
  },
});

export class JEnum extends JObj {
  ename = "";
  ord = 0;
}
rt.register({
  name: "java/lang/Enum", ctor: JEnum,
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;I)V": function (this: JEnum, n: string, o: number) { this.ename = n; this.ord = o; },
    "name()Ljava/lang/String;": function (this: JEnum) { return this.ename; },
    "ordinal()I": function (this: JEnum) { return this.ord; },
    "toString()Ljava/lang/String;": function (this: JEnum) { return this.ename; },
    "equals(Ljava/lang/Object;)Z": function (this: JEnum, o: unknown) { return this === o ? 1 : 0; },
    "hashCode()I": function (this: JEnum) { return idHash(this); },
    "compareTo(Ljava/lang/Enum;)I": enumCmp,
    "compareTo(Ljava/lang/Object;)I": enumCmp,
    "getDeclaringClass()Ljava/lang/Class;": function (this: JEnum) {
      let i: ClassInfo | undefined = (this.constructor as any).$i;
      while (i && i.superInfo && i.superInfo.name !== "java/lang/Enum") i = i.superInfo;
      return rt.classFor(i?.name ?? "java/lang/Enum");
    },
    "static valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;": async function (cls: JClass, n: string) {
      const info = cls.ci!;
      const p = rt.initClass(info); if (p) await p;
      return enumValueOf(await vcall(info.ctor, "values", `()[L${info.name};`), n);
    },
  },
});
function enumCmp(this: JEnum, o: JEnum) { return this.ord - o.ord; }
function enumValueOf<T extends JEnum>(values: T[], name: string): T {
  const v = values.find((e) => e.ename === name);
  if (!v) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No enum constant " + name);
  return v;
}
/**
 * A Java enum with nothing behind it but its constants: registers the class (a fresh ctor per
 * enum, so each has its own statics and ClassInfo), and returns the constants in declaration
 * order. `extra` adds methods a specific enum needs beyond Enum's own (name/ordinal/toString/
 * compareTo come from java/lang/Enum via the prototype chain).
 */
export class JSimpleEnum extends JEnum {}
export function mkEnumSet(cls: string, names: string[], extra: NativeSpec["methods"] = {}): JSimpleEnum[] {
  const ctor = class extends JSimpleEnum {};
  const vals = names.map((n, i) => { const e = new ctor(); e.ename = n; e.ord = i; return e; });
  rt.register({
    name: cls, ctor, sup: "java/lang/Enum",
    statics: Object.fromEntries(names.map((n, i) => [n, vals[i]])),
    methods: {
      [`static values()[L${cls};`]: () => jarray(vals.slice(), `L${cls};`),
      [`static valueOf(Ljava/lang/String;)L${cls};`]: (n: string) => enumValueOf(vals, n),
      ...extra,
    },
  });
  return vals;
}

rt.register({ name: "java/lang/Thread$UncaughtExceptionHandler", ctor: class extends JObj {} });
mkEnumSet("java/lang/Thread$State", ["NEW", "RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "TERMINATED"]);

// java.lang.Character.UnicodeScript. Java's constant names ARE Unicode's script names, and the
// regex engine already carries the table, so `of()` is a property test rather than a range list.
const SCRIPT_NAMES = ["COMMON", "LATIN", "GREEK", "CYRILLIC", "ARMENIAN", "HEBREW", "ARABIC", "SYRIAC",
  "THAANA", "DEVANAGARI", "BENGALI", "GURMUKHI", "GUJARATI", "ORIYA", "TAMIL", "TELUGU", "KANNADA",
  "MALAYALAM", "SINHALA", "THAI", "LAO", "TIBETAN", "MYANMAR", "GEORGIAN", "HANGUL", "ETHIOPIC",
  "CHEROKEE", "OGHAM", "RUNIC", "KHMER", "MONGOLIAN", "HIRAGANA", "KATAKANA", "BOPOMOFO", "HAN",
  "YI", "GOTHIC", "DESERET", "CANADIAN_ABORIGINAL", "TAGALOG", "BRAILLE", "CHAM", "COPTIC",
  "GLAGOLITIC", "JAVANESE", "TIFINAGH", "VAI", "INHERITED", "UNKNOWN"];
const scriptRe = SCRIPT_NAMES.map((n) => {
  const uni = n.toLowerCase().split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("_");
  try { return new RegExp(`\\p{Script=${uni}}`, "u"); } catch { return null; }
});
const scriptMemo = new Map<number, unknown>();
const scriptEnums = mkEnumSet("java/lang/Character$UnicodeScript", SCRIPT_NAMES, {
  "static of(I)Ljava/lang/Character$UnicodeScript;": (cp: number) => {
    let hit = scriptMemo.get(cp);
    if (hit !== undefined) return hit;
    if (cp < 0 || cp > 0x10ffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid code point");
    const ch = String.fromCodePoint(cp);
    hit = scriptEnums[SCRIPT_NAMES.length - 1];
    for (let i = 0; i < scriptRe.length; i++) if (scriptRe[i]?.test(ch)) { hit = scriptEnums[i]; break; }
    scriptMemo.set(cp, hit);
    return hit;
  },
  "static forName(Ljava/lang/String;)Ljava/lang/Character$UnicodeScript;": (n: string) => {
    const i = SCRIPT_NAMES.indexOf(String(n).toUpperCase().replace(/[- ]/g, "_"));
    if (i < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", String(n));
    return scriptEnums[i];
  },
});

// java.lang.ref basics
class JRef extends JObj { referent: unknown = null; }
rt.register({
  name: "java/lang/ref/Reference", ctor: JRef,
  methods: {
    "get()Ljava/lang/Object;": function (this: JRef) { return this.referent; },
    "clear()V": function (this: JRef) { this.referent = null; },
  },
});
class JWeakRef extends JRef { wr: WeakRef<object> | null = null; }
rt.register({
  name: "java/lang/ref/WeakReference", ctor: JWeakRef, sup: "java/lang/ref/Reference",
  methods: {
    "<init>(Ljava/lang/Object;)V": function (this: JWeakRef, o: object) { this.wr = o ? new WeakRef(o) : null; },
    "<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V": function (this: JWeakRef, o: object) { this.wr = o ? new WeakRef(o) : null; },
    "get()Ljava/lang/Object;": function (this: JWeakRef) { return this.wr?.deref() ?? null; },
    "clear()V": function (this: JWeakRef) { this.wr = null; },
  },
});
rt.register({
  name: "java/lang/ref/SoftReference", ctor: class extends JRef {}, sup: "java/lang/ref/Reference",
  methods: {
    "<init>(Ljava/lang/Object;)V": function (this: JRef, o: unknown) { this.referent = o; },
    "<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V": function (this: JRef, o: unknown) { this.referent = o; },
  },
});
rt.register({ name: "java/lang/ref/ReferenceQueue", ctor: class extends JObj {}, methods: { "<init>()V": function () {}, "poll()Ljava/lang/ref/Reference;": () => null } });

rt.register({
  name: "java/lang/reflect/Modifier", ctor: class extends JObj {},
  statics: { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 16, ABSTRACT: 1024 },
  methods: {
    "static isPublic(I)Z": (m: number) => (m & 1 ? 1 : 0),
    "static isStatic(I)Z": (m: number) => (m & 8 ? 1 : 0),
    "static isAbstract(I)Z": (m: number) => (m & 1024 ? 1 : 0),
    "static isFinal(I)Z": (m: number) => (m & 16 ? 1 : 0),
    "static isPrivate(I)Z": (m: number) => (m & 2 ? 1 : 0),
  },
});

class JStackTraceElement extends JObj { declaring = ""; method = ""; file: string | null = null; line = 0; }
rt.register({
  name: "java/lang/StackTraceElement", ctor: JStackTraceElement, ifaces: ["java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;I)V": function (this: JStackTraceElement, c: string, m: string, f: string | null, l: number) {
      this.declaring = c; this.method = m; this.file = f; this.line = l;
    },
    "getClassName()Ljava/lang/String;": function (this: JStackTraceElement) { return this.declaring; },
    "getMethodName()Ljava/lang/String;": function (this: JStackTraceElement) { return this.method; },
    "getFileName()Ljava/lang/String;": function (this: JStackTraceElement) { return this.file; },
    "getLineNumber()I": function (this: JStackTraceElement) { return this.line; },
    "toString()Ljava/lang/String;": function (this: JStackTraceElement) { return this.declaring + "." + this.method + "(" + (this.file ?? "Unknown") + ":" + this.line + ")"; },
  },
});
