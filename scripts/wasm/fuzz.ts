// Instruction-sequence fuzzer: random verifiable int/long/float/double/array/field/branch/switch/try code is generated as Java, compiled with
// javac and d8 (so the DEX is what d8 emits for it), and every generated method runs as Wasm and on the JDK; results must be bit-identical.
// Run from the repository root: pnpm wasm fuzz [--seed N] [--methods N] [--cases N] [--depth N] [--debug] [--file F.java] [--irreducible]
// (--debug: d8 without --release; --file: run an edited copy of a reported source, e.g. while reducing a mismatch; --irreducible: methods of random block graphs, see irfuzz.ts)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./lib.ts";
import { caseLine, compare, genCases } from "./cases.ts";
import { mountPlatform, natives } from "./harness.ts";
import { ACC } from "../../src/wasm/compiler/program.ts";
import { irreducibleClass } from "./irfuzz.ts";
import { Irreducible, Flow } from "../../src/jvm/structure.ts";
import { prepareMethod } from "../../src/jvm/prepared.ts";
import { JAVA, PLATFORM_PATHS, ROOT } from "./paths.ts";
import { checker, fixture, onJdk, tempDir } from "./tools.ts";
import { argv } from "../args.ts";

/** only the first LEAVES methods are called, and they call nothing: their cost is not multiplied along a chain of calls */
const LEAVES = 8;
let cur = 0;
const { flag, opt } = argv(process.argv);
const seed = +(opt("--seed") ?? 1), count = +(opt("--methods") ?? 200), perMethod = +(opt("--cases") ?? 12), depth = +(opt("--depth") ?? 3);
let state = seed >>> 0 || 1;
const rnd = (n: number) => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state % n; };
const pick = <T>(a: T[]) => a[rnd(a.length)];

type T = "I" | "J" | "F" | "D";
const locals: Record<T, string[]> = { I: ["i0", "i1", "i2", "i3"], J: ["l0", "l1", "l2"], F: ["f0", "f1"], D: ["d0", "d1"] };
const consts: Record<T, string[]> = {
  I: ["0", "1", "-1", "2", "7", "31", "32", "255", "65535", "100000", "Integer.MAX_VALUE", "Integer.MIN_VALUE", "0x5bd1e995"],
  J: ["0L", "1L", "-1L", "3L", "4294967296L", "123456789012345L", "Long.MAX_VALUE", "Long.MIN_VALUE"],
  F: ["0f", "-0f", "1f", "-1f", "0.5f", "3.5f", "1e10f", "-2.5e9f", "Float.NaN", "Float.MAX_VALUE", "Float.MIN_VALUE", "Float.POSITIVE_INFINITY"],
  D: ["0.0", "-0.0", "1.0", "-1.0", "0.1", "3.5", "1e10", "-3e9", "1e300", "Double.NaN", "Double.MIN_VALUE", "Double.NEGATIVE_INFINITY"],
};
const castTo: Record<T, string> = { I: "int", J: "long", F: "float", D: "double" };
const arrays = { ia: ["I", 8], la: ["J", 4], fa: ["F", 4], da: ["D", 4], ba: ["I", 8], ca: ["I", 8] } as const;
const arrayOf = (t: T) => pick(Object.keys(arrays).filter((a) => arrays[a as keyof typeof arrays][0] === t));
const index = (a: string) => { const n = arrays[a as keyof typeof arrays][1]; return `(${expr("I", 1)} & ${rnd(40) ? n - 1 : 2 * n - 1})`; };

function expr(t: T, d: number): string {
  if (d <= 0 || !rnd(4)) return pick([...locals[t], ...locals[t], ...consts[t]]);
  const a = () => expr(t, d - 1), sub = (u: T) => expr(u, d - 1);
  const ops = t === "I" || t === "J" ? ["+", "-", "*", "&", "|", "^"] : ["+", "-", "*", "/", "%"];
  switch (rnd(t === "I" ? 14 : 10)) {
    case 0: case 1: case 2: return `(${a()} ${pick(ops)} ${a()})`;
    case 3: return t === "I" || t === "J" ? `(${a()} ${pick(["<<", ">>", ">>>"])} ${sub("I")})` : `(- ${a()})`;
    case 4: return t === "I" || t === "J" ? `(${a()} ${pick(["/", "%"])} ${rnd(8) ? `(${a()} | 1)` : a()})` : `(${castTo[t]}) ${sub(pick<T>(["I", "J", "F", "D"]))}`;
    case 5: return `(${castTo[t]}) ${sub(pick<T>(["I", "J", "F", "D"]))}`;
    case 6: return `(${cond(d - 1)} ? ${a()} : ${a()})`;
    case 7: { const arr = arrayOf(t); return `${arr}[${index(arr)}]`; }
    case 8: return t === "I" ? "ia.length" : t === "J" ? "(sl ^ p.y)" : t === "F" ? "sf" : "(sd + p.z)";
    case 9: return cur >= LEAVES && rnd(2) ? `(${castTo[t]}) m${rnd(LEAVES)}(${sub("I")}, ${sub("J")}, ${sub("F")}, ${sub("D")})` : `(${castTo[t]}) ${sub("I")}`;
    case 10: return `p.mix(${sub("I")})`;
    case 11: return `(${pick(["byte", "short", "char"])}) ${sub("I")}`;
    case 12: return pick([`s.f(${sub("I")})`, `s.g(${sub("I")})`, `((Op) s).ap(${sub("I")})`, "(s instanceof Sq ? 1 : 2)", "(s instanceof Sq ? ((Sq) s).k : 0)", `(sa[2] == null ? 0 : sa[2].f(${sub("I")}))`]);
    case 13: return `g[${index("ia")}][${sub("I")} & 3]`;
    default: return t === "I" ? `(${pick(["si", "p.x"])} ${pick(ops)} ${a()})` : a();
  }
}
function cond(d: number): string {
  const t = pick<T>(["I", "I", "J", "F", "D"]);
  if (d > 0 && !rnd(4)) return `(${cond(d - 1)} ${pick(["&&", "||"])} ${cond(d - 1)})`;
  return `(${expr(t, d)} ${pick(["<", "<=", ">", ">=", "==", "!="])} ${expr(t, d)})`;
}
const lval = (t: T) => rnd(3) ? pick(locals[t]) : rnd(2) ? ((a) => `${a}[${index(a)}]`)(arrayOf(t)) : ({ I: "si", J: "sl", F: "sf", D: "sd" })[t];

let loopVar = 0, mult = 1;
/** loops nest, so the iterations of the statement being generated are capped to keep a method's run time bounded */
const looped = (n: number, d: number, make: () => string) => { if (mult * n > 40) return stmt(0); mult *= n; const r = make(); mult /= n; return r; };
function stmt(d: number): string {
  const t = pick<T>(["I", "I", "J", "F", "D"]);
  const k = rnd(d > 0 ? 16 : 7);
  switch (k) {
    case 0: case 1: { const l = lval(t), narrow = l.startsWith("ba") ? "(byte) " : l.startsWith("ca") ? "(char) " : ""; return `${l} = ${narrow}${expr(t, 3)};`; }
    case 2: {
      const op = pick(["+=", "-=", "*=", "/=", "%="]), rhs = expr(pick<T>(["I", "J", "F", "D"]), 2);
      return `${lval(t)} ${op} ${(op === "/=" || op === "%=") && (t === "I" || t === "J") && rnd(8) ? `(long) ${rhs} | 1` : rhs};`;
    }
    case 3: return `${pick(locals[t === "F" || t === "D" ? "I" : t])}${pick(["++", "--"])};`;
    case 4: { const it = pick<T>(["I", "J"]); return `${lval(it)} ${pick(["<<=", ">>=", ">>>=", "&=", "|=", "^="])} ${expr("I", 2)};`; }
    case 5: return `p.mix(${expr("I", 2)});`;
    case 6: return `if ${cond(2)} { ${block(d - 1)} }${rnd(2) ? ` else { ${block(d - 1)} }` : ""}`;
    case 7: { const v = `k${loopVar++}`, n = 1 + rnd(5); return looped(n, d, () => `for (int ${v} = 0; ${v} < ${n}; ${v}++) { ${block(d - 1)}${rnd(3) ? "" : ` if ${cond(1)} ${pick(["break", "continue"])};`} }`); }
    case 8: { const v = `k${loopVar++}`; return looped(5, d, () => `int ${v} = ${rnd(4)}; while (${v} < 5) { ${v} += ${1 + rnd(2)}; ${block(d - 1)} }`); }
    case 9: {
      const dense = rnd(2), keys = dense ? [0, 1, 2, 3] : [3, 70, 1000, -5, 99999];
      const arms = keys.filter(() => rnd(4)).map((c) => `case ${c}: ${block(d - 1)} ${rnd(3) ? "break;" : ""}`);
      return `switch (${dense ? `${expr("I", 2)} & 3` : `0 + ${expr("I", 2)}`}) { ${arms.join(" ")} default: ${block(d - 1)} }`;
    }
    case 10: return `try { ${block(d - 1)} } catch (RuntimeException ex) { ${pick(locals.I)} += ${1 + rnd(99)}; }${rnd(3) ? "" : ` finally { ${pick(locals.I)} ^= ${1 + rnd(99)}; }`}`;
    case 12: { const o = `lb${loopVar++}`, a = `k${loopVar++}`, b = `k${loopVar++}`; return looped(9, d, () => `${o}: for (int ${a} = 0; ${a} < 3; ${a}++) { for (int ${b} = 0; ${b} < 3; ${b}++) { ${block(d - 1)} if ${cond(1)} ${pick(["break", "continue"])} ${o}; } }`); }
    case 13: return `synchronized (p) { ${block(d - 1)} }`;
    case 14: return `try { ${block(d - 1)} if ${cond(1)} throw new ${pick(["E1", "E2"])}(); ${block(d - 1)} } catch (E2 ex) { ${pick(locals.I)} += ${1 + rnd(9)}; } catch (E1 ex) { ${pick(locals.I)} ^= ${1 + rnd(9)}; }${rnd(2) ? "" : ` finally { ${pick(locals.I)}++; }`}`;
    case 15: return pick([`s = ${cond(1)} ? new Sq(${expr("I", 2)}) : new Ci(${expr("I", 2)});`, `sa[${expr("I", 1)} & 3] = s;`, `g[${index("ia")}][${expr("I", 1)} & 3] = ${expr("I", 2)};`]);
    default: { const v = `k${loopVar++}`; return looped(4, d, () => `int ${v} = 0; do { ${block(d - 1)} } while (${v}++ < ${rnd(4)} && ${cond(1)});`); }
  }
}
const block = (d: number) => Array.from({ length: 1 + rnd(3) }, () => stmt(d)).join(" ");

/** a fixed (int, long, float, double) signature keeps every generated method callable with the shared argument pools */
function method(n: number) {
  cur = n;
  const ret = pick<T>(["I", "J", "F", "D"]);
  const fold: Record<T, string> = {
    I: "i0 ^ (i1 * 31) ^ (i2 + i3) ^ (int) l0 ^ (int) (l1 >> 3) ^ (int) f0 ^ (int) d0 ^ ia[3] ^ ba[2] ^ ca[5] ^ si ^ p.x",
    J: "l0 ^ (l1 * 31L) ^ l2 ^ (long) f0 ^ (long) d1 ^ la[1] ^ sl ^ p.y ^ i0",
    F: "f0 + f1 * (float) d0 + fa[2] + sf + (float) i1",
    D: "d0 + d1 * f1 + da[1] + sd + p.z + l0",
  };
  return `static ${castTo[ret]} m${n}(int a, long b, float c, double x) {
  int i0 = a, i1 = a ^ 5, i2 = 3, i3 = -a; long l0 = b, l1 = b + a, l2 = 7; float f0 = c, f1 = 0.5f; double d0 = x, d1 = c;
  int[] ia = new int[8]; long[] la = new long[4]; float[] fa = new float[4]; double[] da = new double[4]; byte[] ba = new byte[8]; char[] ca = new char[8];
  si = a; sl = b; sf = c; sd = x; P p = new P(a); Sh s = new Sq(a); Sh[] sa = new Sh[4]; int[][] g = new int[8][4];
  ${block(depth)} ${block(depth)}
  return ${fold[ret]};
}`;
}

const generated = `public class F {
  static int si; static long sl; static float sf; static double sd;
  static class E1 extends RuntimeException {} static class E2 extends E1 {}
  interface Op { int ap(int a); }
  static abstract class Sh implements Op { abstract int f(int a); int g(int a) { return f(a) + 1; } public int ap(int a) { return g(a) ^ 3; } }
  static class Sq extends Sh { int k; Sq(int a) { k = a; } int f(int a) { return k + a; } }
  static class Ci extends Sh { int r; Ci(int a) { r = a; } int f(int a) { return r * a; } int g(int a) { return super.g(a) - 5; } }
  static final class P { int x; long y; double z; P(int a) { x = a; y = a * 3L; z = a / 2.0; } int mix(int a) { x += a; y += a * 3L; z += a * 0.5; return x ^ a; } }
  ${Array.from({ length: count }, (_, i) => method(i)).join("\n  ")}
}\n`;

const out = tempDir("j2w-fuzz-");
const file = opt("--file"), irreducible = flag("--irreducible");
if (irreducible) writeFileSync(join(out, "F.class"), irreducibleClass("F", count, rnd));
else writeFileSync(join(out, "F.java"), file === undefined ? generated : readFileSync(file, "utf8"));
fixture({ out, sources: [...irreducible ? [] : [join(out, "F.java")], join(JAVA, "Ref.java")], debug: flag("--debug"), classes: /^F(\$.*)?\.class$/ });

const dex = join(out, "classes.dex"), hit: string[] = [];
await mountPlatform(ROOT);
const w = world([dex, ...PLATFORM_PATHS.slice(0, 2)], { natives });
w.onGap = (gap) => hit.push(gap);
const methods = w.prog.require("F").methods.filter((m) => m.isStatic && m.codeOff && m.flags & ACC.PUBLIC || m.isStatic && m.name.startsWith("m") && m.codeOff);
const cyclic = irreducible ? methods.filter((m) => {
  const item = m.dex.code(m.codeOff);
  try { new Flow(prepareMethod(item), item); return false; } catch (e) { return e instanceof Irreducible; }
}).length : 0;
const entries = new Map(methods.map((m) => [m, w.entry(m.cls, m.name, m.desc)]));
const cases = genCases(methods, {}, perMethod);
const jdk = onJdk(out, cases.map(caseLine));
const suite = checker(`fuzz seed ${seed}`), { threw } = await compare(suite, cases, (m) => entries.get(m)!, jdk, hit);
if (suite.failed) console.log(`source: ${join(out, "F.java")}`);
suite.done(`${cases.length} cases match the JDK across ${methods.length} generated methods; ${threw} threw; compiled ${w.stats.methods} methods, ${w.stats.units} modules${irreducible ? `; ${cyclic} irreducible` : ""}`);
