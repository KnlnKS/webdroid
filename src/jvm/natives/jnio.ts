// java.nio.* buffers backed by a shared ArrayBuffer. position/limit/capacity semantics.

import { rt, JObj, type NativeSpec } from "../runtime";
import { defineException } from "./jlang";

export class JBuffer extends JObj {
  ab!: ArrayBuffer;
  dv!: DataView;
  pos = 0;
  lim = 0;
  cap = 0;
  mark = -1;
  little = false;         // byte order (default big-endian per Java)
  elemShift = 0;          // log2(bytes per element): byte=0, short/char=1, int/float=2, long/double=3
  clampPut(need: number) {
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
    "isDirect()Z": () => 1,
    "isReadOnly()Z": () => 0,
    "hasArray()Z": () => 0,
    "arrayOffset()I": () => 0,
  };
}

class JByteBuffer extends JBuffer {}
rt.register({
  name: "java/nio/Buffer", ctor: JBuffer,
  methods: bufferBaseMethods(),
});

// ── ByteBuffer
rt.register({
  name: "java/nio/ByteBuffer", ctor: JByteBuffer, sup: "java/nio/Buffer",
  ifaces: ["java/lang/Comparable"],
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/ByteBuffer;"),
    "static allocateDirect(I)Ljava/nio/ByteBuffer;": (cap: number) => mkByteBuffer(cap),
    "static allocate(I)Ljava/nio/ByteBuffer;": (cap: number) => mkByteBuffer(cap),
    "static wrap([B)Ljava/nio/ByteBuffer;": (arr: Int8Array) => wrapArray(JByteBuffer, arr, 0),
    "static wrap([BII)Ljava/nio/ByteBuffer;": (arr: Int8Array, off: number, len: number) => wrapArray(JByteBuffer, arr, 0, off, len),
    "order(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, o: { little: boolean }) {
      this.little = !!o?.little; return this;
    },
    "order()Ljava/nio/ByteOrder;": function (this: JByteBuffer) { return this.little ? byteOrderLE : byteOrderBE; },
    "put(B)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(1); this.dv.setInt8(this.pos++, v); return this; },
    "put(IB)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.dv.setInt8(i, v); return this; },
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
    "putShort(IS)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.dv.setInt16(i, v, this.little); return this; },
    "getShort()S": function (this: JByteBuffer) { this.clampGet(2); const v = this.dv.getInt16(this.pos, this.little); this.pos += 2; return v; },
    "getShort(I)S": function (this: JByteBuffer, i: number) { return this.dv.getInt16(i, this.little); },
    "putChar(C)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(2); this.dv.setUint16(this.pos, v, this.little); this.pos += 2; return this; },
    "getChar()C": function (this: JByteBuffer) { this.clampGet(2); const v = this.dv.getUint16(this.pos, this.little); this.pos += 2; return v; },
    "putInt(I)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setInt32(this.pos, v, this.little); this.pos += 4; return this; },
    "putInt(II)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.dv.setInt32(i, v, this.little); return this; },
    "getInt()I": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getInt32(this.pos, this.little); this.pos += 4; return v; },
    "getInt(I)I": function (this: JByteBuffer, i: number) { return this.dv.getInt32(i, this.little); },
    "putLong(J)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: bigint) { this.clampPut(8); this.dv.setBigInt64(this.pos, v, this.little); this.pos += 8; return this; },
    "getLong()J": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getBigInt64(this.pos, this.little); this.pos += 8; return v; },
    "putFloat(F)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(4); this.dv.setFloat32(this.pos, v, this.little); this.pos += 4; return this; },
    "putFloat(IF)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, i: number, v: number) { this.dv.setFloat32(i, v, this.little); return this; },
    "getFloat()F": function (this: JByteBuffer) { this.clampGet(4); const v = this.dv.getFloat32(this.pos, this.little); this.pos += 4; return v; },
    "getFloat(I)F": function (this: JByteBuffer, i: number) { return this.dv.getFloat32(i, this.little); },
    "putDouble(D)Ljava/nio/ByteBuffer;": function (this: JByteBuffer, v: number) { this.clampPut(8); this.dv.setFloat64(this.pos, v, this.little); this.pos += 8; return this; },
    "getDouble()D": function (this: JByteBuffer) { this.clampGet(8); const v = this.dv.getFloat64(this.pos, this.little); this.pos += 8; return v; },
    "asFloatBuffer()Ljava/nio/FloatBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JFloatBuffer, 2); },
    "asIntBuffer()Ljava/nio/IntBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JIntBuffer, 2); },
    "asShortBuffer()Ljava/nio/ShortBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JShortBuffer, 1); },
    "asCharBuffer()Ljava/nio/CharBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JCharBuffer, 1); },
    "asDoubleBuffer()Ljava/nio/DoubleBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JDoubleBuffer, 3); },
    "asLongBuffer()Ljava/nio/LongBuffer;": function (this: JByteBuffer) { return viewBuffer(this, JLongBuffer, 3); },
    "slice()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
      const b = new JByteBuffer();
      b.ab = this.ab; b.dv = new DataView(this.ab, this.dv.byteOffset + this.pos, this.lim - this.pos);
      b.cap = b.lim = this.lim - this.pos; b.pos = 0; b.little = this.little;
      return b;
    },
    "duplicate()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
      const b = new JByteBuffer();
      b.ab = this.ab; b.dv = this.dv; b.cap = this.cap; b.lim = this.lim; b.pos = this.pos; b.little = this.little;
      return b;
    },
    "compact()Ljava/nio/ByteBuffer;": function (this: JByteBuffer) {
      const n = this.lim - this.pos;
      bytes(this).copyWithin(0, this.pos, this.lim);
      this.pos = n; this.lim = this.cap;
      return this;
    },
    "array()[B": function (this: JByteBuffer) { return bytes(this); },
  },
});
function mkByteBuffer(cap: number): JByteBuffer {
  const b = new JByteBuffer();
  b.ab = new ArrayBuffer(Math.max(0, cap));
  b.dv = new DataView(b.ab);
  b.cap = b.lim = cap;
  b.pos = 0;
  return b;
}
// A wrapped or sliced buffer does not start at byte 0 of its ArrayBuffer.
function bytes(b: JByteBuffer): Int8Array {
  return new Int8Array(b.ab, b.dv.byteOffset, b.cap);
}
// Java's wrap shares the array: writes through either side show on the other. A typed array is
// laid out in native order, so a wrapped typed buffer reads little-endian (Java's order() for it
// too); ByteBuffer.wrap keeps Java's big-endian default.
function wrapArray<T extends JBuffer>(Ctor: new () => T, arr: Int8Array | Int16Array | Int32Array | Float32Array, shift: number, off = 0, len = arr.length): T {
  const b = new Ctor();
  b.ab = arr.buffer as ArrayBuffer;
  b.dv = new DataView(b.ab, arr.byteOffset, arr.byteLength);
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
  const byteOff = src.dv.byteOffset + src.pos;
  b.ab = src.ab;
  b.dv = new DataView(src.ab, byteOff);
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
    "static allocate(I)Ljava/nio/FloatBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 4), JFloatBuffer, 2),
    "static wrap([F)Ljava/nio/FloatBuffer;": (arr: Float32Array) => wrapArray(JFloatBuffer, arr, 2),
    "put(F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, v: number) { this.clampPut(1); this.dv.setFloat32(this.pos++ << 2, v, this.little); return this; },
    "put(IF)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, i: number, v: number) { this.dv.setFloat32(i << 2, v, this.little); return this; },
    "put([F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array) { return putFloats(this, arr, 0, arr.length); },
    "put([FII)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array, off: number, len: number) { return putFloats(this, arr, off, len); },
    "get()F": function (this: JFloatBuffer) { this.clampGet(1); return this.dv.getFloat32(this.pos++ << 2, this.little); },
    "get(I)F": function (this: JFloatBuffer, i: number) { return this.dv.getFloat32(i << 2, this.little); },
    "get([F)Ljava/nio/FloatBuffer;": function (this: JFloatBuffer, arr: Float32Array) {
      this.clampGet(arr.length);
      for (let i = 0; i < arr.length; i++) arr[i] = this.dv.getFloat32((this.pos + i) << 2, this.little);
      this.pos += arr.length; return this;
    },
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
function intBufferMethods(): NativeSpec["methods"] {
  return {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/IntBuffer;"),
    "static allocate(I)Ljava/nio/IntBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 4), JIntBuffer, 2),
    "static wrap([I)Ljava/nio/IntBuffer;": (arr: Int32Array) => wrapArray(JIntBuffer, arr, 2),
    "put(I)Ljava/nio/IntBuffer;": function (this: JIntBuffer, v: number) { this.clampPut(1); this.dv.setInt32(this.pos++ << 2, v, this.little); return this; },
    "put(II)Ljava/nio/IntBuffer;": function (this: JIntBuffer, i: number, v: number) { this.dv.setInt32(i << 2, v, this.little); return this; },
    "put([I)Ljava/nio/IntBuffer;": function (this: JIntBuffer, arr: Int32Array) {
      this.clampPut(arr.length);
      for (let i = 0; i < arr.length; i++) this.dv.setInt32((this.pos + i) << 2, arr[i], this.little);
      this.pos += arr.length; return this;
    },
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
    "static allocate(I)Ljava/nio/ShortBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 2), JShortBuffer, 1),
    "static wrap([S)Ljava/nio/ShortBuffer;": (arr: Int16Array) => wrapArray(JShortBuffer, arr, 1),
    "static wrap([SII)Ljava/nio/ShortBuffer;": (arr: Int16Array, off: number, len: number) => wrapArray(JShortBuffer, arr, 1, off, len),
    "put(S)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, v: number) { this.clampPut(1); this.dv.setInt16(this.pos++ << 1, v, this.little); return this; },
    "get()S": function (this: JShortBuffer) { this.clampGet(1); return this.dv.getInt16(this.pos++ << 1, this.little); },
    "get(I)S": function (this: JShortBuffer, i: number) { return this.dv.getInt16(i << 1, this.little); },
    "put([S)Ljava/nio/ShortBuffer;": function (this: JShortBuffer, arr: Int16Array) {
      this.clampPut(arr.length);
      for (let i = 0; i < arr.length; i++) this.dv.setInt16((this.pos + i) << 1, arr[i], this.little);
      this.pos += arr.length; return this;
    },
  },
});
rt.register({
  name: "java/nio/CharBuffer", ctor: JCharBuffer, sup: "java/nio/Buffer",
  ifaces: ["java/lang/CharSequence", "java/lang/Comparable", "java/lang/Appendable"],
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/CharBuffer;"),
    "static allocate(I)Ljava/nio/CharBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 2), JCharBuffer, 1),
    "get()C": function (this: JCharBuffer) { this.clampGet(1); return this.dv.getUint16(this.pos++ << 1, this.little); },
    "put(C)Ljava/nio/CharBuffer;": function (this: JCharBuffer, v: number) { this.clampPut(1); this.dv.setUint16(this.pos++ << 1, v, this.little); return this; },
  },
});
rt.register({
  name: "java/nio/LongBuffer", ctor: JLongBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/LongBuffer;"),
    "static allocate(I)Ljava/nio/LongBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 8), JLongBuffer, 3),
    "get()J": function (this: JLongBuffer) { this.clampGet(1); return this.dv.getBigInt64(this.pos++ << 3, this.little); },
    "put(J)Ljava/nio/LongBuffer;": function (this: JLongBuffer, v: bigint) { this.clampPut(1); this.dv.setBigInt64(this.pos++ << 3, v, this.little); return this; },
  },
});
rt.register({
  name: "java/nio/DoubleBuffer", ctor: JDoubleBuffer, sup: "java/nio/Buffer",
  methods: {
    ...bufferBaseMethods(),
    ...chaining("Ljava/nio/DoubleBuffer;"),
    "static allocate(I)Ljava/nio/DoubleBuffer;": (cap: number) => viewBuffer(mkByteBuffer(cap * 8), JDoubleBuffer, 3),
    "get()D": function (this: JDoubleBuffer) { this.clampGet(1); return this.dv.getFloat64(this.pos++ << 3, this.little); },
    "put(D)Ljava/nio/DoubleBuffer;": function (this: JDoubleBuffer, v: number) { this.clampPut(1); this.dv.setFloat64(this.pos++ << 3, v, this.little); return this; },
  },
});

// ByteOrder
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

// ── charset coding-error policy (Mihon/OkHttp touch these; behavior is moot —
// our encode/decode always replaces)
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

// ── Charset / StandardCharsets
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
  },
});
rt.register({
  name: "java/nio/charset/StandardCharsets", ctor: class extends JObj {},
  statics: { UTF_8: utf8, ISO_8859_1: charset("ISO-8859-1"), US_ASCII: charset("US-ASCII"), UTF_16: charset("UTF-16") },
});
