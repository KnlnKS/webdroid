// java.io.* natives and the VFS shared with native file descriptors.

import { awaited, rt, type JObj, driven, instanceField, getDeclared, setDeclared, waits, type Gen } from "../runtime.ts";
import { concat } from "../abi.ts";
import { vcall, after, newObj } from "./jentry.ts";
import { E, ERRSTR } from "../../native/abi.ts";
import { readFully, writable } from "../../shell/lazyfile.ts";
import { vfs } from "../../shell/vfs.ts";
import { isExternal, mapRemote, mapExternal, memoryAt, memorySync, unmapExternal, writeAt } from "./jmemory.ts";
import { addressSize } from "./jvmruntime.ts";
import { mem } from "../../native/mem.ts";
import { syncShared, trackSharedMap } from "../../native/mappings.ts";
import { fdFile } from "../../native/fs.ts";
import { remoteOf } from "../../native/process-fd.ts";
import { javaFdSource, javaIsSocketFd, javaCloseFd, javaLseekFd, javaReadFd, javaPreadFd, javaWriteFd,
  javaPwriteFd, javaTruncateFd, javaFcntlFd, javaSyncFd, javaFdStat, javaIoctlIntFd } from "../../native/fd.ts";
import { inoOf } from "../../native/kernel.ts";
import { fdLease, guardJavaDescriptor, unguardJavaDescriptor } from "../../android/fd-scope.ts";

/** a java.io.File's path as the VFS names it (libcore's File resolves a relative one against "/") */
export const pathOf = (file: JObj): string => vfs.norm(vcall(file, "getPath", "()Ljava/lang/String;"));
/** `new File(path)` */
export const newFile = (path: string): JObj | Promise<JObj> => newObj("java/io/File", "(Ljava/lang/String;)V", path);

const BAOS = "java/io/ByteArrayOutputStream";
/** the bytes a ByteArrayOutputStream holds, without copying */
export function baosBytes(s: JObj): Uint8Array {
  const buf = getDeclared<Int8Array>(s, BAOS, "buf");
  return new Uint8Array(buf.buffer, buf.byteOffset, getDeclared<number>(s, BAOS, "count"));
}
/** every byte an InputStream has left, through its virtual read */
export const readStreamFully = driven(function* (s: unknown): Gen<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const tmp = new Int8Array(1 << 16);
  for (;;) {
    const n: number = yield vcall(s, "read", "([BII)I", tmp, 0, tmp.length);
    if (n <= 0) break;
    chunks.push(new Uint8Array(tmp.buffer.slice(0, n)));
  }
  return concat(chunks);
});

/** `bytes` to an OutputStream through the caller's storage array, as CreateJavaOutputStreamAdaptor
 *  writes for Bitmap.compress and PdfDocument.writeTo */
export function* writeThrough(out: unknown, storage: Int8Array, bytes: Uint8Array): Gen {
  for (let at = 0; at < bytes.length; at += storage.length) {
    const n = Math.min(storage.length, bytes.length - at);
    storage.set(new Int8Array(bytes.buffer, bytes.byteOffset + at, n));
    yield vcall(out, "write", "([BII)V", storage, 0, n);
  }
}

const FILE_DESCRIPTOR = "java/io/FileDescriptor", O_APPEND = 0x400;
const descriptor = instanceField<number>(FILE_DESCRIPTOR, "descriptor");
const scopeClosed = (d: JObj, fd: number) => { if (descriptor.get(d) === fd) setFdInt(d, -1); };
/** a FileDescriptor's int, -1 for none (JNIHelp's jniGetFDFromFileDescriptor) */
export const fdInt = (d: JObj | null): number => d ? guardJavaDescriptor(d, descriptor.get(d), scopeClosed) : -1;
export function setFdInt(d: JObj, fd: number): void { unguardJavaDescriptor(d); descriptor.set(d, fd); }
/** jniCreateFileDescriptor: a `new FileDescriptor()` given `fd` through setInt$, which also
 *  records whether it appends */
export function mkFd(fd: number): JObj | Promise<JObj> {
  const lease = fdLease(fd), scoped = !!lease?.owner;
  return after(newObj(FILE_DESCRIPTOR), (d: JObj) => after(vcall(d, "setInt$", "(I)V", fd), () => {
    if (scoped) {
      if (lease!.fd < 0) setFdInt(d, -1);
      else fdInt(d);
    }
    return d;
  }));
}
rt.registerJni("java/io/FileDescriptor", "isSocket(I)Z", (fd: number) => +javaIsSocketFd(fd));
// OpenJDK tests the bits of F_GETFL's result as is, so a failure reads as appending
rt.registerJni("java/io/FileDescriptor", "getAppend(I)Z", waits((fd: number) => after(javaFcntlFd(fd,3,0),flags => +((flags & O_APPEND) !== 0))));
// the bytes are already in the VFS; a sync is what asks for them to persist now
rt.registerJni("java/io/FileDescriptor", "sync()V", waits(function (this: JObj) {
  return after(javaSyncFd(fdInt(this)), result => {
    if (result < 0) throw rt.mkThrowable("java/io/SyncFailedException", "sync failed");
    return vfs.flush();
  });
}));
/** OpenJDK's FileInputStream natives (io_util_md.c) over the stream's descriptor */
function streamFd(stream: JObj): number {
  const fd = fdInt(getDeclared<JObj | null>(stream, "java/io/FileInputStream", "fd"));
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
  "available0()I": driven(function* (this: JObj): Gen {
    const fd = streamFd(this), stat = yield* awaited(javaFdStat(fd)), type = (stat?.mode ?? 0) & S_IFMT;
    if (type === S_IFCHR || type === S_IFIFO || type === S_IFSOCK) {
      const n = yield* awaited(javaIoctlIntFd(fd, FIONREAD));
      if (n >= 0) return n;
    }
    const cur = lastError(yield* awaited(javaLseekFd(fd, 0, 1)), null), end = lastError(yield* awaited(javaLseekFd(fd, 0, 2)), null);
    lastError(yield* awaited(javaLseekFd(fd, cur, 0)), null);
    return Math.max(0, Math.min(0x7fffffff, end - cur));
  }),
  "length0()J": driven(function* (this: JObj): Gen {
    const st = yield* awaited(javaFdStat(streamFd(this)));
    if (!st) lastError(-E.BADF, "GetLength failed");
    return BigInt(st!.size);
  }),
  "position0()J": waits(function (this: JObj) { return after(javaLseekFd(streamFd(this), 0, 1), (result) => BigInt(lastError(result, "Seek failed"))); }),
  "skip0(J)J": driven(function* (this: JObj, n: bigint): Gen {
    const fd = streamFd(this), cur = yield* awaited(javaLseekFd(fd, 0, 1));
    if (cur === -E.SPIPE) throw rt.mkThrowable("java/io/FileInputStream$UseManualSkipException", null);
    lastError(cur, "Seek error");
    return BigInt(lastError(yield* awaited(javaLseekFd(fd, Number(n), 1)), "Seek error") - cur);
  }),
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
/** a read into native memory: the bytes land once it completes, since guest memory may move meanwhile */
function readInto(address: bigint, len: number, read: (target: Uint8Array) => number | Promise<number>): number | Promise<number> {
  const scratch = new Uint8Array(len);
  return after(read(scratch),n => { if (n > 0) writeAt(address,scratch.subarray(0,n)); return ioStatus(n,true); });
}
/** iovec i of an IOVecWrapper array: its base, a native address, and its length */
function iovec(iov: bigint, i: number): [bigint, number] {
  const width = addressSize(), at = iov + BigInt(i * 2 * width);
  const word = (a: bigint) => {
    const b = memorySync(a, width), view = new DataView(b.buffer, b.byteOffset, width);
    return width === 8 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
  };
  return [word(at), Number(word(at + BigInt(width)))];
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
  "read0(Ljava/io/FileDescriptor;JI)I": waits((d: JObj, address: bigint, len: number) => readInto(address, len, (t) => javaReadFd(openFd(d), t))),
  "pread0(Ljava/io/FileDescriptor;JIJ)I": waits((d: JObj, address: bigint, len: number, position: bigint) =>
    readInto(address, len, (t) => javaPreadFd(openFd(d), t, offset(position, len)))),
  "write0(Ljava/io/FileDescriptor;JI)I": waits((d: JObj, address: bigint, len: number) =>
    after(memoryAt(address, len), (bytes) => after(javaWriteFd(openFd(d),bytes),n => ioStatus(n,false)))),
  "pwrite0(Ljava/io/FileDescriptor;JIJ)I": waits((d: JObj, address: bigint, len: number, position: bigint) =>
    after(memoryAt(address, len), (bytes) => after(javaPwriteFd(openFd(d),bytes,offset(position,len)),n => ioStatus(n,false)))),
  // readv/writev over IOVecWrapper's iovecs: {base, len}, each as wide as Unsafe.addressSize
  "readv0(Ljava/io/FileDescriptor;JI)J": driven(function* (d: JObj, iov: bigint, count: number): Gen {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const [base, len] = iovec(iov, i), scratch = new Uint8Array(len);
      const n = yield* awaited(javaReadFd(openFd(d), scratch));
      if (n < 0) { if (total) break; return BigInt(ioStatus(n, true)); }
      writeAt(base,scratch.subarray(0,n));
      total += n;
      if (n < len) break;
    }
    return BigInt(total || IOS_EOF);
  }),
  "writev0(Ljava/io/FileDescriptor;JI)J": driven(function* (d: JObj, iov: bigint, count: number): Gen {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const [base, len] = iovec(iov, i);
      const n = yield* awaited(javaWriteFd(openFd(d), yield* awaited(memoryAt(base, len))));
      if (n < 0) { if (total) break; return BigInt(ioStatus(n, false)); }
      total += n;
      if (n < len) break;
    }
    return BigInt(total);
  }),
  "force0(Ljava/io/FileDescriptor;Z)I": waits((d: JObj) => after(javaSyncFd(openFd(d)),n => {
    lastError(n,"Force failed"); return after(vfs.flush(),() => 0);
  })),
  "truncate0(Ljava/io/FileDescriptor;J)I": waits((d: JObj, size: bigint) => after(javaTruncateFd(openFd(d),Number(size)),n => {lastError(n,"Truncation failed");return 0;})),
  "size0(Ljava/io/FileDescriptor;)J": waits((d: JObj) => after(javaFdStat(openFd(d)),st => {
    return BigInt(st ? st.size : lastError(-E.BADF, "Size failed"));
  })),
  // A process's own POSIX record locks never conflict, and FileLockTable arbitrates its channels' overlaps, so every lock
  // a process asks for is granted. Locks are not arbitrated between processes: two processes' locks on one file both hold.
  "lock0(Ljava/io/FileDescriptor;ZJJZ)I": (d: JObj) => { openFd(d); return 0 /* LOCKED */; },
  "release0(Ljava/io/FileDescriptor;JJ)V": (d: JObj) => { openFd(d); },
  "preClose0(Ljava/io/FileDescriptor;)V": () => {},
  "close0(Ljava/io/FileDescriptor;)V": waits((d: JObj) => { const fd=fdInt(d); return fd>=0 ? after(javaCloseFd(fd),n => {lastError(n,"Close failed");}) : undefined; }),
  "closeIntFD(I)V": waits((fd: number) => after(javaCloseFd(fd),n => {lastError(n,"Close failed");})),
});
const MAP_RO = 0, MAP_PV = 2;
const channelFd = instanceField<JObj>("sun/nio/ch/FileChannelImpl", "fd");
rt.registerJnis("sun/nio/ch/FileChannelImpl", {
  "initIDs()J": () => 4096n,
  "position0(Ljava/io/FileDescriptor;J)J": waits((d: JObj, offset: bigint) =>
    after(offset < 0n ? javaLseekFd(openFd(d),0,1) : javaLseekFd(openFd(d),Number(offset),0),n => BigInt(lastError(n,"Position failed")))),
  // sendfile is not offered: FileChannelImpl copies through buffers instead
  "transferTo0(Ljava/io/FileDescriptor;JJLjava/io/FileDescriptor;)J": () => BigInt(IOS_UNSUPPORTED),
  // An immutable file maps read-only outside guest memory, paged in as read; any other mapping is
  // guest memory holding the file's bytes, a shared one kept coherent with the file (mappings.ts)
  "map0(IJJ)J": waits(function (this: JObj, prot: number, position: bigint, length: bigint) {
    const fd = openFd(channelFd.get(this));
    const start = Number(position), n = Number(length);
    const remote = remoteOf(fd);
    if (remote) {
      if (prot === MAP_PV) return BigInt(lastError(-E.NOTSUP,"Map failed"));
      return mapRemote(remote,start,n,prot === MAP_RO ? 1 : 3).then(address => typeof address === "number" ? BigInt(lastError(address,"Map failed")) : address);
    }
    const file = fdFile(fd);
    if (prot === MAP_RO && file?.source && !writable(file.source)) return mapExternal(file.source, start, n);
    return after(file?.source ?? javaFdSource(fd), source => !source ? BigInt(lastError(-E.INVAL, "Map failed")) : after(readFully(source, start, n), (bytes) => {
      const va = mem.mapVa(n, false);
      if (!va) throw rt.mkThrowable("java/lang/OutOfMemoryError", "Map failed");
      mem.write(mem.txVa(BigInt(va)), bytes);
      if (file && prot !== MAP_PV) trackSharedMap(BigInt(va), n, start, file, prot !== MAP_RO);
      return BigInt(va);
    }));
  }),
  "unmap0(JJ)I": waits((address: bigint, length: bigint) => {
    if (isExternal(address)) return after(unmapExternal(address),() => 0);
    else { syncShared(address, Number(length), true); mem.unmapVa(address, Number(length)); }
    return 0;
  }),
});
rt.registerJni("sun/nio/ch/FileKey", "init(Ljava/io/FileDescriptor;)V", driven(function* (this: JObj, d: JObj): Gen {
  const st = yield* awaited(javaFdStat(openFd(d)));
  setDeclared(this, "sun/nio/ch/FileKey", { st_dev: 1n, st_ino: BigInt(st?.path ? inoOf(st.path) : openFd(d)) });
}));
rt.registerJnis("sun/nio/ch/IOUtil", {
  "fdVal(Ljava/io/FileDescriptor;)I": (d: JObj) => fdInt(d),
  "setfdVal(Ljava/io/FileDescriptor;I)V": (d: JObj, fd: number) => setFdInt(d, fd),
  "iovMax()I": () => 1024,
  "fdLimit()I": () => 32768,
});
// no thread here blocks in the kernel, so there is none to signal out of a blocking call
rt.registerJnis("sun/nio/ch/NativeThread", { "current()J": () => 0n, "signal(J)V": () => {} });

// java.io serialization's natives: the object streams convert float and double arrays to and from big-endian bytes
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
rt.registerJnis("java/io/ObjectOutputStream", { "floatsToBytes([FI[BII)V": F4.toBytes, "doublesToBytes([DI[BII)V": F8.toBytes });
rt.registerJnis("java/io/ObjectInputStream", { "bytesToFloats([BI[FII)V": F4.fromBytes, "bytesToDoubles([BI[DII)V": F8.fromBytes });
