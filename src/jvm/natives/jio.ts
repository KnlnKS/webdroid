// java.io.* natives + an in-memory VFS. Nothing persists it; vfs.onWrite is the hook for a host that wants to.

import { rt, JObj, type NativeSpec } from "../runtime";
import { mangleStaticField, mangleMethod, charsToString, jarray } from "../abi";
import { vcall, stringHash, mkEnumSet } from "./jlang";

// marker interface — apps implement this to opt into custom serialization; writeExternal/
// readExternal dispatch isn't needed by anything exercised so far, so this just stops the
// interface from auto-stubbing when an app class implements it directly (see NOTES.md).
rt.register({ name: "java/io/Externalizable", ctor: class extends JObj {}, ifaces: ["java/io/Serializable"] });

// ── VFS: path → bytes. Directories implicit.
export const vfs = {
  files: new Map<string, Uint8Array>(),
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
  write(p: string, data: Uint8Array) { this.files.set(this.norm(p), data); this.onWrite(this.norm(p)); },
  exists(p: string): boolean {
    p = this.norm(p);
    if (this.files.has(p)) return true;
    const dir = p.endsWith("/") ? p : p + "/";
    for (const k of this.files.keys()) if (k.startsWith(dir)) return true;
    return false;
  },
  isDir(p: string): boolean {
    p = this.norm(p);
    if (this.files.has(p)) return false;
    const dir = p.endsWith("/") ? p : p + "/";
    for (const k of this.files.keys()) if (k.startsWith(dir)) return true;
    return dirs.has(p);
  },
  delete(p: string): boolean { const r = this.files.delete(this.norm(p)); if (r) this.onWrite(this.norm(p)); return r; },
  list(p: string): string[] {
    p = this.norm(p);
    const dir = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const k of this.files.keys()) {
      if (k.startsWith(dir)) names.add(k.slice(dir.length).split("/")[0]);
    }
    for (const d of dirs) if (d.startsWith(dir)) names.add(d.slice(dir.length).split("/")[0]);
    names.delete("");
    return [...names];
  },
};
const dirs = new Set<string>(["/data", "/sdcard"]);

// ── File
rt.register({ name: "java/io/FilenameFilter", ctor: class extends JObj {} });
rt.register({ name: "java/io/FileFilter", ctor: class extends JObj {} });
export class JFile extends JObj { path = ""; }
export function mkFile(path: string): JFile { const f = new JFile(); f.path = vfs.norm(path); return f; }
const listFiles = (d: JFile) => jarray(vfs.list(d.path).map((n) => mkFile(d.path + "/" + n)), "Ljava/io/File;");
// apps implement these to pick over a directory listing (File.listFiles(filter))
rt.register({ name: "java/io/FilenameFilter", ctor: class extends JObj {} });
rt.register({ name: "java/io/FileFilter", ctor: class extends JObj {} });
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
    "isFile()Z": function (this: JFile) { return vfs.files.has(this.path) ? 1 : 0; },
    "length()J": function (this: JFile) { return BigInt(vfs.read(this.path)?.length ?? 0); },
    "lastModified()J": function () { return BigInt(Date.now()); },
    "mkdir()Z": function (this: JFile) { dirs.add(this.path); return 1; },
    "mkdirs()Z": function (this: JFile) { dirs.add(this.path); return 1; },
    "createNewFile()Z": function (this: JFile) {
      if (vfs.files.has(this.path)) return 0;
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

// ── streams
export class JInputStream extends JObj {
  buf: Uint8Array = new Uint8Array(0);
  pos = 0;
}
const inputStreamMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "read()I": function (this: JInputStream) {
    return this.pos < this.buf.length ? this.buf[this.pos++] : -1;
  },
  "read([B)I": function (this: JInputStream, out: Int8Array) {
    return (this as any)[readBII](out, 0, out.length);
  },
  "read([BII)I": function (this: JInputStream, out: Int8Array, off: number, len: number) {
    if (this.pos >= this.buf.length) return -1;
    const n = Math.min(len, this.buf.length - this.pos);
    out.set(new Int8Array(this.buf.buffer, this.buf.byteOffset + this.pos, n), off);
    this.pos += n;
    return n;
  },
  "available()I": function (this: JInputStream) { return this.buf.length - this.pos; },
  "skip(J)J": function (this: JInputStream, n: bigint) {
    const k = Math.min(Number(n), this.buf.length - this.pos);
    this.pos += k;
    return BigInt(k);
  },
  "close()V": function () {},
  "mark(I)V": function (this: JInputStream) { (this as any).markPos = this.pos; },
  "reset()V": function (this: JInputStream) { this.pos = (this as any).markPos ?? 0; },
  "markSupported()Z": () => 1,
};
const readBII = mangleMethod("read", "([BII)I");
rt.register({ name: "java/io/InputStream", ctor: JInputStream, ifaces: ["java/io/Closeable"], methods: inputStreamMethods });
rt.register({
  name: "java/io/ByteArrayInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "<init>([B)V": function (this: JInputStream, b: Int8Array) { this.buf = new Uint8Array(b.buffer, b.byteOffset, b.length); },
    "<init>([BII)V": function (this: JInputStream, b: Int8Array, off: number, len: number) {
      this.buf = new Uint8Array(b.buffer, b.byteOffset + off, len);
    },
  },
});
function openRead(this: JInputStream, p: string) {
  const d = vfs.read(p);
  if (!d) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  this.buf = d;
}
rt.register({
  name: "java/io/FileInputStream", ctor: class extends JInputStream {}, sup: "java/io/InputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": () => new JFileDescriptor(),
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "<init>(Ljava/io/File;)V": function (this: JInputStream, f: JFile) { openRead.call(this, f.path); },
    "<init>(Ljava/lang/String;)V": openRead,
  },
});
/** a wrapping stream shares the source's bytes and cursor */
function adoptStream(this: JInputStream, src: JInputStream) {
  if (src instanceof JInputStream) { this.buf = src.buf; this.pos = src.pos; }
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
  methods: {
    "<init>(Ljava/io/InputStream;)V": function (this: JInputStream, src: JInputStream) {
      this.buf = src.buf; this.pos = src.pos;
    },
    "readInt()I": function (this: JInputStream) {
      const v = (this.buf[this.pos] << 24) | (this.buf[this.pos + 1] << 16) | (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3];
      this.pos += 4;
      return v;
    },
    "readByte()B": function (this: JInputStream) { return (this.buf[this.pos++] << 24) >> 24; },
    "readUnsignedByte()I": function (this: JInputStream) { return this.buf[this.pos++]; },
    "readShort()S": function (this: JInputStream) {
      const v = ((this.buf[this.pos] << 8) | this.buf[this.pos + 1]) << 16 >> 16;
      this.pos += 2;
      return v;
    },
    "readUnsignedShort()I": function (this: JInputStream) {
      const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
      this.pos += 2;
      return v;
    },
    "readLong()J": function (this: JInputStream) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.buf[this.pos++]);
      return BigInt.asIntN(64, v);
    },
    "readBoolean()Z": function (this: JInputStream) { return this.buf[this.pos++] ? 1 : 0; },
    "readFully([B)V": function (this: JInputStream, out: Int8Array) {
      (this as any)[readBII](out, 0, out.length);
    },
    "readUTF()Ljava/lang/String;": function (this: JInputStream) {
      const len = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
      this.pos += 2;
      const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
      this.pos += len;
      return s;
    },
  },
});

class JFileDescriptor extends JObj {}
rt.register({
  name: "java/io/FileDescriptor", ctor: JFileDescriptor,
  methods: { "<init>()V": () => {}, "sync()V": () => {}, "valid()Z": () => 1 },
});
export class JOutputStream extends JObj {
  chunks: number[] = [];
}
rt.register({
  name: "java/io/OutputStream", ctor: JOutputStream, ifaces: ["java/io/Closeable", "java/io/Flushable"],
  methods: {
    "<init>()V": function () {},
    "write(I)V": function (this: JOutputStream, b: number) { this.chunks.push(b & 0xff); },
    "write([B)V": async function (this: JOutputStream, b: Int8Array) {
      await vcall(this, "write", "([BII)V", b, 0, b.length);
    },
    "write([BII)V": function (this: JOutputStream, b: Int8Array, off: number, len: number) {
      for (let i = 0; i < len; i++) this.chunks.push(b[off + i] & 0xff);
    },
    "flush()V": function () {},
    "close()V": function () {},
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
  bytes(): Uint8Array { return new Uint8Array(this.buf.buffer, this.buf.byteOffset, this.count); }
}
function baosString(this: JBAOS) { return new TextDecoder().decode(this.bytes()); }
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

rt.register({
  name: "java/io/FileOutputStream", ctor: class extends JOutputStream { fpath = ""; append = false; }, sup: "java/io/OutputStream",
  methods: {
    "getFD()Ljava/io/FileDescriptor;": () => new JFileDescriptor(),
    "getChannel()Ljava/nio/channels/FileChannel;": fileChannel,
    "<init>(Ljava/io/File;)V": function (this: any, f: JFile) { this.fpath = f.path; },
    "<init>(Ljava/io/File;Z)V": function (this: any, f: JFile, app: number) { this.fpath = f.path; this.append = !!app; },
    "<init>(Ljava/lang/String;)V": function (this: any, p: string) { this.fpath = vfs.norm(p); },
    "flush()V": function (this: any) { flushFOS(this); },
    "close()V": function (this: any) { flushFOS(this); },
  },
});
function flushFOS(s: { fpath: string; append: boolean; chunks: number[] }) {
  const nw = new Uint8Array(s.chunks);
  if (s.append) {
    const old = vfs.read(s.fpath) ?? new Uint8Array(0);
    const merged = new Uint8Array(old.length + nw.length);
    merged.set(old); merged.set(nw, old.length);
    vfs.write(s.fpath, merged);
  } else {
    vfs.write(s.fpath, nw);
  }
}

// Filter streams: delegate to wrapped
rt.register({
  name: "java/io/FilterOutputStream", ctor: class extends JOutputStream { out: unknown = null; }, sup: "java/io/OutputStream",
  fields: { out: "out" },
  methods: {
    "<init>(Ljava/io/OutputStream;)V": function (this: any, o: unknown) { this.out = o; },
    "write(I)V": function (this: any, b: number) { return vcall(this.out, "write", "(I)V", b); },
    "write([BII)V": function (this: any, b: Int8Array, o: number, l: number) { return vcall(this.out, "write", "([BII)V", b, o, l); },
    "flush()V": function (this: any) { return this.out ? vcall(this.out, "flush", "()V") : undefined; },
    "close()V": function (this: any) { return this.out ? vcall(this.out, "close", "()V") : undefined; },
  },
});
rt.register({
  name: "java/io/FilterInputStream", ctor: class extends JInputStream { in_: unknown = null; }, sup: "java/io/InputStream",
  fields: { in: "in_" },
  methods: {
    "<init>(Ljava/io/InputStream;)V": function (this: any, s: unknown) {
      this.in_ = s;
      if (s instanceof JInputStream) { this.buf = s.buf; this.pos = s.pos; }
    },
  },
});
class JBufferedOut extends JOutputStream { out: unknown = null; }
async function drain(s: JBufferedOut) {
  if (!s.chunks.length) return;
  await vcall(s.out, "write", "([BII)V", new Int8Array(s.chunks), 0, s.chunks.length);
  s.chunks.length = 0;
}
const wrapOut = function (this: JBufferedOut, o: unknown) { this.out = o; };
rt.register({
  name: "java/io/BufferedOutputStream", ctor: JBufferedOut, sup: "java/io/OutputStream",
  methods: {
    "<init>(Ljava/io/OutputStream;)V": wrapOut,
    "<init>(Ljava/io/OutputStream;I)V": wrapOut,
    "flush()V": async function (this: JBufferedOut) { await drain(this); await vcall(this.out, "flush", "()V"); },
    "close()V": async function (this: JBufferedOut) { await drain(this); await vcall(this.out, "close", "()V"); },
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
function printMethods<T>(sink: (self: T, s: string, ln: boolean) => unknown): NativeSpec["methods"] {
  const m: NativeSpec["methods"] = { "println()V": function (this: T) { return sink(this, "", true); } };
  for (const [desc, str] of PRINT_ARGS) {
    m[`print(${desc})V`] = async function (this: T, v: unknown) { return sink(this, await str(v), false); };
    m[`println(${desc})V`] = async function (this: T, v: unknown) { return sink(this, await str(v), true); };
  }
  return m;
}

// ── PrintStream → console
class JPrintStream extends JObj { line = ""; err = false; }
function pr(ps: JPrintStream, s: string, ln: boolean) {
  if (!ln) { ps.line += s; return; }
  const line = ps.line + s;
  ps.line = "";
  (ps.err ? console.error : console.log)("[java]", line);
}
rt.register({
  name: "java/io/PrintStream", ctor: JPrintStream, sup: "java/io/FilterOutputStream",
  methods: {
    ...printMethods(pr),
    "flush()V": function () {},
    "close()V": function () {},
    "write(I)V": function (this: JPrintStream, b: number) { pr(this, String.fromCharCode(b), false); },
  },
});
// System.out/err
{
  const sysInfo = rt.link("java/lang/System");
  const out = new JPrintStream();
  const err = new JPrintStream(); err.err = true;
  sysInfo.ctor[mangleStaticField("out")] = out;
  sysInfo.ctor[mangleStaticField("err")] = err;
}

// ── Reader/Writer basics
class JReader extends JObj { s = ""; pos = 0; }
rt.register({
  name: "java/io/Reader", ctor: JReader, ifaces: ["java/io/Closeable"],
  methods: { "<init>()V": function () {}, "close()V": function () {} },
});
rt.register({
  name: "java/io/StringReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JReader, s: string) { this.s = s; },
    "read()I": function (this: JReader) { return this.pos < this.s.length ? this.s.charCodeAt(this.pos++) : -1; },
  },
});
// UTF-8 whatever charset was asked for
const decodeStream = function (this: JReader, s: JInputStream) { this.s = new TextDecoder().decode(s.buf.subarray(s.pos)); };
rt.register({
  name: "java/io/InputStreamReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/InputStream;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/lang/String;)V": decodeStream,
    "<init>(Ljava/io/InputStream;Ljava/nio/charset/Charset;)V": decodeStream,
  },
});
rt.register({
  name: "java/io/BufferedReader", ctor: class extends JReader {}, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/Reader;)V": function (this: JReader, r: JReader) { this.s = r.s; this.pos = r.pos; },
    "readLine()Ljava/lang/String;": function (this: JReader) {
      if (this.pos >= this.s.length) return null;
      const i = this.s.indexOf("\n", this.pos);
      const line = i < 0 ? this.s.slice(this.pos) : this.s.slice(this.pos, i);
      this.pos = i < 0 ? this.s.length : i + 1;
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    },
    "read()I": function (this: JReader) { return this.pos < this.s.length ? this.s.charCodeAt(this.pos++) : -1; },
  },
});
class JWriter extends JObj { s = ""; }
/** every Writer overload funnels through the VIRTUAL write(String) so subclasses intercept */
const wr = (w: unknown, s: string) => vcall(w, "write", "(Ljava/lang/String;)V", s);
const chars = (c: Uint16Array): string => charsToString(c, 0, c.length);
rt.register({
  name: "java/io/Writer", ctor: JWriter,
  ifaces: ["java/io/Closeable", "java/io/Flushable", "java/lang/Appendable"],
  methods: {
    "<init>()V": function () {},
    "write(Ljava/lang/String;)V": function (this: JWriter, s: string) { this.s += s; },
    "write(Ljava/lang/String;II)V": function (this: JWriter, s: string, off: number, len: number) { return wr(this, s.substr(off, len)); },
    "write(I)V": function (this: JWriter, c: number) { return wr(this, String.fromCharCode(c & 0xffff)); },
    "write([C)V": function (this: JWriter, c: Uint16Array) { return wr(this, chars(c)); },
    "write([CII)V": function (this: JWriter, c: Uint16Array, off: number, len: number) { return wr(this, chars(c.subarray(off, off + len))); },
    "append(C)Ljava/lang/Appendable;": function (this: JWriter, c: number) { return wr(this, String.fromCharCode(c & 0xffff)).then(() => this); },
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
    "write(Ljava/lang/String;)V": function (this: any, str: string) { return vcall(this.target, "write", "(Ljava/lang/String;)V", str); },
    "newLine()V": function (this: any) { return vcall(this.target, "write", "(Ljava/lang/String;)V", "\n"); },
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
  const w = new (rt.link("java/io/OutputStreamWriter").ctor)();
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
    "write(Ljava/lang/String;)V": function (this: JPrintWriter, s: string) {
      if (this.target === null) { this.s += s; return; }
      return vcall(this.target, "write", "(Ljava/lang/String;)V", s);
    },
    ...printMethods(pw),
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
        const b = new TextEncoder().encode(this.s);
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

class JDataOut extends JOutputStream { sink: JOutputStream | null = null; }
rt.register({
  name: "java/io/DataOutputStream", ctor: JDataOut, sup: "java/io/OutputStream",
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
      const b = new TextEncoder().encode(s);
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

// FileChannel stubs (okio probes them; no real file locking here)
const fileLock = () => new (rt.link("java/nio/channels/FileLock").ctor)();
function fileChannel() { return new (rt.link("java/nio/channels/FileChannel").ctor)(); }
rt.register({
  name: "java/nio/channels/FileChannel", ctor: class extends JObj {},
  methods: {
    "close()V": () => {},
    "size()J": () => 0n,
    "position()J": () => 0n,
    "force(Z)V": () => {},
    "tryLock()Ljava/nio/channels/FileLock;": fileLock,
    "lock()Ljava/nio/channels/FileLock;": fileLock,
  },
});
rt.register({
  name: "java/nio/channels/FileLock", ctor: class extends JObj {},
  methods: { "release()V": () => {}, "close()V": () => {}, "isValid()Z": () => 1 },
});

// FileChannel.MapMode: three singletons with a name — no map() backs them (see the FileChannel stub above).
mkEnumSet("java/nio/channels/FileChannel$MapMode", ["READ_ONLY", "READ_WRITE", "PRIVATE"]);

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
rt.register({ name: "java/nio/file/CopyOption", ctor: class extends JObj {} });
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
    "static createDirectories(Ljava/nio/file/Path;[Ljava/nio/file/attribute/FileAttribute;)Ljava/nio/file/Path;": (p: JNioPath) => { dirs.add(p.p); return p; },
    "static size(Ljava/nio/file/Path;)J": (p: JNioPath) => BigInt(vfs.read(p.p)?.length ?? 0),
    "static readAttributes(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;": (p: JNioPath) => {
      const a = new JBasicAttrs();
      a.sz = vfs.read(p.p)?.length ?? 0;
      a.dir = vfs.isDir(p.p);
      return a;
    },
    "static isDirectory(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.isDir(p.p) ? 1 : 0),
    "static isRegularFile(Ljava/nio/file/Path;[Ljava/nio/file/LinkOption;)Z": (p: JNioPath) => (vfs.files.has(p.p) ? 1 : 0),
    "static readAllBytes(Ljava/nio/file/Path;)[B": (p: JNioPath) => {
      const d = vfs.read(p.p) ?? new Uint8Array(0);
      return new Int8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.length));
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
rt.register({ name: "java/nio/file/attribute/BasicFileAttributes", ctor: class extends JObj {} });
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
