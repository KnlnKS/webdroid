// The kernel's descriptor table and file system over the JVM vfs: files, pipes and fifos,
// eventfd, epoll, inotify, timerfd and sockets (socket/), shared by a raw syscall, the ARM32
// libc's wrappers (stdio.ts) and libcore's descriptors (the java*Fd exports).

import { mem, guestAt, anchor } from "./mem";
import { type HostFn, PTR, ldp, stLong, ARG0 } from "./host";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { fail, kernelResult, utf8, logLine, offArg, randomBytes } from "./libc";
import { KLAYOUT } from "./syscall";
import { vfs, EMPTY, storageEstimate, type VfsFile, type FileAttributes } from "../shell/vfs";
import { remoteFilePath } from "../shell/file-path";
import { procMemory, procText, procWritable, procWrite } from "../shell/procfs";
import { readAt, readFully, writable, type FileSource } from "../shell/lazyfile";
import { concat, utf8 as codec } from "../jvm/abi";
import { allocateFd, releaseFd, reserveFd, fdsanOwnerTag, fdsanExchangeOwnerTag } from "./fd";
import { armClockTimer, disarmClockTimer, timerState, setClockTimer, type ClockTimer } from "./timers";
import { gather, MSG_NOSIGNAL, SOCK_STREAM } from "./socket/abi";
import { SIGPIPE } from "./signals";
import type { Socket, Received } from "./socket/core";
import type { Epoll } from "./poll";
import { processOpenFd, processCloseFd, processReadFd, processPreadFd, processWriteFd, processPwriteFd,
  processSeekFd, processSyncFd, processTruncateFd, processFcntlFd, processFdStat, processIoctlIntFd, type RemoteDescriptor } from "./process-fd";

export const O_ACCMODE = 3, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400, O_NONBLOCK = 0x800, O_DIRECTORY = 0x4000, O_CLOEXEC = 0x80000;
export const POLLIN = 1, POLLPRI = 2, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32, POLLRDHUP = 0x2000;
const O_RDWR = 2;
const S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFIFO = 0x1000, S_IFCHR = 0x2000, S_IFSOCK = 0xc000;

/** a pipe: byte chunks, whoever is parked waiting for them (a reader, or an epoll_wait), and its
 *  open write ends, the last of which closing is its readers' end of file. `closed` also stands for
 *  a reader gone (or shut down), which a writer meets as EPIPE. */
interface Pipe { q: Uint8Array[]; wake: (() => void)[]; writers: number; closed: boolean; named?: boolean }
interface Inotify { watches: Map<number, { path: string; mask: number; dir: boolean }>; nextWd: number; pipe: Pipe }
/** an open file: what descriptors dup(2) and SCM_RIGHTS share */
export interface OpenFile {
  path: string; content: VfsFile; pos: number; write: boolean; dir: boolean; statusFlags: number; references: number; line?: string; synthetic?: boolean;
  /** a writable /proc file, whose writes procWrite takes */
  proc?: boolean;
  timer?: ClockTimer; readQueue?: Promise<void>; byte?: number; random?: boolean; log?: number; rpipe?: Pipe; wpipe?: Pipe; event?: { count: number; wake: (() => void)[] }; epoll?: Epoll; inotify?: Inotify;
  socket?: Socket;
  remote?: RemoteDescriptor;
  /** a remote directory's entries, listed when reading starts */
  entries?: string[];
  /** run when the last descriptor sharing this open file closes it */
  onLastClose?: () => void;
}
type Fd = OpenFile;
const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_GETLK = 5, F_GETLK64 = 12;
export const F_DUPFD_CLOEXEC = 0x406;
const EAGAIN = E.AGAIN;
const IN_MODIFY = 0x2, IN_CLOSE_WRITE = 0x8, IN_CREATE = 0x100, IN_DELETE = 0x200, IN_DELETE_SELF = 0x400, IN_IGNORED = 0x8000;
const IN_NONBLOCK = 0x800, IN_CLOEXEC = 0x80000, IN_MASK_ADD = 0x20000000, IN_ONLYDIR = 0x01000000;
const newPipe = (writers: number): Pipe => ({ q: [], wake: [], writers, closed: false });
/** named pipes (mkfifo) in this process, by the file that names them: every open shares the one
 *  pipe, which outlives its descriptors and goes with its file; Realm's interprocess condition
 *  variables signal through them */
const fifos = new WeakMap<VfsFile, Pipe>();
/** this process's pipes for fifos another realm names; their contents stay per process */
const remoteFifos = new Map<string, Pipe>();
const namedPipe = (): Pipe => ({ ...newPipe(0), named: true });
/** a name only: volatile, as a fifo that outlived a reload would come back a regular file */
export function makeFifo(cpu: Cpu | null, path: string): number {
  const p = vfs.norm(path), taken = newName(cpu, p);
  if (taken) return taken;
  vfs.markVolatile(p);
  vfs.write(p, new Uint8Array(0));
  fifos.set(vfs.open(p)!, namedPipe());
  return 0;
}
export const isFifo = (path: string): boolean => { const file = vfs.open(path); return !!file && fifos.has(file); };
function openFifo(path: string, content: VfsFile, fifo: Pipe, flags: number): number {
  const acc = flags & O_ACCMODE;
  if (acc !== 0) { fifo.writers++; fifo.closed = false; }
  return put({ ...fdBase(path), content, rpipe: acc !== 1 ? fifo : undefined, wpipe: acc !== 0 ? fifo : undefined, write: acc !== 0,
    statusFlags: flags & (O_ACCMODE | O_NONBLOCK) }, !!(flags & O_CLOEXEC));
}
/** opens this process's pipe for a fifo the owning realm names */
export function openRemoteFifo(path: string, flags: number): number {
  let fifo = remoteFifos.get(path);
  if (!fifo) remoteFifos.set(path, fifo = namedPipe());
  return openFifo(path, fdBase(path).content, fifo, flags);
}
const inotifies = new Set<Inotify>();
function inotifyEvent(state: Inotify, wd: number, mask: number, name = ""): void {
  const bytes = name ? utf8(name + "\0") : new Uint8Array(0);
  const len = (bytes.length + 3) & ~3, event = new Uint8Array(16 + len);
  const view = new DataView(event.buffer);
  view.setInt32(0, wd, true); view.setUint32(4, mask, true); view.setUint32(12, len, true);
  event.set(bytes, 16);
  state.pipe.q.push(event);
  wakeAll(state.pipe);
}
function notifyInotify(path: string, mask: number, parentMask = mask): void {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/", name = path.slice(path.lastIndexOf("/") + 1);
  for (const state of inotifies) for (const [wd, watch] of state.watches) {
    const direct = watch.path === path, child = watch.dir && watch.path === parent;
    const eventMask = direct ? mask : child ? parentMask : 0;
    if (eventMask & watch.mask) inotifyEvent(state, wd, eventMask & watch.mask, child ? name : "");
  }
}
function inotifyVfsChange(path: string, change: "modify" | "write" | "create" | "delete"): void {
  if (change === "write") { notifyInotify(path, IN_MODIFY); notifyInotify(path, IN_CLOSE_WRITE); }
  else if (change === "create") notifyInotify(path, IN_CREATE, IN_CREATE);
  else if (change === "delete") notifyInotify(path, IN_DELETE_SELF, IN_DELETE);
  else notifyInotify(path, IN_MODIFY);
}
let inotifyHooked = false;
function hookInotify(): void {
  if (inotifyHooked) return;
  const priorOnWrite = vfs.onWrite;
  vfs.onWrite = (path, change = "modify") => { priorOnWrite(path, change); inotifyVfsChange(path, change); };
  inotifyHooked = true;
}
const ready = (f: Fd): boolean => !!f.random || !!(f.rpipe && (f.rpipe.q.length || f.rpipe.closed)) || !!(f.event && f.event.count > 0);
function wakeAll(p: { wake: (() => void)[] }): void { for (const w of p.wake.splice(0)) w(); }
/** the fd's interest in being woken: pipe readers and epoll waiters both park here */
function waitOn(f: Fd, w: () => void): void { if (f.rpipe) f.rpipe.wake.push(w); else if (f.event) f.event.wake.push(w); }
export const fdBase = (path: string): Fd => ({ path, content: { path: null, data: new Uint8Array(0), len: 0 }, pos: 0, write: false, dir: false, statusFlags: 0, references: 1 });
const fds = new Map<number, Fd>();
const leases = new Map<number, FdLease>();
export class FdScope {
  private leases = new Set<FdLease>();
  private closed = false;
  own(fd: number): FdLease {
    if (this.closed) throw new Error("Descriptor scope has been released");
    if (!fds.has(fd)) throw new Error("Invalid scoped descriptor");
    const current = leases.get(fd);
    if (current?.owner === this) return current;
    const lease = new FdLease(fd, this);
    leases.set(fd, lease); this.leases.add(lease);
    return lease;
  }
  transfer(): void { for (const lease of this.leases) if (lease.owner === this) lease.owner = undefined; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of this.leases) if (lease.owner === this) lease.close();
    this.leases.clear();
  }
}
class FdLease {
  private callbacks = new Set<() => void>();
  constructor(private number: number, public owner: FdScope | undefined) {}
  get fd(): number { return leases.get(this.number) === this && fds.has(this.number) ? this.number : -1; }
  close(): void { if (this.fd >= 0) javaCloseFd(this.fd); }
  onClose(callback: () => void): void { this.callbacks.add(callback); }
  closed(): void { for (const callback of this.callbacks) callback(); this.callbacks.clear(); }
}
export const fdLease = (fd: number) => leases.get(fd);
/** Kernel grants are independent of temporary Java decoding ownership. */
export function detachFdScope(fd: number): void { const lease = leases.get(fd); if (lease) lease.owner = undefined; }
const closeOnExec = new Set<number>();
export const openFd = (fd: number): Fd | undefined => fds.get(fd);

/** poll(2)'s answer for one descriptor: which of `events` it is ready for, with POLLERR and POLLHUP */
export function pollEvents(fd: number, events: number): number {
  const f = fds.get(fd);
  if (!f) return POLLNVAL;
  if (f.socket) return f.socket.poll(events);
  let revents = 0;
  if (f.rpipe) {
    if (events & POLLIN && (f.rpipe.q.length || f.rpipe.closed)) revents |= POLLIN;
    if (f.rpipe.closed) revents |= POLLHUP;
  } else if (f.event) {
    if (events & POLLIN && f.event.count > 0) revents |= POLLIN;
  } else if (!f.epoll && events & POLLIN && !f.write) revents |= POLLIN;
  if (f.wpipe) revents |= f.wpipe.closed ? POLLERR : events & POLLOUT;
  else if (f.write && events & POLLOUT) revents |= POLLOUT;
  return revents;
}
/** call `wake` once the descriptor's readiness may have changed */
export function watchFd(fd: number, wake: () => void): () => void {
  const f = fds.get(fd);
  if (f?.socket) return f.socket.watch(wake);
  const waiters = f?.rpipe?.wake ?? f?.event?.wake;
  if (!waiters) return () => {};
  waiters.push(wake);
  return () => { const index = waiters.indexOf(wake); if (index >= 0) waiters.splice(index, 1); };
}

function atPath(cpu: Cpu, dirfd: number, path: string): string | number {
  if (path.startsWith("/") || dirfd === -100) return path;
  const dir = fds.get(dirfd);
  if (!dir) return fail(cpu, E.BADF);
  return dir.dir ? dir.path + "/" + path : fail(cpu, E.NOTDIR);
}
/** rename(2) over the vfs: a file keeps its lazy source, a directory carries its entries along */
export function renamePath(cpu: Cpu | null, fromPath: string, toPath: string): number {
  const from = vfs.norm(fromPath), to = vfs.norm(toPath), parent = to.slice(0, to.lastIndexOf("/")) || "/";
  if (from === to) return vfs.exists(from) ? 0 : fail(cpu, E.NOENT);
  if (!vfs.isDir(parent)) return fail(cpu, vfs.exists(parent) ? E.NOTDIR : E.NOENT);
  if (vfs.isDir(from)) {
    if (to === from || to.startsWith(from + "/")) return fail(cpu, E.INVAL);
    if (vfs.exists(to)) {
      if (!vfs.isDir(to)) return fail(cpu, E.NOTDIR);
      if (vfs.list(to).length) return fail(cpu, E.NOTEMPTY);
      vfs.rmdir(to);
    }
    const prefix = from + "/";
    for (const m of [vfs.files, vfs.lazyFiles]) {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) vfs.rename(k, to + k.slice(from.length));
    }
    for (const d of [...vfs.dirs]) if (d === from || d.startsWith(prefix)) {
      const dest = to + d.slice(from.length), attributes = vfs.attributes(d,true);
      vfs.dirs.delete(d); vfs.dirs.add(dest);vfs.metadata.delete(d);vfs.metadata.set(dest,attributes);
    }
    vfs.dirs.add(to);
    vfs.onWrite(from); vfs.onWrite(to);
    return 0;
  }
  const source = vfs.source(from);
  if (!source) return fail(cpu, E.NOENT);
  if (vfs.isDir(to)) return fail(cpu, E.ISDIR);
  vfs.rename(from, to);
  return 0;
}
const isRandomDevice = (path: string): boolean => path === "/dev/urandom" || path === "/dev/random";
export function accessPath(cpu: Cpu | null, path: string, mode: number): number {
  if (mode & ~7) return fail(cpu, E.INVAL);
  const p = vfs.norm(path);
  return vfs.exists(p) || vfs.isDir(p) || procText(p) !== null || isRandomDevice(p) ? 0 : fail(cpu, E.NOENT);
}
export function faccessatPath(cpu: Cpu, dirfd: number, name: string, mode: number, flags: number): number | Promise<number> {
  const path = atPath(cpu, dirfd, name);
  if (flags & ~(0x100 | 0x200)) return fail(cpu, E.INVAL);
  return typeof path === "string" ? accessProcess(cpu, path, mode) : path;
}
/** a name for a new entry at normalized `p`: EEXIST if taken, ENOENT without its parent directory */
function newName(cpu: Cpu | null, p: string): number {
  if (vfs.exists(p) || vfs.isDir(p)) return fail(cpu, E.EXIST);
  const parent = p.slice(0, p.lastIndexOf("/")) || "/";
  return parent !== "/" && !vfs.isDir(parent) ? fail(cpu, E.NOENT) : 0;
}
export function mkdirPath(cpu: Cpu | null, path: string): number {
  const p = vfs.norm(path), taken = newName(cpu, p);
  if (taken) return taken;
  vfs.mkdir(p); return 0;
}
/** open(O_CREAT|O_EXCL) and close: an empty file where nothing was */
export function createPath(cpu: Cpu | null, path: string): number {
  const p = vfs.norm(path), taken = newName(cpu, p);
  if (taken) return taken;
  vfs.write(p, new Uint8Array(0)); return 0;
}
/** unlink(2) with `directory` false, rmdir(2) with true, and remove(3) when it is omitted */
export function removePath(cpu: Cpu | null, path: string, directory?: boolean): number {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) return directory ? fail(cpu, vfs.exists(p) ? E.NOTDIR : E.NOENT) : vfs.delete(p) ? 0 : fail(cpu, E.NOENT);
  if (directory === false) return fail(cpu, E.ISDIR);
  if (vfs.list(p).length) return fail(cpu, E.NOTEMPTY);
  vfs.rmdir(p); return 0;
}
export function fdOpen(cpu: Cpu | null, path: string, flags: number): number {
  path = vfs.norm(path);
  const acc = flags & O_ACCMODE;
  if (isRandomDevice(path)) {
    if (acc !== 0) return fail(cpu, E.ACCES);
    return put({ ...fdBase(path), random: true }, !!(flags & O_CLOEXEC));
  }
  const s = procText(path);
  if (s !== null) {
    if (acc !== 0 && !procWritable(path)) return fail(cpu, E.ACCES);
    const b = utf8(s);
    return put({ ...fdBase(path), content: { path: null, data: b, len: b.length }, synthetic: true, proc: acc !== 0 }, !!(flags & O_CLOEXEC));
  }
  if (vfs.isDir(path)) {
    if (acc !== 0) return fail(cpu, E.ISDIR);
    return put({ ...fdBase(path), dir: true }, !!(flags & O_CLOEXEC));
  }
  if (flags & O_DIRECTORY) return fail(cpu, vfs.exists(path) ? E.NOTDIR : E.NOENT);
  const existing = vfs.open(path), fifo = existing && fifos.get(existing);
  if (fifo) return openFifo(path, existing, fifo, flags);
  if (acc !== 0 && existing?.source && !writable(existing.source)) return fail(cpu, E.ACCES);
  if (!existing) {
    if (!(flags & O_CREAT)) return fail(cpu, E.NOENT);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!vfs.isDir(parent)) return fail(cpu, E.NOENT);
    vfs.write(path, new Uint8Array(0));
  } else if (flags & O_CREAT && flags & O_EXCL) return fail(cpu, E.EXIST);
  if (flags & O_TRUNC && acc !== 0) vfs.write(path, new Uint8Array(0));
  return put({ ...fdBase(path), content: vfs.open(path)!, write: acc !== 0, statusFlags: flags & (O_ACCMODE | O_APPEND | O_NONBLOCK) }, !!(flags & O_CLOEXEC));
}
function put(f: Fd, cloexec = false, min = 0): number { const fd = allocateFd(min); fds.set(fd, f); if (cloexec) closeOnExec.add(fd); return fd; }
/** a Java-side open into the same descriptor table native code reads, so a fd handed across JNI is live */
export const javaBytesFd = (bytes: Uint8Array): number => put({ ...fdBase(""), content: { path: null, data: bytes, len: bytes.length }, synthetic: true });
export const javaOpenFd = (path: string, flags: number): number => fdOpen(null, path, flags);
export const javaCloseFd = (fd: number): number => fdClose(null, fd);
export function javaOnLastClose(fd: number, hook: () => void): void { const f = fds.get(fd); if (f) f.onLastClose = hook; }
export const javaSeekFd = (fd: number, off: number, whence: number): number => fdSeek(null, fd, off, whence);
export const javaDupFd = (fd: number): number => fdDup(null, fd);
export const javaDup2Fd = (fd: number, to: number): number => fdDup2(null, fd, to);
export const javaIsSocketFd = (fd: number): boolean => !!fds.get(fd)?.socket;
/** the socket `fd` names, or EBADF, or ENOTSOCK for another open file */
export function socketOf(fd: number): Socket | number {
  const f = fds.get(fd);
  return f?.socket ?? (f ? -E.NOTSOCK : -E.BADF);
}
/** while descriptor `fd` names `socket`: what a socket call waiting on it checks */
export const naming = (fd: number, socket: Socket) => (): boolean => fds.get(fd)?.socket === socket;
/** a new socket's descriptor, the lowest free; `flags` SOCK_NONBLOCK and SOCK_CLOEXEC */
export function installSocket(socket: Socket, flags: number): number {
  socket.file = { ...fdBase("socket"), socket, statusFlags: O_RDWR | flags & O_NONBLOCK };
  return put(socket.file, !!(flags & O_CLOEXEC));
}
/** SCM_RIGHTS's hold on an open file while a message carries it, installed in the receiver's
 *  table (this process's) at the lowest free number when the message is read, or dropped */
export const holdFile = (f: Fd): Fd => { f.references++; return f; };
export const installFile = (f: Fd, cloexec = false): number => put(f, cloexec);
/** EPIPE's signal: a write to a pipe or stream socket no one reads any more raises SIGPIPE in the
 *  writer, unless the call passed MSG_NOSIGNAL. The result as libc returns it. */
export function written(cpu: Cpu | null, f: Fd, r: number, flags = 0): number {
  if (r === -E.PIPE && cpu && !(flags & MSG_NOSIGNAL) && (!f.socket || f.socket.type === SOCK_STREAM)) cpu.kill(SIGPIPE);
  return kernelResult(cpu, r);
}
/** a socket read's bytes alone, the open files it passed dropped: read(2), recv without msg_control */
export function readSocket(fd: number, target: Uint8Array, flags = 0): number | Promise<number> {
  const f = fds.get(fd);
  if (!f?.socket) return f ? -E.NOTSOCK : -E.BADF;
  const r = f.socket.receive(fd, target, flags);
  return r instanceof Promise ? r.then(bytesOf) : bytesOf(r);
}
const bytesOf = (r: Received | number): number => {
  if (typeof r === "number") return r;
  r.rights.forEach(dropFile);
  return r.length;
};
/** the bytes behind a descriptor read at offsets: not a stream, a directory or /dev/random */
const regularContent = (f: Fd | undefined): VfsFile | null =>
  !f || f.dir || f.random || f.rpipe || f.wpipe || f.event || f.timer || f.epoll || f.inotify || f.socket ? null : f.content;
export function javaFdSource(fd: number): FileSource | null {
  const f = fds.get(fd), content = regularContent(f);
  if (!content || f?.remote) return null;
  return {
    get size() { return content.len; },
    read(offset, length) {
      if (fds.get(fd) !== f || (f!.statusFlags & O_ACCMODE) === 1) throw new Error("Bad file descriptor");
      vfs.sync(content);
      return content.source ? content.source.read(offset, length) : content.data.subarray(offset, Math.min(content.len, offset + length));
    },
  };
}
export function javaReadFd(fd: number, target: Uint8Array): number | Promise<number> {
  const f = fds.get(fd);
  if (f?.socket) return readSocket(fd, target);
  if (f && (f.dir || (f.statusFlags & O_ACCMODE) === 1)) return f.dir ? -E.ISDIR : -E.BADF;
  if (f && !f.content.source && !f.random && !f.rpipe && !f.event && !f.timer && !f.epoll) {
    const n = Math.max(0, Math.min(target.length, f.content.len - f.pos));
    vfs.sync(f.content);
    target.set(f.content.data.subarray(f.pos, f.pos + n)); f.pos += n;
    return n;
  }
  const address = mem.va(mem.malloc(target.length));
  const done = (n: number) => { if (n > 0) target.set(mem.bytes(guestAt(address), n)); return n; };
  let n: number | Promise<number>;
  try { n = fdRead(null, fd, guestAt(address), target.length); }
  catch (e) { mem.free(guestAt(address)); throw e; }
  if (n instanceof Promise) return n.then(done).finally(() => mem.free(guestAt(address)));
  try { return done(n); } finally { mem.free(guestAt(address)); }
}
/** libcore's syscalls over this table, each answering -errno on failure. The target of a read that
 *  returns a Promise is filled when it settles. */
export function javaPreadFd(fd: number, target: Uint8Array, off: number): number | Promise<number> {
  const f = fds.get(fd), error = positionalError(fd, f, off, false);
  if (error) return -error;
  if (f!.random) { randomBytes(target); return target.length; }
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(f!.content, off, target.length); }
  catch { return -E.IO; }
  const done = (bytes: Uint8Array) => { target.set(bytes); return bytes.length; };
  return value instanceof Promise ? value.then(done, () => -E.IO) : done(value);
}
export const javaWriteFd = (fd: number, bytes: Uint8Array): number => writeBytes(null, fds.get(fd), bytes);
export const javaPwriteFd = (fd: number, bytes: Uint8Array, off: number): number => pwriteBytes(null, fd, bytes, off);
export const javaTruncateFd = (fd: number, length: number): number => truncateFd(null, fd, length);
export const javaSyncFd = (fd: number): number => syncFd(null, fd);
export const javaFcntlFd = (fd: number, cmd: number, arg: number): number => fdFcntl(null, fd, cmd, arg);
/** ioctl(2) requests with an int result; FIONREAD is the one files answer */
export function javaIoctlIntFd(fd: number, request: number): number {
  return fds.has(fd) && request !== FIONREAD ? -E.NOTTY : fionread(fd);
}
export function javaFdStat(fd: number): { mode: number; size: number; path: string | null; uid: number; gid: number; mtime: number } | null {
  const f = fds.get(fd);
  if (!f || f.remote) return null;
  const path = f.dir ? f.path : f.content.path, attributes = f.content.attributes ?? vfs.attributes(path,f.dir);
  return { mode: fdMode(f), size: f.content.len, path, uid:attributes.uid,gid:attributes.gid,mtime:path ? vfs.mtime(path) : 0 };
}

/** Read from the current offset without moving seekable descriptors; streams are consumed. */
export async function javaFdBytes(fd: number): Promise<Uint8Array | null> {
  const f = fds.get(fd);
  if (!f || f.remote || f.dir || (f.statusFlags & O_ACCMODE) === 1) return null;   // processFdBytes reads a remote one
  if (!f.random && !f.rpipe && !f.wpipe && !f.event && !f.timer && !f.epoll && !f.socket) {
    vfs.sync(f.content);
    try { return f.content.source ? await readFully(f.content.source, f.pos) : f.content.data.subarray(f.pos, f.content.len); }
    catch { return null; }
  }
  const buffer = mem.malloc(65536), target = mem.va(buffer), chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const n = await fdRead(null, fd, guestAt(target), 65536);
      if (n < 0) return null;
      if (!n) return concat(chunks);
      chunks.push(mem.u8.slice(guestAt(target), guestAt(target) + n));
    }
  } finally { mem.free(guestAt(target)); }
}

export const fdOpenProcess = (cpu: Cpu | null, path: string, flags: number): number | Promise<number> => kernelResult(cpu,processOpenFd(path,flags));
export const fdCloseProcess = (cpu: Cpu | null, fd: number): number | Promise<number> => kernelResult(cpu,processCloseFd(fd));
export const fdSeekProcess = (cpu: Cpu | null, fd: number, offset: number, whence: number): number | Promise<number> => kernelResult(cpu,processSeekFd(fd,offset,whence));
export const truncateProcess = (cpu: Cpu | null, fd: number, length: number): number | Promise<number> => kernelResult(cpu,processTruncateFd(fd,length));
export function mkdirProcess(cpu: Cpu | null, path: string): number | Promise<number> {
  const calls = remoteFilePath(path);
  return calls ? kernelResult(cpu,calls.fileMkdir(vfs.norm(path))) : mkdirPath(cpu,path);
}
export function renameProcess(cpu: Cpu | null, from: string, to: string): number | Promise<number> {
  const calls = remoteFilePath(from) ?? remoteFilePath(to);
  return calls ? kernelResult(cpu,calls.fileRename(vfs.norm(from),vfs.norm(to))) : renamePath(cpu,from,to);
}
export function removeProcess(cpu: Cpu | null, path: string, directory?: boolean): number | Promise<number> {
  const calls = remoteFilePath(path);
  if (!calls) return removePath(cpu,path,directory);
  const p = vfs.norm(path);
  remoteFifos.delete(p);
  return kernelResult(cpu,calls.fileRemove(p,directory));
}
/** mknod(2) unprivileged: a fifo or an empty regular file; device nodes need CAP_MKNOD */
export function mknodProcess(cpu: Cpu, path: string, mode: number): number | Promise<number> {
  const type = mode & 0xf000, p = vfs.norm(path), calls = remoteFilePath(p);
  if (type === S_IFIFO) return calls ? kernelResult(cpu,calls.fileFifo(p)) : makeFifo(cpu,p);
  if (type === 0 || type === S_IFREG) return calls ? kernelResult(cpu,calls.fileCreate(p)) : createPath(cpu,p);
  return fail(cpu, type === S_IFCHR || type === 0x6000 ? E.PERM : E.INVAL);
}
export function accessProcess(cpu: Cpu | null, path: string, mode: number): number | Promise<number> {
  if (mode & ~7) return fail(cpu,E.INVAL);
  const calls = remoteFilePath(path);
  return calls ? kernelResult(cpu,calls.fileAccess(vfs.norm(path),mode)) : accessPath(cpu,path,mode);
}
export function statProcess(cpu: Cpu, path: string, buf: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = remoteFilePath(normalized);
  if (!calls) return statPath(cpu,normalized,buf);
  const destination = anchor(buf);
  return calls.fileStat(normalized).then(reply => {
    if (reply.errno || !reply.value) return fail(cpu,reply.errno || E.NOENT);
    const stat = reply.value;
    fillStat(destination(),stat.directory,stat.directory ? 4096 : stat.size,stat.mtime,normalized,undefined,stat,stat.fifo);
    return 0;
  });
}
function remoteRead(cpu: Cpu | null, fd: number, p: number, n: number, offset?: number): number | Promise<number> {
  const target = new Uint8Array(n), destination = anchor(p);
  const done = (result: number) => {
    if (result < 0) return fail(cpu,-result);
    if (result) mem.write(destination(),target.subarray(0,result));
    return result;
  };
  const value = offset === undefined ? processReadFd(fd,target) : processPreadFd(fd,target,offset);
  return value instanceof Promise ? value.then(done) : done(value);
}
export function fdWrite(cpu: Cpu, fd: number, p: number, n: number): number | Promise<number> {
  if (fds.get(fd)?.remote) return kernelResult(cpu,processWriteFd(fd,mem.u8.subarray(p,p+n)));
  return writeBytes(cpu, fds.get(fd), mem.u8.subarray(p, p + n));
}
/** write(2) of `bytes` to an open file, which copies what it keeps */
function writeBytes(cpu: Cpu | null, f: Fd | undefined, bytes: Uint8Array): number {
  const n = bytes.length;
  if (!f) return fail(cpu, E.BADF);
  if (f.log) {
    f.line = (f.line ?? "") + codec.dec.decode(bytes);
    let i: number;
    while ((i = f.line.indexOf("\n")) >= 0) { logLine(f.log, f.log === 6 ? "stderr" : "stdout", f.line.slice(0, i)); f.line = f.line.slice(i + 1); }
    return n;
  }
  if (f.socket) return written(cpu, f, f.socket.send(bytes, null, null));
  if (f.wpipe) {
    if (f.wpipe.closed) return written(cpu, f, -E.PIPE);
    f.wpipe.q.push(bytes.slice()); wakeAll(f.wpipe); return n;
  }
  if (f.proc) return procWrite(f.path, codec.dec.decode(bytes)) ? n : fail(cpu, E.INVAL);
  if (f.timer) return fail(cpu, E.INVAL);
  if (f.event) {
    if (n < 8) return fail(cpu, E.INVAL);
    f.event.count += new DataView(bytes.buffer, bytes.byteOffset, n).getUint32(0, true);
    wakeAll(f.event);
    return 8;
  }
  if (!f.write) return fail(cpu, E.BADF);
  if (f.statusFlags & O_APPEND) f.pos = f.content.len;
  vfs.writeAt(f.content, f.pos, bytes);
  f.pos += n;
  return n;
}
/** readv/writev: each iovec in turn until a transfer comes up short, as the kernel does. `op` is
 *  told what the call has moved so far: a read that would then have to wait moves nothing. */
function vectored(cpu: Cpu, iov: number, count: number, op: (p: number, n: number, moved: number) => number | Promise<number>): number | Promise<number> {
  if (count < 0 || count > 1024) return fail(cpu, E.INVAL);
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
  const f = fds.get(fd);
  if (f?.socket) return !(f.socket.poll(POLLIN) & (POLLIN | POLLHUP)) && !f.socket.error;
  return !!f && !!(f.rpipe || f.event) && !ready(f);
}
function fdReadAt(cpu: Cpu | null, f: Fd, p: number, n: number, off: number): number | Promise<number> {
  if (!n) return 0;
  if (f.random) { randomBytes(mem.u8.subarray(p, p + n)); return n; }
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(f.content, off, n); }
  catch { return fail(cpu, E.IO); }
  if (!(value instanceof Promise)) { mem.write(p, value); return value.length; }
  const dst = anchor(p);
  return value.then((bytes) => { mem.write(dst(), bytes); return bytes.length; }, () => fail(cpu, E.IO));
}
/** up to `n` bytes of a file at `off`, fewer only at its end as a regular file reads: a view of its data, or what its lazy source reads */
export function contentAt(content: VfsFile, off: number, n: number): Uint8Array | Promise<Uint8Array> {
  vfs.sync(content);
  const k = Math.max(0, Math.min(n, content.len - off));
  if (!k) return EMPTY;
  return content.source ? readAt(content.source, off, k) : content.data.subarray(off, off + k);
}
export function fdRead(cpu: Cpu | null, fd: number, p: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.remote) return remoteRead(cpu,fd,p,n);
  if (f.socket) {
    const target = new Uint8Array(n), dst = anchor(p);
    const land = (r: number) => { if (r < 0) return fail(cpu, -r); mem.write(dst(), target.subarray(0, r)); return r; };
    const r = readSocket(fd, target);
    return r instanceof Promise ? r.then(land) : land(r);
  }
  if (f.dir) return fail(cpu, E.ISDIR);
  if (f.inotify) {
    const q = f.inotify.pipe.q;
    if (!q.length) {
      if (f.statusFlags & O_NONBLOCK) return fail(cpu, EAGAIN);
      const at = anchor(p);
      return new Promise<void>((resolve) => f.inotify!.pipe.wake.push(resolve)).then(() => fdRead(cpu, fd, at(), n));
    }
    if (n < q[0].length) return fail(cpu, E.INVAL);
    let done = 0;
    while (q.length && done + q[0].length <= n) {
      const event = q.shift()!;
      mem.write(p + done, event);
      done += event.length;
    }
    return done;
  }
  if (f.event && n < 8) return fail(cpu, E.INVAL);
  if (f.rpipe || f.event) {
    if (!ready(f)) {
      if (f.rpipe?.closed) return 0;
      if (f.statusFlags & O_NONBLOCK) return fail(cpu, EAGAIN);
      const dst = anchor(p);
      return new Promise<void>((r) => waitOn(f, r)).then(() => fdRead(cpu, fd, dst(), n));
    }
    if (f.event) { const c = f.event.count; f.event.count = 0; mem.st64(p, BigInt(c)); return 8; }
    return takePipe(f.rpipe!, p, n);
  }
  if (f.content.source) {
    const dst = anchor(p);
    const read = (f.readQueue ?? Promise.resolve()).then(async () => {
      const result = await fdReadAt(cpu, f, dst(), n, f.pos);
      if (result > 0) f.pos += result;
      return result;
    });
    f.readQueue = read.then(() => {}, () => {});
    return read;
  }
  const result = fdReadAt(cpu, f, p, n, f.pos);
  const advance = (read: number) => { if (read > 0) f.pos += read; return read; };
  return result instanceof Promise ? result.then(advance) : advance(result);
}
/** up to `n` bytes a pipe holds, into guest memory at `p` */
function takePipe(pipe: Pipe, p: number, n: number): number {
  const q = pipe.q;
  let k = 0;
  while (k < n && q.length) {
    const c = q[0], take = Math.min(n - k, c.length);
    mem.write(p + k, c.subarray(0, take));
    k += take;
    if (take === c.length) q.shift(); else q[0] = c.subarray(take);
  }
  return k;
}
/** `n` bytes of `fd` from offset `off` into guest memory at `dst`, without moving the position */
export function readInto(cpu: Cpu, fd: number, off: number, dst: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  return f.remote ? remoteRead(cpu, fd, dst, n, off) : fdReadAt(cpu, f, dst, n, off);
}
/** the file a descriptor reads and writes, which a shared mapping of it shares */
export function fdFile(fd: number): VfsFile | null {
  const f = fds.get(fd);
  return f?.synthetic || f?.remote ? null : regularContent(f);
}
export function fdClose(cpu: Cpu | null, fd: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  const lease = leases.get(fd);
  fds.delete(fd); leases.delete(fd); closeOnExec.delete(fd); releaseFd(fd);
  lease?.closed();
  dropFile(f);
  // a socket call waiting on this descriptor ends with EBADF
  f.socket?.wake();
  return 0;
}
/** one reference to an open file gone: the last ends it */
export function dropFile(f: Fd): void {
  if (--f.references > 0) return;
  f.onLastClose?.();
  if (f.content.path && f.write) notifyInotify(f.content.path, IN_CLOSE_WRITE);
  if (f.inotify) { inotifies.delete(f.inotify); f.inotify.pipe.closed = true; wakeAll(f.inotify.pipe); }
  if (f.timer) disarmClockTimer(f.timer);
  if (f.epoll) { for (const e of f.epoll.entries.values()) e.cancel(); for (const wake of f.epoll.wake) wake(); }
  if (f.wpipe && !--f.wpipe.writers) { f.wpipe.closed = true; wakeAll(f.wpipe); }
  // a pipe nobody reads: its writers meet EPIPE (a fifo's outlives its descriptors)
  if (f.rpipe && !f.rpipe.named) f.rpipe.closed = true;
  f.socket?.close();
}
/** dup(2) and F_DUPFD: the lowest free descriptor at or above `min`, sharing fd's open file */
function fdDup(cpu: Cpu | null, fd: number, min = 0, cloexec = false): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  f.references++;
  const copy = put(f, cloexec, min);
  leases.get(fd)?.owner?.own(copy);
  return copy;
}
/** dup2's implicit close of `to`, which (unlike close) leaves bionic's fdsan owner tag in place */
function closeReplaced(cpu: Cpu | null, to: number): () => number {
  const tag = fdsanOwnerTag(to);
  if (fds.has(to)) fdClose(cpu, to);
  return () => { if (tag) fdsanExchangeOwnerTag(to, 0n, tag); return to; };
}
export function fdDup2(cpu: Cpu | null, fd: number, to: number, cloexec = false): number {
  if (to < 0) return fail(cpu, E.BADF);
  if (fd === to) return fds.has(fd) ? fd : fail(cpu, E.BADF);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  const retag = closeReplaced(cpu, to);
  f.references++;
  reserveFd(to);
  fds.set(to, f);
  leases.get(fd)?.owner?.own(to);
  if (cloexec) closeOnExec.add(to);
  return retag();
}
export function fdSeek(cpu: Cpu | null, fd: number, off: number, whence: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.rpipe || f.wpipe || f.event || f.epoll || f.timer || f.socket) return fail(cpu, E.SPIPE);
  if (f.random) return f.pos;                                                     // noop_llseek
  if (whence < 0 || whence > 2) return fail(cpu, E.INVAL);
  const np = whence === 0 ? off : whence === 1 ? f.pos + off : f.content.len + off;
  if (np < 0) return fail(cpu, E.INVAL);
  f.pos = np;
  return np;
}
/** an inode per path: a runtime's own share table keys on st_dev/st_ino */
export function inoOf(path: string): number { let h = 0x811c9dc5; for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193); return (h >>> 0) || 1; }
export function fillStat(buf: number, isDir: boolean, size: number, mtimeMs: number, path: string, file = vfs.opened(path), attributes: FileAttributes = file?.attributes ?? vfs.attributes(path,isDir), fifo = !!file && fifos.has(file)): void {
  mem.memset(buf, 0, KLAYOUT.STAT_SIZE);
  mem.st32(buf, 1);                                                                  // st_dev
  mem.st32(buf + KLAYOUT.ST_MODE, (isDir ? S_IFDIR : fifo ? S_IFIFO : S_IFREG) | attributes.mode);
  mem.st32(buf + KLAYOUT.ST_NLINK, 1);
  mem.st32(buf + KLAYOUT.ST_UID, attributes.uid); mem.st32(buf + KLAYOUT.ST_GID, attributes.gid);
  mem.st32(buf + KLAYOUT.ST_SIZE, size); mem.st32(buf + KLAYOUT.ST_SIZE + 4, 0);
  mem.st32(buf + KLAYOUT.ST_BLKSIZE, 4096);
  mem.st32(buf + KLAYOUT.ST_BLOCKS, (size + 511) >> 9);
  const sec = Math.floor(mtimeMs / 1000);
  for (const o of [KLAYOUT.ST_ATIME, KLAYOUT.ST_MTIME, KLAYOUT.ST_CTIME]) stLong(buf + o, sec);
  mem.st32(buf + KLAYOUT.ST_INO32, inoOf(path)); mem.st32(buf + KLAYOUT.ST_INO, inoOf(path));
}
/** statfs: the storage estimate in 4K blocks. f_type and f_bsize are longs; the counts after them are 64-bit on both
 *  ABIs (the ILP32 struct is the kernel's statfs64), then fsid, f_namelen and f_frsize */
function fillStatfs(b: number): Promise<number> {
  return storageEstimate().then(({ total, free }) => {
    mem.memset(b, 0, KLAYOUT.STATFS_SIZE);
    const counts = b + 2 * PTR;
    stLong(b + PTR, 4096);
    [total / 4096, free / 4096, free / 4096, 0x10000, 0x8000].forEach((n, i) => mem.st64(counts + i * 8, BigInt(Math.floor(n))));
    stLong(counts + 48, 255); stLong(counts + 48 + PTR, 4096);
    return 0;
  });
}
/** pipe2(2): the read end, then the write end */
export function javaPipeFds(flags: number): [number, number] {
  const p = newPipe(1), statusFlags = flags & O_NONBLOCK, cloexec = !!(flags & O_CLOEXEC);
  return [put({ ...fdBase("pipe"), rpipe: p, statusFlags }, cloexec),
    put({ ...fdBase("pipe"), wpipe: p, write: true, statusFlags: 1 | statusFlags }, cloexec)];
}
export function makePipe(out: number, flags: number): number {
  const [read, write] = javaPipeFds(flags);
  mem.st32(out, read); mem.st32(out + 4, write);
  return 0;
}
function makeInotify(cpu: Cpu | null, flags: number): number {
  if (flags & ~(IN_NONBLOCK | IN_CLOEXEC)) return fail(cpu, E.INVAL);
  const pipe = newPipe(0), state: Inotify = { watches: new Map(), nextWd: 1, pipe };
  inotifies.add(state);
  return put({ ...fdBase("inotify"), inotify: state, rpipe: pipe, statusFlags: flags & IN_NONBLOCK }, !!(flags & O_CLOEXEC));
}
function inotifyAddWatch(cpu: Cpu | null, fd: number, name: string, mask: number): number {
  const path = vfs.norm(name), state = fds.get(fd)?.inotify;
  if (!state) return fail(cpu, E.BADF);
  if (!vfs.exists(path)) return fail(cpu, E.NOENT);
  const dir = vfs.isDir(path);
  if (mask & IN_ONLYDIR && !dir) return fail(cpu, E.NOTDIR);
  const events = mask & ~(IN_MASK_ADD | IN_ONLYDIR);
  for (const [wd, watch] of state.watches) if (watch.path === path) {
    watch.mask = mask & IN_MASK_ADD ? watch.mask | events : events;
    return wd;
  }
  const wd = state.nextWd++;
  state.watches.set(wd, { path, mask: events, dir });
  return wd;
}
function inotifyRmWatch(cpu: Cpu | null, fd: number, wd: number): number {
  const state = fds.get(fd)?.inotify;
  if (!state) return fail(cpu, E.BADF);
  if (!state.watches.delete(wd)) return fail(cpu, E.INVAL);
  inotifyEvent(state, wd, IN_IGNORED);
  return 0;
}
/** inotify for libcore's callers (FileObserver), each answering -errno on failure; the VFS reports
 *  its changes to them as fsInit hooks it for native code */
export function javaInotifyInit(): number { hookInotify(); return makeInotify(null, IN_CLOEXEC); }
export const javaInotifyAddWatch = (fd: number, path: string, mask: number): number => inotifyAddWatch(null, fd, path, mask);
export const javaInotifyRmWatch = (fd: number, wd: number): number => inotifyRmWatch(null, fd, wd);
export function statPath(cpu: Cpu, path: string, buf: number): number {
  path = vfs.norm(path);
  if (isRandomDevice(path)) { fillStat(buf, false, 0, Date.now(), path); return 0; }
  const s = procText(path);
  if (s !== null) { fillStat(buf, false, utf8(s).length, Date.now(), path); return 0; }
  if (vfs.isDir(path)) { fillStat(buf, true, 4096, Date.now(), path); return 0; }
  const file = vfs.stat(path);
  if (!file) return fail(cpu, E.NOENT);
  fillStat(buf, false, file.size, Date.now(), path);
  return 0;
}
function statFd(cpu: Cpu, fd: number, buf: number): number | Promise<number> {
  if (fds.get(fd)?.remote) {
    const destination = anchor(buf);
    return Promise.resolve(processFdStat(fd)).then(stat => {
      if (!stat) return fail(cpu,E.BADF);
      fillStat(destination(),false,stat.size,stat.mtime,stat.path ?? fds.get(fd)?.path ?? "",undefined,{...stat,mode:stat.mode & 0o7777});
      return 0;
    });
  }
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  fillStat(buf, f.dir, f.content.len, Date.now(), f.path, f.content);
  mem.st32(buf + KLAYOUT.ST_MODE, fdMode(f));
  return 0;
}
/** st_mode of an open file: /dev/null stdio and /dev/random are character devices, and eventfd,
 *  epoll, timerfd and inotify descriptors are anonymous inodes, which carry no file type */
function fdMode(f: Fd): number {
  if (f.dir) return S_IFDIR | vfs.attributes(f.path,true).mode;
  if (f.random || f.log || f.path === "/dev/stdin") return S_IFCHR | 0o666;
  if (f.socket) return S_IFSOCK | 0o777;
  if (f.event || f.epoll || f.timer || f.inotify) return 0o600;
  return f.rpipe || f.wpipe ? S_IFIFO | 0o600 : S_IFREG | (f.content.attributes ?? vfs.attributes(f.content.path)).mode;
}

/** why pread/pwrite at `off` cannot reach fd's file, 0 when they can: streams have no offsets */
function positionalError(fd: number, f: Fd | undefined, off: number, write: boolean): number {
  if (!f) return E.BADF;
  if (!f.random && !f.dir && !regularContent(f)) return E.SPIPE;
  if (write ? !f.write : (f.statusFlags & O_ACCMODE) === 1) return E.BADF;
  return off < 0 ? E.INVAL : f.dir ? E.ISDIR : 0;
}
export function pread(cpu: Cpu, fd: number, p: number, n: number, off: number): number | Promise<number> {
  if (fds.get(fd)?.remote) return remoteRead(cpu,fd,p,n,off);
  const f = fds.get(fd), error = positionalError(fd, f, off, false);
  return error ? fail(cpu, error) : fdReadAt(cpu, f!, p, n, off);
}
/** pwrite(2) leaves the offset alone, but an O_APPEND file still takes the bytes at its end, as Linux does */
function pwriteBytes(cpu: Cpu | null, fd: number, bytes: Uint8Array, off: number): number {
  const f = fds.get(fd), error = positionalError(fd, f, off, true);
  if (error) return fail(cpu, error);
  const save = f!.pos;
  f!.pos = off;
  const r = writeBytes(cpu, f, bytes);
  f!.pos = save;
  return r;
}
export const pwrite = (cpu: Cpu, fd: number, p: number, n: number, off: number): number | Promise<number> =>
  fds.get(fd)?.remote ? kernelResult(cpu,processPwriteFd(fd,mem.u8.subarray(p,p+n),off)) : pwriteBytes(cpu, fd, mem.u8.subarray(p, p + n), off);
/** ftruncate(2): only a regular file open for writing */
export function truncateFd(cpu: Cpu | null, fd: number, n: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (n < 0 || !f?.write || !regularContent(f)) return fail(cpu, E.INVAL);
  vfs.resize(f.content, n); return 0;
}
function fdFcntl(cpu: Cpu | null, fd: number, cmd: number, arg: number): number {
  if (cmd === F_DUPFD || cmd === F_DUPFD_CLOEXEC) return arg < 0 ? fail(cpu, E.INVAL) : fdDup(cpu, fd, arg, cmd === F_DUPFD_CLOEXEC);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (cmd === F_GETFD) return closeOnExec.has(fd) ? 1 : 0;
  if (cmd === F_SETFD) { if (arg & 1) closeOnExec.add(fd); else closeOnExec.delete(fd); return 0; }
  if (cmd === F_GETFL) return f.statusFlags;
  if (cmd === F_SETFL) f.statusFlags = (f.statusFlags & ~(O_APPEND | O_NONBLOCK)) | (arg & (O_APPEND | O_NONBLOCK));
  return 0;
}
const FIONREAD = 0x541b;
/** FIONREAD: what a read could take now, or -errno for a descriptor without the request */
function fionread(fd: number): number {
  const f = fds.get(fd), pipe = f?.rpipe ?? f?.wpipe;
  if (!f) return -E.BADF;
  if (f.socket) return f.socket.available();
  if (pipe) return pipe.q.reduce((n, b) => n + b.length, 0);
  if (f.random) return -E.INVAL;
  return f.dir || !regularContent(f) ? -E.NOTTY : Math.max(0, f.content.len - f.pos);
}
/** fsync/fdatasync: the VFS has nothing to flush, but pipes and sockets cannot sync */
function syncFd(cpu: Cpu | null, fd: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  return f.rpipe || f.wpipe || f.event || f.epoll || f.timer || f.random || f.log || f.socket ? fail(cpu, E.INVAL) : 0;
}
/** fallocate's mode 0: grow the file to cover the range; 0 or a negative errno */
export function javaAllocateFd(fd: number, offset: number, len: number): number {
  const f = fds.get(fd);
  if (!f || (f.statusFlags & O_ACCMODE) === 0) return -E.BADF;
  if (offset < 0 || len <= 0) return -E.INVAL;
  if (offset + len > f.content.len) vfs.resize(f.content, offset + len);
  return 0;
}
/** a directory's entries as readdir lists them */
const dirEntries = (path: string) => [".", "..", ...vfs.list(path)];
/** linux_dirent64, which is also bionic's struct dirent */
export const DIRENT64 = { ino: 0, off: 8, reclen: 16, type: 18, name: 19 };
/** a directory's entries as readdir lists them, or a negative errno */
export function listProcess(path: string): string[] | number | Promise<string[] | number> {
  const p = vfs.norm(path), calls = remoteFilePath(p);
  if (calls) return calls.fileList(p).then(reply => reply.value ? [".", "..", ...reply.value] : -(reply.errno || E.NOENT));
  return vfs.isDir(p) ? dirEntries(p) : -(vfs.exists(p) ? E.NOTDIR : E.NOENT);
}
/** getdents64: linux_dirent64 records from the fd's position on */
export function getdents64(cpu: Cpu, fd: number, buf: number, size: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (!f.dir) return fail(cpu, E.NOTDIR);
  if (!f.remote) return dirents(cpu, f, dirEntries(f.path), buf, size);
  if (f.pos && f.entries) return dirents(cpu, f, f.entries, buf, size);
  const destination = anchor(buf);
  return Promise.resolve(listProcess(f.path)).then(entries => {
    if (typeof entries === "number") return fail(cpu, -entries);
    f.entries = entries;
    return dirents(cpu, f, entries, destination(), size);
  });
}
function dirents(cpu: Cpu, f: OpenFile, entries: string[], buf: number, size: number): number {
  let at = 0;
  for (; f.pos < entries.length; f.pos++) {
    const name = utf8(entries[f.pos]), reclen = (DIRENT64.name + name.length + 1 + 7) & ~7;
    if (at + reclen > size) break;
    const de = buf + at;
    mem.memset(de, 0, reclen);
    mem.st64(de + DIRENT64.ino, BigInt(f.pos + 1)); mem.st64(de + DIRENT64.off, BigInt(f.pos + 1));
    mem.st16(de + DIRENT64.reclen, reclen);
    mem.st8(de + DIRENT64.type, f.remote ? 0 : vfs.isDir(`${f.path}/${entries[f.pos]}`) ? 4 : 8);
    mem.write(de + DIRENT64.name, name);
    at += reclen;
  }
  return at || f.pos >= entries.length ? at : fail(cpu, E.INVAL);
}

/** the descriptors a process starts with (stdin, and stdout/stderr into the log) and the hooks
 *  the file system keeps */
export function fsInit(): void {
  hookInotify();
  procMemory.resident = () => mem.u8.byteLength;
  for (let fd = 0; fd < 3; fd++) reserveFd(fd);
  fds.set(0, fdBase("/dev/stdin"));
  fds.set(1, { ...fdBase("/dev/stdout"), write: true, statusFlags: 1, log: 4 });
  fds.set(2, { ...fdBase("/dev/stderr"), write: true, statusFlags: 1, log: 6 });
}

export const FS_SYSCALLS: Record<string, HostFn> = {
  openat: (cpu, a) => {
    const dirfd = a.i(), path = a.str(), flags = a.i();
    const resolved = atPath(cpu, dirfd, path);
    return typeof resolved === "string" ? kernelResult(cpu,processOpenFd(resolved,flags)) : resolved;
  },
  close: (cpu, a) => kernelResult(cpu,processCloseFd(a.i())),
  read: (cpu, a) => fdRead(cpu, a.i(), a.p(), a.u()),
  write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
  readv: (cpu, a) => { const fd = a.i(); return vectored(cpu, a.p(), a.i(), (p, n, moved) => moved && readWouldWait(fd) ? 0 : fdRead(cpu, fd, p, n)); },
  writev: (cpu, a) => {
    const fd = a.i(), iov = a.p(), count = a.i();
    if (fds.get(fd)?.socket?.messages) return writeBytes(cpu, fds.get(fd), gather(iov, count));
    return vectored(cpu, iov, count, (p, n) => fdWrite(cpu, fd, p, n));
  },
  pread64: (cpu, a) => pread(cpu, a.i(), a.p(), a.u(), Number(a.l())),
  pwrite64: (cpu, a) => pwrite(cpu, a.i(), a.p(), a.u(), Number(a.l())),
  lseek: (cpu, a) => {
    const wide = PTR === 8, fd = a.i(), offset = wide ? Number(a.l()) : a.i(), whence = a.i();
    const value = kernelResult(cpu,processSeekFd(fd,offset,whence));
    const done = (result: number) => wide ? BigInt(result) : result;
    return value instanceof Promise ? value.then(done) : done(value);
  },
  fstat: (cpu, a) => statFd(cpu, a.i(), a.p()),
  fstatat: (cpu, a) => {
    const fd = a.i(), name = a.str(), buf = a.p(), flags = a.i();
    if (flags & ~(0x100 | 0x1000)) return fail(cpu, E.INVAL);
    if (!name) return flags & 0x1000 ? statFd(cpu, fd, buf) : fail(cpu, E.NOENT);
    const path = atPath(cpu, fd, name);
    return typeof path === "string" ? statProcess(cpu, path, buf) : path;
  },
  fchmod: () => 0, fchown: () => 0, umask: () => 0o22,
  renameat: (cpu, a) => {
    const from = atPath(cpu, a.i(), a.str());
    if (typeof from !== "string") return from;
    const to = atPath(cpu, a.i(), a.str());
    return typeof to !== "string" ? to : renameProcess(cpu, from, to);
  },
  mkdirat: (cpu, a) => { const path = atPath(cpu, a.i(), a.str()); return typeof path === "string" ? mkdirProcess(cpu, path) : path; },
  mknodat: (cpu, a) => { const path = atPath(cpu, a.i(), a.str()); return typeof path === "string" ? mknodProcess(cpu, path, a.i()) : path; },
  ftruncate: (cpu, a) => kernelResult(cpu,processTruncateFd(a.i(),offArg(a))),
  truncate: (cpu, a) => {
    const file = vfs.open(a.str()), n = offArg(a);
    if (!file) return fail(cpu, E.NOENT);
    if (file.source && !writable(file.source)) return fail(cpu, E.ACCES);
    vfs.resize(file, n); return 0;
  },
  fcntl: (cpu, a) => {
    const fd = a.i(), cmd = a.i();
    if ((cmd === F_GETLK || cmd === F_GETLK64) && fds.has(fd)) {
      const lock = a.p();
      if (mem.ld16u(lock) > 2) return fail(cpu, E.INVAL);
      mem.st16(lock, 2);
      return 0;
    }
    return kernelResult(cpu,processFcntlFd(fd,cmd,a.i()));
  },
  fsync: (cpu, a) => kernelResult(cpu,processSyncFd(a.i())), fdatasync: (cpu, a) => kernelResult(cpu,processSyncFd(a.i())),
  syncfs: (cpu, a) => fds.has(a.i()) ? 0 : fail(cpu, E.BADF),
  dup: (cpu, a) => fdDup(cpu, a.i()),
  dup3: (cpu, a) => {
    const fd = a.i(), to = a.i(), flags = a.i();
    if (fd === to || (flags & ~O_CLOEXEC)) return fail(cpu, E.INVAL);
    return fdDup2(cpu, fd, to, !!(flags & O_CLOEXEC));
  },
  pipe2: (_c, a) => makePipe(a.p(), a.i()),
  inotify_init: (cpu) => makeInotify(cpu, 0),
  inotify_init1: (cpu, a) => makeInotify(cpu, a.i()),
  inotify_add_watch: (cpu, a) => inotifyAddWatch(cpu, a.i(), a.str(), a.u()),
  inotify_rm_watch: (cpu, a) => inotifyRmWatch(cpu, a.i(), a.i()),
  timerfd_create: (cpu, a) => {
    const clock = a.i(), flags = a.i();
    if (![0, 1, 7].includes(clock) || flags & ~(O_NONBLOCK | O_CLOEXEC)) return fail(cpu, E.INVAL);
    return put({ ...fdBase("timerfd"), timer: { clock, next: 0, interval: 0 }, event: { count: 0, wake: [] }, statusFlags: 2 | (flags & O_NONBLOCK) }, !!(flags & O_CLOEXEC));
  },
  timerfd_settime: (cpu, a) => {
    const fd = a.i(), flags = a.i(), value = a.p(), old = a.p(), f = fds.get(fd);
    if (!f) return fail(cpu, E.BADF);
    if (!f.timer || flags & ~1 || !setClockTimer(f.timer, flags, value, old)) return fail(cpu, E.INVAL);
    const event = f.event!;
    event.count = 0;
    armClockTimer(f.timer, (count) => { event.count += count; wakeAll(event); });
    return 0;
  },
  timerfd_gettime: (cpu, a) => {
    const fd = a.i(), out = a.p(), f = fds.get(fd);
    if (!f) return fail(cpu, E.BADF);
    if (!f.timer) return fail(cpu, E.INVAL);
    timerState(f.timer, out); return 0;
  },
  eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return put({ ...fdBase("eventfd"), event: { count: init, wake: [] }, statusFlags: 2 | (flags & O_NONBLOCK) }, !!(flags & O_CLOEXEC)); },
  sendfile: (cpu) => fail(cpu, E.NOSYS),
  flock: () => 0,
  unlinkat: (cpu, a) => { const path = atPath(cpu, a.i(), a.str()), flags = a.i(); return typeof path === "string" ? removeProcess(cpu, path, !!(flags & 0x200)) : path; },
  fchmodat: () => 0, utimensat: () => 0,
  ioctl: (cpu, a) => {
    const fd = a.i(), request = a.i(), argument = a.p();
    if (request !== FIONREAD) return fail(cpu, fds.get(fd)?.socket ? E.NOTTY : E.NOSYS);
    if (fds.get(fd)?.remote) {
      const destination = anchor(argument);
      return Promise.resolve(processIoctlIntFd(fd,request)).then(n => {
        if(n < 0)return fail(cpu,-n);
        mem.st32(destination(),n);return 0;
      });
    }
    const n = fionread(fd);
    if (n < 0) return fail(cpu, -n);
    mem.st32(argument, n);
    return 0;
  },
  statfs: (_c, a) => { a.str(); return fillStatfs(a.p()); },
  fstatfs: (_c, a) => { a.i(); return fillStatfs(a.p()); },
  statfs64: (_c, a) => { a.str(); return fillStatfs(a.p()); },
  fstatfs64: (_c, a) => { a.i(); return fillStatfs(a.p()); },
  getcwd: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "/", n); return ARG0; },
  chdir: () => 0,
  readlinkat: (cpu) => fail(cpu, E.INVAL),
};
