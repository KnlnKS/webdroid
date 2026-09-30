// java.io.* natives and the VFS shared with native file descriptors.

import { rt, JObj, type NativeSpec, type ClassInfo, driven, declaredField, type Gen } from "../runtime";
import { mangleField, concat, i8 } from "../abi";
import { vcall, vcallOn, curThread, after, newObj, checkFromIndexSize } from "./jlang";
import { E, ERRSTR } from "../../native/abi";
import { readFully, writable } from "../../shell/lazyfile";
import { vfs } from "../../shell/vfs";
import { isExternal, mapExternal, memoryAt, unmapExternal } from "./jmemory";
import { mem } from "../../native/mem";
import { syncShared, trackSharedMap } from "../../native/mappings";
import { javaCloseFd, javaSeekFd, javaFdSource, javaReadFd, javaPreadFd, javaWriteFd, javaPwriteFd, javaTruncateFd, javaIsSocketFd, javaFcntlFd, javaSyncFd, javaFdStat, javaIoctlIntFd, fdFile, inoOf } from "../../native/stdio";



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
