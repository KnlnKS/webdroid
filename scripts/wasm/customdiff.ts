// invoke-custom and MethodHandle call sites: records (ObjectMethods.bootstrap) compiled by javac 17+ and kept as invoke-custom by d8 --no-desugaring, and
// MethodHandle.invoke/invokeExact over each kind of direct handle, run as Wasm, on the production JS tier and on the JDK; the results must match. Needs javac (17+), d8 and java. Run: bun customdiff.ts
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { world } from "./build";
import { jsTier, natives, processState } from "./oracle";
import { loadDexes } from "./build";
import { ACC } from "./program";
import { compare, genCases } from "./cases";
import { underNode } from "./undernode";
import { Pool, u2, u4 } from "./classfile";

await underNode(import.meta.path);

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
  return out;
}
const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-cu-"));
const sh = (cmd: string[], input?: string) => {
  const r = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), cwd: out });
  if (r.exitCode) throw new Error(`${cmd[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
for (const [n, bytes] of Object.entries(handClasses())) writeFileSync(join(out, n + ".class"), bytes);
sh(["javac", "--release", "17", "-cp", out, "-d", out, join(here, "java/Rec.java"), join(here, "java/Mh.java"), join(here, "java/Vh.java"), join(here, "java/Px.java"), join(here, "java/Pt.java"), join(here, "java/Ind.java"), join(here, "java/Ref.java")]);
sh(["d8", "--release", "--no-desugaring", "--min-api", "34", "--output", out, ...readdirSync(out).filter((f) => /^(Rec|Mh|Vh|Px|Pt|Pq2?|Ig|Ind)(\$.*)?\.class$/.test(f)).map((f) => join(out, f))]);
const dex = join(out, "classes.dex"), jars = [...PLATFORM_JARS.slice(0, 2), "boot/core-icu4j.jar"].map((j) => join(here, "../../../vendor/aosp", j));
await jsTier(loadDexes(dex));
const w = world([dex, ...jars], { natives }), hit: string[] = [];
processState(w);
w.onGap = (id) => hit.push(w.gapList[id]);
const methods = ["Rec", "Mh", "Vh", "Px", "Pt"].flatMap((c) => w.prog.require(c).methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC && m.name !== "tBind"));
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
const tier = await jsTier(loadDexes(dex));
// the production tier has its own method handle and VarHandle model (jinvoke.ts) and no Class.isRecord: the JDK alone decides those cases
const asJdk = (cls: string, name: string, _d: string, args: unknown[]) => {
  const i = cases.findIndex((c) => c.m.cls === cls && c.m.name === name && c.args.every((a, j) => a === args[j] || Number(a) === Number(args[j])));
  return jdk[i] === "throw" ? Promise.reject(new Error("throw")) : Promise.resolve(entries.get(cases[i].m)!.length === 0 || cases[i].m.ret === "J" ? BigInt(jdk[i]) : Number(jdk[i]));
};
const { bad, blocked, threw } = await compare(cases, (m) => entries.get(m)!, (cls, name, desc, args, inst) => (cls === "Mh" || cls === "Vh" || cls === "Px" || cls === "Pt" || name === "recordInfo" ? asJdk(cls, name, desc, args) : tier(cls, name, desc, args, inst)), jdk, hit);
console.log(`${cases.length - blocked - bad}/${cases.length - blocked} cases match (wasm, js tier, jdk); ${threw} threw`);
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
