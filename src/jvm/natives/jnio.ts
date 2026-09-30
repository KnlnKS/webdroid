// java.nio.* buffers backed by a shared ArrayBuffer. position/limit/capacity semantics.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { defineException, vcall, after, checkFromIndexSize } from "./jlang";
import { mem } from "../../native/mem";
import { charsToString, jarray, mangleMethod } from "../abi";
import { CHARSETS, charsetInfo, decodeString, encodeByte, encodeString } from "../charset";
import { handle } from "../../android/handles";
import { newStringSet } from "./jcoll";
import { readFully, type FileSource } from "../../shell/lazyfile";

/** A native buffer's array is ART's accessible one for allocateDirect (a view over its own guest
 *  bytes) and null for one over native memory (NewDirectByteBuffer, a promoted direct buffer).
 *  A direct buffer outside guest memory has one only when no native code can take its address. */
type BufferStorage = { kind: "heap"; array: ArrayBufferView } | { kind: "direct"; ab: ArrayBuffer; array?: Int8Array } | { kind: "native"; address: number | bigint; array: Int8Array | null };
const directBuffers = new FinalizationRegistry<number>((address) => mem.free(address));
function accessibleArray(b: JBuffer): ArrayBufferView | null {
  const s = b.backing.storage, array = s.array ?? null;
  return array && !b.readOnly && (array as Uint8Array).BYTES_PER_ELEMENT === 2 ** b.elemShift &&
    (!(b instanceof JCharBuffer) || array instanceof Uint16Array) ? array : null;
}

export class JBuffer extends JObj {
  backing!: { storage: BufferStorage };
  /** the pages of a mapping that loads them on first touch */
  paging: Paging | null = null;
  byteOffset = 0;
  private view: DataView | null = null;
  // JSC copies a small typed array out to its own ArrayBuffer on its first .buffer, so a heap
  // array's is read only when needed, not on every CharBuffer.wrap of a fresh char[]
  get ab(): ArrayBuffer {
    const s = this.backing.storage;
    if (this.paging) throw new Error("a paged mapping's bytes read before `resident`");
    return s.kind === "native" ? mem.buf : s.kind === "heap" ? s.array.buffer as ArrayBuffer : s.ab;
  }
  get direct(): boolean { return this.backing.storage.kind !== "heap"; }
  get dv(): DataView {
    const s = this.backing.storage;
    const offset = this.byteOffset + (s.kind === "native" ? typeof s.address === "bigint" ? mem.txVa(s.address) : s.address : 0);
    const ab = this.ab;
    if (!this.view || this.view.buffer !== ab || this.view.byteOffset !== offset) this.view = new DataView(ab, offset, this.cap * 2 ** this.elemShift);
    return this.view;
  }
  pos = 0;
  lim = 0;
  cap = 0;
  mark = -1;
  little = false;         // byte order (default big-endian per Java)
  elemShift = 0;          // log2(bytes per element): byte=0, short/char=1, int/float=2, long/double=3
  readOnly = false;
  clampPut(need: number) {
    if (this.readOnly) throw rt.mkThrowable("java/nio/ReadOnlyBufferException", null);
    if (this.pos + need > this.lim) throw rt.mkThrowable("java/nio/BufferOverflowException", null);
  }
  clampGet(need: number) {
    if (this.pos + need > this.lim) throw rt.mkThrowable("java/nio/BufferUnderflowException", null);
  }
}

// The chaining methods. Each concrete buffer narrows their return type (covariant overrides,
// API 24+), and a dex carries whichever descriptor its compile SDK had — D8 even rewrites the
// narrowed call back to the Buffer-typed one for a low minSdk — so every buffer answers both.
const chainBodies: Record<string, (this: JBuffer, ...a: number[]) => JBuffer> = {
  "position(I)": function (p) { this.pos = p; if (this.mark > p) this.mark = -1; return this; },
  "limit(I)": function (l) { this.lim = l; if (this.pos > l) this.pos = l; if (this.mark > l) this.mark = -1; return this; },
  "clear()": function () { this.pos = 0; this.lim = this.cap; this.mark = -1; return this; },
  "flip()": function () { this.lim = this.pos; this.pos = 0; this.mark = -1; return this; },
  "rewind()": function () { this.pos = 0; this.mark = -1; return this; },
  "mark()": function () { this.mark = this.pos; return this; },
  "reset()": function () { if (this.mark >= 0) this.pos = this.mark; return this; },
};
function chaining(retType: string): NonNullable<NativeSpec["methods"]> {
  const m: NonNullable<NativeSpec["methods"]> = {};
  for (const k in chainBodies) m[k + retType] = chainBodies[k];
  return m;
}

function bufferBaseMethods(): NativeSpec["methods"] {
  return {
    ...chaining("Ljava/nio/Buffer;"),
    "capacity()I": function (this: JBuffer) { return this.cap; },
    "position()I": function (this: JBuffer) { return this.pos; },
    "limit()I": function (this: JBuffer) { return this.lim; },
    "remaining()I": function (this: JBuffer) { return this.lim - this.pos; },
    "hasRemaining()Z": function (this: JBuffer) { return this.pos < this.lim ? 1 : 0; },
    "isDirect()Z": function (this: JBuffer) { return this.direct ? 1 : 0; },
    "isReadOnly()Z": function (this: JBuffer) { return +this.readOnly; },
    "hasArray()Z": function (this: JBuffer) { return accessibleArray(this) ? 1 : 0; },
    "arrayOffset()I": function (this: JBuffer) {
      const array = accessibleArray(this);
      if (!array) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
      return (this.dv.byteOffset - array.byteOffset) >> this.elemShift;
    },
  };
}

const PAGE_SHIFT = 16, PAGE = 1 << PAGE_SHIFT;
type Read = (view: DataView, at: number, little: boolean) => number | bigint;
/** A read-only mapping of an immutable file holds the pages it has touched, each loaded on first
 *  touch as a device's mmap faults it in. A read waits for its pages; TS code that reads the bytes
 *  itself waits for `resident`. */
class Paging {
  readonly pages: (DataView | undefined)[];
  private readonly loading = new Map<number, Promise<void>>();
  private readonly copies = new Map<string, ArrayBuffer>();
  constructor(private readonly source: FileSource, private readonly offset: number, private readonly size: number) {
    this.pages = new Array((size + PAGE - 1) >>> PAGE_SHIFT);
  }
  missing(at: number, n: number): boolean {
    for (let p = at >>> PAGE_SHIFT, last = (at + n - 1) >> PAGE_SHIFT; p <= last; p++) if (!this.pages[p]) return true;
    return false;
  }
  /** null when [at, at + n) is resident, else a Promise that settles once it is. Its missing pages
   *  load together, each by its own read. */
  load(at: number, n: number): Promise<void> | null {
    let waits: Promise<void>[] | null = null;
    for (let p = at >>> PAGE_SHIFT, last = (at + n - 1) >> PAGE_SHIFT; p <= last; p++)
      if (!this.pages[p]) (waits ??= []).push(this.loading.get(p) ?? this.fetch(p));
    return waits && (waits.length === 1 ? waits[0] : Promise.all(waits).then(() => {}));
  }
  private fetch(p: number): Promise<void> {
    const start = p << PAGE_SHIFT, n = Math.min(PAGE, this.size - start);
    const wait = readFully(this.source, this.offset + start, n).then((data) => {
      if (data.length !== n) throw new Error(`short read of a mapped page at ${this.offset + start}`);
      this.pages[p] = new DataView(data.buffer, data.byteOffset, n);
    }).finally(() => this.loading.delete(p));
    this.loading.set(p, wait);
    return wait;
  }
  /** resident [at, at + n) into `out` at `to` */
  copy(at: number, n: number, out: Uint8Array, to: number): void {
    for (let end = at + n; at < end;) {
      const page = this.pages[at >>> PAGE_SHIFT]!, from = at & (PAGE - 1), k = Math.min(end - at, page.byteLength - from);
      out.set(new Uint8Array(page.buffer, page.byteOffset + from, k), to);
      at += k; to += k;
    }
  }
  /** `b` reads resident [at, at + n) of the mapping as its own direct bytes: its page, or a copy
   *  of the pages it spans shared by the buffers over that range */
  rebase(b: JBuffer, at: number, n: number): void {
    const page = this.pages[at >>> PAGE_SHIFT];
    let ab: ArrayBuffer | undefined, offset = 0;
    if (!n) ab = new ArrayBuffer(0);
    else if (at >>> PAGE_SHIFT === (at + n - 1) >>> PAGE_SHIFT) { ab = page!.buffer as ArrayBuffer; offset = page!.byteOffset + (at & (PAGE - 1)); }
    else {
      const key = `${at}+${n}`;
      ab = this.copies.get(key);
      if (!ab) { ab = new ArrayBuffer(n); this.copy(at, n, new Uint8Array(ab), 0); this.copies.set(key, ab); }
    }
    b.paging = null;
    b.backing = { storage: { kind: "direct", ab } };
    b.byteOffset = offset;
  }
  /** a read that waits for its pages or crosses one */
  read(at: number, width: number, read: Read, little: boolean): number | bigint | Promise<number | bigint> {
    const wait = this.load(at, width);
    if (wait) return wait.then(() => this.read(at, width, read, little));
    const bytes = new Uint8Array(8);
    this.copy(at, width, bytes, 0);
    return read(new DataView(bytes.buffer), 0, little);
  }
}
/** null when TS code can read `b`'s bytes, else a Promise that settles once it can: a paged
 *  mapping's buffer loads the pages it spans and reads them as one contiguous range */
export function resident(b: JBuffer): Promise<void> | null {
  const paging = b.paging;
  if (!paging) return null;
  const at = b.byteOffset, n = b.cap;
  const wait = paging.load(at, n);
  if (wait) return wait.then(() => paging.rebase(b, at, n));
  paging.rebase(b, at, n);
  return null;
}

class JByteBuffer extends JBuffer {}
export const remainingBytes = (b: JBuffer) => new Int8Array(b.dv.buffer, b.dv.byteOffset + b.pos, b.lim - b.pos);
function compareByteBuffers(this: JByteBuffer, other: JByteBuffer) {
  return after(resident(this), () => after(resident(other), () => {
    const a = remainingBytes(this), b = remainingBytes(other);
    for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }));
}
/** ByteBuffer's typed reads; a mapping's wait for their pages */
const READS: [string, string, number, Read][] = [
  ["get", "B", 1, (view, at) => view.getInt8(at)],
  ["getShort", "S", 2, (view, at, little) => view.getInt16(at, little)],
  ["getChar", "C", 2, (view, at, little) => view.getUint16(at, little)],
  ["getInt", "I", 4, (view, at, little) => view.getInt32(at, little)],
  ["getLong", "J", 8, (view, at, little) => view.getBigInt64(at, little)],
  ["getFloat", "F", 4, (view, at, little) => view.getFloat32(at, little)],
  ["getDouble", "D", 8, (view, at, little) => view.getFloat64(at, little)],
];
rt.register({
  name: "java/nio/Buffer", ctor: JBuffer,
  methods: bufferBaseMethods(),
});

const byteBufferMethods: Record<string, (this: JByteBuffer, ...a: any[]) => unknown> = {
  ...bufferBaseMethods(),
  ...chaining("Ljava/nio/ByteBuffer;"),
  "setAccessible(Z)V": () => {},
  "static allocateDirect(I)Ljava/nio/ByteBuffer;": allocateDirect,
  "static allocate(I)Ljava/nio/ByteBuffer;": (cap: number) => mkByteBuffer(cap),
  "static wrap([B)Ljava/nio/ByteBuffer;": (arr: Int8Array) => wrapArray(JByteBuffer, arr, 0),
  "static wrap([BII)Ljava/nio/ByteBuffer;": (arr: Int8Array, off: number, len: number) => wrapArray(JByteBuffer, arr, 0, off, len),
  "order(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, o: { little: boolean }) {
    this.little = !!o?.little; return this;
  },
  "order()Ljava/nio/ByteOrder;": function (this: JByteBuffer) { rt.link("java/nio/ByteOrder"); return this.little ? byteOrderLE : byteOrderBE; },
  "put(B)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(1); this.dv.setInt8(this.pos++, v); return this; },
  "put(IB)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setInt8(i, v); return this; },
  "put([B)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array) {
    this.clampPut(arr.length);
    bytes(this).set(arr, this.pos); this.pos += arr.length; return this;
  },
  "put([BII)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array, off: number, len: number) {
    this.clampPut(len);
    bytes(this).set(arr.subarray(off, off + len), this.pos); this.pos += len; return this;
  },
  "put(Ljava/nio/ByteBuffer;)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, src: JByteBuffer) {
    const n = src.lim - src.pos;
    this.clampPut(n);
    return after(resident(src), () => {
      bytes(this).set(bytes(src).subarray(src.pos, src.lim), this.pos);
      this.pos += n; src.pos += n; return this;
    });
  },
  // AOSP compares and hashes the remaining bytes, not the object: Tink checks a GCM
  // ciphertext's prepended IV with wrap(iv).equals(wrap(ciphertext, 0, 12))
  "equals(Ljava/lang/Object;)Z": function (this: JByteBuffer, o: unknown) {
    return o instanceof JByteBuffer ? after(compareByteBuffers.call(this, o), (c) => +(c === 0)) : 0;
  },
  "hashCode()I": function (this: JByteBuffer) {
    return after(resident(this), () => {
      const a = remainingBytes(this);
      let h = 1;
      for (let i = a.length - 1; i >= 0; i--) h = (Math.imul(31, h) + a[i]) | 0;
      return h;
    });
  },
  "compareTo(Ljava/nio/ByteBuffer;)I": compareByteBuffers,
  "compareTo(Ljava/lang/Object;)I": compareByteBuffers,
  "get()B": function (this: JByteBuffer) { this.clampGet(1); return this.dv.getInt8(this.pos++); },
  "get(I)B": function (this: JByteBuffer, i: number) { return this.dv.getInt8(i); },
  "get([B)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array) {
    this.clampGet(arr.length);
    arr.set(bytes(this).subarray(this.pos, this.pos + arr.length)); this.pos += arr.length; return this;
  },
  "get([BII)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array, off: number, len: number) {
    this.clampGet(len);
    arr.set(bytes(this).subarray(this.pos, this.pos + len), off); this.pos += len; return this;
  },
  "putShort(S)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(2); this.dv.setInt16(this.pos, v, this.little); this.pos += 2; return this; },
  "putShort(IS)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setInt16(i, v, this.little); return this; },
  "getShort()S": function (this: JByteBuffer) { this.clampGet(2); const v = this.dv.getInt16(this.pos, this.little); this.pos += 2; return v; },
  "getShort(I)S": function (this: JByteBuffer, i: number) { return this.dv.getInt16(i, this.little); },
  "putChar(C)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(2); this.dv.setUint16(this.pos, v, this.little); this.pos += 2; return this; },
  "getChar()C": function (this: JByteBuffer) { this.clampGet(2); const v = this.dv.getUint16(this.pos, this.little); this.pos += 2; return v; },
  "getChar(I)C": function (this: JByteBuffer, i: number) { return this.dv.getUint16(i, this.little); },
  "putChar(IC)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setUint16(i, v, this.little); return this; },
  "putInt(I)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setInt32(this.pos, v, this.little); this.pos += 4; return this; },
  "putInt(II)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setInt32(i, v, this.little); return this; },
  "getInt()I": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getInt32(this.pos, this.little); this.pos += 4; return v; },
  "getInt(I)I": function (this: JByteBuffer, i: number) { return this.dv.getInt32(i, this.little); },
  "putLong(J)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: bigint) { this.clampPut(8); this.dv.setBigInt64(this.pos, v, this.little); this.pos += 8; return this; },
  "getLong()J": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getBigInt64(this.pos, this.little); this.pos += 8; return v; },
  "getLong(I)J": function (this: JByteBuffer, i: number) { return this.dv.getBigInt64(i, this.little); },
  "putLong(IJ)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: bigint) { this.clampPut(0); this.dv.setBigInt64(i, v, this.little); return this; },
  "putFloat(F)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setFloat32(this.pos, v, this.little); this.pos += 4; return this; },
  "putFloat(IF)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setFloat32(i, v, this.little); return this; },
  "getFloat()F": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getFloat32(this.pos, this.little); this.pos += 4; return v; },
  "getFloat(I)F": function (this: JByteBuffer, i: number) { return this.dv.getFloat32(i, this.little); },
  "putDouble(D)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(8); this.dv.setFloat64(this.pos, v, this.little); this.pos += 8; return this; },
  "getDouble()D": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getFloat64(this.pos, this.little); this.pos += 8; return v; },
  "getDouble(I)D": function (this: JByteBuffer, i: number) { return this.dv.getFloat64(i, this.little); },
  "putDouble(ID)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setFloat64(i, v, this.little); return this; },
  "asFloatBuffer()Ljava/nio/FloatBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/FloatBuffer").ctor, 2); },
  "asIntBuffer()Ljava/nio/IntBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/IntBuffer").ctor, 2); },
  "asShortBuffer()Ljava/nio/ShortBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/ShortBuffer").ctor, 1); },
  "asCharBuffer()Ljava/nio/CharBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/CharBuffer").ctor, 1); },
  "asDoubleBuffer()Ljava/nio/DoubleBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/DoubleBuffer").ctor, 3); },
  "asLongBuffer()Ljava/nio/LongBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/LongBuffer").ctor, 3); },
  "slice()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
    const b = new (this.constructor as new () => JByteBuffer)();
    b.backing = this.backing; b.paging = this.paging; b.byteOffset = this.byteOffset + this.pos;
    b.cap = b.lim = this.lim - this.pos; b.pos = 0; b.little = this.little; b.readOnly = this.readOnly;
    return b;
  },
  "duplicate()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
    return duplicateBuffer(this);
  },
  "asReadOnlyBuffer()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) { const b = duplicateBuffer(this); b.readOnly = true; return b; },
  "compact()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
    this.clampPut(0);
    const n = this.lim - this.pos;
    bytes(this).copyWithin(0, this.pos, this.lim);
    this.pos = n; this.lim = this.cap;
    return this;
  },
  "array()[B": backingArray,
};
rt.register({ name: "java/nio/ByteBuffer", ctor: JByteBuffer, sup: "java/nio/Buffer", ifaces: ["java/lang/Comparable"], methods: byteBufferMethods });
// a mapping's reads wait for their pages
function getPaged(this: JByteBuffer, paging: Paging, arr: Int8Array, off: number, len: number): JByteBuffer | Promise<JByteBuffer> {
  checkFromIndexSize(off, len, arr.length);
  this.clampGet(len);
  const at = this.byteOffset + this.pos;
  return after(paging.load(at, len), () => {
    paging.copy(at, len, new Uint8Array(arr.buffer, arr.byteOffset, arr.length), off);
    this.pos += len;
    return this;
  });
}
const getArray = byteBufferMethods["get([B)Ljava/nio/ByteBuffer;"], getRange = byteBufferMethods["get([BII)Ljava/nio/ByteBuffer;"];
const pagedReads: typeof byteBufferMethods = {
  "get([B)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array) {
    const paging = this.paging;
    return paging ? getPaged.call(this, paging, arr, 0, arr.length) : getArray.call(this, arr);
  },
  "get([BII)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, arr: Int8Array, off: number, len: number) {
    const paging = this.paging;
    return paging ? getPaged.call(this, paging, arr, off, len) : getRange.call(this, arr, off, len);
  },
};
for (const [name, d, width, read] of READS) {
  const next = byteBufferMethods[`${name}()${d}`], at = byteBufferMethods[`${name}(I)${d}`];
  const paged = (b: JByteBuffer, paging: Paging, i: number) => {
    const abs = b.byteOffset + i, page = paging.pages[abs >>> PAGE_SHIFT], off = abs & (PAGE - 1);
    return page !== undefined && off <= page.byteLength - width ? read(page, off, b.little) : paging.read(abs, width, read, b.little);
  };
  pagedReads[`${name}()${d}`] = function (this: JByteBuffer) {
    const paging = this.paging;
    if (!paging) return next.call(this);
    this.clampGet(width);
    this.pos += width;
    return paged(this, paging, this.pos - width);
  };
  pagedReads[`${name}(I)${d}`] = function (this: JByteBuffer, i: number) {
    const paging = this.paging;
    if (!paging) return at.call(this, i);
    if (i < 0 || i > this.lim - width) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(i));
    return paged(this, paging, i);
  };
}
// a mapping's slices and duplicates are mappings, as a device's DirectByteBuffer's are
function duplicateBuffer(source: JByteBuffer): JByteBuffer {
  const b = new (source.constructor as new () => JByteBuffer)();
  b.backing = source.backing; b.paging = source.paging; b.byteOffset = source.byteOffset;
  b.cap = source.cap; b.lim = source.lim; b.pos = source.pos; b.mark = source.mark; b.little = source.little; b.readOnly = source.readOnly;
  return b;
}
defineException("java/nio/ReadOnlyBufferException", "java/lang/UnsupportedOperationException");
class JMappedByteBuffer extends JByteBuffer { flush: (() => void) | null = null; }
rt.register({
  name: "java/nio/MappedByteBuffer", ctor: JMappedByteBuffer, sup: "java/nio/ByteBuffer",
  methods: {
    ...chaining("Ljava/nio/MappedByteBuffer;"),
    ...pagedReads,
    "asFloatBuffer()Ljava/nio/FloatBuffer;": pagedView("java/nio/FloatBuffer", 2),
    "asIntBuffer()Ljava/nio/IntBuffer;": pagedView("java/nio/IntBuffer", 2),
    "asShortBuffer()Ljava/nio/ShortBuffer;": pagedView("java/nio/ShortBuffer", 1),
    "asCharBuffer()Ljava/nio/CharBuffer;": pagedView("java/nio/CharBuffer", 1),
    "asDoubleBuffer()Ljava/nio/DoubleBuffer;": pagedView("java/nio/DoubleBuffer", 3),
    "asLongBuffer()Ljava/nio/LongBuffer;": pagedView("java/nio/LongBuffer", 3),
    "isLoaded()Z": function (this: JMappedByteBuffer) { return +!this.paging?.missing(this.byteOffset, this.cap); },
    "load()Ljava/nio/MappedByteBuffer;": function (this: JMappedByteBuffer) {
      return after(this.paging?.load(this.byteOffset, this.cap) ?? null, () => this);
    },
    "force()Ljava/nio/MappedByteBuffer;": function (this: JMappedByteBuffer) { this.flush?.(); return this; },
  },
});
/** A mapping's typed view reads the pages it spans as one contiguous range. */
function pagedView(name: string, shift: number) {
  return function (this: JMappedByteBuffer) {
    const paging = this.paging, Ctor = rt.link(name).ctor;
    if (!paging) return viewBuffer(this, Ctor, shift);
    const at = this.byteOffset + this.pos, n = this.lim - this.pos;
    return after(paging.load(at, n), () => {
      const view = viewBuffer(this, Ctor, shift);
      paging.rebase(view, at, n);
      return view;
    });
  };
}
/** A buffer over `data` itself; `flush` (force) persists the file a READ_WRITE mapping shares its bytes with, and a read-only
 *  mapping has none. The bytes are the mapping, so a writer's stores are in the file's storage before any force. */
export function mappedBuffer(data: Uint8Array, flush: (() => void) | null): JBuffer {
  rt.link("java/nio/MappedByteBuffer");
  const buffer = new JMappedByteBuffer();
  buffer.backing = { storage: { kind: "direct", ab: data.buffer as ArrayBuffer } };
  buffer.byteOffset = data.byteOffset; buffer.cap = buffer.lim = data.length; buffer.readOnly = flush === null;
  buffer.flush = flush;
  return buffer;
}
export const mappedReadOnlyBuffer = (data: Uint8Array): JBuffer => mappedBuffer(data, null);
/** a read-only mapping of an immutable source, whose pages load on first touch */
export function pagedMapping(source: FileSource, offset: number, length: number): JBuffer {
  const buffer = mappedBuffer(new Uint8Array(0), null);
  buffer.cap = buffer.lim = length;
  if (length) buffer.paging = new Paging(source, offset, length);
  return buffer;
}
export function mkByteBuffer(cap: number, direct = false): JByteBuffer {
  if (cap < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative buffer capacity");
  const b = new JByteBuffer();
  const ab = new ArrayBuffer(cap);
  b.backing = { storage: direct ? { kind: "direct", ab } : { kind: "heap", array: new Int8Array(ab) } };
  b.cap = b.lim = cap;
  b.pos = 0;
  return b;
}
/** sizes guest memory for the app's native ABI before its first library loads; false when it
 *  ships none (the native tier sets it) */
let sizeNativeMemory = (): boolean => false;
export function setNativeMemorySizer(sizer: () => boolean): void { sizeNativeMemory = sizer; }
/** ByteBuffer.allocateDirect: in sized guest memory, whose views stay attached, the buffer's
 *  accessible array and native address are the same bytes, as on ART. An app with native
 *  libraries has its memory sized for them first; without any, its own bytes are the array. */
function allocateDirect(cap: number): JByteBuffer {
  if (cap < 0 || !mem.sized() && !sizeNativeMemory()) {
    const b = mkByteBuffer(cap, true), s = b.backing.storage;
    if (s.kind === "direct") s.array = new Int8Array(s.ab);
    return b;
  }
  const address = mem.calloc(1, Math.max(1, cap));
  if (!address) throw rt.mkThrowable("java/lang/OutOfMemoryError", "direct buffer");
  const b = new JByteBuffer();
  b.backing = { storage: { kind: "native", address, array: new Int8Array(mem.buf, address, cap) } };
  directBuffers.register(b.backing, address);
  b.cap = b.lim = cap;
  return b;
}

export function nativeByteBuffer(address: number, cap: number): JBuffer {
  rt.link("java/nio/ByteBuffer");
  const b = new JByteBuffer();
  b.backing = { storage: { kind: "native", address: mem.va(address), array: null } };
  b.cap = b.lim = cap;
  return b;
}

export function directBufferAddress(b: JBuffer): number | bigint {
  let s = b.backing.storage;
  if (s.kind === "heap") return 0;
  if (b.paging) throw new Error("a paged mapping's address taken before `resident`");
  if (s.kind === "direct") {
    // Promotion waits for native ABI selection and updates every existing slice/view together;
    // it ends any array's aliasing, which only code outside the app's own libraries can reach.
    const address = mem.malloc(s.ab.byteLength);
    if (!address) throw rt.mkThrowable("java/lang/OutOfMemoryError", "direct buffer");
    mem.u8.set(new Uint8Array(s.ab), address);
    s = b.backing.storage = { kind: "native", address, array: null };
    directBuffers.register(b.backing, address);
  }
  return typeof s.address === "bigint" ? s.address + BigInt(b.byteOffset) : s.address + b.byteOffset;
}
// A wrapped or sliced buffer does not start at byte 0 of its ArrayBuffer.
function bytes(b: JByteBuffer): Int8Array {
  return new Int8Array(b.ab, b.dv.byteOffset, b.cap);
}
// Java's wrap shares the array: writes through either side show on the other. A typed array is
// laid out in native order, so a wrapped typed buffer reads little-endian (Java's order() for it
// too); ByteBuffer.wrap keeps Java's big-endian default.
type ElemArray = Int8Array | Int16Array | Uint16Array | Int32Array | Float32Array | BigInt64Array | Float64Array;
function wrapArray<T extends JBuffer>(Ctor: new () => T, arr: ElemArray, shift: number, off = 0, len = arr.length): T {
  const b = new Ctor();
  b.backing = { storage: { kind: "heap", array: arr } };
  b.byteOffset = arr.byteOffset;
  b.elemShift = shift; b.little = shift > 0;
  b.cap = arr.length; b.pos = off; b.lim = off + len;
  return b;
}

/** X.allocate for a typed buffer: a heap buffer over its own element array, as AOSP's HeapXBuffer */
function allocateTyped<T extends JBuffer>(Ctor: new () => T, Arr: new (n: number) => ElemArray, cap: number, shift: number): T {
  if (cap < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "capacity < 0: (" + cap + " < 0)");
  return wrapArray(Ctor, new Arr(cap), shift);
}
/** array(): the element array behind a writable heap buffer */
function backingArray(this: JBuffer): ArrayBufferView {
  if (this.readOnly) throw rt.mkThrowable("java/nio/ReadOnlyBufferException", null);
  const array = accessibleArray(this);
  if (!array) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
  return array;
}

// typed view buffers (Float/Int/Short/Char/Long/Double) sharing the byte buffer's ArrayBuffer
class JFloatBuffer extends JBuffer {}
class JIntBuffer extends JBuffer {}
class JShortBuffer extends JBuffer {}
class JCharBuffer extends JBuffer { sequence: unknown = null; sequenceOffset = 0; }
const allocCharBuffer = (cap: number) => {
  if (cap < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative buffer capacity");
  return wrapArray(JCharBuffer, new Uint16Array(cap), 1);
};
async function wrapSequence(sequence: unknown, start = 0, end?: number): Promise<JCharBuffer> {
  if (sequence === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  const length: number = typeof sequence === "string" ? sequence.length : await vcall(sequence, "length", "()I");
  end ??= length;
  if (start < 0 || end < start || end > length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  const b = new JCharBuffer(); const array = new Uint16Array(0); b.backing = { storage: { kind: "heap", array } };
  b.sequence = sequence; b.readOnly = true; b.cap = length; b.pos = start; b.lim = end; b.elemShift = 1; return b;
}
function charAt(buffer: JCharBuffer, index: number): number | Promise<number> {
  if (index < 0 || index >= buffer.lim) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(index));
  const seq = buffer.sequence;
  return seq === null ? buffer.dv.getUint16(index << 1, buffer.little) : typeof seq === "string" ? seq.charCodeAt(buffer.sequenceOffset + index) : vcall(seq, "charAt", "(I)C", buffer.sequenceOffset + index);
}
async function charText(buffer: JCharBuffer): Promise<string> {
  if (buffer.sequence !== null) {
    const text = typeof buffer.sequence === "string" ? buffer.sequence : await (await import("../../android/text")).csText(buffer.sequence);
    return text.slice(buffer.sequenceOffset + buffer.pos, buffer.sequenceOffset + buffer.lim);
  }
  const chars = new Uint16Array(buffer.lim - buffer.pos), view = buffer.dv;
  for (let i = 0; i < chars.length; i++) chars[i] = view.getUint16((buffer.pos + i) << 1, buffer.little);
  return charsToString(chars, 0, chars.length);
}
function duplicateChars(source: JCharBuffer): JCharBuffer {
  const b = new JCharBuffer();
  b.backing = source.backing; b.byteOffset = source.byteOffset; b.elemShift = 1;
  b.sequence = source.sequence; b.sequenceOffset = source.sequenceOffset;
  b.cap = source.cap; b.lim = source.lim; b.pos = source.pos; b.mark = source.mark; b.little = source.little; b.readOnly = source.readOnly;
  return b;
}
class JLongBuffer extends JBuffer {}
class JDoubleBuffer extends JBuffer {}

function viewBuffer<T extends JBuffer>(src: JByteBuffer, Ctor: new () => T, shift: number): T {
  const b = new Ctor();
  b.backing = src.backing;
  b.readOnly = src.readOnly;
  b.byteOffset = src.byteOffset + src.pos;
  b.elemShift = shift;
  b.little = src.little;
  b.cap = b.lim = (src.lim - src.pos) >> shift;
  b.pos = 0;
  return b;
}

// FloatBuffer (typical GL usage)
rt.register({
  name: "java/nio/FloatBuffer", ctor: JFloatBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/FloatBuffer;"),
    "static allocate(I)Ljava/nio/FloatBuffer;": (cap: number) => allocateTyped(JFloatBuffer, Float32Array, cap, 2),
    "array()[F": backingArray,
    "static wrap([F)Ljava/nio/FloatBuffer;": (arr: Float32Array) => wrapArray(JFloatBuffer, arr, 2),
    "put(F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, v: number) { this.clampPut(1); this.dv.setFloat32(this.pos++ << 2, v, this.little); return this; },
    "put(IF)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, i: number, v: number) { this.clampPut(0); this.dv.setFloat32(i << 2, v, this.little); return this; },
    "put([F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array) { return putFloats(this, arr, 0, arr.length); },
    "put([FII)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array, off: number, len: number) { return putFloats(this, arr, off, len); },
    "get()F": function (this: JFloatBuffer) { this.clampGet(1); return this.dv.getFloat32(this.pos++ << 2, this.little); },
    "get(I)F": function (this: JFloatBuffer, i: number) { return this.dv.getFloat32(i << 2, this.little); },
    "get([F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array) { return getFloats(this, arr, 0, arr.length); },
    "get([FII)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array, off: number, len: number) { return getFloats(this, arr, off, len); },
  },
});
// GL sprite batches refill a nativeOrder() FloatBuffer every frame: copy through a Float32Array
// view when aligned; the per-element DataView path remains for big-endian or unaligned views.
function putFloats(b: JFloatBuffer, arr: Float32Array, off: number, len: number): JFloatBuffer {
  b.clampPut(len);
  const byteOff = b.dv.byteOffset;
  if (b.little && !(byteOff & 3)) new Float32Array(b.ab, byteOff, b.cap).set(len === arr.length ? arr : arr.subarray(off, off + len), b.pos);
  else for (let i = 0; i < len; i++) b.dv.setFloat32((b.pos + i) << 2, arr[off + i], b.little);
  b.pos += len; return b;
}
function getFloats(b: JFloatBuffer, arr: Float32Array, off: number, len: number): JFloatBuffer {
  b.clampGet(len);
  const byteOff = b.dv.byteOffset;
  if (b.little && !(byteOff & 3)) arr.set(new Float32Array(b.ab, byteOff + (b.pos << 2), len), off);
  else for (let i = 0; i < len; i++) arr[off + i] = b.dv.getFloat32((b.pos + i) << 2, b.little);
  b.pos += len; return b;
}
function putInts(buffer: JIntBuffer, values: Int32Array, offset: number, count: number): JIntBuffer {
  checkFromIndexSize(offset, count, values.length);
  buffer.clampPut(count);
  const view = buffer.dv;
  if (buffer.little && !(view.byteOffset & 3)) new Int32Array(view.buffer, view.byteOffset, buffer.cap).set(values.subarray(offset, offset + count), buffer.pos);
  else for (let i = 0; i < count; i++) view.setInt32((buffer.pos + i) << 2, values[offset + i], buffer.little);
  buffer.pos += count;
  return buffer;
}
function putShorts(buffer: JShortBuffer, values: Int16Array, offset: number, count: number): JShortBuffer {
  checkFromIndexSize(offset, count, values.length);
  buffer.clampPut(count);
  const view = buffer.dv;
  if (buffer.little && !(view.byteOffset & 1)) new Int16Array(view.buffer, view.byteOffset, buffer.cap).set(values.subarray(offset, offset + count), buffer.pos);
  else for (let i = 0; i < count; i++) view.setInt16((buffer.pos + i) << 1, values[offset + i], buffer.little);
  buffer.pos += count; return buffer;
}
function intBufferMethods(): NativeSpec["methods"] {
  return {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/IntBuffer;"),
    "static allocate(I)Ljava/nio/IntBuffer;": (cap: number) => allocateTyped(JIntBuffer, Int32Array, cap, 2),
    "array()[I": backingArray,
    "static wrap([I)Ljava/nio/IntBuffer;": (arr: Int32Array) => wrapArray(JIntBuffer, arr, 2),
    "put(I)Ljava/nio/IntBuffer;": function (this: JIntBuffer, v: number) { this.clampPut(1); this.dv.setInt32(this.pos++ << 2, v, this.little); return this; },
    "put(II)Ljava/nio/IntBuffer;": function (this: JIntBuffer, i: number, v: number) { this.clampPut(0); this.dv.setInt32(i << 2, v, this.little); return this; },
    "put([I)Ljava/nio/IntBuffer;": function (this: JIntBuffer, arr: Int32Array) { return putInts(this, arr, 0, arr.length); },
    "put([III)Ljava/nio/IntBuffer;": function (this: JIntBuffer, arr: Int32Array, off: number, len: number) { return putInts(this, arr, off, len); },
    "get()I": function (this: JIntBuffer) { this.clampGet(1); return this.dv.getInt32(this.pos++ << 2, this.little); },
    "get(I)I": function (this: JIntBuffer, i: number) { return this.dv.getInt32(i << 2, this.little); },
    "get([I)Ljava/nio/IntBuffer;": function (this: JIntBuffer, arr: Int32Array) {
      this.clampGet(arr.length);
      for (let i = 0; i < arr.length; i++) arr[i] = this.dv.getInt32((this.pos + i) << 2, this.little);
      this.pos += arr.length; return this;
    },
  };
}
rt.register({ name: "java/nio/IntBuffer", ctor: JIntBuffer, sup: "java/nio/Buffer", methods: intBufferMethods() });
rt.register({
  name: "java/nio/ShortBuffer", ctor: JShortBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/ShortBuffer;"),
    "static allocate(I)Ljava/nio/ShortBuffer;": (cap: number) => allocateTyped(JShortBuffer, Int16Array, cap, 1),
    "array()[S": backingArray,
    "static wrap([S)Ljava/nio/ShortBuffer;": (arr: Int16Array) => wrapArray(JShortBuffer, arr, 1),
    "static wrap([SII)Ljava/nio/ShortBuffer;": (arr: Int16Array, off: number, len: number) => wrapArray(JShortBuffer, arr, 1, off, len),
    "put(S)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, v: number) { this.clampPut(1); this.dv.setInt16(this.pos++ << 1, v, this.little); return this; },
    "get()S": function (this: JShortBuffer) { this.clampGet(1); return this.dv.getInt16(this.pos++ << 1, this.little); },
    "get(I)S": function (this: JShortBuffer, i: number) { return this.dv.getInt16(i << 1, this.little); },
    "put([S)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, arr: Int16Array) { return putShorts(this, arr, 0, arr.length); },
    "put([SII)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, arr: Int16Array, off: number, len: number) { return putShorts(this, arr, off, len); },
    "get([S)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, arr: Int16Array) {
      return getShorts(this, arr, 0, arr.length);
    },
    "get([SII)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, arr: Int16Array, off: number, len: number) {
      return getShorts(this, arr, off, len);
    },
  },
});
function getShorts(b: JShortBuffer, arr: Int16Array, off: number, len: number): JShortBuffer {
  checkFromIndexSize(off, len, arr.length);
  b.clampGet(len);
  const byteOff = b.dv.byteOffset;
  if (b.little && !(byteOff & 1)) arr.set(new Int16Array(b.ab, byteOff + (b.pos << 1), len), off);
  else for (let i = 0; i < len; i++) arr[off + i] = b.dv.getInt16((b.pos + i) << 1, b.little);
  b.pos += len;
  return b;
}
rt.register({
  name: "java/nio/CharBuffer", ctor: JCharBuffer, sup: "java/nio/Buffer",
  ifaces: ["java/lang/CharSequence", "java/lang/Comparable", "java/lang/Appendable"],
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/CharBuffer;"),
    "static allocate(I)Ljava/nio/CharBuffer;": allocCharBuffer,
    "static wrap(Ljava/lang/CharSequence;)Ljava/nio/CharBuffer;": wrapSequence,
    "static wrap(Ljava/lang/CharSequence;II)Ljava/nio/CharBuffer;": wrapSequence,
    "slice()Ljava/nio/CharBuffer;": function (this: JCharBuffer) {
      const b = new JCharBuffer();
      b.backing = this.backing; b.little = this.little; b.readOnly = this.readOnly; b.elemShift = 1;
      b.cap = b.lim = this.lim - this.pos;
      b.sequence = this.sequence; b.sequenceOffset = this.sequenceOffset + this.pos;
      b.byteOffset = this.sequence === null ? this.byteOffset + this.pos * 2 : 0;
      return b;
    },
    // a view of [position + start, position + end) over the same chars
    "subSequence(II)Ljava/nio/CharBuffer;": function (this: JCharBuffer, start: number, end: number) {
      if (start < 0 || end < start || end > this.lim - this.pos) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      const b = duplicateChars(this);
      b.pos = this.pos + start; b.lim = this.pos + end; b.mark = -1;
      return b;
    },
    "duplicate()Ljava/nio/CharBuffer;": function (this: JCharBuffer) { return duplicateChars(this); },
    "length()I": function (this: JCharBuffer) { return this.lim - this.pos; },
    "charAt(I)C": function (this: JCharBuffer, i: number) { if (i < 0) rt.aio(i, this.lim - this.pos); return charAt(this, this.pos + i); },
    "get(I)C": function (this: JCharBuffer, i: number) { return charAt(this, i); },
    "toString()Ljava/lang/String;": function (this: JCharBuffer) { return charText(this); },
    "static wrap([C)Ljava/nio/CharBuffer;": (arr: Uint16Array) => wrapArray(JCharBuffer, arr, 1),
    "static wrap([CII)Ljava/nio/CharBuffer;": (arr: Uint16Array, off: number, len: number) => wrapArray(JCharBuffer, arr, 1, off, len),
    "array()[C": backingArray,
    "get()C": function (this: JCharBuffer) { this.clampGet(1); return charAt(this, this.pos++); },
    "put(C)Ljava/nio/CharBuffer;": function (this: JCharBuffer, v: number) { this.clampPut(1); this.dv.setUint16(this.pos++ << 1, v, this.little); return this; },
  },
});
rt.register({
  name: "java/nio/LongBuffer", ctor: JLongBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/LongBuffer;"),
    "static allocate(I)Ljava/nio/LongBuffer;": (cap: number) => allocateTyped(JLongBuffer, BigInt64Array, cap, 3),
    "array()[J": backingArray,
    "get()J": function (this: JLongBuffer) { this.clampGet(1); return this.dv.getBigInt64(this.pos++ << 3, this.little); },
    "get(I)J": function (this: JLongBuffer, i: number) { return this.dv.getBigInt64(i << 3, this.little); },
    "put(J)Ljava/nio/LongBuffer;": function (this: JLongBuffer, v: bigint) { this.clampPut(1); this.dv.setBigInt64(this.pos++ << 3, v, this.little); return this; },
  },
});
rt.register({
  name: "java/nio/DoubleBuffer", ctor: JDoubleBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/DoubleBuffer;"),
    "static allocate(I)Ljava/nio/DoubleBuffer;": (cap: number) => allocateTyped(JDoubleBuffer, Float64Array, cap, 3),
    "array()[D": backingArray,
    "get()D": function (this: JDoubleBuffer) { this.clampGet(1); return this.dv.getFloat64(this.pos++ << 3, this.little); },
    "put(D)Ljava/nio/DoubleBuffer;": function (this: JDoubleBuffer, v: number) { this.clampPut(1); this.dv.setFloat64(this.pos++ << 3, v, this.little); return this; },
  },
});

class JByteOrder extends JObj { little = false; name = "BIG_ENDIAN"; }
const byteOrderBE = new JByteOrder();
const byteOrderLE = new JByteOrder(); byteOrderLE.little = true; byteOrderLE.name = "LITTLE_ENDIAN";
rt.register({
  name: "java/nio/ByteOrder", ctor: JByteOrder,
  statics: { BIG_ENDIAN: byteOrderBE, LITTLE_ENDIAN: byteOrderLE },
  methods: {
    "static nativeOrder()Ljava/nio/ByteOrder;": () => byteOrderLE,
    "toString()Ljava/lang/String;": function (this: JByteOrder) { return this.name; },
  },
});
for (const n of ["java/nio/BufferOverflowException", "java/nio/BufferUnderflowException", "java/nio/InvalidMarkException"]) {
  defineException(n, "java/lang/RuntimeException");
}

export function bufferView(b: JBuffer): { ab: ArrayBuffer; byteOffset: number; byteFromPos: number } {
  return { ab: b.ab, byteOffset: b.dv.byteOffset, byteFromPos: b.dv.byteOffset + (b.pos << b.elemShift) };
}

class JCodingErrorAction extends JObj { name = "REPORT"; }
rt.register({
  name: "java/nio/charset/CodingErrorAction", ctor: JCodingErrorAction,
  clinit: () => {
    const c = rt.link("java/nio/charset/CodingErrorAction").ctor;
    c.s$IGNORE = Object.assign(new JCodingErrorAction(), { name: "IGNORE" });
    c.s$REPLACE = Object.assign(new JCodingErrorAction(), { name: "REPLACE" });
    c.s$REPORT = new JCodingErrorAction();
  },
  methods: { "toString()Ljava/lang/String;": function (this: JCodingErrorAction) { return this.name; } },
});

class JCharset extends JObj { cname = "UTF-8"; }
/** no converter is ever opened, so nothing is freed */
const NO_FINALIZER = handle(() => {});
const charset = (n: string) => { const c = new JCharset(); c.cname = n; return c; };
const utf8 = charset("UTF-8");
/** Charset.lookup: the canonical name of a charset served here */
function lookupCharset(name: string | null): string {
  if (name === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Null charset name");
  if (!/^[A-Za-z0-9][A-Za-z0-9+\-.:_]*$/.test(name)) throw rt.mkThrowable("java/nio/charset/IllegalCharsetNameException", name);
  try { return charsetInfo(name).name; }
  catch (e) { if (rt.iof(e, "java/io/UnsupportedEncodingException")) throw rt.mkThrowable("java/nio/charset/UnsupportedCharsetException", name); throw e; }
}
rt.register({
  name: "java/nio/charset/Charset", ctor: JCharset,
  methods: {
    "<init>(Ljava/lang/String;[Ljava/lang/String;)V": function (this: JCharset, name: string) { this.cname = name; },
    "static forName(Ljava/lang/String;)Ljava/nio/charset/Charset;": (name: string | null) => charset(lookupCharset(name)),
    "static defaultCharset()Ljava/nio/charset/Charset;": () => utf8,
    "name()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "toString()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "displayName()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "static isSupported(Ljava/lang/String;)Z": (name: string | null) => {
      try { lookupCharset(name); return 1; }
      catch (e) { if (rt.iof(e, "java/nio/charset/UnsupportedCharsetException")) return 0; throw e; }
    },
    "canEncode()Z": () => 1,
    "equals(Ljava/lang/Object;)Z": function (this: JCharset, o: unknown) {
      return o instanceof JCharset && o.cname.toUpperCase() === this.cname.toUpperCase() ? 1 : 0;
    },
    "hashCode()I": function (this: JCharset) { return this.cname.length; },
    "newEncoder()Ljava/nio/charset/CharsetEncoder;": function (this: JCharset) { return mkCoder("CharsetEncoder", this); },
    "newDecoder()Ljava/nio/charset/CharsetDecoder;": function (this: JCharset) { return mkCoder("CharsetDecoder", this); },
    "encode(Ljava/lang/String;)Ljava/nio/ByteBuffer;": function (this: JCharset, text: string) {
      return wrapArray(JByteBuffer, encodeString(text, this), 0);
    },
    "encode(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;": function (this: JCharset, source: JCharBuffer) {
      const encoder = mkCoder("CharsetEncoder", this);
      encoder.malformed = encoder.unmappable = "REPLACE";
      return vcall(encoder, "encode", "(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;", source);
    },
    "aliases()Ljava/util/Set;": function (this: JCharset) {
      const { name, aliases } = charsetInfo(this);
      return newStringSet([name, ...aliases]);
    },
    "decode(Ljava/nio/ByteBuffer;)Ljava/nio/CharBuffer;": driven(function* (this: JCharset, b: JBuffer): Gen {
      yield resident(b);
      const text = decodeString(new Uint8Array(b.ab, b.dv.byteOffset + b.pos, b.lim - b.pos), this);
      b.pos = b.lim;
      const out = allocCharBuffer(text.length);
      for (let i = 0; i < text.length; i++) out.dv.setUint16(i << 1, text.charCodeAt(i), out.little);
      return out;
    }),
  },
});
// libcore's Charset.availableCharsets asks ICU's converter registry, which holds the charsets served here
rt.registerJnis("com/android/icu/charset/NativeConverter", {
  "getNativeFinalizer()J": () => NO_FINALIZER,
  "getAvailableCharsetNames()[Ljava/lang/String;": () => jarray(CHARSETS.map((cs) => cs.name), "Ljava/lang/String;"),
  "charsetForName(Ljava/lang/String;)Ljava/nio/charset/Charset;": (name: string) => {
    try { return charset(charsetInfo(name).name); } catch { return null; }
  },
});
rt.register({
  name: "java/nio/charset/spi/CharsetProvider", ctor: class extends JObj {},
  methods: { "<init>()V": function () {} },
});
/** the coder classes are registered after Charset, so build them through the registry */
function mkCoder(n: string, cs: JCharset) {
  const c = new (rt.link("java/nio/charset/" + n).ctor as new () => JCharsetCoder)();
  c.cs = cs;
  c.replacementBytes = Int8Array.from(charsetInfo(cs).replacement);
  return c;
}
class JCharsetCoder extends JObj {
  cs: JCharset = utf8; malformed = "REPORT"; unmappable = "REPORT"; replacementBytes = Int8Array.of(63);
  marked = false;   // a UTF-16 or UTF-32 encoder has written its byte-order mark
}
const coderChain = (ret: string): NativeSpec["methods"] => ({
  [`charset()Ljava/nio/charset/Charset;`]: function (this: JCharsetCoder) { return this.cs; },
  // implReset/implFlush: the protected hooks a coding subclass overrides
  [`reset()${ret}`]: function (this: JCharsetCoder) {
    if (this instanceof JCharsetDecoder) this.endian = null;
    this.marked = false;
    return after(vcall(this, "implReset", "()V"), () => this);
  },
  "implReset()V": () => {},
  [`implFlush(${ret === "Ljava/nio/charset/CharsetEncoder;" ? "Ljava/nio/ByteBuffer;" : "Ljava/nio/CharBuffer;"})Ljava/nio/charset/CoderResult;`]: () => CODER_UNDERFLOW,
  [`onMalformedInput(Ljava/nio/charset/CodingErrorAction;)${ret}`]: function (this: JCharsetCoder, action: JCodingErrorAction) { this.malformed = action.name; return this; },
  [`onUnmappableCharacter(Ljava/nio/charset/CodingErrorAction;)${ret}`]: function (this: JCharsetCoder, action: JCodingErrorAction) { this.unmappable = action.name; return this; },
});
const encodable = (cs: JCharset, c: number) => encodeByte(charsetInfo(cs), c) >= 0;
const maxBytesPerChar = (cs: JCharset) => charsetInfo(cs).maxBytes;
rt.register({
  name: "java/nio/charset/CharsetEncoder", ctor: JCharsetCoder,
  methods: {
    ...coderChain("Ljava/nio/charset/CharsetEncoder;"),
    "replaceWith([B)Ljava/nio/charset/CharsetEncoder;": driven(function* (this: JCharsetCoder, replacement: Int8Array | null): Gen {
      if (replacement === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Null replacement");
      if (!replacement.length || replacement.length > maxBytesPerChar(this.cs)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal replacement length");
      if (!(yield vcall(this, "isLegalReplacement", "([B)Z", replacement))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal replacement");
      this.replacementBytes = replacement.slice();
      yield vcall(this, "implReplaceWith", "([B)V", replacement);
      return this;
    }),
    "implReplaceWith([B)V": () => {},
    "replacement()[B": function (this: JCharsetCoder) { return this.replacementBytes.slice(); },
    // legal when this charset decodes it without error, as AOSP's default
    "isLegalReplacement([B)Z": function (this: JCharsetCoder, replacement: Int8Array) {
      const decoder = mkCoder("CharsetDecoder", this.cs) as JCharsetDecoder;
      return decodeBuffer(decoder, wrapArray(JByteBuffer, replacement, 0), allocCharBuffer(replacement.length * 2), 1).length ? 0 : 1;
    },
    "flush(Ljava/nio/ByteBuffer;)Ljava/nio/charset/CoderResult;": function (this: JCharsetCoder, out: JBuffer) {
      return vcall(this, "implFlush", "(Ljava/nio/ByteBuffer;)Ljava/nio/charset/CoderResult;", out);
    },
    "maxBytesPerChar()F": function (this: JCharsetCoder) { return maxBytesPerChar(this.cs); },
    "averageBytesPerChar()F": function (this: JCharsetCoder) { return charsetInfo(this.cs).averageBytes; },
    "encode(Ljava/nio/CharBuffer;)Ljava/nio/ByteBuffer;": driven(function* (this: JCharsetCoder, src: JCharBuffer): Gen {
      const text = yield charText(src); let from = 0, cleaned = "";
      for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i)!, width = cp > 0xffff ? 2 : 1;
        const malformed = cp >= 0xd800 && cp <= 0xdfff;
        if (malformed || !encodable(this.cs, cp)) {
          const action = malformed ? this.malformed : this.unmappable;
          if (action === "REPORT") { src.pos += i; throw rt.mkThrowable("java/nio/charset/" + (malformed ? "MalformedInputException" : "UnmappableCharacterException"), "Input length = " + width); }
          if (action === "IGNORE") { cleaned += text.slice(from, i); from = i + width; }
        }
        i += width;
      }
      const data = encodeString(from ? cleaned + text.slice(from) : text, this.cs);
      src.pos = src.lim; return wrapArray(JByteBuffer, data, 0);
    }),
    "canEncode(C)Z": function (this: JCharsetCoder, c: number) { return encodable(this.cs, c) ? 1 : 0; },
    "encode(Ljava/nio/CharBuffer;Ljava/nio/ByteBuffer;Z)Ljava/nio/charset/CoderResult;":
      function (this: JCharsetCoder, src: JCharBuffer, dst: JBuffer, end: number) {
        if (typeof (this as any)[ENCODE_LOOP] === "function") {
          return codeVia(this, "encodeLoop", "(Ljava/nio/CharBuffer;Ljava/nio/ByteBuffer;)Ljava/nio/charset/CoderResult;", src, dst, end, (out) => {
            if (out.lim - out.pos < this.replacementBytes.length) return false;
            for (const b of this.replacementBytes) out.dv.setInt8(out.pos++, b);
            return true;
          });
        }
        if (src.sequence === null || typeof src.sequence === "string") return encodeChars(this, src, dst, end, null);
        return charText(src).then((text) => encodeChars(this, src, dst, end, text));
      },
    "canEncode(Ljava/lang/CharSequence;)Z": driven(function* (this: JCharsetCoder, cs: unknown): Gen {
      const s = typeof cs === "string" ? cs : String(yield vcall(cs, "toString", "()Ljava/lang/String;"));
      for (let i = 0; i < s.length; i++) if (!encodable(this.cs, s.charCodeAt(i))) return 0;
      return 1;
    }),
  },
});
class JCharsetDecoder extends JCharsetCoder {
  replacement = "\ufffd";
  endian: boolean | null = null;
}
/** a heap buffer's own element array when it is an `Arr`, read without a view over its ArrayBuffer
 *  (see JBuffer.ab); the buffer's element 0 is at `offsetIn(b, array)` */
function heapArray<A extends Int8Array | Uint16Array>(b: JBuffer, Arr: new () => A): A | null {
  const s = b.backing.storage;
  return s.kind === "heap" && s.array instanceof Arr ? s.array as A : null;
}
const offsetIn = (b: JBuffer, array: ArrayBufferView) => (b.byteOffset - array.byteOffset) >> b.elemShift;
/** encode(in, out, endOfInput) for the built-in charsets: it stops before a character that does
 *  not fit, and applies the coder's error actions to what an encodeLoop would report. `text` holds
 *  the remaining characters of a buffer over an app's CharSequence. */
function encodeChars(coder: JCharsetCoder, src: JCharBuffer, dst: JBuffer, end: number, text: string | null): JCoderResult {
  if (dst.readOnly) throw rt.mkThrowable("java/nio/ReadOnlyBufferException", null);
  const cs = charsetInfo(coder.cs), { unit, little, max } = cs, wide = unit > 1, ascii = !cs.table || cs.ascii;
  const seq = src.sequence, units = seq === null ? heapArray(src, Uint16Array) : null, ubase = units ? offsetIn(src, units) : 0, order = src.little;
  const first = src.pos, offset = src.sequenceOffset;
  const at = text !== null ? (i: number) => text.charCodeAt(i - first) : typeof seq === "string" ? (i: number) => seq.charCodeAt(offset + i)
    : units ? (i: number) => units[ubase + i] : (i: number) => src.dv.getUint16(i << 1, order);
  // dp and room index `bytes`; an Int8Array store keeps a byte's low 8 bits
  const heap = heapArray(dst, Int8Array), bytes = heap ?? new Int8Array(dst.ab, dst.dv.byteOffset, dst.cap);
  const base = heap ? offsetIn(dst, heap) : 0, limit = src.lim, room = base + dst.lim;
  let sp = first, dp = base + dst.pos, result = CODER_UNDERFLOW;
  if (cs.marked && !coder.marked && sp < limit) {
    if (room - dp < unit) return CODER_OVERFLOW;
    dp = putUnit(bytes, dp, unit, 0xfeff, little); coder.marked = true;
  }
  while (sp < limit) {
    if (units && !wide && ascii) {
      let c = 0;
      while (sp < limit && dp < room && (c = units[ubase + sp]) < 0x80) { bytes[dp++] = c; sp++; }
      if (sp >= limit) break;
    }
    const c = at(sp);
    if (c < 0x80 && !wide && ascii) {
      if (dp >= room) { result = CODER_OVERFLOW; break; }
      bytes[dp++] = c; sp++; continue;
    }
    let cp = c, width = 1, error: "malformed" | "unmappable" | null = null;
    if (c >= 0xd800 && c <= 0xdbff) {
      if (sp + 1 >= limit) { if (!end) break; error = "malformed"; }
      else {
        const low = at(sp + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { cp = 0x10000 + ((c - 0xd800) << 10) + low - 0xdc00; width = 2; }
        else error = "malformed";
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) error = "malformed";
    const byte = cs.table ? encodeByte(cs, cp) : cp;
    if (!error && (cs.table ? byte < 0 : cp > max)) error = "unmappable";
    if (error) {
      const action = error === "malformed" ? coder.malformed : coder.unmappable;
      if (action === "REPORT") { result = new JCoderResult(error, width); break; }
      if (action === "REPLACE") {
        const replacement = coder.replacementBytes;
        if (room - dp < replacement.length) { result = CODER_OVERFLOW; break; }
        for (let i = 0; i < replacement.length; i++) bytes[dp++] = replacement[i];
      }
      sp += width;
      continue;
    }
    const n = unit === 4 ? 4 : wide ? width * 2 : cs.table || max <= 0xff || cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (room - dp < n) { result = CODER_OVERFLOW; break; }
    if (unit === 4) dp = putUnit(bytes, dp, 4, cp, little);
    else if (wide) for (let i = 0; i < width; i++) dp = putUnit(bytes, dp, 2, at(sp + i), little);
    else if (n === 1) bytes[dp++] = byte;
    else if (n === 2) { bytes[dp++] = 0xc0 | cp >> 6; bytes[dp++] = 0x80 | cp & 63; }
    else if (n === 3) { bytes[dp++] = 0xe0 | cp >> 12; bytes[dp++] = 0x80 | cp >> 6 & 63; bytes[dp++] = 0x80 | cp & 63; }
    else { bytes[dp++] = 0xf0 | cp >> 18; bytes[dp++] = 0x80 | cp >> 12 & 63; bytes[dp++] = 0x80 | cp >> 6 & 63; bytes[dp++] = 0x80 | cp & 63; }
    sp += width;
  }
  src.pos = sp; dst.pos = dp - base;
  return result;
}
/** a code unit of `size` bytes at `dp`, in the charset's byte order */
function putUnit(bytes: Int8Array, dp: number, size: number, value: number, little: boolean): number {
  for (let i = 0; i < size; i++) bytes[dp + (little ? i : size - 1 - i)] = value >>> 8 * i;
  return dp + size;
}
function decodeBuffer(coder: JCharsetDecoder, src: JBuffer, dst: JBuffer, end: number) {
  const cs = charsetInfo(coder.cs), { unit, name, table } = cs, wide = unit > 1, ascii = !table || cs.ascii;
  const input = src.dv, bytes = new Uint8Array(input.buffer, input.byteOffset, src.cap);
  // dp and room index `units`, or the buffer's own elements without them
  const units = heapArray(dst, Uint16Array), base = units ? offsetIn(dst, units) : 0, little = dst.little, limit = src.lim, room = base + dst.lim;
  let sp = src.pos, dp = base + dst.pos, result = CODER_UNDERFLOW;
  const put = (unit: number) => { if (units) units[dp++] = unit; else dst.dv.setUint16(dp++ << 1, unit, little); };
  while (sp < limit) {
    if (!wide && units && ascii) {
      let b = 0;
      while (sp < limit && dp < room && (b = bytes[sp]) < 0x80) { units[dp++] = b; sp++; }
      if (sp >= limit) break;
    }
    const pos = sp, remaining = limit - pos;
    let width = 1, cp = bytes[pos], malformed = 0, incomplete = false;
    if (wide) {
      if (remaining < unit) incomplete = true;
      else {
        if (coder.endian === null) {
          coder.endian = !cs.marked && cs.little;
          if (cs.marked) {
            const bom = unit === 2 ? input.getUint16(pos) : input.getUint32(pos);
            if (bom === 0xfeff || bom === (unit === 2 ? 0xfffe : 0xfffe0000)) {
              coder.endian = bom !== 0xfeff; sp += unit; continue;
            }
          }
        }
        width = unit;
        if (unit === 4) {
          cp = input.getUint32(pos, coder.endian);
          if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) malformed = 4;
        } else {
          cp = input.getUint16(pos, coder.endian);
          if (cp >= 0xd800 && cp <= 0xdbff) {
            if (remaining < 4) incomplete = true;
            else {
              const low = input.getUint16(pos + 2, coder.endian);
              if (low < 0xdc00 || low > 0xdfff) malformed = 2;
              else { cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00; width = 4; }
            }
          } else if (cp >= 0xdc00 && cp <= 0xdfff) malformed = 2;
        }
      }
    } else if (table) {
      cp = table.charCodeAt(cp);
      if (cp === 0xfffd) malformed = 1;
    } else if (name === "US-ASCII") {
      if (cp > 127) malformed = 1;
    } else if (name === "UTF-8" && cp >= 128) {
      width = cp >= 0xc2 && cp <= 0xdf ? 2 : cp >= 0xe0 && cp <= 0xef ? 3 : cp >= 0xf0 && cp <= 0xf4 ? 4 : 0;
      if (!width) malformed = 1;
      else {
        const lead = cp;
        cp &= (1 << (7 - width)) - 1;
        for (let i = 1; i < width; i++) {
          if (i >= remaining) { incomplete = true; break; }
          const byte = bytes[pos + i];
          if ((byte & 0xc0) !== 0x80 || i === 1 && (lead === 0xe0 && byte < 0xa0 || lead === 0xf0 && byte < 0x90 || lead === 0xf4 && byte > 0x8f)) {
            malformed = i; break;
          }
          cp = cp << 6 | byte & 63;
        }
        if (!malformed && !incomplete && cp >= 0xd800 && cp <= 0xdfff) malformed = width;
      }
    }
    if (incomplete) {
      if (!end) break;
      malformed = remaining;
    }
    if (malformed && coder.malformed === "REPORT") { result = new JCoderResult("malformed", malformed); break; }
    if (malformed) {
      const text = coder.malformed === "IGNORE" ? "" : coder.replacement;
      if (text.length > room - dp) { result = CODER_OVERFLOW; break; }
      for (let i = 0; i < text.length; i++) put(text.charCodeAt(i));
    } else if (cp > 0xffff) {
      if (room - dp < 2) { result = CODER_OVERFLOW; break; }
      put(0xd7c0 + (cp >> 10)); put(0xdc00 | cp & 0x3ff);
    } else {
      if (dp >= room) { result = CODER_OVERFLOW; break; }
      put(cp);
    }
    sp += malformed || width;
  }
  src.pos = sp; dst.pos = dp - base;
  return result;
}
rt.register({
  name: "java/nio/charset/CharsetDecoder", ctor: JCharsetDecoder,
  methods: {
    ...coderChain("Ljava/nio/charset/CharsetDecoder;"),
    "maxCharsPerByte()F": () => 2,
    "averageCharsPerByte()F": function (this: JCharsetDecoder) { return Math.fround(charsetInfo(this.cs).averageChars); },
    "replacement()Ljava/lang/String;": function (this: JCharsetDecoder) { return this.replacement; },
    "replaceWith(Ljava/lang/String;)Ljava/nio/charset/CharsetDecoder;": driven(function* (this: JCharsetDecoder, replacement: string | null): Gen {
      if (replacement === null || replacement.length === 0 || replacement.length > 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid replacement");
      this.replacement = replacement;
      yield vcall(this, "implReplaceWith", "(Ljava/lang/String;)V", replacement);
      return this;
    }),
    "implReplaceWith(Ljava/lang/String;)V": () => {},
    "decode(Ljava/nio/ByteBuffer;)Ljava/nio/CharBuffer;": driven(function* (this: JCharsetDecoder, src: JBuffer): Gen {
      this.endian = null;
      yield resident(src);
      const out = allocCharBuffer(src.lim - src.pos);
      const result = decodeBuffer(this, src, out, 1);
      if (result.length) yield vcall(result, "throwException", "()V");
      out.lim = out.pos; out.pos = 0;
      return out;
    }),
    "flush(Ljava/nio/CharBuffer;)Ljava/nio/charset/CoderResult;": function (this: JCharsetDecoder, out: JBuffer) {
      return vcall(this, "implFlush", "(Ljava/nio/CharBuffer;)Ljava/nio/charset/CoderResult;", out);
    },
    // a subclass's own decodeLoop does the decoding, the error actions stay here
    "decode(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;Z)Ljava/nio/charset/CoderResult;":
      function (this: JCharsetDecoder, src: JBuffer, dst: JBuffer, end: number) {
        if (typeof (this as any)[DECODE_LOOP] !== "function") return after(resident(src), () => decodeBuffer(this, src, dst, end));
        return codeVia(this, "decodeLoop", "(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;)Ljava/nio/charset/CoderResult;", src, dst, end, (out) => {
          if (out.lim - out.pos < this.replacement.length) return false;
          for (let i = 0; i < this.replacement.length; i++) out.dv.setUint16(out.pos++ << 1, this.replacement.charCodeAt(i), out.little);
          return true;
        });
      },
  },
});
const DECODE_LOOP = mangleMethod("decodeLoop", "(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;)Ljava/nio/charset/CoderResult;");
const ENCODE_LOOP = mangleMethod("encodeLoop", "(Ljava/nio/CharBuffer;Ljava/nio/ByteBuffer;)Ljava/nio/charset/CoderResult;");
/** AOSP's decode/encode(in, out, endOfInput) over a subclass's coding loop: an error result is
 *  reported, or skipped after `replace` writes the replacement, as the coder's actions say */
const codeVia = driven(function* codeVia(coder: JCharsetCoder, loop: string, desc: string, src: JBuffer, dst: JBuffer, end: number, replace: (out: JBuffer) => boolean): Gen {
  for (;;) {
    let result: JCoderResult = yield vcall(coder, loop, desc, src, dst);
    if (result.kind === "overflow") return result;
    if (result.kind === "underflow") {
      if (!end || src.pos >= src.lim) return result;
      result = new JCoderResult("malformed", src.lim - src.pos);
    }
    const action = result.kind === "malformed" ? coder.malformed : coder.unmappable;
    if (action === "REPORT") return result;
    if (action === "REPLACE" && !replace(dst)) return CODER_OVERFLOW;
    src.pos += result.length;
  }
});
class JCoderResult extends JObj {
  constructor(public kind: "underflow" | "overflow" | "malformed" | "unmappable" = "underflow", public length = 0) { super(); }
}
const CODER_UNDERFLOW = new JCoderResult();
const CODER_OVERFLOW = new JCoderResult("overflow");
function coderError(kind: "malformed" | "unmappable", length: number): JCoderResult {
  if (length <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Non-positive length");
  return new JCoderResult(kind, length);
}
rt.register({
  name: "java/nio/charset/CoderResult", ctor: JCoderResult,
  statics: { UNDERFLOW: CODER_UNDERFLOW, OVERFLOW: CODER_OVERFLOW },
  methods: {
    "static malformedForLength(I)Ljava/nio/charset/CoderResult;": (n: number) => coderError("malformed", n),
    "static unmappableForLength(I)Ljava/nio/charset/CoderResult;": (n: number) => coderError("unmappable", n),
    "isUnderflow()Z": function (this: JCoderResult) { return +(this.kind === "underflow"); },
    "isOverflow()Z": function (this: JCoderResult) { return +(this.kind === "overflow"); },
    "isError()Z": function (this: JCoderResult) { return +(this.length > 0); },
    "isMalformed()Z": function (this: JCoderResult) { return +(this.kind === "malformed"); },
    "isUnmappable()Z": function (this: JCoderResult) { return +(this.kind === "unmappable"); },
    "length()I": function (this: JCoderResult) {
      if (!this.length) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Not an error");
      return this.length;
    },
    "throwException()V": function (this: JCoderResult) {
      const name = this.kind === "underflow" ? "BufferUnderflowException" : this.kind === "overflow" ? "BufferOverflowException"
        : "charset/" + (this.kind === "malformed" ? "MalformedInputException" : "UnmappableCharacterException");
      throw rt.mkThrowable("java/nio/" + name, this.length ? "Input length = " + this.length : "");
    },
  },
});
rt.register({
  name: "java/nio/charset/StandardCharsets", ctor: class extends JObj {},
  statics: { UTF_8: utf8, ISO_8859_1: charset("ISO-8859-1"), US_ASCII: charset("US-ASCII"), UTF_16: charset("UTF-16"), UTF_16BE: charset("UTF-16BE"), UTF_16LE: charset("UTF-16LE") },
});

defineException("java/nio/charset/CharacterCodingException", "java/io/IOException");
defineException("java/nio/charset/MalformedInputException", "java/nio/charset/CharacterCodingException");
defineException("java/nio/charset/UnmappableCharacterException", "java/nio/charset/CharacterCodingException");
