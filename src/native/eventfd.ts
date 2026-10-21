// eventfd(2) and timerfd_create(2): a 64-bit counter that writes, or a timer's expirations, add to
// and a read takes whole.
import { E, O_CLOEXEC, O_NONBLOCK, O_RDWR, POLLIN, POLLOUT } from "./abi.ts";
import { ANON, installFile, isKind, newFile, openFd, type FileOps } from "./fd.ts";
import { WaitQueue } from "./poll.ts";
import { armClockTimer, disarmClockTimer, setClockTimer, timerState, type ClockTimer } from "./timers.ts";
import type { HostFn } from "./host.ts";

/** a counter, and whoever waits for it to rise */
export interface Counter { count: number; wake: WaitQueue }
const u32At = (b: Uint8Array, i: number): number => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;

const EVENTFD: FileOps<Counter> = {
  ...ANON,
  read(f, target, at, n) {
    const counter = f.state, count = counter.count;
    if (n < 8) return -E.INVAL;
    if (!count) return -E.AGAIN;
    const low = count % 0x1_0000_0000, high = (count - low) / 0x1_0000_0000;
    target[at] = low; target[at + 1] = low >>> 8; target[at + 2] = low >>> 16; target[at + 3] = low >>> 24;
    target[at + 4] = high; target[at + 5] = high >>> 8; target[at + 6] = high >>> 16; target[at + 7] = high >>> 24;
    counter.count = 0;
    return 8;
  },
  write(f, bytes) {
    if (bytes.length < 8) return -E.INVAL;
    f.state.count += u32At(bytes, 0) + u32At(bytes, 4) * 0x1_0000_0000;
    f.state.wake.wakeAll();
    return 8;
  },
  poll: (f, events) => (events & POLLIN && f.state.count > 0 ? POLLIN : 0) | (events & POLLOUT),
  watch: (f, wake) => f.state.wake.add(wake),
};
/** a timerfd's counter, which its timer's expirations add to */
type TimerCounter = Counter & { timer: ClockTimer };
const TIMERFD: FileOps<TimerCounter> = {
  ...EVENTFD,
  write: () => -E.INVAL,
  poll: (f, events) => events & POLLIN && f.state.count > 0 ? POLLIN : 0,
  close: (f) => disarmClockTimer(f.state.timer),
};
const flagsOf = (flags: number) => O_RDWR | (flags & O_NONBLOCK);
/** the timerfd `fd` names, or EBADF, or EINVAL for another open file */
function timerfdOf(fd: number): TimerCounter | number {
  const f = openFd(fd);
  return isKind(f, TIMERFD) ? f.state : f ? -E.INVAL : -E.BADF;
}

export const EVENTFD_SYSCALLS: Record<string, HostFn> = {
  eventfd: (_c, a) => { const init = a.u(), flags = a.i(); return installFile(newFile(EVENTFD, "eventfd", flagsOf(flags), { count: init, wake: new WaitQueue() }), !!(flags & O_CLOEXEC)); },
  timerfd_create: (_c, a) => {
    const clock = a.i(), flags = a.i();
    if (![0, 1, 7].includes(clock) || flags & ~(O_NONBLOCK | O_CLOEXEC)) return -E.INVAL;
    return installFile(newFile(TIMERFD, "timerfd", flagsOf(flags), { count: 0, wake: new WaitQueue(), timer: { clock, next: 0, interval: 0 } }), !!(flags & O_CLOEXEC));
  },
  timerfd_settime: (_c, a) => {
    const counter = timerfdOf(a.i()), flags = a.i(), value = a.p(), old = a.p();
    if (typeof counter === "number") return counter;
    if (flags & ~1 || !setClockTimer(counter.timer, flags, value, old)) return -E.INVAL;
    counter.count = 0;
    armClockTimer(counter.timer, (count) => { counter.count += count; counter.wake.wakeAll(); });
    return 0;
  },
  timerfd_gettime: (_c, a) => {
    const counter = timerfdOf(a.i()), out = a.p();
    if (typeof counter === "number") return counter;
    timerState(counter.timer, out);
    return 0;
  },
};
