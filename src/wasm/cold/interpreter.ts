import { decodeInstructions, switchCases } from "../../jvm/prepared";
import { validateColdSnapshot, type ColdSnapshot } from "./state";
export type { ColdSnapshot } from "./state";
import type { CodeItem } from "../../jvm/dex";
import { Code, OP } from "../compiler/code";
import { ModuleBuilder, T, ref, type VT } from "../compiler/wasmbin";

const WIDTH = 8;
const enum I { Const = 1, Move, MoveObject, ReturnVoid, ReturnBits, ReturnObject, Goto, Eq, Ne, Lt, Ge, Gt, Le, CmpLong, CmpLf, CmpGf, CmpLd, CmpGd, Switch, Rsub, Unsupported = 255 }
type Numeric = "int" | "long" | "float" | "double";
type Operation = { name: string; input: Numeric; output: Numeric; op: number[]; unary?: boolean };
const operations: Operation[] = [];
for (const [kind, prefix] of [["int", "i32"], ["long", "i64"], ["float", "f32"], ["double", "f64"]] as const) {
  for (const [name, suffix] of [["add", "add"], ["sub", "sub"], ["mul", "mul"], ["and", "and"], ["or", "or"], ["xor", "xor"], ["shl", "shl"], ["shr", "shr_s"], ["ushr", "shr_u"], ...(kind === "float" || kind === "double" ? [["div", "div"]] : [])]) {
    const opcode = OP[`${prefix}_${suffix}` as keyof typeof OP];
    if (opcode !== undefined) operations.push({ name: `${name}-${kind}`, input: kind, output: kind, op: [opcode] });
  }
}
for (const [name, input, output, op] of [
  ["int-to-long", "int", "long", [OP.i64_extend_i32_s]],
  ["long-to-int", "long", "int", [OP.i32_wrap_i64]],
  ["int-to-float", "int", "float", [OP.f32_convert_i32_s]],
  ["int-to-double", "int", "double", [OP.f64_convert_i32_s]],
  ["long-to-float", "long", "float", [OP.f32_convert_i64_s]],
  ["long-to-double", "long", "double", [OP.f64_convert_i64_s]],
  ["float-to-double", "float", "double", [OP.f64_promote_f32]],
  ["double-to-float", "double", "float", [OP.f32_demote_f64]],
  ["int-to-byte", "int", "int", [OP.i32_extend8_s]],
  ["int-to-short", "int", "int", [OP.i32_extend16_s]],
  ["int-to-char", "int", "int", [0x41, 0xff, 0xff, 0x03, OP.i32_and]],
  ["float-to-int", "float", "int", [0xfc, 0]],
  ["double-to-int", "double", "int", [0xfc, 2]],
  ["float-to-long", "float", "long", [0xfc, 4]],
  ["double-to-long", "double", "long", [0xfc, 6]],
  ["neg-int", "int", "int", [0x41, 0x7f, OP.i32_mul]],
  ["not-int", "int", "int", [0x41, 0x7f, OP.i32_xor]],
  ["neg-long", "long", "long", [0x42, 0x7f, OP.i64_mul]],
  ["not-long", "long", "long", [0x42, 0x7f, OP.i64_xor]],
  ["neg-float", "float", "float", [OP.f32_neg]],
  ["neg-double", "double", "double", [OP.f64_neg]],
] as const) operations.push({ name, input, output, op: [...op], unary: true });
const numericIds = new Map(operations.map((op, i) => [op.name, 32 + i]));

/** Decoding produces data, never a method-specific Wasm body or inferred register webs. */
export function coldCode(item: CodeItem): { words: Int32Array; pcs: number[]; slowPcs: number[] } {
  const instructions = decodeInstructions(item.insns), indices = new Map(instructions.map((ins, i) => [ins.pc, i]));
  const words = new Int32Array(instructions.length * WIDTH), tables: number[] = [];
  for (const [i, ins] of instructions.entries()) {
    const n = ins.name, base = n.split("/")[0];
    let op = I.Unsupported, a = ins.a, b = ins.b, c = ins.c, literal = 0n;
    if (n === "nop") { op = I.Goto; literal = BigInt(i + 1); }
    else if (n.startsWith("const-wide")) {
      op = I.Const;
      literal = n === "const-wide" ? ins.wideLit : n === "const-wide/high16" ? BigInt(ins.b) << 48n : BigInt(ins.b);
    } else if (base === "const") {
      op = I.Const; literal = BigInt(n === "const/high16" ? ins.b << 16 : ins.b);
    } else if (base === "move" || base === "move-wide") op = I.Move;
    else if (base === "move-object") op = I.MoveObject;
    else if (n === "return-void") op = I.ReturnVoid;
    else if (n === "return" || n === "return-wide") op = I.ReturnBits;
    else if (n === "return-object") op = I.ReturnObject;
    else if (base === "goto") { op = I.Goto; literal = BigInt(indices.get(ins.pc + ins.a)!); }
    else if (n.startsWith("if-")) {
      const condition = n.slice(3).replace(/z$/, ""), id = ["eq", "ne", "lt", "ge", "gt", "le"].indexOf(condition);
      if (id >= 0) {
        op = I.Eq + id;
        literal = BigInt(indices.get(ins.pc + (n.endsWith("z") ? ins.b : ins.c))!);
        b = n.endsWith("z") ? -1 : ins.b;
      }
    } else if (base === "packed-switch" || base === "sparse-switch") {
      op = I.Switch; literal = BigInt(words.length + tables.length);
      const cases = switchCases(item, ins); c = cases.length;
      for (const [key, target] of cases) tables.push(key, indices.get(target)!);
    } else if (["cmp-long", "cmpl-float", "cmpg-float", "cmpl-double", "cmpg-double"].includes(n)) {
      op = I.CmpLong + ["cmp-long", "cmpl-float", "cmpg-float", "cmpl-double", "cmpg-double"].indexOf(n);
    } else if (base === "rsub-int") op = I.Rsub;
    else if (numericIds.has(base)) {
      op = numericIds.get(base)!;
      if (n.endsWith("/2addr")) { b = ins.a; c = ins.b; }
      if (n.endsWith("/lit8") || n.endsWith("/lit16")) op += 128;
    }
    if (op === I.Unsupported) literal = BigInt(ins.op);
    words.set([op, ins.pc, a, b, c, i + 1, Number(BigInt.asIntN(32, literal)), Number(BigInt.asIntN(32, literal >> 32n))], i * WIDTH);
  }
  const data = new Int32Array(words.length + tables.length); data.set(words); data.set(tables, words.length);
  return { words: data, pcs: instructions.map((ins) => ins.pc), slowPcs: instructions.filter((_, i) => words[i * WIDTH] === I.Unsupported).map(ins => ins.pc) };
}

type Handle = object;
export class UnsupportedColdBody extends Error {
  constructor(pc: number, opcode: number) { super(`cold interpreter: unsupported opcode 0x${opcode.toString(16)} at DEX PC ${pc}`); }
}
interface Exports {
  code(size: number): Handle;
  word(code: Handle, index: number, value: number): void;
  frame(code: Handle, registers: number): Handle;
  bits(frame: Handle, register: number, value: bigint): void;
  object(frame: Handle, register: number, value: unknown): void;
  run(frame: Handle, budget: number): number;
  pc(frame: Handle): number;
  executed(frame: Handle, pc: number): void;
  cursor(frame: Handle, index: number): void;
  index(frame: Handle): number;
  edges(frame: Handle): number;
  setEdges(frame: Handle, edges: number): void;
  readBits(frame: Handle, register: number): bigint;
  readObject(frame: Handle, register: number): unknown;
  kind(frame: Handle, register: number): number;
  result(frame: Handle): bigint;
  reference(frame: Handle): unknown;
}

/** One opcode loop shared by all cold methods. Opaque GC frames can be resumed without JS instruction stepping. */
export class ColdInterpreter {
  readonly bytes: Uint8Array;
  private readonly api: Exports;
  readonly imports: WebAssembly.Exports;
  private readonly frames = new WeakMap<Handle, { item: CodeItem; pcs: number[]; done: boolean; slow: boolean; busy: boolean; context: Pick<ColdSnapshot, "method" | "owner" | "result" | "exception" | "monitors" | "uninitialized" | "sync" | "depth"> }>();
  private readonly active = new WeakMap<NonNullable<ColdSnapshot["owner"]>, Handle[]>();
  private readonly programs = new WeakMap<CodeItem, { code: Handle; pcs: number[]; unsupported?: [number, number] }>();
  constructor(instantiate = (bytes: Uint8Array, imports: Record<string, Record<string, unknown>>) =>
    new WebAssembly.Instance(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>), imports as WebAssembly.Imports)) {
    const mb = new ModuleBuilder(), words = mb.addType({ k: "array", elem: { t: T.i32, mut: true } });
    const bits = mb.addType({ k: "array", elem: { t: T.i64, mut: true } });
    const refs = mb.addType({ k: "array", elem: { t: T.anyref, mut: true } });
    // Code, numeric/reference registers, cursor, DEX PC, result bits/reference, register kinds (0 bits, 1 reference), back-edge count.
    const frame = mb.addType({ k: "struct", fields: [ref(words), ref(bits), ref(refs), T.i32, T.i32, T.i64, T.anyref, ref(words), T.i32].map((t) => ({ t, mut: true })) });

    const equal = mb.importFunc("host", "equal", mb.addFuncType([T.externref, T.externref], [T.i32]));
    const functions = new Map<string, { index: number; params: VT[]; results: VT[] }>();
    const fn = (name: string, params: Parameters<ModuleBuilder["addFuncType"]>[0], results: Parameters<ModuleBuilder["addFuncType"]>[0], emit: (c: Code) => void) => {
      const c = new Code(params.length); emit(c);
      const index = mb.addFunc(mb.addFuncType(params, results), c.finish(), "$cold:" + name);
      mb.export(name, "func", index); functions.set(name, { index, params, results });
    };
    fn("code", [T.i32], [ref(words)], (c) => c.lget(0).arrayNewDefault(words));
    fn("word", [ref(words), T.i32, T.i32], [], (c) => c.lget(0).lget(1).lget(2).arraySet(words));
    fn("frame", [ref(words), T.i32], [ref(frame)], (c) => c.lget(0).lget(1).arrayNewDefault(bits).lget(1).arrayNewDefault(refs).i32(0).i32(0).i64(0n).anyNull().lget(1).arrayNewDefault(words).i32(0).structNew(frame));
    fn("bits", [ref(frame), T.i32, T.i64], [], (c) => {
      c.lget(0).structGet(frame, 1).lget(1).lget(2).arraySet(bits);
      c.lget(0).structGet(frame, 2).lget(1).anyNull().arraySet(refs);
      c.lget(0).structGet(frame, 7).lget(1).i32(0).arraySet(words);
    });
    fn("object", [ref(frame), T.i32, T.externref], [], (c) => {
      c.lget(0).structGet(frame, 2).lget(1).lget(2).anyConvertExtern().arraySet(refs);
      c.lget(0).structGet(frame, 1).lget(1).i64(0n).arraySet(bits);
      c.lget(0).structGet(frame, 7).lget(1).i32(1).arraySet(words);
    });
    fn("pc", [ref(frame)], [T.i32], (c) => c.lget(0).structGet(frame, 4));
    fn("executed", [ref(frame), T.i32], [], (c) => c.lget(0).lget(1).structSet(frame, 4));
    fn("cursor", [ref(frame), T.i32], [], (c) => c.lget(0).lget(1).structSet(frame, 3));
    fn("edges", [ref(frame)], [T.i32], c => c.lget(0).structGet(frame, 8));
    fn("setEdges", [ref(frame), T.i32], [], c => c.lget(0).lget(1).structSet(frame, 8));
    fn("index", [ref(frame)], [T.i32], (c) => c.lget(0).structGet(frame, 3));
    fn("readBits", [ref(frame), T.i32], [T.i64], (c) => c.lget(0).structGet(frame, 1).lget(1).arrayGet(bits));
    fn("readObject", [ref(frame), T.i32], [T.externref], (c) => c.lget(0).structGet(frame, 2).lget(1).arrayGet(refs).externConvertAny());
    fn("kind", [ref(frame), T.i32], [T.i32], (c) => c.lget(0).structGet(frame, 7).lget(1).arrayGet(words));
    fn("result", [ref(frame)], [T.i64], (c) => c.lget(0).structGet(frame, 5));
    fn("reference", [ref(frame)], [T.externref], (c) => c.lget(0).structGet(frame, 6).externConvertAny());
    fn("run", [ref(frame), T.i32], [T.i32], (c) => {
      const at = c.newLocal(T.i32), opcode = c.newLocal(T.i32), a = c.newLocal(T.i32), b = c.newLocal(T.i32), d = c.newLocal(T.i32), value = c.newLocal(T.i64);
      const scan = c.newLocal(T.i32), stop = c.newLocal(T.i32), target = c.newLocal(T.i32);
      const word = (offset: number) => c.lget(0).structGet(frame, 0).lget(at).i32(offset).raw(OP.i32_add).arrayGet(words);
      const numeric = (reg: number, kind: Numeric) => {
        c.lget(0).structGet(frame, 1).lget(reg).arrayGet(bits);
        if (kind === "int" || kind === "float") c.raw(OP.i32_wrap_i64);
        if (kind === "float") c.raw(OP.f32_reinterpret_i32);
        if (kind === "double") c.raw(OP.f64_reinterpret_i64);
      };
      const reference = (reg: number) => c.lget(0).structGet(frame, 2).lget(reg).arrayGet(refs);
      const kind = (reg: number) => c.lget(0).structGet(frame, 7).lget(reg).arrayGet(words);
      const store = (kind: Numeric) => {
        if (kind === "float") c.raw(OP.i32_reinterpret_f32);
        if (kind === "int" || kind === "float") c.raw(OP.i64_extend_i32_s);
        if (kind === "double") c.raw(OP.i64_reinterpret_f64);
        c.lset(value).lget(0).structGet(frame, 1).lget(a).lget(value).arraySet(bits);
        c.lget(0).structGet(frame, 2).lget(a).anyNull().arraySet(refs);
        c.lget(0).structGet(frame, 7).lget(a).i32(0).arraySet(words);
      };
      const next = () => { c.lget(0); word(5); c.structSet(frame, 3); };
      const jump = () => {
        c.lset(target).lget(target).lget(0).structGet(frame, 3).raw(OP.i32_le_u).if_();
        c.lget(0).lget(0).structGet(frame, 8).i32(1).raw(OP.i32_add).structSet(frame, 8).end();
        c.lget(0).lget(target).structSet(frame, 3);
      };
      const handler = (id: number, emit: () => void) => {
        c.lget(opcode).i32(id).raw(OP.i32_eq).if_(); emit(); next(); c.br(1).end();
      };
      c.loop().lget(1).raw(OP.i32_eqz).if_().i32(0).ret().end();
      c.lget(1).i32(1).raw(OP.i32_sub).lset(1);
      c.lget(0).structGet(frame, 3).i32(WIDTH).raw(OP.i32_mul).lset(at);
      word(0); c.lset(opcode);
      c.lget(opcode).i32(I.Unsupported).raw(OP.i32_eq).if_().i32(2).ret().end();
      c.lget(0); word(1); c.structSet(frame, 4); word(2); c.lset(a); word(3); c.lset(b); word(4); c.lset(d);
      handler(I.Const, () => { word(6); c.raw(OP.i64_extend_i32_u); word(7); c.raw(OP.i64_extend_i32_u).i64(32n).raw(OP.i64_shl, OP.i64_or); store("long"); });
      handler(I.Move, () => { numeric(b, "long"); store("long"); });
      handler(I.MoveObject, () => {
        c.lget(0).structGet(frame, 2).lget(a); reference(b); c.arraySet(refs);
        c.lget(0).structGet(frame, 1).lget(a).i64(0n).arraySet(bits);
        c.lget(0).structGet(frame, 7).lget(a).i32(1).arraySet(words);
      });
      handler(I.ReturnVoid, () => { c.i32(1).ret(); });
      handler(I.ReturnBits, () => { c.lget(0); numeric(a, "long"); c.structSet(frame, 5).i32(1).ret(); });
      handler(I.ReturnObject, () => { c.lget(0); reference(a); c.structSet(frame, 6).i32(1).ret(); });
      c.lget(opcode).i32(I.Goto).raw(OP.i32_eq).if_(); word(6); jump(); c.br(1).end();
      for (const [i, compare] of [OP.i32_eq, OP.i32_ne, OP.i32_lt_s, OP.i32_ge_s, OP.i32_gt_s, OP.i32_le_s].entries()) {
        c.lget(opcode).i32(I.Eq + i).raw(OP.i32_eq).if_();
        if (i < 2) {
          kind(a); c.lget(b).i32(-1).raw(OP.i32_eq).if_(T.i32).i32(0).else_(); kind(b); c.end().raw(OP.i32_or).if_(T.i32);
          reference(a); c.externConvertAny(); c.lget(b).i32(-1).raw(OP.i32_eq).if_(T.anyref).anyNull().else_(); reference(b); c.end().externConvertAny().call(equal);
          if (i === 1) c.raw(OP.i32_eqz);
          c.else_();
        }
        numeric(a, "int"); c.lget(b).i32(-1).raw(OP.i32_eq).if_(T.i32).i32(0).else_(); numeric(b, "int"); c.end().raw(compare);
        if (i < 2) c.end();
        c.if_(); word(6); jump(); c.else_(); next(); c.end().br(1).end();
      }
      handler(I.Rsub, () => { word(4); numeric(b, "int"); c.raw(OP.i32_sub); store("int"); });
      handler(I.CmpLong, () => {
        numeric(b, "long"); numeric(d, "long"); c.raw(OP.i64_gt_s);
        numeric(b, "long"); numeric(d, "long"); c.raw(OP.i64_lt_s, OP.i32_sub); store("int");
      });
      for (const [id, type, nan] of [[I.CmpLf, "float", -1], [I.CmpGf, "float", 1], [I.CmpLd, "double", -1], [I.CmpGd, "double", 1]] as const) handler(id, () => {
        const eq = type === "float" ? OP.f32_eq : OP.f64_eq, gt = type === "float" ? OP.f32_gt : OP.f64_gt, lt = type === "float" ? OP.f32_lt : OP.f64_lt;
        numeric(b, type); numeric(b, type); c.raw(eq); numeric(d, type); numeric(d, type); c.raw(eq, OP.i32_and).if_(T.i32);
        numeric(b, type); numeric(d, type); c.raw(gt); numeric(b, type); numeric(d, type); c.raw(lt, OP.i32_sub).else_().i32(nan).end(); store("int");
      });
      c.lget(opcode).i32(I.Switch).raw(OP.i32_eq).if_();
      word(5); c.lset(target); word(6); c.ltee(scan).lget(d).i32(2).raw(OP.i32_mul, OP.i32_add).lset(stop);
      c.block().loop().lget(scan).lget(stop).raw(OP.i32_ge_u).brIf(1);
      numeric(a, "int"); c.lget(0).structGet(frame, 0).lget(scan).arrayGet(words).raw(OP.i32_eq).if_();
      c.lget(0).structGet(frame, 0).lget(scan).i32(1).raw(OP.i32_add).arrayGet(words).lset(target).br(2).end();
      c.lget(scan).i32(2).raw(OP.i32_add).lset(scan).br(0).end().end();
      c.lget(target); jump(); c.br(1).end();
      operations.forEach((op, i) => {
        handler(32 + i, () => {
          numeric(b, op.input);
          if (!op.unary) {
            const shift = op.name.startsWith("sh") || op.name.startsWith("ush");
            numeric(d, shift ? "int" : op.input);
            if (shift && op.input === "long") c.raw(OP.i64_extend_i32_u);
          }
          c.raw(...op.op); store(op.output);
        });
        if (!op.unary && op.input === "int") handler(160 + i, () => {
          numeric(b, "int"); word(4); c.raw(...op.op); store("int");
        });
      });
      c.i32(2).ret().end().unreachable();
    });
    for (const [name, f] of functions) {
      if (name === "frame" || name === "code" || name === "word") continue;
      const c = new Code(f.params.length);
      c.lget(0).anyConvertExtern().refCast(frame);
      for (let i = 1; i < f.params.length; i++) c.lget(i);
      c.call(f.index);
      mb.export("ext:" + name, "func", mb.addFunc(mb.addFuncType([T.externref, ...f.params.slice(1)], f.results), c.finish(), "$cold:ext:" + name));
    }
    this.bytes = mb.build();
    this.imports = instantiate(this.bytes, {
      host: {
        unsupported: (pc: number, opcode: number) => { throw new Error(`cold interpreter: unsupported opcode 0x${opcode.toString(16)} at DEX PC ${pc}`); },
        equal: (a: unknown, b: unknown) => +(a === b),
      },
    }).exports;
    this.api = this.imports as unknown as Exports;
  }
  prepare(item: CodeItem, slow = false, decoded?: ReturnType<typeof coldCode>): () => Handle {
    let program = this.programs.get(item);
    if (!program) {
      const { words, pcs } = decoded ?? coldCode(item);
      let unsupported: [number, number] | undefined;
      for (let i = 0; i < pcs.length * WIDTH; i += WIDTH) if (words[i] === I.Unsupported) { unsupported = [words[i + 1], words[i + 6]]; break; }
      const code = this.api.code(words.length);
      for (let i = 0; i < words.length; i++) this.api.word(code, i, words[i]);
      this.programs.set(item, program = { code, pcs, unsupported });
    }
    if (!slow && program.unsupported) throw new UnsupportedColdBody(...program.unsupported);
    const ready = program;
    return () => {
      const frame = this.api.frame(ready.code, item.regs);
      this.frames.set(frame, { item, pcs: ready.pcs, done: false, slow, busy: false, context: { monitors: [], uninitialized: [], sync: false, depth: 0 } });
      return frame;
    };
  }
  create(item: CodeItem): Handle { return this.prepare(item)(); }
  setBits(frame: Handle, register: number, value: bigint): void { this.api.bits(frame, register, value); }
  setObject(frame: Handle, register: number, value: unknown): void { this.api.object(frame, register, value); }
  seed(frame: Handle, register: number, type: string, value: unknown): void {
    if (type.startsWith("L") || type.startsWith("[")) { this.setObject(frame, register, value); return; }
    if (type === "J") { this.setBits(frame, register, BigInt(value as bigint)); return; }
    if (type === "F" || type === "D") {
      const bits = new DataView(new ArrayBuffer(8));
      if (type === "F") { bits.setFloat32(0, Number(value), true); this.setBits(frame, register, BigInt(bits.getInt32(0, true))); }
      else { bits.setFloat64(0, Number(value), true); this.setBits(frame, register, bits.getBigInt64(0, true)); }
      return;
    }
    this.setBits(frame, register, BigInt(Number(value) | 0));
  }
  resume(frame: Handle, budget: number): boolean {
    if (!Number.isInteger(budget) || budget < 1 || budget > 0x7fffffff) throw new Error("invalid cold instruction budget");
    const state = this.frames.get(frame);
    if (!state) throw new Error("foreign cold activation");
    if (state.busy) throw new Error("cold operation already in flight");
    if (state.done) return true;
    const status = this.api.run(frame, budget);
    if (status === 2) throw new UnsupportedColdBody(this.pc(frame), 0);
    return state.done = status === 1;
  }
  pc(frame: Handle): number { return this.api.pc(frame); }
  enterAt(frame: Handle, item: CodeItem, pc: number): void {
    const state = this.frames.get(frame);
    if (state?.item !== item) throw new Error("cold activation belongs to a different method");
    if (state.busy) throw new Error("cold operation already in flight");
    const index = state.pcs.indexOf(pc);
    if (index < 0) throw new Error(`not a DEX instruction boundary: ${pc}`);
    this.api.cursor(frame, index); state.done = false;
  }
  snapshot(frame: Handle): ColdSnapshot {
    const state = this.frames.get(frame);
    if (!state || state.done || state.busy) throw new Error("no committed cold activation to snapshot");
    const pc = state.pcs[this.api.index(frame)];
    if (pc === undefined) throw new Error("cold activation left its code");
    const bits = new BigInt64Array(state.item.regs), references: unknown[] = [], kinds = new Uint8Array(state.item.regs);
    for (let i = 0; i < bits.length; i++) {
      bits[i] = this.api.readBits(frame, i); kinds[i] = this.api.kind(frame, i);
      references.push(this.api.readObject(frame, i));
    }
    return { item: state.item, ...state.context, monitors: state.context.monitors.map(m => ({ ...m })), uninitialized: state.context.uninitialized.map(a => ({ ...a })), result: state.context.result && { ...state.context.result }, exception: state.context.exception && { ...state.context.exception }, pc, executedPc: this.api.pc(frame), edges: this.api.edges(frame), bits, references, kinds };
  }
  validate(item: CodeItem, snapshot: ColdSnapshot): void { validateColdSnapshot(snapshot, item); }

  commit(frame: Handle, snapshot: ColdSnapshot): void {
    const state = this.frames.get(frame);
    if (!state || state.busy) throw new Error("no committed cold activation");
    this.validate(state.item, snapshot);
    if (state.context.owner && state.context.owner !== snapshot.owner) throw new Error("cold activation cannot change strands");
    this.enterAt(frame, state.item, snapshot.pc); this.api.executed(frame, snapshot.executedPc); this.api.setEdges(frame, snapshot.edges);
    for (let i = 0; i < state.item.regs; i++) {
      if (snapshot.kinds[i] === 1) this.setObject(frame, i, snapshot.references[i]);
      else this.setBits(frame, i, snapshot.bits[i]);
    }
    state.context = { method: snapshot.method, owner: snapshot.owner, sync: snapshot.sync, depth: snapshot.depth, result: snapshot.result && { ...snapshot.result }, exception: snapshot.exception && { ...snapshot.exception }, monitors: snapshot.monitors.map(m => ({ ...m })), uninitialized: snapshot.uninitialized.map(a => ({ ...a })) };
    this.context(frame, snapshot.method, snapshot.owner, snapshot.sync, snapshot.depth);
  }
  restore(item: CodeItem, snapshot: ColdSnapshot): Handle {
    this.validate(item, snapshot);
    const frame = this.prepare(item, !!snapshot.method)(); this.commit(frame, snapshot); return frame;
  }
  context(frame: Handle, method: ColdSnapshot["method"], owner: ColdSnapshot["owner"], sync = false, depth = 0): void {
    const state = this.frames.get(frame);
    if (!state || state.context.owner && state.context.owner !== owner) throw new Error("foreign cold activation owner");
    state.context = { ...state.context, method, owner, sync, depth };
    if (owner) { let frames = this.active.get(owner); if (!frames) this.active.set(owner, frames = []); if (!frames.includes(frame)) frames.push(frame); }
  }
  attempt(frame: Handle, pc: number): void { this.api.executed(frame, pc); }
  transfer(frame: Handle): ColdSnapshot { const state = this.snapshot(frame); this.finish(frame); return state; }
  owner(frame: Handle): ColdSnapshot["owner"] { return this.frames.get(frame)?.context.owner; }
  synchronous(frame: Handle): boolean { return this.frames.get(frame)!.context.sync; }
  hasActive(owner: NonNullable<ColdSnapshot["owner"]>): boolean { return !!this.active.get(owner)?.length; }
  tracePcs(method: ColdSnapshot["method"], owner: NonNullable<ColdSnapshot["owner"]>): number[] {
    return (this.active.get(owner) ?? []).filter(f => this.frames.get(f)?.context.method === method).reverse().map(f => this.pc(f));
  }
  finish(frame: Handle): void {
    const state = this.frames.get(frame);
    if (!state || state.busy) throw new Error("cold activation ended with an operation in flight");
    state.done = true;
    const frames = state.context.owner && this.active.get(state.context.owner), index = frames?.indexOf(frame) ?? -1;
    if (index >= 0) frames!.splice(index, 1);
  }
  inFlight(frame: Handle, busy: boolean): void {
    const state = this.frames.get(frame);
    if (!state || state.busy === busy) throw new Error("invalid cold operation transition");
    state.busy = busy;
  }
  result(frame: Handle): bigint { return this.api.result(frame); }
  reference(frame: Handle): unknown { return this.api.reference(frame); }
}
