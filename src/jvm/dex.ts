// DEX file parser. Format: https://source.android.com/docs/core/runtime/dex-format
// Everything lazy + cached; hot lookups are index math on a DataView.

import { decodeModifiedUtf8, descToName } from "./abi.ts";

export const NO_INDEX = 0xffffffff;
/** access flags of classes, fields and methods */
export const ACC = { PUBLIC: 1, PRIVATE: 2, PROTECTED: 4, STATIC: 8, FINAL: 0x10, SYNCHRONIZED: 0x20, DECLARED_SYNCHRONIZED: 0x20000, NATIVE: 0x100, INTERFACE: 0x200, ABSTRACT: 0x400, ENUM: 0x4000, CONSTRUCTOR: 0x10000 };

export const isDexEntry = (name: string): boolean => /^classes\d*\.dex$/.test(name);
export const dexEntryNames = (names: Iterable<string>): string[] => [...names].filter(isDexEntry)
  .sort((a, b) => (Number(a.slice(7, -4)) || 1) - (Number(b.slice(7, -4)) || 1));

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
  /** the SourceFile attribute's string index, NO_INDEX (0xffffffff) without one */
  sourceFileIdx: number;
  dex: DexFile;
}

// `dex` because element values reference types/enums by index into the dex they came from
export type ClassAnnotations = { cls: EncAnnotation[]; methods: Map<number, EncAnnotation[]>; fields: Map<number, EncAnnotation[]>; params: Map<number, EncAnnotation[][]> };
export interface EncAnnotation { visibility: number; type: string; elements: Record<string, EncVal>; dex: DexFile; }
/** the descriptors a dex's references name: as the file spells them (DexFile), or as the loader that defines its classes sees them (loadergraph.ts LoaderTypes) */
export interface DexTypes {
  /** type descriptor, e.g. "Ljava/lang/String;" or "[I" */
  type(i: number): string;
  /** the binary name of `type(i)` */
  typeName(i: number): string;
  /** full descriptor "(params)ret" of method index i */
  methodDesc(i: number): string;
  /** the parameter and return types of method index i, as parseMethodDesc gives them for its descriptor */
  methodTypes(i: number): { params: string[]; ret: string };
  /** name and descriptor of method index i */
  methodKey(i: number): string;
  /** full descriptor "(params)ret" of proto index pi */
  protoDesc(pi: number): string;
  protoTypes(pi: number): { params: string[]; ret: string };
  protoParamTypes(pi: number): string[];
  /** annotations for a class_def: the class's own, and per field, method and method PARAMETER; shared, so read-only */
  classAnnotations(def: ClassDef): ClassAnnotations;
}

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
/** method_handle_item.method_handle_type: the field accessors (idx a field_id), then the invoke kinds (idx a method_id) */
export const MethodHandleType = { StaticPut: 0, StaticGet: 1, InstancePut: 2, InstanceGet: 3, InvokeStatic: 4, InvokeInstance: 5, InvokeConstructor: 6, InvokeDirect: 7, InvokeInterface: 8 } as const;
export type MethodHandleType = (typeof MethodHandleType)[keyof typeof MethodHandleType];
interface MethodHandleRef { type: MethodHandleType; idx: number; }
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

class Reader {
  bytes: Uint8Array; pos: number;
  constructor(bytes: Uint8Array, pos: number) { this.bytes = bytes; this.pos = pos; }
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
  readonly length: number;
  private pages: (T[] | undefined)[];
  constructor(length: number) { this.length = length; this.pages = new Array(Math.ceil(length / CACHE_PAGE_SIZE)); }
  get(i: number): T | undefined { return this.pages[i >>> CACHE_PAGE_SHIFT]?.[i & CACHE_PAGE_MASK]; }
  set(i: number, value: T): T {
    return (this.pages[i >>> CACHE_PAGE_SHIFT] ??= new Array<T>(CACHE_PAGE_SIZE))[i & CACHE_PAGE_MASK] = value;
  }
  clear(): void { this.pages.fill(undefined); }
}

export class DexFile implements DexTypes {
  bytes: Uint8Array; name: string;
  view: DataView;
  private stringIdsOff: number; private typeIdsOff: number; private protoIdsOff: number;
  private fieldIdsOff: number; private methodIdsOff: number;
  classDefCount: number; private classDefsOff: number;
  private mapOff: number;
  /** map_list sections, resolved on first use: call_site_ids and method_handles live only here */
  private sections?: Map<number, { size: number; off: number }>;
  stringCount: number; typeCount: number;
  version: number; fileSize: number; containerSize: number;

  private stringCache: PagedCache<string>;
  private typeCache: PagedCache<string>;
  private rawTypeNames: PagedCache<string>;
  private classDefCache?: Map<string, number>;
  private protoCache: PagedCache<ProtoRef>;
  private fieldCache: PagedCache<FieldRef>;
  private methodCache: PagedCache<MethodRef>;

  /** the header's SHA-1 signature: names this dex's contents across page loads */
  readonly id: string;

  /** `headerOff` is where this logical dex's header sits inside the physical file. It is 0 for
   *  everything before v41; a v41 container holds several headers and their section offsets are
   *  relative to the CONTAINER, so every dex in one keeps the whole buffer and only the header
   *  moves. That is also why nothing below this constructor needs to know about containers. */
  constructor(bytes: Uint8Array, name = "classes.dex", headerOff = 0) {
    this.bytes = bytes; this.name = name;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    const h = headerOff;
    const magic = String.fromCharCode(...bytes.subarray(h, h + 4));
    if (magic !== "dex\n") throw new Error(`bad dex magic in ${name}`);
    this.version = Number(String.fromCharCode(...bytes.subarray(h + 4, h + 7))) || 0;
    this.fileSize = v.getUint32(h + 32, true);
    this.id = bytes.subarray(h + 12, h + 32).toHex() + (h ? "@" + h : "");
    this.containerSize = this.version >= 41 ? v.getUint32(h + 112, true) : this.fileSize;
    this.stringCount = v.getUint32(h + 56, true); this.stringIdsOff = v.getUint32(h + 60, true);
    this.typeCount = v.getUint32(h + 64, true); this.typeIdsOff = v.getUint32(h + 68, true);
    this.protoIdsOff = v.getUint32(h + 76, true);
    this.fieldIdsOff = v.getUint32(h + 84, true);
    this.methodIdsOff = v.getUint32(h + 92, true);
    this.classDefCount = v.getUint32(h + 96, true); this.classDefsOff = v.getUint32(h + 100, true);
    this.mapOff = v.getUint32(h + 52, true);
    const protoCount = v.getUint32(h + 72, true), fieldCount = v.getUint32(h + 80, true), methodCount = v.getUint32(h + 88, true);
    this.stringCache = new PagedCache(this.stringCount);
    this.typeCache = new PagedCache(this.typeCount);
    this.rawTypeNames = new PagedCache(this.typeCount);
    this.protoCache = new PagedCache(protoCount);
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
  string(i: number): string { return this.stringCache.get(i) ?? this.stringCache.set(i, this.decodeString(i)); }
  /** string `i`, not kept if it was not already */
  private peekString(i: number): string { return this.stringCache.get(i) ?? this.decodeString(i); }
  private decodeString(i: number): string {
    const r = new Reader(this.bytes, this.view.getUint32(this.stringIdsOff + i * 4, true)), len = r.uleb();
    return decodeModifiedUtf8(this.bytes, r.pos, this.bytes.length, len);
  }
  /** the shorty descriptors of its protos, each once, without keeping their strings */
  shorties(): Set<string> {
    const out = new Set<string>(), seen = new Set<number>();
    for (let i = 0; i < this.protoCache.length; i++) {
      const s = this.view.getUint32(this.protoIdsOff + i * 12, true);
      if (!seen.has(s)) { seen.add(s); out.add(this.peekString(s)); }
    }
    return out;
  }

  /** the index of string `s`, or -1. string_ids sort by UTF-16 code units, which is how JS compares strings (ART's verifier rejects any other order). */
  findString(s: string): number {
    let found = this.foundStrings.get(s);
    if (found !== undefined) return found;
    let lo = 0, hi = this.stringCount;
    found = -1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, t = this.string(mid);
      if (t === s) { found = mid; break; }
      if (t < s) lo = mid + 1; else hi = mid;
    }
    this.foundStrings.set(s, found);
    return found;
  }
  private foundStrings = new Map<string, number>();
  private methodNames?: { heads: Uint32Array; next: Uint32Array };
  /** The method_ids whose name is string `nameIdx`, in DEX order. */
  *methodsNamed(nameIdx: number): Iterable<number> {
    if (!this.methodNames) {
      const heads = new Uint32Array(this.stringCount), next = new Uint32Array(this.methodCount);
      // One-based links reserve zero for the end, without decoding names or signatures.
      for (let i = this.methodCount - 1; i >= 0; i--) {
        const name = this.view.getUint32(this.methodIdsOff + i * 8 + 4, true);
        next[i] = heads[name]; heads[name] = i + 1;
      }
      this.methodNames = { heads, next };
    }
    const { heads, next } = this.methodNames;
    for (let i = heads[nameIdx]; i; i = next[i - 1]) yield i - 1;
  }

  // as the file spells the types (a loader's view of them: Program.typesOf); the raw* readers say so where both are at hand
  type(i: number): string { return this.typeCache.get(i) ?? this.typeCache.set(i, this.rawType(i)); }
  rawType(i: number): string { return this.string(this.view.getUint32(this.typeIdsOff + i * 4, true)); }
  typeName(i: number): string { return this.rawTypeName(i); }
  /** kept, so lookups by them hash each name once */
  rawTypeName(i: number): string { return this.rawTypeNames.get(i) ?? this.rawTypeNames.set(i, descToName(this.peekString(this.view.getUint32(this.typeIdsOff + i * 4, true)))); }
  /** the last answer of `typesNaming`: a rebind asks each dex about the same descriptors for every class it checks, through sets its callers build apart */
  private typesNamed?: { descs: ReadonlySet<string>; found: ReadonlySet<number> };
  /** the type_ids naming a class descriptor in `descs` or an array of one; type_ids sort by descriptor, so each class is a binary search */
  typesNaming(descs: ReadonlySet<string>): ReadonlySet<number> {
    const last = this.typesNamed;
    if (last && (last.descs === descs || last.descs.size === descs.size && [...descs].every((d) => last.descs.has(d)))) { last.descs = descs; return last.found; }
    const v = this.view, at = (i: number) => v.getUint32(this.typeIdsOff + i * 4, true), found = new Set<number>();
    this.typesNamed = { descs, found };
    if (!descs.size) return found;
    for (const d of descs) {
      const s = this.findString(d);
      if (s < 0) continue;
      let lo = 0, hi = this.typeCount;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (at(mid) < s) lo = mid + 1; else hi = mid; }
      if (lo < this.typeCount && at(lo) === s) found.add(lo);
    }
    // array descriptors sort together, from "[" up to "\\"
    for (let i = this.typesFrom("["), end = this.typesFrom("\\"); i < end; i++) if (descs.has(this.rawType(i).replace(/^\[+/, ""))) found.add(i);
    return found;
  }
  /** the first type whose descriptor does not sort below `s` */
  private typesFrom(s: string): number {
    let lo = 0, hi = this.typeCount;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.rawType(mid) < s) lo = mid + 1; else hi = mid; }
    return lo;
  }

  proto(i: number): ProtoRef {
    let p = this.protoCache.get(i);
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
      p = this.protoCache.set(i, { shorty, ret, params });
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

  /** Class definitions follow dependency order rather than descriptor order. */
  findClassDef(descriptor: string): number | undefined {
    if (!this.classDefCache) {
      this.classDefCache = new Map();
      for (let i = 0; i < this.classDefCount; i++) this.classDefCache.set(this.rawType(this.classDef2Type(i)), i);
    }
    return this.classDefCache.get(descriptor);
  }

  private descCache: (string | undefined)[] = [];
  private paramTypeCache: (string[] | undefined)[] = [];
  methodDesc(i: number): string { return this.protoDesc(this.method(i).proto); }
  private typesCache: ({ params: string[]; ret: string } | undefined)[] = [];
  methodTypes(i: number): { params: string[]; ret: string } { return this.protoTypes(this.method(i).proto); }
  protoTypes(pi: number): { params: string[]; ret: string } {
    return this.typesCache[pi] ??= { params: this.protoParamTypes(pi), ret: this.type(this.proto(pi).ret) };
  }
  protoDesc(pi: number): string {
    let d = this.descCache[pi];
    if (d === undefined) {
      const p = this.proto(pi);
      d = this.descCache[pi] = "(" + this.protoParamTypes(pi).join("") + ")" + this.type(p.ret);
    }
    return d;
  }
  /** without keeping a record of the method */
  methodKey(i: number): string {
    const off = this.methodIdsOff + i * 8;
    return this.string(this.view.getUint32(off + 4, true)) + this.protoDesc(this.view.getUint16(off + 2, true));
  }
  protoParamTypes(i: number): string[] {
    return this.paramTypeCache[i] ??= this.proto(i).params.map((t) => this.type(t));
  }

  /** the class_def's header: what the class is, without its members */
  classHeader(i: number): { typeIdx: number; flags: number; superIdx: number; interfaces: number[] } {
    const off = this.classDefsOff + i * 32;
    const v = this.view;
    const interfacesOff = v.getUint32(off + 12, true);
    const interfaces: number[] = [];
    if (interfacesOff) {
      const n = v.getUint32(interfacesOff, true);
      for (let j = 0; j < n; j++) interfaces.push(v.getUint16(interfacesOff + 4 + j * 2, true));
    }
    return { typeIdx: v.getUint32(off, true), flags: v.getUint32(off + 4, true), superIdx: v.getUint32(off + 8, true), interfaces };
  }
  /** a reader at class_def i's class_data_item (its four member counts first), if it has members */
  private classData(i: number): Reader | undefined {
    const off = this.view.getUint32(this.classDefsOff + i * 32 + 24, true);
    return off ? new Reader(this.bytes, off) : undefined;
  }
  /** how many methods class_def i declares */
  declaredMethodCount(i: number): number {
    const r = this.classData(i);
    if (!r) return 0;
    r.uleb(); r.uleb();
    return r.uleb() + r.uleb();
  }

  /** how class_def `i` declares method_id `methodIdx` (its position among the direct then virtual methods), if it does */
  declaredAt(i: number, methodIdx: number): EncodedMethod & { index: number } | undefined {
    const r = this.classData(i);
    if (!r) return undefined;
    const nf = r.uleb() + r.uleb(), nd = r.uleb(), nv = r.uleb();
    for (let j = 0; j < nf; j++) { r.uleb(); r.uleb(); }
    let index = 0;
    for (const n of [nd, nv]) for (let j = 0, idx = 0; j < n; j++, index++) {
      idx += r.uleb();
      const flags = r.uleb(), codeOff = r.uleb();
      if (idx === methodIdx) return { methodIdx, flags, codeOff, index };
    }
    return undefined;
  }
  /** whether class_def `i` declares a static field of a type among type_ids `types` */
  declaresStaticOf(i: number, types: ReadonlySet<number>): boolean {
    const r = this.classData(i);
    if (!r) return false;
    const ns = r.uleb();
    r.uleb(); r.uleb(); r.uleb();
    for (let j = 0, idx = 0; j < ns; j++) {
      idx += r.uleb(); r.uleb();
      if (types.has(this.view.getUint16(this.fieldIdsOff + idx * 8 + 2, true))) return true;
    }
    return false;
  }
  /** whether class_def `i` declares a virtual method (in DEX, one neither static, private nor a constructor), with a parameter or return type among
   *  type_ids `types` if given */
  declaresVirtual(i: number, types?: ReadonlySet<number>): boolean {
    const r = this.classData(i);
    if (!r) return false;
    const nf = r.uleb() + r.uleb(), nd = r.uleb(), nv = r.uleb(), v = this.view;
    if (!types) return nv > 0;
    for (let j = 0; j < nf; j++) { r.uleb(); r.uleb(); }
    for (let j = 0; j < nd; j++) { r.uleb(); r.uleb(); r.uleb(); }
    for (let j = 0, idx = 0; j < nv; j++) {
      idx += r.uleb(); r.uleb(); r.uleb();
      const proto = this.protoIdsOff + v.getUint16(this.methodIdsOff + idx * 8 + 2, true) * 12, params = v.getUint32(proto + 8, true);
      if (types.has(v.getUint32(proto + 4, true))) return true;
      for (let k = 0, n = params ? v.getUint32(params, true) : 0; k < n; k++) if (types.has(v.getUint16(params + 4 + k * 2, true))) return true;
    }
    return false;
  }
  /** the method_id of class `typeIdx` named `name` with descriptor `desc` as `types` spell it, or -1. method_ids sort by class, then name, then proto */
  findMethod(typeIdx: number, name: string, desc: string, types: DexTypes = this): number {
    const n = this.findString(name);
    if (n < 0) return -1;
    const v = this.view, at = (i: number) => this.methodIdsOff + i * 8;
    let lo = 0, hi = this.methodCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, c = v.getUint16(at(mid), true), s = v.getUint32(at(mid) + 4, true);
      if (c < typeIdx || c === typeIdx && s < n) lo = mid + 1; else hi = mid;
    }
    for (let i = lo; i < this.methodCount && v.getUint16(at(i), true) === typeIdx && v.getUint32(at(i) + 4, true) === n; i++) {
      if (types.protoDesc(v.getUint16(at(i) + 2, true)) === desc) return i;
    }
    return -1;
  }

  classDef(i: number): ClassDef {
    const off = this.classDefsOff + i * 32;
    const v = this.view;
    const { typeIdx, flags, superIdx, interfaces } = this.classHeader(i);
    const classDataOff = v.getUint32(off + 24, true);
    const def: ClassDef = {
      typeIdx, flags, superIdx, interfaces,
      staticFields: [], instanceFields: [], directMethods: [], virtualMethods: [],
      staticValuesOff: v.getUint32(off + 28, true), annotationsOff: v.getUint32(off + 20, true), sourceFileIdx: v.getUint32(off + 16, true), dex: this,
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

  /** as `types` name the annotations' types, kept in `cache` */
  classAnnotations(def: ClassDef, types: DexTypes = this, cache = this.annotations): ClassAnnotations {
    const dir = def.annotationsOff;
    let out = cache.get(dir);
    if (out) return out;
    out = { cls: [], methods: new Map(), fields: new Map(), params: new Map() };
    cache.set(dir, out);
    if (!dir) return out;
    const v = this.view;
    const classAnnoOff = v.getUint32(dir, true);
    const fieldsSize = v.getUint32(dir + 4, true);
    const methodsSize = v.getUint32(dir + 8, true);
    if (classAnnoOff) out.cls = this.annotationSet(classAnnoOff, types);
    let p = dir + 16;
    for (const [n, into] of [[fieldsSize, out.fields], [methodsSize, out.methods]] as const) {
      for (let i = 0; i < n; i++, p += 8) into.set(v.getUint32(p, true), this.annotationSet(v.getUint32(p + 4, true), types));
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
      for (let k = 0; k < n; k++) per.push(this.annotationSet(v.getUint32(listOff + 4 + k * 4, true), types));
      out.params.set(methodIdx, per);
    }
    return out;
  }

  private annotationSet(off: number, types: DexTypes): EncAnnotation[] {
    if (!off) return [];
    const v = this.view;
    const size = v.getUint32(off, true);
    const out: EncAnnotation[] = [];
    for (let i = 0; i < size; i++) {
      const itemOff = v.getUint32(off + 4 + i * 4, true);
      // annotation_item: visibility(u8) + encoded_annotation
      const r = new Reader(this.bytes, itemOff + 1);
      const annotation = this.encodedAnnotation(r, types); annotation.visibility = this.bytes[itemOff]; out.push(annotation);
    }
    return out;
  }

  private encodedAnnotation(r: Reader, types: DexTypes): EncAnnotation {
    const typeIdx = r.uleb();
    const size = r.uleb();
    const elements: Record<string, EncVal> = {};
    for (let i = 0; i < size; i++) {
      const nameIdx = r.uleb();
      elements[this.string(nameIdx)] = this.encodedValue(r, types);
    }
    return { visibility: 1, type: types.typeName(typeIdx), elements, dex: this };
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
    return { type: this.view.getUint16(off, true) as MethodHandleType, idx: this.view.getUint16(off + 4, true) };
  }

  /** call_site_item: [bootstrap handle, name, method type, ...bootstrap args] */
  callSite(i: number): EncVal[] {
    const sec = this.section(0x0007);
    if (!sec || i >= sec.size) throw new Error(`call_site ${i} out of range in ${this.name}`);
    return this.encodedArray(this.view.getUint32(sec.off + i * 4, true));
  }
  /** the proto index of the method type a call site is linked with */
  callSiteProto(i: number): number {
    const type = this.callSite(i)[2];
    if (typeof type !== "object" || type === null || Array.isArray(type) || type.kind !== "proto") throw new Error(`call_site ${i} has no method type in ${this.name}`);
    return type.idx;
  }

  /** Encoded tags distinguish integer/float/double bootstrap arguments that the value-only API cannot. */
  callSiteValues(i: number): { type: number; value: EncVal }[] {
    const sec = this.section(0x0007);
    if (!sec || i >= sec.size) throw new Error(`call_site ${i} out of range in ${this.name}`);
    const r = new Reader(this.bytes, this.view.getUint32(sec.off + i * 4, true)), n = r.uleb();
    const values: { type: number; value: EncVal }[] = [];
    for (let j = 0; j < n; j++) { const type = r.bytes[r.pos] & 0x1f; values.push({ type, value: this.encodedValue(r) }); }
    return values;
  }

  /** the source line of the instruction at code unit `pc`, by the code item's debug_info
   *  position table; -1 without one */
  lineAt(codeOff: number, pc: number): number {
    let table = this.lineTables.get(codeOff);
    if (!table) this.lineTables.set(codeOff, table = this.positions(codeOff));
    let found = -1;
    for (let i = 0; i < table.length && table[i] <= pc; i += 2) found = table[i + 1];
    return found;
  }
  private lineTables = new Map<number, Int32Array>();
  private annotations = new Map<number, ClassAnnotations>();
  /** a code item's position entries: address, line pairs in address order */
  private positions(codeOff: number): Int32Array {
    const debugOff = this.view.getUint32(codeOff + 8, true), out: number[] = [];
    if (!debugOff) return new Int32Array(0);
    const r = new Reader(this.bytes, debugOff);
    let line = r.uleb(), address = 0;
    for (let n = r.uleb(); n > 0; n--) r.uleb();
    for (;;) {
      const op = r.u8();
      switch (op) {
        case 0: return Int32Array.from(out);                           // DBG_END_SEQUENCE
        case 1: address += r.uleb(); break;                            // DBG_ADVANCE_PC
        case 2: line += r.sleb(); break;                               // DBG_ADVANCE_LINE
        case 3: r.uleb(); r.uleb(); r.uleb(); break;                   // DBG_START_LOCAL
        case 4: r.uleb(); r.uleb(); r.uleb(); r.uleb(); break;         // DBG_START_LOCAL_EXTENDED
        case 5: case 6: r.uleb(); break;                               // DBG_END_LOCAL, DBG_RESTART_LOCAL
        case 7: case 8: break;                                         // DBG_SET_PROLOGUE_END, DBG_SET_EPILOGUE_BEGIN
        case 9: r.uleb(); break;                                       // DBG_SET_FILE
        default: {                                                     // a special opcode emits a position
          const adjusted = op - 10;
          address += Math.floor(adjusted / 15);
          line += -4 + adjusted % 15;
          out.push(address, line);
        }
      }
    }
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

  private encodedValue(r: Reader, types: DexTypes = this): EncVal {
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
        for (let j = 0; j < n; j++) out.push(this.encodedValue(r, types));
        return out;
      }
      case 0x1d: return { kind: "annotation", anno: this.encodedAnnotation(r, types) };
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
