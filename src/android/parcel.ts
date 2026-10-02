// libbinder's Parcel: the native half behind android.os.Parcel's mNativePtr, whose Java half
// (values, bundles, parcelables, exceptions) runs from AOSP bytecode. AOSP's wire layout (4-byte
// cells, UTF-16 strings, 24-byte flat objects) so dataSize/dataPosition agree with a device. What
// has no byte form here — a binder, a descriptor — rides in a side table keyed by its position.
import { JObj, rt, declaredField } from "../jvm/runtime";
import { utf8, u8 } from "../jvm/abi";
import { scall } from "../jvm/natives/jlang";
import { fdInt, mkFd } from "../jvm/natives/jio";
import { javaCloseFd, javaDupFd } from "../native/fs";
import { ownedHandle, deref, release } from "./handles";
export { parcelCreator } from "./parcelable";

export class NativeParcel {
  buf = new Uint8Array(256);
  view = new DataView(this.buf.buffer);
  pos = 0;
  size = 0;
  objects = new Map<number, unknown>();
  allowFds = true;
  /** where writeInterfaceToken put the caller's work source, -1 for none */
  workSourceAt = -1;
}
/** a binder or descriptor slot: libbinder's flat_binder_object */
const FLAT_OBJECT = 24;
/** a descriptor this parcel owns, as writeDupFileDescriptor leaves one */
export class OwnedFd { constructor(readonly fd: number) {} }

/** a Java Parcel, or the native parcel behind one */
export type JParcel = JObj | NativeParcel;
let ptrField = "";
export const nativeParcel = (p: JParcel): NativeParcel =>
  p instanceof NativeParcel ? p : deref<NativeParcel>((p as unknown as Record<string, bigint>)[ptrField ||= declaredField("android/os/Parcel", "mNativePtr")]);
/** Parcel.obtain() */
export const newParcel = (): Promise<JObj> => scall("android/os/Parcel", "obtain", "()Landroid/os/Parcel;");

function reserve(p: NativeParcel, n: number) {
  if (p.pos + n <= p.buf.length) return;
  const b = new Uint8Array(Math.max(p.buf.length * 2, p.pos + n));
  b.set(p.buf.subarray(0, p.size));
  p.buf = b; p.view = new DataView(b.buffer);
}
const advance = (p: NativeParcel, n: number) => { const at = p.pos; p.pos += n; if (p.pos > p.size) p.size = p.pos; return at; };
const pad4 = (n: number) => (n + 3) & ~3;
export function writeInt(jp: JParcel, v: number) { const p = nativeParcel(jp); reserve(p, 4); p.view.setInt32(advance(p, 4), v | 0, true); }
export function writeLong(jp: JParcel, v: bigint) { const p = nativeParcel(jp); reserve(p, 8); p.view.setBigInt64(advance(p, 8), BigInt.asIntN(64, v), true); }
export function writeFloat(jp: JParcel, v: number) { const p = nativeParcel(jp); reserve(p, 4); p.view.setFloat32(advance(p, 4), v, true); }
export function writeDouble(jp: JParcel, v: number) { const p = nativeParcel(jp); reserve(p, 8); p.view.setFloat64(advance(p, 8), v, true); }
export function readInt(jp: JParcel) { const p = nativeParcel(jp); return p.pos + 4 <= p.size ? p.view.getInt32(advance(p, 4), true) : 0; }
export function readLong(jp: JParcel) { const p = nativeParcel(jp); return p.pos + 8 <= p.size ? p.view.getBigInt64(advance(p, 8), true) : 0n; }
export function readFloat(jp: JParcel) { const p = nativeParcel(jp); return p.pos + 4 <= p.size ? p.view.getFloat32(advance(p, 4), true) : 0; }
export function readDouble(jp: JParcel) { const p = nativeParcel(jp); return p.pos + 8 <= p.size ? p.view.getFloat64(advance(p, 8), true) : 0; }
/** `n` bytes in place, padded to a cell; null past the end, as readInplace */
function inplace(p: NativeParcel, n: number): number | null {
  const len = pad4(n);
  if (n < 0 || p.pos + len > p.size) return null;
  return advance(p, len);
}
function writeInplace(p: NativeParcel, n: number): number {
  const len = pad4(n);
  reserve(p, len);
  const at = advance(p, len);
  p.buf.fill(0, at + n, at + len);
  return at;
}
export function writeString(jp: JParcel, s: string | null) {
  const p = nativeParcel(jp);
  if (s === null) return writeInt(p, -1);
  writeInt(p, s.length);
  const at = writeInplace(p, (s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) p.view.setUint16(at + i * 2, s.charCodeAt(i), true);
}
export function readString(jp: JParcel): string | null {
  const p = nativeParcel(jp), len = readInt(p);
  if (len < 0) return null;
  const at = inplace(p, (len + 1) * 2);
  if (at === null) return null;
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
export function writeString8(jp: JParcel, s: string | null) {
  const p = nativeParcel(jp);
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
  writeInt(p, bytes.length);
  const at = writeInplace(p, bytes.length + 1);
  p.buf.set(bytes, at);
}
export function readString8(jp: JParcel): string | null {
  const p = nativeParcel(jp), len = readInt(p);
  if (len < 0) return null;
  const at = inplace(p, len + 1);
  if (at === null) return null;
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
export const writeByteArray = (jp: JParcel, b: Int8Array | null): void => b ? writeBytes(nativeParcel(jp), b, 0, b.length) : writeInt(jp, -1);
export const createByteArray = (jp: JParcel): Int8Array | null => readBytes(nativeParcel(jp));
function writeBytes(p: NativeParcel, b: Int8Array, off: number, len: number) {
  writeInt(p, len);
  const at = writeInplace(p, len);
  p.buf.set(u8(b, off, len), at);
}
function readBytes(p: NativeParcel): Int8Array | null {
  const len = readInt(p);
  if (len < 0 || len > p.size - p.pos) return null;
  const at = inplace(p, len)!;
  return new Int8Array(p.buf.slice(at, at + len).buffer);
}
/** a flat object: its slot holds zeros here, the side table its value */
export function writeObject(jp: JParcel, o: unknown) {
  const p = nativeParcel(jp);
  p.objects.set(p.pos, o);
  writeInplace(p, FLAT_OBJECT);
}
export function readObject(jp: JParcel): unknown {
  const p = nativeParcel(jp), at = p.pos;
  if (inplace(p, FLAT_OBJECT) === null) return null;
  return p.objects.get(at) ?? null;
}
const isBinder = (o: unknown) => o instanceof JObj && !!(rt.iof(o, "android/os/Binder") || rt.iof(o, "android/os/BinderProxy"));
const isFd = (o: unknown) => o !== null && !isBinder(o);
/** closing what a parcel owns: the descriptors written into it */
export function freeData(p: NativeParcel) {
  for (const o of p.objects.values()) if (o instanceof OwnedFd) javaCloseFd(o.fd);
  p.objects.clear();
  p.pos = p.size = 0;
  p.workSourceAt = -1;
}
const inRange = (p: NativeParcel, test: (o: unknown) => boolean, off = 0, len = p.size) => {
  for (const [at, o] of p.objects) if (at >= off && at < off + len && test(o)) return true;
  return false;
};
/** what a parcel carries across processes: its bytes and its side table */
export type ParcelBytes = { bytes: Uint8Array; objects: [number, unknown][] };
export const parcelBytes = (p: NativeParcel): ParcelBytes => ({ bytes: p.buf.slice(0, p.size), objects: [...p.objects] });
export function setParcelBytes(p: NativeParcel, data: { bytes: Uint8Array; objects: [number, unknown][] }): void {
  freeData(p);
  p.buf = new Uint8Array(data.bytes); p.view = new DataView(p.buf.buffer);
  p.size = p.buf.length;
  p.objects = new Map(data.objects);
}

// utils/Errors.h, as signalExceptionForError (android_util_Binder.cpp) throws them
const BAD_VALUE = -22, FDS_NOT_ALLOWED = 0x80000007 | 0;
const ERRORS: Record<number, [string, string | null]> = {
  [BAD_VALUE]: ["java/lang/IllegalArgumentException", null],
  [-12]: ["java/lang/OutOfMemoryError", null],
  [-61]: ["android/os/ParcelFormatException", "Not enough data"],
  [FDS_NOT_ALLOWED]: ["java/lang/RuntimeException", "Not allowed to write file descriptors here"],
};
const status = (err: number) => { const [cls, msg] = ERRORS[err] ?? ["java/lang/RuntimeException", "Unknown binder error code. 0x" + (err >>> 0).toString(16)]; return rt.mkThrowable(cls, msg); };
export const parcelAt = (ptr: bigint): NativeParcel => deref<NativeParcel>(ptr);
const ok = (f: () => void) => { f(); return 0; };

rt.registerJnis("android/os/Parcel", {
  "nativeCreate()J": () => ownedHandle(new NativeParcel()),
  "nativeDestroy(J)V": (ptr: bigint) => { const p = parcelAt(ptr); if (p) { freeData(p); release(ptr); } },
  "nativeFreeBuffer(J)V": (ptr: bigint) => { const p = parcelAt(ptr); freeData(p); p.allowFds = true; },
  "nativeMarkSensitive(J)V": () => {},
  // one wire format serves every binder here, so nothing marks a parcel for its target's
  "nativeMarkForBinder(JLandroid/os/IBinder;)V": () => {},
  "nativeIsForRpc(J)Z": () => 0,
  "nativeDataSize(J)I": (ptr: bigint) => parcelAt(ptr).size,
  "nativeDataAvail(J)I": (ptr: bigint) => { const p = parcelAt(ptr); return Math.max(0, p.size - p.pos); },
  "nativeDataPosition(J)I": (ptr: bigint) => parcelAt(ptr).pos,
  "nativeDataCapacity(J)I": (ptr: bigint) => parcelAt(ptr).buf.length,
  "nativeSetDataSize(JI)V": (ptr: bigint, n: number) => {
    if (n < 0) throw status(BAD_VALUE);
    const p = parcelAt(ptr), pos = p.pos;
    p.pos = 0; reserve(p, n); p.pos = Math.min(pos, n);
    if (n < p.size) for (const k of p.objects.keys()) if (k >= n) p.objects.delete(k);
    p.size = n;
  },
  "nativeSetDataPosition(JI)V": (ptr: bigint, pos: number) => { parcelAt(ptr).pos = pos; },
  "nativeSetDataCapacity(JI)V": (ptr: bigint, n: number) => {
    if (n < 0) throw status(BAD_VALUE);
    const p = parcelAt(ptr), pos = p.pos;
    p.pos = 0; reserve(p, n); p.pos = pos;
  },
  "nativePushAllowFds(JZ)Z": (ptr: bigint, allow: number) => { const p = parcelAt(ptr), was = p.allowFds; p.allowFds = !!allow && was; return +was; },
  "nativeRestoreAllowFds(JZ)V": (ptr: bigint, allow: number) => { parcelAt(ptr).allowFds = !!allow; },
  "nativeWriteByteArray(J[BII)V": (ptr: bigint, b: Int8Array | null, off: number, len: number) => b ? writeBytes(parcelAt(ptr), b, off, len) : writeInt(parcelAt(ptr), -1),
  // a blob always travels in place: ashmem descriptors are what this host cannot share
  "nativeWriteBlob(J[BII)V": (ptr: bigint, b: Int8Array | null, off: number, len: number) => {
    const p = parcelAt(ptr);
    if (!b) return writeInt(p, -1);
    writeInt(p, len); writeInt(p, 0);
    const to = writeInplace(p, len);
    p.buf.set(u8(b, off, len), to);
  },
  "nativeReadBlob(J)[B": (ptr: bigint) => {
    const p = parcelAt(ptr), len = readInt(p);
    if (len < 0) return null;
    if (readInt(p) !== 0) throw status(BAD_VALUE);
    const from = inplace(p, len);
    return from === null ? null : new Int8Array(p.buf.slice(from, from + len).buffer);
  },
  "nativeWriteInt(JI)I": (ptr: bigint, v: number) => ok(() => writeInt(parcelAt(ptr), v)),
  "nativeWriteLong(JJ)I": (ptr: bigint, v: bigint) => ok(() => writeLong(parcelAt(ptr), v)),
  "nativeWriteFloat(JF)I": (ptr: bigint, v: number) => ok(() => writeFloat(parcelAt(ptr), v)),
  "nativeWriteDouble(JD)I": (ptr: bigint, v: number) => ok(() => writeDouble(parcelAt(ptr), v)),
  "nativeSignalExceptionForError(I)V": (err: number) => { throw status(err); },
  "nativeWriteString8(JLjava/lang/String;)V": (ptr: bigint, s: string | null) => writeString8(parcelAt(ptr), s),
  "nativeWriteString16(JLjava/lang/String;)V": (ptr: bigint, s: string | null) => writeString(parcelAt(ptr), s),
  // a non-binder object writes the null binder, as ibinderForJavaObject answers for it
  "nativeWriteStrongBinder(JLandroid/os/IBinder;)V": (ptr: bigint, b: unknown) => {
    const p = parcelAt(ptr);
    writeObject(p, isBinder(b) ? b : null); writeInt(p, 0); // the binder's stability
  },
  "nativeWriteFileDescriptor(JLjava/io/FileDescriptor;)V": (ptr: bigint, d: JObj | null) => {
    const p = parcelAt(ptr);
    if (!p.allowFds) throw status(FDS_NOT_ALLOWED);
    const fd = javaDupFd(fdInt(d));
    if (fd < 0) throw status(BAD_VALUE);
    writeObject(p, new OwnedFd(fd));
  },
  "nativeCreateByteArray(J)[B": (ptr: bigint) => readBytes(parcelAt(ptr)),
  "nativeReadByteArray(J[BI)Z": (ptr: bigint, dest: Int8Array | null, n: number) => {
    const p = parcelAt(ptr), len = readInt(p);
    if (!dest || len !== n || len > p.size - p.pos) return 0;
    const from = inplace(p, len)!;
    dest.set(new Int8Array(p.buf.buffer, from, len));
    return 1;
  },
  "nativeReadInt(J)I": (ptr: bigint) => readInt(parcelAt(ptr)),
  "nativeReadLong(J)J": (ptr: bigint) => readLong(parcelAt(ptr)),
  "nativeReadFloat(J)F": (ptr: bigint) => readFloat(parcelAt(ptr)),
  "nativeReadDouble(J)D": (ptr: bigint) => readDouble(parcelAt(ptr)),
  "nativeReadString8(J)Ljava/lang/String;": (ptr: bigint) => readString8(parcelAt(ptr)),
  "nativeReadString16(J)Ljava/lang/String;": (ptr: bigint) => readString(parcelAt(ptr)),
  "nativeReadStrongBinder(J)Landroid/os/IBinder;": (ptr: bigint) => {
    const p = parcelAt(ptr), b = readObject(p);
    readInt(p);
    return isBinder(b) ? b : null;
  },
  "nativeReadFileDescriptor(J)Ljava/io/FileDescriptor;": (ptr: bigint) => {
    const o = readObject(parcelAt(ptr));
    return o instanceof OwnedFd ? mkFd(javaDupFd(o.fd)) : null;
  },
  "nativeMarshall(J)[B": (ptr: bigint) => {
    const p = parcelAt(ptr);
    if (p.objects.size) throw rt.mkThrowable("java/lang/RuntimeException", "Tried to marshall a Parcel that contained Binder objects.");
    return new Int8Array(p.buf.slice(0, p.size).buffer);
  },
  "nativeUnmarshall(J[BII)V": (ptr: bigint, b: Int8Array, off: number, len: number) => {
    if ((off | len) < 0 || off > b.length - len) throw rt.mkThrowable("java/lang/RuntimeException", "Illegal array bounds");
    const p = parcelAt(ptr);
    setParcelBytes(p, { bytes: u8(b, off, len), objects: [] });
  },
  "nativeCompareData(JJ)I": (a: bigint, b: bigint) => {
    const x = parcelAt(a), y = parcelAt(b), n = Math.min(x.size, y.size);
    for (let i = 0; i < n; i++) if (x.buf[i] !== y.buf[i]) return x.buf[i] - y.buf[i];
    return x.size - y.size;
  },
  "nativeCompareDataInRange(JIJII)Z": (a: bigint, aOff: number, b: bigint, bOff: number, len: number) => {
    const x = parcelAt(a), y = parcelAt(b);
    if (len < 0 || aOff < 0 || bOff < 0 || aOff + len > x.size || bOff + len > y.size) throw status(BAD_VALUE);
    for (let i = 0; i < len; i++) if (x.buf[aOff + i] !== y.buf[bOff + i]) return 0;
    return 1;
  },
  "nativeAppendFrom(JJII)V": (ptr: bigint, from: bigint, off: number, len: number) => {
    const p = parcelAt(ptr), o = parcelAt(from);
    if (off < 0 || len < 0 || off + len > o.size) throw status(BAD_VALUE);
    reserve(p, len);
    const to = advance(p, len);
    p.buf.set(o.buf.subarray(off, off + len), to);
    for (const [k, v] of o.objects) if (k >= off && k < off + len) p.objects.set(to + k - off, v instanceof OwnedFd ? new OwnedFd(javaDupFd(v.fd)) : v);
  },
  "nativeHasBinders(J)Z": (ptr: bigint) => +inRange(parcelAt(ptr), isBinder),
  "nativeHasBindersInRange(JII)Z": (ptr: bigint, off: number, len: number) => +inRange(parcelAt(ptr), isBinder, off, len),
  "nativeHasFileDescriptors(J)Z": (ptr: bigint) => +inRange(parcelAt(ptr), isFd),
  "nativeHasFileDescriptorsInRange(JII)Z": (ptr: bigint, off: number, len: number) => +inRange(parcelAt(ptr), isFd, off, len),
  "nativeGetOpenAshmemSize(J)J": () => 0n,
});
