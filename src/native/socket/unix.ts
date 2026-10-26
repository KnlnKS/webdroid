// AF_UNIX: names bound in this process (an abstract one leads with NUL), connections within it
// (socketpair, a connect to a listener), and the system daemons a guest libc talks to at /dev/socket
// names (daemons.ts). Any other name reaches a socket listening in this process, or is refused as a
// socket file with no listener is. A connected socket passed to another process keeps its connection
// across realms (bridge.ts). Every peer is this process, whose credentials SO_PEERCRED and
// SCM_CREDENTIALS carry; SCM_RIGHTS passes open files along with the bytes.

import { E, O_CLOEXEC, O_NONBLOCK, POLLIN, POLLERR, POLLHUP, POLLOUT } from "../abi.ts";
import { openFd, holdFile, dropFile, type OpenFile } from "../fd.ts";
import { procIdentity } from "../../shell/procfs.ts";
import { AF_UNIX } from "../net-address.ts";
import {
  SOL_SOCKET, SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET, MSG_PEEK, MSG_DONTWAIT, SHUT_RD, SHUT_WR, SCM_RIGHTS, SCM_CREDENTIALS,
  unixAddress, scmRights, readUcred, type SocketAddress, type Cmsg, type Ucred,
} from "./abi.ts";
import { Socket, Loopback, block, received, installSocket, naming, SO_LINGER, SO_PASSCRED, SO_RCVTIMEO, type Received, type Accepted } from "./core.ts";
import { bridge, type CrossingSocket } from "./bridge.ts";
import { DAEMONS, type Daemon } from "./daemons.ts";

const SCM_MAX_FD = 253;
/** this process's credentials: SO_PEERCRED's and SCM_CREDENTIALS's struct ucred */
const processCredentials = (): Ucred => ({ pid: procIdentity.pid, uid: procIdentity.uid, gid: procIdentity.uid });
/** sockets bound in this process, by name */
const names = new Map<string, UnixSocket>();
/** the name a call gave, or EINVAL for another family's */
const pathOf = (addr: SocketAddress | null): string | number => addr?.family === AF_UNIX ? addr.path : -E.INVAL;

/** debug (adb forward): a connection to the stream socket listening at `path` in this process, its other end the host's */
export function connectFromHost(path: string): Loopback | null {
  const server = names.get(path);
  if (!server?.backlog || server.type !== SOCK_STREAM) return null;
  const accepted = new UnixSocket(SOCK_STREAM), [mine, theirs] = Loopback.pair();
  accepted.conn = theirs;
  server.backlog.push(accepted);
  server.wake();
  return mine;
}

class UnixSocket extends Socket {
  readonly family = AF_UNIX;
  /** its bound name, and the name it connected to */
  bound: string | undefined;
  peerName: string | undefined;
  /** its end of a connection: what it reads, and writes to its peer */
  conn: Loopback | null = null;
  /** a datagram socket's queue of what is sent to its name */
  readonly inbox: Loopback | null;
  /** a listening socket's connections not yet accepted */
  backlog: UnixSocket[] | null = null;
  constructor(type: number) { super(type, 0); this.inbox = type === SOCK_DGRAM ? new Loopback(true) : null; }
  get listening(): boolean { return !!this.backlog; }
  protected override get rx(): Loopback | null { return this.conn ?? this.inbox; }
  bind(addr: SocketAddress): number {
    const path = pathOf(addr);
    if (typeof path === "number") return path;
    if (this.bound !== undefined || this.conn) return -E.INVAL;
    if (names.has(path)) return -E.ADDRINUSE;
    names.set(this.bound = path, this);
    return 0;
  }
  listen(): number {
    if (this.bound === undefined || this.conn) return -E.INVAL;
    this.backlog ??= [];
    return 0;
  }
  accept(fd: number, flags: number): Accepted | number | Promise<Accepted | number> {
    if (!this.backlog) return -E.INVAL;
    // the peer is unnamed
    const attempt = (): Accepted | null => { const c = this.backlog!.shift(); return c ? { fd: installSocket(c, flags), peer: unixAddress("") } : null; };
    const ready = attempt();
    if (ready) return ready;
    if (this.nonblock) return -E.AGAIN;
    return block(this, naming(fd, this), attempt, SO_RCVTIMEO);
  }
  /** a daemon, or a socket listening in this process */
  connect(addr: SocketAddress | null): number {
    const path = pathOf(addr);
    if (typeof path === "number") return path;
    const daemon = DAEMONS[path];
    if (daemon) return this.attach(daemon());
    const e = this.connectListener(path);
    return e === -E.CONNREFUSED && !path.startsWith("\0") && !path.startsWith("/dev/socket/") ? -E.NOENT : e;
  }
  /** a stream or seqpacket socket listening at `path`, or a datagram socket there, which becomes
   *  this datagram socket's default destination */
  private connectListener(path: string): number {
    const server = names.get(path);
    if (!server || this.type !== SOCK_DGRAM && !server.backlog) return -E.CONNREFUSED;
    if (server.type !== this.type) return -E.PROTOTYPE;
    if (this.type === SOCK_DGRAM) { this.peerName = path; return 0; }
    if (this.conn) return -E.ISCONN;
    const accepted = new UnixSocket(this.type);
    [this.conn, accepted.conn] = Loopback.pair(this.messages);
    this.peerName = path;
    server.backlog!.push(accepted);
    server.wake();
    return 0;
  }
  /** connected to an in-process daemon: each write reaches `receive` whole, and what it replies is
   *  what the socket reads */
  private attach(receive: Daemon): number {
    if (this.conn) return -E.ISCONN;
    const [mine, theirs] = Loopback.pair(this.messages);
    const reply = (bytes: Uint8Array) => { theirs.write(bytes); };
    const drain = () => {
      for (let c; (c = theirs.next());) { c.rights?.forEach(dropFile); receive(c.bytes, reply); }
      if (!theirs.eof) theirs.subscribe(drain);
    };
    theirs.subscribe(drain);
    this.conn = mine;
    return 0;
  }
  /** sendmsg's SCM_RIGHTS descriptors, each open file held while the message carries it, with
   *  SCM_CREDENTIALS checked as Linux checks an unprivileged sender's (its own pid, uid and gid) */
  private rights(control: Cmsg[] | null): OpenFile[] | null | number {
    const passing: number[] = [], own = processCredentials();
    for (const { level, type, data } of control ?? []) {
      if (level !== SOL_SOCKET) continue;
      if (type === SCM_RIGHTS) passing.push(...scmRights(data));
      else if (type === SCM_CREDENTIALS) {
        const c = readUcred(data);
        if (!c) return -E.INVAL;
        if (c.pid !== own.pid || c.uid !== own.uid || c.gid !== own.gid) return -E.PERM;
      } else return -E.INVAL;
    }
    if (passing.length > SCM_MAX_FD) return -E.INVAL;
    const held: OpenFile[] = [];
    for (const fd of passing) {
      const f = openFd(fd);
      if (!f) { held.forEach(dropFile); return -E.BADF; }
      held.push(holdFile(f));
    }
    return held.length ? held : null;
  }
  send(bytes: Uint8Array, to: SocketAddress | null, control: Cmsg[] | null): number {
    const held = this.rights(control);
    if (typeof held === "number") return held;
    const r = this.sendHeld(bytes, to, held);
    if (r < 0) held?.forEach(dropFile);
    return r;
  }
  private sendHeld(bytes: Uint8Array, to: SocketAddress | null, held: OpenFile[] | null): number {
    if (to) {
      const path = pathOf(to);
      if (typeof path === "number") return path;
      return this.type !== SOCK_DGRAM ? this.conn ? -E.ISCONN : -E.NOTSUP : this.sendDatagram(path, bytes, held);
    }
    const conn = this.conn;
    if (!conn) return this.type === SOCK_DGRAM ? this.sendDatagram(this.peerName, bytes, held) : -E.NOTCONN;
    if (this.writeShut || !conn.writable) return -E.PIPE;
    // a stream queues no empty write, nor what it carries
    if (!bytes.length && !this.messages) { held?.forEach(dropFile); return 0; }
    conn.write(bytes, held);
    return bytes.length;
  }
  /** a datagram to the datagram socket bound to `path` */
  private sendDatagram(path: string | undefined, bytes: Uint8Array, held: OpenFile[] | null): number {
    if (path === undefined) return -E.NOTCONN;
    const target = names.get(path);
    if (!target) return path.startsWith("\0") ? -E.CONNREFUSED : -E.NOENT;
    if (target.type !== SOCK_DGRAM) return -E.PROTOTYPE;
    target.rx!.push({ bytes: bytes.slice(), rights: held, from: this.bound });
    return bytes.length;
  }
  /** the bytes queued for it, or a message socket's next message (cut to the target, MSG_TRUNC's
   *  length its whole); a stream read stops after bytes that passed open files */
  receive(fd: number, target: Uint8Array, flags: number): Received | number | Promise<Received | number> {
    const rx = this.rx;
    if (!rx) return this.type === SOCK_STREAM ? -E.INVAL : -E.NOTCONN;
    const credentials = this.option(SOL_SOCKET, SO_PASSCRED) ? processCredentials() : null;
    const attempt = (): Received | null => {
      if (!rx.pending) return rx.eof ? received(0, 0, null, [], credentials) : null;
      const name = (this.type === SOCK_DGRAM ? rx.nextFrom : this.peerName) ?? "", rights: OpenFile[] = [];
      const n = rx.take(target, 0, target.length, !!(flags & MSG_PEEK), rights);
      return received(Math.min(n, target.length), n, name ? unixAddress(name) : null, rights, credentials);
    };
    const now = attempt();
    if (now) return now;
    if (this.nonblock || flags & MSG_DONTWAIT) return -E.AGAIN;
    return block(this, naming(fd, this), attempt, SO_RCVTIMEO);
  }
  /** SHUT_WR ends what its peer reads, SHUT_RD what it reads once drained, the peer's writes then
   *  meeting EPIPE */
  protected shut(how: number): number {
    if (how !== SHUT_RD && this.conn && !this.writeShut) { this.writeShut = true; this.conn.shutdownWrite(); }
    if (how !== SHUT_WR && this.conn && this.type !== SOCK_DGRAM) this.conn.shutdownRead();
    return 0;
  }
  /** its sun_path ("" unnamed) */
  name(peer: boolean): SocketAddress | number {
    if (peer && !this.conn) return -E.NOTCONN;
    return unixAddress((peer ? this.peerName : this.bound) ?? "");
  }
  /** who connected or listens, every peer being this process; an unconnected socket's is no process */
  peerCredentials(): Ucred | number { return this.conn || this.backlog ? processCredentials() : { pid: 0, uid: -1, gid: -1 }; }
  /** SO_LINGER (off) and SO_PASSCRED; the other socket-level ones are accepted with nothing to observe */
  protected familyOption(level: number, name: number): number {
    if (level !== SOL_SOCKET) return -E.NOPROTOOPT;
    return name === SO_LINGER ? 0 : name === SO_PASSCRED ? this.option(level, name) : -E.NOPROTOOPT;
  }
  protected setFamilyOption(level: number, name: number, value: number): number {
    if (level !== SOL_SOCKET) return -E.NOPROTOOPT;
    if (name === SO_PASSCRED) this.options.set(level << 16 | name, +!!value);
    return 0;
  }
  poll(events: number): number {
    let r = 0;
    const rx = this.rx;
    if (rx) {
      if (events & POLLIN && (rx.pending || rx.eof)) r |= POLLIN;
      if (rx.eof) r |= POLLHUP;
    } else if (this.backlog) { if (events & POLLIN && this.backlog.length) r |= POLLIN; }
    else r |= events & POLLIN;
    if (this.conn) r |= this.writeShut || !this.conn.writable ? POLLERR : events & POLLOUT;
    return r;
  }
  available(): number { const rx = this.rx; return !rx ? 0 : this.messages ? rx.nextSize : rx.available(); }
  /** A connected socket on its way to another process: this process's end of the connection goes across the port it
   *  answers, and holds the socket while the other process does. */
  override cross(): CrossingSocket | null {
    if (!this.conn) return null;
    const { port1, port2 } = new MessageChannel(), file = holdFile(this.file);
    bridge(this.conn, port1, () => dropFile(file));
    return { port: port2, type: this.type, flags: this.file.statusFlags & O_NONBLOCK };
  }
  close(): void {
    if (this.bound !== undefined && names.get(this.bound) === this) names.delete(this.bound);
    this.conn?.close().forEach(dropFile);
    this.inbox?.close().forEach(dropFile);
    // connections never accepted are reset: their clients read the end of the stream and meet EPIPE writing
    for (const c of this.backlog?.splice(0) ?? []) c.close();
    this.wake();
  }
}

/** socket(AF_UNIX, type): SOCK_RAW is a datagram socket, as unix_create makes it */
export function unixSocket(type: number): Socket | number {
  const kind = (type & 15) === 3 ? SOCK_DGRAM : type & 15;
  if (kind !== SOCK_STREAM && kind !== SOCK_DGRAM && kind !== SOCK_SEQPACKET) return -E.SOCKTNOSUPPORT;
  return new UnixSocket(kind);
}
/** socketpair(2): two connected sockets, each reading what the other writes */
export function unixSocketPair(type: number): [Socket, Socket] | number {
  const a = unixSocket(type), b = unixSocket(type);
  if (!(a instanceof UnixSocket) || !(b instanceof UnixSocket)) return a as number;
  [a.conn, b.conn] = Loopback.pair(a.messages);
  return [a, b];
}
/** a descriptor, close-on-exec, on a socket another process passed, connected to its peer across the port */
export function importSocket({ port, type, flags }: CrossingSocket): number {
  const s = new UnixSocket(type), [mine, theirs] = Loopback.pair(s.messages);
  s.conn = mine;
  bridge(theirs, port, () => theirs.close().forEach(dropFile));
  return installSocket(s, flags | O_CLOEXEC);
}
/** an SCM_RIGHTS message passing descriptors `fds` */
export const rightsMessage = (fds: number[]): Cmsg[] | null =>
  fds.length ? [{ level: SOL_SOCKET, type: SCM_RIGHTS, data: new Uint8Array(Int32Array.from(fds).buffer) }] : null;
