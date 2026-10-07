// Minimal WebAssembly binary builder (types incl. GC rec/sub, imports, funcs, tables, globals, tags, exports, elems, data).
// Written for the DEX->Wasm research prototype; emits bytes directly (no text, no binaryen).
export const enum T { i32 = 0x7f, i64 = 0x7e, f32 = 0x7d, f64 = 0x7c, v128 = 0x7b, i8 = 0x78, i16 = 0x77,
  funcref = 0x70, externref = 0x6f, anyref = 0x6e, eqref = 0x6d, i31ref = 0x6c, structref = 0x6b, arrayref = 0x6a, exnref = 0x69, nullref = 0x71 }
export function uleb(n: number | bigint, out: number[]): void {
  if (typeof n === "number" && n >= 0 && n <= 0xffffffff) {
    for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
    out.push(n);
    return;
  }
  let v = BigInt(n);
  for (;;) { const b = Number(v & 0x7fn); v >>= 7n; if (v === 0n) { out.push(b); return; } out.push(b | 0x80); }
}
export function sleb(n: number | bigint, out: number[]): void {
  if (typeof n === "number" && n >= -0x80000000 && n <= 0x7fffffff) {
    for (;;) {
      const b = n & 0x7f;
      n >>= 7;
      if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return; }
      out.push(b | 0x80);
    }
  }
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { out.push(b); return; }
    out.push(b | 0x80);
  }
}
const enc = new TextEncoder();
export function name(s: string, out: number[]): void {
  const b = enc.encode(s);
  uleb(b.length, out);
  for (let i = 0; i < b.length; i++) out.push(b[i]);
}

/** A value type: number for plain types, or {ref: idx, nullable} */
export type VT = number | { ht: number; nullable: boolean };
export const vtKey = (t: VT): string => (typeof t === "number" ? String(t) : (t.nullable ? "n" : "r") + t.ht);
export const refNull = (idx: number): VT => ({ ht: idx, nullable: true });
export const ref = (idx: number): VT => ({ ht: idx, nullable: false });
export function vt(t: VT, out: number[]): void {
  if (typeof t === "number") { out.push(t); return; }
  out.push(t.nullable ? 0x63 : 0x64); sleb(t.ht, out);
}
type StorageT = VT;
interface FieldT { t: StorageT; mut: boolean }
type TypeDef =
  | { k: "func"; params: VT[]; results: VT[]; sup?: number; final?: boolean }
  | { k: "struct"; fields: FieldT[]; sup?: number; final?: boolean }
  | { k: "array"; elem: FieldT; sup?: number; final?: boolean };

export class ModuleBuilder {
  /** type entries; consecutive entries with the same group id form a rec group */
  types: { def: TypeDef; group: number }[] = [];
  private groups = 0;
  imports: { mod: string; name: string; kind: "func" | "memory" | "table" | "global" | "tag"; desc: number[] }[] = [];
  funcTypes: number[] = [];       // type idx per defined function
  bodies: number[][] = [];        // encoded bodies
  funcNames: string[] = [];
  /** after build(): module offset of each defined function's first body byte (its local declarations) */
  bodyOffsets: number[] = [];
  nImportedFuncs = 0; nImportedGlobals = 0; nImportedTags = 0; nImportedTables = 0;
  tables: number[][] = []; memories: number[][] = []; globals: number[][] = []; tags: number[] [] = [];
  exports: { name: string; kind: number; idx: number }[] = [];
  elems: number[][] = []; datas: number[][] = []; declaredFuncs = new Set<number>();
  customs: { name: string; bytes: number[] }[] = [];
  start = -1;

  newGroup(): number { return ++this.groups; }
  /** add a type in the current (or given) rec group; returns its index */
  addType(def: TypeDef, group = ++this.groups): number { this.types.push({ def, group }); return this.types.length - 1; }
  addFuncType(params: VT[], results: VT[]): number {
    const key = params.map(vtKey).join() + ">" + results.map(vtKey).join();
    let i = this.fnTypeCache.get(key);
    if (i === undefined) { i = this.addType({ k: "func", params, results, final: true }); this.fnTypeCache.set(key, i); }
    return i;
  }
  private fnTypeCache = new Map<string, number>();

  importFunc(mod: string, nm: string, type: number): number {
    const d: number[] = [0x00]; uleb(type, d);
    this.imports.push({ mod, name: nm, kind: "func", desc: d });
    return this.nImportedFuncs++;
  }
  importMemory(mod: string, nm: string, min: number, max?: number, shared = false): void {
    const d: number[] = [0x02, (max === undefined ? 0 : 1) | (shared ? 2 : 0)]; uleb(min, d); if (max !== undefined) uleb(max, d);
    this.imports.push({ mod, name: nm, kind: "memory", desc: d });
  }
  importTable(mod: string, nm: string, elem: VT, min: number): number {
    const d: number[] = [0x01]; vt(elem, d); d.push(0); uleb(min, d);
    this.imports.push({ mod, name: nm, kind: "table", desc: d }); return this.nImportedTables++;
  }
  importTag(mod: string, nm: string, type: number): number {
    const d: number[] = [0x04, 0]; uleb(type, d);
    this.imports.push({ mod, name: nm, kind: "tag", desc: d }); return this.nImportedTags++;
  }
  importGlobal(mod: string, nm: string, t: VT, mut: boolean): number {
    const d: number[] = [0x03]; vt(t, d); d.push(mut ? 1 : 0);
    this.imports.push({ mod, name: nm, kind: "global", desc: d }); return this.nImportedGlobals++;
  }
  addFunc(type: number, body: number[], nm = ""): number {
    this.funcTypes.push(type); this.bodies.push(body); this.funcNames.push(nm);
    return this.nImportedFuncs + this.funcTypes.length - 1;
  }
  /** reserve a function index to be filled later */
  reserveFunc(type: number, nm = ""): number { return this.addFunc(type, [], nm); }
  setBody(idx: number, body: number[]): void { this.bodies[idx - this.nImportedFuncs] = body; }
  addTable(elem: VT, min: number): number { const d: number[] = []; vt(elem, d); d.push(0); uleb(min, d); this.tables.push(d); return this.nImportedTables + this.tables.length - 1; }
  addMemory(min: number, max?: number): number { const d: number[] = [max === undefined ? 0 : 1]; uleb(min, d); if (max !== undefined) uleb(max, d); this.memories.push(d); return this.memories.length - 1; }
  addGlobal(t: VT, mut: boolean, init: number[]): number { const d: number[] = []; vt(t, d); d.push(mut ? 1 : 0); d.push(...init, 0x0b); this.globals.push(d); return this.nImportedGlobals + this.globals.length - 1; }
  addTag(type: number): number { const d: number[] = [0]; uleb(type, d); this.tags.push(d); return this.nImportedTags + this.tags.length - 1; }
  export(nm: string, kind: "func" | "table" | "memory" | "global" | "tag", idx: number): void { this.exports.push({ name: nm, kind: { func: 0, table: 1, memory: 2, global: 3, tag: 4 }[kind], idx }); }
  /** active element segment writing funcs at table[offset...] */
  addElemActive(table: number, offset: number, funcs: number[]): void {
    const d: number[] = [0x02]; uleb(table, d); d.push(0x41); sleb(offset, d); d.push(0x0b); d.push(0x00); uleb(funcs.length, d); for (const f of funcs) uleb(f, d); this.elems.push(d);
  }
  addElemDeclare(funcs: number[]): void { if (!funcs.length) return; const d: number[] = [0x03, 0x00]; uleb(funcs.length, d); for (const f of funcs) uleb(f, d); this.elems.push(d); }
  addDataPassive(bytes: Uint8Array | number[]): number { const d: number[] = [0x01]; uleb(bytes.length, d); for (const b of bytes) d.push(b); this.datas.push(d); return this.datas.length - 1; }
  addDataActive(mem: number, offset: number, bytes: Uint8Array | number[]): void { const d: number[] = [0x02]; uleb(mem, d); d.push(0x41); sleb(offset, d); d.push(0x0b); uleb(bytes.length, d); for (const b of bytes) d.push(b); this.datas.push(d); }
  addCustom(nm: string, bytes: number[]): void { this.customs.push({ name: nm, bytes }); }

  private encodeTypeDef(d: TypeDef, out: number[]): void {
    const subbed = d.sup !== undefined || d.final === false;
    if (subbed) { out.push(d.final === false || d.sup !== undefined ? (d.final === false ? 0x50 : 0x4f) : 0x4f); uleb(d.sup !== undefined ? 1 : 0, out); if (d.sup !== undefined) uleb(d.sup, out); }
    switch (d.k) {
      case "func": out.push(0x60); uleb(d.params.length, out); for (const p of d.params) vt(p, out); uleb(d.results.length, out); for (const r of d.results) vt(r, out); break;
      case "struct": out.push(0x5f); uleb(d.fields.length, out); for (const f of d.fields) { vt(f.t, out); out.push(f.mut ? 1 : 0); } break;
      case "array": out.push(0x5e); vt(d.elem.t, out); out.push(d.elem.mut ? 1 : 0); break;
    }
  }
  build(): Uint8Array {
    const parts: ArrayLike<number>[] = [Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0)];
    let size = 8;
    const put = (a: ArrayLike<number>) => { parts.push(a); size += a.length; };
    /** a section: its id, the length of its parts, then the parts */
    const section = (id: number, body: ArrayLike<number>[]) => {
      let len = 0;
      for (const p of body) len += p.length;
      const h: number[] = [id]; uleb(len, h); put(h);
      for (const p of body) put(p);
    };
    const count = (n: number): number[] => { const c: number[] = []; uleb(n, c); return c; };
    const vec = (id: number, items: ArrayLike<number>[]) => section(id, [count(items.length), ...items]);
    // types
    { const entries: number[][] = []; let i = 0;
      while (i < this.types.length) {
        let j = i; while (j < this.types.length && this.types[j].group === this.types[i].group) j++;
        const e: number[] = [];
        if (j - i > 1) { e.push(0x4e); uleb(j - i, e); }
        for (let k = i; k < j; k++) this.encodeTypeDef(this.types[k].def, e);
        entries.push(e); i = j;
      }
      vec(1, entries); }
    if (this.imports.length) {
      const modules = new Map<string, number[]>();
      vec(2, this.imports.map(im => {
        let prefix = modules.get(im.mod);
        if (!prefix) { prefix = []; name(im.mod, prefix); modules.set(im.mod, prefix); }
        const e = prefix.slice(); name(im.name, e);
        for (const x of im.desc) e.push(x);
        return e;
      }));
    }
    vec(3, this.funcTypes.map((t) => { const e: number[] = []; uleb(t, e); return e; }));
    if (this.tables.length) vec(4, this.tables);
    if (this.memories.length) vec(5, this.memories);
    if (this.tags.length) vec(13, this.tags);
    if (this.globals.length) vec(6, this.globals);
    if (this.exports.length) vec(7, this.exports.map((x) => { const e: number[] = []; name(x.name, e); e.push(x.kind); uleb(x.idx, e); return e; }));
    if (this.start >= 0) section(8, [count(this.start)]);
    if (this.elems.length) vec(9, this.elems);
    // the data count section precedes the code
    if (this.datas.length) section(12, [count(this.datas.length)]);
    for (const cu of this.customs) { const c: number[] = []; name(cu.name, c); section(0, [c, cu.bytes]); }
    {
      // the code section is built by hand: a body's offset is where its local declarations begin
      const lens = this.bodies.map((b) => { const l: number[] = []; uleb(b.length, l); return l; });
      let len = count(this.bodies.length).length;
      for (let i = 0; i < this.bodies.length; i++) len += lens[i].length + this.bodies[i].length;
      const h: number[] = [10]; uleb(len, h); put(h); put(count(this.bodies.length));
      this.bodyOffsets = [];
      for (let i = 0; i < this.bodies.length; i++) { put(lens[i]); this.bodyOffsets.push(size); put(this.bodies[i]); }
    }
    if (this.datas.length) vec(11, this.datas);
    // name section for function names (helps stack traces)
    const named = this.funcNames.map((n, i) => [i + this.nImportedFuncs, n] as const).filter(([, n]) => n);
    if (named.length) {
      const sub: number[] = []; uleb(named.length, sub);
      for (const [i, n] of named) { uleb(i, sub); name(n, sub); }
      const c: number[] = []; name("name", c); c.push(1); uleb(sub.length, c);
      section(0, [c, sub]);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p as ArrayLike<number> as Uint8Array, at); at += p.length; }
    return out;
  }
}
