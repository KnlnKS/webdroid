// java.io.* natives and the VFS shared with native file descriptors; java.io.UnixFileSystem's and
// sun.nio.fs's natives over the path operations.

import { awaited, rt, type JObj, driven, instanceField, getDeclared, setDeclared, waits, type Gen } from "../runtime.ts";
import { concat, i8, jarray, utf8 } from "../abi.ts";
import { vcall, after, newObj, initClass } from "./jentry.ts";
import { E, ERRSTR, strerror, S_IFMT, S_IFDIR, S_IFCHR, S_IFIFO, S_IFSOCK } from "../../native/abi.ts";
import { mem } from "../../native/mem.ts";
import { writable } from "../../shell/lazyfile.ts";
import { vfs } from "../../shell/vfs.ts";
import { appUserName } from "../../shell/procfs.ts";
import { filePaths, type AttributeChange } from "../../shell/file-path.ts";
import { isExternal, mapRemote, mapExternal, memoryAt, memorySync, unmapExternal, writeAt } from "./jmemory.ts";
import { addressSize } from "./jvmruntime.ts";
import { mmap, munmap, MAP_PRIVATE, MAP_SHARED, PROT_READ, PROT_WRITE } from "../../native/vm.ts";
import { fdFile, linkTarget, resolveAt, statAt, statFd, storageStat } from "../../native/fs.ts";
import { remoteOf, processOpenFd } from "../../native/process-fd.ts";
import { isSocketFd, closeFd, dupFd, seekFd, readFd, preadFd, writeFd, changeFdAttributes,
  pwriteFd, truncateFd, fcntlFd, syncFd, fdStat, ioctlIntFd } from "../../native/fd.ts";
import { inoOf, type Stat } from "../../native/kernel.ts";
import { fdLease, guardJavaDescriptor, unguardJavaDescriptor } from "../../android/fd-scope.ts";

/** a java.io.File's path as the VFS names it (libcore's File resolves a relative one against "/") */
export const pathOf = (file: JObj): string => vfs.norm(vcall(file, "getPath", "()Ljava/lang/String;"));
/** `new File(path)` */
export const newFile = (path: string): PromiseOrVal<JObj> => newObj("java/io/File", "(Ljava/lang/String;)V", path);

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
export function mkFd(fd: number): PromiseOrVal<JObj> {
  const lease = fdLease(fd), scoped = !!lease?.owner;
  return after(newObj(FILE_DESCRIPTOR), (d: JObj) => after(vcall(d, "setInt$", "(I)V", fd), () => {
    if (scoped) {
      if (lease!.fd < 0) setFdInt(d, -1);
      else fdInt(d);
    }
    return d;
  }));
}
rt.registerJni("java/io/FileDescriptor", "isSocket(I)Z", (fd: number) => +isSocketFd(fd));
// OpenJDK tests the bits of F_GETFL's result as is, so a failure reads as appending
rt.registerJni("java/io/FileDescriptor", "getAppend(I)Z", waits((fd: number) => after(fcntlFd(fd,3,0),flags => +((flags & O_APPEND) !== 0))));
// the bytes are already in the VFS; a sync is what asks for them to persist now
rt.registerJni("java/io/FileDescriptor", "sync()V", waits(function (this: JObj) {
  return after(syncFd(fdInt(this)), result => {
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
const FIONREAD = 0x541b;
const fisNatives: Record<string, (this: JObj, ...args: never[]) => unknown> = {
  // a character device, FIFO or socket answers FIONREAD; anything else, the distance to its end
  "available0()I": driven(function* (this: JObj): Gen {
    const fd = streamFd(this), stat = yield* awaited(fdStat(fd)), type = (stat?.mode ?? 0) & S_IFMT;
    if (type === S_IFCHR || type === S_IFIFO || type === S_IFSOCK) {
      const n = yield* awaited(ioctlIntFd(fd, FIONREAD));
      if (n >= 0) return n;
    }
    const cur = lastError(yield* awaited(seekFd(fd, 0, 1)), null), end = lastError(yield* awaited(seekFd(fd, 0, 2)), null);
    lastError(yield* awaited(seekFd(fd, cur, 0)), null);
    return Math.max(0, Math.min(0x7fffffff, end - cur));
  }),
  "length0()J": driven(function* (this: JObj): Gen {
    const st = yield* awaited(fdStat(streamFd(this)));
    if (!st) lastError(-E.BADF, "GetLength failed");
    return BigInt(st!.size);
  }),
  "position0()J": waits(function (this: JObj) { return after(seekFd(streamFd(this), 0, 1), (result) => BigInt(lastError(result, "Seek failed"))); }),
  "skip0(J)J": driven(function* (this: JObj, n: bigint): Gen {
    const fd = streamFd(this), cur = yield* awaited(seekFd(fd, 0, 1));
    if (cur === -E.SPIPE) throw rt.mkThrowable("java/io/FileInputStream$UseManualSkipException", null);
    lastError(cur, "Seek error");
    return BigInt(lastError(yield* awaited(seekFd(fd, Number(n), 1)), "Seek error") - cur);
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
function readInto(address: bigint, len: number, read: (target: Uint8Array) => PromiseOrVal<number>): PromiseOrVal<number> {
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
  "read0(Ljava/io/FileDescriptor;JI)I": waits((d: JObj, address: bigint, len: number) => readInto(address, len, (t) => readFd(openFd(d), t, len))),
  "pread0(Ljava/io/FileDescriptor;JIJ)I": waits((d: JObj, address: bigint, len: number, position: bigint) =>
    readInto(address, len, (t) => preadFd(openFd(d), t, len, offset(position, len)))),
  "write0(Ljava/io/FileDescriptor;JI)I": waits((d: JObj, address: bigint, len: number) =>
    after(memoryAt(address, len), (bytes) => after(writeFd(openFd(d),bytes),n => ioStatus(n,false)))),
  "pwrite0(Ljava/io/FileDescriptor;JIJ)I": waits((d: JObj, address: bigint, len: number, position: bigint) =>
    after(memoryAt(address, len), (bytes) => after(pwriteFd(openFd(d),bytes,offset(position,len)),n => ioStatus(n,false)))),
  // readv/writev over IOVecWrapper's iovecs: {base, len}, each as wide as Unsafe.addressSize
  "readv0(Ljava/io/FileDescriptor;JI)J": driven(function* (d: JObj, iov: bigint, count: number): Gen {
    let total = 0;
    for (let i = 0; i < count; i++) {
      const [base, len] = iovec(iov, i), scratch = new Uint8Array(len);
      const n = yield* awaited(readFd(openFd(d), scratch, len));
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
      const n = yield* awaited(writeFd(openFd(d), yield* awaited(memoryAt(base, len))));
      if (n < 0) { if (total) break; return BigInt(ioStatus(n, false)); }
      total += n;
      if (n < len) break;
    }
    return BigInt(total);
  }),
  "force0(Ljava/io/FileDescriptor;Z)I": waits((d: JObj) => after(syncFd(openFd(d)),n => {
    lastError(n,"Force failed"); return after(vfs.flush(),() => 0);
  })),
  "truncate0(Ljava/io/FileDescriptor;J)I": waits((d: JObj, size: bigint) => after(truncateFd(openFd(d),Number(size)),n => {lastError(n,"Truncation failed");return 0;})),
  "size0(Ljava/io/FileDescriptor;)J": waits((d: JObj) => after(fdStat(openFd(d)),st => {
    return BigInt(st ? st.size : lastError(-E.BADF, "Size failed"));
  })),
  // A process's own POSIX record locks never conflict, and FileLockTable arbitrates its channels' overlaps, so every lock
  // a process asks for is granted. Locks are not arbitrated between processes: two processes' locks on one file both hold.
  "lock0(Ljava/io/FileDescriptor;ZJJZ)I": (d: JObj) => { openFd(d); return 0 /* LOCKED */; },
  "release0(Ljava/io/FileDescriptor;JJ)V": (d: JObj) => { openFd(d); },
  "preClose0(Ljava/io/FileDescriptor;)V": () => {},
  "close0(Ljava/io/FileDescriptor;)V": waits((d: JObj) => { const fd=fdInt(d); return fd>=0 ? after(closeFd(fd),n => {lastError(n,"Close failed");}) : undefined; }),
  "closeIntFD(I)V": waits((fd: number) => after(closeFd(fd),n => {lastError(n,"Close failed");})),
});
const MAP_RO = 0, MAP_PV = 2;
const channelFd = instanceField<JObj>("sun/nio/ch/FileChannelImpl", "fd");
rt.registerJnis("sun/nio/ch/FileChannelImpl", {
  "initIDs()J": () => 4096n,
  "position0(Ljava/io/FileDescriptor;J)J": waits((d: JObj, offset: bigint) =>
    after(offset < 0n ? seekFd(openFd(d),0,1) : seekFd(openFd(d),Number(offset),0),n => BigInt(lastError(n,"Position failed")))),
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
    return after(mmap(0n, n, prot === MAP_RO ? PROT_READ : PROT_READ | PROT_WRITE, prot === MAP_PV ? MAP_PRIVATE : MAP_SHARED, fd, start), (r) => {
      if (r === -E.NOMEM) throw rt.mkThrowable("java/lang/OutOfMemoryError", "Map failed");
      return BigInt(typeof r === "number" ? lastError(r, "Map failed") : r);
    });
  }),
  "unmap0(JJ)I": waits((address: bigint, length: bigint) => isExternal(address) ? after(unmapExternal(address), () => 0) : (munmap(address, Number(length)), 0)),
});
rt.registerJni("sun/nio/ch/FileKey", "init(Ljava/io/FileDescriptor;)V", driven(function* (this: JObj, d: JObj): Gen {
  const st = yield* awaited(fdStat(openFd(d)));
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

// java.io.UnixFileSystem: java.io.File's natives over the path operations (file-path.ts). There are
// no hard links.
const BA_EXISTS = 1, BA_REGULAR = 2, BA_DIRECTORY = 4;
/** the stat of a File's path, or null */
const fileStat = (p: string) => after(statAt(p), (st) => typeof st === "number" ? null : st);
/** chmod of `p` to what `to` makes of its permission bits, as UnixFileSystem_md.c's statMode and chmod */
const remode = (p: string, to: (mode: number) => number) =>
  after(fileStat(p), stat => stat ? after(filePaths(p).fileSetAttributes(p, { mode: to(stat.mode & 0o7777) }), r => +(r === 0)) : 0);
const unixFileSystem: Record<string, (...args: never[]) => unknown> = {
  "initIDs()V": () => {},
  "canonicalize0(Ljava/lang/String;Z)Ljava/lang/String;": (path: string) => vfs.canonical(path),
  "getBooleanAttributes0(Ljava/lang/String;)I": (path: string) =>
    after(fileStat(vfs.norm(path)), stat => stat ? BA_EXISTS | ((stat.mode & S_IFMT) === S_IFDIR ? BA_DIRECTORY : BA_REGULAR) : 0),
  "list0(Ljava/io/File;)[Ljava/lang/String;": (file: JObj) => {
    const p = pathOf(file);
    return after(filePaths(p).fileList(p), reply => reply.value ? jarray(reply.value, "Ljava/lang/String;") : null);
  },
  "createFileExclusively0(Ljava/lang/String;)Z": driven(function* (path: string): Gen {
    const r = yield* awaited(filePaths(path).fileCreate(path));
    if (r === -E.EXIST) return 0;
    // JNU_ThrowIOExceptionWithLastError: an IOException carrying strerror
    if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? path);
    return 1;
  }),
  "createDirectory0(Ljava/io/File;)Z": (file: JObj) => {
    const p = pathOf(file);
    return after(filePaths(p).fileMkdir(p), result => +(result === 0));
  },
  "getLastModifiedTime0(Ljava/io/File;)J": (file: JObj) => after(fileStat(pathOf(file)), stat => BigInt(stat?.mtime ?? 0)),
  "setLastModifiedTime0(Ljava/io/File;J)Z": (file: JObj, ms: bigint) => {
    const p = pathOf(file);
    return after(filePaths(p).fileSetAttributes(p, { mtime: Number(ms) }), r => +(r === 0));
  },
  // ACCESS_READ, ACCESS_WRITE and ACCESS_EXECUTE are 4, 2 and 1: the owner's bit, or everyone's
  "setPermission0(Ljava/io/File;IZZ)Z": (file: JObj, access: number, enable: number, ownerOnly: number) => {
    const bits = access * (ownerOnly ? 0o100 : 0o111);
    return remode(pathOf(file), mode => enable ? mode | bits : mode & ~bits);
  },
  "setReadOnly0(Ljava/io/File;)Z": (file: JObj) => remode(pathOf(file), mode => mode & ~0o222),
  // FileSystem.SPACE_TOTAL, SPACE_FREE, SPACE_USABLE
  "getSpace0(Ljava/io/File;I)J": (_file: JObj, kind: number) => after(storageStat(), (s) => BigInt((kind === 0 ? s.blocks : s.bfree) * s.bsize)),
  "getNameMax0(Ljava/lang/String;)J": () => 255n,
};
rt.registerJnis("java/io/UnixFileSystem", unixFileSystem);

// sun.nio.fs.UnixNativeDispatcher (UnixNativeDispatcher.c): java.nio.file's syscalls over the VFS.
// Paths arrive as NUL-terminated strings in native memory; failures throw UnixException(errno).
// There are no symbolic or hard links.
// UnixException's fillInStackTrace records nothing, so none is captured
const unixError = (e: number) => setDeclared(rt.make("sun/nio/fs/UnixException"), "sun/nio/fs/UnixException", { errno: e });
const unixSys = (result: number): number => { if (result < 0) throw unixError(-result); return result; };
const cpath = (address: bigint) => mem.cstr(mem.txVa(BigInt.asUintN(64, address)));
export const bytesOf = (s: string) => i8(utf8.enc.encode(s));
const AT_REMOVEDIR = 0x200;
/** a name relative to directory descriptor `dfd`, as the *at calls resolve it */
function atPath(dfd: number, address: bigint): string {
  const path = resolveAt(dfd, cpath(address));
  if (typeof path === "number") throw unixError(-path);
  return path;
}
function fillAttrs(attrs: JObj, st: Stat): void {
  const sec = BigInt(Math.floor(st.mtime / 1000)), nsec = BigInt((st.mtime % 1000) * 1e6);
  setDeclared(attrs, "sun/nio/fs/UnixFileAttributes", { st_mode: st.mode, st_ino: BigInt(st.ino), st_dev: BigInt(st.dev), st_nlink: st.nlink, st_uid: st.uid, st_gid: st.gid,
    st_size: BigInt(st.size), st_atime_sec: sec, st_atime_nsec: nsec, st_mtime_sec: sec, st_mtime_nsec: nsec, st_ctime_sec: sec, st_ctime_nsec: nsec });
}
/** stat(2) of a path in the realm that owns it: a directory, or a file (procfs included) */
function statPath(path: string, attrs: JObj | null): PromiseOrVal<number> {
  return after(statAt(path), (st) => {
    if (typeof st === "number") throw unixError(-st);
    if (attrs) fillAttrs(attrs, st);
    return st.mode;
  });
}
/** unlink(2) with `directory` false, rmdir(2) with true */
function removeAt(path: string, directory: boolean) {
  const p = vfs.norm(path);
  return after(filePaths(p).fileRemove(p, directory), (n) => { unixSys(n); });
}
/** chmod, chown and utimes; the VFS keeps modification times only, which utimes gives in microseconds */
const changePath = (path: string, change: AttributeChange) => after(filePaths(path).fileSetAttributes(path, change), (n) => { unixSys(n); });
const changeFd = (fd: number, change: AttributeChange) => after(changeFdAttributes(fd, change), (n) => { unixSys(n); });
const fdPath = (fd: number) => after(fdStat(fd), st => { if (!st) throw unixError(E.BADF); return st.path ?? ""; });
/** open DIR streams: the entries as readdir(3) returns them, and the descriptor closedir closes */
const dirStreams = new Map<bigint, { names: string[]; i: number; fd: number }>();
let nextDir = 0n;
function openDirStream(path: string, fd: number) {
  const p = vfs.norm(path);
  return after(filePaths(p).fileList(p), ({ errno, value }) => {
    if (!value) throw unixError(errno);
    dirStreams.set(++nextDir, { names: [".", "..", ...value], i: 0, fd });
    return nextDir;
  });
}
const passwdName = (id: number) => bytesOf(appUserName(id));
const unixNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  // SUPPORTS_OPENAT | SUPPORTS_FUTIMES: bionic has openat64, fstatat64, unlinkat, renameat, futimesat
  // and fdopendir. UnixException is initialized first, since the natives throw it synchronously.
  "init()I": waits(() => after(initClass("sun/nio/fs/UnixException"), () => 6)),
  "getcwd()[B": () => bytesOf("/"),
  "strerror(I)[B": (e: number) => bytesOf(strerror(e)),
  "dup(I)I": (fd: number) => unixSys(dupFd(fd)),
  "open0(JII)I": (path: bigint, flags: number) => after(processOpenFd(cpath(path),flags),unixSys),
  "openat0(IJII)I": (dfd: number, path: bigint, flags: number) => after(processOpenFd(atPath(dfd,path),flags),unixSys),
  "close(I)V": (fd: number) => after(closeFd(fd),n => {unixSys(n);}),
  "link0(JJ)V": () => { throw unixError(E.PERM); },
  "symlink0(JJ)V": () => { throw unixError(E.PERM); },
  "unlink0(J)V": (path: bigint) => removeAt(cpath(path), false),
  "unlinkat0(IJI)V": (dfd: number, path: bigint, flags: number) => removeAt(atPath(dfd, path), !!(flags & AT_REMOVEDIR)),
  "rename0(JJ)V": (from: bigint, to: bigint) => { const a = cpath(from), b = cpath(to); return after(filePaths(a, b).fileRename(a, b), (n) => { unixSys(n); }); },
  "renameat0(IJIJ)V": (fromDir: number, from: bigint, toDir: number, to: bigint) => { const a = atPath(fromDir, from), b = atPath(toDir, to); return after(filePaths(a, b).fileRename(a, b), (n) => { unixSys(n); }); },
  "mkdir0(JI)V": (path: bigint) => { const p = cpath(path); return after(filePaths(p).fileMkdir(p), (n) => { unixSys(n); }); },
  "rmdir0(J)V": (path: bigint) => removeAt(cpath(path), true),
  "readlink0(J)[B": waits((path: bigint) => after(linkTarget(cpath(path)), (target) => { if (typeof target === "number") throw unixError(-target); return bytesOf(target); })),
  "realpath0(J)[B": waits((path: bigint) => { const p = vfs.norm(cpath(path)); return after(statPath(p, null), () => bytesOf(p)); }),
  "stat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "lstat0(JLsun/nio/fs/UnixFileAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), attrs), () => {}),
  "stat1(J)I": (path: bigint) => after(statAt(cpath(path)), (st) => typeof st === "number" ? 0 : st.mode),
  "fstatat0(IJILsun/nio/fs/UnixFileAttributes;)V": (dfd: number, path: bigint, _flag: number, attrs: JObj) => after(statPath(atPath(dfd, path), attrs), () => {}),
  "fstat(ILsun/nio/fs/UnixFileAttributes;)V": (fd: number, attrs: JObj) => after(statFd(fd), st => {
    if (typeof st === "number") throw unixError(-st);
    fillAttrs(attrs, st);
  }),
  "chmod0(JI)V": (path: bigint, mode: number) => changePath(cpath(path), { mode }),
  "fchmod(II)V": (fd: number, mode: number) => changeFd(fd, { mode }),
  "chown0(JII)V": (path: bigint, uid: number, gid: number) => changePath(cpath(path), { uid, gid }),
  "lchown0(JII)V": (path: bigint, uid: number, gid: number) => changePath(cpath(path), { uid, gid }),
  "fchown(III)V": (fd: number, uid: number, gid: number) => changeFd(fd, { uid, gid }),
  "utimes0(JJJ)V": (path: bigint, _accessed: bigint, modified: bigint) => changePath(cpath(path), { mtime: Number(modified / 1000n) }),
  "futimes(IJJ)V": (fd: number, _accessed: bigint, modified: bigint) => changeFd(fd, { mtime: Number(modified / 1000n) }),
  "opendir0(J)J": (path: bigint) => openDirStream(cpath(path), -1),
  "fdopendir(I)J": (fd: number) => after(fdPath(fd), path => openDirStream(path, fd)),
  "closedir(J)V": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    dirStreams.delete(dir);
    if (stream.fd >= 0) return after(closeFd(stream.fd), n => { unixSys(n); });
  },
  "readdir(J)[B": (dir: bigint) => {
    const stream = dirStreams.get(dir);
    if (!stream) throw unixError(E.BADF);
    return stream.i < stream.names.length ? bytesOf(stream.names[stream.i++]) : null;
  },
  "access0(JI)V": (path: bigint, mode: number) => { const p = cpath(path); return after(filePaths(p).fileAccess(p, mode), (n) => { unixSys(n); }); },
  "exists0(J)Z": (path: bigint) => { const p = cpath(path); return after(filePaths(p).fileAccess(p, 0), (n) => +(n === 0)); },
  "getpwuid(I)[B": passwdName,
  "getgrgid(I)[B": passwdName,
  "statvfs0(JLsun/nio/fs/UnixFileStoreAttributes;)V": (path: bigint, attrs: JObj) => after(statPath(cpath(path), null), () => after(storageStat(), (s) => {
    setDeclared(attrs, "sun/nio/fs/UnixFileStoreAttributes", { f_frsize: BigInt(s.bsize), f_blocks: BigInt(s.blocks), f_bfree: BigInt(s.bfree), f_bavail: BigInt(s.bfree) });
  })),
};
rt.registerJnis("sun/nio/fs/UnixNativeDispatcher", unixNativeDispatcher);
// LinuxNativeDispatcher.c: the VFS stores no extended attributes, and its only mount table would be
// a file some app wrote (there is no /proc/mounts)
const mountTables = new Map<bigint, string[][]>();
let nextMountTable = 0n;
const linuxNativeDispatcher: Record<string, (...args: never[]) => unknown> = {
  "init()V": () => {},
  "flistxattr(IJI)I": (fd: number) => { fdPath(fd); return 0; },
  "fgetxattr0(IJJI)I": (fd: number) => { fdPath(fd); throw unixError(E.NODATA); },
  "fremovexattr0(IJ)V": (fd: number) => { fdPath(fd); throw unixError(E.NODATA); },
  "fsetxattr0(IJJI)V": (fd: number) => { fdPath(fd); throw unixError(E.NOTSUP); },
  "setmntent0(JJ)J": (path: bigint) => {
    const text = vfs.read(cpath(path));
    if (!text) throw unixError(E.NOENT);
    mountTables.set(++nextMountTable, utf8.dec.decode(text).split("\n").map((line) => line.trim().split(/\s+/)).filter((f) => f.length >= 4 && !f[0].startsWith("#")));
    return nextMountTable;
  },
  "getmntent(JLsun/nio/fs/UnixMountEntry;)I": (table: bigint, entry: JObj) => {
    const fields = mountTables.get(table)?.shift();
    if (!fields) return -1;
    setDeclared(entry, "sun/nio/fs/UnixMountEntry", { name: bytesOf(fields[0]), dir: bytesOf(fields[1]), fstype: bytesOf(fields[2]), opts: bytesOf(fields[3]) });
    return 0;
  },
  "endmntent(J)V": (table: bigint) => { mountTables.delete(table); },
};
rt.registerJnis("sun/nio/fs/LinuxNativeDispatcher", linuxNativeDispatcher);
// UnixCopyFile.c: read(2) and write(2) until the source's end, checking the cancel flag between reads
rt.registerJni("sun/nio/fs/UnixCopyFile", "transfer(IIJ)V", driven(function* (dst: number, src: number, cancel: bigint): Gen {
  const buffer = new Uint8Array(1 << 16);
  for (;;) {
    const n = unixSys(yield* awaited(readFd(src, buffer, buffer.length)));
    if (!n) return;
    if (cancel && mem.ld32(mem.txVa(cancel))) throw unixError(E.CANCELED);
    for (let at = 0; at < n;) at += unixSys(yield* awaited(writeFd(dst, buffer.subarray(at, n))));
  }
}));
