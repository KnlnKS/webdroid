import { slashName } from "../abi";
import { unzipSync } from "fflate";
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
      ? { "classes.dex": bytes } : unzipSync(bytes);
    for (const name of Object.keys(files).filter((n) => /^classes(?:[2-9]|[1-9][0-9]+)?\.dex$/.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b)))
      for (const dex of dexesIn(files[name], entry + "!/" + name)) this.runtime.loadDex(dex);
    for (const [name, data] of Object.entries(files)) if (!this.runtime.classpath[name]) {
      this.runtime.classpath[name] = data;
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
