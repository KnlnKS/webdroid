// java.nio.* buffers backed by a shared ArrayBuffer. position/limit/capacity semantics.

import { rt, JObj, type NativeSpec } from "../runtime";
import { defineException, vcall } from "./jlang";
import { mem } from "../../native/mem";
import { decodeString } from "../charset";

type BufferStorage = { kind: "heap"; ab: ArrayBuffer } | { kind: "direct"; ab: ArrayBuffer } | { kind: "native"; address: number | bigint };
const directBuffers = new FinalizationRegistry<number>((address) => mem.free(address));

export class JBuffer extends JObj {
  backing!: { storage: BufferStorage };
  byteOffset = 0;
  private view: DataView | null = null;
  get ab(): ArrayBuffer { const s = this.backing.storage; return s.kind === "native" ? mem.buf : s.ab; }
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
    "hasArray()Z": () => 0,
    "arrayOffset()I": () => 0,
  };
}

class JByteBuffer extends JBuffer {}
rt.register({
  name: "java/nio/Buffer", ctor: JBuffer,
  methods: bufferBaseMethods(),
});

rt.register({
  name: "java/nio/ByteBuffer", ctor: JByteBuffer, sup: "java/nio/Buffer",
  ifaces: ["java/lang/Comparable"],
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/ByteBuffer;"),
    "static allocateDirect(I)Ljava/nio/ByteBuffer;": (cap: number) => mkByteBuffer(cap, true),
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
      bytes(this).set(bytes(src).subarray(src.pos, src.lim), this.pos);
      this.pos += n; src.pos += n; return this;
    },
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
    "putInt(I)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setInt32(this.pos, v, this.little); this.pos += 4; return this; },
    "putInt(II)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setInt32(i, v, this.little); return this; },
    "getInt()I": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getInt32(this.pos, this.little); this.pos += 4; return v; },
    "getInt(I)I": function (this: JByteBuffer, i: number) { return this.dv.getInt32(i, this.little); },
    "putLong(J)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: bigint) { this.clampPut(8); this.dv.setBigInt64(this.pos, v, this.little); this.pos += 8; return this; },
    "getLong()J": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getBigInt64(this.pos, this.little); this.pos += 8; return v; },
    "putFloat(F)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setFloat32(this.pos, v, this.little); this.pos += 4; return this; },
    "putFloat(IF)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.clampPut(0); this.dv.setFloat32(i, v, this.little); return this; },
    "getFloat()F": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getFloat32(this.pos, this.little); this.pos += 4; return v; },
    "getFloat(I)F": function (this: JByteBuffer, i: number) { return this.dv.getFloat32(i, this.little); },
    "putDouble(D)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(8); this.dv.setFloat64(this.pos, v, this.little); this.pos += 8; return this; },
    "getDouble()D": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getFloat64(this.pos, this.little); this.pos += 8; return v; },
    "asFloatBuffer()Ljava/nio/FloatBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/FloatBuffer").ctor, 2); },
    "asIntBuffer()Ljava/nio/IntBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/IntBuffer").ctor, 2); },
    "asShortBuffer()Ljava/nio/ShortBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/ShortBuffer").ctor, 1); },
    "asCharBuffer()Ljava/nio/CharBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/CharBuffer").ctor, 1); },
    "asDoubleBuffer()Ljava/nio/DoubleBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/DoubleBuffer").ctor, 3); },
    "asLongBuffer()Ljava/nio/LongBuffer;": function (this: JByteBuffer) { return viewBuffer(this, rt.link("java/nio/LongBuffer").ctor, 3); },
    "slice()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
      const b = new JByteBuffer();
      b.backing = this.backing; b.byteOffset = this.byteOffset + this.pos;
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
    "array()[B": function (this: JByteBuffer) { if (this.readOnly) throw rt.mkThrowable("java/nio/ReadOnlyBufferException", null); return bytes(this); },
  },
});
function duplicateBuffer(source: JByteBuffer): JByteBuffer {
  const b = new JByteBuffer();
  b.backing = source.backing; b.byteOffset = source.byteOffset;
  b.cap = source.cap; b.lim = source.lim; b.pos = source.pos; b.mark = source.mark; b.little = source.little; b.readOnly = source.readOnly;
  return b;
}
defineException("java/nio/ReadOnlyBufferException", "java/lang/UnsupportedOperationException");
class JMappedByteBuffer extends JByteBuffer {}
rt.register({
  name: "java/nio/MappedByteBuffer", ctor: JMappedByteBuffer, sup: "java/nio/ByteBuffer",
  methods: {
    ...chaining("Ljava/nio/MappedByteBuffer;"),
    "isLoaded()Z": () => 1,
    "load()Ljava/nio/MappedByteBuffer;": function (this: JMappedByteBuffer) { return this; },
    "force()Ljava/nio/MappedByteBuffer;": function (this: JMappedByteBuffer) { return this; },
  },
});
export function mappedReadOnlyBuffer(data: Uint8Array): JBuffer {
  rt.link("java/nio/MappedByteBuffer");
  const buffer = new JMappedByteBuffer();
  buffer.backing = { storage: { kind: "direct", ab: data.buffer as ArrayBuffer } };
  buffer.byteOffset = data.byteOffset; buffer.cap = buffer.lim = data.length; buffer.readOnly = true;
  return buffer;
}
export function mkByteBuffer(cap: number, direct = false): JByteBuffer {
  if (cap < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "negative buffer capacity");
  const b = new JByteBuffer();
  b.backing = { storage: { kind: direct ? "direct" : "heap", ab: new ArrayBuffer(cap) } };
  b.cap = b.lim = cap;
  b.pos = 0;
  return b;
}

export function nativeByteBuffer(address: number, cap: number): JBuffer {
  rt.link("java/nio/ByteBuffer");
  const b = new JByteBuffer();
  b.backing = { storage: { kind: "native", address: mem.va(address) } };
  b.cap = b.lim = cap;
  return b;
}

export function directBufferAddress(b: JBuffer): number | bigint {
  let s = b.backing.storage;
  if (s.kind === "heap") return 0;
  if (s.kind === "direct") {
    // Promotion waits for native ABI selection and updates every existing slice/view together.
    const address = mem.malloc(s.ab.byteLength);
    if (!address) throw rt.mkThrowable("java/lang/OutOfMemoryError", "direct buffer");
    mem.u8.set(new Uint8Array(s.ab), address);
    s = b.backing.storage = { kind: "native", address };
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
function wrapArray<T extends JBuffer>(Ctor: new () => T, arr: { buffer: ArrayBufferLike; byteOffset: number; length: number }, shift: number, off = 0, len = arr.length): T {
  const b = new Ctor();
  b.backing = { storage: { kind: "heap", ab: arr.buffer as ArrayBuffer } };
  b.byteOffset = arr.byteOffset;
  b.elemShift = shift; b.little = shift > 0;
  b.cap = arr.length; b.pos = off; b.lim = off + len;
  return b;
}

// typed view buffers (Float/Int/Short/Char/Long/Double) sharing the byte buffer's ArrayBuffer
class JFloatBuffer extends JBuffer {}
class JIntBuffer extends JBuffer {}
class JShortBuffer extends JBuffer {}
class JCharBuffer extends JBuffer {}
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

type Elems = { buffer: ArrayBufferLike; byteOffset: number; length: number; [i: number]: number | bigint; subarray(s: number, e: number): Elems; set(a: any, off?: number): void };
type ElemArray = { new (...a: any[]): Elems; BYTES_PER_ELEMENT: number };
// GL batches refill nativeOrder() buffers every frame: copy through a typed-array view when aligned;
// the per-element DataView path remains for big-endian or unaligned views.
function typedBuffer(name: string, d: string, Ctor: new () => JBuffer, Arr: ElemArray, get: (dv: DataView, o: number, le: boolean) => number | bigint,
  set: (dv: DataView, o: number, v: any, le: boolean) => void, ifaces?: string[]) {
  const size = Arr.BYTES_PER_ELEMENT, shift = Math.log2(size), T = `Ljava/nio/${name};`;
  const fast = (b: JBuffer) => b.little && !(b.dv.byteOffset & (size - 1));
  const put = (b: JBuffer, arr: Elems, off: number, len: number) => {
    b.clampPut(len);
    if (fast(b)) new Arr(b.ab, b.dv.byteOffset, b.cap).set(arr.subarray(off, off + len), b.pos);
    else for (let i = 0, dv = b.dv; i < len; i++) set(dv, (b.pos + i) << shift, arr[off + i], b.little);
    b.pos += len; return b;
  };
  const take = (b: JBuffer, arr: Elems, off: number, len: number) => {
    b.clampGet(len);
    if (fast(b)) arr.set(new Arr(b.ab, b.dv.byteOffset + (b.pos << shift), len), off);
    else for (let i = 0, dv = b.dv; i < len; i++) arr[off + i] = get(dv, (b.pos + i) << shift, b.little);
    b.pos += len; return b;
  };
  rt.register({
    name: `java/nio/${name}`, ctor: Ctor, sup: "java/nio/Buffer", ifaces,
    methods: {
      ...bufferBaseMethods(),
      ...chaining(T),
      [`static allocate(I)${T}`]: (cap: number) => viewBuffer(mkByteBuffer(cap << shift), Ctor, shift),
      [`static wrap([${d})${T}`]: (arr: Elems) => wrapArray(Ctor, arr, shift),
      [`static wrap([${d}II)${T}`]: (arr: Elems, off: number, len: number) => wrapArray(Ctor, arr, shift, off, len),
      [`put(${d})${T}`]: function (this: JBuffer, v: unknown) { this.clampPut(1); set(this.dv, this.pos++ << shift, v, this.little); return this; },
      [`put(I${d})${T}`]: function (this: JBuffer, i: number, v: unknown) { this.clampPut(0); set(this.dv, i << shift, v, this.little); return this; },
      [`put([${d})${T}`]: function (this: JBuffer, arr: Elems) { return put(this, arr, 0, arr.length); },
      [`put([${d}II)${T}`]: function (this: JBuffer, arr: Elems, off: number, len: number) { return put(this, arr, off, len); },
      [`get()${d}`]: function (this: JBuffer) { this.clampGet(1); return get(this.dv, this.pos++ << shift, this.little); },
      [`get(I)${d}`]: function (this: JBuffer, i: number) { return get(this.dv, i << shift, this.little); },
      [`get([${d})${T}`]: function (this: JBuffer, arr: Elems) { return take(this, arr, 0, arr.length); },
      [`get([${d}II)${T}`]: function (this: JBuffer, arr: Elems, off: number, len: number) { return take(this, arr, off, len); },
    },
  });
}
typedBuffer("FloatBuffer", "F", JFloatBuffer, Float32Array, (dv, o, le) => dv.getFloat32(o, le), (dv, o, v, le) => dv.setFloat32(o, v, le));
typedBuffer("IntBuffer", "I", JIntBuffer, Int32Array, (dv, o, le) => dv.getInt32(o, le), (dv, o, v, le) => dv.setInt32(o, v, le));
typedBuffer("ShortBuffer", "S", JShortBuffer, Int16Array, (dv, o, le) => dv.getInt16(o, le), (dv, o, v, le) => dv.setInt16(o, v, le));
typedBuffer("CharBuffer", "C", JCharBuffer, Uint16Array, (dv, o, le) => dv.getUint16(o, le), (dv, o, v, le) => dv.setUint16(o, v, le),
  ["java/lang/CharSequence", "java/lang/Comparable", "java/lang/Appendable"]);
typedBuffer("LongBuffer", "J", JLongBuffer, BigInt64Array, (dv, o, le) => dv.getBigInt64(o, le), (dv, o, v, le) => dv.setBigInt64(o, v, le));
typedBuffer("DoubleBuffer", "D", JDoubleBuffer, Float64Array, (dv, o, le) => dv.getFloat64(o, le), (dv, o, v, le) => dv.setFloat64(o, v, le));

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

// ── charset coding-error policy: our encode/decode always replaces
class JCodingErrorAction extends JObj {}
rt.register({
  name: "java/nio/charset/CodingErrorAction", ctor: JCodingErrorAction,
  clinit: () => {
    const c = rt.link("java/nio/charset/CodingErrorAction").ctor;
    c.s$IGNORE = new JCodingErrorAction();
    c.s$REPLACE = new JCodingErrorAction();
    c.s$REPORT = new JCodingErrorAction();
  },
  methods: { "toString()Ljava/lang/String;": () => "REPLACE" },
});

class JCharset extends JObj { cname = "UTF-8"; }
const charset = (n: string) => { const c = new JCharset(); c.cname = n; return c; };
const utf8 = charset("UTF-8");
rt.register({
  name: "java/nio/charset/Charset", ctor: JCharset,
  methods: {
    "static forName(Ljava/lang/String;)Ljava/nio/charset/Charset;": charset,
    "static defaultCharset()Ljava/nio/charset/Charset;": () => utf8,
    "name()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "toString()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "displayName()Ljava/lang/String;": function (this: JCharset) { return this.cname; },
    "static isSupported(Ljava/lang/String;)Z": () => 1,
    "canEncode()Z": () => 1,
    "equals(Ljava/lang/Object;)Z": function (this: JCharset, o: unknown) {
      return o instanceof JCharset && o.cname.toUpperCase() === this.cname.toUpperCase() ? 1 : 0;
    },
    "hashCode()I": function (this: JCharset) { return this.cname.length; },
    "newEncoder()Ljava/nio/charset/CharsetEncoder;": function (this: JCharset) { return mkCoder("CharsetEncoder", this); },
    "newDecoder()Ljava/nio/charset/CharsetDecoder;": function (this: JCharset) { return mkCoder("CharsetDecoder", this); },
    "decode(Ljava/nio/ByteBuffer;)Ljava/nio/CharBuffer;": function (this: JCharset, b: JBuffer) {
      const text = decodeString(new Uint8Array(b.ab, b.dv.byteOffset + b.pos, b.lim - b.pos), this);
      b.pos = b.lim;
      const out = viewBuffer(mkByteBuffer(text.length * 2), JCharBuffer, 1);
      for (let i = 0; i < text.length; i++) out.dv.setUint16(i << 1, text.charCodeAt(i), out.little);
      return out;
    },
  },
});
/** the coder classes are registered after Charset, so build them through the registry */
function mkCoder(n: string, cs: JCharset) {
  const c = new (rt.link("java/nio/charset/" + n).ctor as new () => JCharsetCoder)();
  c.cs = cs;
  return c;
}
// ── coders. Only UTF-8/UTF-16/Latin-1 style charsets ever reach here, and the coding-error
// policy is fixed at REPLACE, so an encoder is its charset plus the one question anyone asks it:
// can this character be represented?
class JCharsetCoder extends JObj { cs: JCharset = utf8; }
const coderChain = (ret: string): NativeSpec["methods"] => ({
  [`charset()Ljava/nio/charset/Charset;`]: function (this: JCharsetCoder) { return this.cs; },
  [`reset()${ret}`]: function (this: JCharsetCoder) { return this; },
  [`onMalformedInput(Ljava/nio/charset/CodingErrorAction;)${ret}`]: function (this: JCharsetCoder) { return this; },
  [`onUnmappableCharacter(Ljava/nio/charset/CodingErrorAction;)${ret}`]: function (this: JCharsetCoder) { return this; },
  [`replaceWith([B)${ret}`]: function (this: JCharsetCoder) { return this; },
});
/** ASCII and Latin-1 have holes; every Unicode transformation format encodes everything */
const encodable = (cs: JCharset, c: number) =>
  /^(US-ASCII|ASCII)$/i.test(cs.cname) ? c < 0x80 : /8859-1|latin/i.test(cs.cname) ? c < 0x100 : true;
rt.register({
  name: "java/nio/charset/CharsetEncoder", ctor: JCharsetCoder,
  methods: {
    ...coderChain("Ljava/nio/charset/CharsetEncoder;"),
    "canEncode(C)Z": function (this: JCharsetCoder, c: number) { return encodable(this.cs, c) ? 1 : 0; },
    "canEncode(Ljava/lang/CharSequence;)Z": async function (this: JCharsetCoder, cs: unknown) {
      const s = typeof cs === "string" ? cs : String(await vcall(cs, "toString", "()Ljava/lang/String;"));
      for (let i = 0; i < s.length; i++) if (!encodable(this.cs, s.charCodeAt(i))) return 0;
      return 1;
    },
  },
});
rt.register({
  name: "java/nio/charset/CharsetDecoder", ctor: class extends JCharsetCoder {},
  methods: {
    ...coderChain("Ljava/nio/charset/CharsetDecoder;"),
    "decode(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;Z)Ljava/nio/charset/CoderResult;":
      function (this: JCharsetCoder, src: JBuffer, dst: JBuffer) {
        const bytes = new Uint8Array(src.ab, src.dv.byteOffset + src.pos, src.lim - src.pos);
        const text = decodeString(bytes, this.cs);
        const n = Math.min(text.length, dst.lim - dst.pos);
        for (let i = 0; i < n; i++) dst.dv.setUint16((dst.pos + i) << 1, text.charCodeAt(i), dst.little);
        dst.pos += n;
        src.pos = src.lim;
        return n < text.length ? CODER_OVERFLOW : CODER_UNDERFLOW;
      },
  },
});
class JCoderResult extends JObj { over = false; }
const CODER_UNDERFLOW = new JCoderResult();
const CODER_OVERFLOW = new JCoderResult();
CODER_OVERFLOW.over = true;
rt.register({
  name: "java/nio/charset/CoderResult", ctor: JCoderResult,
  statics: { UNDERFLOW: CODER_UNDERFLOW, OVERFLOW: CODER_OVERFLOW },
  methods: {
    "isUnderflow()Z": function (this: JCoderResult) { return this.over ? 0 : 1; },
    "isOverflow()Z": function (this: JCoderResult) { return this.over ? 1 : 0; },
    "isError()Z": () => 0,
    "throwException()V": () => {},
  },
});
rt.register({
  name: "java/nio/charset/StandardCharsets", ctor: class extends JObj {},
  statics: { UTF_8: utf8, ISO_8859_1: charset("ISO-8859-1"), US_ASCII: charset("US-ASCII"), UTF_16: charset("UTF-16"), UTF_16BE: charset("UTF-16BE"), UTF_16LE: charset("UTF-16LE") },
});
