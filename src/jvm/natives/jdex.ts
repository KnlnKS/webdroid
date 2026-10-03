import { slashName, dotName } from "../abi";
import { mkEnumeration } from "./jcoll";
import { JObj, rt, type Runtime, driven, type Gen } from "../runtime";
import { zipTree } from "./jzip";
import { pathOf } from "./jio";
import { dexesIn } from "../dex";
import { JClassLoader } from "./jlang";
import { vfs } from "../../shell/vfs";
import { packedArchives } from "../../shell/packedarchive";
import { remainingBytes, resident, type JBuffer } from "./jnio";

function initRuntime(loader: JClassLoader, parent: JClassLoader | null): void {
  loader.parent = parent;
  loader.runtime = (parent?.runtime ?? rt).fork();
  loader.runtime.classLoader = loader;
}
/** the app's own archives, whose dex the process loaded at boot: a loader over them (LoadedApk's) is
 *  the app's class loader, over the runtime that already holds those classes */
export const appArchives = new Set<string>();
async function init(this: JClassLoader, path: string, _libraries: string | null, parent: JClassLoader | null,
  before: JClassLoader[] | null = null, after: JClassLoader[] | null = null) {
  if (!rt.classLoader && appArchives.has(path.split(":")[0])) {
    this.parent = parent; this.runtime = rt; rt.classLoader = this;
  } else {
    initRuntime(this, parent);
    await addDexPath(this, path);
  }
  if (before?.length || after?.length)
    this.runtime.libraries = { before: (before ?? []).map((l) => l.runtime), after: (after ?? []).map((l) => l.runtime) };
}
/** DexPathList: each archive's dex files, in classes, classes2, ... order, and its other entries as resources */
async function addDexPath(loader: JClassLoader, path: string): Promise<void> {
  for (const entry of path.split(":")) {
    const packed = packedArchives.get(entry);
    let files: Record<string, Uint8Array>;
    if (packed) { await packed.prepare(true); files = packed.zip; loader.runtime.classpathSource = packed; }
    else {
      const bytes = await vfs.readFile(entry);
      if (!bytes) continue;
      files = bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78 ? { "classes.dex": bytes } : zipTree(bytes);
    }
    for (const name of Object.keys(files).filter((n) => /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b)))
      for (const dex of dexesIn(files[name], entry + "!/" + name)) loader.runtime.loadDex(dex);
    for (const name of Object.keys(files)) if (!Object.hasOwn(loader.runtime.classpath, name)) {
      Object.defineProperty(loader.runtime.classpath, name, { enumerable: true, configurable: true, get: () => files[name] });
      loader.runtime.classpathLocations.set(name, entry);
    }
  }
}
// the legacy dex handle: it names an archive on the classpath and lists the classes loaded from it
class JDexFile extends JObj { path = ""; runtime: Runtime | null = null; }
const dexRuntimeFor = (path: string): Runtime | null => {
  for (let r: Runtime | null = (rt.classLoader as JClassLoader | null)?.runtime ?? rt; r; r = r.parent) if ([...r.classpathLocations.values()].includes(path)) return r;
  return null;
};
const openDexFile = function (this: JDexFile, p: string) {
  this.path = vfs.norm(p);
  if (!vfs.exists(this.path) && !packedArchives.has(this.path)) throw rt.mkThrowable("java/io/IOException", "unable to open DEX file " + p);
  this.runtime = dexRuntimeFor(this.path);
};
rt.register({
  name: "dalvik/system/DexFile", ctor: JDexFile,
  methods: {
    "<init>(Ljava/lang/String;)V": openDexFile,
    "<init>(Ljava/io/File;)V": function (this: JDexFile, f: JObj) { openDexFile.call(this, pathOf(f)); },
    "static loadDex(Ljava/lang/String;Ljava/lang/String;I)Ldalvik/system/DexFile;": (source: string) => { const d = new JDexFile(); openDexFile.call(d, source); return d; },
    "getName()Ljava/lang/String;": function (this: JDexFile) { return this.path; },
    "toString()Ljava/lang/String;": function (this: JDexFile) { return this.path; },
    "entries()Ljava/util/Enumeration;": function (this: JDexFile) {
      const names: string[] = [];
      const runtime = this.runtime;
      if (runtime) for (const [name, loc] of runtime.dexIndex)
        if (runtime.dexAtClassLocation(loc).name.startsWith(this.path + "!")) names.push(dotName(name));
      return mkEnumeration(names);
    },
    "loadClass(Ljava/lang/String;Ljava/lang/ClassLoader;)Ljava/lang/Class;": function (this: JDexFile, name: string) {
      const cls = slashName(name);
      return this.runtime?.dexIndex.has(cls) ? this.runtime.classFor(cls) : null;
    },
    "close()V": function () {},
  },
});
class JBaseDexClassLoader extends JClassLoader {}
/** a class from this loader's own dex files, not its parent's */
function findDexClass(this: JClassLoader, name: string) {
  const cls = slashName(name);
  if (!this.runtime.defines(cls)) throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
  return this.runtime.classFor(cls);
}
rt.register({
  name: "dalvik/system/BaseDexClassLoader", ctor: JBaseDexClassLoader, sup: "java/lang/ClassLoader",
  methods: {
    "findClass(Ljava/lang/String;)Ljava/lang/Class;": findDexClass,
    // the package manager's dex-load reporter feeds dexopt, which nothing here runs
    "static setReporter(Ldalvik/system/BaseDexClassLoader$Reporter;)V": () => {},
    "reportClassLoaderChain()V": () => {},
    "addDexPath(Ljava/lang/String;)V": function (this: JClassLoader, path: string) { return addDexPath(this, path); },
    "addDexPath(Ljava/lang/String;Z)V": function (this: JClassLoader, path: string) { return addDexPath(this, path); },
    // native libraries load straight from the loader's archives (findLibrary), so library
    // directories add nothing to search
    "addNativePath(Ljava/util/Collection;)V": () => {},
    "getLdLibraryPath()Ljava/lang/String;": () => "",
  },
});
rt.register({
  name: "dalvik/system/PathClassLoader", ctor: class extends JBaseDexClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V": init,
    "<init>(Ljava/lang/String;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, path: string, parent: JClassLoader | null) { return init.call(this, path, null, parent); },
    // ClassLoaderFactory's, with the shared libraries' loaders
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;[Ljava/lang/ClassLoader;)V": init,
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;[Ljava/lang/ClassLoader;[Ljava/lang/ClassLoader;)V": init,
  },
});
rt.register({
  name: "dalvik/system/DexClassLoader", ctor: class extends JBaseDexClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, path: string, _optimized: string, libraries: string | null, parent: JClassLoader | null) { return init.call(this, path, libraries, parent); },
  },
});
function initMemory(this: JClassLoader, buffers: JBuffer[], parent: JClassLoader | null): void | Promise<void> {
  if (!buffers) throw rt.mkThrowable("java/lang/NullPointerException", "null DEX buffers");
  for (const buffer of buffers) if (!buffer) throw rt.mkThrowable("java/lang/NullPointerException", "null DEX buffer");
  const load = () => {
    initRuntime(this, parent);
    for (const [index, buffer] of buffers.entries()) {
      const bytes = remainingBytes(buffer).slice();
      for (const dex of dexesIn(bytes, `memory:${index}`)) this.runtime.loadDex(dex);
    }
  };
  const waits = buffers.map(resident).filter((wait) => wait !== null);
  return waits.length ? Promise.all(waits).then(load) : load();
}
rt.register({
  name: "dalvik/system/InMemoryDexClassLoader", ctor: class extends JBaseDexClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, buffer: JBuffer, parent: JClassLoader | null) { initMemory.call(this, [buffer], parent); },
    "<init>([Ljava/nio/ByteBuffer;Ljava/lang/ClassLoader;)V": initMemory,
    "<init>([Ljava/nio/ByteBuffer;Ljava/lang/String;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, buffers: JBuffer[], _libraries: string | null, parent: JClassLoader | null) { initMemory.call(this, buffers, parent); },
  },
});
rt.register({
  name: "webdroid/PackageClassLoader", ctor: class extends JClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/lang/String;)V": driven(function* (this: JClassLoader, path: string): Gen {
      yield init.call(this, path, null, null);
      this.runtime.platformParent = true;
    }),
    "loadClass(Ljava/lang/String;Z)Ljava/lang/Class;": function (this: JClassLoader, name: string) {
      const cls = slashName(name), runtime = this.runtime;
      if (!runtime.dexIndex.has(cls) && !runtime.natives.has(cls) && !runtime.platformClasses.has(cls))
        throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
      return runtime.classFor(cls);
    },
    "findClass(Ljava/lang/String;)Ljava/lang/Class;": findDexClass,
  },
});

// libnativeloader's namespace for a class loader: native libraries load from the loader's own
// archives here (src/native/loader.ts), so there is nothing to set up and no error to report
rt.registerJni("com/android/internal/os/ClassLoaderFactory",
  "createClassloaderNamespace(Ljava/lang/ClassLoader;ILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;)Ljava/lang/String;", () => null);
