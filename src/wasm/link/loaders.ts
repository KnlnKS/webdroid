// Class loaders. A java.lang.ClassLoader that opens dex files (libcore's BaseDexClassLoader, over the DexFile natives below) is a namespace of the Program
// (compiler/program.ts): the classes its dex files define and its parent does not are its own, with their own ids, statics and Class objects, and the dex files
// see the classes through it. The boot loader, the app's own class loader and a loader that opens dex files the Program already holds stand for the default
// namespace. Class.forName, VMClassLoader.findLoadedClass and Class.getClassLoader answer from it.
import { T } from "../compiler/wasmbin";
import type { Code } from "../compiler/code";
import type { Compiler, Intrinsic } from "../compiler/j2w";
import type { Loader } from "../compiler/program";
import { dexesIn, type DexFile } from "../../jvm/dex";
import type { World } from "./world";
import { prepareDefinition, resolvedMirror } from "./resolution";
import { emitRestored } from "./sched";

/** how host.classByName reads its scope: the loader whose view of the names is asked for, the loader whose own classes are asked for, or the dex files of a cookie */
export const enum Lookup { Visible, Defined, Cookie, ForName }
/** the kind of host.obj that answers the ClassLoader object of a class id */
export const LOADER_OF_CLASS = 100;

interface State {
  byObject: WeakMap<object, Loader>;
  cookies: Map<string, { loader: Loader; dexes: DexFile[] }>;
  parentOf: (loader: object) => object | null;
  libraries: WeakMap<object, [Loader[], Loader[]]>;
  copies: WeakMap<object, Map<DexFile, DexFile>>;
  /** the ClassLoader object that opened the app's own dex files, which the classes of the default namespace that the app defines answer to getClassLoader */
  appLoader: object | null;
}
const states = new WeakMap<World, State>();
function stateOf(w: World): State {
  let s = states.get(w);
  if (!s) states.set(w, s = { byObject: new WeakMap(), cookies: new Map(), parentOf: w.fieldReader<object | null>("java/lang/ClassLoader", "parent", "Ljava/lang/ClassLoader;"), libraries: new WeakMap(), copies: new WeakMap(), appLoader: null });
  return s;
}

/** the namespace a ClassLoader object sees: its own if it opened dex files, else its nearest ancestor's, else the default one */
function loaderFor(w: World, obj: object | null): Loader {
  const s = stateOf(w);
  for (let o = obj; o; o = s.parentOf(o)) { const l = s.byObject.get(o); if (l) return l; }
  return w.prog.boot;
}

/** Parent-first resolution uses the nearest defining ancestor. Custom loadClass overrides need dynamic resolution; their class kind does not specify delegation order. */
function newLoader(w: World, parent: object | null, loader: object): Loader {
  const s = stateOf(w);
  for (let o = parent; o; o = s.parentOf(o)) {
    const ancestor = s.byObject.get(o);
    if (ancestor) return w.prog.newLoader(ancestor, loader);
  }
  return w.prog.newLoader(w.prog.boot, loader);
}

/** Native class generation defines in the supplied loader even when it has never opened dex files. */
export function definingLoader(w: World, object: object | null): Loader {
  if (!object) return w.prog.boot;
  const s = stateOf(w);
  let loader = s.byObject.get(object);
  if (!loader) { loader = newLoader(w, s.parentOf(object), object); s.byObject.set(object, loader); }
  return loader;
}

export function recordDefinedClass(w: World, loader: Loader, name: string, key: string): void {
  w.initiateClass(loader, name, key);
}

export function objectOfLoader(w: World, loader: Loader): object | null {
  return loader.object ?? (loader === w.prog.root ? states.get(w)?.appLoader ?? null : null);
}

function librariesOf(w: World, object: object): [Loader[], Loader[]] {
  const s = stateOf(w), prior = s.libraries.get(object);
  if (prior) return prior;
  const mark = w.bridge.begin();
  try {
    const read = (name: string): Loader[] => {
      const array = w.fieldReader<object | null>("dalvik/system/BaseDexClassLoader", name, "[Ljava/lang/ClassLoader;")(object);
      const values = array ? w.bridge.toHost(array, "[Ljava/lang/ClassLoader;") as unknown[] : [];
      return values.map(value => loaderFor(w, w.bridge.toJava(value, "Ljava/lang/ClassLoader;") as object));
    };
    const graph: [Loader[], Loader[]] = [read("sharedLibraryLoaders"), read("sharedLibraryLoadersAfter")];
    s.libraries.set(object, graph);
    return graph;
  } finally { w.bridge.end(mark); }
}

/** host.classByName(name, scope, mode): the id of the class a binary name ("a.B$C", "[La.B;") stands for in the scope, or 0 */
export function classByName(w: World, name: string, scope: unknown, mode: Lookup): number | Promise<object> {
  const n = name.replace(/\./g, "/");
  if (n === "" || n.includes("@")) return 0;
  const prog = w.prog, s = stateOf(w), cookie = mode === Lookup.Cookie ? s.cookies.get(w.hostString(scope) as string) : undefined;
  const loader = mode === Lookup.Cookie ? cookie?.loader : loaderFor(w, scope as object | null);
  if (!loader) return 0;
  const find = (cls: string): string | undefined => {
    if (mode === Lookup.Defined) return prog.initiatedBy(loader, cls);
    const key = mode === Lookup.Visible ? prog.lookup(loader, cls) : prog.definedBy(loader, cls);
    if (key === undefined || cookie && !cookie.dexes.includes(prog.get(key)!.dex!)) return undefined;
    w.initiateClass(loader, cls, key);
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
  const s = stateOf(w), file = w.hostString(path) as string;
  if (!w.opts.dexes) {
    w.onGap(w.gapId("DexFile.openDexFileNative: the host has no dex files to open"));
    throw w.exception(w.makeThrowable("java/lang/UnsatisfiedLinkError", "dalvik.system.DexFile.openDexFileNative"));
  }
  const dexes = w.opts.dexes(file);
  return dexes instanceof Promise ? dexes.then(open) : open(dexes);
  function open(dexes: DexFile[] | undefined): object {
    if (!dexes) throw w.exception(w.makeThrowable("java/io/IOException", `Unable to open DEX file '${file}'`));
    // dex files the Program holds already stay in their namespace, and a loader that opens only those is that namespace
    let loader = loaderObject ? s.byObject.get(loaderObject) : w.prog.root;
    if (!loader) {
      const ownApp = !s.appLoader && dexes.some(d => w.prog.loaderOfDex(d) === w.prog.root);
      loader = ownApp ? w.prog.root : newLoader(w, s.parentOf(loaderObject!), loaderObject!);
      s.byObject.set(loaderObject!, loader);
    }
    if (loaderObject && loader === w.prog.root) s.appLoader ??= loaderObject;
    if (loaderObject) {
      const [before, after] = librariesOf(w, loaderObject);
      w.bindLibraries(loader, before, after);
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
    const id = `dex:${s.cookies.size}`;
    s.cookies.set(id, { loader, dexes });
    return w.javaString(id) as object;
  }
}

/** host.obj(LOADER_OF_CLASS, id): the ClassLoader object of the loader that defines class `id`, or null for the boot loader and the platform's classes */
export function loaderObject(w: World, id: number): object | null {
  return objectOfLoader(w, w.prog.loaderOf(w.nameOf(id)));
}

export const loaderIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => loaderIntrinsics.set(key, (cx, m, c) => f(cx, c));

def("dalvik/system/DexFile.openDexFileNative(Ljava/lang/String;Ljava/lang/String;ILjava/lang/ClassLoader;[Ldalvik/system/DexPathList$Element;)Ljava/lang/Object;", (cx, c) => {
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  const wait = cx.global("rt", "wait", T.i32, true);
  emitRestored(cx, c, [], [T.anyref], () => {
    c.lget(0); cx.str.toHost(c); c.lget(3).externConvertAny(); c.call(cx.imp.dexOpen);
    c.gget(wait).ifType(cx.mb.addFuncType([T.externref], [T.externref]));
    c.drop().i32(0).gset(wait).call(cx.imp.annotationWait);
    c.end().anyConvertExtern();
  });
});
// the classes of an opened dex are in the Program already: defining one is finding it among the cookie's
def("dalvik/system/DexFile.defineClassNative(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Object;Ldalvik/system/DexFile;)Ljava/lang/Class;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  const wait = cx.global("rt", "wait", T.i32, true);
  emitRestored(cx, c, [], [T.anyref], () => {
    c.lget(0); cx.str.toHost(c); c.lget(2).externConvertAny(); c.i32(Lookup.Cookie); c.call(cx.imp.classByName).lset(id);
    c.gget(wait).if_(T.anyref).i32(0).gset(wait).call(cx.imp.annotationWait).anyConvertExtern();
    c.else_().lget(id).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end().end();
  });
});
// classes are never unloaded, so a closed dex is still in use
def("dalvik/system/DexFile.closeDexFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// a dex opened here is read from its file: no oat file stands behind it
def("dalvik/system/DexFile.isBackedByOatFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// classes are not verified here, in the background or otherwise
def("dalvik/system/DexFile.verifyInBackgroundNative(Ljava/lang/Object;Ljava/lang/ClassLoader;)V", () => {});
