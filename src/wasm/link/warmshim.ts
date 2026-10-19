// A build module instantiated without its World, so that a Worker of its own has the engine compile the module's methods: V8 shares what it compiles
// of a module between the Workers of a process (the same bytes or the posted Module), and a first-tier method called while the warm word is set
// (exc.ts WARM_AT) traps as it is entered, once compiled. The imports come from the module's own bytes: its type section copied into a small module
// that defines its tags and globals at their defaults, JS functions that throw for its function imports (the Math functions the World passes stay
// themselves: V8 compiles calls of those differently), and one table and memory for every module of the warming World.
import { MATH_ARITY } from "../compiler/consts.ts";
import { uleb } from "../compiler/wasmbin.ts";
import { COUNT_SLOTS, WARM_AT } from "../compiler/exc.ts";

const K = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, refNull: 0x63, ref: 0x64 } as const;
/** a method is called with zeros and nulls */
type Zero = 0 | 0n | null;
/** a method to warm: its table slot, its function and its arguments */
export type WarmCall = [slot: number, f: Function, args: Zero[]];

const text = new TextDecoder();
class Reader {
  i = 8;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) { this.b = b; }
  u32(): number { let r = 0, s = 0, x: number; do { x = this.b[this.i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; }
  s32(): number { let r = 0, s = 0, x: number; do { x = this.b[this.i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return s < 32 && x & 0x40 ? r | (-1 << s) : r; }
  skipLeb(): void { while (this.b[this.i++] & 0x80); }
  name(): string { const n = this.u32(); return text.decode(this.b.subarray(this.i, this.i += n)); }
  /** a value type: its bytes, and for a reference type whether it is nullable and its heap type's bytes */
  valtype(): { bytes: Uint8Array; nullable: boolean; heap?: Uint8Array } {
    const at = this.i, t = this.b[this.i++];
    if (t === K.refNull || t === K.ref) { const h = this.i; this.skipLeb(); return { bytes: this.b.subarray(at, this.i), nullable: t === K.refNull, heap: this.b.subarray(h, this.i) }; }
    // an abstract reference type's shorthand is its nullable heap type
    return { bytes: this.b.subarray(at, this.i), nullable: true, heap: t < 0x7b ? this.b.subarray(at, this.i) : undefined };
  }
  limits(): { min: number; flags: number } { const flags = this.b[this.i++], min = this.u32(); if (flags & 1) this.u32(); return { min, flags }; }
}

const zeroOf = (t: number): Zero => t === K.i64 ? 0n : t === K.i32 || t === K.f32 || t === K.f64 ? 0 : null;
/** the arguments of each function type of a type section, by type index (undefined for struct and array types) */
function funcParams(r: Reader): (Zero[] | undefined)[] {
  const out: (Zero[] | undefined)[] = [];
  const sub = () => {
    if (r.b[r.i] === 0x50 || r.b[r.i] === 0x4f) { r.i++; for (let n = r.u32(); n > 0; n--) r.u32(); }
    const form = r.b[r.i++];
    if (form === 0x60) {
      const params: Zero[] = [];
      for (let n = r.u32(); n > 0; n--) params.push(zeroOf(r.valtype().bytes[0]));
      for (let n = r.u32(); n > 0; n--) r.valtype();
      out.push(params);
    } else if (form === 0x5f) { for (let n = r.u32(); n > 0; n--) { r.valtype(); r.i++; } out.push(undefined); }
    else { r.valtype(); r.i++; out.push(undefined); }
  };
  for (let n = r.u32(); n > 0; n--) if (r.b[r.i] === 0x4e) { r.i++; for (let k = r.u32(); k > 0; k--) sub(); } else sub();
  return out;
}

const section = (id: number, items: number[][], out: number[]) => {
  const body: number[] = [];
  uleb(items.length, body);
  for (const item of items) for (const b of item) body.push(b);
  out.push(id); uleb(body.length, out);
  for (const b of body) out.push(b);
};
const thrower = () => { throw new Error("not callable while warming"); };
const grow = (t: WebAssembly.Table, n: number) => { if (t.length < n) t.grow(n - t.length); };

/** one table and memory that the modules a Worker warms share, with the warm word set */
export class WarmWorld {
  private readonly table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  private readonly refs = new WebAssembly.Table({ element: "externref", initial: 0 });
  private readonly mem = new WebAssembly.Memory({ initial: 1 });
  constructor() { new Int32Array(this.mem.buffer, WARM_AT, 1)[0] = 1; }
  /** Instantiates `module` (compiled from `bytes`) here and returns its first-tier methods in the module's order (a build module's table entries are its
   *  methods: Compiler.buildUnit); or why it cannot: an import without a default (a non-nullable global, a shared memory) */
  load(module: WebAssembly.Module, bytes: Uint8Array): WarmCall[] | string {
    const r = new Reader(bytes), imports: WebAssembly.Imports = {};
    const put = (mod: string, field: string, value: unknown) => { (imports[mod] ??= {})[field] = value as WebAssembly.ImportValue; };
    let types: Uint8Array | undefined, params: (Zero[] | undefined)[] = [], tableNeeds = 0;
    const funcTypes: number[] = [], entries: [number, number][] = [];
    const tags: number[][] = [], globals: number[][] = [], defined: [mod: string, field: string, kind: number, index: number][] = [];
    while (r.i < bytes.length) {
      const id = r.b[r.i++], end = r.u32() + r.i;
      if (id === 1) { types = bytes.subarray(r.i, end); params = funcParams(r); }
      else if (id === 2) for (let n = r.u32(); n > 0; n--) {
        const mod = r.name(), field = r.name(), kind = r.b[r.i++];
        if (kind === 0) {
          funcTypes.push(r.u32());
          if (mod !== "wasm:js-string") put(mod, field, mod === "host" && field in MATH_ARITY ? Math[field as keyof typeof MATH_ARITY] : thrower);
        } else if (kind === 1) {
          const elem = r.valtype().bytes[0], { min } = r.limits(), table = elem === 0x70 ? this.table : elem === 0x6f ? this.refs : undefined;
          if (!table) return "table type";
          grow(table, min); put(mod, field, table);
        } else if (kind === 2) {
          const { min, flags } = r.limits(), pages = this.mem.buffer.byteLength >> 16;
          if (flags & ~1) return "memory type";
          if (pages < min) this.mem.grow(min - pages);
          put(mod, field, this.mem);
        } else if (kind === 3) {
          const t = r.valtype(), mut = r.b[r.i++];
          if (mod === "#") continue;
          const init = t.bytes[0] === K.i32 ? [0x41, 0] : t.bytes[0] === K.i64 ? [0x42, 0] : t.bytes[0] === K.f32 ? [0x43, 0, 0, 0, 0] : t.bytes[0] === K.f64 ? [0x44, 0, 0, 0, 0, 0, 0, 0, 0]
            : t.heap && t.nullable ? [0xd0, ...t.heap] : undefined;
          if (!init) return "global type";
          defined.push([mod, field, 3, globals.length]); globals.push([...t.bytes, mut, ...init, 0x0b]);
        } else if (kind === 4) {
          r.i++;
          const tag = [0];
          uleb(r.u32(), tag);
          defined.push([mod, field, 4, tags.length]); tags.push(tag);
        } else return "import kind";
      }
      else if (id === 3) for (let n = r.u32(); n > 0; n--) funcTypes.push(r.u32());
      else if (id === 9) for (let n = r.u32(); n > 0; n--) {
        const flags = r.u32();
        if (flags !== 0 && flags !== 2 && flags !== 3) return "element segment";
        const table = flags === 2 ? r.u32() : 0;
        let offset = -1;
        if (flags !== 3) { if (r.b[r.i++] !== 0x41) return "element offset"; offset = r.s32(); r.i++; }
        if (flags !== 0) r.i++;
        const count = r.u32();
        for (let k = 0; k < count; k++) { const f = r.u32(); if (offset >= 0 && table === 0) entries.push([offset + k, f]); }
        if (offset >= 0 && table === 0) tableNeeds = Math.max(tableNeeds, offset + count);
      }
      r.i = end;
    }
    if (!types) return "no types";
    const calls: WarmCall[] = [];
    if (!entries.length) return calls;
    grow(this.table, tableNeeds);
    const shim = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1];
    uleb(types.length, shim);
    for (const b of types) shim.push(b);
    if (tags.length) section(13, tags, shim);
    if (globals.length) section(6, globals, shim);
    section(7, defined.map(([, , kind, index], i) => { const e: number[] = [], nm = String(i); uleb(nm.length, e); for (const c of nm) e.push(c.charCodeAt(0)); e.push(kind); uleb(index, e); return e; }), shim);
    const defaults = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(shim))).exports;
    defined.forEach(([mod, field], i) => put(mod, field, defaults[i]));
    new WebAssembly.Instance(module, imports);
    for (const [slot, f] of entries) {
      const args = params[funcTypes[f]];
      if (slot < COUNT_SLOTS && args) calls.push([slot, this.table.get(slot) as Function, args]);
    }
    return calls;
  }
}
