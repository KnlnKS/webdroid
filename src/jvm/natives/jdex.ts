import { slashName, dotName } from "../abi";
import { mkIter } from "./jutil";
import { JObj, rt, type Runtime, driven, type Gen } from "../runtime";
import { zipTree } from "./jzip";
import { pathOf } from "./jio";
import { dexesIn } from "../dex";
import { JClassLoader } from "./jlang";
import { vfs } from "../../shell/vfs";
import { packedArchives } from "../../shell/packedarchive";
import type { JBuffer } from "./jnio";

function initRuntime(loader: JClassLoader, parent: JClassLoader | null): void {
  loader.parent = parent;
  loader.runtime = (parent?.runtime ?? rt).fork();
  loader.runtime.classLoader = loader;
}
async function init(this: JClassLoader, path: string, libraries: string | null, parent: JClassLoader | null) {
  initRuntime(this, parent);
  for (const entry of path.split(":")) {
    const packed = packedArchives.get(entry);
    let files: Record<string, Uint8Array>;
    if (packed) { await packed.prepare(true); files = packed.zip; this.runtime.classpathSource = packed; }
    else {
      const bytes = await vfs.readFile(entry);
      if (!bytes) continue;
      files = bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78 ? { "classes.dex": bytes } : zipTree(bytes);
    }
    for (const name of Object.keys(files).filter((n) => /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b)))
      for (const dex of dexesIn(files[name], entry + "!/" + name)) this.runtime.loadDex(dex);
    for (const name of Object.keys(files)) if (!Object.hasOwn(this.runtime.classpath, name)) {
      Object.defineProperty(this.runtime.classpath, name, { enumerable: true, configurable: true, get: () => files[name] });
      this.runtime.classpathLocations.set(name, entry);
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
      return mkIter(names);
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
  if (!this.runtime.dexIndex.has(cls)) throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
  return this.runtime.classFor(cls);
}
rt.register({
  name: "dalvik/system/BaseDexClassLoader", ctor: JBaseDexClassLoader, sup: "java/lang/ClassLoader",
  methods: { "findClass(Ljava/lang/String;)Ljava/lang/Class;": findDexClass },
});
rt.register({
  name: "dalvik/system/PathClassLoader", ctor: class extends JBaseDexClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V": init,
    "<init>(Ljava/lang/String;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, path: string, parent: JClassLoader | null) { return init.call(this, path, null, parent); },
  },
});
rt.register({
  name: "dalvik/system/DexClassLoader", ctor: class extends JBaseDexClassLoader {}, sup: "dalvik/system/BaseDexClassLoader",
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V": function (this: JClassLoader, path: string, _optimized: string, libraries: string | null, parent: JClassLoader | null) { return init.call(this, path, libraries, parent); },
  },
});
function initMemory(this: JClassLoader, buffers: JBuffer[], parent: JClassLoader | null): void {
  if (!buffers) throw rt.mkThrowable("java/lang/NullPointerException", "null DEX buffers");
  initRuntime(this, parent);
  for (const [index, buffer] of buffers.entries()) {
    if (!buffer) throw rt.mkThrowable("java/lang/NullPointerException", "null DEX buffer");
    const view = buffer.dv;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + buffer.pos, buffer.lim - buffer.pos).slice();
    for (const dex of dexesIn(bytes, `memory:${index}`)) this.runtime.loadDex(dex);
  }
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
