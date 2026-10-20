// The loaders suite's native class paths: a DexClassLoader's own, parent, boot, multi-DEX and shared-library paths resolved natively (without
// entering Java's loadClass), and the removed or reordered paths and custom loaders that must keep Java's lookup.
import { readFileSync } from "node:fs";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { Program } from "../../src/wasm/compiler/program.ts";
import { T } from "../../src/wasm/compiler/wasmbin.ts";
import { wasmJni } from "../../src/wasm/host/jni.ts";
import { definingLoader, nativeClassLookup } from "../../src/wasm/link/loaders.ts";
import { program, world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { natives } from "./harness.ts";
import { PLATFORM_PATHS } from "../aosp.ts";
import type { Suite } from "./tools.ts";

/** `app` and `common` are the suite's dexes, `files` the dex each of `paths` (the class path of a DexClassLoader) names */
export async function nativePaths({ fail }: Suite, app: string, common: string, files: Map<string, string>, paths: string[]): Promise<void> {
  const appPath = "/data/local/tmp/native-path-app.dex";
  vfs.mount(appPath, new BytesFile(new Uint8Array(readFileSync(app))));
  {
    const base = program([...PLATFORM_PATHS, common]);
    const appDexes = loadDexes(app), p = new Program(appDexes, base), target = world(p, { natives, loop: { due: () => false, yield: () => Promise.resolve(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, dexes: path => path === appPath ? appDexes : files.has(path) ? loadDexes(files.get(path)!) : undefined });
    let managed = 0;
    const callFn = target.helpers.callFn;
    target.helpers.callFn = function (name, ...args) { if (name.startsWith("resolve:load:")) managed++; return callFn.call(this, name, ...args); };
    const construct = async (cls = "dalvik/system/DexClassLoader", path = paths[0], parent: object | null = null) => {
      const desc = cls.includes("$") ? "(Ljava/lang/String;Ljava/lang/ClassLoader;)V" : "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V";
      const ctor = p.resolve(cls, "<init>", desc)!;
      const make = target.helpers.callFn("native-path:" + cls, ["L", "L"], "L", (cx, c, arg) => {
        cx.emitEnsure(c, cls); cx.emitNew(c, cls); const o = c.newLocal(T.anyref); c.ltee(o); arg(0);
        if (!cls.includes("$")) c.anyNull().anyNull(); arg(1);
        cx.callMethod(c, ctor); c.lget(o);
      });
      const strand = target.sched.strand();
      try { return await make(strand, target.javaString(path), parent) as object; } finally { strand.end(); }
    };
    const set = (obj: object, cls: string, field: string, desc: string, value: object | null) => target.helpers.hostFn("native-path:set:" + cls + field, ["L", "L"], "V", (cx, c) => {
      const st = cx.structFor(cls); c.lget(0).refCast(st).lget(1).structSet(st, cx.fieldIndex(cls, {owner:cls, name:field, desc}));
    })(obj, value);
    const appPeer = await construct("dalvik/system/DexClassLoader", appPath), appLoader = definingLoader(target, appPeer);
    if (appLoader !== p.root || nativeClassLookup(target, appLoader, "Ldr$MemberLoader") !== "Ldr$MemberLoader") fail("root app path was not recognized");
    const jni = wasmJni(target), classLoader = jni.find("java/lang/ClassLoader", null)!;
    for (const name of ["java/io/PrintStream", "java/io/ByteArrayOutputStream"]) {
      if (p.initiatedBy(appLoader, name)) fail("JNI loader fixture class was already initiated");
      const mirror = await jni.invoke(classLoader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", false, appPeer, [jni.string(name)], false);
      if (jni.classOf(mirror)?.name !== name || p.initiatedBy(appLoader, name) !== name) fail("JNI loadClass lost the native platform lookup");
    }
    managed = 0; const appStrand = target.sched.strand();
    try {
      const key = target.resolveClass(appLoader, "Ldr$MemberLoader", appStrand);
      if (key !== "Ldr$MemberLoader" || managed) fail("root app resolution entered managed loadClass");
    } finally { appStrand.end(); }
    const peer = await construct(), loader = definingLoader(target, peer);
    const expected = p.definedBy(loader, "Shared")!;
    if (nativeClassLookup(target, loader, "Shared") !== expected) fail("native path lookup not exercised");
    managed = 0;
    const strand = target.sched.strand();
    let resolved;
    try { resolved = target.resolveClass(loader, "Shared", strand); if (resolved instanceof Promise) fail("ordinary native definition unexpectedly waited"); } finally { strand.end(); }
    if (resolved !== expected || managed) fail("native resolution entered managed loadClass");
    const child = await construct("dalvik/system/DexClassLoader", paths[1], peer), childLoader = definingLoader(target, child);
    const childSub = p.definedBy(childLoader, "Sub");
    if (nativeClassLookup(target, childLoader, "Sub") !== childSub) fail("nested live path lost its definition");
    if (nativeClassLookup(target, childLoader, "Shared") !== expected) fail("parent native identity lost");
    const boot = p.definedBy(p.boot, "java/util/BitSet");
    if (nativeClassLookup(target, childLoader, "java/util/BitSet") !== boot) fail("boot native identity lost");
    managed = 0; const inherited = target.sched.strand();
    try { if (await target.resolveClass(childLoader, "Sub", inherited) !== childSub || await target.resolveClass(childLoader, "Shared", inherited) !== expected || await target.resolveClass(childLoader, "java/util/BitSet", inherited) !== boot) fail("native ancestor resolution changed"); } finally { inherited.end(); }
    if (managed) fail("native ancestor lookup entered Java");
    const multi = await construct("dalvik/system/DexClassLoader", paths.join(":")), multiLoader = definingLoader(target, multi);
    const multiSub = p.definedBy(multiLoader, "Sub");
    if (nativeClassLookup(target, multiLoader, "Sub") !== multiSub) fail("later live DEX lookup failed");
    managed = 0; const later = target.sched.strand();
    try { if (await target.resolveClass(multiLoader, "Sub", later) !== multiSub || managed) fail("later DEX resolution entered Java"); }
    finally { later.end(); }
    const inactive = await construct(), inactiveLoader = definingLoader(target, inactive);
    const path = target.helpers.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(inactive);
    set(path, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava([], "[Ldalvik/system/DexPathList$Element;") as object);
    if (nativeClassLookup(target, inactiveLoader, "Shared")) fail("metadata-only class bypassed the live path");
    managed = 0;
    const blocked = target.sched.strand();
    try { await target.resolveClass(inactiveLoader, "Shared", blocked); fail("empty live path resolved Shared"); }
    catch (e) { const t = target.throwable(e); if (!t || target.classNameOf(t) !== "java/lang/ClassNotFoundException") throw e; }
    finally { blocked.end(); }
    if (!managed) fail("empty path skipped canonical loader failure");
    const reordered = await construct("dalvik/system/DexClassLoader", paths.join(":")), reorderedLoader = definingLoader(target, reordered);
    const reorderedPath = target.helpers.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(reordered);
    const elements = target.helpers.fieldReader<object>("dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;")(reorderedPath);
    const reversed = [];
    for (let i = target.bridge.arrayLength(elements) - 1; i >= 0; i--) reversed.push(target.bridge.toHost(target.bridge.element(elements, i)));
    set(reorderedPath, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava(reversed, "[Ldalvik/system/DexPathList$Element;") as object);
    if (nativeClassLookup(target, reorderedLoader, "Shared")) fail("reordered path accepted stale metadata winner");
    managed = 0; const reorderedStrand = target.sched.strand();
    try { await target.resolveClass(reorderedLoader, "Shared", reorderedStrand); } finally { reorderedStrand.end(); }
    if (!managed) fail("reordered path skipped managed lookup");
    const custom = await construct("Ldr$MemberLoader");
    if (nativeClassLookup(target, definingLoader(target, custom), "Shared")) fail("custom subclass accepted natively");
    const customChild = await construct("dalvik/system/DexClassLoader", paths[1], custom);
    if (nativeClassLookup(target, definingLoader(target, customChild), "Sub")) fail("custom parent delegation bypassed");
    const sharing = await construct(), sharingLoader = definingLoader(target, sharing);
    const libraries = (peers: (object | null)[]) => target.bridge.toJava(peers.map(peer => peer && target.bridge.toHost(peer)), "[Ljava/lang/ClassLoader;") as object;
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== p.definedBy(sharingLoader, "Shared")) fail("empty shared graph blocked its own path");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([null]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== p.definedBy(sharingLoader, "Shared")) fail("null shared loader boot miss blocked its own path");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([custom]));
    if (nativeClassLookup(target, sharingLoader, "Shared")) fail("custom shared delegation bypassed");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([peer]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== expected) fail("live shared-before precedence lost");
    managed = 0; const shared = target.sched.strand();
    try { if (await target.resolveClass(sharingLoader, "Shared", shared) !== expected || managed) fail("shared-before resolution entered Java"); }
    finally { shared.end(); }
    const afterPeer = await construct(), afterLoader = definingLoader(target, afterPeer);
    const afterPath = target.helpers.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(afterPeer);
    set(afterPath, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava([], "[Ldalvik/system/DexPathList$Element;") as object);
    set(afterPeer, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoadersAfter", "[Ljava/lang/ClassLoader;", libraries([peer]));
    if (nativeClassLookup(target, afterLoader, "Shared") !== expected) fail("live shared-after path lost");
    managed = 0; const after = target.sched.strand();
    try { if (await target.resolveClass(afterLoader, "Shared", after) !== expected || managed) fail("shared-after resolution entered Java"); }
    finally { after.end(); }

  }
  console.log("native loader paths: app-root, multi-DEX, parent, boot and live shared-before/after identities; removed/reordered paths and custom graphs retain Java lookup");
}
