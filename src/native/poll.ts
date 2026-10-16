// Readiness over any descriptors: poll(2), select(2) and epoll, over the answer and wakeup fs.ts
// gives for each descriptor.

import { mem, anchor } from "./mem.ts";
import { PTR, type HostFn } from "./host.ts";
import { E } from "./abi.ts";
import type { Cpu } from "./cpu.ts";
import { fail } from "./libc.ts";
import { openFd, installFile, fdBase, pollEvents, watchFd, O_CLOEXEC, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL } from "./fs.ts";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock.ts";

export interface PollEntry { fd: number; events: number; revents: number }
/** poll(2) over any descriptors: the number ready, once one is or `timeout` ms pass (-1: forever) */
export function pollEntries(entries: PollEntry[], timeout: number, signal?: AbortSignal): number | Promise<number> {
  const scan = () => {
    let ready = 0;
    for (const e of entries) { e.revents = e.fd < 0 ? 0 : pollEvents(e.fd, e.events); if (e.revents) ready++; }
    return ready;
  };
  const immediate = scan();
  if (immediate || timeout === 0 || signal?.aborted) return immediate;
  return new Promise<number>((resolve) => {
    let finished = false, timer: GuestTimer | undefined;
    const cleanups: (() => void)[] = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups) cleanup();
      clearGuestTimeout(timer);
      resolve(scan());
    };
    for (const e of entries) if (e.fd >= 0) cleanups.push(watchFd(e.fd, finish));
    if (signal) { signal.addEventListener("abort", finish, { once: true }); cleanups.push(() => signal.removeEventListener("abort", finish)); }
    if (timeout >= 0) timer = setGuestTimeout(finish, timeout);
  });
}

export function nativePoll(_cpu: Cpu, pollfds: number, count: number, timeout: number, signal?: AbortSignal): number | Promise<number> {
  const entries: PollEntry[] = [];
  for (let i = 0; i < count; i++) entries.push({ fd: mem.ld32(pollfds + i * 8), events: mem.ld16u(pollfds + i * 8 + 4), revents: 0 });
  const target = anchor(pollfds);
  const land = (n: number) => {
    const at = target();
    for (let i = 0; i < count; i++) mem.st16(at + i * 8 + 6, entries[i].revents);
    return n;
  };
  const n = pollEntries(entries, timeout, signal);
  return n instanceof Promise ? n.then(land) : land(n);
}

const FD_SETSIZE = 1024;
const fdIsSet = (set: number, fd: number): boolean => !!set && !!(mem.u8[set + (fd >>> 3)] & (1 << (fd & 7)));
const setFd = (set: number, fd: number): void => { mem.st8(set + (fd >>> 3), mem.u8[set + (fd >>> 3)] | (1 << (fd & 7))); };
/** select(2) over fd_sets, sharing readiness and wakeups with poll(2), waiting `ms` (-1: until one is ready) */
export function nativeSelect(cpu: Cpu, count: number, readSet: number, writeSet: number, exceptSet: number, ms: number): number | Promise<number> {
  if (count < 0 || count > FD_SETSIZE) return fail(cpu, E.INVAL);
  const setBytes = Math.ceil(count / (PTR * 8)) * PTR;
  const entries: PollEntry[] = [];
  for (let fd = 0; fd < count; fd++) {
    let events = 0;
    if (fdIsSet(readSet, fd)) events |= POLLIN;
    if (fdIsSet(writeSet, fd)) events |= POLLOUT;
    if (fdIsSet(exceptSet, fd)) events |= POLLPRI;
    if (events) entries.push({ fd, events, revents: 0 });
  }
  const anchored = [readSet, writeSet, exceptSet].map(anchor);
  const finish = (): number => {
    if (entries.some((e) => e.revents & POLLNVAL)) return fail(cpu, E.BADF);
    const sets = anchored.map((set) => set());
    for (const set of sets) if (set && setBytes) mem.memset(set, 0, setBytes);
    let ready = 0;
    for (const { fd, events, revents } of entries) {
      if (sets[0] && events & POLLIN && revents & (POLLIN | POLLERR | POLLHUP)) { setFd(sets[0], fd); ready++; }
      if (sets[1] && events & POLLOUT && revents & (POLLOUT | POLLERR)) { setFd(sets[1], fd); ready++; }
      if (sets[2] && events & POLLPRI && revents & POLLPRI) { setFd(sets[2], fd); ready++; }
    }
    return ready;
  };
  const result = pollEntries(entries, ms);
  return result instanceof Promise ? result.then(finish) : finish();
}

// ── epoll: an open file of watched descriptors, each entry woken through the descriptor's watch
const EPOLLET = 0x80000000, EPOLLONESHOT = 0x40000000;
interface EpollEntry { events: number; data: bigint; pending: number; disabled: boolean; cancel: () => void }
export interface Epoll { entries: Map<number, EpollEntry>; wake: Set<() => void> }
export const epollCreate = (cloexec: boolean): number => installFile({ ...fdBase("epoll"), epoll: { entries: new Map(), wake: new Set() }, statusFlags: 2 }, cloexec);
function epollWatch(ep: Epoll, fd: number, events: number, data: bigint): EpollEntry {
  const entry: EpollEntry = { events, data, pending: pollEvents(fd, events), disabled: false, cancel: () => {} };
  let active = true, remove = () => {};
  const watch = () => {
    if (!active) return;
    remove = watchFd(fd, () => {
      remove();
      entry.pending |= pollEvents(fd, entry.events);
      for (const wake of ep.wake) wake();
      queueMicrotask(watch);
    });
  };
  entry.cancel = () => { active = false; remove(); };
  watch();
  return entry;
}
async function epollWait(cpu: Cpu, epfd: number, events: bigint, max: number, timeout: number): Promise<number> {
  const ep = openFd(epfd)?.epoll, deadline = performance.now() + timeout;
  if (!ep) return fail(cpu, E.BADF);
  if (max <= 0) return fail(cpu, E.INVAL);
  for (;;) {
    let n = 0;
    for (const [fd, e] of ep.entries) {
      if (!openFd(fd)) { e.cancel(); ep.entries.delete(fd); continue; }
      if (e.disabled) continue;
      const ready = pollEvents(fd, e.events) & (e.events & EPOLLET ? e.pending : -1);
      if (!ready || n === max) continue;
      const out = mem.txVa(events) + n++ * 16;
      mem.st32(out, ready); mem.st64(out + 8, e.data);
      e.pending &= ~ready;
      if (e.events & EPOLLONESHOT) e.disabled = true;
    }
    if (n || timeout === 0) return n;
    const remaining = deadline - performance.now();
    if (timeout > 0 && remaining <= 0) return 0;
    await new Promise<void>((resolve) => {
      const done = () => { ep.wake.delete(done); clearTimeout(timer); resolve(); };
      const timer = timeout < 0 ? undefined : setTimeout(done, remaining);
      ep.wake.add(done);
    });
    if (openFd(epfd)?.epoll !== ep) return fail(cpu, E.BADF);
  }
}

export const POLL_SYSCALLS: Record<string, HostFn> = {
  epoll_create1: (cpu, a) => {
    const flags = a.i();
    if (flags & ~O_CLOEXEC) return fail(cpu, E.INVAL);
    return epollCreate(!!flags);
  },
  epoll_ctl: (cpu, a) => {
    const epfd = a.i(), ep = openFd(epfd)?.epoll, op = a.i(), fd = a.i(), ev = a.p();
    if (fd === epfd) return fail(cpu, E.INVAL);
    if (!ep || !openFd(fd)) return fail(cpu, E.BADF);
    const old = ep.entries.get(fd);
    if (op === 1 && old) return fail(cpu, E.EXIST);
    if ((op === 2 || op === 3) && !old) return fail(cpu, E.NOENT);
    if (op < 1 || op > 3) return fail(cpu, E.INVAL);
    old?.cancel();
    if (op === 2) ep.entries.delete(fd); else ep.entries.set(fd, epollWatch(ep, fd, mem.ld32(ev), mem.ld64(ev + 8)));
    for (const wake of ep.wake) wake();
    return 0;
  },
  // its sigmask is left as is
  epoll_pwait: (cpu, a) => epollWait(cpu, a.i(), a.va(), a.i(), a.i()),
};
