// A unix socket connection between realms. Each side of a MessagePort holds a Loopback end that stands
// for the socket on the other side: what its peer writes goes across, and what comes across is written
// to its peer. The open files a write passes (SCM_RIGHTS) cross as rights the page's kernel parks for
// whichever process reads them, or, read-only files no other realm can open, as copies of their bytes,
// as binder sends them. While a socket end is on its way to another process, the page's kernel
// holds its port as a socket of its own (PORTED), which the receiver takes.
import { O_ACCMODE, O_NONBLOCK, O_RDONLY, O_RDWR, S_IFSOCK } from "../abi.ts";
import { ANON, closeFd, dropFile, fdSource, holdFile, installFile, isKind, newFile, openFd, type FileOps, type OpenFile } from "../fd.ts";
import { bytesFd } from "../fs.ts";
import { processRights } from "../process-fd.ts";
import { Loopback } from "./core.ts";

/** a write across, with the open files it passes (each a parked right or a copy); the other side's claim of a write's
 *  rights; the end of the side's writes; its close; the lock its realm holds while it lives */
type Wire = { bytes: Uint8Array; rights: Right[] } | { claimed: true } | { eof: true } | { closed: true } | { realm: string };
type Right = number | Uint8Array;
/** what a socket end crossing to another realm is: its port, its type and its O_NONBLOCK */
export type CrossingSocket = { port: MessagePort; type: number; flags: number };
/** how far a bridge has come, in order: open, its end of writes sent, its close sent, its end let go, its port closed */
const OPEN = 0, EOF = 1, CLOSING = 2, OVER = 3, SHUT = 4;

/** Join `end` to the socket across `port` until either side closes, then `done`. Each process holding a socket
 *  end has a bridge of its own; the first to drain the end takes what arrives. A side's close is answered by
 *  the other's, and the port stays open until then, so the rights in a write already across reach a reader
 *  that lets them go rather than a closed port. Rights the other side never claimed (its realm ended first)
 *  are claimed back and let go. */
export function bridge(end: Loopback, port: MessagePort, done: () => void = () => {}): void {
  let out = Promise.resolve(), inbound = Promise.resolve(), phase = OPEN;
  /** the parked rights of each write across, until the other side claims them */
  const unclaimed: number[][] = [];
  const finish = () => { if (phase >= OVER) return; phase = OVER; done(); };
  const reclaim = () => { for (const ticket of unclaimed.splice(0).flat()) void unpark(ticket).then((f) => { if (f) void dropFile(f); }).catch(failed); };
  const shutdown = () => { finish(); if (phase < SHUT) { phase = SHUT; port.close(); reclaim(); } };
  const send = (wire: () => Wire | Promise<Wire>) => {
    out = out.then(async () => { const w = await wire(); if (phase < SHUT) port.postMessage(w); else reclaim(); }).catch(failed);
  };
  const sendClose = () => { if (phase < CLOSING) { phase = CLOSING; send(() => ({ closed: true })); } };
  const drain = () => {
    if (phase >= OVER) return;
    for (let c; (c = end.next());) {
      const { bytes, rights } = c;
      send(async () => {
        const parked = rights ? await Promise.all(rights.map(park)) : [], tickets = parked.filter(isTicket);
        if (tickets.length) unclaimed.push(tickets);
        return { bytes, rights: parked };
      });
    }
    // a close is the end of the writes too, at once
    const closed = !end.peer || end.peer.closed;
    if (end.eof && phase < EOF && !closed) { phase = EOF; send(() => ({ eof: true })); }
    if (!closed) { end.subscribe(drain); return; }
    sendClose();
    out = out.then(finish);
  };
  port.onmessage = ({ data }: MessageEvent<Wire>) => {
    inbound = inbound.then(async () => {
      if ("bytes" in data) {
        const rights = (await Promise.all(data.rights.map(unpark))).filter((f) => f !== null);
        if (data.rights.some(isTicket)) send(() => ({ claimed: true }));
        if (phase >= OVER || !end.write(data.bytes, rights.length ? rights : null)) rights.forEach(dropFile);
      } else if ("claimed" in data) unclaimed.shift();
      else if ("eof" in data) { if (phase < OVER) end.shutdownWrite(); }
      else if ("realm" in data) void ended(data.realm).then(peerClosed);
      else peerClosed();
    }).catch(failed);
  };
  const peerClosed = () => { sendClose(); out = out.then(shutdown); };
  void realm?.then((name) => { if (phase < SHUT) port.postMessage({ realm: name }); });
  drain();
}
// A port does not report that the realm holding its other side ended (a process's Worker is terminated
// without a word), so each side names a lock its realm holds for life, which the other waits on.
const locks = (globalThis.navigator as Navigator | undefined)?.locks;
const realm = locks && new Promise<string>((granted) => {
  const name = `webdroid-realm-${crypto.randomUUID()}`;
  void locks.request(name, () => { granted(name); return new Promise(() => {}); });
});
const ends = new Map<string, Promise<unknown>>();
function ended(name: string): Promise<unknown> {
  let end = ends.get(name);
  if (!end) ends.set(name, end = locks!.request(name, () => {}));
  return end;
}
const isTicket = (right: Right): right is number => typeof right === "number" && right >= 0;
const failed = (error: unknown) => console.error("[socket] across processes:", error);

/** an open file a write passes: parked in the page's kernel for whoever reads it, or a read-only one's bytes; -1 for one that cannot leave this realm */
async function park(f: OpenFile): Promise<Right> {
  const fd = installFile(f);
  try {
    const ticket = await processRights.park(fd);
    if (ticket !== null && ticket >= 0) return ticket;
    const source = (f.statusFlags & O_ACCMODE) === O_RDONLY ? await fdSource(fd) : null;
    // the source's view may alias guest memory
    if (source) return (await source.read(0, source.size)).slice();
    console.warn("[socket] a descriptor of this process cannot pass to another:", ticket);
    return -1;
  } finally { await closeFd(fd); }
}
async function unpark(right: Right): Promise<OpenFile | null> {
  if (right instanceof Uint8Array) return taken(bytesFd(right));
  const fd = right < 0 ? right : await processRights.claim(right);
  return fd < 0 ? null : taken(fd);
}
/** the open file of `fd`, which closes */
async function taken(fd: number): Promise<OpenFile> {
  const f = holdFile(openFd(fd)!);
  await closeFd(fd);
  return f;
}

/** the connection across `port` ended from this side, as a socket end closed unread ends it */
export const closeCrossing = (port: MessagePort): void => bridge(new Loopback(), port);
/** a socket end on its way to another process, which closes the connection if no one takes it */
const PORTED: FileOps<{ port: MessagePort; type: number; taken: boolean }> = {
  ...ANON,
  mode: S_IFSOCK | 0o777,
  close({ state }) { if (!state.taken) closeCrossing(state.port); },
  /** the crossing socket end it holds, which only one taker gets */
  cross(f) {
    if (f.state.taken) return null;
    f.state.taken = true;
    return { port: f.state.port, type: f.state.type, flags: f.statusFlags & O_NONBLOCK };
  },
};
/** a descriptor, close-on-exec, on a socket end crossing to another process */
export const portedFd = ({ port, type, flags }: CrossingSocket): number => installFile(newFile(PORTED, "socket", O_RDWR | flags, { port, type, taken: false }), true);
export const isPorted = (f: OpenFile): boolean => isKind(f, PORTED);
