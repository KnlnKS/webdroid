import { processExited } from "../process-exit.ts";
import { hostLib, PTR, ldp, stp, ldLong } from "./host.ts";
import { clockTime, fail, readTs, writeTs } from "./libc.ts";
import { KLAYOUT } from "./syscall.ts";
import { mem } from "./mem.ts";
import { startThread } from "./pthread.ts";
import { E } from "./abi.ts";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock.ts";

/** a POSIX timer or a timerfd: its clock, next expiry and interval, in that clock's milliseconds */
export type ClockTimer = { clock: number; next: number; interval: number; timeout?: GuestTimer };
type Timer = ClockTimer & { overrun: number; notify: () => void };
const timers = new Map<number, Timer>();
/** the ARM32 struct sigevent: sigval, signo, notify, then SIGEV_THREAD's function and attributes */
const SIGEVENT = { value: 0, notify: 8, function: 12, attributes: 16 };
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
export function timersInit(): void {
  hostLib("libc.so", {
    timer_create: (cpu, a) => {
      const clock = a.i(), event = a.p(), out = a.p();
      if (![0, 1, 7].includes(clock) || !out) return fail(cpu, E.INVAL);
      const mode = event ? mem.ld32(event + SIGEVENT.notify) : 0;
      if (mode !== 1 && mode !== 2) return fail(cpu, E.NOTSUP);
      let notify = () => {};
      if (mode === 2) {
        const fn = ldp(event + SIGEVENT.function), attributes = ldp(event + SIGEVENT.attributes);
        if (!fn) return fail(cpu, E.INVAL);
        if (attributes) return fail(cpu, E.NOTSUP);
        const arg = BigInt(mem.ld32(event + SIGEVENT.value) >>> 0);
        notify = () => { startThread(cpu, fn, arg, true); };
      }
      const id = mem.malloc(4); if (!id) return fail(cpu, E.NOMEM);
      timers.set(id, { clock, next: 0, interval: 0, overrun: 0, notify }); stp(out, id); return 0;
    },
    timer_settime: (cpu, a) => {
      const timer = timers.get(a.p()), flags = a.i(), value = a.p(), old = a.p();
      if (!timer || flags & ~1 || !setClockTimer(timer, flags, value, old)) return fail(cpu, E.INVAL);
      timer.overrun = 0; arm(timer); return 0;
    },
    timer_gettime: (cpu, a) => { const timer = timers.get(a.p()), out = a.p(); if (!timer || !out) return fail(cpu, E.INVAL); timerState(timer, out); return 0; },
    timer_getoverrun: (cpu, a) => timers.get(a.p())?.overrun ?? fail(cpu, E.INVAL),
    timer_delete: (cpu, a) => { const id = a.p(), timer = timers.get(id); if (!timer) return fail(cpu, E.INVAL); disarmClockTimer(timer); timers.delete(id); mem.free(id); return 0; },
  });
}
