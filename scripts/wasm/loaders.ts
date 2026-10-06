// Class loaders: two DexClassLoaders over dex files that define the same class name (tests/fixtures/wasm/java/Ldr.java) keep distinct classes, statics and Class
// objects, see the app's interface through their parent, and answer Class.forName, loadClass, getClassLoader and reflection each in its own namespace.
// Needs javac and d8. Run: bun run wasm loaders
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { BytesFile } from "../../src/shell/lazyfile";
import { vfs } from "../../src/shell/vfs";
import { loadDexes, program, world } from "./lib";
import { Program } from "../../src/wasm/compiler/program";
import { appArchives } from "../../src/jvm/natives/jdex";
import { openDexes } from "../../src/wasm/host/boot";
import { jsTier, natives } from "./oracle";
import { AOSP, JAVA } from "./paths";
import { filesIn, shellIn } from "./tools";

import { androidPlatform, androidTool } from "../android-sdk";

const out = mkdtempSync(join(tmpdir(), "j2w-ldr-"));
const sh = shellIn(out), androidJar = `${androidPlatform(35)}/android.jar`;
/** compiles `sources` (against the Android API and `classpath`) and dexes the classes; answers the dex */
const build = (dir: string, sources: string[], classpath?: string) => {
  sh(["mkdir", "-p", dir]);
  sh(["javac", "--release", "11", "-Xlint:-options", "-cp", [androidJar, classpath].filter(Boolean).join(":"), "-d", join(out, dir), ...sources.map((s) => join(JAVA, s))]);
  sh([androidTool("d8"), "--min-api", "26", "--output", join(out, dir), "--lib", androidJar, ...(classpath ? ["--classpath", classpath] : []), ...filesIn(join(out, dir), /\.class$/)]);
  return join(out, dir, "classes.dex");
};
const app = build("app", ["Ldr.java"]);
const a = build("a", ["ldr1/Shared.java", "ldr1/Boom.java"], join(out, "app")), b = build("b", ["ldr2/Shared.java", "ldr2/Boom.java", "ldr2/Sub.java"], join(out, "app"));
const apk = join(out, "ordered.apk");
writeFileSync(apk, zipSync({ "classes10.dex": new Uint8Array(readFileSync(b)), "classes2.dex": new Uint8Array(readFileSync(a)), "classes1000.dex": new Uint8Array(readFileSync(b)), "classes.dex": new Uint8Array(readFileSync(app)) }));
const ordered = world([apk, ...PLATFORM_JARS.map((j) => join(AOSP, j))], { natives });
if (ordered.entry("Shared", "tag", "()I")(ordered.entry("Shared", "make", "()LShared;")()) !== 1) throw new Error("APK secondary DEX precedence changed");

const ownPath = "/data/app/loader-own/base.apk", otherPath = "/data/app/loader-other/base.apk", ownDexes = loadDexes(a);
const opened = new Map<string, ReturnType<typeof openDexes>>();
appArchives.add(ownPath);
vfs.mount(otherPath, new BytesFile(zipSync({ "classes.dex": new Uint8Array(readFileSync(b)) })));
try {
  if (openDexes(ownPath, ownDexes, opened) !== ownDexes) throw new Error("own archive lost DEX identity");
  const other = await openDexes(otherPath, ownDexes, opened);
  if (!other || other === ownDexes || other[0].id === ownDexes[0].id || await openDexes(otherPath, ownDexes, opened) !== other) throw new Error("another APK aliased the app's DEX or lost its cached identity");
} finally { appArchives.delete(ownPath); }

// the files the loaders open: libcore finds them through the file system, the World reads their dex
const files = new Map([["/data/local/tmp/a.dex", a], ["/data/local/tmp/b.dex", b]]);
for (const [path, file] of files) vfs.mount(path, new BytesFile(new Uint8Array(readFileSync(file))));
const js = await jsTier(loadDexes(app));
const w = world([app, ...PLATFORM_JARS.map((j) => join(AOSP, j))], { natives, dexes: (path) => (files.has(path) ? loadDexes(files.get(path)!) : undefined) });

const CHECKS = ["the loaders define distinct Shared classes", "getClassLoader", "loadClass finds the class again", "statics are separate", "isInstance does not cross", "both implement the app's Tag",
  "cast across loaders fails", "Class.forName with a loader", "a class only the other loader defines, and its superclass", "the parent's classes are found through the loader", "signatures name the loader's class",
  "a method of the other loader's types is not found", "return types and receivers", "array classes", "loader identity and parent", "exceptions of a loader's own classes"];
let failed = 0;
const gaps = new Set<string>();
w.onGap = (id) => gaps.add(w.gapList[id]);
let got: number;
try { got = w.entry("Ldr", "check", "(Ljava/lang/String;Ljava/lang/String;)I")("/data/local/tmp/a.dex", "/data/local/tmp/b.dex") as number; } catch (e) {
  const t = w.throwable(e);
  if (!t) throw e;
  const detail = w.fieldReader<object | null>("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(t);
  console.log(`gaps hit: ${[...gaps].join("; ") || "none"}`);
  console.log(`threw ${w.classNameOf(t)}: ${detail ? w.hostString(detail) : null}`);
  process.exit(1);
}
for (const [bit, what] of CHECKS.entries()) if (got & (1 << bit)) { failed++; console.log(`FAIL ${what}`); }
// Lazy platform archives wait for their bytes before defining the loader's classes.
w.opts.dexes = async (path) => {
  await new Promise<void>(resolve => queueMicrotask(resolve));
  return files.has(path) ? loadDexes(files.get(path)!) : undefined;
};
const deferred = await w.entryAsync("Ldr", "check", "(Ljava/lang/String;Ljava/lang/String;)I")("/data/local/tmp/a.dex", "/data/local/tmp/b.dex") as number;
if (deferred) { failed++; console.log(`FAIL deferred archive checks: ${deferred}`); }
const desc = "(Ljava/lang/String;Ljava/lang/String;)I", paths = ["/data/local/tmp/a.dex", "/data/local/tmp/b.dex"];
const jsLibraries = await js("Ldr", "libraries", desc, paths);
if (jsLibraries !== 21) throw new Error(`JS shared-library control: ${jsLibraries}`);
for (const asynchronous of [false, true]) {
  const appDexes = loadDexes(a), base = program([...PLATFORM_JARS.map(j => join(AOSP, j)), app]);
  const p = new Program(appDexes, base), layered = world(p, { natives, dexes: path => {
    const dexes = path === paths[0] ? appDexes : files.has(path) ? loadDexes(files.get(path)!) : undefined;
    return asynchronous ? Promise.resolve().then(() => dexes) : dexes;
  } });
  const cls = p.get("Shared")!, self = cls.byKey.get("self()LShared;")!, peer = cls.fields.find(f => f.name === "peer")!;
  cls.byKey.set("alias()LShared;", self);
  const child = p.newLoader(p.root, null);
  layered.addDexes(loadDexes(b), child);
  const childClass = p.get(p.definedBy(child, "Shared")!)!, childSelf = childClass.byKey.get("self()LShared;")!, childPeer = childClass.fields.find(f => f.name === "peer")!;
  const retIndex = appDexes[0].proto(appDexes[0].method(self.methodIdx).proto).ret;
  const result = await layered.entryAsync("Ldr", "libraries", desc)(...paths);
  const visible = p.lookup(p.root, "Shared");
  if (childSelf.ret !== `L${visible};` || childPeer.desc !== childSelf.ret || childClass.byKey.get(childSelf.key) !== childSelf) {
    failed++; console.log(`FAIL dependent loader caches: self=${childSelf.ret}, peer=${childPeer.desc}, visible=${visible}`);
  }
  if (result !== jsLibraries || visible === "Shared" || !visible || self.ret !== `L${visible};` || peer.desc !== self.ret || cls.fields.find(f => f.name === "peer") !== peer || cls.byKey.get(self.key) !== self || cls.byKey.get(`alias()L${visible};`) !== self || cls.byKey.has("self()LShared;") || cls.byKey.has("alias()LShared;") || appDexes[0].rawType(retIndex) !== "LShared;" || appDexes[0].type(retIndex) !== self.ret) {
    failed++; console.log(`FAIL ${asynchronous ? "deferred" : "synchronous"} library graph: result=${result}, visible=${visible}, self=${self.ret}, peer=${peer.desc}`);
  }
}
console.log(failed ? `${failed} failures` : "loaders: all pass");
process.exit(failed ? 1 : 0);
