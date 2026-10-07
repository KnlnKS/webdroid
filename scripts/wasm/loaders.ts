// Class loaders: two DexClassLoaders over dex files that define the same class name (tests/fixtures/wasm/java/Ldr.java) keep distinct classes, statics and Class
// objects, see the app's interface through their parent, and answer Class.forName, loadClass, getClassLoader and reflection each in its own namespace.
// Needs javac and d8. Run: bun run wasm loaders
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { BytesFile } from "../../src/shell/lazyfile";
import { vfs } from "../../src/shell/vfs";
import { PackedArchive, packedArchives, sha256 } from "../../src/shell/packedarchive";
import { loadDexes, program, world } from "./lib";
import { Program, ACC, javaName, type JClass } from "../../src/wasm/compiler/program";
import { COUNT_BASE, HOT_BUDGET } from "../../src/wasm/link/exc";
import { mid } from "../../src/wasm/compiler/ids";
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
import { prepareMethod } from "../../src/jvm/prepared";
import { Pool, u2, u4 } from "./classfile";
import { Compiler } from "../../src/wasm/compiler/j2w";
import { typeFailure, symbolicImplFor } from "../../src/wasm/compiler/linkage";
import type { Code } from "../../src/wasm/compiler/code";
import { ColdSlowOps, SYMBOLIC_ANALYSIS_METHODS, SYMBOLIC_ANALYSIS_CELLS } from "../../src/wasm/cold/slowops";
import { St } from "../../src/wasm/link/monitor";
import { canAccess } from "../../src/wasm/link/classes";
import { HOSTED } from "../../src/wasm/link/hostapi";
import { hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { useEntry } from "../../src/jvm/natives/jentry";
import { rt } from "../../src/jvm/runtime";
import { mangleMethod } from "../../src/jvm/abi";
import { callOn } from "../../src/jvm/natives/jentry";
import { jvmProfiler } from "../../src/jvm/profile";
import { perf } from "../../src/perf";
import { jsTier, natives } from "./oracle";
import { AOSP, JAVA } from "./paths";
import { shellIn } from "./tools";

import { androidPlatform, androidTool } from "../android-sdk";

const out = mkdtempSync(join(tmpdir(), "j2w-ldr-"));
const sh = shellIn(out), androidJar = `${androidPlatform(35)}/android.jar`;
/** compiles `sources` (against the Android API and `classpath`) and dexes the classes; answers the dex */
const build = (dir: string, sources: string[], classpath?: string) => {
  sh(["mkdir", "-p", dir]);
  sh(["javac", "--release", "11", "-Xlint:-options", "-cp", [androidJar, classpath].filter(Boolean).join(":"), "-d", join(out, dir), ...sources.map((s) => join(JAVA, s))]);
  if (dir === "b") {
    const p = new Pool(), self = p.cls("TypeSite"), sup = p.cls("java/lang/Object");
    const method = (name: string, descriptor: string) => {
      const code = [0x13, ...u2(p.methodType(descriptor)), 0xb0], body = [...u2(1), ...u2(0), ...u4(code.length), ...code, ...u2(0), ...u2(0)];
      return [...u2(9), ...u2(p.utf8(name)), ...u2(p.utf8("()Ljava/lang/invoke/MethodType;")), ...u2(1), ...u2(p.utf8("Code")), ...u4(body.length), ...body];
    };
    const methods = [method("value", "(LShared;)LShared;"), method("missing", "()LAbsentOptional;")];
    writeFileSync(join(out, dir, "TypeSite.class"), Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61, ...u2(p.count), ...p.bytes, ...u2(0x21), ...u2(self), ...u2(sup), ...u2(0), ...u2(0), ...u2(methods.length), ...methods.flat(), ...u2(0)]));
  }
  sh([androidTool("d8"), "--min-api", dir === "b" ? "34" : "26", "--output", join(out, dir), "--lib", androidJar, ...(classpath?.split(":").flatMap(path => ["--classpath", path]) ?? []), ...readdirSync(join(out, dir), { recursive: true, encoding: "utf8" }).filter(path => /\.class$/.test(path)).map(path => join(out, dir, path)).filter(path => !/\/(AbsentOptional|MissingCatch|UnusedMemberType)\.class$/.test(path))]);
  return join(out, dir, "classes.dex");
};
if (process.argv.includes("--abstract-default")) { await abstractDefaultControl(); process.exit(0); }
if (process.argv.includes("--super")) { await interfaceSuperControl(); await abstractDefaultControl(); process.exit(0); }
const app = build("app", ["Ldr.java", "Tag.java", "MemorySites.java"]);
const common = build("common", ["Tag.java"]), layeredApp = build("layeredapp", ["Ldr.java"], join(out, "app"));
const a = build("a", ["ldr1/Shared.java", "ldr1/Boom.java", "members1/pack/PackageBase.java", "members1/pack/PackageType.java", "members1/MemberBase.java", "members1/MemberContract.java", "members1/MemberType.java"], join(out, "app")), b = build("b", ["ldr2/Shared.java", "ldr2/Boom.java", "ldr2/Sub.java", "members2/pack/PackageChild.java", "members2/pack/PackagePrivateChild.java", "members2/pack/PackageType.java", "members2/MemberUse.java", "members2/MemberOverride.java", "members2/MemberImplementation.java", "members2/MemberType.java"], [join(out, "app"), join(out, "a")].join(":"));
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

{
  const path = "/data/app/loader-packed/base.apk", first = new Uint8Array(readFileSync(a)), second = new Uint8Array(readFileSync(b));
  const zip = zipSync({ "classes2.dex": second, "classes.dex": first, "assets/unused": new Uint8Array([1, 2, 3]) });
  const files = new Map<string, Uint8Array>(), requests: string[] = [], fetchBefore = globalThis.fetch;
  const file = async (bytes: Uint8Array) => { const hash = await sha256(bytes), name = `${hash}.bin`; files.set(`/packed-loader/${name}`, bytes); return { file: name, size: bytes.length, sha256: hash }; };
  const bootstrap = await file(zipSync({ "AndroidManifest.xml": new Uint8Array([0]) })), one = await file(first), two = await file(second), raw = await file(zip);
  const packed = new PackedArchive({ version: 1, pkg: "loader-packed", sha256: raw.sha256, size: zip.length, certificates: [], bootstrap,
    entries: { "classes2.dex": two, "classes.dex": one }, spans: [[0, zip.length, raw.file, 0]] }, "/packed-loader/");
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input), bytes = files.get(url.split("?")[0]); requests.push(url);
    if (!bytes) throw new Error(`unexpected packed fixture request: ${url}`);
    return new Response(new Uint8Array(bytes).buffer);
  }) as typeof fetch;
  packedArchives.set(path, packed); vfs.mount(path, packed);
  try {
    const result = await openDexes(path, ownDexes, opened);
    if (result?.map(d => d.id).join() !== [...loadDexes(a), ...loadDexes(b)].map(d => d.id).join()) throw new Error("packed DEX precedence changed");
    if (requests.some(url => url.includes("?raw=")) || requests.length !== 3) throw new Error("packed loader read the whole archive instead of its DEX entries");
    if (await openDexes(path, ownDexes, opened) !== result || requests.length !== 3) throw new Error("packed DEX cache lost identity");
    console.log("packed loader: ordered DEX entries and bootstrap only; cached identity preserved");
  } finally { globalThis.fetch = fetchBefore; packedArchives.delete(path); vfs.delete(path, false); }
}

// the files the loaders open: libcore finds them through the file system, the World reads their dex
const files = new Map([["/data/local/tmp/a.dex", a], ["/data/local/tmp/b.dex", b]]);
for (const [path, file] of files) vfs.mount(path, new BytesFile(new Uint8Array(readFileSync(file))));
const js = await jsTier(loadDexes(app));
const w = world([app, ...PLATFORM_JARS.map((j) => join(AOSP, j))], { ...(process.argv.includes("--cold") && { cold: true }), natives, dexes: (path) => (files.has(path) ? loadDexes(files.get(path)!) : undefined) });

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
const memberExpected = await js("Ldr", "memberResolution", desc, paths);
const memberResult = await w.entryAsync("Ldr", "memberResolution", desc)(...paths);
if (memberExpected !== 31 || memberResult !== memberExpected) throw new Error(`binary member descriptors: js=${memberExpected}, wasm=${memberResult}, expected=31`);
console.log(`binary member descriptors: js=${memberExpected}, wasm=${memberResult}; denied type retries, unused prototype stays lazy, declaring reflection identity preserved`);
if (!process.argv.includes("--member-only") || process.argv.includes("--constraints")) {
  for (const method of ["memberConstraints", "memberInterfaceConstraints", "memberIndirectConstraints", "memberReentrantConstraints"]) {
    const baseline = await js("Ldr", method, desc, paths);
    const result = await w.entryAsync("Ldr", method, desc)(...paths);
    console.log(`${method}: js=${baseline}, wasm=${result}, expected=255`);
    if (result !== 255) throw new Error(`${method}: ${result}`);
  }
}
if (!process.argv.includes("--member-only") || process.argv.includes("--constraints")) {
  for (const method of ["memberHostRetry", "memberHostWaitRetry"]) {
    const original = w.javaString, hostFn = w.hostFn, failure = new Error("constraint host failure");
    let injected = false;
    if (method === "memberHostRetry") w.javaString = function(value: string) {
      if (!injected && value === "MemberType") { injected = true; throw failure; }
      return original.call(this, value);
    };
    else w.hostFn = function(...args: Parameters<typeof hostFn>) {
      const fn = hostFn.apply(this, args);
      return args[0] !== "resolve:classId" ? fn : (...values: unknown[]) => {
        const id = fn(...values);
        if (!injected && javaName(w.nameOf(id)) === "MemberType") { injected = true; throw failure; }
        return id;
      };
    };
    try {
      let caught: unknown;
      try { await w.entryAsync("Ldr", method, desc)(...paths); } catch (error) { caught = error; }
      if (caught !== failure || !injected) throw new Error(`${method}: signature host failure changed kind`);
    } finally { w.javaString = original; w.hostFn = hostFn; }
    const retry = await w.entryAsync("Ldr", method, desc)(...paths);
    if (retry !== 7) throw new Error(`${method}: signature host failure prevented retry: ${retry}`);
    console.log(`${method}: original host error propagated, same class retries successfully`);
  }
}
if (!process.argv.includes("--member-only") || process.argv.includes("--package")) {
  sh(["mkdir", "-p", "witness"]);
  sh(["javac", "--release", "11", "-d", join(out, "witness"), join(JAVA, "PackageLoaderControl.java")]);
  const control = sh(["java", "-cp", join(out, "witness"), "PackageLoaderControl", join(out, "a"), join(out, "b")]).trim();
  if (control !== "1122\n1122\n2222\n112222\n112222\n222222") throw new Error(`package runtime-package JDK control: ${control}`);
  console.log(`package runtime-package JDK control: ${control.replaceAll("\n", ",")}`);
  for (const ownType of [true, false]) {
    const signature = "(Ljava/lang/String;Ljava/lang/String;Z)I", args = [...paths, ownType];
    const result = await w.entryAsync("Ldr", "packageMembers", signature)(...args);
    const baseline = await js("Ldr", "packageMembers", signature, args);
    console.log(`package-private dispatch ownType=${ownType}: js=${baseline}, wasm=${result}, expected=1122`);
    if (result !== 1122) throw new Error(`package-private dispatch: ${result}`);
  }
  const same = await w.entryAsync("Ldr", "packageSameLoader", desc)(...paths);
  if (same !== 2222) throw new Error(`same-loader package-private override: ${same}`);
  console.log(`same-loader package-private override: wasm=${same}, jdk=2222`);
  for (const ownType of [true, false]) {
    const result = await w.entryAsync("Ldr", "packagePrivateMembers", "(Ljava/lang/String;Ljava/lang/String;Z)I")(...paths, ownType);
    console.log(`package-private child ownType=${ownType}: wasm=${result}, jdk=112222 (inherited11, own22, reflective22)`);
    if (result !== 112222) throw new Error(`package-private child slot: ${result}`);
  }
  const privateSame = await w.entryAsync("Ldr", "packagePrivateSameLoader", desc)(...paths);
  if (privateSame !== 222222) throw new Error(`same-loader package-private child slot: ${privateSame}`);
  console.log(`same-loader package-private child: wasm=${privateSame}, jdk=222222`);
  const packageOwners = [...w.prog.all()].filter(c => javaName(c.name) === "pack/PackageBase");
  for (const [index, flags] of [0, ACC.PRIVATE, ACC.PROTECTED].entries()) {
    const owner = packageOwners[index].name;
    const method = w.prog.require(owner).methods.find(m => m.name === "foo")!, original = method.flags;
    method.flags = flags;
    try {
      const selector = w.selectorId(method.key), slot = w.host.imtMiss(w.idOf(owner), selector) as number;
      const call = w.hostFn(`interface-access:${flags}`, ["L", "L"], "I", (cx, c) => c.lget(0).lget(1).i32(slot).callIndirect(cx.sig(["L", "L"], "I")));
      let error: unknown;
      const strand = w.sched.strand();
      try { await strand.call(call, null, null); } catch (e) { error = e; } finally { strand.end(); }
      const throwable = w.throwable(error);
      if (!throwable || w.classNameOf(throwable) !== "java/lang/IllegalAccessError") throw new Error(`nonpublic IMT implementation accepted: ${flags}`);
    } finally { method.flags = original; }
  }
  console.log("nonpublic IMT miss: package/private/protected rejected with IllegalAccessError");
}
if (process.argv.includes("--member-only")) process.exit(0);
if (!process.argv.includes("--catch-only") && (!process.argv.includes("--symbolic") || process.argv.includes("--hierarchy"))) {
  const expected = await js("Ldr", "hierarchyDelegateLast", desc, paths);
  const result = await w.entryAsync("Ldr", "hierarchyDelegateLast", desc)(...paths);
  if (expected !== 7 || result !== expected) throw new Error(`defining hierarchy mirrors: js=${expected}, wasm=${result}, expected=7`);
  console.log(`defining hierarchy mirrors: js=${expected}, wasm=${result}`);
  if (process.argv.includes("--hierarchy")) process.exit(0);
}
if (!process.argv.includes("--hierarchy")) {
  const caught = await w.entryAsync("Ldr", "catchResolution", "(Ljava/lang/String;)I")(paths[1]);
  if (caught !== 31) throw new Error(`executed catch loader: wasm=${caught}, expected=31`);
  console.log("executed catch loader: wasm=31; untaken handler types stay lazy, suspended denial retries, successful identity stays cached, missing types preserve the original exception");
  {
    const boot = world(new Program([], program([...PLATFORM_JARS.map(j => join(AOSP, j)), common, b])), { natives, cold: false });
    if (boot.prog.loaderOf("Shared") !== boot.prog.boot) throw new Error("catch fixture is not boot-defined");
    const select = boot.entry("Shared", "catchOnly", "(Z)I");
    if (select(0) !== 7 || boot.prog.initiatedBy(boot.prog.boot, "CatchOnly")) throw new Error("untaken boot catch resolved its type");
    if (select(1) !== 42 || await boot.entryAsync("Shared", "catchOnly", "(Z)I")(1) !== 42) throw new Error("compiled boot catch did not preserve the original throwable");
    if (boot.prog.initiatedBy(boot.prog.boot, "CatchOnly") !== "CatchOnly" || boot.prog.initiatedBy(boot.prog.boot, "MissingCatch")) throw new Error("executed boot catches did not retain only successful resolution");
    if (boot.stats.coldMethods || !boot.stats.methods) throw new Error("boot catch fixture did not run compiled code");
    console.log("compiled boot catch: plain and strand select RuntimeException after missing/nonmatching catch types; cold methods 0");
  }
  if (process.argv.includes("--catch-only")) process.exit(0);
  const actualType = await w.entryAsync("Ldr", "typeDelegateLast", desc)(...paths);
  if (actualType !== 7) throw new Error(`executed method-type loader: wasm=${actualType}, expected=7`);
  console.log("executed method-type loader: wasm=7; unused optional signature stays lazy (JS const-method-type unsupported)");
  const expected = await js("Ldr", "symbolicDelegateLast", desc, paths);
  const result = await w.entryAsync("Ldr", "symbolicDelegateLast", desc)(...paths);
  if (expected !== 42 || result !== expected) throw new Error(`uninitiated symbolic class reference: js=${expected}, wasm=${result}, expected=42`);
  const object = await w.entryAsync("Ldr", "symbolicLoader", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/ClassLoader;")(...paths) as object;
  const owner = w.sched.strand();
  let key: string;
  try { key = await w.resolveClass(definingLoader(w, object), "Shared", owner); } finally { owner.end(); }
  if (process.argv.includes("--promotion-copies")) {
    const loader = w.prog.loaderOf(key), method = w.prog.require(key).byKey.get("symbolic()I")!;
    const helperKey = w.prog.lookup(loader, "SymbolicHelper")!, helper = w.prog.require(helperKey).byKey.get("value()I")!;
    if (w.prog.initiatedBy(loader, "SymbolicHelper")) throw new Error("copy fixture helper already initiated");
    const slot = w.slotOf(method), helperSlot = w.slotOf(helper);
    await w.host.link(slot); await w.host.link(helperSlot);
    new Int32Array(w.mem.buffer, COUNT_BASE + 4 * helperSlot, 1)[0] = HOT_BUDGET;
    const before = w.upgradeJob(slot);
    if (!before || [...before.installed, ...before.copies].includes(mid(helper))) throw new Error("symbolic promotion selected an unresolved local copy");
    if (w.prog.initiatedBy(loader, "SymbolicHelper")) throw new Error("promotion eagerly initiated its helper");
    const strand = w.sched.strand();
    let resolved: string;
    try { resolved = await w.resolveClass(loader, "SymbolicHelper", strand); } finally { strand.end(); }
    const winner = w.prog.require(resolved).byKey.get("value()I")!, winnerSlot = w.slotOf(winner);
    await w.host.link(slot); await w.host.link(winnerSlot);
    new Int32Array(w.mem.buffer, COUNT_BASE + 4 * winnerSlot, 1)[0] = HOT_BUDGET;
    const after = w.upgradeJob(slot);
    if (!after?.copies.includes(mid(winner)) || resolved !== helperKey && after.copies.includes(mid(helper))) throw new Error("promotion did not recheck the Java loader's winning helper");
    if (await w.entryAsync(key, "symbolic", "()I")() !== expected) throw new Error("copy fixture changed Java result");
    console.log("promotion copies: unresolved helper excluded without loading; initiated helper copied on next selection; js=wasm=42");
    process.exit(0);
  }
  const handedData: WeakRef<object>[] = [], handingCompilers: WeakRef<object>[] = [];
  const buildUnit = Compiler.prototype.buildUnit;
  if (process.argv.includes("--memory")) Compiler.prototype.buildUnit = function (...args: Parameters<typeof buildUnit>) {
    const built = buildUnit.apply(this, args);
    const method = w.prog.require(key).byKey.get("symbolic()I")!, analysis = this.methodAnalyses.get(method);
    if (analysis) { handingCompilers.push(new WeakRef(this)); handedData.push(new WeakRef(analysis.prepared), new WeakRef(analysis.typing)); }
    return built;
  };
  const typingBefore = w.stats.symbolicTypingMethods, hitsBefore = w.stats.symbolicAnalysisHits;
  let call: ReturnType<typeof w.entryAsync>;
  try {
    call = w.entryAsync(key, "symbolic", "()I");
    if (await call() !== 42) throw new Error("symbolic direct entry failed");
  } finally { Compiler.prototype.buildUnit = buildUnit; }
  console.log(`symbolic first-call analysis: inferences=${w.stats.symbolicTypingMethods - typingBefore}, hits=${w.stats.symbolicAnalysisHits - hitsBefore}; workload total inferences=${w.stats.symbolicTypingMethods}, hits=${w.stats.symbolicAnalysisHits}`);
  const resolutions = w.symbolicResolutions, stubModules = w.symbolicStubModules;
  for (let i = 0; i < 3; i++) if (await call() !== 42) throw new Error("cached symbolic operation failed");
  if (!w.opts.cold && w.symbolicResolutions !== resolutions) throw new Error("resolved symbolic site entered the loader bridge again");
  if (w.symbolicStubModules !== stubModules) throw new Error("warm symbolic operation rebuilt stub modules");
  console.log(`symbolic cache: first resolutions=${resolutions}, stub modules=${stubModules}; repeat resolutions=${w.symbolicResolutions - resolutions}, stub modules=${w.symbolicStubModules - stubModules}`);
  if (!w.opts.cold) {
    const method = w.prog.require(key).byKey.get("symbolic()I")!;
    const ins = prepareMethod(method.dex, method.dex.code(method.codeOff), method.desc, method.isStatic).instructions.find(ins => ins.name === "invoke-static")!;
    const before = { ...w.stats }, symbols = w.symbolicImports([["accounting:probe", key, method.index, ins.pc, [], "I"]]);
    if (w.stats.units !== before.units + 1 || w.stats.bytes <= before.bytes || w.stats.compileMs <= before.compileMs || !w.traces.has("$accounting:probe")) throw new Error("symbolic stub compilation unaccounted");
    const table = symbols.table as WebAssembly.Table, slot = (symbols["accounting:probe"] as WebAssembly.Global).value as number;
    const stub = { ...w.stats };
    if (table.get(slot)!() !== 42) throw new Error("accounted symbolic operation failed");
    const trace = w.traces.get(`$symbolic:${key}:${method.index}:${ins.pc}`);
    if (w.stats.units !== stub.units + 1 || w.stats.bytes <= stub.bytes || w.stats.compileMs <= stub.compileMs || !trace) throw new Error("symbolic operation compilation unaccounted");
    const warm = { ...w.stats };
    if (table.get(slot)!() !== 42 || w.stats.units !== warm.units || w.stats.bytes !== warm.bytes || w.stats.compileMs !== warm.compileMs) throw new Error("warm symbolic operation compiled again");
    console.log("symbolic accounting: stub and operation each recorded one unit, bytes and traces; warm execution unchanged");
    const later = "fixture/HelperLater", helperBody = (cx: Compiler, c: Code) => {
      const failure = typeFailure(cx.w.prog, `L${later};`);
      if (failure) cx.linkError(c, failure); else c.i32(42);
    };
    const helper = w.hostFn("helper:late:sync", [], "I", helperBody);
    const waitingHelper = w.callFn("helper:late:async", [], "I", helperBody);
    const checkMissing = (error: unknown) => {
      const value = w.throwable(error);
      if (!value || w.classNameOf(value) !== "java/lang/NoClassDefFoundError") throw error;
    };
    let syncFailed = false, asyncFailed = false;
    try { w.unwound(() => helper()); } catch (error) { checkMissing(error); syncFailed = true; }
    const strand = w.sched.strand();
    try { await waitingHelper(strand); } catch (error) { checkMissing(error); asyncFailed = true; } finally { strand.end(); }
    if (!syncFailed || !asyncFailed || w.absent.get(later)?.size !== 2) throw new Error("helper dependencies lack invalidation slots");
    w.addClass({ name: later, sup: "java/lang/Object", ifaces: [], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map(), dex: null, def: null }, new Map());
    const resumed = w.sched.strand();
    try {
      if (helper() !== 42 || await waitingHelper(resumed) !== 42) throw new Error("retained helper did not recover after class arrival");
      const units = w.stats.units;
      if (helper() !== 42 || await waitingHelper(resumed) !== 42 || w.stats.units !== units) throw new Error("warm helper recompiled");
    } finally { resumed.end(); }
    console.log("helper accounting: two owned absence slots recover cached sync/strand functions after class arrival; warm calls unchanged");
    const accountingWorld = world(w.prog, { natives }), initial = { ...accountingWorld.stats };
    const throwable = accountingWorld.makeThrowable("java/lang/IllegalStateException", "accounted helper");
    if (accountingWorld.stats.units <= initial.units || accountingWorld.stats.bytes <= initial.bytes || accountingWorld.stats.compileMs <= initial.compileMs || !accountingWorld.traces.has("$mk:java/lang/IllegalStateException")) throw new Error("throwable helper compilation unaccounted");
    const beforeReader = { ...accountingWorld.stats }, reader = accountingWorld.fieldReader<object | null>("java/lang/Throwable", "detailMessage", "Ljava/lang/String;");
    if (accountingWorld.stats.units !== beforeReader.units + 1 || accountingWorld.stats.bytes <= beforeReader.bytes || accountingWorld.stats.compileMs <= beforeReader.compileMs || !accountingWorld.traces.has("$get:java/lang/Throwable.detailMessage:Ljava/lang/String;")) throw new Error("field reader compilation unaccounted");
    if (accountingWorld.hostString(reader(throwable)!) !== "accounted helper") throw new Error("accounted throwable detail changed");
    const warmHelpers = { ...accountingWorld.stats };
    const again = accountingWorld.makeThrowable("java/lang/IllegalStateException", null);
    if (reader(again) !== null || accountingWorld.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;") !== reader || accountingWorld.stats.units !== warmHelpers.units || accountingWorld.stats.bytes !== warmHelpers.bytes || accountingWorld.stats.compileMs !== warmHelpers.compileMs) throw new Error("warm throwable or reader helper compiled again");
    console.log("helper accounting: throwable and field reader record units, bytes and traces; warm calls unchanged");
    if (process.argv.includes("--memory")) {
      const analyses: WeakRef<object>[] = [], compilers: WeakRef<object>[] = [], seen = new WeakSet<object>();
      let probeOps: ColdSlowOps | undefined;
      const prepare = ColdSlowOps.prototype.prepareSite, emit = Compiler.prototype.buildSynthetic, group = Compiler.prototype.buildSyntheticGroup;
      ColdSlowOps.prototype.prepareSite = function (...args: Parameters<typeof prepare>) { const site = prepare.apply(this, args); probeOps = this; if (!seen.has(site.analysis)) { seen.add(site.analysis); analyses.push(new WeakRef(site.analysis)); } return site; };
      Compiler.prototype.buildSynthetic = function (...args: Parameters<typeof emit>) { compilers.push(new WeakRef(this)); return emit.apply(this, args); };
      Compiler.prototype.buildSyntheticGroup = function (...args: Parameters<typeof group>) { compilers.push(new WeakRef(this)); return group.apply(this, args); };
      const before = w.stats.symbolicTypingMethods;
      try {
        const bindings = w.symbolicImports(Array.from({ length: 32 }, (_, i) => [`memory:${i}`, key, method.index, ins.pc, [], "I"]));
        if (w.stats.symbolicTypingMethods !== before) throw new Error("stub declaration inferred full method IR again");
        for (let i = 0; i < 32; i++) {
          const slot = (bindings[`memory:${i}`] as WebAssembly.Global).value as number;
          if ((bindings.table as WebAssembly.Table).get(slot)!() !== 42) throw new Error("memory probe operation failed");
        }
        if (w.stats.symbolicTypingMethods - before > 1) throw new Error("ordinary analysis repeated per site");
        const varied = w.prog.require("MemorySites").byKey.get("run()I")!, code = varied.dex.code(varied.codeOff);
        const pcs = prepareMethod(varied.dex, code, varied.desc, varied.isStatic).instructions.filter(ins => ins.name === "invoke-static").map(ins => ins.pc);
        const inferences = w.stats.symbolicTypingMethods, hits = w.stats.symbolicAnalysisHits;
        for (const pc of pcs) probeOps!.prepareSite(varied, pc);
        if (pcs.length !== 32 || w.stats.symbolicTypingMethods - inferences !== 1 || w.stats.symbolicAnalysisHits - hits !== 31) throw new Error("distinct PCs repeated full method inference");
        let pressure = 0;
        for (const candidate of w.prog.require("Ldr").methods) if (candidate.codeOff) {
          const item = candidate.dex.code(candidate.codeOff), prepared = prepareMethod(candidate.dex, item, candidate.desc, candidate.isStatic);
          if (item.insns.length + (prepared.instructions.length + 1) * (item.regs + 16) > SYMBOLIC_ANALYSIS_CELLS) continue;
          probeOps!.prepareSite(candidate, prepared.instructions[0].pc);
          if (++pressure === SYMBOLIC_ANALYSIS_METHODS + 1) break;
        }
        if (pressure <= SYMBOLIC_ANALYSIS_METHODS || w.stats.symbolicAnalysisPeakEntries > SYMBOLIC_ANALYSIS_METHODS || w.stats.symbolicAnalysisPeakCells > SYMBOLIC_ANALYSIS_CELLS) throw new Error("ordinary analysis cache exceeds its retention budget");
      } finally {
        ColdSlowOps.prototype.prepareSite = prepare; Compiler.prototype.buildSynthetic = emit; Compiler.prototype.buildSyntheticGroup = group;
      }
      const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      if (!collect || analyses.length !== SYMBOLIC_ANALYSIS_METHODS + 3 || compilers.length !== 33) throw new Error(`symbolic lifetime probe missing emitters or GC: analyses=${analyses.length}, compilers=${compilers.length}, gc=${!!collect}`);
      console.log(`symbolic analysis work: 32 distinct PCs use one full inference and 31 cache hits; peak entries=${w.stats.symbolicAnalysisPeakEntries}, peak cells=${w.stats.symbolicAnalysisPeakCells}, hits=${w.stats.symbolicAnalysisHits}, oversize=${w.stats.symbolicAnalysisOversize}`);
      const heapBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); collect(); }
      const retained = analyses.filter(ref => ref.deref()).length, retainedCompilers = compilers.filter(ref => ref.deref()).length;
      console.log(`symbolic lifetime: analyses=${analyses.length}, retained=${retained}; compilers=${compilers.length}, retained=${retainedCompilers}; heap before GC=${heapBefore}, after GC=${process.memoryUsage().heapUsed}`);
      if (retained > SYMBOLIC_ANALYSIS_METHODS || analyses[0].deref() || retainedCompilers || w.prog.require(key).byKey.get("symbolic()I") !== method || table.get(slot)!() !== 42) throw new Error("symbolic IR retained by live Program or compiled operation");
      const heldCompilers = handingCompilers.filter(ref => ref.deref()).length, heldData = handedData.filter(ref => ref.deref()).length;
      console.log(`compiler typing handoff lifetime: compilers=${handingCompilers.length}, retained=${heldCompilers}; data=${handedData.length}, retained after eviction=${heldData}`);
      if (handingCompilers.length !== 1 || handedData.length !== 2 || heldCompilers || heldData) throw new Error("compiler handoff retained compiler or evicted typing");
    }
  }
  if (await w.entryAsync(key, "optional", "(Z)I")(0) !== 7) throw new Error("unused optional reference resolved eagerly");
  try { await w.entryAsync(key, "optional", "(Z)I")(1); throw new Error("missing optional reference accepted"); }
  catch (e) { const t = w.throwable(e); if (!t || w.classNameOf(t) !== "java/lang/NoClassDefFoundError") throw e; }
  console.log(`uninitiated symbolic class reference: js=${expected}, wasm=${result}${w.opts.cold ? " (cold)" : " (compiled)"}${w.opts.cold ? "" : "; warm site resolutions=0"}; optional reference lazy`);
  if (process.argv.includes("--symbolic")) process.exit(0);
}
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
  cache.noteLate([...p.own()].map(c => c.name));
  const note = cache.noteLate.bind(cache);
  let reindexed = 0;
  cache.noteLate = names => { reindexed += names.length; return note(names); };
  const epoch = cache.epoch;
  cache.initiateClass(child, "Shared", key);
  const sub = p.definedBy(child, "Sub")!;
  if (!reindexed || !cache.late.get(key)?.includes(sub) || cache.late.get("Shared")?.includes(sub)) throw new Error("initiated superclass identity retained stale subtype relationships");
  if (p.lookup(child, "Shared") !== key || cls.dex!.type(type) !== `L${key};` || self.ret !== `L${key};` || peer.desc !== self.ret || cls.byKey.get(self.key) !== self || cache.epoch !== epoch + 1) throw new Error("initiating identity retained stale DEX/member caches");
  const priorLate = cache.late.get("NamespaceFace");
  reindexed = 0;
  cache.initiateClass(child, "SymbolicHelper", p.definedBy(child, "SymbolicHelper")!);
  if (reindexed || cache.late.get("NamespaceFace") !== priorLate) throw new Error("descriptor-only initiation rebuilt the subtype index");
  const face = p.definedBy(child, "NamespaceFace")!;
  cache.initiateClass(child, "NamespaceFace", face);
  if (!reindexed || !cache.late.get(face)?.includes(key) || cache.late.get("NamespaceFace")?.includes(key)) throw new Error("initiated interface identity retained stale subtype relationships");
  console.log(`  subtype index: descriptor-only 0 classes, interface change ${reindexed} classes reindexed`);
  cache.link(key);
  try { cache.initiateClass(child, "Shared", "Shared"); throw new Error("conflicting initiated identity accepted"); }
  catch (e) { const t = cache.throwable(e); if (!t || cache.classNameOf(t) !== "java/lang/LinkageError" || p.lookup(child, "Shared") !== key) throw e; }
}
for (const asynchronous of [false, true]) {
  const appDexes = loadDexes(a), base = program([...PLATFORM_JARS.map(j => join(AOSP, j)), common]);
  const p = new Program([...loadDexes(layeredApp), ...appDexes], base), layered = world(p, { natives, dexes: path => {
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
        const pending = [resolver.resolveClass(loader, "Shared", first), resolver.resolveClass(loader, "Shared", second)];
        const winner = await pending[mode === 4 ? 1 : 0];
        await resolver.entryAsync("Ldr", "resolverReleaseRace", "()V")();
        const results = await Promise.all(pending);
        if (results[0] !== results[1] || results[0] !== winner || winner !== resolver.prog.initiatedBy(loader, "Shared")) throw new Error("racing loader calls did not preserve first successful initiation");
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
await interfaceSuperControl();
console.log(failed ? `${failed} failures` : "loaders: all pass");
process.exit(failed ? 1 : 0);

async function interfaceSuperControl(): Promise<void> {
  const dex = build("interfaceSuper", ["InterfaceSuper.java"]);
  const names = ["selected", "reversed", "declared", "inherited", "classSuper", "virtualDefault", "interfaceDefault", "unusedAbstract"];
  const jdk = sh(["java", "-cp", join(out, "interfaceSuper"), "InterfaceSuper"]).trim().split("\n").map(Number);
  if (jdk.slice(0, names.length).join(",") !== "22,22,33,11,44,22,22,55") throw new Error("interface-super JDK control changed");
  const base = program(PLATFORM_JARS.slice(0, 2).map(j => join(AOSP, j)));
  let checks = 0;
  for (const cold of [false, true]) {
    const p = new Program(loadDexes(dex), base), target = p.get("InterfaceSuper$Select")!.byKey.get("f()I")!;
    const code = target.dex.code(target.codeOff).insns, ref = target.dex.method(code[1]);
    if ((code[0] & 0xff) !== 0x6f || target.dex.rawType(ref.cls) !== "LInterfaceSuper$C;") throw new Error("D8 did not preserve invoke-super C.f");
    if (p.get("InterfaceSuper$Default")!.byKey.has("f()I")) throw new Error("D8 introduced a default forwarder");
    for (const [method, kind, owner] of [["virtualDefault", "invoke-virtual", "Default"], ["interfaceDefault", "invoke-interface", "C"]]) {
      const m = p.get("InterfaceSuper")!.byKey.get(method + "()I")!;
      const prepared = prepareMethod(m.dex, m.dex.code(m.codeOff), m.desc, m.isStatic);
      const call = prepared.instructions.find(i => i.name === kind && m.dex.method(i.b).name === "f");
      if (!call || m.dex.rawType(m.dex.method(call.b).cls) !== `LInterfaceSuper$${owner};`) throw new Error("D8 changed ordinary default dispatch");
    }
    const current = world(p, { cold }), mirrors = new Set<object>();
    for (const [index, namespace] of ["root", "first", "second"].entries()) {
      let cls = "InterfaceSuper";
      if (namespace !== "root") {
        const loader = p.newLoader(p.boot, null);
        current.addDexes(loadDexes(dex), loader); cls += "@" + loader.id;
      }
      const suffix = cls.slice("InterfaceSuper".length), defaultClass = "InterfaceSuper$Default" + suffix;
      const selected = "InterfaceSuper$B" + suffix;
      if (p.implFor(defaultClass, "f", "()I")?.cls !== selected || symbolicImplFor(p, defaultClass, "f()I")?.cls !== selected) throw new Error("ordinary Wasm default selector lost maximal declaration or loader identity");
      await current.entryAsync(cls, "setOffset", "(I)V")(index * 17);
      for (let i = 0; i < names.length; i++) {
        const expected = jdk[index * names.length + i];
        const got = await current.entryAsync(cls, names[i], "()I")();
        if (got !== expected) throw new Error(`interface-super ${cold ? "cold" : "compiled"}/${namespace}/${names[i]}: ${got}, expected ${expected}`);
        checks++;
      }
      mirrors.add(await current.entryAsync(cls, "self", "()Ljava/lang/Class;")() as object);
    }
    if (mirrors.size !== 3) throw new Error("interface-super loaders aliased Class identities");
    if (cold && !current.stats.coldCalls) throw new Error("interface-super cold control did not execute the interpreter");
  }
  console.log(`interface-super/default: ${checks} Wasm cases match JDK; implFor and symbolicImplFor select the owning B declaration`);
  await jsTier(loadDexes(dex));
  const previous = jvmProfiler.tier;
  let jsChecks = 0;
  try {
    for (const mode of ["js", "cold"] as const) {
      jvmProfiler.tier = mode;
      const owners = mode === "js" ? [rt, rt.fork(), rt.fork()] : [rt.fork(), rt.fork()];
      const shared = loadDexes(dex), mirrors = new Set<object>(), before = perf.coldCalls;
      for (const [index, owner] of owners.entries()) {
        if (owner !== rt) shared.forEach(d => owner.loadDex(d));
        const info = owner.link("InterfaceSuper");
        await owner.initClass(info);
        const scope = mode === "js" ? index : index + 3;
        await callOn(mainThread, () => info.ctor[mangleMethod("setOffset", "(I)V")](scope * 17));
        for (let i = 0; i < names.length; i++) {
          const got = await callOn(mainThread, () => info.ctor[mangleMethod(names[i], "()I")]());
          const expected = jdk[scope * names.length + i];
          if (got !== expected) throw new Error(`JS interface-super ${mode}/${names[i]}: ${got}, expected ${expected}`);
          jsChecks++;
        }
        mirrors.add(owner.classFor("InterfaceSuper"));
      }
      if (mirrors.size !== owners.length || mode === "cold" && mirrors.has(rt.classFor("InterfaceSuper"))) throw new Error("JS interface-super loaders aliased Class identities");
      if (mode === "cold" && perf.coldCalls === before) throw new Error("JS interface-super cold control did not execute the interpreter");
    }
  } finally { jvmProfiler.tier = previous; }
  console.log(`JS interface-super/default: ${jsChecks} root/two-fork compiled and two-fork cold cases match JDK; Class identities stay distinct`);

}

async function abstractDefaultControl(): Promise<void> {
  const dex = build("abstractDefault", ["InterfaceSuper.java", "ClassReabstract.java"]);
  const old = join(out, "oldInterfaceSuper");
  sh(["mkdir", "-p", old]);
  writeFileSync(join(old, "InterfaceSuper.java"), readFileSync(join(JAVA, "InterfaceSuper.java"), "utf8").replace("interface Reabstracted extends C { int f(); }", "interface Reabstracted extends C {}").replace("interface OtherReabstracted extends C { int f(); }", "interface OtherReabstracted extends C {}"));
  writeFileSync(join(old, "ClassReabstract.java"), readFileSync(join(JAVA, "ClassReabstract.java"), "utf8").replace("  public abstract int f();", ""));
  sh(["javac", "--release", "11", "-d", old, join(old, "InterfaceSuper.java"), join(old, "ClassReabstract.java"), join(JAVA, "AbstractDefaultUse.java")]);
  for (const file of readdirSync(old).filter(p => /^AbstractDefaultUse.*\.class$/.test(p))) sh(["cp", join(old, file), join(out, "abstractDefault")]);
  sh([androidTool("d8"), "--min-api", "26", "--output", join(out, "abstractDefault"), "--lib", androidJar, ...readdirSync(join(out, "abstractDefault")).filter(p => p.endsWith(".class")).map(p => join(out, "abstractDefault", p))]);
  const expected = sh(["java", "-cp", join(out, "abstractDefault"), "AbstractDefaultUse"]).trim();
  if (expected !== "42\n1\n42\n1") throw new Error("binary-evolution JDK control changed: " + expected);
  const failures: string[] = [], base = program(PLATFORM_JARS.slice(0, 2).map(j => join(AOSP, j)));
  for (const cold of [false, true]) {
    const p = new Program(loadDexes(dex), base), w = world(p, { cold });
    for (let index = 0; index < 3; index++) {
      let cls = "AbstractDefaultUse";
      if (index) { const loader = p.newLoader(p.boot, null); w.addDexes(loadDexes(dex), loader); cls += "@" + loader.id; }
      const mode = `Wasm ${cold ? "cold" : "compiled"}/${index}`;
      const abstract = symbolicImplFor(p, cls, "f()I", true);
      if (p.implFor(cls, "f", "()I") || symbolicImplFor(p, cls, "f()I") || !abstract || !(abstract.flags & ACC.ABSTRACT) || !(abstract.flags & ACC.PUBLIC)) throw new Error("compatible maximal abstracts lost metadata or retained concrete default");
      try {
        for (const suffix of ["", "Class"]) {
          const prepared = await w.entryAsync(cls, "prepare" + suffix, "()I")();
          const checked = await w.entryAsync(cls, "check" + suffix, "()I")();
          console.log(`${mode}/${suffix || "interface"}: preparation=${prepared}, AME=${checked}`);
          if (prepared !== 42 || checked !== 1) failures.push(mode + "/" + suffix);
        }
      } catch (error) { console.log(mode, error); failures.push(mode + " threw before expected catch"); }
    }
    if (cold && !w.stats.coldCalls) throw new Error("abstract-default Wasm cold path inactive");
  }
  await jsTier(loadDexes(dex));
  const previous = jvmProfiler.tier;
  try {
    for (const mode of ["js", "cold"] as const) {
      jvmProfiler.tier = mode;
      const owners = mode === "js" ? [rt, rt.fork(), rt.fork()] : [rt.fork(), rt.fork()], before = perf.coldCalls;
      for (const [index, owner] of owners.entries()) {
        if (owner !== rt) loadDexes(dex).forEach(d => owner.loadDex(d));
        const info = owner.link("AbstractDefaultUse");
        await owner.initClass(info);
        for (const suffix of ["", "Class"]) {
          const prepared = await callOn(mainThread, () => info.ctor[mangleMethod("prepare" + suffix, "()I")]());
          const checked = await callOn(mainThread, () => info.ctor[mangleMethod("check" + suffix, "()I")]());
          console.log(`JS ${mode}/${index}/${suffix || "interface"}: preparation=${prepared}, AME=${checked}`);
          if (prepared !== 42 || checked !== 1) failures.push(`JS ${mode}/${index}/${suffix}`);
        }
      }
      if (mode === "cold" && perf.coldCalls === before) throw new Error("abstract-default JS cold path inactive");
    }
  } finally { jvmProfiler.tier = previous; }
  if (failures.length) throw new Error("abstract-dominance mismatch: " + failures.join(", "));
}
