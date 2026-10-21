// Readiness over any descriptors: poll(2), select(2) and epoll, over the answer and wakeup each
// open file's kind gives (fd.ts), and the guest-clock wait every blocking call shares (waitUntil).

import { mem, anchor } from "./mem.ts";
import { PTR, complete, type HostFn } from "./host.ts";
import { E, O_CLOEXEC, O_RDWR, POLLIN, POLLPRI, POLLOUT, POLLERR, POLLHUP, POLLNVAL } from "./abi.ts";
import { ANON, openFd, installFile, newFile, pollEvents, watchFd, type FileOps } from "./fd.ts";
import { readTimeout } from "./kernel.ts";
import { clearGuestTimeout, guestNow, setGuestTimeout, type GuestTimer } from "../guest-clock.ts";
import { parkTimeout, unparkTimeout } from "../jvm/yield.ts";

/** Wait on the guest clock until `subscribe`'s callback fires (subscribe answers its unsubscribe),
 *  `ms` pass (-1: forever) or `signal` aborts; true when woken. A `park` deadline is a thread's
 *  wait rather than scheduled work (timedParks). */
export function waitUntil(subscribe: (wake: () => void) => () => void, ms: number, signal?: AbortSignal, park = false): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false, unsubscribe: (() => void) | undefined, timer: GuestTimer | undefined;
    const finish = (woken: boolean) => {
      if (finished) return;
      finished = true;
      unsubscribe?.(); signal?.removeEventListener("abort", stop);
      if (park) unparkTimeout(timer); else clearGuestTimeout(timer);
      resolve(woken);
    };
    const stop = () => finish(false);
    unsubscribe = subscribe(() => finish(true));
    if (finished) return unsubscribe();
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    if (ms >= 0) timer = park ? parkTimeout(stop, ms) : setGuestTimeout(stop, ms);
  });
}
/** Callers waiting on one condition, each woken once: the first n in order, or everyone. */
export class WaitQueue {
  private waiters: (() => void)[] = [];
  get size(): number { return this.waiters.length; }
  /** call `wake` at its turn; answers how to stop waiting */
  add(wake: () => void): () => void {
    this.waiters.push(wake);
    return () => { const i = this.waiters.indexOf(wake); if (i >= 0) this.waiters.splice(i, 1); };
  }
  /** a thread's wait: true once woken, false once `ms` guest ms pass first (-1: no limit). `woken`
   *  runs at the wake itself, before any other thread does, as a lock's handoff must. */
  wait(ms = -1, woken?: () => void): Promise<boolean> {
    return waitUntil((wake) => this.add(woken ? () => { woken(); wake(); } : wake), ms, undefined, true);
  }
  /** wakes the first `n`, answering how many */
  wake(n = 1): number {
    let woken = 0;
    for (; woken < n && this.waiters.length; woken++) this.waiters.shift()!();
    return woken;
  }
  /** wakes everyone waiting now, not those a wake adds */
  wakeAll(): void {
    if (!this.waiters.length) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}
/** the guest milliseconds left before `deadline`, or -1 for a wait without one */
export const msLeft = (timeout: number, deadline: number): number => timeout < 0 ? -1 : Math.max(0, deadline - guestNow());

export interface PollEntry { fd: number; events: number; revents: number }
function scan(entries: PollEntry[]): number {
  let ready = 0;
  for (const e of entries) { e.revents = e.fd < 0 ? 0 : pollEvents(e.fd, e.events); if (e.revents) ready++; }
  return ready;
}
/** poll(2) over any descriptors: the number ready, once one is, `timeout` ms pass (-1: forever) or `signal` aborts */
export function pollEntries(entries: PollEntry[], timeout: number, signal?: AbortSignal): number | Promise<number> {
  const ready = scan(entries);
  return ready || timeout === 0 || signal?.aborted ? ready : pollWait(entries, timeout, signal);
}
async function pollWait(entries: PollEntry[], timeout: number, signal?: AbortSignal): Promise<number> {
  const deadline = guestNow() + timeout;
  const subscribe = (wake: () => void) => {
    const cleanups: (() => void)[] = [];
    for (const e of entries) if (e.fd >= 0) cleanups.push(watchFd(e.fd, wake));
    return () => { for (const cleanup of cleanups) cleanup(); };
  };
  // a wake can come of a change the entries do not ask for: wait out the rest
  for (;;) {
    const woken = await waitUntil(subscribe, msLeft(timeout, deadline), signal);
    const ready = scan(entries);
    if (ready || !woken) return ready;
  }
}

export function nativePoll(pollfds: number, count: number, timeout: number): number | Promise<number> {
  const entries: PollEntry[] = [];
  for (let i = 0; i < count; i++) entries.push({ fd: mem.ld32(pollfds + i * 8), events: mem.ld16u(pollfds + i * 8 + 4), revents: 0 });
  const target = anchor(pollfds);
  const land = (n: number) => {
    const at = target();
    for (let i = 0; i < count; i++) mem.st16(at + i * 8 + 6, entries[i].revents);
    return n;
  };
  return complete(pollEntries(entries, timeout), land);
}

const FD_SETSIZE = 1024;
const fdIsSet = (set: number, fd: number): boolean => !!set && !!(mem.u8[set + (fd >>> 3)] & (1 << (fd & 7)));
const setFd = (set: number, fd: number): void => { mem.st8(set + (fd >>> 3), mem.u8[set + (fd >>> 3)] | (1 << (fd & 7))); };
/** select(2) over fd_sets, sharing readiness and wakeups with poll(2), waiting `ms` (-1: until one is ready) */
export function nativeSelect(count: number, readSet: number, writeSet: number, exceptSet: number, ms: number): number | Promise<number> {
  if (count < 0 || count > FD_SETSIZE) return -E.INVAL;
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
    if (entries.some((e) => e.revents & POLLNVAL)) return -E.BADF;
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
  return complete(pollEntries(entries, ms), finish);
}

// ── epoll: an open file of watched descriptors, each entry woken through the descriptor's watch
const EPOLLET = 0x80000000, EPOLLONESHOT = 0x40000000;
interface EpollEntry { events: number; data: bigint; pending: number; disabled: boolean; cancel: () => void }
export interface Epoll { entries: Map<number, EpollEntry>; wake: Set<() => void> }
const EPOLL: FileOps = {
  ...ANON,
  poll: () => 0,
  close(f) { const ep = f.epoll!; for (const e of ep.entries.values()) e.cancel(); for (const wake of ep.wake) wake(); },
};
export function epollCreate(cloexec: boolean): number {
  const f = newFile(EPOLL, "epoll", O_RDWR);
  f.epoll = { entries: new Map(), wake: new Set() };
  return installFile(f, cloexec);
}
function epollWatch(ep: Epoll, fd: number, events: number, data: bigint): EpollEntry {
  const entry: EpollEntry = { events, data, pending: pollEvents(fd, events), disabled: false, cancel: () => {} };
  let active = true, remove = () => {};
  const watch = () => {
    if (!active) return;
    remove = watchFd(fd, () => {
      remove();
      entry.pending |= pollEvents(fd, entry.events);
      for (const wake of ep.wake) wake();
      // at once: a change before a deferred re-arm would find no watcher, and its edge would be lost
      watch();
    });
  };
  entry.cancel = () => { active = false; remove(); };
  watch();
  return entry;
}
async function epollWait(epfd: number, events: bigint, max: number, timeout: number): Promise<number> {
  const ep = openFd(epfd)?.epoll, deadline = guestNow() + timeout;
  if (!ep) return -E.BADF;
  if (max <= 0) return -E.INVAL;
  const subscribe = (wake: () => void) => { ep.wake.add(wake); return () => { ep.wake.delete(wake); }; };
  for (let woken = true; ;) {
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
    if (n || timeout === 0 || !woken) return n;
    woken = await waitUntil(subscribe, msLeft(timeout, deadline));
    if (openFd(epfd)?.epoll !== ep) return -E.BADF;
  }
}

export const POLL_SYSCALLS: Record<string, HostFn> = {
  epoll_create1: (_c, a) => {
    const flags = a.i();
    if (flags & ~O_CLOEXEC) return -E.INVAL;
    return epollCreate(!!flags);
  },
  epoll_ctl: (_c, a) => {
    const epfd = a.i(), ep = openFd(epfd)?.epoll, op = a.i(), fd = a.i(), ev = a.p();
    if (fd === epfd) return -E.INVAL;
    if (!ep || !openFd(fd)) return -E.BADF;
    const old = ep.entries.get(fd);
    if (op === 1 && old) return -E.EXIST;
    if ((op === 2 || op === 3) && !old) return -E.NOENT;
    if (op < 1 || op > 3) return -E.INVAL;
    old?.cancel();
    if (op === 2) ep.entries.delete(fd); else ep.entries.set(fd, epollWatch(ep, fd, mem.ld32(ev), mem.ld64(ev + 8)));
    for (const wake of ep.wake) wake();
    return 0;
  },
  // their sigmasks are left as they are
  epoll_pwait: (_c, a) => epollWait(a.i(), a.va(), a.i(), a.i()),
  pselect6: (_c, a) => { const n = a.i(), r = a.p(), w = a.p(), x = a.p(); return nativeSelect(n, r, w, x, readTimeout(a.p())); },
  ppoll: (_c, a) => { const fds = a.p(), n = a.u(); return nativePoll(fds, n, readTimeout(a.p())); },
};
