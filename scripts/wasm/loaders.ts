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
import { Program, ACC, type JClass } from "../../src/wasm/compiler/program";
import { appArchives } from "../../src/jvm/natives/jdex";
import { openDexes } from "../../src/wasm/host/boot";
import { wasmJni } from "../../src/wasm/host/jni";
import { jniInit, deref, javaVM } from "../../src/native/jni";
import { useJniVm, vm as priorJniVm } from "../../src/native/jnivm";
import { Cpu, setA64 } from "../../src/native/cpu";
import { mem } from "../../src/native/mem";
import { ldp, PTR } from "../../src/native/host";
import { mainThread } from "../../src/jvm/natives/jentry";
import { definingLoader } from "../../src/wasm/link/loaders";
import { St } from "../../src/wasm/link/monitor";
import { canAccess } from "../../src/wasm/link/classes";
import { HOSTED } from "../../src/wasm/link/hostapi";
import { hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { useEntry } from "../../src/jvm/natives/jentry";
import { rt } from "../../src/jvm/runtime";
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
const jsCustom = await js("Ldr", "customParent", desc, paths);
const wasmCustom = await w.entryAsync("Ldr", "customParent", desc)(...paths);
if (wasmCustom !== 121) { failed++; console.log(`FAIL inherited parent-first loader: js=${jsCustom}, wasm=${wasmCustom}, expected=121`); }
if (jsCustom !== 121) console.log(`JS loader superclass differs from parent-first resolution: ${jsCustom} (expected 121)`);
{
  const proxies = await w.entryAsync("Ldr", "proxyLoaders", desc)(...paths);
  if (proxies !== 8191) { failed++; console.log(`FAIL proxy defining loaders, duplicate binary names, bootstrap isolation, public cache, arrays and defensive duplicate rejection: ${proxies} (expected 8191)`); }
}
const jsDelegate = await js("Ldr", "delegateLast", desc, paths);
const wasmDelegate = await w.entryAsync("Ldr", "delegateLast", desc)(...paths);
if (jsDelegate !== 31 || wasmDelegate !== jsDelegate) { failed++; console.log(`FAIL actual delegate-last initiation and ordinary parent-first control: js=${jsDelegate}, wasm=${wasmDelegate}, expected=31`); }

const jsLibraries = await js("Ldr", "libraries", desc, paths);
if (jsLibraries !== 21) throw new Error(`JS shared-library control: ${jsLibraries}`);
try {
  const jsForName = await js("Ldr", "resolverForName", "(Ljava/lang/String;)I", [paths[0]]);
  if (jsForName !== 63) throw new Error(`JS Class.forName fixture: ${jsForName} (expected 63)`);
} catch (error) {
  if (!(error instanceof Error) || error.message !== "java/lang/ClassNotFoundException: [LShared;") throw error;
  console.log("JS Class.forName reference-array control throws ClassNotFoundException: [LShared;");
}
{
  const p = new Program(loadDexes(a), program([...PLATFORM_JARS.map(j => join(AOSP, j)), app]));
  const cache = world(p, { natives }), child = p.newLoader(p.root, null);
  cache.addDexes(loadDexes(b), child);
  const key = p.definedBy(child, "Shared")!, cls = p.get(key)!;
  const self = cls.byKey.get("self()LShared;")!, peer = cls.fields.find(f => f.name === "peer")!;
  const type = cls.dex!.proto(cls.dex!.method(self.methodIdx).proto).ret;
  if (cls.dex!.type(type) !== "LShared;" || peer.desc !== "LShared;") throw new Error("fixture did not warm the parent resolution");
  const epoch = cache.epoch;
  cache.initiateClass(child, "Shared", key);
  if (p.lookup(child, "Shared") !== key || cls.dex!.type(type) !== `L${key};` || self.ret !== `L${key};` || peer.desc !== self.ret || cls.byKey.get(self.key) !== self || cache.epoch !== epoch + 1) throw new Error("initiating identity retained stale DEX/member caches");
  cache.link(key);
  try { cache.initiateClass(child, "Shared", "Shared"); throw new Error("conflicting initiated identity accepted"); }
  catch (e) { const t = cache.throwable(e); if (!t || cache.classNameOf(t) !== "java/lang/LinkageError" || p.lookup(child, "Shared") !== key) throw e; }
}
for (const asynchronous of [false, true]) {
  const appDexes = loadDexes(a), base = program(PLATFORM_JARS.map(j => join(AOSP, j)));
  const p = new Program([...loadDexes(app), ...appDexes], base), layered = world(p, { natives, dexes: path => {
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
  wasmEntry(layered);
  const jni = wasmJni(layered);
  for (const name of ["Ldr", childClass.name, visible!]) {
    const owner = jni.find(name, null)!;
    const expected = p.lookup(p.loaderOf(name), "Shared")!;
    if (p.viewOf(name, "([LShared;Ljava/lang/String;)LShared;") !== `([L${expected};Ljava/lang/String;)L${expected};` || jni.find("[LShared;", null, owner)?.name !== `[L${expected};`) {
      failed++; console.log(`FAIL JNI descriptor/array namespace of ${name}: expected=${expected}, descriptor=${p.viewOf(name, "([LShared;Ljava/lang/String;)LShared;")}, array=${jni.find("[LShared;", null, owner)?.name}`);
    }
  }
  const shared = jni.find(visible!, null)!;
  const object = await jni.construct(shared, "()V", []);
  const field = jni.field(shared, "peer", "LShared;", false);
  if (!field || !jni.hasMethod(shared, "self", "()LShared;", false) || !jni.hasMethod(shared, "same", "(LShared;LShared;)Z", true)) {
    failed++; console.log("FAIL JNI member descriptors");
  } else {
    jni.set(field, object, object);
    if (jni.get(field, object) !== object || await jni.invoke(shared, "self", "()LShared;", false, object, [], false) !== object || !await jni.invoke(shared, "same", "(LShared;LShared;)Z", true, null, [object, object], false)) {
      failed++; console.log("FAIL JNI member invocation/field identity");
    }
  }
  if (childSelf.ret !== `L${visible};` || childPeer.desc !== childSelf.ret || childClass.byKey.get(childSelf.key) !== childSelf) {
    failed++; console.log(`FAIL dependent loader caches: self=${childSelf.ret}, peer=${childPeer.desc}, visible=${visible}`);
  }
  if (result !== jsLibraries || visible === "Shared" || !visible || self.ret !== `L${visible};` || peer.desc !== self.ret || cls.fields.find(f => f.name === "peer") !== peer || cls.byKey.get(self.key) !== self || cls.byKey.get(`alias()L${visible};`) !== self || cls.byKey.has("self()LShared;") || cls.byKey.has("alias()LShared;") || appDexes[0].rawType(retIndex) !== "LShared;" || appDexes[0].type(retIndex) !== self.ret) {
    failed++; console.log(`FAIL ${asynchronous ? "deferred" : "synchronous"} library graph: result=${result}, visible=${visible}, self=${self.ret}, peer=${peer.desc}`);
  }
  const hostedSpec = { name: childClass.name, sup: childClass.sup, ifaces: [], methods: ["toString()Ljava/lang/String;"], fields: [], ctor: class {} };
  layered.addHostClass(hostedSpec);
  if (p.loaderOf(childClass.name + HOSTED) !== child || p.lookup(p.boot, childClass.name + HOSTED)) throw new Error("hosted custom class lost its defining loader");
  const iface: JClass = { name: `fixture/HostedInterface@${child.id}`, dex: null, def: null, sup: "java/lang/Object", ifaces: [], flags: ACC.PUBLIC | ACC.INTERFACE | ACC.ABSTRACT, isInterface: true, fields: [], methods: [], byKey: new Map() };
  layered.addClass(iface, new Map(), child);
  const shell = layered.hosts.javaClass({ ...hostedSpec, name: iface.name, methods: [] });
  if (p.loaderOf(shell) !== child || p.lookup(p.boot, shell)) throw new Error("hosted interface shell lost its defining loader");

}
{
  const base = new Program([]), custom = base.newLoader(base.boot, null);
  const synthetic = (name: string): JClass => ({ name, dex: null, def: null, sup: "java/lang/Object", ifaces: [], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map() });
  base.addClass(synthetic("fixture/BaseApp"), base.root);
  base.addClass(synthetic("fixture/BaseBoot@0"), base.boot);
  base.addClass(synthetic(`fixture/BaseCustom@${custom.id}`), custom);
  const peer = synthetic("fixture/Peer");
  base.addClass(peer, base.root);
  const accessWorld = world(base);
  const appClass = base.require("fixture/BaseApp"), childClass = base.require(`fixture/BaseCustom@${custom.id}`);
  if (!canAccess(peer.name, appClass, 0, accessWorld) || canAccess(childClass.name, appClass, 0, accessWorld)
    || !canAccess(childClass.name, appClass, ACC.PUBLIC, accessWorld)) throw new Error("runtime package access lost defining-loader identity");
  appClass.flags = 0;
  if (!canAccess(peer.name, appClass, ACC.PUBLIC, accessWorld) || canAccess(childClass.name, appClass, ACC.PUBLIC, accessWorld)) throw new Error("non-public class crossed runtime packages");
  appClass.flags = ACC.PUBLIC;
  const derived = new Program([], base);
  if (derived.lookup(derived.boot, "fixture/BaseApp") || derived.lookup(derived.boot, "fixture/BaseCustom") || derived.lookup(derived.boot, "fixture/BaseBoot") !== "fixture/BaseBoot@0" || derived.loaderOf("fixture/BaseApp") !== base.root || derived.loaderOf(`[Lfixture/BaseCustom@${custom.id};`) !== custom || derived.loaderOf("[Lfixture/BaseBoot@0;") !== derived.boot) throw new Error("inherited synthetic defining loader or bootstrap visibility changed");
}
{
  const base = new Program(loadDexes(a)), custom = base.newLoader(base.boot, null);
  base.add(loadDexes(b), custom);
  const derived = new Program(loadDexes(app), base), platform = derived.get("Shared")!;
  if (!platform.dex || derived.loaderOf("Shared") !== derived.boot || derived.loaderOf("[[LShared;") !== derived.boot || ["[I", "#I", "#V"].some(name => derived.loaderOf(name) !== derived.boot) || derived.loaderOf("Ldr") !== derived.root || derived.loaderOf(base.definedBy(custom, "Sub")!) !== custom || derived.loaderOfDex(platform.dex) !== base.root || derived.lookup(derived.boot, "Shared") !== "Shared") throw new Error("inherited DEX defining loader identity changed class path or confused app and bootstrap");
}
{
  const cold = world([app, ...PLATFORM_JARS.map(j => join(AOSP, j))], { natives, cold: true, dexes: path => files.has(path) ? loadDexes(files.get(path)!) : undefined });
  useEntry(wasmEntry(cold)); rt.mkThrowable = hostThrowable;
  const result = await cold.entryAsync("Ldr", "delegateLast", desc)(...paths);
  if (result !== jsDelegate || !cold.stats.coldCalls) throw new Error(`cold delegate-last initiation: ${result}; cold calls=${cold.stats.coldCalls}`);
  useEntry(wasmEntry(w));
}
{
  const resolver = world([app, ...PLATFORM_JARS.map(j => join(AOSP, j))], { natives, dexes: path => files.has(path) ? loadDexes(files.get(path)!) : undefined });
  useEntry(wasmEntry(resolver));
  let forName: unknown;
  try { forName = await resolver.entryAsync("Ldr", "resolverForName", "(Ljava/lang/String;)I")(paths[0]); }
  catch (error) {
    const value = resolver.throwable(error);
    if (value) console.log("Class.forName fixture failure", resolver.classNameOf(value), resolver.hostString(resolver.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(value)), resolver.stackTrace(resolver.fieldReader<object>("java/lang/Throwable", "backtrace", "Ljava/lang/Object;")(value)));
    throw error;
  }
  if (forName !== 63) throw new Error(`Class.forName loader/error boundaries: ${forName}`);
  if (await resolver.entryAsync("Ldr", "resolverForNameInit", "()I")() !== 1) throw new Error("Class.forName initialization boundary failed");
  const calls = () => resolver.entryAsync("Ldr", "resolverCalls", "()I")();
  for (const mode of [0, 1, 2, 3]) {
    const object = await resolver.entryAsync("Ldr", "resolverLoader", "(Ljava/lang/String;I)Ljava/lang/ClassLoader;")(paths[0], mode) as object;
    const loader = definingLoader(resolver, object), owner = resolver.sched.strand();
    const before = await calls() as number;
    try {
      if (mode === 0) {
        const pending = resolver.resolveClass(loader, "Shared", owner);
        if (!(pending instanceof Promise)) throw new Error("loader suspension was bypassed");
        const key = await pending;
        if (resolver.resolveClass(loader, "Shared", owner) !== key || await resolver.resolveClass(loader, "[LShared;", owner) !== `[L${key};` || await calls() !== before + 1) throw new Error("successful loader initiation was not canonical");
      } else {
        const expected = mode === 1 ? "java/lang/ClassNotFoundException" : mode === 2 ? "java/lang/NullPointerException" : "java/lang/NoClassDefFoundError";
        for (let retry = 0; retry < 2; retry++) {
          try { await resolver.resolveClass(loader, "Shared", owner); throw new Error("invalid loader result accepted"); }
          catch (e) { const t = resolver.throwable(e); if (!t || resolver.classNameOf(t) !== expected) throw e; }
        }
        if (resolver.prog.initiatedBy(loader, "Shared") || await calls() !== before + 2) throw new Error("failed loader result was cached");
      }
    } finally { owner.end(); }
  }
  for (const mode of [4, 5, 6]) {
    const object = await resolver.entryAsync("Ldr", "resolverLoader", "(Ljava/lang/String;I)Ljava/lang/ClassLoader;")(paths[0], mode) as object;
    const loader = definingLoader(resolver, object), first = resolver.sched.strand(), second = resolver.sched.strand();
    try {
      if (mode === 6) {
        if (resolver.sched.monitors.tryEnter(object, first) !== St.Ok) throw new Error("resolver fixture monitor acquisition failed");
        try {
          await resolver.resolveClass(loader, "Shared", first);
          if (!resolver.sched.monitors.holds(object, first) || resolver.sched.monitors.holds(object, second)) throw new Error("resolver callback lost or borrowed unrelated monitor ownership");
        } finally { if (resolver.sched.monitors.exit(object, first) !== St.Ok) throw new Error("resolver fixture monitor release failed"); }
      } else {
        const results = await Promise.all([resolver.resolveClass(loader, "Shared", first), resolver.resolveClass(loader, "Shared", second)]);
        if (results[0] !== results[1] || results[0] !== resolver.prog.initiatedBy(loader, "Shared")) throw new Error("racing loader calls did not preserve first successful initiation");
      }
    } finally { first.end(); second.end(); }
  }
  const jni = wasmJni(resolver), previous = priorJniVm;
  setA64(false); jniInit(); useJniVm(jni);
  const name = mem.malloc(16), environment = mem.malloc(PTR);
  mem.putCstr(name, "Shared");
  try {
    for (const mode of [0, 1]) {
      const object = await resolver.entryAsync("Ldr", "resolverLoader", "(Ljava/lang/String;I)Ljava/lang/ClassLoader;")(paths[0], mode) as object;
      const loader = definingLoader(resolver, object), owner = `fixture/NativeOwner@${loader.id}`;
      resolver.prog.addClass({ name: owner, sup: "java/lang/Object", ifaces: [], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map(), dex: null, def: null }, loader);
      const cpu = new Cpu(mainThread, "loader-jni"); cpu.nativeClass = { name: owner };
      const getEnv = ldp(ldp(javaVM.addr) + 6 * PTR);
      if (await cpu.call(getEnv, [javaVM.addr, environment, 0x10006])) throw new Error("JNI fixture GetEnv failed");
      const env = ldp(environment), find = ldp(ldp(env) + 6 * PTR);
      const before = await calls() as number, handle = await cpu.call(find, [env, name]) as number;
      if (await calls() !== before + 1) throw new Error("JNI FindClass bypassed its Java loader");
      if (mode === 0) {
        const key = resolver.prog.initiatedBy(loader, "Shared");
        if (!handle || cpu.exc || jni.classOf(deref(handle, cpu))?.name !== key) throw new Error("suspended JNI FindClass lost its class or reference owner");
      } else if (handle || !cpu.exc || resolver.classNameOf(cpu.exc as object) !== "java/lang/ClassNotFoundException") throw new Error("JNI loader failure did not remain pending");
    }
  } finally { mem.free(name); mem.free(environment); useJniVm(previous); }
}
console.log(failed ? `${failed} failures` : "loaders: all pass");
process.exit(failed ? 1 : 0);
