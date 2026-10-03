// java.lang.* natives. Convention: Java booleans are 0/1 numbers, longs are BigInt,
// Strings are JS string primitives (String.prototype carries mangled Java methods).

import { awaited, rt, JObj, HEAP_LIMIT, type ClassInfo, type NativeSpec, type Runtime, driven, type Gen } from "../runtime";
import { parkTimeout, unparkTimeout } from "../yield";
import { encodeString } from "../charset";
import { coldStack, type ColdMethod } from "../cold";
import { once } from "../suspend";
import { mangleMethod, mangleField, mangleStaticField, demangle, frameOf, jmethod, lateMethod, descToName, charsToString, jarray, PRIM_NAME, PRIM_DESC, dotName, slashName, utf8, PRIM_ARRAYS, i8, splitSig } from "../abi";
import { uptimeMillis, wallMillis, type GuestTimer } from "../../guest-clock";
import { vfs, apkPath } from "../../shell/vfs";
import { processEnv } from "../../shell/environment";
import { csText } from "./jchars";
import { boxObject, intrinsicCompiler } from "./jbox";
import { stringMatches, stringReplace, stringSplit } from "./jregex";
import { procIdentity, procTasks, processTid } from "../../shell/procfs";

function* joinCharSequences(separator: unknown, parts: unknown[]): Gen<string> {
  if (separator == null || parts == null) rt.npe();
  const text = yield* awaited(csText(separator));
  const values: string[] = [];
  for (const part of parts) values.push(part == null ? "null" : yield* awaited(csText(part)));
  return values.join(text);
}

const joinIterable = driven(function* (separator: unknown, parts: unknown): Gen<string> {
  if (parts == null) rt.npe();
  const values: unknown[] = [];
  const iterator = yield vcall(parts, "iterator", "()Ljava/util/Iterator;");
  while (yield vcall(iterator, "hasNext", "()Z")) values.push(yield vcall(iterator, "next", "()Ljava/lang/Object;"));
  return yield* joinCharSequences(separator, values);
});

/** Does a Java thread own this event-loop turn? A resumed activation takes its thread (rt.st) and
 *  releases it (rt.su); host code enters with onMain or callOn. Java entered from a turn nothing owns
 *  (an async function or timer resuming) would run as whichever thread ran last, so the entry
 *  helpers refuse it in a page's realms; Bun's host tools and tests own every turn. */
let owned = true, strictOwnership = false;
export function strictThreadOwnership(): void { strictOwnership = true; owned = false; }
/** no Java thread owns the turn from here (a frame suspended, a native thread parked): the main
 *  thread's identity is left for code that reads it */
export function releaseThread(): void { setCurThread(mainThread); owned = !strictOwnership; }
function unowned(what: string): never {
  throw new Error(`[webdroid unowned] ${what} from a turn no Java thread owns: enter with onMain, callOn or a driven generator`);
}
function findMethod(obj: any, name: string, desc: string): (...a: unknown[]) => unknown {
  const fn = obj[mangleMethod(name, desc)] ?? lateMethod.find?.(obj, name, desc);
  if (typeof fn !== "function") throw rt.unimplemented(`vcall ${describe(obj)}.${name}${desc}`);
  return fn;
}
/** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
export function vcall(obj: any, name: string, desc: string, ...args: unknown[]): any {
  if (!owned) unowned(`vcall ${name}${desc}`);
  return findMethod(obj, name, desc).apply(obj, args);
}
/** A Java call as a Promise, for callers that chain on its completion. */
export function vcallAsync(obj: unknown, name: string, desc: string, ...args: unknown[]): Promise<any> {
  try { return Promise.resolve(vcall(obj, name, desc, ...args)); } catch (e) { return Promise.reject(e); }
}
/** A call no Java frame waits on (a listener, a posted task): its exception, thrown now or when
 *  it resumes, goes to the uncaught handler rather than to the native that dispatched it. */
export function callUncaught(call: () => unknown): void {
  try { const r = call(); if (r instanceof Promise) r.catch(reportUncaught); } catch (e) { reportUncaught(e); }
}
export function vcallOn(thread: JThread, obj: unknown, name: string, desc: string, ...args: unknown[]): unknown {
  return callOn(thread, () => vcall(obj, name, desc, ...args));
}
/** `call` on `thread`, which owns the turn while it runs */
export function callOn<T>(thread: JThread, call: () => T): T {
  const previous = curThread, was = owned;
  setCurThread(thread);
  try { return call(); } finally { setCurThread(previous); owned = was; }
}
/** `f` of `r`, now or once it settles; settled later, `f` runs on the thread that asked (if one
 *  owned the turn that asked) */
export function after<R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T> {
  if (!(r instanceof Promise)) return f(r);
  const thread = curThread;
  return owned ? r.then((v) => callOn(thread, () => f(v))) : r.then(f);
}
function describe(o: unknown): string {
  return typeof o === "string" ? "String" : ((o as any)?.constructor?.$i?.name ?? String(o));
}
/** link + run <clinit>: the class is ready to be instantiated or have its statics read */
export function linkInit(cls: string): ClassInfo | Promise<ClassInfo> {
  if (!owned) unowned(`initialize ${cls}`);
  const info = rt.link(cls);
  return after(rt.initClass(info), () => info);
}
/** a static field's value, once the class has initialized */
export const staticField = <T = unknown>(cls: string, field: string): T | Promise<T> =>
  after(linkInit(cls), (info) => (info.ctor as Record<string, T>)[mangleStaticField(field)]);
/** A static Java call from native code, once the class has initialized, on the calling thread */
export function scall(cls: string, name: string, desc: string, ...args: unknown[]): any {
  return after(linkInit(cls), (info) => vcall(info.ctor, name, desc, ...args));
}
/** `new cls(args)` from native code: initialize the class, then run the Java constructor `desc`;
 *  synchronous unless initialization or the constructor suspends */
export function newObj(cls: string, desc = "()V", ...args: unknown[]): JObj | Promise<any> {
  return after(linkInit(cls), (info) => {
    const o = new info.ctor() as JObj;
    return after(vcall(o, "<init>", desc, ...args), () => o);
  });
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
    // Class@hex(hashCode()), through an app's hashCode override; an array cannot override it
    "toString()Ljava/lang/String;": function (this: JObj) {
      return after(this instanceof JObj ? vcall(this, "hashCode", "()I") : idHash(this), (hash: number) => dotName(jclsName(this)) + "@" + (hash >>> 0).toString(16));
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
const knownArrayClasses = new WeakMap<Runtime, Map<string, JClass>>();
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
let classLinked = false;
/** a Class object, java.lang.Class linked first so it has its methods */
function newClass(): JClass {
  if (!classLinked) { classLinked = true; rt.link("java/lang/Class"); }
  return new JClass();
}
rt.classFor = function (this: Runtime, name: string): JClass {
  if (name[0] === "[") {
    // an array's getClass is hot (Arrays.copyOf asks for every grown collection): once its element
    // class is linked, its owner cannot change, so the answer is kept per asking runtime
    let known = knownArrayClasses.get(this);
    if (!known) knownArrayClasses.set(this, known = new Map());
    let cls = known.get(name);
    if (cls) return cls;
    const owner = arrayOwner(this, name);
    let cache = arrayClasses.get(owner);
    if (!cache) arrayClasses.set(owner, cache = new Map());
    cls = cache.get(name);
    if (!cls) { cls = newClass(); cls.arrDesc = name; cls.componentOwner = owner; cache.set(name, cls); }
    const element = name.replace(/^\[+/, "");
    if (element[0] !== "L" || this.classes.has(descToName(element))) known.set(name, cls);
    return cls;
  }
  const primitive = Object.hasOwn(PRIM_DESC, name);
  const ci = primitive ? null : this.link(name);
  let c: JClass | undefined = ci ? ci.jclass : classCache.get(name);
  if (c) return c;
  c = newClass();
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
const PRIMITIVES = new Set(["boolean", "byte", "char", "short", "int", "long", "float", "double", "void"]);
rt.register({
  name: "java/lang/Class",
  callerSensitive: ["forName(Ljava/lang/String;)Ljava/lang/Class;"],
  ctor: JClass,
  ifaces: ["java/io/Serializable", "java/lang/reflect/Type", "java/lang/reflect/GenericDeclaration", "java/lang/reflect/AnnotatedElement"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JClass) { return jclassName(this); },
    "toString()Ljava/lang/String;": function (this: JClass) { return "class " + jclassName(this); },
    "ensureExtDataPresent()Ldalvik/system/ClassExt;": function (this: JClass) { return this.ext ??= rt.make("dalvik/system/ClassExt"); },
    // ClassLinker::LookupPrimitiveClass, which the wrapper classes' <clinit> ask for their TYPE
    "static getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;": (name: string) =>
      PRIMITIVES.has(name ?? rt.npe()) ? rt.classFor(name) : (() => { throw rt.mkThrowable("java/lang/ClassNotFoundException", name); })(),
    "getSimpleName()Ljava/lang/String;": function (this: JClass) {
      const n = jclassName(this);
      const i = Math.max(n.lastIndexOf("."), n.lastIndexOf("$"));
      return i >= 0 ? n.slice(i + 1) : n;
    },
    "hashCode()I": function () { return idHash(this); },
    "isInstance(Ljava/lang/Object;)Z": function (this: JClass, o: unknown) {
      // a field updater's receiver and value checks, per call: most receivers are exactly the
      // class, and most reference updaters take any Object
      if (o != null && ((o as JObj).constructor === this.ci?.ctor || this.ci?.name === "java/lang/Object")) return 1;
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
const classPathHandlers = new Map<string, unknown>();
/** the URL handler a device keeps per class path archive (DexPathList.Element, VMClassLoader);
 *  an archive that does not open as a jar has none */
const classPathHandler = driven(function* (archive: string): Gen {
  if (!classPathHandlers.has(archive)) {
    let handler = null;
    try { handler = yield newObj("libcore/io/ClassPathURLStreamHandler", "(Ljava/lang/String;)V", archive); }
    catch (e) { if (!rt.iof(e, "java/io/IOException")) throw e; }
    classPathHandlers.set(archive, handler);
  }
  return classPathHandlers.get(archive);
});
const packages = new Map<string, unknown>();
/** libcore's Package for `name`, one per name as a class loader keeps them. Package's initializer
 *  and constructor never suspend, so a caller does not suspend on its first package either. */
export function packageNamed(name: string): unknown {
  const known = packages.get(name);
  if (known) return known;
  const info = rt.link("java/lang/Package"), pending = rt.initClass(info);
  if (pending) return pending.then(() => packageNamed(name));
  const p = new info.ctor();
  vcall(p, "<init>", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/net/URL;Ljava/lang/ClassLoader;)V",
    name, null, null, null, null, null, null, null, null);
  packages.set(name, p);
  return p;
}
const loaderPackages = new WeakMap<Runtime, { classes: number; names: Set<string> }>();
/** the packages whose classes a loader's runtime can define */
function definesPackage(runtime: Runtime, name: string): boolean {
  let known = loaderPackages.get(runtime);
  if (!known || known.classes !== runtime.dexIndex.size) {
    const names = new Set<string>();
    for (const cls of runtime.dexIndex.keys()) names.add(cls.slice(0, Math.max(0, cls.lastIndexOf("/"))));
    loaderPackages.set(runtime, known = { classes: runtime.dexIndex.size, names });
  }
  return known.names.has(slashName(name)) || !!runtime.parent && definesPackage(runtime.parent, name);
}
rt.register({
  name: "java/lang/ClassLoader",
  ctor: JClassLoader,
  methods: {
    "getPackage(Ljava/lang/String;)Ljava/lang/Package;": function (this: JClassLoader, name: string) {
      return definesPackage(this.runtime, name) ? packageNamed(name) : null;
    },
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
    "findResource(Ljava/lang/String;)Ljava/net/URL;": driven(function* (this: JClassLoader, path: string): Gen {
      if (!this.runtime.hasClasspath(path)) return null;
      const handler = yield classPathHandler(this.runtime.bootResources.get(path)?.jar ?? this.runtime.classpathLocations.get(path) ?? apkPath());
      return handler && vcall(handler, "getEntryUrlOrNull", "(Ljava/lang/String;)Ljava/net/URL;", path);
    }),
    "getResource(Ljava/lang/String;)Ljava/net/URL;": driven(function* (this: JClassLoader, path: string): Gen {
      const inherited = this.parent && (yield vcall(this.parent, "getResource", "(Ljava/lang/String;)Ljava/net/URL;", path));
      return inherited || vcall(this, "findResource", "(Ljava/lang/String;)Ljava/net/URL;", path);
    }),
    "findResources(Ljava/lang/String;)Ljava/util/Enumeration;": driven(function* (this: JClassLoader, path: string): Gen {
      const { mkEnumeration } = yield* awaited(import("./jcoll"));
      const url = yield vcall(this, "findResource", "(Ljava/lang/String;)Ljava/net/URL;", path);
      return mkEnumeration(url ? [url] : []);
    }),
    "getResources(Ljava/lang/String;)Ljava/util/Enumeration;": driven(function* (this: JClassLoader, path: string): Gen {
      const { mkEnumeration } = yield* awaited(import("./jcoll"));
      const urls: unknown[] = [];
      const inherited = this.parent && (yield vcall(this.parent, "getResources", "(Ljava/lang/String;)Ljava/util/Enumeration;", path));
      if (inherited) while (yield vcall(inherited, "hasMoreElements", "()Z")) urls.push(yield vcall(inherited, "nextElement", "()Ljava/lang/Object;"));
      const own = yield vcall(this, "findResources", "(Ljava/lang/String;)Ljava/util/Enumeration;", path);
      while (yield vcall(own, "hasMoreElements", "()Z")) urls.push(yield vcall(own, "nextElement", "()Ljava/lang/Object;"));
      return mkEnumeration(urls);
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
        const bytes = yield* awaited(this.runtime.readClasspath(entry));
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
export const classpathStream = (path: string, runtime: Runtime = rt): unknown =>
  after(runtime.readClasspath(path), (bytes) => bytes ? newObj("java/io/ByteArrayInputStream", "([B)V", i8(bytes)) : null);

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
  const quiet = rt.quiet.types;
  t.trace = null;
  if (quiet !== null && quiet.split("|").some((n) => (t.constructor as { $i?: ClassInfo }).$i?.types.has(n))) {
    t.jsErr = null;
    t.coldFrames = [];
    return;
  }
  t.jsErr = jsStackHere();
  t.coldFrames = coldStack.slice(-STACK_DEPTH);
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
    if (!at) {
      // a persisted body's script names the whole chunk; its function names the method
      const named = /^\s*at /.test(line) ? frameOf(line) : null;
      if (named) out.push(named);
      continue;
    }
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
  const ste = rt.link("java/lang/StackTraceElement");
  rt.ensureCompiled(ste);
  const element = (cls: string, method: string) => {
    const e = new ste.ctor();
    e[STE_CLASS] = cls; e[STE_METHOD] = method; e[STE_LINE] = -1;
    return e;
  };
  const out = frames.map(([cls, method]) => element(dotName(cls), method));
  if (!out.length) out.push(element("", ""));
  return jarray(out, "Ljava/lang/StackTraceElement;");
}
const STE_CLASS = mangleField("java/lang/StackTraceElement", "declaringClass"), STE_METHOD = mangleField("java/lang/StackTraceElement", "methodName"),
  STE_LINE = mangleField("java/lang/StackTraceElement", "lineNumber");
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
  // the defining loader of the innermost frame whose class is not the platform's
  "static getClosestUserClassLoader()Ljava/lang/ClassLoader;": () => {
    for (const [cls] of framesHere()) if (!rt.platformClasses.has(cls) && !rt.natives.has(cls)) return (rt.link(cls).owner ?? rt).classLoader ?? null;
    return null;
  },
  // another cooperative thread's frames are not on the JS stack: none, as for a thread not running
  "static getThreadStackTrace(Ljava/lang/Thread;)[Ljava/lang/StackTraceElement;": (t: JThread | null) =>
    stackTrace(t === curThread ? [["dalvik/system/VMStack", "getThreadStackTrace"], ...framesHere()] : []),
} });

const printStackTraceTo = driven(function* (this: JThrowable, out: unknown): Gen {
  yield vcall(out, "println", "(Ljava/lang/String;)V", yield* awaited(stackTraceText(this)));
});
/** JVM-shaped stack trace text: header from the (overridable) toString, then the trace's frames. */
export const stackTraceText = driven(function* (t: JThrowable): Gen<string> {
  function* described(c: JThrowable): Gen<string> {
    let text = String(yield vcall(c, "toString", "()Ljava/lang/String;"));
    for (const e of c.trace ??= throwableTrace(c)) text += "\n\tat " + (yield vcall(e, "toString", "()Ljava/lang/String;"));
    return text;
  }
  let out = yield* described(t);
  const seen = new Set<JThrowable>([t]);
  for (let c = yield* awaited(causeOf(t)); c && !seen.has(c); c = yield* awaited(causeOf(c))) {
    seen.add(c);
    out += "\nCaused by: " + (yield* described(c));
  }
  return out;
});
/** Throwable.getCause, which libcore's InvocationTargetException, UndeclaredThrowableException and
 *  PrivilegedActionException answer from their own fields */
const causeOf = (t: JThrowable): JThrowable | null | Promise<JThrowable | null> => vcall(t, "getCause", "()Ljava/lang/Throwable;");
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
  const next = (t: JThrowable) => { const c = causeOf(t); return c instanceof Promise ? null : c; };
  for (let c = je && next(je), depth = 0; c && depth < 8; c = next(c), depth++) {
    causes += `\n  caused by ${(c.constructor as any)?.$i?.name ?? "?"}: ${c.msg ?? ""}`;
  }
  const jframes = (je as { jframes?: string[] } | null)?.jframes;
  console.error("[uncaught]", (je?.constructor as any)?.$i?.name ?? "?", (je?.msg ?? "") + causes + (jframes ? "\n  at " + jframes.join("\n  at ") : ""), (je as any)?.jsStack ?? (e as any)?.stack ?? "");
  rt.onUncaught(je);
}

/** Objects.checkFromIndexSize: [off, off + len) must lie within [0, length) */
export function checkFromIndexSize(off: number, len: number, length: number, cls = "java/lang/IndexOutOfBoundsException"): void {
  if (off < 0 || len < 0 || off > length - len) throw rt.mkThrowable(cls, null);
}

/** a throwable made without running its constructors: `cls` linked, its message set, its trace
 *  taken here (a class that is not a throwable, or cannot link, makes a plain Throwable) */
rt.mkThrowable = (cls: string, msg: string | null) => {
  let ctor: new () => JThrowable = JThrowable;
  try {
    const info = rt.link(cls);
    if (info.ctor.prototype instanceof JThrowable) { rt.ensureCompiled(info); ctor = info.ctor; }
  } catch { /* fall through */ }
  const e = new ctor();
  e.msg = msg;
  captureStack(e);
  return e;
};

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
// Case-insensitive comparison is libcore's (Character.toUpperCase, then toLowerCase, per char); ASCII
// chars, whose cases are ASCII letters, compare here
sm("equalsIgnoreCase(Ljava/lang/String;)Z", function (o: string | null) {
  if (o === null || o.length !== this.length) return 0;
  for (let i = 0; i < o.length; i++) {
    const a = this.charCodeAt(i), b = o.charCodeAt(i), lower = a | 0x20;
    if (a === b) continue;
    if ((a | b) >= 0x80) return vcall(this, "regionMatches", "(ZILjava/lang/String;II)Z", 1, 0, o, 0, this.length);
    if (lower !== (b | 0x20) || lower < 0x61 || lower > 0x7a) return 0;
  }
  return 1;
});
function stringCompare(a: string, b: string): number {
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
/** String.indexOf(int): a char, a surrogate pair for a supplementary code point, never an invalid one.
 *  Short strings (URI and parser delimiter sets) are scanned without allocating the needle. */
function charIndex(s: string, c: number, from: number): number {
  if (c >>> 0 < 0x10000 && s.length - from < 32) {
    for (let i = from < 0 ? 0 : from; i < s.length; i++) if (s.charCodeAt(i) === c) return i;
    return -1;
  }
  return c >>> 0 > 0x10ffff ? -1 : s.indexOf(String.fromCodePoint(c), from);
}
function charLastIndex(s: string, c: number, from: number): number {
  return from < 0 || c >>> 0 > 0x10ffff ? -1 : s.lastIndexOf(String.fromCodePoint(c), from);
}
sm("indexOf(I)I", function (c: number) { return charIndex(this, c, 0); });
sm("indexOf(II)I", function (c: number, from: number) { return charIndex(this, c, from); });
sm("indexOf(Ljava/lang/String;)I", function (s: string) { return this.indexOf(s); });
sm("indexOf(Ljava/lang/String;I)I", function (s: string, from: number) { return this.indexOf(s, from); });
sm("lastIndexOf(I)I", function (c: number) { return charLastIndex(this, c, this.length); });
sm("lastIndexOf(Ljava/lang/String;)I", function (s: string) { return this.lastIndexOf(s); });
sm("lastIndexOf(II)I", function (c: number, from: number) { return charLastIndex(this, c, from); });
sm("lastIndexOf(Ljava/lang/String;I)I", function (v: string, from: number) { return this.lastIndexOf(v, from); });
sm("substring(I)Ljava/lang/String;", function (i: number) {
  if (i < 0 || i > this.length) sioobe(i);
  return this.slice(i);
});
const substring = function (this: string, a: number, b: number) {
  if (a < 0 || b > this.length || a > b) sioobe(a);
  return this.slice(a, b);
};
sm("substring(II)Ljava/lang/String;", substring);
sm("subSequence(II)Ljava/lang/CharSequence;", substring);
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
sm("doRepeat(I)Ljava/lang/String;", function (n: number) { return this.repeat(n); });
// CaseMapper: only Turkish, Azeri and Lithuanian case differently, and only these letters; the
// no-argument forms case for Locale.getDefault()
const LOCALE_CASED = /[IiJj\u00cc\u00cd\u0128\u012e\u0130\u0131\u0307]/, CASE_LOCALES = new Set(["tr", "az", "lt"]);
/** `s` cased as `lang` cases it; languages CaseMapper does not treat apart case as the root locale */
const caseAs = (s: string, upper: boolean, lang: string): string => !CASE_LOCALES.has(lang)
  ? upper ? s.toUpperCase() : s.toLowerCase() : upper ? s.toLocaleUpperCase(lang) : s.toLocaleLowerCase(lang);
/** a Locale's language, which never changes */
const languages = new WeakMap<object, string>();
const language = (locale: object): string | Promise<string> => languages.get(locale) ??
  after(vcall(locale, "getLanguage", "()Ljava/lang/String;"), (lang: string) => { languages.set(locale, lang); return lang; });
function caseIn(s: string, locale: object | null, upper: boolean): unknown {
  if (locale === null) return rt.npe();
  return LOCALE_CASED.test(s) ? after(language(locale), (lang) => caseAs(s, upper, lang)) : caseAs(s, upper, "");
}
const GET_DEFAULT = mangleMethod("getDefault", "()Ljava/util/Locale;"), localeClass = once(() => linkInit("java/util/Locale"));
const caseInDefault = (s: string, upper: boolean): unknown => !LOCALE_CASED.test(s) ? caseAs(s, upper, "")
  : after(localeClass(), (info) => after((info.ctor as Record<string, () => object>)[GET_DEFAULT](), (locale) => caseIn(s, locale, upper)));
sm("toLowerCase()Ljava/lang/String;", function () { return caseInDefault(this, false); });
sm("toUpperCase()Ljava/lang/String;", function () { return caseInDefault(this, true); });
sm("toLowerCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, false); });
sm("toUpperCase(Ljava/util/Locale;)Ljava/lang/String;", function (locale: object | null) { return caseIn(this, locale, true); });
sm("toString()Ljava/lang/String;", function () { return this as string; });
sm("toCharArray()[C", function () {
  const a = new Uint16Array(this.length);
  for (let i = 0; i < this.length; i++) a[i] = this.charCodeAt(i);
  return a;
});
sm("getChars(II[CI)V", function (srcBegin: number, srcEnd: number, dst: Uint16Array, dstBegin: number) {
  if (srcBegin < 0 || srcBegin > srcEnd || srcEnd > this.length) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `begin ${srcBegin}, end ${srcEnd}, length ${this.length}`);
  if (!dst) rt.npe();
  if (dstBegin < 0 || dstBegin > dst.length - (srcEnd - srcBegin)) throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", `offset ${dstBegin}, count ${srcEnd - srcBegin}, length ${dst.length}`);
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
// ART's compact-string internals, which libcore's builders and StringLatin1/StringUTF16 use: coder
// 0 (LATIN1) holds each char in a byte, coder 1 (UTF16) in two, low byte first; fills start at a byte index
const NOT_LATIN1 = /[^\x00-\xff]/;
sm("coder()B", function () { return NOT_LATIN1.test(this) ? 1 : 0; });
sm("fillBytesLatin1([BI)V", function (dst: Int8Array, at: number) { for (let i = 0; i < this.length; i++) dst[at + i] = this.charCodeAt(i); });
sm("fillBytesUTF16([BI)V", function (dst: Int8Array, at: number) {
  for (let i = 0, j = at; i < this.length; i++, j += 2) { const c = this.charCodeAt(i); dst[j] = c; dst[j + 1] = c >> 8; }
});
// ART's string allocations, which String's constructors become
rt.registerJnis("java/lang/StringFactory", {
  "newStringFromBytes([BIII)Ljava/lang/String;": (b: Int8Array, high: number, off: number, n: number) => rt.newStr["([BIII)V"](b, high, off, n),
  "newStringFromChars(II[C)Ljava/lang/String;": (off: number, n: number, chars: Uint16Array) => rt.strChars(chars, off, n),
  "newStringFromString(Ljava/lang/String;)Ljava/lang/String;": (s: string | null) => s ?? rt.npe(),
  "newStringFromUtf8Bytes([BII)Ljava/lang/String;": (b: Int8Array, off: number, n: number) => rt.newStr["([BII)V"](b, off, n),
  "newStringFromUtf16Bytes([BII)Ljava/lang/String;": (b: Int8Array, off: number, n: number) => {
    const chars = new Uint16Array(n);
    for (let i = 0; i < n; i++) chars[i] = (b[off + 2 * i] & 255) | ((b[off + 2 * i + 1] & 255) << 8);
    return charsToString(chars, 0, n);
  },
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
sm("contentEquals(Ljava/lang/CharSequence;)Z", function (o: unknown) { return (this as string) === jToString(o) ? 1 : 0; });
sm("codePointCount(II)I", function (a: number, b: number) { return cpCount(this, a, b); });
sm("offsetByCodePoints(II)I", function (i: number, n: number) { return offsetCodePoints(String(this), i, n); });
const intStream = (values: Int32Array) => scall("java/util/Arrays", "stream", "([I)Ljava/util/stream/IntStream;", values);
const charStream = (s: string) => intStream(Int32Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)));
const codePointStream = (s: string) => intStream(Int32Array.from(s, (ch) => ch.codePointAt(0)!));
sm("chars()Ljava/util/stream/IntStream;", function () { return charStream(this); });
sm("codePoints()Ljava/util/stream/IntStream;", function () { return codePointStream(this); });
sm("getClass()Ljava/lang/Class;", function () { return rt.classFor("java/lang/String"); });
sm("matches(Ljava/lang/String;)Z", function (p: string) { return stringMatches(this as string, p); });
sm("replaceAll(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, true); });
sm("replaceFirst(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", function (p: string, r: string) { return stringReplace(this as string, p, r, false); });
sm("split(Ljava/lang/String;)[Ljava/lang/String;", function (p: string) { return stringSplit(this as string, p, 0); });
sm("split(Ljava/lang/String;I)[Ljava/lang/String;", function (p: string, l: number) { return stringSplit(this as string, p, l); });

const M_TO_STRING = mangleMethod("toString", "()Ljava/lang/String;");
/** A value's OWN toString — %s prints that, and so does every CharSequence a synchronous
 *  native is handed. A body that suspends cannot be awaited here and falls back to JS. */
function jToString(v: unknown): string {
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
const stringOf = (v: unknown): string | Promise<string> => after(valueOfObject(v), String);
rt.register({
  name: "java/lang/String",
  ctor: String, // instances are JS primitives
  ifaces: ["java/lang/CharSequence", "java/lang/Comparable", "java/io/Serializable"],
  // strings travel as TC_STRING; their class descriptor (a Class<String> written on its own) has no fields
  serialization: { uid: -6849794470754667710n, fields: [] },
  methods: {
    "static valueOf(I)Ljava/lang/String;": (v: number) => String(v),
    "static valueOf(J)Ljava/lang/String;": (v: bigint) => String(v),
    "static valueOf(Z)Ljava/lang/String;": (v: number) => (v ? "true" : "false"),
    "static valueOf(C)Ljava/lang/String;": (v: number) => String.fromCharCode(v),
    "static valueOf(Ljava/lang/Object;)Ljava/lang/String;": valueOfObject,
    "static valueOf([C)Ljava/lang/String;": (v: Uint16Array) => charsToString(v, 0, v.length),
    "static valueOf([CII)Ljava/lang/String;": (v: Uint16Array, o: number, n: number) => charsToString(v, o, n),
    "static join(Ljava/lang/CharSequence;[Ljava/lang/CharSequence;)Ljava/lang/String;": driven(joinCharSequences),
    "static join(Ljava/lang/CharSequence;Ljava/lang/Iterable;)Ljava/lang/String;": joinIterable,
  },
  // String's <clinit> does not run for the spec: its comparator is made on first read
  statics: { get CASE_INSENSITIVE_ORDER() { return rt.make("java/lang/String$CaseInsensitiveComparator"); } },
});
// §4.7: StringBuilder and StringBuffer over a JS string, which V8 concatenates as a rope: libcore's
// builders fill a byte[] char by char and measured 8x-15x slower on appends. Every method follows
// libcore's AbstractStringBuilder, its capacity policy and messages included (tests/intrinsics.test.ts
// runs both over generated operations); float and double text is libcore's Float/Double.toString.
class JSB extends JObj {
  s = "";
  /** the capacity libcore's builder would have: its value array's length in chars */
  cap = 16;
}
const indexError = (msg: string): never => { throw rt.mkThrowable("java/lang/StringIndexOutOfBoundsException", msg); };
const checkIndex = (i: number, n: number) => { if (i < 0 || i >= n) indexError(`index ${i},length ${n}`); };
const checkOffset = (i: number, n: number) => { if (i < 0 || i > n) indexError(`offset ${i},length ${n}`); };
const checkRange = (start: number, end: number, n: number, cls = "java/lang/StringIndexOutOfBoundsException") => {
  if (start < 0 || start > end || end > n) throw rt.mkThrowable(cls, `start ${start}, end ${end}, length ${n}`);
};
/** AbstractStringBuilder.ensureCapacityInternal: at least `min`, at least twice plus two */
function grow(sb: JSB, min: number): void { if (min > sb.cap) sb.cap = Math.max(min, sb.cap * 2 + 2); }
/** the append every builder method but insert takes */
function add(sb: JSB, text: string): JSB {
  grow(sb, sb.s.length + text.length);
  sb.s += text;
  return sb;
}
function put(sb: JSB, at: number, text: string): JSB {
  grow(sb, sb.s.length + text.length);
  sb.s = at === sb.s.length ? sb.s + text : sb.s.slice(0, at) + text + sb.s.slice(at);
  return sb;
}
const floatText = (v: number) => scall("java/lang/Float", "toString", "(F)Ljava/lang/String;", v);
const doubleText = (v: number) => scall("java/lang/Double", "toString", "(D)Ljava/lang/String;", v);
const charRange = (v: Uint16Array | null, start: number, n: number) => {
  if (v === null) return rt.npe();
  checkRange(start, start + n, v.length);
  return charsToString(v, start, n);
};
/** chars [a, b) of a CharSequence (b undefined: its length), read as libcore's builders read one:
 *  a String's or a builder's text, any other sequence through length() and charAt() */
const csChars = driven(function* csChars(v: unknown, a: number, b?: number): Gen<string> {
  if (v === null) v = "null";
  const text = typeof v === "string" ? v : v instanceof JSB ? v.s : null;
  const n: number = text?.length ?? (yield vcall(v, "length", "()I"));
  b ??= n;
  checkRange(a, b, n, "java/lang/IndexOutOfBoundsException");
  if (text !== null) return text.slice(a, b);
  const chars = new Uint16Array(b - a);
  for (let i = a; i < b; i++) chars[i - a] = yield vcall(v, "charAt", "(I)C", i);
  return charsToString(chars, 0, chars.length);
});
function sbSpec(name: string): NativeSpec {
  const c = name === "java/lang/StringBuilder" ? class SB extends JSB {} : class SBuf extends JSB {};
  const L = `L${name};`;
  const at = (self: JSB, i: number, text: string | Promise<string>) => after(text, (t: string) => put(self, i, t));
  const appendText = (self: JSB, t: string | Promise<string>) => after(t, (text: string) => add(self, text));
  const appendCs = function (this: JSB, v: unknown) { return appendText(this, csChars(v, 0)); };
  const insertText = (text: (v: any) => string | Promise<string>) => function (this: JSB, i: number, v: unknown) { checkOffset(i, this.s.length); return at(this, i, text(v)); };
  const methods: NativeSpec["methods"] = {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JSB, n: number) { if (n < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(n)); this.cap = n; },
    "<init>(Ljava/lang/String;)V": function (this: JSB, s: string | null) { this.cap = (s ?? rt.npe()).length + 16; this.s = s!; },
    "<init>(Ljava/lang/CharSequence;)V": function (this: JSB, v: unknown) {
      return after(csChars(v ?? rt.npe(), 0), (s: string) => { this.cap = s.length + 16; this.s = s; });
    },
    [`append(Ljava/lang/String;)${L}`]: function (this: JSB, v: string | null) { return add(this, v ?? "null"); },
    [`append(Ljava/lang/Object;)${L}`]: function (this: JSB, v: unknown) { return appendText(this, stringOf(v)); },
    [`append(Ljava/lang/CharSequence;)${L}`]: appendCs,
    [`append(Ljava/lang/StringBuffer;)${L}`]: appendCs,
    [`append(Ljava/lang/CharSequence;II)${L}`]: function (this: JSB, v: unknown, a: number, b: number) { return appendText(this, csChars(v, a, b)); },
    [`append([C)${L}`]: function (this: JSB, v: Uint16Array) { return add(this, charRange(v, 0, v?.length ?? 0)); },
    [`append([CII)${L}`]: function (this: JSB, v: Uint16Array, o: number, n: number) { return add(this, charRange(v, o, n)); },
    [`append(Z)${L}`]: function (this: JSB, v: number) { return add(this, v ? "true" : "false"); },
    [`append(C)${L}`]: function (this: JSB, v: number) { return add(this, String.fromCharCode(v)); },
    [`append(I)${L}`]: function (this: JSB, v: number) { return add(this, "" + v); },
    [`append(J)${L}`]: function (this: JSB, v: bigint) { return add(this, "" + v); },
    [`append(F)${L}`]: function (this: JSB, v: number) { return appendText(this, floatText(v)); },
    [`append(D)${L}`]: function (this: JSB, v: number) { return appendText(this, doubleText(v)); },
    [`appendCodePoint(I)${L}`]: function (this: JSB, cp: number) {
      if (cp >>> 0 > 0x10ffff) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid Unicode code point: 0x" + (cp >>> 0).toString(16).toUpperCase());
      return add(this, String.fromCodePoint(cp));
    },
    [`insert(ILjava/lang/String;)${L}`]: insertText((v: string | null) => v ?? "null"),
    [`insert(ILjava/lang/Object;)${L}`]: insertText(stringOf),
    [`insert(ILjava/lang/CharSequence;)${L}`]: insertText((v) => csChars(v, 0)),
    [`insert(ILjava/lang/CharSequence;II)${L}`]: function (this: JSB, i: number, v: unknown, a: number, b: number) {
      checkOffset(i, this.s.length);
      return at(this, i, csChars(v, a, b));
    },
    [`insert(IC)${L}`]: insertText((v: number) => String.fromCharCode(v)),
    [`insert(II)${L}`]: insertText((v: number) => "" + v),
    [`insert(IJ)${L}`]: insertText((v: bigint) => "" + v),
    [`insert(IF)${L}`]: insertText(floatText),
    [`insert(ID)${L}`]: insertText(doubleText),
    [`insert(IZ)${L}`]: insertText((v: number) => (v ? "true" : "false")),
    [`insert(I[C)${L}`]: insertText((v: Uint16Array) => charRange(v, 0, v?.length ?? 0)),
    [`insert(I[CII)${L}`]: function (this: JSB, i: number, v: Uint16Array, o: number, n: number) {
      checkOffset(i, this.s.length);
      if (v === null) return rt.npe();
      checkRange(o, o + n, v.length);
      return put(this, i, charsToString(v, o, n));
    },
    "toString()Ljava/lang/String;": function (this: JSB) { return this.s; },
    "length()I": function (this: JSB) { return this.s.length; },
    "capacity()I": function (this: JSB) { return this.cap; },
    "ensureCapacity(I)V": function (this: JSB, n: number) { if (n > 0) grow(this, n); },
    "trimToSize()V": function (this: JSB) { if (this.s.length < this.cap) this.cap = this.s.length; },
    "charAt(I)C": function (this: JSB, i: number) { checkIndex(i, this.s.length); return this.s.charCodeAt(i); },
    "getChars(II[CI)V": function (this: JSB, begin: number, end: number, dst: Uint16Array, at: number) {
      checkRange(begin, end, this.s.length);
      if (dst === null) return rt.npe();
      checkRange(at, at + end - begin, dst.length, "java/lang/IndexOutOfBoundsException");
      for (let i = begin; i < end; i++) dst[at + i - begin] = this.s.charCodeAt(i);
    },
    "codePointAt(I)I": function (this: JSB, i: number) { checkIndex(i, this.s.length); return cpAt(this.s, i); },
    "codePointBefore(I)I": function (this: JSB, i: number) { checkIndex(i - 1, this.s.length); return cpBefore(this.s, i); },
    "codePointCount(II)I": function (this: JSB, a: number, b: number) { return cpCount(this.s, a, b); },
    "offsetByCodePoints(II)I": function (this: JSB, i: number, n: number) { return offsetCodePoints(this.s, i, n); },
    "chars()Ljava/util/stream/IntStream;": function (this: JSB) { return charStream(this.s); },
    "codePoints()Ljava/util/stream/IntStream;": function (this: JSB) { return codePointStream(this.s); },
    [`compareTo(${L})I`]: function (this: JSB, o: JSB) { return stringCompare(this.s, (o ?? rt.npe()).s); },
    [`replace(IILjava/lang/String;)${L}`]: function (this: JSB, a: number, b: number, r: string) {
      const n = this.s.length;
      if (b > n) b = n;
      checkRange(a, b, n);
      grow(this, n + (r ?? rt.npe()).length - (b - a));
      this.s = this.s.slice(0, a) + r + this.s.slice(b);
      return this;
    },
    "setLength(I)V": function (this: JSB, n: number) {
      if (n < 0) indexError("String index out of range: " + n);
      grow(this, n);
      this.s = n <= this.s.length ? this.s.slice(0, n) : this.s.padEnd(n, "\0");
    },
    [`reverse()${L}`]: function (this: JSB) { this.s = [...this.s].reverse().join(""); return this; },
    [`deleteCharAt(I)${L}`]: function (this: JSB, i: number) {
      checkIndex(i, this.s.length);
      this.s = this.s.slice(0, i) + this.s.slice(i + 1);
      return this;
    },
    [`delete(II)${L}`]: function (this: JSB, a: number, b: number) {
      const n = this.s.length;
      if (b > n) b = n;
      checkRange(a, b, n);
      this.s = this.s.slice(0, a) + this.s.slice(b);
      return this;
    },
    "indexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.indexOf(v ?? rt.npe()); },
    "indexOf(Ljava/lang/String;I)I": function (this: JSB, v: string, from: number) { return this.s.indexOf(v ?? rt.npe(), from); },
    "lastIndexOf(Ljava/lang/String;)I": function (this: JSB, v: string) { return this.s.lastIndexOf(v ?? rt.npe()); },
    "lastIndexOf(Ljava/lang/String;I)I": function (this: JSB, v: string, from: number) { return from < 0 ? (v ?? rt.npe(), -1) : this.s.lastIndexOf(v ?? rt.npe(), from); },
    "substring(I)Ljava/lang/String;": function (this: JSB, a: number) { checkRange(a, this.s.length, this.s.length); return this.s.slice(a); },
    "substring(II)Ljava/lang/String;": function (this: JSB, a: number, b: number) { checkRange(a, b, this.s.length); return this.s.slice(a, b); },
    "subSequence(II)Ljava/lang/CharSequence;": function (this: JSB, a: number, b: number) { checkRange(a, b, this.s.length); return this.s.slice(a, b); },
    "setCharAt(IC)V": function (this: JSB, i: number, ch: number) {
      checkIndex(i, this.s.length);
      this.s = this.s.slice(0, i) + String.fromCharCode(ch) + this.s.slice(i + 1);
    },
  };
  return { name, ctor: c, ifaces: ["java/lang/CharSequence", "java/lang/Appendable", "java/lang/Comparable"], methods };
}
rt.register(sbSpec("java/lang/StringBuilder"));
rt.register(sbSpec("java/lang/StringBuffer"));
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

function arraycopy(src: any, sp: number, dst: any, dp: number, len: number) {
  if (src === null || dst === null) rt.npe();
  if (sp < 0 || dp < 0 || len < 0 || sp > src.length - len || dp > dst.length - len) {
    throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", `src.length=${src.length} srcPos=${sp} dst.length=${dst.length} dstPos=${dp} length=${len}`);
  }
  if (len === 0) return;
  // a short copy loops: a subarray view costs more than its elements
  if (len > 16 && ArrayBuffer.isView(src)) {
    (dst as { set(a: unknown, o: number): void }).set((src as Uint8Array).subarray(sp, sp + len), dp);
  } else if (src === dst && dp > sp) {
    for (let i = len - 1; i >= 0; i--) dst[dp + i] = src[sp + i];
  } else {
    for (let i = 0; i < len; i++) dst[dp + i] = src[sp + i];
  }
}
const loadedLibs = new Map<string, { owner: Runtime; thread: JThread; pending: Promise<string | null> }>();
/** what a device this shape carries, most-preferred first. Which of them we can EXECUTE is the
 *  native tier's answer (rt.nativeAbis), and a library we can run beats one we cannot. */
const ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86_64", "x86"];
/** the ABI an apk's lib/ would be loaded from: the first the tier runs, else the first present
 *  — so the UnsatisfiedLinkError names the machine code the device would actually have used */
function pickAbi(has: (abi: string) => boolean): string | null {
  return rt.nativeAbis.find(has) ?? ABIS.find(has) ?? null;
}
/** the ABI an app's libraries load from, given its entry names, when it ships any */
export function libraryAbi(names: Iterable<string>): string | null {
  const dirs = new Set([...names].flatMap((name) => /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1] ?? []));
  return dirs.size ? pickAbi((a) => dirs.has(a)) : null;
}
const appAbis = new WeakMap<Runtime, string | null>();
/** the ABI the app's own libraries load from, when it ships any */
export function appNativeAbi(owner: Runtime = rt): string | null {
  if (appAbis.has(owner)) return appAbis.get(owner)!;
  const abi = libraryAbi(owner.classpathNames());
  appAbis.set(owner, abi);
  return abi;
}
const E_MACHINE: Record<number, string> = { 0xb7: "arm64-v8a", 0x28: "armeabi-v7a", 0x3e: "x86_64", 0x03: "x86" };
/** Runtime.nativeLoad: `file` is a path (ClassLoader.findLibrary's, System.load's) or a bare name
 *  from the loader's class path; null once the library is loaded, else the linker's error */
function nativeLoad(file: string, loader: JClassLoader | null): string | null | Promise<string | null> {
  const owner = loader?.runtime ?? rt, lib = file.slice(file.lastIndexOf("/") + 1);
  if (owner.nativeLibs.has(lib.replace(/^lib|\.so$/g, ""))) return null;
  const have = loadedLibs.get(lib);
  if (have) return have.owner !== owner ? `Library ${lib} already loaded by another ClassLoader` : have.thread === curThread ? null : have.pending;
  const thread = curThread;
  const pending = (async (): Promise<string | null> => {
    let abi: string | null, bytes: Uint8Array | null;
    if (file.startsWith("/")) {
      bytes = await vfs.readFile(file);
      abi = bytes && (E_MACHINE[bytes[18] | (bytes[19] << 8)] ?? "unknown");
    } else {
      abi = pickAbi((a) => owner.hasClasspath(`lib/${a}/${lib}`));
      bytes = abi ? await owner.readClasspath(`lib/${abi}/${lib}`) : null;
    }
    if (abi && bytes && owner.loadNativeLib) {
      try { await owner.loadNativeLib(lib, bytes, abi, owner, thread); return null; }
      catch (e) {
        rt.noteNativeRequired(lib, abi);
        if (e instanceof rt.link("java/lang/UnsatisfiedLinkError").ctor) return (e as JThrowable).msg;
        throw e;
      }
    }
    if (abi) rt.noteNativeRequired(lib, abi);
    return `dlopen failed: library "${lib}" ${abi ? "is " + abi + " machine code" : "not found"}`;
  })();
  loadedLibs.set(lib, { owner, thread, pending });
  const forget = () => { loadedLibs.delete(lib); };
  pending.then((error) => { if (error !== null) forget(); }, forget);
  return pending;
}
rt.register({
  name: "java/lang/System", ctor: class extends JObj {}, platformClinit: true,
  // Reflection.getCallerClass names a frame's class, not its defining loader: compiled callers pass their Runtime
  callerSensitive: ["loadLibrary(Ljava/lang/String;)V", "load(Ljava/lang/String;)V"],
  methods: {
    "static arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V": arraycopy,
    "static currentTimeMillis()J": () => BigInt(Math.floor(wallMillis())),
    "static nanoTime()J": () => BigInt(Math.floor(uptimeMillis() * 1e6)),
    // libcore's Object.identityHashCode reads the lock word
    "static identityHashCode(Ljava/lang/Object;)I": idHash,
    // System.c: the zygote's working directory, and the linker's default search path
    "static specialProperties()[Ljava/lang/String;": () =>
      jarray(["user.dir=/", `java.library.path=${processEnv.LD_LIBRARY_PATH ?? "/system/lib64:/system_ext/lib64"}`], "Ljava/lang/String;"),
    "static mapLibraryName(Ljava/lang/String;)Ljava/lang/String;": (name: string) => { if (name === null) rt.npe(); return `lib${name}.so`; },
    "static loadLibrary(Ljava/lang/String;)V": driven(function* (name: string, owner: Runtime = rt): Gen {
      yield vcall(yield scall("java/lang/Runtime", "getRuntime", "()Ljava/lang/Runtime;"), "loadLibrary0", "(Ljava/lang/ClassLoader;Ljava/lang/String;)V", owner.classLoader ?? null, name);
    }),
    // Runtime.load0
    "static load(Ljava/lang/String;)V": driven(function* (path: string, owner: Runtime = rt): Gen {
      if (path === null) rt.npe();
      if (!path.startsWith("/")) throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", "Expecting an absolute path of the library: " + path);
      const error = yield* awaited(nativeLoad(path, (owner.classLoader ?? null) as JClassLoader | null));
      if (error !== null) throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", error);
    }),
  },
});
for (const [name, desc] of [["In", "Ljava/io/InputStream;"], ["Out", "Ljava/io/PrintStream;"], ["Err", "Ljava/io/PrintStream;"]]) {
  rt.registerJni("java/lang/System", `set${name}0(${desc})V`, (stream: unknown) => { rt.link("java/lang/System").ctor[mangleStaticField(name.toLowerCase())] = stream; });
}
// Clock.systemUTC's wall time: nanoseconds past `offset` seconds, or -1 beyond ±2^32 s as libcore expects
rt.registerJni("jdk/internal/misc/VM", "getNanoTimeAdjustment(J)J", (offset: bigint) => {
  const adjustment = BigInt(Math.round(wallMillis() * 1e6)) - offset * 1_000_000_000n;
  return adjustment > MAX_NANO_ADJUSTMENT || adjustment < -MAX_NANO_ADJUSTMENT ? -1n : adjustment;
});
const MAX_NANO_ADJUSTMENT = (1n << 32n) * 1_000_000_000n;

// there is no process to fork: exec fails as for a program that is not there, and ProcessBuilder
// names the program
rt.registerJnis("java/lang/UNIXProcess", {
  "initIDs()V": () => {},
  "forkAndExec([B[BI[BI[B[IZ)I": () => { throw rt.mkThrowable("java/io/IOException", "error=2, No such file or directory"); },
});
rt.registerJnis("java/lang/Runtime", {
  "nativeLoad(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Class;)Ljava/lang/String;": nativeLoad,
  "nativeGc()V": () => {},
  "maxMemory()J": () => BigInt(HEAP_LIMIT),
  "totalMemory()J": () => 268435456n,
  "freeMemory()J": () => 134217728n,
});

/** the native tier releases a finished thread's Cpu and stack through this */
export const threadExit = { hook: null as ((t: JThread) => void) | null };
const liveThreads = new Set<JThread>();
procTasks.tids = () => [...new Set([procIdentity.pid, ...[...liveThreads].map((t) => processTid(t, t === mainThread))])];
const taskOf = (tid: number) => { for (const t of liveThreads) if (processTid(t, t === mainThread) === tid) return t; return null; };
procTasks.name = (tid) => taskOf(tid)?.jname ?? null;
procTasks.rename = (tid, name) => { const t = taskOf(tid); if (t) t.jname = name; return !!t; };
export class JThread extends JObj {
  jname = "Thread";
  /** the fields libcore reaches in a Thread, by name or Unsafe offset: ThreadLocalRandom's state and
   *  ThreadLocal's maps */
  threadLocalRandomSeed = 0n; threadLocalRandomProbe = 0; threadLocalRandomSecondarySeed = 0;
  threadLocals: unknown = null; inheritableThreadLocals: unknown = null; inheritedAccessControlContext: unknown = null;
  /** LockSupport's blocker, and the id it reads through Unsafe as getId reports it */
  parkBlocker: unknown = null;
  /** the Interruptible of the channel operation blocking this thread (Thread.blockedOn) */
  blocker: unknown = null;
  get tid(): bigint { return BigInt(idHash(this)); }
  daemon = 0;
  private live = 0;
  /** Thread.started, which Runtime.addShutdownHook reads */
  started = 0;
  parked = 0;
  get alive() { return this.live; }
  set alive(value: number) { this.live = value; if (value) { this.started = 1; liveThreads.add(this); } else liveThreads.delete(this); }
  prio = 5;
  target: unknown = null;   // Runnable
  ueh: unknown = null;      // Thread.UncaughtExceptionHandler
  interrupted = 0;
  wake: (() => void) | null = null;
  /** LockSupport: a permit delivered while not parked, or the wake of a park in progress */
  permit = false;
  unpark: (() => void) | null = null;
  done: Promise<void> | null = null;
  /** the thread's native Looper (android/mainloop), once it has prepared one */
  looper: unknown = null;
  /** the ThreadGroup a Java constructor named; null is the main group */
  group: unknown = null;
}
export let curThread: JThread = null as never;
export const mainThread = curThread = new JThread();
mainThread.jname = "main";
mainThread.alive = 1;
rt.th = () => curThread;
rt.st = (t) => setCurThread(t as JThread);
rt.su = releaseThread;
class JDefaultUEH extends JObj {}
rt.register({
  name: "webdroid/DefaultUEH", ctor: JDefaultUEH, ifaces: ["java/lang/Thread$UncaughtExceptionHandler"],
  methods: {
    // AOSP's LoggingHandler prints the whole trace; the "Caused by" chain is what names the real
    // fault, and the JS stack locates one a native raised
    "uncaughtException(Ljava/lang/Thread;Ljava/lang/Throwable;)V": driven(function* (_t: unknown, e: unknown): Gen {
      if (e instanceof JThrowable) console.error("[uncaughtException]", yield* awaited(stackTraceText(e)), "\n" + e.jsStack);
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
/** run as `t` from here: the code that follows owns the turn as that thread */
export function setCurThread(t: JThread) {
  owned = true;
  if (t === curThread) return;
  curThread = t;
  threadSwitch.hook?.(t);
}
let threadCounter = 0;
const nextThreadName = () => "Thread-" + threadCounter++;
function initGroupedThread(this: JThread, group: unknown, target: unknown, name: string) { this.group = group ?? curThread.group; this.target = target; this.jname = name; }
/** the ThreadGroup ART makes at startup, libcore's ThreadGroup.mainThreadGroup */
function mainThreadGroup(): unknown {
  const info = rt.link("java/lang/ThreadGroup");
  return after(rt.initClass(info), () => info.ctor[mangleStaticField("mainThreadGroup")]);
}
/** a Thread constructor that, as Thread.init does, starts the thread with a copy of its creator's
 *  inheritable thread locals (libcore's ThreadLocal keeps them in the thread's fields) */
function inheriting(init: (this: JThread, ...a: any[]) => void) {
  return function (this: JThread, ...a: unknown[]) {
    init.apply(this, a);
    const parent = curThread.inheritableThreadLocals;
    if (parent === null) return;
    return after(scall("java/lang/ThreadLocal", "createInheritedMap", "(Ljava/lang/ThreadLocal$ThreadLocalMap;)Ljava/lang/ThreadLocal$ThreadLocalMap;", parent),
      (m: unknown) => { this.inheritableThreadLocals = m; });
  };
}
// §4.7: ThreadLocal.get and set when the value sits in the entry its hash names, in the thread's own
// map (getMap not overridden, as InheritableThreadLocal does); every other case is libcore's
{
  const TL = "java/lang/ThreadLocal", MAP = "java/lang/ThreadLocal$ThreadLocalMap";
  let proto: Record<string, unknown> | undefined;
  const compile = intrinsicCompiler({ hash: mangleField(TL, "threadLocalHashCode"), table: mangleField(MAP, "table"),
    value: mangleField(MAP + "$Entry", "value"), getMap: mangleMethod("getMap", "(Ljava/lang/Thread;)Ljava/lang/ThreadLocal$ThreadLocalMap;") },
  { R: rt, proto: () => proto ??= rt.link(TL).ctor.prototype });
  const entry = (params: string, hit: string) => compile(params, `
    const map = this.$getMap === proto().$getMap ? R.th().threadLocals : null;
    if (map !== null) {
      const table = map.$table, e = table[this.$hash & (table.length - 1)];
      if (e !== null && e.wr !== null && e.wr.deref() === this) ${hit}
    }
    return base.call(this${params ? ", " + params : ""});`);
  rt.intrinsic(TL, { "get()Ljava/lang/Object;": entry("", "return e.$value;"), "set(Ljava/lang/Object;)V": entry("v", "{ e.$value = v; return; }") });
}

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

/** Thread.start's body, the thread in its group */
function startThread(t: JThread): void {
  t.alive = 1;
  // the body begins now, not after the caller's whole main-looper job: a thread that
  // publishes its Handler has it by the time the next lifecycle call posts to it
  t.done = new Promise((resolve) => {
    queueMicrotask(async () => {
      try { await vcallOn(t, t, "run", "()V"); }
      catch (e) { await dispatchUncaught(t, e); }
      finally {
        t.alive = 0;
        try { await vcallOn(t, t.group, "threadTerminated", "(Ljava/lang/Thread;)V", t); } catch (e) { reportUncaught(e); }
        threadExit.hook?.(t);
        resolve();
      }
    });
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
  fields: ["threadLocalRandomSeed", "threadLocalRandomProbe", "threadLocalRandomSecondarySeed", "threadLocals", "inheritableThreadLocals",
    "inheritedAccessControlContext", "parkBlocker", "tid", "started"],
  methods: {
    "<init>()V": inheriting(function () { this.jname = nextThreadName(); }),
    "<init>(Ljava/lang/Runnable;)V": inheriting(function (r: unknown) { this.target = r; this.jname = nextThreadName(); }),
    "<init>(Ljava/lang/Runnable;Ljava/lang/String;)V": inheriting(function (r: unknown, n: string) { this.target = r; this.jname = n; }),
    "<init>(Ljava/lang/String;)V": inheriting(function (n: string) { this.jname = n; }),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;)V": inheriting(initGroupedThread),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/Runnable;Ljava/lang/String;J)V": inheriting(initGroupedThread),
    "<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V": inheriting(function (g: unknown, n: string) { this.group = g ?? curThread.group; this.jname = n; }),
    "getName()Ljava/lang/String;": function (this: JThread) { return this.jname; },
    "setName(Ljava/lang/String;)V": function (this: JThread, n: string) { this.jname = n; },
    "setDaemon(Z)V": function (this: JThread, d: number) { this.daemon = d; },
    "isDaemon()Z": function (this: JThread) { return this.daemon; },
    "setPriority(I)V": function (this: JThread, p: number) { this.prio = p; },
    "getPriority()I": function (this: JThread) { return this.prio; },
    "isAlive()Z": function (this: JThread) { return this.alive; },
    "getState()Ljava/lang/Thread$State;": function (this: JThread) {
      const state = THREAD_STATES[!this.started ? 0 : !this.alive ? 5 : rt.monitors.isBlocked(this) ? 2 : this.parked || 1];
      const info = rt.link("java/lang/Thread$State");
      return after(rt.initClass(info), () => info.ctor[mangleStaticField(state)]);
    },
    "getId()J": function (this: JThread) { return BigInt(idHash(this)); },
    "isInterrupted()Z": function (this: JThread) { return this.interrupted; },
    // an interruptible channel operation blocked here is closed by its Interruptible, as libcore's Thread does
    "interrupt()V": function (this: JThread) {
      this.interrupted = 1; this.wake?.();
      return this.blocker ? vcall(this.blocker, "interrupt", "(Ljava/lang/Thread;)V", this) : undefined;
    },
    "blockedOn(Lsun/nio/ch/Interruptible;)V": function (this: JThread, b: unknown) { this.blocker = b; },
    "start()V": function (this: JThread) {
      if (this.started) throw rt.mkThrowable("java/lang/IllegalThreadStateException", "Thread already started");
      return after(this.group ?? mainThreadGroup(), (group) => after(vcall(group, "addUnstarted", "()V"), () => after(vcall(group, "add", "(Ljava/lang/Thread;)V", this), () => {
        this.group = group;
        startThread(this);
      })));
    },
    "run()V": driven(function* (this: JThread): Gen {
      if (this.target) yield vcall(this.target, "run", "()V");
    }),
    "join()V": function (this: JThread) { return join(this, 0); },
    "join(J)V": function (this: JThread, ms: bigint) { return join(this, Number(ms)); },
    "join(JI)V": function (this: JThread, ms: bigint, ns: number) { return join(this, Number(ms) + (ns > 0 ? 1 : 0)); },
    // a thread that has ended has no group
    "getThreadGroup()Ljava/lang/ThreadGroup;": function (this: JThread) { return this.started && !this.alive ? null : this.group ?? mainThreadGroup(); },
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
    "static sleep(JI)V": (ms: bigint, nanos: number) => {
      if (ms < 0n || nanos < 0 || nanos > 999999) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout value is negative or nanos out of range");
      return park(curThread, () => () => {}, Number(ms) + nanos / 1e6);
    },
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
const ENUM_NAME = mangleField("java/lang/Enum", "name"), ENUM_ORDINAL = mangleField("java/lang/Enum", "ordinal");
// §4.7: compareTo within one enum class, and valueOf over the constants getSharedConstants shares
// (AOSP asks getClass and getDeclaringClass of both, and an LRU cache under a lock, per call)
const sharedEnums = new WeakMap<object, Record<string, unknown>[]>();
rt.intrinsic("java/lang/Enum", {
  "compareTo(Ljava/lang/Enum;)I": (base) => function (this: Record<string, number>, o: Record<string, number>) {
    return o !== null && o.constructor === this.constructor ? this[ENUM_ORDINAL] - o[ENUM_ORDINAL] : base.call(this, o);
  },
  "static getSharedConstants(Ljava/lang/Class;)[Ljava/lang/Enum;": (base) => (cls: JClass | null) =>
    (cls !== null && sharedEnums.get(cls)) || after(base(cls), (values: Record<string, unknown>[] | null) => { if (cls !== null && values !== null) sharedEnums.set(cls, values); return values; }),
  "static valueOf(Ljava/lang/Class;Ljava/lang/String;)Ljava/lang/Enum;": (base) => (cls: JClass | null, name: string | null) => {
    const values = cls !== null && name !== null ? sharedEnums.get(cls) : undefined;
    if (values) for (const e of values) if (e[ENUM_NAME] === name) return e;
    return base(cls, name);
  },
});
const THREAD_STATES = ["NEW", "RUNNABLE", "BLOCKED", "WAITING", "TIMED_WAITING", "TERMINATED"];
/** debug: each live thread as Thread.getState reads it, with the object it parked on
 *  (wd.threads; the e2e harness records it when a step's phase hangs) */
export const threadStates = (): { name: string; state: string; blocker?: string }[] => [...liveThreads].map((t) => ({
  name: t.jname, state: THREAD_STATES[rt.monitors.isBlocked(t) ? 2 : t.parked || 1],
  blocker: (t.parkBlocker as { constructor?: { $i?: ClassInfo } } | null)?.constructor?.$i?.name,
}));

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
// Reference.refersTo(obj): whether the referent is obj, without making a weak referent strong
rt.registerJni("java/lang/ref/Reference", "refersTo0(Ljava/lang/Object;)Z", function (this: JRef, o: unknown) {
  return +((this instanceof JWeakRef ? this.wr?.deref() ?? this.referent : this.referent) === o);
});
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
