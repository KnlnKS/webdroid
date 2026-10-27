// One process's descriptor table: the numbers naming its open files, which dup(2) and SCM_RIGHTS
// share, with close-on-exec and bionic's fdsan owner tags. An open file's kind (FileOps) answers the
// calls on it: files, directories and devices (fs.ts), pipes and fifos (pipe.ts), eventfd and timerfd
// (eventfd.ts), inotify (inotify.ts), epoll (poll.ts), sockets (socket/core.ts) and the open files
// another realm owns (process-fd.ts). Each call answers -errno on failure.

import { E, O_ACCMODE, O_APPEND, O_NONBLOCK, O_RDONLY, O_WRONLY, POLLIN, POLLNVAL, POLLOUT, S_IFMT, S_IFSOCK } from "./abi.ts";
import { mem, anchor, wrote } from "./mem.ts";
import { procIdentity } from "../shell/procfs.ts";
import { concat } from "../jvm/abi.ts";
import type { VfsFile } from "../shell/vfs.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import type { AttributeChange } from "../shell/file-path.ts";
import type { CrossingSocket } from "./socket/bridge.ts";

/** stat(2)'s answer: st_mode with the file type, st_size, st_mtime in milliseconds and the owner */
export type FileStat = { mode: number; size: number; mtime: number; uid: number; gid: number };
/** fstat(2)'s answer, with the path the open file has now, or the device node fstat reports for it */
export type FdStat = FileStat & { path: string | null; device?: string };

/** an open file: what descriptors dup(2) and SCM_RIGHTS share, with its kind's state */
export interface OpenFile<S = unknown> {
  ops: FileOps<S>; state: S; path: string; content: VfsFile; pos: number; dir: boolean; statusFlags: number; references: number;
  /** a read whose file answers later, which the next read at the position waits behind */
  readQueue?: Promise<void>;
  /** run when the last descriptor sharing this open file closes it */
  onLastClose?: () => void;
}

/** What an open file's kind does with each call, over its `state`. A result is -errno on failure. */
export interface FileOps<S = unknown> {
  /** st_mode of an open file without a name */
  readonly mode: number;
  /** whether pread and pwrite reach it: a stream has no offsets */
  readonly positional: boolean;
  /** Up to `n` bytes at `off`, or at the position (off < 0), which moves past them, into `target` from
   *  `at` (guest memory itself for a guest read). A stream that would wait answers -EAGAIN, and is waited
   *  on (watch) unless O_NONBLOCK. A Promise leaves `target` alone and settles to the bytes read, or -errno. */
  read(f: OpenFile<S>, target: Uint8Array, at: number, n: number, off: number, fd: number): number | Promise<Uint8Array | number>;
  /** `bytes` at `off`, or at the position (off < 0); the kind copies what it keeps */
  write(f: OpenFile<S>, bytes: Uint8Array, off: number): PromiseOrVal<number>;
  /** whether each write is one message, which writev gathers its vectors into and whose EPIPE
   *  raises no SIGPIPE */
  messages(f: OpenFile<S>): boolean;
  poll(f: OpenFile<S>, events: number): number;
  /** call `wake` once the readiness may have changed; answers how to stop */
  watch(f: OpenFile<S>, wake: () => void): () => void;
  seek(f: OpenFile<S>, off: number, whence: number): PromiseOrVal<number>;
  stat(f: OpenFile<S>): FdStat | Promise<FdStat | null>;
  sync(f: OpenFile<S>): PromiseOrVal<number>;
  /** FIONREAD: what a read could take now */
  available(f: OpenFile<S>): PromiseOrVal<number>;
  /** ioctl(2) with an int argument and result, but FIONREAD */
  ioctl(f: OpenFile<S>, request: number, arg: number): PromiseOrVal<number>;
  truncate(f: OpenFile<S>, length: number): PromiseOrVal<number>;
  allocate(f: OpenFile<S>, off: number, length: number): PromiseOrVal<number>;
  /** F_GETFL and F_SETFL */
  status(f: OpenFile<S>, cmd: number, arg: number): PromiseOrVal<number>;
  change(f: OpenFile<S>, change: AttributeChange, uid?: number): PromiseOrVal<number>;
  /** a regular file's bytes, read as a lazy source while descriptor `fd` names it */
  source(f: OpenFile<S>, fd: number): PromiseOrVal<FileSource | null>;
  /** a directory's entries as readdir lists them */
  entries(f: OpenFile<S>): PromiseOrVal<string[] | number>;
  /** a descriptor naming it closed: the calls waiting on that descriptor end */
  unnamed(f: OpenFile<S>): void;
  /** the last descriptor sharing the open file closed it; a remote one answers once its owner has */
  close(f: OpenFile<S>): void | Promise<number>;
  /** a socket end as it crosses to another realm, its connection carried across the port (socket/bridge.ts) */
  cross?(f: OpenFile<S>): CrossingSocket | null;
}
const F_DUPFD = 0, F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
const F_DUPFD_CLOEXEC = 0x406;
export const FIONREAD = 0x541b;
const NOOP = () => {};
/** an anonymous inode's answers, which each kind starts from: ready as its access mode allows, with no
 *  name, offsets or entries */
export const ANON: FileOps = {
  mode: 0o600,
  positional: false,
  read: () => -E.INVAL,
  write: () => -E.INVAL,
  messages: () => false,
  poll(f, events) {
    const access = f.statusFlags & O_ACCMODE;
    return (access !== O_WRONLY ? events & POLLIN : 0) | (access !== O_RDONLY ? events & POLLOUT : 0);
  },
  watch: () => NOOP,
  seek: () => -E.SPIPE,
  stat: (f) => ({ mode: f.ops.mode, size: 0, path: null, uid: procIdentity.uid, gid: procIdentity.uid, mtime: 0 }),
  sync: () => -E.INVAL,
  available: () => -E.NOTTY,
  ioctl: () => -E.NOTTY,
  truncate: () => -E.INVAL,
  allocate: () => -E.NODEV,
  status(f, cmd, arg) {
    if (cmd === F_GETFL) return f.statusFlags;
    f.statusFlags = (f.statusFlags & ~(O_APPEND | O_NONBLOCK)) | (arg & (O_APPEND | O_NONBLOCK));
    return 0;
  },
  change: () => -E.NOTSUP,
  source: () => null,
  entries: () => -E.NOTDIR,
  unnamed: NOOP,
  close: NOOP,
};
/** an open file of kind `ops` with its `state`, opened as `path` with `statusFlags`, reading `content` */
export const newFile = <S>(ops: FileOps<S>, path: string, statusFlags: number, state: S, content: VfsFile = { path: null, data: new Uint8Array(0), len: 0 }, dir = false): OpenFile<S> =>
  ({ ops, state, path, content, pos: 0, dir, statusFlags, references: 1 });
/** whether `f` is an open file of kind `ops` */
export const isKind = <S>(f: OpenFile | undefined, ops: FileOps<S>): f is OpenFile<S> => f?.ops === (ops as FileOps);

const fds = new Map<number, OpenFile>();
const closeOnExec = new Set<number>();
/** every descriptor below it is taken: 0, 1 and 2 are stdio's until the process closes them */
let lowest = 3;
export const openFd = (fd: number): OpenFile | undefined => fds.get(fd);
/** libcore's descriptor scopes (android/fd-scope.ts), told of descriptors closing and duplicating */
export const fdEvents: { closed?(fd: number): void; duplicated?(from: number, to: number): void } = {};
/** a descriptor for `f`, which takes over a reference to it: the lowest free at or above `min` */
export function installFile(f: OpenFile, cloexec = false, min = 0): number {
  let fd = Math.max(min, lowest);
  while (fds.has(fd)) fd++;
  if (min <= lowest) lowest = fd + 1;
  placeFile(fd, f, cloexec);
  return fd;
}
/** `f` at free descriptor `fd` */
export function placeFile(fd: number, f: OpenFile, cloexec = false): void {
  fds.set(fd, f);
  if (cloexec) closeOnExec.add(fd);
}
/** SCM_RIGHTS's hold on an open file while a message carries it, installed in the receiver's table
 *  when the message is read, or dropped */
export const holdFile = (f: OpenFile): OpenFile => { f.references++; return f; };
/** one reference to an open file gone: the last ends it */
export function dropFile(f: OpenFile): void | Promise<number> {
  if (--f.references > 0) return;
  f.onLastClose?.();
  return f.ops.close(f);
}
export function whenLastClosed(fd: number, hook: () => void): void { const f = fds.get(fd); if (f) f.onLastClose = hook; }
/** close(2); the last close of a remote open file answers once its owner has closed it */
export function closeFd(fd: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  if (!f) return -E.BADF;
  fds.delete(fd); closeOnExec.delete(fd); ownerTags.delete(fd);
  if (fd < lowest) lowest = fd;
  fdEvents.closed?.(fd);
  const closing = dropFile(f);
  f.ops.unnamed(f);
  return closing ?? 0;
}
/** dup(2) and F_DUPFD: the lowest free descriptor at or above `min`, sharing fd's open file */
function dupAbove(fd: number, min: number, cloexec: boolean): number {
  const f = fds.get(fd);
  if (!f) return -E.BADF;
  f.references++;
  const copy = installFile(f, cloexec, min);
  fdEvents.duplicated?.(fd, copy);
  return copy;
}
export const dupFd = (fd: number, cloexec = false): number => dupAbove(fd, 0, cloexec);
/** dup2(2) and dup3(2); the implicit close of `to` (unlike close) leaves its fdsan owner tag in place */
export function dup2Fd(fd: number, to: number, cloexec = false): number {
  if (to < 0) return -E.BADF;
  if (fd === to) return fds.has(fd) ? fd : -E.BADF;
  const f = fds.get(fd);
  if (!f) return -E.BADF;
  const tag = fdsanOwnerTag(to);
  if (fds.has(to)) closeFd(to);
  f.references++;
  placeFile(to, f, cloexec);
  fdEvents.duplicated?.(fd, to);
  if (tag) ownerTags.set(to, tag);
  return to;
}
/** fcntl(2): descriptor flags and duplicates belong to this table, status flags to the open file */
export function fcntlFd(fd: number, cmd: number, arg: number): PromiseOrVal<number> {
  if (cmd === F_DUPFD || cmd === F_DUPFD_CLOEXEC) return arg < 0 ? -E.INVAL : dupAbove(fd, arg, cmd === F_DUPFD_CLOEXEC);
  const f = fds.get(fd);
  if (!f) return -E.BADF;
  if (cmd === F_GETFD) return closeOnExec.has(fd) ? 1 : 0;
  if (cmd === F_SETFD) { if (arg & 1) closeOnExec.add(fd); else closeOnExec.delete(fd); return 0; }
  return cmd === F_GETFL || cmd === F_SETFL ? f.ops.status(f, cmd, arg) : 0;
}

/** why a read (or with `write`, a write) at `off` (-1: the position) cannot reach `f`, or 0 */
export function refused(f: OpenFile | undefined, off: number, write: boolean): number {
  if (!f) return -E.BADF;
  if (off >= 0 && !f.ops.positional) return -E.SPIPE;
  return (f.statusFlags & O_ACCMODE) === (write ? O_RDONLY : O_WRONLY) ? -E.BADF : 0;
}
/** once `f` may be ready: what a read that would wait waits for */
export const woken = (f: OpenFile): Promise<void> => new Promise((resolve) => { const stop = f.ops.watch(f, () => { stop(); resolve(); }); });
/** read(2), or pread(2) at `off`: up to `n` bytes into `into`, a byte array or guest memory at that
 *  address (resolved again if the bytes come once memory has grown), in place or once they come */
export function readFd(fd: number, into: Uint8Array | number, n: number, off = -1): PromiseOrVal<number> {
  const f = fds.get(fd), error = refused(f, off, false);
  if (error) return error;
  const guest = typeof into === "number", [target, start] = guest ? mem.reach(into, n) : [into, 0];
  const r = f!.ops.read(f!, target, start, n, off, fd);
  if (typeof r !== "number") {
    if (!guest) return r.then((v) => typeof v === "number" ? v : (into.set(v), v.length));
    const at = anchor(into);
    return r.then((v) => typeof v === "number" ? v : (mem.write(at(), v), v.length));
  }
  if (r > 0) { if (guest) wrote(into, r); }
  else if (r === -E.AGAIN && !(f!.statusFlags & O_NONBLOCK)) {
    const at = guest ? anchor(into) : null;
    return woken(f!).then(() => readFd(fd, at ? at() : into, n, off));
  }
  return r;
}
export const preadFd = (fd: number, into: Uint8Array | number, n: number, off: number): PromiseOrVal<number> => off < 0 ? -E.INVAL : readFd(fd, into, n, off);
export function writeFd(fd: number, bytes: Uint8Array, off = -1): PromiseOrVal<number> {
  const f = fds.get(fd), error = refused(f, off, true);
  return error || f!.ops.write(f!, bytes, off);
}
export const pwriteFd = (fd: number, bytes: Uint8Array, off: number): PromiseOrVal<number> => off < 0 ? -E.INVAL : writeFd(fd, bytes, off);
/** the rest of an open file from its position: a file's, which keeps it, or a stream's, which it consumes */
export async function readRest(fd: number): Promise<Uint8Array | null> {
  const f = fds.get(fd);
  if (!f || (f.statusFlags & O_ACCMODE) === O_WRONLY) return null;
  if (!f.ops.positional) {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = new Uint8Array(65536), n = await readFd(fd, chunk, chunk.length);
      if (n < 0) return null;
      if (!n) return concat(chunks);
      chunks.push(chunk.subarray(0, n));
    }
  }
  const [stat, position] = await Promise.all([f.ops.stat(f), f.ops.seek(f, 0, 1)]);
  if (!stat || position < 0) return null;
  const bytes = new Uint8Array(Math.max(0, stat.size - position)), n = await readFd(fd, bytes, bytes.length, position);
  return n < 0 ? null : bytes.subarray(0, n);
}
export function seekFd(fd: number, off: number, whence: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  return f ? f.ops.seek(f, off, whence) : -E.BADF;
}
export function truncateFd(fd: number, length: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  return f ? f.ops.truncate(f, length) : -E.BADF;
}
/** fsync and fdatasync */
export function syncFd(fd: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  return f ? f.ops.sync(f) : -E.BADF;
}
/** fallocate's mode 0: the file grown to cover the range */
export function allocateFd(fd: number, off: number, length: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  if (!f || (f.statusFlags & O_ACCMODE) === O_RDONLY) return -E.BADF;
  return off < 0 || length <= 0 ? -E.INVAL : f.ops.allocate(f, off, length);
}
/** ioctl(2) requests with an int result: FIONREAD, which files answer, and those a kind takes (ashmem's) */
export function ioctlIntFd(fd: number, request: number, arg = 0): PromiseOrVal<number> {
  const f = fds.get(fd);
  return !f ? -E.BADF : request === FIONREAD ? f.ops.available(f) : f.ops.ioctl(f, request, arg);
}
export function fdStat(fd: number): PromiseOrVal<FdStat | null> {
  const f = fds.get(fd);
  return f ? f.ops.stat(f) : null;
}
/** the stat of an open file this realm holds */
export function localFdStat(fd: number): FdStat | null {
  const f = fds.get(fd), stat = f && f.ops.stat(f);
  return !stat || stat instanceof Promise ? null : stat;
}
export function fdSource(fd: number): PromiseOrVal<FileSource | null> {
  const f = fds.get(fd);
  return f ? f.ops.source(f, fd) : null;
}
/** fchmod, fchown and futimens: a change to the file open on `fd`, which its owner (by `uid`) makes */
export function changeFdAttributes(fd: number, change: AttributeChange, uid?: number): PromiseOrVal<number> {
  const f = fds.get(fd);
  return f ? f.ops.change(f, change, uid) : -E.BADF;
}
/** what the open file `fd` names becomes crossing to another realm, if it is a socket end that can */
export function crossingOf(fd: number): CrossingSocket | null {
  const f = fds.get(fd);
  return f?.ops.cross?.(f) ?? null;
}
export const isSocketFd = (fd: number): boolean => ((fds.get(fd)?.ops.mode ?? 0) & S_IFMT) === S_IFSOCK;
/** poll(2)'s answer for one descriptor: which of `events` it is ready for, with POLLERR and POLLHUP */
export function pollEvents(fd: number, events: number): number {
  const f = fds.get(fd);
  return f ? f.ops.poll(f, events) : POLLNVAL;
}
/** call `wake` once the descriptor's readiness may have changed */
export function watchFd(fd: number, wake: () => void): () => void {
  const f = fds.get(fd);
  return f ? f.ops.watch(f, wake) : NOOP;
}

/** each descriptor's fdsan owner tag (fdsan.ts), which closing it clears */
const ownerTags = new Map<number, bigint>();
export const fdsanOwnerTag = (fd: number): bigint => ownerTags.get(fd) ?? 0n;
export function setFdsanOwnerTag(fd: number, tag: bigint): void { if (tag) ownerTags.set(fd, tag); else ownerTags.delete(fd); }
