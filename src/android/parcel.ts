// android.os.Parcel: AOSP's wire layout (4-byte cells, UTF-16 strings, BNDL bundles) so
// dataSize/dataPosition agree with what an app measured on a device. What has no byte
// form here — a binder — rides in a side table keyed by its position.
import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { dotName, slashName, jarray, mangleStaticField, utf8, u8 } from "../jvm/abi";
import { newObj, vcall, defineException, callOn, curThread, vcallOn } from "../jvm/natives/jlang";
import { box, boxDesc, unbox, type BoxDesc } from "../jvm/natives/jbox";
import { newArrayList, toJsArray } from "../jvm/natives/jcoll";
import { JBundle, JBaseBundle, JPersistableBundle } from "./os";
import { csText } from "./text";

const enum V { NULL = -1, STRING = 0, INTEGER = 1, MAP = 2, BUNDLE = 3, PARCELABLE = 4, SHORT = 5, LONG = 6, FLOAT = 7, DOUBLE = 8, BOOLEAN = 9,
  CHARSEQUENCE = 10, LIST = 11, BYTEARRAY = 13, STRINGARRAY = 14, IBINDER = 15, PARCELABLEARRAY = 16, OBJECTARRAY = 17, INTARRAY = 18, LONGARRAY = 19,
  BYTE = 20, SERIALIZABLE = 21, BOOLEANARRAY = 23, DOUBLEARRAY = 28, CHAR = 29, SHORTARRAY = 30, CHARARRAY = 31, FLOATARRAY = 32 }
const BNDL = 0x4c444e42;
const P = "Landroid/os/Parcel;";
defineException("android/os/BadParcelableException", "java/lang/RuntimeException");
const EXCEPTIONS = ["java/lang/SecurityException", "android/os/BadParcelableException", "java/lang/IllegalArgumentException",
  "java/lang/NullPointerException", "java/lang/IllegalStateException", "android/os/NetworkOnMainThreadException", "java/lang/UnsupportedOperationException"];

export class JParcel extends JObj {
  buf = new Uint8Array(256);
  view = new DataView(this.buf.buffer);
  pos = 0;
  size = 0;
  objects = new Map<number, unknown>();
}
export { parcelCreator } from "./parcelable";
function reserve(p: JParcel, n: number) {
  if (p.pos + n <= p.buf.length) return;
  const b = new Uint8Array(Math.max(p.buf.length * 2, p.pos + n));
  b.set(p.buf.subarray(0, p.size));
  p.buf = b; p.view = new DataView(b.buffer);
}
const advance = (p: JParcel, n: number) => { const at = p.pos; p.pos += n; if (p.pos > p.size) p.size = p.pos; return at; };
const pad4 = (n: number) => (n + 3) & ~3;
export function writeInt(p: JParcel, v: number) { reserve(p, 4); p.view.setInt32(advance(p, 4), v | 0, true); }
export function writeLong(p: JParcel, v: bigint) { reserve(p, 8); p.view.setBigInt64(advance(p, 8), BigInt.asIntN(64, v), true); }
function writeFloat(p: JParcel, v: number) { reserve(p, 4); p.view.setFloat32(advance(p, 4), v, true); }
export function writeDouble(p: JParcel, v: number) { reserve(p, 8); p.view.setFloat64(advance(p, 8), v, true); }
export function readInt(p: JParcel) { return p.pos + 4 <= p.size ? p.view.getInt32(advance(p, 4), true) : 0; }
export function readLong(p: JParcel) { return p.pos + 8 <= p.size ? p.view.getBigInt64(advance(p, 8), true) : 0n; }
function readFloat(p: JParcel) { return p.pos + 4 <= p.size ? p.view.getFloat32(advance(p, 4), true) : 0; }
export function readDouble(p: JParcel) { return p.pos + 8 <= p.size ? p.view.getFloat64(advance(p, 8), true) : 0; }
export function writeString(p: JParcel, s: string | null) {
  if (s === null) return writeInt(p, -1);
  writeInt(p, s.length);
  const n = pad4((s.length + 1) * 2);
  reserve(p, n);
  const at = advance(p, n);
  for (let i = 0; i < s.length; i++) p.view.setUint16(at + i * 2, s.charCodeAt(i), true);
  p.buf.fill(0, at + s.length * 2, at + n);
}
export function readString(p: JParcel): string | null {
  const len = readInt(p);
  if (len < 0) return null;
  const at = advance(p, pad4((len + 1) * 2));
  let s = "";
  // Below ~32 units a typed view costs more than it saves (measured in V8 and JSC).
  if (len < 32) {
    for (let i = 0; i < len; i++) s += String.fromCharCode(p.view.getUint16(at + i * 2, true));
    return s;
  }
  // fromCharCode keeps lone surrogates, which TextDecoder would replace; the host is little-endian.
  const units = at & 1 ? new Uint16Array(p.buf.slice(at, at + len * 2).buffer) : new Uint16Array(p.buf.buffer, at, len);
  for (let i = 0; i < len; i += 8192) s += String.fromCharCode.apply(null, units.subarray(i, i + 8192) as unknown as number[]);
  return s;
}
export function writeString8(p: JParcel, s: string | null) {
  if (s === null) return writeInt(p, -1);
  let bytes: Uint8Array;
  if (!/[\0\ud800-\udfff]/.test(s)) bytes = utf8.enc.encode(s);
  else {
    // ART String8 uses modified NUL/surrogates but four bytes for paired supplementary characters.
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c > 0 && c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    bytes = Uint8Array.from(out);
  }
  const n = pad4(bytes.length + 1);
  writeInt(p, bytes.length); reserve(p, n);
  const at = advance(p, n);
  p.buf.set(bytes, at); p.buf.fill(0, at + bytes.length, at + n);
}
export function readString8(p: JParcel): string | null {
  const len = readInt(p);
  if (len < 0) return null;
  const at = advance(p, pad4(len + 1));
  const bytes = p.buf.subarray(at, at + len);
  if (!bytes.includes(0xc0) && !bytes.includes(0xed)) return utf8.dec.decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c < 0xe0) s += String.fromCharCode((c & 31) << 6 | bytes[i++] & 63);
    else if (c < 0xf0) s += String.fromCharCode((c & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63);
    else s += String.fromCodePoint((c & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63);
  }
  return s;
}
function writeBytes(p: JParcel, b: Int8Array | null) {
  if (!b) return writeInt(p, -1);
  writeInt(p, b.length);
  const n = pad4(b.length);
  reserve(p, n);
  const at = advance(p, n);
  p.buf.set(u8(b), at);
  p.buf.fill(0, at + b.length, at + n);
}
function readBytes(p: JParcel): Int8Array | null {
  const len = readInt(p);
  if (len < 0) return null;
  const at = advance(p, pad4(len));
  return new Int8Array(p.buf.slice(at, at + len).buffer);
}
/** an opaque object: its slot holds a tag, the side table holds the value */
export function writeObject(p: JParcel, o: unknown) { p.objects.set(p.pos, o); writeInt(p, 0); }
export function readObject(p: JParcel) { const at = p.pos; readInt(p); return p.objects.get(at) ?? null; }
async function writeSerializable(p: JParcel, o: unknown): Promise<void> {
  const thread = curThread;
  if (o === null) return writeString(p, null);
  writeString(p, typeof o === "string" ? "java.lang.String" : className(o as JObj));
  const target = await callOn(thread, () => newObj("java/io/ByteArrayOutputStream"));
  const output = await callOn(thread, () => newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", target));
  await vcallOn(thread, output, "writeObject", "(Ljava/lang/Object;)V", o);
  await vcallOn(thread, output, "close", "()V");
  writeBytes(p, await vcallOn(thread, target, "toByteArray", "()[B") as Int8Array);
}
async function readSerializable(p: JParcel): Promise<unknown> {
  const thread = curThread;
  if (readString(p) === null) return null;
  const bytes = readBytes(p);
  const source = await callOn(thread, () => newObj("java/io/ByteArrayInputStream", "([B)V", bytes));
  const input = await callOn(thread, () => newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source));
  return vcallOn(thread, input, "readObject", "()Ljava/lang/Object;");
}

const className = (o: JObj) => dotName((o.constructor as { $i?: { name: string } }).$i?.name ?? "java/lang/Object");
async function writeParcelable(p: JParcel, o: JObj | null, flags: number) {
  if (!o) return writeString(p, null);
  writeString(p, className(o));
  await vcall(o, "writeToParcel", `(${P}I)V`, p, flags);
}
/** a Parcelable's CREATOR, on the class the wire names */
async function creatorOf(name: string): Promise<unknown> {
  const info = rt.link(slashName(name));
  const pending = rt.initClass(info); if (pending) await pending;
  let creator: unknown;
  for (let owner: typeof info | null = info; owner && !creator; owner = owner.superInfo) creator = (owner.ctor as Record<string, unknown>)[mangleStaticField("CREATOR")];
  if (!creator) throw rt.mkThrowable("java/lang/RuntimeException", "Parcelable protocol requires a Parcelable.Creator object called CREATOR on class " + name);
  return creator;
}
async function createFrom(p: JParcel, creator: unknown, loader: unknown) {
  return rt.iof(creator, "android/os/Parcelable$ClassLoaderCreator")
    ? vcall(creator, "createFromParcel", `(${P}Ljava/lang/ClassLoader;)Ljava/lang/Object;`, p, loader)
    : vcall(creator, "createFromParcel", `(${P})Ljava/lang/Object;`, p);
}
async function readParcelable(p: JParcel, loader: unknown) {
  const name = readString(p);
  return name === null ? null : createFrom(p, await creatorOf(name), loader);
}
async function writeBundle(p: JParcel, b: JBaseBundle | null) {
  if (!b) return writeInt(p, -1);
  if (!b.map.size) return writeInt(p, 0);
  const lenAt = p.pos;
  writeInt(p, 0); writeInt(p, BNDL); writeInt(p, b.map.size);
  for (const [k, v] of b.map) { writeString(p, k); await writeValue(p, v); }
  p.view.setInt32(lenAt, p.pos - lenAt - 8, true);
}
async function readBundle(p: JParcel, loader: unknown, persistable = false) {
  const len = readInt(p);
  if (len < 0) return null;
  rt.link(persistable ? "android/os/PersistableBundle" : "android/os/Bundle");
  const b = persistable ? new JPersistableBundle() : new JBundle();
  b.loader = loader;
  if (len === 0) return b;
  if (readInt(p) !== BNDL) throw rt.mkThrowable("java/lang/IllegalStateException", "Bad magic number for Bundle");
  for (let n = readInt(p); n > 0; n--) { const k = readString(p)!; b.map.set(k, await readValue(p, loader)); }
  return b;
}
async function writeList(p: JParcel, list: unknown) {
  if (list === null) return writeInt(p, -1);
  const items = await toJsArray(list);
  writeInt(p, items.length);
  for (const v of items) await writeValue(p, v);
}
async function readItems(p: JParcel, loader: unknown): Promise<unknown[] | null> {
  const n = readInt(p);
  if (n < 0) return null;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(await readValue(p, loader));
  return out;
}
const readList = async (p: JParcel, loader: unknown) => { const items = await readItems(p, loader); return items && newArrayList(items); };
async function writeMap(p: JParcel, m: unknown) {
  if (m === null) return writeInt(p, -1);
  const entries = await toJsArray(await vcall(m, "entrySet", "()Ljava/util/Set;"));
  writeInt(p, entries.length);
  for (const e of entries) {
    await writeValue(p, await vcall(e, "getKey", "()Ljava/lang/Object;"));
    await writeValue(p, await vcall(e, "getValue", "()Ljava/lang/Object;"));
  }
}
async function readMap(p: JParcel, loader: unknown) {
  const n = readInt(p);
  if (n < 0) return null;
  const m = await newObj("java/util/HashMap");
  for (let i = 0; i < n; i++) await vcall(m, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", await readValue(p, loader), await readValue(p, loader));
  return m;
}
const writePrimArray = (p: JParcel, a: ArrayLike<number | bigint> | null, one: (v: never) => void) => {
  if (!a) return writeInt(p, -1);
  writeInt(p, a.length);
  for (let i = 0; i < a.length; i++) one(a[i] as never);
};
function readPrimArray<T>(p: JParcel, make: (n: number) => T, one: () => number | bigint): T | null {
  const n = readInt(p);
  if (n < 0) return null;
  const out = make(n) as unknown as Record<number, number | bigint>;
  for (let i = 0; i < n; i++) out[i] = one();
  return out as unknown as T;
}
const PRIM_PARCEL: [new (n: number) => ArrayLike<number | bigint>, V, (p: JParcel, v: never) => void, (p: JParcel) => number | bigint, string, string][] = [
  [Int32Array, V.INTARRAY, writeInt, readInt, "Int", "I"], [BigInt64Array, V.LONGARRAY, writeLong, readLong, "Long", "J"],
  [Float32Array, V.FLOATARRAY, writeFloat, readFloat, "Float", "F"], [Float64Array, V.DOUBLEARRAY, writeDouble, readDouble, "Double", "D"],
  [Uint8Array, V.BOOLEANARRAY, writeInt, readInt, "Boolean", "Z"], [Uint16Array, V.CHARARRAY, writeInt, readInt, "Char", "C"],
  [Int16Array, V.SHORTARRAY, writeInt, readInt, "", "S"],
];
const readStrings = (p: JParcel) => readPrimArray(p, (n) => jarray(new Array<string | null>(n).fill(null), "Ljava/lang/String;"), () => readString(p) as never);
export const writeStrings = (p: JParcel, a: (string | null)[] | null) => { if (!a) return writeInt(p, -1); writeInt(p, a.length); for (const s of a) writeString(p, s); };
function readStringList(p: JParcel) { const a = readStrings(p); return a ? newArrayList(a) : null; }

const BOX_TAGS: Record<BoxDesc, V> = { I: V.INTEGER, J: V.LONG, F: V.FLOAT, D: V.DOUBLE, Z: V.BOOLEAN, B: V.BYTE, S: V.SHORT, C: V.CHAR };
async function writeValue(p: JParcel, v: unknown) {
  const tag = (t: V) => writeInt(p, t);
  if (v === null || v === undefined) return tag(V.NULL);
  if (typeof v === "string") { tag(V.STRING); return writeString(p, v); }
  if (typeof v === "number") { if (Number.isInteger(v)) { tag(V.INTEGER); writeInt(p, v); } else { tag(V.DOUBLE); writeDouble(p, v); } return; }
  if (typeof v === "bigint") { tag(V.LONG); return writeLong(p, v); }
  const boxed = boxDesc(v);
  if (boxed) {
    const n = unbox(v)!;
    tag(BOX_TAGS[boxed]);
    return boxed === "J" ? writeLong(p, n as bigint) : boxed === "F" ? writeFloat(p, n as number) : boxed === "D" ? writeDouble(p, n as number) : writeInt(p, n as number);
  }
  if (v instanceof Int8Array) { tag(V.BYTEARRAY); return writeBytes(p, v); }
  for (const [C, code, w] of PRIM_PARCEL) if (v instanceof C) { tag(code); return writePrimArray(p, v as ArrayLike<number>, (x: never) => w(p, x)); }
  if (Array.isArray(v)) {
    const t = (v as { $t?: string }).$t;
    if (t === "Ljava/lang/String;") { tag(V.STRINGARRAY); return writeStrings(p, v); }
    // AOSP tests instanceof Parcelable[], which an Account[] passes too
    const parcelables = !!rt.arrayIof(v, "[Landroid/os/Parcelable;");
    tag(parcelables ? V.PARCELABLEARRAY : V.OBJECTARRAY);
    writeInt(p, v.length);
    for (const x of v) await (parcelables ? writeParcelable(p, x, 0) : writeValue(p, x));
    return;
  }
  if (v instanceof JBundle) { tag(V.BUNDLE); return writeBundle(p, v); }
  if (rt.iof(v, "android/os/Parcelable")) { tag(V.PARCELABLE); return writeParcelable(p, v as JObj, 0); }
  if (rt.iof(v, "java/util/Map")) { tag(V.MAP); return writeMap(p, v); }
  if (rt.iof(v, "java/util/List")) { tag(V.LIST); return writeList(p, v); }
  if (rt.iof(v, "java/lang/CharSequence")) { tag(V.CHARSEQUENCE); return writeString(p, await csText(v)); }
  if (rt.iof(v, "android/os/IBinder")) { tag(V.IBINDER); return writeObject(p, v); }
  if (rt.iof(v, "java/io/Serializable")) { tag(V.SERIALIZABLE); return writeSerializable(p, v); }
  throw rt.mkThrowable("java/lang/RuntimeException", "Parcel: unable to marshal value " + className(v as JObj));
}
async function readValue(p: JParcel, loader: unknown): Promise<unknown> {
  const t = readInt(p) as V;
  switch (t) {
    case V.NULL: return null;
    case V.STRING: case V.CHARSEQUENCE: return readString(p);
    case V.INTEGER: return box("I", readInt(p));
    case V.LONG: return box("J", readLong(p));
    case V.FLOAT: return box("F", readFloat(p));
    case V.DOUBLE: return box("D", readDouble(p));
    case V.BOOLEAN: return box("Z", readInt(p));
    case V.BYTE: return box("B", (readInt(p) << 24) >> 24);
    case V.SHORT: return box("S", (readInt(p) << 16) >> 16);
    case V.CHAR: return box("C", readInt(p) & 0xffff);
    case V.BYTEARRAY: return readBytes(p);
    case V.STRINGARRAY: return readStrings(p);
    case V.PARCELABLEARRAY: case V.OBJECTARRAY: {
      const n = readInt(p);
      if (n < 0) return null;
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(await (t === V.PARCELABLEARRAY ? readParcelable(p, loader) : readValue(p, loader)));
      return jarray(out, t === V.PARCELABLEARRAY ? "Landroid/os/Parcelable;" : "Ljava/lang/Object;");
    }
    case V.BUNDLE: return readBundle(p, loader);
    case V.PARCELABLE: return readParcelable(p, loader);
    case V.MAP: return readMap(p, loader);
    case V.LIST: return readList(p, loader);
    case V.IBINDER: return readObject(p);
    case V.SERIALIZABLE: return readSerializable(p);
    default: {
      const prim = PRIM_PARCEL.find((e) => e[1] === t);
      if (prim) return readPrimArray(p, (n) => new prim[0](n), () => prim[3](p));
      throw rt.mkThrowable("java/lang/RuntimeException", "Parcel: unknown type code " + t);
    }
  }
}
async function writeTyped(p: JParcel, items: unknown[] | null, flags: number) {
  if (!items) return writeInt(p, -1);
  writeInt(p, items.length);
  for (const x of items) { if (x === null) writeInt(p, 0); else { writeInt(p, 1); await vcall(x, "writeToParcel", `(${P}I)V`, p, flags); } }
}
async function readTyped(p: JParcel, creator: unknown): Promise<unknown[] | null> {
  const n = readInt(p);
  if (n < 0) return null;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(readInt(p) ? await createFrom(p, creator, null) : null);
  return out;
}

for (const i of ["android/os/Parcelable$ClassLoaderCreator", "android/os/Parcelable$Creator"]) rt.register({ name: i, ctor: class extends JObj {}, ifaces: i.endsWith("ClassLoaderCreator") ? ["android/os/Parcelable$Creator"] : [] });
const L = "Ljava/lang/ClassLoader;", S = "Ljava/lang/String;", CR = "Landroid/os/Parcelable$Creator;";
rt.register({
  name: "android/os/Parcel", ctor: JParcel,
  methods: {
    [`static obtain()${P}`]: () => new JParcel(),
    // one wire format serves every binder, so a parcel needs no marking for its target's
    [`static obtain(Landroid/os/IBinder;)${P}`]: () => new JParcel(),
    "recycle()V": function (this: JParcel) { this.pos = this.size = 0; this.objects.clear(); },
    "dataSize()I": function (this: JParcel) { return this.size; },
    "dataPosition()I": function (this: JParcel) { return this.pos; },
    "dataAvail()I": function (this: JParcel) { return this.size - this.pos; },
    "dataCapacity()I": function (this: JParcel) { return this.buf.length; },
    "setDataPosition(I)V": function (this: JParcel, at: number) { this.pos = at; },
    "setDataSize(I)V": function (this: JParcel, n: number) { reserve(this, n - this.pos); this.size = n; if (this.pos > n) this.pos = n; },
    "setDataCapacity(I)V": function (this: JParcel, n: number) { reserve(this, n - this.pos); },
    "marshall()[B": function (this: JParcel) { return new Int8Array(this.buf.slice(0, this.size).buffer); },
    "unmarshall([BII)V": function (this: JParcel, b: Int8Array, off: number, len: number) {
      this.buf = new Uint8Array(len); this.buf.set(u8(b, off, len));
      this.view = new DataView(this.buf.buffer); this.size = len; this.pos = 0; this.objects.clear();
    },
    [`appendFrom(${P}II)V`]: function (this: JParcel, o: JParcel, off: number, len: number) {
      reserve(this, len); this.buf.set(o.buf.subarray(off, off + len), advance(this, len));
    },
    "writeInt(I)V": function (this: JParcel, v: number) { writeInt(this, v); },
    "writeLong(J)V": function (this: JParcel, v: bigint) { writeLong(this, v); },
    "writeFloat(F)V": function (this: JParcel, v: number) { writeFloat(this, v); },
    "writeDouble(D)V": function (this: JParcel, v: number) { writeDouble(this, v); },
    "writeByte(B)V": function (this: JParcel, v: number) { writeInt(this, v); },
    "writeBoolean(Z)V": function (this: JParcel, v: number) { writeInt(this, v); },
    [`writeString(${S})V`]: function (this: JParcel, s: string | null) { writeString(this, s); },
    [`writeString8(${S})V`]: function (this: JParcel, s: string | null) { writeString8(this, s); },
    [`writeString16(${S})V`]: function (this: JParcel, s: string | null) { writeString(this, s); },
    "writeCharSequence(Ljava/lang/CharSequence;)V": driven(function* (this: JParcel, s: unknown): Gen { writeString(this, s === null ? null : yield csText(s)); }),
    "writeByteArray([B)V": function (this: JParcel, b: Int8Array | null) { writeBytes(this, b); },
    "writeByteArray([BII)V": function (this: JParcel, b: Int8Array | null, off: number, len: number) { writeBytes(this, b && b.subarray(off, off + len)); },
    ...Object.fromEntries(PRIM_PARCEL.filter((e) => e[4]).flatMap(([C, , w, r, name, d]) => [
      [`write${name}Array([${d})V`, function (this: JParcel, a: ArrayLike<number> | null) { writePrimArray(this, a, (x: never) => w(this, x)); }],
      [`create${name}Array()[${d}`, function (this: JParcel) { return readPrimArray(this, (n) => new C(n), () => r(this)); }],
    ])),
    [`writeStringArray([${S})V`]: function (this: JParcel, a: string[] | null) { writeStrings(this, a); },
    "writeStringList(Ljava/util/List;)V": driven(function* (this: JParcel, l: unknown): Gen { writeStrings(this, l === null ? null : (yield toJsArray(l)) as string[]); }),
    "writeValue(Ljava/lang/Object;)V": function (this: JParcel, v: unknown) { return writeValue(this, v); },
    "writeList(Ljava/util/List;)V": function (this: JParcel, l: unknown) { return writeList(this, l); },
    "writeMap(Ljava/util/Map;)V": function (this: JParcel, m: unknown) { return writeMap(this, m); },
    "writePersistableBundle(Landroid/os/PersistableBundle;)V": function (this: JParcel, b: JPersistableBundle | null) { return writeBundle(this, b); },
    "writeBundle(Landroid/os/Bundle;)V": function (this: JParcel, b: JBundle | null) { return writeBundle(this, b); },
    "writeParcelable(Landroid/os/Parcelable;I)V": function (this: JParcel, o: JObj | null, flags: number) { return writeParcelable(this, o, flags); },
    "writeTypedList(Ljava/util/List;)V": driven(function* (this: JParcel, l: unknown): Gen { return writeTyped(this, l === null ? null : yield toJsArray(l), 0); }),
    "writeTypedList(Ljava/util/List;I)V": driven(function* (this: JParcel, l: unknown, flags: number): Gen { return writeTyped(this, l === null ? null : yield toJsArray(l), flags); }),
    "writeTypedArray([Landroid/os/Parcelable;I)V": function (this: JParcel, a: unknown[] | null, flags: number) { return writeTyped(this, a, flags); },
    "writeTypedObject(Landroid/os/Parcelable;I)V": driven(function* (this: JParcel, o: unknown, flags: number): Gen { if (o === null) writeInt(this, 0); else { writeInt(this, 1); yield vcall(o, "writeToParcel", `(${P}I)V`, this, flags); } }),
    "writeSerializable(Ljava/io/Serializable;)V": function (this: JParcel, o: unknown) { return writeSerializable(this, o); },
    "writeStrongBinder(Landroid/os/IBinder;)V": function (this: JParcel, b: unknown) { writeObject(this, b); },
    "writeStrongInterface(Landroid/os/IInterface;)V": driven(function* (this: JParcel, value: unknown): Gen { writeObject(this, value ? yield vcall(value, "asBinder", "()Landroid/os/IBinder;") : null); }),
    [`writeInterfaceToken(${S})V`]: function (this: JParcel, s: string) { writeString(this, s); },
    "writeNoException()V": function (this: JParcel) { writeInt(this, 0); },
    "writeException(Ljava/lang/Exception;)V": driven(function* (this: JParcel, error: unknown): Gen {
      const index = EXCEPTIONS.findIndex((cls) => rt.iof(error, cls));
      if (index < 0) throw error;
      writeInt(this, -index - 1);
      writeString(this, yield vcall(error, "getMessage", "()Ljava/lang/String;"));
      writeInt(this, 0);
    }),
    "readInt()I": function (this: JParcel) { return readInt(this); },
    "readLong()J": function (this: JParcel) { return readLong(this); },
    "readFloat()F": function (this: JParcel) { return readFloat(this); },
    "readDouble()D": function (this: JParcel) { return readDouble(this); },
    "readByte()B": function (this: JParcel) { return readInt(this) << 24 >> 24; },
    "readBoolean()Z": function (this: JParcel) { return readInt(this) ? 1 : 0; },
    [`readString()${S}`]: function (this: JParcel) { return readString(this); },
    [`readString8()${S}`]: function (this: JParcel) { return readString8(this); },
    [`readString16()${S}`]: function (this: JParcel) { return readString(this); },
    "readCharSequence()Ljava/lang/CharSequence;": function (this: JParcel) { return readString(this); },
    "createByteArray()[B": function (this: JParcel) { return readBytes(this); },
    [`createStringArray()[${S}`]: function (this: JParcel) { return readStrings(this); },
    "createStringArrayList()Ljava/util/ArrayList;": function (this: JParcel) { return readStringList(this); },
    "readIntArray([I)V": function (this: JParcel, out: Int32Array) { const n = readInt(this); for (let i = 0; i < n; i++) out[i] = readInt(this); },
    "readStringList(Ljava/util/List;)V": driven(function* (this: JParcel, out: unknown): Gen { yield vcall(out, "clear", "()V"); for (const s of readStrings(this) ?? []) yield vcall(out, "add", "(Ljava/lang/Object;)Z", s); }),
    [`readValue(${L})Ljava/lang/Object;`]: function (this: JParcel, loader: unknown) { return readValue(this, loader); },
    [`readArrayList(${L})Ljava/util/ArrayList;`]: function (this: JParcel, loader: unknown) { return readList(this, loader); },
    [`readList(Ljava/util/List;${L})V`]: driven(function* (this: JParcel, out: unknown, loader: unknown): Gen { for (const v of (yield readItems(this, loader)) ?? []) yield vcall(out, "add", "(Ljava/lang/Object;)Z", v); }),
    [`readHashMap(${L})Ljava/util/HashMap;`]: function (this: JParcel, loader: unknown) { return readMap(this, loader); },
    [`readMap(Ljava/util/Map;${L})V`]: driven(function* (this: JParcel, out: unknown, loader: unknown): Gen { const m = yield readMap(this, loader); if (m) yield vcall(out, "putAll", "(Ljava/util/Map;)V", m); }),
    "readPersistableBundle()Landroid/os/PersistableBundle;": function (this: JParcel) { return readBundle(this, null, true); },
    "readPersistableBundle(Ljava/lang/ClassLoader;)Landroid/os/PersistableBundle;": function (this: JParcel, loader: unknown) { return readBundle(this, loader, true); },
    "readBundle()Landroid/os/Bundle;": function (this: JParcel) { return readBundle(this, null); },
    [`readBundle(${L})Landroid/os/Bundle;`]: function (this: JParcel, loader: unknown) { return readBundle(this, loader); },
    [`readParcelable(${L})Landroid/os/Parcelable;`]: function (this: JParcel, loader: unknown) { return readParcelable(this, loader); },
    [`readParcelable(${L}Ljava/lang/Class;)Ljava/lang/Object;`]: function (this: JParcel, loader: unknown) { return readParcelable(this, loader); },
    [`createTypedArrayList(${CR})Ljava/util/ArrayList;`]: driven(function* (this: JParcel, c: unknown): Gen { const a = yield readTyped(this, c); return a && newArrayList(a); }),
    [`createTypedArray(${CR})[Ljava/lang/Object;`]: driven(function* (this: JParcel, c: unknown): Gen {
      const a = yield readTyped(this, c);
      if (!a) return null;
      const out = (yield vcall(c, "newArray", "(I)[Ljava/lang/Object;", a.length)) as unknown[];
      for (let i = 0; i < a.length; i++) out[i] = a[i];
      return out;
    }),
    [`readTypedObject(${CR})Ljava/lang/Object;`]: function (this: JParcel, c: unknown) { return readInt(this) ? createFrom(this, c, null) : null; },
    [`readTypedList(Ljava/util/List;${CR})V`]: driven(function* (this: JParcel, out: unknown, c: unknown): Gen { yield vcall(out, "clear", "()V"); for (const v of (yield readTyped(this, c)) ?? []) yield vcall(out, "add", "(Ljava/lang/Object;)Z", v); }),
    "readSerializable()Ljava/io/Serializable;": function (this: JParcel) { return readSerializable(this); },
    [`readSerializable(${L}Ljava/lang/Class;)Ljava/lang/Object;`]: function (this: JParcel) { return readSerializable(this); },
    "readStrongBinder()Landroid/os/IBinder;": function (this: JParcel) { return readObject(this); },
    "readException()V": function (this: JParcel) {
      const code = readInt(this);
      if (code) {
        const message = readString(this), stack = readInt(this);
        if (stack) this.pos += stack - 4;
        throw rt.mkThrowable(EXCEPTIONS[-code - 1] ?? "java/lang/RuntimeException", message);
      }
    },
    "enforceInterface(Ljava/lang/String;)V": function (this: JParcel, descriptor: string) {
      if (readString(this) !== descriptor) throw rt.mkThrowable("java/lang/SecurityException", "Binder interface mismatch");
    },
    "enforceNoDataAvail()V": function (this: JParcel) {
      if (this.pos !== this.size) throw rt.mkThrowable("android/os/BadParcelableException", "Parcel data not fully consumed");
    },
    "hasFileDescriptors()Z": () => 0,
  },
});
