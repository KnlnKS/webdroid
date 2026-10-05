import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Program, kindOf } from "../../src/wasm/compiler/program";
import { ColdInterpreter } from "../../src/wasm/cold/interpreter";
import { loadDexes, world } from "./lib";
import { bitsOf, jsTier, unbits } from "./oracle";
import { genCases } from "./cases";
import { decodeInstructions } from "../../src/jvm/prepared";
import { JAVA } from "./paths";
import { shellIn } from "./tools";

const out = mkdtempSync(join(tmpdir(), "wasm-cold-")), sh = shellIn(out);
sh(["javac", "--release", "8", "-d", out, ...["W", "S", "N", "Ref"].map((n) => join(JAVA, n + ".java"))]);
sh(["d8", "--release", "--output", out, ...readdirSync(out).filter((n) => n.endsWith(".class")).map((n) => join(out, n))]);
const dexes = loadDexes(join(out, "classes.dex")), prog = new Program(dexes), interpreter = new ColdInterpreter(), js = await jsTier(dexes);
const cases: [string, (number | bigint)[]][] = [
  ...[0, 1, 10, 1000].map((n): [string, number[]] => ["xorshift", [n]]),
  ...[0, 1, 5, 20].map((n): [string, number[]] => ["nested", [n]]),
  ...[0, 1, 10, 1000].map((n): [string, number[]] => ["mix", [n]]),
  ...[-65, -1, 0, 31, 32, 63, 64, 127].map((n): [string, (number | bigint)[]] => ["lshift", [-0x123456789abcdefn, n]]),
  ...[-33, -1, 0, 31, 32, 63].map((n): [string, number[]] => ["ishift", [-2147483648, n]]),
  ...[1, 2, 27, 1000].map((n): [string, number[]] => ["collatz", [n]]),
  ...genCases(prog.require("W").methods.filter((m) => ["sw", "sparse", "sparse9", "dense", "packed", "lcmp", "conv", "convl", "fcmp", "dcmp"].includes(m.name))).map(({ m, args }): [string, (number | bigint)[]] =>
    [m.name, args.map((a, i) => unbits(m.params[i], a as bigint))]),
];
const expected = sh(["java", "-cp", out, "Ref"], cases.map(([name, args]) => {
  const m = prog.require("W").methods.find((m) => m.name === name)!;
  return `W.${name} ${args.map((a, i) => bitsOf(m.params[i], a)).join(" ")}`;
}).join("\n") + "\n").trim().split("\n");
const linked = world([join(out, "classes.dex")], { cold: true });
let checks = 0;
for (const [i, [name, args]] of cases.entries()) {
  const method = prog.require("W").methods.find((m) => m.name === name)!, item = method.dex.code(method.codeOff);
  const oracle = BigInt.asIntN(64, bitsOf(method.ret, await js(method.cls, method.name, method.desc, args)));
  const answer = linked.entry(method.cls, method.name, method.desc)(...args.map((a, i) => { const bits = bitsOf(method.params[i], a); return kindOf(method.params[i]) === "J" ? bits : Number(BigInt.asIntN(32, bits)); })) as number | bigint;
  if (BigInt.asIntN(64, BigInt(answer)) !== oracle) throw new Error(`${name}: linked cold entry disagrees`);
  for (const budget of [1, 7, 4096]) {
    let frame = interpreter.create(item); let reg = item.regs - item.ins;
    for (let p = 0; p < args.length; p++) {
      const type = method.params[p];
      interpreter.seed(frame, reg, type, args[p]); reg += type === "J" || type === "D" ? 2 : 1;
    }
    let slices = 0;
    try {
      while (!interpreter.resume(frame, budget)) {
        if (++slices > 1000000) throw new Error(`wedged at ${interpreter.pc(frame)}`);
        if (slices === 1 || slices === 7) frame = interpreter.restore(item, interpreter.snapshot(frame));
      }
    } catch (e) { throw new Error(`${name}(${args}), budget ${budget}: ${String(e)}`); }
    const bits = interpreter.result(frame);
    if (bits !== oracle || bits !== BigInt(expected[i])) throw new Error(`${name}(${args}): cold ${bits}, JS ${oracle}, JDK ${expected[i]}`);
    checks++;
  }
}
// An injected frame enters at a real DEX return instruction, without executing its prologue.
const method = prog.require("W").methods.find((m) => m.name === "ishift")!, item = method.dex.code(method.codeOff);
const instruction = decodeInstructions(item.insns).find((ins) => ins.name === "return")!, pc = instruction.pc, reg = instruction.a, frame = interpreter.create(item);
interpreter.setBits(frame, reg, 123n); interpreter.enterAt(frame, item, pc);
if (!interpreter.resume(frame, 1) || interpreter.result(frame) !== 123n) throw new Error("injected activation did not resume at return");
const object = { live: true }, refItem = { regs: 2, ins: 1, tries: [], insns: new Uint16Array([0x1007, 0x0011]) };
let refFrame = interpreter.create(refItem);
interpreter.setObject(refFrame, 1, object);
if (interpreter.resume(refFrame, 1)) throw new Error("reference move bypassed the instruction budget");
const saved = interpreter.snapshot(refFrame);
if (saved.pc !== 1) throw new Error("snapshot did not identify the next DEX instruction");
refFrame = interpreter.restore(refItem, saved);
if (interpreter.pc(refFrame) !== 0) throw new Error("snapshot did not retain the last executed PC");
(globalThis as { gc?: () => void }).gc?.();
if (!interpreter.resume(refFrame, 1) || interpreter.reference(refFrame) !== object) throw new Error("reference lost across slice/GC");
const equality = { regs: 3, ins: 2, tries: [], insns: new Uint16Array([0x1032, 4, 0x0212, 0x020f, 0x1212, 0x020f]) };
for (const [leftType, left, rightType, right, want] of [
  ["Ljava/lang/Object;", object, "Ljava/lang/Object;", object, 1n],
  ["Ljava/lang/Object;", object, "Ljava/lang/Object;", {}, 0n],
  ["Ljava/lang/Object;", null, "I", 0, 1n],
  ["I", 0, "Ljava/lang/Object;", null, 1n],
  ["I", 42, "I", 42, 1n],
  ["I", -1, "I", 0, 0n],
] as const) {
  const f = interpreter.create(equality);
  interpreter.seed(f, 0, leftType, left); interpreter.seed(f, 1, rightType, right);
  while (!interpreter.resume(f, 1)) {}
  if (interpreter.result(f) !== want) throw new Error("typed reference/numeric equality disagrees");
}
for (const type of ["F", "D"]) for (const value of [-0, 1.25, Infinity, -Infinity, NaN]) {
  const item = { regs: 2, ins: 2, tries: [], insns: new Uint16Array([type === "F" ? 0x000f : 0x0010]) }, f = interpreter.create(item);
  interpreter.seed(f, 0, type, value);
  if (!interpreter.resume(f, 1) || interpreter.result(f) !== bitsOf(type, value)) throw new Error(`${type} raw argument bits changed`);
}
const unsupported = prog.require("W").methods.find((m) => m.name === "convd")!;
let error = "";
try { interpreter.create(unsupported.dex.code(unsupported.codeOff)); } catch (e) { error = String(e); }
if (!error.includes("unsupported opcode 0x71 at DEX PC 3")) throw new Error(`invoke support boundary was hidden: ${error}`);
const coldBeforeInvoke = linked.stats.coldCalls;
if (linked.entry("W", "fib", "(I)I")(10) !== 55 || linked.stats.coldCalls <= coldBeforeInvoke)
  throw new Error("recursive invokes bypassed the cold bridge");
const loop = linked.entry("W", "xorshift", "(I)J"), want = await js("W", "xorshift", "(I)J", [50_000]);
if (loop(50_000) !== want || !linked.stats.upgrades) throw new Error("cold back edges did not promote the method");
const calls = linked.stats.coldCalls;
if (loop(50_000) !== want || linked.stats.coldCalls !== calls) throw new Error("promoted calls stayed in the interpreter");
if (!linked.stats.coldMethods || !linked.stats.coldCalls) throw new Error("method table bypassed the cold interpreter");
console.log(`linked cold: ${linked.stats.coldMethods} interpreted methods, ${linked.stats.coldCalls} calls`);
console.log(`cold: ${checks} unchanged numeric/control DEX cases match JS/JDK across 1/7/4096-instruction slices and snapshot transfers; injected PC/register state, GC references and typed equality resume; standalone unsupported invokes rejected before execution; linked recursive invokes use canonical slow adapters`);
