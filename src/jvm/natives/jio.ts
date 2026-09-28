// java.io.* natives and the VFS shared with native file descriptors.

import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { mangleStaticField, mangleMethod, charsToString, jarray, utf8, concat, i8, u8, decodeModifiedUtf8 } from "../abi";
import { charsetName, encodeModifiedUtf8, encodeString, streamDecoder, type StreamDecoder } from "../charset";
import { vcall, vcallOn, curThread, after, stringHash, stringCompare, mkEnumSet, javaFormat, newObj, defineException, type JSimpleEnum } from "./jlang";
import { csText } from "./jchars";
import { readFully, writable, type FileSource } from "../../shell/lazyfile";
import { vfs, EMPTY, type VfsFile } from "../../shell/vfs";
import { mappedBuffer, mappedReadOnlyBuffer, mkByteBuffer, type JBuffer, type JCharsetDecoder } from "./jnio";
import { renamePath, javaOpenFd, javaCloseFd, javaSeekFd, javaFdSource, javaReadFd, javaAvailableFd } from "../../native/stdio";

rt.register({ name: "java/io/Externalizable", ctor: class extends JObj {}, ifaces: ["java/io/Serializable"] });


export class JFile extends JObj {
  /** the absolute path the VFS reads */
  path = "";
  /** a relative path as Java reports it; it resolves against user.dir, "/" */
  rel: string | null = null;
  get javaPath(): string { return this.rel ?? this.path; }
}
/** java.io.File's normalization: repeated and trailing separators go, a relative path stays relative */
function initFile(f: JFile, p: string | null): void {
  if (p === null) return rt.npe();
  let j = p.replace(/\/+/g, "/");
  if (j.length > 1 && j.endsWith("/")) j = j.slice(0, -1);
  f.path = vfs.norm(j);
  f.rel = j.startsWith("/") ? null : j;
}
function compareFile(this: JFile, other: unknown): number {
  if (other === null) throw rt.mkThrowable("java/lang/NullPointerException", "pathname");
  if (!(other instanceof JFile)) throw rt.mkThrowable("java/lang/ClassCastException", "Not a File");
  return stringCompare(this.javaPath, other.javaPath);
}
export function mkFile(path: string): JFile { const f = new JFile(); f.path = vfs.norm(path); return f; }
/** `new File(p)`: File's own methods return a plain File, whatever the receiver's class */
function fileOf(p: string): JFile { const f = new JFile(); initFile(f, p); return f; }
const childOf = (d: JFile, name: string) => fileOf(d.javaPath + "/" + name);
const listFiles = (d: JFile) => jarray(vfs.list(d.path).map((n) => childOf(d, n)), "Ljava/io/File;");
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
function filePath(this: JFile) { return this.javaPath; }
function absolutePath(this: JFile) { return this.path; }
/** File.getParent: the path before its last separator, the root for a top-level absolute path */
function parentOf(f: JFile): string | null {
  const p = f.javaPath, i = p.lastIndexOf("/"), prefix = f.rel === null ? 1 : 0;
  if (i >= prefix) return p.slice(0, i);
  return prefix && p.length > prefix ? "/" : null;
}
function absoluteFile(this: JFile) { return this.rel === null ? this : mkFile(this.path); }
function makeDirs(this: JFile) { vfs.mkdir(this.path); return 1; }
const markUnsupported = (): never => { throw rt.mkThrowable("java/io/IOException", "mark/reset not supported"); };
/** the mark/reset trio of a stream that cannot rewind */
export const noMark = { "markSupported()Z": () => 0, "mark(I)V": () => {}, "reset()V": markUnsupported };
rt.register({
  name: "java/io/File", ctor: JFile,
  ifaces: ["java/io/Serializable", "java/lang/Comparable"],
  statics: { separator: "/", separatorChar: 47, pathSeparator: ":" },
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JFile, p: string | null) { initFile(this, p); },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JFile, d: string | null, n: string | null) {
      if (n === null) return rt.npe();
      initFile(this, d === null ? n : d + "/" + n);
    },
    "<init>(Ljava/io/File;Ljava/lang/String;)V": function (this: JFile, d: JFile | null, n: string | null) {
      if (n === null) return rt.npe();
      initFile(this, d === null ? n : d.javaPath + "/" + n);
    },
    "getPath()Ljava/lang/String;": filePath,
    "getAbsolutePath()Ljava/lang/String;": absolutePath,
    "getCanonicalPath()Ljava/lang/String;": absolutePath,
    "isAbsolute()Z": function (this: JFile) { return +(this.rel === null); },
    "toURI()Ljava/net/URI;": function (this: JFile) {
      let path = this.path.startsWith("/") ? this.path : "/" + this.path;
      if (vfs.isDir(this.path) && !path.endsWith("/")) path += "/";
      if (path.startsWith("//")) path = "//" + path;
      return newObj("java/net/URI", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V", "file", null, path, null);
    },
    "getName()Ljava/lang/String;": function (this: JFile) { return this.javaPath.slice(this.javaPath.lastIndexOf("/") + 1); },
    "isHidden()Z": function (this: JFile) { return this.path.slice(this.path.lastIndexOf("/") + 1).startsWith(".") ? 1 : 0; },
    "getParent()Ljava/lang/String;": function (this: JFile) { return parentOf(this); },
    "getParentFile()Ljava/io/File;": function (this: JFile) {
      const parent = parentOf(this);
      return parent === null ? null : fileOf(parent);
    },
    "getAbsoluteFile()Ljava/io/File;": absoluteFile,
    "getCanonicalFile()Ljava/io/File;": absoluteFile,
    "exists()Z": function (this: JFile) { return vfs.exists(this.path) ? 1 : 0; },
    "isDirectory()Z": function (this: JFile) { return vfs.isDir(this.path) ? 1 : 0; },
    "isFile()Z": function (this: JFile) { return vfs.stat(this.path) ? 1 : 0; },
    "length()J": function (this: JFile) { return BigInt(vfs.stat(this.path)?.size ?? 0); },
    "lastModified()J": function () { return BigInt(Date.now()); },
    "setLastModified(J)Z": () => 1,
    "mkdir()Z": makeDirs,
    "mkdirs()Z": makeDirs,
    "createNewFile()Z": function (this: JFile) {
      if (vfs.exists(this.path)) return 0;
      vfs.write(this.path, new Uint8Array(0));
      return 1;
    },
    "static createTempFile(Ljava/lang/String;Ljava/lang/String;)Ljava/io/File;": (p: string, s: string | null) => createTempFile(p, s, null),
    "static createTempFile(Ljava/lang/String;Ljava/lang/String;Ljava/io/File;)Ljava/io/File;": createTempFile,
    // a directory goes only when empty, as unlink/rmdir decide
    "delete()Z": function (this: JFile) { return +(vfs.isDir(this.path) ? !vfs.list(this.path).length && vfs.rmdir(this.path) : vfs.delete(this.path)); },
    "deleteOnExit()V": function () {},
    "renameTo(Ljava/io/File;)Z": function (this: JFile, dst: JFile) {
      return renamePath(null, this.path, dst.path) === 0 ? 1 : 0;
    },
    "list()[Ljava/lang/String;": function (this: JFile) {
      return jarray(vfs.list(this.path), "Ljava/lang/String;");
    },
    "listFiles()[Ljava/io/File;": function (this: JFile) { return listFiles(this); },
    "listFiles(Ljava/io/FilenameFilter;)[Ljava/io/File;": driven(function* (this: JFile, f: unknown): Gen {
      const out: JFile[] = [];
      for (const n of vfs.list(this.path)) if (f === null || (yield vcall(f, "accept", "(Ljava/io/File;Ljava/lang/String;)Z", this, n))) out.push(childOf(this, n));
      return jarray(out, "Ljava/io/File;");
    }),
    "listFiles(Ljava/io/FileFilter;)[Ljava/io/File;": driven(function* (this: JFile, f: unknown): Gen {
      const out: JFile[] = [];
      for (const c of listFiles(this)) if (f === null || (yield vcall(f, "accept", "(Ljava/io/File;)Z", c))) out.push(c);
      return jarray(out, "Ljava/io/File;");
    }),
    "list(Ljava/io/FilenameFilter;)[Ljava/lang/String;": driven(function* (this: JFile, f: unknown): Gen {
      const out: string[] = [];
      for (const n of vfs.list(this.path)) if (!f || (yield vcall(f, "accept", "(Ljava/io/File;Ljava/lang/String;)Z", this, n))) out.push(n);
      return jarray(out, "Ljava/lang/String;");
    }),
    "canRead()Z": () => 1, "canWrite()Z": () => 1, "canExecute()Z": () => 1,
    "setReadOnly()Z": () => 1,
    "setReadable(Z)Z": () => 1, "setWritable(Z)Z": () => 1, "setExecutable(Z)Z": () => 1,
    "setReadable(ZZ)Z": () => 1, "setWritable(ZZ)Z": () => 1, "setExecutable(ZZ)Z": () => 1,
    "toString()Ljava/lang/String;": filePath,
    "compareTo(Ljava/io/File;)I": compareFile,
    "compareTo(Ljava/lang/Object;)I": compareFile,
    "equals(Ljava/lang/Object;)Z": function (this: JFile, o: unknown) { return o instanceof JFile && o.javaPath === this.javaPath ? 1 : 0; },
    "hashCode()I": function (this: JFile) { return stringHash(this.javaPath) ^ 1234321; },
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
  declare markPos?: number;
}
class JByteArrayInputStream extends JInputStream {}
/** A seekable stream over bytes already in hand or a lazy file source. */
export function streamOf(bytes: Uint8Array): JInputStream {
  const s = new JByteArrayInputStream();
  s.buf = bytes;
  return s;
}
export function streamOfSource(source: FileSource): JInputStream {
  const s = new JByteArrayInputStream();
  s.source = source;
  return s;
}
const inputStreamMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "read()I": function (this: JInputStream) {
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
  },
  "read([B)I": function (this: JInputStream, out: Int8Array) {
    return (this as any)[readBII](out, 0, out.length);
  },
  "read([BII)I": function (this: JInputStream, out: Int8Array, off: number, len: number) {
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
  },
  "available()I": function (this: JInputStream) { return this.wrapped ? vcall(this.wrapped, "available", "()I") : (this.source?.size ?? this.buf.length) - this.pos; },
  "skip(J)J": function (this: JInputStream, n: bigint) {
    if (this.wrapped) return vcall(this.wrapped, "skip", "(J)J", n);
    if (n <= 0n) return 0n;
    const ownRead = (JInputStream.prototype as unknown as Record<string, unknown>)[readBII];
    if ((this as unknown as Record<string, unknown>)[readBII] !== ownRead) return skipThroughRead(this, n);
    const k = Math.min(Number(n), Math.max(0, (this.source?.size ?? this.buf.length) - this.pos));
    this.pos += k;
    return BigInt(k);
  },
  "close()V": function (this: JInputStream) { if (this.wrapped) return vcall(this.wrapped, "close", "()V"); },
  "mark(I)V": function (this: JInputStream, limit: number) { if (this.wrapped) return vcall(this.wrapped, "mark", "(I)V", limit); },
  "reset()V": function (this: JInputStream) {
    if (this.wrapped) return vcall(this.wrapped, "reset", "()V");
    throw rt.mkThrowable("java/io/IOException", "mark/reset not supported");
  },
  "markSupported()Z": function (this: JInputStream) { return this.wrapped ? vcall(this.wrapped, "markSupported", "()Z") : 0; },
};
const readI = mangleMethod("read", "()I"), readBII = mangleMethod("read", "([BII)I");
const writeBII = mangleMethod("write", "([BII)V");
async function skipThroughRead(stream: JInputStream, count: bigint): Promise<bigint> {
  const scratch = new Int8Array(Number(count < 2048n ? count : 2048n));
  let remaining = count;
  while (remaining > 0n) {
    const length = Number(remaining < BigInt(scratch.length) ? remaining : BigInt(scratch.length));
    const read = await vcall(stream, "read", "([BII)I", scratch, 0, length) as number;
    if (read <= 0) break;
    remaining -= BigInt(read);
  }
  return count - remaining;
}
function usesReads(stream: unknown, prototype = JInputStream.prototype): stream is JInputStream {
  const s = stream as Record<string, unknown> | null, p = prototype as unknown as Record<string, unknown>;
  return stream instanceof JInputStream && s![readI] === p[readI] && s![readBII] === p[readBII];
}
// the DataInput/DataOutput primitives, big-endian as the JDK reads and writes them
type Get = (v: DataView) => unknown;
type Put = (v: DataView, x: never) => void;
const PRIMS: [string, string, number, Get, Put][] = [
  ["Int", "I", 4, (v) => v.getInt32(0), (v, x: number) => v.setInt32(0, x)],
  ["Short", "S", 2, (v) => v.getInt16(0), (v, x: number) => v.setInt16(0, x)],
  ["Char", "C", 2, (v) => v.getUint16(0), (v, x: number) => v.setUint16(0, x)],
  ["Byte", "B", 1, (v) => v.getInt8(0), (v, x: number) => v.setInt8(0, x)],
  ["Boolean", "Z", 1, (v) => (v.getUint8(0) ? 1 : 0), (v, x: number) => v.setUint8(0, x ? 1 : 0)],
  ["Long", "J", 8, (v) => v.getBigInt64(0), (v, x: bigint) => v.setBigInt64(0, x)],
  ["Float", "F", 4, (v) => v.getFloat32(0), (v, x: number) => v.setFloat32(0, x)],
  ["Double", "D", 8, (v) => v.getFloat64(0), (v, x: number) => v.setFloat64(0, x)],
];
const READS: [string, string, number, Get, Put?][] = [...PRIMS, ["UnsignedShort", "I", 2, (v) => v.getUint16(0)], ["UnsignedByte", "I", 1, (v) => v.getUint8(0)]];
export const readers = (read: (n: number, get: Get) => unknown) =>
  Object.fromEntries(READS.map(([name, d, n, get]) => [`read${name}()${d}`, read(n, get)])) as NonNullable<NativeSpec["methods"]>;
export const writers = (write: (n: number, put: Put) => unknown) =>
  Object.fromEntries(PRIMS.map(([name, d, n, , put]) => [`write${name}(${"SBC".includes(d) ? "I" : d})V`, write(n, put)])) as NonNullable<NativeSpec["methods"]>;
/** every byte an InputStream has left: in place when its reads are ours, else through its virtual read */
export async function readStreamFully(s: unknown): Promise<Uint8Array> {
  if (usesReads(s) && !s.wrapped) {
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
  name: "java/io/ByteArrayInputStream", ctor: JByteArrayInputStream, sup: "java/io/InputStream",
  methods: {
    "<init>([B)V": function (this: JInputStream, b: Int8Array) { this.buf = u8(b); },
    "<init>([BII)V": function (this: JInputStream, b: Int8Array, off: number, len: number) {
      this.buf = u8(b, off, len);
    },
    "mark(I)V": function (this: JInputStream) { this.markPos = this.pos; },
    "reset()V": function (this: JInputStream) { this.pos = this.markPos ?? 0; },
    "markSupported()Z": () => 1,
  },
});
class JFileInputStream extends JInputStream { fd = new JFileDescriptor(); ownsFd = false; }
function adoptFd(this: JFileInputStream, fd: JFileDescriptor | null, owner = 0) {
  if (!fd) return rt.npe();
  this.fd = fd; this.ownsFd = !!owner;
  this.source = javaFdSource(fd.fd);
  Object.defineProperty(this, "pos", {
    get: () => checkedFdResult(javaSeekFd(fd.fd, 0, 1)),
    set: (position: number) => { checkedFdResult(javaSeekFd(fd.fd, position, 0)); },
    configurable: true,
  });
}
function checkedFdResult(n: number): number {
  if (n < 0) throw rt.mkThrowable("java/io/IOException", "Invalid file descriptor operation");
  return n;
}
function openRead(this: JFileInputStream, p: string) {
  if (p == null) return rt.npe();
  if (vfs.isDir(p)) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  const fd = javaOpenFd(p, 0);
  if (fd < 0) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  this.fd.fd = fd;
  adoptFd.call(this, this.fd, 1);
}
function readFile(this: JFileInputStream, out: Int8Array, off: number, len: number) {
  checkFileOpen(this);
  if (!out) return rt.npe();
  if (off < 0 || len < 0 || off > out.length - len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  if (!len) return 0;
  return after(javaReadFd(this.fd.fd, u8(out, off, len)), n => checkedFdResult(n) || -1);
}
rt.register({
  name: "java/io/FileInputStream", ctor: JFileInputStream, sup: "java/io/InputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": function (this: JFileInputStream) { return this.fd; },
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "<init>(Ljava/io/File;)V": function (this: JFileInputStream, f: JFile) { if (!f) return rt.npe(); openRead.call(this, f.path); },
    "<init>(Ljava/lang/String;)V": openRead,
    "<init>(Ljava/io/FileDescriptor;)V": adoptFd,
    "<init>(Ljava/io/FileDescriptor;Z)V": adoptFd,
    "read()I": function (this: JFileInputStream) { const b = new Int8Array(1); return after(readFile.call(this, b, 0, 1), n => n < 0 ? -1 : b[0] & 255); },
    "read([B)I": function (this: JFileInputStream, out: Int8Array) { if (!out) return rt.npe(); return readFile.call(this, out, 0, out.length); },
    "read([BII)I": readFile,
    "available()I": function (this: JFileInputStream) { checkFileOpen(this); return Math.min(0x7fffffff, checkedFdResult(javaAvailableFd(this.fd.fd))); },
    "skip(J)J": function (this: JFileInputStream, n: bigint) {
      checkFileOpen(this);
      const before = this.pos, next = checkedFdResult(javaSeekFd(this.fd.fd, Number(n), 1));
      return BigInt(next - before);
    },
    ...noMark,
    "close()V": function (this: JFileInputStream) {
      if (closedFiles.has(this)) return;
      closeFile(this);
      if (this.ownsFd) { javaCloseFd(this.fd.fd); this.fd.fd = -1; }
    },
  },
});
function adoptStream(this: JInputStream, src: JInputStream) {
  this.wrapped = src;
}
class JBufferedIn extends JInputStream {
  count = 0; marked = -1; markLimit = 0; closed = false;
  check() { if (this.closed) throw rt.mkThrowable("java/io/IOException", "Stream closed"); }
  async fill(): Promise<void> {
    if (this.marked < 0) this.pos = 0;
    else if (this.pos >= this.buf.length) {
      if (this.marked > 0) { this.buf.copyWithin(0, this.marked, this.pos); this.pos -= this.marked; this.marked = 0; }
      else if (this.buf.length >= this.markLimit) { this.marked = -1; this.pos = 0; }
      else { const bytes = new Uint8Array(Math.min(this.buf.length * 2, this.markLimit)); bytes.set(this.buf); this.buf = bytes; }
    }
    this.count = this.pos;
    const n = await vcall(this.wrapped, "read", "([BII)I", i8(this.buf), this.pos, this.buf.length - this.pos);
    if (n > 0) this.count = this.pos + n;
  }
}
function bufferedIn(this: JBufferedIn, source: unknown, size = 8192): void {
  if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size <= 0");
  this.wrapped = source; this.buf = new Uint8Array(size);
}
rt.register({
  name: "java/io/BufferedInputStream", ctor: JBufferedIn, sup: "java/io/InputStream",
  fields: { markpos: "marked" },
  methods: {
    "<init>(Ljava/io/InputStream;)V": bufferedIn,
    "<init>(Ljava/io/InputStream;I)V": bufferedIn,
    "read()I": driven(function* (this: JBufferedIn): Gen { this.check(); if (this.pos >= this.count) yield this.fill(); return this.pos < this.count ? this.buf[this.pos++] : -1; }),
    "read([BII)I": driven(function* (this: JBufferedIn, out: Int8Array, offset: number, count: number): Gen {
      this.check();
      if (!out) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (offset < 0 || count < 0 || offset > out.length - count) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (!count) return 0;
      if (this.pos >= this.count) {
        if (count >= this.buf.length && this.marked < 0) return vcall(this.wrapped, "read", "([BII)I", out, offset, count);
        yield this.fill(); if (this.pos >= this.count) return -1;
      }
      const n = Math.min(count, this.count - this.pos);
      out.set(i8(this.buf, this.pos, n), offset); this.pos += n; return n;
    }),
    "available()I": function (this: JBufferedIn) { this.check(); return after(vcall(this.wrapped, "available", "()I"), n => Math.min(2147483647, this.count - this.pos + n)); },
    "skip(J)J": driven(function* (this: JBufferedIn, count: bigint): Gen {
      this.check(); if (count <= 0n) return 0n;
      if (this.pos >= this.count) { if (this.marked < 0) return vcall(this.wrapped, "skip", "(J)J", count); yield this.fill(); }
      const n = Math.min(Number(count), this.count - this.pos); this.pos += n; return BigInt(n);
    }),
    "mark(I)V": function (this: JBufferedIn, limit: number) { this.marked = this.pos; this.markLimit = limit; },
    "reset()V": function (this: JBufferedIn) { this.check(); if (this.marked < 0) throw rt.mkThrowable("java/io/IOException", "Resetting to invalid mark"); this.pos = this.marked; },
    "markSupported()Z": () => 1,
    "close()V": function (this: JBufferedIn) { if (!this.closed) { this.closed = true; this.buf = new Uint8Array(0); return vcall(this.wrapped, "close", "()V"); } },
  },
});
rt.register({
  name: "java/io/DataInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  ifaces: ["java/io/DataInput"],
  methods: {
    "<init>(Ljava/io/InputStream;)V": adoptStream,
    ...readers((n, get) => dataRead(n, (b) => get(new DataView(b.buffer, b.byteOffset, n)))),
    "readFully([B)V": function (this: JInputStream, out: Int8Array) {
      return after(dataBytes(this, out.length), (bytes) => { out.set(i8(bytes)); });
    },
    "skipBytes(I)I": driven(function* (this: JInputStream, n: number): Gen {
      const thread = curThread;
      let total = 0;
      while (total < n) {
        const skipped = Number(yield vcallOn(thread, this.wrapped, "skip", "(J)J", BigInt(n - total)));
        if (skipped <= 0) break;
        total += skipped;
      }
      return total;
    }),
    "readUTF()Ljava/lang/String;": driven(function* (this: JInputStream): Gen {
      const head = yield dataBytes(this, 2);
      return decodeModifiedUtf8(yield dataBytes(this, (head[0] << 8) | head[1]));
    }),
  },
});
function dataRead(length: number, decode: (b: Uint8Array) => unknown) {
  return function (this: JInputStream) { return after(dataBytes(this, length), decode); };
}
export function dataBytes(stream: JInputStream, length: number, thread = curThread): Uint8Array | Promise<Uint8Array> {
  checkFileOpen(stream);
  const take = (bytes: Uint8Array) => {
    if (bytes.length !== length) throw rt.mkThrowable("java/io/EOFException", null);
    stream.pos += length;
    return bytes;
  };
  if (stream.wrapped) {
    const source = stream.wrapped;
    if (usesReads(source)) return after(dataBytes(source, length, thread), take);
    if (source instanceof JBufferedIn && usesReads(source, JBufferedIn.prototype) && source.count - source.pos >= length) {
      source.check(); const bytes = source.buf.subarray(source.pos, source.pos + length); source.pos += length; return take(bytes);
    }
    return wrappedBytes(stream, length, thread).then(take);
  }
  return stream.source ? readFully(stream.source, stream.pos, length).then(take) : take(stream.buf.subarray(stream.pos, stream.pos + length));
}
/** as many of `length` bytes as the wrapped stream has, one virtual read at a time */
async function wrappedBytes(stream: JInputStream, length: number, thread: typeof curThread): Promise<Uint8Array> {
  const out = new Int8Array(length);
  let got = 0;
  while (got < length) {
    const n = Number(await vcallOn(thread, stream.wrapped, "read", "([BII)I", out, got, length - got));
    if (n <= 0) break;
    got += n;
  }
  return new Uint8Array(out.buffer, 0, got);
}

/** A stream's descriptor names its open file (`path`, open(2) `flags`); the native descriptor
 *  number is opened from those the first time something outside java.io asks for it. A
 *  RandomAccessFile's is kept so streams built on it write at its shared file pointer. */
export class JFileDescriptor extends JObj { fd = -1; path = ""; flags = 0; owner: JObj | null = null; }
const descriptors = new WeakMap<JObj, JFileDescriptor>();
function descriptorOf(owner: JObj, path: string, flags: number): JFileDescriptor {
  let d = descriptors.get(owner);
  if (!d) { d = new JFileDescriptor(); d.path = path; d.flags = flags; d.owner = owner; descriptors.set(owner, d); }
  return d;
}
rt.register({
  name: "java/io/FileDescriptor", ctor: JFileDescriptor,
  fields: { descriptor: "fd", fd: "fd" },
  methods: {
    "<init>()V": () => {}, "sync()V": () => {},
    "valid()Z": function (this: JFileDescriptor) { return this.fd >= 0 || (this.owner !== null && !closedFiles.has(this.owner)) ? 1 : 0; },
  },
});
export class JOutputStream extends JObj {
  chunks: number[] = [];
}
rt.register({
  name: "java/io/OutputStream", ctor: JOutputStream, ifaces: ["java/io/Closeable", "java/io/Flushable"],
  methods: {
    "<init>()V": function () {},
    "write(I)V": function (this: JOutputStream, b: number) { this.chunks.push(b & 0xff); },
    "write([B)V": function (this: JOutputStream, b: Int8Array) {
      return (this as any)[writeBII](b, 0, b.length);
    },
    // OutputStream.write(byte[],int,int) is write(int) per byte, reaching a subclass's override
    "write([BII)V": driven(function* (this: JOutputStream, b: Int8Array, off: number, len: number): Gen {
      if (!b) rt.npe();
      if (off < 0 || len < 0 || len > b.length - off) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      for (let i = 0; i < len; i++) yield vcall(this, "write", "(I)V", b[off + i]);
    }),
    "flush()V": function () {},
    "close()V": function () {},
  },
});
// ByteArrayOutputStream keeps AOSP's protected `buf`/`count` as real fields: subclasses (pooled
// buffers, size probes) swap the array and read the count directly, so the bytes live in the
// Int8Array itself rather than in the base stream's chunk list.
export class JBAOS extends JOutputStream {
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
    "writeTo(Ljava/io/OutputStream;)V": driven(function* (this: JBAOS, out: unknown): Gen {
      yield vcall(out, "write", "([BII)V", this.buf, 0, this.count);
    }),
    "close()V": function () {},
  },
});

const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_APPEND = 0x400;
class JFOS extends JOutputStream {
  shared: JFileDescriptor | null = null;
  fpath = "";
  append = false;
  deleteOnClose = false;
  offset = 0;
  /** bytes written since the last publish to the file */
  pend = new Uint8Array(0);
  plen = 0;
  /** the pending buffer, with room for n more bytes */
  private room(n: number): Uint8Array {
    if (this.plen + n > this.pend.length) {
      const grown = new Uint8Array(Math.max(this.plen + n, this.pend.length * 2, 8192));
      grown.set(this.pend.subarray(0, this.plen));
      this.pend = grown;
    }
    return this.pend;
  }
  put(b: Uint8Array) { this.room(b.length).set(b, this.plen); this.plen += b.length; }
  putByte(b: number) { this.room(1)[this.plen++] = b; }
  get pos() {
    const raf = this.shared?.owner;
    if (raf instanceof JRAF) return raf.pos + this.plen;
    const fd = this.shared?.fd ?? -1;
    const base = fd >= 0 ? checkedFdResult(javaSeekFd(fd, 0, 1))
      : this.append && this.plen ? vfs.stat(this.fpath)?.size ?? 0 : this.offset;
    return base + this.plen;
  }
  set pos(value: number) {
    flushFOS(this);
    this.offset = value;
    const raf = this.shared?.owner;
    if (raf instanceof JRAF) { raf.pos = value; return; }
    const fd = this.shared?.fd ?? -1;
    if (fd >= 0) checkedFdResult(javaSeekFd(fd, value, 0));
  }
}
function openWrite(this: JFOS, path: string, append = 0, truncate = true) {
  this.fpath = vfs.norm(path);
  this.append = !!append;
  const size = vfs.stat(this.fpath)?.size;
  if (size === undefined || (!this.append && truncate)) vfs.write(this.fpath, new Uint8Array(0));
  this.offset = this.append ? size ?? 0 : 0;
}
rt.register({
  name: "java/io/FileOutputStream", ctor: JFOS, sup: "java/io/OutputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": function (this: JFOS) { return descriptors.get(this) ?? this.shared ?? descriptorOf(this, this.fpath, O_WRONLY | O_CREAT | (this.append ? O_APPEND : 0)); },
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    // AOSP: a stream over an open descriptor writes to that open file at its shared position
    "<init>(Ljava/io/FileDescriptor;)V": function (this: JFOS, d: JFileDescriptor | null) {
      if (!d) throw rt.mkThrowable("java/lang/NullPointerException", "fdObj == null");
      if (!d.path) throw rt.mkThrowable("java/io/IOException", "descriptor has no file to write");
      this.shared = d; this.fpath = d.path;
      if (!(d.owner instanceof JRAF)) {
        this.append = !!(d.flags & O_APPEND);
        this.offset = d.fd >= 0 ? checkedFdResult(javaSeekFd(d.fd, 0, 1)) : this.append ? vfs.stat(d.path)?.size ?? 0 : 0;
      }
    },
    "<init>(Ljava/io/File;)V": function (this: JFOS, f: JFile) { openWrite.call(this, f.path); },
    "<init>(Ljava/io/File;Z)V": function (this: JFOS, f: JFile, app: number) { openWrite.call(this, f.path, app); },
    "<init>(Ljava/lang/String;)V": openWrite,
    "<init>(Ljava/lang/String;Z)V": openWrite,
    "write(I)V": function (this: JFOS, b: number) { checkFileOpen(this); this.putByte(b); if (this.shared) flushFOS(this); },
    "write([BII)V": function (this: JFOS, b: Int8Array, off: number, len: number) {
      checkFileOpen(this);
      if (off < 0 || len < 0 || len > b.length - off) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      this.put(u8(b, off, len));
      if (this.shared) flushFOS(this);
    },
    "flush()V": function (this: JFOS) { checkFileOpen(this); flushFOS(this); },
    "close()V": function (this: JFOS) {
      if (closedFiles.has(this)) return;
      flushFOS(this);
      closeFile(this);
      if (this.deleteOnClose) vfs.delete(this.fpath);
    },
  },
});
function flushFOS(s: JFOS) {
  if (!s.plen) return;
  const bytes = s.pend.subarray(0, s.plen);
  s.plen = 0;
  if (s.pend.length > 1 << 20) s.pend = new Uint8Array(0);
  const raf = s.shared?.owner;
  if (raf instanceof JRAF) { rafWrite(raf, i8(bytes), 0, bytes.length); return; }
  if (!vfs.stat(s.fpath)) vfs.write(s.fpath, new Uint8Array(0));
  const file = vfs.open(s.fpath)!, fd = s.shared?.fd ?? -1;
  const start = s.append ? file.len : fd >= 0 ? checkedFdResult(javaSeekFd(fd, 0, 1)) : s.offset;
  vfs.writeAt(file, start, bytes);
  s.offset = start + bytes.length;
  if (fd >= 0) checkedFdResult(javaSeekFd(fd, s.offset, 0));
}

// RandomAccessFile handles keep independent cursors over the path's shared open file.
class JRAF extends JObj {
  path = ""; file: VfsFile = { path: null, data: EMPTY, len: 0 }; pos = 0; write = false;
  get source(): FileSource | null { return this.file.source ?? null; }
  get buf(): Uint8Array { return this.file.data.subarray(0, this.file.len); }
}
const rafOpen = function (this: JRAF, p: string, mode: string) {
  this.path = vfs.norm(p);
  this.write = mode.includes("w");
  if (!vfs.stat(this.path)) {
    if (!this.write) throw rt.mkThrowable("java/io/FileNotFoundException", p);
    vfs.write(this.path, new Uint8Array(0));
  }
  this.file = vfs.open(this.path)!;
  if (this.write && this.file.source && !writable(this.file.source)) throw rt.mkThrowable("java/io/IOException", "read-only file: " + p);
};
rt.register({
  name: "java/io/RandomAccessFile", ctor: JRAF, ifaces: ["java/io/Closeable", "java/io/DataInput", "java/io/DataOutput"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": rafOpen,
    "<init>(Ljava/io/File;Ljava/lang/String;)V": function (this: JRAF, f: JFile, m: string) { rafOpen.call(this, f.path, m); },
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "length()J": function (this: JRAF) { checkFileOpen(this); return BigInt(this.file.len); },
    "getFilePointer()J": function (this: JRAF) { checkFileOpen(this); return BigInt(this.pos); },
    "seek(J)V": function (this: JRAF, p: bigint) { checkFileOpen(this); this.pos = Number(p); },
    "skipBytes(I)I": function (this: JRAF, n: number) {
      const step = Math.max(0, Math.min(n, this.file.len - this.pos));
      this.pos += step;
      return step;
    },
    "getFD()Ljava/io/FileDescriptor;": function (this: JRAF) { return descriptorOf(this, this.path, this.write ? O_RDWR | O_CREAT : 0); },
    "read()I": driven(function* (this: JRAF): Gen {
      checkFileOpen(this);
      vfs.sync(this.file);
      if (!this.source) return this.pos < this.file.len ? this.file.data[this.pos++] : -1;
      const bytes = yield this.source.read(this.pos, 1);
      if (!bytes.length) return -1;
      this.pos++;
      return bytes[0];
    }),
    "read([B)I": function(this: JRAF, b: Int8Array) { return rafRead(this, b, 0, b.length); },
    "read([BII)I": function(this: JRAF, b: Int8Array, off: number, len: number) { return rafRead(this, b, off, len); },
    "readLine()Ljava/lang/String;": driven(function* (this: JRAF): Gen {
      checkFileOpen(this);
      vfs.sync(this.file);
      const parts: string[] = [], size = this.file.len;
      if (this.pos >= size) return null;
      while (this.pos < size) {
        const n = Math.min(4096, size - this.pos), bytes = this.source ? yield this.source.read(this.pos, n) : this.buf.subarray(this.pos, this.pos + n);
        if (!bytes.length) break;
        let end = 0; while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13) end++;
        parts.push(charsToString(bytes, 0, end)); this.pos += end;
        if (end < bytes.length) {
          this.pos++;
          if (bytes[end] === 13 && this.pos < size) {
            const next = this.source ? (yield this.source.read(this.pos, 1))[0] : this.buf[this.pos];
            if (next === 10) this.pos++;
          }
          break;
        }
      }
      return parts.join("");
    }),
    "readFully([B)V": function (this: JRAF, b: Int8Array) { return rafReadFully(this, b, 0, b.length); },
    "readFully([BII)V": function (this: JRAF, b: Int8Array, off: number, len: number) { return rafReadFully(this, b, off, len); },
    ...readers((n, get) => async function (this: JRAF) { const b = new Int8Array(n); await rafReadFully(this, b, 0, n); return get(new DataView(b.buffer)); }),
    "write(I)V": function (this: JRAF, v: number) { rafWrite(this, Int8Array.of(v), 0, 1); },
    "write([B)V": function (this: JRAF, b: Int8Array) { rafWrite(this, b, 0, b.length); },
    "write([BII)V": function (this: JRAF, b: Int8Array, off: number, len: number) { rafWrite(this, b, off, len); },
    ...writers((n, put) => function (this: JRAF, x: never) { const b = new Int8Array(n); put(new DataView(b.buffer), x); rafWrite(this, b, 0, n); }),
    "setLength(J)V": function (this: JRAF, n: bigint) {
      checkFileOpen(this);
      const len = Number(n);
      vfs.resize(this.file, len);
      if (this.pos > len) this.pos = len;
    },
    "close()V": function (this: JRAF) { if (!closedFiles.has(this)) closeFile(this); },
  },
});
function rafRead(f: JRAF, b: Int8Array, off: number, len: number): number | Promise<number> {
  checkFileOpen(f);
  if (len === 0) return 0;
  vfs.sync(f.file);
  if (f.source) {
    return after(f.source.read(f.pos, len), (bytes: Uint8Array) => {
      if (!bytes.length) return -1;
      b.set(i8(bytes), off);
      f.pos += bytes.length;
      return bytes.length;
    });
  }
  const n = Math.min(len, f.file.len - f.pos);
  if (n <= 0) return -1;
  b.set(i8(f.file.data, f.pos, n), off);
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
  vfs.writeAt(f.file, f.pos, u8(b, off, len));
  f.pos += len;
}

export class JFilterOutputStream extends JOutputStream { out: unknown = null; }
rt.register({
  name: "java/io/FilterOutputStream", ctor: JFilterOutputStream, sup: "java/io/OutputStream",
  fields: { out: "out" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: any, o: unknown) { this.out = o; },
    "write(I)V": function (this: any, b: number) { return vcall(this.out, "write", "(I)V", b); },
    "write([BII)V": function (this: any, b: Int8Array, o: number, l: number) { return vcall(this.out, "write", "([BII)V", b, o, l); },
    "flush()V": function (this: any) { return this.out ? vcall(this.out, "flush", "()V") : undefined; },
    "close()V": function (this: any) { return this.out ? vcall(this.out, "close", "()V") : undefined; },
  },
});
export async function skipStream(this: unknown, count: bigint): Promise<bigint> {
  if (count <= 0n) return 0n;
  const bytes = new Int8Array(Number(count > 2048n ? 2048n : count)); let remaining = count;
  while (remaining > 0n) {
    let n = await vcall(this, "read", "([BII)I", bytes, 0, Number(remaining > BigInt(bytes.length) ? BigInt(bytes.length) : remaining));
    if (n < 0) break;
    if (!n) { if (await vcall(this, "read", "()I") < 0) break; n = 1; }
    remaining -= BigInt(n);
  }
  return count - remaining;
}
class JSequenceInputStream extends JInputStream {
  enumeration: unknown = null; streams: unknown[] = []; current: unknown = null;
  async advance(): Promise<void> {
    if (this.current) await vcall(this.current, "close", "()V");
    this.current = null;
    if (this.enumeration ? await vcall(this.enumeration, "hasMoreElements", "()Z") : this.streams.length) {
      this.current = this.enumeration ? await vcall(this.enumeration, "nextElement", "()Ljava/lang/Object;") : this.streams.shift();
      if (!this.current) throw rt.mkThrowable("java/lang/NullPointerException", "stream");
    }
  }
}
rt.register({ name: "java/io/SequenceInputStream", ctor: JSequenceInputStream, sup: "java/io/InputStream", methods: {
  "<init>(Ljava/io/InputStream;Ljava/io/InputStream;)V": driven(function* (this: JSequenceInputStream, first: unknown, second: unknown): Gen { this.streams = [first, second]; yield this.advance(); }),
  "<init>(Ljava/util/Enumeration;)V": driven(function* (this: JSequenceInputStream, enumeration: unknown): Gen {
    if (!enumeration) throw rt.mkThrowable("java/lang/NullPointerException", null);
    this.enumeration = enumeration; yield this.advance();
  }),
  "read()I": driven(function* (this: JSequenceInputStream): Gen {
    while (this.current) { const value = yield vcall(this.current, "read", "()I"); if (value >= 0) return value; yield this.advance(); } return -1;
  }),
  "read([BII)I": driven(function* (this: JSequenceInputStream, out: Int8Array, offset: number, count: number): Gen {
    if (!out) throw rt.mkThrowable("java/lang/NullPointerException", null);
    if (offset < 0 || count < 0 || offset > out.length - count) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
    if (!count) return 0;
    while (this.current) { const n = yield vcall(this.current, "read", "([BII)I", out, offset, count); if (n > 0) return n; yield this.advance(); } return -1;
  }),
  "available()I": function (this: JSequenceInputStream) { return this.current ? vcall(this.current, "available", "()I") : 0; },
  "close()V": driven(function* (this: JSequenceInputStream): Gen { while (this.current) yield this.advance(); }),
  ...noMark,
  "skip(J)J": skipStream,
} });

// every method forwards to the wrapped stream, as the JDK's does: a Java subclass's super.read()
// reaches the stream it wrapped, whether that is one of ours or app code over a socket
export class JFilterInputStream extends JInputStream { in_: unknown = null; }
const fwd = (name: string, desc: string) => function (this: JFilterInputStream, ...a: unknown[]) { return vcall(this.in_, name, desc, ...a); };
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
/** PushbackInputStream: `pbuf[ppos..]` holds the unread bytes, which reads return first */
class JPushbackIn extends JFilterInputStream { pbuf: Int8Array | null = null; ppos = 0; }
function pushbackInit(this: JPushbackIn, s: unknown, size = 1) {
  if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "size <= 0");
  this.in_ = s;
  this.pbuf = new Int8Array(size);
  this.ppos = size;
}
function pushbackOpen(p: JPushbackIn): Int8Array {
  if (!p.pbuf) throw rt.mkThrowable("java/io/IOException", "Stream closed");
  return p.pbuf;
}
function unread(this: JPushbackIn, b: Int8Array, off: number, len: number) {
  const buf = pushbackOpen(this);
  if (len > this.ppos) throw rt.mkThrowable("java/io/IOException", "Push back buffer is full");
  this.ppos -= len;
  buf.set(b.subarray(off, off + len), this.ppos);
}
rt.register({
  name: "java/io/PushbackInputStream", ctor: JPushbackIn, sup: "java/io/FilterInputStream",
  fields: { buf: "pbuf", pos: "ppos" },
  methods: {
    "<init>(Ljava/io/InputStream;)V": pushbackInit,
    "<init>(Ljava/io/InputStream;I)V": pushbackInit,
    "read()I": function (this: JPushbackIn) {
      const buf = pushbackOpen(this);
      return this.ppos < buf.length ? buf[this.ppos++] & 0xff : vcall(this.in_, "read", "()I");
    },
    "read([BII)I": driven(function* (this: JPushbackIn, b: Int8Array, off: number, len: number): Gen {
      const buf = pushbackOpen(this);
      if (!b) rt.npe();
      if (off < 0 || len < 0 || len > b.length - off) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (!len) return 0;
      const avail = Math.min(buf.length - this.ppos, len);
      b.set(buf.subarray(this.ppos, this.ppos + avail), off);
      this.ppos += avail;
      if (avail === len) return avail;
      const n = yield vcall(this.in_, "read", "([BII)I", b, off + avail, len - avail);
      return n < 0 ? (avail || -1) : avail + n;
    }),
    "unread(I)V": function (this: JPushbackIn, v: number) { unread.call(this, Int8Array.of(v), 0, 1); },
    "unread([B)V": function (this: JPushbackIn, b: Int8Array) { unread.call(this, b, 0, b.length); },
    "unread([BII)V": unread,
    "available()I": function (this: JPushbackIn) {
      const n = pushbackOpen(this).length - this.ppos;
      return after(vcall(this.in_, "available", "()I"), (a: number) => Math.min(0x7fffffff, n + a));
    },
    "skip(J)J": function (this: JPushbackIn, n: bigint) {
      const buf = pushbackOpen(this);
      if (n <= 0n) return 0n;
      const own = Math.min(buf.length - this.ppos, Number(n));
      this.ppos += own;
      return BigInt(own) < n ? after(vcall(this.in_, "skip", "(J)J", n - BigInt(own)), (m: bigint) => BigInt(own) + m) : BigInt(own);
    },
    ...noMark,
    "close()V": function (this: JPushbackIn) {
      if (!this.in_) return;
      const s = this.in_;
      this.in_ = null;
      this.pbuf = null;
      return vcall(s, "close", "()V");
    },
  },
});
class JBufferedOut extends JFilterOutputStream { buf = new Int8Array(8192); count = 0; }
function drain(s: JBufferedOut) {
  if (!s.count) return;
  return after(vcall(s.out, "write", "([BII)V", s.buf, 0, s.count), () => { s.count = 0; });
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
    "write(I)V": function (this: JBufferedOut, b: number) {
      return after(this.count === this.buf.length ? drain(this) : undefined, () => { this.buf[this.count++] = b; });
    },
    "write([BII)V": function (this: JBufferedOut, b: Int8Array, off: number, len: number) {
      if (off < 0 || len < 0 || off + len > b.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (len >= this.buf.length) {
        const t = rt.th();
        return after(drain(this), () => { rt.st(t); return vcall(this.out, "write", "([BII)V", b, off, len); });
      }
      return after(len > this.buf.length - this.count ? drain(this) : undefined, () => {
        this.buf.set(b.subarray(off, off + len), this.count);
        this.count += len;
      });
    },
    "flush()V": function (this: JBufferedOut) {
      const t = rt.th();
      return after(drain(this), () => { rt.st(t); return vcall(this.out, "flush", "()V"); });
    },
    "close()V": driven(function* (this: JBufferedOut): Gen {
      const t = rt.th();
      try { yield vcall(this, "flush", "()V"); } finally { rt.st(t); yield vcall(this.out, "close", "()V"); }
    }),
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
  out: unknown = null; auto = false; closed = false; trouble = false; charset = "UTF-8";
  line = ""; err = false; decoder = new TextDecoder();
}
async function pr(ps: JPrintStream, s: string, ln: boolean) {
  if (ps.closed) { ps.trouble = true; return; }
  if (ps.out !== null) {
    const bytes = encodeString(ln ? s + "\n" : s, ps.charset);
    await vcall(ps, "write", "([BII)V", bytes, 0, bytes.length);
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
const initPrint = function (this: JPrintStream, out: unknown, auto = 0, charset: string | null = "UTF-8") {
  if (out == null) throw rt.mkThrowable("java/lang/NullPointerException", "Null output stream");
  this.out = out; this.auto = !!auto; this.charset = charsetName(charset);
};
rt.register({
  name: "java/io/PrintStream", ctor: JPrintStream, sup: "java/io/FilterOutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": initPrint,
    "<init>(Ljava/io/OutputStream;Z)V": initPrint,
    "<init>(Ljava/io/OutputStream;ZLjava/lang/String;)V": initPrint,
    ...printMethods(pr, "java/io/PrintStream"),
    "flush()V": function (this: JPrintStream) { return this.out !== null ? printCall(this, "flush", "()V") : this.line ? pr(this, "", true) : undefined; },
    "close()V": driven(function* (this: JPrintStream): Gen {
      if (this.closed) return;
      yield vcall(this, "flush", "()V");
      if (this.out !== null) yield printCall(this, "close", "()V");
      this.closed = true;
    }),
    "checkError()Z": driven(function* (this: JPrintStream): Gen {
      if (!this.closed) yield vcall(this, "flush", "()V");
      return this.trouble || this.out instanceof JPrintStream && (yield vcall(this.out, "checkError", "()Z")) ? 1 : 0;
    }),
    "write(I)V": driven(function* (this: JPrintStream, b: number): Gen {
      if (this.out === null) { yield pr(this, this.decoder.decode(Uint8Array.of(b), { stream: true }), false); return; }
      yield printCall(this, "write", "(I)V", b);
      if (this.auto && (b & 255) === 10) yield vcall(this, "flush", "()V");
    }),
    "write([BII)V": driven(function* (this: JPrintStream, bytes: Int8Array, off: number, len: number): Gen {
      if (this.out === null) { yield pr(this, this.decoder.decode(bytes.subarray(off, off + len), { stream: true }), false); return; }
      yield printCall(this, "write", "([BII)V", bytes, off, len);
      if (this.auto) yield vcall(this, "flush", "()V");
    }),
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
  dec: StreamDecoder | null = null;
  markPos = -1;
  markLimit = 0;
}
const READ_CHUNK = 8192;
/**
 * One chunk out of the wrapped source, through its VIRTUAL read: an app's own InputStream or
 * Reader is bytecode, and reading the native class's byte buffer off it finds an empty one.
 */
function fill(r: JReader): void | Promise<void> {
  const src = r.src;
  if (!src) return;
  if (r.pos > 0 && (r.markPos < 0 || r.pos - r.markPos > r.markLimit)) {
    r.s = r.s.slice(r.pos);
    r.pos = 0;
    r.markPos = -1;
  }
  if (r.srcChars) {
    const out = new Uint16Array(READ_CHUNK);
    return after(vcall(src, "read", "([CII)I", out, 0, READ_CHUNK), (n: number) => {
      if (n > 0) r.s += charsToString(out, 0, n); else if (n < 0) r.src = null;
    });
  }
  const out = new Int8Array(READ_CHUNK);
  return after(vcall(src, "read", "([BII)I", out, 0, READ_CHUNK), (n: number) => {
    const dec = (r.dec ??= streamDecoder("UTF-8"));
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
    "read()I": function (this: JReader) {
      return after(need(this), () => (this.pos < this.s.length ? this.s.charCodeAt(this.pos++) : -1));
    },
    "read([CII)I": function (this: JReader, out: Uint16Array, off: number, len: number) {
      if (len === 0) return 0;
      return after(need(this), () => {
        if (this.pos >= this.s.length) return -1;
        const n = Math.min(len, this.s.length - this.pos);
        for (let i = 0; i < n; i++) out[off + i] = this.s.charCodeAt(this.pos + i);
        this.pos += n;
        return n;
      });
    },
    "read([C)I": function (this: JReader, out: Uint16Array) {
      return vcall(this, "read", "([CII)I", out, 0, out.length);
    },
    "ready()Z": function (this: JReader) { return this.pos < this.s.length ? 1 : 0; },
    "skip(J)J": function (this: JReader, n: bigint) {
      let left = Number(n), skipped = 0;
      const step = (): number | Promise<number> => {
        const k = Math.min(left, this.s.length - this.pos);
        this.pos += k; left -= k; skipped += k;
        return left > 0 && this.src ? after(fill(this), step) : skipped;
      };
      return after(step(), BigInt);
    },
    "markSupported()Z": () => 0,
  },
});
rt.register({
  name: "java/io/StringReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JReader, s: string) { this.s = s; },
    "markSupported()Z": () => 1,
    "mark(I)V": function (this: JReader, limit: number) {
      if (limit < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "readAheadLimit < 0");
      this.markPos = this.pos;
    },
    "reset()V": function (this: JReader) { this.pos = this.markPos < 0 ? 0 : this.markPos; },
    "ready()Z": () => 1,
  },
});
rt.register({
  name: "java/io/CharArrayReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>([C)V": function (this: JReader, chars: Uint16Array) {
      if (chars === null) return rt.npe();
      this.s = charsToString(chars, 0, chars.length);
      this.markPos = 0;
      this.markLimit = chars.length;
    },
    "<init>([CII)V": function (this: JReader, chars: Uint16Array, off: number, len: number) {
      if (chars === null) return rt.npe();
      if (off < 0 || len < 0 || off > chars.length || off + len < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      this.s = charsToString(chars, off, Math.min(len, chars.length - off));
      this.markPos = 0;
      this.markLimit = this.s.length;
    },
    "markSupported()Z": () => 1,
    "mark(I)V": function (this: JReader) { this.markPos = this.pos; this.markLimit = this.s.length; },
    "reset()V": function (this: JReader) { this.pos = this.markPos < 0 ? 0 : this.markPos; },
  },
});
const decodeStream = function (this: JReader, s: unknown, charset: unknown = "UTF-8") {
  if (s === null) rt.npe();
  this.src = s; this.dec = streamDecoder(charset);
};
rt.register({
  name: "java/io/InputStreamReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/InputStream;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/lang/String;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/CharsetDecoder;)V": function (this: JReader, s: unknown, d: JCharsetDecoder | null) {
      decodeStream.call(this, s, (d ?? rt.npe()).cs);
    },
  },
});
// FileReader is an InputStreamReader over a file: the file's bytes, decoded, in one go.
const fileText = driven(function* fileText(p: string): Gen<string> {
  const d: Uint8Array | null = yield vfs.readFile(p);
  if (!d) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  return utf8.dec.decode(d);
});
const openReader = driven(function* (this: JReader, p: string): Gen { this.s = yield fileText(p); });
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
    "readLine()Ljava/lang/String;": function (this: JReader) {
      const step = (): string | null | Promise<string | null> => {
        const i = this.s.indexOf("\n", this.pos);
        if (i < 0 && this.src) return after(fill(this), step);
        if (this.pos >= this.s.length) return null;
        const line = i < 0 ? this.s.slice(this.pos) : this.s.slice(this.pos, i);
        this.pos = i < 0 ? this.s.length : i + 1;
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      };
      return step();
    },
    "markSupported()Z": () => 1,
    "mark(I)V": function (this: JReader, limit: number) {
      if (limit < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Read-ahead limit < 0");
      this.markPos = this.pos;
      this.markLimit = limit;
    },
    "reset()V": function (this: JReader) {
      if (this.markPos < 0 || this.pos - this.markPos > this.markLimit) throw rt.mkThrowable("java/io/IOException", "Mark invalid");
      this.pos = this.markPos;
    },
  },
});
class JFilterReader extends JReader { in: JReader | null = null; }
const filterInput = (r: JFilterReader) => {
  if (!r.in) throw rt.mkThrowable("java/io/IOException", "Reader is closed");
  return r.in;
};
rt.register({
  name: "java/io/FilterReader", ctor: JFilterReader, sup: "java/io/Reader", fields: ["in"],
  methods: {
    "<init>(Ljava/io/Reader;)V": function (this: JFilterReader, input: JReader) { if (!input) return rt.npe(); this.in = input; },
    "read()I": function (this: JFilterReader) { return vcall(filterInput(this), "read", "()I"); },
    "read([CII)I": function (this: JFilterReader, out: Uint16Array, off: number, len: number) { return vcall(filterInput(this), "read", "([CII)I", out, off, len); },
    "ready()Z": function (this: JFilterReader) { return vcall(filterInput(this), "ready", "()Z"); },
    "skip(J)J": function (this: JFilterReader, n: bigint) { return vcall(filterInput(this), "skip", "(J)J", n); },
    "markSupported()Z": function (this: JFilterReader) { return vcall(filterInput(this), "markSupported", "()Z"); },
    "mark(I)V": function (this: JFilterReader, limit: number) { return vcall(filterInput(this), "mark", "(I)V", limit); },
    "reset()V": function (this: JFilterReader) { return vcall(filterInput(this), "reset", "()V"); },
    "close()V": function (this: JFilterReader) { const input = this.in; this.in = null; return input ? vcall(input, "close", "()V") : undefined; },
  },
});
class JPushbackReader extends JFilterReader { push: number[] = []; capacity = 1; }
function unreadChars(r: JPushbackReader, chars: Uint16Array, off: number, len: number): void {
  filterInput(r);
  if (!chars) return rt.npe();
  if (off < 0 || len < 0 || off > chars.length - len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
  if (r.push.length + len > r.capacity) throw rt.mkThrowable("java/io/IOException", "Pushback buffer full");
  for (let i = off + len - 1; i >= off; i--) r.push.push(chars[i]);
}
rt.register({
  name: "java/io/PushbackReader", ctor: JPushbackReader, sup: "java/io/FilterReader",
  methods: {
    "<init>(Ljava/io/Reader;)V": function (this: JPushbackReader, input: JReader) { if (!input) return rt.npe(); this.in = input; },
    "<init>(Ljava/io/Reader;I)V": function (this: JPushbackReader, input: JReader, size: number) {
      if (!input) return rt.npe();
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "size <= 0");
      this.in = input; this.capacity = size;
    },
    "read()I": function (this: JPushbackReader) { const input = filterInput(this); return this.push.length ? this.push.pop() ?? -1 : vcall(input, "read", "()I"); },
    "read([CII)I": function (this: JPushbackReader, out: Uint16Array, off: number, len: number) {
      const input = filterInput(this);
      if (!out) return rt.npe();
      if (off < 0 || len < 0 || off > out.length - len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      if (!len) return 0;
      let copied = 0;
      while (copied < len && this.push.length) out[off + copied++] = this.push.pop() ?? 0;
      if (copied === len) return copied;
      return after(vcall(input, "read", "([CII)I", out, off + copied, len - copied), (n: number) => n < 0 ? copied || -1 : copied + n);
    },
    "unread(I)V": function (this: JPushbackReader, c: number) { unreadChars(this, Uint16Array.of(c), 0, 1); },
    "unread([C)V": function (this: JPushbackReader, chars: Uint16Array) { unreadChars(this, chars, 0, chars?.length ?? 0); },
    "unread([CII)V": function (this: JPushbackReader, chars: Uint16Array, off: number, len: number) { unreadChars(this, chars, off, len); },
    "ready()Z": function (this: JPushbackReader) { const input = filterInput(this); return this.push.length ? 1 : vcall(input, "ready", "()Z"); },
    "skip(J)J": function (this: JPushbackReader, count: bigint) {
      const input = filterInput(this);
      if (count < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "skip value is negative");
      const buffered = Math.min(this.push.length, Number(count));
      this.push.length -= buffered;
      return BigInt(buffered) === count ? count : after(vcall(input, "skip", "(J)J", count - BigInt(buffered)), (n: bigint) => BigInt(buffered) + n);
    },
    "markSupported()Z": () => 0,
    "mark(I)V": markUnsupported,
    "reset()V": markUnsupported,
    "close()V": function (this: JPushbackReader) { this.push.length = 0; const input = this.in; this.in = null; return input ? vcall(input, "close", "()V") : undefined; },
  },
});
class JWriter extends JObj { s = ""; lock: unknown = this; }
const wr = (w: unknown, s: string) => vcall(w, "write", "(Ljava/lang/String;)V", s);
const chars = (c: Uint16Array): string => charsToString(c, 0, c.length);
function writerRange(value: string | Uint16Array, off: number, len: number): void {
  if (value == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (off < 0 || len < 0 || off > value.length - len) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
}
const nativeWriterRanges = {
  "write(Ljava/lang/String;II)V": function (this: JWriter, text: string, off: number, len: number) {
    writerRange(text, off, len); return wr(this, text.slice(off, off + len));
  },
  "write([CII)V": function (this: JWriter, c: Uint16Array, off: number, len: number) {
    writerRange(c, off, len); return wr(this, charsToString(c, off, len));
  },
};
const memoryWriterMethods = {
  ...nativeWriterRanges,
  "write(Ljava/lang/String;)V": function (this: JWriter, s: string) {
    if (s == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    this.s += s;
  },
};
function writerAppend(ret: string): NonNullable<NativeSpec["methods"]> {
  return {
    [`append(C)L${ret};`]: function (this: JWriter, c: number) { return after(vcall(this, "write", "(I)V", c), () => this); },
    [`append(Ljava/lang/CharSequence;)L${ret};`]: driven(function* (this: JWriter, cs: unknown): Gen {
      const thread = curThread, text = cs == null ? "null" : yield csText(cs);
      yield vcallOn(thread, this, "write", "(Ljava/lang/String;)V", text); return this;
    }),
    [`append(Ljava/lang/CharSequence;II)L${ret};`]: driven(function* (this: JWriter, cs: unknown, start: number, end: number): Gen {
      const thread = curThread, text = cs == null ? "null" : yield csText(cs);
      if (start < 0 || end < start || end > text.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
      yield vcallOn(thread, this, "write", "(Ljava/lang/String;)V", text.slice(start, end)); return this;
    }),
  };
}
rt.register({
  name: "java/io/Writer", ctor: JWriter, fields: { lock: "lock" },
  ifaces: ["java/io/Closeable", "java/io/Flushable", "java/lang/Appendable"],
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/Object;)V": function (this: JWriter, lock: unknown) {
      if (lock == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      this.lock = lock;
    },
    "write(Ljava/lang/String;)V": function (this: JWriter, s: string) {
      if (s == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return vcall(this, "write", "(Ljava/lang/String;II)V", s, 0, s.length);
    },
    ...writerAppend("java/io/Writer"), ...writerAppend("java/lang/Appendable"),
    "write(Ljava/lang/String;II)V": function (this: JWriter, s: string, off: number, len: number) {
      writerRange(s, off, len);
      const chars = new Uint16Array(len);
      for (let i = 0; i < len; i++) chars[i] = s.charCodeAt(off + i);
      return vcall(this, "write", "([CII)V", chars, 0, len);
    },
    "write(I)V": function (this: JWriter, c: number) { return vcall(this, "write", "([CII)V", Uint16Array.of(c), 0, 1); },
    "write([C)V": function (this: JWriter, c: Uint16Array) {
      if (c == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      return vcall(this, "write", "([CII)V", c, 0, c.length);
    },
    "flush()V": function () {}, "close()V": function () {},
  },
});
rt.register({
  name: "java/io/StringWriter", ctor: class extends JWriter {}, sup: "java/io/Writer",
  methods: {
    ...memoryWriterMethods,
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
  name: "java/io/CharArrayWriter", ctor: class extends JWriter {}, sup: "java/io/Writer",
  methods: {
    ...memoryWriterMethods,
    "<init>()V": function () {},
    "<init>(I)V": function () {},
    "reset()V": function (this: JWriter) { this.s = ""; },
    "size()I": function (this: JWriter) { return this.s.length; },
    "toCharArray()[C": function (this: JWriter) {
      const out = new Uint16Array(this.s.length);
      for (let i = 0; i < out.length; i++) out[i] = this.s.charCodeAt(i);
      return out;
    },
    "toString()Ljava/lang/String;": function (this: JWriter) { return this.s; },
    "writeTo(Ljava/io/Writer;)V": function (this: JWriter, out: unknown) { return wr(out, this.s); },
  },
});
function initBufferedWriter(this: { target: JWriter | null }, w: JWriter) { this.target = w; }
rt.register({
  name: "java/io/BufferedWriter", ctor: class extends JWriter { target: JWriter | null = null; }, sup: "java/io/Writer",
  methods: {
    ...nativeWriterRanges,
    "<init>(Ljava/io/Writer;)V": initBufferedWriter,
    "<init>(Ljava/io/Writer;I)V": initBufferedWriter,
    "write(Ljava/lang/String;)V": function (this: any, str: string) { return wr(this.target, str); },
    "newLine()V": function (this: any) { return wr(this.target, "\n"); },
    "flush()V": function (this: any) { return vcall(this.target, "flush", "()V"); },
    "close()V": function (this: any) { return vcall(this.target, "close", "()V"); },
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
    ...nativeWriterRanges,
    "<init>(Ljava/io/Writer;)V": function (this: JPrintWriter, w: unknown) { this.target = w; },
    "<init>(Ljava/io/Writer;Z)V": function (this: JPrintWriter, w: unknown, a: number) { this.target = w; this.auto = !!a; },
    "<init>(Ljava/io/OutputStream;)V": driven(function* (this: JPrintWriter, o: unknown): Gen { this.target = yield mkOSW(o); }),
    "<init>(Ljava/io/OutputStream;Z)V": driven(function* (this: JPrintWriter, o: unknown, a: number): Gen { this.target = yield mkOSW(o); this.auto = !!a; }),
    "write(Ljava/lang/String;)V": function (this: JPrintWriter, s: string) {
      if (this.target === null) { this.s += s; return; }
      return vcall(this.target, "write", "(Ljava/lang/String;)V", s);
    },
    ...printMethods(pw, "java/io/PrintWriter"), ...writerAppend("java/io/PrintWriter"),
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
    ...nativeWriterRanges,
    "<init>(Ljava/io/OutputStream;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "<init>(Ljava/io/OutputStream;Ljava/nio/charset/Charset;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "<init>(Ljava/io/OutputStream;Ljava/lang/String;)V": function (this: JOSW, o: unknown) { this.sink = o; },
    "write(Ljava/lang/String;)V": function (this: JOSW, str: string) { this.s += str; },
    "flush()V": driven(function* (this: JOSW): Gen {
      if (this.s && this.sink) {
        const b = utf8.enc.encode(this.s);
        yield vcall(this.sink, "write", "([BII)V", new Int8Array(b.buffer, 0, b.length), 0, b.length);
        this.s = "";
      }
      if (this.sink) yield vcall(this.sink, "flush", "()V");
    }),
    "close()V": driven(function* (this: JOSW): Gen {
      yield vcall(this, "flush", "()V");
      if (this.sink) yield vcall(this.sink, "close", "()V");
    }),
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

class JDataOut extends JOutputStream { sink: unknown = null; written = 0; }
function emit(s: JDataOut, b: Int8Array, off: number, len: number): unknown {
  return after(vcall(s.sink, "write", "([BII)V", b, off, len), () => { s.written += len; });
}
rt.register({
  name: "java/io/DataOutputStream", ctor: JDataOut, sup: "java/io/OutputStream",
  ifaces: ["java/io/DataOutput"],
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: JDataOut, s: unknown) { this.sink = s; },
    "write(I)V": function (this: JDataOut, b: number) { return after(vcall(this.sink, "write", "(I)V", b), () => { this.written++; }); },
    "write([BII)V": function (this: JDataOut, b: Int8Array, off: number, len: number) { return emit(this, b, off, len); },
    "writeBytes(Ljava/lang/String;)V": function (this: JDataOut, s: string) {
      const bytes = new Int8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      return emit(this, bytes, 0, bytes.length);
    },
    ...writers((n, put) => function (this: JDataOut, x: never) { const b = new Int8Array(n); put(new DataView(b.buffer), x); return emit(this, b, 0, n); }),
    "writeUTF(Ljava/lang/String;)V": function (this: JDataOut, s: string) {
      const b = encodeModifiedUtf8(s);
      if (b.length > 65535) throw rt.mkThrowable("java/io/UTFDataFormatException", "encoded string too long: " + b.length + " bytes");
      const out = new Int8Array(b.length + 2);
      out[0] = b.length >>> 8; out[1] = b.length; out.set(b, 2);
      return emit(this, out, 0, out.length);
    },
    "flush()V": function (this: JDataOut) { return vcall(this.sink, "flush", "()V"); },
    "close()V": function (this: JDataOut) { return after(vcall(this.sink, "flush", "()V"), () => vcall(this.sink, "close", "()V")); },
    "size()I": function (this: JDataOut) { return this.written; },
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
  writable(): JFOS | JRAF {
    this.opened();
    if (this.file instanceof JFOS || this.file instanceof JRAF && this.file.write) return this.file;
    throw rt.mkThrowable("java/nio/channels/NonWritableChannelException", null);
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
function channelRead(channel: JFileChannel, dst: JBuffer): number | Promise<number> {
  const file = channel.readable(), len = dst.lim - dst.pos;
  if (len === 0) return 0;
  dst.clampPut(0);
  const view = new Int8Array(dst.ab, dst.dv.byteOffset + dst.pos, len);
  const n = file instanceof JRAF ? rafRead(file, view, 0, len) : (file as any)[readBII](view, 0, len);
  return after(n, (n: number) => { if (n > 0) dst.pos += n; return n; });
}
function channelWrite(channel: JFileChannel, src: JBuffer): number | Promise<number> {
  if (!src) throw rt.mkThrowable("java/lang/NullPointerException", "src");
  const file = channel.writable(), len = src.lim - src.pos;
  if (len === 0) return 0;
  const view = new Int8Array(src.ab, src.dv.byteOffset + src.pos, len);
  const written = file instanceof JRAF ? rafWrite(file, view, 0, len) : vcall(file, "write", "([BII)V", view, 0, len);
  return after(written, () => { src.pos += len; return len; });
}
rt.register({
  name: "java/nio/channels/FileChannel", ctor: JFileChannel,
  methods: {
    "close()V": function (this: JFileChannel) { if (this.open) { this.open = false; return vcall(this.file, "close", "()V"); } },
    "isOpen()Z": function (this: JFileChannel) { return +this.open; },
    "size()J": function (this: JFileChannel) {
      const file = this.opened();
      return BigInt(file instanceof JFOS
        ? Math.max(vfs.stat(file.fpath)?.size ?? 0, file.plen ? file.pos : 0)
        : file instanceof JRAF ? file.file.len : file.source?.size ?? file.buf.length);
    },
    "truncate(J)Ljava/nio/channels/FileChannel;": function (this: JFileChannel, size: bigint) {
      if (size < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "size");
      const file = this.writable();
      if (file instanceof JRAF) {
        if (size < BigInt(file.file.len)) vfs.resize(file.file, Number(size));
      } else {
        flushFOS(file);
        const open = vfs.open(file.fpath);
        if (open && size < BigInt(open.len)) vfs.resize(open, Number(size));
      }
      if (BigInt(file.pos) > size) file.pos = Number(size);
      return this;
    },
    "position()J": function (this: JFileChannel) { return BigInt(this.opened().pos); },
    "position(J)Ljava/nio/channels/FileChannel;": function (this: JFileChannel, position: bigint) {
      if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position");
      this.opened().pos = Number(position); return this;
    },
    "map(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;": function (this: JFileChannel, mode: JSimpleEnum | null, position: bigint, size: bigint) {
      const file = this.readable();
      if (!mode) return rt.npe();
      if (position < 0n || size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position/size");
      const start = Number(position), length = Number(size);
      if (mode.ename === "READ_ONLY") {
        if (position + size > BigInt(file.source?.size ?? file.buf.length)) throw rt.mkThrowable("java/io/IOException", "mapping exceeds file size");
        return file.source ? readFully(file.source, start, length).then(mappedReadOnlyBuffer) : mappedReadOnlyBuffer(file.buf.subarray(start, start + length));
      }
      if (!(file instanceof JRAF) || !file.write) throw rt.mkThrowable("java/nio/channels/NonWritableChannelException", null);
      // a writable mapping past the end extends the file first (FileChannelImpl.map truncates it up to position + size)
      const open = file.file;
      if (start + length > open.len) vfs.resize(open, start + length);
      if (open.source) {
        // a disk-backed file maps a copy of the region, written back when the mapping is forced
        return readFully(open.source, start, length).then((bytes) =>
          mappedBuffer(bytes.slice(), mode.ename === "PRIVATE" ? () => {} : () => vfs.writeAt(open, start, bytes)));
      }
      if (mode.ename === "PRIVATE") return mappedBuffer(open.data.slice(start, start + length), () => {});
      const buffer = mappedBuffer(open.data.subarray(start, start + length), () => vfs.publish(open));
      (open.maps ??= []).push(buffer);
      return buffer;
    },
    "read(Ljava/nio/ByteBuffer;)I": function (this: JFileChannel, dst: JBuffer) { return channelRead(this, dst); },
    "read(Ljava/nio/ByteBuffer;J)I": function (this: JFileChannel, dst: JBuffer, position: bigint) {
      const file = this.readable(), saved = file.pos;
      file.pos = Number(position);
      return after(channelRead(this, dst), (n) => { file.pos = saved; return n; });
    },
    "write(Ljava/nio/ByteBuffer;)I": function (this: JFileChannel, src: JBuffer) { return channelWrite(this, src); },
    "transferTo(JJLjava/nio/channels/WritableByteChannel;)J": driven(function* (this: JFileChannel, position: bigint, count: bigint, target: JObj | null): Gen {
      const file = this.readable(), thread = curThread;
      if (!target) return rt.npe();
      if (position < 0n || count < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position/count");
      if (!(yield vcallOn(thread, target, "isOpen", "()Z"))) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
      if (target instanceof JFileChannel) target.writable();
      const available = BigInt(file.source?.size ?? file.buf.length) - position;
      const length = Number(count < available ? count : available);
      if (length <= 0) return 0n;
      const buffer = mkByteBuffer(Math.min(length, 65536)), bytes = new Uint8Array(buffer.ab);
      let transferred = 0;
      while (transferred < length) {
        this.readable();
        const start = Number(position) + transferred, n = Math.min(length - transferred, bytes.length);
        const data = file.source ? yield readFully(file.source, start, n) : file.buf.subarray(start, start + n);
        bytes.set(data); buffer.pos = 0; buffer.lim = data.length;
        const written = Number(yield vcallOn(thread, target, "write", "(Ljava/nio/ByteBuffer;)I", buffer));
        transferred += written;
        if (written < n) break;
      }
      return BigInt(transferred);
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
defineException("java/nio/channels/NonWritableChannelException", "java/lang/IllegalStateException");
defineException("java/nio/file/FileSystemNotFoundException", "java/lang/RuntimeException");
defineException("java/nio/file/DirectoryNotEmptyException", "java/io/IOException");

// ── java.nio.file over the vfs
class JNioPath extends JObj { p = ""; }
class JNioFileSystem extends JObj {}
class JNioFileSystemProvider extends JObj {}
const nioFileSystem = new JNioFileSystem();
const nioFileSystemProvider = new JNioFileSystemProvider();
const mkPath = (p: string) => { const q = new JNioPath(); q.p = p; return q; };
function createNioTempFile(dir: JNioPath | null, prefix: string | null, suffix: string | null, attrs: unknown[] | null): JNioPath {
  if (attrs?.length) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "File attributes");
  const parent = dir?.p ?? "/data/local/tmp";
  if (!vfs.isDir(parent)) throw rt.mkThrowable("java/nio/file/NoSuchFileException", parent);
  for (;;) {
    const path = vfs.norm(`${parent}/${prefix ?? ""}${crypto.randomUUID().replaceAll("-", "")}${suffix ?? ".tmp"}`);
    if (!vfs.exists(path)) { vfs.write(path, new Uint8Array(0)); return mkPath(path); }
  }
}
rt.register({
  name: "java/nio/file/Path", ctor: JNioPath, ifaces: ["java/lang/Comparable", "java/lang/Iterable"],
  methods: {
    "toString()Ljava/lang/String;": function (this: JNioPath) { return this.p; },
    "toFile()Ljava/io/File;": function (this: JNioPath) { return mkFile(this.p); },
    "getFileSystem()Ljava/nio/file/FileSystem;": () => nioFileSystem,
    "getParent()Ljava/nio/file/Path;": function (this: JNioPath) {
      const i = this.p.lastIndexOf("/");
      return i <= 0 ? null : mkPath(this.p.slice(0, i));
    },
    "resolve(Ljava/lang/String;)Ljava/nio/file/Path;": function (this: JNioPath, n: string) { return mkPath(vfs.norm(this.p + "/" + n)); },
    "getFileName()Ljava/nio/file/Path;": function (this: JNioPath) { return mkPath(this.p.split("/").pop() ?? ""); },
  },
});
rt.markers("java/nio/file/CopyOption", "java/nio/file/OpenOption", "java/nio/file/attribute/FileAttribute", "java/nio/file/attribute/FileAttributeView");
const joinPath = (first: string, more: string[] | null) => mkPath(vfs.norm([first, ...(more ?? [])].join("/")));
rt.register({
  name: "java/nio/file/Paths", ctor: class extends JObj {},
  methods: {
    "static get(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;": joinPath,
  },
});
rt.register({
  name: "java/nio/file/FileSystem", ctor: JNioFileSystem, ifaces: ["java/io/Closeable"],
  methods: {
    "provider()Ljava/nio/file/spi/FileSystemProvider;": () => nioFileSystemProvider,
    "isOpen()Z": () => 1,
    "isReadOnly()Z": () => 0,
    "getSeparator()Ljava/lang/String;": () => "/",
    "getPath(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;": joinPath,
    "close()V": () => {},
  },
});
const optionName = (option: unknown): string => option instanceof JObj && "ename" in option && typeof option.ename === "string" ? option.ename : "";
const replaceExisting = (options: unknown[] | null) => (options ?? []).some((option) => optionName(option) === "REPLACE_EXISTING");
function requireNioFile(path: JNioPath): void {
  if (!vfs.exists(path.p)) throw rt.mkThrowable("java/nio/file/NoSuchFileException", path.p);
}
/** remove an existing file, or a directory only when empty */
function removeNioEntry(path: JNioPath): void {
  if (vfs.isDir(path.p)) {
    if (vfs.list(path.p).length) throw rt.mkThrowable("java/nio/file/DirectoryNotEmptyException", path.p);
    vfs.rmdir(path.p);
  } else vfs.delete(path.p);
}
const basicAttrs = (path: string) => Object.assign(new JBasicAttrs(), { sz: vfs.stat(path)?.size ?? 0, dir: vfs.isDir(path) });
rt.register({
  name: "java/nio/file/spi/FileSystemProvider", ctor: JNioFileSystemProvider,
  methods: {
    "<init>()V": function () {},
    "getScheme()Ljava/lang/String;": () => "file",
    "getFileSystem(Ljava/net/URI;)Ljava/nio/file/FileSystem;": driven(function* (uri: unknown): Gen {
      const text = yield vcall(uri, "toString", "()Ljava/lang/String;");
      if (!/^file:/i.test(text)) throw rt.mkThrowable("java/nio/file/FileSystemNotFoundException", text);
      return nioFileSystem;
    }),
    "newInputStream(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/InputStream;": (path: JNioPath) =>
      newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", path.p),
    "newOutputStream(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;": (path: JNioPath, options: unknown[] | null) =>
      newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", path.p, (options ?? []).some((option) => optionName(option) === "APPEND") ? 1 : 0),
    "createDirectory(Ljava/nio/file/Path;[Ljava/nio/file/attribute/FileAttribute;)V": (path: JNioPath) => {
      if (vfs.exists(path.p)) throw rt.mkThrowable("java/nio/file/FileAlreadyExistsException", path.p);
      vfs.mkdir(path.p);
    },
    "delete(Ljava/nio/file/Path;)V": (path: JNioPath) => { requireNioFile(path); removeNioEntry(path); },
    "deleteIfExists(Ljava/nio/file/Path;)Z": (path: JNioPath) => {
      if (!vfs.exists(path.p)) return 0;
      removeNioEntry(path);
      return 1;
    },
    "copy(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)V": driven(function* (source: JNioPath, target: JNioPath, options: unknown[] | null): Gen {
      requireNioFile(source);
      if (vfs.exists(target.p) && !replaceExisting(options)) throw rt.mkThrowable("java/nio/file/FileAlreadyExistsException", target.p);
      const bytes = yield vfs.readFile(source.p);
      if (bytes) vfs.write(target.p, bytes.slice()); else vfs.mkdir(target.p);
    }),
    "move(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)V": driven(function* (this: JNioFileSystemProvider, source: JNioPath, target: JNioPath, options: unknown[] | null): Gen {
      yield vcall(this, "copy", "(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)V", source, target, options);
      yield vcall(this, "delete", "(Ljava/nio/file/Path;)V", source);
    }),
    "checkAccess(Ljava/nio/file/Path;[Ljava/nio/file/AccessMode;)V": (path: JNioPath) => requireNioFile(path),
    "getFileAttributeView(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/FileAttributeView;": () => null,
    "readAttributes(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;": (path: JNioPath) => {
      requireNioFile(path);
      return basicAttrs(path.p);
    },
  },
});
{
  const opt = (n: string) => { const o = new JObj(); (o as unknown as { ename: string }).ename = n; return o; };
  rt.register({
    name: "java/nio/file/StandardCopyOption", ctor: class extends JObj {}, sup: "java/lang/Enum",
    statics: { REPLACE_EXISTING: opt("REPLACE_EXISTING"), ATOMIC_MOVE: opt("ATOMIC_MOVE"), COPY_ATTRIBUTES: opt("COPY_ATTRIBUTES") },
  });
}
mkEnumSet("java/nio/file/StandardOpenOption", ["READ", "WRITE", "APPEND", "TRUNCATE_EXISTING", "CREATE", "CREATE_NEW", "DELETE_ON_CLOSE", "SPARSE", "SYNC", "DSYNC"], {}, ["java/nio/file/OpenOption"]);
defineException("java/nio/file/FileSystemException", "java/io/IOException");
defineException("java/nio/file/NoSuchFileException", "java/nio/file/FileSystemException");
defineException("java/nio/file/FileAlreadyExistsException", "java/nio/file/FileSystemException");
rt.register({
  name: "java/nio/file/Files", ctor: class extends JObj {},
  methods: {
    "static createTempFile(Ljava/nio/file/Path;Ljava/lang/String;Ljava/lang/String;[Ljava/nio/file/attribute/FileAttribute;)Ljava/nio/file/Path;": createNioTempFile,
    "static createTempFile(Ljava/lang/String;Ljava/lang/String;[Ljava/nio/file/attribute/FileAttribute;)Ljava/nio/file/Path;": (prefix: string | null, suffix: string | null, attrs: unknown[] | null) => createNioTempFile(null, prefix, suffix, attrs),
    "static exists(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.exists(p.p) ? 1 : 0),
    "static isWritable(Ljava/nio/file/Path;)Z": (p: JNioPath) => (vfs.exists(p.p) ? 1 : 0),
    "static move(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;": (src: JNioPath, dst: JNioPath) => {
      vfs.rename(src.p, dst.p);
      return dst;
    },
    "static copy(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;": driven(function* (src: JNioPath, dst: JNioPath): Gen {
      const data: Uint8Array | null = yield vfs.readFile(src.p);
      if (data) vfs.write(dst.p, data.slice());
      return dst;
    }),
    "static delete(Ljava/nio/file/Path;)V": (p: JNioPath) => { vfs.delete(p.p); },
    "static deleteIfExists(Ljava/nio/file/Path;)Z": (p: JNioPath) => (vfs.delete(p.p) ? 1 : 0),
    "static createDirectories(Ljava/nio/file/Path;[Ljava/nio/file/attribute/FileAttribute;)Ljava/nio/file/Path;": (p: JNioPath) => { vfs.mkdir(p.p); return p; },
    "static size(Ljava/nio/file/Path;)J": (p: JNioPath) => BigInt(vfs.stat(p.p)?.size ?? 0),
    "static readAttributes(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;": (p: JNioPath) => basicAttrs(p.p),
    "static isDirectory(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.isDir(p.p) ? 1 : 0),
    "static isRegularFile(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.stat(p.p) ? 1 : 0),
    "static isSymbolicLink(Ljava/nio/file/Path;)Z": () => 0,
    "static newOutputStream(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;": driven(function* (p: JNioPath, options: JSimpleEnum[] | null): Gen {
      const names = new Set((options ?? []).map((option) => option.ename));
      const defaults = names.size === 0;
      if (names.has("READ") || names.has("APPEND") && names.has("TRUNCATE_EXISTING")) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      const exists = vfs.exists(p.p);
      if (names.has("CREATE_NEW") && exists) throw rt.mkThrowable("java/nio/file/FileAlreadyExistsException", p.p);
      if (!exists && !defaults && !names.has("CREATE") && !names.has("CREATE_NEW")) throw rt.mkThrowable("java/nio/file/NoSuchFileException", p.p);
      if (vfs.isDir(p.p)) throw rt.mkThrowable("java/nio/file/FileSystemException", p.p);
      const truncate = defaults || names.has("TRUNCATE_EXISTING");
      if (exists && !truncate && !vfs.read(p.p) && !writable(vfs.source(p.p))) {
        const bytes = yield vfs.readFile(p.p);
        if (bytes) vfs.write(p.p, bytes);
      }
      const stream = new JFOS();
      openWrite.call(stream, p.p, names.has("APPEND") ? 1 : 0, truncate);
      stream.deleteOnClose = names.has("DELETE_ON_CLOSE");
      return stream;
    }),
    "static readAllBytes(Ljava/nio/file/Path;)[B": driven(function* (p: JNioPath): Gen {
      const bytes = (yield vfs.readFile(p.p)) ?? new Uint8Array(0);
      return new Int8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    }),
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
// delim anchors at the cursor; delimAll is the same pattern searching ahead for the token's end
class JScanner extends JObj { text = ""; pos = 0; delim = /\s+/y; delimAll = /\s+/g; }
function skipDelim(s: JScanner): void { s.delim.lastIndex = s.pos; const m = s.delim.exec(s.text); if (m && m.index === s.pos) s.pos += m[0].length; }
function peekToken(s: JScanner): string | null {
  skipDelim(s);
  if (s.pos >= s.text.length) return null;
  s.delimAll.lastIndex = s.pos;
  const m = s.delimAll.exec(s.text);
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
    "<init>(Ljava/io/File;)V": driven(function* (this: JScanner, f: JFile): Gen { this.text = yield fileText(f.path); }),
    "useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;": function (this: JScanner, p: string) { this.delim = new RegExp(p, "y"); this.delimAll = new RegExp(p, "g"); return this; },
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
