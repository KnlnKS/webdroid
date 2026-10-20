// eventfd(2) and timerfd_create(2): a 64-bit counter that writes, or a timer's expirations, add to
// and a read takes whole.
import { E, O_CLOEXEC, O_NONBLOCK, O_RDWR, POLLIN, POLLOUT } from "./abi.ts";
import { ANON, installFile, newFile, openFd, type FileOps, type OpenFile } from "./fd.ts";
import { waitIn, wakeAll } from "./pipe.ts";
import { armClockTimer, disarmClockTimer, setClockTimer, timerState } from "./timers.ts";
import type { HostFn } from "./host.ts";

/** a counter, and whoever waits for it to rise */
export interface Counter { count: number; wake: (() => void)[] }
const u32At = (b: Uint8Array, i: number): number => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;

const EVENTFD: FileOps = {
  ...ANON,
  read(f, target) {
    const counter = f.event!, count = counter.count;
    if (target.length < 8) return -E.INVAL;
    if (!count) return -E.AGAIN;
    const low = count % 0x1_0000_0000, high = (count - low) / 0x1_0000_0000;
    target[0] = low; target[1] = low >>> 8; target[2] = low >>> 16; target[3] = low >>> 24;
    target[4] = high; target[5] = high >>> 8; target[6] = high >>> 16; target[7] = high >>> 24;
    counter.count = 0;
    return 8;
  },
  write(f, bytes) {
    if (bytes.length < 8) return -E.INVAL;
    f.event!.count += u32At(bytes, 0) + u32At(bytes, 4) * 0x1_0000_0000;
    wakeAll(f.event!);
    return 8;
  },
  poll: (f, events) => (events & POLLIN && f.event!.count > 0 ? POLLIN : 0) | (events & POLLOUT),
  watch: (f, wake) => waitIn(f.event!.wake, wake),
};
const TIMERFD: FileOps = {
  ...EVENTFD,
  write: () => -E.INVAL,
  poll: (f, events) => events & POLLIN && f.event!.count > 0 ? POLLIN : 0,
  close: (f) => disarmClockTimer(f.timer!),
};
function counterFile(ops: FileOps, path: string, count: number, flags: number): OpenFile {
  const f = newFile(ops, path, O_RDWR | (flags & O_NONBLOCK));
  f.event = { count, wake: [] };
  return f;
}

export const EVENTFD_SYSCALLS: Record<string, HostFn> = {
  eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return installFile(counterFile(EVENTFD, "eventfd", init, flags), !!(flags & O_CLOEXEC)); },
  timerfd_create: (_c, a) => {
    const clock = a.i(), flags = a.i();
    if (![0, 1, 7].includes(clock) || flags & ~(O_NONBLOCK | O_CLOEXEC)) return -E.INVAL;
    const f = counterFile(TIMERFD, "timerfd", 0, flags);
    f.timer = { clock, next: 0, interval: 0 };
    return installFile(f, !!(flags & O_CLOEXEC));
  },
  timerfd_settime: (_c, a) => {
    const fd = a.i(), flags = a.i(), value = a.p(), old = a.p(), f = openFd(fd);
    if (!f) return -E.BADF;
    if (f.ops !== TIMERFD || flags & ~1 || !setClockTimer(f.timer!, flags, value, old)) return -E.INVAL;
    const counter = f.event!;
    counter.count = 0;
    armClockTimer(f.timer!, (count) => { counter.count += count; wakeAll(counter); });
    return 0;
  },
  timerfd_gettime: (_c, a) => {
    const fd = a.i(), out = a.p(), f = openFd(fd);
    if (!f) return -E.BADF;
    if (f.ops !== TIMERFD) return -E.INVAL;
    timerState(f.timer!, out);
    return 0;
  },
};
