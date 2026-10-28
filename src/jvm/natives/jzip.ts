// java.util.zip's natives over zlib (src/zlib.ts), as Inflater.c and Deflater.c call it: callers depend on exactly how much
// input a call consumed (okio's InflaterSource and GZIP trailers read the rest back through getRemaining). The Java classes
// above them are libcore's.
import { rt, waits, ranged, type JObj, setDeclared } from "../runtime.ts";
import { u8 } from "../abi.ts";
import { after } from "./jentry.ts";
import { ZStream, Z_OK, Z_STREAM_END, Z_NEED_DICT, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR, Z_BUF_ERROR, crc32, adler32, zError } from "../../zlib.ts";
import { handle, deref, release } from "../../android/handles.ts";
import { memoryAt, region } from "./jmemory.ts";

const Z_PARTIAL_FLUSH = 1;
const stream = (h: bigint) => deref<ZStream>(h);
const pack = (read: number, written: number, a: boolean, b: boolean) =>
  BigInt(read) | BigInt(written) << 31n | (a ? 1n << 62n : 0n) | (b ? 1n << 63n : 0n);
const open = (s: ZStream | number) => {
  if (typeof s !== "number") return handle(s);
  throw rt.mkThrowable(s === Z_MEM_ERROR ? "java/lang/OutOfMemoryError" : s === Z_STREAM_ERROR ? "java/lang/IllegalArgumentException" : "java/lang/InternalError", zError(s));
};
function end(h: bigint): void { stream(h).end(); release(h); }

// ── Inflater (Inflater.c): Z_PARTIAL_FLUSH, input and output counts packed with finished and needDict
function inflateBytes(this: JObj, h: bigint, input: Uint8Array, output: Uint8Array): bigint {
  const s = stream(h), [code, read, written] = s.run(input, output, Z_PARTIAL_FLUSH);
  switch (code) {
    case Z_STREAM_END: case Z_OK: case Z_NEED_DICT: return pack(read, written, code === Z_STREAM_END, code === Z_NEED_DICT);
    case Z_BUF_ERROR: return 0n;
    case Z_DATA_ERROR: {
      setDeclared(this, "java/util/zip/Inflater", { inputConsumed: read, outputConsumed: written });
      throw rt.mkThrowable("java/util/zip/DataFormatException", s.msg);
    }
    default: throw rt.mkThrowable("java/lang/InternalError", s.msg);
  }
}
function setDictionary(h: bigint, dictionary: Uint8Array): void {
  const s = stream(h), code = s.setDictionary(dictionary);
  if (code === Z_OK) return;
  throw rt.mkThrowable(code === Z_DATA_ERROR || code === Z_STREAM_ERROR ? "java/lang/IllegalArgumentException" : "java/lang/InternalError", s.msg);
}
const streamNatives = {
  "setDictionary(J[BII)V": ranged((h: bigint, b: Int8Array, off: number, len: number) => setDictionary(h, region(b, off, len)), [1, 2, 3]),
  "setDictionaryBuffer(JJI)V": waits((h: bigint, address: bigint, len: number) => after(memoryAt(address, len), (d) => setDictionary(h, d))),
  "getAdler(J)I": (h: bigint) => stream(h).adler,
  "reset(J)V": (h: bigint) => { stream(h).reset(); },
  "end(J)V": end,
};
rt.registerJnis("java/util/zip/Inflater", {
  "init(Z)J": (nowrap: number) => open(ZStream.inflater(nowrap ? -15 : 15)),
  "inflateBytesBytes(J[BII[BII)J": ranged(function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number) {
    return inflateBytes.call(this, h, region(i, io, il), region(o, oo, ol));
  }, [1, 2, 3], [4, 5, 6]),
  "inflateBytesBuffer(J[BIIJI)J": ranged(waits(function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number) {
    return after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, region(i, io, il), o));
  }), [1, 2, 3]),
  "inflateBufferBytes(JJI[BII)J": ranged(waits(function (this: JObj, h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number) {
    return after(memoryAt(input, il), (i) => inflateBytes.call(this, h, i, region(o, oo, ol)));
  }), [3, 4, 5]),
  "inflateBufferBuffer(JJIJI)J": waits(function (this: JObj, h: bigint, input: bigint, il: number, out: bigint, ol: number) {
    return after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, i, o)));
  }),
  ...streamNatives,
});

// ── Deflater (Deflater.c): `params` & 1 asks for deflateParams(level = params >> 3, strategy)
function deflateBytes(h: bigint, input: Uint8Array, output: Uint8Array, flush: number, params: number): bigint {
  const s = stream(h);
  if (params & 1) {
    const [code, read, written] = s.params(params >> 3, params >> 1 & 3, input, output);
    if (code === Z_OK || code === Z_BUF_ERROR) return pack(read, written, false, code !== Z_OK);
    throw rt.mkThrowable("java/lang/InternalError", "deflateParams failed");
  }
  const [code, read, written] = s.run(input, output, flush);
  if (code === Z_STREAM_END || code === Z_OK) return pack(read, written, code === Z_STREAM_END, false);
  if (code === Z_BUF_ERROR) return 0n;
  throw rt.mkThrowable("java/lang/InternalError", s.msg);
}
rt.registerJnis("java/util/zip/Deflater", {
  "init(IIZ)J": (level: number, strategy: number, nowrap: number) => open(ZStream.deflater(level, 8, nowrap ? -15 : 15, 8, strategy)),
  "deflateBytesBytes(J[BII[BIIII)J": ranged((h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    deflateBytes(h, region(i, io, il), region(o, oo, ol), flush, params), [1, 2, 3], [4, 5, 6]),
  "deflateBytesBuffer(J[BIIJIII)J": ranged(waits((h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(out, ol), (o) => deflateBytes(h, region(i, io, il), o, flush, params))), [1, 2, 3]),
  "deflateBufferBytes(JJI[BIIII)J": ranged(waits((h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => deflateBytes(h, i, region(o, oo, ol), flush, params))), [3, 4, 5]),
  "deflateBufferBuffer(JJIJIII)J": waits((h: bigint, input: bigint, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => deflateBytes(h, i, o, flush, params)))),
  ...streamNatives,
});

// ── CRC32 and Adler32
const checksum = (step: (sum: number, b: Uint8Array) => number) => ({
  "update(II)I": (sum: number, b: number) => step(sum, Uint8Array.of(b)),
  "updateBytes(I[BII)I": ranged((sum: number, b: Int8Array, off: number, len: number) => step(sum, u8(b, off, len)), [1, 2, 3]),
  "updateByteBuffer(IJII)I": waits((sum: number, address: bigint, off: number, len: number) => after(memoryAt(address + BigInt(off), len), (b) => step(sum, b))),
});
const crc = checksum(crc32);
rt.registerJnis("java/util/zip/CRC32", { "update(II)I": crc["update(II)I"], "updateBytes0(I[BII)I": crc["updateBytes(I[BII)I"], "updateByteBuffer0(IJII)I": crc["updateByteBuffer(IJII)I"] });
rt.registerJnis("java/util/zip/Adler32", checksum(adler32));
