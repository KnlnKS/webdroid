// Pipes and named pipes (fifos): the byte queue a pipe2 pair, or every open of one fifo, shares.
import { E, O_ACCMODE, O_CLOEXEC, O_NONBLOCK, O_RDONLY, O_WRONLY, POLLERR, POLLHUP, POLLIN, POLLOUT, S_IFIFO } from "./abi.ts";
import { ANON, installFile, newFile, type FileOps, type OpenFile } from "./fd.ts";
import { vfs, type VfsFile } from "../shell/vfs.ts";
import { WaitQueue } from "./poll.ts";
import { changeOpenFile, openFileStat } from "../shell/file-path.ts";

/** a pipe: byte chunks, whoever is parked waiting for them (a reader, or an epoll_wait), and its
 *  open write ends, the last of which closing is its readers' end of file. `closed` also stands for
 *  a reader gone (or shut down), which a writer meets as EPIPE. A fifo's (`named`) outlives its descriptors;
 *  `holder` is the process its opens reach (holdFifo). */
export interface Pipe { q: Uint8Array[]; wake: WaitQueue; writers: number; closed: boolean; named?: boolean; holder?: number }
export const newPipe = (writers: number): Pipe => ({ q: [], wake: new WaitQueue(), writers, closed: false });
const namedPipe = (): Pipe => ({ ...newPipe(0), named: true });
export const queued = (pipe: Pipe): number => pipe.q.reduce((n, b) => n + b.length, 0);
/** poll(2) on a pipe's read end */
export function readable(pipe: Pipe, events: number): number {
  return (events & POLLIN && (pipe.q.length || pipe.closed) ? POLLIN : 0) | (pipe.closed ? POLLHUP : 0);
}
/** the ends of a pipe an open file holds, as its access mode says */
type Ends = { read: Pipe | null; write: Pipe | null };

/** a pipe's ends: its read end reads (an empty pipe waits until its writers are gone), its write end writes */
const PIPE: FileOps<Ends> = {
  ...ANON,
  mode: S_IFIFO | 0o600,
  read(f, target, at, n) {
    const pipe = f.state.read!, q = pipe.q;
    if (!q.length) return pipe.closed ? 0 : -E.AGAIN;
    let k = 0;
    while (k < n && q.length) {
      const c = q[0], take = Math.min(n - k, c.length);
      target.set(take === c.length ? c : c.subarray(0, take), at + k);
      k += take;
      if (take === c.length) q.shift(); else q[0] = c.subarray(take);
    }
    return k;
  },
  write(f, bytes) {
    const pipe = f.state.write!;
    if (pipe.closed) return -E.PIPE;
    pipe.q.push(bytes.slice());
    pipe.wake.wakeAll();
    return bytes.length;
  },
  poll(f, events) {
    const { read, write } = f.state;
    return (read ? readable(read, events) : 0) | (write ? write.closed ? POLLERR : events & POLLOUT : 0);
  },
  watch: (f, wake) => f.state.read ? f.state.read.wake.add(wake) : ANON.watch(f, wake),
  available: (f) => queued(f.state.read ?? f.state.write!),
  stat: (f) => openFileStat(f.content.path, S_IFIFO | 0o600, f.content.len, f.content.attributes),
  change: (f, change, uid) => changeOpenFile(f.content.path, change, uid),
  close(f) {
    const { read, write } = f.state;
    if (write && !--write.writers) { write.closed = true; write.wake.wakeAll(); }
    // a pipe nobody reads: its writers meet EPIPE (a fifo's outlives its descriptors)
    if (read && !read.named) read.closed = true;
  },
};
/** an open file on `pipe` with `statusFlags`, reading or writing it as its access mode says */
function pipeFile(path: string, pipe: Pipe, statusFlags: number, content?: VfsFile): OpenFile<Ends> {
  const access = statusFlags & O_ACCMODE;
  return newFile(PIPE, path, statusFlags, { read: access !== O_WRONLY ? pipe : null, write: access !== O_RDONLY ? pipe : null }, content);
}
/** pipe2(2): the read end, then the write end */
export function javaPipeFds(flags: number): [number, number] {
  const pipe = newPipe(1), nonblock = flags & O_NONBLOCK, cloexec = !!(flags & O_CLOEXEC);
  return [installFile(pipeFile("pipe", pipe, O_RDONLY | nonblock), cloexec), installFile(pipeFile("pipe", pipe, O_WRONLY | nonblock), cloexec)];
}

/** named pipes (mkfifo) in this process, by the file that names them: every open shares the one
 *  pipe, which goes with its file; Realm's interprocess condition variables signal through them */
const fifos = new WeakMap<VfsFile, Pipe>();
/** this process's pipes for fifos another realm names, by path; that realm lets one process open each */
const remoteFifos = new Map<string, Pipe>();
/** names the free normalized path `p` a fifo: volatile, as a fifo that outlived a reload would come back a regular file */
export function nameFifo(p: string): void {
  vfs.write(p, new Uint8Array(0), false);
  vfs.markVolatile(p);
  fifos.set(vfs.open(p)!, namedPipe());
}
export const fifoOf = (file: VfsFile | null | undefined): Pipe | undefined => file ? fifos.get(file) : undefined;
export const isFifo = (path: string): boolean => !!fifoOf(vfs.open(path));
/** Whether process `pid` (0: this realm's own opens) may open `fifo`, which it then holds. A fifo's bytes stay in the
 *  realm of the process that opened it, so an open from another process would reach a pipe nobody else does: it is
 *  refused (ENXIO, as an open finding no reader) until the holder dies. */
export const holdFifo = (fifo: Pipe, pid: number): boolean => (fifo.holder ??= pid) === pid;
/** an open of the fifo named by `content`, with open(2)'s `flags` */
export function openFifo(path: string, fifo: Pipe, flags: number, content?: VfsFile): number {
  if (flags & O_ACCMODE) { fifo.writers++; fifo.closed = false; }
  return installFile(pipeFile(path, fifo, flags & (O_ACCMODE | O_NONBLOCK), content), !!(flags & O_CLOEXEC));
}
/** an open of this process's pipe for a fifo the owning realm names */
export function openRemoteFifo(path: string, flags: number): number {
  let fifo = remoteFifos.get(path);
  if (!fifo) remoteFifos.set(path, fifo = namedPipe());
  return openFifo(path, fifo, flags);
}
/** the owning realm renamed (`to`) or removed (null) a name: this process's pipe for it follows */
export function moveRemoteFifo(from: string, to: string | null): void {
  const fifo = remoteFifos.get(from);
  remoteFifos.delete(from);
  if (to === null) return;
  if (fifo) remoteFifos.set(to, fifo); else remoteFifos.delete(to);
}
