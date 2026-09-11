// java.io.* natives and the VFS shared with native file descriptors.

import { rt, JObj, maySuspend, type NativeSpec } from "../runtime";
import { mangleStaticField, mangleMethod, charsToString, jarray, utf8, concat, i8, u8 } from "../abi";
import { vcall, vcallMaybe, after, stringHash, mkEnumSet, javaFormat, newObj, defineException, type JSimpleEnum } from "./jlang";
import { BytesFile, readFully, type FileSource } from "../../shell/lazyfile";
import { mappedReadOnlyBuffer } from "./jnio";

/** Where an installed apk lives, spelled once: the base, or one of its config/feature splits.
 *  ApplicationInfo.sourceDir/splitSourceDirs answer with these and ZipFile opens them. */
export const apkPath = (split?: string) => split ? `/data/app/split_${split}.apk` : "/data/app/base.apk";

// marker interface — apps implement this to opt into custom serialization; writeExternal/
// readExternal dispatch isn't needed by anything exercised so far, so this just stops the
// interface from auto-stubbing when an app class implements it directly (see "VM and
// framework lessons" in the implementation history).
rt.register({ name: "java/io/Externalizable", ctor: class extends JObj {}, ifaces: ["java/io/Serializable"] });

// ── VFS: path → bytes. Directories implicit.
export const vfs = {
  files: new Map<string, Uint8Array>(),
  lazyFiles: new Map<string, FileSource>(),
  dirs: new Set<string>(["/data", "/sdcard"]),
  prepare: (_pkg: string): Promise<void> => Promise.resolve(),
  flush: (): Promise<void> => Promise.resolve(),
  onWrite: (path: string) => {},
  norm(p: string): string {
    const parts: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "/" + parts.join("/");
  },
  read(p: string): Uint8Array | null { return this.files.get(this.norm(p)) ?? null; },
  readFile(p: string): Uint8Array | Promise<Uint8Array> | null {
    const path = this.norm(p);
    const bytes = this.files.get(path);
    if (bytes) return bytes;
    const source = this.lazyFiles.get(path);
    return source ? readFully(source) : null;
  },
  source(p: string): FileSource | null {
    const path = this.norm(p);
    const bytes = this.files.get(path);
    return bytes ? new BytesFile(bytes) : this.lazyFiles.get(path) ?? null;
  },
  stat(p: string): { size: number; source: FileSource } | null {
    const source = this.source(p);
    return source ? { size: source.size, source } : null;
  },
  write(p: string, data: Uint8Array) {
    const path = this.norm(p);
    this.lazyFiles.delete(path);
    this.files.set(path, data);
    this.onWrite(path);
  },
  mount(p: string, source: FileSource) {
    const path = this.norm(p);
    this.files.delete(path);
    this.lazyFiles.set(path, source);
  },
  lazy() {
    return [...this.lazyFiles].map(([path, source]) => ({ path, size: source.size, ...source.stats?.() }));
  },
  exists(p: string): boolean {
    p = this.norm(p);
    if (this.files.has(p) || this.lazyFiles.has(p)) return true;
    const dir = p.endsWith("/") ? p : p + "/";
    for (const k of this.files.keys()) if (k.startsWith(dir)) return true;
    for (const k of this.lazyFiles.keys()) if (k.startsWith(dir)) return true;
    return this.dirs.has(p);
  },
  isDir(p: string): boolean {
    p = this.norm(p);
    if (this.files.has(p) || this.lazyFiles.has(p)) return false;
    const dir = p.endsWith("/") ? p : p + "/";
    for (const k of this.files.keys()) if (k.startsWith(dir)) return true;
    for (const k of this.lazyFiles.keys()) if (k.startsWith(dir)) return true;
    return this.dirs.has(p);
  },
  delete(p: string): boolean {
    const path = this.norm(p);
    const removed = this.files.delete(path) || this.lazyFiles.delete(path);
    if (removed) this.onWrite(path);
    return removed;
  },
  mkdir(p: string) { const path = this.norm(p); if (!this.dirs.has(path)) { this.dirs.add(path); this.onWrite(path); } },
  rmdir(p: string): boolean { const path = this.norm(p), removed = this.dirs.delete(path); if (removed) this.onWrite(path); return removed; },
  list(p: string): string[] {
    p = this.norm(p);
    const dir = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(dir)) names.add(k.slice(dir.length).split("/")[0]);
    }
    for (const k of this.lazyFiles.keys()) {
      if (k.startsWith(dir)) names.add(k.slice(dir.length).split("/")[0]);
    }
    for (const d of this.dirs) if (d.startsWith(dir)) names.add(d.slice(dir.length).split("/")[0]);
    names.delete("");
    return [...names];
  },
};

export class JFile extends JObj { path = ""; }
export function mkFile(path: string): JFile { const f = new JFile(); f.path = vfs.norm(path); return f; }
const listFiles = (d: JFile) => jarray(vfs.list(d.path).map((n) => mkFile(d.path + "/" + n)), "Ljava/io/File;");
// apps implement these to pick over a directory listing (File.listFiles(filter))
rt.markers("java/io/FilenameFilter", "java/io/FileFilter");
// Default dir matches System.getProperty("java.io.tmpdir"). Creation cannot fail in the in-memory vfs.
function createTempFile(prefix: string, suffix: string | null, dir: JFile | null): JFile {
  if (prefix.length < 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Prefix string too short");
  for (;;) {
    const f = mkFile(`${dir?.path ?? "/data/local/tmp"}/${prefix}${Math.floor(Math.random() * 1e9)}${suffix ?? ".tmp"}`);
    if (!vfs.exists(f.path)) { vfs.write(f.path, new Uint8Array(0)); return f; }
  }
}
rt.register({
  name: "java/io/File", ctor: JFile,
  ifaces: ["java/io/Serializable", "java/lang/Comparable"],
  statics: { separator: "/", separatorChar: 47, pathSeparator: ":" },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JFile, p: string) { this.path = vfs.norm(p); },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JFile, d: string, n: string) { this.path = vfs.norm(d + "/" + n); },
    "<init>(Ljava/io/File;Ljava/lang/String;)V": function (this: JFile, d: JFile, n: string) { this.path = vfs.norm((d?.path ?? "") + "/" + n); },
    "getPath()Ljava/lang/String;": function (this: JFile) { return this.path; },
    "getAbsolutePath()Ljava/lang/String;": function (this: JFile) { return this.path; },
    "getCanonicalPath()Ljava/lang/String;": function (this: JFile) { return this.path; },
    "getName()Ljava/lang/String;": function (this: JFile) { return this.path.split("/").pop() ?? ""; },
    "getParent()Ljava/lang/String;": function (this: JFile) {
      const i = this.path.lastIndexOf("/");
      return i <= 0 ? null : this.path.slice(0, i);
    },
    "getParentFile()Ljava/io/File;": function (this: JFile) {
      const i = this.path.lastIndexOf("/");
      return i <= 0 ? null : mkFile(this.path.slice(0, i));
    },
    "getAbsoluteFile()Ljava/io/File;": function (this: JFile) { return this; },
    "getCanonicalFile()Ljava/io/File;": function (this: JFile) { return this; },
    "exists()Z": function (this: JFile) { return vfs.exists(this.path) ? 1 : 0; },
    "isDirectory()Z": function (this: JFile) { return vfs.isDir(this.path) ? 1 : 0; },
    "isFile()Z": function (this: JFile) { return vfs.stat(this.path) ? 1 : 0; },
    "length()J": function (this: JFile) { return BigInt(vfs.stat(this.path)?.size ?? 0); },
    "lastModified()J": function () { return BigInt(Date.now()); },
    "setLastModified(J)Z": () => 1,
    "mkdir()Z": function (this: JFile) { vfs.mkdir(this.path); return 1; },
    "mkdirs()Z": function (this: JFile) { vfs.mkdir(this.path); return 1; },
    "createNewFile()Z": function (this: JFile) {
      if (vfs.exists(this.path)) return 0;
      vfs.write(this.path, new Uint8Array(0));
      return 1;
    },
    "static createTempFile(Ljava/lang/String;Ljava/lang/String;)Ljava/io/File;": (p: string, s: string | null) => createTempFile(p, s, null),
    "static createTempFile(Ljava/lang/String;Ljava/lang/String;Ljava/io/File;)Ljava/io/File;": createTempFile,
    "delete()Z": function (this: JFile) { return vfs.delete(this.path) ? 1 : 0; },
    "deleteOnExit()V": function () {},
    "renameTo(Ljava/io/File;)Z": function (this: JFile, dst: JFile) {
      const data = vfs.read(this.path);
      if (!data) return 0;
      vfs.write(dst.path, data);
      vfs.delete(this.path);
      return 1;
    },
    "list()[Ljava/lang/String;": function (this: JFile) {
      const a = vfs.list(this.path); (a as any).$t = "Ljava/lang/String;"; return a;
    },
    "listFiles()[Ljava/io/File;": function (this: JFile) { return listFiles(this); },
    "listFiles(Ljava/io/FilenameFilter;)[Ljava/io/File;": async function (this: JFile, f: unknown) {
      const out: JFile[] = [];
      for (const c of listFiles(this)) if (f === null || (await vcall(f, "accept", "(Ljava/io/File;Ljava/lang/String;)Z", this, c.path.slice(this.path.length + 1)))) out.push(c);
      return jarray(out, "Ljava/io/File;");
    },
    "listFiles(Ljava/io/FileFilter;)[Ljava/io/File;": async function (this: JFile, f: unknown) {
      const out: JFile[] = [];
      for (const c of listFiles(this)) if (f === null || (await vcall(f, "accept", "(Ljava/io/File;)Z", c))) out.push(c);
      return jarray(out, "Ljava/io/File;");
    },
    // the filtered forms return null for a non-directory, as the unfiltered ones should too
    "list(Ljava/io/FilenameFilter;)[Ljava/lang/String;": async function (this: JFile, f: unknown) {
      const out: string[] = [];
      for (const n of vfs.list(this.path)) if (!f || await vcall(f, "accept", "(Ljava/io/File;Ljava/lang/String;)Z", this, n)) out.push(n);
      (out as any).$t = "Ljava/lang/String;"; return out;
    },
    "canRead()Z": () => 1, "canWrite()Z": () => 1, "canExecute()Z": () => 1,
    "setReadable(Z)Z": () => 1, "setWritable(Z)Z": () => 1, "setExecutable(Z)Z": () => 1,
    "setReadable(ZZ)Z": () => 1, "setWritable(ZZ)Z": () => 1, "setExecutable(ZZ)Z": () => 1,
    "toString()Ljava/lang/String;": function (this: JFile) { return this.path; },
    "equals(Ljava/lang/Object;)Z": function (this: JFile, o: unknown) { return o instanceof JFile && o.path === this.path ? 1 : 0; },
    "hashCode()I": function (this: JFile) { return stringHash(this.path) ^ 1234321; },
    "toPath()Ljava/nio/file/Path;": function (this: JFile) { return mkPath(this.path); },
    "getFreeSpace()J": () => 1073741824n,
    "getUsableSpace()J": () => 1073741824n,
    "getTotalSpace()J": () => 2147483648n,
  },
});

export class JInputStream extends JObj {
  buf: Uint8Array = new Uint8Array(0);
  source: FileSource | null = null;
  wrapped: unknown = null;   // a bytecode InputStream this one reads through
  pos = 0;
}
/** a plain InputStream over bytes already in hand */
export function streamOf(bytes: Uint8Array): JInputStream {
  const s = new JInputStream();
  s.buf = bytes;
  return s;
}
export function streamOfSource(source: FileSource): JInputStream {
  const s = new JInputStream();
  s.source = source;
  return s;
}
const inputStreamMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "read()I": maySuspend(function (this: JInputStream) {
    checkFileOpen(this);
    if (this.wrapped) return vcall(this.wrapped, "read", "()I");
    if (this.source) {
      return after(this.source.read(this.pos, 1), (bytes) => {
        if (!bytes.length) return -1;
        this.pos++;
        return bytes[0];
      });
    }
    return this.pos < this.buf.length ? this.buf[this.pos++] : -1;
  }),
  "read([B)I": maySuspend(function (this: JInputStream, out: Int8Array) {
    return (this as any)[readBII](out, 0, out.length);
  }),
  "read([BII)I": maySuspend(function (this: JInputStream, out: Int8Array, off: number, len: number) {
    checkFileOpen(this);
    if (len === 0) return 0;
    if (this.wrapped) return vcall(this.wrapped, "read", "([BII)I", out, off, len);
    if (this.source) {
      return after(this.source.read(this.pos, len), (bytes) => {
        if (!bytes.length) return -1;
        out.set(i8(bytes), off);
        this.pos += bytes.length;
        return bytes.length;
      });
    }
    if (this.pos >= this.buf.length) return -1;
    const n = Math.min(len, this.buf.length - this.pos);
    out.set(i8(this.buf, this.pos, n), off);
    this.pos += n;
    return n;
  }),
  "available()I": function (this: JInputStream) { return (this.source?.size ?? this.buf.length) - this.pos; },
  "skip(J)J": function (this: JInputStream, n: bigint) {
    const k = Math.min(Number(n), (this.source?.size ?? this.buf.length) - this.pos);
    this.pos += k;
    return BigInt(k);
  },
  "close()V": maySuspend(function () {}),
  "mark(I)V": function (this: JInputStream) { (this as any).markPos = this.pos; },
  "reset()V": function (this: JInputStream) { this.pos = (this as any).markPos ?? 0; },
  "markSupported()Z": () => 1,
};
const readI = mangleMethod("read", "()I"), readBII = mangleMethod("read", "([BII)I");
const writeBII = mangleMethod("write", "([BII)V");
/** every byte an InputStream has left: in place when its reads are ours, else through its virtual read */
export async function readStreamFully(s: unknown): Promise<Uint8Array> {
  const base = JInputStream.prototype as any;
  if (s instanceof JInputStream && !s.wrapped && (s as any)[readI] === base[readI] && (s as any)[readBII] === base[readBII]) {
    checkFileOpen(s);
    const out = s.source ? await readFully(s.source, s.pos) : s.buf.subarray(s.pos);
    s.pos += out.length;
    return out;
  }
  const chunks: Uint8Array[] = [];
  const tmp = new Int8Array(1 << 16);
  for (;;) {
    const n = await vcall(s, "read", "([BII)I", tmp, 0, tmp.length) as number;
    if (n <= 0) break;
    chunks.push(new Uint8Array(tmp.buffer.slice(0, n)));
  }
  return concat(chunks);
}
rt.register({ name: "java/io/InputStream", ctor: JInputStream, ifaces: ["java/io/Closeable"], methods: inputStreamMethods });
rt.register({
  name: "java/io/ByteArrayInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "<init>([B)V": function (this: JInputStream, b: Int8Array) { this.buf = u8(b); },
    "<init>([BII)V": function (this: JInputStream, b: Int8Array, off: number, len: number) {
      this.buf = u8(b, off, len);
    },
  },
});
function openRead(this: JInputStream, p: string) {
  const bytes = vfs.read(p);
  if (bytes) this.buf = bytes;
  else {
    const source = vfs.source(p);
    if (!source) throw rt.mkThrowable("java/io/FileNotFoundException", p);
    this.source = source;
  }
}
rt.register({
  name: "java/io/FileInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": () => new JFileDescriptor(),
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "<init>(Ljava/io/File;)V": function (this: JInputStream, f: JFile) { openRead.call(this, f.path); },
    "<init>(Ljava/lang/String;)V": openRead,
    "close()V": function (this: JInputStream) { closeFile(this); },
  },
});
/** a wrapping stream shares the source's bytes and cursor, or — when the source is an app's own
 *  stream — reads through the source's virtual read, which is the only way in */
function adoptStream(this: JInputStream, src: JInputStream) {
  if (src instanceof JInputStream) { this.buf = src.buf; this.source = src.source; this.pos = src.pos; }
  else this.wrapped = src;
}
rt.register({
  name: "java/io/BufferedInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "<init>(Ljava/io/InputStream;)V": adoptStream,
    "<init>(Ljava/io/InputStream;I)V": adoptStream,
  },
});
rt.register({
  name: "java/io/DataInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  ifaces: ["java/io/DataInput"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": adoptStream,
    "readInt()I": dataRead(4, (b) => (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]),
    "readByte()B": dataRead(1, (b) => b[0] << 24 >> 24),
    "readUnsignedByte()I": dataRead(1, (b) => b[0]),
    "readShort()S": dataRead(2, (b) => ((b[0] << 8) | b[1]) << 16 >> 16),
    "readUnsignedShort()I": dataRead(2, (b) => (b[0] << 8) | b[1]),
    "readLong()J": dataRead(8, (b) => new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0)),
    "readBoolean()Z": dataRead(1, (b) => (b[0] ? 1 : 0)),
    "readFully([B)V": maySuspend(function (this: JInputStream, out: Int8Array) {
      return after(dataBytes(this, out.length), (bytes) => { out.set(i8(bytes)); });
    }),
    "readUTF()Ljava/lang/String;": async function (this: JInputStream) {
      const head = await dataBytes(this, 2);
      return utf8.dec.decode(await dataBytes(this, (head[0] << 8) | head[1]));
    },
  },
});
function dataRead(length: number, decode: (b: Uint8Array) => unknown) {
  return maySuspend(function (this: JInputStream) { return after(dataBytes(this, length), decode); });
}
function dataBytes(stream: JInputStream, length: number): Uint8Array | Promise<Uint8Array> {
  const take = (bytes: Uint8Array) => {
    if (bytes.length !== length) throw rt.mkThrowable("java/io/EOFException", null);
    stream.pos += length;
    return bytes;
  };
  if (stream.wrapped) return wrappedBytes(stream, length).then(take);
  return stream.source ? readFully(stream.source, stream.pos, length).then(take) : take(stream.buf.subarray(stream.pos, stream.pos + length));
}
/** as many of `length` bytes as the wrapped stream has, one virtual read at a time */
async function wrappedBytes(stream: JInputStream, length: number): Promise<Uint8Array> {
  const out = new Int8Array(length);
  let got = 0;
  while (got < length) {
    const n: number = await vcall(stream.wrapped, "read", "([BII)I", out, got, length - got);
    if (n <= 0) break;
    got += n;
  }
  return new Uint8Array(out.buffer, 0, got);
}

export class JFileDescriptor extends JObj { fd = -1; }
rt.register({
  name: "java/io/FileDescriptor", ctor: JFileDescriptor,
  methods: { "<init>()V": () => {}, "sync()V": () => {}, "valid()Z": function (this: JFileDescriptor) { return this.fd >= 0 ? 1 : 0; } },
});
export class JOutputStream extends JObj {
  chunks: number[] = [];
}
rt.register({
  name: "java/io/OutputStream", ctor: JOutputStream, ifaces: ["java/io/Closeable", "java/io/Flushable"],
  methods: {
    "<init>()V": function () {},
    "write(I)V": function (this: JOutputStream, b: number) { this.chunks.push(b & 0xff); },
    "write([B)V": maySuspend(function (this: JOutputStream, b: Int8Array) {
      return (this as any)[writeBII](b, 0, b.length);
    }),
    "write([BII)V": function (this: JOutputStream, b: Int8Array, off: number, len: number) {
      for (let i = 0; i < len; i++) this.chunks.push(b[off + i] & 0xff);
    },
    "flush()V": maySuspend(function () {}),
    "close()V": function () {},
  },
});
// ── java.io.Object{Input,Output}Stream, over the serialization stream's BLOCK-DATA layer only.
// A primitive written outside writeObject travels in TC_BLOCKDATA records, which is the whole
// protocol Externalizable bodies (libphonenumber's metadata, for one) use. An object graph needs
// the class-descriptor and back-reference machinery, which is not modelled: readObject says so.
const STREAM_MAGIC = 0xaced, STREAM_VERSION = 5, TC_BLOCKDATA = 0x77, TC_BLOCKDATALONG = 0x7a;
class JObjectIn extends JInputStream { blockEnd = 0; }
/** `n` bytes of block data, crossing record boundaries the way a long writeUTF body does */
async function blockBytes(s: JObjectIn, n: number): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  for (let got = 0; got < n;) {
    while (s.blockEnd <= s.pos) {
      const tag = (await dataBytes(s, 1))[0];
      if (tag === TC_BLOCKDATA) s.blockEnd = s.pos + (await dataBytes(s, 1))[0];
      else if (tag === TC_BLOCKDATALONG) {
        const len = await dataBytes(s, 4);
        s.blockEnd = s.pos + new DataView(len.buffer, len.byteOffset, 4).getUint32(0);
      }
      else throw rt.mkThrowable("java/io/StreamCorruptedException", "unsupported serialization tag 0x" + tag.toString(16));
    }
    const take = Math.min(n - got, s.blockEnd - s.pos);
    out.set(await dataBytes(s, take), got);
    got += take;
  }
  return out;
}
const blockRead = (n: number, decode: (v: DataView) => unknown) =>
  maySuspend(async function (this: JObjectIn) {
    const b = await blockBytes(this, n);
    return decode(new DataView(b.buffer, b.byteOffset, n));
  });
/** modified UTF-8: NUL is two bytes and a supplementary character is two three-byte halves */
function modifiedUtf8(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length;) {
    const c = b[i++];
    if (c < 0x80) out += String.fromCharCode(c);
    else if ((c & 0xe0) === 0xc0) out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
  }
  return out;
}
defineException("java/io/StreamCorruptedException", "java/io/IOException");
const noGraph = (): never => { throw rt.mkThrowable("java/io/StreamCorruptedException", "object graph serialization is not available"); };
rt.register({
  name: "java/io/ObjectInputStream", ctor: JObjectIn, sup: "java/io/InputStream",
  ifaces: ["java/io/ObjectInput", "java/io/DataInput"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": maySuspend(async function (this: JObjectIn, src: JInputStream) {
      adoptStream.call(this, src);
      const head = await dataBytes(this, 4);
      const magic = (head[0] << 8) | head[1], version = (head[2] << 8) | head[3];
      if (magic !== STREAM_MAGIC || version !== STREAM_VERSION) {
        throw rt.mkThrowable("java/io/StreamCorruptedException", "invalid stream header");
      }
    }),
    "readInt()I": blockRead(4, (v) => v.getInt32(0)),
    "readShort()S": blockRead(2, (v) => v.getInt16(0)),
    "readUnsignedShort()I": blockRead(2, (v) => v.getUint16(0)),
    "readByte()B": blockRead(1, (v) => v.getInt8(0)),
    "readUnsignedByte()I": blockRead(1, (v) => v.getUint8(0)),
    "readBoolean()Z": blockRead(1, (v) => (v.getUint8(0) ? 1 : 0)),
    "readChar()C": blockRead(2, (v) => v.getUint16(0)),
    "readLong()J": blockRead(8, (v) => v.getBigInt64(0)),
    "readFloat()F": blockRead(4, (v) => v.getFloat32(0)),
    "readDouble()D": blockRead(8, (v) => v.getFloat64(0)),
    "readUTF()Ljava/lang/String;": maySuspend(async function (this: JObjectIn) {
      const head = await blockBytes(this, 2);
      return modifiedUtf8(await blockBytes(this, (head[0] << 8) | head[1]));
    }),
    "readFully([B)V": maySuspend(async function (this: JObjectIn, out: Int8Array) {
      const b = await blockBytes(this, out.length);
      out.set(i8(b));
    }),
    "readObject()Ljava/lang/Object;": noGraph,
    "defaultReadObject()V": noGraph,
    "close()V": function () {},
  },
});
class JObjectOut extends JOutputStream {}
/** every primitive write is its own TC_BLOCKDATA record, which reads back identically */
function blockWrite(o: JObjectOut, bytes: Uint8Array): void {
  o.chunks.push(TC_BLOCKDATA, bytes.length);
  for (const b of bytes) o.chunks.push(b);
}
const blockPut = (n: number, encode: (v: DataView, x: never) => void) =>
  function (this: JObjectOut, x: never) {
    const b = new Uint8Array(n);
    encode(new DataView(b.buffer), x);
    blockWrite(this, b);
  };
rt.register({
  name: "java/io/ObjectOutputStream", ctor: JObjectOut, sup: "java/io/OutputStream",
  ifaces: ["java/io/ObjectOutput", "java/io/DataOutput"],
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: JObjectOut, out: JOutputStream) {
      (this as unknown as { target: unknown }).target = out;
      this.chunks.push(STREAM_MAGIC >> 8, STREAM_MAGIC & 0xff, 0, STREAM_VERSION);
    },
    "writeInt(I)V": blockPut(4, (v, x: number) => v.setInt32(0, x)),
    "writeShort(I)V": blockPut(2, (v, x: number) => v.setInt16(0, x)),
    "writeByte(I)V": blockPut(1, (v, x: number) => v.setInt8(0, x)),
    "writeBoolean(Z)V": blockPut(1, (v, x: number) => v.setUint8(0, x ? 1 : 0)),
    "writeChar(I)V": blockPut(2, (v, x: number) => v.setUint16(0, x)),
    "writeLong(J)V": blockPut(8, (v, x: bigint) => v.setBigInt64(0, x)),
    "writeFloat(F)V": blockPut(4, (v, x: number) => v.setFloat32(0, x)),
    "writeDouble(D)V": blockPut(8, (v, x: number) => v.setFloat64(0, x)),
    "writeUTF(Ljava/lang/String;)V": function (this: JObjectOut, str: string) {
      const body = utf8.enc.encode(str);
      const b = new Uint8Array(body.length + 2);
      b[0] = body.length >> 8; b[1] = body.length & 0xff;
      b.set(body, 2);
      blockWrite(this, b);
    },
    "writeObject(Ljava/lang/Object;)V": noGraph,
    "flush()V": maySuspend(function (this: JObjectOut) {
      const target = (this as unknown as { target: unknown }).target;
      const bytes = Int8Array.from(this.chunks);
      this.chunks = [];
      return target ? vcall(target, "write", "([BII)V", bytes, 0, bytes.length) : undefined;
    }),
    "close()V": maySuspend(function (this: JObjectOut) { return vcall(this, "flush", "()V"); }),
  },
});

// ByteArrayOutputStream keeps AOSP's protected `buf`/`count` as real fields: subclasses (pooled
// buffers, size probes) swap the array and read the count directly, so the bytes live in the
// Int8Array itself rather than in the base stream's chunk list.
class JBAOS extends JOutputStream {
  buf = new Int8Array(32);
  count = 0;
  grow(min: number) {
    if (min <= this.buf.length) return;
    const nb = new Int8Array(Math.max(min, this.buf.length * 2));
    nb.set(this.buf.subarray(0, this.count));
    this.buf = nb;
  }
  bytes(): Uint8Array { return u8(this.buf, 0, this.count); }
}
function baosString(this: JBAOS) { return utf8.dec.decode(this.bytes()); }
rt.register({
  name: "java/io/ByteArrayOutputStream", ctor: JBAOS, sup: "java/io/OutputStream",
  fields: { buf: "buf", count: "count" },
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JBAOS, n: number) {
      if (n < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Negative initial size: " + n);
      this.buf = new Int8Array(n);
    },
    "write(I)V": function (this: JBAOS, b: number) { this.grow(this.count + 1); this.buf[this.count++] = b; },
    "write([BII)V": function (this: JBAOS, b: Int8Array, off: number, len: number) {
      if (off < 0 || len < 0 || off + len > b.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      this.grow(this.count + len);
      this.buf.set(b.subarray(off, off + len), this.count);
      this.count += len;
    },
    "writeBytes([B)V": function (this: JBAOS, b: Int8Array) { this.grow(this.count + b.length); this.buf.set(b, this.count); this.count += b.length; },
    "toByteArray()[B": function (this: JBAOS) { return this.buf.slice(0, this.count); },
    "size()I": function (this: JBAOS) { return this.count; },
    "reset()V": function (this: JBAOS) { this.count = 0; },
    "toString()Ljava/lang/String;": baosString,
    "toString(Ljava/lang/String;)Ljava/lang/String;": baosString,
    "toString(Ljava/nio/charset/Charset;)Ljava/lang/String;": baosString,
    "writeTo(Ljava/io/OutputStream;)V": async function (this: JBAOS, out: unknown) {
      await vcall(out, "write", "([BII)V", this.buf, 0, this.count);
    },
    "close()V": function () {},
  },
});

class JFOS extends JOutputStream {
  fpath = "";
  append = false;
  offset = 0;
  get pos() { return (this.append && this.chunks.length ? vfs.read(this.fpath)?.length ?? 0 : this.offset) + this.chunks.length; }
  set pos(value: number) { flushFOS(this); this.offset = value; }
}
function openWrite(this: JFOS, path: string, append = 0) {
  this.fpath = vfs.norm(path);
  this.append = !!append;
  if (!this.append || !vfs.read(this.fpath)) vfs.write(this.fpath, new Uint8Array(0));
  this.offset = this.append ? vfs.read(this.fpath)!.length : 0;
}
rt.register({
  name: "java/io/FileOutputStream", ctor: JFOS, sup: "java/io/OutputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": () => new JFileDescriptor(),
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "<init>(Ljava/io/File;)V": function (this: JFOS, f: JFile) { openWrite.call(this, f.path); },
    "<init>(Ljava/io/File;Z)V": function (this: JFOS, f: JFile, app: number) { openWrite.call(this, f.path, app); },
    "<init>(Ljava/lang/String;)V": openWrite,
    "<init>(Ljava/lang/String;Z)V": openWrite,
    "write(I)V": function (this: JFOS, b: number) { checkFileOpen(this); this.chunks.push(b & 0xff); },
    "write([BII)V": function (this: JFOS, b: Int8Array, off: number, len: number) {
      checkFileOpen(this);
      if (off < 0 || len < 0 || len > b.length - off) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      for (let i = 0; i < len; i++) this.chunks.push(b[off + i] & 0xff);
    },
    "flush()V": function (this: JFOS) { checkFileOpen(this); flushFOS(this); },
    "close()V": function (this: JFOS) { if (!closedFiles.has(this)) { flushFOS(this); closeFile(this); } },
  },
});
function flushFOS(s: JFOS) {
  if (!s.chunks.length) return;
  const old = vfs.read(s.fpath) ?? new Uint8Array(0);
  const start = s.append ? old.length : s.offset;
  const merged = new Uint8Array(Math.max(old.length, start + s.chunks.length));
  merged.set(old); merged.set(s.chunks, start);
  vfs.write(s.fpath, merged);
  s.offset = start + s.chunks.length;
  s.chunks.length = 0;
}

// RandomAccessFile: the whole file in memory with a cursor, written back as it grows. The
// vfs has no partial write, so "rw" is read-modify-write — correct, and the sizes an apk
// opens this way (a cache index, a downloaded chunk) are the sizes it already unzipped.
class JRAF extends JObj { path = ""; buf: Uint8Array = new Uint8Array(0); source: FileSource | null = null; pos = 0; write = false; }
const rafGrow = (f: JRAF, need: number) => {
  if (need <= f.buf.length) return;
  const n = new Uint8Array(need);
  n.set(f.buf);
  f.buf = n;
};
const rafOpen = function (this: JRAF, p: string, mode: string) {
  this.path = vfs.norm(p);
  this.write = mode.includes("w");
  const data = vfs.read(this.path);
  const source = data ? null : vfs.source(this.path);
  if (!data && !source && !this.write) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  if (source && this.write) throw rt.mkThrowable("java/io/IOException", "read-only file: " + p);
  this.source = this.write ? null : source;
  this.buf = data ?? new Uint8Array(0);
};
rt.register({
  name: "java/io/RandomAccessFile", ctor: JRAF, ifaces: ["java/io/Closeable", "java/io/DataInput", "java/io/DataOutput"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": rafOpen,
    "<init>(Ljava/io/File;Ljava/lang/String;)V": function (this: JRAF, f: JFile, m: string) { rafOpen.call(this, f.path, m); },
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "length()J": function (this: JRAF) { checkFileOpen(this); return BigInt(this.source?.size ?? this.buf.length); },
    "getFilePointer()J": function (this: JRAF) { checkFileOpen(this); return BigInt(this.pos); },
    "seek(J)V": function (this: JRAF, p: bigint) { checkFileOpen(this); this.pos = Number(p); },
    "skipBytes(I)I": function (this: JRAF, n: number) {
      const step = Math.max(0, Math.min(n, (this.source?.size ?? this.buf.length) - this.pos));
      this.pos += step;
      return step;
    },
    "getFD()Ljava/io/FileDescriptor;": () => new JFileDescriptor(),
    "read()I": async function (this: JRAF) {
      checkFileOpen(this);
      if (!this.source) return this.pos < this.buf.length ? this.buf[this.pos++] : -1;
      const bytes = await this.source.read(this.pos, 1);
      if (!bytes.length) return -1;
      this.pos++;
      return bytes[0];
    },
    "read([B)I": async function (this: JRAF, b: Int8Array) { return await rafRead(this, b, 0, b.length); },
    "read([BII)I": async function (this: JRAF, b: Int8Array, off: number, len: number) { return await rafRead(this, b, off, len); },
    "readFully([B)V": maySuspend(function (this: JRAF, b: Int8Array) { return rafReadFully(this, b, 0, b.length); }),
    "readFully([BII)V": function (this: JRAF, b: Int8Array, off: number, len: number) { return rafReadFully(this, b, off, len); },
    ...Object.fromEntries(([["readInt()I", 4, (v: DataView) => v.getInt32(0)], ["readLong()J", 8, (v: DataView) => v.getBigInt64(0)], ["readShort()S", 2, (v: DataView) => v.getInt16(0)],
      ["readUnsignedShort()I", 2, (v: DataView) => v.getUint16(0)], ["readByte()B", 1, (v: DataView) => v.getInt8(0)], ["readUnsignedByte()I", 1, (v: DataView) => v.getUint8(0)],
      ["readBoolean()Z", 1, (v: DataView) => v.getUint8(0) ? 1 : 0], ["readDouble()D", 8, (v: DataView) => v.getFloat64(0)], ["readFloat()F", 4, (v: DataView) => v.getFloat32(0)]] as const)
      .map(([key, n, get]) => [key, async function (this: JRAF) { const b = new Int8Array(n); await rafReadFully(this, b, 0, n); return get(new DataView(b.buffer)); }])),
    "write(I)V": function (this: JRAF, v: number) {
      checkFileOpen(this);
      rafGrow(this, this.pos + 1);
      this.buf[this.pos++] = v & 0xff;
      vfs.write(this.path, this.buf);
    },
    "write([B)V": function (this: JRAF, b: Int8Array) { rafWrite(this, b, 0, b.length); },
    "write([BII)V": function (this: JRAF, b: Int8Array, off: number, len: number) { rafWrite(this, b, off, len); },
    // DataOutput: big-endian, as the JDK writes
    "writeInt(I)V": function (this: JRAF, v: number) { rafWrite(this, new Int8Array(Int32Array.of(v).buffer).reverse(), 0, 4); },
    "writeShort(I)V": function (this: JRAF, v: number) { rafWrite(this, Int8Array.of(v >> 8, v), 0, 2); },
    "writeByte(I)V": function (this: JRAF, v: number) { rafWrite(this, Int8Array.of(v), 0, 1); },
    "writeBoolean(Z)V": function (this: JRAF, v: number) { rafWrite(this, Int8Array.of(v ? 1 : 0), 0, 1); },
    "writeLong(J)V": function (this: JRAF, v: bigint) { rafWrite(this, new Int8Array(BigInt64Array.of(v).buffer).reverse(), 0, 8); },
    "writeDouble(D)V": function (this: JRAF, v: number) { rafWrite(this, new Int8Array(Float64Array.of(v).buffer).reverse(), 0, 8); },
    "writeFloat(F)V": function (this: JRAF, v: number) { rafWrite(this, new Int8Array(Float32Array.of(v).buffer).reverse(), 0, 4); },
    "setLength(J)V": function (this: JRAF, n: bigint) {
      checkFileOpen(this);
      const len = Number(n);
      if (len <= this.buf.length) this.buf = this.buf.slice(0, len);
      else rafGrow(this, len);
      if (this.pos > len) this.pos = len;
      vfs.write(this.path, this.buf);
    },
    "close()V": function (this: JRAF) { if (!closedFiles.has(this)) { if (this.write) vfs.write(this.path, this.buf); closeFile(this); } },
  },
});
function rafRead(f: JRAF, b: Int8Array, off: number, len: number): number | Promise<number> {
  checkFileOpen(f);
  if (len === 0) return 0;
  if (f.source) {
    const value = f.source.read(f.pos, len);
    const done = (bytes: Uint8Array) => {
      if (!bytes.length) return -1;
      b.set(i8(bytes), off);
      f.pos += bytes.length;
      return bytes.length;
    };
    return value instanceof Promise ? value.then(done) : done(value);
  }
  const n = Math.min(len, f.buf.length - f.pos);
  if (n <= 0) return -1;
  b.set(f.buf.subarray(f.pos, f.pos + n) as unknown as Int8Array, off);
  f.pos += n;
  return n;
}
async function rafReadFully(f: JRAF, b: Int8Array, off: number, len: number): Promise<void> {
  let read = 0;
  while (read < len) {
    const n = await rafRead(f, b, off + read, len - read);
    if (n <= 0) throw rt.mkThrowable("java/io/EOFException", null);
    read += n;
  }
}
function rafWrite(f: JRAF, b: Int8Array, off: number, len: number) {
  checkFileOpen(f);
  rafGrow(f, f.pos + len);
  f.buf.set(u8(b, off, len), f.pos);
  f.pos += len;
  vfs.write(f.path, f.buf);
}

// serialPersistentFields is a static array a serializable class declares; nothing here
// serializes, but the <clinit> that builds the array has to be able to construct one.
class JObjectStreamField extends JObj { fname = ""; ftype: unknown = null; }
rt.register({
  name: "java/io/ObjectStreamField", ctor: JObjectStreamField, ifaces: ["java/lang/Comparable"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/Class;)V": function (this: JObjectStreamField, n: string, t: unknown) { this.fname = n; this.ftype = t; },
    "<init>(Ljava/lang/String;Ljava/lang/Class;Z)V": function (this: JObjectStreamField, n: string, t: unknown) { this.fname = n; this.ftype = t; },
    "getName()Ljava/lang/String;": function (this: JObjectStreamField) { return this.fname; },
    "getType()Ljava/lang/Class;": function (this: JObjectStreamField) { return this.ftype; },
    "toString()Ljava/lang/String;": function (this: JObjectStreamField) { return this.fname; },
  },
});

class JFilterOutputStream extends JOutputStream { out: unknown = null; }
rt.register({
  name: "java/io/FilterOutputStream", ctor: JFilterOutputStream, sup: "java/io/OutputStream",
  fields: { out: "out" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: any, o: unknown) { this.out = o; },
    "write(I)V": maySuspend(function (this: any, b: number) { return vcallMaybe(this.out, "write", "(I)V", b); }),
    "write([BII)V": maySuspend(function (this: any, b: Int8Array, o: number, l: number) { return vcallMaybe(this.out, "write", "([BII)V", b, o, l); }),
    "flush()V": maySuspend(function (this: any) { return this.out ? vcallMaybe(this.out, "flush", "()V") : undefined; }),
    "close()V": maySuspend(function (this: any) { return this.out ? vcallMaybe(this.out, "close", "()V") : undefined; }),
  },
});
// every method forwards to the wrapped stream, as the JDK's does: a Java subclass's super.read()
// reaches the stream it wrapped, whether that is one of ours or app code over a socket
class JFilterInputStream extends JInputStream { in_: unknown = null; }
const fwd = (name: string, desc: string) => maySuspend(function (this: JFilterInputStream, ...a: unknown[]) { return vcallMaybe(this.in_, name, desc, ...a); });
rt.register({
  name: "java/io/FilterInputStream", ctor: JFilterInputStream, sup: "java/io/InputStream",
  fields: { in: "in_" },
  methods: {
    "<init>(Ljava/io/InputStream;)V": function (this: JFilterInputStream, s: unknown) { this.in_ = s; },
    "read()I": fwd("read", "()I"),
    "read([BII)I": fwd("read", "([BII)I"),
    "available()I": fwd("available", "()I"),
    "skip(J)J": fwd("skip", "(J)J"),
    "close()V": fwd("close", "()V"),
    "mark(I)V": fwd("mark", "(I)V"),
    "reset()V": fwd("reset", "()V"),
    "markSupported()Z": fwd("markSupported", "()Z"),
  },
});
class JBufferedOut extends JFilterOutputStream { buf = new Int8Array(8192); count = 0; }
function drain(s: JBufferedOut) {
  if (!s.count) return;
  return after(vcallMaybe(s.out, "write", "([BII)V", s.buf, 0, s.count), () => { s.count = 0; });
}
const wrapOut = function (this: JBufferedOut, o: unknown, size = 8192) {
  if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size <= 0");
  this.out = o;
  if (size !== this.buf.length) this.buf = new Int8Array(size);
  this.count = 0;
};
rt.register({
  name: "java/io/BufferedOutputStream", ctor: JBufferedOut, sup: "java/io/FilterOutputStream",
  fields: { buf: "buf", count: "count" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": wrapOut,
    "<init>(Ljava/io/OutputStream;I)V": wrapOut,
    "write(I)V": maySuspend(function (this: JBufferedOut, b: number) {
      return after(this.count === this.buf.length ? drain(this) : undefined, () => { this.buf[this.count++] = b; });
    }),
    "write([BII)V": maySuspend(function (this: JBufferedOut, b: Int8Array, off: number, len: number) {
      if (off < 0 || len < 0 || off + len > b.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (len >= this.buf.length) {
        const t = rt.th();
        return after(drain(this), () => { rt.st(t); return vcallMaybe(this.out, "write", "([BII)V", b, off, len); });
      }
      return after(len > this.buf.length - this.count ? drain(this) : undefined, () => {
        this.buf.set(b.subarray(off, off + len), this.count);
        this.count += len;
      });
    }),
    "flush()V": maySuspend(function (this: JBufferedOut) {
      const t = rt.th();
      return after(drain(this), () => { rt.st(t); return vcallMaybe(this.out, "flush", "()V"); });
    }),
    "close()V": async function (this: JBufferedOut) {
      const t = rt.th();
      try { await vcall(this, "flush", "()V"); } finally { rt.st(t); await vcall(this.out, "close", "()V"); }
    },
  },
});

// ── print/println overloads shared by PrintStream and PrintWriter: each argument type → its
// Java string form, then one sink per class takes (text, newline?)
const PRINT_ARGS: [string, (v: any) => string | Promise<string>][] = [
  ["Ljava/lang/String;", (s: string | null) => s ?? "null"],
  ["Ljava/lang/Object;", async (o: unknown) => (o === null ? "null" : String(await vcall(o, "toString", "()Ljava/lang/String;")))],
  ["I", String], ["J", String], ["D", String], ["F", String],
  ["Z", (v: number) => (v ? "true" : "false")],
  ["C", (v: number) => String.fromCharCode(v)],
  ["[C", (v: Uint16Array) => chars(v)],
];
function printMethods<T>(sink: (self: T, s: string, ln: boolean) => unknown, self: string): NativeSpec["methods"] {
  const m: NativeSpec["methods"] = { "println()V": function (this: T) { return sink(this, "", true); } };
  for (const [desc, str] of PRINT_ARGS) {
    m[`print(${desc})V`] = async function (this: T, v: unknown) { return sink(this, await str(v), false); };
    m[`println(${desc})V`] = async function (this: T, v: unknown) { return sink(this, await str(v), true); };
  }
  // printf/format are String.format into the same sink, and both return the stream
  const fmt = async function (this: T, f: string, a: unknown[]) { await sink(this, javaFormat(f, a), false); return this; };
  const fmtL = async function (this: T, _l: unknown, f: string, a: unknown[]) { await sink(this, javaFormat(f, a), false); return this; };
  for (const name of ["printf", "format"]) {
    m[`${name}(Ljava/lang/String;[Ljava/lang/Object;)L${self};`] = fmt;
    m[`${name}(Ljava/util/Locale;Ljava/lang/String;[Ljava/lang/Object;)L${self};`] = fmtL;
  }
  return m;
}

// ── PrintStream; the unwrapped System streams feed the console.
class JPrintStream extends JOutputStream {
  out: unknown = null; auto = false; closed = false; trouble = false;
  line = ""; err = false; decoder = new TextDecoder();
}
async function pr(ps: JPrintStream, s: string, ln: boolean) {
  if (ps.closed) { ps.trouble = true; return; }
  if (ps.out !== null) {
    const bytes = utf8.enc.encode(ln ? s + "\n" : s);
    await vcall(ps, "write", "([BII)V", new Int8Array(bytes.buffer), 0, bytes.length);
    return;
  }
  ps.line += s + (ln ? "\n" : "");
  let end: number;
  while ((end = ps.line.indexOf("\n")) >= 0) {
    (ps.err ? console.error : console.log)("[java]", ps.line.slice(0, end));
    ps.line = ps.line.slice(end + 1);
  }
}
async function printCall(p: JPrintStream, name: string, desc: string, ...args: unknown[]) {
  if (p.closed) { p.trouble = true; return; }
  try { await vcall(p.out, name, desc, ...args); }
  catch (e) { if (!(e instanceof rt.link("java/io/IOException").ctor)) throw e; p.trouble = true; }
}
const initPrint = function (this: JPrintStream, out: unknown, auto = 0) {
  if (out == null) throw rt.mkThrowable("java/lang/NullPointerException", "Null output stream");
  this.out = out; this.auto = !!auto;
};
rt.register({
  name: "java/io/PrintStream", ctor: JPrintStream, sup: "java/io/FilterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": initPrint,
    "<init>(Ljava/io/OutputStream;Z)V": initPrint,
    ...printMethods(pr, "java/io/PrintStream"),
    "flush()V": function (this: JPrintStream) { return this.out !== null ? printCall(this, "flush", "()V") : this.line ? pr(this, "", true) : undefined; },
    "close()V": async function (this: JPrintStream) {
      if (this.closed) return;
      await vcall(this, "flush", "()V");
      if (this.out !== null) await printCall(this, "close", "()V");
      this.closed = true;
    },
    "checkError()Z": async function (this: JPrintStream) {
      if (!this.closed) await vcall(this, "flush", "()V");
      return this.trouble || this.out instanceof JPrintStream && await vcall(this.out, "checkError", "()Z") ? 1 : 0;
    },
    "write(I)V": async function (this: JPrintStream, b: number) {
      if (this.out === null) { await pr(this, this.decoder.decode(Uint8Array.of(b), { stream: true }), false); return; }
      await printCall(this, "write", "(I)V", b);
      if (this.auto && (b & 255) === 10) await vcall(this, "flush", "()V");
    },
    "write([BII)V": async function (this: JPrintStream, bytes: Int8Array, off: number, len: number) {
      if (this.out === null) { await pr(this, this.decoder.decode(bytes.subarray(off, off + len), { stream: true }), false); return; }
      await printCall(this, "write", "([BII)V", bytes, off, len);
      if (this.auto) await vcall(this, "flush", "()V");
    },
  },
});
{
  const sysInfo = rt.link("java/lang/System");
  const out = new JPrintStream();
  const err = new JPrintStream(); err.err = true;
  sysInfo.ctor[mangleStaticField("out")] = out;
  sysInfo.ctor[mangleStaticField("err")] = err;
}

rt.markers("java/lang/Readable");
class JReader extends JObj {
  s = ""; pos = 0;
  /** the stream or reader still to be decoded into `s`; null once the text is complete */
  src: unknown = null;
  srcChars = false;   // src reads chars (a Reader) rather than bytes (an InputStream)
  dec: TextDecoder | null = null;
}
const READ_CHUNK = 8192;
/**
 * One chunk out of the wrapped source, through its VIRTUAL read: an app's own InputStream or
 * Reader is bytecode, and reading the native class's byte buffer off it finds an empty one.
 */
function fill(r: JReader): void | Promise<void> {
  const src = r.src;
  if (!src) return;
  if (r.pos > 0) { r.s = r.s.slice(r.pos); r.pos = 0; }
  if (r.srcChars) {
    const out = new Uint16Array(READ_CHUNK);
    return after(vcall(src, "read", "([CII)I", out, 0, READ_CHUNK), (n: number) => {
      if (n > 0) r.s += charsToString(out, 0, n); else if (n < 0) r.src = null;
    });
  }
  const out = new Int8Array(READ_CHUNK);
  return after(vcall(src, "read", "([BII)I", out, 0, READ_CHUNK), (n: number) => {
    const dec = (r.dec ??= new TextDecoder());
    if (n > 0) r.s += dec.decode(new Uint8Array(out.buffer, 0, n), { stream: true });
    else if (n < 0) { r.s += dec.decode(); r.src = null; }
  });
}
/** decode until a character is available or the source ends */
function need(r: JReader): void | Promise<void> {
  while (r.pos >= r.s.length && r.src) {
    const p = fill(r);
    if (p) return p.then(() => need(r));
  }
}
// Every Reader here is the same model — a decoded string and a cursor — so the whole read
// surface lives on the base and the subclasses inherit it instead of each re-declaring read().
rt.register({
  name: "java/io/Reader", ctor: JReader, ifaces: ["java/io/Closeable", "java/lang/Readable"],
  methods: {
    "<init>()V": function () {},
    "close()V": function (this: JReader) { this.src = null; },
    "read()I": maySuspend(function (this: JReader) {
      return after(need(this), () => (this.pos < this.s.length ? this.s.charCodeAt(this.pos++) : -1));
    }),
    "read([CII)I": maySuspend(function (this: JReader, out: Uint16Array, off: number, len: number) {
      if (len === 0) return 0;
      return after(need(this), () => {
        if (this.pos >= this.s.length) return -1;
        const n = Math.min(len, this.s.length - this.pos);
        for (let i = 0; i < n; i++) out[off + i] = this.s.charCodeAt(this.pos + i);
        this.pos += n;
        return n;
      });
    }),
    "read([C)I": maySuspend(function (this: JReader, out: Uint16Array) {
      return vcall(this, "read", "([CII)I", out, 0, out.length);
    }),
    "ready()Z": function (this: JReader) { return this.pos < this.s.length ? 1 : 0; },
    "skip(J)J": maySuspend(function (this: JReader, n: bigint) {
      let left = Number(n), skipped = 0;
      const step = (): number | Promise<number> => {
        const k = Math.min(left, this.s.length - this.pos);
        this.pos += k; left -= k; skipped += k;
        return left > 0 && this.src ? after(fill(this), step) : skipped;
      };
      return after(step(), BigInt);
    }),
    "markSupported()Z": () => 0,
  },
});
rt.register({
  name: "java/io/StringReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JReader, s: string) { this.s = s; },
  },
});
// UTF-8 whatever charset was asked for
const decodeStream = function (this: JReader, s: unknown) { this.src = s; };
rt.register({
  name: "java/io/InputStreamReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/InputStream;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/lang/String;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V": decodeStream,
  },
});
// FileReader is an InputStreamReader over a file: the file's bytes, decoded, in one go —
// the same shape openRead gives FileInputStream.
const openReader = function (this: JReader, p: string) {
  const d = vfs.read(p);
  if (!d) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  this.s = utf8.dec.decode(d);
};
rt.register({
  name: "java/io/FileReader", ctor: class extends JReader {}, sup: "java/io/InputStreamReader",
  methods: {
    "<init>(Ljava/lang/String;)V": openReader,
    "<init>(Ljava/io/File;)V": function (this: JReader, f: JFile) { openReader.call(this, f.path); },
  },
});
/** A buffering Reader over another Reader, which may be the app's own subclass. */
const wrapReader = function (this: JReader, r: JReader) { this.src = r; this.srcChars = true; };
rt.register({
  name: "java/io/BufferedReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/Reader;)V": wrapReader,
    "<init>(Ljava/io/Reader;I)V": wrapReader,
    "readLine()Ljava/lang/String;": maySuspend(function (this: JReader) {
      const step = (): string | null | Promise<string | null> => {
        const i = this.s.indexOf("\n", this.pos);
        if (i < 0 && this.src) return after(fill(this), step);
        if (this.pos >= this.s.length) return null;
        const line = i < 0 ? this.s.slice(this.pos) : this.s.slice(this.pos, i);
        this.pos = i < 0 ? this.s.length : i + 1;
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      };
      return step();
    }),
  },
});
class JWriter extends JObj { s = ""; }
/** every Writer overload funnels through the VIRTUAL write(String) so subclasses intercept */
const wr = (w: unknown, s: string) => vcallMaybe(w, "write", "(Ljava/lang/String;)V", s);
const chars = (c: Uint16Array): string => charsToString(c, 0, c.length);
rt.register({
  name: "java/io/Writer", ctor: JWriter,
  ifaces: ["java/io/Closeable", "java/io/Flushable", "java/lang/Appendable"],
  methods: {
    "<init>()V": function () {},
    "write(Ljava/lang/String;)V": function (this: JWriter, s: string) { this.s += s; },
    // Appendable: the base class routes through write(String), which a subclass overrides
    "append(Ljava/lang/CharSequence;)Ljava/io/Writer;": async function (this: JWriter, cs: unknown) { await vcall(this, "write", "(Ljava/lang/String;)V", String(cs ?? "null")); return this; },
    "append(Ljava/lang/CharSequence;II)Ljava/io/Writer;": async function (this: JWriter, cs: unknown, a: number, b: number) { await vcall(this, "write", "(Ljava/lang/String;)V", String(cs ?? "null").slice(a, b)); return this; },
    "append(C)Ljava/io/Writer;": async function (this: JWriter, c: number) { await vcall(this, "write", "(Ljava/lang/String;)V", String.fromCharCode(c)); return this; },
    "write(Ljava/lang/String;II)V": maySuspend(function (this: JWriter, s: string, off: number, len: number) { return wr(this, s.substr(off, len)); }),
    "write(I)V": maySuspend(function (this: JWriter, c: number) { return wr(this, String.fromCharCode(c & 0xffff)); }),
    "write([C)V": maySuspend(function (this: JWriter, c: Uint16Array) { return wr(this, chars(c)); }),
    "write([CII)V": maySuspend(function (this: JWriter, c: Uint16Array, off: number, len: number) { return wr(this, chars(c.subarray(off, off + len))); }),
    "append(C)Ljava/lang/Appendable;": maySuspend(function (this: JWriter, c: number) { return after(wr(this, String.fromCharCode(c & 0xffff)), () => this); }),
    "append(Ljava/lang/CharSequence;)Ljava/lang/Appendable;": async function (this: JWriter, cs: unknown) {
      await wr(this, cs === null ? "null" : String(await vcall(cs, "toString", "()Ljava/lang/String;")));
      return this;
    },
    "flush()V": function () {}, "close()V": function () {},
  },
});
rt.register({
  name: "java/io/StringWriter", ctor: class extends JWriter {}, sup: "java/io/Writer",
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "toString()Ljava/lang/String;": function (this: JWriter) { return this.s; },
    "getBuffer()Ljava/lang/StringBuffer;": function (this: JWriter) {
      const info = rt.link("java/lang/StringBuffer");
      const sb = new info.ctor();
      sb.s = this.s;
      return sb;
    },
  },
});
rt.register({
  name: "java/io/BufferedWriter", ctor: class extends JWriter { target: JWriter | null = null; }, sup: "java/io/Writer",
  methods: {
    "<init>(Ljava/io/Writer;)V": function (this: any, w: JWriter) { this.target = w; },
    "write(Ljava/lang/String;)V": maySuspend(function (this: any, str: string) { return wr(this.target, str); }),
    "newLine()V": maySuspend(function (this: any) { return wr(this.target, "\n"); }),
    "flush()V": maySuspend(function (this: any) { return vcallMaybe(this.target, "flush", "()V"); }),
    "close()V": maySuspend(function (this: any) { return vcallMaybe(this.target, "close", "()V"); }),
  },
});
// PrintWriter: every print/println overload funnels through the virtual write(String),
// which forwards to the wrapped Writer. Wrapping an OutputStream goes through a real
// OutputStreamWriter so the bytes actually reach the stream.
class JPrintWriter extends JWriter { target: unknown = null; auto = false; }
const pw = async (p: JPrintWriter, s: string, ln: boolean) => {
  await vcall(p, "write", "(Ljava/lang/String;)V", ln ? s + "\n" : s);
  if (ln && p.auto) await vcall(p, "flush", "()V");
};
const mkOSW = async (o: unknown) => {
  const w = rt.make("java/io/OutputStreamWriter");
  await vcall(w, "<init>", "(Ljava/io/OutputStream;)V", o);
  return w;
};
rt.register({
  name: "java/io/PrintWriter", ctor: JPrintWriter, sup: "java/io/Writer",
  methods: {
    "<init>(Ljava/io/Writer;)V": function (this: JPrintWriter, w: unknown) { this.target = w; },
    "<init>(Ljava/io/Writer;Z)V": function (this: JPrintWriter, w: unknown, a: number) { this.target = w; this.auto = !!a; },
    "<init>(Ljava/io/OutputStream;)V": async function (this: JPrintWriter, o: unknown) { this.target = await mkOSW(o); },
    "<init>(Ljava/io/OutputStream;Z)V": async function (this: JPrintWriter, o: unknown, a: number) { this.target = await mkOSW(o); this.auto = !!a; },
    "write(Ljava/lang/String;)V": maySuspend(function (this: JPrintWriter, s: string) {
      if (this.target === null) { this.s += s; return; }
      return vcall(this.target, "write", "(Ljava/lang/String;)V", s);
    }),
    ...printMethods(pw, "java/io/PrintWriter"),
    "flush()V": function (this: JPrintWriter) { return this.target === null ? undefined : vcall(this.target, "flush", "()V"); },
    "close()V": function (this: JPrintWriter) { return this.target === null ? undefined : vcall(this.target, "close", "()V"); },
    "checkError()Z": function () { return 0; },
  },
});

// OutputStreamWriter: chars → bytes into the wrapped stream (UTF-8 only)
class JOSW extends JWriter { sink: unknown = null; }
rt.register({
  name: "java/io/OutputStreamWriter", ctor: JOSW, sup: "java/io/Writer",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "<init>(Ljava/io/OutputStream;Ljava/nio/charset/Charset;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "<init>(Ljava/io/OutputStream;Ljava/lang/String;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "write(Ljava/lang/String;)V": function (this: JOSW, str: string) { this.s += str; },
    "flush()V": async function (this: JOSW) {
      if (this.s && this.sink) {
        const b = utf8.enc.encode(this.s);
        await vcall(this.sink, "write", "([BII)V", new Int8Array(b.buffer, 0, b.length), 0, b.length);
        this.s = "";
      }
      if (this.sink) await vcall(this.sink, "flush", "()V");
    },
    "close()V": async function (this: JOSW) {
      await vcall(this, "flush", "()V");
      if (this.sink) await vcall(this.sink, "close", "()V");
    },
  },
});

const openWriter = async function (this: JOSW, f: JFile | string, append = 0) {
  this.sink = await newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", typeof f === "string" ? f : f.path, append);
};
rt.register({
  name: "java/io/FileWriter", ctor: class extends JOSW {}, sup: "java/io/OutputStreamWriter",
  methods: {
    "<init>(Ljava/lang/String;)V": openWriter,
    "<init>(Ljava/lang/String;Z)V": openWriter,
    "<init>(Ljava/io/File;)V": openWriter,
    "<init>(Ljava/io/File;Z)V": openWriter,
  },
});

class JDataOut extends JOutputStream { sink: JOutputStream | null = null; }
rt.register({
  name: "java/io/DataOutputStream", ctor: JDataOut, sup: "java/io/OutputStream",
  ifaces: ["java/io/DataOutput"],
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: JDataOut, s: JOutputStream) { this.sink = s; },
    "write(I)V": function (this: JDataOut, b: number) { this.sink?.chunks.push(b & 0xff); },
    "write([BII)V": function (this: JDataOut, b: Int8Array, off: number, len: number) {
      for (let i = 0; i < len; i++) this.sink?.chunks.push(b[off + i] & 0xff);
    },
    "writeInt(I)V": function (this: JDataOut, v: number) {
      this.sink?.chunks.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    },
    "writeLong(J)V": function (this: JDataOut, v: bigint) {
      for (let i = 7n; i >= 0n; i--) this.sink?.chunks.push(Number((v >> (i * 8n)) & 0xffn));
    },
    "writeByte(I)V": function (this: JDataOut, v: number) { this.sink?.chunks.push(v & 0xff); },
    "writeShort(I)V": function (this: JDataOut, v: number) { this.sink?.chunks.push((v >>> 8) & 0xff, v & 0xff); },
    "writeBoolean(Z)V": function (this: JDataOut, v: number) { this.sink?.chunks.push(v ? 1 : 0); },
    "writeUTF(Ljava/lang/String;)V": function (this: JDataOut, s: string) {
      const b = utf8.enc.encode(s);
      const sink = this.sink;
      if (!sink) return;
      sink.chunks.push((b.length >>> 8) & 0xff, b.length & 0xff);
      for (const x of b) sink.chunks.push(x); // not a spread: a long string would blow the argument limit
    },
    "flush()V": function () {},
    "close()V": function () {},
    "size()I": function (this: JDataOut) { return this.sink?.chunks.length ?? 0; },
  },
});

// File locks remain advisory; byte mappings retain the opened stream's storage.
const fileLock = () => rt.make("java/nio/channels/FileLock");
class JFileChannel extends JObj {
  file!: JInputStream | JRAF | JFOS;
  open = true;
  opened() {
    if (!this.open || closedFiles.has(this.file)) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
    return this.file;
  }
  readable(): JInputStream | JRAF {
    this.opened();
    if (this.file instanceof JInputStream || this.file instanceof JRAF) return this.file;
    throw rt.mkThrowable("java/nio/channels/NonReadableChannelException", null);
  }
}
const fileChannels = new WeakMap<JObj, JFileChannel>();
const closedFiles = new WeakSet<JObj>();
function closeFile(file: JObj) {
  closedFiles.add(file);
  const channel = fileChannels.get(file);
  if (channel) channel.open = false;
}
function checkFileOpen(file: JObj) {
  if (closedFiles.has(file)) throw rt.mkThrowable("java/io/IOException", "Stream closed");
}
function fileChannel(this: JInputStream | JRAF | JFOS): JFileChannel {
  let channel = fileChannels.get(this);
  if (!channel) {
    rt.link("java/nio/channels/FileChannel");
    channel = new JFileChannel(); channel.file = this; channel.open = !closedFiles.has(this); fileChannels.set(this, channel);
  }
  return channel;
}
rt.register({
  name: "java/nio/channels/FileChannel", ctor: JFileChannel,
  methods: {
    "close()V": maySuspend(function (this: JFileChannel) { if (this.open) { this.open = false; return vcallMaybe(this.file, "close", "()V"); } }),
    "isOpen()Z": function (this: JFileChannel) { return +this.open; },
    "size()J": function (this: JFileChannel) {
      const file = this.opened();
      return BigInt(file instanceof JFOS
        ? Math.max(vfs.read(file.fpath)?.length ?? 0, file.chunks.length ? file.pos : 0)
        : file.source?.size ?? file.buf.length);
    },
    "position()J": function (this: JFileChannel) { return BigInt(this.opened().pos); },
    "position(J)Ljava/nio/channels/FileChannel;": function (this: JFileChannel, position: bigint) {
      if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position");
      this.opened().pos = Number(position); return this;
    },
    "map(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;": maySuspend(function (this: JFileChannel, mode: JSimpleEnum | null, position: bigint, size: bigint) {
      const file = this.readable();
      if (!mode) return rt.npe();
      if (position < 0n || size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position/size");
      if (mode.ename !== "READ_ONLY") throw rt.unimplemented("FileChannel writable mappings");
      if (position + size > BigInt(file.source?.size ?? file.buf.length)) throw rt.mkThrowable("java/io/IOException", "mapping exceeds file size");
      const start = Number(position), length = Number(size);
      return file.source ? readFully(file.source, start, length).then(mappedReadOnlyBuffer) : mappedReadOnlyBuffer(file.buf.subarray(start, start + length));
    }),
    "force(Z)V": () => {},
    "tryLock()Ljava/nio/channels/FileLock;": fileLock,
    "tryLock(JJZ)Ljava/nio/channels/FileLock;": fileLock,
    "lock(JJZ)Ljava/nio/channels/FileLock;": fileLock,
    "lock()Ljava/nio/channels/FileLock;": fileLock,
  },
});
rt.register({
  name: "java/nio/channels/FileLock", ctor: class extends JObj {},
  methods: { "release()V": () => {}, "close()V": () => {}, "isValid()Z": () => 1 },
});

mkEnumSet("java/nio/channels/FileChannel$MapMode", ["READ_ONLY", "READ_WRITE", "PRIVATE"]);
defineException("java/nio/channels/ClosedChannelException", "java/io/IOException");
defineException("java/nio/channels/NonReadableChannelException", "java/lang/IllegalStateException");

// ── java.nio.file minimal (datastore atomic-write path)
class JNioPath extends JObj { p = ""; }
const mkPath = (p: string) => { const q = new JNioPath(); q.p = p; return q; };
rt.register({
  name: "java/nio/file/Path", ctor: JNioPath, ifaces: ["java/lang/Comparable", "java/lang/Iterable"],
  methods: {
    "toString()Ljava/lang/String;": function (this: JNioPath) { return this.p; },
    "toFile()Ljava/io/File;": function (this: JNioPath) { return mkFile(this.p); },
    "getParent()Ljava/nio/file/Path;": function (this: JNioPath) {
      const i = this.p.lastIndexOf("/");
      return i <= 0 ? null : mkPath(this.p.slice(0, i));
    },
    "resolve(Ljava/lang/String;)Ljava/nio/file/Path;": function (this: JNioPath, n: string) { return mkPath(vfs.norm(this.p + "/" + n)); },
    "getFileName()Ljava/nio/file/Path;": function (this: JNioPath) { return mkPath(this.p.split("/").pop() ?? ""); },
  },
});
rt.markers("java/nio/file/CopyOption");
rt.register({
  name: "java/nio/file/Paths", ctor: class extends JObj {},
  methods: {
    "static get(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;": (first: string, more: string[] | null) =>
      mkPath(vfs.norm([first, ...(more ?? [])].join("/"))),
  },
});
{
  const opt = (n: string) => { const o = new JObj(); (o as unknown as { ename: string }).ename = n; return o; };
  rt.register({
    name: "java/nio/file/StandardCopyOption", ctor: class extends JObj {}, sup: "java/lang/Enum",
    statics: { REPLACE_EXISTING: opt("REPLACE_EXISTING"), ATOMIC_MOVE: opt("ATOMIC_MOVE"), COPY_ATTRIBUTES: opt("COPY_ATTRIBUTES") },
  });
}
rt.register({
  name: "java/nio/file/Files", ctor: class extends JObj {},
  methods: {
    "static exists(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.exists(p.p) ? 1 : 0),
    "static move(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;": (src: JNioPath, dst: JNioPath) => {
      const data = vfs.read(src.p);
      if (data) { vfs.write(dst.p, data); vfs.delete(src.p); }
      return dst;
    },
    "static copy(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;": (src: JNioPath, dst: JNioPath) => {
      const data = vfs.read(src.p);
      if (data) vfs.write(dst.p, data.slice());
      return dst;
    },
    "static delete(Ljava/nio/file/Path;)V": (p: JNioPath) => { vfs.delete(p.p); },
    "static deleteIfExists(Ljava/nio/file/Path;)Z": (p: JNioPath) => (vfs.delete(p.p) ? 1 : 0),
    "static createDirectories(Ljava/nio/file/Path;[Ljava/nio/file/attribute/FileAttribute;)Ljava/nio/file/Path;": (p: JNioPath) => { vfs.mkdir(p.p); return p; },
    "static size(Ljava/nio/file/Path;)J": (p: JNioPath) => BigInt(vfs.stat(p.p)?.size ?? 0),
    "static readAttributes(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;": (p: JNioPath) => {
      const a = new JBasicAttrs();
      a.sz = vfs.stat(p.p)?.size ?? 0;
      a.dir = vfs.isDir(p.p);
      return a;
    },
    "static isDirectory(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.isDir(p.p) ? 1 : 0),
    "static isRegularFile(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.stat(p.p) ? 1 : 0),
    "static readAllBytes(Ljava/nio/file/Path;)[B": async (p: JNioPath) => {
      const bytes = await vfs.readFile(p.p) ?? new Uint8Array(0);
      return new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    },
  },
});

class JFileTime extends JObj { ms = 0n; }
rt.register({
  name: "java/nio/file/attribute/FileTime", ctor: JFileTime,
  methods: {
    "toMillis()J": function (this: JFileTime) { return this.ms; },
    "static fromMillis(J)Ljava/nio/file/attribute/FileTime;": (ms: bigint) => { const t = new JFileTime(); t.ms = ms; return t; },
  },
});
rt.markers("java/nio/file/attribute/BasicFileAttributes");
class JBasicAttrs extends JObj { sz = 0; dir = false; }
rt.register({
  name: "webdroid/BasicAttrs", ctor: JBasicAttrs, ifaces: ["java/nio/file/attribute/BasicFileAttributes"],
  methods: {
    "size()J": function (this: JBasicAttrs) { return BigInt(this.sz); },
    "isDirectory()Z": function (this: JBasicAttrs) { return this.dir ? 1 : 0; },
    "isRegularFile()Z": function (this: JBasicAttrs) { return this.dir ? 0 : 1; },
    "isSymbolicLink()Z": () => 0,
    "isOther()Z": () => 0,
    "creationTime()Ljava/nio/file/attribute/FileTime;": () => new JFileTime(),
    "lastModifiedTime()Ljava/nio/file/attribute/FileTime;": () => new JFileTime(),
    "lastAccessTime()Ljava/nio/file/attribute/FileTime;": () => new JFileTime(),
    "fileKey()Ljava/lang/Object;": () => null,
  },
});
rt.register({ name: "java/nio/file/LinkOption", ctor: class extends JObj {}, sup: "java/lang/Enum",
  statics: { NOFOLLOW_LINKS: new JObj() } });

// ── java.util.Scanner: tokens and lines over a source read whole up front (a stream, a string, a file)
class JScanner extends JObj { text = ""; pos = 0; delim = /\s+/y; }
function skipDelim(s: JScanner): void { s.delim.lastIndex = s.pos; const m = s.delim.exec(s.text); if (m && m.index === s.pos) s.pos += m[0].length; }
function peekToken(s: JScanner): string | null {
  skipDelim(s);
  if (s.pos >= s.text.length) return null;
  s.delim.lastIndex = s.pos;
  const re = new RegExp(s.delim.source, "g"); re.lastIndex = s.pos;
  const m = re.exec(s.text);
  return s.text.slice(s.pos, m ? m.index : s.text.length);
}
function nextToken(s: JScanner): string {
  const t = peekToken(s);
  if (t === null) throw rt.mkThrowable("java/util/NoSuchElementException", null);
  s.pos += t.length;
  return t;
}
const scanStream = async function (this: JScanner, s: unknown) { this.text = utf8.dec.decode(await readStreamFully(s)); };
rt.register({
  name: "java/util/Scanner", ctor: JScanner, ifaces: ["java/util/Iterator", "java/io/Closeable"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": scanStream,
    "<init>(Ljava/io/InputStream;Ljava/lang/String;)V": scanStream,
    "<init>(Ljava/lang/String;)V": function (this: JScanner, s: string) { this.text = s; },
    "<init>(Ljava/io/File;)V": function (this: JScanner, f: JFile) {
      const b = vfs.read(f.path);
      if (!b) throw rt.mkThrowable("java/io/FileNotFoundException", f.path);
      this.text = utf8.dec.decode(b);
    },
    "useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;": function (this: JScanner, p: string) { this.delim = new RegExp(p, "y"); return this; },
    "hasNext()Z": function (this: JScanner) { return peekToken(this) !== null ? 1 : 0; },
    "next()Ljava/lang/String;": function (this: JScanner) { return nextToken(this); },
    "next()Ljava/lang/Object;": function (this: JScanner) { return nextToken(this); },
    "hasNextInt()Z": function (this: JScanner) { const t = peekToken(this); return t !== null && /^[+-]?\d+$/.test(t) ? 1 : 0; },
    "nextInt()I": function (this: JScanner) { const t = nextToken(this); if (!/^[+-]?\d+$/.test(t)) throw rt.mkThrowable("java/util/InputMismatchException", t); return Number(t) | 0; },
    "nextLong()J": function (this: JScanner) { const t = nextToken(this); if (!/^[+-]?\d+$/.test(t)) throw rt.mkThrowable("java/util/InputMismatchException", t); return BigInt(t); },
    "nextDouble()D": function (this: JScanner) { const t = nextToken(this); const v = Number(t); if (Number.isNaN(v)) throw rt.mkThrowable("java/util/InputMismatchException", t); return v; },
    "hasNextLine()Z": function (this: JScanner) { return this.pos < this.text.length ? 1 : 0; },
    "nextLine()Ljava/lang/String;": function (this: JScanner) {
      if (this.pos >= this.text.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
      const i = this.text.indexOf("\n", this.pos);
      const line = i < 0 ? this.text.slice(this.pos) : this.text.slice(this.pos, i);
      this.pos = i < 0 ? this.text.length : i + 1;
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    },
    "close()V": () => {},
  },
});
