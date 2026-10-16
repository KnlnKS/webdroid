// WebAssembly binary builder, including GC recursive types and subtypes.
export const T = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, i8: 0x78, i16: 0x77,
  funcref: 0x70, externref: 0x6f, anyref: 0x6e, eqref: 0x6d, i31ref: 0x6c, structref: 0x6b, arrayref: 0x6a, exnref: 0x69, nullref: 0x71 } as const;
export type T = (typeof T)[keyof typeof T];
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
function name(s: string, out: number[]): void {
  const start = out.length;
  uleb(s.length, out);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) {
      out.length = start;
      const b = enc.encode(s);
      uleb(b.length, out);
      for (let j = 0; j < b.length; j++) out.push(b[j]);
      return;
    }
    out.push(c);
  }
}

/** A value type: number for plain types, or {ref: idx, nullable} */
export type VT = number | { ht: number; nullable: boolean };
const vtKey = (t: VT): string => (typeof t === "number" ? String(t) : (t.nullable ? "n" : "r") + t.ht);
/** abstract heap types, as the negative type indices they encode as */
export const HT = { extern: -17, any: -18, eq: -19 } as const;
export const refNull = (idx: number): VT => ({ ht: idx, nullable: true });
export const ref = (idx: number): VT => ({ ht: idx, nullable: false });
export function vt(t: VT, out: number[]): void {
  if (typeof t === "number") { out.push(t); return; }
  out.push(t.nullable ? 0x63 : 0x64); sleb(t.ht, out);
}
interface FieldT { t: VT; mut: boolean }
export interface FunctionType { params: readonly VT[]; results: readonly VT[] }
const functionKey = (params: readonly VT[], results: readonly VT[]) => params.map(vtKey).join() + ">" + results.map(vtKey).join();
type TypeDef =
  | FunctionType & { k: "func"; sup?: number; final?: boolean }
  | { k: "struct"; fields: FieldT[]; sup?: number; final?: boolean }
  | { k: "array"; elem: FieldT; sup?: number; final?: boolean };

// Function-index immediates are tracked independently of DEX stack-trace offsets.
export type FuncBytes = number[] & { functionRefs?: number[] };
export function functionIndex(index: number, out: FuncBytes): void {
  (out.functionRefs ??= []).push(out.length); uleb(index, out);
}
function readIndex(bytes: number[], at: number): number {
  let value = 0, shift = 0, b: number;
  do { b = bytes[at++]; value += (b & 127) * 2 ** shift; shift += 7; } while (b & 128);
  return value;
}

export class ModuleBuilder {
  /** type entries; consecutive entries with the same group id form a rec group */
  types: { def: TypeDef; group: number }[] = [];
  private groups = 0;
  imports: { mod: string; name: string; kind: "func" | "memory" | "table" | "global" | "tag"; desc: number[]; signature?: FunctionType }[] = [];
  funcTypes: number[] = [];       // type idx per defined function
  bodies: FuncBytes[] = [];        // encoded bodies
  funcNames: string[] = [];
  /** after build(): module offset of each defined function's first body byte (its local declarations) */
  bodyOffsets: number[] = [];
  nImportedFuncs = 0; nImportedGlobals = 0; nImportedTags = 0; nImportedTables = 0;
  tables: number[][] = []; globals: number[][] = []; tags: number[] [] = [];
  exports: { name: string; kind: number; idx: number }[] = [];
  elems: FuncBytes[] = []; datas: number[][] = [];
  start = -1;

  /** add a type in the current (or given) rec group; returns its index */
  addType(def: TypeDef, group = ++this.groups): number { this.types.push({ def, group }); return this.types.length - 1; }
  addFuncType(params: readonly VT[], results: readonly VT[]): number {
    const key = functionKey(params, results);
    let i = this.fnTypeCache.get(key);
    if (i === undefined) { i = this.addType({ k: "func", params, results, final: true }); this.fnTypeCache.set(key, i); }
    return i;
  }
  private fnTypeCache = new Map<string, number>();

  importFunc(mod: string, nm: string, type: number | FunctionType): number {
    const d: number[] = [];
    if (typeof type === "number") { d.push(0x00); uleb(type, d); }
    this.imports.push({ mod, name: nm, kind: "func", desc: d, signature: typeof type === "number" ? undefined : type });
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
  addGlobal(t: VT, mut: boolean, init: number[]): number { const d: number[] = []; vt(t, d); d.push(mut ? 1 : 0); d.push(...init, 0x0b); this.globals.push(d); return this.nImportedGlobals + this.globals.length - 1; }
  addTag(type: number): number { const d: number[] = [0]; uleb(type, d); this.tags.push(d); return this.nImportedTags + this.tags.length - 1; }
  export(nm: string, kind: "func" | "table" | "memory" | "global" | "tag", idx: number): void { this.exports.push({ name: nm, kind: { func: 0, table: 1, memory: 2, global: 3, tag: 4 }[kind], idx }); }
  /** active element segment writing funcs at table[offset...] */
  addElemActive(table: number, offset: number, funcs: number[]): void {
    const d: number[] = [0x02]; uleb(table, d); d.push(0x41); sleb(offset, d); d.push(0x0b); d.push(0x00); uleb(funcs.length, d); for (const f of funcs) functionIndex(f, d); this.elems.push(d);
  }
  addElemDeclare(funcs: number[]): void { if (!funcs.length) return; const d: number[] = [0x03, 0x00]; uleb(funcs.length, d); for (const f of funcs) functionIndex(f, d); this.elems.push(d); }
  addDataPassive(bytes: Uint8Array | number[]): number { const d: number[] = [0x01]; uleb(bytes.length, d); for (const b of bytes) d.push(b); this.datas.push(d); return this.datas.length - 1; }

  private encodeTypeDef(d: TypeDef, out: number[]): void {
    if (d.sup !== undefined || d.final === false) { out.push(d.final === false ? 0x50 : 0x4f); uleb(d.sup !== undefined ? 1 : 0, out); if (d.sup !== undefined) uleb(d.sup, out); }
    switch (d.k) {
      case "func": out.push(0x60); uleb(d.params.length, out); for (const p of d.params) vt(p, out); uleb(d.results.length, out); for (const r of d.results) vt(r, out); break;
      case "struct": out.push(0x5f); uleb(d.fields.length, out); for (const f of d.fields) { vt(f.t, out); out.push(f.mut ? 1 : 0); } break;
      case "array": out.push(0x5e); vt(d.elem.t, out); out.push(d.elem.mut ? 1 : 0); break;
    }
  }
  build(compactImports = false): Uint8Array {
    let imports = this.imports, imported = this.nImportedFuncs;
    let index = (f: number) => f;
    // Raw bodies or global initializers (ref.func) can contain untracked function references.
    if (compactImports && !this.globals.some(g => g.includes(0xd2)) && this.bodies.every(b => b.functionRefs) && this.elems.every(b => b.functionRefs)) {
      const used = new Set<number>();
      for (const group of [this.bodies, this.elems]) for (const b of group) for (const at of b.functionRefs!) { const f = readIndex(b, at); if (f < this.nImportedFuncs) used.add(f); }
      for (const e of this.exports) if (e.kind === 0) used.add(e.idx);
      if (this.start >= 0) used.add(this.start);
      const indices = new Map<number, number>();
      let old = 0; imported = 0;
      imports = this.imports.filter(im => {
        if (im.kind !== "func") return true;
        const keep = used.has(old);
        if (keep) indices.set(old, imported++);
        old++; return keep;
      });
      const removed = this.nImportedFuncs - imported;
      index = f => f < this.nImportedFuncs ? indices.get(f)! : f - removed;
    }
    // Deferred import signatures never enter the module's type section unless the import survives.
    let types = this.types, nextGroup = this.groups;
    const signatures = new Map<FunctionType, number>(), added = new Map<string, number>();
    for (const im of imports) if (im.signature && !signatures.has(im.signature)) {
      const signature = im.signature, key = functionKey(signature.params, signature.results);
      let type = this.fnTypeCache.get(key) ?? added.get(key);
      if (type === undefined) {
        if (types === this.types) types = types.slice();
        type = types.length; added.set(key, type);
        types.push({ def: { k: "func", ...signature, final: true }, group: ++nextGroup });
      }
      signatures.set(signature, type);
    }
    // Bodies whose function indices move are patched where they land in the output: [offset, index] pairs.
    const moved = new Set<FuncBytes>(), fixes: number[] = [];
    const relocate = (body: FuncBytes): ArrayLike<number> => {
      if (imported !== this.nImportedFuncs && body.functionRefs?.length) moved.add(body);
      return body;
    };
    const parts: ArrayLike<number>[] = [[0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]];
    let size = 8;
    const put = (a: ArrayLike<number>) => {
      if (moved.has(a as FuncBytes)) for (const at of (a as FuncBytes).functionRefs!) fixes.push(size + at, index(readIndex(a as FuncBytes, at)));
      parts.push(a); size += a.length;
    };
    /** a section: its id, the length of its parts, then the parts */
    const section = (id: number, body: ArrayLike<number>[]) => {
      let len = 0;
      for (const p of body) len += p.length;
      const h: number[] = [id]; uleb(len, h); put(h);
      for (const p of body) put(p);
    };
    const count = (n: number): number[] => { const c: number[] = []; uleb(n, c); return c; };
    const vec = (id: number, items: ArrayLike<number>[]) => section(id, [count(items.length), ...items]);
    {
      let groups = 0;
      for (let i = 0; i < types.length; i++) if (!i || types[i].group !== types[i - 1].group) groups++;
      const entries = count(groups);
      for (let i = 0; i < types.length;) {
        let j = i + 1; while (j < types.length && types[j].group === types[i].group) j++;
        if (j - i > 1) { entries.push(0x4e); uleb(j - i, entries); }
        for (; i < j; i++) this.encodeTypeDef(types[i].def, entries);
      }
      section(1, [entries]);
    }
    if (imports.length) {
      const modules = new Map<string, number[]>(), entries = count(imports.length);
      for (const im of imports) {
        let prefix = modules.get(im.mod);
        if (!prefix) { prefix = []; name(im.mod, prefix); modules.set(im.mod, prefix); }
        for (const x of prefix) entries.push(x);
        name(im.name, entries);
        if (im.signature) { entries.push(0x00); uleb(signatures.get(im.signature)!, entries); }
        else for (const x of im.desc) entries.push(x);
      }
      section(2, [entries]);
    }
    const functions = count(this.funcTypes.length);
    for (const t of this.funcTypes) uleb(t, functions);
    section(3, [functions]);
    if (this.tables.length) vec(4, this.tables);
    if (this.tags.length) vec(13, this.tags);
    if (this.globals.length) vec(6, this.globals);
    if (this.exports.length) {
      const entries = count(this.exports.length);
      for (const x of this.exports) { name(x.name, entries); entries.push(x.kind); uleb(x.kind === 0 ? index(x.idx) : x.idx, entries); }
      section(7, [entries]);
    }
    if (this.start >= 0) section(8, [count(index(this.start))]);
    if (this.elems.length) vec(9, this.elems.map(relocate));
    // the data count section precedes the code
    if (this.datas.length) section(12, [count(this.datas.length)]);
    {
      // the code section is built by hand: a body's offset is where its local declarations begin
      const lens = this.bodies.map((b) => { const l: number[] = []; uleb(b.length, l); return l; });
      let len = count(this.bodies.length).length;
      for (let i = 0; i < this.bodies.length; i++) len += lens[i].length + this.bodies[i].length;
      const h: number[] = [10]; uleb(len, h); put(h); put(count(this.bodies.length));
      this.bodyOffsets = [];
      for (let i = 0; i < this.bodies.length; i++) { put(lens[i]); this.bodyOffsets.push(size); put(relocate(this.bodies[i])); }
    }
    if (this.datas.length) vec(11, this.datas);
    // name section for function names (helps stack traces)
    let named = 0;
    for (const n of this.funcNames) if (n) named++;
    if (named) {
      const sub = count(named);
      for (let i = 0; i < this.funcNames.length; i++) if (this.funcNames[i]) { uleb(i + imported, sub); name(this.funcNames[i], sub); }
      const c: number[] = []; name("name", c); c.push(1); uleb(sub.length, c);
      section(0, [c, sub]);
    }
    const out = new Uint8Array(size);
    let at = 0;
    // TypedArray.set from a JS array costs several times an indexed copy below about 16 elements, and a third of it above
    for (const p of parts) {
      if (p.length > 16) { out.set(p, at); at += p.length; } else for (let i = 0; i < p.length; i++) out[at++] = p[i];
    }
    for (let k = 0; k < fixes.length; k += 2) {
      let i = fixes[k], value = fixes[k + 1];
      // Preserve immediate widths so stack-trace marks within a body stay valid.
      while (out[i] & 128) { out[i++] = (value & 127) | 128; value = Math.floor(value / 128); }
      out[i] = value;
    }
    return out;
  }
}
