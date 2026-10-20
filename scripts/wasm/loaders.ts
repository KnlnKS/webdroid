// Class loaders: two DexClassLoaders over dex files that define the same class name (tests/fixtures/wasm/java/Ldr.java) keep distinct classes, statics and Class
// objects, see the app's interface through their parent, and answer Class.forName, loadClass, getClassLoader and reflection each in its own namespace.
// The archives a loader opens (loaders-archives.ts), default methods across loaders (loaders-defaults.ts) and native class paths (loaders-paths.ts) are
// modules of their own. Needs javac and the Android SDK. Run: pnpm wasm loaders
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { loadDexes, program, world } from "./lib.ts";
import { Program, ACC, PlainClass, javaName } from "../../src/wasm/compiler/program.ts";
import { COUNT_BASE, HOT_BUDGET } from "../../src/wasm/compiler/exc.ts";
import { mid } from "../../src/wasm/compiler/ids.ts";
import { wasmJni } from "../../src/wasm/host/jni.ts";
import { jniInit, deref, javaVM } from "../../src/native/jni.ts";
import { useJniVm, vm as priorJniVm } from "../../src/native/jnivm.ts";
import { Cpu, setA64 } from "../../src/native/cpu.ts";
import { mem } from "../../src/native/mem.ts";
import { ldp, PTR } from "../../src/native/host.ts";
import { mainThread } from "../../src/jvm/natives/jentry.ts";
import { definingLoader } from "../../src/wasm/link/loaders.ts";
import { prepareMethod } from "../../src/jvm/prepared.ts";
import { Pool, u2, u4 } from "./classfile.ts";
import { Compiler } from "../../src/wasm/compiler/j2w.ts";
import { typeFailure, canAccess } from "../../src/wasm/compiler/linkage.ts";
import type { Code } from "../../src/wasm/compiler/code.ts";
import { St } from "../../src/wasm/compiler/hostcalls.ts";
import { HOSTED } from "../../src/wasm/link/hostapi.ts";
import { wasmEntry } from "../../src/wasm/host/entry.ts";
import { mountPlatform, natives } from "./harness.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { androidFixture, checker, java, javac, tempDir } from "./tools.ts";
import { archives } from "./loaders-archives.ts";
import { defaults } from "./loaders-defaults.ts";
import { nativePaths } from "./loaders-paths.ts";

const out = tempDir();
/** compiles `sources` (against the Android API and `classpath`) and dexes the classes; answers the dex */
const build = (dir: string, sources: string[], classpath: string[] = []) => {
  const to = join(out, dir);
  javac(to, sources.map((s) => join(JAVA, s)), { release: 11, classpath, android: true });
  if (dir === "b") {
    const p = new Pool(), self = p.cls("TypeSite"), sup = p.cls("java/lang/Object");
    const method = (name: string, descriptor: string) => {
      const code = [0x13, ...u2(p.methodType(descriptor)), 0xb0], body = [...u2(1), ...u2(0), ...u4(code.length), ...code, ...u2(0), ...u2(0)];
      return [...u2(9), ...u2(p.utf8(name)), ...u2(p.utf8("()Ljava/lang/invoke/MethodType;")), ...u2(1), ...u2(p.utf8("Code")), ...u4(body.length), ...body];
    };
    const methods = [method("value", "(LShared;)LShared;"), method("missing", "()LAbsentOptional;")];
    writeFileSync(join(to, "TypeSite.class"), Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61, ...u2(p.count), ...p.bytes, ...u2(0x21), ...u2(self), ...u2(sup), ...u2(0), ...u2(0), ...u2(methods.length), ...methods.flat(), ...u2(0)]));
  }
  const classes = readdirSync(to, { recursive: true, encoding: "utf8" }).filter(path => /\.class$/.test(path) && !/(^|\/)(AbsentOptional|MissingCatch|UnusedMemberType)\.class$/.test(path)).map(path => join(to, path));
  return join(androidFixture({ out: to, classpath, minApi: dir === "b" ? 34 : 26, classes }), "classes.dex");
};
const app = build("app", ["Ldr.java", "Tag.java"]);
const common = build("common", ["Tag.java"]), layeredApp = build("layeredapp", ["Ldr.java"], [join(out, "app")]);
const a = build("a", ["ldr1/Shared.java", "ldr1/Boom.java", "members1/pack/PackageBase.java", "members1/pack/PackageType.java", "members1/MemberBase.java", "members1/MemberContract.java", "members1/MemberType.java"], [join(out, "app")]), b = build("b", ["ldr2/Shared.java", "ldr2/Boom.java", "ldr2/Sub.java", "members2/pack/PackageChild.java", "members2/pack/PackagePrivateChild.java", "members2/pack/PackageType.java", "members2/MemberUse.java", "members2/MemberOverride.java", "members2/MemberImplementation.java", "members2/MemberType.java"], [join(out, "app"), join(out, "a")]);
const suite = checker("loaders"), { check, fail } = suite;
await archives(suite, out, app, a, b);
// the files the loaders open: libcore finds them through the file system, the World reads their dex
const files = new Map([["/data/local/tmp/a.dex", a], ["/data/local/tmp/b.dex", b]]);
for (const [path, file] of files) vfs.mount(path, new BytesFile(new Uint8Array(readFileSync(file))));
await mountPlatform(ROOT);
const w = world([app, ...PLATFORM_PATHS], { natives, dexes: (path) => (files.has(path) ? loadDexes(files.get(path)!) : undefined) });

const CHECKS = ["the loaders define distinct Shared classes", "getClassLoader", "loadClass finds the class again", "statics are separate", "isInstance does not cross", "both implement the app's Tag",
  "cast across loaders fails", "Class.forName with a loader", "a class only the other loader defines, and its superclass", "the parent's classes are found through the loader", "signatures name the loader's class",
  "a method of the other loader's types is not found", "return types and receivers", "array classes", "loader identity and parent", "exceptions of a loader's own classes"];
const gaps = new Set<string>();
w.onGap = (gap) => gaps.add(gap);
let got: number;
try { got = await w.entryAsync("Ldr", "check", "(Ljava/lang/String;Ljava/lang/String;)I")("/data/local/tmp/a.dex", "/data/local/tmp/b.dex") as number; } catch (e) {
  const t = w.throwable(e);
  if (!t) throw e;
  const detail = w.fieldReader<object | null>("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(t);
  fail(`Ldr.check threw ${w.classNameOf(t)}: ${detail ? w.hostString(detail) : null}; gaps hit: ${[...gaps].join("; ") || "none"}`);
  process.exit(1);
}
for (const [bit, what] of CHECKS.entries()) if (got & (1 << bit)) fail(what);
// Lazy platform archives wait for their bytes before defining the loader's classes.
w.opts.dexes = async (path) => {
  await new Promise<void>(resolve => queueMicrotask(resolve));
  return files.has(path) ? loadDexes(files.get(path)!) : undefined;
};
const deferred = await w.entryAsync("Ldr", "check", "(Ljava/lang/String;Ljava/lang/String;)I")("/data/local/tmp/a.dex", "/data/local/tmp/b.dex") as number;
if (deferred) fail(`deferred archive checks: ${deferred}`);
const desc = "(Ljava/lang/String;Ljava/lang/String;)I", paths = ["/data/local/tmp/a.dex", "/data/local/tmp/b.dex"];
const memberResult = await w.entryAsync("Ldr", "memberResolution", desc)(...paths);
check("binary member descriptors", memberResult, 31);
console.log(`binary member descriptors: wasm=${memberResult}; denied type retries, unused prototype stays lazy, declaring reflection identity preserved`);
for (const method of ["memberConstraints", "memberInterfaceConstraints", "memberIndirectConstraints", "memberReentrantConstraints"]) {
  const result = await w.entryAsync("Ldr", method, desc)(...paths);
  console.log(`${method}: wasm=${result}, expected=255`);
  check(method, result, 255);
}
for (const method of ["memberHostRetry", "memberHostWaitRetry"]) {
  const original = w.javaString, hostFn = w.helpers.hostFn, failure = new Error("constraint host failure");
  let injected = false;
  if (method === "memberHostRetry") w.javaString = function(value: string) {
    if (!injected && value === "MemberType") { injected = true; throw failure; }
    return original.call(this, value);
  };
  else w.helpers.hostFn = function(...args: Parameters<typeof hostFn>) {
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
    if (caught !== failure || !injected) fail(`${method}: signature host failure changed kind`);
  } finally { w.javaString = original; w.helpers.hostFn = hostFn; }
  const retry = await w.entryAsync("Ldr", method, desc)(...paths);
  check(`${method}: signature host failure prevented retry`, retry, 7);
  console.log(`${method}: original host error propagated, same class retries successfully`);
}
{
  javac(join(out, "witness"), [join(JAVA, "PackageLoaderControl.java")], { release: 11 });
  const control = java(join(out, "witness"), "PackageLoaderControl", [join(out, "a"), join(out, "b")]).trim();
  if (control !== "1122\n1122\n2222\n112222\n112222\n222222") fail(`package runtime-package JDK control: ${control}`);
  console.log(`package runtime-package JDK control: ${control.replaceAll("\n", ",")}`);
  for (const ownType of [true, false]) {
    const signature = "(Ljava/lang/String;Ljava/lang/String;Z)I", args = [...paths, ownType];
    const result = await w.entryAsync("Ldr", "packageMembers", signature)(...args);
    console.log(`package-private dispatch ownType=${ownType}: wasm=${result}, expected=1122`);
    check("package-private dispatch", result, 1122);
  }
  const same = await w.entryAsync("Ldr", "packageSameLoader", desc)(...paths);
  check("same-loader package-private override", same, 2222);
  console.log(`same-loader package-private override: wasm=${same}, jdk=2222`);
  for (const ownType of [true, false]) {
    const result = await w.entryAsync("Ldr", "packagePrivateMembers", "(Ljava/lang/String;Ljava/lang/String;Z)I")(...paths, ownType);
    console.log(`package-private child ownType=${ownType}: wasm=${result}, jdk=112222 (inherited11, own22, reflective22)`);
    check("package-private child slot", result, 112222);
  }
  const privateSame = await w.entryAsync("Ldr", "packagePrivateSameLoader", desc)(...paths);
  check("same-loader package-private child slot", privateSame, 222222);
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
      if (!throwable || w.classNameOf(throwable) !== "java/lang/IllegalAccessError") fail(`nonpublic IMT implementation accepted: ${flags}`);
    } finally { method.flags = original; }
  }
  console.log("nonpublic IMT miss: package/private/protected rejected with IllegalAccessError");
}
{
  const result = await w.entryAsync("Ldr", "hierarchyDelegateLast", desc)(...paths);
  check("defining hierarchy mirrors", result, 7);
  console.log(`defining hierarchy mirrors: wasm=${result}`);
}
{
  const caught = await w.entryAsync("Ldr", "catchResolution", "(Ljava/lang/String;)I")(paths[1]);
  check("executed catch loader", caught, 31);
  console.log("executed catch loader: wasm=31; untaken handler types stay lazy, suspended denial retries, successful identity stays cached, missing types preserve the original exception");
  {
    const boot = world(new Program([], program([...PLATFORM_PATHS, common, b])), { natives });
    if (boot.prog.loaderOf("Shared") !== boot.prog.boot) fail("catch fixture is not boot-defined");
    const select = boot.entry("Shared", "catchOnly", "(Z)I");
    if (select(0) !== 7 || boot.prog.initiatedBy(boot.prog.boot, "CatchOnly")) fail("untaken boot catch resolved its type");
    if (select(1) !== 42 || await boot.entryAsync("Shared", "catchOnly", "(Z)I")(1) !== 42) fail("compiled boot catch did not preserve the original throwable");
    if (boot.prog.initiatedBy(boot.prog.boot, "CatchOnly") !== "CatchOnly" || boot.prog.initiatedBy(boot.prog.boot, "MissingCatch")) fail("executed boot catches did not retain only successful resolution");
    if (!boot.stats.methods) fail("boot catch fixture did not run compiled code");
    console.log("compiled boot catch: plain and strand select RuntimeException after missing/nonmatching catch types");
  }
  const actualType = await w.entryAsync("Ldr", "typeDelegateLast", desc)(...paths);
  check("executed method-type loader", actualType, 7);
  console.log("executed method-type loader: wasm=7; unused optional signature stays lazy");
  const expected = 42, result = await w.entryAsync("Ldr", "symbolicDelegateLast", desc)(...paths);
  check("uninitiated symbolic class reference", result, expected);
  /** Shared as a new symbolicLoader defines it */
  const symbolicShared = async () => {
    const object = await w.entryAsync("Ldr", "symbolicLoader", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/ClassLoader;")(...paths) as object, owner = w.sched.strand();
    try { return await w.resolveClass(definingLoader(w, object), "Shared", owner); } finally { owner.end(); }
  };
  const key = await symbolicShared();
  const handedData: WeakRef<object>[] = [], handingCompilers: WeakRef<object>[] = [];
  const analysisOf = Compiler.prototype.analysis;
  Compiler.prototype.analysis = function (m, last) {
    const analysis = analysisOf.call(this, m, last);
    // the symbolic sites of the method are declared from its analysis
    if (!last && m === w.prog.require(key).byKey.get("symbolic()I")) { handingCompilers.push(new WeakRef(this)); handedData.push(new WeakRef(analysis.prepared), new WeakRef(analysis.typing)); }
    return analysis;
  };
  let call: ReturnType<typeof w.entryAsync>;
  try {
    call = w.entryAsync(key, "symbolic", "()I");
    if (await call() !== 42) fail("symbolic direct entry failed");
  } finally { Compiler.prototype.analysis = analysisOf; }
  const resolutions = w.symbolic.symbolicResolutions, stubModules = w.symbolic.symbolicStubModules;
  for (let i = 0; i < 3; i++) if (await call() !== 42) fail("cached symbolic operation failed");
  if (w.symbolic.symbolicResolutions !== resolutions) fail("resolved symbolic site entered the loader bridge again");
  if (w.symbolic.symbolicStubModules !== stubModules) fail("warm symbolic operation rebuilt stub modules");
  console.log(`symbolic cache: first resolutions=${resolutions}, stub modules=${stubModules}; repeat resolutions=${w.symbolic.symbolicResolutions - resolutions}, stub modules=${w.symbolic.symbolicStubModules - stubModules}`);
  {
    const method = w.prog.require(key).byKey.get("symbolic()I")!;
    const ins = prepareMethod(method.dex.code(method.codeOff)).instructions.find(ins => ins.name === "invoke-static")!;
    const before = { ...w.stats }, symbols = w.symbolic.symbolicImports([["accounting:probe", key, method.index, ins.pc, [], "I"]]);
    if (w.stats.units !== before.units + 1 || w.stats.bytes <= before.bytes || w.stats.compileMs <= before.compileMs) fail("symbolic stub compilation unaccounted");
    const table = symbols.table as WebAssembly.Table, slot = (symbols["accounting:probe"] as WebAssembly.Global).value as number;
    const stub = { ...w.stats };
    if (table.get(slot)!() !== 42) fail("accounted symbolic operation failed");
    if (w.stats.units !== stub.units || w.stats.bytes !== stub.bytes || w.stats.compileMs <= stub.compileMs) fail("shared symbolic operation rebuilt code or lost resolution accounting");
    const warm = { ...w.stats };
    if (table.get(slot)!() !== 42 || w.stats.units !== warm.units || w.stats.bytes !== warm.bytes || w.stats.compileMs !== warm.compileMs) fail("warm symbolic operation compiled again");
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
    if (!syncFailed || !asyncFailed || w.assumptions.absent.get(later)?.size !== 2) fail("helper dependencies lack invalidation slots");
    w.addClass(new PlainClass(later, "java/lang/Object", [], ACC.PUBLIC), new Map());
    const resumed = w.sched.strand();
    try {
      if (helper() !== 42 || await waitingHelper(resumed) !== 42) fail("retained helper did not recover after class arrival");
      const units = w.stats.units;
      if (helper() !== 42 || await waitingHelper(resumed) !== 42 || w.stats.units !== units) fail("warm helper recompiled");
    } finally { resumed.end(); }
    console.log("helper accounting: two owned absence slots recover cached sync/strand functions after class arrival; warm calls unchanged");
    const accountingWorld = world(w.prog, { natives }), initial = { ...accountingWorld.stats };
    const throwable = accountingWorld.makeThrowable("java/lang/IllegalStateException", "accounted helper");
    if (accountingWorld.stats.units <= initial.units || accountingWorld.stats.bytes <= initial.bytes || accountingWorld.stats.compileMs <= initial.compileMs) fail("throwable helper compilation unaccounted");
    const beforeReader = { ...accountingWorld.stats }, reader = accountingWorld.fieldReader<object | null>("java/lang/Throwable", "detailMessage", "Ljava/lang/String;");
    if (accountingWorld.stats.units !== beforeReader.units + 1 || accountingWorld.stats.bytes <= beforeReader.bytes || accountingWorld.stats.compileMs <= beforeReader.compileMs) fail("field reader compilation unaccounted");
    if (accountingWorld.hostString(reader(throwable)!) !== "accounted helper") fail("accounted throwable detail changed");
    const warmHelpers = { ...accountingWorld.stats };
    const again = accountingWorld.makeThrowable("java/lang/IllegalStateException", null);
    if (reader(again) !== null || accountingWorld.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;") !== reader || accountingWorld.stats.units !== warmHelpers.units || accountingWorld.stats.bytes !== warmHelpers.bytes || accountingWorld.stats.compileMs !== warmHelpers.compileMs) fail("warm throwable or reader helper compiled again");
    console.log("helper accounting: throwable and field reader record units and bytes; warm calls unchanged");
    {
      const stubs: WeakRef<object>[] = [], compilers: WeakRef<object>[] = [];
      const emit = Compiler.prototype.buildSynthetics;
      Compiler.prototype.buildSynthetics = function (...args: Parameters<typeof emit>) { compilers.push(new WeakRef(this)); return emit.apply(this, args); };
      const before = { ...w.stats.phase };
      try {
        const bindings = w.symbolic.symbolicImports(Array.from({ length: 32 }, (_, i) => [`memory:${i}`, key, method.index, ins.pc, [], "I"]));
        for (let i = 0; i < 32; i++) {
          const slot = (bindings[`memory:${i}`] as WebAssembly.Global).value as number;
          stubs.push(new WeakRef((bindings.table as WebAssembly.Table).get(slot)!));
          if ((bindings.table as WebAssembly.Table).get(slot)!() !== 42) fail("memory probe operation failed");
        }
        if (w.stats.phase.prepare !== before.prepare || w.stats.phase.infer !== before.infer) fail("symbolic operation reanalyzed its method");
      } finally {
        Compiler.prototype.buildSynthetics = emit;
      }
      const collect = (globalThis as typeof globalThis & { gc: () => void }).gc;
      check("symbolic lifetime probe compilers (shared operations are not rebuilt)", compilers.length, 1);
      const heapBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 0)); collect(); }
      const retainedStubs = stubs.filter(ref => ref.deref()).length;
      console.log(`symbolic stubs: replaced=${stubs.length}, retained=${retainedStubs}`);
      if (stubs.length !== 32 || retainedStubs) fail("replaced symbolic stubs retained");
      const retainedCompilers = compilers.filter(ref => ref.deref()).length;
      console.log(`symbolic lifetime: compilers=${compilers.length}, retained=${retainedCompilers}; heap before GC=${heapBefore}, after GC=${process.memoryUsage().heapUsed}`);
      if (retainedCompilers || w.prog.require(key).byKey.get("symbolic()I") !== method || table.get(slot)!() !== 42) fail("symbolic compiler retained by live Program or compiled operation");
      const heldCompilers = handingCompilers.filter(ref => ref.deref()).length, heldData = handedData.filter(ref => ref.deref()).length;
      console.log(`method analysis lifetime: compilers=${handingCompilers.length}, retained=${heldCompilers}; data=${handedData.length}, retained=${heldData}`);
      if (handingCompilers.length !== 1 || handedData.length !== 2 || heldCompilers || heldData) fail("symbolic resolution retained method compiler or typing");
    }
  }
  const operands = w.entryAsync(key, "symbolicOperands", "()I");
  for (let i = 0; i < 2; i++) if (await operands() !== 15) fail("symbolic aliased operands or floating/wide bits changed");
  console.log("symbolic operands: aliased references and arguments, float/double signed zero and full-width long survive fields and invocation");
  if (await w.entryAsync(key, "optional", "(Z)I")(0) !== 7) fail("unused optional reference resolved eagerly");
  try { await w.entryAsync(key, "optional", "(Z)I")(1); fail("missing optional reference accepted"); }
  catch (e) { const t = w.throwable(e); if (!t || w.classNameOf(t) !== "java/lang/NoClassDefFoundError") throw e; }
  console.log(`uninitiated symbolic class reference: wasm=${result}; warm site resolutions=0; optional reference lazy`);
  // promotion copies, over a namespace of its own whose helper nothing has initiated
  {
    const key = await symbolicShared(), loader = w.prog.loaderOf(key), method = w.prog.require(key).byKey.get("symbolic()I")!;
    const helperKey = w.prog.lookup(loader, "SymbolicHelper")!, helper = w.prog.require(helperKey).byKey.get("value()I")!;
    if (w.prog.initiatedBy(loader, "SymbolicHelper")) fail("copy fixture helper already initiated");
    const slot = w.slotOf(method), helperSlot = w.slotOf(helper);
    await w.tiers.linkSlot(slot); await w.tiers.linkSlot(helperSlot);
    new Int32Array(w.mem.buffer, COUNT_BASE + 4 * helperSlot, 1)[0] = HOT_BUDGET;
    const before = w.tiers.upgradeJob(slot);
    if (!before || [...before.installed, ...before.copies].includes(mid(helper))) fail("symbolic promotion selected an unresolved local copy");
    if (w.prog.initiatedBy(loader, "SymbolicHelper")) fail("promotion eagerly initiated its helper");
    const strand = w.sched.strand();
    let resolved: string;
    try { resolved = await w.resolveClass(loader, "SymbolicHelper", strand); } finally { strand.end(); }
    const winner = w.prog.require(resolved).byKey.get("value()I")!, winnerSlot = w.slotOf(winner);
    await w.tiers.linkSlot(slot); await w.tiers.linkSlot(winnerSlot);
    new Int32Array(w.mem.buffer, COUNT_BASE + 4 * winnerSlot, 1)[0] = HOT_BUDGET;
    const after = w.tiers.upgradeJob(slot);
    if (!after?.copies.includes(mid(winner)) || resolved !== helperKey && after.copies.includes(mid(helper))) fail("promotion did not recheck the Java loader's winning helper");
    if (await w.entryAsync(key, "symbolic", "()I")() !== expected) fail("copy fixture changed Java result");
    console.log("promotion copies: unresolved helper excluded without loading; initiated helper copied on next selection; wasm=42");
  }
}
const wasmCustom = await w.entryAsync("Ldr", "customParent", desc)(...paths);
check("inherited parent-first loader", wasmCustom, 121);
{
  const proxies = await w.entryAsync("Ldr", "proxyLoaders", desc)(...paths);
  check("proxy defining loaders, duplicate binary names, bootstrap isolation, public cache, arrays and defensive duplicate rejection", proxies, 8191);
}
const wasmDelegate = await w.entryAsync("Ldr", "delegateLast", desc)(...paths);
check("actual delegate-last initiation and ordinary parent-first control", wasmDelegate, 31);

{
  const p = new Program(loadDexes(a), program([...PLATFORM_PATHS, app]));
  const cache = world(p, { natives }), child = p.newLoader(p.root, null);
  cache.addDexes(loadDexes(b), child);
  const key = p.definedBy(child, "Shared")!, cls = p.get(key)!;
  const self = cls.byKey.get("self()LShared;")!, peer = cls.fields.find(f => f.name === "peer")!;
  const type = cls.dex!.proto(cls.dex!.method(self.methodIdx).proto).ret;
  if (p.typesOf(cls.dex!).type(type) !== "LShared;" || peer.desc !== "LShared;") fail("fixture did not warm the parent resolution");
  const epoch = cache.epoch;
  cache.namespaces.initiateClass(child, "Shared", key);
  const sub = p.definedBy(child, "Sub")!;
  if (!p.isSubclass(sub, key) || p.isSubclass(sub, "Shared")) fail("initiated superclass identity retained stale subtype relationships");
  if (p.lookup(child, "Shared") !== key || p.typesOf(cls.dex!).type(type) !== `L${key};` || self.ret !== `L${key};` || peer.desc !== self.ret || cls.byKey.get(self.key) !== self || cache.epoch !== epoch + 1) fail("initiating identity retained stale DEX/member caches");
  const implementors = () => [...p.own()].filter(c => p.isSubclass(c.name, "NamespaceFace")).map(c => c.name).join();
  const prior = implementors();
  cache.namespaces.initiateClass(child, "SymbolicHelper", p.definedBy(child, "SymbolicHelper")!);
  if (implementors() !== prior) fail("descriptor-only initiation changed subtype relationships");
  const face = p.definedBy(child, "NamespaceFace")!;
  cache.namespaces.initiateClass(child, "NamespaceFace", face);
  if (!p.isSubclass(key, face) || p.isSubclass(key, "NamespaceFace")) fail("initiated interface identity retained stale subtype relationships");
  cache.link(key);
  try { cache.namespaces.initiateClass(child, "Shared", "Shared"); fail("conflicting initiated identity accepted"); }
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
      fail(`JNI descriptor/array namespace of ${name}: expected=${expected}, descriptor=${p.viewOf(name, "([LShared;Ljava/lang/String;)LShared;")}, array=${jni.find("[LShared;", owner)?.name}`);
    }
  }
  const shared = jni.find(visible!, null)!;
  const object = await jni.construct(shared, "()V", []);
  const field = jni.field(shared, "peer", "LShared;", false);
  if (!field || !jni.hasMethod(shared, "self", "()LShared;", false) || !jni.hasMethod(shared, "same", "(LShared;LShared;)Z", true)) {
    fail("JNI member descriptors");
  } else {
    jni.set(field, object, object);
    if (jni.get(field, object) !== object || await jni.invoke(shared, "self", "()LShared;", false, object, [], false) !== object || !await jni.invoke(shared, "same", "(LShared;LShared;)Z", true, null, [object, object], false)) {
      fail("JNI member invocation/field identity");
    }
  }
  if (childSelf.ret !== `L${visible};` || childPeer.desc !== childSelf.ret || childClass.byKey.get(childSelf.key) !== childSelf) {
    fail(`dependent loader caches: self=${childSelf.ret}, peer=${childPeer.desc}, visible=${visible}`);
  }
  if (result !== 21 || visible === "Shared" || !visible || self.ret !== `L${visible};` || peer.desc !== self.ret || cls.fields.find(f => f.name === "peer") !== peer || cls.byKey.get(self.key) !== self || cls.byKey.get(`alias()L${visible};`) !== self || cls.byKey.has("self()LShared;") || cls.byKey.has("alias()LShared;") || appDexes[0].rawType(retIndex) !== "LShared;" || p.typesOf(appDexes[0]).type(retIndex) !== self.ret) {
    fail(`${asynchronous ? "deferred" : "synchronous"} library graph: result=${result}, visible=${visible}, self=${self.ret}, peer=${peer.desc}`);
  }
  const hostedSpec = { name: childClass.name, sup: childClass.sup, ifaces: [], methods: ["toString()Ljava/lang/String;"], fields: [], ctor: class {} };
  layered.addHostClass(hostedSpec);
  if (p.loaderOf(childClass.name + HOSTED) !== child || p.lookup(p.boot, childClass.name + HOSTED)) fail("hosted custom class lost its defining loader");
  const iface = new PlainClass(`fixture/HostedInterface@${child.id}`, "java/lang/Object", [], ACC.PUBLIC | ACC.INTERFACE | ACC.ABSTRACT);
  layered.addClass(iface, new Map(), child);
  const shell = layered.hosts.javaClass({ ...hostedSpec, name: iface.name, methods: [] });
  if (p.loaderOf(shell) !== child || p.lookup(p.boot, shell)) fail("hosted interface shell lost its defining loader");

}
{
  const base = new Program([]), custom = base.newLoader(base.boot, null);
  const synthetic = (name: string) => new PlainClass(name, "java/lang/Object", [], ACC.PUBLIC);
  base.addClass(synthetic("fixture/BaseApp"), base.root);
  base.addClass(synthetic("fixture/BaseBoot@0"), base.boot);
  base.addClass(synthetic(`fixture/BaseCustom@${custom.id}`), custom);
  const peer = synthetic("fixture/Peer");
  base.addClass(peer, base.root);
  const appClass = base.require("fixture/BaseApp") as PlainClass, childClass = base.require(`fixture/BaseCustom@${custom.id}`);
  if (!canAccess(base, peer.name, appClass, 0) || canAccess(base, childClass.name, appClass, 0)
    || !canAccess(base, childClass.name, appClass, ACC.PUBLIC)) fail("runtime package access lost defining-loader identity");
  appClass.flags = 0;
  if (!canAccess(base, peer.name, appClass, ACC.PUBLIC) || canAccess(base, childClass.name, appClass, ACC.PUBLIC)) fail("non-public class crossed runtime packages");
  appClass.flags = ACC.PUBLIC;
  const derived = new Program([], base);
  if (derived.lookup(derived.boot, "fixture/BaseApp") || derived.lookup(derived.boot, "fixture/BaseCustom") || derived.lookup(derived.boot, "fixture/BaseBoot") !== "fixture/BaseBoot@0" || derived.loaderOf("fixture/BaseApp") !== base.root || derived.loaderOf(`[Lfixture/BaseCustom@${custom.id};`) !== custom || derived.loaderOf("[Lfixture/BaseBoot@0;") !== derived.boot) fail("inherited synthetic defining loader or bootstrap visibility changed");
}
{
  const base = new Program(loadDexes(a)), custom = base.newLoader(base.boot, null);
  base.add(loadDexes(b), custom);
  const derived = new Program(loadDexes(app), base), platform = derived.get("Shared")!;
  if (!platform.dex || derived.loaderOf("Shared") !== derived.boot || derived.loaderOf("[[LShared;") !== derived.boot || ["[I", "#I", "#V"].some(name => derived.loaderOf(name) !== derived.boot) || derived.loaderOf("Ldr") !== derived.root || derived.loaderOf(base.definedBy(custom, "Sub")!) !== custom || derived.loaderOfDex(platform.dex) !== base.root || derived.lookup(derived.boot, "Shared") !== "Shared") fail("inherited DEX defining loader identity changed class path or confused app and bootstrap");
}
{
  const resolver = world([app, ...PLATFORM_PATHS], { natives, dexes: path => files.has(path) ? loadDexes(files.get(path)!) : undefined });
  let forName: unknown;
  try { forName = await resolver.entryAsync("Ldr", "resolverForName", "(Ljava/lang/String;)I")(paths[0]); }
  catch (error) {
    const value = resolver.throwable(error);
    if (value) console.log("Class.forName fixture failure", resolver.classNameOf(value), resolver.hostString(resolver.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(value)), resolver.stacks.stackTrace(resolver.fieldReader<object>("java/lang/Throwable", "backtrace", "Ljava/lang/Object;")(value)));
    throw error;
  }
  check("Class.forName loader/error boundaries", forName, 63);
  if (await resolver.entryAsync("Ldr", "resolverForNameInit", "()I")() !== 1) fail("Class.forName initialization boundary failed");
  const calls = () => resolver.entryAsync("Ldr", "resolverCalls", "()I")();
  for (const mode of [0, 1, 2, 3]) {
    const object = await resolver.entryAsync("Ldr", "resolverLoader", "(Ljava/lang/String;I)Ljava/lang/ClassLoader;")(paths[0], mode) as object;
    const loader = definingLoader(resolver, object), owner = resolver.sched.strand();
    const before = await calls() as number;
    try {
      if (mode === 0) {
        const pending = resolver.resolveClass(loader, "Shared", owner);
        if (!(pending instanceof Promise)) fail("loader suspension was bypassed");
        const key = await pending;
        if (resolver.resolveClass(loader, "Shared", owner) !== key || await resolver.resolveClass(loader, "[LShared;", owner) !== `[L${key};` || await calls() !== before + 1) fail("successful loader initiation was not canonical");
      } else {
        const expected = mode === 1 ? "java/lang/ClassNotFoundException" : mode === 2 ? "java/lang/NullPointerException" : "java/lang/NoClassDefFoundError";
        for (let retry = 0; retry < 2; retry++) {
          try { await resolver.resolveClass(loader, "Shared", owner); fail("invalid loader result accepted"); }
          catch (e) { const t = resolver.throwable(e); if (!t || resolver.classNameOf(t) !== expected) throw e; }
        }
        if (resolver.prog.initiatedBy(loader, "Shared") || await calls() !== before + 2) fail("failed loader result was cached");
      }
    } finally { owner.end(); }
  }
  for (const mode of [4, 5, 6]) {
    const object = await resolver.entryAsync("Ldr", "resolverLoader", "(Ljava/lang/String;I)Ljava/lang/ClassLoader;")(paths[0], mode) as object;
    const loader = definingLoader(resolver, object), first = resolver.sched.strand(), second = resolver.sched.strand();
    try {
      if (mode === 6) {
        if (resolver.sched.monitors.tryEnter(object, first) !== St.Ok) fail("resolver fixture monitor acquisition failed");
        try {
          await resolver.resolveClass(loader, "Shared", first);
          if (!resolver.sched.monitors.holds(object, first) || resolver.sched.monitors.holds(object, second)) fail("resolver callback lost or borrowed unrelated monitor ownership");
        } finally { if (resolver.sched.monitors.exit(object, first) !== St.Ok) fail("resolver fixture monitor release failed"); }
      } else {
        const pending = [resolver.resolveClass(loader, "Shared", first), resolver.resolveClass(loader, "Shared", second)];
        const winner = await pending[mode === 4 ? 1 : 0];
        await resolver.entryAsync("Ldr", "resolverReleaseRace", "()V")();
        const results = await Promise.all(pending);
        if (results[0] !== results[1] || results[0] !== winner || winner !== resolver.prog.initiatedBy(loader, "Shared")) fail("racing loader calls did not preserve first successful initiation");
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
      resolver.prog.addClass(new PlainClass(owner, "java/lang/Object", [], ACC.PUBLIC), loader);
      const cpu = new Cpu(mainThread, "loader-jni"); cpu.nativeClass = { name: owner };
      const getEnv = ldp(ldp(javaVM.addr) + 6 * PTR);
      if (await cpu.call(getEnv, [javaVM.addr, environment, 0x10006])) fail("JNI fixture GetEnv failed");
      const env = ldp(environment), find = ldp(ldp(env) + 6 * PTR);
      const before = await calls() as number, handle = await cpu.call(find, [env, name]) as number;
      if (await calls() !== before + 1) fail("JNI FindClass bypassed its Java loader");
      if (mode === 0) {
        const key = resolver.prog.initiatedBy(loader, "Shared");
        if (!handle || cpu.exc || jni.classOf(deref(handle, cpu))?.name !== key) fail("suspended JNI FindClass lost its class or reference owner");
      } else if (handle || !cpu.exc || resolver.classNameOf(cpu.exc as object) !== "java/lang/ClassNotFoundException") fail("JNI loader failure did not remain pending");
    }
  } finally { mem.free(name); mem.free(environment); useJniVm(previous); }
}
await defaults(suite, build);
await nativePaths(suite, app, common, files, paths);
suite.done();

