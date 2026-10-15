// java.util.zip's natives, and the zip reader the shell loads apks and resources with.
// Inflater and Deflater run zlib itself (pako is a line-for-line port), since callers depend on
// exactly how much input a call consumed: okio's InflaterSource and GZIP trailers read the rest
// back through getRemaining. The Java classes above them are libcore's.
import { inflateSync } from "fflate";
import * as zInflate from "pako/lib/zlib/inflate.js";
import * as zDeflate from "pako/lib/zlib/deflate.js";
import ZStream from "pako/lib/zlib/zstream.js";
import { rt, JObj, declaredField } from "../runtime";
import { utf8, u8 } from "../abi";
import { after } from "./jentry";
import { checkFromIndexSize } from "./jlang";
import { readFully, type FileSource } from "../../shell/lazyfile";
import { handle, deref, release } from "../../android/handles";
import { memoryAt } from "./jmemory";

const Z_OK = 0, Z_STREAM_END = 1, Z_NEED_DICT = 2, Z_DATA_ERROR = -3, Z_BUF_ERROR = -5, Z_PARTIAL_FLUSH = 1, Z_BLOCK = 5;
type Stream = InstanceType<typeof ZStream> & { state: any; msg: string; adler: number };
const EMPTY = new Uint8Array(0);
const stream = (h: bigint) => deref<Stream>(h);
const view = (a: Int8Array, off: number, len: number) => { checkFromIndexSize(off, len, a.length, "java/lang/ArrayIndexOutOfBoundsException"); return u8(a, off, len); };
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
let consumedFields: [string, string] | undefined;
function inflateBytes(this: JObj, h: bigint, input: Uint8Array, output: Uint8Array): bigint {
  const [code, read, written] = run(stream(h), input, output, (s) => zInflate.inflate(s, Z_PARTIAL_FLUSH));
  switch (code) {
    case Z_STREAM_END: case Z_OK: case Z_NEED_DICT: return pack(read, written, code === Z_STREAM_END, code === Z_NEED_DICT);
    case Z_BUF_ERROR: return 0n;
    case Z_DATA_ERROR: {
      const [inField, outField] = consumedFields ??= [declaredField("java/util/zip/Inflater", "inputConsumed"), declaredField("java/util/zip/Inflater", "outputConsumed")];
      (this as unknown as Record<string, number>)[inField] = read; (this as unknown as Record<string, number>)[outField] = written;
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
  "setDictionary(J[BII)V": (h: bigint, b: Int8Array, off: number, len: number) => setDictionary(h, view(b, off, len), zInflate.inflateSetDictionary),
  "setDictionaryBuffer(JJI)V": (h: bigint, address: bigint, len: number) => after(memoryAt(address, len), (d) => setDictionary(h, d, zInflate.inflateSetDictionary)),
  "inflateBytesBytes(J[BII[BII)J": function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number) {
    return inflateBytes.call(this, h, view(i, io, il), view(o, oo, ol));
  },
  "inflateBytesBuffer(J[BIIJI)J": function (this: JObj, h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number) {
    return after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, view(i, io, il), o));
  },
  "inflateBufferBytes(JJI[BII)J": function (this: JObj, h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number) {
    return after(memoryAt(input, il), (i) => inflateBytes.call(this, h, i, view(o, oo, ol)));
  },
  "inflateBufferBuffer(JJIJI)J": function (this: JObj, h: bigint, input: bigint, il: number, out: bigint, ol: number) {
    return after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => inflateBytes.call(this, h, i, o)));
  },
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
  "setDictionary(J[BII)V": (h: bigint, b: Int8Array, off: number, len: number) => setDictionary(h, view(b, off, len), zDeflate.deflateSetDictionary),
  "setDictionaryBuffer(JJI)V": (h: bigint, address: bigint, len: number) => after(memoryAt(address, len), (d) => setDictionary(h, d, zDeflate.deflateSetDictionary)),
  "deflateBytesBytes(J[BII[BIIII)J": (h: bigint, i: Int8Array, io: number, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    deflateBytes(h, view(i, io, il), view(o, oo, ol), flush, params),
  "deflateBytesBuffer(J[BIIJIII)J": (h: bigint, i: Int8Array, io: number, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(out, ol), (o) => deflateBytes(h, view(i, io, il), o, flush, params)),
  "deflateBufferBytes(JJI[BIIII)J": (h: bigint, input: bigint, il: number, o: Int8Array, oo: number, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => deflateBytes(h, i, view(o, oo, ol), flush, params)),
  "deflateBufferBuffer(JJIJIII)J": (h: bigint, input: bigint, il: number, out: bigint, ol: number, flush: number, params: number) =>
    after(memoryAt(input, il), (i) => after(memoryAt(out, ol), (o) => deflateBytes(h, i, o, flush, params))),
  "getAdler(J)I": (h: bigint) => stream(h).adler | 0,
  "reset(J)V": (h: bigint) => { zDeflate.deflateReset(stream(h)); },
  "end(J)V": (h: bigint) => { zDeflate.deflateEnd(stream(h)); release(h); },
});

// ── CRC32 (zlib's, slicing by 8) and Adler32
const CRC = Array.from({ length: 8 }, () => new Int32Array(256));
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; CRC[0][n] = c; }
for (let n = 0; n < 256; n++) for (let t = 1; t < 8; t++) CRC[t][n] = CRC[t - 1][n] >>> 8 ^ CRC[0][CRC[t - 1][n] & 255];
export function crc32(crc: number, b: Uint8Array): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC;
  let c = ~crc, i = 0;
  for (const end = b.length & ~7; i < end; i += 8) {
    const lo = c ^ (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24);
    c = t7[lo & 255] ^ t6[lo >>> 8 & 255] ^ t5[lo >>> 16 & 255] ^ t4[lo >>> 24] ^ t3[b[i + 4]] ^ t2[b[i + 5]] ^ t1[b[i + 6]] ^ t0[b[i + 7]];
  }
  for (; i < b.length; i++) c = t0[(c ^ b[i]) & 255] ^ c >>> 8;
  return ~c;
}
export function adler32(adler: number, b: Uint8Array): number {
  let a = adler & 0xffff, s = adler >>> 16;
  for (let i = 0; i < b.length;) {
    // 5552 bytes keep the sums below 2^32 between reductions, as zlib's NMAX
    for (const end = Math.min(b.length, i + 5552); i < end; i++) { a += b[i]; s += a; }
    a %= 65521; s %= 65521;
  }
  return (s << 16 | a) | 0;
}
const checksum = (step: (sum: number, b: Uint8Array) => number) => ({
  "update(II)I": (sum: number, b: number) => step(sum, Uint8Array.of(b)),
  "updateBytes(I[BII)I": (sum: number, b: Int8Array, off: number, len: number) => step(sum, u8(b, off, len)),
  "updateByteBuffer(IJII)I": (sum: number, address: bigint, off: number, len: number) => after(memoryAt(address + BigInt(off), len), (b) => step(sum, b)),
});
const crc = checksum(crc32);
rt.registerJnis("java/util/zip/CRC32", { "update(II)I": crc["update(II)I"], "updateBytes0(I[BII)I": crc["updateBytes(I[BII)I"], "updateByteBuffer0(IJII)I": crc["updateByteBuffer(IJII)I"] });
rt.registerJnis("java/util/zip/Adler32", checksum(adler32));
// ── the shell's zip reader: index the central directory, inflate an entry only when it is read
export interface ZEntry { name: string; method: number; csize: number; size: number; time: number; off: number; }
function dosTime(date: number, time: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}
interface ZipDirectory { offset: number; size: number; entries: number }
function directoryFromTail(z: Uint8Array, fileSize: number): ZipDirectory {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22; // end-of-central-directory record, scanning back over any archive comment
  while (e >= 0 && (v.getUint32(e, true) !== 0x06054b50 || e + 22 + v.getUint16(e + 20, true) !== z.length)) e--;
  if (e < 0) throw rt.mkThrowable("java/util/zip/ZipException", "End Of Central Directory signature not found");
  const entries = v.getUint16(e + 10, true);
  const size = v.getUint32(e + 12, true);
  const offset = v.getUint32(e + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw rt.mkThrowable("java/util/zip/ZipException", "ZIP64 is not supported");
  }
  if (offset + size > fileSize) throw rt.mkThrowable("java/util/zip/ZipException", "Central Directory is outside the archive");
  return { offset, size, entries };
}
function centralDirRecords(z: Uint8Array, entries: number): Map<string, ZEntry> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const out = new Map<string, ZEntry>();
  let p = 0;
  for (let n = entries; n > 0; n--) {
    if (p + 46 > z.length || v.getUint32(p, true) !== 0x02014b50) {
      throw rt.mkThrowable("java/util/zip/ZipException", "Invalid Central Directory entry");
    }
    const nl = v.getUint16(p + 28, true);
    const name = utf8.dec.decode(z.subarray(p + 46, p + 46 + nl));
    out.set(name, {
      name, method: v.getUint16(p + 10, true), time: dosTime(v.getUint16(p + 14, true), v.getUint16(p + 12, true)),
      csize: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), off: v.getUint32(p + 42, true),
    });
    p += 46 + nl + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}
function centralDirFromTail(z: Uint8Array, fileSize: number): Map<string, ZEntry> {
  const d = directoryFromTail(z, fileSize);
  const start = d.offset - (fileSize - z.length);
  if (start < 0 || start + d.size > z.length) {
    throw rt.mkThrowable("java/util/zip/ZipException", `Central Directory needs range ${d.offset}-${d.offset + d.size - 1}`);
  }
  return centralDirRecords(z.subarray(start, start + d.size), d.entries);
}
export function centralDir(z: Uint8Array): Map<string, ZEntry> {
  const d = directoryFromTail(z, z.length);
  return centralDirRecords(z.subarray(d.offset, d.offset + d.size), d.entries);
}
/** where an entry's data begins: the local header carries its own name/extra lengths, which
 *  may differ from the central ones */
function localStart(z: Uint8Array, e: ZEntry): number {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  return e.off + 30 + v.getUint16(e.off + 26, true) + v.getUint16(e.off + 28, true);
}
export function entryBytes(z: Uint8Array, e: ZEntry): Uint8Array {
  const start = localStart(z, e);
  return inflateEntry(z.subarray(start, start + e.csize), e);
}
export function inflateEntry(raw: Uint8Array, e: ZEntry): Uint8Array {
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateSync(raw);
  throw rt.mkThrowable("java/util/zip/ZipException", "Invalid compression method " + e.method + ": " + e.name);
}
export async function centralDirOfSource(source: FileSource): Promise<Map<string, ZEntry>> {
  const tailSize = Math.min(22 + 0xffff, source.size);
  const tail = await readFully(source, source.size - tailSize, tailSize);
  const info = directoryFromTail(tail, source.size);
  if (info.offset >= source.size - tail.length) return centralDirFromTail(tail, source.size);
  return centralDirRecords(await readFully(source, info.offset, info.size), info.entries);
}
export async function localDataOffset(source: FileSource, e: ZEntry): Promise<number> {
  const header = await readFully(source, e.off, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length !== 30 || view.getUint32(0, true) !== 0x04034b50) {
    throw rt.mkThrowable("java/util/zip/ZipException", "Invalid local header: " + e.name);
  }
  return e.off + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}
/** A zip as the file tree the rest of the boot reads, materialised one entry at a time: a
 *  stored entry is a view into bytes we already hold and costs nothing, a deflated one is
 *  inflated on first read and then replaces its own accessor, so a second read is a plain
 *  property. `Object.keys` stays free; `Object.entries` inflates the whole tree, which is why
 *  nothing on the boot path uses it. `rename` returns null to drop an entry. */
export function zipTree(z: Uint8Array, into: Record<string, Uint8Array> = {}, rename?: (n: string) => string | null): Record<string, Uint8Array> {
  let pending = lazyEntries.get(into);
  if (!pending) lazyEntries.set(into, pending = new Map());
  for (const e of centralDir(z).values()) {
    if (e.name.endsWith("/")) continue;
    const name = rename ? rename(e.name) : e.name;
    if (name === null || Object.prototype.hasOwnProperty.call(into, name)) continue;
    const pin = (value: Uint8Array) => {
      pending.delete(name);
      Object.defineProperty(into, name, { value, writable: true, enumerable: true, configurable: true });
      return value;
    };
    if (e.method === 8) pending.set(name, [z, e]);
    Object.defineProperty(into, name, {
      enumerable: true, configurable: true,
      get: () => pin(entryBytes(z, e)),
      set: pin,
    });
  }
  return into;
}
const lazyEntries = new WeakMap<Record<string, Uint8Array>, Map<string, [Uint8Array, ZEntry]>>();
/** Inflate a tree's still-compressed entries that `wanted` names with the platform's native
 *  inflater, concurrently, ahead of the synchronous reads that would otherwise inflate in JS. */
export async function inflateTree(tree: Record<string, Uint8Array>, wanted: (name: string) => boolean): Promise<void> {
  const pending = lazyEntries.get(tree);
  if (!pending || typeof DecompressionStream === "undefined") return;
  await Promise.all([...pending].filter(([name]) => wanted(name)).map(async ([name, [z, e]]) => {
    const start = localStart(z, e);
    const stream = new Blob([z.subarray(start, start + e.csize) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (pending.has(name)) tree[name] = bytes;
  }));
}
/** a class path entry as a file, sized without inflating or fetching it; reading it inflates natively */
export function classpathFile(name: string): FileSource {
  const resident = Object.hasOwn(rt.classpath, name);
  return {
    size: resident ? lazyEntries.get(rt.classpath)?.get(name)?.[1].size ?? rt.classpath[name].length : rt.classpathSource!.entrySize(name),
    read: async (offset, length) => {
      if (resident) await inflateTree(rt.classpath, (entry) => entry === name);
      return (await rt.readClasspath(name))!.subarray(offset, offset + length);
    },
  };
}

