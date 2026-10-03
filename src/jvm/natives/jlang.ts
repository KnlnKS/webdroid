// java.lang.* natives: Object, Class, ClassLoader, System, Runtime, Enum and references. String
// (jstring.ts), Throwable (jthrowable.ts) and Thread (jthread.ts) have their own modules, and
// host code's calls into Java are jentry.ts's. Java booleans are 0/1 numbers, longs are BigInt.

import { awaited, rt, JObj, HEAP_LIMIT, type ClassInfo, type NativeSpec, type Runtime, driven, type Gen } from "../runtime";
import { mangleMethod, mangleField, mangleStaticField, descToName, jarray, PRIM_NAME, PRIM_DESC, dotName, slashName, PRIM_ARRAYS, i8, splitSig, idHash } from "../abi";
import { uptimeMillis, wallMillis } from "../../guest-clock";
import { vfs, apkPath } from "../../shell/vfs";
import { processEnv } from "../../shell/environment";
import { after, curThread, newObj, scall, vcall, type JThread } from "./jentry";
import { shareable } from "../suspend";
import { JThrowable } from "./jthrowable";
import { park } from "./jthread";
// String and its builders, java.lang's natives with these
import "./jstring";

/** the class name of a Java value: a string's, or its class's */
export function jclsName(o: unknown): string {
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

export function classDesc(c: JClass | null): string {
  if (c?.primName) return PRIM_DESC[c.primName] ?? "I";
  if (c?.arrDesc) return c.arrDesc;
  return c?.ci ? "L" + c.ci.name + ";" : "Ljava/lang/Object;";
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
/** libcore's Package for `name`, one per name as a class loader keeps them */
export function packageNamed(name: string): unknown {
  return packages.get(name) ?? after(newObj("java/lang/Package", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/net/URL;Ljava/lang/ClassLoader;)V",
    name, null, null, null, null, null, null, null, null), (p) => { if (!packages.has(name)) packages.set(name, p); return packages.get(name); });
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

/** Objects.checkFromIndexSize: [off, off + len) must lie within [0, length) */
export function checkFromIndexSize(off: number, len: number, length: number, cls = "java/lang/IndexOutOfBoundsException"): void {
  if (off < 0 || len < 0 || off > length - len) throw rt.mkThrowable(cls, null);
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
const E_MACHINE: Record<number, string> = { 0xb7: "arm64-v8a", 0x28: "armeabi-v7a", 0x3e: "x86_64", 0x03: "x86" };
/** Runtime.nativeLoad: `file` is a path (ClassLoader.findLibrary's, System.load's) or a bare name
 *  from the loader's class path; null once the library is loaded, else the linker's error */
function nativeLoad(file: string, loader: JClassLoader | null): string | null | Promise<string | null> {
  const owner = loader?.runtime ?? rt, lib = file.slice(file.lastIndexOf("/") + 1);
  if (owner.nativeLibs.has(lib.replace(/^lib|\.so$/g, ""))) return null;
  const have = loadedLibs.get(lib);
  if (have) return have.owner !== owner ? `Library ${lib} already loaded by another ClassLoader` : have.thread === curThread ? null : have.pending;
  const thread = curThread;
  // driven: each step continues on the asking thread and chain (a <clinit>'s, when it loads its library)
  const pending = shareable(rt.drive(function* (): Gen<string | null> {
    let abi: string | null, bytes: Uint8Array | null;
    if (file.startsWith("/")) {
      bytes = yield vfs.readFile(file);
      abi = bytes && (E_MACHINE[bytes[18] | (bytes[19] << 8)] ?? "unknown");
    } else {
      abi = pickAbi((a) => owner.hasClasspath(`lib/${a}/${lib}`));
      bytes = abi ? yield owner.readClasspath(`lib/${abi}/${lib}`) : null;
    }
    if (abi && bytes && owner.loadNativeLib) {
      try { yield owner.loadNativeLib(lib, bytes, abi, owner); return null; }
      catch (e) {
        rt.noteNativeRequired(lib, abi);
        if (e instanceof rt.link("java/lang/UnsatisfiedLinkError").ctor) return (e as JThrowable).msg;
        throw e;
      }
    }
    if (abi) rt.noteNativeRequired(lib, abi);
    return `dlopen failed: library "${lib}" ${abi ? "is " + abi + " machine code" : "not found"}`;
  }()));
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

// there is no second process: the fork fails as native code's does (EAGAIN), in UNIXProcess_md.c's
// words, and ProcessBuilder names the program
rt.registerJnis("java/lang/UNIXProcess", {
  "initIDs()V": () => {},
  "forkAndExec([B[BI[BI[B[IZ)I": () => { throw rt.mkThrowable("java/io/IOException", "error=11, Try again"); },
});
rt.registerJnis("java/lang/Runtime", {
  "nativeLoad(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Class;)Ljava/lang/String;": nativeLoad,
  "nativeGc()V": () => {},
  "maxMemory()J": () => BigInt(HEAP_LIMIT),
  "totalMemory()J": () => 268435456n,
  "freeMemory()J": () => 134217728n,
});

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
