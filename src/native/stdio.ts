// The ARM32 libc's stdio over the kernel's descriptor table (fs.ts): FILE structs live in guest
// memory (bionic's __sFILE) so the getc/putc macros and __srget refills work; then dirent
// streams, scandir, fts and the file calls only the libc wrappers have.

import { mem, wrote, anchor } from "./mem.ts";
import { hostLib, hostData, vaList, type HostFn, PTR, stp, ldp, stLong, ARG0, ptr, guestSort, complete } from "./host.ts";
import { E } from "./abi.ts";
import { utf8 as codec } from "../jvm/abi.ts";
import type { Cpu } from "./cpu.ts";
import { fail, utf8, logLine, scanSink } from "./libc.ts";
import { format, scan } from "./printf.ts";
import { KLAYOUT } from "./syscall.ts";
import { vfs, storageEstimate } from "../shell/vfs.ts";
import { FS_SYSCALLS, O_ACCMODE, O_APPEND, O_CREAT, O_EXCL, O_TRUNC, DIRENT64, openFd, fdOpenProcess as fdOpen, fdRead, fdWrite, fdCloseProcess as fdClose, fdSeekProcess as fdSeek, fdDup2,
  statProcess as statPath, accessProcess as accessPath, faccessatPath, renameProcess as renamePath, mkdirProcess as mkdirPath, removeProcess as removePath, mknodProcess, makePipe, truncateProcess as truncateFd, pread, pwrite, listProcess, fillStat, localStat, S_IFDIR, S_IFREG, inoOf } from "./fs.ts";
import { POLL_SYSCALLS, epollCreate } from "./poll.ts";
import { processAllocateFd } from "./process-fd.ts";

/** bionic's ARM32 __sFILE: the fields guest macros read */
const FILE = { flags: 12, file: 14, size: 84 };
/** struct dirent: linux_dirent64's fields, padded */
const DIRENT_SIZE = 276;
const files = new Map<number, number>();       // FILE* → fd
const pushback = new Map<number, number[]>();
const dirs = new Map<number, { entries: string[]; i: number; dirent: number }>();

/** mkstemp's contract: the six trailing X's become the name in place, and the file is created exclusively */
function fdTemp(cpu: Cpu, tpl: number, flags: number, dir: boolean): number | Promise<number> {
  const t = mem.cstr(tpl), destination = anchor(tpl);
  if (!t.endsWith("XXXXXX")) return fail(cpu, E.INVAL);
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const attempt = (count: number): number | Promise<number> => {
    if (count === 100) return fail(cpu,E.EXIST);
    let name = t.slice(0,-6);
    for (let i=0;i<6;i++) name += chars[(Math.random()*chars.length)|0];
    const pending = dir ? mkdirPath(cpu,name) : fdOpen(cpu,name,(flags & ~O_ACCMODE)|2|O_CREAT|O_EXCL);
    return complete(pending,result => { if(result>=0){mem.write(destination(),utf8(name));return result;}return attempt(count+1); });
  };
  return attempt(0);
}
/** _PC_LINK_MAX 0 … NAME_MAX 4, PATH_MAX 5, PIPE_BUF 6 */
const pathconfOf = (n: number) => (n === 4 ? 255 : n === 5 ? 4096 : n === 6 ? 4096 : n === 0 ? 127 : -1);
/** struct statvfs: the storage estimate in 4K blocks, as eleven unsigned longs (bsize, frsize, blocks, bfree, bavail,
 *  files, ffree, favail, fsid, flag, namemax) */
function fillStatvfs(b: number): Promise<number> {
  return storageEstimate().then(({ total, free }) => {
    [4096, 4096, total / 4096, free / 4096, free / 4096, 0x10000, 0x8000, 0x8000, 0, 0, 255].forEach((v, i) => stLong(b + i * PTR, Math.floor(v)));
    return 0;
  });
}

// ── FILE* layer: the struct is real (guest code inspects _flags/_file through macros), the
// buffering is ours (_r = _w = 0 so getc/putc always take the function path).
const F_EOF = 0x20, F_ERR = 0x40, F_RD = 4, F_WR = 8, F_RW = 0x10;
function newFile(fd: number, flags: number): number {
  const fp = mem.malloc(FILE.size);
  mem.memset(fp, 0, FILE.size);
  mem.st16(fp + FILE.flags, flags);
  mem.st16(fp + FILE.file, fd);
  files.set(fp, fd);
  return fp;
}
function fileFd(fp: number): number { return files.get(fp) ?? mem.ld16s(fp + FILE.file); }
function fileSeek(cpu: Cpu, fp: number, off: number, whence: number): number | Promise<number> {
  return complete(fdSeek(cpu,fileFd(fp),off-(whence===1 ? pushback.get(fp)?.length??0 : 0),whence),result => {
    if(result<0)return -1;
    pushback.delete(fp);mem.st16(fp+FILE.flags,mem.ld16u(fp+FILE.flags)&~F_EOF);return 0;
  });
}
function fileTell(cpu: Cpu, fp: number): number | Promise<number> {
  return complete(fdSeek(cpu,fileFd(fp),0,1),position => position<0 ? -1 : position-(pushback.get(fp)?.length??0));
}
function setFlag(fp: number, f: number): void { mem.st16(fp + FILE.flags, mem.ld16u(fp + FILE.flags) | f); }
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
  const f = openFd(fd);
  if (!f) { setFlag(fp, F_ERR); return -1; }
  const byte = f.byte ?? (f.byte = mem.hostAlloc(1));
  const done = (read: number) => {
    if (read <= 0) { setFlag(fp, read < 0 ? F_ERR : F_EOF); return -1; }
    return mem.u8[byte];
  };
  return complete(fdRead(cpu, fd, byte, 1), done);
}
function fwriteBytes(cpu: Cpu, fp: number, p: number, n: number): number | Promise<number> {
  return complete(fdWrite(cpu, fileFd(fp), p, n), written => { if (written < 0) { setFlag(fp,F_ERR); return 0; } return written; });
}
function fwriteStr(cpu: Cpu, fp: number, s: string): number | Promise<number> {
  const b = utf8(s);
  const tmp = mem.malloc(b.length + 1);
  mem.u8.set(b, tmp);
  const r = fwriteBytes(cpu, fp, tmp, b.length);
  mem.free(tmp);
  return complete(r, written => written < b.length ? -1 : b.length);
}
const chk = (cpu: Cpu, n: number, size: number, what: string) => { if (n > size) cpu.fault(`fortify: ${what} past the buffer`); };
function openDir(cpu: Cpu, path: string): number | Promise<number> {
  const open = (entries: string[] | number) => {
    if (typeof entries === "number") { fail(cpu, -entries); return 0; }
    const h = mem.malloc(16);
    dirs.set(h, { entries, i: 0, dirent: mem.malloc(DIRENT_SIZE) });
    return h;
  };
  return complete(listProcess(path), open);
}
function nextDirent(d: { entries: string[]; i: number }, de: number): number {
  const name = d.entries[d.i++];
  mem.memset(de, 0, DIRENT_SIZE);
  mem.st32(de + DIRENT64.ino, d.i); mem.st32(de + DIRENT64.off, d.i);
  mem.st16(de + DIRENT64.reclen, DIRENT_SIZE);
  mem.st8(de + DIRENT64.type, 8);
  mem.putCstr(de + DIRENT64.name, name, 256);
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
  const entry = mem.malloc(FTS.name + namelen + 1), pathp = mem.strdup(path), statp = mem.malloc(KLAYOUT.STAT_SIZE);
  walk.allocations.push(entry, pathp, statp);
  mem.memset(entry, 0, FTS.name + namelen + 1);
  stp(entry + FTS.parent, parent); stp(entry + FTS.accpath, pathp); stp(entry + FTS.path, pathp);
  mem.st32(entry + FTS.pathlen, pathlen); mem.st32(entry + FTS.namelen, namelen);
  mem.st32(entry + FTS.ino, inoOf(path)); mem.st32(entry + FTS.dev, 1); mem.st32(entry + FTS.nlink, 1);
  mem.st16(entry + FTS.level, level); mem.st16(entry + FTS.info, info); stp(entry + FTS.statp, statp);
  fillStat(statp, path, localStat(path, info === 1 || info === 6 ? S_IFDIR : S_IFREG, vfs.stat(path)?.size ?? 4096, Date.now()));
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
  if (compar) await guestSort(node.children, (x, y) => { stp(cell, x.pre); stp(cell + PTR, y.pre); return cpu.call(compar, [cell, cell + PTR]); });
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
  for (let p = argv, pathp; (pathp = ldp(p)); p += PTR) roots.push(ftsTree(walk, vfs.norm(mem.cstr(pathp)), 0, 0));
  if (!roots.length) { closeFts(handle); fail(cpu, E.INVAL); return 0; }
  const cell = mem.malloc(2 * PTR); walk.allocations.push(cell);
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
  // __sF[3]: stdin/stdout/stderr FILE structs, contiguous
  const sF = mem.hostAlloc(FILE.size * 3);
  mem.memset(sF, 0, FILE.size * 3);
  for (let i = 0; i < 3; i++) {
    const fp = sF + i * FILE.size;
    mem.st16(fp + FILE.flags, i === 0 ? F_RD : F_WR);
    mem.st16(fp + FILE.file, i);
    files.set(fp, i);
  }
  hostData("libc.so", "__sF", sF);
  const stdoutP = mem.hostAlloc(PTR); stp(stdoutP, sF + FILE.size); hostData("libc.so", "stdout", stdoutP);
  const stderrP = mem.hostAlloc(PTR); stp(stderrP, sF + 2 * FILE.size); hostData("libc.so", "stderr", stderrP);
  const stdinP = mem.hostAlloc(PTR); stp(stdinP, sF); hostData("libc.so", "stdin", stdinP);
  const stdoutFp = sF + FILE.size;

  const M: Record<string, HostFn> = {
    open: (cpu, a) => fdOpen(cpu, a.str(), a.i()),
    creat: (cpu, a) => fdOpen(cpu, a.str(), 1 | O_CREAT | O_TRUNC),
    mkstemp: (cpu, a) => fdTemp(cpu, a.p(), 0, false),
    mkostemp: (cpu, a) => fdTemp(cpu, a.p(), a.i(), false),
    mkdtemp: (cpu, a) => { const p = a.p(), destination = anchor(p); return complete(fdTemp(cpu,p,0,true),n => n < 0 ? 0 : destination()); },
    pread: (cpu, a) => pread(cpu, a.i(), a.p(), a.u(), a.i()),
    pwrite: (cpu, a) => pwrite(cpu, a.i(), a.p(), a.u(), a.i()),
    lseek64: (cpu, a) => complete(fdSeek(cpu,a.i(),Number(a.l()),a.i()),n => BigInt(n)),
    stat: (cpu, a) => statPath(cpu, a.str(), a.p()),
    access: (cpu, a) => accessPath(cpu, a.str(), a.i()),
    faccessat: (cpu, a) => faccessatPath(cpu, a.i(), a.str(), a.i(), a.i()),
    chmod: () => 0, chown: () => 0,
    unlink: (cpu, a) => removePath(cpu, a.str(), false),
    mkfifo: (cpu, a) => mknodProcess(cpu, a.str(), 0x1000 | a.i()),
    remove: (cpu, a) => removePath(cpu, a.str()),
    rename: (cpu, a) => renamePath(cpu, a.str(), a.str()),
    mkdir: (cpu, a) => mkdirPath(cpu, a.str()),
    rmdir: (cpu, a) => removePath(cpu, a.str(), true),
    ftruncate64: (cpu, a) => truncateFd(cpu, a.i(), Number(a.l())),
    // they report the error number itself
    posix_fallocate: (_c, a) => complete(processAllocateFd(a.i(), a.i(), a.i()), (r) => -r),
    posix_fallocate64: (_c, a) => complete(processAllocateFd(a.i(), Number(a.l()), Number(a.l())), (r) => -r),
    sync: () => {},
    dup2: (cpu, a) => fdDup2(cpu, a.i(), a.i()),
    pipe: (_c, a) => makePipe(a.p(), 0),
    epoll_create: () => epollCreate(false),
    epoll_wait: POLL_SYSCALLS.epoll_pwait,
    __read_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(); chk(cpu, n, a.u(), "read"); return fdRead(cpu, fd, p, n); },
    __write_chk: (cpu, a) => {
      const fd = a.i(), p = a.p(), n = a.va(), size = a.va();
      if (n > size || n > 0x7fffffffn) cpu.fault("fortify: write past the buffer");
      return fdWrite(cpu, fd, p, Number(n));
    },
    __pread64_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = Number(a.l()); chk(cpu, n, a.u(), "pread"); return pread(cpu, fd, p, n, off); },
    __pread_chk: (cpu, a) => { const fd = a.i(), p = a.p(), n = a.u(), off = a.i(); chk(cpu, n, a.u(), "pread"); return pread(cpu, fd, p, n, off); },
    futimens: () => 0,
    pathconf: (_c, a) => { a.str(); return pathconfOf(a.i()); },
    fpathconf: (_c, a) => { a.i(); return pathconfOf(a.i()); },
    statvfs: (_c, a) => { a.str(); return fillStatvfs(a.p()); },
    fstatvfs: (_c, a) => { a.i(); return fillStatvfs(a.p()); },
    statvfs64: (_c, a) => { a.str(); return fillStatvfs(a.p()); },
    fstatvfs64: (_c, a) => { a.i(); return fillStatvfs(a.p()); },
    isatty: () => 0,
    realpath: (_c, a) => { const p = vfs.norm(a.str()); let out = a.p(); if (!out) out = mem.malloc(4096); mem.putCstr(out, p, 4096); return ptr(out); },
    readlink: (cpu) => fail(cpu, E.INVAL),
    symlink: (cpu) => fail(cpu, E.PERM), link: (cpu) => fail(cpu, E.PERM),
    utimes: () => 0, utime: () => 0,

    opendir: (cpu, a) => openDir(cpu, a.str()),
    fdopendir: (cpu, a) => { const f = openFd(a.i()); if (!f || !f.dir) { fail(cpu, E.NOTDIR); return 0; } return openDir(cpu, f.path); },
    readdir: (_c, a) => { const d = dirs.get(a.p()); return d && d.i < d.entries.length ? nextDirent(d, d.dirent) : 0; },
    readdir_r: (_c, a) => { const d = dirs.get(a.p()), ent = a.p(), res = a.p(); stp(res, d && d.i < d.entries.length ? nextDirent(d, ent) : 0); return 0; },
    rewinddir: (_c, a) => { const d = dirs.get(a.p()); if (d) d.i = 0; },
    closedir: (_c, a) => { const h = a.p(); const d = dirs.get(h); if (d) { mem.free(d.dirent); mem.free(h); dirs.delete(h); return 0; } return -1; },
    dirfd: () => -1,
    // scandir(path, &namelist, filter, compar): every entry the filter keeps, each its own
    // malloc'd dirent, sorted by the guest's comparator (over dirent**) into a malloc'd array
    scandir: async (cpu, a) => {
      const path = a.str(), out = a.p(), filter = a.p(), compar = a.p(), entries = await listProcess(path);
      if (typeof entries === "number") return fail(cpu, -entries);
      const kept: number[] = [];
      for (const name of entries) {
        const de = mem.malloc(DIRENT_SIZE);
        nextDirent({ entries: [name], i: 0 }, de);
        if (filter && !(await cpu.call(filter, [de]))) { mem.free(de); continue; }
        kept.push(de);
      }
      if (compar && kept.length > 1) {
        const cell = mem.malloc(2 * PTR);
        try { await guestSort(kept, (x, y) => { stp(cell, x); stp(cell + PTR, y); return cpu.call(compar, [cell, cell + PTR]); }); } finally { mem.free(cell); }
      }
      const list = mem.malloc(Math.max(1, kept.length) * PTR);
      for (let i = 0; i < kept.length; i++) stp(list + i * PTR, kept[i]);
      stp(out, list);
      return kept.length;
    },
    alphasort: (_c, a) => { const x = mem.cstr(ldp(a.p()) + DIRENT64.name), y = mem.cstr(ldp(a.p()) + DIRENT64.name); return x < y ? -1 : x > y ? 1 : 0; },
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
      return complete(fdOpen(cpu,path,o),fd => fd<0 ? 0 : newFile(fd,f));
    },
    fdopen: (_c, a) => { const fd = a.i(), mode = a.str(); return openFd(fd) ? newFile(fd, modeFlags(mode).f) : 0; },
    freopen: (cpu, a) => {
      const path=a.str(),mode=a.str(),fp=a.p(),{o,f}=modeFlags(mode);pushback.delete(fp);
      return complete(fdClose(cpu,fileFd(fp)),()=>complete(fdOpen(cpu,path,o),fd => {
        if(fd<0)return 0;files.set(fp,fd);mem.st16(fp+FILE.file,fd);mem.st16(fp+FILE.flags,f);return fp;
      }));
    },
    tmpfile: (cpu) => { return complete(fdOpen(cpu, `/data/local/tmp/tmp${Date.now()}_${Math.floor(Math.random() * 1e6)}`, 2 | O_CREAT | O_TRUNC), fd => fd<0 ? 0 : newFile(fd,F_RW)); },
    fclose: (cpu, a) => { const fp = a.p(); pushback.delete(fp); const fd = fileFd(fp); const r = fdClose(cpu, fd); if (!isStd(fp)) { files.delete(fp); mem.free(fp); } return r; },
    fflush: (cpu, a) => { const fp = a.p(); return !fp || openFd(fileFd(fp)) ? 0 : fail(cpu, E.BADF); },
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
      return complete(fdRead(cpu, fileFd(fp), p + used, total - used), fin);
    },
    fwrite: (cpu, a) => { const p = a.p(), sz = a.u(), n = a.u(), fp = a.p(); const total = sz * n; if (!total) return 0; return complete(fwriteBytes(cpu, fp, p, total), written => Math.floor(written / sz)); },
    fseek: (cpu, a) => { const fp = a.p(), off = a.i(); return fileSeek(cpu, fp, off, a.i()); },
    ftell: (cpu, a) => fileTell(cpu, a.p()),
    rewind: (cpu, a) => { const fp = a.p(); return complete(fileSeek(cpu,fp,0,0),()=>{mem.st16(fp+FILE.flags,mem.ld16u(fp+FILE.flags)&~F_ERR);}); },
    fgetpos: (cpu, a) => { const fp=a.p(),destination=anchor(a.p());return complete(fileTell(cpu,fp),value => {if(value<0)return -1;stLong(destination(),value);return 0;}); },
    fsetpos: (cpu, a) => { const fp = a.p(), pos = a.p(); return fileSeek(cpu, fp, mem.ld32(pos), 0); },
    feof: (_c, a) => (mem.ld16u(a.p() + FILE.flags) & F_EOF ? 1 : 0),
    ferror: (_c, a) => (mem.ld16u(a.p() + FILE.flags) & F_ERR ? 1 : 0),
    clearerr: (_c, a) => { const fp = a.p(); mem.st16(fp + FILE.flags, mem.ld16u(fp + FILE.flags) & ~(F_EOF | F_ERR)); },
    fileno: (_c, a) => fileFd(a.p()),
    setvbuf: () => 0, setbuf: () => {}, setbuffer: () => {}, setlinebuf: () => {},
    fgetc: (cpu, a) => fgetc(cpu, a.p()),
    getchar: () => -1,
    ungetc: (_c, a) => {
      const c = a.i(), fp = a.p();
      if (c === -1 || !(mem.ld16u(fp + FILE.flags) & (F_RD | F_RW))) return -1;
      let pending = pushback.get(fp);
      if (!pending) pushback.set(fp, pending = []);
      pending.push(c & 255);
      mem.st16(fp + FILE.flags, mem.ld16u(fp + FILE.flags) & ~F_EOF);
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
    fputc: (cpu, a) => { const c = a.i() & 255, fp = a.p(); mem.u8[scratch] = c; return complete(fwriteBytes(cpu, fp, scratch, 1), n => n === 1 ? c : -1); },
    putchar: (cpu, a) => { const c = a.i() & 255; mem.u8[scratch] = c; return complete(fwriteBytes(cpu, stdoutFp, scratch, 1), n => n === 1 ? c : -1); },
    fputs: (cpu, a) => { const s = a.str(), fp = a.p(); return complete(fwriteStr(cpu, fp, s), n => n < 0 ? -1 : 0); },
    puts: (cpu, a) => fwriteStr(cpu, stdoutFp, a.str() + "\n"),
    fprintf: (cpu, a) => { const fp = a.p(), f = a.str(); return fwriteStr(cpu, fp, format(f, a)); },
    vfprintf: (cpu, a) => { const fp = a.p(), f = a.str(); return fwriteStr(cpu, fp, format(f, vaList(a.p()))); },
    printf: (cpu, a) => { const f = a.str(); return fwriteStr(cpu, stdoutFp, format(f, a)); },
    vprintf: (cpu, a) => { const f = a.str(); return fwriteStr(cpu, stdoutFp, format(f, vaList(a.p()))); },
    fscanf: (cpu, a) => {
      const fp = a.p(), f = a.str();
      const fd = fileFd(fp), fo = openFd(fd);
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
      const text = codec.dec.decode(data);
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
  for (const [alias, name] of [["__open_2", "open"], ["lstat", "stat"], ["fseeko", "fseek"], ["ftello", "ftell"], ["getc", "fgetc"], ["__srget", "fgetc"], ["putc", "fputc"], ["__swbuf", "fputc"]]) M[alias] = M[name];
  Object.assign(M, { __openat_2: FS_SYSCALLS.openat, stat64: M.stat, lstat64: M.stat, fstat64: FS_SYSCALLS.fstat, fstatat64: FS_SYSCALLS.fstatat });
  scratch = mem.hostAlloc(16);
  const isStd = (fp: number) => fp >= sF && fp < sF + 3 * FILE.size;
  hostLib("libc.so", M);
}
