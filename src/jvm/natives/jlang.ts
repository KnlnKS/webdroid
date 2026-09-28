// java.lang.* natives. Convention: Java booleans are 0/1 numbers, longs are BigInt,
// Strings are JS string primitives (String.prototype carries mangled Java methods).

import { rt, JObj, type ClassInfo, type NativeSpec, type Runtime, driven, type Gen } from "../runtime";
import { parkTimeout, unparkTimeout } from "../yield";
import { directionality } from "../bidi";
import { encodeString } from "../charset";
import { javaClassSets } from "../regex-sets";
import { coldStack, type ColdMethod } from "../cold";
import { mangleMethod, mangleStaticField, demangle, jmethod, lateMethod, descToName, charsToString, jarray, PRIM_NAME, PRIM_DESC, intBitsToFloat, floatToIntBits, longBitsToDouble, doubleToLongBits, dotName, slashName, utf8, PRIM_ARRAYS, i8, splitSig } from "../abi";
import { guestNow, type GuestTimer } from "../../guest-clock";
import { device } from "../../shell/config";
import { vfs, apkPath } from "../../shell/vfs";
import { appUserName, procIdentity } from "../../shell/procfs";
import { csText } from "./jchars";
import { mkIntStream } from "./jstream-values";

async function joinCharSequences(separator: unknown, parts: unknown[]): Promise<string> {
  if (separator == null || parts == null) rt.npe();
  const text = await csText(separator);
  const values: string[] = [];
  for (const part of parts) values.push(part == null ? "null" : await csText(part));
  return values.join(text);
}

async function joinIterable(separator: unknown, parts: unknown): Promise<string> {
  if (parts == null) rt.npe();
  const values: unknown[] = [];
  const iterator = await vcall(parts, "iterator", "()Ljava/util/Iterator;");
  while (await vcall(iterator, "hasNext", "()Z")) values.push(await vcall(iterator, "next", "()Ljava/lang/Object;"));
  return joinCharSequences(separator, values);
}


function findMethod(obj: any, name: string, desc: string): (...a: unknown[]) => unknown {
  const fn = obj[mangleMethod(name, desc)] ?? lateMethod.find?.(obj, name, desc);
  if (typeof fn !== "function") throw rt.unimplemented(`vcall ${describe(obj)}.${name}${desc}`);
  return fn;
}
/** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
export function vcall(obj: any, name: string, desc: string, ...args: unknown[]): any {
  return findMethod(obj, name, desc).apply(obj, args);
}
/** A Java call as a Promise, for callers that chain on its completion. */
export function vcallAsync(obj: unknown, name: string, desc: string, ...args: unknown[]): Promise<any> {
  try { return Promise.resolve(vcall(obj, name, desc, ...args)); } catch (e) { return Promise.reject(e); }
}
/** A call no Java frame waits on (a listener, a posted task): its exception, thrown now or when
 *  it resumes, goes to the uncaught handler rather than to the native that dispatched it. */
export function vcallUncaught(obj: unknown, name: string, desc: string, ...args: unknown[]): Promise<void> {
  return vcallAsync(obj, name, desc, ...args).then(() => {}, reportUncaught);
}
export function vcallOn(thread: JThread, obj: unknown, name: string, desc: string, ...args: unknown[]): unknown {
  return callOn(thread, () => vcall(obj, name, desc, ...args));
}
export function callOn<T>(thread: JThread, call: () => T): T {
  const previous = curThread;
  setCurThread(thread);
  try { return call(); } finally { setCurThread(previous); }
}
export const after = <R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T> =>
  (r instanceof Promise ? r.then(f) : f(r as R));
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
  const thread = curThread, info = await linkInit(cls);
  const o = callOn(thread, () => new info.ctor());
  if (desc !== null) await vcallOn(thread, o, "<init>", desc, ...args);
  return o;
}
/** a boxed primitive (Integer, Long, Float …) — every box class keeps its value in `v` */
export function box<T extends { v: unknown }>(Ctor: new () => T, v: T["v"]): T {
  const b = new Ctor();
  b.v = v;
  return b;
}

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
  if (out.includes("(?>")) out = atomicGroups(out);
  return [out, extra];
}
function atomicGroups(src: string): string {
  // A lookahead fixes the chosen alternative before its backreference consumes it.
  // Synthetic captures would shift Java group numbers, so leave those patterns unsupported.
  let escaped = false, inClass = false, depth = 0, atomic = 0, captures = false;
  const opens: number[] = [];
  const pairs = new Map<number, number>();
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "]" && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (c === "(") {
      if (src.startsWith("(?>", i)) atomic++;
      else if (src[i + 1] !== "?" || (src.startsWith("(?<", i) && !/[=!]/.test(src[i + 3] ?? ""))) captures = true;
      opens.push(i); depth++;
    } else if (c === ")") {
      if (depth) pairs.set(opens.pop()!, i);
      depth--;
    }
  }
  if (!atomic) return src;
  if (captures) throw new SyntaxError("Atomic group with capturing groups is unsupported");
  let n = 0;
  const rewrite = (start: number, end: number): string => {
    let result = "";
    for (let i = start; i < end; i++) {
      const close = pairs.get(i);
      if (close === undefined) { result += src[i]; continue; }
      const body = rewrite(i + (src.startsWith("(?>", i) ? 3 : 1), close);
      if (src.startsWith("(?>", i)) {
        const name = `__wdAtomic${n++}`;
        result += `(?:(?=(?<${name}>${body}))\\k<${name}>)`;
      } else result += `(${body})`;
      i = close;
    }
    return result;
  };
  return rewrite(0, src.length);
}
/** Java regex source + JS flags → RegExp, memoised: String.matches and Matcher rebuild theirs per call.
 *  Callers that use sticky/global flags must set lastIndex before every exec. */
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
      catch {
        try { re = new RegExp(javaClassSets(js), f.replace(/[uv]/g, "") + "v"); }
        catch { re = new RegExp(js, f.replace("u", "")); }
      }
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

const monitorMethods: NativeSpec["methods"] = {
  "notify()V": function () { rt.monitors.notify(this, curThread, false); },
  "notifyAll()V": function () { rt.monitors.notify(this, curThread, true); },
  "wait()V": function () { return monWait(this, 0); },
  "wait(J)V": function (ms: bigint) { return monWait(this, Number(ms)); },
  "wait(JI)V": function (ms: bigint, ns: number) {
    if (ms < 0n || ns < 0 || ns > 999999) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout");
    return monWait(this, Number(ms) + (ns > 0 ? 1 : 0));
  },
};
rt.register({
  name: "java/lang/Object",
  ctor: JObj,
  methods: {
    "<init>()V": function () {},
    "hashCode()I": function () { return idHash(this); },
    "equals(Ljava/lang/Object;)Z": function (o: unknown) { return this === o ? 1 : 0; },
    "toString()Ljava/lang/String;": function () {
      return dotName(jclsName(this)) + "@" + idHash(this).toString(16);
    },
    "getClass()Ljava/lang/Class;": function () { const info: ClassInfo | undefined = (this.constructor as typeof JObj).$i; return info?.jclass ?? (info?.owner ?? rt).classFor(jclsName(this)); },
    "clone()Ljava/lang/Object;": function (this: any) {
      if (Array.isArray(this) || ArrayBuffer.isView(this)) return rt.arrCall(this, "clone");
      const c = Object.create(Object.getPrototypeOf(this));
      Object.assign(c, this);
      return c;
    },
    ...monitorMethods,
  },
});
Object.defineProperty(Object.prototype, mangleMethod("getClass", "()Ljava/lang/Class;"), {
  value: function (this: unknown) { return rt.classFor(jclsName(this)); },
  writable: true, configurable: true, enumerable: false,
});
// the strings and arrays that stand for Java objects inherit these from here too
for (const [sig, fn] of Object.entries(monitorMethods))
  Object.defineProperty(Object.prototype, mangleMethod(...splitSig(sig)), { value: fn, writable: true, configurable: true, enumerable: false });

function monWait(obj: object | string, ms: number): Promise<void> {
  if (ms < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout");
  const thread = curThread;
  if (thread.interrupted && rt.monitors.holds(obj, thread)) {
    thread.interrupted = 0;
    return Promise.reject(rt.mkThrowable("java/lang/InterruptedException", null));
  }
  return rt.monitors.wait(obj, thread, (arm) => park(thread, arm, ms > 0 ? ms : undefined));
}

export class JClass extends JObj {
  ci: ClassInfo | null = null;
  /** ART's per-class extension data (ClassValue's map lives there), made on first request */
  ext: JObj | null = null;
  primName: string | null = null;
  arrDesc: string | null = null;
  componentOwner: Runtime | null = null;
  jname: string | null = null;
}
export function enclosingClass(this: JClass): JClass | null {
  const n = this.ci?.name ?? "", i = n.lastIndexOf("$");
  return i > 0 ? rt.classFor(n.slice(0, i)) : null;
}
const arrayClasses = new WeakMap<Runtime, Map<string, JClass>>();
const classCache = new Map<string, JClass>();
function arrayOwner(runtime: Runtime, desc: string): Runtime {
  const element = desc.replace(/^\[+/, "");
  if (element[0] !== "L") return rt;
  const name = descToName(element);
  for (;;) {
    const owner = runtime.classes.get(name)?.owner;
    if (owner) return owner;
    if (!runtime.parent || !runtime.natives.has(name) && runtime.dexIndex.has(name)) return runtime;
    runtime = runtime.parent;
  }
}
rt.classFor = function (this: Runtime, name: string): JClass {
  if (name[0] === "[") {
    const owner = arrayOwner(this, name);
    let cache = arrayClasses.get(owner);
    if (!cache) arrayClasses.set(owner, cache = new Map());
    let cls = cache.get(name);
    if (!cls) { cls = new JClass(); cls.arrDesc = name; cls.componentOwner = owner; cache.set(name, cls); }
    return cls;
  }
  const primitive = Object.hasOwn(PRIM_DESC, name);
  const ci = primitive ? null : this.link(name);
  let c: JClass | undefined = ci ? ci.jclass : classCache.get(name);
  if (c) return c;
  c = new JClass();
  if (primitive) c.primName = name;
  else c.ci = ci;
  if (ci) ci.jclass = c;
  else classCache.set(name, c);
  return c;
};

function jclassName(c: JClass): string {
  if (c.primName) return c.primName;
  return c.jname ??= dotName(c.arrDesc ?? c.ci!.name);
}
rt.register({
  name: "java/lang/Class",
  callerSensitive: ["forName(Ljava/lang/String;)Ljava/lang/Class;"],
  ctor: JClass,
  ifaces: ["java/io/Serializable", "java/lang/reflect/Type", "java/lang/reflect/GenericDeclaration", "java/lang/reflect/AnnotatedElement"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JClass) { return jclassName(this); },
    "toString()Ljava/lang/String;": function (this: JClass) { return "class " + jclassName(this); },
    "ensureExtDataPresent()Ldalvik/system/ClassExt;": function (this: JClass) { return this.ext ??= rt.make("dalvik/system/ClassExt"); },
    "getSimpleName()Ljava/lang/String;": function (this: JClass) {
      const n = jclassName(this);
      const i = Math.max(n.lastIndexOf("."), n.lastIndexOf("$"));
      return i >= 0 ? n.slice(i + 1) : n;
    },
    "hashCode()I": function () { return idHash(this); },
    "isInstance(Ljava/lang/Object;)Z": function (this: JClass, o: unknown) {
      return (this.ci?.owner ?? rt).iof(o, this.ci?.name ?? this.arrDesc ?? "?");
    },
    "isAssignableFrom(Ljava/lang/Class;)Z": function (this: JClass, other: JClass) {
      if (!other) rt.npe();
      if (other === this) return 1;
      return this.ci && other.ci ? +other.ci.assignableTo(this.ci) : 0;
    },
    "isInterface()Z": function (this: JClass) { return this.ci?.isInterface ? 1 : 0; },
    "isArray()Z": function (this: JClass) { return this.arrDesc ? 1 : 0; },
    "isPrimitive()Z": function (this: JClass) { return this.primName ? 1 : 0; },
    "getSuperclass()Ljava/lang/Class;": function (this: JClass) {
      const s = (this.ci ?? (this.arrDesc ? (this.componentOwner ?? rt).link(this.arrDesc) : null))?.superInfo;
      return s ? (s.owner ?? rt).classFor(s.name) : null;
    },
    "getComponentType()Ljava/lang/Class;": function (this: JClass) {
      if (!this.arrDesc) return null;
      const e = this.arrDesc.slice(1);
      return (this.componentOwner ?? rt).classFor(e[0] === "L" ? descToName(e) : e[0] === "[" ? e : PRIM_NAME[e]);
    },
    "newInstance()Ljava/lang/Object;": driven(function* (this: JClass): Gen {
      const info = this.ci!;
      const p = rt.initClass(info);
      if (p) yield p;
      // <init> mangles without a class component, so an inherited <init>()V would run the
      // SUPERclass ctor and leave every own field null — silently. Only accept our own.
      if (info.def && !Object.hasOwn(info.ctor.prototype, mangleMethod("<init>", "()V")))
        throw rt.mkThrowable("java/lang/InstantiationException", dotName(info.name));
      const o = new info.ctor();
      yield vcall(o, "<init>", "()V");
      return o;
    }),
    "getClassLoader()Ljava/lang/ClassLoader;": function (this: JClass) {
      if (this.primName || this.arrDesc && !this.arrDesc.replace(/^\[+/, "").startsWith("L")) return null;
      return (this.componentOwner ?? this.ci?.owner)?.classLoader ?? bootLoader;
    },
    "desiredAssertionStatus()Z": function () { return 0; },
    "getInterfaces()[Ljava/lang/Class;": function (this: JClass) {
      return jarray((this.ci?.interfaces ?? []).map((i) => (i.owner ?? rt).classFor(i.name)), "Ljava/lang/Class;");
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
      return dotName(this.ci?.name ?? this.primName ?? this.arrDesc ?? "?");
    },
    "getEnclosingClass()Ljava/lang/Class;": enclosingClass,
    "cast(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JClass, o: unknown) {
      return (this.ci?.owner ?? rt).cc(o, this.ci?.name ?? this.arrDesc ?? "java/lang/Object");
    },
    "asSubclass(Ljava/lang/Class;)Ljava/lang/Class;": function (this: JClass) { return this; },
    // forName/getConstructor(s)/getDeclaredConstructor(s)/getModifiers live in jreflect (installClassReflection)
  },
});

export class JClassLoader extends JObj { parent: JClassLoader | null = null; runtime: Runtime = rt; }
function rememberLoaded(loader: JClassLoader, name: string, cls: JClass): JClass {
  if (loader.runtime.classLoader === loader && cls.ci?.name === slashName(name)) {
    const previous = loader.runtime.classes.get(cls.ci.name);
    if (previous && !previous.stub && previous !== cls.ci)
      throw rt.mkThrowable("java/lang/LinkageError", `Conflicting loader definition: ${name}`);
    loader.runtime.classes.set(cls.ci.name, cls.ci);
  }
  return cls;
}
const loadClass = driven(function* (this: JClassLoader, n: string): Gen<JClass> {
  const loaded: JClass | null = yield vcall(this, "findLoadedClass", "(Ljava/lang/String;)Ljava/lang/Class;", n);
  if (loaded) return loaded;
  try {
    const cls = this.parent
      ? yield vcall(this.parent, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", n)
      : yield vcall(rt.link("java/lang/Class").ctor, "forName", "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;", n, 0, null);
    return rememberLoaded(this, n, cls as JClass);
  } catch (e) { if (!rt.iof(e, "java/lang/ClassNotFoundException")) throw e; }
  return rememberLoaded(this, n, (yield vcall(this, "findClass", "(Ljava/lang/String;)Ljava/lang/Class;", n)) as JClass);
});
rt.register({
  name: "java/lang/ClassLoader",
  ctor: JClassLoader,
  methods: {
    "static getSystemClassLoader()Ljava/lang/ClassLoader;": systemClassLoader,
    "<init>()V": function (this: JClassLoader) { this.parent = bootLoader; },
    "<init>(Ljava/lang/ClassLoader;)V": function (this: JClassLoader, parent: JClassLoader | null) { this.parent = parent; },
    "getParent()Ljava/lang/ClassLoader;": function (this: JClassLoader) { return this.parent; },
    "loadClass(Ljava/lang/String;)Ljava/lang/Class;": driven(function* (this: JClassLoader, n: string): Gen {
      return rememberLoaded(this, n, yield vcall(this, "loadClass", "(Ljava/lang/String;Z)Ljava/lang/Class;", n, 0));
    }),
    "loadClass(Ljava/lang/String;Z)Ljava/lang/Class;": loadClass,
    "findLoadedClass(Ljava/lang/String;)Ljava/lang/Class;": function (this: JClassLoader, n: string) {
      const name = slashName(n);
      const ci = this.runtime.classes.get(name);
      return ci && !ci.stub ? this.runtime.classFor(name) : null;
    },
    "resolveClass(Ljava/lang/Class;)V": () => {},
    "findClass(Ljava/lang/String;)Ljava/lang/Class;": (n: string) => { throw rt.mkThrowable("java/lang/ClassNotFoundException", n); },
    "findResource(Ljava/lang/String;)Ljava/net/URL;": function (this: JClassLoader, path: string) {
      if (!this.runtime.hasClasspath(path)) return null;
      const archive = this.runtime.classpathLocations.get(path) ?? "/data/app/base.apk";
      return newObj("java/net/URL", "(Ljava/lang/String;)V", "jar:file://" + archive + "!/" + path);
    },
    "getResource(Ljava/lang/String;)Ljava/net/URL;": driven(function* (this: JClassLoader, path: string): Gen {
      const inherited = this.parent && (yield vcall(this.parent, "getResource", "(Ljava/lang/String;)Ljava/net/URL;", path));
      return inherited || vcall(this, "findResource", "(Ljava/lang/String;)Ljava/net/URL;", path);
    }),
    "findResources(Ljava/lang/String;)Ljava/util/Enumeration;": driven(function* (this: JClassLoader, path: string): Gen {
      const { mkIter } = yield import("./jutil");
      const url = yield vcall(this, "findResource", "(Ljava/lang/String;)Ljava/net/URL;", path);
      return mkIter(url ? [url] : []);
    }),
    "getResources(Ljava/lang/String;)Ljava/util/Enumeration;": driven(function* (this: JClassLoader, path: string): Gen {
      const { mkIter } = yield import("./jutil");
      const urls: unknown[] = [];
      const inherited = this.parent && (yield vcall(this.parent, "getResources", "(Ljava/lang/String;)Ljava/util/Enumeration;", path));
      if (inherited) while (yield vcall(inherited, "hasMoreElements", "()Z")) urls.push(yield vcall(inherited, "nextElement", "()Ljava/lang/Object;"));
      const own = yield vcall(this, "findResources", "(Ljava/lang/String;)Ljava/util/Enumeration;", path);
      while (yield vcall(own, "hasMoreElements", "()Z")) urls.push(yield vcall(own, "nextElement", "()Ljava/lang/Object;"));
      return mkIter(urls);
    }),
    "getResourceAsStream(Ljava/lang/String;)Ljava/io/InputStream;": driven(function* (this: JClassLoader, path: string): Gen {
      const url = yield vcall(this, "getResource", "(Ljava/lang/String;)Ljava/net/URL;", path.replace(/^\//, ""));
      return url ? vcall(url, "openStream", "()Ljava/io/InputStream;") : null;
    }),
    "findLibrary(Ljava/lang/String;)Ljava/lang/String;": driven(function* (this: JClassLoader, n: string): Gen {
      const abi = pickAbi((a) => this.runtime.hasClasspath(`lib/${a}/lib${n}.so`));
      if (!abi) return null;
      const entry = `lib/${abi}/lib${n}.so`;
      const archive = this.runtime.classpathLocations.get(entry) ?? apkPath();
      const path = `${archive}.lib/${abi}/lib${n}.so`;
      if (!vfs.exists(path)) {
        const bytes = yield this.runtime.readClasspath(entry);
        if (!bytes) return null;
        vfs.write(path, bytes, false);
      }
      return path;
    }),
  },
});
const bootLoader = new JClassLoader();
export function systemClassLoader(): unknown { return rt.classLoader ?? bootLoader; }
/** a classpath entry as an InputStream, or null when the apk has no such file */
export async function classpathStream(path: string, runtime: Runtime = rt): Promise<unknown> {
  const bytes = await runtime.readClasspath(path);
  return bytes ? newObj("java/io/ByteArrayInputStream", "([B)V", i8(bytes)) : null;
}

export class JThrowable extends JObj {
  msg: string | null = null;
  cause: JThrowable | null = null;
  suppressed: JThrowable[] = [];
  /** captured by fillInStackTrace(), which Throwable's constructors call virtually */
  jsErr: Error | null = null;
  coldFrames: readonly ColdMethod[] = [];
  get jsStack(): string | undefined { return this.jsErr?.stack; }
  /** memoised getStackTrace(), or what setStackTrace() was handed */
  trace: unknown[] | null = null;
}
const STACK_DEPTH = 64;
/** the JS stack here, deep enough to hold the Java frames a trace reports */
function jsStackHere(): Error {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STACK_DEPTH;
  const js = new Error();
  Error.stackTraceLimit = limit;
  return js;
}
function captureStack(t: JThrowable): void {
  if (rt.throwables && rt.throwables.length < 500) rt.throwables.push(t);
  t.jsErr = jsStackHere();
  t.coldFrames = coldStack.slice(-STACK_DEPTH);
  t.trace = null;
}
/** The Java frames of a captured JS stack, innermost first. Compiled code's source names its
 *  class and method ("wd/pkg/Class.method.js"; neither name can contain '.'), a class's own source
 *  (native stubs) leaves the method to the function name, and each cold handler frame is the
 *  next interpreted method outward. */
function javaFrames(js: string | undefined, cold: readonly ColdMethod[]): [string, string][] {
  const out: [string, string][] = [];
  let k = cold.length;
  for (const line of (js ?? "").split("\n")) {
    const at = /^\s*at (?:(.*) \()?wd\/(.*)\.js:\d+:\d+\)?$/.exec(line);
    if (!at) continue;
    const [cls, method] = at[2].split(".");
    if (cls === "") {
      const c = cold[--k];
      if (c) { const dot = c.name.indexOf("."); out.push([c.name.slice(0, dot), c.name.slice(dot + 1, c.name.indexOf("(", dot))]); }
    } else if (method !== undefined) out.push([cls, method]);
    else {
      const fn = at[1] ?? "", named = demangle(/\[as (\S+)\]$/.exec(fn)?.[1] ?? fn.slice(fn.lastIndexOf(".") + 1));
      if (named) out.push([cls, named[0]]);
    }
  }
  return out;
}
/**
 * StackTraceElements for Java frames. An EMPTY trace is not a thing any JVM produces, and library
 * code counts on that: kotlinx.coroutines' stack-trace recovery does `copyOfRange(trace, 1, trace.size)`
 * on the way out of a *caught* exception, which on an empty array throws — turning a handled
 * failure into a fatal one.
 */
function stackTrace(frames: [string, string][]): unknown[] {
  const out = frames.map(([cls, method]) => Object.assign(new JStackTraceElement(), { declaring: dotName(cls), method }));
  if (!out.length) out.push(new JStackTraceElement());
  return jarray(out, "Ljava/lang/StackTraceElement;");
}
/** ART starts a throwable's trace below the frames of its own class hierarchy (its constructors) */
function throwableTrace(t: JThrowable): unknown[] {
  const frames = javaFrames(t.jsStack, t.coldFrames), own = new Set<string>();
  for (let info: ClassInfo | null | undefined = (t.constructor as { $i?: ClassInfo }).$i; info; info = info.superInfo) own.add(info.name);
  let skip = 0;
  while (skip < frames.length && own.has(frames[skip][0])) skip++;
  return stackTrace(frames.slice(skip));
}
const framesHere = () => javaFrames(jsStackHere().stack, coldStack);
rt.javaFrames = () => framesHere().map(([cls, method]) => dotName(cls) + "." + method);
/** Thread.getStackTrace: ART's trace names the natives that took it */
const threadTrace = () => stackTrace([["dalvik/system/VMStack", "getThreadStackTrace"], ["java/lang/Thread", "getStackTrace"], ...framesHere()]);
/** VMStack.getStackClassN: the class `n` frames out from the native's caller */
const stackClass = (n: number) => { const frame = framesHere()[n]; return frame ? rt.classFor(frame[0]) : null; };
rt.register({ name: "dalvik/system/VMStack", ctor: class extends JObj {}, methods: {
  "static getStackClass1()Ljava/lang/Class;": () => stackClass(1),
  "static getStackClass2()Ljava/lang/Class;": () => stackClass(2),
} });

const printStackTraceTo = driven(function* (this: JThrowable, out: unknown): Gen {
  yield vcall(out, "println", "(Ljava/lang/String;)V", yield stackTraceText(this));
});
/** JVM-shaped stack trace text: header from the (overridable) toString, then the trace's frames. */
export async function stackTraceText(t: JThrowable): Promise<string> {
  const frames = (c: JThrowable) => ((c.trace ??= throwableTrace(c)) as JStackTraceElement[]).map((e) => "\n\tat " + elementText(e)).join("");
  let out = String(await vcall(t, "toString", "()Ljava/lang/String;")) + frames(t);
  const seen = new Set<JThrowable>([t]);
  for (let c = t.cause; c && !seen.has(c); c = c.cause) {
    seen.add(c);
    out += "\nCaused by: " + String(await vcall(c, "toString", "()Ljava/lang/String;")) + frames(c);
  }
  return out;
}
const M_fillInStackTrace = mangleMethod("fillInStackTrace", "()Ljava/lang/Throwable;");
/** Throwable's constructors fill the trace through the virtual method: subclasses that override
 *  it to skip the capture (coroutine and Compose cancellations) never pay for a JS stack. */
export function fillInStackTrace(t: JThrowable): void { (t as unknown as Record<string, () => unknown>)[M_fillInStackTrace](); }
const throwableConstructors: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function (this: JThrowable) { fillInStackTrace(this); },
  "<init>(Ljava/lang/String;)V": function (this: JThrowable, m: string) { this.msg = m; fillInStackTrace(this); },
  "<init>(Ljava/lang/String;Ljava/lang/Throwable;)V": function (this: JThrowable, m: string, c: JThrowable) { this.msg = m; this.cause = c; fillInStackTrace(this); },
  "<init>(Ljava/lang/Throwable;)V": function (this: JThrowable, c: JThrowable) {
    this.cause = c;
    fillInStackTrace(this);
    if (c) return after(vcall(c, "toString", "()Ljava/lang/String;"), (m: string) => { this.msg = m; });
  },
  "<init>(Ljava/lang/String;Ljava/lang/Throwable;ZZ)V": function (this: JThrowable, m: string, c: JThrowable, _suppression: number, writable: number) {
    this.msg = m; this.cause = c;
    if (writable) fillInStackTrace(this);
  },
};
rt.register({
  name: "java/lang/Throwable",
  ctor: JThrowable,
  ifaces: ["java/io/Serializable"],
  methods: {
    ...throwableConstructors,
    "getMessage()Ljava/lang/String;": function (this: JThrowable) { return this.msg; },
    "getLocalizedMessage()Ljava/lang/String;": function (this: JThrowable) { return vcall(this, "getMessage", "()Ljava/lang/String;"); },
    "getCause()Ljava/lang/Throwable;": function (this: JThrowable) { return this.cause; },
    "initCause(Ljava/lang/Throwable;)Ljava/lang/Throwable;": function (this: JThrowable, c: JThrowable) { this.cause = c; return this; },
    "toString()Ljava/lang/String;": function (this: JThrowable) {
      const n = dotName(jclsName(this));
      return after(vcall(this, "getLocalizedMessage", "()Ljava/lang/String;"), (m: string | null) => (m !== null ? n + ": " + m : n));
    },
    "printStackTrace()V": function (this: JThrowable) {
      console.warn("[java] " + jclsName(this) + ": " + this.msg, this.jsStack, this.cause ? "caused by " + jclsName(this.cause) + ": " + this.cause.msg : "");
    },
    // apps route caught exceptions through these (logcat/Timber's Throwable.asLog())
    "printStackTrace(Ljava/io/PrintWriter;)V": printStackTraceTo,
    "printStackTrace(Ljava/io/PrintStream;)V": printStackTraceTo,
    "fillInStackTrace()Ljava/lang/Throwable;": function (this: JThrowable) { captureStack(this); return this; },
    "getStackTrace()[Ljava/lang/StackTraceElement;": function (this: JThrowable) { return this.trace ??= throwableTrace(this); },
    "setStackTrace([Ljava/lang/StackTraceElement;)V": function (this: JThrowable, t: unknown[]) { this.trace = t ?? null; },
    "addSuppressed(Ljava/lang/Throwable;)V": function (this: JThrowable, t: JThrowable) { this.suppressed.push(t); },
    "getSuppressed()[Ljava/lang/Throwable;": function (this: JThrowable) { return jarray(this.suppressed.slice(), "Ljava/lang/Throwable;"); },
  },
});

/** log a throwable that escaped every handler and tell the development shell */
export function reportUncaught(e: unknown) {
  const je = rt.jx(e);
  // the cause chain travels with the throwable and is usually where the real failure is named
  let causes = "";
  for (let c = je?.cause, depth = 0; c && depth < 8; c = c.cause, depth++) {
    causes += `\n  caused by ${(c.constructor as any)?.$i?.name ?? "?"}: ${c.msg ?? ""}`;
  }
  const jframes = (je as { jframes?: string[] } | null)?.jframes;
  console.error("[uncaught]", (je?.constructor as any)?.$i?.name ?? "?", (je?.msg ?? "") + causes + (jframes ? "\n  at " + jframes.join("\n  at ") : ""), (je as any)?.jsStack ?? (e as any)?.stack ?? "");
  rt.onUncaught(je);
}

const excCtors = new Map<string, new () => JThrowable>([["java/lang/Throwable", JThrowable]]);
/** Register a throwable class under an already-registered parent (native here or elsewhere). */
export function defineException(name: string, sup: string, constructors: string[] = [], extra: NativeSpec["methods"] = {}) {
  const parent = excCtors.get(sup) ?? (rt.link(sup).ctor as new () => JThrowable);
  const c = class extends parent {};
  excCtors.set(name, c);
  const methods = Object.fromEntries(constructors.map((desc) => ["<init>" + desc, throwableConstructors["<init>" + desc]]));
  rt.register({ name, sup, ctor: c, methods: { ...methods, ...extra } });
}
const lang = (n: string) => (n.includes("/") ? n : "java/lang/" + n);
for (const [sup, names] of [
  ["Throwable", "Error Exception"],
  ["Exception", "RuntimeException InterruptedException CloneNotSupportedException ReflectiveOperationException org/xmlpull/v1/XmlPullParserException"],
  ["RuntimeException", "NullPointerException ClassCastException ArithmeticException ArrayIndexOutOfBoundsException StringIndexOutOfBoundsException " +
    "IndexOutOfBoundsException IllegalArgumentException IllegalStateException UnsupportedOperationException NumberFormatException " +
    "NegativeArraySizeException ArrayStoreException SecurityException IllegalMonitorStateException java/util/NoSuchElementException " +
    "java/util/ConcurrentModificationException"],
  ["ReflectiveOperationException", "ClassNotFoundException NoSuchMethodException NoSuchFieldException InstantiationException IllegalAccessException"],
  ["IllegalArgumentException", "IllegalThreadStateException"],
  ["Error", "StackOverflowError OutOfMemoryError LinkageError InternalError"],
  ["LinkageError", "NoClassDefFoundError NoSuchMethodError NoSuchFieldError UnsatisfiedLinkError AbstractMethodError ExceptionInInitializerError"],
  ["java/io/IOException", "java/io/FileNotFoundException java/io/EOFException java/io/UnsupportedEncodingException java/net/SocketException " +
    "java/net/SocketTimeoutException java/net/UnknownHostException java/io/InterruptedIOException " +
    "java/net/UnknownServiceException java/io/CharConversionException"],
  ["java/net/SocketException", "java/net/ConnectException java/net/BindException"],
]) {
  if (sup === "java/io/IOException") defineException(sup, "java/lang/Exception", ["()V", "(Ljava/lang/String;)V", "(Ljava/lang/Throwable;)V", "(Ljava/lang/String;Ljava/lang/Throwable;)V"]);
  for (const n of names.split(" ")) defineException(lang(n), lang(sup));
}

defineException("java/io/ObjectStreamException", "java/io/IOException");
for (const name of ["NotSerializableException", "InvalidClassException", "InvalidObjectException", "NotActiveException", "StreamCorruptedException"])
  defineException("java/io/" + name, "java/io/ObjectStreamException");
defineException("java/io/UTFDataFormatException", "java/io/IOException");

class JAssertionError extends JThrowable {}
rt.register({ name: "java/lang/AssertionError", ctor: JAssertionError, sup: "java/lang/Error", methods: {
  "<init>(Ljava/lang/Object;)V": driven(function* (this: JAssertionError, detail: unknown): Gen {
    this.msg = detail === null ? "null" : typeof detail === "string" ? detail : yield vcall(detail, "toString", "()Ljava/lang/String;");
    if (detail instanceof JThrowable) this.cause = detail;
  }),
  ...Object.fromEntries(["Z", "C", "I", "J", "F", "D"].map(type => ["<init>(" + type + ")V", async function (this: JAssertionError, detail: unknown) {
    this.msg = await vcall(rt.link("java/lang/String").ctor, "valueOf", "(" + type + ")Ljava/lang/String;", detail);
  }])),
} });

rt.mkThrowable = (cls: string, msg: string | null) => {
  let ctor = excCtors.get(cls);
  try {
    const info = rt.link(cls);
    if (info.ctor && (info.ctor === JThrowable || info.ctor.prototype instanceof JThrowable)) ctor = info.ctor;
  } catch { /* fall through */ }
  const e = new (ctor ?? excCtors.get("java/lang/RuntimeException")!)();
  e.msg = msg;
  captureStack(e);
  return e;
};

rt.register({
  name: "java/lang/Iterable", ctor: class extends JObj {}, typeVars: "T",
  methods: {
    "forEach(Ljava/util/function/Consumer;)V": driven(function* (this: JObj, c: unknown): Gen {
      const it = yield vcall(this, "iterator", "()Ljava/util/Iterator;");
      while (yield vcall(it, "hasNext", "()Z")) yield vcall(c, "accept", "(Ljava/lang/Object;)V", yield vcall(it, "next", "()Ljava/lang/Object;"));
    }),
    "spliterator()Ljava/util/Spliterator;": driven(function* (this: JObj): Gen {
      const values: unknown[] = [];
      const it = yield vcall(this, "iterator", "()Ljava/util/Iterator;");
      while (yield vcall(it, "hasNext", "()Z")) values.push(yield vcall(it, "next", "()Ljava/lang/Object;"));
      const spliterator = rt.make("java/util/Spliterator") as JObj & { a: unknown[] };
      spliterator.a = values;
      return spliterator;
    }),
  },
});
// marker interfaces (registered early so link of String/implementors works + iof)
// Closeable extends AutoCloseable, and that inheritance is load-bearing: R8 merges every
// close-this-thing helper into one method that tests `instanceof AutoCloseable` first, so a
// Closeable that is not one falls off the end of the chain into its throw.
for (const [i, ext] of [["java/lang/Runnable"], ["java/lang/Comparable"], ["java/lang/CharSequence"],
  ["java/lang/Cloneable"], ["java/lang/Appendable"], ["java/lang/AutoCloseable"],
  ["java/io/Serializable"], ["java/io/Closeable", "java/lang/AutoCloseable"], ["java/io/Flushable"],
  ["java/io/DataInput"], ["java/io/DataOutput"],
  ["java/io/ObjectInput", "java/io/DataInput"], ["java/io/ObjectOutput", "java/io/DataOutput"]] as const) {
  rt.register({ name: i, ctor: class extends JObj {}, ifaces: ext ? [ext] : undefined });
}

// ── arrays: Object-typed call sites (Kotlin generics) dispatch mangled Object
// methods directly on JS arrays — give every array prototype the basics
for (const proto of [Array.prototype, ...Object.values(PRIM_ARRAYS).map((c) => c.prototype)] as object[]) {
  for (const [sig, name] of [["getClass()Ljava/lang/Class;", "getClass"], ["hashCode()I", "hashCode"],
    ["toString()Ljava/lang/String;", "toString"], ["equals(Ljava/lang/Object;)Z", "equals"],
    ["clone()Ljava/lang/Object;", "clone"]] as [string, string][]) {
    Object.defineProperty(proto, mangleMethod(...splitSig(sig)), {
      value: function (this: unknown, other?: unknown) { return name === "equals" ? (this === other ? 1 : 0) : rt.arrCall(this, name); },
      writable: true, configurable: true, enumerable: false,
    });
  }
}

// ── String (patch JS String.prototype with mangled methods)
function sm(sig: string, fn: (this: string, ...a: any[]) => unknown) {
  Object.defineProperty(String.prototype, mangleMethod(...splitSig(sig)), {
    value: fn, writable: true, configurable: true, enumerable: false,
  });
}
function sioobe(i: number): never {
  throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", "index " + i);
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff, isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** code point access shared by String, StringBuilder and Character, with Java's bounds */
function cpAt(s: string, i: number, limit = s.length): number {
  if (i < 0 || i >= limit) sioobe(i);
  const c = s.charCodeAt(i);
  return isHigh(c) && i + 1 < limit && isLow(s.charCodeAt(i + 1)) ? s.codePointAt(i)! : c;
}
function cpBefore(s: string, i: number, start = 0): number {
  if (i <= start || i > s.length) sioobe(i);
  const c = s.charCodeAt(i - 1);
  return isLow(c) && i - 1 > start && isHigh(s.charCodeAt(i - 2)) ? s.codePointAt(i - 2)! : c;
}
function cpCount(s: string, a: number, b: number): number {
  if (a < 0 || b < a || b > s.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  let n = b - a;
  for (let i = a; i < b - 1; i++) if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) { n--; i++; }
  return n;
}
sm("length()I", function () { return this.length; });
sm("isEmpty()Z", function () { return this.length === 0 ? 1 : 0; });
sm("charAt(I)C", function (i: number) {
  if (i >>> 0 >= this.length) sioobe(i);
  return this.charCodeAt(i);
});
sm("codePointAt(I)I", function (i: number) { return cpAt(this, i); });
sm("codePointBefore(I)I", function (i: number) { return cpBefore(this, i); });
sm("hashCode()I", function () { return stringHash(this as string); });
sm("equals(Ljava/lang/Object;)Z", function (o: unknown) { return (this as string) === o ? 1 : 0; });
sm("equalsIgnoreCase(Ljava/lang/String;)Z", function (o: string | null) {
  return o !== null && this.toLowerCase() === o.toLowerCase() ? 1 : 0;
});
export function stringCompare(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d) return d;
  }
  return a.length - b.length;
}
const compareStrings = function (this: string, o: string) { return stringCompare(this, o); };
sm("compareTo(Ljava/lang/String;)I", compareStrings);
sm("compareTo(Ljava/lang/Object;)I", compareStrings);
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
sm("contains(Ljava/lang/CharSequence;)Z", function (s: unknown) { return this.includes(jToString(s)) ? 1 : 0; });
function javaTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}
const JAVA_WHITESPACE = /^[\t-\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+|[\t-\r\x1c-\x1f \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/g;
sm("trim()Ljava/lang/String;", function () { return javaTrim(this); });
sm("strip()Ljava/lang/String;", function () { return this.replace(JAVA_WHITESPACE, ""); });
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
const utf8Bytes = function (this: string) { return new Int8Array(utf8.enc.encode(this).buffer); };
sm("getBytes()[B", utf8Bytes);
const encodedBytes = function (this: string, charset: unknown) { return encodeString(this, charset); };
sm("getBytes(Ljava/lang/String;)[B", encodedBytes);
sm("getBytes(Ljava/nio/charset/Charset;)[B", encodedBytes);
sm("getBytes(II[BI)V", function (begin: number, end: number, dst: Int8Array, offset: number) {
  if (begin < 0 || end > this.length || begin > end) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", null);
  if (dst == null) rt.npe();
  if (offset < 0 || offset + end - begin > dst.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
  for (let i = begin; i < end; i++) dst[offset + i - begin] = this.charCodeAt(i);
});
sm("replace(CC)Ljava/lang/String;", function (a: number, b: number) {
  return this.split(String.fromCharCode(a)).join(String.fromCharCode(b));
});
sm("replace(Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/lang/String;", function (a: unknown, b: unknown) {
  return after(csText(a ?? rt.npe()), (target: string) => after(csText(b ?? rt.npe()), (replacement: string) => this.replaceAll(target, () => replacement)));
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
sm("contentEquals(Ljava/lang/CharSequence;)Z", function (o: unknown) { return (this as string) === jToString(o) ? 1 : 0; });
sm("codePointCount(II)I", function (a: number, b: number) { return cpCount(this, a, b); });
sm("offsetByCodePoints(II)I", function (i: number, n: number) { return offsetCodePoints(String(this), i, n); });
sm("chars()Ljava/util/stream/IntStream;", function () { return mkIntStream(Array.from({ length: this.length }, (_, i) => this.charCodeAt(i))); });
sm("codePoints()Ljava/util/stream/IntStream;", function () { return mkIntStream(Array.from(this, char => char.codePointAt(0)!)); });
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
  if (limit === 1) return jarray([s], "Ljava/lang/String;");
  const parts: string[] = [];
  let end = 0, matched = false;
  if (plain) {
    for (;;) {
      if (limit > 0 && parts.length === limit - 1) break;
      const at = s.indexOf(pattern, end);
      if (at < 0) break;
      matched = true;
      parts.push(s.slice(end, at));
      end = at + pattern.length;
    }
  } else {
    const regex = javaRegex(pattern, "gsu");
    regex.lastIndex = 0;
    for (;;) {
      if (limit > 0 && parts.length === limit - 1) break;
      const match = regex.exec(s);
      if (!match) break;
      if (match.index === 0 && match[0].length === 0 && end === 0) {
        regex.lastIndex = 1;
        continue;
      }
      matched = true;
      parts.push(s.slice(end, match.index));
      end = match.index + match[0].length;
      if (!match[0].length) regex.lastIndex = match.index + 1;
    }
    regex.lastIndex = 0;
  }
  if (!matched) return jarray([s], "Ljava/lang/String;");
  parts.push(s.slice(end));
  if (limit === 0) { while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop(); }
  return jarray(parts, "Ljava/lang/String;");
}
sm("split(Ljava/lang/String;)[Ljava/lang/String;", function (p: string) { return javaSplit(this as string, p, 0); });
sm("split(Ljava/lang/String;I)[Ljava/lang/String;", function (p: string, l: number) { return javaSplit(this as string, p, l); });

const M_TO_STRING = mangleMethod("toString", "()Ljava/lang/String;");
/** A value's OWN toString — %s prints that, and so does every CharSequence a synchronous
 *  native is handed. A body that suspends cannot be awaited here and falls back to JS. */
export function jToString(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return String(v);
  const f = jmethod(v, M_TO_STRING);
  const r = f && f.call(v);
  return typeof r === "string" ? r : String(v);
}
/** String.valueOf(Object): "null", or what the value's virtual toString answers (null included) */
const valueOfObject = (v: unknown): string | null | Promise<string | null> =>
  v === null ? "null" : typeof v === "string" ? v : vcall(boxObject(v), "toString", "()Ljava/lang/String;");
/** the text string concatenation appends for a value */
export const stringOf = (v: unknown): string | Promise<string> => after(valueOfObject(v), String);
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
      // %x/%o print two's complement at the ARGUMENT's width, so a Byte -1 is "ff", not "ffffffff"
      const mask = v instanceof JByte ? 0xff : v instanceof JShort ? 0xffff : -1;
      if (v !== null && typeof v === "object" && "v" in (v as object)) {
        const inner = (v as { v: unknown }).v;
        if (typeof inner === "number" || typeof inner === "bigint") v = inner; // unbox Integer/Long/Double…
      }
      const radix = (r: number) => big !== null ? (big < 0n ? "-" : "") + (big < 0n ? -big : big).toString(r)
        : (typeof v === "bigint" ? BigInt.asUintN(64, v) : ((Number(v) & mask) >>> 0)).toString(r);
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
        default: s = jToString(v);
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
class JFormatter extends JObj { out: unknown = null; s = ""; }
const formatterInit = function (this: JFormatter, ...a: unknown[]) { this.out = a.find((x) => x !== null && !rt.iof(x, "java/util/Locale")) ?? null; };
rt.register({
  name: "java/util/Formatter", ctor: JFormatter, ifaces: ["java/io/Closeable", "java/io/Flushable"],
  methods: {
    "<init>()V": formatterInit,
    "<init>(Ljava/lang/Appendable;)V": formatterInit,
    "<init>(Ljava/util/Locale;)V": formatterInit,
    "<init>(Ljava/lang/Appendable;Ljava/util/Locale;)V": formatterInit,
    "format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/util/Formatter;": driven(function* (this: JFormatter, fmt: string, args: unknown[]): Gen {
      const s = javaFormat(fmt, args ?? []);
      if (this.out) yield vcall(this.out, "append", "(Ljava/lang/CharSequence;)Ljava/lang/Appendable;", s); else this.s += s;
      return this;
    }),
    "format(Ljava/util/Locale;Ljava/lang/String;[Ljava/lang/Object;)Ljava/util/Formatter;": function (this: JFormatter, _l: unknown, fmt: string, args: unknown[]) {
      return vcall(this, "format", "(Ljava/lang/String;[Ljava/lang/Object;)Ljava/util/Formatter;", fmt, args);
    },
    "out()Ljava/lang/Appendable;": function (this: JFormatter) { return this.out; },
    "toString()Ljava/lang/String;": function (this: JFormatter) { return this.out ? vcall(this.out, "toString", "()Ljava/lang/String;") : this.s; },
    "flush()V": () => {},
    "close()V": () => {},
  },
});
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
    "static valueOf(Ljava/lang/Object;)Ljava/lang/String;": valueOfObject,
    "static valueOf([C)Ljava/lang/String;": (v: Uint16Array) => charsToString(v, 0, v.length),
    "static valueOf([CII)Ljava/lang/String;": (v: Uint16Array, o: number, n: number) => charsToString(v, o, n),
    "static format(Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;": (f: string, a: unknown[]) => javaFormat(f, a),
    "static format(Ljava/util/Locale;Ljava/lang/String;[Ljava/lang/Object;)Ljava/lang/String;":
      (_l: unknown, f: string, a: unknown[]) => javaFormat(f, a),
    "static join(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/String;": joinCharSequences,
    "static join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String;": joinIterable,

  },
  // A getter, because java.util.Comparator is not registered yet when this spec is built.
  statics: { get CASE_INSENSITIVE_ORDER() { return mkCmp(caseInsensitive); } },
});
/** A Comparator is a plain JObj carrying `compare` — all a vcall from a sort needs. */
const COMPARE = mangleMethod("compare", "(Ljava/lang/Object;Ljava/lang/Object;)I");
export const mkCmp = (compare: (a: unknown, b: unknown) => unknown) => {
  const o = new (rt.link("java/util/Comparator").ctor as new () => JObj)();
  (o as unknown as Record<string, unknown>)[COMPARE] = compare;
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
function fmtFloat(v: number): string {
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
    if (v === null || typeof v === "string" || v instanceof JSB) {
      const str = v === null ? "null" : typeof v === "string" ? v : v.s;
      if (a < 0 || b < a || b > str.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      this.s += str.slice(a, b);
      return this;
    }
    const len = await vcall(v, "length", "()I") as number;
    if (a < 0 || b < a || b > len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
    const chars = new Uint16Array(b - a);
    for (let i = a; i < b; i++) chars[i - a] = await vcall(v, "charAt", "(I)C", i) as number;
    this.s += charsToString(chars, 0, chars.length);
    return this;
  };
  const appendChar = app(function (v) { this.s += String.fromCharCode(v); });
  const indexOf = function (this: JSB, value: string | null, from = 0) {
    if (value === null) return rt.npe();
    return this.s.indexOf(value, from);
  };
  const lastIndexOf = function (this: JSB, value: string | null, from = this.s.length) {
    if (value === null) return rt.npe();
    return from < 0 ? -1 : this.s.lastIndexOf(value, from);
  };
  return {
    name, ctor: c,
    ifaces: ["java/lang/CharSequence", "java/lang/Appendable"],
    methods: {
      "<init>()V": function () {},
      "<init>(I)V": function () {},
      "<init>(Ljava/lang/String;)V": function (this: JSB, s: string) { this.s = s; },
      "<init>(Ljava/lang/CharSequence;)V": function (this: JSB, s: unknown) { this.s = jToString(s); },
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
      "ensureCapacity(I)V": function () {},
      "charAt(I)C": function (this: JSB, i: number) { return this.s.charCodeAt(i); },
      [`appendCodePoint(I)L${name};`]: function (this: JSB, cp: number) { this.s += String.fromCodePoint(cp); return this; },
      "codePointAt(I)I": function (this: JSB, i: number) { return cpAt(this.s, i); },
      "codePointBefore(I)I": function (this: JSB, i: number) { return cpBefore(this.s, i); },
      "codePointCount(II)I": function (this: JSB, a: number, b: number) { return cpCount(this.s, a, b); },
      "offsetByCodePoints(II)I": function (this: JSB, i: number, n: number) { return offsetCodePoints(this.s, i, n); },
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
      "indexOf(Ljava/lang/String;)I": indexOf,
      "indexOf(Ljava/lang/String;I)I": indexOf,
      "lastIndexOf(Ljava/lang/String;)I": lastIndexOf,
      "lastIndexOf(Ljava/lang/String;I)I": lastIndexOf,
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

rt.register({ name: "java/lang/Record", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
class JNumber extends JObj {}
rt.register({
  name: "java/lang/Number", ctor: JNumber, ifaces: ["java/io/Serializable"],
  serialization: { uid: -8742448824652078965n, fields: [] },
  methods: {
    "<init>()V": function () {},
    "byteValue()B": function (this: JNumber) { return after(vcall(this, "intValue", "()I"), (v: number) => (v << 24) >> 24); },
    "shortValue()S": function (this: JNumber) { return after(vcall(this, "intValue", "()I"), (v: number) => (v << 16) >> 16); },
  },
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
/** A primitive read out of an Object-typed slot. A bare JS number has no toString()/hashCode()
 *  for the caller, and the slot lost the declared width, so the value's own shape names it. */
export function boxObject(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? boxInt(v) : box(JDouble, v);
  if (typeof v === "bigint") return box(JLong, v);
  return v;
}
const PRIM_BOX = { I: "java/lang/Integer", J: "java/lang/Long", F: "java/lang/Float", D: "java/lang/Double", B: "java/lang/Byte", S: "java/lang/Short" };
export const bitCount32 = (v: number) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};
export function reverseBytes32(v: number): number {
  return (v >>> 24) | ((v >>> 8) & 0xff00) | ((v & 0xff00) << 8) | (v << 24);
}
export function reverseBytes64(v: bigint): bigint {
  const u = BigInt.asUintN(64, v);
  let r = 0n;
  for (let i = 0; i < 8; i++) r |= ((u >> BigInt(i * 8)) & 0xffn) << BigInt((7 - i) * 8);
  return BigInt.asIntN(64, r);
}
const rev32 = (v: number) => {
  v = ((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555);
  v = ((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333);
  v = ((v & 0x0f0f0f0f) << 4) | ((v >>> 4) & 0x0f0f0f0f);
  return ((v << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) | 0;
};
const ctz32 = (v: number) => (v === 0 ? 32 : 31 - Math.clz32(v & -v));
const lo32 = (v: bigint) => Number(BigInt.asUintN(32, v)), hi32 = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n));
const nlz64 = (v: bigint) => { const hi = hi32(v); return hi ? Math.clz32(hi) : 32 + Math.clz32(lo32(v)); };
/** compareTo for every box class: `v` holds the number/bigint */
const cmpV = function (this: { v: number | bigint }, o: { v: number | bigint }) { return this.v < o.v ? -1 : this.v > o.v ? 1 : 0; };
const INT_MIN = -2147483648n, INT_MAX = 2147483647n, LONG_MIN = -9223372036854775808n, LONG_MAX = 9223372036854775807n;
function nfe(s: unknown): never {
  throw rt.mkThrowable("java/lang/NumberFormatException", `For input string: "${s}"`);
}
/** Integer/Long.toString use radix 10 for an out-of-range radix */
const radixOr10 = (r: number) => (r >= 2 && r <= 36 ? r : 10);
function parseUnsignedIntJ(s: string, radix: number): number {
  if (typeof s === "string" && s.startsWith("-")) throw rt.mkThrowable("java/lang/NumberFormatException", `Illegal leading minus sign on unsigned string ${s}.`);
  const v = parseLongJ(s, radix);
  if (v > 0xffffffffn) throw rt.mkThrowable("java/lang/NumberFormatException", `String value ${s} exceeds range of unsigned int.`);
  return Number(v) | 0;
}
function parseIntJ(s: string, radix = 10): number {
  if (typeof s !== "string" || radix < 2 || radix > 36 || !/^[+-]?[0-9a-zA-Z]+$/.test(s)) nfe(s);
  let start = 0, negative = false;
  if (s[0] === "+" || s[0] === "-") { negative = s[0] === "-"; start = 1; }
  let magnitude = 0;
  for (let i = start; i < s.length; i++) {
    const digit = parseInt(s[i], 36);
    if (Number.isNaN(digit) || digit >= radix) nfe(s);
    magnitude = magnitude * radix + digit;
  }
  const limit = negative ? 2147483648 : 2147483647;
  if (magnitude > limit) nfe(s);
  return (negative ? -magnitude : magnitude) | 0;
}
/** Integer/Long/Short/Byte.decode: a sign, then 0x/0X/# for hex, a leading 0 for octal, else decimal */
function decodeJ(s: string, min: bigint, max: bigint): bigint {
  if (s == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (!s.length) throw rt.mkThrowable("java/lang/NumberFormatException", "Zero length string");
  const neg = s[0] === "-";
  let i = neg || s[0] === "+" ? 1 : 0, radix = 10;
  if (s.startsWith("0x", i) || s.startsWith("0X", i)) { radix = 16; i += 2; }
  else if (s[i] === "#") { radix = 16; i++; }
  else if (s[i] === "0" && s.length > i + 1) { radix = 8; i++; }
  if (s[i] === "-" || s[i] === "+") throw rt.mkThrowable("java/lang/NumberFormatException", "Sign character in wrong position");
  const v = parseLongJ((neg ? "-" : "") + s.slice(i), radix);
  if (v < min || v > max) nfe(s);
  return v;
}
const numCommon = (kind: "I" | "J" | "F" | "D" | "B" | "S", Ctor: new () => { v: number | bigint }) => ({
  [`<init>(${kind})V`]: function (this: { v: number | bigint }, v: number | bigint) { this.v = v; },
  "equals(Ljava/lang/Object;)Z": function (this: { v: number | bigint }, o: unknown) {
    return o instanceof Ctor && (kind === "F" || kind === "D" ? Object.is(o.v, this.v) : o.v === this.v) ? 1 : 0;
  },
  [`compareTo(L${PRIM_BOX[kind]};)I`]: cmpV,
  "compareTo(Ljava/lang/Object;)I": cmpV,
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
  serialization: { uid: 1360826667806852920n, fields: [{ name: "value", desc: "I", prop: "v" }] },
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 2147483647, MIN_VALUE: -2147483648, SIZE: 32, BYTES: 4, get TYPE() { return rt.classFor("int"); } },
  methods: {
    ...numCommon("I", JInt),
    "static getInteger(Ljava/lang/String;)Ljava/lang/Integer;": (prop: string) => { const v = sysDecode(prop, INT_MIN, INT_MAX); return v === null ? null : boxInt(Number(v)); },
    "static getInteger(Ljava/lang/String;I)Ljava/lang/Integer;": (prop: string, def: number) => boxInt(Number(sysDecode(prop, INT_MIN, INT_MAX) ?? def)),
    "static getInteger(Ljava/lang/String;Ljava/lang/Integer;)Ljava/lang/Integer;": (prop: string, def: JInt) => { const v = sysDecode(prop, INT_MIN, INT_MAX); return v === null ? def : boxInt(Number(v)); },
    "static lowestOneBit(I)I": (v: number) => v & -v,
    "static valueOf(I)Ljava/lang/Integer;": boxInt,
    "static decode(Ljava/lang/String;)Ljava/lang/Integer;": (s: string) => boxInt(Number(decodeJ(s, INT_MIN, INT_MAX))),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Integer;": (s: string) => boxInt(parseIntJ(s)),
    "static parseInt(Ljava/lang/String;)I": (s: string) => parseIntJ(s),
    "static parseInt(Ljava/lang/String;I)I": (s: string, r: number) => parseIntJ(s, r),
    "static valueOf(Ljava/lang/String;I)Ljava/lang/Integer;": (s: string, r: number) => boxInt(parseIntJ(s, r)),
    "static toString(I)Ljava/lang/String;": (v: number) => String(v),
    "static toString(II)Ljava/lang/String;": (v: number, r: number) => v.toString(radixOr10(r)),
    "static toUnsignedString(I)Ljava/lang/String;": (v: number) => String(v >>> 0),
    "static toUnsignedString(II)Ljava/lang/String;": (v: number, r: number) => (v >>> 0).toString(radixOr10(r)),
    "static toUnsignedLong(I)J": (v: number) => BigInt(v >>> 0),
    "static compareUnsigned(II)I": (a: number, b: number) => ((a >>> 0) < (b >>> 0) ? -1 : (a >>> 0) > (b >>> 0) ? 1 : 0),
    "static divideUnsigned(II)I": (a: number, b: number) => { if (!b) divideByZero(); return ((a >>> 0) / (b >>> 0)) | 0; },
    "static remainderUnsigned(II)I": (a: number, b: number) => { if (!b) divideByZero(); return ((a >>> 0) % (b >>> 0)) | 0; },
    "static parseUnsignedInt(Ljava/lang/String;)I": (s: string) => parseUnsignedIntJ(s, 10),
    "static parseUnsignedInt(Ljava/lang/String;I)I": parseUnsignedIntJ,
    "static toHexString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(16),
    "static toBinaryString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(2),
    "static toOctalString(I)Ljava/lang/String;": (v: number) => (v >>> 0).toString(8),
    "static compare(II)I": (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0),
    "static min(II)I": (a: number, b: number) => Math.min(a, b),
    "static max(II)I": (a: number, b: number) => Math.max(a, b),
    "static sum(II)I": (a: number, b: number) => (a + b) | 0,
    "static bitCount(I)I": bitCount32,
    "static numberOfLeadingZeros(I)I": (v: number) => Math.clz32(v),
    "static numberOfTrailingZeros(I)I": ctz32,
    "static highestOneBit(I)I": (v: number) => (v === 0 ? 0 : 1 << (31 - Math.clz32(v))),
    "static reverse(I)I": rev32,
    "static reverseBytes(I)I": reverseBytes32,
    "static rotateLeft(II)I": (v: number, n: number) => ((v << n) | (v >>> (32 - n))) | 0,
    "static rotateRight(II)I": (v: number, n: number) => (v >>> n) | (v << -n),
    "static hashCode(I)I": (v: number) => v,
    "static signum(I)I": (v: number) => Math.sign(v),
  },
});
function parseLongJ(s: string, radix = 10): bigint {
  if (typeof s !== "string" || !s.length || radix < 2 || radix > 36) nfe(s);
  let i = 0, neg = false;
  if (s[0] === "-" || s[0] === "+") { neg = s[0] === "-"; i = 1; }
  if (i === s.length) nfe(s);
  let v = 0n;
  const R = BigInt(radix);
  for (; i < s.length; i++) {
    const d = parseInt(s[i], 36);
    if (Number.isNaN(d) || d >= radix) nfe(s);
    v = v * R + BigInt(d);
  }
  if (neg) v = -v;
  if (v > 9223372036854775807n || v < -9223372036854775808n) nfe(s);
  return v;
}
rt.register({
  name: "java/lang/Long", ctor: JLong, sup: "java/lang/Number",
  serialization: { uid: 4290774380558885855n, fields: [{ name: "value", desc: "J", prop: "v" }] },
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 9223372036854775807n, MIN_VALUE: -9223372036854775808n, SIZE: 64, BYTES: 8, get TYPE() { return rt.classFor("long"); } },
  methods: {
    ...numCommon("J", JLong),
    "static valueOf(J)Ljava/lang/Long;": (v: bigint) => box(JLong, v),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Long;": (s: string) => box(JLong, parseLongJ(s)),
    "static valueOf(Ljava/lang/String;I)Ljava/lang/Long;": (s: string, radix: number) => box(JLong, parseLongJ(s, radix)),
    "static parseLong(Ljava/lang/String;)J": parseLongJ,
    "static parseLong(Ljava/lang/String;I)J": parseLongJ,
    "static lowestOneBit(J)J": (v: bigint) => v & -v,
    "static numberOfLeadingZeros(J)I": nlz64,
    "static toString(JI)Ljava/lang/String;": (v: bigint, radix: number) => v.toString(radixOr10(radix)),
    "static toBinaryString(J)Ljava/lang/String;": (v: bigint) => BigInt.asUintN(64, v).toString(2),
    "static toOctalString(J)Ljava/lang/String;": (v: bigint) => BigInt.asUintN(64, v).toString(8),
    "static sum(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, a + b),
    "static toUnsignedString(J)Ljava/lang/String;": (v: bigint) => BigInt.asUintN(64, v).toString(),
    "static toUnsignedString(JI)Ljava/lang/String;": (v: bigint, radix: number) => BigInt.asUintN(64, v).toString(radixOr10(radix)),
    "static compareUnsigned(JJ)I": (a: bigint, b: bigint) => { const x = BigInt.asUintN(64, a), y = BigInt.asUintN(64, b); return x < y ? -1 : x > y ? 1 : 0; },
    "static divideUnsigned(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, BigInt.asUintN(64, a) / BigInt.asUintN(64, b)),
    "static remainderUnsigned(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, BigInt.asUintN(64, a) % BigInt.asUintN(64, b)),
    "static rotateRight(JI)J": (v: bigint, d: number) => { const n = BigInt(d & 63); const x = BigInt.asUintN(64, v); return BigInt.asIntN(64, (x >> n) | (x << (64n - n))); },
    "static highestOneBit(J)J": (v: bigint) => (v === 0n ? 0n : BigInt.asIntN(64, 1n << BigInt(63 - nlz64(v)))),
    "static reverse(J)J": (v: bigint) => BigInt.asIntN(64, (BigInt(rev32(lo32(v)) >>> 0) << 32n) | BigInt(rev32(hi32(v)) >>> 0)),
    "static getLong(Ljava/lang/String;)Ljava/lang/Long;": (prop: string) => { const v = sysDecode(prop, LONG_MIN, LONG_MAX); return v === null ? null : box(JLong, v); },
    "static getLong(Ljava/lang/String;J)Ljava/lang/Long;": (prop: string, def: bigint) => box(JLong, sysDecode(prop, LONG_MIN, LONG_MAX) ?? def),
    "static decode(Ljava/lang/String;)Ljava/lang/Long;": (s: string) => box(JLong, decodeJ(s, LONG_MIN, LONG_MAX)),
    "static toString(J)Ljava/lang/String;": (v: bigint) => String(v),
    "static toHexString(J)Ljava/lang/String;": (v: bigint) => BigInt.asUintN(64, v).toString(16),
    "static compare(JJ)I": (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0),
    "static min(JJ)J": (a: bigint, b: bigint) => (a < b ? a : b),
    "static max(JJ)J": (a: bigint, b: bigint) => (a > b ? a : b),
    "static signum(J)I": (v: bigint) => (v < 0n ? -1 : v > 0n ? 1 : 0),
    "static hashCode(J)I": (v: bigint) => Number(BigInt.asIntN(32, v ^ (v >> 32n))),
    "static numberOfTrailingZeros(J)I": (v: bigint) => (lo32(v) ? ctz32(lo32(v)) : 32 + ctz32(hi32(v))),
    "static bitCount(J)I": (v: bigint) => bitCount32(lo32(v)) + bitCount32(hi32(v)),
    "static rotateLeft(JI)J": (v: bigint, n: number) =>
      BigInt.asIntN(64, (v << BigInt(n & 63)) | (BigInt.asUintN(64, v) >> BigInt(64 - (n & 63)))),
    "static reverseBytes(J)J": reverseBytes64,
  },
});
function parseFloatJ(s: string): number {
  if (typeof s !== "string") nfe(s);
  const t = s.trim().replace(/[fFdD]$/, "");
  if (!/^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(t) && !/^[+-]?(Infinity|NaN)$/.test(t)) nfe(s);
  return parseFloat(t);
}
const isNaNZ = (v: number) => (v !== v ? 1 : 0);
const isFiniteZ = (v: number) => (Number.isFinite(v) ? 1 : 0);
const isInfZ = (v: number) => (v === Infinity || v === -Infinity ? 1 : 0);
/** Float/Double.compare: NaN sorts above everything, including itself equal */
export const cmpFloat = (a: number, b: number) => a < b ? -1 : a > b ? 1 : Object.is(a, b) ? 0 : a === b ? Object.is(a, -0) ? -1 : 1 : a !== a ? 1 : -1;
rt.register({
  name: "java/lang/Float", ctor: JFloat, sup: "java/lang/Number",
  serialization: { uid: -2671257302660747028n, fields: [{ name: "value", desc: "F", prop: "v" }] },
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 3.4028234663852886e38, MIN_VALUE: 1.401298464324817e-45, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN, get TYPE() { return rt.classFor("float"); } },
  methods: {
    ...numCommon("F", JFloat),
    "static valueOf(F)Ljava/lang/Float;": (v: number) => box(JFloat, v),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Float;": (s: string) => box(JFloat, Math.fround(parseFloatJ(s))),
    "static parseFloat(Ljava/lang/String;)F": (s: string) => Math.fround(parseFloatJ(s)),
    "static hashCode(F)I": floatToIntBits,
    "static floatToIntBits(F)I": floatToIntBits,
    "static floatToRawIntBits(F)I": floatToIntBits,
    "static intBitsToFloat(I)F": intBitsToFloat,
    "static isNaN(F)Z": isNaNZ,
    "static isInfinite(F)Z": isInfZ,
    "static isFinite(F)Z": isFiniteZ,
    "static compare(FF)I": cmpFloat,
    "static toString(F)Ljava/lang/String;": fmtFloat,
    "isNaN()Z": function (this: JFloat) { return isNaNZ(this.v); },
    "isInfinite()Z": function (this: JFloat) { return isInfZ(this.v); },
  },
});
rt.register({
  name: "java/lang/Double", ctor: JDouble, sup: "java/lang/Number",
  serialization: { uid: -9172774392245257468n, fields: [{ name: "value", desc: "D", prop: "v" }] },
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 1.7976931348623157e308, MIN_VALUE: 4.9e-324, POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN: NaN, get TYPE() { return rt.classFor("double"); } },
  methods: {
    ...numCommon("D", JDouble),
    "static valueOf(D)Ljava/lang/Double;": (v: number) => box(JDouble, v),
    "static valueOf(Ljava/lang/String;)Ljava/lang/Double;": (s: string) => box(JDouble, parseFloatJ(s)),
    "static parseDouble(Ljava/lang/String;)D": parseFloatJ,
    "static doubleToLongBits(D)J": doubleToLongBits,
    "static doubleToRawLongBits(D)J": doubleToLongBits,
    "static longBitsToDouble(J)D": longBitsToDouble,
    "static isNaN(D)Z": isNaNZ,
    "static isInfinite(D)Z": isInfZ,
    "static isFinite(D)Z": isFiniteZ,
    "static compare(DD)I": cmpFloat,
    "static hashCode(D)I": (v: number) => { const b = doubleToLongBits(v); return Number(BigInt.asIntN(32, b ^ (b >> 32n))); },
    "static toString(D)Ljava/lang/String;": fmtDouble,
    "isNaN()Z": function (this: JDouble) { return isNaNZ(this.v); },
    "isInfinite()Z": function (this: JDouble) { return isInfZ(this.v); },
  },
});
/** Byte and Short statics: parsing checks the range, as Byte.parseByte does, instead of wrapping */
function smallInt(d: "B" | "S", name: string, Ctor: new () => { v: number }, bits: number) {
  const max = 2 ** (bits - 1) - 1, self = `Ljava/lang/${name};`;
  const parse = (s: string, radix = 10) => {
    const v = parseIntJ(s, radix);
    if (v < -max - 1 || v > max) throw rt.mkThrowable("java/lang/NumberFormatException", `Value out of range. Value:"${s}" Radix:${radix}`);
    return v;
  };
  return {
    [`static parse${name}(Ljava/lang/String;)${d}`]: (s: string) => parse(s),
    [`static parse${name}(Ljava/lang/String;I)${d}`]: parse,
    [`static valueOf(${d})${self}`]: (v: number) => box(Ctor, v),
    [`static valueOf(Ljava/lang/String;)${self}`]: (s: string) => box(Ctor, parse(s)),
    [`static valueOf(Ljava/lang/String;I)${self}`]: (s: string, r: number) => box(Ctor, parse(s, r)),
    [`static decode(Ljava/lang/String;)${self}`]: (s: string) => box(Ctor, Number(decodeJ(s, BigInt(-max - 1), BigInt(max)))),
    [`static toString(${d})Ljava/lang/String;`]: (v: number) => String(v),
    [`static hashCode(${d})I`]: (v: number) => v,
    [`static compare(${d}${d})I`]: (a: number, b: number) => a - b,
    [`static toUnsignedInt(${d})I`]: (v: number) => v & (2 ** bits - 1),
    [`static toUnsignedLong(${d})J`]: (v: number) => BigInt(v & (2 ** bits - 1)),
  };
}
rt.register({
  name: "java/lang/Byte", ctor: JByte, sup: "java/lang/Number",
  serialization: { uid: -7183698231559129828n, fields: [{ name: "value", desc: "B", prop: "v" }] },
  statics: { MAX_VALUE: 127, MIN_VALUE: -128, get TYPE() { return rt.classFor("byte"); } },
  methods: {
    ...numCommon("B", JByte),
    ...smallInt("B", "Byte", JByte, 8),
  },
});
rt.register({
  name: "java/lang/Short", ctor: JShort, sup: "java/lang/Number",
  serialization: { uid: 7515723908773894738n, fields: [{ name: "value", desc: "S", prop: "v" }] },
  statics: { MAX_VALUE: 32767, MIN_VALUE: -32768, get TYPE() { return rt.classFor("short"); } },
  methods: {
    ...numCommon("S", JShort),
    ...smallInt("S", "Short", JShort, 16),
  },
});
export const TRUE = new JBool(); TRUE.v = 1;
export const FALSE = new JBool();
rt.register({
  name: "java/lang/Boolean", ctor: JBool,
  serialization: { uid: -3665804199014368530n, fields: [{ name: "value", desc: "Z", prop: "v" }] },
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
    "static getBoolean(Ljava/lang/String;)Z": (k: string) => (sysProps[k]?.toLowerCase() === "true" ? 1 : 0),
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
function offsetCodePoints(text: string, index: number, offset: number): number {
  if (index < 0 || index > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(index));
  while (offset > 0 && index < text.length) {
    const c = text.charCodeAt(index++);
    if (isHigh(c) && index < text.length && isLow(text.charCodeAt(index))) index++;
    offset--;
  }
  while (offset < 0 && index > 0) {
    const c = text.charCodeAt(--index);
    if (isLow(c) && index > 0 && isHigh(text.charCodeAt(index - 1))) index--;
    offset++;
  }
  if (offset !== 0) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(offset));
  return index;
}
function charTitleCase(c: number): number {
  // Unicode simple title mappings differ from uppercase for digraphs, Georgian and Greek.
  if (c >= 0x1c4 && c <= 0x1cc) return 0x1c5 + Math.floor((c - 0x1c4) / 3) * 3;
  if (c >= 0x1f1 && c <= 0x1f3) return 0x1f2;
  if (c >= 0x10d0 && c <= 0x10ff) return c;
  if (c >= 0x1f80 && c <= 0x1faf) return c | 8;
  if (c === 0x1fb3 || c === 0x1fc3 || c === 0x1ff3) return c + 9;
  const upper = String.fromCharCode(c).toUpperCase();
  return upper.length === 1 ? upper.charCodeAt(0) : c;
}
const isISOControl = (c: number) => +((c >= 0 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f));
const characterCategories = "Cn Lu Ll Lt Lm Lo Mn Me Mc Nd Nl No Zs Zl Zp Cc Cf - Co Cs Pd Ps Pe Pc Po Sm Sc Sk So Pi Pf"
  .split(" ").map(category => category === "-" ? null : new RegExp(`\\p{${category}}`, "u"));
function unicodeCategory(c: number): number {
  if (c < 0 || c > 0x10ffff) return 0;
  const s = String.fromCodePoint(c);
  return characterCategories.findIndex(category => category?.test(s));
}
const asciiCategories = Uint8Array.from({ length: 128 }, (_, c) => unicodeCategory(c));
const characterType = (c: number) => c >= 0 && c < 128 ? asciiCategories[c] : unicodeCategory(c);
const isDefinedChar = (c: number) => +(characterType(c) !== 0);
const isDigit = (c: number) => (c < 0x80 ? +(c >= 48 && c <= 57) : +(c <= 0x10ffff && /\p{Nd}/u.test(String.fromCodePoint(c))));
/** Character.digit of a char or code point (fromCodePoint equals fromCharCode below 0x10000) */
const charDigit = (cp: number, radix: number) => { const d = parseInt(String.fromCodePoint(cp), radix); return Number.isNaN(d) ? -1 : d; };
const charText = (chars: Uint16Array | null) => charsToString(chars ?? rt.npe(), 0, chars!.length);
function codePointChars(cp: number): Uint16Array {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid code point: " + cp);
  if (cp < 0x10000) return Uint16Array.of(cp);
  const pair = cp - 0x10000;
  return Uint16Array.of(0xd800 + (pair >> 10), 0xdc00 + (pair & 0x3ff));
}
rt.register({
  name: "java/lang/Character", ctor: JChar,
  serialization: { uid: 3786198910865385080n, fields: [{ name: "value", desc: "C", prop: "v" }] },
  ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  statics: { MAX_VALUE: 0xffff, MIN_VALUE: 0, get TYPE() { return rt.classFor("char"); } },
  methods: {
    "static offsetByCodePoints(Ljava/lang/CharSequence;II)I": (cs: unknown, index: number, offset: number) => {
      if (cs == null) return rt.npe();
      if (typeof cs === "string") return offsetCodePoints(cs, index, offset);
      return after(vcall(cs, "toString", "()Ljava/lang/String;"), (text: string) => offsetCodePoints(text, index, offset));
    },
    "static charCount(I)I": (cp: number) => (cp >= 0x10000 ? 2 : 1),
    "static getDirectionality(C)B": directionality,
    "static getDirectionality(I)B": directionality,
    "static toChars(I)[C": codePointChars,
    "static toChars(I[CI)I": (cp: number, destination: Uint16Array | null, offset: number) => {
      if (destination === null) rt.npe();
      const chars = codePointChars(cp);
      if (offset < 0 || offset > destination!.length - chars.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "Invalid char array offset: " + offset);
      destination!.set(chars, offset);
      return chars.length;
    },
    "static codePointAt(Ljava/lang/CharSequence;I)I": (cs: unknown, i: number) => cpAt(jToString(cs ?? rt.npe()), i),
    "static codePointAt([CI)I": (chars: Uint16Array, i: number) => cpAt(charText(chars), i),
    "static codePointAt([CII)I": (chars: Uint16Array, i: number, limit: number) => {
      if (limit > (chars ?? rt.npe()).length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(limit));
      return cpAt(charText(chars), i, limit);
    },
    "static codePointBefore(Ljava/lang/CharSequence;I)I": (cs: unknown, i: number) => cpBefore(jToString(cs ?? rt.npe()), i),
    "static codePointBefore([CI)I": (chars: Uint16Array, i: number) => cpBefore(charText(chars), i),
    "static codePointBefore([CII)I": (chars: Uint16Array, i: number, start: number) => cpBefore(charText(chars), i, start),
    "static codePointCount(Ljava/lang/CharSequence;II)I": (cs: unknown, a: number, b: number) => cpCount(jToString(cs ?? rt.npe()), a, b),
    "static codePointCount([CII)I": (chars: Uint16Array, offset: number, count: number) => cpCount(charText(chars), offset, offset + count),
    "static isSupplementaryCodePoint(I)Z": (cp: number) => (cp >= 0x10000 ? 1 : 0),
    "static isHighSurrogate(C)Z": (c: number) => +isHigh(c),
    "static isLowSurrogate(C)Z": (c: number) => +isLow(c),
    "static isSurrogatePair(CC)Z": (high: number, low: number) => +(isHigh(high) && isLow(low)),
    "static isSurrogate(C)Z": (c: number) => (c >= 0xd800 && c <= 0xdfff ? 1 : 0),
    "static toCodePoint(CC)I": (h: number, l: number) => ((h - 0xd800) << 10) + (l - 0xdc00) + 0x10000,
    "static isISOControl(I)Z": isISOControl,
    "static isISOControl(C)Z": isISOControl,
    "static getType(C)I": characterType,
    "static getType(I)I": characterType,
    "static isDefined(C)Z": isDefinedChar,
    "static isDefined(I)Z": isDefinedChar,
    "<init>(C)V": function (this: JChar, v: number) { this.v = v; },
    "charValue()C": function (this: JChar) { return this.v; },
    "compareTo(Ljava/lang/Character;)I": cmpV,
    "compareTo(Ljava/lang/Object;)I": cmpV,
    "equals(Ljava/lang/Object;)Z": function (this: JChar, o: unknown) { return o instanceof JChar && o.v === this.v ? 1 : 0; },
    "hashCode()I": function (this: JChar) { return this.v; },
    "toString()Ljava/lang/String;": function (this: JChar) { return String.fromCharCode(this.v); },
    "static valueOf(C)Ljava/lang/Character;": (v: number) => box(JChar, v),
    "static toString(C)Ljava/lang/String;": (v: number) => String.fromCharCode(v),
    "static isDigit(C)Z": isDigit,
    "static isDigit(I)Z": isDigit,
    ...Object.fromEntries(([["isJavaIdentifierStart", /[\p{L}\p{Nl}\p{Sc}\p{Pc}]/u],
      ["isJavaIdentifierPart", /[\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mc}\p{Mn}\p{Cf}\x00-\x08\x0e-\x1b\x7f-\x9f]/u],
      ["isLetter", /\p{L}/u], ["isLetterOrDigit", /[\p{L}\p{Nd}]/u], ["isWhitespace", /\s/], ["isSpaceChar", /\s/]] as const).flatMap(([n, re]) => {
      const test = (c: number) => c >= 0 && c <= 0x10ffff && re.test(String.fromCodePoint(c)) ? 1 : 0;
      return [[`static ${n}(C)Z`, test], [`static ${n}(I)Z`, test]];
    })),
    "static isUpperCase(C)Z": (c: number) => { const s = String.fromCharCode(c); return s !== s.toLowerCase() && s === s.toUpperCase() ? 1 : 0; },
    "static isLowerCase(C)Z": (c: number) => { const s = String.fromCharCode(c); return s !== s.toUpperCase() && s === s.toLowerCase() ? 1 : 0; },
    "static toTitleCase(C)C": charTitleCase,
    "static toUpperCase(C)C": (c: number) => String.fromCharCode(c).toUpperCase().charCodeAt(0),
    "static toLowerCase(C)C": (c: number) => String.fromCharCode(c).toLowerCase().charCodeAt(0),
    "static digit(CI)I": charDigit,
    "static digit(II)I": charDigit,
    "static getNumericValue(C)I": (c: number) => { const d = parseInt(String.fromCharCode(c), 36); return Number.isNaN(d) ? -1 : d; },
    "static forDigit(II)C": (d: number, r: number) => d.toString(r).charCodeAt(0),
  },
});

class JMath extends JObj {}
const mm: Record<string, (...a: never[]) => unknown> = {};
for (const t of ["I", "J", "F", "D"]) {
  // abs(MIN_VALUE) wraps back to MIN_VALUE for int and long
  mm[`static abs(${t})${t}`] = t === "J" ? (v: bigint) => BigInt.asIntN(64, v < 0n ? -v : v) : t === "I" ? (v: number) => Math.abs(v) | 0 : (v: number) => Math.abs(v);
  mm[`static max(${t}${t})${t}`] = t === "J" ? (a: bigint, b: bigint) => (a > b ? a : b) : (a: number, b: number) => Math.max(a, b);
  mm[`static min(${t}${t})${t}`] = t === "J" ? (a: bigint, b: bigint) => (a < b ? a : b) : (a: number, b: number) => Math.min(a, b);
}
for (const f of ["sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "exp", "expm1", "log", "log1p", "log10", "cbrt", "sinh", "cosh", "tanh", "floor", "ceil"] as const) {
  mm[`static ${f}(D)D`] = (v: number) => Math[f](v);
}
// the *Exact family throws on overflow where plain arithmetic wraps
const overflow = (what: string) => { throw rt.mkThrowable("java/lang/ArithmeticException", `${what} overflow`); };
const exactI = (v: number) => (v === (v | 0) ? v : overflow("integer"));
const exactJ = (v: bigint) => (v === BigInt.asIntN(64, v) ? v : overflow("long"));
Object.assign(mm, {
  "static addExact(II)I": (a: number, b: number) => exactI(a + b), "static addExact(JJ)J": (a: bigint, b: bigint) => exactJ(a + b),
  "static subtractExact(II)I": (a: number, b: number) => exactI(a - b), "static subtractExact(JJ)J": (a: bigint, b: bigint) => exactJ(a - b),
  "static multiplyExact(II)I": (a: number, b: number) => exactI(a * b),
  "static multiplyExact(JJ)J": (a: bigint, b: bigint) => exactJ(a * b),
  "static multiplyExact(JI)J": (a: bigint, b: number) => exactJ(a * BigInt(b)),
  "static incrementExact(I)I": (a: number) => exactI(a + 1), "static incrementExact(J)J": (a: bigint) => exactJ(a + 1n),
  "static decrementExact(I)I": (a: number) => exactI(a - 1), "static decrementExact(J)J": (a: bigint) => exactJ(a - 1n),
  "static negateExact(I)I": (a: number) => exactI(-a), "static negateExact(J)J": (a: bigint) => exactJ(-a),
  "static absExact(I)I": (a: number) => exactI(Math.abs(a)), "static absExact(J)J": (a: bigint) => exactJ(a < 0n ? -a : a),
  "static toIntExact(J)I": (a: bigint) => exactI(Number(a)),
  "static multiplyHigh(JJ)J": (a: bigint, b: bigint) => BigInt.asIntN(64, (a * b) >> 64n),
  "static multiplyFull(II)J": (a: number, b: number) => BigInt(a) * BigInt(b),
});
const divideByZero = (): never => { throw rt.mkThrowable("java/lang/ArithmeticException", "/ by zero"); };
const floorDivJ = (a: bigint, b: bigint) => { if (b === 0n) divideByZero(); const q = a / b; return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q; };
const floorModJ = (a: bigint, b: bigint) => a - floorDivJ(a, b) * b;
const floorDivI = (a: number, b: number) => { if (!b) divideByZero(); return Math.floor(a / b) | 0; };
const floorModI = (a: number, b: number) => (a - floorDivI(a, b) * b) | 0;
Object.assign(mm, {
  "static floorDiv(II)I": floorDivI, "static floorMod(II)I": floorModI,
  "static floorDiv(JJ)J": floorDivJ, "static floorMod(JJ)J": floorModJ,
  "static floorDiv(JI)J": (a: bigint, b: number) => floorDivJ(a, BigInt(b)),
  "static floorMod(JI)I": (a: bigint, b: number) => Number(floorModJ(a, BigInt(b))),
});
const ulpD = (v: number) => { if (!Number.isFinite(v)) return Number.isNaN(v) ? v : Infinity; const e = Math.max(Number((doubleToLongBits(Math.abs(v)) >> 52n) & 0x7ffn), 1); return Math.pow(2, e - 1075); };
const nextD = (v: number, up: boolean) => {
  if (Number.isNaN(v) || v === (up ? Infinity : -Infinity)) return v;
  if (v === 0) return up ? 5e-324 : -5e-324;
  const bits = doubleToLongBits(v);
  return longBitsToDouble((v > 0) === up ? bits + 1n : bits - 1n);
};
const nextF = (v: number, up: boolean) => {
  if (Number.isNaN(v) || v === (up ? Infinity : -Infinity)) return v;
  if (v === 0) return up ? intBitsToFloat(1) : -intBitsToFloat(1);
  const bits = floatToIntBits(v);
  return intBitsToFloat((v > 0) === up ? bits + 1 : bits - 1);
};
/** round half to even, as rint and IEEEremainder's quotient do */
const rint = (v: number) => { const r = Math.round(v); return Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r; };
const mathMethods: NativeSpec["methods"] = {
    ...mm,
    "static pow(DD)D": (a: number, b: number) => Math.pow(a, b),
    "static atan2(DD)D": (a: number, b: number) => Math.atan2(a, b),
    "static hypot(DD)D": (a: number, b: number) => Math.hypot(a, b),
    "static IEEEremainder(DD)D": (a: number, b: number) => a - b * rint(a / b),
    "static fma(DDD)D": (a: number, b: number, c: number) => a * b + c,
    "static fma(FFF)F": (a: number, b: number, c: number) => Math.fround(a * b + c),
    "static copySign(DD)D": (magnitude: number, sign: number) => longBitsToDouble(
      doubleToLongBits(magnitude) & 0x7fffffffffffffffn | doubleToLongBits(sign) & -0x8000000000000000n),
    "static copySign(FF)F": (magnitude: number, sign: number) => intBitsToFloat(
      floatToIntBits(magnitude) & 0x7fffffff | floatToIntBits(sign) & 0x80000000),
    "static getExponent(D)I": (v: number) => Number((doubleToLongBits(v) >> 52n) & 0x7ffn) - 1023,
    "static getExponent(F)I": (v: number) => ((floatToIntBits(v) >>> 23) & 0xff) - 127,
    "static scalb(DI)D": (v: number, n: number) => v * Math.pow(2, n),
    "static scalb(FI)F": (v: number, n: number) => Math.fround(v * Math.pow(2, n)),
    "static ulp(D)D": ulpD,
    "static ulp(F)F": (v: number) => Math.fround(Math.abs(nextF(Math.abs(v), true) - Math.abs(v))),
    "static nextUp(D)D": (v: number) => nextD(v, true), "static nextDown(D)D": (v: number) => nextD(v, false),
    "static nextUp(F)F": (v: number) => nextF(v, true), "static nextDown(F)F": (v: number) => nextF(v, false),
    "static nextAfter(DD)D": (v: number, d: number) => d > v ? nextD(v, true) : d < v ? nextD(v, false) : d,
    "static nextAfter(FD)F": (v: number, d: number) => d > v ? nextF(v, true) : d < v ? nextF(v, false) : Math.fround(d),
    "static random()D": () => Math.random(),
    // Math.round SATURATES at the type's bounds and maps NaN to 0 (JLS 15.1.4); `|0` wraps,
    // and BigInt(NaN) throws.
    "static round(D)J": (v: number) => rt.f2l(Math.round(v)),
    "static round(F)I": (v: number) => rt.f2i(Math.round(v)),
    "static rint(D)D": rint,
    "static signum(D)D": (v: number) => Math.sign(v),
    "static signum(F)F": (v: number) => Math.sign(v),
    "static toRadians(D)D": (v: number) => (v * Math.PI) / 180,
    "static toDegrees(D)D": (v: number) => (v * 180) / Math.PI,
};
rt.register({ name: "java/lang/Math", ctor: JMath, statics: { PI: Math.PI, E: Math.E, TAU: 2 * Math.PI }, methods: mathMethods });
// StrictMath's results are Math's here: both are the host's IEEE operations
rt.register({ name: "java/lang/StrictMath", ctor: class extends JObj {}, statics: { PI: Math.PI, E: Math.E }, methods: mathMethods });

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
const loadedLibs = new Map<string, { owner: Runtime; thread: JThread; pending: Promise<void> }>();
/** what a device this shape carries, most-preferred first. Which of them we can EXECUTE is the
 *  native tier's answer (rt.nativeAbis), and a library we can run beats one we cannot. */
const ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86_64", "x86"];
/** the ABI an apk's lib/ would be loaded from: the first the tier runs, else the first present
 *  — so the UnsatisfiedLinkError names the machine code the device would actually have used */
function pickAbi(has: (abi: string) => boolean): string | null {
  return rt.nativeAbis.find(has) ?? ABIS.find(has) ?? null;
}
const appAbis = new WeakMap<Runtime, string | null>();
/** the ABI the app's own libraries load from, when it ships any */
export function appNativeAbi(owner: Runtime = rt): string | null {
  if (appAbis.has(owner)) return appAbis.get(owner)!;
  const dirs = new Set(owner.classpathNames().flatMap((name) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1] ?? []));
  const abi = dirs.size ? pickAbi((a) => dirs.has(a)) : null;
  appAbis.set(owner, abi);
  return abi;
}
const E_MACHINE: Record<number, string> = { 0xb7: "arm64-v8a", 0x28: "armeabi", 0x3e: "x86_64", 0x03: "x86" };
async function dlopen(owner: Runtime, lib: string, abi: () => string | null, bytes: (a: string) => Uint8Array | null | Promise<Uint8Array | null>): Promise<void> {
  if (owner.nativeLibs.has(lib.replace(/^lib|\.so$/g, ""))) return;
  const have = loadedLibs.get(lib);
  if (have) {
    if (have.owner !== owner) throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `Library ${lib} already loaded by another ClassLoader`);
    if (have.thread === curThread) return;
    return have.pending;
  }
  const thread = curThread;
  const pending = (async () => {
    const a = abi(), b = a && owner.loadNativeLib ? await bytes(a) : null;
    if (a && b && owner.loadNativeLib) {
      try { return await owner.loadNativeLib(lib, b, a, owner, thread); }
      catch (e) { rt.noteNativeRequired(lib, a); throw e; }
    }
    if (a) rt.noteNativeRequired(lib, a);
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${lib}" ${a ? "is " + a + " machine code" : "not found"}`);
  })();
  loadedLibs.set(lib, { owner, thread, pending });
  try { await pending; }
  catch (error) { loadedLibs.delete(lib); throw error; }
}
const loadLibrary = async (n: string, owner: Runtime = rt) => dlopen(owner, `lib${n}.so`, () => pickAbi((a) => owner.hasClasspath(`lib/${a}/lib${n}.so`)),
  (a) => owner.readClasspath(`lib/${a}/lib${n}.so`));
/** Integer.getInteger/Long.getLong: a system property decoded the way Integer.decode does,
 *  null when it is unset or not a number — the value a caller falls back from. */
function sysDecode(prop: string, min: bigint, max: bigint): bigint | null {
  const raw = sysProps[prop];
  if (raw === undefined) return null;
  try { return decodeJ(raw, min, max); } catch { return null; }
}
const ownProps: Record<string, string> = {
  // The loader indexes every DEX before application initialization, as ART 2.1 does.
  "java.vm.version": "2.1.0",
  "java.io.tmpdir": "/data/local/tmp", "user.dir": "/", "os.name": "Linux",
  // libcore reads these from uname and the app's passwd entry
  "os.arch": "aarch64", "os.version": "3.10.0", "user.home": "/data",
  // RuntimeInit's default user agent from Build.VERSION.RELEASE, MODEL and ID
  "http.agent": `Dalvik/2.1.0 (Linux; U; Android ${device.release}; webdroid Build/WD1A)`,
  get "user.name"() { return appUserName(procIdentity.uid); },
};
let artProps: Record<string, string> | null = null;
/** ART's fixed properties (java.class.version, java.specification.*, file.encoding...), read
 *  from libcore's own table once the platform class path is there */
function hardcodedProps(): Record<string, string> {
  if (artProps) return artProps;
  const info = rt.link("java/lang/AndroidHardcodedSystemProperties");
  if (info.stub || rt.initClass(info)) return {};
  artProps = {};
  for (const pair of (info.ctor as Record<string, (string | null)[][]>)[mangleStaticField("STATIC_PROPERTIES")] ?? [])
    if (pair[0] && pair[1] !== null) artProps[pair[0]] = pair[1];
  return artProps;
}
/** System properties: webdroid's own, over ART's */
export const sysProps: Record<string, string> = new Proxy(ownProps, {
  get: (own, k: string) => k in own ? Reflect.get(own, k) : hardcodedProps()[k],
  has: (own, k: string) => k in own || k in hardcodedProps(),
  ownKeys: (own) => [...new Set([...Object.keys(hardcodedProps()), ...Reflect.ownKeys(own) as string[]])],
  getOwnPropertyDescriptor: (own, k: string) => Reflect.getOwnPropertyDescriptor(own, k)
    ?? (k in hardcodedProps() ? { value: hardcodedProps()[k], enumerable: true, configurable: true, writable: true } : undefined),
});
const sysEnv: Record<string, string> = {
  PATH: "/system/bin:/system/xbin:/vendor/bin",
  ANDROID_ROOT: "/system", ANDROID_DATA: "/data", EXTERNAL_STORAGE: "/sdcard",
  TMPDIR: "/data/local/tmp",
};
rt.register({
  name: "java/lang/System", ctor: JSystem,
  callerSensitive: ["loadLibrary(Ljava/lang/String;)V", "load(Ljava/lang/String;)V"],
  statics: { out: null, err: null, "in": null }, // filled by jio
  methods: {
    "static arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V": arraycopy,
    "static currentTimeMillis()J": () => BigInt(Date.now()),
    "static nanoTime()J": () => BigInt(Math.floor(guestNow() * 1e6)),
    "static identityHashCode(Ljava/lang/Object;)I": idHash,
    "static getProperty(Ljava/lang/String;)Ljava/lang/String;": (k: string) => sysProps[k] ?? null,
    "static getProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (k: string, d: string) => sysProps[k] ?? d,
    "static getProperties()Ljava/util/Properties;": driven(function* (): Gen {
      const p = yield newObj("java/util/Properties");
      for (const [k, v] of Object.entries(sysProps)) yield vcall(p, "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;", k, v);
      return p;
    }),
    // deleting first replaces a getter-only property (user.name) rather than assigning through it
    "static setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (k: string, v: string) => { const o = sysProps[k] ?? null; delete sysProps[k]; sysProps[k] = v; return o; },
    "static getenv(Ljava/lang/String;)Ljava/lang/String;": (key: string | null) => {
      if (key === null) rt.npe();
      return sysEnv[key!] ?? null;
    },
    "static getenv()Ljava/util/Map;": driven(function* (): Gen {
      const map = yield newObj("java/util/HashMap");
      for (const [key, value] of Object.entries(sysEnv)) yield vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value);
      return map;
    }),
    // Android has never installed one; code that asks is deciding whether it may reflect
    "static getSecurityManager()Ljava/lang/SecurityManager;": () => null,
    "static gc()V": () => {},
    "static exit(I)V": (c: number) => { console.warn("System.exit", c); },
    "static loadLibrary(Ljava/lang/String;)V": loadLibrary,
    "static load(Ljava/lang/String;)V": driven(function* (path: string, owner: Runtime = rt): Gen {
      const b: Uint8Array | null = yield vfs.readFile(path);
      yield dlopen(owner, path.slice(path.lastIndexOf("/") + 1), () => b ? E_MACHINE[b[18] | (b[19] << 8)] ?? "unknown" : null, () => b);
    }),
    "static mapLibraryName(Ljava/lang/String;)Ljava/lang/String;": (n: string) => `lib${n}.so`,
    "static lineSeparator()Ljava/lang/String;": () => "\n",
  },
});

class JRuntimeCls extends JObj {}
const theRuntime = new JRuntimeCls();
const shutdownHooks = new Set<unknown>();
const cannotExec = (program: string): never => {
  throw rt.mkThrowable("java/io/IOException", `Cannot run program "${program}": error=2, No such file or directory`);
};
rt.register({
  name: "java/lang/Runtime", ctor: JRuntimeCls,
  methods: {
    "static getRuntime()Ljava/lang/Runtime;": () => theRuntime,
    // the page never shuts the runtime down the way a JVM does; hooks are kept so removal works
    "addShutdownHook(Ljava/lang/Thread;)V": (t: unknown) => { shutdownHooks.add(t); },
    "removeShutdownHook(Ljava/lang/Thread;)Z": (t: unknown) => (shutdownHooks.delete(t) ? 1 : 0),
    "availableProcessors()I": () => device.cpu.cores,
    "maxMemory()J": () => 536870912n,
    "totalMemory()J": () => 268435456n,
    "freeMemory()J": () => 134217728n,
    "gc()V": () => {},
    // There is no process table behind this. A device answers for a program it cannot find the
    // same way, and callers probing for one (root checks, getprop readers) have that catch.
    "exec(Ljava/lang/String;)Ljava/lang/Process;": (cmd: string) => {
      const command = cmd?.trim();
      if (!command) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Empty command");
      return cannotExec(command.split(/\s+/)[0]);
    },
    "exec([Ljava/lang/String;)Ljava/lang/Process;": (cmd: unknown[]) => cannotExec(String(cmd?.[0] ?? "")),
    "loadLibrary0(Ljava/lang/Class;Ljava/lang/String;)V": function (c: JClass | null, n: string) { return loadLibrary(n, c?.ci?.owner ?? rt); },
  },
});

/** the native tier releases a finished thread's Cpu and stack through this */
export const threadExit = { hook: null as ((t: JThread) => void) | null };
const liveThreads = new Set<JThread>();
export class JThread extends JObj {
  jname = "Thread";
  daemon = 0;
  private live = 0;
  started = false;
  parked = 0;
  get alive() { return this.live; }
  set alive(value: number) { this.live = value; if (value) { this.started = true; liveThreads.add(this); } else liveThreads.delete(this); }
  prio = 5;
  target: unknown = null;   // Runnable
  ueh: unknown = null;      // Thread.UncaughtExceptionHandler
  locals = inheritedLocals();
  interrupted = 0;
  wake: (() => void) | null = null;
  /** LockSupport: a permit delivered while not parked, or the wake of a park in progress */
  permit = false;
  unpark: (() => void) | null = null;
  done: Promise<void> | null = null;
  looper: unknown = null;   // android Looper, set by android/os
  /** native calls in progress on this thread: its looper cannot dispatch while it is inside one */
  inNative = 0;
  nativeIdle: (() => void)[] = [];
  /** resolves once the thread is back from native code (at once when it is not in any) */
  untilIdle(): Promise<void> { return this.inNative ? new Promise((r) => this.nativeIdle.push(r)) : Promise.resolve(); }
}
export let curThread: JThread = null as never;
export const mainThread = curThread = new JThread();
mainThread.jname = "main";
mainThread.alive = 1;
rt.th = () => curThread;
rt.st = (t) => setCurThread(t as JThread);
rt.su = () => setCurThread(mainThread);
class JDefaultUEH extends JObj {}
rt.register({
  name: "webdroid/DefaultUEH", ctor: JDefaultUEH, ifaces: ["java/lang/Thread$UncaughtExceptionHandler"],
  methods: {
    // AOSP's LoggingHandler prints the whole trace; the "Caused by" chain is what names the real
    // fault, and the JS stack locates one a native raised
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": driven(function* (_t: unknown, e: unknown): Gen {
      if (e instanceof JThrowable) console.error("[uncaughtException]", yield stackTraceText(e), "\n" + e.jsStack);
      else console.error("[uncaughtException]", e);
    }),
  },
});
let defaultUEH: unknown = new JDefaultUEH();
/** Thread.dispatchUncaughtException: the thread's handler, else the default one */
export async function dispatchUncaught(t: JThread, e: unknown): Promise<void> {
  try { await vcallOn(t, t.ueh ?? defaultUEH, "uncaughtException", "(Ljava/lang/Thread;Ljava/lang/Throwable;)V", t, rt.jx(e)); }
  catch (inner) { console.error("[thread " + t.jname + "] uncaught handler failed", rt.jx(inner)); }
}
export const threadSwitch = { hook: null as ((t: JThread) => void) | null };
export function setCurThread(t: JThread) {
  if (t === curThread) return;
  curThread = t;
  threadSwitch.hook?.(t);
}
let threadCounter = 0;
const nextThreadName = () => "Thread-" + threadCounter++;
function initGroupedThread(this: JThread, _group: unknown, target: unknown, name: string) { this.target = target; this.jname = name; }

// Parks `t` until `wake` is called (notify/signal), the timeout elapses, or the thread is
// interrupted: resolves true on a wake, false on a timeout, rejects with InterruptedException on
// an interrupt — including one already pending, which Java checks before blocking. `arm`
// enqueues the waiter and returns its dequeue, so neither a timeout nor an interrupt leaves a
// dead entry behind to swallow a later notify meant for someone else.
export function park(t: JThread, arm: (wake: () => void) => () => void, timeoutMs?: number): Promise<boolean> {
  const ie = () => rt.mkThrowable("java/lang/InterruptedException", null);
  if (t.interrupted) { t.interrupted = 0; return Promise.reject(ie()); }
  return new Promise<boolean>((resolve, reject) => {
    t.parked = timeoutMs === undefined ? 3 : 4;
    let id: GuestTimer | undefined;
    const disarm = arm(() => { t.parked = 0; t.wake = null; unparkTimeout(id); resolve(true); });
    // a delay past 2^31-1 ms overflows setTimeout and fires at once; treat it as untimed
    if (timeoutMs !== undefined && timeoutMs < 0x7fffffff) id = parkTimeout(() => { disarm(); t.parked = 0; t.wake = null; resolve(false); }, timeoutMs);
    t.wake = () => { disarm(); t.parked = 0; t.wake = null; unparkTimeout(id); t.interrupted = 0; reject(ie()); };
  });
}

function join(t: JThread, ms: number): Promise<void> | undefined {
  const done = t.done;
  if (ms < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout");
  if (!done || !t.alive) return;
  return park(curThread, (wake) => {
    let pending = true;
    void done.then(() => { if (pending) wake(); });
    return () => { pending = false; };
  }, ms > 0 ? ms : undefined).then(() => {});
}

rt.register({
  name: "java/lang/Thread", ctor: JThread,
  ifaces: ["java/lang/Runnable"],
  methods: {
    "<init>()V": function (this: JThread) { this.jname = nextThreadName(); },
    "<init>(Ljava/lang/Runnable;)V": function (this: JThread, r: unknown) { this.target = r; this.jname = nextThreadName(); },
    "<init>(Ljava/lang/Runnable;Ljava/lang/String;)V": function (this: JThread, r: unknown, n: string) { this.target = r; this.jname = n; },
    "<init>(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;)V": initGroupedThread,
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;J)V": initGroupedThread,
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V": function (this: JThread, _g: unknown, n: string) { this.jname = n; },
    "getName()Ljava/lang/String;": function (this: JThread) { return this.jname; },
    "setName(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "setDaemon(Z)V": function (this: JThread, d: number) { this.daemon = d; },
    "isDaemon()Z": function (this: JThread) { return this.daemon; },
    "setPriority(I)V": function (this: JThread, p: number) { this.prio = p; },
    "getPriority()I": function (this: JThread) { return this.prio; },
    "isAlive()Z": function (this: JThread) { return this.alive; },
    "getState()Ljava/lang/Thread$State;": function (this: JThread) {
      rt.link("java/lang/Thread$State");
      return threadStates[!this.started ? 0 : !this.alive ? 5 : rt.monitors.isBlocked(this) ? 2 : this.parked || 1];
    },
    "getId()J": function (this: JThread) { return BigInt(idHash(this)); },
    "isInterrupted()Z": function (this: JThread) { return this.interrupted; },
    "interrupt()V": function (this: JThread) { this.interrupted = 1; this.wake?.(); },
    "start()V": function (this: JThread) {
      if (this.started) throw rt.mkThrowable("java/lang/IllegalThreadStateException", "Thread already started");
      this.alive = 1;
      // the body begins now, not after the caller's whole main-looper job: a thread that
      // publishes its Handler has it by the time the next lifecycle call posts to it
      this.done = new Promise((resolve) => {
        queueMicrotask(async () => {
          try { await vcallOn(this, this, "run", "()V"); }
          catch (e) { await dispatchUncaught(this, e); }
          finally { this.alive = 0; threadExit.hook?.(this); resolve(); }
        });
      });
    },
    "run()V": driven(function* (this: JThread): Gen {
      if (this.target) yield vcall(this.target, "run", "()V");
    }),
    "join()V": function (this: JThread) { return join(this, 0); },
    "join(J)V": function (this: JThread, ms: bigint) { return join(this, Number(ms)); },
    "join(JI)V": function (this: JThread, ms: bigint, ns: number) { return join(this, Number(ms) + (ns > 0 ? 1 : 0)); },
    "getThreadGroup()Ljava/lang/ThreadGroup;": () => mainGroup,
    "getContextClassLoader()Ljava/lang/ClassLoader;": systemClassLoader,
    "setContextClassLoader(Ljava/lang/ClassLoader;)V": () => {},
    "getStackTrace()[Ljava/lang/StackTraceElement;": threadTrace,
    "static currentThread()Ljava/lang/Thread;": () => curThread,
    "static activeCount()I": () => liveThreads.size,
    "static enumerate([Ljava/lang/Thread;)I": enumerateThreads,
    "static getAllStackTraces()Ljava/util/Map;": driven(function* (): Gen {
      const m = yield newObj("java/util/HashMap");
      yield vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", curThread, threadTrace());
      return m;
    }),
    "static getDefaultUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": () => defaultUEH,
    "getUncaughtExceptionHandler()Ljava/lang/Thread$UncaughtExceptionHandler;": function (this: JThread) { return this.ueh ?? defaultUEH; },
    "setUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": function (this: JThread, h: unknown) { this.ueh = h; },
    "static setDefaultUncaughtExceptionHandler(Ljava/lang/Thread$UncaughtExceptionHandler;)V": (h: unknown) => { defaultUEH = h; },
    "static sleep(J)V": (ms: bigint) => park(curThread, () => () => {}, Number(ms)),
    "static yield()V": () => new Promise((r) => setTimeout(r, 0)),
    "static interrupted()Z": () => { const v = curThread.interrupted; curThread.interrupted = 0; return v; },
    "static holdsLock(Ljava/lang/Object;)Z": (o: unknown) => rt.monitors.holds(o as object, curThread) ? 1 : 0,
  },
});

function enumerateThreads(threads: unknown[]): number {
  let count = 0;
  for (const thread of liveThreads) { if (count === threads.length) break; threads[count++] = thread; }
  return count;
}
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
    "activeCount()I": () => liveThreads.size,
    "enumerate([Ljava/lang/Thread;)I": enumerateThreads,
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": (_t: unknown, e: unknown) => { console.error("[uncaught]", e); },
    "toString()Ljava/lang/String;": function (this: JThreadGroup) { return `java.lang.ThreadGroup[name=${this.gname},maxpri=10]`; },
  },
});

class JThreadLocal extends JObj {}
class JInheritableThreadLocal extends JThreadLocal {}
/** a new Thread starts with its creator's inheritable values (the default childValue) */
function inheritedLocals(): Map<object, unknown> {
  const m = new Map<object, unknown>();
  if (curThread) for (const [k, v] of curThread.locals) if (k instanceof JInheritableThreadLocal) m.set(k, v);
  return m;
}
rt.register({
  name: "java/lang/InheritableThreadLocal", ctor: JInheritableThreadLocal, sup: "java/lang/ThreadLocal",
  methods: { "<init>()V": function () {}, "childValue(Ljava/lang/Object;)Ljava/lang/Object;": (v: unknown) => v },
});
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
    "get()Ljava/lang/Object;": driven(function* (this: JThreadLocal): Gen {
      const t = curThread;
      if (!t.locals.has(this)) {
        const v = yield vcall(this, "initialValue", "()Ljava/lang/Object;");
        if (!t.locals.has(this)) t.locals.set(this, v);
      }
      return t.locals.get(this) ?? null;
    }),
    "set(Ljava/lang/Object;)V": function (this: JThreadLocal, v: unknown) { curThread.locals.set(this, v); },
    "remove()V": function (this: JThreadLocal) { curThread.locals.delete(this); },
    "initialValue()Ljava/lang/Object;": function () { return null; },
    "static withInitial(Ljava/util/function/Supplier;)Ljava/lang/ThreadLocal;": (sup: unknown) => {
      if (sup == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      const t = rt.make("webdroid/SuppliedThreadLocal");
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
      return (i?.owner ?? rt).classFor(i?.name ?? "java/lang/Enum");
    },
    "static valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;": driven(function* (cls: JClass, n: string): Gen {
      const info = cls.ci!;
      const p = rt.initClass(info); if (p) yield p;
      return enumValueOf(yield vcall(info.ctor, "values", `()[L${info.name};`), n);
    }),
  },
});
function enumCmp(this: JEnum, o: JEnum) { return this.ord - o.ord; }
export function enumValueOf<T extends JEnum>(values: T[], name: string): T {
  if (name === null) throw rt.mkThrowable("java/lang/NullPointerException", "Name is null");
  const v = values.find((e) => e.ename === name);
  if (!v) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No enum constant " + name);
  return v;
}
export class JSimpleEnum extends JEnum {}
/**
 * A Java enum with nothing behind it but its constants: registers the class (a fresh ctor per
 * enum, so each has its own statics and ClassInfo), and returns the constants in declaration
 * order. `extra` adds methods a specific enum needs beyond Enum's own (name/ordinal/toString/
 * compareTo come from java/lang/Enum via the prototype chain).
 */
export function mkEnumSet(cls: string, names: string[], extra: NativeSpec["methods"] = {}, ifaces?: string[], fields?: NativeSpec["fields"]): JSimpleEnum[] {
  const ctor = class extends JSimpleEnum {};
  const vals = names.map((n, i) => { const e = new ctor(); e.ename = n; e.ord = i; return e; });
  rt.register({
    name: cls, ctor, sup: "java/lang/Enum", ifaces, fields,
    statics: Object.fromEntries(names.map((n, i) => [n, vals[i]])),
    methods: {
      [`static values()[L${cls};`]: () => jarray(vals.slice(), `L${cls};`),
      [`static valueOf(Ljava/lang/String;)L${cls};`]: (n: string) => enumValueOf(vals, n),
      ...extra,
    },
  });
  return vals;
}

rt.markers("java/lang/Thread$UncaughtExceptionHandler");
const threadStates = mkEnumSet("java/lang/Thread$State", ["NEW", "RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "TERMINATED"]);

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

class JRef extends JObj { referent: unknown = null; queue: JRefQueue | null = null; state = 0; }
class JRefQueue extends JObj { items: JRef[] = []; waiters = new Set<() => void>(); }
function enqueueReference(ref: JRef): number {
  if (!ref.queue || ref.state) return 0;
  collectedReferences.unregister(ref);
  ref.referent = null;
  if (ref instanceof JWeakRef) ref.wr = null;
  ref.state = 1; ref.queue.items.push(ref);
  for (const wake of ref.queue.waiters) wake();
  ref.queue.waiters.clear();
  return 1;
}
const collectedReferences = new FinalizationRegistry<WeakRef<JRef>>(ref => { const value = ref.deref(); if (value) enqueueReference(value); });
function watchReference(ref: JRef, value: unknown, queue: JRefQueue | null): void {
  ref.queue = queue;
  if (queue && value && (typeof value === "object" || typeof value === "function")) collectedReferences.register(value, new WeakRef(ref), ref);
}
function pollReference(queue: JRefQueue): JRef | null {
  const ref = queue.items.shift(); if (!ref) return null;
  ref.state = 2; return ref;
}
async function removeReference(this: JRefQueue, ms = 0n): Promise<JRef | null> {
  if (ms < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Negative timeout");
  const thread = curThread, start = performance.now();
  for (;;) {
    if (thread.interrupted) { thread.interrupted = 0; throw rt.mkThrowable("java/lang/InterruptedException", null); }
    const ref = pollReference(this); if (ref) return ref;
    const remaining = Number(ms) - (performance.now() - start);
    if (ms > 0n && remaining <= 0) return null;
    await park(thread, wake => { this.waiters.add(wake); return () => this.waiters.delete(wake); }, ms === 0n ? undefined : remaining);
  }
}
rt.register({
  name: "java/lang/ref/Reference", ctor: JRef,
  methods: {
    "get()Ljava/lang/Object;": function (this: JRef) { return this.referent; },
    "clear()V": function (this: JRef) { this.referent = null; collectedReferences.unregister(this); },
    "isEnqueued()Z": function (this: JRef) { return +(this.state === 1); },
    "enqueue()Z": function (this: JRef) { return enqueueReference(this); },
    "static reachabilityFence(Ljava/lang/Object;)V": () => {},
  },
});
class JWeakRef extends JRef { wr: WeakRef<object> | null = null; }
rt.register({
  name: "java/lang/ref/WeakReference", ctor: JWeakRef, sup: "java/lang/ref/Reference",
  methods: {
    "<init>(Ljava/lang/Object;)V": initWeakReference,
    "<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V": initWeakReference,
    "get()Ljava/lang/Object;": function (this: JWeakRef) { return this.wr?.deref() ?? this.referent; },
    "clear()V": function (this: JWeakRef) { this.wr = null; this.referent = null; collectedReferences.unregister(this); },
  },
});
rt.register({
  name: "java/lang/ref/SoftReference", ctor: class extends JRef {}, sup: "java/lang/ref/Reference",
  methods: {
    "<init>(Ljava/lang/Object;)V": function (this: JRef, o: unknown) { this.referent = o; },
    "<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V": function (this: JRef, o: unknown, queue: JRefQueue | null) { this.referent = o; this.queue = queue; },
  },
});
rt.register({
  name: "java/lang/ref/PhantomReference", ctor: class extends JRef {}, sup: "java/lang/ref/Reference",
  methods: {
    "<init>(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V": function (this: JRef, o: unknown, queue: JRefQueue | null) { watchReference(this, o, queue); },
    "get()Ljava/lang/Object;": () => null,
  },
});
function initWeakReference(this: JWeakRef, value: unknown, queue: JRefQueue | null = null): void {
  if (value && (typeof value === "object" || typeof value === "function")) this.wr = new WeakRef(value);
  else this.referent = value;
  watchReference(this, value, queue);
}
rt.register({ name: "java/lang/ref/ReferenceQueue", ctor: JRefQueue, methods: {
  "<init>()V": function () {},
  "poll()Ljava/lang/ref/Reference;": function (this: JRefQueue) { return pollReference(this); },
  "remove()Ljava/lang/ref/Reference;": removeReference,
  "remove(J)Ljava/lang/ref/Reference;": removeReference,
} });

rt.register({
  name: "java/lang/reflect/Modifier", ctor: class extends JObj {},
  statics: { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 16, SYNCHRONIZED: 32, VOLATILE: 64, TRANSIENT: 128, NATIVE: 256, INTERFACE: 512, ABSTRACT: 1024, STRICT: 2048 },
  methods: Object.fromEntries([["Public", 1], ["Private", 2], ["Protected", 4], ["Static", 8], ["Final", 16], ["Synchronized", 32], ["Volatile", 64],
    ["Transient", 128], ["Native", 256], ["Interface", 512], ["Abstract", 1024], ["Strict", 2048]].map(([n, bit]) => [`static is${n}(I)Z`, (m: number) => (m & (bit as number) ? 1 : 0)])),
});

class JStackTraceElement extends JObj { declaring = ""; method = ""; file: string | null = null; line = -1; }
const elementText = (e: JStackTraceElement) => `${e.declaring}.${e.method}(${e.line === -2 ? "Native Method"
  : e.file === null ? "Unknown Source" : e.line >= 0 ? `${e.file}:${e.line}` : e.file})`;
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
    "isNativeMethod()Z": function (this: JStackTraceElement) { return this.line === -2 ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JStackTraceElement) { return elementText(this); },
  },
});
