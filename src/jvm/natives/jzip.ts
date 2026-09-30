// java.util.zip on fflate: streaming codecs (Inflater/Deflater raw+zlib, CRC32), ZipFile over a
// central-directory index, GZIPInputStream over a drained source.
import { Inflate, Unzlib, Deflate, Zlib, Gzip, Zip, ZipDeflate, ZipPassThrough, inflateSync, gunzipSync, type DeflateOptions } from "fflate";
import { rt, JObj, driven, type Gen } from "../runtime";
import { utf8, i8, u8 } from "../abi";
import { vcall, newObj, after, defineException, checkFromIndexSize } from "./jlang";
import { pathOf, readStreamFully, heldByteReads, filterOut, setFilterOut } from "./jio";
import { vfs } from "../../shell/vfs";
import { JBuffer, resident } from "./jnio";
import { mkEnumeration, newArrayList } from "./jcoll";
import { readFully, type FileSource } from "../../shell/lazyfile";

type Codec = Inflate | Unzlib | Deflate | Zlib | Gzip;
const collect = (z: { out: Uint8Array[]; done: boolean }) => (d: Uint8Array, final: boolean) => { if (d.length) z.out.push(d); if (final) z.done = true; };
class JInflater extends JObj {
  raw = false;
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  fed = 0;
  written = 0;
  /** input bytes not consumed: what sits past the final block (a gzip trailer) */
  rem = 0;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Inflate() : new Unzlib();
      this.st.ondata = collect(this);
    }
    return this.st;
  }
  // Java keeps input handed over after the end of stream (okio reads the trailer back through
  // getRemaining); fflate would throw on it. It parks the unconsumed tail in `p` and only ever
  // tests "last block decoded" as `s.f && !s.l` internally, so that test is repeated here.
  //
  // getRemaining() must only ever count bytes past the END of the deflate stream. Mid-stream
  // fflate also parks a partial tail in `p` — but it keeps those bytes and decodes them once
  // more input arrives, so reporting them as unconsumed makes a caller that computes
  // "consumed = given - getRemaining()" (okio's InflaterSource.releaseBytesAfterInflate) hand
  // the very same bytes back on the next refill. That both wedges the reader into a one-byte-
  // per-refill loop and feeds the codec duplicate input, which surfaces far away as
  // "invalid distance" / "invalid block type" out of a gzipped HTTP response.
  feed(b: Uint8Array) {
    if (this.done) { this.rem = b.length; return; }
    const st = this.ensure() as any;
    st.push(b);
    if (st.s.f && !st.s.l) this.done = true;
    // fflate trims `p` to the byte the bit cursor sits in and keeps the leftover bit offset in
    // `s.p`. A stream that ended mid-byte has therefore consumed p[0] as far as the container
    // is concerned, and counting it as remaining puts the caller one byte early into the gzip
    // trailer — which reads as a CRC that is the real one shifted left by eight bits.
    this.rem = this.done ? Math.max(0, (st.p?.length ?? 0) - ((st.s.p & 7) ? 1 : 0)) : 0;
    this.fed += b.length - this.rem;
  }
  inflate(b: Int8Array, off: number, len: number) {
    const n = drain(this, b, off, len);
    this.written += n;
    return n;
  }
}
function drain(z: { out: Uint8Array[] }, b: Int8Array, off: number, len: number): number {
  let n = 0;
  while (n < len && z.out.length) {
    const c = z.out[0];
    const take = Math.min(len - n, c.length);
    u8(b, off + n, take).set(c.subarray(0, take));
    n += take;
    if (take === c.length) z.out.shift(); else z.out[0] = c.subarray(take);
  }
  return n;
}
rt.register({
  name: "java/util/zip/Inflater", ctor: JInflater,
  methods: {
    "<init>()V": function (this: JInflater) { this.raw = false; },
    "<init>(Z)V": function (this: JInflater, nowrap: number) { this.raw = !!nowrap; },
    "setInput([BII)V": function (this: JInflater, b: Int8Array, off: number, len: number) {
      this.feed(u8(b, off, len).slice());
    },
    "setInput([B)V": function (this: JInflater, b: Int8Array) {
      this.feed(u8(b).slice());
    },
    "inflate([BII)I": function (this: JInflater, b: Int8Array, off: number, len: number) { return this.inflate(b, off, len); },
    "inflate([B)I": function (this: JInflater, b: Int8Array) { return this.inflate(b, 0, b.length); },
    // The input is consumed eagerly, so "the input buffer is empty" is only true once the
    // output it produced has been drained too. Unconsumed input past the stream (a gzip
    // trailer) also counts: okio's refill treats needsInput as a promise that getRemaining is 0.
    "needsInput()Z": function (this: JInflater) { return this.out.length || this.rem ? 0 : 1; },
    "needsDictionary()Z": () => 0,
    // end of stream = the BFINAL block has been fully decoded (fflate only flags `final` when
    // the caller says so, which a chunked Java feeder never does) — Inflater.finished() is what
    // streaming readers loop on
    "finished()Z": function (this: JInflater) {
      const s = (this.st as unknown as { s?: { f?: number; l?: unknown } } | null)?.s;
      return (this.done || (s?.f && !s.l)) && !this.out.length ? 1 : 0;
    },
    "getRemaining()I": function (this: JInflater) { return this.rem; },
    "getBytesRead()J": function (this: JInflater) { return BigInt(this.fed); },
    "getBytesWritten()J": function (this: JInflater) { return BigInt(this.written); },
    "reset()V": function (this: JInflater) { this.st = null; this.out = []; this.done = false; this.fed = 0; this.written = 0; this.rem = 0; },
    "end()V": function (this: JInflater) { this.st = null; this.out = []; },
  },
});

class JDeflater extends JObj {
  raw = false;
  options: DeflateOptions = {};
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  fed = 0;
  pending: Uint8Array | null = null;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Deflate(this.options) : new Zlib(this.options);
      this.st.ondata = collect(this);
    }
    return this.st;
  }
  feed(bytes: Uint8Array, final = false) {
    this.ensure().push(bytes, final); this.fed += bytes.length;
  }
  level(value: number): void {
    if (value !== -1 && (value < 0 || value > 9 || !Number.isInteger(value))) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid compression level");
    this.options.level = value === -1 ? undefined : value as DeflateOptions["level"];
  }
}
rt.register({
  name: "java/util/zip/Deflater", ctor: JDeflater,
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JDeflater, level: number) { this.level(level); },
    "<init>(IZ)V": function (this: JDeflater, level: number, nowrap: number) { this.level(level); this.raw = !!nowrap; },
    "setLevel(I)V": function (this: JDeflater, level: number) { this.level(level); },
    "setInput([BII)V": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      this.pending = u8(b, off, len).slice();
    },
    "finish()V": function (this: JDeflater) {
      this.feed(this.pending ?? new Uint8Array(0), true);
      this.pending = null;
    },
    "deflate([BII)I": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      if (this.pending) { this.feed(this.pending); this.pending = null; }
      return drain(this, b, off, len);
    },
    "finished()Z": function (this: JDeflater) { return this.done && !this.out.length ? 1 : 0; },
    "needsInput()Z": function (this: JDeflater) { return this.pending ? 0 : 1; },
    "getBytesRead()J": function (this: JDeflater) { return BigInt(this.fed); },
    "end()V": function (this: JDeflater) { this.st = null; this.out = []; },
    "reset()V": function (this: JDeflater) { this.st = null; this.out = []; this.done = false; this.pending = null; this.fed = 0; },
  },
});

// DeflaterOutputStream: feeds its Deflater and forwards whatever it produces to the wrapped
// stream; close() finishes the deflate stream first (the zlib trailer), as the JDK does.
class JDeflaterOut extends JObj { def = new JDeflater(); closed = false; }
async function pump(s: JDeflaterOut) {
  for (const c of s.def.out) await vcall(filterOut(s), "write", "([BII)V", i8(c), 0, c.length);
  s.def.out = [];
}
function dosInit(this: JDeflaterOut, o: unknown, def?: JDeflater | null) { setFilterOut(this, o); if (def) this.def = def; }
rt.register({
  name: "java/util/zip/DeflaterOutputStream", ctor: JDeflaterOut, sup: "java/io/FilterOutputStream",
  fields: { def: "def" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": dosInit,
    "<init>(Ljava/io/OutputStream;Z)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;I)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;Z)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;IZ)V": dosInit,
    "write(I)V": function (this: JDeflaterOut, b: number) { return vcall(this, "write", "([BII)V", Int8Array.of(b), 0, 1); },
    "write([BII)V": driven(function* (this: JDeflaterOut, b: Int8Array, off: number, len: number): Gen {
      if (this.def.done) throw rt.mkThrowable("java/io/IOException", "write beyond end of stream");
      if (len > 0) { this.def.feed(u8(b, off, len).slice()); yield pump(this); }
    }),
    "finish()V": driven(function* (this: JDeflaterOut): Gen {
      if (!this.def.done) { this.def.feed(new Uint8Array(0), true); yield pump(this); }
    }),
    "flush()V": function (this: JDeflaterOut) { return vcall(filterOut(this), "flush", "()V"); },
    "close()V": driven(function* (this: JDeflaterOut): Gen {
      if (this.closed) return;
      this.closed = true;
      yield vcall(this, "finish", "()V");
      yield vcall(filterOut(this), "close", "()V");
    }),
  },
});
class JGzipDeflater extends JDeflater { ensure() { return this.st ??= Object.assign(new Gzip(), { ondata: collect(this) }); } }
rt.register({
  name: "java/util/zip/GZIPOutputStream", ctor: class extends JDeflaterOut { def = new JGzipDeflater(); }, sup: "java/util/zip/DeflaterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": dosInit, "<init>(Ljava/io/OutputStream;I)V": dosInit,
    "<init>(Ljava/io/OutputStream;Z)V": dosInit, "<init>(Ljava/io/OutputStream;IZ)V": dosInit,
  },
});

// ── Checksum: CRC32, CRC32C and Adler32 share every update overload
const crcTable = (poly: number) => Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? poly ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
interface ChecksumAlgo { init: number; step(state: number, b: Uint8Array, off: number, len: number): number; value(state: number): number }
const crc = (table: Uint32Array): ChecksumAlgo => ({
  init: 0xffffffff,
  step(c, b, off, len) { for (let i = off; i < off + len; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c >>> 0; },
  value: (c) => (c ^ 0xffffffff) >>> 0,
});
const adler32: ChecksumAlgo = {
  init: 1,
  step(state, buf, off, len) {
    let a = state & 0xffff, b = state >>> 16;
    for (let i = off; i < off + len; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  },
  value: (state) => state,
};
class JChecksum extends JObj { state = 0; declare algo: ChecksumAlgo; }
const CHECKSUMS: [string, ChecksumAlgo][] = [["CRC32", crc(crcTable(0xedb88320))], ["CRC32C", crc(crcTable(0x82f63b78))], ["Adler32", adler32]];
const updateBytes = function (this: JChecksum, b: Int8Array, off: number, len: number) {
  if (!b) rt.npe();
  checkFromIndexSize(off, len, b.length, "java/lang/ArrayIndexOutOfBoundsException");
  this.state = this.algo.step(this.state, u8(b), off, len);
};
/** update a Checksum, ours directly and an app's own through its update([BII)V */
const feed = (c: unknown, b: Int8Array, off: number, len: number) =>
  c instanceof JChecksum ? updateBytes.call(c, b, off, len) : vcall(c, "update", "([BII)V", b, off, len);
// Checksum's defaults, which an app's own implementation inherits too
const checksumMethods = {
  "update([B)V": function (this: unknown, b: Int8Array) { if (!b) rt.npe(); return feed(this, b, 0, b.length); },
  "update([BII)V": updateBytes,
  "update(Ljava/nio/ByteBuffer;)V": function (this: unknown, bb: JBuffer) {
    return after(resident(bb), () => {
      const n = bb.lim - bb.pos, bytes = new Uint8Array(bb.ab, bb.dv.byteOffset + bb.pos, n);
      bb.pos = bb.lim;
      if (this instanceof JChecksum) this.state = this.algo.step(this.state, bytes, 0, n);
      else return vcall(this, "update", "([BII)V", new Int8Array(bytes), 0, n);
    });
  },
};
rt.register({ name: "java/util/zip/Checksum", ctor: class extends JObj {}, methods: checksumMethods });
for (const [name, algo] of CHECKSUMS) {
  rt.register({
    name: "java/util/zip/" + name, ctor: class extends JChecksum { algo = algo; state = algo.init; }, ifaces: ["java/util/zip/Checksum"],
    methods: {
      ...checksumMethods,
      "<init>()V": function () {},
      "update(I)V": function (this: JChecksum, v: number) { this.state = this.algo.step(this.state, Uint8Array.of(v), 0, 1); },
      "getValue()J": function (this: JChecksum) { return BigInt(this.algo.value(this.state)); },
      "reset()V": function (this: JChecksum) { this.state = this.algo.init; },
    },
  });
}
defineException("java/util/zip/ZipException", "java/io/IOException");

// ── ZipFile / ZipEntry: index the central directory, inflate an entry only when it is read
export interface ZEntry { name: string; method: number; csize: number; size: number; time: number; off: number; }
const UNKNOWN: ZEntry = { name: "", method: -1, csize: -1, size: -1, time: -1, off: -1 };
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
async function entryBytesOfSource(source: FileSource, e: ZEntry): Promise<Uint8Array> {
  return inflateEntry(await readFully(source, await localDataOffset(source, e), e.csize), e);
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

class JZipEntry extends JObj { e: ZEntry = UNKNOWN; }
function mkZipEntry(e: ZEntry): JZipEntry {
  const z = rt.make("java/util/zip/ZipEntry") as JZipEntry;
  z.e = e;
  return z;
}
rt.register({
  name: "java/util/zip/ZipEntry", ctor: JZipEntry, ifaces: ["java/lang/Cloneable"],
  statics: { STORED: 0, DEFLATED: 8 },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JZipEntry, name: string) { this.e = { ...UNKNOWN, name }; },
    "<init>(Ljava/util/zip/ZipEntry;)V": function (this: JZipEntry, entry: JZipEntry | null) {
      if (!entry) throw rt.mkThrowable("java/lang/NullPointerException", "entry");
      this.e = { ...entry.e };
    },
    "getName()Ljava/lang/String;": function (this: JZipEntry) { return this.e.name; },
    "getSize()J": function (this: JZipEntry) { return BigInt(this.e.size); },
    "getCompressedSize()J": function (this: JZipEntry) { return BigInt(this.e.csize); },
    "getTime()J": function (this: JZipEntry) { return BigInt(this.e.time); },
    "getMethod()I": function (this: JZipEntry) { return this.e.method; },
    "setMethod(I)V": function (this: JZipEntry, method: number) {
      if (method !== 0 && method !== 8) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid compression method");
      this.e.method = method;
    },
    "isDirectory()Z": function (this: JZipEntry) { return this.e.name.endsWith("/") ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JZipEntry) { return this.e.name; },
  },
});
class JZipOutputStream extends JDeflaterOut {
  archive: Zip | null = null;
  entry: ZipDeflate | ZipPassThrough | null = null;
  pendingChunks: Uint8Array[] = [];
  error: Error | null = null;
  finished = false;
  names = new Set<string>();
  level = 6;
  async flushChunks() {
    if (this.error) throw rt.mkThrowable("java/util/zip/ZipException", this.error.message);
    for (const chunk of this.pendingChunks.splice(0)) await vcall(filterOut(this), "write", "([BII)V", i8(chunk), 0, chunk.length);
  }
  async closeEntry() {
    if (!this.entry) return;
    this.entry.push(new Uint8Array(0), true);
    this.entry = null;
    await this.flushChunks();
  }
}
function zipOutInit(this: JZipOutputStream, out: unknown) {
  if (!out) throw rt.mkThrowable("java/lang/NullPointerException", "out");
  setFilterOut(this, out);
  this.archive = new Zip((error, chunk) => {
    if (error) this.error = error;
    else if (chunk?.length) this.pendingChunks.push(chunk);
  });
}
rt.register({
  name: "java/util/zip/ZipOutputStream", ctor: JZipOutputStream, sup: "java/util/zip/DeflaterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": zipOutInit,
    "<init>(Ljava/io/OutputStream;Ljava/nio/charset/Charset;)V": zipOutInit,
    "putNextEntry(Ljava/util/zip/ZipEntry;)V": driven(function* (this: JZipOutputStream, entry: JZipEntry | null): Gen {
      if (!entry) throw rt.mkThrowable("java/lang/NullPointerException", "entry");
      if (!this.archive || this.finished) throw rt.mkThrowable("java/io/IOException", "Stream closed");
      yield this.closeEntry();
      if (this.names.has(entry.e.name)) throw rt.mkThrowable("java/util/zip/ZipException", "duplicate entry: " + entry.e.name);
      this.names.add(entry.e.name);
      const file = entry.e.method === 0 ? new ZipPassThrough(entry.e.name) : new ZipDeflate(entry.e.name, { level: this.level as DeflateOptions["level"] });
      if (entry.e.time >= 0) file.mtime = new Date(entry.e.time);
      this.archive.add(file);
      this.entry = file;
      yield this.flushChunks();
    }),
    "write(I)V": driven(function* (this: JZipOutputStream, byte: number): Gen {
      yield vcall(this, "write", "([BII)V", Int8Array.of(byte), 0, 1);
    }),
    "write([B)V": driven(function* (this: JZipOutputStream, bytes: Int8Array): Gen {
      yield vcall(this, "write", "([BII)V", bytes, 0, bytes.length);
    }),
    "write([BII)V": driven(function* (this: JZipOutputStream, bytes: Int8Array, off: number, len: number): Gen {
      if (!this.entry) throw rt.mkThrowable("java/util/zip/ZipException", "no current ZIP entry");
      checkFromIndexSize(off, len, bytes.length);
      if (len) this.entry.push(u8(bytes, off, len).slice());
      yield this.flushChunks();
    }),
    "closeEntry()V": function (this: JZipOutputStream) { return this.closeEntry(); },
    "setLevel(I)V": function (this: JZipOutputStream, level: number) {
      if (level < 0 || level > 9) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid compression level");
      this.level = level;
    },
    "finish()V": driven(function* (this: JZipOutputStream): Gen {
      if (this.finished || !this.archive) return;
      yield this.closeEntry();
      this.archive.end();
      this.finished = true;
      yield this.flushChunks();
    }),
    "flush()V": driven(function* (this: JZipOutputStream): Gen { yield this.flushChunks(); yield vcall(filterOut(this), "flush", "()V"); }),
    "close()V": driven(function* (this: JZipOutputStream): Gen {
      if (!this.archive) return;
      yield vcall(this, "finish", "()V");
      yield vcall(filterOut(this), "close", "()V");
      this.archive = null;
    }),
  },
});
class JZipFile extends JObj {
  name = "";
  entries = new Map<string, ZEntry>();
  data: (e: ZEntry) => Uint8Array | Promise<Uint8Array> = () => new Uint8Array(0);
}
async function openZip(this: JZipFile, path: string) {
  this.name = vfs.norm(path);
  const bytes = vfs.read(path);
  if (bytes) { this.entries = centralDir(bytes); this.data = (e) => entryBytes(bytes, e); return; }
  const source = vfs.source(path);
  if (source) { this.entries = await centralDirOfSource(source); this.data = (e) => entryBytesOfSource(source, e); return; }
  throw rt.mkThrowable("java/io/FileNotFoundException", path + " (No such file or directory)");
}
const openZipFile = function (this: JZipFile, f: JObj) { return openZip.call(this, pathOf(f)); };
/** a JarFile's entries are its own JarEntry subclass, as ZipFile.getZipEntry makes them */
function entryOf(zip: JZipFile, e: ZEntry): JZipEntry | Promise<JZipEntry> {
  if (!rt.iof(zip, "java/util/jar/JarFile")) return mkZipEntry(e);
  return after(vcall(zip, "entryFor", "(Ljava/lang/String;)Ljava/util/jar/JarEntry;", e.name) as JZipEntry | Promise<JZipEntry>, (entry) => { entry.e = e; return entry; });
}
/** the manifest and signature files JarFile verifies with, as ZipFile.Source indexes them:
 *  META-INF/MANIFEST.MF and META-INF's own .SF, .DSA, .RSA and .EC files, ignoring case */
function jarMeta(zip: JZipFile): { manifest: string | null; signatures: string[] } {
  let manifest: string | null = null;
  const signatures: string[] = [];
  for (const name of zip.entries.keys()) {
    const upper = name.toUpperCase();
    if (!upper.startsWith("META-INF/")) continue;
    if (upper === "META-INF/MANIFEST.MF") manifest ??= name;
    else if (!upper.includes("/", 9) && /\.(SF|DSA|RSA|EC)$/.test(upper)) signatures.push(name);
  }
  return { manifest, signatures };
}
rt.register({
  name: "java/util/zip/ZipFile", ctor: JZipFile, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>(Ljava/lang/String;)V": openZip,
    "<init>(Ljava/io/File;)V": openZipFile,
    "<init>(Ljava/io/File;I)V": openZipFile,
    "<init>(Ljava/io/File;IZ)V": openZipFile,
    "getName()Ljava/lang/String;": function (this: JZipFile) { return this.name; },
    "getManifestName(Z)Ljava/lang/String;": function (this: JZipFile, onlyIfSigned: number) {
      const { manifest, signatures } = jarMeta(this);
      return onlyIfSigned && !signatures.length ? null : manifest;
    },
    "getManifestAndSignatureRelatedFiles()Ljava/util/List;": function (this: JZipFile) {
      const { manifest, signatures } = jarMeta(this);
      return newArrayList(manifest ? [manifest, ...signatures] : signatures);
    },
    "size()I": function (this: JZipFile) { return this.entries.size; },
    "entries()Ljava/util/Enumeration;": driven(function* (this: JZipFile): Gen {
      const entries = [];
      for (const e of this.entries.values()) entries.push(yield entryOf(this, e));
      return mkEnumeration(entries);
    }),
    "getEntry(Ljava/lang/String;)Ljava/util/zip/ZipEntry;": function (this: JZipFile, name: string) {
      const e = this.entries.get(name) ?? this.entries.get(name + "/");
      return e ? entryOf(this, e) : null;
    },
    "getInputStream(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;": driven(function* (this: JZipFile, ze: JZipEntry): Gen {
      const e = this.entries.get(ze.e.name);
      if (!e) return null;
      const b = yield this.data(e);
      return newObj("java/io/ByteArrayInputStream", "([B)V", i8(b));
    }),
    "close()V": function () {},
  },
});

// ── ZipInputStream: the source is drained and indexed by its central directory, which is what
// makes an entry with a data descriptor (sizes only after the data) readable without decoding
// ahead; entries are then served in local-header order, one buffer-backed entry at a time.
class JZipInputStream extends JObj { buf: Uint8Array = new Uint8Array(0); pos = 0; zip: Uint8Array | null = null; entries: ZEntry[] = []; next = 0; }
async function openZipStream(this: JZipInputStream, src: unknown) {
  if (src === null) throw rt.mkThrowable("java/lang/NullPointerException", "in == null");
  this.zip = await readStreamFully(src);
}
rt.register({
  name: "java/util/zip/ZipInputStream", ctor: JZipInputStream, sup: "java/util/zip/InflaterInputStream",
  methods: {
    "<init>(Ljava/io/InputStream;)V": openZipStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V": openZipStream,
    ...heldByteReads,
    "getNextEntry()Ljava/util/zip/ZipEntry;": function (this: JZipInputStream) {
      if (!this.zip) throw rt.mkThrowable("java/io/IOException", "Stream closed");
      if (!this.next && !this.entries.length) {
        try { this.entries = [...centralDir(this.zip).values()].sort((a, b) => a.off - b.off); }
        catch (e) { throw rt.mkThrowable("java/util/zip/ZipException", (e as Error).message); }
      }
      const e = this.entries[this.next];
      if (!e) { this.buf = new Uint8Array(0); this.pos = 0; return null; }
      this.next++;
      this.buf = e.name.endsWith("/") ? new Uint8Array(0) : entryBytes(this.zip, e);
      this.pos = 0;
      return mkZipEntry(e);
    },
    "closeEntry()V": function (this: JZipInputStream) { this.buf = new Uint8Array(0); this.pos = 0; },
    "available()I": function (this: JZipInputStream) { return this.pos < this.buf.length ? 1 : 0; },
    "close()V": function (this: JZipInputStream) { this.zip = null; this.buf = new Uint8Array(0); this.pos = 0; },
  },
});

// ── GZIPInputStream: the whole source is gunzipped up front and served like any buffer-backed stream
class JGzipIn extends JObj { buf: Uint8Array = new Uint8Array(0); pos = 0; }
async function gunzip(this: JGzipIn, src: unknown) {
  const z = await readStreamFully(src);
  try { this.buf = gunzipSync(z); }
  catch (e) { throw rt.mkThrowable("java/util/zip/ZipException", (e as Error).message); }
}
rt.register({
  name: "java/util/zip/GZIPInputStream", ctor: JGzipIn, sup: "java/io/InputStream",
  methods: {
    ...heldByteReads,
    "<init>(Ljava/io/InputStream;)V": gunzip,
    "<init>(Ljava/io/InputStream;I)V": gunzip,
  },
});
