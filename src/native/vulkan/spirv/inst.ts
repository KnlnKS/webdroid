// A function's instructions as WGSL statements: each result a `let`, or the assignment of the
// function-scope `var` a value used outside its block is hoisted to.

import { O, type Inst, type Of } from "./module.ts";
import { BUFFER_DIM, texelComponents, type MatLayout, type Translator } from "./layout.ts";
import type { Fn } from "./cfg.ts";

export interface Ctx { t: Translator; fn: Fn; lines: string[]; depth: number; vals: Map<number, string>; refs: Map<number, string>; mats: Map<number, MatRef>; hoisted: Set<number>; phis: Map<number, Inst[]>; done: Set<number> }
/** a pointer into a member's matrices (matLayout): to the matrix or array of them of type `type` that `text` holds, or to column
 *  `col` of a row-major one */
interface MatRef { text: string; type: number; m: MatLayout; col?: string }

export const line = (c: Ctx, s: string) => { c.lines.push("  ".repeat(c.depth) + s); };
export function value(c: Ctx, id: number): string {
  const v = c.vals.get(id) ?? c.t.consts.get(id);
  if (v !== undefined) return v;
  if (c.hoisted.has(id)) return `x_${id}`;
  const r = c.refs.get(id);
  if (r !== undefined) return r;
  throw new Error(`SPIR-V: %${id} used before its definition`);
}
function ref(c: Ctx, id: number): string {
  const r = c.refs.get(id) ?? (c.t.types.has(c.t.resultType.get(id) ?? -1) ? `x_${id}` : undefined);
  if (r === undefined) throw new Error(`SPIR-V: %${id} is not a pointer`);
  return r;
}
/** `id`'s value as the type `want`: the same bits where only integer signedness differs */
export function as(c: Ctx, id: number, want: number): string {
  const v = value(c, id), have = c.t.resultType.get(id);
  if (have === undefined || have === want) return v;
  const a = c.t.wgsl(have), b = c.t.wgsl(want);
  return a === b ? v : `bitcast<${b}>(${v})`;
}
/** an integer operand as signed or unsigned */
function asInt(c: Ctx, id: number, signed: boolean): string {
  const have = c.t.resultType.get(id)!;
  return c.t.signed(have) === signed ? value(c, id) : `bitcast<${c.t.intType(have, signed)}>(${value(c, id)})`;
}
/** a result: a let, or the assignment of a hoisted var */
function define(c: Ctx, id: number, expr: string): void {
  if (c.hoisted.has(id)) line(c, `x_${id} = ${expr};`);
  else { line(c, `let x_${id} = ${expr};`); c.vals.set(id, `x_${id}`); }
}
/** an integer op computed in `signed` arithmetic, given back as the result type */
function intOp(c: Ctx, ty: number, signed: boolean, expr: (a: (id: number) => string) => string): string {
  const e = expr((id) => asInt(c, id, signed));
  return c.t.signed(ty) === signed ? e : `bitcast<${c.t.wgsl(ty)}>(${e})`;
}

const GLSL: Record<number, string> = {
  1: "round", 2: "round", 3: "trunc", 4: "abs", 5: "abs", 6: "sign", 7: "sign", 8: "floor", 9: "ceil", 10: "fract", 11: "radians", 12: "degrees",
  13: "sin", 14: "cos", 15: "tan", 16: "asin", 17: "acos", 18: "atan", 19: "sinh", 20: "cosh", 21: "tanh", 22: "asinh", 23: "acosh", 24: "atanh",
  25: "atan2", 26: "pow", 27: "exp", 28: "log", 29: "exp2", 30: "log2", 31: "sqrt", 32: "inverseSqrt", 33: "determinant",
  37: "min", 38: "min", 39: "min", 40: "max", 41: "max", 42: "max", 43: "clamp", 44: "clamp", 45: "clamp", 46: "mix", 48: "step", 49: "smoothstep",
  50: "fma", 53: "ldexp", 54: "pack4x8snorm", 55: "pack4x8unorm", 56: "pack2x16snorm", 57: "pack2x16unorm", 58: "pack2x16float",
  60: "unpack2x16snorm", 61: "unpack2x16unorm", 62: "unpack2x16float", 63: "unpack4x8snorm", 64: "unpack4x8unorm",
  66: "length", 67: "distance", 68: "cross", 69: "normalize", 70: "faceForward", 71: "reflect", 72: "refract", 73: "firstTrailingBit",
  74: "firstLeadingBit", 75: "firstLeadingBit", 79: "min", 80: "max", 81: "clamp",
};
const GLSL_SIGNED = new Set([5, 7, 39, 42, 45, 74]), GLSL_UNSIGNED = new Set([38, 41, 44, 75]);
const BINARY: Record<number, string> = {
  [O.FAdd]: "+", [O.FSub]: "-", [O.FMul]: "*", [O.FDiv]: "/", [O.FRem]: "%", [O.VectorTimesScalar]: "*", [O.MatrixTimesScalar]: "*",
  [O.VectorTimesMatrix]: "*", [O.MatrixTimesVector]: "*", [O.MatrixTimesMatrix]: "*",
  [O.FOrdEqual]: "==", [O.FUnordEqual]: "==", [O.FOrdNotEqual]: "!=", [O.FUnordNotEqual]: "!=", [O.FOrdLessThan]: "<", [O.FUnordLessThan]: "<",
  [O.FOrdGreaterThan]: ">", [O.FUnordGreaterThan]: ">", [O.FOrdLessThanEqual]: "<=", [O.FUnordLessThanEqual]: "<=", [O.FOrdGreaterThanEqual]: ">=",
  [O.FUnordGreaterThanEqual]: ">=", [O.LogicalEqual]: "==", [O.LogicalNotEqual]: "!=", [O.LogicalOr]: "||", [O.LogicalAnd]: "&&",
};
/** integer ops: their operator and the signedness their operands take, null where either does */
const INT_BINARY: Record<number, [string, boolean | null]> = {
  [O.IAdd]: ["+", null], [O.ISub]: ["-", null], [O.IMul]: ["*", null], [O.UDiv]: ["/", false], [O.SDiv]: ["/", true], [O.UMod]: ["%", false], [O.SRem]: ["%", true],
  [O.BitwiseOr]: ["|", null], [O.BitwiseXor]: ["^", null], [O.BitwiseAnd]: ["&", null],
};
const INT_COMPARE: Record<number, [string, boolean | null]> = {
  [O.IEqual]: ["==", null], [O.INotEqual]: ["!=", null], [O.UGreaterThan]: [">", false], [O.SGreaterThan]: [">", true], [O.UGreaterThanEqual]: [">=", false],
  [O.SGreaterThanEqual]: [">=", true], [O.ULessThan]: ["<", false], [O.SLessThan]: ["<", true], [O.ULessThanEqual]: ["<=", false], [O.SLessThanEqual]: ["<=", true],
};
const DERIVATIVE: Record<number, string> = { [O.DPdx]: "dpdx", [O.DPdy]: "dpdy", [O.Fwidth]: "fwidth", [O.DPdxFine]: "dpdxFine", [O.DPdyFine]: "dpdyFine",
  [O.FwidthFine]: "fwidthFine", [O.DPdxCoarse]: "dpdxCoarse", [O.DPdyCoarse]: "dpdyCoarse", [O.FwidthCoarse]: "fwidthCoarse" };
const ATOMIC: Record<number, string> = { [O.AtomicExchange]: "atomicExchange", [O.AtomicIAdd]: "atomicAdd", [O.AtomicISub]: "atomicSub", [O.AtomicSMin]: "atomicMin",
  [O.AtomicUMin]: "atomicMin", [O.AtomicSMax]: "atomicMax", [O.AtomicUMax]: "atomicMax", [O.AtomicAnd]: "atomicAnd", [O.AtomicOr]: "atomicOr", [O.AtomicXor]: "atomicXor" };

/** an access into a composite of type `ty` at constant index `i`: a struct member, a vector component or an element */
function member(t: Translator, ty: number, i: number): { text: string; type: number } {
  const tt = t.type(ty);
  if (tt.k === "struct") return { text: `.m${i}`, type: tt.members[i] };
  if (tt.k === "vec") return { text: `.${"xyzw"[i]}`, type: tt.el };
  if (tt.k === "mat") return { text: `[${i}]`, type: tt.col };
  if (tt.k === "array") return { text: `[${i}]${t.padded(ty) !== undefined ? ".v" : ""}`, type: tt.el };
  throw new Error(`SPIR-V: a member of ${tt.k}`);
}

/** vector `i` of the matrix `text` holds in layout `m`: a row of a row-major one, else a column */
const vecOf = (m: MatLayout, text: string, i: number | string) => `${text}[${i}]${m.wrap ? ".v" : ""}`;
/** the value a MatRef points to */
function matValue(t: Translator, { text, type, m, col }: MatRef): string {
  const ty = t.type(type), vecs = (f: (v: string) => string) => Array.from({ length: m.k }, (_, i) => f(vecOf(m, text, i))).join(", ");
  if (col !== undefined) return `vec${m.R}<${m.el}>(${vecs((v) => `${v}[${col}]`)})`;
  if (ty.k === "array") {
    if (ty.len === null) throw new Error("SPIR-V: a runtime array of matrices loaded whole");
    return `${t.wgsl(type)}(${Array.from({ length: ty.len }, (_, i) => matValue(t, { text: `${text}[${i}]`, type: ty.el, m })).join(", ")})`;
  }
  return m.rowMajor ? `transpose(mat${m.R}x${m.C}<${m.el}>(${vecs((v) => v)}))` : `mat${m.C}x${m.R}<${m.el}>(${vecs((v) => v)})`;
}
/** a store of `v` through a MatRef, a vector at a time */
function storeMat(c: Ctx, { text, type, m, col }: MatRef, v: string): void {
  if (c.t.type(type).k === "array") throw new Error("SPIR-V: a store of an array of row-major or padded matrices");
  const tmp = `x_m${c.lines.length}`;
  line(c, `let ${tmp} = ${m.rowMajor && col === undefined ? `transpose(${v})` : v};`);
  for (let i = 0; i < m.k; i++) line(c, col !== undefined ? `${vecOf(m, text, i)}[${col}] = ${tmp}[${i}];` : `${vecOf(m, text, i)} = ${tmp}[${i}];`);
}

export function emitInst(c: Ctx, i: Inst): void {
  const t = c.t, w = i.w, op = i.op;
  const ty = w[0], id = w[1];
  const bin = BINARY[op];
  if (bin) return define(c, id, `(${value(c, w[2])} ${bin} ${value(c, w[3])})`);
  const ib = INT_BINARY[op];
  if (ib) { const signed = ib[1] ?? t.signed(ty); return define(c, id, intOp(c, ty, signed, (a) => `(${a(w[2])} ${ib[0]} ${a(w[3])})`)); }
  const ic = INT_COMPARE[op];
  if (ic) { const signed = ic[1] ?? t.signed(t.resultType.get(w[2])!); return define(c, id, `(${asInt(c, w[2], signed)} ${ic[0]} ${asInt(c, w[3], signed)})`); }
  const der = DERIVATIVE[op];
  if (der) return define(c, id, `${der}(${value(c, w[2])})`);
  const atomic = ATOMIC[op];
  if (atomic) return define(c, id, `${atomic}(&${ref(c, w[2])}, ${as(c, w[5], ty)})`);
  switch (op) {
    case O.Variable: return;
    case O.Phi: return;
    case O.Load: {
      const rt = t.type(ty), mr = c.mats.get(w[2]);
      if (rt.k === "image" || rt.k === "sampler" || rt.k === "sampled") {
        // a combined image sampler is its texture and the sampler declared beside it, as OpSampledImage pairs them
        const r = ref(c, w[2]); c.refs.set(id, r); c.vals.set(id, rt.k === "sampled" ? `${r}, ${r}_s` : r); return;
      }
      return define(c, id, mr ? matValue(t, mr) : ref(c, w[2]));
    }
    case O.Store: {
      const mr = c.mats.get(w[0]);
      if (mr) return storeMat(c, mr, value(c, w[1]));
      return line(c, `${ref(c, w[0])} = ${as(c, w[1], t.pointee(t.resultType.get(w[0])!))};`);
    }
    case O.CopyMemory:
      if (c.mats.has(w[0]) || c.mats.has(w[1])) throw new Error("SPIR-V: a copy of row-major or padded matrices");
      return line(c, `${ref(c, w[0])} = ${ref(c, w[1])};`);
    case O.AccessChain: case O.InBoundsAccessChain: {
      const base = c.mats.get(w[2]);
      let text = base?.text ?? ref(c, w[2]), cur = base?.type ?? t.pointee(t.resultType.get(w[2])!), m = base?.m ?? null, col = base?.col;
      for (const idx of w.subarray(3)) {
        const k = t.constValues.get(idx), at = k !== undefined ? `${k}` : value(c, idx), tt = t.type(cur);
        if (m && tt.k === "array") { text += `[${at}]`; cur = tt.el; }
        else if (m && tt.k === "mat" && m.rowMajor) { col = at; cur = tt.col; }
        else if (m) { text = tt.k === "mat" ? vecOf(m, text, at) : `${vecOf(m, text, at)}[${col}]`; cur = t.element(cur); m = null; }
        else if (tt.k === "struct") { const mb = member(t, cur, k!); text += mb.text; m = t.matLayout(cur, k!); cur = mb.type; }
        else { text += `[${at}]${t.padded(cur) !== undefined ? ".v" : ""}`; cur = t.element(cur); }
      }
      if (m) c.mats.set(id, { text, type: cur, m, col });
      c.refs.set(id, text);
      return;
    }
    case O.CompositeExtract: {
      let text = value(c, w[2]), cur = t.resultType.get(w[2])!;
      for (const k of w.subarray(3)) {
        const mb = member(t, cur, k), m = t.type(cur).k === "struct" ? t.matLayout(cur, k) : null;
        text = m ? matValue(t, { text: text + mb.text, type: mb.type, m }) : text + mb.text; cur = mb.type;
      }
      return define(c, id, text);
    }
    case O.CompositeInsert: {
      line(c, `var x_${id}_v = ${value(c, w[3])};`);
      let text = `x_${id}_v`, cur = t.resultType.get(w[3])!;
      for (const k of w.subarray(4)) {
        if (t.type(cur).k === "struct" && t.matLayout(cur, k)) throw new Error("SPIR-V: an insert of row-major or padded matrices");
        const mb = member(t, cur, k); text += mb.text; cur = mb.type;
      }
      line(c, `${text} = ${value(c, w[2])};`);
      return define(c, id, `x_${id}_v`);
    }
    case O.CompositeConstruct: {
      const rt = t.type(ty);
      if (rt.k === "struct" && rt.members.some((_, i) => t.matLayout(ty, i))) throw new Error("SPIR-V: a struct of row-major or padded matrices constructed");
      const parts = [...w.subarray(2)].map((p, i) => rt.k === "vec" || rt.k === "mat" ? value(c, p) : as(c, p, rt.k === "struct" ? rt.members[i] : t.element(ty)));
      return define(c, id, t.construct(ty, parts));
    }
    case O.VectorShuffle: {
      const a = t.kind(t.resultType.get(w[2])!, "vec"), parts = [...w.subarray(4)].map((k) => k === 0xffffffff ? `${value(c, w[2])}.x` : k < a.n ? `${value(c, w[2])}.${"xyzw"[k]}` : `${value(c, w[3])}.${"xyzw"[k - a.n]}`);
      return define(c, id, `${t.wgsl(ty)}(${parts.join(", ")})`);
    }
    case O.VectorExtractDynamic: return define(c, id, `${value(c, w[2])}[${value(c, w[3])}]`);
    case O.VectorInsertDynamic: line(c, `var x_${id}_v = ${value(c, w[2])};`); line(c, `x_${id}_v[${value(c, w[4])}] = ${value(c, w[3])};`); return define(c, id, `x_${id}_v`);
    case O.CopyObject: if (t.type(ty).k === "ptr") { c.refs.set(id, ref(c, w[2])); return; } return define(c, id, value(c, w[2]));
    case O.Transpose: return define(c, id, `transpose(${value(c, w[2])})`);
    case O.Dot: return define(c, id, `dot(${value(c, w[2])}, ${value(c, w[3])})`);
    case O.OuterProduct: throw new Error("SPIR-V: OpOuterProduct");
    case O.FNegate: return define(c, id, `(-${value(c, w[2])})`);
    case O.SNegate: return define(c, id, intOp(c, ty, true, (a) => `(-${a(w[2])})`));
    case O.Not: return define(c, id, `(~${as(c, w[2], ty)})`);
    case O.LogicalNot: return define(c, id, `(!${value(c, w[2])})`);
    case O.Any: return define(c, id, `any(${value(c, w[2])})`);
    case O.All: return define(c, id, `all(${value(c, w[2])})`);
    case O.IsNan: { const v = value(c, w[2]); return define(c, id, `(${v} != ${v})`); }
    case O.IsInf: return define(c, id, `(abs(${value(c, w[2])}) > ${t.wgsl(t.resultType.get(w[2])!)}(0x1.fffffep+127))`);
    case O.Select: return define(c, id, `select(${as(c, w[4], ty)}, ${as(c, w[3], ty)}, ${value(c, w[2])})`);
    case O.SMod: {
      // the remainder with the divisor's sign
      const a = asInt(c, w[2], true), b = asInt(c, w[3], true);
      return define(c, id, intOp(c, ty, true, () => `select(${a} % ${b}, ${a} % ${b} + ${b}, (${a} % ${b} != ${t.intType(ty, true)}(0)) && ((${a} % ${b} < ${t.intType(ty, true)}(0)) != (${b} < ${t.intType(ty, true)}(0))))`));
    }
    case O.FMod: { const a = value(c, w[2]), b = value(c, w[3]); return define(c, id, `(${a} - ${b} * floor(${a} / ${b}))`); }
    case O.ShiftLeftLogical: return define(c, id, `(${as(c, w[2], ty)} << ${asInt(c, w[3], false)})`);
    case O.ShiftRightLogical: return define(c, id, intOp(c, ty, false, (a) => `(${a(w[2])} >> ${asInt(c, w[3], false)})`));
    case O.ShiftRightArithmetic: return define(c, id, intOp(c, ty, true, (a) => `(${a(w[2])} >> ${asInt(c, w[3], false)})`));
    case O.BitCount: return define(c, id, as(c, w[2], ty) === value(c, w[2]) ? `countOneBits(${value(c, w[2])})` : `bitcast<${t.wgsl(ty)}>(countOneBits(${value(c, w[2])}))`);
    case O.BitReverse: return define(c, id, `reverseBits(${as(c, w[2], ty)})`);
    case O.BitFieldInsert: return define(c, id, `insertBits(${as(c, w[2], ty)}, ${as(c, w[3], ty)}, ${asInt(c, w[4], false)}, ${asInt(c, w[5], false)})`);
    case O.BitFieldSExtract: return define(c, id, intOp(c, ty, true, (a) => `extractBits(${a(w[2])}, ${asInt(c, w[3], false)}, ${asInt(c, w[4], false)})`));
    case O.BitFieldUExtract: return define(c, id, intOp(c, ty, false, (a) => `extractBits(${a(w[2])}, ${asInt(c, w[3], false)}, ${asInt(c, w[4], false)})`));
    case O.ConvertFToU: case O.ConvertFToS: case O.ConvertUToF: case O.FConvert: return define(c, id, `${t.wgsl(ty)}(${value(c, w[2])})`);
    case O.ConvertSToF: return define(c, id, `${t.wgsl(ty)}(${asInt(c, w[2], true)})`);
    case O.UConvert: case O.SConvert: return define(c, id, as(c, w[2], ty));
    case O.QuantizeToF16: return define(c, id, `quantizeToF16(${value(c, w[2])})`);
    case O.Bitcast: return define(c, id, `bitcast<${t.wgsl(ty)}>(${value(c, w[2])})`);
    case O.ArrayLength: return define(c, id, `arrayLength(&${ref(c, w[2])}.m${w[3]})`);
    case O.ExtInst: {
      if (!t.glsl.has(w[2])) throw new Error("SPIR-V: an extended instruction set other than GLSL.std.450");
      const n = w[3], args = [...w.subarray(4)];
      if (n === 34) throw new Error("SPIR-V: MatrixInverse");
      if (n === 35 || n === 36 || n === 51 || n === 52) throw new Error("SPIR-V: modf/frexp");
      if (n === 47) throw new Error("SPIR-V: IMix");
      const fn = GLSL[n];
      if (!fn) throw new Error(`SPIR-V: GLSL.std.450 ${n}`);
      if (GLSL_SIGNED.has(n) || GLSL_UNSIGNED.has(n)) return define(c, id, intOp(c, ty, GLSL_SIGNED.has(n), (a) => `${fn}(${args.map(a).join(", ")})`));
      if (n === 53) return define(c, id, `ldexp(${value(c, args[0])}, ${asInt(c, args[1], true)})`);
      return define(c, id, `${fn}(${args.map((a) => value(c, a)).join(", ")})`);
    }
    case O.FunctionCall: {
      const callee = w[2], params = [...w.subarray(3)].map((a) => t.type(t.resultType.get(a)!).k === "ptr" ? `&${ref(c, a)}` : value(c, a));
      const call = `f_${callee}(${params.join(", ")})`;
      if (t.type(ty).k === "void") return line(c, `${call};`);
      return define(c, id, call);
    }
    case O.SampledImage: c.vals.set(id, `${value(c, w[2])}, ${value(c, w[3])}`); return;
    case O.Image: c.vals.set(id, value(c, w[2]).split(",")[0]); return;
    case O.ImageSampleImplicitLod: case O.ImageSampleExplicitLod: case O.ImageSampleDrefImplicitLod: case O.ImageSampleDrefExplicitLod:
    case O.ImageGather: case O.ImageDrefGather: return define(c, id, sample(c, i));
    case O.ImageFetch: case O.ImageRead: return define(c, id, fetch(c, i));
    case O.ImageWrite: {
      const img = imageOf(c, w[0]);
      if (img.dim === BUFFER_DIM) {
        const at = texelAt(c, w[1], img);
        return line(c, `{ let v = ${texel(c, w[2], img)}; ${at.map((a, k) => `${value(c, w[0])}[${a}] = v.${"xyzw"[k]};`).join(" ")} }`);
      }
      const { coords, layer } = split(c, w[1], img.arrayed);
      return line(c, `textureStore(${value(c, w[0])}, ${coords}${layer ? `, ${layer}` : ""}, ${texel(c, w[2], img)});`);
    }
    case O.ImageQuerySizeLod: case O.ImageQuerySize: {
      const img = imageOf(c, w[2]), lod = op === O.ImageQuerySizeLod ? `, ${value(c, w[3])}` : "", v = value(c, w[2]);
      if (img.dim === BUFFER_DIM) return define(c, id, as2(c, `arrayLength(&${v}) / ${texelComponents(img)}u`, ty));
      const dims = `textureDimensions(${v}${lod})`, rt = t.type(ty), n = rt.k === "vec" ? rt.n : 1;
      const parts = img.dim === 0 ? [dims] : [`${dims}.x`, `${dims}.y`, ...(img.dim === 2 ? [`${dims}.z`] : [])];
      if (img.arrayed) parts.push(`textureNumLayers(${v})`);
      return define(c, id, n === 1 ? as2(c, parts[0], ty) : `${t.wgsl(ty)}(${parts.slice(0, n).map((p) => `${t.signed(ty) ? "i32" : "u32"}(${p})`).join(", ")})`);
    }
    case O.ImageQueryLevels: return define(c, id, as2(c, `textureNumLevels(${value(c, w[2])})`, ty));
    case O.ImageQuerySamples: return define(c, id, as2(c, `textureNumSamples(${value(c, w[2])})`, ty));
    case O.ControlBarrier: return line(c, (c.t.constValues.get(w[2]) ?? 0) & 0x40 ? "storageBarrier();" : "workgroupBarrier();");
    case O.MemoryBarrier: return line(c, "storageBarrier();");
    case O.AtomicLoad: return define(c, id, `atomicLoad(&${ref(c, w[2])})`);
    case O.AtomicStore: return line(c, `atomicStore(&${ref(c, w[0])}, ${value(c, w[3])});`);
    case O.AtomicIIncrement: return define(c, id, `atomicAdd(&${ref(c, w[2])}, 1${t.signed(ty) ? "i" : "u"})`);
    case O.AtomicIDecrement: return define(c, id, `atomicSub(&${ref(c, w[2])}, 1${t.signed(ty) ? "i" : "u"})`);
    case O.AtomicCompareExchange: return define(c, id, `atomicCompareExchangeWeak(&${ref(c, w[2])}, ${value(c, w[7])}, ${value(c, w[6])}).old_value`);
    case O.DemoteToHelperInvocation: return line(c, "discard;");
    case O.Undef: return;
    default: throw new Error(`SPIR-V: opcode ${op}`);
  }
}
const as2 = (c: Ctx, expr: string, ty: number) => c.t.signed(ty) ? `i32(${expr})` : expr;
/** the image type an image or sampled image value has */
function imageOf(c: Ctx, id: number): Of<"image"> {
  const ty = c.t.resultType.get(id)!, t = c.t.type(ty);
  return c.t.kind(t.k === "sampled" ? t.image : ty, "image");
}
/** coordinates with an arrayed image's layer split off, as WGSL takes it */
function split(c: Ctx, coord: number, arrayed: number): { coords: string; layer: string | null } {
  const v = value(c, coord);
  if (!arrayed) return { coords: v, layer: null };
  const ct = c.t.kind(c.t.resultType.get(coord)!, "vec"), n = ct.n - 1, int = c.t.isInt(ct.el);
  const sw = "xyzw".slice(0, n);
  return { coords: n === 1 ? `${v}.x` : `${v}.${sw}`, layer: int ? `${v}.${"xyzw"[n]}` : `i32(round(${v}.${"xyzw"[n]}))` };
}
/** a texel to store, as the storage format's channel type takes it */
function texel(c: Ctx, id: number, img: Of<"image">): string {
  const sampled = c.t.wgsl(img.sampled), v = value(c, id), have = c.t.scalarOf(c.t.resultType.get(id)!);
  const haveName = have.k === "int" ? (have.signed ? "i32" : "u32") : "f32";
  return haveName === sampled ? v : `bitcast<vec4<${sampled}>>(${v})`;
}
interface ImageOperands { bias?: string; lod?: string; grad?: [string, string]; offset?: string; sample?: string }
function imageOperands(c: Ctx, w: Uint32Array, at: number): ImageOperands {
  if (w.length <= at) return {};
  const mask = w[at], out: ImageOperands = {};
  let k = at + 1;
  if (mask & 0x1) out.bias = value(c, w[k++]);
  if (mask & 0x2) out.lod = value(c, w[k++]);
  if (mask & 0x4) { out.grad = [value(c, w[k]), value(c, w[k + 1])]; k += 2; }
  if (mask & 0x8) out.offset = value(c, w[k++]);
  if (mask & 0x10) throw new Error("SPIR-V: a non-constant texel offset");
  if (mask & 0x20) throw new Error("SPIR-V: ConstOffsets");
  if (mask & 0x40) out.sample = value(c, w[k++]);
  return out;
}
function sample(c: Ctx, i: Inst): string {
  const w = i.w, op = i.op, img = imageOf(c, w[2]), pair = value(c, w[2]);
  const { coords, layer } = split(c, w[3], img.arrayed), L = layer ? `, ${layer}` : "";
  const dref = op === O.ImageSampleDrefImplicitLod || op === O.ImageSampleDrefExplicitLod || op === O.ImageDrefGather;
  const opsAt = dref || op === O.ImageGather ? 5 : 4, ops = imageOperands(c, w, opsAt), off = ops.offset ? `, ${ops.offset}` : "";
  const depth = img.depth === 1 || c.t.depth(w[2]);
  if (op === O.ImageGather) return `textureGather(${depth ? "" : `${value(c, w[4])}, `}${pair}, ${coords}${L}${off})`;
  if (op === O.ImageDrefGather) return `textureGatherCompare(${pair}, ${coords}${L}, ${value(c, w[4])}${off})`;
  if (dref) {
    const level = ops.lod !== undefined || op === O.ImageSampleDrefExplicitLod;
    return `textureSampleCompare${level ? "Level" : ""}(${pair}, ${coords}${L}, ${value(c, w[4])}${off})`;
  }
  let r: string;
  if (ops.grad) r = `textureSampleGrad(${pair}, ${coords}${L}, ${ops.grad[0]}, ${ops.grad[1]}${off})`;
  else if (ops.lod !== undefined) r = `textureSampleLevel(${pair}, ${coords}${L}, ${depth ? `i32(${ops.lod})` : ops.lod}${off})`;
  else if (ops.bias !== undefined) r = `textureSampleBias(${pair}, ${coords}${L}, ${ops.bias}${off})`;
  else r = `textureSample(${pair}, ${coords}${L}${off})`;
  // a depth texture samples to a scalar; SPIR-V's result is a vector with it first
  return depth ? `vec4<f32>(${r}, 0.0, 0.0, 0.0)` : r;
}
/** the array indices of the components of a texel buffer's texel `coord` */
function texelAt(c: Ctx, coord: number, img: Of<"image">): string[] {
  const n = texelComponents(img);
  return Array.from({ length: n }, (_, k) => `${n}u * u32(${value(c, coord)}) + ${k}u`);
}
function fetch(c: Ctx, i: Inst): string {
  const w = i.w, img = imageOf(c, w[2]), want = c.t.wgsl(w[0]), have = `vec4<${c.t.wgsl(img.sampled)}>`;
  if (img.dim === BUFFER_DIM) {
    // the components a texel lacks read as (0, 0, 0, 1)
    const at = texelAt(c, w[3], img), s = c.t.wgsl(img.sampled);
    const r = `${have}(${[0, 1, 2, 3].map((k) => at[k] ? `${value(c, w[2])}[${at[k]}]` : `${s}(${k === 3 ? 1 : 0})`).join(", ")})`;
    return want === have ? r : `bitcast<${want}>(${r})`;
  }
  const { coords, layer } = split(c, w[3], img.arrayed), ops = imageOperands(c, w, 4);
  const args = [value(c, w[2]), coords];
  if (layer) args.push(layer);
  if (i.op === O.ImageFetch) args.push(img.ms ? ops.sample ?? "0" : ops.lod ?? "0");
  const r = `textureLoad(${args.join(", ")})`;
  if (img.depth === 1 || c.t.depth(w[2])) return `vec4<f32>(${r}, 0.0, 0.0, 0.0)`;
  return want === have ? r : `bitcast<${want}>(${r})`;
}
