// java.util.zip on fflate: streaming codecs (Inflater/Deflater raw+zlib, CRC32), ZipFile over a
// central-directory index, GZIPInputStream over a drained source.
import { Inflate, Unzlib, Deflate, Zlib, Gzip, inflateSync, gunzipSync, type DeflateOptions } from "fflate";
import { rt, JObj } from "../runtime";
import { utf8, i8, u8 } from "../abi";
import { vcall, vcallMaybe, newObj, defineException } from "./jlang";
import { vfs, JFile, JInputStream, JOutputStream, readStreamFully } from "./jio";
import { mkIter } from "./jutil";
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
class JDeflaterOut extends JOutputStream { out: unknown = null; def = new JDeflater(); closed = false; }
async function pump(s: JDeflaterOut) {
  for (const c of s.def.out) await vcall(s.out, "write", "([BII)V", i8(c), 0, c.length);
  s.def.out = [];
}
function dosInit(this: JDeflaterOut, o: unknown, def?: JDeflater | null) { this.out = o; if (def) this.def = def; }
rt.register({
  name: "java/util/zip/DeflaterOutputStream", ctor: JDeflaterOut, sup: "java/io/FilterOutputStream",
  fields: { out: "out", def: "def" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": dosInit,
    "<init>(Ljava/io/OutputStream;Z)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;I)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;Z)V": dosInit,
    "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;IZ)V": dosInit,
    "write(I)V": function (this: JDeflaterOut, b: number) { return vcallMaybe(this, "write", "([BII)V", Int8Array.of(b), 0, 1); },
    "write([BII)V": async function (this: JDeflaterOut, b: Int8Array, off: number, len: number) {
      if (this.def.done) throw rt.mkThrowable("java/io/IOException", "write beyond end of stream");
      if (len > 0) { this.def.feed(u8(b, off, len).slice()); await pump(this); }
    },
    "finish()V": async function (this: JDeflaterOut) {
      if (!this.def.done) { this.def.feed(new Uint8Array(0), true); await pump(this); }
    },
    "flush()V": function (this: JDeflaterOut) { return vcallMaybe(this.out, "flush", "()V"); },
    "close()V": async function (this: JDeflaterOut) {
      if (this.closed) return;
      this.closed = true;
      await vcall(this, "finish", "()V");
      await vcall(this.out, "close", "()V");
    },
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

class JCRC32 extends JObj { crc = 0xffffffff; }
const CRC_T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[i] = c >>> 0; }
rt.register({
  name: "java/util/zip/CRC32", ctor: JCRC32,
  methods: {
    "<init>()V": function () {},
    "update([BII)V": function (this: JCRC32, b: Int8Array, off: number, len: number) {
      let c = this.crc;
      for (let i = 0; i < len; i++) c = CRC_T[(c ^ b[off + i]) & 0xff] ^ (c >>> 8);
      this.crc = c >>> 0;
    },
    "update(I)V": function (this: JCRC32, v: number) { this.crc = (CRC_T[(this.crc ^ v) & 0xff] ^ (this.crc >>> 8)) >>> 0; },
    "getValue()J": function (this: JCRC32) { return BigInt((this.crc ^ 0xffffffff) >>> 0); },
    "reset()V": function (this: JCRC32) { this.crc = 0xffffffff; },
  },
});

class JAdler32 extends JObj { a = 1; b = 0; }
rt.register({
  name: "java/util/zip/Adler32", ctor: JAdler32,
  methods: {
    "<init>()V": function () {},
    "update([BII)V": function (this: JAdler32, buf: Int8Array, off: number, len: number) {
      let { a, b } = this;
      for (let i = 0; i < len; i++) { a = (a + (buf[off + i] & 0xff)) % 65521; b = (b + a) % 65521; }
      this.a = a; this.b = b;
    },
    "update([B)V": function (this: JAdler32, buf: Int8Array) { return vcall(this, "update", "([BII)V", buf, 0, buf.length); },
    "update(I)V": function (this: JAdler32, v: number) { this.a = (this.a + (v & 0xff)) % 65521; this.b = (this.b + this.a) % 65521; },
    "getValue()J": function (this: JAdler32) { return BigInt(((this.b << 16) | this.a) >>> 0); },
    "reset()V": function (this: JAdler32) { this.a = 1; this.b = 0; },
  },
});

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
export function entryBytes(z: Uint8Array, e: ZEntry): Uint8Array {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  // the local header carries its own name/extra lengths, which may differ from the central ones
  const start = e.off + 30 + v.getUint16(e.off + 26, true) + v.getUint16(e.off + 28, true);
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
  for (const e of centralDir(z).values()) {
    if (e.name.endsWith("/")) continue;
    const name = rename ? rename(e.name) : e.name;
    if (name === null || Object.prototype.hasOwnProperty.call(into, name)) continue;
    const pin = (value: Uint8Array) => { Object.defineProperty(into, name, { value, writable: true, enumerable: true, configurable: true }); return value; };
    Object.defineProperty(into, name, {
      enumerable: true, configurable: true,
      get: () => pin(entryBytes(z, e)),
      set: pin,
    });
  }
  return into;
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
    "getName()Ljava/lang/String;": function (this: JZipEntry) { return this.e.name; },
    "getSize()J": function (this: JZipEntry) { return BigInt(this.e.size); },
    "getCompressedSize()J": function (this: JZipEntry) { return BigInt(this.e.csize); },
    "getTime()J": function (this: JZipEntry) { return BigInt(this.e.time); },
    "getMethod()I": function (this: JZipEntry) { return this.e.method; },
    "isDirectory()Z": function (this: JZipEntry) { return this.e.name.endsWith("/") ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JZipEntry) { return this.e.name; },
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
const openZipFile = function (this: JZipFile, f: JFile) { return openZip.call(this, f.path); };
rt.register({
  name: "java/util/zip/ZipFile", ctor: JZipFile, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>(Ljava/lang/String;)V": openZip,
    "<init>(Ljava/io/File;)V": openZipFile,
    "<init>(Ljava/io/File;I)V": openZipFile,
    "getName()Ljava/lang/String;": function (this: JZipFile) { return this.name; },
    "size()I": function (this: JZipFile) { return this.entries.size; },
    "entries()Ljava/util/Enumeration;": function (this: JZipFile) { return mkIter([...this.entries.values()].map(mkZipEntry)); },
    "getEntry(Ljava/lang/String;)Ljava/util/zip/ZipEntry;": function (this: JZipFile, name: string) {
      const e = this.entries.get(name) ?? this.entries.get(name + "/");
      return e ? mkZipEntry(e) : null;
    },
    "getInputStream(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;": async function (this: JZipFile, ze: JZipEntry) {
      const e = this.entries.get(ze.e.name);
      if (!e) return null;
      const b = await this.data(e);
      return newObj("java/io/ByteArrayInputStream", "([B)V", i8(b));
    },
    "close()V": function () {},
  },
});

// ── ZipInputStream: the source is drained and indexed by its central directory, which is what
// makes an entry with a data descriptor (sizes only after the data) readable without decoding
// ahead; entries are then served in local-header order, one buffer-backed entry at a time.
class JZipInputStream extends JInputStream { zip: Uint8Array | null = null; entries: ZEntry[] = []; next = 0; }
async function openZipStream(this: JZipInputStream, src: JInputStream) {
  if (src === null) throw rt.mkThrowable("java/lang/NullPointerException", "in == null");
  this.zip = await readStreamFully(src);
}
rt.register({
  name: "java/util/zip/ZipInputStream", ctor: JZipInputStream, sup: "java/util/zip/InflaterInputStream",
  methods: {
    "<init>(Ljava/io/InputStream;)V": openZipStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V": openZipStream,
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
rt.register({ name: "java/util/zip/InflaterInputStream", ctor: class extends JInputStream {}, sup: "java/io/FilterInputStream" });

// ── GZIPInputStream: the whole source is gunzipped up front and served like any buffer-backed stream
async function gunzip(this: JInputStream, src: JInputStream) {
  const z = await readStreamFully(src);
  try { this.buf = gunzipSync(z); }
  catch (e) { throw rt.mkThrowable("java/util/zip/ZipException", (e as Error).message); }
}
rt.register({
  name: "java/util/zip/GZIPInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "<init>(Ljava/io/InputStream;)V": gunzip,
    "<init>(Ljava/io/InputStream;I)V": gunzip,
  },
});
