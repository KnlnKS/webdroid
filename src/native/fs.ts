// The files the kernel's descriptors (fd.ts) open by path: regular files over the JVM vfs,
// directories, procfs snapshots and devices; the path operations, each where its path lives
// (file-path.ts), as JS values or -errno for the guest's calls here and libcore's natives alike;
// and the guest's calls over guest memory.

import { mem, anchor } from "./mem.ts";
import { type HostFn, PTR, ldp, ldLong, stLong, complete } from "./host.ts";
import { E, AT_FDCWD, O_ACCMODE, O_APPEND, O_CLOEXEC, O_CREAT, O_DIRECTORY, O_EXCL, O_NONBLOCK, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY,
  POLLERR, POLLHUP, POLLIN, S_IFCHR, S_IFDIR, S_IFIFO, S_IFREG } from "./abi.ts";
import type { Cpu } from "./cpu.ts";
import { DIRENT64, fillStat, fullStat, logLine, offArg, putDirent, randomBytes, readTs, KLAYOUT, type Stat } from "./kernel.ts";
import { vfs, EMPTY, storageEstimate, type VfsFile } from "../shell/vfs.ts";
import { ASHMEM_DEVICE, filePaths, changeOpenFile, isCharDevice, openFileStat, type AttributeChange, type CharDevice } from "../shell/file-path.ts";
import { procIdentity, procMemory, procText, procWritable, procWrite } from "../shell/procfs.ts";
import { is64BitProcess } from "../jvm/natives/jvmruntime.ts";
import { readAt, writable, type FileSource } from "../shell/lazyfile.ts";
import { utf8 } from "../jvm/abi.ts";
import { ANON, FIONREAD, installFile, newFile, openFd, placeFile, readFd, preadFd, pwriteFd, writeFd, allocateFd, changeFdAttributes, closeFd, dup2Fd,
  dupFd, fcntlFd, ioctlIntFd, seekFd, syncFd, truncateFd, type FdStat, type FileOps, type OpenFile } from "./fd.ts";
import { fifoOf, holdFifo, pipeFds, openFifo } from "./pipe.ts";
import { closedWrite, hookInotify } from "./inotify.ts";
import { gather, MSG_NOSIGNAL } from "./socket/abi.ts";
import { SIGPIPE } from "./signals.ts";
import { processOpenFd } from "./process-fd.ts";
import { releaseRegion } from "./shm.ts";

/** up to `n` bytes of a file at `off`, fewer only at its end as a regular file reads: a view of its data, or what its lazy source reads */
export function contentAt(content: VfsFile, off: number, n: number): Uint8Array | Promise<Uint8Array> {
  vfs.sync(content);
  const k = Math.max(0, Math.min(n, content.len - off));
  if (!k) return EMPTY;
  return content.source ? readAt(content.source, off, k) : content.data.subarray(off, off + k);
}
function contentInto(content: VfsFile, target: Uint8Array, at: number, n: number, off: number): number | Promise<Uint8Array | number> {
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(content, off, n); }
  catch { return -E.IO; }
  if (value instanceof Promise) return value.catch(() => -E.IO);
  target.set(value, at);
  return value.length;
}
/** a read at the position moves it once the bytes come, and the next read at the position waits for that */
function queueRead(f: OpenFile, read: Promise<Uint8Array | number>): Promise<Uint8Array | number> {
  const moved = read.then((v) => { if (typeof v !== "number") f.pos += v.length; return v; });
  const queue: Promise<void> = f.readQueue = moved.then(() => { if (f.readQueue === queue) f.readQueue = undefined; });
  return moved;
}
function readContent(f: OpenFile, target: Uint8Array, at: number, n: number, off: number): number | Promise<Uint8Array | number> {
  if (off >= 0) return contentInto(f.content, target, at, n, off);
  if (f.readQueue) return queueRead(f, f.readQueue.then(() => contentAt(f.content, f.pos, n)).catch(() => -E.IO));
  const r = contentInto(f.content, target, at, n, f.pos);
  if (typeof r !== "number") return queueRead(f, r);
  if (r > 0) f.pos += r;
  return r;
}
/** pwrite(2) leaves the position alone, but an O_APPEND file still takes the bytes at its end, as Linux does */
function writeContent(f: OpenFile, bytes: Uint8Array, off: number): number {
  const at = f.statusFlags & O_APPEND ? f.content.len : off < 0 ? f.pos : off;
  vfs.writeAt(f.content, at, bytes);
  if (off < 0) f.pos = at + bytes.length;
  return bytes.length;
}
function seekPosition(f: OpenFile, off: number, whence: number): number {
  if (whence < 0 || whence > 2) return -E.INVAL;
  const np = whence === 0 ? off : whence === 1 ? f.pos + off : f.content.len + off;
  return np < 0 ? -E.INVAL : f.pos = np;
}
function contentSource(f: OpenFile, fd: number): FileSource {
  const content = f.content;
  return {
    get size() { return content.len; },
    read(offset, length) {
      if (openFd(fd) !== f || (f.statusFlags & O_ACCMODE) === O_WRONLY) throw new Error("Bad file descriptor");
      vfs.sync(content);
      return content.source ? content.source.read(offset, length) : content.data.subarray(offset, Math.min(content.len, offset + length));
    },
  };
}
function contentStat(f: OpenFile): FdStat {
  const content = f.content, attributes = content.attributes ?? vfs.attributes(content.path);
  return openFileStat(content.path, S_IFREG | attributes.mode, content.len, attributes);
}
/** bytes read whole when opened: a procfs file's text, whose writes procfs takes, or libcore's (bytesFd) */
const SNAPSHOT: FileOps = {
  ...ANON,
  mode: S_IFREG,
  positional: true,
  read: readContent,
  write: (f, bytes) => procWrite(f.path, utf8.dec.decode(bytes)) ? bytes.length : -E.INVAL,
  seek: seekPosition,
  stat: contentStat,
  sync: () => 0,
  available: (f) => Math.max(0, f.content.len - f.pos),
  source: contentSource,
};
/** a regular file: one the vfs names (its bytes in memory or behind a lazy source), or one without a
 *  name (ashmem, an unlinked file); what a shared mapping of it shares */
const FILE: FileOps = {
  ...SNAPSHOT,
  write: writeContent,
  truncate(f, length) {
    if (length < 0 || !(f.statusFlags & O_ACCMODE)) return -E.INVAL;
    vfs.resize(f.content, length);
    return 0;
  },
  allocate(f, off, length) { if (off + length > f.content.len) vfs.resize(f.content, off + length); return 0; },
  change: (f, change, uid) => changeOpenFile(f.content.path, change, uid),
  close(f) { if (f.content.path && f.statusFlags & O_ACCMODE) closedWrite(f.content.path); },
};
/** <linux/ashmem.h>'s requests by type and number, whose direction and size bits differ by ABI */
export const ASHMEM_IOCTL = { GET_SIZE: 0x7704, SET_PROT_MASK: 0x7705, GET_PROT_MASK: 0x7706, PIN: 0x7707, UNPIN: 0x7708 };
/** An ashmem region: a file without a name, of the size it was made with, whose protection mask only narrows. fstat
 *  reports the driver's device, as libcutils and Chromium tell regions apart by. No region is purged, so a pin finds
 *  its pages as they were left (ASHMEM_NOT_PURGED). */
const REGION: FileOps = {
  ...FILE,
  write: (f, bytes, off) => (off < 0 ? f.pos : off) + bytes.length > f.content.len ? -E.INVAL : writeContent(f, bytes, off),
  truncate: (f, length) => length === f.content.len ? 0 : -E.INVAL,
  allocate: (f, off, length) => off + length <= f.content.len ? 0 : -E.INVAL,
  stat: (f) => ({ ...contentStat(f), device: ASHMEM_DEVICE }),
  ioctl(f, request, arg) {
    const region = f.content.ashmem!;
    switch (request & 0xffff) {
      case ASHMEM_IOCTL.GET_SIZE: return f.content.len;
      case ASHMEM_IOCTL.GET_PROT_MASK: return region.prot;
      case ASHMEM_IOCTL.SET_PROT_MASK:
        if (arg & ~region.prot) return -E.INVAL;
        region.prot = arg;
        return 0;
      case ASHMEM_IOCTL.PIN: case ASHMEM_IOCTL.UNPIN: return 0;
      default: return -E.NOTTY;
    }
  },
  close: (f) => releaseRegion(f.content),
};
const DIR: FileOps = {
  ...ANON,
  mode: S_IFDIR,
  positional: true,
  read: () => -E.ISDIR,
  seek: seekPosition,
  stat(f) { const attributes = vfs.attributes(f.path, true); return openFileStat(f.path, S_IFDIR | attributes.mode, 4096, attributes); },
  sync: () => 0,
  change: (f, change, uid) => changeOpenFile(f.path, change, uid),
  entries: (f) => [".", "..", ...vfs.list(f.path)],
};
/** stdin, which reads nothing, and stdout and stderr, which write lines to the log at their
 *  priority, holding each unfinished one */
const STDIO: FileOps<{ log: number; line: string }> = {
  ...ANON,
  mode: S_IFCHR | 0o666,
  positional: true,
  read: () => 0,
  write({ state }, bytes) {
    state.line += utf8.dec.decode(bytes);
    let i: number;
    while ((i = state.line.indexOf("\n")) >= 0) { logLine(state.log, state.log === 6 ? "stderr" : "stdout", state.line.slice(0, i)); state.line = state.line.slice(i + 1); }
    return bytes.length;
  },
  seek: seekPosition,
  available: () => 0,
};
/** /dev/null reads nothing and /dev/urandom random bytes; writes to either are taken and dropped */
const charDevice = (read: (target: Uint8Array) => number): FileOps => ({
  ...ANON,
  mode: S_IFCHR | 0o666,
  positional: true,
  read: (_f, target, at, n) => read(target.subarray(at, at + n)),
  write: (_f, bytes) => bytes.length,
  seek: (f) => f.pos,                                                             // noop_llseek
  available: () => -E.INVAL,
});
const RANDOM = charDevice((target) => { randomBytes(target); return target.length; });
const DEVICE_OPS: Record<CharDevice, FileOps> = { "/dev/null": charDevice(() => 0), "/dev/urandom": RANDOM, "/dev/random": RANDOM };

/** an open of a file this realm holds */
export function localOpen(name: string, flags: number): number {
  const path = vfs.norm(name), access = flags & O_ACCMODE, status = flags & (O_ACCMODE | O_APPEND | O_NONBLOCK), cloexec = !!(flags & O_CLOEXEC);
  if (isCharDevice(path)) return installFile(newFile(DEVICE_OPS[path], path, status, undefined), cloexec);
  const s = procText(path);
  if (s !== null) {
    if (access && !procWritable(path)) return -E.ACCES;
    const b = utf8.enc.encode(s);
    return installFile(newFile(SNAPSHOT, path, status, undefined, { path: null, data: b, len: b.length }), cloexec);
  }
  if (vfs.isDir(path)) return access ? -E.ISDIR : installFile(newFile(DIR, path, status, undefined, undefined, true), cloexec);
  if (flags & O_DIRECTORY) return -(vfs.exists(path) ? E.NOTDIR : E.NOENT);
  const existing = vfs.open(path), fifo = fifoOf(existing);
  if (fifo) return holdFifo(fifo, 0) ? openFifo(path, fifo, flags, existing!) : -E.NXIO;
  if (access && existing?.source && !writable(existing.source)) return -E.ACCES;
  if (!existing) {
    if (!(flags & O_CREAT)) return -E.NOENT;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!vfs.isDir(parent)) return -E.NOENT;
    vfs.write(path, new Uint8Array(0));
  } else if (flags & O_CREAT && flags & O_EXCL) return -E.EXIST;
  if (flags & O_TRUNC && access) vfs.write(path, new Uint8Array(0));
  return installFile(newFile(FILE, path, status, undefined, vfs.open(path)!), cloexec);
}
/** a Java-side open of `bytes` into the descriptor table native code reads, so a fd handed across JNI is live */
export const bytesFd = (bytes: Uint8Array): number => installFile(newFile(SNAPSHOT, "", O_RDONLY, undefined, { path: null, data: bytes, len: bytes.length }));
/** a descriptor, close-on-exec, on the ashmem region `content` */
export const regionFd = (content: VfsFile): number => installFile(newFile(REGION, "", O_RDWR, undefined, content), true);
/** the file a descriptor reads and writes, which a shared mapping of it shares */
export function fdFile(fd: number): VfsFile | null {
  const f = openFd(fd);
  return f?.ops === FILE || f?.ops === REGION ? f.content : null;
}

/** EPIPE's signal: a write to a pipe or stream socket no one reads any more raises SIGPIPE in the
 *  writer, unless the call passed MSG_NOSIGNAL */
export function written(cpu: Cpu | null, f: OpenFile, r: number, flags = 0): number {
  if (r === -E.PIPE && cpu && !(flags & MSG_NOSIGNAL) && !f.ops.messages(f)) cpu.kill(SIGPIPE);
  return r;
}
/** write(2) of `n` bytes of guest memory at `p` */
export function fdWrite(cpu: Cpu | null, fd: number, p: number, n: number): number | Promise<number> {
  const r = writeFd(fd, mem.bytes(p, n));
  return r === -E.PIPE ? written(cpu, openFd(fd)!, r) : r;
}
/** readv/writev: each iovec in turn until a transfer comes up short, as the kernel does. `op` is
 *  told what the call has moved so far: a read that would then have to wait moves nothing. */
function vectored(iov: number, count: number, op: (p: number, n: number, moved: number) => number | Promise<number>): number | Promise<number> {
  if (count < 0 || count > 1024) return -E.INVAL;
  const at = anchor(iov);
  const from = (i: number, done: number): number | Promise<number> => {
    for (; i < count; i++) {
      const entry = at(i * 2 * PTR), len = mem.ld32(entry + PTR) >>> 0;
      if (!len) continue;
      const r = op(ldp(entry), len, done);
      if (r instanceof Promise) return r.then((n) => n < 0 ? done || n : n < len ? done + n : from(i + 1, done + n));
      if (r < 0) return done || r;
      done += r;
      if (r < len) break;
    }
    return done;
  };
  return from(0, 0);
}
function readWouldWait(fd: number): boolean {
  const f = openFd(fd);
  return !!f && !(f.ops.poll(f, POLLIN) & (POLLIN | POLLHUP | POLLERR));
}
/** fstat(2): the descriptor's record, or its device node's, or -errno */
export function statFd(fd: number): Stat | number | Promise<Stat | number> {
  const f = openFd(fd);
  return f ? complete(f.ops.stat(f), (s) => !s ? -E.BADF : s.device ? fullStat(s.device, { ...s, mode: S_IFCHR | 0o666, size: 0 })
    : fullStat(s.path ?? f.path, s)) : -E.BADF;
}
/** a stat call's record into the struct stat at `buf` */
export function putStat(buf: number, stat: Stat | number | Promise<Stat | number>): number | Promise<number> {
  if (!(stat instanceof Promise)) { if (typeof stat !== "number") { fillStat(buf, stat); return 0; } return stat; }
  const at = anchor(buf);
  return stat.then((s) => { if (typeof s === "number") return s; fillStat(at(), s); return 0; });
}
/** getdents64: linux_dirent64 records from the fd's position on */
export function getdents64(fd: number, buf: number, size: number): number | Promise<number> {
  const f = openFd(fd);
  if (!f) return -E.BADF;
  const entries = f.ops.entries(f);
  if (!(entries instanceof Promise)) return typeof entries === "number" ? entries : dirents(f, entries, buf, size);
  const at = anchor(buf);
  return entries.then((e) => typeof e === "number" ? e : dirents(f, e, at(), size));
}
function dirents(f: OpenFile, entries: string[], buf: number, size: number): number {
  let at = 0;
  for (; f.pos < entries.length; f.pos++) {
    const name = utf8.enc.encode(entries[f.pos] + "\0"), reclen = (DIRENT64.name + name.length + 7) & ~7;
    if (at + reclen > size) break;
    putDirent(buf + at, f.pos + 1, reclen, f.ops !== DIR ? 0 : vfs.isDir(`${f.path}/${entries[f.pos]}`) ? 4 : 8, name);
    at += reclen;
  }
  return at || f.pos >= entries.length ? at : -E.INVAL;
}
/** fallocate(2): mode 0 allocates; punching holes and collapsing ranges are not supported */
export const fallocate = (fd: number, mode: number, off: number, length: number): number | Promise<number> => mode ? -E.NOTSUP : allocateFd(fd, off, length);
export function makePipe(out: number, flags: number): number {
  const [read, write] = pipeFds(flags);
  mem.st32(out, read); mem.st32(out + 4, write);
  return 0;
}
/** statfs and statvfs of the one filesystem: the storage estimate in 4K blocks, 0x10000 inodes and
 *  half of them free, 255-byte names */
type StorageStat = { bsize: number; blocks: number; bfree: number; files: number; ffree: number; namemax: number };
export const storageStat = (): Promise<StorageStat> => storageEstimate().then(({ total, free }) =>
  ({ bsize: 4096, blocks: Math.floor(total / 4096), bfree: Math.floor(free / 4096), files: 0x10000, ffree: 0x8000, namemax: 255 }));
/** statfs(2) into `buf`: f_type and f_bsize are longs; the counts after them are 64-bit on both ABIs
 *  (the ILP32 struct is the kernel's statfs64), then fsid, f_namelen and f_frsize */
function statfs(buf: number): Promise<number> {
  const at = anchor(buf);
  return storageStat().then((s) => {
    const b = at(), counts = b + 2 * PTR;
    mem.memset(b, 0, KLAYOUT.STATFS_SIZE);
    stLong(b + PTR, s.bsize);
    [s.blocks, s.bfree, s.bfree, s.files, s.ffree].forEach((n, i) => mem.st64(counts + i * 8, BigInt(n)));
    stLong(counts + 48, s.namemax); stLong(counts + 48 + PTR, s.bsize);
    return 0;
  });
}

// The path operations, where each path lives
/** a name relative to directory descriptor `dirfd`, as the *at calls resolve it, or -errno */
export function resolveAt(dirfd: number, name: string): string | number {
  if (name.startsWith("/") || dirfd === AT_FDCWD) return name;
  const dir = openFd(dirfd);
  if (!dir) return -E.BADF;
  return dir.dir ? dir.path + "/" + name : -E.NOTDIR;
}
/** stat(2) of a path: its record, or -errno */
export function statAt(path: string): Stat | number | Promise<Stat | number> {
  const p = vfs.norm(path);
  return complete(filePaths(p).fileStat(p), ({ errno, value }) => value ? fullStat(p, value) : -(errno || E.NOENT));
}
const PROC_EXE = /^\/proc\/(?:self|thread-self|(\d+))\/exe$/;
/** readlink(2)'s target, or -errno: /proc's exe is the app_process the zygote of the process's width runs;
 *  no other path here is a symbolic link */
export function linkTarget(path: string): string | number | Promise<string | number> {
  const p = vfs.norm(path), exe = PROC_EXE.exec(p);
  if (exe && (!exe[1] || +exe[1] === procIdentity.pid)) return `/system/bin/app_process${is64BitProcess() ? 64 : 32}`;
  return complete(statAt(p), (s) => typeof s === "number" ? s : -E.INVAL);
}
/** readlink's copy of the target into `buf`: as much as fits, with no NUL */
export const readlinkInto = (path: string, buf: number, size: number): number | Promise<number> => size <= 0 ? -E.INVAL :
  complete(linkTarget(path), (target) => {
    if (typeof target === "number") return target;
    const bytes = utf8.enc.encode(target).subarray(0, size);
    mem.u8.set(bytes, buf);
    return bytes.length;
  });
export function faccessatPath(dirfd: number, name: string, mode: number, flags: number): number | Promise<number> {
  const path = resolveAt(dirfd, name);
  if (flags & ~(0x100 | 0x200) || mode & ~7) return -E.INVAL;
  return typeof path === "string" ? filePaths(path).fileAccess(path, mode) : path;
}
/** mknod(2) unprivileged: a fifo or an empty regular file; device nodes need CAP_MKNOD */
export function mknodAt(path: string, mode: number): number | Promise<number> {
  const type = mode & 0xf000;
  if (type === S_IFIFO) return filePaths(path).fileFifo(path);
  if (type === 0 || type === S_IFREG) return filePaths(path).fileCreate(path);
  return -(type === S_IFCHR || type === 0x6000 ? E.PERM : E.INVAL);
}
/** a directory's entries as readdir lists them, or -errno */
export const listAt = (path: string): string[] | number | Promise<string[] | number> =>
  complete(filePaths(path).fileList(path), ({ errno, value }) => value ? [".", "..", ...value] : -(errno || E.NOENT));
/** the *at calls' path, resolved: `op`'s answer, or the resolution's -errno */
const inDir = <T>(dirfd: number, name: string, op: (path: string) => T): T | number => {
  const path = resolveAt(dirfd, name);
  return typeof path === "string" ? op(path) : path;
};
const UTIME_NOW = 0x3fffffff, UTIME_OMIT = 0x3ffffffe;
/** the modification time utimensat's `times` (struct timespec[2]) sets: now without them, none when omitted */
export function modifiedTime(times: number): AttributeChange {
  if (!times) return { mtime: Date.now() };
  const mtime = times + KLAYOUT.TS_SIZE, nsec = ldLong(mtime + KLAYOUT.TS_NSEC);
  return nsec === UTIME_OMIT ? {} : { mtime: nsec === UTIME_NOW ? Date.now() : readTs(mtime) };
}

/** the descriptors a process starts with (stdin, and stdout/stderr into the log) and the hooks
 *  the file system keeps */
export function fsInit(): void {
  hookInotify();
  procMemory.resident = () => mem.u8.byteLength;
  placeFile(0, newFile(STDIO, "/dev/stdin", O_RDONLY, { log: 0, line: "" }));
  placeFile(1, newFile(STDIO, "/dev/stdout", O_WRONLY, { log: 4, line: "" }));
  placeFile(2, newFile(STDIO, "/dev/stderr", O_WRONLY, { log: 6, line: "" }));
}

export const FS_SYSCALLS: Record<string, HostFn> = {
  openat: (_c, a) => { const dirfd = a.i(), name = a.str(), flags = a.i(); return inDir(dirfd, name, (path) => processOpenFd(path, flags)); },
  close: (_c, a) => closeFd(a.i()),
  read: (_c, a) => readFd(a.i(), a.p(), a.u()),
  write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
  readv: (_c, a) => { const fd = a.i(); return vectored(a.p(), a.i(), (p, n, moved) => moved && readWouldWait(fd) ? 0 : readFd(fd, p, n)); },
  writev: (cpu, a) => {
    const fd = a.i(), iov = a.p(), count = a.i(), f = openFd(fd);
    if (f?.ops.messages(f)) return complete(f.ops.write(f, gather(iov, count), -1), (r) => written(cpu, f, r));
    return vectored(iov, count, (p, n) => fdWrite(cpu, fd, p, n));
  },
  pread64: (_c, a) => preadFd(a.i(), a.p(), a.u(), Number(a.l())),
  pwrite64: (_c, a) => { const fd = a.i(), p = a.p(), n = a.u(); return pwriteFd(fd, mem.bytes(p, n), Number(a.l())); },
  lseek: (_c, a) => seekFd(a.i(), offArg(a), a.i()),
  fstat: (_c, a) => { const fd = a.i(); return putStat(a.p(), statFd(fd)); },
  fstatat: (_c, a) => {
    const fd = a.i(), name = a.str(), buf = a.p(), flags = a.i();
    if (flags & ~(0x100 | 0x1000)) return -E.INVAL;
    if (!name) return flags & 0x1000 ? putStat(buf, statFd(fd)) : -E.NOENT;
    return inDir(fd, name, (path) => putStat(buf, statAt(path)));
  },
  fchmod: (_c, a) => changeFdAttributes(a.i(), { mode: a.i() }),
  fchown: (_c, a) => changeFdAttributes(a.i(), { uid: a.i(), gid: a.i() }),
  umask: () => 0o22,
  renameat: (_c, a) => {
    const from = resolveAt(a.i(), a.str());
    if (typeof from !== "string") return from;
    return inDir(a.i(), a.str(), (to) => filePaths(from, to).fileRename(from, to));
  },
  mkdirat: (_c, a) => inDir(a.i(), a.str(), (path) => filePaths(path).fileMkdir(path)),
  mknodat: (_c, a) => { const dirfd = a.i(), name = a.str(), mode = a.i(); return inDir(dirfd, name, (path) => mknodAt(path, mode)); },
  ftruncate: (_c, a) => truncateFd(a.i(), offArg(a)),
  fallocate: (_c, a) => { const fd = a.i(), mode = a.i(), off = Number(a.l()); return fallocate(fd, mode, off, Number(a.l())); },
  // the raw call has no flags, libc's (libc32/stdio.ts) has
  faccessat: (_c, a) => faccessatPath(a.i(), a.str(), a.i(), 0),
  getdents64: (_c, a) => getdents64(a.i(), a.p(), a.u()),
  truncate: (_c, a) => {
    const path = a.str(), n = offArg(a);
    return complete(processOpenFd(path, 1), fd => fd < 0 ? fd : complete(truncateFd(fd, n), r => complete(closeFd(fd), () => r)));
  },
  fcntl: (_c, a) => {
    const fd = a.i(), cmd = a.i();
    if ((cmd === 5 || cmd === 12) && openFd(fd)) {                                // F_GETLK, F_GETLK64: no lock is held
      const lock = a.p();
      if (mem.ld16u(lock) > 2) return -E.INVAL;
      mem.st16(lock, 2);
      return 0;
    }
    return fcntlFd(fd, cmd, a.i());
  },
  fsync: (_c, a) => syncFd(a.i()), fdatasync: (_c, a) => syncFd(a.i()),
  syncfs: (_c, a) => openFd(a.i()) ? 0 : -E.BADF,
  dup: (_c, a) => dupFd(a.i()),
  dup3: (_c, a) => {
    const fd = a.i(), to = a.i(), flags = a.i();
    if (fd === to || (flags & ~O_CLOEXEC)) return -E.INVAL;
    return dup2Fd(fd, to, !!(flags & O_CLOEXEC));
  },
  pipe2: (_c, a) => makePipe(a.p(), a.i()),
  sendfile: () => -E.NOSYS,
  flock: () => 0,
  unlinkat: (_c, a) => { const dirfd = a.i(), name = a.str(), flags = a.i(); return inDir(dirfd, name, (path) => filePaths(path).fileRemove(path, !!(flags & 0x200))); },
  // no links to follow, so fchmodat's flags change nothing
  fchmodat: (_c, a) => { const dirfd = a.i(), name = a.str(), mode = a.i(); return inDir(dirfd, name, (path) => filePaths(path).fileSetAttributes(path, { mode })); },
  utimensat: (_c, a) => {
    const dirfd = a.i(), name = a.p(), change = modifiedTime(a.p());
    if (!name) return changeFdAttributes(dirfd, change);
    return inDir(dirfd, mem.cstr(name), (path) => filePaths(path).fileSetAttributes(path, change));
  },
  // FIONREAD answers into its argument; the other requests take a value and answer one
  ioctl: (_c, a) => {
    const fd = a.i(), request = a.i();
    if (request !== FIONREAD) return ioctlIntFd(fd, request, a.u());
    const destination = anchor(a.p());
    return complete(ioctlIntFd(fd, request), n => {
      if (n < 0) return n;
      mem.st32(destination(), n);
      return 0;
    });
  },
  statfs: (_c, a) => { a.str(); return statfs(a.p()); },
  fstatfs: (_c, a) => { a.i(); return statfs(a.p()); },
  statfs64: (_c, a) => { a.str(); return statfs(a.p()); },
  fstatfs64: (_c, a) => { a.i(); return statfs(a.p()); },
  // the length with its NUL
  getcwd: (_c, a) => { const b = a.p(), n = a.u(); return n < 2 ? -E.RANGE : mem.putCstr(b, "/", n) + 1; },
  chdir: () => 0,
  readlinkat: (_c, a) => { const dirfd = a.i(), name = a.str(), buf = a.p(), size = a.i(); return inDir(dirfd, name, (path) => readlinkInto(path, buf, size)); },
};
