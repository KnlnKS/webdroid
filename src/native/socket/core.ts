// The socket core every address family shares (inet.ts, unix.ts). A socket is the open file behind
// its descriptors (fs.ts), as Linux's struct socket is, so dup, close, fcntl, poll, epoll and
// SCM_RIGHTS treat it as any other. Its operations answer -errno and take JS values; the kernel's
// socket calls (syscalls.ts) and libcore's (android/socket.ts) adapt them.

import { E } from "../abi";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../../guest-clock";
import type { OpenFile } from "../fs";
import { SOL_SOCKET, SOCK_STREAM, SOCK_NONBLOCK, SHUT_RD, SHUT_RDWR, type SocketAddress, type Ucred, type Cmsg } from "./abi";

export const SO_REUSEADDR = 2, SO_TYPE = 3, SO_ERROR = 4, SO_BROADCAST = 6, SO_SNDBUF = 7, SO_RCVBUF = 8, SO_LINGER = 13, SO_PASSCRED = 16;
export const SO_PEERCRED = 17, SO_RCVTIMEO = 20, SO_SNDTIMEO = 21, SO_BINDTODEVICE = 25, SO_ACCEPTCONN = 30, SO_PROTOCOL = 38, SO_DOMAIN = 39;

export const netDebug = { events: [] as string[] };
export function record(event: string): void {
  netDebug.events.push(event);
  if (netDebug.events.length > 100) netDebug.events.shift();
}

/** a byte stream a stream socket reads and writes: a relay connection, or a Loopback end */
export interface Stream {
  /** no more bytes will arrive than are queued */
  readonly eof: boolean;
  available(): number;
  take(out: Uint8Array, off: number, len: number, peek?: boolean): number;
  /** false once the other end is gone */
  write(bytes: Uint8Array): boolean;
  subscribe(waiter: () => void): () => void;
  shutdownWrite(): void;
  close(): void;
}

/** one write on an in-process connection: its bytes, the open files SCM_RIGHTS passes with them,
 *  and the name a datagram was sent from */
export interface Chunk { bytes: Uint8Array; rights: OpenFile[] | null; from?: string }
const CONSUMED: Chunk = { bytes: new Uint8Array(0), rights: null };
/** One end of an in-process connection, reading what its peer writes: a byte stream, or with
 *  `messages` one that keeps each write whole. A peerless end is a datagram socket's queue. */
export class Loopback implements Stream {
  private chunks: Chunk[] = [];
  private head = 0;
  private bytes = 0;
  /** no more will arrive than is queued: the peer shut down writing, or this end reading */
  eof = false;
  closed = false;
  /** this end shut down reading: its peer's writes meet EPIPE */
  private refusing = false;
  peer: Loopback | null = null;
  private readonly waiters = new Set<() => void>();
  constructor(readonly messages = false) {}
  static pair(messages = false): [Loopback, Loopback] {
    const a = new Loopback(messages), b = new Loopback(messages);
    a.peer = b; b.peer = a;
    return [a, b];
  }
  available(): number { return this.bytes; }
  /** bytes, or a message (perhaps empty), are queued */
  get pending(): boolean { return this.head < this.chunks.length; }
  /** the queued message's length, and the name it was sent from */
  get nextSize(): number { return this.pending ? this.chunks[this.head].bytes.length : 0; }
  get nextFrom(): string | undefined { return this.chunks[this.head]?.from; }
  get writable(): boolean { return !!this.peer && !this.closed && !this.peer.closed && !this.peer.refusing; }
  push(chunk: Chunk): void {
    this.chunks.push(chunk);
    this.bytes += chunk.bytes.length;
    this.wake();
  }
  write(bytes: Uint8Array, rights: OpenFile[] | null = null): boolean {
    if (!this.writable) return false;
    this.peer!.push({ bytes: bytes.slice(), rights });
    return true;
  }
  /** Move up to `len` queued bytes into `out` at `off`: a message end's next message whole, cut to
   *  `len` and answering its length; a byte stream's bytes, stopping after a write that passed open
   *  files. Those go to `rights`, which a peek holds again. */
  take(out: Uint8Array, off: number, len: number, peek = false, rights: OpenFile[] = []): number {
    const collect = (c: Chunk) => {
      if (!c.rights) return false;
      if (peek) { for (const f of c.rights) { f.references++; rights.push(f); } return true; }
      rights.push(...c.rights);
      c.rights = null;
      return true;
    };
    if (this.messages) {
      const c = this.chunks[this.head];
      if (!c) return 0;
      collect(c);
      out.set(c.bytes.subarray(0, Math.min(len, c.bytes.length)), off);
      if (!peek) this.advance(this.head + 1, c.bytes.length);
      return c.bytes.length;
    }
    let n = 0, i = this.head;
    while (n < len && i < this.chunks.length) {
      const c = this.chunks[i], take = Math.min(len - n, c.bytes.length), carried = collect(c);
      out.set(take === c.bytes.length ? c.bytes : c.bytes.subarray(0, take), off + n);
      n += take;
      if (peek) i++;
      else if (take === c.bytes.length) i++;
      else c.bytes = c.bytes.subarray(take);
      if (carried) break;
    }
    if (!peek) this.advance(i, n);
    return n;
  }
  private advance(head: number, taken: number): void {
    for (let i = this.head; i < head; i++) this.chunks[i] = CONSUMED;
    this.bytes -= taken;
    this.head = head;
    if (this.head === this.chunks.length) { this.chunks.length = 0; this.head = 0; }
    else if (this.head >= 1024 && this.head * 2 >= this.chunks.length) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
  }
  /** the next write whole: what an in-process daemon reads */
  next(): Chunk | null {
    const c = this.chunks[this.head];
    if (c) this.advance(this.head + 1, c.bytes.length);
    return c ?? null;
  }
  subscribe(waiter: () => void): () => void { this.waiters.add(waiter); return () => this.waiters.delete(waiter); }
  wake(): void { const ws = [...this.waiters]; this.waiters.clear(); for (const w of ws) w(); }
  shutdownWrite(): void { if (this.peer) { this.peer.eof = true; this.peer.wake(); } }
  shutdownRead(): void { this.eof = this.refusing = true; this.wake(); }
  /** the reader goes: the peer reads the end and meets EPIPE. The open files no read took are
   *  the caller's to release. */
  close(): OpenFile[] {
    const unread: OpenFile[] = [];
    for (let i = this.head; i < this.chunks.length; i++) { const c = this.chunks[i]; if (c.rights) unread.push(...c.rights); c.rights = null; }
    this.closed = this.eof = true;
    this.shutdownWrite();
    this.wake();
    return unread;
  }
}

/** what a receive took: `length` bytes copied of a message `size` long (MSG_TRUNC's answer), its
 *  sender, the open files SCM_RIGHTS passed and, under SO_PASSCRED, the sender's credentials */
export interface Received { length: number; size: number; from: SocketAddress | null; rights: OpenFile[]; credentials: Ucred | null }
export const received = (length: number, size = length, from: SocketAddress | null = null, rights: OpenFile[] = [], credentials: Ucred | null = null): Received =>
  ({ length, size, from, rights, credentials });
/** a connection accept(2) took: its descriptor and its peer */
export interface Accepted { fd: number; peer: SocketAddress }

/** A socket of some family and type. Each operation answers -errno for what it refuses. */
export abstract class Socket {
  abstract readonly family: number;
  /** the open file this socket is, which its descriptors share */
  file!: OpenFile;
  error = 0;
  readShut = false;
  writeShut = false;
  readonly waiters = new Set<() => void>();
  /** setsockopt values by level << 16 | option */
  readonly options = new Map<number, number>();
  constructor(readonly type: number, readonly protocol: number) {}
  /** O_NONBLOCK, which is SOCK_NONBLOCK, on its open file */
  get nonblock(): boolean { return !!(this.file.statusFlags & SOCK_NONBLOCK); }
  /** each write stays whole: SOCK_DGRAM and SOCK_SEQPACKET */
  get messages(): boolean { return this.type !== SOCK_STREAM; }
  option(level: number, name: number, fallback = 0): number { return this.options.get(level << 16 | name) ?? fallback; }
  wake(): void { const ws = [...this.waiters]; this.waiters.clear(); for (const w of ws) w(); }
  /** the stream whose arrivals also wake the socket's waiters */
  protected get rx(): Stream | null { return null; }
  /** call `waiter` once something about the socket changes */
  watch(waiter: () => void): () => void {
    this.waiters.add(waiter);
    const rx = this.rx?.subscribe(waiter);
    return () => { this.waiters.delete(waiter); rx?.(); };
  }

  abstract bind(addr: SocketAddress): number;
  /** connect(2); null is AF_UNSPEC's dissolving of a datagram socket's association */
  abstract connect(addr: SocketAddress | null): number | Promise<number>;
  abstract listen(): number;
  abstract readonly listening: boolean;
  /** accept4(2) on descriptor `fd`; `flags` SOCK_NONBLOCK and SOCK_CLOEXEC are the new descriptor's */
  abstract accept(fd: number, flags: number): Accepted | number | Promise<Accepted | number>;
  /** a write to the peer, or a datagram to `to`, with sendmsg's ancillary data (null for none) */
  abstract send(bytes: Uint8Array, to: SocketAddress | null, control: Cmsg[] | null): number;
  /** a read into `target` on descriptor `fd`, waiting unless nonblocking or MSG_DONTWAIT; EBADF
   *  once the descriptor closes under the wait */
  abstract receive(fd: number, target: Uint8Array, flags: number): Received | number | Promise<Received | number>;
  /** shutdown(2) of a connected socket's directions; `how` is valid */
  protected abstract shut(how: number): number;
  abstract name(peer: boolean): SocketAddress | number;
  abstract poll(events: number): number;
  /** FIONREAD: what a read could take now */
  abstract available(): number;
  /** the last descriptor sharing the socket closed it */
  abstract close(): void;
  /** SO_PEERCRED */
  peerCredentials(): Ucred | number { return -E.NOPROTOOPT; }
  /** IP_ADD_MEMBERSHIP and its kin: a level this family lacks */
  group(_join: boolean, _group: number[], _ifindex: number): number { return -E.NOPROTOOPT; }

  shutdown(how: number): number { return how < SHUT_RD || how > SHUT_RDWR ? -E.INVAL : this.shut(how); }
  /** getsockopt(2) for an int-valued option: SOL_SOCKET's common ones, then the family's */
  getOption(level: number, name: number): number {
    if (level === SOL_SOCKET) switch (name) {
      case SO_TYPE: return this.type;
      case SO_DOMAIN: return this.family;
      case SO_PROTOCOL: return this.protocol;
      case SO_ERROR: { const e = this.error; this.error = 0; return e; }
      case SO_ACCEPTCONN: return +this.listening;
      case SO_RCVTIMEO: case SO_SNDTIMEO: return this.option(level, name);
    }
    return this.familyOption(level, name);
  }
  /** setsockopt(2) for an int-valued option (the timeouts in ms) */
  setOption(level: number, name: number, value: number): number {
    if (level === SOL_SOCKET) switch (name) {
      case SO_TYPE: case SO_ERROR: case SO_DOMAIN: case SO_PROTOCOL: case SO_ACCEPTCONN: return -E.NOPROTOOPT;
      case SO_RCVTIMEO: case SO_SNDTIMEO: this.options.set(level << 16 | name, Math.max(0, value)); return 0;
    }
    return this.setFamilyOption(level, name, value);
  }
  protected abstract familyOption(level: number, name: number): number;
  protected abstract setFamilyOption(level: number, name: number, value: number): number;
}

/** Wait until `attempt` answers (anything but null), the socket's `timeoutOption` (SO_RCVTIMEO or
 *  SO_SNDTIMEO) elapses (EAGAIN) or the descriptor waited on stops naming it (EBADF). */
export function block<T>(socket: Socket, named: () => boolean, attempt: () => T | null, timeoutOption: number): Promise<T | number> {
  return new Promise((resolve) => {
    const ms = socket.option(SOL_SOCKET, timeoutOption);
    let timer: GuestTimer | undefined, unsubscribe: (() => void) | undefined;
    const done = (value: T | number) => { clearGuestTimeout(timer); unsubscribe?.(); resolve(value); };
    const retry = () => {
      unsubscribe?.(); unsubscribe = undefined;
      if (!named()) return done(-E.BADF);
      const result = attempt();
      if (result !== null) return done(result);
      unsubscribe = socket.watch(retry);
    };
    if (ms > 0) timer = setGuestTimeout(() => done(-E.AGAIN), ms);
    unsubscribe = socket.watch(retry);
  });
}
