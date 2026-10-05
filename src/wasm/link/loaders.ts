// Class loaders. A java.lang.ClassLoader that opens dex files (libcore's BaseDexClassLoader, over the DexFile natives below) is a namespace of the Program
// (compiler/program.ts): the classes its dex files define and its parent does not are its own, with their own ids, statics and Class objects, and the dex files
// see the classes through it. The boot loader, the app's own class loader and a loader that opens dex files the Program already holds stand for the default
// namespace. Class.forName, VMClassLoader.findLoadedClass and Class.getClassLoader answer from it.
import { T } from "../compiler/wasmbin";
import type { Code } from "../compiler/code";
import type { Compiler, Intrinsic } from "../compiler/j2w";
import type { Loader } from "../compiler/program";
import type { DexFile } from "../../jvm/dex";
import type { World } from "./world";

/** how host.classByName reads its scope: the loader whose view of the names is asked for, the loader whose own classes are asked for, or the dex files of a cookie */
export const enum Lookup { Visible, Defined, Cookie }
/** the kind of host.obj that answers the ClassLoader object of a class id */
export const LOADER_OF_CLASS = 100;

interface State {
  byObject: WeakMap<object, Loader>;
  cookies: Map<string, { loader: Loader; dexes: DexFile[] }>;
  parentOf: (loader: object) => object | null;
  /** the ClassLoader object that opened the app's own dex files, which the classes of the default namespace that the app defines answer to getClassLoader */
  appLoader: object | null;
}
const states = new WeakMap<World, State>();
function stateOf(w: World): State {
  let s = states.get(w);
  if (!s) states.set(w, s = { byObject: new WeakMap(), cookies: new Map(), parentOf: w.fieldReader<object | null>("java/lang/ClassLoader", "parent", "Ljava/lang/ClassLoader;"), appLoader: null });
  return s;
}

/** the namespace a ClassLoader object sees: its own if it opened dex files, else its nearest ancestor's, else the default one */
function loaderFor(w: World, obj: object | null): Loader {
  const s = stateOf(w);
  for (let o = obj; o; o = s.parentOf(o)) { const l = s.byObject.get(o); if (l) return l; }
  return w.prog.root;
}

/** host.classByName(name, scope, mode): the id of the class a binary name ("a.B$C", "[La.B;") stands for in the scope, or 0 */
export function classByName(w: World, name: string, scope: unknown, mode: Lookup): number {
  const n = name.replace(/\./g, "/");
  if (n === "" || n.includes("@")) return 0;
  const prog = w.prog, s = stateOf(w), cookie = mode === Lookup.Cookie ? s.cookies.get(w.hostString(scope) as string) : undefined;
  const loader = mode === Lookup.Cookie ? cookie?.loader : loaderFor(w, scope as object | null);
  if (!loader) return 0;
  const find = (cls: string): string | undefined => {
    if (mode === Lookup.Visible) return prog.lookup(loader, cls);
    const key = prog.definedBy(loader, cls);
    return key !== undefined && (!cookie || cookie.dexes.includes(prog.get(key)!.dex!)) ? key : undefined;
  };
  const e = n.replace(/^\[+/, "");
  if (e === n) { const key = find(n); return key === undefined ? 0 : w.idOf(key); }
  const element = /^L(.+);$/.exec(e), key = element ? find(element[1]) : /^[ZBCSIJFD]$/.test(e) ? "" : undefined;
  return key === undefined ? 0 : w.idOf(key === "" ? n : `${n.slice(0, n.length - e.length)}L${key};`);
}

/** host.dexOpen(path, loader): the cookie of the dex files at `path`, whose classes are defined in the namespace of the ClassLoader object `loader` */
export function dexOpen(w: World, path: unknown, loaderObject: object | null): object {
  const s = stateOf(w), file = w.hostString(path) as string;
  if (!w.opts.dexes) {
    w.onGap(w.gapId("DexFile.openDexFileNative: the host has no dex files to open"));
    throw w.exception(w.makeThrowable("java/lang/UnsatisfiedLinkError", "dalvik.system.DexFile.openDexFileNative"));
  }
  const dexes = w.opts.dexes(file);
  if (!dexes) throw w.exception(w.makeThrowable("java/io/IOException", `Unable to open DEX file '${file}'`));
  // dex files the Program holds already stay in their namespace, and a loader that opens only those is that namespace
  let loader = loaderObject ? s.byObject.get(loaderObject) : w.prog.root;
  if (!loader) {
    loader = dexes.map((d) => w.prog.loaderOfDex(d)).find((l) => l) ?? w.prog.newLoader(loaderFor(w, s.parentOf(loaderObject!)), loaderObject);
    s.byObject.set(loaderObject!, loader);
  }
  if (loaderObject && loader === w.prog.root) s.appLoader ??= loaderObject;
  const fresh = dexes.filter((d) => !w.prog.loaderOfDex(d));
  if (fresh.length) w.addDexes(fresh, loader);
  const id = `dex:${s.cookies.size}`;
  s.cookies.set(id, { loader, dexes });
  return w.javaString(id) as object;
}

/** host.obj(LOADER_OF_CLASS, id): the ClassLoader object of the loader that defines class `id`, or null for the boot loader and the platform's classes */
export function loaderObject(w: World, id: number): object | null {
  const name = w.nameOf(id), loader = w.prog.loaderOf(name);
  // the app's classes are the default namespace's too, but its class loader is the one that opened the app's dex files, not the boot loader
  return loader.object ?? (loader === w.prog.root && !w.prog.base?.has(name) ? stateOf(w).appLoader : null);
}

export const loaderIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => loaderIntrinsics.set(key, (cx, m, c) => f(cx, c));

def("dalvik/system/DexFile.openDexFileNative(Ljava/lang/String;Ljava/lang/String;ILjava/lang/ClassLoader;[Ldalvik/system/DexPathList$Element;)Ljava/lang/Object;", (cx, c) => {
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(0); cx.str.toHost(c); c.lget(3).externConvertAny(); c.call(cx.imp.dexOpen).anyConvertExtern();
});
// the classes of an opened dex are in the Program already: defining one is finding it among the cookie's
def("dalvik/system/DexFile.defineClassNative(Ljava/lang/String;Ljava/lang/ClassLoader;Ljava/lang/Object;Ldalvik/system/DexFile;)Ljava/lang/Class;", (cx, c) => {
  const id = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(0); cx.str.toHost(c); c.lget(2).externConvertAny(); c.i32(Lookup.Cookie); c.call(cx.imp.classByName).ltee(id).if_(T.anyref).lget(id); cx.callRt(c, "classOf"); c.else_().anyNull().end();
});
// classes are never unloaded, so a closed dex is still in use
def("dalvik/system/DexFile.closeDexFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// a dex opened here is read from its file: no oat file stands behind it
def("dalvik/system/DexFile.isBackedByOatFile(Ljava/lang/Object;)Z", (cx, c) => { c.i32(0); });
// classes are not verified here, in the background or otherwise
def("dalvik/system/DexFile.verifyInBackgroundNative(Ljava/lang/Object;Ljava/lang/ClassLoader;)V", () => {});
