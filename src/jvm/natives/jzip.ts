// java.util.zip on fflate: streaming codecs (Inflater/Deflater raw+zlib, CRC32), ZipFile over a
// central-directory index, GZIPInputStream over a drained source.
import { Inflate, Unzlib, Deflate, Zlib, inflateSync, gunzipSync, deflateSync, zlibSync, gzipSync } from "fflate";
import { rt, JObj, type NativeSpec } from "../runtime";
import { mangleMethod } from "../abi";
import { vcall, newObj, defineException } from "./jlang";
import { vfs, JFile, JInputStream, JOutputStream } from "./jio";
import { mkIter } from "./jutil";

type Codec = Inflate | Unzlib | Deflate | Zlib;
class JInflater extends JObj {
  raw = false;
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  fed = 0;
  /** input bytes not consumed: what sits past the final block (a gzip trailer) */
  rem = 0;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Inflate() : new Unzlib();
      this.st.ondata = (d, final) => { if (d.length) this.out.push(d); if (final) this.done = true; };
    }
    return this.st;
  }
  // Java keeps input handed over after the end of stream (okio reads the trailer back through
  // getRemaining); fflate would throw on it. It parks the unconsumed tail in `p` and only ever
  // tests "last block decoded" as `s.f && !s.l` internally, so that test is repeated here.
  feed(b: Uint8Array) {
    this.fed += b.length;
    if (this.done) { this.rem = b.length; return; }
    const st = this.ensure() as any;
    st.push(b);
    if (st.s.f && !st.s.l) this.done = true;
    this.rem = st.p?.length ?? 0;
  }
}
function drain(z: JInflater, b: Int8Array, off: number, len: number): number {
  let n = 0;
  while (n < len && z.out.length) {
    const c = z.out[0];
    const take = Math.min(len - n, c.length);
    new Uint8Array(b.buffer, b.byteOffset + off + n, take).set(c.subarray(0, take));
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
      this.feed(new Uint8Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + len)));
    },
    "setInput([B)V": function (this: JInflater, b: Int8Array) {
      this.feed(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
    },
    "inflate([BII)I": function (this: JInflater, b: Int8Array, off: number, len: number) { return drain(this, b, off, len); },
    "inflate([B)I": function (this: JInflater, b: Int8Array) { return drain(this, b, 0, b.length); },
    "needsInput()Z": function (this: JInflater) { return this.out.length ? 0 : 1; },
    "needsDictionary()Z": () => 0,
    "finished()Z": function (this: JInflater) { return this.done && !this.out.length ? 1 : 0; },
    "getRemaining()I": function (this: JInflater) { return this.rem; },
    "getBytesRead()J": function (this: JInflater) { return BigInt(this.fed); },
    "getBytesWritten()J": function (this: JInflater) { return BigInt(this.fed); },
    "reset()V": function (this: JInflater) { this.st = null; this.out = []; this.done = false; this.fed = 0; this.rem = 0; },
    "end()V": function (this: JInflater) { this.st = null; this.out = []; },
  },
});

class JDeflater extends JObj {
  raw = false;
  st: Codec | null = null;
  out: Uint8Array[] = [];
  done = false;
  pending: Uint8Array | null = null;
  ensure() {
    if (!this.st) {
      this.st = this.raw ? new Deflate() : new Zlib();
      this.st.ondata = (d, final) => { if (d.length) this.out.push(d); if (final) this.done = true; };
    }
    return this.st;
  }
}
rt.register({
  name: "java/util/zip/Deflater", ctor: JDeflater,
  methods: {
    "<init>()V": function () {},
    // fflate's Deflate has no level knob: the level argument is accepted and ignored.
    "<init>(I)V": function () {},
    "<init>(IZ)V": function (this: JDeflater, _level: number, nowrap: number) { this.raw = !!nowrap; },
    "setInput([BII)V": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      this.pending = new Uint8Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + len));
    },
    "finish()V": function (this: JDeflater) {
      this.ensure().push(this.pending ?? new Uint8Array(0), true);
      this.pending = null;
    },
    "deflate([BII)I": function (this: JDeflater, b: Int8Array, off: number, len: number) {
      if (this.pending) { this.ensure().push(this.pending); this.pending = null; }
      const z = this as unknown as JInflater;
      return drain(z, b, off, len);
    },
    "finished()Z": function (this: JDeflater) { return this.done && !this.out.length ? 1 : 0; },
    "needsInput()Z": function (this: JDeflater) { return this.pending ? 0 : 1; },
    "end()V": function (this: JDeflater) { this.st = null; this.out = []; },
    "reset()V": function (this: JDeflater) { this.st = null; this.out = []; this.done = false; this.pending = null; },
  },
});

// DeflaterOutputStream / GZIPOutputStream: bytes collect in the inherited chunk buffer and are
// compressed in one go at finish(), which is when Java would emit the final block anyway.
class JDeflaterOut extends JOutputStream { out: unknown = null; raw = false; gzip = false; finished = false; }
async function finishDeflate(s: JDeflaterOut) {
  if (s.finished) return;
  s.finished = true;
  const data = new Uint8Array(s.chunks);
  const z = s.gzip ? gzipSync(data) : s.raw ? deflateSync(data) : zlibSync(data);
  await vcall(s.out, "write", "([BII)V", new Int8Array(z.buffer, z.byteOffset, z.length), 0, z.length);
}
const deflaterOut: NativeSpec["methods"] = {
  "<init>(Ljava/io/OutputStream;)V": function (this: JDeflaterOut, o: unknown) { this.out = o; },
  "<init>(Ljava/io/OutputStream;I)V": function (this: JDeflaterOut, o: unknown) { this.out = o; },
  "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;)V": function (this: JDeflaterOut, o: unknown, d: JDeflater) { this.out = o; this.raw = d.raw; },
  "<init>(Ljava/io/OutputStream;Ljava/util/zip/Deflater;I)V": function (this: JDeflaterOut, o: unknown, d: JDeflater) { this.out = o; this.raw = d.raw; },
  "finish()V": function (this: JDeflaterOut) { return finishDeflate(this); },
  "flush()V": function (this: JDeflaterOut) { return vcall(this.out, "flush", "()V"); },
  "close()V": async function (this: JDeflaterOut) { await finishDeflate(this); await vcall(this.out, "close", "()V"); },
};
rt.register({ name: "java/util/zip/DeflaterOutputStream", ctor: JDeflaterOut, sup: "java/io/OutputStream", methods: deflaterOut });
rt.register({
  name: "java/util/zip/GZIPOutputStream", ctor: class extends JDeflaterOut { gzip = true; }, sup: "java/util/zip/DeflaterOutputStream",
  methods: deflaterOut,
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

defineException("java/util/zip/ZipException", "java/io/IOException");

// ── ZipFile / ZipEntry: index the central directory, inflate an entry only when it is read
interface ZEntry { name: string; method: number; csize: number; size: number; time: number; off: number; }
const UNKNOWN: ZEntry = { name: "", method: -1, csize: -1, size: -1, time: -1, off: -1 };
/** what ApplicationInfo.sourceDir answers (android/app.ts): the apk exists only as the unpacked classpath */
const SOURCE_DIR = "/data/app/base.apk";
function dosTime(date: number, time: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}
function centralDir(z: Uint8Array): Map<string, ZEntry> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22; // end-of-central-directory record, scanning back over any archive comment
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw rt.mkThrowable("java/util/zip/ZipException", "End Of Central Directory signature not found");
  const out = new Map<string, ZEntry>();
  let p = v.getUint32(e + 16, true);
  for (let n = v.getUint16(e + 10, true); n > 0; n--) {
    const nl = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nl));
    out.set(name, {
      name, method: v.getUint16(p + 10, true), time: dosTime(v.getUint16(p + 14, true), v.getUint16(p + 12, true)),
      csize: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), off: v.getUint32(p + 42, true),
    });
    p += 46 + nl + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}
function entryBytes(z: Uint8Array, e: ZEntry): Uint8Array {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  // the local header carries its own name/extra lengths, which may differ from the central ones
  const start = e.off + 30 + v.getUint16(e.off + 26, true) + v.getUint16(e.off + 28, true);
  const raw = z.subarray(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateSync(raw);
  throw rt.mkThrowable("java/util/zip/ZipException", "Invalid compression method " + e.method + ": " + e.name);
}
class JZipEntry extends JObj { e: ZEntry = UNKNOWN; }
function mkZipEntry(e: ZEntry): JZipEntry {
  const z = new (rt.link("java/util/zip/ZipEntry").ctor)() as JZipEntry;
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
  data: (e: ZEntry) => Uint8Array = () => new Uint8Array(0);
}
function openZip(this: JZipFile, path: string) {
  this.name = vfs.norm(path);
  const bytes = vfs.read(path);
  if (bytes) { this.entries = centralDir(bytes); this.data = (e) => entryBytes(bytes, e); return; }
  // the app's own package is already unpacked; what only the central directory knows stays -1
  if (this.name === SOURCE_DIR) {
    for (const [name, b] of Object.entries(rt.classpath)) this.entries.set(name, { ...UNKNOWN, name, size: b.length });
    this.data = (e) => rt.classpath[e.name];
    return;
  }
  throw rt.mkThrowable("java/io/FileNotFoundException", path + " (No such file or directory)");
}
const openZipFile = function (this: JZipFile, f: JFile) { openZip.call(this, f.path); };
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
    "getInputStream(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;": function (this: JZipFile, ze: JZipEntry) {
      const e = this.entries.get(ze.e.name);
      if (!e) return null;
      const b = this.data(e);
      return newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(b.buffer, b.byteOffset, b.length));
    },
    "close()V": function () {},
  },
});

// ── GZIPInputStream: the whole source is gunzipped up front and served like any buffer-backed stream
const readI = mangleMethod("read", "()I"), readBII = mangleMethod("read", "([BII)I");
/** everything the source still holds — in place for a native buffer stream, else through its own read([BII) */
async function drainStream(src: JInputStream): Promise<Uint8Array> {
  const base = JInputStream.prototype as any;
  if (src instanceof JInputStream && (src as any)[readI] === base[readI] && (src as any)[readBII] === base[readBII]) {
    const b = src.buf.subarray(src.pos);
    src.pos = src.buf.length;
    return b;
  }
  const chunks: Uint8Array[] = [];
  const buf = new Int8Array(65536);
  let n = 0, total = 0;
  while ((n = await vcall(src, "read", "([BII)I", buf, 0, buf.length)) > 0) { chunks.push(new Uint8Array(buf.buffer.slice(0, n))); total += n; }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
async function gunzip(this: JInputStream, src: JInputStream) {
  const z = await drainStream(src);
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
