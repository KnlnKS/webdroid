// WGSL types, constants and struct declarations for a module, laid out as its decorations say: what an
// entry point's analysis marks (atomics, depth comparisons, storage access) is settled before any is named.

import { fromHalf } from "../../../android/bitmap.ts";
import { D, O, Module, type Of } from "./module.ts";

/** Dim Buffer: a texel buffer, declared as an array of its texels' 32-bit components (interface.ts); as many as its storage
 *  format has, and one for a sampled one, as formats.ts offers uniform texel buffers only in single-component formats */
export const BUFFER_DIM = 5;
const TEXEL_COMPONENTS: Record<number, number> = { 0: 1, 1: 4, 3: 1, 6: 2, 21: 4, 24: 1, 25: 2, 30: 4, 33: 1, 35: 2 };
export function texelComponents(img: Of<"image">): number {
  const n = TEXEL_COMPONENTS[img.format];
  if (!n) throw new Error(`SPIR-V: texel buffer format ${img.format}`);
  return n;
}
const TEXEL_FORMAT: Record<number, string> = {
  1: "rgba32float", 2: "rgba16float", 3: "r32float", 4: "rgba8unorm", 5: "rgba8snorm", 6: "rg32float", 7: "rg16float", 15: "r16float",
  21: "rgba32sint", 22: "rgba16sint", 23: "rgba8sint", 24: "r32sint", 25: "rg32sint", 30: "rgba32uint", 31: "rgba16uint", 32: "rgba8uint", 33: "r32uint", 35: "rg32uint",
  9: "r8unorm", 13: "rg8unorm", 27: "rg8sint", 29: "r8sint", 37: "rg8uint", 39: "r8uint", 11: "rgb10a2unorm", 34: "rgb10a2uint", 8: "rg11b10ufloat",
};
/** a member's matrices as an array (`text`, `size` bytes) of k vectors: rows of a row-major one, else columns; `wrap` where
 *  each is a struct's v to take the stride, which `q` declares */
export interface MatLayout { rowMajor: boolean; wrap: boolean; C: number; R: number; k: number; el: string; text: string; size: number; align: number; q: string }
const roundUp = (n: number, to: number) => Math.ceil(n / to) * to;

export class Translator extends Module {
  /** the array types and struct members an atomic operation uses: declared atomic */
  readonly atomicArrays = new Set<number>();
  readonly atomicMembers = new Map<number, Set<number>>();
  /** image and sampler variables a comparison samples with, and the variable each loaded value comes from */
  readonly depthVars = new Set<number>();
  readonly sources = new Map<number, number>();
  depth(id: number): boolean { return this.depthVars.has(this.sources.get(id) ?? -1); }
  /** the access of storage image types, as the variables of them declare it */
  readonly storageAccess = new Map<number, string>();
  /** constants' WGSL expressions (defineConstants) */
  readonly consts = new Map<number, string>();
  private readonly mats = new Map<string, MatLayout | null>();

  wgsl(id: number): string {
    const t = this.type(id);
    switch (t.k) {
      case "void": return "void";
      case "bool": return "bool";
      case "int": if (t.width !== 32) throw new Error(`SPIR-V: ${t.width}-bit integers`); return t.signed ? "i32" : "u32";
      case "float": if (t.width === 16) return "f16"; if (t.width !== 32) throw new Error("SPIR-V: 64-bit floats"); return "f32";
      case "vec": return `vec${t.n}<${this.wgsl(t.el)}>`;
      case "mat": { const c = this.kind(t.col, "vec"); return `mat${t.n}x${c.n}<${this.wgsl(c.el)}>`; }
      case "array": {
        const el = this.padded(id) !== undefined ? `P${id}` : this.atomicArrays.has(id) ? `atomic<${this.wgsl(t.el)}>` : this.wgsl(t.el);
        return t.len === null ? `array<${el}>` : `array<${el}, ${t.len}>`;
      }
      case "struct": return `S${id}`;
      case "sampler": return "sampler";
      case "image": return this.imageType(id, t);
      case "sampled": return this.wgsl(t.image);
      default: throw new Error(`SPIR-V: no WGSL type for ${t.k}`);
    }
  }
  imageType(id: number, t: Of<"image">, depth = false, access = this.storageAccess.get(id) ?? "read_write"): string {
    const dim = ["1d", "2d", "3d", "cube"][t.dim];
    if (!dim) throw new Error(`SPIR-V: image dimension ${t.dim}`);
    const arr = t.arrayed ? "_array" : "";
    if (t.usage === 2) {
      const format = TEXEL_FORMAT[t.format];
      if (!format) throw new Error(`SPIR-V: storage image format ${t.format}`);
      return `texture_storage_${dim}${arr}<${format}, ${access}>`;
    }
    if (t.depth === 1 || depth) return t.ms ? "texture_depth_multisampled_2d" : `texture_depth_${dim}${arr}`;
    const el = this.wgsl(t.sampled);
    return t.ms ? `texture_multisampled_2d<${el}>` : `texture_${dim}${arr}<${el}>`;
  }
  /** the ArrayStride of an array whose stride WGSL's own is not (std140's of scalars, vectors and structs), its elements each
   *  wrapped as P<id>'s v; an array of matrices takes the layout of the member holding it (matLayout) */
  padded(id: number): number | undefined {
    const t = this.type(id);
    if (t.k !== "array") return undefined;
    let el = this.type(t.el);
    while (el.k === "array") el = this.type(el.el);
    const stride = this.dec(id, D.ArrayStride)?.[0], l = this.layout(t.el);
    return el.k !== "mat" && stride !== undefined && stride !== roundUp(l.size, l.align) ? stride : undefined;
  }
  /** a composite of type `ty` from its parts, a padded array's each wrapped */
  construct(ty: number, parts: string[]): string {
    const ps = this.padded(ty) !== undefined ? parts.map((p) => `P${ty}(${p})`) : parts;
    return `${this.wgsl(ty)}(${(this.lead(ty) ? ["0u", ...ps] : ps).join(", ")})`;
  }
  /** the bytes before struct `id`'s first member, which a block one stage shares with another may leave to the other */
  private lead(id: number): number { return this.type(id).k === "struct" ? this.memberDec(id, 0, D.Offset)?.[0] ?? 0 : 0; }
  /** how struct `s`'s member `i`, a matrix or an array of them, lays out matrices WGSL's matCxR does not: row-major or
   *  with a MatrixStride other than its columns' own. Such a member is an array of its rows or columns, each wrapped
   *  as Q<s>_<i>'s v where the stride is not the vector's own; null for a member WGSL lays out as SPIR-V does. */
  matLayout(s: number, i: number): MatLayout | null {
    const key = `${s}_${i}`;
    if (this.mats.has(key)) return this.mats.get(key)!;
    const arrays: number[] = [];
    let ty = this.kind(s, "struct").members[i], mt = this.type(ty);
    for (; mt.k === "array"; mt = this.type(ty = mt.el)) arrays.push(ty);
    let m: MatLayout | null = null;
    if (mt.k === "mat") {
      const col = this.kind(mt.col, "vec"), c = this.layout(mt.col), natural = roundUp(c.size, c.align);
      const rowMajor = !!this.memberDec(s, i, D.RowMajor), stride = this.memberDec(s, i, D.MatrixStride)?.[0] ?? natural;
      if (rowMajor || stride !== natural) {
        const C = mt.n, R = col.n, n = rowMajor ? C : R, e = c.size / R, align = e * (n === 3 ? 4 : n), el = this.wgsl(col.el), vec = `vec${n}<${el}>`;
        if (stride % align) throw new Error(`SPIR-V: matrix stride ${stride}`);
        const wrap = stride !== roundUp(e * n, align), k = rowMajor ? R : C;
        m = { rowMajor, wrap, C, R, k, el, text: `array<${wrap ? `Q${key}` : vec}, ${k}>`, size: k * stride, align, q: `struct Q${key} {\n  @size(${stride}) v: ${vec},\n}` };
        for (let d = arrays.length - 1; d >= 0; d--) {
          const decorated = this.dec(arrays[d], D.ArrayStride)?.[0], len = this.kind(arrays[d], "array").len;
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
    return m ? { size: m.size, align: m.align } : this.layout(this.kind(s, "struct").members[i]);
  }
  /** WGSL's size and alignment of a type */
  layout(id: number): { size: number; align: number } {
    const ty = this.type(id);
    switch (ty.k) {
      case "bool": case "int": return { size: 4, align: 4 };
      case "float": return ty.width === 16 ? { size: 2, align: 2 } : { size: 4, align: 4 };
      case "vec": { const e = this.layout(ty.el); const n = ty.n === 3 ? 4 : ty.n; return { size: e.size * ty.n, align: e.size * n }; }
      case "mat": { const c = this.layout(ty.col); return { size: roundUp(c.size, c.align) * ty.n, align: c.align }; }
      case "array": {
        const e = this.layout(ty.el), stride = this.padded(id) ?? roundUp(e.size, e.align);
        return { size: stride * (ty.len ?? 1), align: e.align };
      }
      case "struct": {
        let size = 0, align = 1;
        ty.members.forEach((_, i) => {
          const l = this.memberLayout(id, i), off = this.memberDec(id, i, D.Offset)?.[0] ?? roundUp(size, l.align);
          size = off + l.size; align = Math.max(align, l.align);
        });
        return { size: roundUp(size, align), align };
      }
      default: return { size: 4, align: 4 };
    }
  }
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
    if (t.k === "float" && t.width === 16) return `${floatText(fromHalf(w[0] & 0xffff))}h`;
    throw new Error(`SPIR-V: a constant of ${t.k}`);
  }
  /** the constants' expressions, once the types they name are settled */
  defineConstants(): void {
    for (const i of this.constants) {
      const { op, w } = i;
      let text: string;
      switch (op) {
        case O.ConstantTrue: case O.ConstantFalse: text = String(op === O.ConstantTrue); break;
        case O.SpecConstantTrue: case O.SpecConstantFalse: { const v = this.specValue(w[1]); text = String(v ? !!v[0] : op === O.SpecConstantTrue); break; }
        case O.Constant: case O.SpecConstant: text = this.literal(w[0], this.constantBits(i)); break;
        case O.ConstantComposite: case O.SpecConstantComposite: text = this.construct(w[0], [...w.subarray(2)].map((c) => this.consts.get(c)!)); break;
        default: text = this.zero(w[0]);
      }
      this.consts.set(w[1], text);
    }
  }
  /** whether the module has 16-bit floats, which WGSL must enable */
  hasF16(): boolean { return [...this.types.values()].some((t) => t.k === "float" && t.width === 16); }

  /** the declarations of every struct, its members at their decorated offsets: the Q structs of their matrices, the structs,
   *  then the P structs of padded arrays */
  structs(): string[] {
    const qs: string[] = [], ss: string[] = [], done = new Set<number>();
    const emit = (id: number) => {
      if (done.has(id)) return;
      done.add(id);
      const t = this.type(id);
      if (t.k === "array") emit(t.el);
      if (t.k !== "struct") return;
      t.members.forEach(emit);
      const lines = t.members.map((m, i) => {
        const mat = this.matLayout(id, i);
        if (mat?.wrap) qs.push(mat.q);
        const ty = mat?.text ?? (this.atomicMembers.get(id)?.has(i) ? `atomic<${this.wgsl(m)}>` : this.wgsl(m));
        const off = this.memberDec(id, i, D.Offset)?.[0], next = this.memberDec(id, i + 1, D.Offset)?.[0];
        const natural = this.memberLayout(id, i);
        let attrs = "";
        if (off !== undefined && next !== undefined && next - off !== natural.size) attrs += `@size(${next - off}) `;
        if (off !== undefined && off % natural.align !== 0) throw new Error(`SPIR-V: member offset ${off} under its alignment`);
        return `  ${attrs}m${i}: ${ty},`;
      });
      if (!lines.length) lines.push("  m_unused: u32,");
      const lead = this.lead(id);
      if (lead) lines.unshift(`  @size(${lead}) m_lead: u32,`);
      ss.push(`struct S${id} {\n${lines.join("\n")}\n}`);
    };
    for (const [id, t] of this.types) if (t.k === "struct") emit(id);
    const ps: string[] = [];
    for (const [id, t] of this.types) {
      const stride = t.k === "array" ? this.padded(id) : undefined;
      if (stride !== undefined) ps.push(`struct P${id} {\n  @size(${stride}) v: ${this.wgsl(this.element(id))},\n}`);
    }
    return [...qs, ...ss, ...ps];
  }
}

/** a float as WGSL writes it, exactly */
function floatText(f: number): string {
  let s = String(f);
  if (!s.includes(".") && !s.includes("e")) s += ".0";
  return s;
}
