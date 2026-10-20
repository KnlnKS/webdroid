import { processExited } from "../process-exit.ts";
import { hostLib, PTR, ldp, ldLong, stLong, type HostFn } from "./host.ts";
import { clockTime, readTs, writeTs, wrapped, KLAYOUT } from "./kernel.ts";
import { mem } from "./mem.ts";
import { startThread } from "./pthread.ts";
import { E } from "./abi.ts";
import { cpuByOsTid, cpus, type Cpu } from "./cpu.ts";
import { blocked } from "./signals.ts";
import { clearGuestTimeout, setGuestTimeout, wallMillis, type GuestTimer } from "../guest-clock.ts";

/** a POSIX timer or a timerfd: its clock, next expiry and interval, in that clock's milliseconds */
export type ClockTimer = { clock: number; next: number; interval: number; timeout?: GuestTimer };
type Timer = ClockTimer & { overrun: number; notify: () => void };
const timers = new Map<number, Timer>();
let nextTimerId = 0;
/** struct sigevent: sigval, signo, notify, then a union of SIGEV_THREAD_ID's tid and (ARM32 libc's
 *  own) SIGEV_THREAD function and attributes */
const SIGEVENT = { signo: 0, notify: 4, union: 8 };
const SIGEV_SIGNAL = 0, SIGEV_NONE = 1, SIGEV_THREAD = 2, SIGEV_THREAD_ID = 4, SIGALRM = 14, SI_TIMER = -2;
/** fire(expirations) once the clock passes the next expiry, then wait for the one after */
export function armClockTimer(timer: ClockTimer, fire: (count: number) => void): void {
  disarmClockTimer(timer);
  if (!timer.next || processExited()) return;
  timer.timeout = setGuestTimeout(() => {
    if (processExited()) return;
    const now = clockTime(timer.clock);
    if (now >= timer.next) {
      const count = timer.interval ? Math.floor((now - timer.next) / timer.interval) + 1 : 1;
      timer.next = timer.interval ? timer.next + count * timer.interval : 0;
      fire(count);
    }
    armClockTimer(timer, fire);
  }, Math.max(0, timer.next - clockTime(timer.clock)));
}
export const disarmClockTimer = (timer: ClockTimer): void => clearGuestTimeout(timer.timeout);
const arm = (timer: Timer): void => armClockTimer(timer, (count) => { timer.overrun = Math.min(0x7fffffff, count - 1); timer.notify(); });
/** an itimerspec: the interval, then what remains until the next expiry */
export function timerState(timer: ClockTimer, out: number): void {
  writeTs(out, timer.interval); writeTs(out + KLAYOUT.TS_SIZE, timer.next ? Math.max(0, timer.next - clockTime(timer.clock)) : 0);
}
/** timer_settime and timerfd_settime: report the old itimerspec, then take the new one (flags bit 0 is
 *  TIMER_ABSTIME); false, with nothing changed, when it holds an invalid timespec */
export function setClockTimer(timer: ClockTimer, flags: number, value: number, old: number): boolean {
  if (!value || !validTime(value) || !validTime(value + KLAYOUT.TS_SIZE)) return false;
  const interval = readTs(value), first = readTs(value + KLAYOUT.TS_SIZE);
  if (old) timerState(timer, old);
  timer.interval = interval; timer.next = first ? first + (flags & 1 ? 0 : clockTime(timer.clock)) : 0;
  return true;
}
function validTime(p: number): boolean {
  const nanos = ldLong(p + PTR);
  return ldLong(p) >= 0 && nanos >= 0 && nanos < 1e9;
}
/** timer_create(2), and the HLE libc's, which runs SIGEV_THREAD's function on a thread of its own */
function createTimer(cpu: Cpu, clock: number, event: number, out: number, libcThreads: boolean): number {
  if (![0, 1, 7].includes(clock) || !out) return -E.INVAL;
  const id = nextTimerId, at = event + PTR;
  const mode = event ? mem.ld32(at + SIGEVENT.notify) : SIGEV_SIGNAL, sig = event ? mem.ld32(at + SIGEVENT.signo) : SIGALRM;
  const value = event ? BigInt(ldp(event)) : BigInt(id);
  let notify = () => {};
  if (mode === SIGEV_SIGNAL || mode === SIGEV_THREAD_ID) {
    if (sig < 1 || sig > 64) return -E.INVAL;
    const target = mode === SIGEV_THREAD_ID ? cpuByOsTid(mem.ld32(at + SIGEVENT.union)) : undefined;
    if (mode === SIGEV_THREAD_ID && (!target || target.pid !== cpu.pid)) return -E.INVAL;
    // a process-directed signal goes to a thread that does not block it
    const thread = (): Cpu => target ?? [...cpus].find((c) => !c.finished && !blocked(c.signalMask, sig)) ?? cpu;
    notify = () => thread().kill(sig, { code: SI_TIMER, addr: 0n, timer: { id, overrun: timer.overrun, value } });
  } else if (mode === SIGEV_THREAD && libcThreads) {
    const fn = ldp(at + SIGEVENT.union), attributes = ldp(at + SIGEVENT.union + PTR);
    if (!fn) return -E.INVAL;
    if (attributes) return -E.NOTSUP;
    notify = () => { startThread(cpu, fn, value, true); };
  } else if (mode !== SIGEV_NONE) return -E.INVAL;
  const timer: Timer = { clock, next: 0, interval: 0, overrun: 0, notify };
  timers.set(id, timer); nextTimerId++;
  mem.st32(out, id); return 0;
}
/** the kernel's clock and POSIX timer calls */
export const TIMER_SYSCALLS: Record<string, HostFn> = {
  timer_create: (cpu, a) => createTimer(cpu, a.i(), a.p(), a.p(), false),
  timer_settime: (_c, a) => {
    const timer = timers.get(a.i()), flags = a.i(), value = a.p(), old = a.p();
    if (!timer || flags & ~1 || !setClockTimer(timer, flags, value, old)) return -E.INVAL;
    timer.overrun = 0; arm(timer); return 0;
  },
  timer_gettime: (_c, a) => { const timer = timers.get(a.i()), out = a.p(); if (!timer || !out) return -E.INVAL; timerState(timer, out); return 0; },
  timer_getoverrun: (_c, a) => timers.get(a.i())?.overrun ?? -E.INVAL,
  gettimeofday: (_c, a) => { const tv = a.p(); if (tv) writeTs(tv, wallMillis(), 1e3); return 0; },
  clock_gettime: (_c, a) => { const id = a.i(); writeTs(a.p(), clockTime(id)); return 0; }, // MONOTONIC/BOOTTIME: never 0
  clock_getres: (_c, a) => { a.i(); const ts = a.p(); if (ts) { stLong(ts + KLAYOUT.TS_SEC, 0); stLong(ts + KLAYOUT.TS_NSEC, 1000); } return 0; },
  timer_delete: (_c, a) => { const id = a.i(), timer = timers.get(id); if (!timer) return -E.INVAL; disarmClockTimer(timer); timers.delete(id); return 0; },
};
export function timersInit(): void {
  hostLib("libc.so", { timer_create: wrapped((cpu, a) => createTimer(cpu, a.i(), a.p(), a.p(), true)) });
}
