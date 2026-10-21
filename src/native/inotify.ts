// inotify(7): the VFS's changes, as events queued whole for each inotify descriptor watching them.
import { E, O_CLOEXEC } from "./abi.ts";
import { ANON, installFile, isKind, newFile, openFd, type FileOps } from "./fd.ts";
import { newPipe, queued, readable, type Pipe } from "./pipe.ts";
import { vfs } from "../shell/vfs.ts";
import { utf8 } from "../jvm/abi.ts";
import type { HostFn } from "./host.ts";

/** an inotify instance's watches, and the pipe its events queue on */
export interface Inotify { watches: Map<number, { path: string; mask: number; dir: boolean }>; nextWd: number; pipe: Pipe }
const IN_MODIFY = 0x2, IN_CLOSE_WRITE = 0x8, IN_CREATE = 0x100, IN_DELETE = 0x200, IN_DELETE_SELF = 0x400, IN_IGNORED = 0x8000;
const IN_NONBLOCK = 0x800, IN_CLOEXEC = 0x80000, IN_MASK_ADD = 0x20000000, IN_ONLYDIR = 0x01000000;
const inotifies = new Set<Inotify>();

function inotifyEvent(state: Inotify, wd: number, mask: number, name = ""): void {
  const bytes = name ? utf8.enc.encode(name + "\0") : new Uint8Array(0);
  const len = (bytes.length + 3) & ~3, event = new Uint8Array(16 + len);
  const view = new DataView(event.buffer);
  view.setInt32(0, wd, true); view.setUint32(4, mask, true); view.setUint32(12, len, true);
  event.set(bytes, 16);
  state.pipe.q.push(event);
  state.pipe.wake.wakeAll();
}
function notifyInotify(path: string, mask: number, parentMask = mask): void {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/", name = path.slice(path.lastIndexOf("/") + 1);
  for (const state of inotifies) for (const [wd, watch] of state.watches) {
    const direct = watch.path === path, child = watch.dir && watch.path === parent;
    const eventMask = direct ? mask : child ? parentMask : 0;
    if (eventMask & watch.mask) inotifyEvent(state, wd, eventMask & watch.mask, child ? name : "");
  }
}
/** the last close of a file open for writing */
export const closedWrite = (path: string): void => notifyInotify(path, IN_CLOSE_WRITE);
let hooked = false;
/** the VFS's changes reach the watches from now on */
export function hookInotify(): void {
  if (hooked) return;
  vfs.watch((path, change) => {
    if (change === "write") { notifyInotify(path, IN_MODIFY); notifyInotify(path, IN_CLOSE_WRITE); }
    else if (change === "create") notifyInotify(path, IN_CREATE, IN_CREATE);
    else if (change === "delete") notifyInotify(path, IN_DELETE_SELF, IN_DELETE);
    else notifyInotify(path, IN_MODIFY);
  });
  hooked = true;
}

/** an inotify descriptor reads whole events, as many as fit */
const INOTIFY: FileOps<Inotify> = {
  ...ANON,
  read(f, target, at, n) {
    const pipe = f.state.pipe, q = pipe.q;
    if (!q.length) return pipe.closed ? 0 : -E.AGAIN;
    if (n < q[0].length) return -E.INVAL;
    let done = 0;
    while (q.length && done + q[0].length <= n) {
      const event = q.shift()!;
      target.set(event, at + done);
      done += event.length;
    }
    return done;
  },
  poll: (f, events) => readable(f.state.pipe, events),
  watch: (f, wake) => f.state.pipe.wake.add(wake),
  available: (f) => queued(f.state.pipe),
  close(f) { inotifies.delete(f.state); f.state.pipe.closed = true; f.state.pipe.wake.wakeAll(); },
};
/** the inotify instance `fd` names, or EBADF, or EINVAL for another open file */
function inotifyOf(fd: number): Inotify | number {
  const f = openFd(fd);
  return isKind(f, INOTIFY) ? f.state : f ? -E.INVAL : -E.BADF;
}
function makeInotify(flags: number): number {
  if (flags & ~(IN_NONBLOCK | IN_CLOEXEC)) return -E.INVAL;
  const pipe = newPipe(0), state: Inotify = { watches: new Map(), nextWd: 1, pipe };
  inotifies.add(state);
  return installFile(newFile(INOTIFY, "inotify", flags & IN_NONBLOCK, state), !!(flags & O_CLOEXEC));
}
export function javaInotifyAddWatch(fd: number, name: string, mask: number): number {
  const path = vfs.norm(name), state = inotifyOf(fd);
  if (typeof state === "number") return state;
  if (!vfs.exists(path)) return -E.NOENT;
  const dir = vfs.isDir(path);
  if (mask & IN_ONLYDIR && !dir) return -E.NOTDIR;
  const events = mask & ~(IN_MASK_ADD | IN_ONLYDIR);
  for (const [wd, watch] of state.watches) if (watch.path === path) {
    watch.mask = mask & IN_MASK_ADD ? watch.mask | events : events;
    return wd;
  }
  const wd = state.nextWd++;
  state.watches.set(wd, { path, mask: events, dir });
  return wd;
}
export function javaInotifyRmWatch(fd: number, wd: number): number {
  const state = inotifyOf(fd);
  if (typeof state === "number") return state;
  if (!state.watches.delete(wd)) return -E.INVAL;
  inotifyEvent(state, wd, IN_IGNORED);
  return 0;
}
/** inotify_init for libcore's callers (FileObserver), whose changes the VFS reports from now on */
export function javaInotifyInit(): number { hookInotify(); return makeInotify(IN_CLOEXEC); }

export const INOTIFY_SYSCALLS: Record<string, HostFn> = {
  inotify_init: () => makeInotify(0),
  inotify_init1: (_c, a) => makeInotify(a.i()),
  inotify_add_watch: (_c, a) => javaInotifyAddWatch(a.i(), a.str(), a.u()),
  inotify_rm_watch: (_c, a) => javaInotifyRmWatch(a.i(), a.i()),
};
