// C structs in guest memory, laid out by the C rules for the process's pointer width: a uint64_t is
// 8-aligned under both AAPCS and AAPCS64, a pointer or size_t is the pointer width, and a struct aligns
// to its widest member.

import { mem } from "./mem.ts";
import { PTR, ldp, stp } from "./host.ts";

type Scalar = "u32" | "i32" | "f32" | "u64" | "ptr" | "u8";
interface Field { name: string; type: Scalar; count: number; off: number }
const width = (t: Scalar) => t === "u8" ? 1 : t === "u64" ? 8 : t === "ptr" ? PTR : 4;
/** a u64 read as a number: handles and sizes stay below 2^53, and all ones (VK_WHOLE_SIZE) reads as 2^64 */
export const WHOLE = 2 ** 64;
export const ldU64 = (a: number): number => (mem.ld32(a) >>> 0) + (mem.ld32(a + 4) >>> 0) * 2 ** 32;
export function stU64(a: number, v: number): void { mem.st32(a, v % 2 ** 32 | 0); mem.st32(a + 4, Math.floor(v / 2 ** 32) | 0); }

/** the field names of a `struct` spec, so a misspelt field is a type error */
type Name<F extends string> = F extends `${infer A}\n${infer B}` ? Name<A> | Name<B> : F extends `${infer N}:${string}` ? N : never;
type Fields<S extends string, Acc extends string = never> = S extends `${infer F} ${infer R}` ? Fields<R, Acc | Name<F>> : Acc | Name<S>;

export interface Struct<K extends string> {
  size(): number;
  off(name: K): number;
  read(p: number): Record<K, number>;
  /** an array field's elements */
  array(p: number, name: K): number[];
  write(p: number, values: Partial<Record<K, number | number[] | string>>): void;
}
/** `spec` lists `name:type` or `name:type[n]` fields in order; `size` is size_t, a pointer's width, and a
 *  zero-length field aligns what follows as a nested struct of that type would be */
export function struct<S extends string>(spec: S): Struct<string extends S ? string : Fields<S>> {
  type K = string extends S ? string : Fields<S>;
  const parsed = spec.trim().split(/\s+/).map((f) => {
    const m = /^(\w+):(\w+)(?:\[(\d+)\])?$/.exec(f);
    if (!m) throw new Error(`bad field ${f}`);
    return { name: m[1], type: (m[2] === "size" ? "ptr" : m[2]) as Scalar, count: m[3] ? Number(m[3]) : 1 };
  });
  // a layout per pointer width, since 32- and 64-bit processes share these modules
  const layouts = new Map<number, { fields: Map<string, Field>; size: number }>();
  const layout = () => {
    let l = layouts.get(PTR);
    if (!l) {
      let off = 0, align = 1;
      const fields = new Map<string, Field>();
      for (const f of parsed) {
        const w = width(f.type);
        off = (off + w - 1) & -w; align = Math.max(align, w);
        fields.set(f.name, { ...f, off });
        off += w * f.count;
      }
      layouts.set(PTR, (l = { fields, size: (off + align - 1) & -align }));
    }
    return l;
  };
  const load = (t: Scalar, a: number): number => {
    switch (t) {
      case "u32": return mem.ld32(a) >>> 0;
      case "i32": return mem.ld32(a);
      case "f32": return mem.ldf32(a);
      case "u8": return mem.ld8u(a);
      case "ptr": return ldp(a);
      case "u64": return ldU64(a);
    }
  };
  const store = (t: Scalar, a: number, v: number): void => {
    switch (t) {
      case "u32": case "i32": mem.st32(a, v | 0); return;
      case "f32": mem.stf32(a, v); return;
      case "u8": mem.st8(a, v); return;
      case "ptr": stp(a, v); return;
      case "u64": stU64(a, v); return;
    }
  };
  const field = (name: string) => {
    const f = layout().fields.get(name);
    if (!f) throw new Error(`no field ${name}`);
    return f;
  };
  return {
    size: () => layout().size,
    off: (name) => field(name).off,
    read(p) {
      const out = {} as Record<K, number>;
      for (const f of layout().fields.values()) if (f.count === 1) out[f.name as K] = load(f.type, p + f.off);
      return out;
    },
    array(p, name) {
      const f = field(name), w = width(f.type);
      return Array.from({ length: f.count }, (_, i) => load(f.type, p + f.off + i * w));
    },
    write(p, values) {
      for (const [name, v] of Object.entries(values) as [string, number | number[] | string][]) {
        const f = field(name), w = width(f.type);
        if (typeof v === "string") {
          const bytes = new TextEncoder().encode(v).subarray(0, f.count - 1);
          mem.write(p + f.off, bytes); mem.st8(p + f.off + bytes.length, 0);
        } else if (Array.isArray(v)) v.forEach((x, i) => store(f.type, p + f.off + i * w, x));
        else store(f.type, p + f.off, v);
      }
    },
  };
}

/** `n` elements of `size` bytes from `p`, each read by `read` */
export function list<T>(p: number, n: number, size: number, read: (at: number) => T): T[] {
  return Array.from({ length: p ? n : 0 }, (_, i) => read(p + i * size));
}
export const u32s = (p: number, n: number): number[] => list(p, n, 4, (a) => mem.ld32(a) >>> 0);
export const ptrs = (p: number, n: number): number[] => list(p, n, PTR, ldp);
export const u64s = (p: number, n: number): number[] => list(p, n, 8, ldU64);
