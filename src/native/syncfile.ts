// Android's sync_file, the descriptor a native fence is: readable (POLLIN) once the work it stands for is done.
import { E, O_RDONLY, POLLIN } from "./abi.ts";
import { ANON, installFile, isKind, newFile, openFd, type FileOps } from "./fd.ts";
import { WaitQueue } from "./poll.ts";
import { mem } from "./mem.ts";
import { uptimeMillis } from "../guest-clock.ts";

/** whether some work is done, since when (CLOCK_MONOTONIC ms), and whoever waits for it */
export interface Fence { signaled: boolean; at: number; done: Promise<void>; wake: WaitQueue }
export function fence(work: Promise<unknown>): Fence {
  const f: Fence = { signaled: false, at: 0, wake: new WaitQueue(), done: Promise.resolve() };
  const settle = () => { f.signaled = true; f.at = uptimeMillis(); f.wake.wakeAll(); };
  f.done = work.then(settle, settle);
  return f;
}
const SYNC_FILE: FileOps<Fence> = {
  ...ANON,
  poll: (f, events) => events & POLLIN && f.state.signaled ? POLLIN : 0,
  watch: (f, wake) => f.state.wake.add(wake),
  // SYNC_IOC_MERGE with a struct sync_merge_data (name[32] fd2 fence flags pad): a new sync_file of both files' work.
  // SYNC_IOC_FILE_INFO into a struct sync_file_info (name[32] status flags num_fences pad sync_fence_info:u64): the file holds
  // one fence, whose struct sync_fence_info (obj_name[32] driver_name[32] status flags timestamp_ns:u64) goes where the caller asks
  ioctl(f, request, arg) {
    if (request >>> 0 === 0xc0303e03) {
      const other = fenceOf(mem.ld32(arg + 32));
      if (!other || mem.ld32(arg + 40) || mem.ld32(arg + 44)) return -E.INVAL;
      mem.st32(arg + 36, syncFileFd(fence(Promise.all([f.state.done, other.done]))));
      return 0;
    }
    if (request >>> 0 !== 0xc0383e04) return -E.NOTTY;
    if (mem.ld32(arg + 36) || mem.ld32(arg + 44)) return -E.INVAL;
    const status = +f.state.signaled, asked = mem.ld32(arg + 40) >>> 0;
    if (asked) {
      const out = Number(mem.ld64(arg + 48));
      mem.write(out, NAME); mem.write(out + 32, NAME);
      mem.st32(out + 64, status); mem.st32(out + 68, 0);
      mem.st64(out + 72, BigInt(Math.round(f.state.at * 1e6)));
    }
    mem.write(arg, NAME); mem.st32(arg + 32, status); mem.st32(arg + 40, 1);
    return 0;
  },
};
const NAME = new Uint8Array(32);
NAME.set(new TextEncoder().encode("webdroid"));
/** a descriptor, close-on-exec as the kernel makes it, on `f` */
export const syncFileFd = (f: Fence): number => installFile(newFile(SYNC_FILE, "sync_file", O_RDONLY, f), true);
/** the fence the sync_file `fd` names, or null for any other descriptor */
export function fenceOf(fd: number): Fence | null {
  const f = openFd(fd);
  return isKind(f, SYNC_FILE) ? f.state : null;
}
