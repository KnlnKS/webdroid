// Pipes and named pipes (fifos): the byte queue a pipe2 pair, or every open of one fifo, shares.
import { mem } from "./mem.ts";
import { vfs, type VfsFile } from "../shell/vfs.ts";

/** a pipe: byte chunks, whoever is parked waiting for them (a reader, or an epoll_wait), and its
 *  open write ends, the last of which closing is its readers' end of file. `closed` also stands for
 *  a reader gone (or shut down), which a writer meets as EPIPE. A fifo's (`named`) outlives its descriptors;
 *  `holder` is the process its opens reach (holdFifo). */
export interface Pipe { q: Uint8Array[]; wake: (() => void)[]; writers: number; closed: boolean; named?: boolean; holder?: number }
export const newPipe = (writers: number): Pipe => ({ q: [], wake: [], writers, closed: false });
const namedPipe = (): Pipe => ({ ...newPipe(0), named: true });
export function wakeAll(p: { wake: (() => void)[] }): void { for (const w of p.wake.splice(0)) w(); }
/** up to `n` bytes a pipe holds, into guest memory at `p` */
export function takePipe(pipe: Pipe, p: number, n: number): number {
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

/** named pipes (mkfifo) in this process, by the file that names them: every open shares the one
 *  pipe, which goes with its file; Realm's interprocess condition variables signal through them */
const fifos = new WeakMap<VfsFile, Pipe>();
/** this process's pipes for fifos another realm names, by path; that realm lets one process open each */
const remoteFifos = new Map<string, Pipe>();
/** names the free normalized path `p` a fifo: volatile, as a fifo that outlived a reload would come back a regular file */
export function nameFifo(p: string): void {
  vfs.markVolatile(p);
  vfs.write(p, new Uint8Array(0));
  fifos.set(vfs.open(p)!, namedPipe());
}
export const fifoOf = (file: VfsFile | null | undefined): Pipe | undefined => file ? fifos.get(file) : undefined;
export const isFifo = (path: string): boolean => !!fifoOf(vfs.open(path));
/** Whether process `pid` (0: this realm's own opens) may open `fifo`, which it then holds. A fifo's bytes stay in the
 *  realm of the process that opened it, so an open from another process would reach a pipe nobody else does: it is
 *  refused (ENXIO, as an open finding no reader) until the holder dies. */
export const holdFifo = (fifo: Pipe, pid: number): boolean => (fifo.holder ??= pid) === pid;
/** this process's pipe for a fifo the owning realm names */
export function remoteFifo(path: string): Pipe {
  let fifo = remoteFifos.get(path);
  if (!fifo) remoteFifos.set(path, fifo = namedPipe());
  return fifo;
}
/** the owning realm renamed (`to`) or removed (null) a name: this process's pipe for it follows */
export function moveRemoteFifo(from: string, to: string | null): void {
  const fifo = remoteFifos.get(from);
  remoteFifos.delete(from);
  if (to === null) return;
  if (fifo) remoteFifos.set(to, fifo); else remoteFifos.delete(to);
}
