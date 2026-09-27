import { hasProcessExited } from "./cpu";
import { hostLib, PTR, ldp, stp } from "./host";
import { clockTime, fail, LAYOUT, readTs, writeTs } from "./libc";
import { mem } from "./mem";
import { startThread } from "./pthread";
import { E } from "./abi";

/** a POSIX timer or a timerfd: its clock, next expiry and interval, in that clock's milliseconds */
export type ClockTimer = { clock: number; next: number; interval: number; timeout?: ReturnType<typeof setTimeout> };
type Timer = ClockTimer & { overrun: number; notify: () => void };
const timers = new Map<number, Timer>();
/** fire(expirations) once the clock passes the next expiry, then wait for the one after */
export function armClockTimer(timer: ClockTimer, fire: (count: number) => void): void {
  clearTimeout(timer.timeout);
  if (!timer.next || hasProcessExited()) return;
  timer.timeout = setTimeout(() => {
    if (hasProcessExited()) return;
    const now = clockTime(timer.clock);
    if (now >= timer.next) {
      const count = timer.interval ? Math.floor((now - timer.next) / timer.interval) + 1 : 1;
      timer.next = timer.interval ? timer.next + count * timer.interval : 0;
      fire(count);
    }
    armClockTimer(timer, fire);
  }, Math.min(0x7fffffff, Math.max(0, timer.next - clockTime(timer.clock))));
}
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
      const mode = event ? mem.ld32(event + PTR + 4) : 0;
      if (mode !== 1 && mode !== 2) return fail(cpu, E.NOTSUP);
      let notify = () => {};
      if (mode === 2) {
        const fn = ldp(event + PTR + 8), attributes = ldp(event + PTR * 2 + 8);
        if (!fn) return fail(cpu, E.INVAL);
        if (attributes) return fail(cpu, E.NOTSUP);
        const arg = PTR === 8 ? mem.ld64(event) : BigInt(mem.ld32(event) >>> 0);
        notify = () => { startThread(cpu, fn, arg, true); };
      }
      const id = mem.malloc(PTR); if (!id) return fail(cpu, E.NOMEM);
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
    timer_delete: (cpu, a) => { const id = a.p(), timer = timers.get(id); if (!timer) return fail(cpu, E.INVAL); clearTimeout(timer.timeout); timers.delete(id); mem.free(id); return 0; },
  });
}
