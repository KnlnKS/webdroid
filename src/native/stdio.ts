// stdio + the fd table over the JVM vfs: FILE structs live in guest memory (bionic __sFILE layout)
// so the getc/putc macros and __srget refills work; /proc/cpuinfo and /proc/meminfo are synthesized.

import { mem, guestAt, wrote } from "./mem";
import { hostLib, hostData, vaList, type HostFn, PTR, stp, ldp, ARG0, ptr } from "./host";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { LAYOUT, fail, utf8, logLine, offArg, readTs, clockTime, scanSink } from "./libc";
import { format, scan } from "./printf";
import { vfs, EMPTY, type VfsFile } from "../shell/vfs";
import { procIdentity, procMemory, procText } from "../shell/procfs";
import { readFully, writable, type FileSource } from "../shell/lazyfile";
import { concat } from "../jvm/abi";
import { isNativeSocket, nativeSocketClose, nativeSocketDup, nativeSocketFcntl, nativeSocketIoctl, nativeSocketAvailable, nativeSocketRead, nativeSocketWrite, setNativePollProvider, nativePollEvents, watchNativeFd, socketReceive, socketSend } from "./net";
import { allocateFd, releaseFd, reserveFd, fdsanOwnerTag, fdsanExchangeOwnerTag } from "./fd";
import { armClockTimer, disarmClockTimer, timerState, validTime, type ClockTimer } from "./timers";
const dec = new TextDecoder();

const O_ACCMODE = 3, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400, O_NONBLOCK = 0x800, O_DIRECTORY = 0x4000, O_CLOEXEC = 0x80000;
const S_IFDIR = 0x4000, S_IFREG = 0x8000, S_IFIFO = 0x1000, S_IFCHR = 0x2000, S_IFSOCK = 0xc000;

/** a pipe: byte chunks, whoever is parked waiting for them (a reader, or an epoll_wait), and its
 *  open write ends, the last of which closing is its readers' end of file */
interface Pipe { q: Uint8Array[]; wake: (() => void)[]; writers: number; closed: boolean }
interface Inotify { watches: Map<number, { path: string; mask: number; dir: boolean }>; nextWd: number; pipe: Pipe }
interface EpollEntry { events: number; data: bigint; pending: number; disabled: boolean; cancel: () => void }
interface Epoll { entries: Map<number, EpollEntry>; wake: Set<() => void> }
interface Fd {
  path: string; content: VfsFile; pos: number; write: boolean; dir: boolean; append: boolean; statusFlags: number; references: number; line?: string; synthetic?: boolean;
  timer?: ClockTimer; readQueue?: Promise<void>; byte?: number; random?: boolean; log?: number; nonblock?: boolean; rpipe?: Pipe; wpipe?: Pipe; event?: { count: number; wake: (() => void)[] }; epoll?: Epoll; inotify?: Inotify;
  /** an AF_UNIX socket (unix.ts); a datagram one keeps each write whole */
  unix?: boolean; dgram?: boolean;
}
const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4, F_GETLK = 5, F_GETLK64 = 12, F_DUPFD_CLOEXEC = 0x406;
const EPOLLET = 0x80000000, EPOLLONESHOT = 0x40000000, EAGAIN = E.AGAIN;
const IN_MODIFY = 0x2, IN_CLOSE_WRITE = 0x8, IN_CREATE = 0x100, IN_DELETE = 0x200, IN_DELETE_SELF = 0x400, IN_IGNORED = 0x8000;
const IN_NONBLOCK = 0x800, IN_CLOEXEC = 0x80000, IN_MASK_ADD = 0x20000000, IN_ONLYDIR = 0x01000000;
const newPipe = (writers: number): Pipe => ({ q: [], wake: [], writers, closed: false });
/** named pipes (mkfifo) in this process, by the file that names them: every open shares the one
 *  pipe, which outlives its descriptors and goes with its file; Realm's interprocess condition
 *  variables signal through them */
const fifos = new WeakMap<VfsFile, Pipe>();
function makeFifo(cpu: Cpu, path: string): number {
  const p = vfs.norm(path), taken = newName(cpu, p);
  if (taken) return taken;
  vfs.write(p, new Uint8Array(0));
  fifos.set(vfs.open(p)!, newPipe(0));
  return 0;
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
const ready = (f: Fd): boolean => !!f.random || !!(f.rpipe && (f.rpipe.q.length || f.rpipe.closed)) || !!(f.event && f.event.count > 0);
function wakeAll(p: { wake: (() => void)[] }): void { for (const w of p.wake.splice(0)) w(); }
/** the fd's interest in being woken: pipe readers and epoll waiters both park here */
function waitOn(f: Fd, w: () => void): void { if (f.rpipe) f.rpipe.wake.push(w); else if (f.event) f.event.wake.push(w); }
const fdBase = (path: string): Fd => ({ path, content: { path: null, data: new Uint8Array(0), len: 0 }, pos: 0, write: false, dir: false, append: false, statusFlags: 0, references: 1 });
const fds = new Map<number, Fd>();
const closeOnExec = new Set<number>();
const files = new Map<number, number>();       // FILE* → fd
const pushback = new Map<number, number[]>();
const dirs = new Map<number, { entries: string[]; i: number; dirent: number }>();

setNativePollProvider({
  query(fd, events) {
    const f = fds.get(fd);
    if (!f) return null;
    let revents = 0;
    if (f.rpipe) {
      if (events & 1 && (f.rpipe.q.length || f.rpipe.closed)) revents |= 1;
      if (f.rpipe.closed) revents |= 16;
    } else if (f.event) {
      if (events & 1 && f.event.count > 0) revents |= 1;
    } else if (!f.epoll && events & 1 && !f.write) revents |= 1;
    if (f.wpipe) revents |= f.wpipe.closed ? 8 : events & 4;
    else if (f.write && events & 4) revents |= 4;
    return revents;
  },
  subscribe(fd, wake) {
    const f = fds.get(fd);
    const waiters = f?.rpipe?.wake ?? f?.event?.wake;
    if (!waiters) return () => {};
    waiters.push(wake);
    return () => { const index = waiters.indexOf(wake); if (index >= 0) waiters.splice(index, 1); };
  },
  read(cpu, fd, destination, length) { return fds.has(fd) ? fdRead(cpu, fd, destination, length) : null; },
  write(cpu, fd, source, length) { return fds.has(fd) ? fdWrite(cpu, fd, source, length) : null; },
});

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
    for (const d of [...vfs.dirs]) if (d === from || d.startsWith(prefix)) { vfs.dirs.delete(d); vfs.dirs.add(to + d.slice(from.length)); }
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
export function accessPath(cpu: Cpu | null, path: string, mode: number): number {
  if (mode & ~7) return fail(cpu, E.INVAL);
  const p = vfs.norm(path);
  return vfs.exists(p) || vfs.isDir(p) || procText(p) !== null || p === "/dev/urandom" || p === "/dev/random" ? 0 : fail(cpu, E.NOENT);
}
export function faccessatPath(cpu: Cpu, dirfd: number, name: string, mode: number, flags: number): number {
  const path = atPath(cpu, dirfd, name);
  if (flags & ~(0x100 | 0x200)) return fail(cpu, E.INVAL);
  return typeof path === "string" ? accessPath(cpu, path, mode) : path;
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
/** remove(3): unlink a file, or rmdir an empty directory */
export function removePath(cpu: Cpu | null, path: string): number {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) return vfs.delete(p) ? 0 : fail(cpu, E.NOENT);
  if (vfs.list(p).length) return fail(cpu, E.NOTEMPTY);
  vfs.rmdir(p); return 0;
}
function fdOpen(cpu: Cpu | null, path: string, flags: number): number {
  path = vfs.norm(path);
  const acc = flags & O_ACCMODE;
  if (path === "/dev/urandom" || path === "/dev/random") {
    if (acc !== 0) return fail(cpu, E.ACCES);
    return put({ ...fdBase(path), random: true }, !!(flags & O_CLOEXEC));
  }
  const s = procText(path);
  if (s !== null) { const b = utf8(s); return put({ ...fdBase(path), content: { path: null, data: b, len: b.length }, synthetic: true }, !!(flags & O_CLOEXEC)); }
  if (vfs.isDir(path)) {
    if (acc !== 0) return fail(cpu, E.ISDIR);
    return put({ ...fdBase(path), dir: true }, !!(flags & O_CLOEXEC));
  }
  if (flags & O_DIRECTORY) return fail(cpu, E.NOTDIR);
  const existing = vfs.open(path), fifo = existing && fifos.get(existing);
  if (fifo) {
    if (acc !== 0) { fifo.writers++; fifo.closed = false; }
    return put({ ...fdBase(path), content: existing, rpipe: acc !== 1 ? fifo : undefined, wpipe: acc !== 0 ? fifo : undefined, write: acc !== 0,
      nonblock: !!(flags & O_NONBLOCK), statusFlags: flags & (O_ACCMODE | O_NONBLOCK) }, !!(flags & O_CLOEXEC));
  }
  if (acc !== 0 && existing?.source && !writable(existing.source)) return fail(cpu, E.ACCES);
  if (!existing) {
    if (!(flags & O_CREAT)) return fail(cpu, E.NOENT);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!vfs.isDir(parent)) return fail(cpu, E.NOENT);
    vfs.write(path, new Uint8Array(0));
  } else if (flags & O_CREAT && flags & O_EXCL) return fail(cpu, E.EXIST);
  if (flags & O_TRUNC && acc !== 0) vfs.write(path, new Uint8Array(0));
  return put({ ...fdBase(path), content: vfs.open(path)!, write: acc !== 0, append: !!(flags & O_APPEND), nonblock: !!(flags & O_NONBLOCK), statusFlags: flags & (O_ACCMODE | O_APPEND | O_NONBLOCK) }, !!(flags & O_CLOEXEC));
}
function put(f: Fd, cloexec = false, min = 0): number { const fd = allocateFd(min); fds.set(fd, f); if (cloexec) closeOnExec.add(fd); return fd; }
/** a Java-side open into the same descriptor table native code reads, so a fd handed across JNI is live */
export const javaBytesFd = (bytes: Uint8Array): number => put({ ...fdBase(""), content: { path: null, data: bytes, len: bytes.length }, synthetic: true });
export const javaOpenFd = (path: string, flags: number): number => fdOpen(null, path, flags);
export const javaCloseFd = (fd: number): number => fdClose(null, fd);
export const javaSeekFd = (fd: number, off: number, whence: number): number => fdSeek(null, fd, off, whence);
export const javaDupFd = (fd: number): number => fdDup(null, fd);
export const javaDup2Fd = (fd: number, to: number): number => fdDup2(null, fd, to);
/** socketpair's ends are the only sockets this table holds; net.ts keeps the rest */
export const javaIsSocketFd = (fd: number): boolean => isNativeSocket(fd) || fds.get(fd)?.path === "socketpair";
/** shutdown(2) of a socketpair end: SHUT_WR (or RDWR) ends what its peer reads; -errno otherwise */
export function javaShutdownFd(fd: number, how: number): number {
  const f = fds.get(fd);
  if (!f) return -E.BADF;
  if (f.path !== "socketpair") return -E.NOTSOCK;
  if (how !== 0 && f.wpipe && !f.wpipe.closed) {
    if (!--f.wpipe.writers) { f.wpipe.closed = true; wakeAll(f.wpipe); }
    f.wpipe = { ...newPipe(1), closed: true };
  }
  return 0;
}
/** socket(AF_UNIX): unconnected until unix.ts attaches the daemon it names */
export function unixSocket(type: number): number {
  const nb = !!(type & O_NONBLOCK);
  return put({ ...fdBase("socketpair"), unix: true, dgram: (type & 15) === 2, nonblock: nb, statusFlags: 2 | (nb ? O_NONBLOCK : 0) }, !!(type & O_CLOEXEC));
}
export const isUnixSocket = (fd: number): boolean => !!fds.get(fd)?.unix;
/** connect a unix socket to an in-process peer: each write reaches `receive` whole, and what it
 *  replies is what the socket reads; -errno when already connected */
export function attachUnixPeer(fd: number, receive: (bytes: Uint8Array, reply: (bytes: Uint8Array) => void) => void): number {
  const f = fds.get(fd)!;
  if (f.wpipe) return E.ISCONN;
  const toPeer = newPipe(1), fromPeer = newPipe(1);
  const reply = (bytes: Uint8Array) => { fromPeer.q.push(bytes); wakeAll(fromPeer); };
  const drain = () => { while (toPeer.q.length) receive(toPeer.q.shift()!, reply); if (!toPeer.closed) toPeer.wake.push(drain); };
  toPeer.wake.push(drain);
  f.wpipe = toPeer; f.rpipe = fromPeer;
  return 0;
}
/** socketpair(2): two connected descriptors, each reading what the other writes */
export function javaSocketPair(type: number): [number, number] {
  const ab = newPipe(1), ba = newPipe(1), nb = !!(type & O_NONBLOCK);
  const end = (rpipe: Pipe, wpipe: Pipe) => put({ ...fdBase("socketpair"), rpipe, wpipe, nonblock: nb, statusFlags: 2 | (nb ? O_NONBLOCK : 0) }, !!(type & O_CLOEXEC));
  return [end(ab, ba), end(ba, ab)];
}
/** the bytes behind a descriptor read at offsets: not a stream, a directory or /dev/random */
const regularContent = (f: Fd | undefined): VfsFile | null =>
  !f || f.dir || f.random || f.rpipe || f.wpipe || f.event || f.timer || f.epoll || f.inotify ? null : f.content;
export function javaFdSource(fd: number): FileSource | null {
  const f = fds.get(fd), content = regularContent(f);
  if (!content) return null;
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
  if (isNativeSocket(fd)) return socketReceive(fd, target);
  const f = fds.get(fd);
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
  if (f!.random) { fillRandom(target); return target.length; }
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(f!.content, off, target.length); }
  catch { return -E.IO; }
  const done = (bytes: Uint8Array) => { target.set(bytes); return bytes.length; };
  return value instanceof Promise ? value.then(done, () => -E.IO) : done(value);
}
export const javaWriteFd = (fd: number, bytes: Uint8Array): number => isNativeSocket(fd) ? socketSend(fd, bytes) : writeBytes(null, fds.get(fd), bytes);
export const javaPwriteFd = (fd: number, bytes: Uint8Array, off: number): number => pwriteBytes(null, fd, bytes, off);
export const javaTruncateFd = (fd: number, length: number): number => truncateFd(null, fd, length);
export const javaSyncFd = (fd: number): number => syncFd(null, fd);
export const javaFcntlFd = (fd: number, cmd: number, arg: number): number => fdFcntl(null, fd, cmd, arg);
/** ioctl(2) requests with an int result; FIONREAD is the one files answer */
export function javaIoctlIntFd(fd: number, request: number): number {
  if (isNativeSocket(fd)) return request === FIONREAD ? nativeSocketAvailable(fd) : -E.NOTTY;
  return fds.has(fd) && request !== FIONREAD ? -E.NOTTY : fionread(fd);
}
export function javaFdStat(fd: number): { mode: number; size: number; path: string | null } | null {
  const f = fds.get(fd);
  if (!f) return isNativeSocket(fd) ? { mode: S_IFSOCK | 0o777, size: 0, path: null } : null;
  return { mode: fdMode(f), size: f.content.len, path: f.dir ? f.path : f.content.path };
}

/** Read from the current offset without moving seekable descriptors; streams are consumed. */
export async function javaFdBytes(fd: number): Promise<Uint8Array | null> {
  const f = fds.get(fd);
  if (f && (f.dir || (f.statusFlags & O_ACCMODE) === 1)) return null;
  if (f && !f.random && !f.rpipe && !f.wpipe && !f.event && !f.timer && !f.epoll) {
    vfs.sync(f.content);
    try { return f.content.source ? await readFully(f.content.source, f.pos) : f.content.data.subarray(f.pos, f.content.len); }
    catch { return null; }
  }
  if (!f && !isNativeSocket(fd)) return null;
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

function fdWrite(cpu: Cpu, fd: number, p: number, n: number): number {
  return isNativeSocket(fd) ? nativeSocketWrite(cpu, fd, p, n) : writeBytes(cpu, fds.get(fd), mem.u8.subarray(p, p + n));
}
/** write(2) of `bytes` to an open file, which copies what it keeps */
function writeBytes(cpu: Cpu | null, f: Fd | undefined, bytes: Uint8Array): number {
  const n = bytes.length;
  if (!f) return fail(cpu, E.BADF);
  if (f.log) {
    f.line = (f.line ?? "") + dec.decode(bytes);
    let i: number;
    while ((i = f.line.indexOf("\n")) >= 0) { logLine(f.log, f.log === 6 ? "stderr" : "stdout", f.line.slice(0, i)); f.line = f.line.slice(i + 1); }
    return n;
  }
  if (f.wpipe) { f.wpipe.q.push(bytes.slice()); wakeAll(f.wpipe); return n; }
  if (f.timer) return fail(cpu, E.INVAL);
  if (f.event) {
    if (n < 8) return fail(cpu, E.INVAL);
    f.event.count += new DataView(bytes.buffer, bytes.byteOffset, n).getUint32(0, true);
    wakeAll(f.event);
    return 8;
  }
  if (!f.write) return fail(cpu, E.BADF);
  if (f.append) f.pos = f.content.len;
  vfs.writeAt(f.content, f.pos, bytes);
  f.pos += n;
  return n;
}
/** readv/writev: each iovec in turn until a transfer comes up short, as the kernel does. `op` is
 *  told what the call has moved so far: a read that would then have to wait moves nothing. */
/** an iovec array's bytes as one buffer: what one datagram carries */
function gather(iov: number, count: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) { const entry = iov + i * 2 * PTR; parts.push(mem.bytes(ldp(entry), mem.ld32(entry + PTR) >>> 0)); }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function vectored(cpu: Cpu, iov: number, count: number, op: (p: number, n: number, moved: number) => number | Promise<number>): number | Promise<number> {
  if (count < 0 || count > 1024) return fail(cpu, E.INVAL);
  const from = (i: number, done: number): number | Promise<number> => {
    for (; i < count; i++) {
      const entry = iov + i * 2 * PTR, len = mem.ld32(entry + PTR) >>> 0;
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
  if (isNativeSocket(fd)) return !(nativePollEvents(fd, 1) & (1 | 8 | 16));
  const f = fds.get(fd);
  return !!f && !!(f.rpipe || f.event) && !ready(f);
}
function fdReadAt(cpu: Cpu | null, f: Fd, p: number, n: number, off: number): number | Promise<number> {
  if (!n) return 0;
  if (f.random) { fillRandom(mem.u8.subarray(p, p + n)); return n; }
  let value: Uint8Array | Promise<Uint8Array>;
  try { value = contentAt(f.content, off, n); }
  catch { return fail(cpu, E.IO); }
  if (!(value instanceof Promise)) { mem.write(p, value); return value.length; }
  const dst = mem.va(p);
  return value.then((bytes) => { mem.write(guestAt(dst), bytes); return bytes.length; }, () => fail(cpu, E.IO));
}
/** getRandomValues fills at most 64 KiB a call */
function fillRandom(target: Uint8Array): void {
  for (let done = 0; done < target.length; done += 65536) crypto.getRandomValues(target.subarray(done, done + 65536));
}
/** up to `n` bytes of a file at `off`: a view of its data, or what its lazy source reads */
function contentAt(content: VfsFile, off: number, n: number): Uint8Array | Promise<Uint8Array> {
  vfs.sync(content);
  const k = Math.max(0, Math.min(n, content.len - off));
  if (!k) return EMPTY;
  return content.source ? content.source.read(off, k) : content.data.subarray(off, off + k);
}
function fdRead(cpu: Cpu | null, fd: number, p: number, n: number): number | Promise<number> {
  if (isNativeSocket(fd)) return nativeSocketRead(cpu, fd, p, n);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.dir) return fail(cpu, E.ISDIR);
  if (f.inotify) {
    const q = f.inotify.pipe.q;
    if (!q.length) {
      if (f.nonblock) return fail(cpu, EAGAIN);
      return new Promise<void>((resolve) => f.inotify!.pipe.wake.push(resolve)).then(() => fdRead(cpu, fd, p, n));
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
      if (f.nonblock) return fail(cpu, EAGAIN);
      const dst = mem.va(p);
      return new Promise<void>((r) => waitOn(f, r)).then(() => fdRead(cpu, fd, guestAt(dst), n));
    }
    if (f.event) { const c = f.event.count; f.event.count = 0; mem.st64(p, BigInt(c)); return 8; }
    const q = f.rpipe!.q;
    let k = 0;
    while (k < n && q.length) { const c = q[0], take = Math.min(n - k, c.length); mem.write(p + k, c.subarray(0, take)); k += take; if (take === c.length) q.shift(); else q[0] = c.subarray(take); }
    return k;
  }
  if (f.content.source) {
    const dst = mem.va(p);
    const read = (f.readQueue ?? Promise.resolve()).then(async () => {
      const result = await fdReadAt(cpu, f, guestAt(dst), n, f.pos);
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
async function readLoop(dst: number, n: number, read: (p: number, k: number, done: number) => number | Promise<number>): Promise<number> {
  const target = mem.va(dst);
  let total = 0;
  while (total < n) {
    const r = await read(guestAt(target, total), n - total, total);
    if (r <= 0) return total || r;
    total += r;
  }
  return total;
}
function fdReadFully(cpu: Cpu, fd: number, p: number, n: number): number | Promise<number> {
  return fds.get(fd)?.content.source ? readLoop(p, n, (q, k) => fdRead(cpu, fd, q, k)) : fdRead(cpu, fd, p, n);
}
/** `n` bytes of `fd` from offset `off` into guest memory at `dst`, without moving the position */
export function readInto(cpu: Cpu, fd: number, off: number, dst: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  return f.content.source ? readLoop(dst, n, (q, k, done) => fdReadAt(cpu, f, q, k, off + done)) : fdReadAt(cpu, f, dst, n, off);
}
/** the file a descriptor reads and writes, which a shared mapping of it shares */
export function fdFile(fd: number): VfsFile | null {
  const f = fds.get(fd);
  return f?.synthetic ? null : regularContent(f);
}
function fdClose(cpu: Cpu | null, fd: number): number {
  if (isNativeSocket(fd)) return nativeSocketClose(cpu, fd);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  fds.delete(fd); closeOnExec.delete(fd); releaseFd(fd);
  if (--f.references > 0) return 0;
  if (f.content.path && f.write) notifyInotify(f.content.path, IN_CLOSE_WRITE);
  if (f.inotify) { inotifies.delete(f.inotify); f.inotify.pipe.closed = true; wakeAll(f.inotify.pipe); }
  if (f.timer) disarmClockTimer(f.timer);
  if (f.epoll) { for (const e of f.epoll.entries.values()) e.cancel(); for (const wake of f.epoll.wake) wake(); }
  if (f.wpipe && !--f.wpipe.writers) { f.wpipe.closed = true; wakeAll(f.wpipe); }
  return 0;
}
/** dup(2) and F_DUPFD: the lowest free descriptor at or above `min`, sharing fd's open file */
function fdDup(cpu: Cpu | null, fd: number, min = 0, cloexec = false): number {
  if (isNativeSocket(fd)) return nativeSocketDup(cpu, fd, min, cloexec);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  f.references++;
  return put(f, cloexec, min);
}
/** dup2's implicit close of `to`, which (unlike close) leaves bionic's fdsan owner tag in place */
function closeReplaced(cpu: Cpu | null, to: number): () => number {
  const tag = fdsanOwnerTag(to);
  if (isNativeSocket(to)) nativeSocketClose(cpu, to);
  else if (fds.has(to)) fdClose(cpu, to);
  return () => { if (tag) fdsanExchangeOwnerTag(to, 0n, tag); return to; };
}
function fdDup2(cpu: Cpu | null, fd: number, to: number, cloexec = false): number {
  if (to < 0) return fail(cpu, E.BADF);
  if (fd === to) return isNativeSocket(fd) || fds.has(fd) ? fd : fail(cpu, E.BADF);
  if (isNativeSocket(fd)) {
    const retag = closeReplaced(cpu, to);
    nativeSocketDup(cpu, fd, to, cloexec);                                         // `to` is free now
    return retag();
  }
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  const retag = closeReplaced(cpu, to);
  f.references++;
  reserveFd(to);
  fds.set(to, f);
  if (cloexec) closeOnExec.add(to);
  return retag();
}
/** mkstemp's contract: the six trailing X's become the name in place, and the file is created exclusively */
function fdTemp(cpu: Cpu, tpl: number, flags: number, dir: boolean): number {
  const t = mem.cstr(tpl);
  if (!t.endsWith("XXXXXX")) return fail(cpu, E.INVAL);
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let name = t.slice(0, -6);
    for (let i = 0; i < 6; i++) name += chars[(Math.random() * chars.length) | 0];
    const r = dir ? (vfs.exists(name) ? fail(cpu, E.EXIST) : mkdirPath(cpu, name)) : fdOpen(cpu, name, (flags & ~O_ACCMODE) | 2 | O_CREAT | O_EXCL);
    if (r >= 0) { mem.write(tpl, utf8(name)); return r; }
  }
  return fail(cpu, E.EXIST);
}
function fdSeek(cpu: Cpu | null, fd: number, off: number, whence: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, isNativeSocket(fd) ? E.SPIPE : E.BADF);
  if (f.rpipe || f.wpipe || f.event || f.epoll || f.timer) return fail(cpu, E.SPIPE);
  if (f.random) return f.pos;                                                     // noop_llseek
  if (whence < 0 || whence > 2) return fail(cpu, E.INVAL);
  const np = whence === 0 ? off : whence === 1 ? f.pos + off : f.content.len + off;
  if (np < 0) return fail(cpu, E.INVAL);
  f.pos = np;
  return np;
}
/** an inode per path: a runtime's own share table keys on st_dev/st_ino */
export function inoOf(path: string): number { let h = 0x811c9dc5; for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193); return (h >>> 0) || 1; }
/** the platform's own files are root's, as on a device; bionic maps the property area only if they are */
const ownerOf = (path: string) => /^\/(?:system|apex|vendor|product|dev)\//.test(path) ? 0 : procIdentity.uid;
function fillStat(buf: number, isDir: boolean, size: number, mtimeMs: number, path: string, file = vfs.opened(path)): void {
  mem.memset(buf, 0, LAYOUT.STAT_SIZE);
  mem.st32(buf, 1);                                                                  // st_dev
  mem.st32(buf + LAYOUT.ST_MODE, isDir ? S_IFDIR | 0o755 : file && fifos.has(file) ? S_IFIFO | 0o600 : S_IFREG | 0o644);
  mem.st32(buf + LAYOUT.ST_NLINK, 1);
  const owner = ownerOf(path);
  mem.st32(buf + LAYOUT.ST_UID, owner); mem.st32(buf + LAYOUT.ST_GID, owner);
  mem.st32(buf + LAYOUT.ST_SIZE, size); mem.st32(buf + LAYOUT.ST_SIZE + 4, 0);
  mem.st32(buf + LAYOUT.ST_BLKSIZE, 4096);
  mem.st32(buf + LAYOUT.ST_BLOCKS, (size + 511) >> 9);
  const sec = Math.floor(mtimeMs / 1000);
  for (const o of [LAYOUT.ST_ATIME, LAYOUT.ST_MTIME, LAYOUT.ST_CTIME]) stp(buf + o, sec);
  mem.st32(buf + LAYOUT.ST_INO32, inoOf(path)); mem.st32(buf + LAYOUT.ST_INO, inoOf(path));
}
/** _PC_LINK_MAX 0 … NAME_MAX 4, PATH_MAX 5, PIPE_BUF 6 */
const pathconfOf = (n: number) => (n === 4 ? 255 : n === 5 ? 4096 : n === 6 ? 4096 : n === 0 ? 127 : -1);
/** struct statvfs: eleven unsigned longs (bsize, frsize, blocks, bfree, bavail, files, ffree, favail, fsid, flag, namemax) */
function fillStatvfs(b: number): void {
  mem.memset(b, 0, 112);
  const v = [4096, 4096, 0x100000, 0x80000, 0x80000, 0x10000, 0x8000, 0x8000, 0, 0, 255];
  for (let i = 0; i < v.length; i++) mem.st32(b + i * 4, v[i]);
}
/** statfs: a fixed-size filesystem with room; the LP64 struct is all 64-bit fields at an 8-byte stride */
function fillStatfs(b: number): void {
  mem.memset(b, 0, LAYOUT.STATFS_SIZE);
  const w = PTR, put = (i: number, v: number) => stp(b + i * w, v);
  put(1, 4096); put(2, 0x100000); put(3, 0x80000); put(4, 0x80000); put(5, 0x10000); put(6, 0x8000);
  if (PTR === 8) { put(8, 255); put(9, 4096); } else { mem.st32(b + 56, 255); mem.st32(b + 60, 4096); }
}
/** pipe2(2): the read end, then the write end */
export function javaPipeFds(flags: number): [number, number] {
  const p = newPipe(1), nb = !!(flags & O_NONBLOCK), cloexec = !!(flags & O_CLOEXEC);
  return [put({ ...fdBase("pipe"), rpipe: p, nonblock: nb, statusFlags: nb ? O_NONBLOCK : 0 }, cloexec),
    put({ ...fdBase("pipe"), wpipe: p, nonblock: nb, write: true, statusFlags: 1 | (nb ? O_NONBLOCK : 0) }, cloexec)];
}
function makePipe(out: number, flags: number): number {
  const [read, write] = javaPipeFds(flags);
  mem.st32(out, read); mem.st32(out + 4, write);
  return 0;
}
function makeInotify(cpu: Cpu, flags: number): number {
  if (flags & ~(IN_NONBLOCK | IN_CLOEXEC)) return fail(cpu, E.INVAL);
  const pipe = newPipe(0), state: Inotify = { watches: new Map(), nextWd: 1, pipe };
  inotifies.add(state);
  return put({ ...fdBase("inotify"), inotify: state, rpipe: pipe, nonblock: !!(flags & IN_NONBLOCK), statusFlags: flags & IN_NONBLOCK }, !!(flags & O_CLOEXEC));
}
function epollWatch(ep: Epoll, fd: number, events: number, data: bigint): EpollEntry {
  const entry: EpollEntry = { events, data, pending: nativePollEvents(fd, events), disabled: false, cancel: () => {} };
  let active = true, remove = () => {};
  const watch = () => {
    if (!active) return;
    remove = watchNativeFd(fd, () => {
      remove();
      entry.pending |= nativePollEvents(fd, entry.events);
      for (const wake of ep.wake) wake();
      queueMicrotask(watch);
    });
  };
  entry.cancel = () => { active = false; remove(); };
  watch();
  return entry;
}
async function epollWait(cpu: Cpu, epfd: number, events: bigint, max: number, timeout: number): Promise<number> {
  const ep = fds.get(epfd)?.epoll, deadline = performance.now() + timeout;
  if (!ep) return fail(cpu, E.BADF);
  if (max <= 0) return fail(cpu, E.INVAL);
  for (;;) {
    let n = 0;
    for (const [fd, e] of ep.entries) {
      if (!fds.has(fd) && !isNativeSocket(fd)) { e.cancel(); ep.entries.delete(fd); continue; }
      if (e.disabled) continue;
      const ready = nativePollEvents(fd, e.events) & (e.events & EPOLLET ? e.pending : -1);
      if (!ready || n === max) continue;
      const out = mem.txVa(events) + n++ * 16;
      mem.st32(out, ready); mem.st64(out + 8, e.data);
      e.pending &= ~ready;
      if (e.events & EPOLLONESHOT) e.disabled = true;
    }
    if (n || timeout === 0) return n;
    const remaining = deadline - performance.now();
    if (timeout > 0 && remaining <= 0) return 0;
    await new Promise<void>((resolve) => {
      const done = () => { ep.wake.delete(done); clearTimeout(timer); resolve(); };
      const timer = timeout < 0 ? undefined : setTimeout(done, remaining);
      ep.wake.add(done);
    });
    if (fds.get(epfd)?.epoll !== ep) return fail(cpu, E.BADF);
  }
}
function statPath(cpu: Cpu, path: string, buf: number): number {
  path = vfs.norm(path);
  if (path === "/dev/urandom" || path === "/dev/random") { fillStat(buf, false, 0, Date.now(), path); return 0; }
  const s = procText(path);
  if (s !== null) { fillStat(buf, false, utf8(s).length, Date.now(), path); return 0; }
  if (vfs.isDir(path)) { fillStat(buf, true, 4096, Date.now(), path); return 0; }
  const file = vfs.stat(path);
  if (!file) return fail(cpu, E.NOENT);
  fillStat(buf, false, file.size, Date.now(), path);
  return 0;
}
function statFd(cpu: Cpu, fd: number, buf: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  fillStat(buf, f.dir, f.content.len, Date.now(), f.path, f.content);
  mem.st32(buf + LAYOUT.ST_MODE, fdMode(f));
  return 0;
}
/** st_mode of an open file: /dev/null stdio and /dev/random are character devices, and eventfd,
 *  epoll, timerfd and inotify descriptors are anonymous inodes, which carry no file type */
function fdMode(f: Fd): number {
  if (f.dir) return S_IFDIR | 0o755;
  if (f.random || f.log || f.path === "/dev/stdin") return S_IFCHR | 0o666;
  if (f.path === "socketpair") return S_IFSOCK | 0o777;
  if (f.event || f.epoll || f.timer || f.inotify) return 0o600;
  return f.rpipe || f.wpipe ? S_IFIFO | 0o600 : S_IFREG | 0o644;
}

// ── FILE* layer: the struct is real (guest code inspects _flags/_file through macros), the
// buffering is ours (_r = _w = 0 so getc/putc always take the function path).
const F_EOF = 0x20, F_ERR = 0x40, F_RD = 4, F_WR = 8, F_RW = 0x10;
function newFile(fd: number, flags: number): number {
  const fp = mem.malloc(LAYOUT.FILE_SIZE);
  mem.memset(fp, 0, LAYOUT.FILE_SIZE);
  mem.st16(fp + LAYOUT.F_FLAGS, flags);
  mem.st16(fp + LAYOUT.F_FILE, fd);
  files.set(fp, fd);
  return fp;
}
function fileFd(fp: number): number { return files.get(fp) ?? mem.ld16s(fp + LAYOUT.F_FILE); }
function fileSeek(cpu: Cpu, fp: number, off: number, whence: number): number {
  const r = fdSeek(cpu, fileFd(fp), off - (whence === 1 ? pushback.get(fp)?.length ?? 0 : 0), whence);
  if (r < 0) return -1;
  pushback.delete(fp);
  mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~F_EOF);
  return 0;
}
function fileTell(cpu: Cpu, fp: number): number {
  const pos = fdSeek(cpu, fileFd(fp), 0, 1);
  return pos < 0 ? -1 : pos - (pushback.get(fp)?.length ?? 0);
}
function setFlag(fp: number, f: number): void { mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) | f); }
function modeFlags(mode: string): { o: number; f: number } {
  const plus = mode.includes("+");
  if (mode[0] === "r") return { o: plus ? 2 : 0, f: plus ? F_RW : F_RD };
  if (mode[0] === "w") return { o: (plus ? 2 : 1) | O_CREAT | O_TRUNC, f: plus ? F_RW : F_WR };
  return { o: (plus ? 2 : 1) | O_CREAT | O_APPEND, f: plus ? F_RW : F_WR };
}
let scratch = 0;
function fgetc(cpu: Cpu, fp: number): number | Promise<number> {
  const pending = pushback.get(fp), c = pending?.pop();
  if (c !== undefined) { if (!pending?.length) pushback.delete(fp); return c; }
  const fd = fileFd(fp);
  const f = fds.get(fd);
  if (!f) { setFlag(fp, F_ERR); return -1; }
  const byte = f.byte ?? (f.byte = mem.hostAlloc(1));
  const done = (read: number) => {
    if (read <= 0) { setFlag(fp, read < 0 ? F_ERR : F_EOF); return -1; }
    return mem.u8[byte];
  };
  const read = fdRead(cpu, fd, byte, 1);
  return read instanceof Promise ? read.then(done) : done(read);
}
function fwriteBytes(cpu: Cpu, fp: number, p: number, n: number): number {
  const r = fdWrite(cpu, fileFd(fp), p, n);
  if (r < 0) { setFlag(fp, F_ERR); return 0; }
  return r;
}
function fwriteStr(cpu: Cpu, fp: number, s: string): number {
  const b = utf8(s);
  const tmp = mem.malloc(b.length + 1);
  mem.u8.set(b, tmp);
  const r = fwriteBytes(cpu, fp, tmp, b.length);
  mem.free(tmp);
  return r < b.length ? -1 : b.length;
}

/** why pread/pwrite at `off` cannot reach fd's file, 0 when they can: streams have no offsets */
function positionalError(fd: number, f: Fd | undefined, off: number, write: boolean): number {
  if (!f) return isNativeSocket(fd) ? E.SPIPE : E.BADF;
  if (!f.random && !f.dir && !regularContent(f)) return E.SPIPE;
  if (write ? !f.write : (f.statusFlags & O_ACCMODE) === 1) return E.BADF;
  return off < 0 ? E.INVAL : f.dir ? E.ISDIR : 0;
}
function pread(cpu: Cpu, fd: number, p: number, n: number, off: number): number | Promise<number> {
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
const pwrite = (cpu: Cpu, fd: number, p: number, n: number, off: number): number => pwriteBytes(cpu, fd, mem.u8.subarray(p, p + n), off);
/** ftruncate(2): only a regular file open for writing */
function truncateFd(cpu: Cpu | null, fd: number, n: number): number {
  const f = fds.get(fd);
  if (!f && !isNativeSocket(fd)) return fail(cpu, E.BADF);
  if (n < 0 || !f?.write || !regularContent(f)) return fail(cpu, E.INVAL);
  vfs.resize(f.content, n); return 0;
}
function fdFcntl(cpu: Cpu | null, fd: number, cmd: number, arg: number): number {
  if (cmd === F_DUPFD || cmd === F_DUPFD_CLOEXEC) return arg < 0 ? fail(cpu, E.INVAL) : fdDup(cpu, fd, arg, cmd === F_DUPFD_CLOEXEC);
  if (isNativeSocket(fd)) return nativeSocketFcntl(cpu, fd, cmd, arg);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (cmd === F_GETFD) return closeOnExec.has(fd) ? 1 : 0;
  if (cmd === F_SETFD) { if (arg & 1) closeOnExec.add(fd); else closeOnExec.delete(fd); return 0; }
  if (cmd === F_GETFL) return f.statusFlags;
  if (cmd === F_SETFL) {
    f.statusFlags = (f.statusFlags & ~(O_APPEND | O_NONBLOCK)) | (arg & (O_APPEND | O_NONBLOCK));
    f.append = !!(f.statusFlags & O_APPEND);
    f.nonblock = !!(f.statusFlags & O_NONBLOCK);
  }
  return 0;
}
const FIONREAD = 0x541b;
/** FIONREAD: what a read could take now, or -errno for a descriptor without the request */
function fionread(fd: number): number {
  const f = fds.get(fd), pipe = f?.rpipe ?? f?.wpipe;
  if (!f) return -E.BADF;
  if (pipe) return pipe.q.reduce((n, b) => n + b.length, 0);
  if (f.random) return -E.INVAL;
  return f.dir || !regularContent(f) ? -E.NOTTY : Math.max(0, f.content.len - f.pos);
}
/** fsync/fdatasync: the VFS has nothing to flush, but pipes and sockets cannot sync */
function syncFd(cpu: Cpu | null, fd: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, isNativeSocket(fd) ? E.INVAL : E.BADF);
  return f.rpipe || f.wpipe || f.event || f.epoll || f.timer || f.random || f.log ? fail(cpu, E.INVAL) : 0;
}
/** posix_fallocate: grow the file to cover the range; it reports the error number itself */
export const fdFallocate = (fd: number, offset: number, len: number): number => fallocateFd(fds.get(fd), offset, len);
function fallocateFd(f: Fd | undefined, offset: number, len: number): number {
  if (!f) return E.BADF;
  if (offset < 0 || len <= 0) return E.INVAL;
  if (offset + len > f.content.len) vfs.resize(f.content, offset + len);
  return 0;
}
const chk = (cpu: Cpu, n: number, size: number, what: string) => { if (n > size) cpu.fault(`fortify: ${what} past the buffer`); };
/** getdents64: linux_dirent64 records (bionic's struct dirent on LP64) from the fd's position on */
export function getdents64(cpu: Cpu, fd: number, buf: number, size: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (!f.dir) return fail(cpu, E.NOTDIR);
  const entries = [".", "..", ...vfs.list(f.path)];
  let at = 0;
  for (; f.pos < entries.length; f.pos++) {
    const name = utf8(entries[f.pos]), reclen = (LAYOUT.D_NAME + name.length + 1 + 7) & ~7;
    if (at + reclen > size) break;
    const de = buf + at;
    mem.memset(de, 0, reclen);
    mem.st64(de + LAYOUT.D_INO, BigInt(f.pos + 1)); mem.st64(de + LAYOUT.D_OFF, BigInt(f.pos + 1));
    mem.st16(de + LAYOUT.D_RECLEN, reclen);
    mem.st8(de + LAYOUT.D_TYPE, vfs.isDir(`${f.path}/${entries[f.pos]}`) ? 4 : 8);
    mem.write(de + LAYOUT.D_NAME, name);
    at += reclen;
  }
  return at || f.pos >= entries.length ? at : fail(cpu, E.INVAL);
}
function openDir(path: string): number {
  const h = mem.malloc(16);
  dirs.set(h, { entries: [".", "..", ...vfs.list(path)], i: 0, dirent: mem.malloc(LAYOUT.DIRENT_SIZE) });
  return h;
}
function nextDirent(d: { entries: string[]; i: number }, de: number): number {
  const name = d.entries[d.i++];
  mem.memset(de, 0, LAYOUT.DIRENT_SIZE);
  mem.st32(de + LAYOUT.D_INO, d.i); mem.st32(de + LAYOUT.D_OFF, d.i);
  mem.st16(de + LAYOUT.D_RECLEN, LAYOUT.DIRENT_SIZE);
  mem.st8(de + LAYOUT.D_TYPE, 8);
  mem.putCstr(de + LAYOUT.D_NAME, name, 256);
  return de;
}

interface FtsNode {
  pre: number;
  post: number;
  children: FtsNode[];
  first: number;
  end: number;
}
interface FtsWalk {
  entries: number[];
  nodes: Map<number, FtsNode>;
  allocations: number[];
  index: number;
  current: number;
}
const ftsWalks = new Map<number, FtsWalk>();
const FTS = { parent: 4, link: 8, accpath: 20, path: 24, errno: 28, pathlen: 36, namelen: 40, ino: 44, dev: 48, nlink: 52, level: 56, info: 58, flags: 60, instr: 62, statp: 64, name: 68 };

function ftsEntry(walk: FtsWalk, path: string, level: number, parent: number, info: number): number {
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  const pathlen = utf8(path).length, namelen = utf8(name).length;
  const entry = mem.malloc(FTS.name + namelen + 1), pathp = mem.strdup(path), statp = mem.malloc(LAYOUT.STAT_SIZE);
  walk.allocations.push(entry, pathp, statp);
  mem.memset(entry, 0, FTS.name + namelen + 1);
  stp(entry + FTS.parent, parent); stp(entry + FTS.accpath, pathp); stp(entry + FTS.path, pathp);
  mem.st32(entry + FTS.pathlen, pathlen); mem.st32(entry + FTS.namelen, namelen);
  mem.st32(entry + FTS.ino, inoOf(path)); mem.st32(entry + FTS.dev, 1); mem.st32(entry + FTS.nlink, 1);
  mem.st16(entry + FTS.level, level); mem.st16(entry + FTS.info, info); stp(entry + FTS.statp, statp);
  const file = vfs.stat(path); fillStat(statp, info === 1 || info === 6, file?.size ?? 4096, Date.now(), path);
  mem.putCstr(entry + FTS.name, name);
  return entry;
}

function ftsTree(walk: FtsWalk, path: string, level: number, parent: number): FtsNode {
  const exists = vfs.exists(path), dir = vfs.isDir(path), info = !exists ? 10 : dir ? 1 : 8;
  const pre = ftsEntry(walk, path, level, parent, info);
  const post = dir ? ftsEntry(walk, path, level, parent, 6) : 0;
  const node: FtsNode = { pre, post, children: [], first: 0, end: 0 };
  walk.nodes.set(pre, node);
  if (post) walk.nodes.set(post, node);
  if (dir) for (const name of vfs.list(path)) node.children.push(ftsTree(walk, vfs.norm(path + "/" + name), level + 1, pre));
  return node;
}

async function sortFts(cpu: Cpu, node: FtsNode, compar: number, cell: number): Promise<void> {
  if (compar && node.children.length > 1) {
    for (let i = 1; i < node.children.length; i++) {
      const value = node.children[i]; let j = i;
      while (j > 0) {
        stp(cell, node.children[j - 1].pre); stp(cell + 4, value.pre);
        if ((await cpu.call(compar, [cell, cell + 4])) <= 0) break;
        node.children[j] = node.children[j - 1]; j--;
      }
      node.children[j] = value;
    }
  }
  for (const child of node.children) await sortFts(cpu, child, compar, cell);
}

function flattenFts(walk: FtsWalk, node: FtsNode): void {
  walk.entries.push(node.pre);
  node.first = node.children[0]?.pre ?? 0;
  for (let i = 0; i < node.children.length; i++) stp(node.children[i].pre + FTS.link, node.children[i + 1]?.pre ?? 0);
  for (const child of node.children) flattenFts(walk, child);
  if (node.post) walk.entries.push(node.post);
  node.end = walk.entries.length;
}

async function ftsOpen(cpu: Cpu, argv: number, options: number, compar: number): Promise<number | bigint> {
  if (!argv || options & ~0xff) { fail(cpu, E.INVAL); return 0; }
  const handle = mem.malloc(4), walk: FtsWalk = { entries: [], nodes: new Map(), allocations: [handle], index: 0, current: 0 };
  const roots: FtsNode[] = [];
  for (let p = argv, pathp; (pathp = ldp(p)); p += 4) roots.push(ftsTree(walk, vfs.norm(mem.cstr(pathp)), 0, 0));
  if (!roots.length) { closeFts(handle); fail(cpu, E.INVAL); return 0; }
  const cell = mem.malloc(8); walk.allocations.push(cell);
  for (const root of roots) { await sortFts(cpu, root, compar, cell); flattenFts(walk, root); }
  ftsWalks.set(handle, walk);
  return ptr(handle);
}

function closeFts(handle: number): number {
  const walk = ftsWalks.get(handle);
  if (!walk) return -1;
  for (const allocation of walk.allocations) mem.free(allocation);
  ftsWalks.delete(handle);
  return 0;
}

export function stdioInit(): void {
  if (!inotifyHooked) {
    const priorOnWrite = vfs.onWrite;
    vfs.onWrite = (path, change = "modify") => { priorOnWrite(path, change); inotifyVfsChange(path, change); };
    inotifyHooked = true;
  }
  procMemory.resident = () => mem.u8.byteLength;
  for (let fd = 0; fd < 3; fd++) reserveFd(fd);
  fds.set(0, fdBase("/dev/stdin"));
  fds.set(1, { ...fdBase("/dev/stdout"), write: true, statusFlags: 1, log: 4 });
  fds.set(2, { ...fdBase("/dev/stderr"), write: true, statusFlags: 1, log: 6 });
  // __sF[3]: stdin/stdout/stderr FILE structs, contiguous
  const sF = mem.hostAlloc(LAYOUT.FILE_SIZE * 3);
  mem.memset(sF, 0, LAYOUT.FILE_SIZE * 3);
  for (let i = 0; i < 3; i++) {
    const fp = sF + i * LAYOUT.FILE_SIZE;
    mem.st16(fp + LAYOUT.F_FLAGS, i === 0 ? F_RD : F_WR);
    mem.st16(fp + LAYOUT.F_FILE, i);
    files.set(fp, i);
  }
  hostData("libc.so", "__sF", sF);
  const stdoutP = mem.hostAlloc(PTR); stp(stdoutP, sF + LAYOUT.FILE_SIZE); hostData("libc.so", "stdout", stdoutP);
  const stderrP = mem.hostAlloc(PTR); stp(stderrP, sF + 2 * LAYOUT.FILE_SIZE); hostData("libc.so", "stderr", stderrP);
  const stdinP = mem.hostAlloc(PTR); stp(stdinP, sF); hostData("libc.so", "stdin", stdinP);
  const stdoutFp = sF + LAYOUT.FILE_SIZE;

  const M: Record<string, HostFn> = {
    open: (cpu, a) => fdOpen(cpu, a.str(), a.i()),
    __open_2: (cpu, a) => fdOpen(cpu, a.str(), a.i()),
    openat: (cpu, a) => {
      const dirfd = a.i(), path = a.str(), flags = a.i();
      const resolved = atPath(cpu, dirfd, path);
      return typeof resolved === "string" ? fdOpen(cpu, resolved, flags) : resolved;
    },
    creat: (cpu, a) => fdOpen(cpu, a.str(), 1 | O_CREAT | O_TRUNC),
    mkstemp: (cpu, a) => fdTemp(cpu, a.p(), 0, false),
    mkostemp: (cpu, a) => fdTemp(cpu, a.p(), a.i(), false),
    mkdtemp: (cpu, a) => { const p = a.p(); return fdTemp(cpu, p, 0, true) < 0 ? 0 : p; },
    close: (cpu, a) => fdClose(cpu, a.i()),
    read: (cpu, a) => fdRead(cpu, a.i(), a.p(), a.u()),
    write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
    readv: (cpu, a) => { const fd = a.i(); return vectored(cpu, a.p(), a.i(), (p, n, moved) => moved && readWouldWait(fd) ? 0 : fdRead(cpu, fd, p, n)); },
    writev: (cpu, a) => {
      const fd = a.i(), iov = a.p(), count = a.i();
      if (fds.get(fd)?.dgram) return writeBytes(cpu, fds.get(fd), gather(iov, count));
      return vectored(cpu, iov, count, (p, n) => fdWrite(cpu, fd, p, n));
    },
    pread: (cpu, a) => pread(cpu, a.i(), a.p(), a.u(), a.i()),
    pwrite: (cpu, a) => pwrite(cpu, a.i(), a.p(), a.u(), a.i()),
    pread64: (cpu, a) => pread(cpu, a.i(), a.p(), a.u(), Number(a.l())),
    pwrite64: (cpu, a) => pwrite(cpu, a.i(), a.p(), a.u(), Number(a.l())),
    lseek: (cpu, a) => (PTR === 8 ? BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())) : fdSeek(cpu, a.i(), a.i(), a.i())),
    lseek64: (cpu, a) => BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())),
    fstat: (cpu, a) => statFd(cpu, a.i(), a.p()),
    stat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    lstat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    fstatat: (cpu, a) => {
      const fd = a.i(), name = a.str(), buf = a.p(), flags = a.i();
      if (flags & ~(0x100 | 0x1000)) return fail(cpu, E.INVAL);
      if (!name) return flags & 0x1000 ? statFd(cpu, fd, buf) : fail(cpu, E.NOENT);
      const path = atPath(cpu, fd, name);
      return typeof path === "string" ? statPath(cpu, path, buf) : path;
    },
    access: (cpu, a) => accessPath(cpu, a.str(), a.i()),
    faccessat: (cpu, a) => faccessatPath(cpu, a.i(), a.str(), a.i(), a.i()),
    chmod: () => 0, fchmod: () => 0, chown: () => 0, fchown: () => 0, umask: () => 0o22,
    unlink: (cpu, a) => vfs.delete(a.str()) ? 0 : fail(cpu, E.NOENT),
    mkfifo: (cpu, a) => makeFifo(cpu, a.str()),
    remove: (cpu, a) => { const p = vfs.norm(a.str()); if (vfs.isDir(p)) return vfs.list(p).length ? fail(cpu, E.NOTEMPTY) : 0; return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    rename: (cpu, a) => renamePath(cpu, a.str(), a.str()),
    renameat: (cpu, a) => {
      const from = atPath(cpu, a.i(), a.str());
      if (typeof from !== "string") return from;
      const to = atPath(cpu, a.i(), a.str());
      return typeof to !== "string" ? to : renamePath(cpu, from, to);
    },
    mkdir: (cpu, a) => mkdirPath(cpu, a.str()),
    mkdirat: (cpu, a) => { const path = atPath(cpu, a.i(), a.str()); return typeof path === "string" ? mkdirPath(cpu, path) : path; },
    rmdir: (cpu, a) => { const p = vfs.norm(a.str()); if (!vfs.isDir(p)) return fail(cpu, E.NOTDIR); if (vfs.list(p).length) return fail(cpu, E.NOTEMPTY); vfs.rmdir(p); return 0; },
    ftruncate: (cpu, a) => truncateFd(cpu, a.i(), offArg(a)),
    ftruncate64: (cpu, a) => truncateFd(cpu, a.i(), Number(a.l())),
    posix_fallocate: (_c, a) => fallocateFd(fds.get(a.i()), a.i(), a.i()),
    posix_fallocate64: (_c, a) => fallocateFd(fds.get(a.i()), Number(a.l()), Number(a.l())),
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
      return fdFcntl(cpu, fd, cmd, a.i());
    },
    fsync: (cpu, a) => syncFd(cpu, a.i()), fdatasync: (cpu, a) => syncFd(cpu, a.i()), sync: () => {},
    syncfs: (cpu, a) => fds.has(a.i()) ? 0 : fail(cpu, E.BADF),
    dup: (cpu, a) => fdDup(cpu, a.i()),
    dup2: (cpu, a) => fdDup2(cpu, a.i(), a.i()),
    dup3: (cpu, a) => {
      const fd = a.i(), to = a.i(), flags = a.i();
      if (fd === to || (flags & ~O_CLOEXEC)) return fail(cpu, E.INVAL);
      return fdDup2(cpu, fd, to, !!(flags & O_CLOEXEC));
    },
    pipe: (_c, a) => makePipe(a.p(), 0),
    pipe2: (_c, a) => makePipe(a.p(), a.i()),
    inotify_init: (cpu) => makeInotify(cpu, 0),
    inotify_init1: (cpu, a) => makeInotify(cpu, a.i()),
    inotify_add_watch: (cpu, a) => {
      const fd = a.i(), path = vfs.norm(a.str()), mask = a.u(), state = fds.get(fd)?.inotify;
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
    },
    inotify_rm_watch: (cpu, a) => {
      const state = fds.get(a.i())?.inotify, wd = a.i();
      if (!state) return fail(cpu, E.BADF);
      if (!state.watches.delete(wd)) return fail(cpu, E.INVAL);
      inotifyEvent(state, wd, IN_IGNORED);
      return 0;
    },
    socketpair: (_c, a) => {
      a.i(); const type = a.i(); a.i(); const sv = a.p();
      const [first, second] = javaSocketPair(type);
      mem.st32(sv, first); mem.st32(sv + 4, second);
      return 0;
    },
    timerfd_create: (cpu, a) => {
      const clock = a.i(), flags = a.i();
      if (![0, 1, 7].includes(clock) || flags & ~(O_NONBLOCK | O_CLOEXEC)) return fail(cpu, E.INVAL);
      return put({ ...fdBase("timerfd"), timer: { clock, next: 0, interval: 0 }, event: { count: 0, wake: [] }, nonblock: !!(flags & O_NONBLOCK), statusFlags: 2 | (flags & O_NONBLOCK) }, !!(flags & O_CLOEXEC));
    },
    timerfd_settime: (cpu, a) => {
      const fd = a.i(), flags = a.i(), value = a.p(), old = a.p(), f = fds.get(fd);
      if (!f) return fail(cpu, E.BADF);
      if (!f.timer || flags & ~1) return fail(cpu, E.INVAL);
      if (!validTime(value) || !validTime(value + LAYOUT.TS_SIZE)) return fail(cpu, E.INVAL);
      const interval = readTs(value), next = readTs(value + LAYOUT.TS_SIZE);
      if (old) timerState(f.timer, old);
      f.timer.interval = interval;
      f.timer.next = next ? next + (flags & 1 ? 0 : clockTime(f.timer.clock)) : 0;
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
    eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return put({ ...fdBase("eventfd"), event: { count: init, wake: [] }, nonblock: !!(flags & O_NONBLOCK), statusFlags: 2 | (flags & O_NONBLOCK) }, !!(flags & O_CLOEXEC)); },
    epoll_create: () => put({ ...fdBase("epoll"), epoll: { entries: new Map(), wake: new Set() }, statusFlags: 2 }),
    epoll_create1: (cpu, a) => {
      const flags = a.i();
      if (flags & ~O_CLOEXEC) return fail(cpu, E.INVAL);
      return put({ ...fdBase("epoll"), epoll: { entries: new Map(), wake: new Set() }, statusFlags: 2 }, !!flags);
    },
    epoll_ctl: (cpu, a) => {
      const epfd = a.i(), ep = fds.get(epfd)?.epoll, op = a.i(), fd = a.i(), ev = a.p();
      if (fd === epfd) return fail(cpu, E.INVAL);
      if (!ep || (!fds.has(fd) && !isNativeSocket(fd))) return fail(cpu, E.BADF);
      const old = ep.entries.get(fd);
      if (op === 1 && old) return fail(cpu, E.EXIST);
      if ((op === 2 || op === 3) && !old) return fail(cpu, E.NOENT);
      if (op < 1 || op > 3) return fail(cpu, E.INVAL);
      old?.cancel();
      if (op === 2) ep.entries.delete(fd); else ep.entries.set(fd, epollWatch(ep, fd, mem.ld32(ev), mem.ld64(ev + 8)));
      for (const wake of ep.wake) wake();
      return 0;
    },
    epoll_wait: (cpu, a) => epollWait(cpu, a.i(), a.va(), a.i(), a.i()),
    sendfile: (cpu) => fail(cpu, E.NOSYS),
    __read_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(); chk(cpu, n, a.u(), "read"); return fdRead(cpu, fd, p, n); },
    __write_chk: (cpu, a) => {
      const fd = a.i(), p = a.p(), n = a.va(), size = a.va();
      if (n > size || n > 0x7fffffffn) cpu.fault("fortify: write past the buffer");
      return fdWrite(cpu, fd, p, Number(n));
    },
    __pread64_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); chk(cpu, n, a.u(), "pread"); return pread(cpu, fd, p, n, off); },
    __pread_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = a.i(); chk(cpu, n, a.u(), "pread"); return pread(cpu, fd, p, n, off); },
    flock: () => 0,
    unlinkat: (cpu, a) => { a.i(); const p = a.str(), flags = a.i(); if (flags & 0x200) { const d = vfs.norm(p); if (!vfs.isDir(d)) return fail(cpu, E.NOTDIR); vfs.rmdir(d); return 0; } return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    fchmodat: () => 0, utimensat: () => 0, futimens: () => 0,
    pathconf: (_c, a) => { a.str(); return pathconfOf(a.i()); },
    fpathconf: (_c, a) => { a.i(); return pathconfOf(a.i()); },
    statvfs: (_c, a) => { a.str(); fillStatvfs(a.p()); return 0; },
    fstatvfs: (_c, a) => { a.i(); fillStatvfs(a.p()); return 0; },
    isatty: () => 0,
    ioctl: (cpu, a) => {
      const fd = a.i(), request = a.i(), argument = a.p();
      if (isNativeSocket(fd)) return nativeSocketIoctl(cpu, fd, request, argument);
      if (request !== FIONREAD) return fail(cpu, E.NOSYS);
      const n = fionread(fd);
      if (n < 0) return fail(cpu, -n);
      mem.st32(argument, n);
      return 0;
    },
    statfs: (_c, a) => { a.str(); fillStatfs(a.p()); return 0; },
    fstatfs: (_c, a) => { a.i(); fillStatfs(a.p()); return 0; },
    getcwd: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "/", n); return ARG0; },
    chdir: () => 0,
    realpath: (_c, a) => { const p = vfs.norm(a.str()); let out = a.p(); if (!out) out = mem.malloc(4096); mem.putCstr(out, p, 4096); return ptr(out); },
    readlink: (cpu) => fail(cpu, E.INVAL),
    readlinkat: (cpu) => fail(cpu, E.INVAL),
    symlink: (cpu) => fail(cpu, E.PERM), link: (cpu) => fail(cpu, E.PERM),
    utimes: () => 0, utime: () => 0,

    opendir: (cpu, a) => {
      const p = vfs.norm(a.str());
      if (!vfs.isDir(p)) { fail(cpu, vfs.exists(p) ? E.NOTDIR : E.NOENT); return 0; }
      return openDir(p);
    },
    fdopendir: (cpu, a) => { const f = fds.get(a.i()); if (!f || !f.dir) { fail(cpu, E.NOTDIR); return 0; } return openDir(f.path); },
    readdir: (_c, a) => { const d = dirs.get(a.p()); return d && d.i < d.entries.length ? nextDirent(d, d.dirent) : 0; },
    readdir_r: (_c, a) => { const d = dirs.get(a.p()), ent = a.p(), res = a.p(); stp(res, d && d.i < d.entries.length ? nextDirent(d, ent) : 0); return 0; },
    rewinddir: (_c, a) => { const d = dirs.get(a.p()); if (d) d.i = 0; },
    closedir: (_c, a) => { const h = a.p(); const d = dirs.get(h); if (d) { mem.free(d.dirent); mem.free(h); dirs.delete(h); return 0; } return -1; },
    dirfd: () => -1,
    // scandir(path, &namelist, filter, compar): every entry the filter keeps, each its own
    // malloc'd dirent, sorted by the guest's comparator (over dirent**) into a malloc'd array
    scandir: async (cpu, a) => {
      const path = vfs.norm(a.str()), out = a.p(), filter = a.p(), compar = a.p();
      if (!vfs.isDir(path)) return fail(cpu, vfs.exists(path) ? E.NOTDIR : E.NOENT);
      const kept: number[] = [];
      for (const name of [".", "..", ...vfs.list(path)]) {
        const de = mem.malloc(LAYOUT.DIRENT_SIZE);
        nextDirent({ entries: [name], i: 0 }, de);
        if (filter && !(await cpu.call(filter, [de]))) { mem.free(de); continue; }
        kept.push(de);
      }
      if (compar && kept.length > 1) {
        const cell = mem.malloc(8), cmp = async (x: number, y: number) => { stp(cell, x); stp(cell + 4, y); return (await cpu.call(compar, [cell, cell + 4])) | 0; };
        try {
          // insertion sort: stable, and each comparison is a guest call
          for (let i = 1; i < kept.length; i++) {
            const v = kept[i];
            let j = i;
            while (j > 0 && (await cmp(kept[j - 1], v)) > 0) { kept[j] = kept[j - 1]; j--; }
            kept[j] = v;
          }
        } finally { mem.free(cell); }
      }
      const list = mem.malloc(Math.max(1, kept.length) * 4);
      for (let i = 0; i < kept.length; i++) stp(list + i * 4, kept[i]);
      stp(out, list);
      return kept.length;
    },
    alphasort: (_c, a) => { const x = mem.cstr(ldp(a.p()) + LAYOUT.D_NAME), y = mem.cstr(ldp(a.p()) + LAYOUT.D_NAME); return x < y ? -1 : x > y ? 1 : 0; },
    fts_open: (cpu, a) => ftsOpen(cpu, a.p(), a.i(), a.p()),
    fts_read: (_c, a) => {
      const walk = ftsWalks.get(a.p());
      if (!walk) return 0;
      if (walk.current) {
        const node = walk.nodes.get(walk.current);
        if (node && mem.ld16u(walk.current + FTS.instr) === 4) walk.index = node.end;
      }
      const entry = walk.entries[walk.index++] ?? 0;
      walk.current = entry;
      return entry ? ptr(entry) : 0;
    },
    fts_children: (_c, a) => {
      const walk = ftsWalks.get(a.p()); a.i();
      const first = walk?.nodes.get(walk.current)?.first ?? 0;
      return first ? ptr(first) : 0;
    },
    fts_set: (cpu, a) => {
      const walk = ftsWalks.get(a.p()), entry = a.p(), instruction = a.i();
      if (!walk || !walk.nodes.has(entry) || instruction < 1 || instruction > 4) return fail(cpu, E.INVAL);
      mem.st16(entry + FTS.instr, instruction); return 0;
    },
    fts_close: (_c, a) => closeFts(a.p()),

    fopen: (cpu, a) => {
      const path = a.str(), mode = a.str();
      const { o, f } = modeFlags(mode);
      const fd = fdOpen(cpu, path, o);
      if (fd < 0) return 0;
      return newFile(fd, f);
    },
    fdopen: (_c, a) => { const fd = a.i(), mode = a.str(); return fds.has(fd) ? newFile(fd, modeFlags(mode).f) : 0; },
    freopen: (cpu, a) => { const path = a.str(), mode = a.str(), fp = a.p(); const { o, f } = modeFlags(mode); pushback.delete(fp); fdClose(cpu, fileFd(fp)); const fd = fdOpen(cpu, path, o); if (fd < 0) return 0; files.set(fp, fd); mem.st16(fp + LAYOUT.F_FILE, fd); mem.st16(fp + LAYOUT.F_FLAGS, f); return fp; },
    tmpfile: (cpu) => { const fd = fdOpen(cpu, `/data/local/tmp/tmp${Date.now()}_${Math.floor(Math.random() * 1e6)}`, 2 | O_CREAT | O_TRUNC); return fd < 0 ? 0 : newFile(fd, F_RW); },
    fclose: (cpu, a) => { const fp = a.p(); pushback.delete(fp); const fd = fileFd(fp); const r = fdClose(cpu, fd); if (fp >= 0 && !isStd(fp)) { files.delete(fp); mem.free(fp); } return r; },
    fflush: (cpu, a) => { const fp = a.p(); return !fp || fds.has(fileFd(fp)) ? 0 : fail(cpu, E.BADF); },
    fread: (cpu, a) => {
      const p = a.p(), sz = a.u(), n = a.u(), fp = a.p();
      const total = sz * n;
      if (!total) return 0;
      const pending = pushback.get(fp);
      let used = 0;
      while (used < total && pending?.length) mem.u8[p + used++] = pending.pop()!;
      wrote(p, used);
      if (!pending?.length) pushback.delete(fp);
      if (used === total) return n;
      const fin = (r: number) => { if (r < 0) setFlag(fp, F_ERR); else if (r + used < total) setFlag(fp, F_EOF); return Math.floor((used + Math.max(0, r)) / sz); };
      const r = fdReadFully(cpu, fileFd(fp), p + used, total - used);
      return r instanceof Promise ? r.then(fin) : fin(r);
    },
    fwrite: (cpu, a) => { const p = a.p(), sz = a.u(), n = a.u(), fp = a.p(); const total = sz * n; if (!total) return 0; const r = fwriteBytes(cpu, fp, p, total); return Math.floor(r / sz); },
    fseek: (cpu, a) => { const fp = a.p(), off = a.i(); return fileSeek(cpu, fp, off, a.i()); },
    ftell: (cpu, a) => fileTell(cpu, a.p()),
    rewind: (cpu, a) => { const fp = a.p(); fileSeek(cpu, fp, 0, 0); mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~F_ERR); },
    fgetpos: (cpu, a) => { const fp = a.p(), pos = a.p(), value = fileTell(cpu, fp); if (value < 0) return -1; stp(pos, value); return 0; },
    fsetpos: (cpu, a) => { const fp = a.p(), pos = a.p(); return fileSeek(cpu, fp, mem.ld32(pos), 0); },
    feof: (_c, a) => (mem.ld16u(a.p() + LAYOUT.F_FLAGS) & F_EOF ? 1 : 0),
    ferror: (_c, a) => (mem.ld16u(a.p() + LAYOUT.F_FLAGS) & F_ERR ? 1 : 0),
    clearerr: (_c, a) => { const fp = a.p(); mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~(F_EOF | F_ERR)); },
    fileno: (_c, a) => fileFd(a.p()),
    setvbuf: () => 0, setbuf: () => {}, setbuffer: () => {}, setlinebuf: () => {},
    fgetc: (cpu, a) => fgetc(cpu, a.p()),
    getchar: () => -1,
    ungetc: (_c, a) => {
      const c = a.i(), fp = a.p();
      if (c === -1 || !(mem.ld16u(fp + LAYOUT.F_FLAGS) & (F_RD | F_RW))) return -1;
      let pending = pushback.get(fp);
      if (!pending) pushback.set(fp, pending = []);
      pending.push(c & 255);
      mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~F_EOF);
      return c & 255;
    },
    fgets: async (cpu, a) => {
      const buf = a.p(), n = a.i(), fp = a.p();
      if (n <= 0) return 0;
      let i = 0;
      while (i < n - 1) {
        const c = await fgetc(cpu, fp);
        if (c < 0) break;
        mem.st8(buf + i++, c);
        if (c === 10) break;
      }
      if (i === 0) return 0;
      mem.st8(buf + i, 0);
      return ARG0;
    },
    fputc: (cpu, a) => { const c = a.i() & 255, fp = a.p(); mem.u8[scratch] = c; return fwriteBytes(cpu, fp, scratch, 1) === 1 ? c : -1; },
    putchar: (cpu, a) => { const c = a.i() & 255; mem.u8[scratch] = c; return fwriteBytes(cpu, stdoutFp, scratch, 1) === 1 ? c : -1; },
    fputs: (cpu, a) => { const s = a.str(), fp = a.p(); return fwriteStr(cpu, fp, s) < 0 ? -1 : 0; },
    puts: (cpu, a) => fwriteStr(cpu, stdoutFp, a.str() + "\n"),
    fprintf: (cpu, a) => { const fp = a.p(), f = a.str(); return fwriteStr(cpu, fp, format(f, a)); },
    vfprintf: (cpu, a) => { const fp = a.p(), f = a.str(); return fwriteStr(cpu, fp, format(f, vaList(a.p()))); },
    printf: (cpu, a) => { const f = a.str(); return fwriteStr(cpu, stdoutFp, format(f, a)); },
    vprintf: (cpu, a) => { const f = a.str(); return fwriteStr(cpu, stdoutFp, format(f, vaList(a.p()))); },
    fscanf: (cpu, a) => {
      const fp = a.p(), f = a.str();
      const fd = fileFd(fp), fo = fds.get(fd);
      if (!fo) return -1;
      // scan the rest of the file as text, then advance by how much the conversions consumed
      const pending = pushback.get(fp);
      let data = fo.content.data.subarray(fo.pos, Math.min(fo.content.len, fo.pos + 65536));
      if (pending?.length) {
        const combined = new Uint8Array(pending.length + data.length);
        for (let i = 0; i < pending.length; i++) combined[i] = pending[pending.length - i - 1];
        combined.set(data, pending.length);
        data = combined;
      }
      const text = dec.decode(data);
      let consumed = 0;
      const sink = scanSink(a);
      const r = scan(text, f + "%n", (kind, v) => (kind === "n" ? ((consumed = v as number), 0) : sink(kind, v)));
      const bytes = utf8(text.slice(0, consumed)).length, used = Math.min(bytes, pending?.length ?? 0);
      if (pending) { pending.length -= used; if (!pending.length) pushback.delete(fp); }
      fo.pos += bytes - used;
      if (r < 0) setFlag(fp, F_EOF);
      return r;
    },
    perror: (_c, a) => { const s = a.p(); logLine(6, "stderr", (s ? mem.cstr(s) + ": " : "") + "error"); },
  };
  for (const [alias, name] of [["__openat_2", "openat"], ["epoll_pwait", "epoll_wait"], ["fseeko", "fseek"], ["ftello", "ftell"], ["getc", "fgetc"], ["__srget", "fgetc"], ["putc", "fputc"], ["__swbuf", "fputc"]]) M[alias] = M[name];
  for (const name of ["stat", "fstat", "lstat", "fstatat"]) M[name + "64"] = M[name];
  scratch = mem.hostAlloc(16);
  const isStd = (fp: number) => fp >= sF && fp < sF + 3 * LAYOUT.FILE_SIZE;
  hostLib("libc.so", M);
}
