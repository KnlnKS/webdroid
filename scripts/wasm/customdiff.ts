// invoke-custom and MethodHandle call sites: records (ObjectMethods.bootstrap) compiled by javac 17+ and kept as invoke-custom by d8 --no-desugaring, and
// MethodHandle.invoke/invokeExact over each kind of direct handle, run as Wasm and on the JDK; the results must match. Needs javac (17+), d8 and java. Run: pnpm wasm customdiff
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mountPlatform, natives, startProcess } from "./harness.ts";
import { program, world } from "./lib.ts";
import { loadDexes } from "../dexes.ts";
import { ACC, Program } from "../../src/wasm/compiler/program.ts";
import type { World } from "../../src/wasm/link/world.ts";
import { caseLine, compare, genCases } from "./cases.ts";
import { Pool, u2, u4 } from "./classfile.ts";
import { CORE_PATHS, JAVA, ROOT } from "./paths.ts";
import { checker } from "./tools.ts";
import { fixture, javac, onJdk, tempDir } from "../java.ts";
import { handleThunk, handleMemberOwner, handleSignatureTypes, methodTypeSignatureTypes } from "../../src/wasm/link/mhandles.ts";
import { bootstrapReferences } from "../../src/wasm/link/callsites.ts";
import { mapExternal, memorySync, unmapExternal } from "../../src/jvm/natives/jmemory.ts";
import { mem } from "../../src/native/mem.ts";
import { hostLoop } from "../../src/wasm/host/boot.ts";
import { fieldCookie } from "../../src/wasm/link/unsafe.ts";
import { decodeInstructions } from "../../src/jvm/prepared.ts";
import { BytesFile } from "../../src/shell/lazyfile.ts";
import { vfs } from "../../src/shell/vfs.ts";
import { definingLoader } from "../../src/wasm/link/loaders.ts";
import { idOfClass } from "../../src/wasm/link/classes.ts";

import { definitionReady } from "../../src/wasm/link/resolution.ts";
import { UInfo } from "../../src/wasm/compiler/info.ts";

/** Pq and Pq2 as javac would not write them: ObjectMethods.bootstrap over a virtual getter (overridden in Pq2) and a virtual name getter, including overridden accessors */
function handClasses(): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  const build = (name: string, access: number, sup: string, ifaces: string[], pool: Pool, fields: number[][], methods: number[][], attrs: number[][]) => {
    const self = pool.cls(name), parent = pool.cls(sup), interfaces = ifaces.map((i) => pool.cls(i));
    out[name] = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61, ...u2(pool.count), ...pool.bytes, ...u2(access), ...u2(self), ...u2(parent), ...u2(interfaces.length), ...interfaces.flatMap(u2), ...u2(fields.length), ...fields.flat(), ...u2(methods.length), ...methods.flat(), ...u2(attrs.length), ...attrs.flat()]);
  };
  const method = (pool: Pool, access: number, name: string, desc: string, code: number[] | null, locals = 3, stack = 4) => {
    const body = code && [...u2(stack), ...u2(locals), ...u4(code.length), ...code, ...u2(0), ...u2(0)];
    return [...u2(access), ...u2(pool.utf8(name)), ...u2(pool.utf8(desc)), ...u2(body ? 1 : 0), ...(body ? [...u2(pool.utf8("Code")), ...u4(body.length), ...body] : [])];
  };
  // interface Ig { String name(); }
  { const p = new Pool(); build("Ig", 0x601, "java/lang/Object", [], p, [], [method(p, 0x401, "name", "()Ljava/lang/String;", null)], []); }
  // class Pq implements Ig { int x; String s; ... }
  const pq = (name: string, sup: string) => {
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
      const bootstrap = [...u2(p.utf8("BootstrapMethods")), ...u4(2 + 2 + 2 + 2 * args.length), ...u2(1), ...u2(p.methodHandle(6, bsm)), ...u2(args.length), ...args.flatMap(u2)];
      build(name, 0x21, "java/lang/Object", ["Ig"], p, [field("x", "I"), field("s", "Ljava/lang/String;")], methods, [bootstrap]);
    } else {
      methods.push(method(p, 1, "x", "()I", [0x2a, 0xb7, ...u2(p.member(10, "Pq", "x", "()I")), 0x10, 10, 0x68, 0xac]));
      build(name, 0x21, sup, [], p, [], methods, []);
    }
  };
  pq("Pq", "java/lang/Object"); pq("Pq2", "Pq");
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
    constant("loaderType", p.methodType("(LMh$Signature;)LMh$Signature;"), "MethodType");
    build("Mc", 0x21, "Mh", [], p, [], methods, []);
  }
  {
    const p = new Pool();
    const constant = (name: string, index: number, type: string) => method(p, 9, name, `()Ljava/lang/invoke/${type};`, [0x13, ...u2(index), 0xb0]);
    const signature = "(LMh$Signature;)LMh$Signature;", handle = p.methodHandle(6, p.member(10, "Mt", "identity", signature));
    const bsm = p.methodHandle(6, p.member(10, "Bootstrap", "signature", "(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;Ljava/lang/Class;Ljava/lang/invoke/MethodType;Ljava/lang/invoke/MethodHandle;)Ljava/lang/invoke/CallSite;"));
    const args = [p.cls("Mh$Signature"), p.methodType(signature), handle];
    const body = [...u2(1), ...u2(bsm), ...u2(args.length), ...args.flatMap(u2)];
    build("Mt", 0x21, "java/lang/Object", [], p, [], [
      constant("type", p.methodType(signature), "MethodType"),
      constant("handle", handle, "MethodHandle"),
      method(p, 9, "identity", "(LMh$Signature;)LMh$Signature;", [0x2a, 0xb0], 1),
      method(p, 9, "poly", "(Ljava/lang/invoke/MethodHandle;)LMh$Signature;", [0x2a, 0x01, 0xb6, ...u2(p.member(10, "java/lang/invoke/MethodHandle", "invokeExact", "(LMh$Signature;)LMh$Signature;")), 0xb0], 1),
      method(p, 9, "arrayHandle", "()Ljava/lang/invoke/VarHandle;", [0x13, ...u2(p.cls("[LMh$Signature;")), 0xb8, ...u2(p.member(10, "java/lang/invoke/MethodHandles", "arrayElementVarHandle", "(Ljava/lang/Class;)Ljava/lang/invoke/VarHandle;")), 0xb0], 0),
      method(p, 9, "vh", "(Ljava/lang/invoke/VarHandle;)Ljava/lang/Object;", [0x2a, 0x01, 0x03, 0xb6, ...u2(p.member(10, "java/lang/invoke/VarHandle", "get", "([LMh$Signature;I)LMh$Signature;")), 0xb0], 1),
      method(p, 9, "nullPoly", "()I", [0x01, 0x01, 0xb6, ...u2(p.member(10, "java/lang/invoke/MethodHandle", "invokeExact", "(LAbsent;)LAbsent;")), 0x57, 0x03, 0xac], 0),
      method(p, 9, "custom", "()Ljava/lang/Object;", [0x01, 0xba, ...u2(p.invokeDynamic(0, "signature", signature)), 0, 0, 0xb0], 0)
    ], [[...u2(p.utf8("BootstrapMethods")), ...u4(body.length), ...body]]);
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
    const nullable = bootstraps.length, nullableDesc = "([IIIIII)V";
    bootstraps.push([...u2(p.methodHandle(6, p.member(10, "Bootstrap", "nullableRange", prefix + ")Ljava/lang/invoke/CallSite;"))), ...u2(0)]);
    methods.push(method(p, 9, "nullableRange", "([IIIIII)I", [0x2a, 0x1b, 0x1c, 0x1d, 0x15, 4, 0x15, 5,
      0xba, ...u2(p.invokeDynamic(nullable, "nullableRange", nullableDesc)), 0, 0, 0x2a, 0xbe, 0xac], 6, 6));
    const body = [...u2(bootstraps.length), ...bootstraps.flat()];
    build("Dyn", 0x21, "java/lang/Object", [], p, [], methods, [[...u2(p.utf8("BootstrapMethods")), ...u4(body.length), ...body]]);
  }
  return out;
}
/** `e` as an Error naming the Java exception it carries and the World's last message */
const javaError = (w: World, what: string, e: unknown) => {
  const t = w.throwable(e);
  return new Error(`${what}: ${t ? w.classNameOf(t) : String(e)} (${w.lastMessage})`, { cause: e });
};
const out = tempDir();
for (const [n, bytes] of Object.entries(handClasses())) writeFileSync(join(out, n + ".class"), bytes);
javac(out, ["Rec", "Mh", "Vh", "Px", "Pt", "Ind", "Ref", "Bootstrap"].map((c) => join(JAVA, c + ".java")), { release: 17, classpath: [out], android: true });
fixture({ out, minApi: 34, d8: ["--no-desugaring"], classes: /^(Rec|Mh|Mc|Mt|Vh|Px|Pt|Bootstrap|Dyn|Pq2?|Ig|Ind)(\$.*)?\.class$/ });
const dex = join(out, "classes.dex"), jars = CORE_PATHS;
await mountPlatform(ROOT);

let forceAdmission = false, admissionTurns = 0;
const loop = { ...hostLoop, due: () => (forceAdmission && admissionTurns < 32) || hostLoop.due(), yield: (soon: boolean) => {
  if (forceAdmission && admissionTurns < 32) admissionTurns++;
  return hostLoop.yield(soon);
} };
const w = world([dex, ...jars], { natives, loop }), hit: string[] = [];
const constants = w.prog.require("Mc").methods.filter(m => m.codeOff).flatMap(m => decodeInstructions(m.dex.code(m.codeOff).insns));
const kinds = new Set(constants.filter(i => i.name === "const-method-handle").map(i => w.prog.require("Mc").dex!.methodHandle(i.b).type));
if (kinds.size !== 9 || !constants.some(i => i.name === "const-method-type")) throw new Error("constant fixture must retain both DEX opcodes and all nine handle kinds");
const constantSite = (name: string) => {
  const method = w.prog.require("Mc").methods.find(m => m.name === name)!;
  return { method, index: decodeInstructions(method.dex.code(method.codeOff).insns).find(i => i.name.startsWith("const-method-"))!.b };
};
const virtualSite = constantSite("hVirtual"), typeSite = constantSite("loaderType");
if (handleMemberOwner(virtualSite.method, virtualSite.index) !== "Mh"
  || JSON.stringify(handleSignatureTypes(virtualSite.method, virtualSite.index)) !== JSON.stringify([{ owner: "Mc", descriptor: "I" }, { owner: "Mc", descriptor: "I" }])
  || methodTypeSignatureTypes(typeSite.method, typeSite.index).some(t => t.owner !== "Mc" || t.descriptor !== "LMh$Signature;")) throw new Error("executed signature metadata contract changed");
const nullableRange = w.prog.require("Dyn").methods.find(m => m.name === "nullableRange")!;
if (!decodeInstructions(nullableRange.dex.code(nullableRange.codeOff).insns).some(i => i.name === "invoke-custom/range")) throw new Error("nullable call-site fixture lost its range invoke");
const dyn = w.prog.require("Dyn").methods.find(m => m.name === "constants")!;
const customIndex = decodeInstructions(dyn.dex.code(dyn.codeOff).insns).find(i => i.name.startsWith("invoke-custom"))!.b;
if (bootstrapReferences(dyn, customIndex).map(r => r.kind).join() !== "handle,methodType,class,methodType,handle") throw new Error("bootstrap reference ordering changed");
{
  const probe = world([dex, ...jars], { natives }), fields = probe.prog.require("Vh").fields, id = probe.idOf("Vh");
  const info = probe.host.info;
  let calls = 0;
  probe.host.info = (...args: [number, number, number]) => { calls++; return info(...args); };
  const lookup = probe.hostFn("unsafe:cache", ["I", "I", "I"], "I", (cx, c) => { c.lget(0).lget(1).lget(2); cx.callRt(c, "ufield"); });
  probe.tiers.linkSlot(probe.slots.synthSlotOf("ufield")!);
  const mark = probe.numbers.marks();
  let first = 0, cookie = 0;
  for (const [kind, name] of ["i", "l", "s"].entries()) {
    const offset = fieldCookie(probe, (id << 12) | fields.findIndex(f => f.name === name));
    if (!cookie) cookie = offset;
    for (let op = 0; op < 3; op++) {
      const expected = info(UInfo.ObjGet + op, offset, kind), before = calls;
      if (!expected || lookup(offset, op, kind) !== expected || lookup(offset, op, kind) !== expected || calls !== before + 1) throw new Error("Unsafe cache lost an accessor or repeated its host lookup");
      first ||= expected;
    }
  }
  for (const offset of [0, -8, cookie + 1, 0x7ffffff8]) if (lookup(offset, 0, 0) !== 0) throw new Error("invalid Unsafe cookie hit the cache");
  if (lookup(cookie, 0, 1) !== 0) throw new Error("Unsafe cache accepted a mismatched field kind");
  probe.rollback(mark);
  const reused = probe.synthSlot("unsafe:reused", { params: ["L"], ret: "I", body: (_cx, c) => { c.i32(12345); } });
  if (reused !== first || lookup(cookie, 0, 0) === first || lookup(cookie, 0, 0) !== info(UInfo.ObjGet, cookie, 0)) throw new Error("Unsafe cache retained a rolled-back slot");
  console.log("Unsafe accessor cache: all operations/storage kinds, growth, invalid cookies and slot reuse");
}
// Pure accessors must already be installed when their host lookup returns, even when lazy admission is due.
const assertEagerFieldAccessors = (tier: typeof w) => {
  const info = tier.host.info;
  tier.host.info = (kind: number, a: number, b: number) => {
    const slot = info(kind, a, b);
    if (([UInfo.FieldGet, UInfo.FieldPut, UInfo.StaticGet, UInfo.StaticPut] as number[]).includes(kind) && slot) {
      const state = tier.slots.at(slot);
      if (state?.k !== "synth" || !state.done) throw new Error("field accessor still needs lazy admission");
    }
    return slot;
  };
};
let bridgeCalls = 0;
const invokeBridge = w.host.mhInvoke;
w.host.mhInvoke = (...args: unknown[]) => { bridgeCalls++; return invokeBridge(...args); };
assertEagerFieldAccessors(w);
await startProcess(w);
w.onGap = (gap) => hit.push(gap);
const methods = ["Rec", "Mh", "Vh", "Px", "Pt", "Bootstrap"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && (c !== "Bootstrap" || m.name.startsWith("tCustom")) && m.flags & ACC.PUBLIC && m.name !== "tConstWait" && m.name !== "tTransformWait" && m.name !== "tTransformConcurrent" && m.name !== "tCustomRace" && m.name !== "tCustomRetry" && m.name !== "tInvokerConcurrent"));
const mh = [0, 1, 2, 3, 7, 12], small: Record<string, number[]> = {
  ...Object.fromEntries(methods.filter((m) => m.cls === "Mh" || m.cls === "Vh" || m.cls === "Px" || m.cls === "Pt" || m.cls === "Bootstrap").map((m) => [m.name, mh])), tCustomFailure: [0], tCustomRangeNull: [0, 3], empty: [0], eqNaN: [0, 1, 2], eqOther: [0, 1, 2, 3, 4], nullRecv: [0, 1, 7], ts: [0, 1, 2, 3, 4, 5, 6, 7, 30], hc: [0, 1, 2, 3, 7, 12, 40], nested: [0, 3, 4] };
const cases = [...genCases(methods.filter((m) => m.name !== "eq"), small), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d) => [0, 1, 2, 3, 4, 9].map((a) => ({ m: methods.find((m) => m.name === "eq")!, args: [BigInt(a), BigInt(d)] })))];
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const jdk = onJdk(out, cases.map(caseLine));
// ART ClassLinker::ResolveMethodHandleForMethod keeps the named array receiver; JDKs before 21.0.12 narrow Object.clone's
// protected receiver to Mc and throw, so those rows take ART's receiver rule and array clone semantics.
cases.forEach((c, i) => { if (c.m.name === "tConstClone" && jdk[i] === "throw") jdk[i] = String(Number(c.args[0]) + 1); });
// JDK 22+ (JDK-8318966) allows only plain access through byte array and heap buffer views and throws; ART's view handles keep every
// access mode, so those rows take the answers ART's (and JDK 21's) semantics give.
const artViews: Record<string, (a: number) => number> = {
  tDirectViews: (a) => 4 * a + 14, tInvokerViewArray: (a) => 3 * a + 1107, tInvokerViewBuffer: (a) => a + 1111,
  tInvokerViewKinds: (a) => ((a + 65530) & 0xffff) + ((-a << 16) >> 16) + 1103,
};
cases.forEach((c, i) => { const art = artViews[c.m.name]; if (art && jdk[i] === "throw") jdk[i] = String(art(Number(c.args[0]))); });
const suite = checker("customdiff"), { blocked, threw } = await compare(suite, cases, (m) => entries.get(m)!, jdk, hit);
const bridgeCounts: Record<string, number> = {};
for (const name of ["inst", "tDirectAdapt", "tDirectViews"]) {
  const before = bridgeCalls, method = methods.find(m => m.cls === "Vh" && m.name === name)!;
  entries.get(method)!(7); bridgeCounts[name] = bridgeCalls - before;
}
if (bridgeCounts.inst !== 0 || !bridgeCounts.tDirectAdapt || !bridgeCounts.tDirectViews) throw new Error(`exact storage/fallback bridge counts: ${JSON.stringify(bridgeCounts)}`);
console.log(`direct bridge calls: ${JSON.stringify(bridgeCounts)} (work counts, no timing claim)`);
// Actual DEX definitions in sibling namespaces must keep their Class identities through constants and polymorphic calls.
{
  const tier = world(new Program([], program(jars)), { natives, loop });
  await startProcess(tier);
  const loaders = [tier.prog.newLoader(tier.prog.boot, null), tier.prog.newLoader(tier.prog.boot, null)];
  for (const loader of loaders) tier.addDexes(loadDexes(dex), loader);
  const names = loaders.map(loader => `Mh@${loader.id}`), constants = loaders.map(loader => `Mc@${loader.id}`);
  for (const name of names) {
    if (await tier.entryAsync(name, "tConstLoaderType", "(I)I")(0) !== 7) throw new Error("constant signature lost defining loader identity");
    if (await tier.entryAsync(name, "tConstVirtual", "(I)I")(3) !== 999) throw new Error("polymorphic signature lost defining loader identity");
    const bootstrap = name.replace("Mh@", "Bootstrap@");
    if (await tier.entryAsync(bootstrap, "tCustomConstants", "(I)I")(3) !== 8) throw new Error("bootstrap constants lost defining loader identity");
  }
  const other = await tier.entryAsync(constants[1], "hVirtual", "()Ljava/lang/invoke/MethodHandle;")();
  if (await tier.entryAsync(names[0], "loaderMismatch", "(Ljava/lang/invoke/MethodHandle;)I")(other) !== 1) throw new Error("invokeExact accepted a sibling loader signature");
}
console.log("7 executed cross-loader constant/polymorphic/bootstrap checks preserve sibling DEX identities");
await checkDeferredSignatures();
let suspendedCases = 0;
for (const [cls, name] of [...["tConstWait", "tTransformWait", "tTransformConcurrent"].map(name => ["Mh", name]), ["Vh", "tInvokerConcurrent"]]) {
  forceAdmission = name === "tInvokerConcurrent";
  const waiting = [-1, 7], reference = onJdk(out, waiting.map(a => `${cls}.${name} ${a}`));
  for (const [i, a] of waiting.entries()) {
    const value = await w.entryAsync(cls, name, "(I)I")(a);
    if (String(value) !== reference[i]) throw new Error(`suspended ${name}(${a}): ${value} != ${reference[i]}`);
    suspendedCases++;
  }
}
forceAdmission = false;
if (!admissionTurns) throw new Error("VarHandle concurrency fixture must force lazy-link turns");
console.log(`${admissionTurns} forced admission turns retain eager field accessors`);
console.log(`${suspendedCases} suspended handle cases preserve thread, monitor ownership and exceptions`);
{
  try {
    const buffer = await w.entryAsync("Vh", "artViewAllocate", "()Ljava/nio/ByteBuffer;")();
    const setAddress = w.hostFn("fixture:viewAddress", ["L", "J"], "V", (cx, c) => {
      const owner = "java/nio/Buffer", f = cx.prog.resolveField(owner, "address", "J")!;
      c.lget(0).refCast(cx.structFor(owner)).lget(1).structSet(cx.structFor(owner), cx.fieldIndex(owner, f));
    });
    const address = BigInt(mem.va(mem.malloc(8))), view = () => new DataView(memorySync(address, 8).slice().buffer);
    memorySync(address, 8).set([0, 0, 0, 41]);
    setAddress(buffer, address);
    if (await w.entryAsync("Vh", "artViewUpdate", "(Ljava/nio/ByteBuffer;I)I")(buffer, 7) !== 41 || view().getInt32(0) !== 48) throw new Error("mutable external view update must stay atomic");
    let faults = 0;
    const mapped = mapExternal({ size: 8, read: async (at, n) => { faults++; return memorySync(address, 8).slice(at, at + n); } }, 0, 8);
    try {
      setAddress(buffer, mapped);
      if (await w.entryAsync("Vh", "artViewRead", "(Ljava/nio/ByteBuffer;)I")(buffer) !== 48 || faults !== 1) throw new Error("immutable mapped view must retain paged whole-width reads");
    } finally { unmapExternal(mapped); }
  } catch (e) { throw javaError(w, "external view", e); }
}
console.log("2 external view cases preserve synchronous mutable updates and asynchronous immutable reads");
// ART retries failed linkage (the JDK caches failures), and requires exact collector component types (the JDK adapts them).
{
  if (await w.entryAsync("Bootstrap", "artCollectorMismatch", "(I)I")(0) !== 31) throw new Error("ART bootstrap collectors require exact component types");
  if (await w.entryAsync("Bootstrap", "tCustomRetry", "(I)I")(0) !== 2) throw new Error("ART bootstrap failures must be retried");
  if (await w.entryAsync("Bootstrap", "artRaceFailure", "(I)I")(0) !== 1) throw new Error("failed bootstrap contender must preserve its error and leave the successful winner installed");
  if (await w.entryAsync("Bootstrap", "tCustomRace", "(I)I")(0) !== 1) throw new Error("racing bootstrap contenders must invoke the installed winner");
}
console.log("4 ART collector/retry/racing cases match");
// A plain callback with a captured async owner cannot create a child stack that outlives its caller.
{
  const owner = w.sched.strand(), before = w.rtImports().depth.value;
  const call = handleThunk(w, "mh:syncCallbackTest", [], "I", (cx, c) => {
    c.i64(1n); cx.callMethod(c, cx.prog.resolve("java/lang/Thread", "sleep", "(J)V")!); c.i32(7);
  }, owner);
  try {
    w.synchronous(() => call());
    throw new Error("plain handle callback must reject blocking");
  } catch (e) {
    const t = w.throwable(e);
    if (!t || w.classNameOf(t) !== "java/lang/IllegalStateException") throw e;
    if (w.rtImports().depth.value !== before || w.sched.strands.some(s => s?.parent === owner)) throw new Error("plain handle callback leaked depth or a nested strand");
  } finally { owner.end(); }
}
console.log("2 synchronous handle callbacks reject blocking without orphan strands");
// Missing bootstrap classes fail resolution; libcore LambdaMetafactory returns null and ART wraps that CCE in BME.
const outcome = (name: string) => { try { w.entry("Ind", name, "(I)I")(3); return "returned"; } catch (e) { const t = w.throwable(e); return t ? `${w.classNameOf(t)}: ${w.bridge.toHost(w.fieldReader("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")(t))}` : String(e); } };
const concat = outcome("concat"), lambda = outcome("lambda");
suite.check("concat", concat, "java/lang/NoClassDefFoundError: Failed resolution of: Ljava/lang/invoke/StringConcatFactory;");
if (!lambda.startsWith("java/lang/BootstrapMethodError")) suite.fail(`lambda: ${lambda}`);
suite.done(`${cases.length - blocked} cases match (the JDK or documented ART differences); ${threw} threw`);

async function checkDeferredSignatures(): Promise<void> {
  const signaturePath = "/data/local/tmp/mh-signatures.dex";
  vfs.mount(signaturePath, new BytesFile(new Uint8Array(readFileSync(dex))));
  {
    let loads = 0;
    const tier = world(new Program(loadDexes(dex), program(jars)), { natives, dexes: async path => {
      if (path !== signaturePath) return undefined;
      loads++; await new Promise<void>(resolve => queueMicrotask(resolve)); return loadDexes(dex);
    } });
    try { await startProcess(tier); }
    catch (e) { throw javaError(tier, "signature bootstrap", e); }
    let object: object;
    try { object = await tier.entryAsync("Mh", "signatureLoader", "(Ljava/lang/String;)Ljava/lang/ClassLoader;")(signaturePath) as object; }
    catch (e) { throw javaError(tier, "signature loader creation", e); }
    const strand = tier.sched.strand();
    let name: string;
    try { name = await tier.resolveClass(definingLoader(tier, object), "Mt", strand); }
    catch (e) { throw javaError(tier, "signature child resolution", e); }
    finally { strand.end(); }
    if (name === "Mt" || loads !== 1) throw new Error("signature fixture did not load deferred child DEX");
    const ownerLoader = definingLoader(tier, object), ownerStrand = tier.sched.strand();
    try {
      for (const cls of ["java/lang/invoke/MethodHandle", "java/lang/invoke/VarHandle"]) {
        await tier.resolveClass(ownerLoader, cls, ownerStrand);
        const key = tier.prog.initiatedBy(ownerLoader, cls);
        if (!key || !definitionReady(tier, key)) throw new Error("polymorphic owner fixture is not initiated and definition ready");
      }
    } catch (e) { throw javaError(tier, "polymorphic owner initiation", e); }
    finally { ownerStrand.end(); }
    let parentHandle: unknown, parentArrayHandle: unknown;
    try {
      parentHandle = await tier.entryAsync("Mt", "handle", "()Ljava/lang/invoke/MethodHandle;")();
      parentArrayHandle = await tier.entryAsync("Mt", "arrayHandle", "()Ljava/lang/invoke/VarHandle;")();
    } catch (e) { throw javaError(tier, "parent polymorphic handles", e); }
    const prototypeFailures: string[] = [];
    for (const [method, desc, handle] of [["poly", tier.prog.viewOf(name, "(Ljava/lang/invoke/MethodHandle;)LMh$Signature;"), parentHandle], ["vh", "(Ljava/lang/invoke/VarHandle;)Ljava/lang/Object;", parentArrayHandle]] as const) {
      try { await tier.entryAsync(name, method, desc)(handle); throw new Error(`${method} initiated owner bypassed denied prototype`); }
      catch (e) { const t = tier.throwable(e); if (!t || tier.classNameOf(t) !== "java/lang/NoClassDefFoundError") prototypeFailures.push(`${method}: ${t ? tier.classNameOf(t) : String(e)}`); }
    }
    if (prototypeFailures.length) throw new Error(`initiated owner bypassed denied prototype: ${prototypeFailures.join("; ")}`);
    for (const [method, desc] of [["type", "()Ljava/lang/invoke/MethodType;"], ["handle", "()Ljava/lang/invoke/MethodHandle;"], ["custom", "()Ljava/lang/Object;"]]) {
      try { await tier.entryAsync(name, method, desc)(); throw new Error(`${method} bypassed Java loader signature denial`); }
      catch (e) { const t = tier.throwable(e); if (!t || tier.classNameOf(t) !== "java/lang/NoClassDefFoundError") throw e; }
    }
    await tier.entryAsync("Mh", "allowSignature", "(Ljava/lang/ClassLoader;)V")(object);
    let result: unknown;
    try { result = await tier.entryAsync(name, "type", "()Ljava/lang/invoke/MethodType;")(); }
    catch (e) { throw javaError(tier, "signature constant execution", e); }
    const returnType = await handleThunk(tier, "fixture:signatureReturn", ["L"], "L", (cx, c, arg) => {
      arg(0); cx.callMethod(c, cx.prog.resolve("java/lang/invoke/MethodType", "returnType", "()Ljava/lang/Class;")!);
    }, tier.sched.current())(result as object);
    const owner = tier.sched.strand();
    let key: string;
    try { key = await tier.resolveClass(definingLoader(tier, object), "Mh$Signature", owner); } finally { owner.end(); }
    const id = tier.hostFn("fixture:signatureId", ["L"], "I", (cx, c) => { c.lget(0); idOfClass(cx, c); })(returnType as object);
    if (id !== tier.idOf(key)) throw new Error(`deferred constant signature identity: got=${id}, expected=${tier.idOf(key)}`);
    const handle = await tier.entryAsync(name, "handle", "()Ljava/lang/invoke/MethodHandle;")();
    if (await tier.entryAsync(name, "poly", tier.prog.viewOf(name, "(Ljava/lang/invoke/MethodHandle;)LMh$Signature;"))(handle) !== null) throw new Error("deferred polymorphic prototype must match its handle");
    if (await tier.entryAsync(name, "custom", "()Ljava/lang/Object;")() !== null) throw new Error("deferred bootstrap must retry against canonical signature identities");
    try { await tier.entryAsync(name, "nullPoly", "()I")(); throw new Error("null polymorphic receiver returned"); }
    catch (e) { const t = tier.throwable(e); if (!t || tier.classNameOf(t) !== "java/lang/NullPointerException") throw e; }
    const bootstrapOwner = tier.sched.strand();
    let bootstrap: string;
    try { bootstrap = await tier.resolveClass(definingLoader(tier, object), "Bootstrap", bootstrapOwner); } finally { bootstrapOwner.end(); }
    if (await tier.entryAsync(bootstrap, "tCustomConstants", "(I)I")(3) !== 8) throw new Error("deferred bootstrap encoded constants lost defining identities");
  }
  console.log("18 deferred Java-loader constant/polymorphic/bootstrap checks preserve defining identities, initiated-owner denial/retry and null precedence");
}
