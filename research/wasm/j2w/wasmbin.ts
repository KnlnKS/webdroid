// Minimal WebAssembly binary builder (types incl. GC rec/sub, imports, funcs, tables, globals, tags, exports, elems, data).
// Written for the DEX->Wasm research prototype; emits bytes directly (no text, no binaryen).
export const enum T { i32 = 0x7f, i64 = 0x7e, f32 = 0x7d, f64 = 0x7c, v128 = 0x7b, i8 = 0x78, i16 = 0x77,
  funcref = 0x70, externref = 0x6f, anyref = 0x6e, eqref = 0x6d, i31ref = 0x6c, structref = 0x6b, arrayref = 0x6a, exnref = 0x69, nullref = 0x71 }
export function uleb(n: number | bigint, out: number[]): void {
  let v = BigInt(n);
  for (;;) { const b = Number(v & 0x7fn); v >>= 7n; if (v === 0n) { out.push(b); return; } out.push(b | 0x80); }
}
export function sleb(n: number | bigint, out: number[]): void {
  let v = BigInt(n);
  for (;;) {
    const b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) { out.push(b); return; }
    out.push(b | 0x80);
  }
}
const enc = new TextEncoder();
export function name(s: string, out: number[]): void { const b = enc.encode(s); uleb(b.length, out); for (const x of b) out.push(x); }

/** A value type: number for plain types, or {ref: idx, nullable} */
export type VT = number | { ht: number; nullable: boolean };
export const refNull = (idx: number): VT => ({ ht: idx, nullable: true });
export const ref = (idx: number): VT => ({ ht: idx, nullable: false });
export function vt(t: VT, out: number[]): void {
  if (typeof t === "number") { out.push(t); return; }
  out.push(t.nullable ? 0x63 : 0x64); sleb(t.ht, out);
}
export type StorageT = VT;
export interface FieldT { t: StorageT; mut: boolean }
export type TypeDef =
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
    const key = JSON.stringify([params, results]);
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

  private section(id: number, content: number[], out: number[]): void { out.push(id); uleb(content.length, out); for (let i = 0; i < content.length; i++) out.push(content[i]); }
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
    const out: number[] = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
    const vec = (items: number[][]): number[] => { const c: number[] = []; uleb(items.length, c); for (const it of items) for (const b of it) c.push(b); return c; };
    // types
    { const entries: number[][] = []; let i = 0;
      while (i < this.types.length) {
        let j = i; while (j < this.types.length && this.types[j].group === this.types[i].group) j++;
        const e: number[] = [];
        if (j - i > 1) { e.push(0x4e); uleb(j - i, e); }
        for (let k = i; k < j; k++) this.encodeTypeDef(this.types[k].def, e);
        entries.push(e); i = j;
      }
      this.section(1, vec(entries), out); }
    if (this.imports.length) this.section(2, vec(this.imports.map((im) => { const e: number[] = []; name(im.mod, e); name(im.name, e); e.push(...im.desc); return e; })), out);
    this.section(3, vec(this.funcTypes.map((t) => { const e: number[] = []; uleb(t, e); return e; })), out);
    if (this.tables.length) this.section(4, vec(this.tables), out);
    if (this.memories.length) this.section(5, vec(this.memories), out);
    if (this.tags.length) this.section(13, vec(this.tags), out);
    if (this.globals.length) this.section(6, vec(this.globals), out);
    if (this.exports.length) this.section(7, vec(this.exports.map((x) => { const e: number[] = []; name(x.name, e); e.push(x.kind); uleb(x.idx, e); return e; })), out);
    if (this.start >= 0) { const c: number[] = []; uleb(this.start, c); this.section(8, c, out); }
    if (this.elems.length) this.section(9, vec(this.elems), out);
    if (this.datas.length) { const c: number[] = []; uleb(this.datas.length, c); /* datacount section id 12 must precede code */ const dc: number[] = []; uleb(this.datas.length, dc); this.section(12, dc, out); }
    for (const cu of this.customs) { const c: number[] = []; name(cu.name, c); c.push(...cu.bytes); this.section(0, c, out); }
    this.section(10, vec(this.bodies.map((b) => { const e: number[] = []; uleb(b.length, e); for (let i = 0; i < b.length; i++) e.push(b[i]); return e; })), out);
    if (this.datas.length) this.section(11, vec(this.datas), out);
    // name section for function names (helps stack traces)
    const named = this.funcNames.map((n, i) => [i + this.nImportedFuncs, n] as const).filter(([, n]) => n);
    if (named.length) {
      const sub: number[] = []; uleb(named.length, sub);
      for (const [i, n] of named) { uleb(i, sub); name(n, sub); }
      const c: number[] = []; name("name", c); c.push(1); uleb(sub.length, c); c.push(...sub); this.section(0, c, out);
    }
    return Uint8Array.from(out);
  }
}
