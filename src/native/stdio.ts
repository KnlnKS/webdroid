// stdio + the fd table over the JVM vfs: FILE structs live in guest memory (bionic __sFILE layout)
// so the getc/putc macros and __srget refills work; /proc/cpuinfo and /proc/meminfo are synthesized.

import { mem } from "./mem";
import { hostLib, hostData, vaList, type HostFn, PTR, stp } from "./host";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { LAYOUT, fail, utf8, logLine, readTs, offArg } from "./libc";
import { format, scan } from "./printf";
import { vfs } from "../jvm/natives/jio";
import { device } from "../shell/config";

const O_ACCMODE = 3, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_APPEND = 0x400, O_DIRECTORY = 0x4000;
const S_IFDIR = 0x4000, S_IFREG = 0x8000;
const u8 = mem.u8;

/** a pipe: byte chunks, and whoever is parked waiting for them (a reader, or an epoll_wait) */
interface Pipe { q: Uint8Array[]; wake: (() => void)[]; closed: boolean }
interface Fd {
  path: string; data: Uint8Array; len: number; pos: number; write: boolean; dirty: boolean; dir: boolean; append: boolean; line?: string; synthetic?: boolean;
  nonblock?: boolean; rpipe?: Pipe; wpipe?: Pipe; event?: { count: number; wake: (() => void)[] }; epoll?: Map<number, { events: number; data: bigint }>;
}
const EPOLLIN = 1, EAGAIN = E.AGAIN;
const newPipe = (): Pipe => ({ q: [], wake: [], closed: false });
const ready = (f: Fd): boolean => !!(f.rpipe && (f.rpipe.q.length || f.rpipe.closed)) || !!(f.event && f.event.count > 0);
function wakeAll(p: { wake: (() => void)[] }): void { for (const w of p.wake.splice(0)) w(); }
/** the fd's interest in being woken: pipe readers and epoll waiters both park here */
function waitOn(f: Fd, w: () => void): void { if (f.rpipe) f.rpipe.wake.push(w); else if (f.event) f.event.wake.push(w); }
const fdBase = (path: string): Fd => ({ path, data: new Uint8Array(0), len: 0, pos: 0, write: false, dirty: false, dir: false, append: false });
const fds = new Map<number, Fd>();
let nextFd = 3;
const files = new Map<number, number>();       // FILE* → fd
const dirs = new Map<number, { entries: string[]; i: number; dirent: number }>();

function synth(path: string): string | null {
  if (path === "/proc/cpuinfo") {
    let s = "";
    for (let i = 0; i < device.cpu.cores; i++) s += `processor\t: ${i}\nmodel name\t: ARMv7 Processor rev 0 (v7l)\nBogoMIPS\t: 38.40\nFeatures\t: ${device.cpu.features}\nCPU implementer\t: 0x41\nCPU architecture: 7\nCPU variant\t: 0x0\nCPU part\t: 0xc07\nCPU revision\t: 0\n\n`;
    return s + `Hardware\t: ${device.cpu.hardware}\nRevision\t: 0000\nSerial\t\t: 0000000000000000\n`;
  }
  if (path === "/proc/meminfo") return `MemTotal:        ${device.cpu.memKb} kB\nMemFree:         ${device.cpu.memKb >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n`;
  if (path === "/proc/self/maps" || path === "/proc/self/cmdline") return "";
  return null;
}

function fdOpen(cpu: Cpu, path: string, flags: number): number {
  path = vfs.norm(path);
  const s = synth(path);
  if (s !== null) { const b = utf8(s); return put({ path, data: b, len: b.length, pos: 0, write: false, dirty: false, dir: false, append: false, synthetic: true }); }
  const acc = flags & O_ACCMODE;
  if (vfs.isDir(path)) {
    if (acc !== 0) return fail(cpu, E.ISDIR);
    return put({ path, data: new Uint8Array(0), len: 0, pos: 0, write: false, dirty: false, dir: true, append: false });
  }
  if (flags & O_DIRECTORY) return fail(cpu, E.NOTDIR);
  let data = vfs.read(path);
  if (!data) {
    if (!(flags & O_CREAT)) return fail(cpu, E.NOENT);
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    if (!vfs.isDir(parent)) return fail(cpu, E.NOENT);
    data = new Uint8Array(0);
    vfs.write(path, data);
  } else if (flags & O_CREAT && flags & O_EXCL) return fail(cpu, E.EXIST);
  if (flags & O_TRUNC && acc !== 0) { data = new Uint8Array(0); vfs.write(path, data); }
  return put({ path, data, len: data.length, pos: 0, write: acc !== 0, dirty: false, dir: false, append: !!(flags & O_APPEND) });
}
function put(f: Fd): number { const fd = nextFd++; fds.set(fd, f); return fd; }

function grow(f: Fd, need: number): void {
  if (need <= f.data.length) return;
  const n = new Uint8Array(Math.max(need, f.data.length * 2, 4096));
  n.set(f.data.subarray(0, f.len));
  f.data = n;
}
function fdWrite(cpu: Cpu, fd: number, p: number, n: number): number {
  if (fd === 1 || fd === 2) {
    const s = new TextDecoder().decode(u8.subarray(p, p + n));
    const f = fds.get(fd)!;
    f.line = (f.line ?? "") + s;
    let i: number;
    while ((i = f.line.indexOf("\n")) >= 0) { logLine(fd === 2 ? 6 : 4, fd === 2 ? "stderr" : "stdout", f.line.slice(0, i)); f.line = f.line.slice(i + 1); }
    return n;
  }
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.wpipe) { f.wpipe.q.push(u8.slice(p, p + n)); wakeAll(f.wpipe); return n; }
  if (f.event) { f.event.count += mem.ld32(p); wakeAll(f.event); return 8; }
  if (!f.write) return fail(cpu, E.BADF);
  if (f.append) f.pos = f.len;
  grow(f, f.pos + n);
  f.data.set(u8.subarray(p, p + n), f.pos);
  f.pos += n;
  if (f.pos > f.len) f.len = f.pos;
  f.dirty = true;
  return n;
}
function fdRead(cpu: Cpu, fd: number, p: number, n: number): number | Promise<number> {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  if (f.dir) return fail(cpu, E.ISDIR);
  if (f.rpipe || f.event) {
    if (!ready(f)) {
      if (f.rpipe?.closed) return 0;
      if (f.nonblock) return fail(cpu, EAGAIN);
      return new Promise<void>((r) => waitOn(f, r)).then(() => fdRead(cpu, fd, p, n));
    }
    if (f.event) { const c = f.event.count; f.event.count = 0; mem.st32(p, c); mem.st32(p + 4, 0); return 8; }
    const q = f.rpipe!.q;
    let k = 0;
    while (k < n && q.length) { const c = q[0], take = Math.min(n - k, c.length); u8.set(c.subarray(0, take), p + k); k += take; if (take === c.length) q.shift(); else q[0] = c.subarray(take); }
    return k;
  }
  const k = Math.max(0, Math.min(n, f.len - f.pos));
  if (k > 0) u8.set(f.data.subarray(f.pos, f.pos + k), p);
  f.pos += k;
  return k;
}
function flushFd(f: Fd): void {
  if (f.dirty && !f.synthetic) { vfs.write(f.path, f.data.slice(0, f.len)); f.dirty = false; }
}
function fdClose(cpu: Cpu, fd: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  flushFd(f);
  if (f.wpipe) { f.wpipe.closed = true; wakeAll(f.wpipe); }
  if (fd > 2) fds.delete(fd);
  return 0;
}
function fdSeek(cpu: Cpu, fd: number, off: number, whence: number): number {
  const f = fds.get(fd);
  if (!f) return fail(cpu, E.BADF);
  const np = whence === 0 ? off : whence === 1 ? f.pos + off : f.len + off;
  if (np < 0) return fail(cpu, E.INVAL);
  f.pos = np;
  return np;
}
function fillStat(buf: number, isDir: boolean, size: number, mtimeMs: number): void {
  mem.memset(buf, 0, LAYOUT.STAT_SIZE);
  mem.st32(buf + LAYOUT.ST_MODE, (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644));
  mem.st32(buf + LAYOUT.ST_NLINK, 1);
  mem.st32(buf + LAYOUT.ST_UID, 10123); mem.st32(buf + LAYOUT.ST_GID, 10123);
  mem.st32(buf + LAYOUT.ST_SIZE, size); mem.st32(buf + LAYOUT.ST_SIZE + 4, 0);
  mem.st32(buf + LAYOUT.ST_BLKSIZE, 4096);
  mem.st32(buf + LAYOUT.ST_BLOCKS, (size + 511) >> 9);
  const sec = Math.floor(mtimeMs / 1000);
  for (const o of [LAYOUT.ST_ATIME, LAYOUT.ST_MTIME, LAYOUT.ST_CTIME]) stp(buf + o, sec);
  mem.st32(buf + LAYOUT.ST_INO32, 1); mem.st32(buf + LAYOUT.ST_INO, 1);
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
  mem.st32(out, put({ ...fdBase("pipe"), rpipe: p, nonblock: nb }));
  mem.st32(out + 4, put({ ...fdBase("pipe"), wpipe: p, nonblock: nb, write: true }));
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
  }).then(() => epollWait(cpu, epfd, events, max, 0));
}
function statPath(cpu: Cpu, path: string, buf: number): number {
  path = vfs.norm(path);
  const s = synth(path);
  if (s !== null) { fillStat(buf, false, utf8(s).length, Date.now()); return 0; }
  if (vfs.isDir(path)) { fillStat(buf, true, 4096, Date.now()); return 0; }
  const d = vfs.read(path);
  if (!d) return fail(cpu, E.NOENT);
  fillStat(buf, false, d.length, Date.now());
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
function fgetc(_cpu: Cpu, fp: number): number {
  const fd = fileFd(fp);
  const f = fds.get(fd);
  if (!f) { setFlag(fp, F_ERR); return -1; }
  if (f.pos >= f.len) { setFlag(fp, F_EOF); return -1; }
  return f.data[f.pos++];
}
function fwriteBytes(cpu: Cpu, fp: number, p: number, n: number): number {
  const r = fdWrite(cpu, fileFd(fp), p, n);
  if (r < 0) { setFlag(fp, F_ERR); return 0; }
  return r;
}
function fwriteStr(cpu: Cpu, fp: number, s: string): number {
  const b = utf8(s);
  const tmp = mem.malloc(b.length + 1);
  u8.set(b, tmp);
  const r = fwriteBytes(cpu, fp, tmp, b.length);
  mem.free(tmp);
  return r < b.length ? -1 : b.length;
}

export function stdioInit(): void {
  fds.set(0, { path: "/dev/stdin", data: new Uint8Array(0), len: 0, pos: 0, write: false, dirty: false, dir: false, append: false });
  fds.set(1, { path: "/dev/stdout", data: new Uint8Array(0), len: 0, pos: 0, write: true, dirty: false, dir: false, append: false });
  fds.set(2, { path: "/dev/stderr", data: new Uint8Array(0), len: 0, pos: 0, write: true, dirty: false, dir: false, append: false });
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
    openat: (cpu, a) => { a.i(); return fdOpen(cpu, a.str(), a.i()); },
    creat: (cpu, a) => fdOpen(cpu, a.str(), 1 | O_CREAT | O_TRUNC),
    close: (cpu, a) => fdClose(cpu, a.i()),
    read: (cpu, a) => fdRead(cpu, a.i(), a.p(), a.u()),
    write: (cpu, a) => fdWrite(cpu, a.i(), a.p(), a.u()),
    pread: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdRead(cpu, fd, p, n); f.pos = save; return r; },
    pwrite: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdWrite(cpu, fd, p, n); f.pos = save; return r; },
    pread64: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdRead(cpu, fd, p, n); f.pos = save; return r; },
    pwrite64: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdWrite(cpu, fd, p, n); f.pos = save; return r; },
    lseek: (cpu, a) => (PTR === 8 ? BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())) : fdSeek(cpu, a.i(), a.i(), a.i())),
    lseek64: (cpu, a) => BigInt(fdSeek(cpu, a.i(), Number(a.l()), a.i())),
    fstat: (cpu, a) => { const fd = a.i(), buf = a.p(); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); fillStat(buf, f.dir, f.len, Date.now()); return 0; },
    stat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    lstat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    access: (cpu, a) => { const p = a.str(); a.i(); return vfs.exists(p) || vfs.isDir(p) || synth(vfs.norm(p)) !== null ? 0 : fail(cpu, E.NOENT); },
    chmod: () => 0, fchmod: () => 0, chown: () => 0, fchown: () => 0, umask: () => 0o22,
    unlink: (cpu, a) => (vfs.delete(a.str()) ? 0 : fail(cpu, E.NOENT)),
    remove: (cpu, a) => { const p = vfs.norm(a.str()); if (vfs.isDir(p)) return vfs.list(p).length ? fail(cpu, E.NOTEMPTY) : 0; return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    rename: (cpu, a) => { const from = vfs.norm(a.str()), to = vfs.norm(a.str()); const d = vfs.read(from); if (!d) return fail(cpu, E.NOENT); vfs.write(to, d); vfs.delete(from); return 0; },
    mkdir: (cpu, a) => { const p = vfs.norm(a.str()); if (vfs.exists(p) || vfs.isDir(p)) return fail(cpu, E.EXIST); const parent = p.slice(0, p.lastIndexOf("/")) || "/"; if (parent !== "/" && !vfs.isDir(parent)) return fail(cpu, E.NOENT); vfs.mkdir(p); return 0; },
    rmdir: (cpu, a) => { const p = vfs.norm(a.str()); if (!vfs.isDir(p)) return fail(cpu, E.NOTDIR); if (vfs.list(p).length) return fail(cpu, E.NOTEMPTY); vfs.rmdir(p); return 0; },
    ftruncate: (cpu, a) => { const f = fds.get(a.i()); const n = offArg(a); if (!f) return fail(cpu, E.BADF); grow(f, n); if (n > f.len) f.data.fill(0, f.len, n); f.len = n; f.dirty = true; return 0; },
    ftruncate64: (cpu, a) => { const f = fds.get(a.i()); const n = Number(a.l()); if (!f) return fail(cpu, E.BADF); grow(f, n); if (n > f.len) f.data.fill(0, f.len, n); f.len = n; f.dirty = true; return 0; },
    truncate: (cpu, a) => { const p = vfs.norm(a.str()), n = offArg(a); const d = vfs.read(p); if (!d) return fail(cpu, E.NOENT); const nd = new Uint8Array(n); nd.set(d.subarray(0, Math.min(n, d.length))); vfs.write(p, nd); return 0; },
    fcntl: (cpu, a) => { const fd = a.i(), cmd = a.i(); if (!fds.has(fd)) return fail(cpu, E.BADF); return cmd === 3 ? 2 : 0; }, // F_GETFL → O_RDWR
    fsync: () => 0, fdatasync: () => 0, sync: () => {},
    dup: (cpu, a) => { const f = fds.get(a.i()); if (!f) return fail(cpu, E.BADF); return put({ ...f }); },
    dup2: (cpu, a) => { const f = fds.get(a.i()), to = a.i(); if (!f) return fail(cpu, E.BADF); fds.set(to, { ...f }); return to; },
    pipe: (_c, a) => makePipe(a.p(), 0),
    pipe2: (_c, a) => makePipe(a.p(), a.i()),
    socketpair: (_c, a) => {
      a.i(); const type = a.i(); a.i(); const sv = a.p();
      const ab = newPipe(), ba = newPipe(), nb = !!(type & 0x800);
      mem.st32(sv, put({ ...fdBase("socketpair"), rpipe: ab, wpipe: ba, nonblock: nb }));
      mem.st32(sv + 4, put({ ...fdBase("socketpair"), rpipe: ba, wpipe: ab, nonblock: nb }));
      return 0;
    },
    eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return put({ ...fdBase("eventfd"), event: { count: init, wake: [] }, nonblock: !!(flags & 0x800) }); },
    epoll_create: () => put({ ...fdBase("epoll"), epoll: new Map() }),
    epoll_create1: () => put({ ...fdBase("epoll"), epoll: new Map() }),
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
    __pread64_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); if (n > a.u()) cpu.fault("fortify: pread past the buffer"); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdRead(cpu, fd, p, n); f.pos = save; return r; },
    __pread_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = offArg(a); if (n > a.u()) cpu.fault("fortify: pread past the buffer"); const f = fds.get(fd); if (!f) return fail(cpu, E.BADF); const save = f.pos; f.pos = off; const r = fdRead(cpu, fd, p, n); f.pos = save; return r; },
    flock: () => 0,
    unlinkat: (cpu, a) => { a.i(); const p = a.str(), flags = a.i(); if (flags & 0x200) { const d = vfs.norm(p); if (!vfs.isDir(d)) return fail(cpu, E.NOTDIR); vfs.rmdir(d); return 0; } return vfs.delete(p) ? 0 : fail(cpu, E.NOENT); },
    fchmodat: () => 0, utimensat: () => 0, futimens: () => 0,
    pathconf: (_c, a) => { a.str(); return pathconfOf(a.i()); },
    fpathconf: (_c, a) => { a.i(); return pathconfOf(a.i()); },
    statvfs: (_c, a) => { a.str(); fillStatvfs(a.p()); return 0; },
    fstatvfs: (_c, a) => { a.i(); fillStatvfs(a.p()); return 0; },
    isatty: () => 0,
    ioctl: (cpu) => fail(cpu, E.NOSYS),
    select: (_c, a) => {
      // no descriptor we hand out ever becomes readable: a timed select is a sleep, an untimed one blocks forever
      a.i(); a.p(); a.p(); a.p(); const tv = a.p();
      if (!tv) return new Promise<never>(() => {});
      const ms = readTs(tv, 1e3);
      return ms > 0 ? new Promise<number>((r) => setTimeout(() => r(0), ms)) : Promise.resolve(0);
    },
    statfs: (_c, a) => { a.str(); fillStatfs(a.p()); return 0; },
    fstatfs: (_c, a) => { a.i(); fillStatfs(a.p()); return 0; },
    getcwd: (_c, a) => { const b = a.p(), n = a.u(); mem.putCstr(b, "/", n); return b; },
    chdir: () => 0,
    realpath: (_c, a) => { const p = vfs.norm(a.str()); let out = a.p(); if (!out) out = mem.malloc(4096); mem.putCstr(out, p, 4096); return out; },
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
      const r = fdRead(cpu, fileFd(fp), p, total);
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
    ungetc: (_c, a) => { const c = a.i(), fp = a.p(); const f = fds.get(fileFd(fp)); if (!f || f.pos === 0) return -1; f.pos--; if (f.data[f.pos] !== c && !f.synthetic) { f.data[f.pos] = c; } return c; },
    fgets: (cpu, a) => {
      const buf = a.p(), n = a.i(), fp = a.p();
      if (n <= 0) return 0;
      let i = 0;
      while (i < n - 1) {
        const c = fgetc(cpu, fp);
        if (c < 0) break;
        u8[buf + i++] = c;
        if (c === 10) break;
      }
      if (i === 0) return 0;
      u8[buf + i] = 0;
      return buf;
    },
    fputc: (cpu, a) => { const c = a.i() & 255, fp = a.p(); u8[scratch] = c; return fwriteBytes(cpu, fp, scratch, 1) === 1 ? c : -1; },
    putc: (cpu, a) => { const c = a.i() & 255, fp = a.p(); u8[scratch] = c; return fwriteBytes(cpu, fp, scratch, 1) === 1 ? c : -1; },
    __swbuf: (cpu, a) => { const c = a.i() & 255, fp = a.p(); u8[scratch] = c; return fwriteBytes(cpu, fp, scratch, 1) === 1 ? c : -1; },
    putchar: (cpu, a) => { const c = a.i() & 255; u8[scratch] = c; return fwriteBytes(cpu, stdoutFp, scratch, 1) === 1 ? c : -1; },
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
  const scratch = mem.hostAlloc(16);
  const isStd = (fp: number) => fp >= sF && fp < sF + 3 * LAYOUT.FILE_SIZE;
  hostLib("libc.so", M);
}
