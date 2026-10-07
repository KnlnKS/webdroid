// invoke-custom and MethodHandle call sites: records (ObjectMethods.bootstrap) compiled by javac 17+ and kept as invoke-custom by d8 --no-desugaring, and
// MethodHandle.invoke/invokeExact over each kind of direct handle, run as Wasm, on the production JS tier and on the JDK; the results must match. Needs javac (17+), d8 and java. Run: bun run wasm customdiff
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { jsTier, natives, processState } from "./oracle";
import { loadDexes, world } from "./lib";
import { ACC } from "../../src/wasm/compiler/program";
import { compare, genCases } from "./cases";
import { Pool, u2, u4 } from "./classfile";
import { AOSP, JAVA } from "./paths";
import { shellIn } from "./tools";
import { handleThunk } from "../../src/wasm/link/mhandles";
import { hostBytes, hostAddress, mapExternal, unmapExternal } from "../../src/jvm/natives/jmemory";
import { defaultLoop } from "../../src/wasm/link/sched";
import { UInfo } from "../../src/wasm/link/unsafe";
import { decodeInstructions } from "../../src/jvm/prepared";

/** Pq and Pq2 as javac would not write them: ObjectMethods.bootstrap over a virtual getter (overridden in Pq2) and a virtual name getter, including overridden accessors */
function handClasses(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const build = (name: string, access: number, sup: string, ifaces: string[], pool: Pool, fields: number[][], methods: number[][], attrs: number[][]) => {
    const self = pool.cls(name), parent = pool.cls(sup), interfaces = ifaces.map((i) => pool.cls(i));
    out[name] = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61, ...u2(pool.count), ...pool.bytes, ...u2(access), ...u2(self), ...u2(parent), ...u2(interfaces.length), ...interfaces.flatMap(u2), ...u2(fields.length), ...fields.flat(), ...u2(methods.length), ...methods.flat(), ...u2(attrs.length), ...attrs.flat()]);
  };
  const method = (pool: Pool, access: number, name: string, desc: string, code: number[] | null, locals = 3) => {
    const body = code && [...u2(4), ...u2(locals), ...u4(code.length), ...code, ...u2(0), ...u2(0)];
    return [...u2(access), ...u2(pool.utf8(name)), ...u2(pool.utf8(desc)), ...u2(body ? 1 : 0), ...(body ? [...u2(pool.utf8("Code")), ...u4(body.length), ...body] : [])];
  };
  // interface Ig { String name(); }
  { const p = new Pool(); build("Ig", 0x601, "java/lang/Object", [], p, [], [method(p, 0x401, "name", "()Ljava/lang/String;", null)], []); }
  // class Pq implements Ig { int x; String s; ... }
  const pq = (name: string, sup: string, indy: boolean) => {
    const p = new Pool(), self = `L${name};`, field = (n: string, d: string) => [...u2(0), ...u2(p.utf8(n)), ...u2(p.utf8(d)), ...u2(0)];
    const fx = p.member(9, "Pq", "x", "I"), fs = p.member(9, "Pq", "s", "Ljava/lang/String;"), superInit = p.member(10, sup, "<init>", sup === "Pq" ? "(ILjava/lang/String;)V" : "()V");
    const methods: number[][] = [];
    methods.push(method(p, 1, "<init>", "(ILjava/lang/String;)V", sup === "Pq" ? [0x2a, 0x1b, 0x2c, 0xb7, ...u2(superInit), 0xb1] : [0x2a, 0xb7, ...u2(superInit), 0x2a, 0x1b, 0xb5, ...u2(fx), 0x2a, 0x2c, 0xb5, ...u2(fs), 0xb1]));
    if (name === "Pq") {
      methods.push(method(p, 1, "x", "()I", [0x2a, 0xb4, ...u2(fx), 0xac]), method(p, 1, "name", "()Ljava/lang/String;", [0x2a, 0xb4, ...u2(fs), 0xb0]));
      const bsm = p.member(10, "java/lang/runtime/ObjectMethods", "bootstrap", "(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/TypeDescriptor;Ljava/lang/Class;Ljava/lang/String;[Ljava/lang/invoke/MethodHandle;)Ljava/lang/Object;");
      const args = [p.cls("Pq"), p.string("x;name"), p.methodHandle(5, p.member(10, "Pq", "x", "()I")), p.methodHandle(5, p.member(10, "Pq", "name", "()Ljava/lang/String;"))];
      const site = (what: string, desc: string) => p.invokeDynamic(0, what, desc);
      methods.push(method(p, 1, "toString", "()Ljava/lang/String;", [0x2a, 0xba, ...u2(site("toString", `(${self})Ljava/lang/String;`)), 0, 0, 0xb0]));
      methods.push(method(p, 1, "hashCode", "()I", [0x2a, 0xba, ...u2(site("hashCode", `(${self})I`)), 0, 0, 0xac]));
      methods.push(method(p, 1, "equals", "(Ljava/lang/Object;)Z", [0x2a, 0x2b, 0xba, ...u2(site("equals", `(${self}Ljava/lang/Object;)Z`)), 0, 0, 0xac]));
      const bootstrap = [...u2(p.utf8("BootstrapMethods")), ...u4(2 + 2 + 2 + 2 * args.length + 0), ...u2(1), ...u2(p.methodHandle(6, bsm)), ...u2(args.length), ...args.flatMap(u2)];
      build(name, 0x21, "java/lang/Object", ["Ig"], p, [field("x", "I"), field("s", "Ljava/lang/String;")], methods, [bootstrap]);
    } else {
      methods.push(method(p, 1, "x", "()I", [0x2a, 0xb7, ...u2(p.member(10, "Pq", "x", "()I")), 0x10, 10, 0x68, 0xac]));
      build(name, 0x21, sup, [], p, [], methods, []);
    }
  };
  pq("Pq", "java/lang/Object", true); pq("Pq2", "Pq", false);
  // ldc handles/types become DEX 039 const-method-*; javac cannot express these constants directly.
  {
    const p = new Pool(), methods: number[][] = [];
    const constant = (name: string, index: number, type: string) => methods.push(method(p, 9, name, `()Ljava/lang/invoke/${type};`, [0x13, ...u2(index), 0xb0]));
    const handle = (name: string, kind: number, tag: 9 | 10 | 11, cls: string, member: string, desc: string) => constant(name, p.methodHandle(kind, p.member(tag, cls, member, desc)), "MethodHandle");
    methods.push(method(p, 1, "<init>", "()V", [0x2a, 0xb7, ...u2(p.member(10, "Mh", "<init>", "()V")), 0xb1]));
    methods.push(method(p, 2, "<init>", "(I)V", [0x2a, 0x1b, 0xb7, ...u2(p.member(10, "Mh", "<init>", "(I)V")), 0xb1]));
    methods.push(method(p, 1, "plus", "(I)I", [0x11, ...u2(999), 0xac]));
    methods.push(method(p, 2, "secret", "(I)I", [0x1b, 0x10, 10, 0x68, 0xac]));
    handle("hStatic", 6, 10, "Mh", "add", "(II)I");
    handle("hVirtual", 5, 10, "Mh", "plus", "(I)I");
    handle("hInterface", 9, 11, "Ig", "name", "()Ljava/lang/String;");
    handle("hDirect", 7, 10, "Mc", "secret", "(I)I");
    handle("hSuper", 7, 10, "Mh", "plus", "(I)I");
    handle("hConstructor", 8, 10, "Mh", "<init>", "()V");
    handle("hPrivateConstructor", 8, 10, "Mc", "<init>", "(I)V");
    handle("hStringConstructor", 8, 10, "java/lang/String", "<init>", "([C)V");
    handle("hClone", 5, 10, "[I", "clone", "()Ljava/lang/Object;");
    handle("hGet", 1, 9, "Mh", "f", "I");
    handle("hPut", 3, 9, "Mh", "f", "I");
    handle("hStaticGet", 2, 9, "Mh", "sf", "I");
    handle("hStaticPut", 4, 9, "Mh", "sf", "I");
    handle("hDenied", 7, 10, "Mh", "priv", "(I)I");
    handle("hMissing", 6, 10, "Mh", "absent", "()I");
    handle("hWrongKind", 6, 10, "Mh", "plus", "(I)I");
    handle("hMissingField", 2, 9, "Mh", "absent", "I");
    handle("hMissingConstructor", 8, 10, "Pq2", "<init>", "()V");
    handle("hFinalPut", 3, 9, "Mh", "readOnly", "I");
    handle("hDormant", 2, 9, "Mh$Dormant", "f", "I");
    handle("hWait", 6, 10, "Mh", "waiting", "(ILjava/lang/Thread;Ljava/lang/Object;)I");
    constant("type", p.methodType("([Ljava/lang/String;JD)Ljava/lang/Object;"), "MethodType");
    constant("dormantType", p.methodType("()LMh$Dormant;"), "MethodType");
    constant("missingType", p.methodType("()LAbsent;"), "MethodType");
    build("Mc", 0x21, "Mh", [], p, [], methods, []);
  }
  {
    const p = new Pool(), methods: number[][] = [], bootstraps: number[][] = [];
    const prefix = "(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;";
    const site = (name: string, bsm: string, tail: string, args: number[] = [], ret = "Ljava/lang/invoke/CallSite;") => {
      const index = bootstraps.length;
      bootstraps.push([...u2(p.methodHandle(6, p.member(10, "Bootstrap", bsm, prefix + tail + ")" + ret))), ...u2(args.length), ...args.flatMap(u2)]);
      methods.push(method(p, 9, name, "(I)I", [0x1a, 0xba, ...u2(p.invokeDynamic(index, name, "(I)I")), 0, 0, 0xac], 1));
    };
    methods.push(method(p, 10, "secret", "(I)I", [0x1a, 0x10, 19, 0x60, 0xac], 1));
    site("fixed", "fixed", "I", [p.int(19)]);
    site("collected", "collected", "[I", [p.int(2), p.int(7), p.int(11)]);
    site("constants", "constants", "Ljava/lang/String;Ljava/lang/Class;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;", [p.string("payload"), p.cls("Bootstrap"), p.methodType("(I)I"), p.methodHandle(6, p.member(10, "Bootstrap", "add", "(II)I"))]);
    site("changing", "changing", "");
    site("scalars", "scalars", "JFD", [p.numeric(5, 4294967303n), p.numeric(4, -0), p.numeric(6, 2.5)]);
    site("volatileChanging", "volatileChanging", "");
    site("reentrant", "reentrant", "");
    site("targetFailure", "targetFailure", "");
    site("nonCallSite", "nonCallSite", "", [], "Ljava/lang/Object;");
    site("collectorMismatch", "collectorMismatch", "[Ljava/lang/Object;", [p.string("payload")]);
    for (const [kind, name] of ["failure", "error", "nullSite", "wrong"].entries()) site(name, "failure", "I", [p.int(kind)]);
    site("race", "race", "");
    site("raceFailure", "raceFailure", "");
    const body = [...u2(bootstraps.length), ...bootstraps.flat()];
    build("Dyn", 0x21, "java/lang/Object", [], p, [], methods, [[...u2(p.utf8("BootstrapMethods")), ...u4(body.length), ...body]]);
  }
  return out;
}
const out = mkdtempSync(join(tmpdir(), "j2w-cu-"));
const sh = shellIn(out);
for (const [n, bytes] of Object.entries(handClasses())) writeFileSync(join(out, n + ".class"), bytes);
sh(["javac", "--release", "17", "-cp", out, "-d", out, join(JAVA, "Rec.java"), join(JAVA, "Mh.java"), join(JAVA, "Vh.java"), join(JAVA, "Px.java"), join(JAVA, "Pt.java"), join(JAVA, "Ind.java"), join(JAVA, "Ref.java"), join(JAVA, "Bootstrap.java")]);
sh(["d8", "--release", "--no-desugaring", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^(Rec|Mh|Mc|Vh|Px|Pt|Bootstrap|Dyn|Pq2?|Ig|Ind)(\$.*)?\.class$/.test(f)).map((f) => join(out, f))]);
const dex = join(out, "classes.dex"), jars = [...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(AOSP, j));
await jsTier(loadDexes(dex));
let forceAdmission = false, admissionTurns = 0;
const loop = { ...defaultLoop, due: () => (forceAdmission && admissionTurns < 32) || defaultLoop.due(), yield: (soon: boolean) => {
  if (forceAdmission && admissionTurns < 32) admissionTurns++;
  return defaultLoop.yield(soon);
} };
const w = world([dex, ...jars], { natives, loop }), hit: string[] = [];
const constants = w.prog.require("Mc").methods.filter(m => m.codeOff).flatMap(m => decodeInstructions(m.dex.code(m.codeOff).insns));
const kinds = new Set(constants.filter(i => i.name === "const-method-handle").map(i => w.prog.require("Mc").dex!.methodHandle(i.b).type));
if (kinds.size !== 9 || !constants.some(i => i.name === "const-method-type")) throw new Error("constant fixture must retain both DEX opcodes and all nine handle kinds");
// Pure accessors must already be installed when their host lookup returns, even when lazy admission is due.
const assertEagerFieldAccessors = (tier: typeof w) => {
  const info = tier.host.info;
  tier.host.info = (kind: number, a: number, b: number) => {
    const slot = info(kind, a, b);
    if ([UInfo.FieldGet, UInfo.FieldPut, UInfo.StaticGet, UInfo.StaticPut].includes(kind) && slot) {
      const state = tier.slotAt(slot);
      if (state?.k !== "synth" || !state.done) throw new Error("field accessor still needs lazy admission");
    }
    return slot;
  };
};
assertEagerFieldAccessors(w);
processState(w);
w.onGap = (id) => hit.push(w.gapList[id]);
const methods = ["Rec", "Mh", "Vh", "Px", "Pt", "Bootstrap"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && (c !== "Bootstrap" || m.name.startsWith("tCustom")) && m.flags & ACC.PUBLIC && m.name !== "tConstWait" && m.name !== "tTransformWait" && m.name !== "tTransformConcurrent" && m.name !== "tCustomRace" && m.name !== "tCustomRetry" && m.name !== "tInvokerConcurrent"));
const mh = [0, 1, 2, 3, 7, 12], small: Record<string, number[]> = {
  ...Object.fromEntries(methods.filter((m) => m.cls === "Mh" || m.cls === "Vh" || m.cls === "Px" || m.cls === "Pt" || m.cls === "Bootstrap").map((m) => [m.name, mh])), tCustomFailure: [0], empty: [0], eqNaN: [0, 1, 2], eqOther: [0, 1, 2, 3, 4], nullRecv: [0, 1, 7], ts: [0, 1, 2, 3, 4, 5, 6, 7, 30], hc: [0, 1, 2, 3, 7, 12, 40], nested: [0, 3, 4] };
const cases = [...genCases(methods.filter((m) => m.name !== "eq"), small), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d) => [0, 1, 2, 3, 4, 9].map((a) => ({ m: methods.find((m) => m.name === "eq")!, args: [BigInt(a), BigInt(d)] })))];
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
// ART ClassLinker::ResolveMethodHandleForMethod keeps the named array receiver; the JDK narrows Object.clone's protected receiver to Mc.
// These six rows therefore use ART's receiver rule and array clone semantics, rather than claiming a JDK match.
cases.forEach((c, i) => { if (c.m.name === "tConstClone") { if (jdk[i] !== "throw") throw new Error("JDK array clone receiver changed"); jdk[i] = String(Number(c.args[0]) + 1); } });
const tier = await jsTier(loadDexes(dex));
// the production tier has its own method handle and VarHandle model (jinvoke.ts) and no Class.isRecord: the JDK alone decides those cases
const asJdk = (cls: string, name: string, _d: string, args: unknown[]) => {
  const i = cases.findIndex((c) => c.m.cls === cls && c.m.name === name && c.args.every((a, j) => a === args[j] || Number(a) === Number(args[j])));
  return jdk[i] === "throw" ? Promise.reject(new Error("throw")) : Promise.resolve(entries.get(cases[i].m)!.length === 0 || cases[i].m.ret === "J" ? BigInt(jdk[i]) : Number(jdk[i]));
};
const { bad, blocked, threw } = await compare(cases, (m) => entries.get(m)!, (cls, name, desc, args, inst) => (cls === "Mh" || cls === "Vh" || cls === "Px" || cls === "Pt" || cls === "Bootstrap" || name === "recordInfo" ? asJdk(cls, name, desc, args) : tier(cls, name, desc, args, inst)), jdk, hit);
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match (JS/JDK or documented ART differences); ${threw} threw`);
const cold = world([dex, ...jars], { cold: true, natives, loop });
assertEagerFieldAccessors(cold);
processState(cold);
const constantCases = cases.map((c, i) => ({ ...c, i })).filter(c => c.m.name.startsWith("tConst") || c.m.name.startsWith("tTransform") || c.m.name === "tBind" || c.m.name.startsWith("tCustom") || c.m.name.startsWith("tInvoker") || c.m.name.startsWith("tDirect"));
for (const { m, args, i } of constantCases) {
  let value: unknown;
  try { value = await cold.entryAsync(m.cls, m.name, m.desc)(...args.map(Number)); } catch (e) {
    const throwable = cold.throwable(e);
    throw new Error(`cold ${m.name}: ${throwable ? cold.classNameOf(throwable) : String(e)} (${cold.lastMessage})`, { cause: e });
  }
  if (String(value) !== jdk[i]) throw new Error(`cold ${m.name}: ${value} != ${jdk[i]}`);
}
console.log(`${constantCases.length} constant/transformer/bootstrap cases match on the cold tier`);
let suspendedCases = 0;
for (const [cls, name] of [...["tConstWait", "tTransformWait", "tTransformConcurrent"].map(name => ["Mh", name]), ["Vh", "tInvokerConcurrent"]]) {
  forceAdmission = name === "tInvokerConcurrent";
  const waiting = [-1, 7], reference = sh(["java", "-cp", out, "Ref"], waiting.map(a => `${cls}.${name} ${a}`).join("\n") + "\n").trim().split("\n");
  for (const tier of [w, cold]) for (const [i, a] of waiting.entries()) {
    const value = await tier.entryAsync(cls, name, "(I)I")(a);
    if (String(value) !== reference[i]) throw new Error(`suspended ${name}(${a}): ${value} != ${reference[i]}`);
    suspendedCases++;
  }
}
forceAdmission = false;
if (!admissionTurns) throw new Error("VarHandle concurrency fixture must force lazy-link turns");
console.log(`${admissionTurns} forced admission turns retain eager field accessors`);
console.log(`${suspendedCases} suspended handle cases preserve thread, monitor ownership and exceptions`);
for (const tier of [w, cold]) {
  try {
    const buffer = await tier.entryAsync("Vh", "artViewAllocate", "()Ljava/nio/ByteBuffer;")();
    const setAddress = tier.hostFn("fixture:viewAddress", ["L", "J"], "V", (cx, c) => {
      const owner = "java/nio/Buffer", f = cx.prog.resolveField(owner, "address", "J")!;
      c.lget(0).refCast(cx.structFor(owner)).lget(1).structSet(cx.structFor(owner), cx.fieldIndex(owner, f));
    });
    const bytes = hostBytes(8), view = new DataView(bytes.buffer); view.setInt32(0, 41);
    setAddress(buffer, hostAddress(bytes)!);
    if (await tier.entryAsync("Vh", "artViewUpdate", "(Ljava/nio/ByteBuffer;I)I")(buffer, 7) !== 41 || view.getInt32(0) !== 48) throw new Error("mutable external view update must stay atomic");
    let faults = 0;
    const mapped = mapExternal({ size: 8, read: async (at, n) => { faults++; return new Uint8Array(bytes.buffer).slice(at, at + n); } }, 0, 8);
    try {
      setAddress(buffer, mapped);
      if (await tier.entryAsync("Vh", "artViewRead", "(Ljava/nio/ByteBuffer;)I")(buffer) !== 48 || faults !== 1) throw new Error("immutable mapped view must retain paged whole-width reads");
    } finally { unmapExternal(mapped); }
  } catch (e) { const throwable = tier.throwable(e); throw new Error(`external view: ${throwable ? tier.classNameOf(throwable) : String(e)} (${tier.lastMessage})`, { cause: e }); }
}
console.log("4 external view cases preserve synchronous mutable updates and asynchronous immutable reads");
// ART retries failed linkage (the JDK caches failures), and requires exact collector component types (the JDK adapts them).
for (const tier of [w, cold]) {
  if (await tier.entryAsync("Bootstrap", "artCollectorMismatch", "(I)I")(0) !== 31) throw new Error("ART bootstrap collectors require exact component types");
  if (await tier.entryAsync("Bootstrap", "tCustomRetry", "(I)I")(0) !== 2) throw new Error("ART bootstrap failures must be retried");
  if (await tier.entryAsync("Bootstrap", "artRaceFailure", "(I)I")(0) !== 1) throw new Error("failed bootstrap contender must preserve its error and leave the successful winner installed");
  if (await tier.entryAsync("Bootstrap", "tCustomRace", "(I)I")(0) !== 1) throw new Error("racing bootstrap contenders must invoke the installed winner");
}
console.log("8 ART collector/retry/racing cases match on both tiers");
// A plain callback with a captured async owner cannot create a child stack that outlives its caller.
for (const tier of [w, cold]) {
  const owner = tier.sched.strand(), before = tier.rtImports().depth.value;
  const call = handleThunk(tier, "mh:syncCallbackTest", [], "I", (cx, c) => {
    c.i64(1n); cx.callMethod(c, cx.prog.resolve("java/lang/Thread", "sleep", "(J)V")!); c.i32(7);
  }, owner);
  try {
    tier.synchronous(() => call());
    throw new Error("plain handle callback must reject blocking");
  } catch (e) {
    const t = tier.throwable(e);
    if (!t || tier.classNameOf(t) !== "java/lang/IllegalStateException") throw e;
    if (tier.rtImports().depth.value !== before || tier.sched.strands.some(s => s?.parent === owner)) throw new Error("plain handle callback leaked depth or a nested strand");
  } finally { owner.end(); }
}
console.log("2 synchronous handle callbacks reject blocking without orphan strands");
if (blocked) console.log(`${blocked} cases blocked by a compiler gap: ${[...new Set(hit)].join("; ")}`);
// Missing bootstrap classes fail resolution; libcore LambdaMetafactory returns null and ART wraps that CCE in BME.
const outcome = (name: string) => { try { w.entry("Ind", name, "(I)I")(3); return "returned"; } catch (e) { const t = w.throwable(e); return t ? `${w.classNameOf(t)}: ${w.bridge.toHost(w.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(t))}` : String(e); } };
const concat = outcome("concat"), lambda = outcome("lambda");
if (concat !== "java/lang/NoClassDefFoundError: Failed resolution of: Ljava/lang/invoke/StringConcatFactory;") { console.log(`FAIL concat: ${concat}`); process.exit(1); }
if (!lambda.startsWith("java/lang/BootstrapMethodError")) { console.log(`FAIL lambda: ${lambda}`); process.exit(1); }
process.exit(bad || blocked ? 1 : 0);
