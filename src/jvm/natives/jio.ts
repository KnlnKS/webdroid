// java.io.* natives and the VFS shared with native file descriptors.

import { rt, JObj, type NativeSpec, driven, declaredField, type Gen } from "../runtime";
import { mangleField, charsToString, utf8, concat, i8, u8 } from "../abi";
import { vcall, vcallOn, curThread, after, mkEnumSet, newObj, defineException, type JSimpleEnum, checkFromIndexSize } from "./jlang";
import { E, ERRSTR } from "../../native/abi";
import { readFully, writable } from "../../shell/lazyfile";
import { vfs } from "../../shell/vfs";
import { mappedBuffer, mappedReadOnlyBuffer, pagedMapping, mkByteBuffer, remainingBytes, resident, type JBuffer } from "./jnio";
import { javaCloseFd, javaSeekFd, javaFdSource, javaReadFd, javaPreadFd, javaWriteFd, javaPwriteFd, javaTruncateFd, javaIsSocketFd, javaFcntlFd, javaSyncFd, javaFdStat, javaIoctlIntFd, fdFile } from "../../native/stdio";

rt.register({ name: "java/io/Externalizable", ctor: class extends JObj {}, ifaces: ["java/io/Serializable"] });


/** a java.io.File's path as the VFS names it (libcore's File resolves a relative one against "/") */
export const pathOf = (file: JObj): string => vfs.norm(vcall(file, "getPath", "()Ljava/lang/String;"));
/** `new File(path)` */
export const newFile = (path: string): Promise<JObj> => newObj("java/io/File", "(Ljava/lang/String;)V", path);

// the stream a TS subclass of FilterInputStream or FilterOutputStream wraps
const FILTER_IN = mangleField("java/io/FilterInputStream", "in"), FILTER_OUT = mangleField("java/io/FilterOutputStream", "out");
type Fields = Record<string, unknown>;
export const filterIn = (s: object): unknown => (s as Fields)[FILTER_IN];
export const filterOut = (s: object): unknown => (s as Fields)[FILTER_OUT];
export const setFilterIn = (s: object, stream: unknown): void => { (s as Fields)[FILTER_IN] = stream; };
export const setFilterOut = (s: object, stream: unknown): void => { (s as Fields)[FILTER_OUT] = stream; };
const BAIS = "java/io/ByteArrayInputStream", BAOS = "java/io/ByteArrayOutputStream";
/** `new ByteArrayInputStream(bytes)`, sharing them; the class has no <clinit>, so this is synchronous */
export function streamOf(bytes: Uint8Array): JObj {
  const info = rt.link(BAIS);
  rt.initClass(info);
  const s = new info.ctor() as Record<string, unknown>;
  s[declaredField(BAIS, "buf")] = i8(bytes);
  s[declaredField(BAIS, "count")] = bytes.length;
  return s as unknown as JObj;
}
/** the bytes a ByteArrayOutputStream holds, without copying */
export function baosBytes(s: JObj): Uint8Array {
  const o = s as unknown as Record<string, Int8Array | number>;
  const buf = o[declaredField(BAOS, "buf")] as Int8Array;
  return new Uint8Array(buf.buffer, buf.byteOffset, o[declaredField(BAOS, "count")] as number);
}
/** InputStream's reads over bytes a TS stream holds in `buf` from `pos` */
interface HeldBytes { buf: Uint8Array; pos: number }
export const heldByteReads: NativeSpec["methods"] = {
  "read()I": function (this: HeldBytes) { return this.pos < this.buf.length ? this.buf[this.pos++] : -1; },
  "read([BII)I": function (this: HeldBytes, out: Int8Array, off: number, len: number) {
    if (!out) rt.npe();
    checkFromIndexSize(off, len, out.length);
    if (len === 0) return 0;
    if (this.pos >= this.buf.length) return -1;
    const n = Math.min(len, this.buf.length - this.pos);
    out.set(i8(this.buf, this.pos, n), off);
    this.pos += n;
    return n;
  },
  "available()I": function (this: HeldBytes) { return this.buf.length - this.pos; },
  "skip(J)J": function (this: HeldBytes, n: bigint) {
    const k = n <= 0n ? 0 : Math.min(Number(n), this.buf.length - this.pos);
    this.pos += k;
    return BigInt(k);
  },
};
/** OutputStream's writes into bytes a TS stream collects in `chunks` */
interface HeldWrites { chunks: number[] }
export const heldByteWrites: NativeSpec["methods"] = {
  "write(I)V": function (this: HeldWrites, b: number) { this.chunks.push(b & 0xff); },
  "write([BII)V": function (this: HeldWrites, b: Int8Array, off: number, len: number) {
    if (!b) rt.npe();
    checkFromIndexSize(off, len, b.length);
    for (let i = 0; i < len; i++) this.chunks.push(b[off + i] & 0xff);
  },
};
/** every byte an InputStream has left, through its virtual read */
export async function readStreamFully(s: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const tmp = new Int8Array(1 << 16);
  for (;;) {
    const n = await vcall(s, "read", "([BII)I", tmp, 0, tmp.length) as number;
    if (n <= 0) break;
    chunks.push(new Uint8Array(tmp.buffer.slice(0, n)));
  }
  return concat(chunks);
}


const FILE_DESCRIPTOR = "java/io/FileDescriptor", O_APPEND = 0x400;
/** a FileDescriptor's int, -1 for none (JNIHelp's jniGetFDFromFileDescriptor) */
let descriptorProp: string | undefined;
const descriptor = () => descriptorProp ??= declaredField(FILE_DESCRIPTOR, "descriptor");
export const fdInt = (d: JObj | null): number => d ? (d as unknown as Record<string, number>)[descriptor()] : -1;
export function setFdInt(d: JObj, fd: number): void { (d as unknown as Record<string, number>)[descriptor()] = fd; }
/** jniCreateFileDescriptor: a `new FileDescriptor()` holding `fd` */
export function mkFd(fd: number): JObj | Promise<JObj> {
  const thread = curThread, info = rt.link(FILE_DESCRIPTOR), init = rt.initClass(info);
  const make = () => {
    const d = new info.ctor() as JObj;
    return after(vcallOn(thread, d, "<init>", "()V"), () => { setFdInt(d, fd); return d; });
  };
  return init ? init.then(make) : make();
}
rt.registerJni("java/io/FileDescriptor", "isSocket(I)Z", (fd: number) => +javaIsSocketFd(fd));
// OpenJDK tests the bits of F_GETFL's result as is, so a failure reads as appending
rt.registerJni("java/io/FileDescriptor", "getAppend(I)Z", (fd: number) => +((javaFcntlFd(fd, 3 /* F_GETFL */, 0) & O_APPEND) !== 0));
rt.registerJni("java/io/FileDescriptor", "sync()V", function (this: JObj) {
  if (javaSyncFd(fdInt(this)) < 0) throw rt.mkThrowable("java/io/SyncFailedException", "sync failed");
});
/** OpenJDK's FileInputStream natives (io_util_md.c) over the stream's descriptor */
function streamFd(stream: JObj): number {
  const fd = fdInt((stream as unknown as Record<string, JObj | null>)[declaredField("java/io/FileInputStream", "fd")]);
  if (fd < 0) throw rt.mkThrowable("java/io/IOException", "Stream Closed");
  return fd;
}
/** JNU_ThrowIOExceptionWithLastError: the errno's text, else the caller's detail */
function lastError(result: number, detail: string | null): number {
  if (result < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-result] ?? detail);
  return result;
}
const S_IFMT = 0o170000, S_IFCHR = 0o020000, S_IFIFO = 0o010000, S_IFSOCK = 0o140000, FIONREAD = 0x541b;
const fisNatives: Record<string, (this: JObj, ...args: never[]) => unknown> = {
  // a character device, FIFO or socket answers FIONREAD; anything else, the distance to its end
  "available0()I": function () {
    const fd = streamFd(this), type = (javaFdStat(fd)?.mode ?? 0) & S_IFMT;
    if (type === S_IFCHR || type === S_IFIFO || type === S_IFSOCK) {
      const n = javaIoctlIntFd(fd, FIONREAD);
      if (n >= 0) return n;
    }
    const cur = lastError(javaSeekFd(fd, 0, 1), null), end = lastError(javaSeekFd(fd, 0, 2), null);
    lastError(javaSeekFd(fd, cur, 0), null);
    return Math.max(0, Math.min(0x7fffffff, end - cur));
  },
  "length0()J": function () {
    const st = javaFdStat(streamFd(this));
    if (!st) lastError(-E.BADF, "GetLength failed");
    return BigInt(st!.size);
  },
  "position0()J": function () { return BigInt(lastError(javaSeekFd(streamFd(this), 0, 1), "Seek failed")); },
  "skip0(J)J": function (n: bigint) {
    const fd = streamFd(this), cur = javaSeekFd(fd, 0, 1);
    if (cur === -E.SPIPE) throw rt.mkThrowable("java/io/FileInputStream$UseManualSkipException", null);
    lastError(cur, "Seek error");
    return BigInt(lastError(javaSeekFd(fd, Number(n), 1), "Seek error") - cur);
  },
};
for (const [sig, fn] of Object.entries(fisNatives)) rt.registerJni("java/io/FileInputStream", sig, fn);


// BufferedReader stays TS over libcore's Reader: compiled bytecode scans a line at about 3.5 ns a
// char and builds it from a char[], 2.3x this model's time for readLine over 1 MB. Here each chunk of
// the wrapped Reader becomes one string, and lines are slices of it. The semantics are libcore's:
// \n, \r and \r\n end a line, skipLF carries a trailing \r's pending \n across calls, and a mark
// holds the text back until reading passes its read-ahead limit.
const UNMARKED = -1, INVALIDATED = -2, LF = 10, CR = 13;
class JBufferedReader extends JObj {
  in: unknown = null;
  size = 8192;
  s = "";
  pos = 0;
  markPos = UNMARKED;
  markLimit = 0;
  skipLF = false;
  markedSkipLF = false;
}
function openReader(r: JBufferedReader): unknown {
  if (r.in === null) throw rt.mkThrowable("java/io/IOException", "Stream closed");
  return r.in;
}
/** one read of the wrapped Reader into the text; false at its end */
function fillReader(r: JBufferedReader): boolean | Promise<boolean> {
  if (r.markPos < 0) { r.s = r.s.slice(r.pos); r.pos = 0; }
  else if (r.pos - r.markPos >= r.markLimit) { r.markPos = INVALIDATED; r.markLimit = 0; r.s = r.s.slice(r.pos); r.pos = 0; }
  else { r.s = r.s.slice(r.markPos); r.pos -= r.markPos; r.markPos = 0; }
  const chunk = new Uint16Array(r.size), thread = curThread;
  const step = (n: number): boolean | Promise<boolean> => {
    if (n > 0) { r.s += charsToString(chunk, 0, n); return true; }
    if (n < 0) return false;
    return after(vcallOn(thread, r.in, "read", "([CII)I", chunk, 0, chunk.length) as number | Promise<number>, step);
  };
  return after(vcallOn(thread, r.in, "read", "([CII)I", chunk, 0, chunk.length) as number | Promise<number>, step);
}
function readerLine(r: JBufferedReader, ignoreLF: boolean): string | null | Promise<string | null> {
  openReader(r);
  let line: string | null = null, omitLF = ignoreLF || r.skipLF;
  const step = (): string | null | Promise<string | null> => {
    for (;;) {
      if (r.pos >= r.s.length) {
        const got = fillReader(r);
        if (got instanceof Promise) return got.then((more) => more ? step() : line !== null && line.length > 0 ? line : null);
        if (!got) return line !== null && line.length > 0 ? line : null;
      }
      const s = r.s;
      if (omitLF && s.charCodeAt(r.pos) === LF) r.pos++;
      r.skipLF = false; omitLF = false;
      let i = r.pos, c = 0;
      for (; i < s.length; i++) if ((c = s.charCodeAt(i)) === LF || c === CR) break;
      const part = s.slice(r.pos, i);
      line = line === null ? part : line + part;
      if (i < s.length) {
        r.pos = i + 1;
        if (c === CR) r.skipLF = true;
        return line;
      }
      r.pos = i;
    }
  };
  return step();
}
/** the next char after a pending \n is dropped, or -1 at the end */
function readerChar(r: JBufferedReader): number | Promise<number> {
  openReader(r);
  for (;;) {
    if (r.pos >= r.s.length) {
      const got = fillReader(r);
      if (got instanceof Promise) return got.then((more) => more ? readerChar(r) : -1);
      if (!got) return -1;
    }
    if (r.skipLF) { r.skipLF = false; if (r.s.charCodeAt(r.pos) === LF) { r.pos++; continue; } }
    return r.s.charCodeAt(r.pos++);
  }
}
/** BufferedReader.read1: from the text, or straight from the wrapped Reader for a large read */
function readerChunk(r: JBufferedReader, out: Uint16Array, off: number, len: number): number | Promise<number> {
  if (r.pos >= r.s.length) {
    if (len >= r.size && r.markPos <= UNMARKED && !r.skipLF) return vcall(r.in, "read", "([CII)I", out, off, len);
    const got = fillReader(r);
    if (got instanceof Promise) return got.then((more) => more ? readerChunk(r, out, off, len) : -1);
    if (!got) return -1;
  }
  if (r.skipLF) {
    r.skipLF = false;
    if (r.s.charCodeAt(r.pos) === LF) { r.pos++; return readerChunk(r, out, off, len); }
  }
  const n = Math.min(len, r.s.length - r.pos), s = r.s, from = r.pos;
  for (let i = 0; i < n; i++) out[off + i] = s.charCodeAt(from + i);
  r.pos += n;
  return n;
}
const bufferReader = function (this: JBufferedReader, input: unknown, size = 8192) {
  if (input === null) rt.npe();
  if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size <= 0");
  (this as unknown as Record<string, unknown>)[declaredField("java/io/Reader", "lock")] = input;
  this.in = input; this.size = size;
};
rt.register({
  name: "java/io/BufferedReader", ctor: JBufferedReader, sup: "java/io/Reader",
  methods: {
    "<init>(Ljava/io/Reader;)V": bufferReader,
    "<init>(Ljava/io/Reader;I)V": bufferReader,
    "read()I": function (this: JBufferedReader) { return readerChar(this); },
    "read([CII)I": driven(function* (this: JBufferedReader, out: Uint16Array, off: number, len: number): Gen {
      const thread = curThread;
      openReader(this);
      if (!out) rt.npe();
      checkFromIndexSize(off, len, out.length);
      if (!len) return 0;
      let n: number = yield readerChunk(this, out, off, len);
      if (n <= 0) return n;
      while (n < len && (yield vcallOn(thread, this.in, "ready", "()Z"))) {
        const more: number = yield readerChunk(this, out, off + n, len - n);
        if (more <= 0) break;
        n += more;
      }
      return n;
    }),
    // Reader's own methods: this class's JS prototype does not reach the platform Reader's
    "read([C)I": function (this: JBufferedReader, out: Uint16Array) {
      if (!out) rt.npe();
      return vcall(this, "read", "([CII)I", out, 0, out.length);
    },
    "read(Ljava/nio/CharBuffer;)I": driven(function* (this: JBufferedReader, target: JObj): Gen {
      const thread = curThread, chars = new Uint16Array(yield vcallOn(thread, target, "remaining", "()I"));
      const n: number = yield vcallOn(thread, this, "read", "([CII)I", chars, 0, chars.length);
      if (n > 0) yield vcallOn(thread, target, "put", "([CII)Ljava/nio/CharBuffer;", chars, 0, n);
      return n;
    }),
    "transferTo(Ljava/io/Writer;)J": driven(function* (this: JBufferedReader, out: unknown): Gen {
      if (out === null) rt.npe();
      const thread = curThread, chars = new Uint16Array(8192);
      let total = 0n;
      for (let n: number; (n = yield vcallOn(thread, this, "read", "([CII)I", chars, 0, chars.length)) >= 0;) {
        yield vcallOn(thread, out, "write", "([CII)V", chars, 0, n);
        total += BigInt(n);
      }
      return total;
    }),
    "readLine()Ljava/lang/String;": function (this: JBufferedReader) { return readerLine(this, false); },
    "readLine(Z)Ljava/lang/String;": function (this: JBufferedReader, ignoreLF: number) { return readerLine(this, !!ignoreLF); },
    "skip(J)J": driven(function* (this: JBufferedReader, count: bigint): Gen {
      if (count < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "skip value is negative");
      openReader(this);
      let left = count;
      while (left > 0n) {
        if (this.pos >= this.s.length && !(yield fillReader(this))) break;
        if (this.skipLF) { this.skipLF = false; if (this.s.charCodeAt(this.pos) === LF) this.pos++; }
        const available = BigInt(this.s.length - this.pos);
        if (left <= available) { this.pos += Number(left); left = 0n; break; }
        left -= available; this.pos = this.s.length;
      }
      return count - left;
    }),
    "ready()Z": driven(function* (this: JBufferedReader): Gen {
      const thread = curThread, input = openReader(this);
      if (this.skipLF) {
        if (this.pos >= this.s.length && (yield vcallOn(thread, input, "ready", "()Z"))) yield fillReader(this);
        if (this.pos < this.s.length) { if (this.s.charCodeAt(this.pos) === LF) this.pos++; this.skipLF = false; }
      }
      return this.pos < this.s.length ? 1 : (yield vcallOn(thread, input, "ready", "()Z"));
    }),
    "markSupported()Z": () => 1,
    "mark(I)V": function (this: JBufferedReader, limit: number) {
      if (limit < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Read-ahead limit < 0");
      openReader(this);
      this.markLimit = limit; this.markPos = this.pos; this.markedSkipLF = this.skipLF;
    },
    "reset()V": function (this: JBufferedReader) {
      openReader(this);
      if (this.markPos < 0) throw rt.mkThrowable("java/io/IOException", this.markPos === INVALIDATED ? "Mark invalid" : "Stream not marked");
      this.pos = this.markPos; this.skipLF = this.markedSkipLF;
    },
    "close()V": function (this: JBufferedReader) {
      const input = this.in;
      if (input === null) return;
      this.in = null; this.s = "";
      return vcall(input, "close", "()V");
    },
  },
});

// sun.nio.ch.FileChannelImpl over its stream's descriptor. libcore's needs NIO internals the TS
// FileChannel lacks (AbstractInterruptibleChannel state, NativeThreadSet, address-based
// dispatcher natives). Locks are advisory.
const fileLock = () => rt.make("java/nio/channels/FileLock");
class JFileChannel extends JObj {
  fd: JObj | null = null;
  parent: JObj | null = null;
  readable = false;
  writable = false;
  open = true;
  opened(): number {
    if (!this.open) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
    return fdInt(this.fd);
  }
  reading(): number {
    const fd = this.opened();
    if (!this.readable) throw rt.mkThrowable("java/nio/channels/NonReadableChannelException", null);
    return fd;
  }
  writing(): number {
    const fd = this.opened();
    if (!this.writable) throw rt.mkThrowable("java/nio/channels/NonWritableChannelException", null);
    return fd;
  }
}
const fdSize = (fd: number): number => javaFdStat(fd)?.size ?? lastError(-E.BADF, null);
function channelRead(channel: JFileChannel, dst: JBuffer, position = -1): number | Promise<number> {
  const fd = channel.reading(), len = dst.lim - dst.pos;
  if (len === 0) return 0;
  dst.clampPut(0);
  const view = u8(remainingBytes(dst));
  return after(position < 0 ? javaReadFd(fd, view) : javaPreadFd(fd, view, position), (n) => {
    if (!lastError(n, null)) return -1;
    dst.pos += n;
    return n;
  });
}
function channelWrite(channel: JFileChannel, src: JBuffer, position = -1): number | Promise<number> {
  if (!src) throw rt.mkThrowable("java/lang/NullPointerException", "src");
  const fd = channel.writing();
  if (src.lim === src.pos) return 0;
  return after(resident(src), () => {
    const bytes = u8(remainingBytes(src));
    const n = lastError(position < 0 ? javaWriteFd(fd, bytes) : javaPwriteFd(fd, bytes, position), null);
    src.pos += n;
    return n;
  });
}
rt.register({ name: "java/nio/channels/FileChannel", ctor: class extends JObj {} });
rt.register({
  name: "sun/nio/ch/FileChannelImpl", ctor: JFileChannel, sup: "java/nio/channels/FileChannel",
  methods: {
    "static open(Ljava/io/FileDescriptor;Ljava/lang/String;ZZLjava/lang/Object;)Ljava/nio/channels/FileChannel;":
      (fd: JObj, _path: string | null, readable: number, writable: number, parent: JObj | null) =>
        Object.assign(rt.make("sun/nio/ch/FileChannelImpl") as JFileChannel, { fd, parent, readable: !!readable, writable: !!writable }),
    // AbstractInterruptibleChannel.close: closed first, so the parent stream's close finds it so
    "close()V": function (this: JFileChannel) {
      if (!this.open) return;
      this.open = false;
      if (this.parent) return vcall(this.parent, "close", "()V");
      const fd = fdInt(this.fd);
      if (fd >= 0) { setFdInt(this.fd!, -1); javaCloseFd(fd); }
    },
    "isOpen()Z": function (this: JFileChannel) { return +this.open; },
    "size()J": function (this: JFileChannel) { return BigInt(fdSize(this.opened())); },
    "truncate(J)Ljava/nio/channels/FileChannel;": function (this: JFileChannel, size: bigint) {
      const fd = this.opened();
      if (size < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Negative size");
      if (!this.writable) throw rt.mkThrowable("java/nio/channels/NonWritableChannelException", null);
      if (size < BigInt(fdSize(fd))) lastError(javaTruncateFd(fd, Number(size)), null);
      if (BigInt(lastError(javaSeekFd(fd, 0, 1), null)) > size) lastError(javaSeekFd(fd, Number(size), 0), null);
      return this;
    },
    // an appending channel's position is the file's end
    "position()J": function (this: JFileChannel) {
      const fd = this.opened();
      return BigInt(javaFcntlFd(fd, 3 /* F_GETFL */, 0) & O_APPEND ? fdSize(fd) : lastError(javaSeekFd(fd, 0, 1), null));
    },
    "position(J)Ljava/nio/channels/FileChannel;": function (this: JFileChannel, position: bigint) {
      const fd = this.opened();
      if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position");
      lastError(javaSeekFd(fd, Number(position), 0), null);
      return this;
    },
    "map(Ljava/nio/channels/FileChannel$MapMode;JJ)Ljava/nio/MappedByteBuffer;": function (this: JFileChannel, mode: JSimpleEnum | null, position: bigint, size: bigint) {
      const fd = this.opened();
      if (!mode) return rt.npe();
      if (position < 0n || size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position/size");
      if (mode.ename !== "READ_ONLY" && !this.writable) throw rt.mkThrowable("java/nio/channels/NonWritableChannelException", null);
      if (!this.readable) throw rt.mkThrowable("java/nio/channels/NonReadableChannelException", null);
      const start = Number(position), length = Number(size), file = fdFile(fd), source = javaFdSource(fd);
      if (!source) return lastError(-E.INVAL, null);
      if (mode.ename === "READ_ONLY") {
        if (start + length > source.size) throw rt.mkThrowable("java/io/IOException", "mapping exceeds file size");
        if (file && !file.source) { vfs.sync(file); return mappedReadOnlyBuffer(file.data.subarray(start, start + length)); }
        // the mapping outlives the descriptor, so it pages from the file's own source
        if (file?.source && !writable(file.source)) return pagedMapping(file.source, start, length);
        return readFully(source, start, length).then(mappedReadOnlyBuffer);
      }
      if (!file) return lastError(-E.INVAL, null);
      // a writable mapping past the end extends the file first (FileChannelImpl.map truncates it up to position + size)
      if (start + length > file.len) vfs.resize(file, start + length);
      if (file.source) {
        // a disk-backed file maps a copy of the region, written back when the mapping is forced
        return readFully(file.source, start, length).then((bytes) =>
          mappedBuffer(bytes.slice(), mode.ename === "PRIVATE" ? () => {} : () => vfs.writeAt(file, start, bytes)));
      }
      if (mode.ename === "PRIVATE") return mappedBuffer(file.data.slice(start, start + length), () => {});
      const buffer = mappedBuffer(file.data.subarray(start, start + length), () => vfs.publish(file));
      (file.maps ??= []).push(buffer);
      return buffer;
    },
    "read(Ljava/nio/ByteBuffer;)I": function (this: JFileChannel, dst: JBuffer) { return channelRead(this, dst); },
    "read(Ljava/nio/ByteBuffer;J)I": function (this: JFileChannel, dst: JBuffer, position: bigint) {
      if (position < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Negative position");
      return channelRead(this, dst, Number(position));
    },
    "write(Ljava/nio/ByteBuffer;)I": function (this: JFileChannel, src: JBuffer) { return channelWrite(this, src); },
    "write(Ljava/nio/ByteBuffer;J)I": function (this: JFileChannel, src: JBuffer, position: bigint) {
      if (position < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Negative position");
      return channelWrite(this, src, Number(position));
    },
    "transferTo(JJLjava/nio/channels/WritableByteChannel;)J": driven(function* (this: JFileChannel, position: bigint, count: bigint, target: JObj | null): Gen {
      const fd = this.reading(), thread = curThread;
      if (!target) return rt.npe();
      if (position < 0n || count < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "position/count");
      if (!(yield vcallOn(thread, target, "isOpen", "()Z"))) throw rt.mkThrowable("java/nio/channels/ClosedChannelException", null);
      if (target instanceof JFileChannel) target.writing();
      const available = BigInt(fdSize(fd)) - position;
      const length = Number(count < available ? count : available);
      if (length <= 0) return 0n;
      const buffer = mkByteBuffer(Math.min(length, 65536)), bytes = new Uint8Array(buffer.ab);
      let transferred = 0;
      while (transferred < length) {
        const n = lastError(yield javaPreadFd(this.reading(), bytes.subarray(0, Math.min(length - transferred, bytes.length)), Number(position) + transferred), null);
        if (!n) break;
        buffer.pos = 0; buffer.lim = n;
        const written = Number(yield vcallOn(thread, target, "write", "(Ljava/nio/ByteBuffer;)I", buffer));
        transferred += written;
        if (written < n) break;
      }
      return BigInt(transferred);
    }),
    "force(Z)V": function (this: JFileChannel) { this.opened(); },
    "tryLock()Ljava/nio/channels/FileLock;": fileLock,
    "tryLock(JJZ)Ljava/nio/channels/FileLock;": fileLock,
    "lock(JJZ)Ljava/nio/channels/FileLock;": fileLock,
    "lock()Ljava/nio/channels/FileLock;": fileLock,
  },
});
rt.register({
  name: "java/nio/channels/FileLock", ctor: class extends JObj {},
  methods: { "release()V": () => {}, "close()V": function (this: JObj) { return vcall(this, "release", "()V"); }, "isValid()Z": () => 1 },
});

mkEnumSet("java/nio/channels/FileChannel$MapMode", ["READ_ONLY", "READ_WRITE", "PRIVATE"]);
defineException("java/nio/channels/ClosedChannelException", "java/io/IOException");
defineException("java/nio/channels/NonReadableChannelException", "java/lang/IllegalStateException");
defineException("java/nio/channels/NonWritableChannelException", "java/lang/IllegalStateException");

// a file's bytes, decoded as UTF-8
const fileText = driven(function* fileText(p: string): Gen<string> {
  const d: Uint8Array | null = yield vfs.readFile(p);
  if (!d) throw rt.mkThrowable("java/io/FileNotFoundException", p);
  return utf8.dec.decode(d);
});
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
    "<init>(Ljava/io/File;)V": driven(function* (this: JScanner, f: JObj): Gen { this.text = yield fileText(pathOf(f)); }),
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
