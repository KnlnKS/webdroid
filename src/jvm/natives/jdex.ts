import { slashName } from "../abi";
import { zipTree } from "./jzip";
import { rt } from "../runtime";
import { dexesIn } from "../dex";
import { JClassLoader } from "./jlang";
import { vfs } from "./jio";

async function init(this: JClassLoader, path: string, libraries: string | null, parent: JClassLoader | null) {
  this.parent = parent;
  this.runtime = (parent?.runtime ?? rt).fork();
  this.runtime.classLoader = this;
  for (const entry of path.split(":")) {
    const bytes = await vfs.readFile(entry);
    if (!bytes) continue;
    const files: Record<string, Uint8Array> = bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78
      ? { "classes.dex": bytes } : zipTree(bytes);
    for (const name of Object.keys(files).filter((n) => /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b)))
      for (const dex of dexesIn(files[name], entry + "!/" + name)) this.runtime.loadDex(dex);
    for (const name of Object.keys(files)) if (!Object.hasOwn(this.runtime.classpath, name)) {
      Object.defineProperty(this.runtime.classpath, name, { enumerable: true, configurable: true, get: () => files[name] });
      this.runtime.classpathLocations.set(name, entry);
    }
  }
}
rt.register({
  name: "dalvik/system/PathClassLoader", ctor: class extends JClassLoader {}, sup: "java/lang/ClassLoader",
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V": init,
    "<init>(Ljava/lang/String;Ljava/lang/ClassLoader;)V": async function (this: JClassLoader, path: string, parent: JClassLoader | null) { await init.call(this, path, null, parent); },
    "findClass(Ljava/lang/String;)Ljava/lang/Class;": function (this: JClassLoader, n: string) {
      const name = slashName(n);
      if (!this.runtime.dexIndex.has(name)) {
        rt.link("java/lang/ClassNotFoundException");
        throw rt.mkThrowable("java/lang/ClassNotFoundException", n);
      }
      return this.runtime.classFor(name);
    },
  },
});
rt.register({
  name: "webdroid/PackageClassLoader", ctor: class extends JClassLoader {}, sup: "java/lang/ClassLoader",
  methods: {
    "<init>(Ljava/lang/String;)V": async function (this: JClassLoader, path: string) {
      await init.call(this, path, null, null);
      this.runtime.platformParent = true;
    },
    "loadClass(Ljava/lang/String;Z)Ljava/lang/Class;": function (this: JClassLoader, name: string) {
      const cls = slashName(name), runtime = this.runtime;
      if (!runtime.dexIndex.has(cls) && !runtime.natives.has(cls) && !runtime.platformClasses.has(cls))
        throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
      return runtime.classFor(cls);
    },
    "findClass(Ljava/lang/String;)Ljava/lang/Class;": function (this: JClassLoader, name: string) {
      const cls = slashName(name);
      if (!this.runtime.dexIndex.has(cls)) throw rt.mkThrowable("java/lang/ClassNotFoundException", name);
      return this.runtime.classFor(cls);
    },
  },
});
