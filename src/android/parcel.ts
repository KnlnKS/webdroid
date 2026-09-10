// android.os.Parcel: AOSP's wire layout (4-byte cells, UTF-16 strings, BNDL bundles) so
// dataSize/dataPosition agree with what an app measured on a device. What has no byte
// form here — a Serializable, a binder — rides in a side table keyed by its position.
import { JObj, rt, maySuspend } from "../jvm/runtime";
import { dotName, slashName, jarray, mangleStaticField, utf8 } from "../jvm/abi";
import { newObj, vcall, JInt, JLong, JFloat, JDouble, JBool, JByte, JShort, JChar, box, defineException } from "../jvm/natives/jlang";
import { newArrayList, toJsArray, type JList } from "../jvm/natives/jutil";
import { JBundle } from "./os";
import { csText } from "./text";
import { deserialize, type Serialized } from "../jvm/serialization";

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
class JCreator extends JObj { type = ""; read!: (parcel: JParcel) => Promise<unknown>; }
rt.register({ name: "webdroid/ParcelableCreator", ctor: JCreator, ifaces: ["android/os/Parcelable$Creator"], methods: {
  "createFromParcel(Landroid/os/Parcel;)Ljava/lang/Object;": async function (this: JCreator, parcel: JParcel) { return this.read(parcel); },
  "newArray(I)[Ljava/lang/Object;": function (this: JCreator, size: number) { return jarray(Array(size).fill(null), "L" + this.type + ";"); },
} });
const creators = new Map<string, JCreator>();
export function parcelCreator(type: string, read: JCreator["read"]): JCreator {
  let creator = creators.get(type);
  if (!creator) {
    rt.link("webdroid/ParcelableCreator"); creator = new JCreator(); creator.type = type; creator.read = read; creators.set(type, creator);
  }
  return creator;
}
function reserve(p: JParcel, n: number) {
  if (p.pos + n <= p.buf.length) return;
  const b = new Uint8Array(Math.max(p.buf.length * 2, p.pos + n));
  b.set(p.buf.subarray(0, p.size));
  p.buf = b; p.view = new DataView(b.buffer);
}
const advance = (p: JParcel, n: number) => { const at = p.pos; p.pos += n; if (p.pos > p.size) p.size = p.pos; return at; };
const pad4 = (n: number) => (n + 3) & ~3;
function writeInt(p: JParcel, v: number) { reserve(p, 4); p.view.setInt32(advance(p, 4), v | 0, true); }
function writeLong(p: JParcel, v: bigint) { reserve(p, 8); p.view.setBigInt64(advance(p, 8), BigInt.asIntN(64, v), true); }
function writeFloat(p: JParcel, v: number) { reserve(p, 4); p.view.setFloat32(advance(p, 4), v, true); }
function writeDouble(p: JParcel, v: number) { reserve(p, 8); p.view.setFloat64(advance(p, 8), v, true); }
function readInt(p: JParcel) { return p.pos + 4 <= p.size ? p.view.getInt32(advance(p, 4), true) : 0; }
function readLong(p: JParcel) { return p.pos + 8 <= p.size ? p.view.getBigInt64(advance(p, 8), true) : 0n; }
function readFloat(p: JParcel) { return p.pos + 4 <= p.size ? p.view.getFloat32(advance(p, 4), true) : 0; }
function readDouble(p: JParcel) { return p.pos + 8 <= p.size ? p.view.getFloat64(advance(p, 8), true) : 0; }
function writeString(p: JParcel, s: string | null) {
  if (s === null) return writeInt(p, -1);
  writeInt(p, s.length);
  const n = pad4((s.length + 1) * 2);
  reserve(p, n);
  const at = advance(p, n);
  for (let i = 0; i < s.length; i++) p.view.setUint16(at + i * 2, s.charCodeAt(i), true);
  p.buf.fill(0, at + s.length * 2, at + n);
}
function readString(p: JParcel): string | null {
  const len = readInt(p);
  if (len < 0) return null;
  const at = advance(p, pad4((len + 1) * 2));
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(p.view.getUint16(at + i * 2, true));
  return s;
}
function writeString8(p: JParcel, s: string | null) {
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
function readString8(p: JParcel): string | null {
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
  p.buf.set(new Uint8Array(b.buffer, b.byteOffset, b.length), at);
  p.buf.fill(0, at + b.length, at + n);
}
function readBytes(p: JParcel): Int8Array | null {
  const len = readInt(p);
  if (len < 0) return null;
  const at = advance(p, pad4(len));
  return new Int8Array(p.buf.slice(at, at + len).buffer);
}
/** an opaque object: its slot holds a tag, the side table holds the value */
function writeObject(p: JParcel, o: unknown) { p.objects.set(p.pos, o); writeInt(p, 0); }
function readObject(p: JParcel) { const at = p.pos; readInt(p); return p.objects.get(at) ?? null; }
async function readSerializable(p: JParcel): Promise<unknown> {
  if (readString(p) === null) return null;
  const object = readObject(p);
  return object && typeof object === "object" && "serialized" in object ? deserialize(object as Serialized) : object;
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
async function writeBundle(p: JParcel, b: JBundle | null) {
  if (!b) return writeInt(p, -1);
  const lenAt = p.pos;
  writeInt(p, 0); writeInt(p, BNDL); writeInt(p, b.map.size);
  for (const [k, v] of b.map) { writeString(p, k); await writeValue(p, v); }
  p.view.setInt32(lenAt, p.pos - lenAt - 4, true);
}
async function readBundle(p: JParcel, loader: unknown) {
  const len = readInt(p);
  if (len < 0) return null;
  if (readInt(p) !== BNDL) throw rt.mkThrowable("java/lang/IllegalStateException", "Bad magic number for Bundle");
  const b = new (rt.link("android/os/Bundle").ctor)() as JBundle;
  b.loader = loader;
  for (let n = readInt(p); n > 0; n--) { const k = readString(p)!; b.map.set(k, await readValue(p, loader)); }
  return b;
}
async function writeList(p: JParcel, list: unknown) {
  if (list === null) return writeInt(p, -1);
  const items = await toJsArray(list);
  writeInt(p, items.length);
  for (const v of items) await writeValue(p, v);
}
async function readList(p: JParcel, loader: unknown): Promise<JList | null> {
  const n = readInt(p);
  if (n < 0) return null;
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(await readValue(p, loader));
  return newArrayList(out);
}
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
const readStrings = (p: JParcel) => readPrimArray(p, (n) => jarray(new Array<string | null>(n).fill(null), "Ljava/lang/String;"), () => readString(p) as never);
const writeStrings = (p: JParcel, a: (string | null)[] | null) => { if (!a) return writeInt(p, -1); writeInt(p, a.length); for (const s of a) writeString(p, s); };
function readStringList(p: JParcel) { const a = readStrings(p); return a ? newArrayList(a) : null; }

async function writeValue(p: JParcel, v: unknown) {
  const tag = (t: V) => writeInt(p, t);
  if (v === null || v === undefined) return tag(V.NULL);
  if (typeof v === "string") { tag(V.STRING); return writeString(p, v); }
  if (typeof v === "number") { if (Number.isInteger(v)) { tag(V.INTEGER); writeInt(p, v); } else { tag(V.DOUBLE); writeDouble(p, v); } return; }
  if (typeof v === "bigint") { tag(V.LONG); return writeLong(p, v); }
  if (v instanceof JInt) { tag(V.INTEGER); return writeInt(p, v.v); }
  if (v instanceof JLong) { tag(V.LONG); return writeLong(p, v.v); }
  if (v instanceof JFloat) { tag(V.FLOAT); return writeFloat(p, v.v); }
  if (v instanceof JDouble) { tag(V.DOUBLE); return writeDouble(p, v.v); }
  if (v instanceof JBool) { tag(V.BOOLEAN); return writeInt(p, v.v); }
  if (v instanceof JByte) { tag(V.BYTE); return writeInt(p, v.v); }
  if (v instanceof JShort) { tag(V.SHORT); return writeInt(p, v.v); }
  if (v instanceof JChar) { tag(V.CHAR); return writeInt(p, v.v); }
  if (v instanceof Int8Array) { tag(V.BYTEARRAY); return writeBytes(p, v); }
  if (v instanceof Int32Array) { tag(V.INTARRAY); return writePrimArray(p, v, (x: number) => writeInt(p, x)); }
  if (v instanceof BigInt64Array) { tag(V.LONGARRAY); return writePrimArray(p, v, (x: bigint) => writeLong(p, x)); }
  if (v instanceof Float32Array) { tag(V.FLOATARRAY); return writePrimArray(p, v, (x: number) => writeFloat(p, x)); }
  if (v instanceof Float64Array) { tag(V.DOUBLEARRAY); return writePrimArray(p, v, (x: number) => writeDouble(p, x)); }
  if (v instanceof Uint8Array) { tag(V.BOOLEANARRAY); return writePrimArray(p, v, (x: number) => writeInt(p, x)); }
  if (v instanceof Uint16Array) { tag(V.CHARARRAY); return writePrimArray(p, v, (x: number) => writeInt(p, x)); }
  if (v instanceof Int16Array) { tag(V.SHORTARRAY); return writePrimArray(p, v, (x: number) => writeInt(p, x)); }
  if (Array.isArray(v)) {
    const t = (v as { $t?: string }).$t;
    if (t === "Ljava/lang/String;") { tag(V.STRINGARRAY); return writeStrings(p, v); }
    tag(t === "Landroid/os/Parcelable;" ? V.PARCELABLEARRAY : V.OBJECTARRAY);
    writeInt(p, v.length);
    for (const x of v) await (t === "Landroid/os/Parcelable;" ? writeParcelable(p, x, 0) : writeValue(p, x));
    return;
  }
  if (v instanceof JBundle) { tag(V.BUNDLE); return writeBundle(p, v); }
  if (rt.iof(v, "android/os/Parcelable")) { tag(V.PARCELABLE); return writeParcelable(p, v as JObj, 0); }
  if (rt.iof(v, "java/util/Map")) { tag(V.MAP); return writeMap(p, v); }
  if (rt.iof(v, "java/util/List")) { tag(V.LIST); return writeList(p, v); }
  if (rt.iof(v, "java/lang/CharSequence")) { tag(V.CHARSEQUENCE); return writeString(p, await csText(v)); }
  if (rt.iof(v, "android/os/IBinder")) { tag(V.IBINDER); return writeObject(p, v); }
  if (rt.iof(v, "java/io/Serializable")) { tag(V.SERIALIZABLE); writeString(p, className(v as JObj)); return writeObject(p, v); }
  throw rt.mkThrowable("java/lang/RuntimeException", "Parcel: unable to marshal value " + className(v as JObj));
}
async function readValue(p: JParcel, loader: unknown): Promise<unknown> {
  const t = readInt(p) as V;
  switch (t) {
    case V.NULL: return null;
    case V.STRING: case V.CHARSEQUENCE: return readString(p);
    case V.INTEGER: return box(JInt, readInt(p));
    case V.LONG: return box(JLong, readLong(p));
    case V.FLOAT: return box(JFloat, readFloat(p));
    case V.DOUBLE: return box(JDouble, readDouble(p));
    case V.BOOLEAN: return box(JBool, readInt(p));
    case V.BYTE: return box(JByte, readInt(p));
    case V.SHORT: return box(JShort, readInt(p));
    case V.CHAR: return box(JChar, readInt(p));
    case V.BYTEARRAY: return readBytes(p);
    case V.INTARRAY: return readPrimArray(p, (n) => new Int32Array(n), () => readInt(p));
    case V.LONGARRAY: return readPrimArray(p, (n) => new BigInt64Array(n), () => readLong(p));
    case V.FLOATARRAY: return readPrimArray(p, (n) => new Float32Array(n), () => readFloat(p));
    case V.DOUBLEARRAY: return readPrimArray(p, (n) => new Float64Array(n), () => readDouble(p));
    case V.BOOLEANARRAY: return readPrimArray(p, (n) => new Uint8Array(n), () => readInt(p));
    case V.CHARARRAY: return readPrimArray(p, (n) => new Uint16Array(n), () => readInt(p));
    case V.SHORTARRAY: return readPrimArray(p, (n) => new Int16Array(n), () => readInt(p));
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
    default: throw rt.mkThrowable("java/lang/RuntimeException", "Parcel: unknown type code " + t);
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
      this.buf = new Uint8Array(len); this.buf.set(new Uint8Array(b.buffer, b.byteOffset + off, len));
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
    "writeCharSequence(Ljava/lang/CharSequence;)V": async function (this: JParcel, s: unknown) { writeString(this, s === null ? null : await csText(s)); },
    "writeByteArray([B)V": function (this: JParcel, b: Int8Array | null) { writeBytes(this, b); },
    "writeByteArray([BII)V": function (this: JParcel, b: Int8Array | null, off: number, len: number) { writeBytes(this, b && b.subarray(off, off + len)); },
    "writeIntArray([I)V": function (this: JParcel, a: Int32Array | null) { writePrimArray(this, a, (x: number) => writeInt(this, x)); },
    "writeLongArray([J)V": function (this: JParcel, a: BigInt64Array | null) { writePrimArray(this, a, (x: bigint) => writeLong(this, x)); },
    "writeFloatArray([F)V": function (this: JParcel, a: Float32Array | null) { writePrimArray(this, a, (x: number) => writeFloat(this, x)); },
    "writeDoubleArray([D)V": function (this: JParcel, a: Float64Array | null) { writePrimArray(this, a, (x: number) => writeDouble(this, x)); },
    "writeBooleanArray([Z)V": function (this: JParcel, a: Uint8Array | null) { writePrimArray(this, a, (x: number) => writeInt(this, x)); },
    "writeCharArray([C)V": function (this: JParcel, a: Uint16Array | null) { writePrimArray(this, a, (x: number) => writeInt(this, x)); },
    [`writeStringArray([${S})V`]: function (this: JParcel, a: string[] | null) { writeStrings(this, a); },
    "writeStringList(Ljava/util/List;)V": async function (this: JParcel, l: unknown) { writeStrings(this, l === null ? null : await toJsArray(l) as string[]); },
    "writeValue(Ljava/lang/Object;)V": maySuspend(function (this: JParcel, v: unknown) { return writeValue(this, v); }),
    "writeList(Ljava/util/List;)V": maySuspend(function (this: JParcel, l: unknown) { return writeList(this, l); }),
    "writeMap(Ljava/util/Map;)V": maySuspend(function (this: JParcel, m: unknown) { return writeMap(this, m); }),
    "writeBundle(Landroid/os/Bundle;)V": maySuspend(function (this: JParcel, b: JBundle | null) { return writeBundle(this, b); }),
    "writeParcelable(Landroid/os/Parcelable;I)V": maySuspend(function (this: JParcel, o: JObj | null, flags: number) { return writeParcelable(this, o, flags); }),
    "writeTypedList(Ljava/util/List;)V": async function (this: JParcel, l: unknown) { return writeTyped(this, l === null ? null : await toJsArray(l), 0); },
    "writeTypedList(Ljava/util/List;I)V": async function (this: JParcel, l: unknown, flags: number) { return writeTyped(this, l === null ? null : await toJsArray(l), flags); },
    "writeTypedArray([Landroid/os/Parcelable;I)V": maySuspend(function (this: JParcel, a: unknown[] | null, flags: number) { return writeTyped(this, a, flags); }),
    "writeTypedObject(Landroid/os/Parcelable;I)V": async function (this: JParcel, o: unknown, flags: number) { if (o === null) writeInt(this, 0); else { writeInt(this, 1); await vcall(o, "writeToParcel", `(${P}I)V`, this, flags); } },
    "writeSerializable(Ljava/io/Serializable;)V": function (this: JParcel, o: unknown) { if (o === null) return writeString(this, null); writeString(this, className(o as JObj)); writeObject(this, o); },
    "writeStrongBinder(Landroid/os/IBinder;)V": function (this: JParcel, b: unknown) { writeObject(this, b); },
    "writeStrongInterface(Landroid/os/IInterface;)V": async function (this: JParcel, value: unknown) { writeObject(this, value ? await vcall(value, "asBinder", "()Landroid/os/IBinder;") : null); },
    [`writeInterfaceToken(${S})V`]: function (this: JParcel, s: string) { writeString(this, s); },
    "writeNoException()V": function (this: JParcel) { writeInt(this, 0); },
    "writeException(Ljava/lang/Exception;)V": async function (this: JParcel, error: unknown) {
      const index = EXCEPTIONS.findIndex((cls) => rt.iof(error, cls));
      if (index < 0) throw error;
      writeInt(this, -index - 1);
      writeString(this, await vcall(error, "getMessage", "()Ljava/lang/String;"));
      writeInt(this, 0);
    },
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
    "createIntArray()[I": function (this: JParcel) { return readPrimArray(this, (n) => new Int32Array(n), () => readInt(this)); },
    "createLongArray()[J": function (this: JParcel) { return readPrimArray(this, (n) => new BigInt64Array(n), () => readLong(this)); },
    "createFloatArray()[F": function (this: JParcel) { return readPrimArray(this, (n) => new Float32Array(n), () => readFloat(this)); },
    "createDoubleArray()[D": function (this: JParcel) { return readPrimArray(this, (n) => new Float64Array(n), () => readDouble(this)); },
    "createBooleanArray()[Z": function (this: JParcel) { return readPrimArray(this, (n) => new Uint8Array(n), () => readInt(this)); },
    "createCharArray()[C": function (this: JParcel) { return readPrimArray(this, (n) => new Uint16Array(n), () => readInt(this)); },
    [`createStringArray()[${S}`]: function (this: JParcel) { return readStrings(this); },
    "createStringArrayList()Ljava/util/ArrayList;": function (this: JParcel) { return readStringList(this); },
    "readIntArray([I)V": function (this: JParcel, out: Int32Array) { const n = readInt(this); for (let i = 0; i < n; i++) out[i] = readInt(this); },
    "readStringList(Ljava/util/List;)V": async function (this: JParcel, out: unknown) { await vcall(out, "clear", "()V"); for (const s of readStrings(this) ?? []) await vcall(out, "add", "(Ljava/lang/Object;)Z", s); },
    [`readValue(${L})Ljava/lang/Object;`]: maySuspend(function (this: JParcel, loader: unknown) { return readValue(this, loader); }),
    [`readArrayList(${L})Ljava/util/ArrayList;`]: maySuspend(function (this: JParcel, loader: unknown) { return readList(this, loader); }),
    [`readList(Ljava/util/List;${L})V`]: async function (this: JParcel, out: unknown, loader: unknown) { for (const v of (await readList(this, loader))?.a ?? []) await vcall(out, "add", "(Ljava/lang/Object;)Z", v); },
    [`readHashMap(${L})Ljava/util/HashMap;`]: maySuspend(function (this: JParcel, loader: unknown) { return readMap(this, loader); }),
    [`readMap(Ljava/util/Map;${L})V`]: async function (this: JParcel, out: unknown, loader: unknown) { const m = await readMap(this, loader); if (m) await vcall(out, "putAll", "(Ljava/util/Map;)V", m); },
    "readBundle()Landroid/os/Bundle;": maySuspend(function (this: JParcel) { return readBundle(this, null); }),
    [`readBundle(${L})Landroid/os/Bundle;`]: maySuspend(function (this: JParcel, loader: unknown) { return readBundle(this, loader); }),
    [`readParcelable(${L})Landroid/os/Parcelable;`]: maySuspend(function (this: JParcel, loader: unknown) { return readParcelable(this, loader); }),
    [`readParcelable(${L}Ljava/lang/Class;)Ljava/lang/Object;`]: maySuspend(function (this: JParcel, loader: unknown) { return readParcelable(this, loader); }),
    [`createTypedArrayList(${CR})Ljava/util/ArrayList;`]: async function (this: JParcel, c: unknown) { const a = await readTyped(this, c); return a && newArrayList(a); },
    [`createTypedArray(${CR})[Ljava/lang/Object;`]: async function (this: JParcel, c: unknown) {
      const a = await readTyped(this, c);
      if (!a) return null;
      const out = await vcall(c, "newArray", "(I)[Ljava/lang/Object;", a.length) as unknown[];
      for (let i = 0; i < a.length; i++) out[i] = a[i];
      return out;
    },
    [`readTypedObject(${CR})Ljava/lang/Object;`]: maySuspend(function (this: JParcel, c: unknown) { return readInt(this) ? createFrom(this, c, null) : null; }),
    [`readTypedList(Ljava/util/List;${CR})V`]: async function (this: JParcel, out: unknown, c: unknown) { await vcall(out, "clear", "()V"); for (const v of (await readTyped(this, c)) ?? []) await vcall(out, "add", "(Ljava/lang/Object;)Z", v); },
    "readSerializable()Ljava/io/Serializable;": async function (this: JParcel) { return readSerializable(this); },
    [`readSerializable(${L}Ljava/lang/Class;)Ljava/io/Serializable;`]: async function (this: JParcel) { return readSerializable(this); },
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
