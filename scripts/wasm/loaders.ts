// Class loaders: two DexClassLoaders over dex files that define the same class name (tests/fixtures/wasm/java/Ldr.java) keep distinct classes, statics and Class
// objects, see the app's interface through their parent, and answer Class.forName, loadClass, getClassLoader and reflection each in its own namespace.
// Needs javac and d8. Run: pnpm wasm loaders
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { PackedArchive, packedArchives, sha256 } from "../../src/shell/packedarchive.ts";
import { loadDexes, program, world } from "./lib.ts";
import { Program, ACC, javaName, declaredMethods, declaredMethod, type JClass } from "../../src/wasm/compiler/program.ts";
import { COUNT_BASE, HOT_BUDGET } from "../../src/wasm/link/exc.ts";
import { mid, methodOf } from "../../src/wasm/compiler/ids.ts";
import { appArchives } from "../../src/jvm/natives/jdex.ts";
import { openDexes } from "../../src/wasm/host/boot.ts";
import { wasmJni } from "../../src/wasm/host/jni.ts";
import { jniInit, deref, javaVM } from "../../src/native/jni.ts";
import { useJniVm, vm as priorJniVm } from "../../src/native/jnivm.ts";
import { Cpu, setA64 } from "../../src/native/cpu.ts";
import { mem } from "../../src/native/mem.ts";
import { ldp, PTR } from "../../src/native/host.ts";
import { mainThread } from "../../src/jvm/natives/jentry.ts";
import { definingLoader, nativeClassLookup } from "../../src/wasm/link/loaders.ts";
import { prepareMethod } from "../../src/jvm/prepared.ts";
import { Pool, u2, u4 } from "./classfile.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { T } from "../../src/wasm/compiler/wasmbin.ts";
import { UnitCompiler } from "../../src/wasm/link/unit.ts";
import { CompileClient, type WorkerPort } from "../../src/wasm/host/compiler.ts";
import type { CompileRequest, CompileResponse } from "../../src/wasm/host/compile-serve.ts";
import { typeFailure, symbolicImplFor } from "../../src/wasm/compiler/linkage.ts";
import type { Code } from "../../src/wasm/compiler/code.ts";
import { St } from "../../src/wasm/link/monitor.ts";
import { canAccess } from "../../src/wasm/link/classes.ts";
import { HOSTED } from "../../src/wasm/link/hostapi.ts";
import { wasmEntry } from "../../src/wasm/host/entry.ts";
import { mountPlatform, natives } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { filesIn, shellIn } from "./tools.ts";

import { androidPlatform, androidTool } from "../android-sdk.ts";

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
if (process.argv.includes("--hot-refresh")) { await hotRefreshControl(); process.exit(0); }
const app = build("app", ["Ldr.java", "Tag.java"]);
const common = build("common", ["Tag.java"]), layeredApp = build("layeredapp", ["Ldr.java"], join(out, "app"));
const a = build("a", ["ldr1/Shared.java", "ldr1/Boom.java", "members1/pack/PackageBase.java", "members1/pack/PackageType.java", "members1/MemberBase.java", "members1/MemberContract.java", "members1/MemberType.java"], join(out, "app")), b = build("b", ["ldr2/Shared.java", "ldr2/Boom.java", "ldr2/Sub.java", "members2/pack/PackageChild.java", "members2/pack/PackagePrivateChild.java", "members2/pack/PackageType.java", "members2/MemberUse.java", "members2/MemberOverride.java", "members2/MemberImplementation.java", "members2/MemberType.java"], [join(out, "app"), join(out, "a")].join(":"));
const apk = join(out, "ordered.apk");
writeFileSync(apk, zipSync({ "classes10.dex": new Uint8Array(readFileSync(b)), "classes2.dex": new Uint8Array(readFileSync(a)), "classes1000.dex": new Uint8Array(readFileSync(b)), "classes.dex": new Uint8Array(readFileSync(app)) }));
const ordered = world([apk, ...PLATFORM_PATHS], { natives });
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
await mountPlatform(ROOT);
const w = world([app, ...PLATFORM_PATHS], { natives, dexes: (path) => (files.has(path) ? loadDexes(files.get(path)!) : undefined) });

const CHECKS = ["the loaders define distinct Shared classes", "getClassLoader", "loadClass finds the class again", "statics are separate", "isInstance does not cross", "both implement the app's Tag",
  "cast across loaders fails", "Class.forName with a loader", "a class only the other loader defines, and its superclass", "the parent's classes are found through the loader", "signatures name the loader's class",
  "a method of the other loader's types is not found", "return types and receivers", "array classes", "loader identity and parent", "exceptions of a loader's own classes"];
let failed = 0;
const gaps = new Set<string>();
w.onGap = (id) => gaps.add(w.gapList[id]);
let got: number;
try { got = await w.entryAsync("Ldr", "check", "(Ljava/lang/String;Ljava/lang/String;)I")("/data/local/tmp/a.dex", "/data/local/tmp/b.dex") as number; } catch (e) {
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
const memberResult = await w.entryAsync("Ldr", "memberResolution", desc)(...paths);
if (memberResult !== 31) throw new Error(`binary member descriptors: wasm=${memberResult}, expected=31`);
console.log(`binary member descriptors: wasm=${memberResult}; denied type retries, unused prototype stays lazy, declaring reflection identity preserved`);
for (const method of ["memberConstraints", "memberInterfaceConstraints", "memberIndirectConstraints", "memberReentrantConstraints"]) {
  const result = await w.entryAsync("Ldr", method, desc)(...paths);
  console.log(`${method}: wasm=${result}, expected=255`);
  if (result !== 255) throw new Error(`${method}: ${result}`);
}
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
{
  sh(["mkdir", "-p", "witness"]);
  sh(["javac", "--release", "11", "-d", join(out, "witness"), join(JAVA, "PackageLoaderControl.java")]);
  const control = sh(["java", "-cp", join(out, "witness"), "PackageLoaderControl", join(out, "a"), join(out, "b")]).trim();
  if (control !== "1122\n1122\n2222\n112222\n112222\n222222") throw new Error(`package runtime-package JDK control: ${control}`);
  console.log(`package runtime-package JDK control: ${control.replaceAll("\n", ",")}`);
  for (const ownType of [true, false]) {
    const signature = "(Ljava/lang/String;Ljava/lang/String;Z)I", args = [...paths, ownType];
    const result = await w.entryAsync("Ldr", "packageMembers", signature)(...args);
    console.log(`package-private dispatch ownType=${ownType}: wasm=${result}, expected=1122`);
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
{
  const result = await w.entryAsync("Ldr", "hierarchyDelegateLast", desc)(...paths);
  if (result !== 7) throw new Error(`defining hierarchy mirrors: wasm=${result}, expected=7`);
  console.log(`defining hierarchy mirrors: wasm=${result}`);
}
{
  const caught = await w.entryAsync("Ldr", "catchResolution", "(Ljava/lang/String;)I")(paths[1]);
  if (caught !== 31) throw new Error(`executed catch loader: wasm=${caught}, expected=31`);
  console.log("executed catch loader: wasm=31; untaken handler types stay lazy, suspended denial retries, successful identity stays cached, missing types preserve the original exception");
  {
    const boot = world(new Program([], program([...PLATFORM_PATHS, common, b])), { natives });
    if (boot.prog.loaderOf("Shared") !== boot.prog.boot) throw new Error("catch fixture is not boot-defined");
    const select = boot.entry("Shared", "catchOnly", "(Z)I");
    if (select(0) !== 7 || boot.prog.initiatedBy(boot.prog.boot, "CatchOnly")) throw new Error("untaken boot catch resolved its type");
    if (select(1) !== 42 || await boot.entryAsync("Shared", "catchOnly", "(Z)I")(1) !== 42) throw new Error("compiled boot catch did not preserve the original throwable");
    if (boot.prog.initiatedBy(boot.prog.boot, "CatchOnly") !== "CatchOnly" || boot.prog.initiatedBy(boot.prog.boot, "MissingCatch")) throw new Error("executed boot catches did not retain only successful resolution");
    if (!boot.stats.methods) throw new Error("boot catch fixture did not run compiled code");
    console.log("compiled boot catch: plain and strand select RuntimeException after missing/nonmatching catch types");
  }
  const actualType = await w.entryAsync("Ldr", "typeDelegateLast", desc)(...paths);
  if (actualType !== 7) throw new Error(`executed method-type loader: wasm=${actualType}, expected=7`);
  console.log("executed method-type loader: wasm=7; unused optional signature stays lazy");
  const expected = 42, result = await w.entryAsync("Ldr", "symbolicDelegateLast", desc)(...paths);
  if (result !== expected) throw new Error(`uninitiated symbolic class reference: wasm=${result}, expected=42`);
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
    console.log("promotion copies: unresolved helper excluded without loading; initiated helper copied on next selection; wasm=42");
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
  let call: ReturnType<typeof w.entryAsync>;
  try {
    call = w.entryAsync(key, "symbolic", "()I");
    if (await call() !== 42) throw new Error("symbolic direct entry failed");
  } finally { Compiler.prototype.buildUnit = buildUnit; }
  const resolutions = w.symbolicResolutions, stubModules = w.symbolicStubModules;
  for (let i = 0; i < 3; i++) if (await call() !== 42) throw new Error("cached symbolic operation failed");
  if (w.symbolicResolutions !== resolutions) throw new Error("resolved symbolic site entered the loader bridge again");
  if (w.symbolicStubModules !== stubModules) throw new Error("warm symbolic operation rebuilt stub modules");
  console.log(`symbolic cache: first resolutions=${resolutions}, stub modules=${stubModules}; repeat resolutions=${w.symbolicResolutions - resolutions}, stub modules=${w.symbolicStubModules - stubModules}`);
  {
    const method = w.prog.require(key).byKey.get("symbolic()I")!;
    const ins = prepareMethod(method.dex.code(method.codeOff)).instructions.find(ins => ins.name === "invoke-static")!;
    const before = { ...w.stats }, symbols = w.symbolicImports([["accounting:probe", key, method.index, ins.pc, [], "I"]]);
    if (w.stats.units !== before.units + 1 || w.stats.bytes <= before.bytes || w.stats.compileMs <= before.compileMs) throw new Error("symbolic stub compilation unaccounted");
    const table = symbols.table as WebAssembly.Table, slot = (symbols["accounting:probe"] as WebAssembly.Global).value as number;
    const stub = { ...w.stats };
    if (table.get(slot)!() !== 42) throw new Error("accounted symbolic operation failed");
    if (w.stats.units !== stub.units || w.stats.bytes !== stub.bytes || w.stats.compileMs <= stub.compileMs) throw new Error("shared symbolic operation rebuilt code or lost resolution accounting");
    const warm = { ...w.stats };
    if (table.get(slot)!() !== 42 || w.stats.units !== warm.units || w.stats.bytes !== warm.bytes || w.stats.compileMs !== warm.compileMs) throw new Error("warm symbolic operation compiled again");
    console.log("symbolic accounting: new stub recorded; resolved operation shared without compilation; warm execution unchanged");
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
    if (accountingWorld.stats.units <= initial.units || accountingWorld.stats.bytes <= initial.bytes || accountingWorld.stats.compileMs <= initial.compileMs) throw new Error("throwable helper compilation unaccounted");
    const beforeReader = { ...accountingWorld.stats }, reader = accountingWorld.fieldReader<object | null>("java/lang/Throwable", "detailMessage", "Ljava/lang/String;");
    if (accountingWorld.stats.units !== beforeReader.units + 1 || accountingWorld.stats.bytes <= beforeReader.bytes || accountingWorld.stats.compileMs <= beforeReader.compileMs) throw new Error("field reader compilation unaccounted");
    if (accountingWorld.hostString(reader(throwable)!) !== "accounted helper") throw new Error("accounted throwable detail changed");
    const warmHelpers = { ...accountingWorld.stats };
    const again = accountingWorld.makeThrowable("java/lang/IllegalStateException", null);
    if (reader(again) !== null || accountingWorld.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;") !== reader || accountingWorld.stats.units !== warmHelpers.units || accountingWorld.stats.bytes !== warmHelpers.bytes || accountingWorld.stats.compileMs !== warmHelpers.compileMs) throw new Error("warm throwable or reader helper compiled again");
    console.log("helper accounting: throwable and field reader record units and bytes; warm calls unchanged");
    if (process.argv.includes("--memory")) {
      const stubs: WeakRef<object>[] = [], compilers: WeakRef<object>[] = [];
      const emit = Compiler.prototype.buildSynthetic, group = Compiler.prototype.buildSyntheticGroup;
      Compiler.prototype.buildSynthetic = function (...args: Parameters<typeof emit>) { compilers.push(new WeakRef(this)); return emit.apply(this, args); };
      Compiler.prototype.buildSyntheticGroup = function (...args: Parameters<typeof group>) { compilers.push(new WeakRef(this)); return group.apply(this, args); };
      const before = { ...w.stats.phase };
      try {
        const bindings = w.symbolicImports(Array.from({ length: 32 }, (_, i) => [`memory:${i}`, key, method.index, ins.pc, [], "I"]));
        for (let i = 0; i < 32; i++) {
          const slot = (bindings[`memory:${i}`] as WebAssembly.Global).value as number;
          stubs.push(new WeakRef((bindings.table as WebAssembly.Table).get(slot)!));
          if ((bindings.table as WebAssembly.Table).get(slot)!() !== 42) throw new Error("memory probe operation failed");
        }
        if (w.stats.phase.prepare !== before.prepare || w.stats.phase.infer !== before.infer) throw new Error("symbolic operation reanalyzed its method");
      } finally {
        Compiler.prototype.buildSynthetic = emit; Compiler.prototype.buildSyntheticGroup = group;
      }
      const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      if (!collect || compilers.length !== 1) throw new Error(`symbolic lifetime probe rebuilt shared operations or lacks GC: compilers=${compilers.length}, gc=${!!collect}`);
      const heapBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); collect(); }
      const retainedStubs = stubs.filter(ref => ref.deref()).length;
      console.log(`symbolic stubs: replaced=${stubs.length}, retained=${retainedStubs}`);
      if (stubs.length !== 32 || retainedStubs) throw new Error("replaced symbolic stubs retained");
      const retainedCompilers = compilers.filter(ref => ref.deref()).length;
      console.log(`symbolic lifetime: compilers=${compilers.length}, retained=${retainedCompilers}; heap before GC=${heapBefore}, after GC=${process.memoryUsage().heapUsed}`);
      if (retainedCompilers || w.prog.require(key).byKey.get("symbolic()I") !== method || table.get(slot)!() !== 42) throw new Error("symbolic compiler retained by live Program or compiled operation");
      const heldCompilers = handingCompilers.filter(ref => ref.deref()).length, heldData = handedData.filter(ref => ref.deref()).length;
      console.log(`method analysis lifetime: compilers=${handingCompilers.length}, retained=${heldCompilers}; data=${handedData.length}, retained=${heldData}`);
      if (handingCompilers.length !== 1 || handedData.length !== 2 || heldCompilers || heldData) throw new Error("symbolic resolution retained method compiler or typing");
    }
  }
  const operands = w.entryAsync(key, "symbolicOperands", "()I");
  for (let i = 0; i < 2; i++) if (await operands() !== 15) throw new Error("symbolic aliased operands or floating/wide bits changed");
  console.log("symbolic operands: aliased references and arguments, float/double signed zero and full-width long survive fields and invocation");
  if (await w.entryAsync(key, "optional", "(Z)I")(0) !== 7) throw new Error("unused optional reference resolved eagerly");
  try { await w.entryAsync(key, "optional", "(Z)I")(1); throw new Error("missing optional reference accepted"); }
  catch (e) { const t = w.throwable(e); if (!t || w.classNameOf(t) !== "java/lang/NoClassDefFoundError") throw e; }
  console.log(`uninitiated symbolic class reference: wasm=${result}; warm site resolutions=0; optional reference lazy`);
}
const wasmCustom = await w.entryAsync("Ldr", "customParent", desc)(...paths);
if (wasmCustom !== 121) { failed++; console.log(`FAIL inherited parent-first loader: wasm=${wasmCustom}, expected=121`); }
{
  const proxies = await w.entryAsync("Ldr", "proxyLoaders", desc)(...paths);
  if (proxies !== 8191) { failed++; console.log(`FAIL proxy defining loaders, duplicate binary names, bootstrap isolation, public cache, arrays and defensive duplicate rejection: ${proxies} (expected 8191)`); }
}
const wasmDelegate = await w.entryAsync("Ldr", "delegateLast", desc)(...paths);
if (wasmDelegate !== 31) { failed++; console.log(`FAIL actual delegate-last initiation and ordinary parent-first control: wasm=${wasmDelegate}, expected=31`); }

{
  const p = new Program(loadDexes(a), program([...PLATFORM_PATHS, app]));
  const cache = world(p, { natives }), child = p.newLoader(p.root, null);
  cache.addDexes(loadDexes(b), child);
  const key = p.definedBy(child, "Shared")!, cls = p.get(key)!;
  const self = cls.byKey.get("self()LShared;")!, peer = cls.fields.find(f => f.name === "peer")!;
  const type = cls.dex!.proto(cls.dex!.method(self.methodIdx).proto).ret;
  if (cls.dex!.type(type) !== "LShared;" || peer.desc !== "LShared;") throw new Error("fixture did not warm the parent resolution");
  const epoch = cache.epoch;
  cache.initiateClass(child, "Shared", key);
  const sub = p.definedBy(child, "Sub")!;
  if (!cache.lateSubtypes(key).includes(sub) || cache.lateSubtypes("Shared").includes(sub)) throw new Error("initiated superclass identity retained stale subtype relationships");
  if (p.lookup(child, "Shared") !== key || cls.dex!.type(type) !== `L${key};` || self.ret !== `L${key};` || peer.desc !== self.ret || cls.byKey.get(self.key) !== self || cache.epoch !== epoch + 1) throw new Error("initiating identity retained stale DEX/member caches");
  const priorLate = cache.lateSubtypes("NamespaceFace").join();
  cache.initiateClass(child, "SymbolicHelper", p.definedBy(child, "SymbolicHelper")!);
  if (cache.lateSubtypes("NamespaceFace").join() !== priorLate) throw new Error("descriptor-only initiation changed subtype relationships");
  const face = p.definedBy(child, "NamespaceFace")!;
  cache.initiateClass(child, "NamespaceFace", face);
  if (!cache.lateSubtypes(face).includes(key) || cache.lateSubtypes("NamespaceFace").includes(key)) throw new Error("initiated interface identity retained stale subtype relationships");
  cache.link(key);
  try { cache.initiateClass(child, "Shared", "Shared"); throw new Error("conflicting initiated identity accepted"); }
  catch (e) { const t = cache.throwable(e); if (!t || cache.classNameOf(t) !== "java/lang/LinkageError" || p.lookup(child, "Shared") !== key) throw e; }
}
for (const asynchronous of [false, true]) {
  const appDexes = loadDexes(a), base = program([...PLATFORM_PATHS, common]);
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
    const owner = jni.find(name)!;
    const expected = p.lookup(p.loaderOf(name), "Shared")!;
    if (p.viewOf(name, "([LShared;Ljava/lang/String;)LShared;") !== `([L${expected};Ljava/lang/String;)L${expected};` || jni.find("[LShared;", owner)?.name !== `[L${expected};`) {
      failed++; console.log(`FAIL JNI descriptor/array namespace of ${name}: expected=${expected}, descriptor=${p.viewOf(name, "([LShared;Ljava/lang/String;)LShared;")}, array=${jni.find("[LShared;", owner)?.name}`);
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
  if (result !== 21 || visible === "Shared" || !visible || self.ret !== `L${visible};` || peer.desc !== self.ret || cls.fields.find(f => f.name === "peer") !== peer || cls.byKey.get(self.key) !== self || cls.byKey.get(`alias()L${visible};`) !== self || cls.byKey.has("self()LShared;") || cls.byKey.has("alias()LShared;") || appDexes[0].rawType(retIndex) !== "LShared;" || appDexes[0].type(retIndex) !== self.ret) {
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
  const resolver = world([app, ...PLATFORM_PATHS], { natives, dexes: path => files.has(path) ? loadDexes(files.get(path)!) : undefined });
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
await nativePathControl();
console.log(failed ? `${failed} failures` : "loaders: all pass");
process.exit(failed ? 1 : 0);

async function interfaceSuperControl(): Promise<void> {
  const dex = build("interfaceSuper", ["InterfaceSuper.java"]);
  {
    const p = new Program(loadDexes(dex), program(PLATFORM_PATHS.slice(0, 2))), target = world(p), loader = p.newLoader(p.root, null);
    target.addDexes(loadDexes(dex), loader);
    const face = p.definedBy(loader, "InterfaceSuper$C")!, replacement = p.definedBy(loader, "InterfaceSuper$B")!;
    p.addClass({ name: "Outside", sup: "java/lang/Object", ifaces: [face], flags: ACC.PUBLIC, isInterface: false, fields: [], methods: [], byKey: new Map(), dex: null, def: null }, p.root);
    target.link("Outside");
    if ((target as any).classes.has(face)) throw Error("dependency control interface already linked");
    try { target.initiateClass(loader, "InterfaceSuper$B", replacement); throw Error("changed inherited default accepted"); }
    catch (error) { const t = target.throwable(error); if (!t || target.classNameOf(t) !== "java/lang/LinkageError" || p.lookup(loader, "InterfaceSuper$B") !== "InterfaceSuper$B") throw error; }
    console.log("scoped rebinding retains outside-loader dispatch guard through an unlinked interface");
  }

  const names = ["selected", "reversed", "declared", "inherited", "classSuper", "virtualDefault", "interfaceDefault", "unusedAbstract"];
  const jdk = sh(["java", "-cp", join(out, "interfaceSuper"), "InterfaceSuper"]).trim().split("\n").map(Number);
  if (jdk.slice(0, names.length).join(",") !== "22,22,33,11,44,22,22,55") throw new Error("interface-super JDK control changed");
  const base = program(PLATFORM_PATHS.slice(0, 2));
  let checks = 0;
  {
    const p = new Program(loadDexes(dex), base), target = p.get("InterfaceSuper$Select")!.byKey.get("f()I")!;
    const code = target.dex.code(target.codeOff).insns, ref = target.dex.method(code[1]);
    if ((code[0] & 0xff) !== 0x6f || target.dex.rawType(ref.cls) !== "LInterfaceSuper$C;") throw new Error("D8 did not preserve invoke-super C.f");
    if (p.get("InterfaceSuper$Default")!.byKey.has("f()I")) throw new Error("D8 introduced a default forwarder");
    for (const [method, kind, owner] of [["virtualDefault", "invoke-virtual", "Default"], ["interfaceDefault", "invoke-interface", "C"]]) {
      const m = p.get("InterfaceSuper")!.byKey.get(method + "()I")!;
      const prepared = prepareMethod(m.dex.code(m.codeOff));
      const call = prepared.instructions.find(i => i.name === kind && m.dex.method(i.b).name === "f");
      if (!call || m.dex.rawType(m.dex.method(call.b).cls) !== `LInterfaceSuper$${owner};`) throw new Error("D8 changed ordinary default dispatch");
    }
    const current = world(p), mirrors = new Set<object>();
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
        if (got !== expected) throw new Error(`interface-super ${namespace}/${names[i]}: ${got}, expected ${expected}`);
        checks++;
      }
      mirrors.add(await current.entryAsync(cls, "self", "()Ljava/lang/Class;")() as object);
    }
    if (mirrors.size !== 3) throw new Error("interface-super loaders aliased Class identities");
  }
  console.log(`interface-super/default: ${checks} Wasm cases match JDK; implFor and symbolicImplFor select the owning B declaration`);

}

async function hotRefreshControl(): Promise<void> {
  const dex = build("refresh", ["HotRefresh.java"]), late = build("refresh-late", ["HotRefreshLate.java"], join(out, "refresh"));
  const expected = sh(["java", "-cp", [join(out, "refresh"), join(out, "refresh-late")].join(":"), "HotRefresh"]).trim().split("\n").map(Number);
  if (expected.join(",") !== "896,1536,2048") throw new Error("hot refresh JDK control changed");
  const base = program(PLATFORM_PATHS.slice(0, 2));
  let checks = 0;
  const check = (name: string, got: unknown, want: unknown) => { if (got !== want) throw new Error(`${name}: ${got} != ${want}`); checks++; };
  for (const custom of [false, true]) {
    const p = new Program(custom ? [] : loadDexes(dex), base), w = world(p, { natives, holdUpgrades: () => true });
    const loader = custom ? p.newLoader(p.boot, null) : p.root;
    if (custom) w.addDexes(loadDexes(dex), loader);
    const suffix = custom ? "@" + loader.id : "", cls = "HotRefresh" + suffix;
    const run = w.entryAsync(cls, "run", "(Z)I"), root = p.resolve(cls, "run", "(Z)I")!, slot = w.slotOf(root);
    check("seed before later reference", await run(0), expected[0]);
    const job = w.upgradeJob(slot)!;
    if (!job || !job.copies.some(id => id.startsWith(cls + ".helper"))) throw new Error("hot refresh did not copy the executed callee");
    const cx = new Compiler(w), method = (id: string) => methodOf(p, id)!;
    const built = cx.buildUnit(job.installed.map(id => method(id)!), job.copies.map(id => method(id)!), true);
    if (!cx.symbolicImports.size) throw new Error("hot refresh seed lost the unused later reference");
    // Install the actual compiled unit with the same canonical publication path as inline promotion.
    const owner = w as unknown as { unitImports(cx: Compiler): Record<string, unknown>; unitClock(): { start: number; accounted: number };
      install(group: number[], hot: boolean, cx: Compiler, imports: Record<string, unknown>, built: ReturnType<Compiler["buildUnit"]>, slot: number, clock: { start: number; accounted: number }): void };
    owner.install(job.installed.map(id => w.slotOf(method(id)!)), true, cx, owner.unitImports(cx), built, slot, owner.unitClock());
    const before = w.table.get(slot), deopts = w.stats.invalidated;
    check("copied callee resolves later reference", await run(1), expected[1]);
    check("hold preserves hot unit", w.table.get(slot), before);
    check("hold defers refresh", w.hotRefreshes, 0);
    w.opts.holdUpgrades = () => false;
    for (let i = 0; i < 100 && !w.hotRefreshes; i++) { await new Promise(r => setTimeout(r, 1)); check("refresh result", await run(1), expected[1]); }
    check("ready sites coalesce into one refresh", w.hotRefreshes, 1);
    check("refresh replaces live export", w.table.get(slot) !== before, true);
    check("refresh is not deoptimization", w.stats.invalidated, deopts);
    const refreshed = w.table.get(slot), units = w.stats.units;
    check("repeat result", await run(1), expected[1]);
    check("repeat does not refresh", w.hotRefreshes, 1);
    check("repeat does not compile", w.stats.units, units);
    check("repeat keeps live export", w.table.get(slot), refreshed);
    w.addDexes(loadDexes(late), loader);
    check("late override invalidates guarded unit", w.stats.invalidated > deopts, true);
    const ownMethod = (key: string, name: string) => {
      const owner = p.require(key), [signature] = declaredMethods(owner).find(([signature]) => signature.startsWith(name + "("))!;
      return declaredMethod(owner, signature)!;
    };
    const make = ownMethod("HotRefreshLate" + suffix, "make"), choose = ownMethod(cls, "choose");
    const value = await w.entryAsync(make.cls, make.name, make.desc)();
    await w.entryAsync(choose.cls, choose.name, choose.desc)(value);
    check("late override dispatch", await run(1), expected[2]);
  }
  // The worker's snapshot precedes successful resolution in the executing World.
  const files = [dex, ...PLATFORM_PATHS.slice(0, 2)];
  const page = world(files, { natives, holdUpgrades: () => true }), worker = world(files, { compileOnly: true }), uc = new UnitCompiler(worker);
  const run = page.entryAsync("HotRefresh", "run", "(Z)I"), slot = page.slotOf(page.prog.resolve("HotRefresh", "run", "(Z)I")!);
  check("worker seed", await run(0), expected[0]);
  const job = page.upgradeJob(slot)!, marks = page.numbering(), epoch = page.epoch;
  check("worker numbering sync", uc.sync(page.since(page.base), true), true);
  const result = uc.upgrade(job);
  if (typeof result === "string") throw new Error(result);
  check("resolve before worker publication", await run(1), expected[1]);
  check("publish after readiness", page.adoptUnit(slot, job, result, epoch), true);
  const n = result.numbering, keep = !!(n.names.length + n.tail.length + n.selectors.length + n.gaps.length + n.links.length);
  const syncFrom = keep ? page.numbering() : marks;
  const refresh = page.upgradeJob(slot)!;
  if (refresh?.refresh === undefined) throw new Error("worker publication missed prior readiness");
  check("refresh worker numbering sync", uc.sync(page.since(syncFrom), keep), true);
  const refreshed = uc.upgrade(refresh);
  if (typeof refreshed === "string") throw new Error(refreshed);
  check("worker refresh adopted", page.adoptUnit(slot, refresh, refreshed, page.epoch), true);
  check("worker refresh result", await run(1), expected[1]);
  check("worker refresh coalesced", page.hotRefreshes, 1);
  await hotRefreshPendingControl(files, late);
  console.log(`hot refresh: ${checks} JDK-matched checks; root/custom, hold, late override and worker publication/generation`);
}

async function hotRefreshPendingControl(files: string[], late: string): Promise<void> {
  let checks = 0;
  const check = (name: string, got: unknown, want: unknown) => { if (got !== want) throw new Error(`${name}: ${got} != ${want}`); checks++; };
  const seed = async () => {
    const w = world(files, { natives, holdUpgrades: () => true });
    const run = w.entryAsync("HotRefresh", "run", "(Z)I"), m = w.prog.resolve("HotRefresh", "run", "(Z)I")!, slot = w.slotOf(m);
    check("pending seed result", await run(0), 896);
    return { w, run, slot };
  };
  const build = (w: ReturnType<typeof world>, slot: number) => {
    const owner = w as unknown as { unitImports(cx: Compiler): Record<string, unknown>; unitClock(): { start: number; accounted: number };
      install(group: number[], hot: boolean, cx: Compiler, imports: Record<string, unknown>, built: ReturnType<Compiler["buildUnit"]>, slot: number, clock: { start: number; accounted: number }): void };
    const clock = owner.unitClock(), job = w.upgradeJob(slot);
    if (!job) throw new Error("pending control has no real compilation job");
    const cx = new Compiler(w), methods = job.installed.map(id => methodOf(w.prog, id)!);
    const built = cx.buildUnit(methods, job.copies.map(id => methodOf(w.prog, id)!), true);
    return () => owner.install(methods.map(m => w.slotOf(m)), true, cx, owner.unitImports(cx), built, slot, clock);
  };
  const state = (w: ReturnType<typeof world>, slot: number) => w.peek(slot) as { pending?: boolean; hot?: boolean };
  const connect = (w: ReturnType<typeof world>) => {
    const requests: CompileRequest[] = [];
    const port: WorkerPort = { onmessage: null, onerror: null, postMessage(message) { requests.push(structuredClone(message) as CompileRequest); }, terminate() {} };
    const client = new CompileClient(port);
    client.start(w, undefined, undefined);
    const reply = (data: CompileResponse) => port.onmessage!({ data } as MessageEvent<CompileResponse>);
    reply({ type: "loaded" }); w.opts.compiler = client;
    const request = () => {
      const message = requests.find((m): m is Extract<CompileRequest, { type: "upgrade" }> => m.type === "upgrade");
      if (!message) throw new Error("pending control did not submit an actual upgrade request");
      return message;
    };
    const compile = () => {
      const init = requests.find((m): m is Extract<CompileRequest, { type: "init" }> => m.type === "init");
      if (!init?.sync) throw new Error("pending control has no actual initialization numbering");
      const worker = world(files, { compileOnly: true }), units = new UnitCompiler(worker), job = request();
      if (!units.sync(init.sync, true)) throw new Error("pending worker initialization mismatch");
      if (!units.sync(job.sync, job.keep)) throw new Error("pending worker job numbering mismatch");
      const result = units.upgrade(job.job);
      if (typeof result === "string") throw new Error(result);
      return { type: "unit" as const, id: job.id, result, ms: 0 };
    };
    return { client, reply, requests, request, compile };
  };
  // Actual host.hot queues while the client starts; publication makes the queued job obsolete.
  {
    const { w, run, slot } = await seed(), publish = build(w, slot), c = connect(w);
    try {
      w.host.hot(slot);
      check("queued promotion pending", state(w, slot).pending, true);
      check("starting worker has no upgrade request", c.requests.filter(m => m.type === "upgrade").length, 0);
      publish(); const saved = w.table.get(slot);
      c.reply({ type: "ready", ms: 0 });
      check("queued rejection releases pending", state(w, slot).pending, false);
      check("queued rejection submits no job", c.client.stats.jobs, 0);
      check("queued rejection keeps hot export", w.table.get(slot), saved);
      check("queued rejection executes", await run(0), 896);
      check("ready synchronous submit accepts queue", c.client.submit(w, slot), true);
      check("synchronous rejection leaves pending false", state(w, slot).pending, false);
      w.host.hot(slot);
      check("actual hot caller skips obsolete promotion", state(w, slot).pending, false);
      check("actual hot caller sends no job", c.client.stats.jobs, 0);
    } finally { c.client.close(); }
  }
  for (const outcome of ["adopt", "stale", "failed", "failed-superseded", "failed-invalidated"] as const) {
    const { w, run, slot } = await seed(); build(w, slot)();
    check("actual later resolution", await run(1), 1536);
    const c = connect(w);
    try {
      c.reply({ type: "ready", ms: 0 }); w.opts.holdUpgrades = () => false;
      const saved = w.table.get(slot);
      check("ready refresh guest result", await run(1), 1536);
      if (c.request().job.refresh === undefined) throw new Error("actual entry did not submit a refresh generation");
      check("actual refresh reserves pending", state(w, slot).pending, true);
      if (outcome === "adopt") {
        c.reply(c.compile());
        check("actual refresh adopted", c.client.stats.adopted, 1);
        check("actual refresh releases pending", state(w, slot).pending, false);
        check("actual refresh replaces export", w.table.get(slot) !== saved, true);
        check("actual refresh increments count", w.hotRefreshes, 1);
      } else if (outcome === "stale") {
        const response = c.compile();
        build(w, slot)(); const replacement = w.table.get(slot);
        c.reply(response);
        check("superseded real generation rejected", c.client.stats.stale, 1);
        check("stale reply releases pending", state(w, slot).pending, false);
        check("stale reply preserves replacement", w.table.get(slot), replacement);
      } else if (outcome === "failed-superseded" || outcome === "failed-invalidated") {
        if (outcome === "failed-superseded") build(w, slot)();
        else {
          const epoch = w.epoch, invalidated = w.stats.invalidated;
          w.addDexes(loadDexes(late));
          check("busy refresh advances actual DEX epoch", w.epoch > epoch, true);
          check("late implementation invalidates actual guarded code", w.stats.invalidated > invalidated, true);
          const invalidatedState = w.peek(slot);
          check("invalidated root requires relink", invalidatedState?.k === "method" && !invalidatedState.done, true);
        }
        const replacement = w.table.get(slot);
        check("old request still owns pending before failure", state(w, slot).pending, true);
        c.reply({ type: "failed", id: c.request().id, message: "controlled old refresh compile failure" });
        check("old refresh failure recorded", c.client.stats.failed, 1);
        check("old refresh failure releases its reservation", state(w, slot).pending, false);
        check("old refresh failure preserves replacement", w.table.get(slot), replacement);
        check("old refresh failure starts no extra job", c.client.stats.jobs, 1);
      } else {
        c.reply({ type: "failed", id: c.request().id, message: "controlled refresh compile failure" });
        check("failed refresh recorded", c.client.stats.failed, 1);
        check("failed refresh releases pending", state(w, slot).pending, false);
        check("failed refresh keeps valid export", w.table.get(slot), saved);
        check("failed refresh drops only tracking", w.upgradeJob(slot), undefined);
      }
      check("settled transition executes", await run(1), 1536);
      if (outcome === "failed") check("failed refresh does not retry", c.client.stats.jobs, 1);
    } finally { c.client.close(); }
  }
  console.log(`hot refresh pending: ${checks} checks; queued rejection, ready adoption, natural supersession and failed-generation cleanup`);
}

async function abstractDefaultControl(): Promise<void> {
  const dex = build("abstractDefault", ["InterfaceSuper.java", "ClassReabstract.java"]);
  const old = join(out, "oldInterfaceSuper");
  sh(["mkdir", "-p", old]);
  writeFileSync(join(old, "InterfaceSuper.java"), readFileSync(join(JAVA, "InterfaceSuper.java"), "utf8").replace("interface Reabstracted extends C { int f(); }", "interface Reabstracted extends C {}").replace("interface OtherReabstracted extends C { int f(); }", "interface OtherReabstracted extends C {}"));
  writeFileSync(join(old, "ClassReabstract.java"), readFileSync(join(JAVA, "ClassReabstract.java"), "utf8").replace("  public abstract int f();", ""));
  sh(["javac", "--release", "11", "-d", old, join(old, "InterfaceSuper.java"), join(old, "ClassReabstract.java"), join(JAVA, "AbstractDefaultUse.java")]);
  for (const file of filesIn(old, /^AbstractDefaultUse.*\.class$/)) sh(["cp", file, join(out, "abstractDefault")]);
  sh([androidTool("d8"), "--min-api", "26", "--output", join(out, "abstractDefault"), "--lib", androidJar, ...filesIn(join(out, "abstractDefault"), /\.class$/)]);
  const expected = sh(["java", "-cp", join(out, "abstractDefault"), "AbstractDefaultUse"]).trim();
  if (expected !== "42\n1\n42\n1") throw new Error("binary-evolution JDK control changed: " + expected);
  const failures: string[] = [], base = program(PLATFORM_PATHS.slice(0, 2));
  {
    const p = new Program(loadDexes(dex), base), w = world(p);
    for (let index = 0; index < 3; index++) {
      let cls = "AbstractDefaultUse";
      if (index) { const loader = p.newLoader(p.boot, null); w.addDexes(loadDexes(dex), loader); cls += "@" + loader.id; }
      const mode = `Wasm/${index}`;
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
  }
  if (failures.length) throw new Error("abstract-dominance mismatch: " + failures.join(", "));
}

async function nativePathControl(): Promise<void> {
  const appPath = "/data/local/tmp/native-path-app.dex";
  vfs.mount(appPath, new BytesFile(new Uint8Array(readFileSync(app))));
  {
    const base = program([...PLATFORM_PATHS, common]);
    const appDexes = loadDexes(app), p = new Program(appDexes, base), target = world(p, { natives, loop: { due: () => false, yield: () => Promise.resolve(), after: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, dexes: path => path === appPath ? appDexes : files.has(path) ? loadDexes(files.get(path)!) : undefined });
    let managed = 0;
    const callFn = target.callFn;
    target.callFn = function (name, ...args) { if (name.startsWith("resolve:load:")) managed++; return callFn.call(this, name, ...args); };
    const construct = async (cls = "dalvik/system/DexClassLoader", path = paths[0], parent: object | null = null) => {
      const desc = cls.includes("$") ? "(Ljava/lang/String;Ljava/lang/ClassLoader;)V" : "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/ClassLoader;)V";
      const ctor = p.resolve(cls, "<init>", desc)!;
      const make = target.callFn("native-path:" + cls, ["L", "L"], "L", (cx, c, arg) => {
        cx.emitEnsure(c, cls); cx.emitNew(c, cls); const o = c.newLocal(T.anyref); c.ltee(o); arg(0);
        if (!cls.includes("$")) c.anyNull().anyNull(); arg(1);
        cx.callMethod(c, ctor); c.lget(o);
      });
      const strand = target.sched.strand();
      try { return await make(strand, target.javaString(path), parent) as object; } finally { strand.end(); }
    };
    const set = (obj: object, cls: string, field: string, desc: string, value: object | null) => target.hostFn("native-path:set:" + cls + field, ["L", "L"], "V", (cx, c) => {
      const st = cx.structFor(cls); c.lget(0).refCast(st).lget(1).structSet(st, cx.fieldIndex(cls, {owner:cls, name:field, desc}));
    })(obj, value);
    const appPeer = await construct("dalvik/system/DexClassLoader", appPath), appLoader = definingLoader(target, appPeer);
    if (appLoader !== p.root || nativeClassLookup(target, appLoader, "Ldr$MemberLoader") !== "Ldr$MemberLoader") throw new Error("root app path was not recognized");
    const jni = wasmJni(target), classLoader = jni.find("java/lang/ClassLoader", null)!;
    for (const name of ["java/io/PrintStream", "java/io/ByteArrayOutputStream"]) {
      if (p.initiatedBy(appLoader, name)) throw new Error("JNI loader fixture class was already initiated");
      const mirror = await jni.invoke(classLoader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", false, appPeer, [jni.string(name)], false);
      if (jni.classOf(mirror)?.name !== name || p.initiatedBy(appLoader, name) !== name) throw new Error("JNI loadClass lost the native platform lookup");
    }
    managed = 0; const appStrand = target.sched.strand();
    try {
      const key = target.resolveClass(appLoader, "Ldr$MemberLoader", appStrand);
      if (key !== "Ldr$MemberLoader" || managed) throw new Error("root app resolution entered managed loadClass");
    } finally { appStrand.end(); }
    const peer = await construct(), loader = definingLoader(target, peer);
    const expected = p.definedBy(loader, "Shared")!;
    if (nativeClassLookup(target, loader, "Shared") !== expected) throw new Error("native path lookup not exercised");
    managed = 0;
    const strand = target.sched.strand();
    let resolved;
    try { resolved = target.resolveClass(loader, "Shared", strand); if (resolved instanceof Promise) throw new Error("ordinary native definition unexpectedly waited"); } finally { strand.end(); }
    if (resolved !== expected || managed) throw new Error("native resolution entered managed loadClass");
    const child = await construct("dalvik/system/DexClassLoader", paths[1], peer), childLoader = definingLoader(target, child);
    const childSub = p.definedBy(childLoader, "Sub");
    if (nativeClassLookup(target, childLoader, "Sub") !== childSub) throw new Error("nested live path lost its definition");
    if (nativeClassLookup(target, childLoader, "Shared") !== expected) throw new Error("parent native identity lost");
    const boot = p.definedBy(p.boot, "java/util/BitSet");
    if (nativeClassLookup(target, childLoader, "java/util/BitSet") !== boot) throw new Error("boot native identity lost");
    managed = 0; const inherited = target.sched.strand();
    try { if (await target.resolveClass(childLoader, "Sub", inherited) !== childSub || await target.resolveClass(childLoader, "Shared", inherited) !== expected || await target.resolveClass(childLoader, "java/util/BitSet", inherited) !== boot) throw new Error("native ancestor resolution changed"); } finally { inherited.end(); }
    if (managed) throw new Error("native ancestor lookup entered Java");
    const multi = await construct("dalvik/system/DexClassLoader", paths.join(":")), multiLoader = definingLoader(target, multi);
    const multiSub = p.definedBy(multiLoader, "Sub");
    if (nativeClassLookup(target, multiLoader, "Sub") !== multiSub) throw new Error("later live DEX lookup failed");
    managed = 0; const later = target.sched.strand();
    try { if (await target.resolveClass(multiLoader, "Sub", later) !== multiSub || managed) throw new Error("later DEX resolution entered Java"); }
    finally { later.end(); }
    const inactive = await construct(), inactiveLoader = definingLoader(target, inactive);
    const path = target.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(inactive);
    set(path, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava([], "[Ldalvik/system/DexPathList$Element;") as object);
    if (nativeClassLookup(target, inactiveLoader, "Shared")) throw new Error("metadata-only class bypassed the live path");
    managed = 0;
    const blocked = target.sched.strand();
    try { await target.resolveClass(inactiveLoader, "Shared", blocked); throw new Error("empty live path resolved Shared"); }
    catch (e) { const t = target.throwable(e); if (!t || target.classNameOf(t) !== "java/lang/ClassNotFoundException") throw e; }
    finally { blocked.end(); }
    if (!managed) throw new Error("empty path skipped canonical loader failure");
    const reordered = await construct("dalvik/system/DexClassLoader", paths.join(":")), reorderedLoader = definingLoader(target, reordered);
    const reorderedPath = target.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(reordered);
    const elements = target.fieldReader<object>("dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;")(reorderedPath);
    const reversed = [];
    for (let i = target.bridge.arrayLength(elements) - 1; i >= 0; i--) reversed.push(target.bridge.toHost(target.bridge.element(elements, i)));
    set(reorderedPath, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava(reversed, "[Ldalvik/system/DexPathList$Element;") as object);
    if (nativeClassLookup(target, reorderedLoader, "Shared")) throw new Error("reordered path accepted stale metadata winner");
    managed = 0; const reorderedStrand = target.sched.strand();
    try { await target.resolveClass(reorderedLoader, "Shared", reorderedStrand); } finally { reorderedStrand.end(); }
    if (!managed) throw new Error("reordered path skipped managed lookup");
    const custom = await construct("Ldr$MemberLoader");
    if (nativeClassLookup(target, definingLoader(target, custom), "Shared")) throw new Error("custom subclass accepted natively");
    const customChild = await construct("dalvik/system/DexClassLoader", paths[1], custom);
    if (nativeClassLookup(target, definingLoader(target, customChild), "Sub")) throw new Error("custom parent delegation bypassed");
    const sharing = await construct(), sharingLoader = definingLoader(target, sharing);
    const libraries = (peers: (object | null)[]) => target.bridge.toJava(peers.map(peer => peer && target.bridge.toHost(peer)), "[Ljava/lang/ClassLoader;") as object;
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== p.definedBy(sharingLoader, "Shared")) throw new Error("empty shared graph blocked its own path");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([null]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== p.definedBy(sharingLoader, "Shared")) throw new Error("null shared loader boot miss blocked its own path");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([custom]));
    if (nativeClassLookup(target, sharingLoader, "Shared")) throw new Error("custom shared delegation bypassed");
    set(sharing, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoaders", "[Ljava/lang/ClassLoader;", libraries([peer]));
    if (nativeClassLookup(target, sharingLoader, "Shared") !== expected) throw new Error("live shared-before precedence lost");
    managed = 0; const shared = target.sched.strand();
    try { if (await target.resolveClass(sharingLoader, "Shared", shared) !== expected || managed) throw new Error("shared-before resolution entered Java"); }
    finally { shared.end(); }
    const afterPeer = await construct(), afterLoader = definingLoader(target, afterPeer);
    const afterPath = target.fieldReader<object>("dalvik/system/BaseDexClassLoader", "pathList", "Ldalvik/system/DexPathList;")(afterPeer);
    set(afterPath, "dalvik/system/DexPathList", "dexElements", "[Ldalvik/system/DexPathList$Element;", target.bridge.toJava([], "[Ldalvik/system/DexPathList$Element;") as object);
    set(afterPeer, "dalvik/system/BaseDexClassLoader", "sharedLibraryLoadersAfter", "[Ljava/lang/ClassLoader;", libraries([peer]));
    if (nativeClassLookup(target, afterLoader, "Shared") !== expected) throw new Error("live shared-after path lost");
    managed = 0; const after = target.sched.strand();
    try { if (await target.resolveClass(afterLoader, "Shared", after) !== expected || managed) throw new Error("shared-after resolution entered Java"); }
    finally { after.end(); }

  }
  console.log("native loader paths: app-root, multi-DEX, parent, boot and live shared-before/after identities; removed/reordered paths and custom graphs retain Java lookup");
}
