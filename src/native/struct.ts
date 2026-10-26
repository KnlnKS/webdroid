// C structs in guest memory, laid out by the C rules for the process's pointer width: a uint64_t is
// 8-aligned under both AAPCS and AAPCS64, a pointer or size_t is the pointer width, and a struct aligns
// to its widest member, a nested struct's included.

import { mem } from "./mem.ts";
import { PTR, ldp, stp } from "./host.ts";

type Scalar = "u32" | "i32" | "f32" | "u64" | "ptr" | "u8";
interface Field { name: string; type: Scalar | "struct"; count: number; off: number }
const width = (t: Scalar) => t === "u8" ? 1 : t === "u64" ? 8 : t === "ptr" ? PTR : 4;
/** a u64 read as a number: handles and sizes stay below 2^53, and all ones (VK_WHOLE_SIZE) reads as 2^64 */
export const WHOLE = 2 ** 64;
export const ldU64 = (a: number): number => (mem.ld32(a) >>> 0) + (mem.ld32(a + 4) >>> 0) * 2 ** 32;
export function stU64(a: number, v: number): void { mem.st32(a, v % 2 ** 32 | 0); mem.st32(a + 4, Math.floor(v / 2 ** 32) | 0); }

/** the field names of a `struct` spec, so a misspelt field is a type error */
type Name<F extends string> = F extends `${infer A}\n${infer B}` ? Name<A> | Name<B> : F extends `${infer N}:${string}` ? N : never;
type Fields<S extends string, Acc extends string = never> = S extends `${infer F} ${infer R}` ? Fields<R, Acc | Name<F>> : Acc | Name<S>;

interface Layout { size(): number; align(): number; read(p: number): object; write(p: number, values: never): void }
type Nested = Record<string, Layout>;
type Values<K extends string, N extends Nested> = Record<Exclude<K, keyof N>, number> & { [M in keyof N]: ReturnType<N[M]["read"]> };
type Inputs<K extends string, N extends Nested> = Partial<Record<Exclude<K, keyof N>, number | number[] | string> & { [M in keyof N]: Parameters<N[M]["write"]>[1] }>;
/** the fields `s.read` gives */
export type Read<S extends Layout> = ReturnType<S["read"]>;

export interface Struct<K extends string, N extends Nested> extends Layout {
  off(name: K): number;
  read(p: number): Values<K, N>;
  /** an array field's elements */
  array(p: number, name: K): number[];
  write(p: number, values: Inputs<K, N>): void;
}
/** `spec` lists `name:type` or `name:type[n]` fields in order; `size` is size_t, a pointer's width, and `struct`
 *  the struct `nested` holds by the field's name */
export function struct<S extends string, N extends Nested = Record<never, Layout>>(spec: S, nested?: N): Struct<string extends S ? string : Fields<S>, N> {
  type K = string extends S ? string : Fields<S>;
  const parsed = spec.trim().split(/\s+/).map((f) => {
    const m = /^(\w+):(\w+)(?:\[(\d+)\])?$/.exec(f);
    if (!m || (m[2] === "struct" && !nested?.[m[1]])) throw new Error(`bad field ${f}`);
    return { name: m[1], type: (m[2] === "size" ? "ptr" : m[2]) as Field["type"], count: m[3] ? Number(m[3]) : 1 };
  });
  const inner = (name: string) => nested![name];
  // a layout per pointer width, since 32- and 64-bit processes share these modules
  const layouts = new Map<number, { fields: Map<string, Field>; size: number; align: number }>();
  const layout = () => {
    let l = layouts.get(PTR);
    if (!l) {
      let off = 0, align = 1;
      const fields = new Map<string, Field>();
      for (const f of parsed) {
        const w = f.type === "struct" ? inner(f.name).size() : width(f.type), a = f.type === "struct" ? inner(f.name).align() : w;
        off = (off + a - 1) & -a; align = Math.max(align, a);
        fields.set(f.name, { ...f, off });
        off += w * f.count;
      }
      layouts.set(PTR, (l = { fields, size: (off + align - 1) & -align, align }));
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
    align: () => layout().align,
    off: (name) => field(name).off,
    read(p) {
      const out: Record<string, unknown> = {};
      for (const f of layout().fields.values()) {
        if (f.type === "struct") out[f.name] = inner(f.name).read(p + f.off);
        else if (f.count === 1) out[f.name] = load(f.type, p + f.off);
      }
      return out as Values<K, N>;
    },
    array(p, name) {
      const f = field(name), t = f.type as Scalar, w = width(t);
      return Array.from({ length: f.count }, (_, i) => load(t, p + f.off + i * w));
    },
    write(p, values) {
      for (const [name, v] of Object.entries(values) as [string, unknown][]) {
        const f = field(name);
        if (f.type === "struct") { inner(name).write(p + f.off, v as never); continue; }
        const t = f.type, w = width(t);
        if (typeof v === "string") {
          const bytes = new TextEncoder().encode(v).subarray(0, f.count - 1);
          mem.write(p + f.off, bytes); mem.st8(p + f.off + bytes.length, 0);
        } else if (Array.isArray(v)) v.forEach((x: number, i) => store(t, p + f.off + i * w, x));
        else store(t, p + f.off, v as number);
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
