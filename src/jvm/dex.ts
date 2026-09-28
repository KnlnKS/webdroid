// DEX file parser. Format: https://source.android.com/docs/core/runtime/dex-format
// Everything lazy + cached; hot lookups are index math on a DataView.

import { decodeModifiedUtf8, descToName } from "./abi";

export const NO_INDEX = 0xffffffff;

export const isDexEntry = (name: string): boolean => /^classes\d*\.dex$/.test(name);

/** The logical dex files in one physical file. Before v41 that is always exactly one; the v41
 *  container format (Android 15) packs several into a file and is what an apk built against a
 *  current SDK now ships, so a reader that assumes one header sees only the first classes'
 *  worth and silently misses the rest. */
export function dexesIn(bytes: Uint8Array, name = "classes.dex"): DexFile[] {
  const out: DexFile[] = [];
  for (let off = 0; ;) {
    const d = new DexFile(bytes, out.length ? `${name}!${out.length}` : name, off);
    out.push(d);
    const next = off + d.fileSize;
    if (d.version < 41 || !d.fileSize || next + 112 > bytes.length || next >= d.containerSize) break;
    off = next;
  }
  return out;
}

interface FieldRef { cls: number; type: number; name: string; }
interface ProtoRef { shorty: string; ret: number; params: number[]; }
interface MethodRef { cls: number; proto: number; name: string; }

interface EncodedField { fieldIdx: number; flags: number; }
export interface EncodedMethod { methodIdx: number; flags: number; codeOff: number; }

export interface ClassDef {
  typeIdx: number; flags: number; superIdx: number; interfaces: number[];
  staticFields: EncodedField[]; instanceFields: EncodedField[];
  directMethods: EncodedMethod[]; virtualMethods: EncodedMethod[];
  staticValuesOff: number;
  annotationsOff: number;
  dex: DexFile;
}

// `dex` because element values reference types/enums by index into the dex they came from
export interface EncAnnotation { visibility: number; type: string; elements: Record<string, EncVal>; dex: DexFile; }

interface TryItem { start: number; end: number; handlers: [number, number][]; catchAllAddr: number; }

export interface CodeItem {
  regs: number; ins: number;
  insns: Uint16Array;   // code units
  tries: TryItem[];
}

// encoded_value results: numbers, bigints, strings, null, or tagged refs
export type EncVal = number | bigint | string | boolean | null | EncVal[] |
  { kind: "type" | "field" | "method" | "enum" | "proto" | "mhandle"; idx: number } |
  { kind: "annotation"; anno: EncAnnotation };

/** method_handle_item: what the handle points at, and which field/method id */
interface MethodHandleRef { type: number; idx: number; }
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

class Reader {
  constructor(public bytes: Uint8Array, public pos: number) {}
  u8(): number { return this.bytes[this.pos++]; }
  uleb(): number {
    let result = 0, shift = 0, b: number;
    do { b = this.bytes[this.pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return result >>> 0;
  }
  sleb(): number {
    let result = 0, shift = 0, b: number;
    do { b = this.bytes[this.pos++]; result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    if (shift < 32 && (b & 0x40)) result |= -1 << shift;
    return result;
  }
}

const CACHE_PAGE_SHIFT = 7;
const CACHE_PAGE_SIZE = 1 << CACHE_PAGE_SHIFT;
const CACHE_PAGE_MASK = CACHE_PAGE_SIZE - 1;

class PagedCache<T> {
  private pages: (T[] | undefined)[];
  constructor(readonly length: number) { this.pages = new Array(Math.ceil(length / CACHE_PAGE_SIZE)); }
  get(i: number): T | undefined { return this.pages[i >>> CACHE_PAGE_SHIFT]?.[i & CACHE_PAGE_MASK]; }
  set(i: number, value: T): void {
    (this.pages[i >>> CACHE_PAGE_SHIFT] ??= new Array<T>(CACHE_PAGE_SIZE))[i & CACHE_PAGE_MASK] = value;
  }
}

export class DexFile {
  view: DataView;
  private stringIdsOff: number; private typeIdsOff: number; private protoIdsOff: number;
  private fieldIdsOff: number; private methodIdsOff: number;
  classDefCount: number; private classDefsOff: number;
  private mapOff: number;
  /** map_list sections, resolved on first use: call_site_ids and method_handles live only here */
  private sections?: Map<number, { size: number; off: number }>;
  stringCount: number; typeCount: number;
  version: number; fileSize: number; containerSize: number;

  private stringCache: (string | undefined)[];
  private typeCache: (string | undefined)[];
  private protoCache: (ProtoRef | undefined)[];
  private fieldCache: PagedCache<FieldRef>;
  private methodCache: PagedCache<MethodRef>;

  /** the header's SHA-1 signature: names this dex's contents across page loads */
  readonly id: string;
  get cachedStrings(): readonly (string | undefined)[] { return this.stringCache; }

  /** `headerOff` is where this logical dex's header sits inside the physical file. It is 0 for
   *  everything before v41; a v41 container holds several headers and their section offsets are
   *  relative to the CONTAINER, so every dex in one keeps the whole buffer and only the header
   *  moves. That is also why nothing below this constructor needs to know about containers. */
  constructor(public bytes: Uint8Array, public name = "classes.dex", headerOff = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    const h = headerOff;
    const magic = String.fromCharCode(...bytes.subarray(h, h + 4));
    if (magic !== "dex\n") throw new Error(`bad dex magic in ${name}`);
    this.version = Number(String.fromCharCode(...bytes.subarray(h + 4, h + 7))) || 0;
    this.fileSize = v.getUint32(h + 32, true);
    this.id = Array.from(bytes.subarray(h + 12, h + 32), (b) => b.toString(16).padStart(2, "0")).join("") + (h ? "@" + h : "");
    this.containerSize = this.version >= 41 ? v.getUint32(h + 112, true) : this.fileSize;
    this.stringCount = v.getUint32(h + 56, true); this.stringIdsOff = v.getUint32(h + 60, true);
    this.typeCount = v.getUint32(h + 64, true); this.typeIdsOff = v.getUint32(h + 68, true);
    this.protoIdsOff = v.getUint32(h + 76, true);
    this.fieldIdsOff = v.getUint32(h + 84, true);
    this.methodIdsOff = v.getUint32(h + 92, true);
    this.classDefCount = v.getUint32(h + 96, true); this.classDefsOff = v.getUint32(h + 100, true);
    this.mapOff = v.getUint32(h + 52, true);
    const protoCount = v.getUint32(h + 72, true), fieldCount = v.getUint32(h + 80, true), methodCount = v.getUint32(h + 88, true);
    this.stringCache = new Array(this.stringCount);
    this.typeCache = new Array(this.typeCount);
    this.protoCache = new Array(protoCount);
    this.fieldCache = new PagedCache(fieldCount);
    this.methodCache = new PagedCache(methodCount);

    // Validate up front: otherwise a truncated or byte-swapped file surfaces as a RangeError
    // from a DataView deep inside a lookup, naming neither the file nor the cause.
    // The checksum and SHA-1 are deliberately NOT verified: they cost an adler32 and a SHA-1
    // over every megabyte of every dex on every boot, and the zip these came out of already
    // CRC'd the same bytes.
    const endian = v.getUint32(h + 40, true);
    if (endian !== 0x12345678) {
      throw new Error(`${name}: endian_tag 0x${endian.toString(16)}${endian === 0x78563412 ? " — a byte-swapped dex" : ""}`);
    }
    if (this.version < 35 || this.version > 41) throw new Error(`${name}: dex version ${this.version || "?"} is not one this reads`);
    const headerSize = v.getUint32(h + 36, true);
    if (headerSize !== (this.version >= 41 ? 120 : 112)) throw new Error(`${name}: header_size ${headerSize} for version ${this.version}`);
    for (const [what, count, off, stride] of [
      ["string_ids", this.stringCount, this.stringIdsOff, 4], ["type_ids", this.typeCount, this.typeIdsOff, 4],
      ["proto_ids", protoCount, this.protoIdsOff, 12], ["field_ids", fieldCount, this.fieldIdsOff, 8],
      ["method_ids", methodCount, this.methodIdsOff, 8], ["class_defs", this.classDefCount, this.classDefsOff, 32],
    ] as [string, number, number, number][]) {
      if (count && off + count * stride > bytes.length) throw new Error(`${name}: ${what} runs past the file (${count} at ${off}, file ${bytes.length})`);
    }
  }

  stringLen(i: number): number {
    return new Reader(this.bytes, this.view.getUint32(this.stringIdsOff + i * 4, true)).uleb();
  }
  string(i: number): string {
    let s = this.stringCache[i];
    if (s === undefined) {
      const off = this.view.getUint32(this.stringIdsOff + i * 4, true);
      const r = new Reader(this.bytes, off);
      const len = r.uleb();
      s = this.stringCache[i] = decodeModifiedUtf8(this.bytes, r.pos, this.bytes.length, len);
    }
    return s;
  }

  /** type descriptor, e.g. "Ljava/lang/String;" or "[I" */
  type(i: number): string {
    let s = this.typeCache[i];
    if (s === undefined) {
      s = this.typeCache[i] = this.string(this.view.getUint32(this.typeIdsOff + i * 4, true));
    }
    return s;
  }

  proto(i: number): ProtoRef {
    let p = this.protoCache[i];
    if (p === undefined) {
      const off = this.protoIdsOff + i * 12;
      const shorty = this.string(this.view.getUint32(off, true));
      const ret = this.view.getUint32(off + 4, true);
      const paramsOff = this.view.getUint32(off + 8, true);
      const params: number[] = [];
      if (paramsOff) {
        const n = this.view.getUint32(paramsOff, true);
        for (let j = 0; j < n; j++) params.push(this.view.getUint16(paramsOff + 4 + j * 2, true));
      }
      p = this.protoCache[i] = { shorty, ret, params };
    }
    return p;
  }

  field(i: number): FieldRef {
    let f = this.fieldCache.get(i);
    if (f === undefined) {
      const off = this.fieldIdsOff + i * 8;
      f = {
        cls: this.view.getUint16(off, true),
        type: this.view.getUint16(off + 2, true),
        name: this.string(this.view.getUint32(off + 4, true)),
      };
      this.fieldCache.set(i, f);
    }
    return f;
  }

  get methodCount(): number { return this.methodCache.length; }
  *methodsOf(descriptor: string): Generator<number> {
    const owner = (i: number) => this.type(this.view.getUint16(this.methodIdsOff + i * 8, true));
    // DEX method_ids sort by type_idx; type_ids sort by their UTF-16 descriptors.
    let lo = 0, hi = this.methodCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (owner(mid) < descriptor) lo = mid + 1;
      else hi = mid;
    }
    for (; lo < this.methodCount && owner(lo) === descriptor; lo++) yield lo;
  }
  method(i: number): MethodRef {
    let m = this.methodCache.get(i);
    if (m === undefined) {
      const off = this.methodIdsOff + i * 8;
      m = {
        cls: this.view.getUint16(off, true),
        proto: this.view.getUint16(off + 2, true),
        name: this.string(this.view.getUint32(off + 4, true)),
      };
      this.methodCache.set(i, m);
    }
    return m;
  }

  /** type idx of class_def i without parsing the whole def */
  classDef2Type(i: number): number {
    return this.view.getUint32(this.classDefsOff + i * 32, true);
  }

  private descCache: (string | undefined)[] = [];
  private paramTypeCache: (string[] | undefined)[] = [];
  /** full descriptor "(params)ret" of method index i */
  methodDesc(i: number): string {
    const pi = this.method(i).proto;
    let d = this.descCache[pi];
    if (d === undefined) {
      const p = this.proto(pi);
      d = this.descCache[pi] = "(" + this.protoParamTypes(pi).join("") + ")" + this.type(p.ret);
    }
    return d;
  }
  protoParamTypes(i: number): string[] {
    return this.paramTypeCache[i] ??= this.proto(i).params.map((t) => this.type(t));
  }

  classDef(i: number): ClassDef {
    const off = this.classDefsOff + i * 32;
    const v = this.view;
    const typeIdx = v.getUint32(off, true);
    const flags = v.getUint32(off + 4, true);
    const superIdx = v.getUint32(off + 8, true);
    const interfacesOff = v.getUint32(off + 12, true);
    const classDataOff = v.getUint32(off + 24, true);
    const interfaces: number[] = [];
    if (interfacesOff) {
      const n = v.getUint32(interfacesOff, true);
      for (let j = 0; j < n; j++) interfaces.push(v.getUint16(interfacesOff + 4 + j * 2, true));
    }
    const def: ClassDef = {
      typeIdx, flags, superIdx, interfaces,
      staticFields: [], instanceFields: [], directMethods: [], virtualMethods: [],
      staticValuesOff: v.getUint32(off + 28, true), annotationsOff: v.getUint32(off + 20, true), dex: this,
    };
    if (classDataOff) {
      const r = new Reader(this.bytes, classDataOff);
      const ns = r.uleb(), ni = r.uleb(), nd = r.uleb(), nv = r.uleb();
      const list = <T>(n: number, out: T[], mk: (idx: number) => T) => { for (let j = 0, idx = 0; j < n; j++) out.push(mk(idx += r.uleb())); };
      list(ns, def.staticFields, (fieldIdx) => ({ fieldIdx, flags: r.uleb() }));
      list(ni, def.instanceFields, (fieldIdx) => ({ fieldIdx, flags: r.uleb() }));
      list(nd, def.directMethods, (methodIdx) => ({ methodIdx, flags: r.uleb(), codeOff: r.uleb() }));
      list(nv, def.virtualMethods, (methodIdx) => ({ methodIdx, flags: r.uleb(), codeOff: r.uleb() }));
    }
    return def;
  }

  /** annotations for a class_def: the class's own, and per field, method and method PARAMETER */
  classAnnotations(def: ClassDef): { cls: EncAnnotation[]; methods: Map<number, EncAnnotation[]>; fields: Map<number, EncAnnotation[]>; params: Map<number, EncAnnotation[][]> } {
    const out = { cls: [] as EncAnnotation[], methods: new Map<number, EncAnnotation[]>(), fields: new Map<number, EncAnnotation[]>(), params: new Map<number, EncAnnotation[][]>() };
    const dir = def.annotationsOff;
    if (!dir) return out;
    const v = this.view;
    const classAnnoOff = v.getUint32(dir, true);
    const fieldsSize = v.getUint32(dir + 4, true);
    const methodsSize = v.getUint32(dir + 8, true);
    if (classAnnoOff) out.cls = this.annotationSet(classAnnoOff);
    let p = dir + 16;
    for (const [n, into] of [[fieldsSize, out.fields], [methodsSize, out.methods]] as const) {
      for (let i = 0; i < n; i++, p += 8) into.set(v.getUint32(p, true), this.annotationSet(v.getUint32(p + 4, true)));
    }
    // annotated_parameters: one annotation_set_ref_list per method, one set per parameter.
    // Retrofit, Dagger and Jackson read nothing else — @Query, @Named, @JsonProperty are all here.
    const paramsSize = v.getUint32(dir + 12, true);
    for (let i = 0; i < paramsSize; i++) {
      const methodIdx = v.getUint32(p, true);
      const listOff = v.getUint32(p + 4, true);
      p += 8;
      if (!listOff) continue;
      const n = v.getUint32(listOff, true);
      const per: EncAnnotation[][] = [];
      for (let k = 0; k < n; k++) per.push(this.annotationSet(v.getUint32(listOff + 4 + k * 4, true)));
      out.params.set(methodIdx, per);
    }
    return out;
  }

  private annotationSet(off: number): EncAnnotation[] {
    if (!off) return [];
    const v = this.view;
    const size = v.getUint32(off, true);
    const out: EncAnnotation[] = [];
    for (let i = 0; i < size; i++) {
      const itemOff = v.getUint32(off + 4 + i * 4, true);
      // annotation_item: visibility(u8) + encoded_annotation
      const r = new Reader(this.bytes, itemOff + 1);
      const annotation = this.encodedAnnotation(r); annotation.visibility = this.bytes[itemOff]; out.push(annotation);
    }
    return out;
  }

  private encodedAnnotation(r: Reader): EncAnnotation {
    const typeIdx = r.uleb();
    const size = r.uleb();
    const elements: Record<string, EncVal> = {};
    for (let i = 0; i < size; i++) {
      const nameIdx = r.uleb();
      elements[this.string(nameIdx)] = this.encodedValue(r);
    }
    return { visibility: 1, type: descToName(this.type(typeIdx)), elements, dex: this };
  }

  /** map_list entry for a TYPE_* code, or undefined. The header stops at class_defs, so
   *  call_site_ids (0x0007) and method_handles (0x0008) are reachable only through here. */
  private section(type: number): { size: number; off: number } | undefined {
    let m = this.sections;
    if (!m) {
      m = this.sections = new Map();
      if (this.mapOff) {
        const n = this.view.getUint32(this.mapOff, true);
        for (let i = 0; i < n; i++) {
          const p = this.mapOff + 4 + i * 12;
          m.set(this.view.getUint16(p, true), { size: this.view.getUint32(p + 4, true), off: this.view.getUint32(p + 8, true) });
        }
      }
    }
    return m.get(type);
  }

  methodHandle(i: number): MethodHandleRef {
    const sec = this.section(0x0008);
    if (!sec || i >= sec.size) throw new Error(`method_handle ${i} out of range in ${this.name}`);
    const off = sec.off + i * 8;
    return { type: this.view.getUint16(off, true), idx: this.view.getUint16(off + 4, true) };
  }

  /** call_site_item: [bootstrap handle, name, method type, ...bootstrap args] */
  callSite(i: number): EncVal[] {
    const sec = this.section(0x0007);
    if (!sec || i >= sec.size) throw new Error(`call_site ${i} out of range in ${this.name}`);
    return this.encodedArray(this.view.getUint32(sec.off + i * 4, true));
  }

  code(off: number): CodeItem {
    const v = this.view;
    const regs = v.getUint16(off, true);
    const ins = v.getUint16(off + 2, true);
    const triesSize = v.getUint16(off + 6, true);
    const insnsSize = v.getUint32(off + 12, true);
    const at = this.bytes.byteOffset + off + 16;
    let insns: Uint16Array;
    if (LITTLE_ENDIAN && (at & 1) === 0) insns = new Uint16Array(this.bytes.buffer, at, insnsSize);
    else {
      insns = new Uint16Array(insnsSize);
      for (let j = 0; j < insnsSize; j++) insns[j] = v.getUint16(off + 16 + j * 2, true);
    }
    const tries: TryItem[] = [];
    if (triesSize) {
      let p = off + 16 + insnsSize * 2;
      if (insnsSize & 1) p += 2;
      const handlersBase = p + triesSize * 8;
      const handlerCache = new Map<number, { handlers: [number, number][]; catchAllAddr: number }>();
      for (let j = 0; j < triesSize; j++) {
        const start = v.getUint32(p, true);
        const count = v.getUint16(p + 4, true);
        const hOff = v.getUint16(p + 6, true);
        p += 8;
        let h = handlerCache.get(hOff);
        if (!h) {
          const r = new Reader(this.bytes, handlersBase + hOff);
          const size = r.sleb();
          const n = Math.abs(size);
          const handlers: [number, number][] = [];
          for (let k = 0; k < n; k++) handlers.push([r.uleb(), r.uleb()]);
          const catchAllAddr = size <= 0 ? r.uleb() : -1;
          h = { handlers, catchAllAddr };
          handlerCache.set(hOff, h);
        }
        tries.push({ start, end: start + count, handlers: h.handlers, catchAllAddr: h.catchAllAddr });
      }
    }
    return { regs, ins, insns, tries };
  }

  /** encoded_array_item at off (used for static field initial values) */
  encodedArray(off: number): EncVal[] {
    const r = new Reader(this.bytes, off);
    const n = r.uleb();
    const out: EncVal[] = [];
    for (let j = 0; j < n; j++) out.push(this.encodedValue(r));
    return out;
  }

  private encodedValue(r: Reader): EncVal {
    const b = r.u8();
    const type = b & 0x1f, arg = b >> 5;
    const size = arg + 1;
    switch (type) {
      case 0x00: { const x = r.u8(); return x << 24 >> 24; } // byte
      case 0x02: return this.readSExt(r, size);              // short
      case 0x03: return this.readZExt(r, size);              // char
      case 0x04: return this.readSExt(r, size);              // int
      case 0x06: return this.readSExt64(r, size);            // long
      case 0x10: case 0x11: { // float/double: size bytes, right-zero-extended to 4/8
        const n = type === 0x10 ? 4 : 8, buf = new Uint8Array(n);
        for (let i = 0; i < size; i++) buf[n - size + i] = r.u8();
        const dv = new DataView(buf.buffer);
        return n === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
      }
      case 0x17: return this.string(this.readZExt(r, size)); // string
      case 0x18: return { kind: "type", idx: this.readZExt(r, size) };
      case 0x19: return { kind: "field", idx: this.readZExt(r, size) };
      case 0x15: return { kind: "proto", idx: this.readZExt(r, size) };
      case 0x16: return { kind: "mhandle", idx: this.readZExt(r, size) };
      case 0x1a: return { kind: "method", idx: this.readZExt(r, size) };
      case 0x1b: return { kind: "enum", idx: this.readZExt(r, size) };
      case 0x1c: { // array
        const n = r.uleb();
        const out: EncVal[] = [];
        for (let j = 0; j < n; j++) out.push(this.encodedValue(r));
        return out;
      }
      case 0x1d: return { kind: "annotation", anno: this.encodedAnnotation(r) };
      case 0x1e: return null;
      case 0x1f: return arg !== 0;
      default: throw new Error(`encoded_value type 0x${type.toString(16)}`);
    }
  }

  private readZExt(r: Reader, size: number): number {
    let x = 0;
    for (let i = 0; i < size; i++) x |= r.u8() << (i * 8);
    return x >>> 0;
  }
  private readSExt(r: Reader, size: number): number {
    let x = 0;
    for (let i = 0; i < size; i++) x |= r.u8() << (i * 8);
    const shift = 32 - size * 8;
    return shift > 0 ? (x << shift) >> shift : x | 0;
  }
  private readSExt64(r: Reader, size: number): bigint {
    let x = 0n;
    for (let i = 0; i < size; i++) x |= BigInt(r.u8()) << BigInt(i * 8);
    const shift = BigInt(64 - size * 8);
    return shift > 0n ? BigInt.asIntN(64, x << shift) >> shift : BigInt.asIntN(64, x);
  }
}
