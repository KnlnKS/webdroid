// stdio + the fd table over the JVM vfs: FILE structs live in guest memory (bionic __sFILE layout)
// so the getc/putc macros and __srget refills work; /proc/cpuinfo and /proc/meminfo are synthesized.

import { mem } from "./mem";
import { hostLib, hostData, vaList, type HostFn, PTR, stp, ARG0, ptr } from "./host";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { LAYOUT, fail, utf8, logLine, offArg, readTs, writeTs, clockTime } from "./libc";
import { format, scan } from "./printf";
import { vfs } from "../jvm/natives/jio";
import { device } from "../shell/config";
import type { FileSource } from "../shell/lazyfile";
import { isNativeSocket, nativeSocketClose, nativeSocketDup, nativeSocketFcntl, nativeSocketRead, nativeSocketWrite, setNativePollProvider } from "./net";
import { allocateFd, releaseFd, reserveFd } from "./fd";

const O_ACCMODE = 3, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400, O_NONBLOCK = 0x800, O_DIRECTORY = 0x4000;
const S_IFDIR = 0x4000, S_IFREG = 0x8000;

/** a pipe: byte chunks, and whoever is parked waiting for them (a reader, or an epoll_wait) */
interface Pipe { q: Uint8Array[]; wake: (() => void)[]; closed: boolean }
interface Timer { clock: number; next: number; interval: number; timeout?: ReturnType<typeof setTimeout> }
interface Fd {
  path: string; data: Uint8Array; len: number; pos: number; write: boolean; dirty: boolean; dir: boolean; append: boolean; statusFlags: number; references: number; line?: string; synthetic?: boolean;
  timer?: Timer; source?: FileSource; readQueue?: Promise<void>; byte?: number; random?: boolean; nonblock?: boolean; rpipe?: Pipe; wpipe?: Pipe; event?: { count: number; wake: (() => void)[] }; epoll?: Map<number, { events: number; data: bigint }>;
}
const EPOLLIN = 1, EAGAIN = E.AGAIN;
const newPipe = (): Pipe => ({ q: [], wake: [], closed: false });
const ready = (f: Fd): boolean => !!f.random || !!(f.rpipe && (f.rpipe.q.length || f.rpipe.closed)) || !!(f.event && f.event.count > 0);
function wakeAll(p: { wake: (() => void)[] }): void { for (const w of p.wake.splice(0)) w(); }
/** the fd's interest in being woken: pipe readers and epoll waiters both park here */
function waitOn(f: Fd, w: () => void): void { if (f.rpipe) f.rpipe.wake.push(w); else if (f.event) f.event.wake.push(w); }
const fdBase = (path: string): Fd => ({ path, data: new Uint8Array(0), len: 0, pos: 0, write: false, dirty: false, dir: false, append: false, statusFlags: 0, references: 1 });
const fds = new Map<number, Fd>();
const files = new Map<number, number>();       // FILE* → fd
const dirs = new Map<number, { entries: string[]; i: number; dirent: number }>();
const cpuList = device.cpu.cores === 1 ? "0\n" : `0-${device.cpu.cores - 1}\n`;

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

function synth(path: string): string | null {
  if (path === "/proc/cpuinfo") {
    let s = "";
    for (let i = 0; i < device.cpu.cores; i++) s += `processor\t: ${i}\nmodel name\t: ARMv7 Processor rev 0 (v7l)\nBogoMIPS\t: 38.40\nFeatures\t: ${device.cpu.features}\nCPU implementer\t: 0x41\nCPU architecture: 7\nCPU variant\t: 0x0\nCPU part\t: 0xc07\nCPU revision\t: 0\n\n`;
    return s + `Hardware\t: ${device.cpu.hardware}\nRevision\t: 0000\nSerial\t\t: 0000000000000000\n`;
  }
  if (path === "/sys/devices/system/cpu/present" || path === "/sys/devices/system/cpu/possible" || path === "/sys/devices/system/cpu/online") return cpuList;
  if (path === "/proc/meminfo") return `MemTotal:        ${device.cpu.memKb} kB\nMemFree:         ${device.cpu.memKb >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n`;
  if (path === "/proc/self/maps" || path === "/proc/self/cmdline") return "";
  return null;
}

function fdOpen(cpu: Cpu, path: string, flags: number): number {
  path = vfs.norm(path);
  const acc = flags & O_ACCMODE;
  if (path === "/dev/urandom" || path === "/dev/random") {
    if (acc !== 0) return fail(cpu, E.ACCES);
    return put({ ...fdBase(path), random: true });
  }
  const s = synth(path);
  if (s !== null) { const b = utf8(s); return put({ ...fdBase(path), data: b, len: b.length, synthetic: true }); }
  if (vfs.isDir(path)) {
    if (acc !== 0) return fail(cpu, E.ISDIR);
    return put({ ...fdBase(path), dir: true });
  }
  if (flags & O_DIRECTORY) return fail(cpu, E.NOTDIR);
  const found = vfs.stat(path);
  let data = vfs.read(path);
  if (found && !data && acc !== 0) return fail(cpu, E.ACCES);
  if (!found) {
    if (!(flags & O_CREAT)) return fail(cpu, E.NOENT);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!vfs.isDir(parent)) return fail(cpu, E.NOENT);
    data = new Uint8Array(0);
    vfs.write(path, data);
  } else if (flags & O_CREAT && flags & O_EXCL) return fail(cpu, E.EXIST);
  if (flags & O_TRUNC && acc !== 0) { data = new Uint8Array(0); vfs.write(path, data); }
  return put({ ...fdBase(path), data: data ?? new Uint8Array(0), source: data ? undefined : found?.source, len: data?.length ?? found?.size ?? 0, write: acc !== 0, append: !!(flags & O_APPEND), nonblock: !!(flags & O_NONBLOCK), statusFlags: flags & (O_ACCMODE | O_APPEND | O_NONBLOCK) });
}
function put(f: Fd): number { const fd = allocateFd(); fds.set(fd, f); return fd; }

function grow(f: Fd, need: number): void {
  if (need <= f.data.length) return;
  const n = new Uint8Array(Math.max(need, f.data.length * 2, 4096));
  n.set(f.data.subarray(0, f.len));
  f.data = n;
}
function fdWrite(cpu: Cpu, fd: number, p: number, n: number): number {
  if (isNativeSocket(fd)) return nativeSocketWrite(cpu, fd, p, n);
  if (fd === 1 || fd === 2) {
    const s = new TextDecoder().decode(mem.u8.subarray(p, p + n));
    const f = fds.get(fd)!;
    f.line = (f.line ?? "") + s;
    let i: number;
    while ((i = f.line.indexOf("\n")) >= 0) { logLine(fd === 2 ? 6 : 4, fd === 2 ? "stderr" : "stdout", f.line.slice(0, i)); f.line = f.line.slice(i + 1); }
    return n;
  }
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.wpipe) { f.wpipe.q.push(mem.u8.slice(p, p + n)); wakeAll(f.wpipe); return n; }
  if (f.timer) return fail(cpu, E.INVAL);
  if (f.event) { f.event.count += mem.ld32(p); wakeAll(f.event); return 8; }
  if (!f.write) return fail(cpu, E.BADF);
  if (f.append) f.pos = f.len;
  grow(f, f.pos + n);
  f.data.set(mem.u8.subarray(p, p + n), f.pos);
  f.pos += n;
  if (f.pos > f.len) f.len = f.pos;
  f.dirty = true;
  return n;
}
const guestAt = (base: number | bigint, offset = 0): number =>
  typeof base === "bigint" ? mem.txVa(base + BigInt(offset)) : base + offset;
function fdReadAt(cpu: Cpu, f: Fd, p: number, n: number, off: number): number | Promise<number> {
  if (!n) return 0;
  if (f.random) {
    let done = 0;
    while (done < n) {
      const take = Math.min(65536, n - done);
      crypto.getRandomValues(mem.u8.subarray(p + done, p + done + take));
      done += take;
    }
    return n;
  }
  const k = Math.max(0, Math.min(n, f.len - off));
  if (!k) return 0;
  if (!f.source) { mem.write(p, f.data.subarray(off, off + k)); return k; }
  let value: Uint8Array | Promise<Uint8Array>;
  const dst = mem.va(p);
  try { value = f.source.read(off, k); }
  catch { return fail(cpu, E.IO); }
  const done = (bytes: Uint8Array) => { mem.write(guestAt(dst), bytes); return bytes.length; };
  return value instanceof Promise ? value.then(done, () => fail(cpu, E.IO)) : done(value);
}
function fdRead(cpu: Cpu, fd: number, p: number, n: number): number | Promise<number> {
  if (isNativeSocket(fd)) return nativeSocketRead(cpu, fd, p, n);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.dir) return fail(cpu, E.ISDIR);
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
    while (k < n && q.length) { const c = q[0], take = Math.min(n - k, c.length); mem.u8.set(c.subarray(0, take), p + k); k += take; if (take === c.length) q.shift(); else q[0] = c.subarray(take); }
    return k;
  }
  if (f.source) {
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
function fdReadFully(cpu: Cpu, fd: number, p: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f?.source) return fdRead(cpu, fd, p, n);
  const dst = mem.va(p);
  return (async () => {
    let total = 0;
    while (total < n) {
      const read = await fdRead(cpu, fd, guestAt(dst, total), n - total);
      if (read <= 0) return total || read;
      total += read;
    }
    return total;
  })();
}
/** `n` bytes of `fd` from offset `off` into guest memory at `dst`, without moving the position */
export function readInto(cpu: Cpu, fd: number, off: number, dst: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (!f.source) return fdReadAt(cpu, f, dst, n, off);
  return readIntoAsync(cpu, f, off, dst, n);
}
async function readIntoAsync(cpu: Cpu, f: Fd, off: number, dst: number, n: number): Promise<number> {
  const target = mem.va(dst);
  let total = 0;
  while (total < n) {
    const read = await fdReadAt(cpu, f, guestAt(target, total), n - total, off + total);
    if (read <= 0) return total || read;
    total += read;
  }
  return total;
}
function flushFd(f: Fd): void {
  if (f.dirty && !f.synthetic) { vfs.write(f.path, f.data.slice(0, f.len)); f.dirty = false; }
}
function fdClose(cpu: Cpu, fd: number): number {
  if (isNativeSocket(fd)) return nativeSocketClose(cpu, fd);
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (fd <= 2) return 0;
  fds.delete(fd); releaseFd(fd);
  if (--f.references > 0) return 0;
  flushFd(f);
  if (f.timer) clearTimeout(f.timer.timeout);
  if (f.wpipe) { f.wpipe.closed = true; wakeAll(f.wpipe); }
  return 0;
}
function fdSeek(cpu: Cpu, fd: number, off: number, whence: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.random) return fail(cpu, E.SPIPE);
  const np = whence === 0 ? off : whence === 1 ? f.pos + off : f.len + off;
  if (np < 0) return fail(cpu, E.INVAL);
  f.pos = np;
  return np;
}
/** an inode per path: a runtime's own share table (Mono's sharing violations) keys on st_dev/st_ino */
function inoOf(path: string): number { let h = 0x811c9dc5; for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 0x01000193); return (h >>> 0) || 1; }
function fillStat(buf: number, isDir: boolean, size: number, mtimeMs: number, path: string): void {
  mem.memset(buf, 0, LAYOUT.STAT_SIZE);
  mem.st32(buf, 1);                                                                  // st_dev
  mem.st32(buf + LAYOUT.ST_MODE, (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644));
  mem.st32(buf + LAYOUT.ST_NLINK, 1);
  mem.st32(buf + LAYOUT.ST_UID, 10123); mem.st32(buf + LAYOUT.ST_GID, 10123);
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
  for (let i = 0; i < v.length; i++) stp(b + i * PTR, v[i]);
}
/** statfs: a fixed-size filesystem with room; the LP64 struct is all 64-bit fields at an 8-byte stride */
function fillStatfs(b: number): void {
  mem.memset(b, 0, LAYOUT.STATFS_SIZE);
  const w = PTR, put = (i: number, v: number) => stp(b + i * w, v);
  put(1, 4096); put(2, 0x100000); put(3, 0x80000); put(4, 0x80000); put(5, 0x10000); put(6, 0x8000);
  if (PTR === 8) { put(8, 255); put(9, 4096); } else { mem.st32(b + 56, 255); mem.st32(b + 60, 4096); }
}
function makePipe(out: number, flags: number): number {
  const p = newPipe(), nb = !!(flags & 0x800);
  mem.st32(out, put({ ...fdBase("pipe"), rpipe: p, nonblock: nb, statusFlags: nb ? O_NONBLOCK : 0 }));
  mem.st32(out + 4, put({ ...fdBase("pipe"), wpipe: p, nonblock: nb, write: true, statusFlags: 1 | (nb ? O_NONBLOCK : 0) }));
  return 0;
}
/** epoll_wait: report the registered fds that are readable; else sleep the timeout, or park until one is written */
function epollWait(cpu: Cpu, epfd: number, events: number, max: number, timeout: number): number | Promise<number> {
  const table = fds.get(epfd)?.epoll;
  if (!table) return fail(cpu, E.BADF);
  let n = 0;
  for (const [fd, e] of table) {
    const f = fds.get(fd);
    if (n < max && f && (e.events & EPOLLIN) && ready(f)) { mem.st32(events + n * 16, EPOLLIN); mem.st64(events + n * 16 + 8, e.data); n++; }
  }
  if (n || timeout === 0) return n;
  return new Promise<void>((r) => {
    let done = false;
    const once = () => { if (!done) { done = true; clearTimeout(t); r(); } };
    const t = timeout < 0 ? undefined : setTimeout(once, timeout);
    for (const fd of table.keys()) { const f = fds.get(fd); if (f) waitOn(f, once); }
  }).then(() => epollWait(cpu, epfd, mem.rephys(events), max, 0));
}
function armTimer(f: Fd): void {
  const timer = f.timer!, event = f.event!;
  clearTimeout(timer.timeout);
  if (!timer.next) return;
  timer.timeout = setTimeout(() => {
    const now = clockTime(timer.clock);
    if (now >= timer.next) {
      const count = timer.interval ? Math.floor((now - timer.next) / timer.interval) + 1 : 1;
      event.count += count;
      timer.next = timer.interval ? timer.next + count * timer.interval : 0;
      wakeAll(event);
    }
    armTimer(f);
  }, Math.min(0x7fffffff, Math.max(0, timer.next - clockTime(timer.clock))));
}
function timerState(timer: Timer, out: number): void {
  writeTs(out, timer.interval);
  writeTs(out + PTR * 2, timer.next ? Math.max(0, timer.next - clockTime(timer.clock)) : 0);
}
function statPath(cpu: Cpu, path: string, buf: number): number {
  path = vfs.norm(path);
  if (path === "/dev/urandom" || path === "/dev/random") { fillStat(buf, false, 0, Date.now(), path); return 0; }
  const s = synth(path);
  if (s !== null) { fillStat(buf, false, utf8(s).length, Date.now(), path); return 0; }
  if (vfs.isDir(path)) { fillStat(buf, true, 4096, Date.now(), path); return 0; }
  const file = vfs.stat(path);
  if (!file) return fail(cpu, E.NOENT);
  fillStat(buf, false, file.size, Date.now(), path);
  return 0;
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
function setFlag(fp: number, f: number): void { mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) | f); }
function modeFlags(mode: string): { o: number; f: number } {
  const plus = mode.includes("+");
  if (mode[0] === "r") return { o: plus ? 2 : 0, f: plus ? F_RW : F_RD };
  if (mode[0] === "w") return { o: (plus ? 2 : 1) | O_CREAT | O_TRUNC, f: plus ? F_RW : F_WR };
  return { o: (plus ? 2 : 1) | O_CREAT | O_APPEND, f: plus ? F_RW : F_WR };
}
let scratch = 0;
function fgetc(cpu: Cpu, fp: number): number | Promise<number> {
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

const putChar: HostFn = (cpu, a) => { const c = a.i() & 255, fp = a.p(); mem.u8[scratch] = c; return fwriteBytes(cpu, fp, scratch, 1) === 1 ? c : -1; };

export function stdioInit(): void {
  fds.set(0, fdBase("/dev/stdin"));
  fds.set(1, { ...fdBase("/dev/stdout"), write: true, statusFlags: 1 });
  fds.set(2, { ...fdBase("/dev/stderr"), write: true, statusFlags: 1 });
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
      if (path.startsWith("/") || dirfd === -100) return fdOpen(cpu, path, flags);
      const dir = fds.get(dirfd);
      if (!dir) return fail(cpu, E.BADF);
      return dir.dir ? fdOpen(cpu, dir.path + "/" + path, flags) : fail(cpu, E.NOTDIR);
    },
    creat: (cpu, a) => fdOpen(cpu, a.str(), 1 | O_CREAT | O_TRUNC),
    close: (cpu, a) => fdClose(cpu, a.i()),
    read: (cpu, a) => fdRead(cpu, a.i(), a.p(), a.u()),
    write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
    pread: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); const f = fds.get(fd); return f ? fdReadAt(cpu, f, p, n, off) : fail(cpu, E.BADF); },
    pwrite: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdWrite(cpu, fd, p, n); f.pos = save; return r; },
    pread64: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); const f = fds.get(fd); return f ? fdReadAt(cpu, f, p, n, off) : fail(cpu, E.BADF); },
    pwrite64: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdWrite(cpu, fd, p, n); f.pos = save; return r; },
    lseek: (cpu, a) => (PTR === 8 ? BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())) : fdSeek(cpu, a.i(), a.i(), a.i())),
    lseek64: (cpu, a) => BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())),
    fstat: (cpu, a) => { const fd = a.i(), buf = a.p(); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); fillStat(buf, f.dir, f.len, Date.now(), f.path); return 0; },
    stat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    lstat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    access: (cpu, a) => { const p = vfs.norm(a.str()); a.i(); return vfs.exists(p) || vfs.isDir(p) || synth(p) !== null || p === "/dev/urandom" || p === "/dev/random" ? 0 : fail(cpu, E.NOENT); },
    chmod: () => 0, fchmod: () => 0, chown: () => 0, fchown: () => 0, umask: () => 0o22,
    unlink: (cpu, a) => (vfs.delete(a.str()) ? 0 : fail(cpu, E.NOENT)),
    remove: (cpu, a) => { const p = vfs.norm(a.str()); if (vfs.isDir(p)) return vfs.list(p).length ? fail(cpu, E.NOTEMPTY) : 0; return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    rename: (cpu, a) => { const from = vfs.norm(a.str()), to = vfs.norm(a.str()); const d = vfs.read(from); if (!d) return fail(cpu, E.NOENT); vfs.write(to, d); vfs.delete(from); return 0; },
    mkdir: (cpu, a) => { const p = vfs.norm(a.str()); if (vfs.exists(p) || vfs.isDir(p)) return fail(cpu, E.EXIST); const parent = p.slice(0, p.lastIndexOf("/")) || "/"; if (parent !== "/" && !vfs.isDir(parent)) return fail(cpu, E.NOENT); vfs.mkdir(p); return 0; },
    rmdir: (cpu, a) => { const p = vfs.norm(a.str()); if (!vfs.isDir(p)) return fail(cpu, E.NOTDIR); if (vfs.list(p).length) return fail(cpu, E.NOTEMPTY); vfs.rmdir(p); return 0; },
    ftruncate: (cpu, a) => { const f = fds.get(a.i()); const n = offArg(a); if (!f) return fail(cpu, E.BADF); grow(f, n); if (n > f.len) f.data.fill(0, f.len, n); f.len = n; f.dirty = true; return 0; },
    ftruncate64: (cpu, a) => { const f = fds.get(a.i()); const n = Number(a.l()); if (!f) return fail(cpu, E.BADF); grow(f, n); if (n > f.len) f.data.fill(0, f.len, n); f.len = n; f.dirty = true; return 0; },
    truncate: (cpu, a) => { const p = vfs.norm(a.str()), n = offArg(a); const d = vfs.read(p); if (!d) return fail(cpu, E.NOENT); const nd = new Uint8Array(n); nd.set(d.subarray(0, Math.min(n, d.length))); vfs.write(p, nd); return 0; },
    fcntl: (cpu, a) => {
      const fd = a.i(), cmd = a.i(), value = a.i();
      if (isNativeSocket(fd)) return nativeSocketFcntl(cpu, fd, cmd, value);
      const f = fds.get(fd);
      if (!f) return fail(cpu, E.BADF);
      if (cmd === 3) return f.statusFlags;
      if (cmd === 4) {
        f.statusFlags = (f.statusFlags & ~(O_APPEND | O_NONBLOCK)) | (value & (O_APPEND | O_NONBLOCK));
        f.append = !!(f.statusFlags & O_APPEND);
        f.nonblock = !!(f.statusFlags & O_NONBLOCK);
      }
      return 0;
    },
    fsync: () => 0, fdatasync: () => 0, sync: () => {},
    dup: (cpu, a) => { const fd = a.i(); if (isNativeSocket(fd)) return nativeSocketDup(cpu, fd); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); f.references++; return put(f); },
    dup2: (cpu, a) => {
      const fd = a.i(), to = a.i();
      if (to < 0) return fail(cpu, E.BADF);
      if (fd === to) return isNativeSocket(fd) || fds.has(fd) ? fd : fail(cpu, E.BADF);
      if (isNativeSocket(fd)) {
        if (isNativeSocket(to)) nativeSocketClose(cpu, to);
        else if (fds.has(to)) fdClose(cpu, to);
        return nativeSocketDup(cpu, fd, to);
      }
      const f = fds.get(fd);
      if (!f) return fail(cpu, E.BADF);
      if (isNativeSocket(to)) nativeSocketClose(cpu, to);
      else if (fds.has(to)) fdClose(cpu, to);
      f.references++;
      reserveFd(to);
      fds.set(to, f);
      return to;
    },
    pipe: (_c, a) => makePipe(a.p(), 0),
    pipe2: (_c, a) => makePipe(a.p(), a.i()),
    socketpair: (_c, a) => {
      a.i(); const type = a.i(); a.i(); const sv = a.p();
      const ab = newPipe(), ba = newPipe(), nb = !!(type & 0x800);
      mem.st32(sv, put({ ...fdBase("socketpair"), rpipe: ab, wpipe: ba, nonblock: nb, statusFlags: 2 | (nb ? O_NONBLOCK : 0) }));
      mem.st32(sv + 4, put({ ...fdBase("socketpair"), rpipe: ba, wpipe: ab, nonblock: nb, statusFlags: 2 | (nb ? O_NONBLOCK : 0) }));
      return 0;
    },
    timerfd_create: (cpu, a) => {
      const clock = a.i(), flags = a.i();
      if (![0, 1, 7].includes(clock) || flags & ~(O_NONBLOCK | 0x80000)) return fail(cpu, E.INVAL);
      return put({ ...fdBase("timerfd"), timer: { clock, next: 0, interval: 0 }, event: { count: 0, wake: [] }, nonblock: !!(flags & O_NONBLOCK), statusFlags: 2 | (flags & O_NONBLOCK) });
    },
    timerfd_settime: (cpu, a) => {
      const fd = a.i(), flags = a.i(), value = a.p(), old = a.p(), f = fds.get(fd);
      if (!f) return fail(cpu, E.BADF);
      if (!f.timer || flags & ~1) return fail(cpu, E.INVAL);
      const interval = readTs(value), next = readTs(value + PTR * 2);
      if (interval < 0 || next < 0 || mem.ld32(value + PTR) < 0 || mem.ld32(value + PTR) >= 1e9 || mem.ld32(value + PTR * 3) < 0 || mem.ld32(value + PTR * 3) >= 1e9) return fail(cpu, E.INVAL);
      if (old) timerState(f.timer, old);
      f.timer.interval = interval;
      f.timer.next = next ? next + (flags & 1 ? 0 : clockTime(f.timer.clock)) : 0;
      f.event!.count = 0;
      armTimer(f);
      return 0;
    },
    timerfd_gettime: (cpu, a) => {
      const fd = a.i(), out = a.p(), f = fds.get(fd);
      if (!f) return fail(cpu, E.BADF);
      if (!f.timer) return fail(cpu, E.INVAL);
      timerState(f.timer, out); return 0;
    },
    eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return put({ ...fdBase("eventfd"), event: { count: init, wake: [] }, nonblock: !!(flags & O_NONBLOCK), statusFlags: 2 | (flags & O_NONBLOCK) }); },
    epoll_create: () => put({ ...fdBase("epoll"), epoll: new Map(), statusFlags: 2 }),
    epoll_create1: () => put({ ...fdBase("epoll"), epoll: new Map(), statusFlags: 2 }),
    epoll_ctl: (cpu, a) => {
      const ep = fds.get(a.i()), op = a.i(), fd = a.i(), ev = a.p();
      if (!ep?.epoll || !fds.has(fd)) return fail(cpu, E.BADF);
      if (op === 2) ep.epoll.delete(fd); else ep.epoll.set(fd, { events: mem.ld32(ev), data: mem.ld64(ev + 8) });
      return 0;
    },
    epoll_wait: (cpu, a) => epollWait(cpu, a.i(), a.p(), a.i(), a.i()),
    epoll_pwait: (cpu, a) => epollWait(cpu, a.i(), a.p(), a.i(), a.i()),
    sendfile: (cpu) => fail(cpu, E.NOSYS),
    __read_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(); if (n > a.u()) cpu.fault("fortify: read past the buffer"); return fdRead(cpu, fd, p, n); },
    __pread64_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); if (n > a.u()) cpu.fault("fortify: pread past the buffer"); const f = fds.get(fd); return f ? fdReadAt(cpu, f, p, n, off) : fail(cpu, E.BADF); },
    __pread_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); if (n > a.u()) cpu.fault("fortify: pread past the buffer"); const f = fds.get(fd); return f ? fdReadAt(cpu, f, p, n, off) : fail(cpu, E.BADF); },
    flock: () => 0,
    unlinkat: (cpu, a) => { a.i(); const p = a.str(), flags = a.i(); if (flags & 0x200) { const d = vfs.norm(p); if (!vfs.isDir(d)) return fail(cpu, E.NOTDIR); vfs.rmdir(d); return 0; } return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    fchmodat: () => 0, utimensat: () => 0, futimens: () => 0,
    pathconf: (_c, a) => { a.str(); return pathconfOf(a.i()); },
    fpathconf: (_c, a) => { a.i(); return pathconfOf(a.i()); },
    statvfs: (_c, a) => { a.str(); fillStatvfs(a.p()); return 0; },
    fstatvfs: (_c, a) => { a.i(); fillStatvfs(a.p()); return 0; },
    isatty: () => 0,
    ioctl: (cpu) => fail(cpu, E.NOSYS),
    statfs: (_c, a) => { a.str(); fillStatfs(a.p()); return 0; },
    fstatfs: (_c, a) => { a.i(); fillStatfs(a.p()); return 0; },
    getcwd: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "/", n); return ARG0; },
    chdir: () => 0,
    realpath: (_c, a) => { const p = vfs.norm(a.str()); let out = a.p(); if (!out) out = mem.malloc(4096); mem.putCstr(out, p, 4096); return ptr(out); },
    readlink: (cpu) => fail(cpu, E.INVAL),
    symlink: (cpu) => fail(cpu, E.PERM), link: (cpu) => fail(cpu, E.PERM),
    utimes: () => 0, utime: () => 0,

    opendir: (cpu, a) => {
      const p = vfs.norm(a.str());
      if (!vfs.isDir(p)) { fail(cpu, vfs.exists(p) ? E.NOTDIR : E.NOENT); return 0; }
      const h = mem.malloc(16);
      dirs.set(h, { entries: [".", "..", ...vfs.list(p)], i: 0, dirent: mem.malloc(LAYOUT.DIRENT_SIZE) });
      return h;
    },
    fdopendir: (cpu, a) => { const f = fds.get(a.i()); if (!f || !f.dir) { fail(cpu, E.NOTDIR); return 0; } const h = mem.malloc(16); dirs.set(h, { entries: [".", "..", ...vfs.list(f.path)], i: 0, dirent: mem.malloc(LAYOUT.DIRENT_SIZE) }); return h; },
    readdir: (_c, a) => {
      const d = dirs.get(a.p());
      if (!d || d.i >= d.entries.length) return 0;
      const name = d.entries[d.i++];
      const de = d.dirent;
      mem.memset(de, 0, LAYOUT.DIRENT_SIZE);
      mem.st32(de + LAYOUT.D_INO, d.i); mem.st32(de + LAYOUT.D_OFF, d.i);
      mem.st16(de + LAYOUT.D_RECLEN, LAYOUT.DIRENT_SIZE);
      mem.st8(de + LAYOUT.D_TYPE, 8); // DT_REG; refined below
      mem.putCstr(de + LAYOUT.D_NAME, name, 256);
      return de;
    },
    readdir_r: (_c, a) => { const h = a.p(), ent = a.p(), res = a.p(); const d = dirs.get(h); if (!d || d.i >= d.entries.length) { stp(res, 0); return 0; } const name = d.entries[d.i++]; mem.memset(ent, 0, LAYOUT.DIRENT_SIZE); mem.st16(ent + LAYOUT.D_RECLEN, LAYOUT.DIRENT_SIZE); mem.st8(ent + LAYOUT.D_TYPE, 8); mem.putCstr(ent + LAYOUT.D_NAME, name, 256); stp(res, ent); return 0; },
    rewinddir: (_c, a) => { const d = dirs.get(a.p()); if (d) d.i = 0; },
    closedir: (_c, a) => { const h = a.p(); const d = dirs.get(h); if (d) { mem.free(d.dirent); mem.free(h); dirs.delete(h); return 0; } return -1; },
    dirfd: () => -1,

    fopen: (cpu, a) => {
      const path = a.str(), mode = a.str();
      const { o, f } = modeFlags(mode);
      const fd = fdOpen(cpu, path, o);
      if (fd < 0) return 0;
      return newFile(fd, f);
    },
    fdopen: (_c, a) => { const fd = a.i(), mode = a.str(); return fds.has(fd) ? newFile(fd, modeFlags(mode).f) : 0; },
    freopen: (cpu, a) => { const path = a.str(), mode = a.str(), fp = a.p(); const { o, f } = modeFlags(mode); fdClose(cpu, fileFd(fp)); const fd = fdOpen(cpu, path, o); if (fd < 0) return 0; files.set(fp, fd); mem.st16(fp + LAYOUT.F_FILE, fd); mem.st16(fp + LAYOUT.F_FLAGS, f); return fp; },
    tmpfile: (cpu) => { const fd = fdOpen(cpu, `/data/local/tmp/tmp${Date.now()}_${Math.floor(Math.random() * 1e6)}`, 2 | O_CREAT | O_TRUNC); return fd < 0 ? 0 : newFile(fd, F_RW); },
    fclose: (cpu, a) => { const fp = a.p(); const fd = fileFd(fp); const r = fdClose(cpu, fd); if (fp >= 0 && !isStd(fp)) { files.delete(fp); mem.free(fp); } return r; },
    fflush: (_c, a) => { const fp = a.p(); if (!fp) { for (const f of fds.values()) flushFd(f); return 0; } const f = fds.get(fileFd(fp)); if (f) flushFd(f); return 0; },
    fread: (cpu, a) => {
      const p = a.p(), sz = a.u(), n = a.u(), fp = a.p();
      const total = sz * n;
      if (!total) return 0;
      const fin = (r: number) => { if (r < 0) { setFlag(fp, F_ERR); return 0; } if (r < total) setFlag(fp, F_EOF); return Math.floor(r / sz); };
      const r = fdReadFully(cpu, fileFd(fp), p, total);
      return r instanceof Promise ? r.then(fin) : fin(r);
    },
    fwrite: (cpu, a) => { const p = a.p(), sz = a.u(), n = a.u(), fp = a.p(); const total = sz * n; if (!total) return 0; const r = fwriteBytes(cpu, fp, p, total); return Math.floor(r / sz); },
    fseek: (cpu, a) => { const fp = a.p(), off = offArg(a), wh = a.i(); const r = fdSeek(cpu, fileFd(fp), off, wh); if (r >= 0) mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~F_EOF); return r < 0 ? -1 : 0; },
    fseeko: (cpu, a) => { const fp = a.p(), off = offArg(a), wh = a.i(); return fdSeek(cpu, fileFd(fp), off, wh) < 0 ? -1 : 0; },
    ftell: (_c, a) => { const f = fds.get(fileFd(a.p())); return f ? f.pos : -1; },
    ftello: (_c, a) => { const f = fds.get(fileFd(a.p())); return f ? f.pos : -1; },
    rewind: (cpu, a) => { const fp = a.p(); fdSeek(cpu, fileFd(fp), 0, 0); mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~(F_EOF | F_ERR)); },
    fgetpos: (_c, a) => { const f = fds.get(fileFd(a.p())); const pos = a.p(); if (!f) return -1; stp(pos, f.pos); return 0; },
    fsetpos: (cpu, a) => { const fp = a.p(), pos = a.p(); return fdSeek(cpu, fileFd(fp), mem.ld32(pos), 0) < 0 ? -1 : 0; },
    feof: (_c, a) => (mem.ld16u(a.p() + LAYOUT.F_FLAGS) & F_EOF ? 1 : 0),
    ferror: (_c, a) => (mem.ld16u(a.p() + LAYOUT.F_FLAGS) & F_ERR ? 1 : 0),
    clearerr: (_c, a) => { const fp = a.p(); mem.st16(fp + LAYOUT.F_FLAGS, mem.ld16u(fp + LAYOUT.F_FLAGS) & ~(F_EOF | F_ERR)); },
    fileno: (_c, a) => fileFd(a.p()),
    setvbuf: () => 0, setbuf: () => {}, setbuffer: () => {}, setlinebuf: () => {},
    fgetc: (cpu, a) => fgetc(cpu, a.p()),
    getc: (cpu, a) => fgetc(cpu, a.p()),
    __srget: (cpu, a) => fgetc(cpu, a.p()),
    getchar: () => -1,
    ungetc: (_c, a) => { const c = a.i(), fp = a.p(); const f = fds.get(fileFd(fp)); if (!f || f.pos === 0) return -1; f.pos--; if (f.data[f.pos] !== c && !f.synthetic && !f.source && !f.random) { f.data[f.pos] = c; } return c; },
    fgets: async (cpu, a) => {
      const buf = a.p(), n = a.i(), fp = a.p();
      if (n <= 0) return 0;
      let i = 0;
      while (i < n - 1) {
        const c = await fgetc(cpu, fp);
        if (c < 0) break;
        mem.u8[buf + i++] = c;
        if (c === 10) break;
      }
      if (i === 0) return 0;
      mem.u8[buf + i] = 0;
      return ARG0;
    },
    fputc: putChar,
    putc: putChar,
    __swbuf: putChar,
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
      const text = new TextDecoder().decode(fo.data.subarray(fo.pos, Math.min(fo.len, fo.pos + 65536)));
      let consumed = 0;
      const r = scan(text + "", f + "%n", (kind, v) => {
        if (kind === "n") { consumed = v as number; return 0; }
        const dst = a.p();
        if (!dst) return 0;
        if (kind === "i") mem.st32(dst, v as number); else if (kind === "h") mem.st16(dst, v as number); else if (kind === "b") mem.st8(dst, v as number);
        else if (kind === "l") mem.st64(dst, v as bigint); else if (kind === "f") mem.stf32(dst, v as number); else if (kind === "d") mem.stf64(dst, v as number);
        else if (kind === "s") mem.putCstr(dst, v as string);
        return 0;
      });
      fo.pos += utf8(text.slice(0, consumed)).length;
      if (r < 0) setFlag(fp, F_EOF);
      return r;
    },
    perror: (_c, a) => { const s = a.p(); logLine(6, "stderr", (s ? mem.cstr(s) + ": " : "") + "error"); },
  };
  M.__openat_2 = M.openat;
  scratch = mem.hostAlloc(16);
  const isStd = (fp: number) => fp >= sF && fp < sF + 3 * LAYOUT.FILE_SIZE;
  hostLib("libc.so", M);
}
