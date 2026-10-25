// Class loaders. A java.lang.ClassLoader that opens dex files (libcore's BaseDexClassLoader, over the DexFile natives below) is a namespace of the Program
// (compiler/program.ts): the classes its dex files define and its parent does not are its own, with their own ids, statics and Class objects, and the dex files
// see the classes through it. The boot loader, the app's own class loader and a loader that opens dex files the Program already holds stand for the default
// namespace. Class.forName, VMClassLoader.findLoadedClass and Class.getClassLoader answer from it.
import { T } from "../compiler/wasmbin.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { Loader } from "../compiler/program.ts";
import { dexesIn, type DexFile } from "../../jvm/dex.ts";
import type { World } from "./world.ts";
import { PerWorld } from "./perworld.ts";
import { prepareDefinition, resolvedMirror } from "./resolution.ts";
import { chain } from "./maybe.ts";
import { emitRestored, emitSettled } from "../compiler/hostcalls.ts";

/** after host.classByName set local `id`: the Class it named (null for 0), or the settled answer of a lookup that parked */
export function emitClassAnswer(cx: Compiler, c: Code, id: number): void {
  const wait = cx.global("rt", "wait", T.i32, true);
  c.gget(wait).if_(T.anyref).i32(0).gset(wait).call(cx.imp.annotationWait).anyConvertExtern();
  c.else_().lget(id).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end().end();
}

/** how host.classByName reads its scope: the loader whose view of the names is asked for, the loader whose own classes are asked for, or the dex files of a cookie */
export const Lookup = { Visible: 0, Defined: 1, Cookie: 2, ForName: 3 } as const;
/** the kind of host.obj that answers the ClassLoader object of a class id */
export const LOADER_OF_CLASS = 100;

interface State {
  byObject: WeakMap<object, Loader>;
  cookies: WeakMap<object, { loader: Loader; dexes: DexFile[] }>;
  nextDexHandle: bigint;
  parentOf: (loader: object) => object | null;
  libraries: WeakMap<object, [Loader[], Loader[]]>;
  copies: WeakMap<object, Map<DexFile, DexFile>>;
  /** the ClassLoader object that opened the app's own dex files, which the classes of the default namespace that the app defines answer to getClassLoader */
  appLoader: object | null;
}
const states = new PerWorld((w): State => ({
  byObject: new WeakMap(), cookies: new WeakMap(), nextDexHandle: 1n, libraries: new WeakMap(), copies: new WeakMap(), appLoader: null,
  parentOf: w.helpers.fieldReader<object | null>("java/lang/ClassLoader", "parent", "Ljava/lang/ClassLoader;"),
}));

/** the namespace a ClassLoader object sees: its own if it opened dex files, else its nearest ancestor's, else the default one */
function loaderFor(w: World, obj: object | null): Loader {
  const s = states.get(w);
  for (let o = obj; o; o = s.parentOf(o)) { const l = s.byObject.get(o); if (l) return l; }
  return w.prog.boot;
}

/** Parent-first resolution uses the nearest defining ancestor. Custom loadClass overrides need dynamic resolution; their class kind does not specify delegation
 *  order. A loader resolves its own classes first, after the boot classes, when it is the platform's DelegateLastClassLoader, or when an ancestor below its
 *  nearest defining one is a ClassLoader of the app's, which decides in Java what it hands down (an isolating loader usually hands down little): Java's
 *  resolutions correct either guess as they happen, and each correction re-resolves the loader's dex files. */
function newLoader(w: World, parent: object | null, loader: object): Loader {
  const s = states.get(w), platform = (o: object) => { const cls = w.classNameOf(o); return w.prog.loaderOf(cls) === w.prog.boot ? cls : undefined; };
  let ownFirst = platform(loader) === "dalvik/system/DelegateLastClassLoader";
  for (let o = parent; o; o = s.parentOf(o)) {
    const ancestor = s.byObject.get(o);
    if (ancestor) return w.prog.newLoader(ancestor, loader, ownFirst);
    ownFirst ||= !platform(o);
  }
  return w.prog.newLoader(w.prog.boot, loader, ownFirst);
}

/** Native class generation defines in the supplied loader even when it has never opened dex files. */
export function definingLoader(w: World, object: object | null): Loader {
  if (!object) return w.prog.boot;
  const s = states.get(w);
  let loader = s.byObject.get(object);
  if (!loader) { loader = newLoader(w, s.parentOf(object), object); s.byObject.set(object, loader); }
  return loader;
}

export function objectOfLoader(w: World, loader: Loader): object | null {
  return loader.object ?? (loader === w.prog.root ? states.peek(w)?.appLoader ?? null : null);
}

const PATH_LOADERS = new Set(["dalvik/system/PathClassLoader", "dalvik/system/DexClassLoader", "dalvik/system/InMemoryDexClassLoader"]);

/** whether a loader resolves names as the Program models it, which nativeClassLookup proves for ART: a platform path loader directly over the boot loader, whose shared libraries are too */
function standardPath(w: World, object: object, seen = new Set<object>()): boolean {
  if (seen.has(object)) return false;
  seen.add(object);
  const cls = w.classNameOf(object), parent = states.get(w).parentOf(object);
  if (!PATH_LOADERS.has(cls) || w.prog.loaderOf(cls) !== w.prog.boot || parent && w.classNameOf(parent) !== "java/lang/BootClassLoader") return false;
  const [before, after] = librariesOf(w, object);
  return [...before, ...after].every(l => l !== w.prog.boot && !!l.object && standardPath(w, l.object, seen));
}

/** ART searches exact platform loader chains natively before invoking Java loadClass. */
export function nativeClassLookup(w: World, loader: Loader, name: string): string | undefined {
  const s = states.peek(w);
  if (!s) return;
  const boot = w.prog.lookup(w.prog.boot, name), descriptor = `L${name};`, active = new Set<object>();
  // False delegates an unprovable path to Java; undefined is a proven miss.
  const find = (object: object | null): string | undefined | false => {
    if (!object) return boot;
    if (active.has(object)) return false;
    const cls = w.classNameOf(object);
    if (w.prog.loaderOf(cls) !== w.prog.boot) return false;
    if (cls === "java/lang/BootClassLoader") return boot;
    if (!PATH_LOADERS.has(cls)) return false;
    const current = s.byObject.get(object), loaded = current && w.prog.initiatedBy(current, name);
    if (loaded) return loaded;
    active.add(object);
    const libraries = (field: string): string | undefined | false => {
      const array = w.helpers.fieldReader<object | null>("dalvik/system/BaseDexClassLoader", field, "[Ljava/lang/ClassLoader;")(object);
      for (let i = 0; array && i < w.bridge.arrayLength(array); i++) {
        const key = find(w.bridge.element(array, i) as object | null);
        if (key !== undefined) return key;
      }
    };
    try {
      let key = find(s.parentOf(object));
      if (key !== undefined) return key;
      key = libraries("sharedLibraryLoaders");
      if (key !== undefined) return key;
      const path = w.helpers.fieldReader<object | null>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(object);
      const elements = path && w.helpers.fieldReader<object | null>("dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;")(path);
      for (let i = 0; elements && i < w.bridge.arrayLength(elements); i++) {
        const element = w.bridge.element(elements, i) as object | null;
        const file = element && w.helpers.fieldReader<object | null>("dalvik/system/DexPathList$Element", "dexFile", "Ldalvik/system/DexFile;")(element);
        const cookie = file && w.helpers.fieldReader<object | null>("dalvik/system/DexFile", "mCookie", "Ljava/lang/Object;")(file);
        if (!cookie) continue;
        const opened = s.cookies.get(cookie);
        if (!current || opened?.loader !== current) return false;
        for (const dex of opened.dexes) {
          if (dex.findClassDef(descriptor) === undefined) continue;
          const defined = w.prog.definedBy(current, name);
          // A live path can be reordered after Program retained its first definition.
          return defined && w.prog.get(defined)?.dex === dex ? defined : false;
        }
      }
      return libraries("sharedLibraryLoadersAfter");
    } finally { active.delete(object); }
  };
  const found = find(objectOfLoader(w, loader));
  return typeof found === "string" ? found : undefined;
}

function librariesOf(w: World, object: object): [Loader[], Loader[]] {
  const s = states.get(w), prior = s.libraries.get(object);
  if (prior) return prior;
  const mark = w.bridge.begin();
  try {
    const read = (name: string): Loader[] => {
      const array = w.helpers.fieldReader<object | null>("dalvik/system/BaseDexClassLoader", name, "[Ljava/lang/ClassLoader;")(object);
      const values = array ? w.bridge.toHost(array, "[Ljava/lang/ClassLoader;") as unknown[] : [];
      return values.map(value => loaderFor(w, w.bridge.toJava(value, "Ljava/lang/ClassLoader;") as object));
    };
    const graph: [Loader[], Loader[]] = [read("sharedLibraryLoaders"), read("sharedLibraryLoadersAfter")];
    s.libraries.set(object, graph);
    return graph;
  } finally { w.bridge.end(mark); }
}

/** host.classByName(name, scope, mode): the id of the class a binary name ("a.B$C", "[La.B;") stands for in the scope, or 0 */
export function classByName(w: World, name: string, scope: unknown, mode: number): number | Promise<object> {
  const n = name.replace(/\./g, "/");
  if (n === "" || n.includes("@")) return 0;
  const prog = w.prog, s = states.get(w), cookie = mode === Lookup.Cookie ? s.cookies.get(scope as object) : undefined;
  const object = scope as object | null;
  const loader = mode === Lookup.Cookie ? cookie?.loader : mode === Lookup.Defined ? definingLoader(w, object) : loaderFor(w, object);
  if (!loader) return 0;
  const find = (cls: string): string | undefined => {
    const key = mode === Lookup.Defined ? prog.initiatedBy(loader, cls) ?? (object ? nativeClassLookup(w, loader, cls) : undefined)
      : mode === Lookup.Visible ? prog.lookup(loader, cls) : prog.definedBy(loader, cls);
    if (key === undefined || cookie && !cookie.dexes.includes(prog.get(key)!.dex!)) return undefined;
    w.namespaces.initiateClass(loader, cls, key);
    return key;
  };
  const e = n.replace(/^\[+/, "");
  if (e === n) {
    const key = find(n);
    if (key === undefined) return 0;
    const owner = w.sched.current(), prepared = prepareDefinition(w, key, owner);
    return prepared instanceof Promise ? prepared.then(key => resolvedMirror(w, key, owner)) : w.idOf(key);
  }
  const element = /^L(.+);$/.exec(e), key = element ? find(element[1]) : /^[ZBCSIJFD]$/.test(e) ? "" : undefined;
  if (key === undefined) return 0;
  if (key === "") return w.idOf(n);
  const owner = w.sched.current(), prepared = prepareDefinition(w, key, owner);
  const array = (component: string) => `${n.slice(0, n.length - e.length)}L${component};`;
  return prepared instanceof Promise ? prepared.then(component => resolvedMirror(w, array(component), owner)) : w.idOf(array(key));
}

/** host.dexOpen(path, loader): the cookie of the dex files at `path`, whose classes are defined in the namespace of the ClassLoader object `loader` */
export function dexOpen(w: World, path: unknown, loaderObject: object | null): object | Promise<object> {
  const file = w.hostString(path) as string;
  if (!w.opts.dexes) {
    w.onGap("DexFile.openDexFileNative: the host has no dex files to open");
    w.raise("java/lang/UnsatisfiedLinkError", "dalvik.system.DexFile.openDexFileNative");
  }
  const dexes = w.opts.dexes(file);
  return chain(dexes, open);
  function open(dexes: DexFile[] | undefined): object {
    if (!dexes) w.raise("java/io/IOException", `Unable to open DEX file '${file}'`);
    return openDexes(w, dexes, loaderObject);
  }
}

function openDexes(w: World, dexes: DexFile[], loaderObject: object | null): object {
  const s = states.get(w);
  // dex files the Program holds already stay in their namespace, and a loader that opens only those is that namespace
  let loader = loaderObject ? s.byObject.get(loaderObject) : w.prog.root;
  if (!loader) {
    const ownApp = !s.appLoader && dexes.some(d => w.prog.loaderOfDex(d) === w.prog.root);
    loader = ownApp ? w.prog.root : newLoader(w, s.parentOf(loaderObject!), loaderObject!);
    s.byObject.set(loaderObject!, loader);
  }
  const binding = !!loaderObject && loader === w.prog.root && !s.appLoader;
  if (binding) s.appLoader = loaderObject;
  if (loaderObject) {
    const [before, after] = librariesOf(w, loaderObject);
    if (binding && !standardPath(w, loaderObject)) w.namespaces.dynamicRoot();
    w.namespaces.bindLibraries(loader, before, after);
    dexes = dexes.map(d => {
      const owner = w.prog.loaderOfDex(d);
      if (!owner || owner === loader) return d;
      let copies = s.copies.get(loaderObject);
      if (!copies) s.copies.set(loaderObject, copies = new Map());
      let copy = copies.get(d);
      if (!copy) { copy = dexesIn(d.bytes, d.name).find(candidate => candidate.id === d.id)!; copies.set(d, copy); }
      return copy;
    });
  }
  const fresh = dexes.filter((d) => !w.prog.loaderOfDex(d));
  if (fresh.length) w.addDexes(fresh, loader);
  const mark = w.bridge.begin();
  try {
    // ART's long[] starts with the OAT handle; this VM uses opaque DEX handles.
    const cookie = w.bridge.toJava(BigInt64Array.from([0n, ...dexes.map(() => s.nextDexHandle++)]), "[J") as object;
    s.cookies.set(cookie, { loader, dexes });
    return cookie;
  } finally { w.bridge.end(mark); }
}

export function dexOpenMemory(w: World, buffers: object, arrays: object, starts: object, ends: object, loader: object | null): object | Promise<object> {
  const mark = w.bridge.begin(), bytes: (Uint8Array | Promise<Uint8Array>)[] = [];
  try {
    const from = w.bridge.toHost(starts, "[I") as Int32Array, to = w.bridge.toHost(ends, "[I") as Int32Array;
    for (let i = 0; i < w.bridge.arrayLength(buffers); i++) {
      const start = from[i], n = to[i] - start, array = w.bridge.element(arrays, i) as object | null;
      if (n <= 0) w.raise("java/io/IOException", "Bad range");
      if (array) {
        if (start < 0 || start > w.bridge.arrayLength(array) - n) w.raise("java/lang/ArrayIndexOutOfBoundsException", "DEX buffer range");
        const view = w.bridge.toHost(array, "[B", [start, n]) as Int8Array;
        bytes.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
      } else {
        const buffer = w.bridge.element(buffers, i) as object | null;
        if (!buffer) w.raise("java/io/IOException", "dexFileBuffer not direct");
        bytes.push(w.bridge.readBuffer(buffer, start, n));
      }
    }
  } finally { w.bridge.end(mark); }
  const open = (copies: Uint8Array[]) => {
    let dexes: DexFile[];
    try { dexes = copies.flatMap((bytes, i) => dexesIn(bytes, `memory:${i}`)); }
    catch (e) { w.raise("java/io/IOException", String(e)); }
    return openDexes(w, dexes, loader);
  };
  return bytes.some(bytes => bytes instanceof Promise) ? Promise.all(bytes).then(open) : open(bytes as Uint8Array[]);
}

/** host.obj(LOADER_OF_CLASS, id): the ClassLoader object of the loader that defines class `id`, or null for the boot loader and the platform's classes */
export function loaderObject(w: World, id: number): object | null {
  return objectOfLoader(w, w.prog.loaderOf(w.nameOf(id)));
}

export const loaderIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => loaderIntrinsics.set(key, (cx, m, c) => f(cx, c));

def("dalvik/system/DexFile.openDexFileNative(Ljava/lang/String;Ljava/lang/String;ILjava/lang/ClassLoader;[Ldalvik/system/DexPathList$Element;)Ljava/lang/Object;", (cx, c) => {
  c.lget(0); cx.nullCheck(c);
  emitRestored(cx, c, [], [T.anyref], () => {
    c.lget(0); cx.str.toHost(c); c.lget(3).externConvertAny(); c.call(cx.imp.dexOpen);
    emitSettled(cx, c);
  });
});
def("dalvik/system/DexFile.openInMemoryDexFilesNative([Ljava/nio/ByteBuffer;[[B[I[ILjava/lang/ClassLoader;[Ldalvik/system/DexPathList$Element;)Ljava/lang/Object;", (cx, c) => {
  emitRestored(cx, c, [], [T.anyref], () => {
    for (let i = 0; i < 5; i++) c.lget(i).externConvertAny();
    c.call(cx.imp.dexOpenMemory);
    emitSettled(cx, c);
  });
});
// the classes of an opened dex are in the Program already: defining one is finding it among the cookie's
def("dalvik/system/DexFile.defineClassNative(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Object;Ldalvik/system/DexFile;)Ljava/lang/Class;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(0); cx.nullCheck(c);
  emitRestored(cx, c, [], [T.anyref], () => {
    c.lget(0); cx.str.toHost(c); c.lget(2).externConvertAny(); c.i32(Lookup.Cookie); c.call(cx.imp.classByName).lset(id);
    emitClassAnswer(cx, c, id);
  });
});
// classes are never unloaded, so a closed dex is still in use
def("dalvik/system/DexFile.closeDexFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// a dex opened here is read from its file: no oat file stands behind it
def("dalvik/system/DexFile.isBackedByOatFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// classes are not verified here, in the background or otherwise
def("dalvik/system/DexFile.verifyInBackgroundNative(Ljava/lang/Object;Ljava/lang/ClassLoader;)V", () => {});
