import { hasProcessExited } from "./cpu";
import { hostLib, PTR, ldp, stp } from "./host";
import { clockTime, fail, LAYOUT, readTs, writeTs } from "./libc";
import { mem } from "./mem";
import { startThread } from "./pthread";
import { E } from "./abi";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock";

/** a POSIX timer or a timerfd: its clock, next expiry and interval, in that clock's milliseconds */
export type ClockTimer = { clock: number; next: number; interval: number; timeout?: GuestTimer };
type Timer = ClockTimer & { overrun: number; notify: () => void };
const timers = new Map<number, Timer>();
/** the ARM32 struct sigevent: sigval, signo, notify, then SIGEV_THREAD's function and attributes */
const SIGEVENT = { value: 0, notify: 8, function: 12, attributes: 16 };
/** fire(expirations) once the clock passes the next expiry, then wait for the one after */
export function armClockTimer(timer: ClockTimer, fire: (count: number) => void): void {
  disarmClockTimer(timer);
  if (!timer.next || hasProcessExited()) return;
  timer.timeout = setGuestTimeout(() => {
    if (hasProcessExited()) return;
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
  writeTs(out, timer.interval); writeTs(out + LAYOUT.TS_SIZE, timer.next ? Math.max(0, timer.next - clockTime(timer.clock)) : 0);
}
export function validTime(p: number): boolean {
  const seconds = PTR === 8 ? mem.ld64(p) : BigInt(mem.ld32(p) | 0);
  const nanos = PTR === 8 ? mem.ld64(p + 8) : BigInt(mem.ld32(p + 4) | 0);
  return seconds >= 0n && nanos >= 0n && nanos < 1000000000n;
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
      if (!timer || !value || flags & ~1 || !validTime(value) || !validTime(value + LAYOUT.TS_SIZE)) return fail(cpu, E.INVAL);
      const interval = readTs(value), first = readTs(value + LAYOUT.TS_SIZE);
      if (old) timerState(timer, old);
      timer.interval = interval; timer.next = first ? first + (flags & 1 ? 0 : clockTime(timer.clock)) : 0;
      timer.overrun = 0; arm(timer); return 0;
    },
    timer_gettime: (cpu, a) => { const timer = timers.get(a.p()), out = a.p(); if (!timer || !out) return fail(cpu, E.INVAL); timerState(timer, out); return 0; },
    timer_getoverrun: (cpu, a) => timers.get(a.p())?.overrun ?? fail(cpu, E.INVAL),
    timer_delete: (cpu, a) => { const id = a.p(), timer = timers.get(id); if (!timer) return fail(cpu, E.INVAL); disarmClockTimer(timer); timers.delete(id); mem.free(id); return 0; },
  });
}
