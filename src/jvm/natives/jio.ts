// java.io.* natives and the VFS shared with native file descriptors.

import { rt, JObj, type NativeSpec, type ClassInfo, driven, declaredField, type Gen } from "../runtime";
import { mangleField, charsToString, utf8, concat, i8 } from "../abi";
import { vcall, vcallOn, curThread, after, newObj, checkFromIndexSize } from "./jlang";
import { E, ERRSTR } from "../../native/abi";
import { readFully, writable } from "../../shell/lazyfile";
import { vfs } from "../../shell/vfs";
import { isExternal, mapExternal, memoryAt, unmapExternal } from "./jmemory";
import { mem } from "../../native/mem";
import { syncShared, trackSharedMap } from "../../native/mappings";
import { javaCloseFd, javaSeekFd, javaFdSource, javaReadFd, javaPreadFd, javaWriteFd, javaPwriteFd, javaTruncateFd, javaIsSocketFd, javaFcntlFd, javaSyncFd, javaFdStat, javaIoctlIntFd, fdFile, inoOf } from "../../native/stdio";

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
/** jniCreateFileDescriptor: a `new FileDescriptor()` given `fd` through setInt$, which also
 *  records whether it appends */
export function mkFd(fd: number): JObj | Promise<JObj> {
  const thread = curThread, info = rt.link(FILE_DESCRIPTOR), init = rt.initClass(info);
  const make = () => {
    const d = new info.ctor() as JObj;
    return after(vcallOn(thread, d, "<init>", "()V"), () => after(vcallOn(thread, d, "setInt$", "(I)V", fd), () => d));
  };
  return init ? init.then(make) : make();
}
rt.registerJni("java/io/FileDescriptor", "isSocket(I)Z", (fd: number) => +javaIsSocketFd(fd));
// OpenJDK tests the bits of F_GETFL's result as is, so a failure reads as appending
rt.registerJni("java/io/FileDescriptor", "getAppend(I)Z", (fd: number) => +((javaFcntlFd(fd, 3 /* F_GETFL */, 0) & O_APPEND) !== 0));
// the bytes are already in the VFS; a sync is what asks for them to persist now
rt.registerJni("java/io/FileDescriptor", "sync()V", function (this: JObj) {
  if (javaSyncFd(fdInt(this)) < 0) throw rt.mkThrowable("java/io/SyncFailedException", "sync failed");
  return vfs.flush();
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
rt.registerJnis("java/io/FileInputStream", fisNatives);


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

// ── sun.nio.ch's file natives (FileDispatcherImpl.c, FileChannelImpl.c, FileKey.c, IOUtil.c,
// NativeThread.c) under libcore's FileChannelImpl. The socket side of sun.nio.ch is not here.
const IOS_EOF = -1, IOS_UNAVAILABLE = -2, IOS_INTERRUPTED = -3, IOS_UNSUPPORTED = -4;
/** convertReturnVal: a count, EOF on a zero-byte read, or an IOException with the errno's text */
function ioStatus(n: number, reading: boolean): number {
  if (n > 0) return n;
  if (n === 0) return reading ? IOS_EOF : 0;
  if (n === -E.AGAIN) return IOS_UNAVAILABLE;
  if (n === -E.INTR) return IOS_INTERRUPTED;
  return lastError(n, reading ? "Read failed" : "Write failed");
}
const physical = (address: bigint) => mem.txVa(BigInt.asUintN(64, address));
/** a read into native memory: the bytes land once it completes, since guest memory may move meanwhile */
function readInto(address: bigint, len: number, read: (target: Uint8Array) => number | Promise<number>): number | Promise<number> {
  const scratch = new Uint8Array(len);
  return after(read(scratch), (n) => { if (n > 0) mem.write(physical(address), scratch.subarray(0, n)); return ioStatus(n, true); });
}
/** a pread/pwrite offset: past what a file here can reach, EINVAL as the kernel reports an off_t overflow */
function offset(position: bigint, len: number): number {
  if (position + BigInt(len) > BigInt(Number.MAX_SAFE_INTEGER)) lastError(-E.INVAL, null);
  return Number(position);
}
/** the descriptor a FileDescriptor holds, or EBADF's IOException */
function openFd(d: JObj | null): number {
  const fd = fdInt(d);
  if (fd < 0) lastError(-E.BADF, null);
  return fd;
}
rt.registerJnis("sun/nio/ch/FileDispatcherImpl", {
  "read0(Ljava/io/FileDescriptor;JI)I": (d: JObj, address: bigint, len: number) => readInto(address, len, (t) => javaReadFd(openFd(d), t)),
  "pread0(Ljava/io/FileDescriptor;JIJ)I": (d: JObj, address: bigint, len: number, position: bigint) =>
    readInto(address, len, (t) => javaPreadFd(openFd(d), t, offset(position, len))),
  "write0(Ljava/io/FileDescriptor;JI)I": (d: JObj, address: bigint, len: number) =>
    after(memoryAt(address, len), (bytes) => ioStatus(javaWriteFd(openFd(d), bytes), false)),
  "pwrite0(Ljava/io/FileDescriptor;JIJ)I": (d: JObj, address: bigint, len: number, position: bigint) =>
    after(memoryAt(address, len), (bytes) => ioStatus(javaPwriteFd(openFd(d), bytes, offset(position, len)), false)),
  // readv/writev over IOVecWrapper's iovecs: {base, len}, each as wide as Unsafe.addressSize (4)
  "readv0(Ljava/io/FileDescriptor;JI)J": driven(function* (d: JObj, iov: bigint, count: number): Gen {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const at = physical(iov) + i * 8, base = mem.ld32(at) >>> 0, len = mem.ld32(at + 4) >>> 0, scratch = new Uint8Array(len);
      const n: number = yield javaReadFd(openFd(d), scratch);
      if (n < 0) { if (total) break; return BigInt(ioStatus(n, true)); }
      mem.write(base, scratch.subarray(0, n));
      total += n;
      if (n < len) break;
    }
    return BigInt(total || IOS_EOF);
  }),
  "writev0(Ljava/io/FileDescriptor;JI)J": (d: JObj, iov: bigint, count: number) => {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const at = physical(iov) + i * 8, base = mem.ld32(at) >>> 0, len = mem.ld32(at + 4) >>> 0;
      const n = javaWriteFd(openFd(d), mem.bytes(base, len));
      if (n < 0) { if (total) break; return BigInt(ioStatus(n, false)); }
      total += n;
      if (n < len) break;
    }
    return BigInt(total);
  },
  "force0(Ljava/io/FileDescriptor;Z)I": (d: JObj) => {
    lastError(javaSyncFd(openFd(d)), "Force failed");
    return after(vfs.flush(), () => 0);
  },
  "truncate0(Ljava/io/FileDescriptor;J)I": (d: JObj, size: bigint) => { lastError(javaTruncateFd(openFd(d), Number(size)), "Truncation failed"); return 0; },
  "size0(Ljava/io/FileDescriptor;)J": (d: JObj) => {
    const st = javaFdStat(openFd(d));
    return BigInt(st ? st.size : lastError(-E.BADF, "Size failed"));
  },
  // one process holds every lock of a file here, which FileLockTable already arbitrates
  "lock0(Ljava/io/FileDescriptor;ZJJZ)I": (d: JObj) => { openFd(d); return 0 /* LOCKED */; },
  "release0(Ljava/io/FileDescriptor;JJ)V": (d: JObj) => { openFd(d); },
  "preClose0(Ljava/io/FileDescriptor;)V": () => {},
  "close0(Ljava/io/FileDescriptor;)V": (d: JObj) => { const fd = fdInt(d); if (fd >= 0) lastError(javaCloseFd(fd), "Close failed"); },
  "closeIntFD(I)V": (fd: number) => { lastError(javaCloseFd(fd), "Close failed"); },
});
const MAP_RO = 0, MAP_PV = 2;
let channelFd: string | undefined;
rt.registerJnis("sun/nio/ch/FileChannelImpl", {
  "initIDs()J": () => 4096n,
  "position0(Ljava/io/FileDescriptor;J)J": (d: JObj, offset: bigint) =>
    BigInt(lastError(offset < 0n ? javaSeekFd(openFd(d), 0, 1) : javaSeekFd(openFd(d), Number(offset), 0), "Position failed")),
  // sendfile is not offered: FileChannelImpl copies through buffers instead
  "transferTo0(Ljava/io/FileDescriptor;JJLjava/io/FileDescriptor;)J": () => BigInt(IOS_UNSUPPORTED),
  // An immutable file maps read-only outside guest memory, paged in as read; any other mapping is
  // guest memory holding the file's bytes, a shared one kept coherent with the file (mappings.ts)
  "map0(IJJ)J": function (this: JObj, prot: number, position: bigint, length: bigint) {
    const fd = openFd((this as unknown as Record<string, JObj>)[channelFd ??= declaredField("sun/nio/ch/FileChannelImpl", "fd")]);
    const file = fdFile(fd), source = file?.source ?? javaFdSource(fd), start = Number(position), n = Number(length);
    if (!source) return BigInt(lastError(-E.INVAL, "Map failed"));
    if (prot === MAP_RO && file?.source && !writable(file.source)) return mapExternal(file.source, start, n);
    return after(readFully(source, start, n), (bytes) => {
      const va = mem.mapVa(n, false);
      if (!va) throw rt.mkThrowable("java/lang/OutOfMemoryError", "Map failed");
      mem.write(mem.txVa(BigInt(va)), bytes);
      if (file && prot !== MAP_PV) trackSharedMap(BigInt(va), n, start, file, prot !== MAP_RO);
      return BigInt(va);
    });
  },
  "unmap0(JJ)I": (address: bigint, length: bigint) => {
    if (isExternal(address)) unmapExternal(address);
    else { syncShared(address, Number(length), true); mem.unmapVa(address, Number(length)); }
    return 0;
  },
});
rt.registerJni("sun/nio/ch/FileKey", "init(Ljava/io/FileDescriptor;)V", function (this: JObj, d: JObj) {
  const st = javaFdStat(openFd(d)), o = this as unknown as Record<string, bigint>;
  o[declaredField("sun/nio/ch/FileKey", "st_dev")] = 1n;
  o[declaredField("sun/nio/ch/FileKey", "st_ino")] = BigInt(st?.path ? inoOf(st.path) : openFd(d));
});
rt.registerJnis("sun/nio/ch/IOUtil", {
  "fdVal(Ljava/io/FileDescriptor;)I": (d: JObj) => fdInt(d),
  "setfdVal(Ljava/io/FileDescriptor;I)V": (d: JObj, fd: number) => setFdInt(d, fd),
  "iovMax()I": () => 1024,
  "fdLimit()I": () => 32768,
});
// no thread here blocks in the kernel, so there is none to signal out of a blocking call
rt.registerJnis("sun/nio/ch/NativeThread", { "current()J": () => 0n, "signal(J)V": () => {} });

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

// java.io serialization's natives: ObjectStreamClass asks whether a class has a static initializer
// (the default serialVersionUID hashes it), and the object streams convert float and double
// arrays to and from big-endian bytes
const hasClinit = (info: ClassInfo) => info.def
  ? info.def.directMethods.some((m) => info.dex!.method(m.methodIdx).name === "<clinit>")
  : !!rt.natives.get(info.name)?.methods?.["<clinit>()V"];
function floatBytes(size: 4 | 8) {
  const view = new DataView(new ArrayBuffer(8));
  return {
    toBytes: (src: Float32Array | Float64Array, from: number, dst: Int8Array, at: number, n: number) => {
      for (let i = 0; i < n; i++, at += size) {
        if (size === 4) view.setFloat32(0, src[from + i]); else view.setFloat64(0, src[from + i]);
        for (let b = 0; b < size; b++) dst[at + b] = view.getInt8(b);
      }
    },
    fromBytes: (src: Int8Array, at: number, dst: Float32Array | Float64Array, to: number, n: number) => {
      for (let i = 0; i < n; i++, at += size) {
        for (let b = 0; b < size; b++) view.setInt8(b, src[at + b]);
        dst[to + i] = size === 4 ? view.getFloat32(0) : view.getFloat64(0);
      }
    },
  };
}
const F4 = floatBytes(4), F8 = floatBytes(8);
rt.registerJnis("java/io/ObjectStreamClass", {
  "hasStaticInitializer(Ljava/lang/Class;Z)Z": (cls: { ci?: ClassInfo }, inherit: number) => {
    for (let info = cls.ci ?? null; info; info = inherit ? info.superInfo : null) if (hasClinit(info)) return 1;
    return 0;
  },
});
rt.registerJnis("java/io/ObjectOutputStream", { "floatsToBytes([FI[BII)V": F4.toBytes, "doublesToBytes([DI[BII)V": F8.toBytes });
rt.registerJnis("java/io/ObjectInputStream", { "bytesToFloats([BI[FII)V": F4.fromBytes, "bytesToDoubles([BI[DII)V": F8.fromBytes });
