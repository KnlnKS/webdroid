// java.util.zip's natives.
// Inflater and Deflater run zlib itself (pako is a line-for-line port), since callers depend on
// exactly how much input a call consumed: okio's InflaterSource and GZIP trailers read the rest
// back through getRemaining. The Java classes above them are libcore's.
import * as zInflate from "pako/lib/zlib/inflate.js";
import * as zDeflate from "pako/lib/zlib/deflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import { rt, waits, type JObj, setDeclared } from "../runtime.ts";
import { u8 } from "../abi.ts";
import { after } from "./jentry.ts";
import { crc32, adler32 } from "../../zip.ts";
import { handle, deref, release } from "../../android/handles.ts";
import { memoryAt, region } from "./jmemory.ts";

const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5, Z_PARTIAL_FLUSH = 1, Z_BLOCK = 5;
type Stream = InstanceType<typeof ZStream> & { state: any; msg: string; adler: number };
const EMPTY = new Uint8Array(0);
const stream = (h: bigint) => deref<Stream>(h);
/** one zlib call over [input, output): the counts it consumed and produced */
function run(s: Stream, input: Uint8Array, output: Uint8Array, call: (s: Stream) => number): [number, number, number] {
  s.input = input; s.next_in = 0; s.avail_in = input.length;
  s.output = output; s.next_out = 0; s.avail_out = output.length;
  const code = call(s);
  s.input = EMPTY; s.output = EMPTY;
  return [code, input.length - s.avail_in, output.length - s.avail_out];
}
const pack = (read: number, written: number, a: boolean, b: boolean) =>
  BigInt(read) | BigInt(written) << 31n | (a ? 1n << 62n : 0n) | (b ? 1n << 63n : 0n);

// ── Inflater (Inflater.c): Z_PARTIAL_FLUSH, input and output counts packed with finished and needDict
function inflateBytes(this: JObj, h: bigint, input: Uint8Array, output: Uint8Array): bigint {
  const [code, read, written] = run(stream(h), input, output, (s) => zInflate.inflate(s, Z_PARTIAL_FLUSH));
  switch (code) {
    case Z_STREAM_END: case Z_OK: case Z_NEED_DICT: return pack(read, written, code === Z_STREAM_END, code === Z_NEED_DICT);
    case Z_BUF_ERROR: return 0n;
    case Z_DATA_ERROR: {
      setDeclared(this, "java/util/zip/Inflater", { inputConsumed: read, outputConsumed: written });
      throw rt.mkThrowable("java/util/zip/DataFormatException", stream(h).msg || null);
    }
    default: throw rt.mkThrowable("java/lang/InternalError", stream(h).msg || null);
  }
}
function setDictionary(h: bigint, dictionary: Uint8Array, set: (s: Stream, d: Uint8Array) => number): void {
  const s = stream(h), code = set(s, dictionary);
  if (code === Z_OK) return;
  throw rt.mkThrowable(code === Z_DATA_ERROR || code === -2 ? "java/lang/IllegalArgumentException" : "java/lang/InternalError", s.msg || null);
}
rt.registerJnis("java/util/zip/Inflater", {
  "init(Z)J": (nowrap: number) => {
    const s = new ZStream() as Stream;
    if (zInflate.inflateInit2(s, nowrap ? -15 : 15) !== Z_OK) throw rt.mkThrowable("java/lang/InternalError", s.msg || null);
    return handle(s);
  },
  "setDictionary(J[BII)V": (h: bigint, b: Int8Array, off: number, len: number) => setDictionary(h, region(b, off, len), zInflate.inflateSetDictionary),
  "setDictionaryBuffer(JJI)V": waits((h: bigint, address: bigint, len: number) => after(memoryAt(address, len), (d) => setDictionary(h, d, zInflate.inflateSetDictionary))),
  "inflateBytesBytes(J[BII[BII)J": function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number) {
    return inflateBytes.call(this, h, region(i, io, il), region(o, oo, ol));
  },
  "inflateBytesBuffer(J[BIIJI)J": waits(function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number) {
    return after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, region(i, io, il), o));
  }),
  "inflateBufferBytes(JJI[BII)J": waits(function (this: JObj, h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number) {
    return after(memoryAt(input, il), (i) => inflateBytes.call(this, h, i, region(o, oo, ol)));
  }),
  "inflateBufferBuffer(JJIJI)J": waits(function (this: JObj, h: bigint, input: bigint, il: number, out: bigint, ol: number) {
    return after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, i, o)));
  }),
  "getAdler(J)I": (h: bigint) => stream(h).adler | 0,
  // pako's updatewindow, unlike zlib's, does not size a kept window again after a reset zeroed
  // wsize, so the next stream would lose every back-reference: size it here
  "reset(J)V": (h: bigint) => {
    const s = stream(h);
    zInflate.inflateReset(s);
    if (s.state.window) s.state.wsize = 1 << s.state.wbits;
  },
  "end(J)V": (h: bigint) => { zInflate.inflateEnd(stream(h)); release(h); },
});

// ── Deflater (Deflater.c): `params` & 1 asks for deflateParams(level = params >> 3, strategy)
const CONFIG = [[0, 0, 0, 0], [4, 4, 8, 4], [4, 5, 16, 8], [4, 6, 32, 32], [4, 4, 16, 16], [8, 16, 32, 32],
  [8, 16, 128, 128], [8, 32, 128, 256], [32, 128, 258, 1024], [32, 258, 258, 4096]]; // good, lazy, nice, chain
const group = (level: number) => level === 0 ? 0 : level <= 3 ? 1 : 2;
/** zlib 1.2.12's deflateParams, which pako does not port, over pako's deflate state */
function deflateParams(strm: Stream, level: number, strategy: number): number {
  const s = strm.state;
  if (level === -1) level = 6;
  if (level < 0 || level > 9 || strategy < 0 || strategy > 4) return -2;
  if ((strategy !== s.strategy || group(s.level) !== group(level)) && s.last_flush !== -2) {
    const code = zDeflate.deflate(strm, Z_BLOCK);
    if (code === -2) return code;
    if (strm.avail_in || s.strstart - s.block_start + s.lookahead) return Z_BUF_ERROR;
  }
  if (s.level !== level) {
    if (s.level === 0 && s.matches !== 0) {
      if (s.matches === 1) slideHash(s); else s.head.fill(0);
      s.matches = 0;
    }
    s.level = level;
    [s.good_match, s.max_lazy_match, s.nice_match, s.max_chain_length] = CONFIG[level];
  }
  s.strategy = strategy;
  return Z_OK;
}
function slideHash(s: { w_size: number; head: Uint16Array; prev: Uint16Array }): void {
  for (const table of [s.head, s.prev]) for (let i = 0; i < table.length; i++) table[i] = table[i] >= s.w_size ? table[i] - s.w_size : 0;
}
function deflateBytes(h: bigint, input: Uint8Array, output: Uint8Array, flush: number, params: number): bigint {
  const setParams = params & 1;
  const [code, read, written] = run(stream(h), input, output, setParams ? (s) => deflateParams(s, params >> 3, params >> 1 & 3) : (s) => zDeflate.deflate(s, flush));
  if (setParams) {
    if (code === Z_OK || code === Z_BUF_ERROR) return pack(read, written, false, code !== Z_OK);
    throw rt.mkThrowable("java/lang/InternalError", "deflateParams failed");
  }
  if (code === Z_STREAM_END || code === Z_OK) return pack(read, written, code === Z_STREAM_END, false);
  if (code === Z_BUF_ERROR) return 0n;
  throw rt.mkThrowable("java/lang/InternalError", stream(h).msg || null);
}
rt.registerJnis("java/util/zip/Deflater", {
  "init(IIZ)J": (level: number, strategy: number, nowrap: number) => {
    const s = new ZStream() as Stream;
    const code = zDeflate.deflateInit2(s, level, 8, nowrap ? -15 : 15, 8, strategy);
    if (code !== Z_OK) throw rt.mkThrowable(code === -2 ? "java/lang/IllegalArgumentException" : "java/lang/InternalError", s.msg || null);
    return handle(s);
  },
  "setDictionary(J[BII)V": (h: bigint, b: Int8Array, off: number, len: number) => setDictionary(h, region(b, off, len), zDeflate.deflateSetDictionary),
  "setDictionaryBuffer(JJI)V": waits((h: bigint, address: bigint, len: number) => after(memoryAt(address, len), (d) => setDictionary(h, d, zDeflate.deflateSetDictionary))),
  "deflateBytesBytes(J[BII[BIIII)J": (h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    deflateBytes(h, region(i, io, il), region(o, oo, ol), flush, params),
  "deflateBytesBuffer(J[BIIJIII)J": waits((h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(out, ol), (o) => deflateBytes(h, region(i, io, il), o, flush, params))),
  "deflateBufferBytes(JJI[BIIII)J": waits((h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => deflateBytes(h, i, region(o, oo, ol), flush, params))),
  "deflateBufferBuffer(JJIJIII)J": waits((h: bigint, input: bigint, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => deflateBytes(h, i, o, flush, params)))),
  "getAdler(J)I": (h: bigint) => stream(h).adler | 0,
  "reset(J)V": (h: bigint) => { zDeflate.deflateReset(stream(h)); },
  "end(J)V": (h: bigint) => { zDeflate.deflateEnd(stream(h)); release(h); },
});

// ── CRC32 and Adler32
const checksum = (step: (sum: number, b: Uint8Array) => number) => ({
  "update(II)I": (sum: number, b: number) => step(sum, Uint8Array.of(b)),
  "updateBytes(I[BII)I": (sum: number, b: Int8Array, off: number, len: number) => step(sum, u8(b, off, len)),
  "updateByteBuffer(IJII)I": waits((sum: number, address: bigint, off: number, len: number) => after(memoryAt(address + BigInt(off), len), (b) => step(sum, b))),
});
const crc = checksum(crc32);
rt.registerJnis("java/util/zip/CRC32", { "update(II)I": crc["update(II)I"], "updateBytes0(I[BII)I": crc["updateBytes(I[BII)I"], "updateByteBuffer0(IJII)I": crc["updateByteBuffer(IJII)I"] });
rt.registerJnis("java/util/zip/Adler32", checksum(adler32));
