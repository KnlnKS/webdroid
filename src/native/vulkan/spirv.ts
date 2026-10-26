// SPIR-V to WGSL for one entry point of a shader module. Types, constants and resources become WGSL
// declarations; functions keep their structure, each result a `let` (or a function-scope `var` where
// a later block uses it, as OpPhi results are), and structured control flow becomes if, switch and
// loop statements. Interface variables are private variables an entry function fills from its
// parameters, calls the SPIR-V entry with, and returns. A vertex position's Y can be negated
// (webdroid_flip_y) for a viewport of positive height, whose +Y points down where WebGPU's points up.
// Push constants are a read-only storage buffer at PUSH_BINDING of the group the pipeline layout gives
// them, laid out as std430 is.

export type Stage = "vertex" | "fragment" | "compute";
export interface Resource { set: number; binding: number; kind: "buffer" | "texture" | "sampler" | "combined" | "storage" | "push" }
/** the WGSL binding of push constants: past those of Vulkan bindings below 499 (2b and 2b + 1), under maxBindingsPerBindGroup */
export const PUSH_BINDING = 999;
export interface Translation { code: string; entry: string; resources: Resource[] }

// opcodes
const O = {
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
const D = { SpecId: 1, Block: 2, BufferBlock: 3, RowMajor: 4, ArrayStride: 6, MatrixStride: 7, BuiltIn: 11, NoPerspective: 13, Flat: 14, Centroid: 16, Sample: 17,
  NonWritable: 24, NonReadable: 25, Location: 30, Index: 32, Binding: 33, DescriptorSet: 34, Offset: 35 } as const;
const SC = { UniformConstant: 0, Input: 1, Uniform: 2, Output: 3, Workgroup: 4, Private: 6, Function: 7, PushConstant: 9, StorageBuffer: 12 } as const;
const BUILTIN: Record<number, [string, string]> = {
  0: ["position", "vec4<f32>"], 15: ["position", "vec4<f32>"], 17: ["front_facing", "bool"], 18: ["sample_index", "u32"], 20: ["sample_mask", "u32"],
  22: ["frag_depth", "f32"], 24: ["num_workgroups", "vec3<u32>"], 26: ["workgroup_id", "vec3<u32>"], 27: ["local_invocation_id", "vec3<u32>"],
  28: ["global_invocation_id", "vec3<u32>"], 29: ["local_invocation_index", "u32"], 42: ["vertex_index", "u32"], 43: ["instance_index", "u32"],
  3: ["clip_distances", ""], 36: ["subgroup_size", "u32"], 41: ["subgroup_invocation_id", "u32"],
};
const POINT_SIZE = 1, CULL_DISTANCE = 4;
const TEXEL_FORMAT: Record<number, string> = {
  1: "rgba32float", 2: "rgba16float", 3: "r32float", 4: "rgba8unorm", 5: "rgba8snorm", 6: "rg32float", 7: "rg16float", 15: "r16float",
  21: "rgba32sint", 22: "rgba16sint", 23: "rgba8sint", 24: "r32sint", 25: "rg32sint", 30: "rgba32uint", 31: "rgba16uint", 32: "rgba8uint", 33: "r32uint", 35: "rg32uint",
  9: "r8unorm", 13: "rg8unorm", 27: "rg8sint", 29: "r8sint", 37: "rg8uint", 39: "r8uint", 11: "rgb10a2unorm", 34: "rgb10a2uint", 8: "rg11b10ufloat",
};

type Type =
  | { k: "void" } | { k: "bool" } | { k: "int"; signed: boolean; width: number } | { k: "float"; width: number }
  | { k: "vec"; el: number; n: number } | { k: "mat"; col: number; n: number } | { k: "array"; el: number; len: number | null }
  | { k: "struct"; members: number[] } | { k: "ptr"; sc: number; to: number } | { k: "fn"; ret: number; params: number[] }
  | { k: "image"; sampled: number; dim: number; depth: number; arrayed: number; ms: number; usage: number; format: number }
  | { k: "sampler" } | { k: "sampled"; image: number };
interface Inst { op: number; w: Uint32Array; at: number }
/** a member's matrices as an array (`text`, `size` bytes) of k vectors: rows of a row-major one, else columns; `wrap` where
 *  each is a struct's v to take the stride */
interface MatLayout { rowMajor: boolean; wrap: boolean; C: number; R: number; k: number; el: string; text: string; size: number; align: number }
const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;

class Translator {
  readonly insts: Inst[] = [];
  readonly types = new Map<number, Type>();
  readonly decorations = new Map<number, Map<number, number[]>>();
  readonly members = new Map<number, Map<number, Map<number, number[]>>>();
  /** constants' WGSL expressions, and their values where an integer is needed (array lengths, indices) */
  readonly consts = new Map<number, string>(); readonly constValues = new Map<number, number>();
  readonly resultType = new Map<number, number>();
  readonly glsl = new Set<number>();
  readonly out: string[] = [];
  readonly enables = new Set<string>();
  readonly structNames = new Map<number, string>();
  /** the types of variables an atomic operation uses: declared atomic */
  readonly atomics = new Set<number>();
  /** image and sampler variables a comparison samples with, and the variable each loaded value comes from */
  readonly depthVars = new Set<number>();
  readonly sources = new Map<number, number>();
  depth(id: number): boolean { return this.depthVars.has(this.sources.get(id) ?? -1); }
  readonly spec: Map<number, number[]>;
  constructor(words: Uint32Array, spec: Map<number, number[]>) {
    this.spec = spec;
    if (words[0] !== 0x07230203) throw new Error("not SPIR-V");
    for (let i = 5; i < words.length;) {
      const n = words[i] >>> 16, op = words[i] & 0xffff;
      if (!n) throw new Error("bad SPIR-V word count");
      this.insts.push({ op, w: words.subarray(i + 1, i + n), at: this.insts.length });
      i += n;
    }
  }
  dec(id: number, d: number): number[] | undefined { return this.decorations.get(id)?.get(d); }
  memberDec(id: number, m: number, d: number): number[] | undefined { return this.members.get(id)?.get(m)?.get(d); }
  type(id: number): Type { const t = this.types.get(id); if (!t) throw new Error(`SPIR-V: no type %${id}`); return t; }
  wgsl(id: number): string {
    const t = this.type(id);
    switch (t.k) {
      case "void": return "void";
      case "bool": return "bool";
      case "int": if (t.width !== 32) throw new Error(`SPIR-V: ${t.width}-bit integers`); return t.signed ? "i32" : "u32";
      case "float": if (t.width === 16) { this.enables.add("f16"); return "f16"; } if (t.width !== 32) throw new Error("SPIR-V: 64-bit floats"); return "f32";
      case "vec": return `vec${t.n}<${this.wgsl(t.el)}>`;
      case "mat": { const c = this.type(t.col) as { el: number; n: number }; return `mat${t.n}x${c.n}<${this.wgsl(c.el)}>`; }
      case "array": {
        const padded = this.padded(id) !== undefined;
        if (padded) this.paddings.add(id);
        const el = padded ? `P${id}` : this.atomics.has(id) ? `atomic<${this.wgsl(t.el)}>` : this.wgsl(t.el);
        return t.len === null ? `array<${el}>` : `array<${el}, ${t.len}>`;
      }
      case "struct": return this.structNames.get(id)!;
      case "sampler": return "sampler";
      case "image": return this.imageType(id, t);
      case "sampled": return this.wgsl(t.image);
      default: throw new Error(`SPIR-V: no WGSL type for ${t.k}`);
    }
  }
  imageType(id: number, t: Extract<Type, { k: "image" }>, depth = false): string {
    const dim = ["1d", "2d", "3d", "cube"][t.dim];
    if (!dim) throw new Error(`SPIR-V: image dimension ${t.dim}`);
    const arr = t.arrayed ? "_array" : "";
    if (t.usage === 2) {
      const format = TEXEL_FORMAT[t.format];
      if (!format) throw new Error(`SPIR-V: storage image format ${t.format}`);
      return `texture_storage_${dim}${arr}<${format}, ${this.storageAccess.get(id) ?? "read_write"}>`;
    }
    if (t.depth === 1 || depth) return t.ms ? "texture_depth_multisampled_2d" : `texture_depth_${dim}${arr}`;
    const el = this.wgsl(t.sampled);
    return t.ms ? `texture_multisampled_2d<${el}>` : `texture_${dim}${arr}<${el}>`;
  }
  readonly storageAccess = new Map<number, string>();
  /** the arrays declared with their elements wrapped */
  readonly paddings = new Set<number>();
  readonly mats = new Map<string, MatLayout | null>();
  /** the ArrayStride of an array whose stride WGSL's own is not (std140's of scalars, vectors and structs), its elements each
   *  wrapped as P<id>'s v; an array of matrices takes the layout of the member holding it (matLayout) */
  padded(id: number): number | undefined {
    const t = this.type(id);
    if (t.k !== "array") return undefined;
    let el = this.type(t.el);
    while (el.k === "array") el = this.type(el.el);
    const stride = this.dec(id, D.ArrayStride)?.[0], l = layout(this, t.el);
    return el.k !== "mat" && stride !== undefined && stride !== roundUp(l.size, l.align) ? stride : undefined;
  }
  /** a composite of type `ty` from its parts, a padded array's each wrapped */
  construct(ty: number, parts: string[]): string {
    return `${this.wgsl(ty)}(${(this.padded(ty) !== undefined ? parts.map((p) => `P${ty}(${p})`) : parts).join(", ")})`;
  }
  /** how struct `s`'s member `i`, a matrix or an array of them, lays out matrices WGSL's matCxR does not: row-major or
   *  with a MatrixStride other than its columns' own. Such a member is an array of its rows or columns, each wrapped
   *  as Q<s>_<i>'s v where the stride is not the vector's own; null for a member WGSL lays out as SPIR-V does. */
  matLayout(s: number, i: number): MatLayout | null {
    const key = `${s}_${i}`;
    if (this.mats.has(key)) return this.mats.get(key)!;
    const arrays: number[] = [];
    let ty = (this.type(s) as { members: number[] }).members[i], mt = this.type(ty);
    for (; mt.k === "array"; mt = this.type(ty = mt.el)) arrays.push(ty);
    let m: MatLayout | null = null;
    if (mt.k === "mat") {
      const col = this.type(mt.col) as { el: number; n: number }, c = layout(this, mt.col), natural = roundUp(c.size, c.align);
      const rowMajor = !!this.memberDec(s, i, D.RowMajor), stride = this.memberDec(s, i, D.MatrixStride)?.[0] ?? natural;
      if (rowMajor || stride !== natural) {
        const C = mt.n, R = col.n, n = rowMajor ? C : R, e = c.size / R, align = e * (n === 3 ? 4 : n), el = this.wgsl(col.el), vec = `vec${n}<${el}>`;
        if (stride % align) throw new Error(`SPIR-V: matrix stride ${stride}`);
        const wrap = stride !== roundUp(e * n, align), k = rowMajor ? R : C;
        if (wrap) this.out.push(`struct Q${key} {\n  @size(${stride}) v: ${vec},\n}`);
        m = { rowMajor, wrap, C, R, k, el, text: `array<${wrap ? `Q${key}` : vec}, ${k}>`, size: k * stride, align };
        for (let d = arrays.length - 1; d >= 0; d--) {
          const decorated = this.dec(arrays[d], D.ArrayStride)?.[0], len = (this.type(arrays[d]) as { len: number | null }).len;
          if (decorated !== undefined && decorated !== m.size) throw new Error(`SPIR-V: array stride ${decorated} of ${m.size}-byte matrices`);
          m.text = len === null ? `array<${m.text}>` : `array<${m.text}, ${len}>`;
          m.size *= len ?? 1;
        }
      }
    }
    this.mats.set(key, m);
    return m;
  }
  /** WGSL's size and alignment of struct `s`'s member `i` as it declares it */
  memberLayout(s: number, i: number): { size: number; align: number } {
    const m = this.matLayout(s, i);
    return m ? { size: m.size, align: m.align } : layout(this, (this.type(s) as { members: number[] }).members[i]);
  }
  scalarOf(id: number): Type { const t = this.type(id); return t.k === "vec" ? this.type(t.el) : t; }
  isInt(id: number): boolean { return this.scalarOf(id).k === "int"; }
  signed(id: number): boolean { const s = this.scalarOf(id); return s.k === "int" && s.signed; }
  /** the type of `id` with integer scalars of signedness `signed` */
  intType(id: number, signed: boolean): string {
    const t = this.type(id);
    if (t.k === "vec") return `vec${t.n}<${signed ? "i32" : "u32"}>`;
    return signed ? "i32" : "u32";
  }
  zero(id: number): string {
    const t = this.type(id);
    if (t.k === "struct" || t.k === "array" || t.k === "mat" || t.k === "vec") return `${this.wgsl(id)}()`;
    if (t.k === "bool") return "false";
    if (t.k === "int") return t.signed ? "0i" : "0u";
    if (t.k === "float") return t.width === 16 ? "0h" : "0f";
    throw new Error(`SPIR-V: a zero of ${t.k}`);
  }
  literal(typeId: number, w: Uint32Array): string {
    const t = this.type(typeId);
    if (t.k === "int") return t.signed ? (w[0] === 0x80000000 ? "i32(-2147483647 - 1)" : `${w[0] | 0}i`) : `${w[0] >>> 0}u`;
    if (t.k === "float" && t.width === 32) {
      const f = new Float32Array(new Uint32Array([w[0]]).buffer)[0];
      if (!Number.isFinite(f)) return `bitcast<f32>(${w[0] >>> 0}u)`;
      return `${floatText(f)}f`;
    }
    if (t.k === "float" && t.width === 16) return `${floatText(halfOf(w[0] & 0xffff))}h`;
    throw new Error(`SPIR-V: a constant of ${t.k}`);
  }

  // ── module-level declarations
  scan(): void {
    for (const { op, w } of this.insts) {
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
        case O.TypeStruct: this.types.set(w[0], { k: "struct", members: [...w.subarray(1)] }); this.structNames.set(w[0], `S${w[0]}`); break;
        case O.TypePointer: this.types.set(w[0], { k: "ptr", sc: w[1], to: w[2] }); break;
        case O.TypeFunction: this.types.set(w[0], { k: "fn", ret: w[1], params: [...w.subarray(2)] }); break;
        case O.ConstantTrue: case O.ConstantFalse: this.resultType.set(w[1], w[0]); this.consts.set(w[1], op === O.ConstantTrue ? "true" : "false"); break;
        case O.SpecConstantTrue: case O.SpecConstantFalse: {
          const v = this.specValue(w[1]), on = v ? !!v[0] : op === O.SpecConstantTrue;
          this.resultType.set(w[1], w[0]); this.consts.set(w[1], on ? "true" : "false"); break;
        }
        case O.Constant: case O.SpecConstant: {
          const v = op === O.SpecConstant ? this.specValue(w[1]) : undefined, bits = v ? new Uint32Array(v) : w.subarray(2);
          this.resultType.set(w[1], w[0]); this.consts.set(w[1], this.literal(w[0], bits)); this.constValues.set(w[1], this.signed(w[0]) ? bits[0] | 0 : bits[0] >>> 0);
          break;
        }
        case O.ConstantComposite: case O.SpecConstantComposite:
          this.resultType.set(w[1], w[0]); this.consts.set(w[1], this.construct(w[0], [...w.subarray(2)].map((c) => this.consts.get(c)!))); break;
        case O.ConstantNull: this.resultType.set(w[1], w[0]); this.consts.set(w[1], this.zero(w[0])); break;
        case O.Undef: this.resultType.set(w[1], w[0]); this.consts.set(w[1], this.zero(w[0])); break;
        case O.SpecConstantOp: throw new Error("SPIR-V: OpSpecConstantOp");
      }
    }
  }
  specValue(id: number): number[] | undefined { const sid = this.dec(id, D.SpecId); return sid ? this.spec.get(sid[0]) : undefined; }
  constValue(id: number): number { const v = this.constValues.get(id); if (v === undefined) throw new Error(`SPIR-V: %${id} is not a constant integer`); return v; }

  /** struct declarations, members laid out at their decorated offsets */
  structs(used: Set<number>): void {
    const done = new Set<number>();
    const emit = (id: number) => {
      if (done.has(id)) return;
      done.add(id);
      const t = this.type(id);
      if (t.k === "array") emit(t.el);
      if (t.k !== "struct") return;
      t.members.forEach(emit);
      const lines = t.members.map((m, i) => {
        const b = this.memberDec(id, i, D.BuiltIn);
        if (b) return null;
        const ty = this.matLayout(id, i)?.text ?? (this.atomics.has(-id * 1000 - i) ? `atomic<${this.wgsl(m)}>` : this.wgsl(m));
        const off = this.memberDec(id, i, D.Offset)?.[0], next = this.memberDec(id, i + 1, D.Offset)?.[0];
        const natural = this.memberLayout(id, i);
        let attrs = "";
        if (off !== undefined && next !== undefined && next - off !== natural.size) attrs += `@size(${next - off}) `;
        if (off !== undefined && off % natural.align !== 0) throw new Error(`SPIR-V: member offset ${off} under its alignment`);
        return `  ${attrs}m${i}: ${ty},`;
      }).filter((l) => l !== null);
      if (!lines.length) lines.push("  m_unused: u32,");
      this.out.push(`struct S${id} {\n${lines.join("\n")}\n}`);
    };
    for (const id of used) emit(id);
    for (const id of this.paddings) {
      const el = (this.type(id) as { el: number }).el;
      this.out.push(`struct P${id} {\n  @size(${this.padded(id)}) v: ${this.wgsl(el)},\n}`);
    }
  }
}

/** a float as WGSL writes it, exactly */
function floatText(f: number): string {
  let s = String(f);
  if (!s.includes(".") && !s.includes("e")) s += ".0";
  return s;
}
function halfOf(h: number): number {
  const e = (h >> 10) & 0x1f, m = h & 0x3ff, sign = h & 0x8000 ? -1 : 1;
  return sign * (e === 0 ? m * 2 ** -24 : 2 ** (e - 15) * (1 + m / 1024));
}
function str(w: Uint32Array, from: number): string {
  const bytes = new Uint8Array(w.buffer, w.byteOffset + from * 4, (w.length - from) * 4), end = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
}
/** WGSL's size and alignment of a type */
function layout(t: Translator, id: number): { size: number; align: number } {
  const ty = t.type(id);
  switch (ty.k) {
    case "bool": case "int": return { size: 4, align: 4 };
    case "float": return ty.width === 16 ? { size: 2, align: 2 } : { size: 4, align: 4 };
    case "vec": { const e = layout(t, ty.el); const n = ty.n === 3 ? 4 : ty.n; return { size: e.size * ty.n, align: e.size * n }; }
    case "mat": { const c = layout(t, ty.col); return { size: roundUp(c.size, c.align) * ty.n, align: c.align }; }
    case "array": {
      const e = layout(t, ty.el), stride = t.padded(id) ?? roundUp(e.size, e.align);
      return { size: stride * (ty.len ?? 1), align: e.align };
    }
    case "struct": {
      let size = 0, align = 1;
      ty.members.forEach((_, i) => {
        const l = t.memberLayout(id, i), off = t.memberDec(id, i, D.Offset)?.[0] ?? roundUp(size, l.align);
        size = off + l.size; align = Math.max(align, l.align);
      });
      return { size: roundUp(size, align), align };
    }
    default: return { size: 4, align: 4 };
  }
}

interface Block { label: number; insts: Inst[]; merge?: Inst; term: Inst }
interface Fn { id: number; ret: number; params: number[]; blocks: Map<number, Block>; order: number[] }

export function translate(words: Uint32Array, entry: string, stage: Stage, spec: Map<number, number[]>, pushGroup: number): Translation {
  const t = new Translator(words, spec);
  t.scan();
  const MODEL: Record<Stage, number> = { vertex: 0, fragment: 4, compute: 5 };
  const ep = t.insts.find((i) => i.op === O.EntryPoint && i.w[0] === MODEL[stage] && str(i.w, 2) === entry);
  if (!ep) throw new Error(`SPIR-V: no ${stage} entry point ${entry}`);
  const epFn = ep.w[1];

  // functions and their blocks
  const fns = new Map<number, Fn>();
  const globals: Inst[] = [];
  let fn: Fn | null = null, block: Block | null = null;
  for (const inst of t.insts) {
    const { op, w } = inst;
    if (op === O.Function) { fn = { id: w[1], ret: w[0], params: [], blocks: new Map(), order: [] }; fns.set(w[1], fn); t.resultType.set(w[1], w[0]); continue; }
    if (!fn) { if (op === O.Variable) { globals.push(inst); t.resultType.set(w[1], w[0]); } continue; }
    if (op === O.FunctionEnd) { fn = null; continue; }
    if (op === O.FunctionParameter) { fn.params.push(w[1]); t.resultType.set(w[1], w[0]); continue; }
    if (op === O.Label) { block = { label: w[0], insts: [], term: inst }; fn.blocks.set(w[0], block); fn.order.push(w[0]); continue; }
    if (!block) continue;
    if (op === O.SelectionMerge || op === O.LoopMerge) block.merge = inst;
    else if (op === O.Branch || op === O.BranchConditional || op === O.Switch || op === O.Return || op === O.ReturnValue || op === O.Kill || op === O.Unreachable || op === O.TerminateInvocation) block.term = inst;
    else block.insts.push(inst);
    if (hasResult(op)) t.resultType.set(w[1], w[0]);
  }
  // the functions the entry point reaches
  const reached = new Set<number>(), visit = (id: number) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) if (i.op === O.FunctionCall) visit(i.w[2]);
  };
  visit(epFn);
  // globals the reached functions use, and what the uses say of them: atomics, depth comparisons, storage access
  const usedGlobals = new Set<number>(), globalIds = new Set(globals.map((g) => g.w[1]));
  const roots = new Map<number, number>();                                       // pointer → the variable it points into
  for (const id of reached) for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) {
    for (const a of operandIds(i)) if (globalIds.has(a)) usedGlobals.add(a);
    if (i.op === O.AccessChain || i.op === O.InBoundsAccessChain) roots.set(i.w[1], roots.get(i.w[2]) ?? i.w[2]);
    if (i.op === O.Load) t.sources.set(i.w[1], roots.get(i.w[2]) ?? i.w[2]);
    if (i.op === O.SampledImage || i.op === O.Image || i.op === O.CopyObject) t.sources.set(i.w[1], t.sources.get(i.w[2]) ?? -1);
  }
  for (const id of ep.w.subarray(3 + Math.ceil((str(ep.w, 2).length + 1) / 4))) usedGlobals.add(id);
  for (const id of reached) for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) {
    if (i.op === O.ImageSampleDrefImplicitLod || i.op === O.ImageSampleDrefExplicitLod || i.op === O.ImageDrefGather) {
      const si = b.insts.find((s) => s.op === O.SampledImage && s.w[1] === i.w[2]);
      t.depthVars.add(t.sources.get(i.w[2]) ?? -1);
      if (si) t.depthVars.add(t.sources.get(si.w[3]) ?? -1);
    }
    if (i.op >= O.AtomicLoad && i.op <= O.AtomicXor) markAtomic(t, i.op === O.AtomicStore ? i.w[0] : i.w[2], fns);
  }

  const resources: Resource[] = [];
  const decls: string[] = [];
  const inputs: { id: number; type: number }[] = [], outputs: { id: number; type: number }[] = [];
  for (const g of globals) {
    const id = g.w[1], ptr = t.type(g.w[0]) as { sc: number; to: number }, sc = g.w[2];
    if (!usedGlobals.has(id)) continue;
    const name = `x_${id}`, ty = ptr.to;
    const set = t.dec(id, D.DescriptorSet)?.[0] ?? 0, binding = t.dec(id, D.Binding)?.[0] ?? 0;
    const at = `@group(${set}) @binding(${2 * binding})`;
    if (sc === SC.Uniform || sc === SC.StorageBuffer) {
      const bufferBlock = !!t.dec(ty, D.BufferBlock);
      const readOnly = !!t.dec(id, D.NonWritable) || (t.type(ty) as { members: number[] }).members.every((_, i) => t.memberDec(ty, i, D.NonWritable));
      const space = sc === SC.StorageBuffer || bufferBlock ? `storage, ${readOnly ? "read" : "read_write"}` : "uniform";
      decls.push(`${at} var<${space}> ${name}: ${t.wgsl(ty)};`);
      resources.push({ set, binding, kind: "buffer" });
    } else if (sc === SC.UniformConstant) {
      const rt = t.type(ty);
      if (rt.k === "sampled") {
        const depth = t.depthVars.has(id);
        decls.push(`${at} var ${name}: ${t.imageType(rt.image, t.type(rt.image) as Extract<Type, { k: "image" }>, depth)};`, `@group(${set}) @binding(${2 * binding + 1}) var ${name}_s: ${depth ? "sampler_comparison" : "sampler"};`);
        resources.push({ set, binding, kind: "combined" });
      } else {
        if (rt.k === "image" && rt.usage === 2) t.storageAccess.set(ty, t.dec(id, D.NonReadable) ? "write" : t.dec(id, D.NonWritable) ? "read" : "read_write");
        const depth = t.depthVars.has(id);
        decls.push(`${at} var ${name}: ${rt.k === "image" ? t.imageType(ty, rt, depth) : depth ? "sampler_comparison" : t.wgsl(ty)};`);
        resources.push({ set, binding, kind: rt.k === "sampler" ? "sampler" : rt.k === "image" && rt.usage === 2 ? "storage" : "texture" });
      }
    } else if (sc === SC.Input || sc === SC.Output) {
      (sc === SC.Input ? inputs : outputs).push({ id, type: ty });
      decls.push(`var<private> ${name}: ${t.wgsl(ty)}${g.w[3] ? ` = ${t.consts.get(g.w[3])}` : ""};`);
    } else if (sc === SC.PushConstant) {
      decls.push(`@group(${pushGroup}) @binding(${PUSH_BINDING}) var<storage, read> ${name}: ${t.wgsl(ty)};`);
      resources.push({ set: pushGroup, binding: PUSH_BINDING, kind: "push" });
    } else if (sc === SC.Private) decls.push(`var<private> ${name}: ${t.wgsl(ty)}${g.w[3] ? ` = ${t.consts.get(g.w[3])}` : ""};`);
    else if (sc === SC.Workgroup) decls.push(`var<workgroup> ${name}: ${t.wgsl(ty)};`);
    else throw new Error(`SPIR-V: storage class ${sc}`);
  }
  // structs: those of every type a declaration or function names
  const structIds = new Set<number>();
  for (const [id, ty] of t.types) if (ty.k === "struct") structIds.add(id);
  const body: string[] = [];
  for (const id of [...reached].reverse()) body.push(emitFunction(t, fns.get(id)!));
  t.structs(structIds);
  body.push(entryWrapper(t, stage, epFn, inputs, outputs));

  const head = [...t.enables].map((e) => `enable ${e};`);
  head.push("diagnostic(off, derivative_uniformity);");
  if (stage === "vertex") head.push("override webdroid_flip_y: bool = false;");
  return { code: [...head, ...t.out, ...decls, ...body].join("\n"), entry: "webdroid_main", resources };
}

function hasResult(op: number): boolean {
  return !(op === O.Store || op === O.CopyMemory || op === O.ImageWrite || op === O.ControlBarrier || op === O.MemoryBarrier || op === O.AtomicStore
    || op === O.SelectionMerge || op === O.LoopMerge || op === O.Branch || op === O.BranchConditional || op === O.Switch || op === O.Return
    || op === O.ReturnValue || op === O.Kill || op === O.Unreachable || op === O.TerminateInvocation || op === O.DemoteToHelperInvocation || op === O.Label);
}
/** the ids an instruction reads */
function operandIds(i: Inst): number[] {
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
function markAtomic(t: Translator, ptr: number, fns: Map<number, Fn>): void {
  // the access chain into the variable decides what is atomic: a struct member or an array's elements
  for (const f of fns.values()) for (const b of f.blocks.values()) for (const i of b.insts) {
    if ((i.op !== O.AccessChain && i.op !== O.InBoundsAccessChain) || i.w[1] !== ptr) continue;
    let ty = (t.type(t.resultType.get(i.w[2])!) as { to: number }).to;
    const idx = [...i.w.subarray(3)];
    for (let k = 0; k < idx.length; k++) {
      const tt = t.type(ty);
      if (k === idx.length - 1) {
        if (tt.k === "struct") t.atomics.add(-ty * 1000 - t.constValue(idx[k]));
        else if (tt.k === "array") t.atomics.add(ty);
        return;
      }
      ty = tt.k === "struct" ? tt.members[t.constValue(idx[k])] : (tt as { el: number }).el;
    }
    return;
  }
  throw new Error("SPIR-V: an atomic on a variable itself");
}

// ── functions
interface Ctx { t: Translator; fn: Fn; lines: string[]; depth: number; vals: Map<number, string>; refs: Map<number, string>; mats: Map<number, MatRef>; hoisted: Set<number>; phis: Map<number, Inst[]>; done: Set<number> }
/** a pointer into a member's matrices (matLayout): to the matrix or array of them of type `type` that `text` holds, or to column
 *  `col` of a row-major one */
interface MatRef { text: string; type: number; m: MatLayout; col?: string }
type Construct = { kind: "loop"; header: number; merge: number; cont: number } | { kind: "switch"; merge: number } | { kind: "if"; merge: number };

function emitFunction(t: Translator, f: Fn): string {
  const ctx: Ctx = { t, fn: f, lines: [], depth: 1, vals: new Map(), refs: new Map(), mats: new Map(), hoisted: new Set(), phis: new Map(), done: new Set() };
  const params = f.params.map((p) => {
    const ty = t.type(t.resultType.get(p)!);
    if (ty.k === "ptr") { ctx.refs.set(p, `(*x_${p})`); return `x_${p}: ${pointer(ty.sc, t.wgsl(ty.to))}`; }
    ctx.vals.set(p, `x_${p}`);
    return `x_${p}: ${t.wgsl(t.resultType.get(p)!)}`;
  });
  // the block of each definition and the blocks of its uses: a value used outside its block is a function-scope var
  const defBlock = new Map<number, number>(), useBlocks = new Map<number, Set<number>>(), pointerOps = new Map<number, number[]>();
  for (const label of f.order) {
    const b = f.blocks.get(label)!;
    for (const i of b.insts) {
      if (hasResult(i.op)) defBlock.set(i.w[1], label);
      if (i.op === O.AccessChain || i.op === O.InBoundsAccessChain) pointerOps.set(i.w[1], [...i.w.subarray(2)]);
      if (i.op === O.Phi) {
        ctx.phis.set(label, [...(ctx.phis.get(label) ?? []), i]);
        for (let k = 2; k < i.w.length; k += 2) addUse(useBlocks, i.w[k], i.w[k + 1]);
        continue;
      }
      for (const a of operandIds(i)) addUse(useBlocks, a, label);
    }
    for (const a of termOperands(b.term)) addUse(useBlocks, a, label);
  }
  // a pointer's index operands are used wherever the pointer is
  const spread = (id: number, label: number, seen = new Set<number>()) => {
    if (seen.has(id)) return; seen.add(id);
    for (const a of pointerOps.get(id) ?? []) { addUse(useBlocks, a, label); spread(a, label, seen); }
  };
  for (const [id, blocks] of [...useBlocks]) for (const l of [...blocks]) spread(id, l);
  const decls: string[] = [];
  for (const [id, label] of defBlock) {
    const inst = findInst(f, id);
    if (!inst || inst.op === O.Variable || inst.op === O.AccessChain || inst.op === O.InBoundsAccessChain || inst.op === O.SampledImage || inst.op === O.Image) continue;
    const ty = t.type(t.resultType.get(id)!);
    if (ty.k === "ptr" || ty.k === "void" || ty.k === "image" || ty.k === "sampler" || ty.k === "sampled") continue;
    const uses = useBlocks.get(id);
    if (inst.op === O.Phi || (uses && [...uses].some((u) => u !== label))) {
      ctx.hoisted.add(id);
      decls.push(`  var x_${id}: ${t.wgsl(t.resultType.get(id)!)};`);
    }
  }
  // function-scope variables
  for (const label of f.order) for (const i of f.blocks.get(label)!.insts) if (i.op === O.Variable) {
    const ty = (t.type(i.w[0]) as { to: number }).to;
    decls.push(`  var x_${i.w[1]}: ${t.wgsl(ty)}${i.w.length > 3 ? ` = ${value(ctx, i.w[3])}` : ""};`);
    ctx.refs.set(i.w[1], `x_${i.w[1]}`);
  }
  ctx.lines.push(...decls);
  emitRegion(ctx, f.order[0], [], new Set());
  const ret = t.type(f.ret).k === "void" ? "" : ` -> ${t.wgsl(f.ret)}`;
  return `fn f_${f.id}(${params.join(", ")})${ret} {\n${ctx.lines.join("\n")}\n}`;
}
function addUse(m: Map<number, Set<number>>, id: number, label: number): void { let s = m.get(id); if (!s) m.set(id, s = new Set()); s.add(label); }
function findInst(f: Fn, id: number): Inst | undefined {
  for (const b of f.blocks.values()) for (const i of b.insts) if (hasResult(i.op) && i.w[1] === id) return i;
  return undefined;
}
function termOperands(i: Inst): number[] {
  if (i.op === O.BranchConditional) return [i.w[0]];
  if (i.op === O.Switch) return [i.w[0]];
  if (i.op === O.ReturnValue) return [i.w[0]];
  return [];
}
/** a WGSL pointer type into storage class `sc` */
const pointer = (sc: number, to: string) => sc === SC.Function ? `ptr<function, ${to}>` : sc === SC.Private || sc === SC.Input || sc === SC.Output ? `ptr<private, ${to}>`
  : sc === SC.Workgroup ? `ptr<workgroup, ${to}>` : sc === SC.StorageBuffer ? `ptr<storage, ${to}, read_write>` : sc === SC.PushConstant ? `ptr<storage, ${to}, read>` : `ptr<uniform, ${to}>`;
const line = (c: Ctx, s: string) => { c.lines.push("  ".repeat(c.depth) + s); };

function value(c: Ctx, id: number): string {
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
function as(c: Ctx, id: number, want: number): string {
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

function emitRegion(c: Ctx, start: number, stack: Construct[], stop: Set<number>): void {
  let label: number | null = start;
  while (label !== null && !stop.has(label)) {
    if (c.done.has(label)) throw new Error(`SPIR-V: block %${label} reached twice`);
    c.done.add(label);
    const b: Block = c.fn.blocks.get(label)!;
    for (const i of b.insts) if (i.op !== O.Phi) emitInst(c, i);
    label = emitTerminator(c, b, stack, stop);
  }
}
/** a branch from `from` to `to`: the phi assignments it makes, then a break or continue where it leaves the construct */
function branch(c: Ctx, from: number, to: number, stack: Construct[]): { next: number | null } {
  for (const phi of c.phis.get(to) ?? []) {
    for (let k = 2; k < phi.w.length; k += 2) if (phi.w[k + 1] === from) line(c, `x_${phi.w[1]} = ${value(c, phi.w[k])};`);
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const s = stack[k];
    if (s.kind === "loop" && to === s.cont) { line(c, "continue;"); return { next: null }; }
    if (s.kind === "loop" && to === s.header) return { next: null };
    if (s.merge === to) {
      if (s.kind === "if") return { next: null };
      // WGSL's break leaves the innermost loop or switch
      if (stack.slice(k + 1).some((x) => x.kind !== "if")) throw new Error("SPIR-V: a break out of more than one loop or switch");
      line(c, "break;");
      return { next: null };
    }
  }
  return { next: to };
}
function emitTerminator(c: Ctx, b: Block, stack: Construct[], stop: Set<number>): number | null {
  const term = b.term, w = term.w, merge = b.merge;
  if (merge?.op === O.LoopMerge) {
    const m = merge.w[0], cont = merge.w[1];
    line(c, "loop {");
    c.depth++;
    const loop: Construct = { kind: "loop", header: b.label, merge: m, cont };
    const inner = [...stack, loop];
    // the header's own branch into the loop body
    if (term.op === O.BranchConditional) {
      const [cond, t1, f1] = [w[0], w[1], w[2]];
      if (f1 === m) { line(c, `if (!(${value(c, cond)})) { break; }`); emitBody(c, b.label, t1, inner, cont); }
      else if (t1 === m) { line(c, `if (${value(c, cond)}) { break; }`); emitBody(c, b.label, f1, inner, cont); }
      else throw new Error("SPIR-V: a loop header branching to neither its merge nor body alone");
    } else if (term.op === O.Branch) emitBody(c, b.label, w[0], inner, cont);
    else throw new Error("SPIR-V: a loop header without a branch");
    // the continue construct, ending in the back edge
    line(c, "continuing {");
    c.depth++;
    if (cont !== b.label) emitContinue(c, cont, loop, inner);
    c.depth--;
    line(c, "}");
    c.depth--;
    line(c, "}");
    return m;
  }
  switch (term.op) {
    case O.Branch: return branch(c, b.label, w[0], stack).next;
    case O.BranchConditional: {
      const [cond, t1, f1] = [w[0], w[1], w[2]];
      if (merge?.op === O.SelectionMerge) {
        const m = merge.w[0], inner: Construct[] = [...stack, { kind: "if", merge: m }];
        line(c, `if (${value(c, cond)}) {`);
        c.depth++; emitArm(c, b.label, t1, inner, m); c.depth--;
        if (f1 !== m || (c.phis.get(m) ?? []).length) { line(c, "} else {"); c.depth++; emitArm(c, b.label, f1, inner, m); c.depth--; }
        line(c, "}");
        // a merge block a phi or break left unreached is still where the code goes on
        return stop.has(m) ? null : m;
      }
      // a conditional break or continue
      line(c, `if (${value(c, cond)}) {`);
      c.depth++; const a = branch(c, b.label, t1, stack); if (a.next !== null) emitRegion(c, a.next, stack, stop); c.depth--;
      line(c, "} else {");
      c.depth++; const e = branch(c, b.label, f1, stack); if (e.next !== null) emitRegion(c, e.next, stack, stop); c.depth--;
      line(c, "}");
      return null;
    }
    case O.Switch: {
      if (merge?.op !== O.SelectionMerge) throw new Error("SPIR-V: a switch without a merge");
      const m = merge.w[0], selType = c.t.resultType.get(w[0])!, inner: Construct[] = [...stack, { kind: "switch", merge: m }];
      const cases = new Map<number, number[]>();
      for (let k = 2; k < w.length; k += 2) cases.set(w[k + 1], [...(cases.get(w[k + 1]) ?? []), w[k]]);
      const suffix = c.t.signed(selType) ? "i" : "u";
      line(c, `switch (${value(c, w[0])}) {`);
      c.depth++;
      for (const [target, lits] of cases) {
        const isDefault = target === w[1];
        line(c, `case ${lits.map((l) => `${c.t.signed(selType) ? l | 0 : l >>> 0}${suffix}`).join(", ")}${isDefault ? ", default" : ""}: {`);
        c.depth++; emitArm(c, b.label, target, inner, m); c.depth--;
        line(c, "}");
      }
      if (!cases.has(w[1])) { line(c, "default: {"); c.depth++; emitArm(c, b.label, w[1], inner, m); c.depth--; line(c, "}"); }
      c.depth--;
      line(c, "}");
      return stop.has(m) ? null : m;
    }
    case O.Return: line(c, "return;"); return null;
    case O.ReturnValue: line(c, `return ${as(c, w[0], c.fn.ret)};`); return null;
    case O.Kill: case O.TerminateInvocation: line(c, "discard;"); return null;
    case O.Unreachable: return null;
    default: throw new Error(`SPIR-V: terminator ${term.op}`);
  }
}
function emitArm(c: Ctx, from: number, target: number, stack: Construct[], merge: number): void {
  const r = branch(c, from, target, stack);
  if (r.next !== null && r.next !== merge) emitRegion(c, r.next, stack, new Set([merge]));
}
function emitBody(c: Ctx, from: number, target: number, stack: Construct[], cont: number): void {
  const r = branch(c, from, target, stack);
  if (r.next !== null && r.next !== cont) emitRegion(c, r.next, stack, new Set([cont]));
}
function emitContinue(c: Ctx, start: number, loop: Extract<Construct, { kind: "loop" }>, stack: Construct[]): void {
  let label: number | null = start;
  while (label !== null) {
    if (c.done.has(label)) throw new Error(`SPIR-V: block %${label} reached twice`);
    c.done.add(label);
    const b: Block = c.fn.blocks.get(label)!;
    for (const i of b.insts) if (i.op !== O.Phi) emitInst(c, i);
    const term = b.term;
    if (term.op === O.Branch) {
      const r = branch(c, b.label, term.w[0], stack);
      label = r.next;
    } else if (term.op === O.BranchConditional) {
      const [cond, t1, f1] = [term.w[0], term.w[1], term.w[2]];
      if (b.merge) { label = emitTerminator(c, b, stack, new Set([loop.header])); continue; }
      // the back edge or the loop's exit
      const phisOf = (to: number) => (c.phis.get(to) ?? []).flatMap((phi) => { const out: string[] = []; for (let k = 2; k < phi.w.length; k += 2) if (phi.w[k + 1] === b.label) out.push(`x_${phi.w[1]} = ${value(c, phi.w[k])};`); return out; });
      for (const s of [...phisOf(t1), ...phisOf(f1)]) line(c, s);
      if (t1 === loop.header && f1 === loop.merge) line(c, `break if !(${value(c, cond)});`);
      else if (f1 === loop.header && t1 === loop.merge) line(c, `break if ${value(c, cond)};`);
      else throw new Error("SPIR-V: a continue construct ending other than in its back edge");
      label = null;
    } else throw new Error("SPIR-V: a continue construct ending other than in a branch");
  }
}

// ── instructions
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

function emitInst(c: Ctx, i: Inst): void {
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
      if (rt.k === "image" || rt.k === "sampler" || rt.k === "sampled") { c.refs.set(id, ref(c, w[2])); c.vals.set(id, ref(c, w[2])); return; }
      return define(c, id, mr ? matValue(t, mr) : ref(c, w[2]));
    }
    case O.Store: {
      const mr = c.mats.get(w[0]);
      if (mr) return storeMat(c, mr, value(c, w[1]));
      return line(c, `${ref(c, w[0])} = ${as(c, w[1], (t.type(t.resultType.get(w[0])!) as { to: number }).to)};`);
    }
    case O.CopyMemory:
      if (c.mats.has(w[0]) || c.mats.has(w[1])) throw new Error("SPIR-V: a copy of row-major or padded matrices");
      return line(c, `${ref(c, w[0])} = ${ref(c, w[1])};`);
    case O.AccessChain: case O.InBoundsAccessChain: {
      const base = c.mats.get(w[2]);
      let text = base?.text ?? ref(c, w[2]), cur = base?.type ?? (t.type(t.resultType.get(w[2])!) as { to: number }).to, m = base?.m ?? null, col = base?.col;
      for (const idx of w.subarray(3)) {
        const k = t.constValues.get(idx), at = k !== undefined ? `${k}` : value(c, idx), tt = t.type(cur);
        if (m && tt.k === "array") { text += `[${at}]`; cur = tt.el; }
        else if (m && tt.k === "mat" && m.rowMajor) { col = at; cur = tt.col; }
        else if (m) { text = tt.k === "mat" ? vecOf(m, text, at) : `${vecOf(m, text, at)}[${col}]`; cur = tt.k === "mat" ? tt.col : (tt as { el: number }).el; m = null; }
        else if (tt.k === "struct") { const mb = member(t, cur, k!); text += mb.text; m = t.matLayout(cur, k!); cur = mb.type; }
        else { text += `[${at}]${t.padded(cur) !== undefined ? ".v" : ""}`; cur = tt.k === "vec" ? tt.el : tt.k === "mat" ? tt.col : (tt as { el: number }).el; }
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
      const parts = [...w.subarray(2)].map((p, i) => rt.k === "vec" || rt.k === "mat" ? value(c, p) : as(c, p, rt.k === "struct" ? rt.members[i] : (rt as { el: number }).el));
      return define(c, id, t.construct(ty, parts));
    }
    case O.VectorShuffle: {
      const a = t.type(t.resultType.get(w[2])!) as { n: number }, parts = [...w.subarray(4)].map((k) => k === 0xffffffff ? `${value(c, w[2])}.x` : k < a.n ? `${value(c, w[2])}.${"xyzw"[k]}` : `${value(c, w[3])}.${"xyzw"[k - a.n]}`);
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
    case O.IsInf: return define(c, id, `(abs(${value(c, w[2])}) > ${t.wgsl(t.resultType.get(w[2])!)}(3.40282347e+38))`);
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
      const img = imageOf(c, w[0]), { coords, layer } = split(c, w[1], img.arrayed);
      return line(c, `textureStore(${value(c, w[0])}, ${coords}${layer ? `, ${layer}` : ""}, ${texel(c, w[2], img)});`);
    }
    case O.ImageQuerySizeLod: case O.ImageQuerySize: {
      const img = imageOf(c, w[2]), lod = op === O.ImageQuerySizeLod ? `, ${value(c, w[3])}` : "", v = value(c, w[2]);
      const dims = `textureDimensions(${v}${lod})`, n = (t.type(ty) as { n?: number }).n ?? 1;
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
function imageOf(c: Ctx, id: number): Extract<Type, { k: "image" }> {
  let ty = c.t.type(c.t.resultType.get(id)!);
  if (ty.k === "sampled") ty = c.t.type(ty.image);
  if (ty.k !== "image") throw new Error("SPIR-V: not an image");
  return ty;
}
/** coordinates with an arrayed image's layer split off, as WGSL takes it */
function split(c: Ctx, coord: number, arrayed: number): { coords: string; layer: string | null } {
  const v = value(c, coord);
  if (!arrayed) return { coords: v, layer: null };
  const ct = c.t.type(c.t.resultType.get(coord)!) as { n: number; el: number }, n = ct.n - 1, int = c.t.isInt(ct.el);
  const sw = "xyzw".slice(0, n);
  return { coords: n === 1 ? `${v}.x` : `${v}.${sw}`, layer: int ? `${v}.${"xyzw"[n]}` : `i32(round(${v}.${"xyzw"[n]}))` };
}
/** a texel to store, as the storage format's channel type takes it */
function texel(c: Ctx, id: number, img: Extract<Type, { k: "image" }>): string {
  const sampled = c.t.wgsl(img.sampled), v = value(c, id), have = c.t.scalarOf(c.t.resultType.get(id)!);
  const haveName = have.k === "int" ? (have.signed ? "i32" : "u32") : "f32";
  return haveName === sampled ? v : `bitcast<vec4<${sampled}>>(${v})`;
}
function imageOperands(c: Ctx, w: Uint32Array, at: number): { bias?: string; lod?: string; grad?: [string, string]; offset?: string; sample?: string } {
  if (w.length <= at) return {};
  const mask = w[at], out: { bias?: string; lod?: string; grad?: [string, string]; offset?: string; sample?: string } = {};
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
  const w = i.w, op = i.op, img = imageOf(c, w[2]), si = value(c, w[2]);
  const [tex] = si.split(", ");
  const samplerName = si.includes(", ") ? si.slice(tex.length + 2) : si;
  const pair = `${tex}, ${samplerName}`;
  const { coords, layer } = split(c, w[3], img.arrayed), L = layer ? `, ${layer}` : "";
  const dref = op === O.ImageSampleDrefImplicitLod || op === O.ImageSampleDrefExplicitLod || op === O.ImageDrefGather;
  const opsAt = dref || op === O.ImageGather ? 5 : 4, ops = imageOperands(c, w, opsAt), off = ops.offset ? `, ${ops.offset}` : "";
  const depth = img.depth === 1 || c.t.depth(w[2]);
  if (op === O.ImageGather) return `textureGather(${depth ? "" : `${value(c, w[4])}, `}${pair}, ${coords}${L}${off})`;
  if (op === O.ImageDrefGather) return `textureGatherCompare(${pair}, ${coords}${L}, ${value(c, w[4])}${off})`;
  if (dref) {
    const r = ops.lod !== undefined || op === O.ImageSampleDrefExplicitLod ? `textureSampleCompareLevel(${pair}, ${coords}${L}, ${value(c, w[4])}${off})` : `textureSampleCompare(${pair}, ${coords}${L}, ${value(c, w[4])}${off})`;
    return r;
  }
  let r: string;
  if (ops.grad) r = `textureSampleGrad(${pair}, ${coords}${L}, ${ops.grad[0]}, ${ops.grad[1]}${off})`;
  else if (ops.lod !== undefined) r = `textureSampleLevel(${pair}, ${coords}${L}, ${depth ? `i32(${ops.lod})` : ops.lod}${off})`;
  else if (ops.bias !== undefined) r = `textureSampleBias(${pair}, ${coords}${L}, ${ops.bias}${off})`;
  else r = `textureSample(${pair}, ${coords}${L}${off})`;
  // a depth texture samples to a scalar; SPIR-V's result is a vector with it first
  return depth ? `vec4<f32>(${r}, 0.0, 0.0, 0.0)` : r;
}
function fetch(c: Ctx, i: Inst): string {
  const w = i.w, img = imageOf(c, w[2]), { coords, layer } = split(c, w[3], img.arrayed), ops = imageOperands(c, w, 4);
  const args = [value(c, w[2]), coords];
  if (layer) args.push(layer);
  if (i.op === O.ImageFetch) args.push(img.ms ? ops.sample ?? "0" : ops.lod ?? "0");
  const r = `textureLoad(${args.join(", ")})`;
  const depth = img.depth === 1 || c.t.depth(w[2]);
  const want = c.t.wgsl(w[0]), have = img.usage === 2 ? `vec4<${c.t.wgsl(img.sampled)}>` : depth ? "f32" : `vec4<${c.t.wgsl(img.sampled)}>`;
  if (depth) return `vec4<f32>(${r}, 0.0, 0.0, 0.0)`;
  return want === have ? r : `bitcast<${want}>(${r})`;
}

// ── the entry function
function entryWrapper(t: Translator, stage: Stage, epFn: number, inputs: { id: number; type: number }[], outputs: { id: number; type: number }[]): string {
  const params: string[] = [], pre: string[] = [], fields: string[] = [], post: string[] = [];
  let usesFlip = false;
  const interp = (id: number, ty: number, member?: [number, number]) => {
    const dec = (d: number) => member ? t.memberDec(member[0], member[1], d) : t.dec(id, d);
    if (dec(D.Flat) || t.isInt(ty)) return " @interpolate(flat)";
    const mode = dec(D.NoPerspective) ? "linear" : "perspective", where = dec(D.Centroid) ? ", centroid" : dec(D.Sample) ? ", sample" : "";
    return mode === "perspective" && !where ? "" : ` @interpolate(${mode}${where})`;
  };
  for (const { id, type } of inputs) {
    const b = t.dec(id, D.BuiltIn)?.[0];
    if (b !== undefined) {
      const [name, wty] = BUILTIN[b] ?? [];
      if (!name) throw new Error(`SPIR-V: input builtin ${b}`);
      const have = t.wgsl(type);
      params.push(`@builtin(${name}) p_${id}: ${wty}`);
      if (b === 20) pre.push(`x_${id}[0] = ${have.includes("i32") ? `bitcast<i32>(p_${id})` : `p_${id}`};`);
      else pre.push(`x_${id} = ${have === wty ? `p_${id}` : `bitcast<${have}>(p_${id})`};`);
      continue;
    }
    const loc = t.dec(id, D.Location)?.[0];
    if (loc === undefined) throw new Error("SPIR-V: an input without a location");
    params.push(`@location(${loc})${stage === "fragment" ? interp(id, type) : ""} p_${id}: ${t.wgsl(type)}`);
    pre.push(`x_${id} = p_${id};`);
  }
  for (const { id, type } of outputs) {
    const st = t.type(type);
    // a block of builtins, as glslang writes gl_PerVertex
    if (st.k === "struct" && st.members.some((_, i) => t.memberDec(type, i, D.BuiltIn))) {
      st.members.forEach((m, i) => {
        const b = t.memberDec(type, i, D.BuiltIn)?.[0];
        if (b === 0) { fields.push(`@builtin(position) o_${id}_${i}: vec4<f32>,`); post.push(`out.o_${id}_${i} = x_${id}.m${i};`); usesFlip = true; post.push(`if (webdroid_flip_y) { out.o_${id}_${i}.y = -out.o_${id}_${i}.y; }`); }
        else if (b === 3 && (t.type(m) as { len: number }).len) { t.enables.add("clip_distances"); fields.push(`@builtin(clip_distances) o_${id}_${i}: ${t.wgsl(m)},`); post.push(`out.o_${id}_${i} = x_${id}.m${i};`); }
      });
      continue;
    }
    const b = t.dec(id, D.BuiltIn)?.[0];
    if (b === POINT_SIZE || b === CULL_DISTANCE) continue;
    if (b !== undefined) {
      const [name, wty] = BUILTIN[b] ?? [];
      if (!name) throw new Error(`SPIR-V: output builtin ${b}`);
      if (b === 3) { t.enables.add("clip_distances"); fields.push(`@builtin(clip_distances) o_${id}: ${t.wgsl(type)},`); post.push(`out.o_${id} = x_${id};`); continue; }
      fields.push(`@builtin(${name}) o_${id}: ${wty},`);
      if (b === 20) post.push(`out.o_${id} = ${t.wgsl(type).includes("i32") ? `bitcast<u32>(x_${id}[0])` : `x_${id}[0]`};`);
      else post.push(`out.o_${id} = ${t.wgsl(type) === wty ? `x_${id}` : `bitcast<${wty}>(x_${id})`};`);
      if (b === 0 && stage === "vertex") { usesFlip = true; post.push(`if (webdroid_flip_y) { out.o_${id}.y = -out.o_${id}.y; }`); }
      continue;
    }
    const loc = t.dec(id, D.Location)?.[0], index = t.dec(id, D.Index)?.[0];
    if (loc === undefined) throw new Error("SPIR-V: an output without a location");
    if (index) t.enables.add("dual_source_blending");
    fields.push(`@location(${loc})${index !== undefined && stage === "fragment" ? ` @blend_src(${index})` : ""}${stage === "vertex" ? interp(id, type) : ""} o_${id}: ${t.wgsl(type)},`);
    post.push(`out.o_${id} = x_${id};`);
  }
  if (stage === "vertex" && !usesFlip) pre.push("_ = webdroid_flip_y;");
  let attr = `@${stage}`;
  if (stage === "compute") {
    const size = t.insts.find((i) => i.op === O.ExecutionMode && i.w[0] === epFn && i.w[1] === 17);
    const builtin = [...t.decorations].find(([, d]) => d.get(D.BuiltIn)?.[0] === 25)?.[0];
    const dims = builtin !== undefined ? (t.consts.get(builtin) ?? "").replace(/^vec3<u32>\(|\)$/g, "") : size ? `${size.w[2]}, ${size.w[3]}, ${size.w[4]}` : "1, 1, 1";
    attr += ` @workgroup_size(${dims})`;
  }
  const call = `  f_${epFn}();`;
  if (!fields.length) return `${attr} fn webdroid_main(${params.join(", ")}) {\n${pre.map((p) => `  ${p}`).join("\n")}\n${call}\n}`;
  return `struct WebdroidOut {\n${fields.map((f) => `  ${f}`).join("\n")}\n}\n${attr} fn webdroid_main(${params.join(", ")}) -> WebdroidOut {\n${pre.map((p) => `  ${p}`).join("\n")}\n${call}\n  var out: WebdroidOut;\n${post.map((p) => `  ${p}`).join("\n")}\n  return out;\n}`;
}
