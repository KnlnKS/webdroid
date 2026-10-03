// Name mangling + descriptor utilities. One canonical scheme for compiled & native code.
//
// Java values in JS:
//   int/short/byte/char/float/double → number (booleans are 0/1 numbers, NEVER JS true/false)
//   long → BigInt   |   String → JS string primitive   |   null → null
//   prim arrays → TypedArrays (byte=Int8, bool=Uint8, char=Uint16, short=Int16,
//     int=Int32, long=BigInt64, float=Float32, double=Float64)
//   object arrays → JS Array with $t = element descriptor tag
//   objects → JS class instances (unified hierarchy: dex + native classes)
//
// Methods:      proto[`m$name$H` ] where H = hash(fullMethodDescriptor)
// Constructors: proto[`i$H`]
// Static via ctor: Ctor[`m$...`], Ctor[`s$fieldName`]
// Instance fields: `f$name$H2` where H2 = hash(declaringClass) — avoids R8 shadowing collisions

export function hash36(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const nameRe = /[^A-Za-z0-9_]/g;
function safeName(n: string): string {
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (!(c >= 97 && c <= 122 || c >= 65 && c <= 90 || c >= 48 && c <= 57 || c === 95))
      return n.replace(nameRe, (ch) => "$" + ch.charCodeAt(0).toString(16) + "$");
  }
  return n;
}

// Two-level memo (name → desc → mangled). vcall mangles on every dynamic dispatch — per
// text line per frame, per view per draw — and the uncached path is a char loop over the
// descriptor plus a regex plus two concats. Nested maps so a lookup allocates nothing.
const mangleMemo = new Map<string, Map<string, string>>();
/** mangle method: name + full descriptor like "(ILjava/lang/String;)V" */
export function mangleMethod(name: string, desc: string): string {
  let byDesc = mangleMemo.get(name);
  if (byDesc === undefined) mangleMemo.set(name, (byDesc = new Map()));
  const hit = byDesc.get(desc);
  if (hit !== undefined) return hit;
  const m = name === "<init>" ? "i$" + hash36(desc)
    : name === "<clinit>" ? "$clinit"
    : "m$" + safeName(name) + "$" + hash36(desc);
  byDesc.set(desc, m);
  demangled.set(m, [name, desc]);
  return m;
}
/** the prototype property naming exactly `cls`'s method `mangled`, which a subclass cannot shadow:
 *  a direct call through it is a method call, whose call feedback lets V8 inline the target */
export const directName = (cls: string, mangled: string): string => "d" + hash36(cls) + "$" + mangled;
const demangled = new Map<string, [string, string]>();
export const demangle = (mangled: string): [string, string] | undefined => demangled.get(mangled);
/** a reflect.Proxy materialises a method on first use from the name and descriptor the caller
 *  holds; set by jreflect, consulted by jmethod and every other by-name dispatch */
export const lateMethod = { find: null as ((o: unknown, name: string, desc: string) => JMethod | undefined) | null };

/** mangle instance field. declCls = "java/lang/Object" form */
export function mangleField(declCls: string, name: string): string {
  return "f$" + safeName(name) + "$" + hash36(declCls);
}

export function mangleStaticField(name: string, desc?: string): string {
  return "s$" + safeName(name) + (desc ? "$" + hash36(desc) : "");
}

/** "(ILjava/lang/String;[J)V" → { params: ["I","Ljava/lang/String;","[J"], ret: "V" } */
const descMemo = new Map<string, { params: string[]; ret: string }>();
export function parseMethodDesc(desc: string): { params: string[]; ret: string } {
  let hit = descMemo.get(desc);
  if (hit) return hit;
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const start = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") { while (desc[i] !== ";") i++; }
    i++;
    params.push(desc.slice(start, i));
  }
  descMemo.set(desc, (hit = { params, ret: desc.slice(i + 1) }));
  return hit;
}

export const dotName = (internal: string) => internal.replace(/\//g, ".");
export const slashName = (binary: string) => binary.replace(/\./g, "/");
export const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };
/** the bytes TextEncoder makes of `s`: a surrogate pair is four, a lone surrogate U+FFFD's three */
export function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if ((c & 0xfc00) === 0xd800 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 2; i++; }
    else n += 2;
  }
  return n;
}

export function isWide(desc: string): boolean { return desc === "J" || desc === "D"; }

/** default value of a field of the given type descriptor */
export function defaultValue(desc: string): 0 | 0n | null {
  return desc[0] === "J" ? 0n : desc[0] === "L" || desc[0] === "[" ? null : 0;
}
/** the same, as a JS source literal */
export function defaultVal(desc: string): string {
  const v = defaultValue(desc);
  return typeof v === "bigint" ? "0n" : String(v);
}

/** "Ljava/lang/String;" → "java/lang/String"; passthrough for already-plain names */
export function descToName(desc: string): string {
  return desc[0] === "L" ? desc.slice(1, -1) : desc;
}

/** primitive descriptor ↔ Java type name */
export const PRIM_NAME: Record<string, string> = { I: "int", J: "long", F: "float", D: "double", Z: "boolean", B: "byte", C: "char", S: "short", V: "void" };
export const PRIM_DESC: Record<string, string> = Object.fromEntries(Object.entries(PRIM_NAME).map(([d, n]) => [n, d]));

/** the one mapping of Java's element types onto TypedArrays (byte=Int8, boolean=Uint8, char=Uint16, long=BigInt64) */
export const PRIM_ARRAYS = { Z: Uint8Array, B: Int8Array, C: Uint16Array, S: Int16Array, I: Int32Array, J: BigInt64Array, F: Float32Array, D: Float64Array };
export type PrimElem = keyof typeof PRIM_ARRAYS;
const PRIM_BY_CTOR = new Map<unknown, PrimElem>(Object.entries(PRIM_ARRAYS).map(([d, c]) => [c, d as PrimElem]));
export function primElem(v: unknown): PrimElem | undefined {
  const e = PRIM_BY_CTOR.get((v as object | null)?.constructor);
  if (e !== undefined || !ArrayBuffer.isView(v)) return e;
  for (const d in PRIM_ARRAYS) if (v instanceof PRIM_ARRAYS[d as PrimElem]) return d as PrimElem;
}

/** tag a JS array as a Java `elem[]` for compiled code (in place, returns the same array) */
export function jarray<T>(items: T[], elem = "Ljava/lang/Object;"): T[] {
  (items as { $t?: string }).$t = elem;
  return items;
}
export const strArray = (a: readonly string[]) => jarray([...a], "Ljava/lang/String;");

// Typed code-unit reads and fromCharCode cannot re-enter; retain only numeric scratch by length.
const shortStringUnits: number[][] = [];
const utf16 = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });
/** code units → string, chunked to stay under the argument limit */
export function charsToString(chars: Uint16Array | Uint8Array, off: number, len: number): string {
  // a long run decodes about 2.5x faster (V8, 1 KB); a lone surrogate, which the decoder refuses,
  // and a view it cannot read (shared memory) take fromCharCode's path
  if (len >= 128 && chars instanceof Uint16Array) {
    try { return utf16.decode(chars.subarray(off, off + len)); } catch { /* below */ }
  }
  // fromCharCode reads a plain array's elements faster than a typed array's (about 2x in V8 below
  // 40 code units); a subarray also allocates a view, which the whole-array case skips
  if (len < 128) {
    const units = shortStringUnits[len] ??= new Array<number>(len);
    for (let i = 0; i < len; i++) units[i] = chars[off + i];
    return Reflect.apply(String.fromCharCode, null, units);
  }
  if (off === 0 && len === chars.length && len <= 1024) return Reflect.apply(String.fromCharCode, null, chars);
  let s = "";
  for (let i = 0; i < len; i += 1024) {
    s += Reflect.apply(String.fromCharCode, null, chars.subarray(off + i, off + Math.min(len, i + 1024)));
  }
  return s;
}

export function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** modified UTF-8 from `pos`: NUL is two bytes and a supplementary character is two three-byte
 *  halves, or one four-byte sequence as ART's JNI accepts. Stops at `end` or after `units` UTF-16
 *  units, whichever comes first. */
export function decodeModifiedUtf8(bytes: Uint8Array, pos = 0, end = bytes.length, units = end - pos): string {
  let ascii = pos + units <= end;
  for (let i = 0; ascii && i < units; i++) ascii = bytes[pos + i] < 0x80;
  if (ascii) return charsToString(bytes, pos, units);
  const out = new Uint16Array(units);
  let o = 0, p = pos;
  while (o < units && p < end) {
    const a = bytes[p++];
    if (a < 0x80) out[o++] = a;
    else if ((a & 0xe0) === 0xc0) out[o++] = ((a & 0x1f) << 6) | (bytes[p++] & 0x3f);
    else if ((a & 0xf8) === 0xf0) {
      const v = (((a & 7) << 18) | ((bytes[p] & 0x3f) << 12) | ((bytes[p + 1] & 0x3f) << 6) | (bytes[p + 2] & 0x3f)) - 0x10000;
      p += 3;
      out[o++] = 0xd800 | (v >> 10);
      if (o < units) out[o++] = 0xdc00 | (v & 0x3ff);
    }
    else { const b = bytes[p++], c = bytes[p++]; out[o++] = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f); }
  }
  return charsToString(out, 0, o);
}

export const i8 = <B extends ArrayBufferLike>(b: ArrayBufferView<B>, off = 0, len = b.byteLength - off) => new Int8Array(b.buffer, b.byteOffset + off, len);
export const u8 = <B extends ArrayBufferLike>(b: ArrayBufferView<B>, off = 0, len = b.byteLength - off) => new Uint8Array(b.buffer, b.byteOffset + off, len);
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; }
  return out;
}
export const hexBytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
export function splitSig(sig: string): [string, string] {
  const p = sig.indexOf("(");
  return [sig.slice(0, p), sig.slice(p)];
}

export type JMethod = (this: unknown, ...a: unknown[]) => unknown;
export function jmethod(o: unknown, mangled: string): JMethod | undefined {
  const f = (o as Record<string, JMethod | undefined> | null)?.[mangled];
  if (f !== undefined || !lateMethod.find) return f;
  const nd = demangled.get(mangled);
  return nd ? lateMethod.find(o, nd[0], nd[1]) : undefined;
}

const bits = new DataView(new ArrayBuffer(8));
export function intBitsToFloat(i: number): number { bits.setInt32(0, i | 0); return bits.getFloat32(0); }
export function floatToIntBits(f: number): number { bits.setFloat32(0, f); return bits.getInt32(0); }
export function longBitsToDouble(l: bigint): number { bits.setBigInt64(0, l); return bits.getFloat64(0); }
export function doubleToLongBits(d: number): bigint { bits.setFloat64(0, d); return bits.getBigInt64(0); }

/** VarHandle access modes by how many value operands follow the coordinates */
const VARHANDLE_VALUES = new Map<string, number>();
for (const [n, modes] of [
  [0, "get getVolatile getOpaque getAcquire"],
  [1, "set setVolatile setOpaque setRelease getAndSet getAndSetAcquire getAndSetRelease getAndAdd getAndAddAcquire " +
    "getAndAddRelease getAndBitwiseOr getAndBitwiseOrAcquire getAndBitwiseOrRelease getAndBitwiseAnd " +
    "getAndBitwiseAndAcquire getAndBitwiseAndRelease getAndBitwiseXor getAndBitwiseXorAcquire getAndBitwiseXorRelease"],
  [2, "compareAndSet compareAndExchange compareAndExchangeAcquire compareAndExchangeRelease weakCompareAndSet " +
    "weakCompareAndSetPlain weakCompareAndSetAcquire weakCompareAndSetRelease"],
] as const) for (const m of modes.split(" ")) VARHANDLE_VALUES.set(m, n);
export const VARHANDLE_MODES: readonly string[] = [...VARHANDLE_VALUES.keys()];
/** how many value operands a VarHandle access mode takes; undefined for any other name */
export const varHandleValues = (mode: string): number | undefined => VARHANDLE_VALUES.get(mode);

/** A compiled body's function name, naming its class and method in identifier characters: stack
 *  frames carry it whatever script the body came from, as persisted code does not carry its
 *  per-method sourceURL. Every other character is `_` and four hex digits, so `__` separates. */
const frameEscape = (s: string) => s.replace(/[^A-Za-z0-9]/g, (c) => "_" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export const frameName = (cls: string, method: string) => `wd_${frameEscape(cls)}__${frameEscape(method)}`;
/** [class, method] from a frameName in a stack line, if it holds one */
export function frameOf(line: string): [string, string] | null {
  const m = /\bwd_([A-Za-z0-9_]*?)__([A-Za-z0-9_]+)/.exec(line);
  if (!m) return null;
  const unescape = (s: string) => s.replace(/_([0-9a-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return [unescape(m[1]), unescape(m[2])];
}
