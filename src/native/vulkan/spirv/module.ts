// A SPIR-V module's instructions, with its types, decorations and the values of its constants.

export const O = {
  Undef: 1, Name: 5, MemberName: 6, Extension: 10, ExtInstImport: 11, ExtInst: 12, EntryPoint: 15, ExecutionMode: 16, Capability: 17,
  TypeVoid: 19, TypeBool: 20, TypeInt: 21, TypeFloat: 22, TypeVector: 23, TypeMatrix: 24, TypeImage: 25, TypeSampler: 26, TypeSampledImage: 27,
  TypeArray: 28, TypeRuntimeArray: 29, TypeStruct: 30, TypePointer: 32, TypeFunction: 33,
  ConstantTrue: 41, ConstantFalse: 42, Constant: 43, ConstantComposite: 44, ConstantNull: 46,
  SpecConstantTrue: 48, SpecConstantFalse: 49, SpecConstant: 50, SpecConstantComposite: 51, SpecConstantOp: 52,
  Function: 54, FunctionParameter: 55, FunctionEnd: 56, FunctionCall: 57, Variable: 59, Load: 61, Store: 62, CopyMemory: 63,
  AccessChain: 65, InBoundsAccessChain: 66, ArrayLength: 68, Decorate: 71, MemberDecorate: 72,
  VectorExtractDynamic: 77, VectorInsertDynamic: 78, VectorShuffle: 79, CompositeConstruct: 80, CompositeExtract: 81, CompositeInsert: 82,
  CopyObject: 83, Transpose: 84, SampledImage: 86, ImageSampleImplicitLod: 87, ImageSampleExplicitLod: 88, ImageSampleDrefImplicitLod: 89,
  ImageSampleDrefExplicitLod: 90, ImageFetch: 95, ImageGather: 96, ImageDrefGather: 97, ImageRead: 98, ImageWrite: 99, Image: 100,
  ImageQuerySizeLod: 103, ImageQuerySize: 104, ImageQueryLevels: 106, ImageQuerySamples: 107,
  ConvertFToU: 109, ConvertFToS: 110, ConvertSToF: 111, ConvertUToF: 112, UConvert: 113, SConvert: 114, FConvert: 115, QuantizeToF16: 116, Bitcast: 124,
  SNegate: 126, FNegate: 127, IAdd: 128, FAdd: 129, ISub: 130, FSub: 131, IMul: 132, FMul: 133, UDiv: 134, SDiv: 135, FDiv: 136, UMod: 137,
  SRem: 138, SMod: 139, FRem: 140, FMod: 141, VectorTimesScalar: 142, MatrixTimesScalar: 143, VectorTimesMatrix: 144, MatrixTimesVector: 145,
  MatrixTimesMatrix: 146, OuterProduct: 147, Dot: 148, Any: 154, All: 155, IsNan: 156, IsInf: 157,
  LogicalEqual: 164, LogicalNotEqual: 165, LogicalOr: 166, LogicalAnd: 167, LogicalNot: 168, Select: 169,
  IEqual: 170, INotEqual: 171, UGreaterThan: 172, SGreaterThan: 173, UGreaterThanEqual: 174, SGreaterThanEqual: 175, ULessThan: 176, SLessThan: 177,
  ULessThanEqual: 178, SLessThanEqual: 179, FOrdEqual: 180, FUnordEqual: 181, FOrdNotEqual: 182, FUnordNotEqual: 183, FOrdLessThan: 184,
  FUnordLessThan: 185, FOrdGreaterThan: 186, FUnordGreaterThan: 187, FOrdLessThanEqual: 188, FUnordLessThanEqual: 189, FOrdGreaterThanEqual: 190,
  FUnordGreaterThanEqual: 191, ShiftRightLogical: 194, ShiftRightArithmetic: 195, ShiftLeftLogical: 196, BitwiseOr: 197, BitwiseXor: 198,
  BitwiseAnd: 199, Not: 200, BitFieldInsert: 201, BitFieldSExtract: 202, BitFieldUExtract: 203, BitReverse: 204, BitCount: 205,
  DPdx: 207, DPdy: 208, Fwidth: 209, DPdxFine: 210, DPdyFine: 211, FwidthFine: 212, DPdxCoarse: 213, DPdyCoarse: 214, FwidthCoarse: 215,
  ControlBarrier: 224, MemoryBarrier: 225, AtomicLoad: 227, AtomicStore: 228, AtomicExchange: 229, AtomicCompareExchange: 230,
  AtomicIIncrement: 232, AtomicIDecrement: 233, AtomicIAdd: 234, AtomicISub: 235, AtomicSMin: 236, AtomicUMin: 237, AtomicSMax: 238,
  AtomicUMax: 239, AtomicAnd: 240, AtomicOr: 241, AtomicXor: 242, Phi: 245, LoopMerge: 246, SelectionMerge: 247, Label: 248, Branch: 249,
  BranchConditional: 250, Switch: 251, Kill: 252, Return: 253, ReturnValue: 254, Unreachable: 255, TerminateInvocation: 4416, DemoteToHelperInvocation: 5380,
} as const;
export const D = { SpecId: 1, Block: 2, BufferBlock: 3, RowMajor: 4, ArrayStride: 6, MatrixStride: 7, BuiltIn: 11, NoPerspective: 13, Flat: 14, Centroid: 16, Sample: 17,
  NonWritable: 24, NonReadable: 25, Location: 30, Index: 32, Binding: 33, DescriptorSet: 34, Offset: 35 } as const;
export const SC = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Workgroup: 4, Private: 6, Function: 7, PushConstant: 9, StorageBuffer: 12 } as const;

export type Type =
  | { k: "void" } | { k: "bool" } | { k: "int"; signed: boolean; width: number } | { k: "float"; width: number }
  | { k: "vec"; el: number; n: number } | { k: "mat"; col: number; n: number } | { k: "array"; el: number; len: number | null }
  | { k: "struct"; members: number[] } | { k: "ptr"; sc: number; to: number } | { k: "fn"; ret: number; params: number[] }
  | { k: "image"; sampled: number; dim: number; depth: number; arrayed: number; ms: number; usage: number; format: number }
  | { k: "sampler" } | { k: "sampled"; image: number };
export type Of<K extends Type["k"]> = Extract<Type, { k: K }>;
export interface Inst { op: number; w: Uint32Array }

export class Module {
  readonly insts: Inst[] = [];
  readonly types = new Map<number, Type>();
  readonly decorations = new Map<number, Map<number, number[]>>();
  readonly members = new Map<number, Map<number, Map<number, number[]>>>();
  /** the values of constants where an integer is needed (array lengths, indices) */
  readonly constValues = new Map<number, number>();
  /** the constants, spec constants, nulls and undefs, in order */
  readonly constants: Inst[] = [];
  readonly resultType = new Map<number, number>();
  readonly glsl = new Set<number>();
  readonly spec: Map<number, number[]>;
  constructor(words: Uint32Array, spec: Map<number, number[]>) {
    this.spec = spec;
    if (words[0] !== 0x07230203) throw new Error("not SPIR-V");
    for (let i = 5; i < words.length;) {
      const n = words[i] >>> 16, op = words[i] & 0xffff;
      if (!n) throw new Error("bad SPIR-V word count");
      this.insts.push({ op, w: words.subarray(i + 1, i + n) });
      i += n;
    }
    for (const inst of this.insts) this.scan(inst);
  }
  private scan(inst: Inst): void {
    const { op, w } = inst;
    switch (op) {
      case O.Decorate: case O.MemberDecorate: {
        const member = op === O.MemberDecorate;
        const id = w[0], d = member ? w[2] : w[1], args = [...w.subarray(member ? 3 : 2)];
        if (member) {
          const ms = this.members.get(id) ?? new Map<number, Map<number, number[]>>(); this.members.set(id, ms);
          const m = ms.get(w[1]) ?? new Map<number, number[]>(); ms.set(w[1], m); m.set(d, args);
        } else { const m = this.decorations.get(id) ?? new Map<number, number[]>(); this.decorations.set(id, m); m.set(d, args); }
        break;
      }
      case O.ExtInstImport: if (str(w, 1) === "GLSL.std.450") this.glsl.add(w[0]); break;
      case O.TypeVoid: this.types.set(w[0], { k: "void" }); break;
      case O.TypeBool: this.types.set(w[0], { k: "bool" }); break;
      case O.TypeInt: this.types.set(w[0], { k: "int", width: w[1], signed: !!w[2] }); break;
      case O.TypeFloat: this.types.set(w[0], { k: "float", width: w[1] }); break;
      case O.TypeVector: this.types.set(w[0], { k: "vec", el: w[1], n: w[2] }); break;
      case O.TypeMatrix: this.types.set(w[0], { k: "mat", col: w[1], n: w[2] }); break;
      case O.TypeImage: this.types.set(w[0], { k: "image", sampled: w[1], dim: w[2], depth: w[3], arrayed: w[4], ms: w[5], usage: w[6], format: w[7] }); break;
      case O.TypeSampler: this.types.set(w[0], { k: "sampler" }); break;
      case O.TypeSampledImage: this.types.set(w[0], { k: "sampled", image: w[1] }); break;
      case O.TypeArray: this.types.set(w[0], { k: "array", el: w[1], len: this.constValue(w[2]) }); break;
      case O.TypeRuntimeArray: this.types.set(w[0], { k: "array", el: w[1], len: null }); break;
      case O.TypeStruct: this.types.set(w[0], { k: "struct", members: [...w.subarray(1)] }); break;
      case O.TypePointer: this.types.set(w[0], { k: "ptr", sc: w[1], to: w[2] }); break;
      case O.TypeFunction: this.types.set(w[0], { k: "fn", ret: w[1], params: [...w.subarray(2)] }); break;
      case O.Constant: case O.SpecConstant: {
        const bits = this.constantBits(inst);
        this.constValues.set(w[1], this.signed(w[0]) ? bits[0] | 0 : bits[0] >>> 0);
      }
      // falls through
      case O.ConstantTrue: case O.ConstantFalse: case O.SpecConstantTrue: case O.SpecConstantFalse:
      case O.ConstantComposite: case O.SpecConstantComposite: case O.ConstantNull: case O.Undef:
        this.resultType.set(w[1], w[0]); this.constants.push(inst); break;
      case O.SpecConstantOp: throw new Error("SPIR-V: OpSpecConstantOp");
    }
  }
  dec(id: number, d: number): number[] | undefined { return this.decorations.get(id)?.get(d); }
  memberDec(id: number, m: number, d: number): number[] | undefined { return this.members.get(id)?.get(m)?.get(d); }
  type(id: number): Type { const t = this.types.get(id); if (!t) throw new Error(`SPIR-V: no type %${id}`); return t; }
  /** type `id`, which must be a `k` */
  kind<K extends Type["k"]>(id: number, k: K): Of<K> {
    const t = this.type(id);
    if (t.k !== k) throw new Error(`SPIR-V: %${id} is a ${t.k}, not a ${k}`);
    return t as Of<K>;
  }
  /** the type pointer type `id` points to */
  pointee(id: number): number { return this.kind(id, "ptr").to; }
  /** the element type of vector or array `id`, a column's of matrix `id` */
  element(id: number): number {
    const t = this.type(id);
    if (t.k === "vec" || t.k === "array") return t.el;
    if (t.k === "mat") return t.col;
    throw new Error(`SPIR-V: an element of ${t.k}`);
  }
  scalarOf(id: number): Type { const t = this.type(id); return t.k === "vec" ? this.type(t.el) : t; }
  isInt(id: number): boolean { return this.scalarOf(id).k === "int"; }
  signed(id: number): boolean { const s = this.scalarOf(id); return s.k === "int" && s.signed; }
  specValue(id: number): number[] | undefined { const sid = this.dec(id, D.SpecId); return sid ? this.spec.get(sid[0]) : undefined; }
  constValue(id: number): number { const v = this.constValues.get(id); if (v === undefined) throw new Error(`SPIR-V: %${id} is not a constant integer`); return v; }
  /** an OpConstant's or OpSpecConstant's bits, a spec constant's as the pipeline specializes it */
  constantBits({ op, w }: Inst): Uint32Array {
    const v = op === O.SpecConstant ? this.specValue(w[1]) : undefined;
    return v ? new Uint32Array(v) : w.subarray(2);
  }
}

export function str(w: Uint32Array, from: number): string {
  const bytes = new Uint8Array(w.buffer, w.byteOffset + from * 4, (w.length - from) * 4), end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}
export function hasResult(op: number): boolean {
  return !(op === O.Store || op === O.CopyMemory || op === O.ImageWrite || op === O.ControlBarrier || op === O.MemoryBarrier || op === O.AtomicStore
    || op === O.SelectionMerge || op === O.LoopMerge || op === O.Branch || op === O.BranchConditional || op === O.Switch || op === O.Return
    || op === O.ReturnValue || op === O.Kill || op === O.Unreachable || op === O.TerminateInvocation || op === O.DemoteToHelperInvocation || op === O.Label);
}
/** the ids an instruction reads */
export function operandIds(i: Inst): number[] {
  const w = i.w;
  switch (i.op) {
    case O.Store: return [w[0], w[1]];
    case O.CopyMemory: return [w[0], w[1]];
    case O.ImageWrite: return [w[0], w[1], w[2], ...(w.length > 3 ? w.subarray(4) : [])];
    case O.AtomicStore: return [w[0], w[3]];
    case O.ControlBarrier: case O.MemoryBarrier: return [];
    case O.Phi: return [...w.subarray(2)].filter((_, k) => k % 2 === 0);
    case O.ExtInst: return [...w.subarray(4)];
    case O.CompositeExtract: return [w[2]];
    case O.CompositeInsert: return [w[2], w[3]];
    case O.VectorShuffle: return [w[2], w[3]];
    case O.FunctionCall: return [...w.subarray(3)];
    case O.ImageSampleImplicitLod: case O.ImageSampleExplicitLod: case O.ImageFetch: case O.ImageRead:
      return [w[2], w[3], ...(w.length > 4 ? w.subarray(5) : [])];
    case O.ImageSampleDrefImplicitLod: case O.ImageSampleDrefExplicitLod: case O.ImageGather: case O.ImageDrefGather:
      return [w[2], w[3], w[4], ...(w.length > 5 ? w.subarray(6) : [])];
    case O.AccessChain: case O.InBoundsAccessChain: return [...w.subarray(2)];
    case O.Variable: return w.length > 3 ? [w[3]] : [];
    case O.ArrayLength: return [w[2]];
    default: return hasResult(i.op) ? [...w.subarray(2)] : [...w];
  }
}
