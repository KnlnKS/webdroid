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
import { decodeInstructions } from "../../src/jvm/prepared";

/** Pq and Pq2 as javac would not write them: ObjectMethods.bootstrap over a virtual getter (overridden in Pq2) and an interface getter, the method handle kinds a record never uses */
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
      const args = [p.cls("Pq"), p.string("x;name"), p.methodHandle(5, p.member(10, "Pq", "x", "()I")), p.methodHandle(9, p.member(11, "Ig", "name", "()Ljava/lang/String;"))];
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
    methods.push(method(p, 1, "plus", "(I)I", [0x11, ...u2(999), 0xac]));
    methods.push(method(p, 2, "secret", "(I)I", [0x1b, 0x10, 10, 0x68, 0xac]));
    handle("hStatic", 6, 10, "Mh", "add", "(II)I");
    handle("hVirtual", 5, 10, "Mh", "plus", "(I)I");
    handle("hInterface", 9, 11, "Ig", "name", "()Ljava/lang/String;");
    handle("hDirect", 7, 10, "Mc", "secret", "(I)I");
    handle("hSuper", 7, 10, "Mh", "plus", "(I)I");
    handle("hConstructor", 8, 10, "Mh", "<init>", "()V");
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
  return out;
}
const out = mkdtempSync(join(tmpdir(), "j2w-cu-"));
const sh = shellIn(out);
for (const [n, bytes] of Object.entries(handClasses())) writeFileSync(join(out, n + ".class"), bytes);
sh(["javac", "--release", "17", "-cp", out, "-d", out, join(JAVA, "Rec.java"), join(JAVA, "Mh.java"), join(JAVA, "Vh.java"), join(JAVA, "Px.java"), join(JAVA, "Pt.java"), join(JAVA, "Ind.java"), join(JAVA, "Ref.java")]);
sh(["d8", "--release", "--no-desugaring", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^(Rec|Mh|Mc|Vh|Px|Pt|Pq2?|Ig|Ind)(\$.*)?\.class$/.test(f)).map((f) => join(out, f))]);
const dex = join(out, "classes.dex"), jars = [...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(AOSP, j));
await jsTier(loadDexes(dex));
const w = world([dex, ...jars], { natives }), hit: string[] = [];
const constants = w.prog.require("Mc").methods.filter(m => m.codeOff).flatMap(m => decodeInstructions(m.dex.code(m.codeOff).insns));
const kinds = new Set(constants.filter(i => i.name === "const-method-handle").map(i => w.prog.require("Mc").dex!.methodHandle(i.b).type));
if (kinds.size !== 9 || !constants.some(i => i.name === "const-method-type")) throw new Error("constant fixture must retain both DEX opcodes and all nine handle kinds");
processState(w);
w.onGap = (id) => hit.push(w.gapList[id]);
const methods = ["Rec", "Mh", "Vh", "Px", "Pt"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC && m.name !== "tBind" && m.name !== "tConstWait"));
const mh = [0, 1, 2, 3, 7, 12], small: Record<string, number[]> = {
  ...Object.fromEntries(methods.filter((m) => m.cls === "Mh" || m.cls === "Vh" || m.cls === "Px" || m.cls === "Pt").map((m) => [m.name, mh])), empty: [0], eqNaN: [0, 1, 2], eqOther: [0, 1, 2, 3, 4], nullRecv: [0, 1, 7], ts: [0, 1, 2, 3, 4, 5, 6, 7, 30], hc: [0, 1, 2, 3, 7, 12, 40], nested: [0, 3, 4] };
const cases = [...genCases(methods.filter((m) => m.name !== "eq"), small), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d) => [0, 1, 2, 3, 4, 9].map((a) => ({ m: methods.find((m) => m.name === "eq")!, args: [BigInt(a), BigInt(d)] })))];
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const jdk = sh(["java", "-cp", out, "Ref"], cases.map((c) => `${c.m.cls}.${c.m.name} ${c.args.join(" ")}`).join("\n") + "\n").trim().split("\n");
// the JDK rejects Pq (its ObjectMethods wants a record), so the expected values of Pt are computed here from the semantics of ObjectMethods: the getters are virtual (Pq2.x() answers ten
// times the field), the components combine as 31 * hash + hash, and the name in toString is the record class's, Pq
const strHash = (t: string | null) => t === null ? 0 : [...t].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 0);
const pqHash = (x: number, name: string | null) => (Math.imul(x | 0, 31) + strHash(name)) | 0;
const pqText = (x: number, name: string | null) => `Pq[x=${x}, name=${name}]`;
const expected: Record<string, (a: number) => number> = {
  ts: (a) => (Math.imul(strHash(pqText(a, a % 2 === 0 ? null : "n")), 31) + strHash(pqText(a * 10, "m"))) | 0,
  hc: (a) => (Math.imul(pqHash(a, "n"), 7) + pqHash(a * 10, "m") + pqHash(a, null)) | 0,
  eq: (a) => 17 + (a === 0 ? 12 : 0),
};
cases.forEach((c, i) => { if (c.m.cls === "Pt") jdk[i] = String(expected[c.m.name](Number(c.args[0]))); });
// ART ClassLinker::ResolveMethodHandleForMethod keeps the named array receiver; the JDK narrows Object.clone's protected receiver to Mc.
// These six rows therefore use ART's receiver rule and array clone semantics, rather than claiming a JDK match.
cases.forEach((c, i) => { if (c.m.name === "tConstClone") { if (jdk[i] !== "throw") throw new Error("JDK array clone receiver changed"); jdk[i] = String(Number(c.args[0]) + 1); } });
const tier = await jsTier(loadDexes(dex));
// the production tier has its own method handle and VarHandle model (jinvoke.ts) and no Class.isRecord: the JDK alone decides those cases
const asJdk = (cls: string, name: string, _d: string, args: unknown[]) => {
  const i = cases.findIndex((c) => c.m.cls === cls && c.m.name === name && c.args.every((a, j) => a === args[j] || Number(a) === Number(args[j])));
  return jdk[i] === "throw" ? Promise.reject(new Error("throw")) : Promise.resolve(entries.get(cases[i].m)!.length === 0 || cases[i].m.ret === "J" ? BigInt(jdk[i]) : Number(jdk[i]));
};
const { bad, blocked, threw } = await compare(cases, (m) => entries.get(m)!, (cls, name, desc, args, inst) => (cls === "Mh" || cls === "Vh" || cls === "Px" || cls === "Pt" || name === "recordInfo" ? asJdk(cls, name, desc, args) : tier(cls, name, desc, args, inst)), jdk, hit);
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match (JS/JDK or documented ART differences); ${threw} threw`);
const cold = world([dex, ...jars], { cold: true, natives });
processState(cold);
const constantCases = cases.map((c, i) => ({ ...c, i })).filter(c => c.m.name.startsWith("tConst"));
for (const { m, args, i } of constantCases) {
  const value = await cold.entryAsync(m.cls, m.name, m.desc)(...args.map(Number));
  if (String(value) !== jdk[i]) throw new Error(`cold ${m.name}: ${value} != ${jdk[i]}`);
}
console.log(`${constantCases.length} constant cases match on the cold tier`);
const waiting = [-1, 7], waitingJdk = sh(["java", "-cp", out, "Ref"], waiting.map(a => `Mh.tConstWait ${a}`).join("\n") + "\n").trim().split("\n");
for (const tier of [w, cold]) for (const [i, a] of waiting.entries()) {
  const value = await tier.entryAsync("Mh", "tConstWait", "(I)I")(a);
  if (String(value) !== waitingJdk[i]) throw new Error(`suspended handle(${a}): ${value} != ${waitingJdk[i]}`);
}
console.log("4 suspended handle cases preserve thread, monitor ownership and exceptions");
if (blocked) console.log(`${blocked} cases blocked by a compiler gap: ${[...new Set(hit)].join("; ")}`);
// a bootstrap class libcore lacks is ART's NoClassDefFoundError at the site; LambdaMetafactory exists but returns null, which is a gap
const outcome = (name: string) => { try { w.entry("Ind", name, "(I)I")(3); return "returned"; } catch (e) { const t = w.throwable(e); return t ? `${w.classNameOf(t)}: ${w.lastMessage}` : String(e); } };
const concat = outcome("concat"), lambda = outcome("lambda");
if (concat !== "java/lang/NoClassDefFoundError: Failed resolution of: Ljava/lang/invoke/StringConcatFactory;") { console.log(`FAIL concat: ${concat}`); process.exit(1); }
if (!lambda.startsWith("java/lang/UnsatisfiedLinkError")) { console.log(`FAIL lambda: ${lambda}`); process.exit(1); }
// a transformer handle is a recorded gap, not a result
hit.length = 0;
let transformer = true;
try { w.entry("Mh", "tBind", "(I)I")(3); transformer = false; } catch { /* the gap throws */ }
if (!transformer || !hit.some((g) => /transformer handle/.test(g))) { console.log(`FAIL tBind: gap ${hit.join("; ")}`); process.exit(1); }
process.exit(bad || blocked ? 1 : 0);
