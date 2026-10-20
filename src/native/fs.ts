// The files the kernel's descriptors (fd.ts) open by path: regular files over the JVM vfs,
// directories, procfs snapshots and devices; the path calls, each where its path lives
// (file-path.ts); and the read/write family over guest memory.

import { mem, anchor, wrote } from "./mem.ts";
import { type HostFn, PTR, ldp, ldLong, ARG0, complete } from "./host.ts";
import { E, AT_FDCWD, O_ACCMODE, O_APPEND, O_CLOEXEC, O_CREAT, O_DIRECTORY, O_EXCL, O_NONBLOCK, O_RDONLY, O_RDWR, O_TRUNC, O_WRONLY,
  POLLERR, POLLHUP, POLLIN, S_IFCHR, S_IFDIR, S_IFIFO, S_IFREG } from "./abi.ts";
import type { Cpu } from "./cpu.ts";
import { DIRENT64, fillStat, fillStatfs, logLine, offArg, putDirent, randomBytes, readTs, KLAYOUT } from "./kernel.ts";
import { vfs, EMPTY, storageEstimate, type VfsFile } from "../shell/vfs.ts";
import { filePaths, changeOpenFile, isRandomDevice, openFileStat, type AttributeChange } from "../shell/file-path.ts";
import { procMemory, procText, procWritable, procWrite } from "../shell/procfs.ts";
import { readAt, writable, type FileSource } from "../shell/lazyfile.ts";
import { utf8 } from "../jvm/abi.ts";
import { ANON, FIONREAD, installFile, newFile, openFd, placeFile, refused, woken, javaChangeFdAttributes, javaCloseFd, javaDup2Fd,
  javaDupFd, javaFcntlFd, javaIoctlIntFd, javaLseekFd, javaSyncFd, javaTruncateFd, type FdStat, type FileOps, type OpenFile } from "./fd.ts";
import { fifoOf, holdFifo, javaPipeFds, openFifo } from "./pipe.ts";
import { closedWrite, hookInotify } from "./inotify.ts";
import { gather, MSG_NOSIGNAL, SOCK_STREAM } from "./socket/abi.ts";
import { SIGPIPE } from "./signals.ts";
import { processOpenFd } from "./process-fd.ts";

/** up to `n` bytes of a file at `off`, fewer only at its end as a regular file reads: a view of its data, or what its lazy source reads */
export function contentAt(content: VfsFile, off: number, n: number): Uint8Array | Promise<Uint8Array> {
  vfs.sync(content);
  const k = Math.max(0, Math.min(n, content.len - off));
  if (!k) return EMPTY;
  return content.source ? readAt(content.source, off, k) : content.data.subarray(off, off + k);
}
function contentInto(content: VfsFile, target: Uint8Array, off: number): number | Promise<Uint8Array | number> {
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(content, off, target.length); }
  catch { return -E.IO; }
  if (value instanceof Promise) return value.catch(() => -E.IO);
  target.set(value);
  return value.length;
}
/** a read at the position moves it once the bytes come, and the next read at the position waits for that */
function queueRead(f: OpenFile, read: Promise<Uint8Array | number>): Promise<Uint8Array | number> {
  const moved = read.then((v) => { if (typeof v !== "number") f.pos += v.length; return v; });
  const queue: Promise<void> = f.readQueue = moved.then(() => { if (f.readQueue === queue) f.readQueue = undefined; });
  return moved;
}
function readContent(f: OpenFile, target: Uint8Array, off: number): number | Promise<Uint8Array | number> {
  if (off >= 0) return contentInto(f.content, target, off);
  const n = target.length;
  if (f.readQueue) return queueRead(f, f.readQueue.then(() => contentAt(f.content, f.pos, n)).catch(() => -E.IO));
  const r = contentInto(f.content, target, f.pos);
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
/** bytes read whole when opened: a procfs file's text, whose writes procfs takes, or libcore's (javaBytesFd) */
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
/** stdin, which reads nothing, and stdout and stderr, which write lines to the log */
const STDIO: FileOps = {
  ...ANON,
  mode: S_IFCHR | 0o666,
  positional: true,
  read: () => 0,
  write(f, bytes) {
    f.line = (f.line ?? "") + utf8.dec.decode(bytes);
    let i: number;
    while ((i = f.line.indexOf("\n")) >= 0) { logLine(f.log!, f.log === 6 ? "stderr" : "stdout", f.line.slice(0, i)); f.line = f.line.slice(i + 1); }
    return bytes.length;
  },
  seek: seekPosition,
  available: () => 0,
};
const RANDOM: FileOps = {
  ...ANON,
  mode: S_IFCHR | 0o666,
  positional: true,
  read(_f, target) { randomBytes(target); return target.length; },
  seek: (f) => f.pos,                                                             // noop_llseek
  available: () => -E.INVAL,
};

/** an open of a file this realm holds */
export function javaOpenFd(name: string, flags: number): number {
  const path = vfs.norm(name), access = flags & O_ACCMODE, status = flags & (O_ACCMODE | O_APPEND | O_NONBLOCK), cloexec = !!(flags & O_CLOEXEC);
  if (isRandomDevice(path)) return access ? -E.ACCES : installFile(newFile(RANDOM, path, status), cloexec);
  const s = procText(path);
  if (s !== null) {
    if (access && !procWritable(path)) return -E.ACCES;
    const b = utf8.enc.encode(s);
    return installFile(newFile(SNAPSHOT, path, status, { path: null, data: b, len: b.length }), cloexec);
  }
  if (vfs.isDir(path)) return access ? -E.ISDIR : installFile(newFile(DIR, path, status, undefined, true), cloexec);
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
  return installFile(newFile(FILE, path, status, vfs.open(path)!), cloexec);
}
/** a Java-side open of `bytes` into the descriptor table native code reads, so a fd handed across JNI is live */
export const javaBytesFd = (bytes: Uint8Array): number => installFile(newFile(SNAPSHOT, "", O_RDONLY, { path: null, data: bytes, len: bytes.length }));
/** a descriptor, close-on-exec, on `content`, a file without a name (ashmem) */
export const javaAnonymousFd = (content: VfsFile): number => installFile(newFile(FILE, "", O_RDWR, content), true);
/** the file a descriptor reads and writes, which a shared mapping of it shares */
export function fdFile(fd: number): VfsFile | null {
  const f = openFd(fd);
  return f?.ops === FILE ? f.content : null;
}

/** read(2), or pread(2) at `off`, into guest memory: in place, or once the bytes come */
export function fdRead(fd: number, p: number, n: number, off = -1): number | Promise<number> {
  const f = openFd(fd), error = refused(f, off, false);
  if (error) return error;
  const r = f!.ops.read(f!, mem.bytes(p, n), off, fd);
  if (typeof r !== "number") {
    const at = anchor(p);
    return r.then((v) => typeof v === "number" ? v : (mem.write(at(), v), v.length));
  }
  if (r > 0) wrote(p, r);
  else if (r === -E.AGAIN && !(f!.statusFlags & O_NONBLOCK)) { const at = anchor(p); return woken(f!).then(() => fdRead(fd, at(), n, off)); }
  return r;
}
export const pread = (fd: number, p: number, n: number, off: number): number | Promise<number> => off < 0 ? -E.INVAL : fdRead(fd, p, n, off);
/** EPIPE's signal: a write to a pipe or stream socket no one reads any more raises SIGPIPE in the
 *  writer, unless the call passed MSG_NOSIGNAL */
export function written(cpu: Cpu | null, f: OpenFile, r: number, flags = 0): number {
  if (r === -E.PIPE && cpu && !(flags & MSG_NOSIGNAL) && (!f.socket || f.socket.type === SOCK_STREAM)) cpu.kill(SIGPIPE);
  return r;
}
/** write(2), or pwrite(2) at `off`, of guest memory */
export function fdWrite(cpu: Cpu | null, fd: number, p: number, n: number, off = -1): number | Promise<number> {
  const f = openFd(fd), error = refused(f, off, true);
  if (error) return error;
  const r = f!.ops.write(f!, mem.u8.subarray(p, p + n), off);
  return typeof r === "number" ? written(cpu, f!, r) : r;
}
export const pwrite = (fd: number, p: number, n: number, off: number): number | Promise<number> => off < 0 ? -E.INVAL : fdWrite(null, fd, p, n, off);
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
/** fstat(2) */
function statFd(fd: number, buf: number): number | Promise<number> {
  const f = openFd(fd);
  if (!f) return -E.BADF;
  const stat = f.ops.stat(f);
  if (!(stat instanceof Promise)) { fillStat(buf, stat.path ?? f.path, stat); return 0; }
  const at = anchor(buf);
  return stat.then((s) => { if (!s) return -E.BADF; fillStat(at(), s.path ?? f.path, s); return 0; });
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
export function makePipe(out: number, flags: number): number {
  const [read, write] = javaPipeFds(flags);
  mem.st32(out, read); mem.st32(out + 4, write);
  return 0;
}
function statfs(buf: number): Promise<number> {
  const at = anchor(buf);
  return storageEstimate().then((estimate) => fillStatfs(at(), estimate));
}

// The path calls, where each path lives
function atPath(dirfd: number, path: string): string | number {
  if (path.startsWith("/") || dirfd === AT_FDCWD) return path;
  const dir = openFd(dirfd);
  if (!dir) return -E.BADF;
  return dir.dir ? dir.path + "/" + path : -E.NOTDIR;
}
export function faccessatPath(dirfd: number, name: string, mode: number, flags: number): number | Promise<number> {
  const path = atPath(dirfd, name);
  if (flags & ~(0x100 | 0x200) || mode & ~7) return -E.INVAL;
  return typeof path === "string" ? filePaths(path).fileAccess(path, mode) : path;
}
export const mkdirProcess = (path: string): number | Promise<number> => filePaths(path).fileMkdir(path);
export const renameProcess = (from: string, to: string): number | Promise<number> => filePaths(from, to).fileRename(from, to);
export const removeProcess = (path: string, directory?: boolean): number | Promise<number> => filePaths(path).fileRemove(path, directory);
/** mknod(2) unprivileged: a fifo or an empty regular file; device nodes need CAP_MKNOD */
export function mknodProcess(path: string, mode: number): number | Promise<number> {
  const type = mode & 0xf000;
  if (type === S_IFIFO) return filePaths(path).fileFifo(path);
  if (type === 0 || type === S_IFREG) return filePaths(path).fileCreate(path);
  return -(type === S_IFCHR || type === 0x6000 ? E.PERM : E.INVAL);
}
export function statProcess(path: string, buf: number): number | Promise<number> {
  const p = vfs.norm(path), destination = anchor(buf);
  return complete(filePaths(p).fileStat(p), ({ errno, value }) => {
    if (!value) return -(errno || E.NOENT);
    fillStat(destination(), p, value);
    return 0;
  });
}
/** a directory's entries as readdir lists them, or a negative errno */
export const listProcess = (path: string): string[] | number | Promise<string[] | number> =>
  complete(filePaths(path).fileList(path), ({ errno, value }) => value ? [".", "..", ...value] : -(errno || E.NOENT));
/** chmod, chown and utimes of a path */
export const changeProcess = (path: string, change: AttributeChange): number | Promise<number> =>
  filePaths(path).fileSetAttributes(path, change);
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
  placeFile(0, newFile(STDIO, "/dev/stdin", O_RDONLY));
  for (const [fd, log] of [[1, 4], [2, 6]]) {
    const f = newFile(STDIO, fd === 1 ? "/dev/stdout" : "/dev/stderr", O_WRONLY);
    f.log = log;
    placeFile(fd, f);
  }
}

export const FS_SYSCALLS: Record<string, HostFn> = {
  openat: (_c, a) => {
    const dirfd = a.i(), path = a.str(), flags = a.i();
    const resolved = atPath(dirfd, path);
    return typeof resolved === "string" ? processOpenFd(resolved, flags) : resolved;
  },
  close: (_c, a) => javaCloseFd(a.i()),
  read: (_c, a) => fdRead(a.i(), a.p(), a.u()),
  write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
  readv: (_c, a) => { const fd = a.i(); return vectored(a.p(), a.i(), (p, n, moved) => moved && readWouldWait(fd) ? 0 : fdRead(fd, p, n)); },
  writev: (cpu, a) => {
    const fd = a.i(), iov = a.p(), count = a.i(), f = openFd(fd);
    if (f?.socket?.messages) return written(cpu, f, f.socket.send(gather(iov, count), null, null));
    return vectored(iov, count, (p, n) => fdWrite(cpu, fd, p, n));
  },
  pread64: (_c, a) => pread(a.i(), a.p(), a.u(), Number(a.l())),
  pwrite64: (_c, a) => pwrite(a.i(), a.p(), a.u(), Number(a.l())),
  lseek: (_c, a) => {
    const wide = PTR === 8, fd = a.i(), offset = wide ? Number(a.l()) : a.i(), whence = a.i();
    return complete(javaLseekFd(fd, offset, whence), result => wide ? BigInt(result) : result);
  },
  fstat: (_c, a) => statFd(a.i(), a.p()),
  fstatat: (_c, a) => {
    const fd = a.i(), name = a.str(), buf = a.p(), flags = a.i();
    if (flags & ~(0x100 | 0x1000)) return -E.INVAL;
    if (!name) return flags & 0x1000 ? statFd(fd, buf) : -E.NOENT;
    const path = atPath(fd, name);
    return typeof path === "string" ? statProcess(path, buf) : path;
  },
  fchmod: (_c, a) => javaChangeFdAttributes(a.i(), { mode: a.i() }),
  fchown: (_c, a) => javaChangeFdAttributes(a.i(), { uid: a.i(), gid: a.i() }),
  umask: () => 0o22,
  renameat: (_c, a) => {
    const from = atPath(a.i(), a.str());
    if (typeof from !== "string") return from;
    const to = atPath(a.i(), a.str());
    return typeof to !== "string" ? to : renameProcess(from, to);
  },
  mkdirat: (_c, a) => { const path = atPath(a.i(), a.str()); return typeof path === "string" ? mkdirProcess(path) : path; },
  mknodat: (_c, a) => { const path = atPath(a.i(), a.str()); return typeof path === "string" ? mknodProcess(path, a.i()) : path; },
  ftruncate: (_c, a) => javaTruncateFd(a.i(), offArg(a)),
  truncate: (_c, a) => {
    const path = a.str(), n = offArg(a);
    return complete(processOpenFd(path, 1), fd => fd < 0 ? fd : complete(javaTruncateFd(fd, n), r => complete(javaCloseFd(fd), () => r)));
  },
  fcntl: (_c, a) => {
    const fd = a.i(), cmd = a.i();
    if ((cmd === 5 || cmd === 12) && openFd(fd)) {                                // F_GETLK, F_GETLK64: no lock is held
      const lock = a.p();
      if (mem.ld16u(lock) > 2) return -E.INVAL;
      mem.st16(lock, 2);
      return 0;
    }
    return javaFcntlFd(fd, cmd, a.i());
  },
  fsync: (_c, a) => javaSyncFd(a.i()), fdatasync: (_c, a) => javaSyncFd(a.i()),
  syncfs: (_c, a) => openFd(a.i()) ? 0 : -E.BADF,
  dup: (_c, a) => javaDupFd(a.i()),
  dup3: (_c, a) => {
    const fd = a.i(), to = a.i(), flags = a.i();
    if (fd === to || (flags & ~O_CLOEXEC)) return -E.INVAL;
    return javaDup2Fd(fd, to, !!(flags & O_CLOEXEC));
  },
  pipe2: (_c, a) => makePipe(a.p(), a.i()),
  sendfile: () => -E.NOSYS,
  flock: () => 0,
  unlinkat: (_c, a) => { const path = atPath(a.i(), a.str()), flags = a.i(); return typeof path === "string" ? removeProcess(path, !!(flags & 0x200)) : path; },
  // no links to follow, so fchmodat's flags change nothing
  fchmodat: (_c, a) => { const path = atPath(a.i(), a.str()), mode = a.i(); return typeof path === "string" ? changeProcess(path, { mode }) : path; },
  utimensat: (_c, a) => {
    const dirfd = a.i(), name = a.p(), change = modifiedTime(a.p());
    if (!name) return javaChangeFdAttributes(dirfd, change);
    const path = atPath(dirfd, mem.cstr(name));
    return typeof path === "string" ? changeProcess(path, change) : path;
  },
  ioctl: (_c, a) => {
    const fd = a.i(), request = a.i(), argument = a.p();
    if (request !== FIONREAD) return -(openFd(fd)?.socket ? E.NOTTY : E.NOSYS);
    const destination = anchor(argument);
    return complete(javaIoctlIntFd(fd, request), n => {
      if (n < 0) return n;
      mem.st32(destination(), n);
      return 0;
    });
  },
  statfs: (_c, a) => { a.str(); return statfs(a.p()); },
  fstatfs: (_c, a) => { a.i(); return statfs(a.p()); },
  statfs64: (_c, a) => { a.str(); return statfs(a.p()); },
  fstatfs64: (_c, a) => { a.i(); return statfs(a.p()); },
  getcwd: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "/", n); return ARG0; },
  chdir: () => 0,
  readlinkat: () => -E.INVAL,
};
