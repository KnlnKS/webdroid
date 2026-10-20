// AF_UNIX: names bound in this process (an abstract one leads with NUL), connections within it
// (socketpair, a connect to a listener), and the system daemons a guest libc talks to at /dev/socket
// names: logd's logdw (liblog's records) and netd's dnsproxyd (bionic's getaddrinfo and gethostby*
// proxy to it). Any other name reaches a socket listening in this process, or is refused as a socket
// file with no listener is. Every peer is this process, whose credentials SO_PEERCRED and
// SCM_CREDENTIALS carry; SCM_RIGHTS passes open files along with the bytes.

import { E } from "../abi.ts";
import { utf8 } from "../../jvm/abi.ts";
import { logLine } from "../kernel.ts";
import { complete } from "../host.ts";
import { openFd, holdFile, dropFile, installSocket, naming, POLLIN, POLLERR, POLLHUP, POLLOUT, type OpenFile } from "../fs.ts";
import { procIdentity } from "../../shell/procfs.ts";
import { parseIpv4 } from "../../shell/relay.ts";
import { AF_INET, AF_INET6, AF_UNIX, EAI_FAMILY, EAI_SERVICE, EAI_SOCKTYPE, resolveHost, hostOf, parseIpv6 } from "../net-address.ts";
import {
  SOL_SOCKET, SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, SOCK_SEQPACKET, MSG_PEEK, MSG_DONTWAIT, SHUT_RD, SHUT_WR, SCM_RIGHTS, SCM_CREDENTIALS,
  sockaddrOf, unixAddress, scmRights, readUcred, type SocketAddress, type Cmsg, type Ucred,
} from "./abi.ts";
import { IPPROTO_TCP, IPPROTO_UDP } from "./inet.ts";
import { Socket, Loopback, block, received, SO_LINGER, SO_PASSCRED, SO_RCVTIMEO, type Received, type Accepted } from "./core.ts";

const SCM_MAX_FD = 253;
/** this process's credentials: SO_PEERCRED's and SCM_CREDENTIALS's struct ucred */
const processCredentials = (): Ucred => ({ pid: procIdentity.pid, uid: procIdentity.uid, gid: procIdentity.uid });
/** sockets bound in this process, by name */
const names = new Map<string, UnixSocket>();
/** the name a call gave, or EINVAL for another family's */
const pathOf = (addr: SocketAddress | null): string | number => addr?.family === AF_UNIX ? addr.path : -E.INVAL;

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
/** an SCM_RIGHTS message passing descriptors `fds` */
export const rightsMessage = (fds: number[]): Cmsg[] | null =>
  fds.length ? [{ level: SOL_SOCKET, type: SCM_RIGHTS, data: new Uint8Array(Int32Array.from(fds).buffer) }] : null;

// ── the daemons
type Daemon = (bytes: Uint8Array, reply: (bytes: Uint8Array) => void) => void;

/** logd_writer.cpp's datagram: android_log_header_t {u8 id, u16 tid, u32 sec, u32 nsec}, then a
 *  text buffer's priority, tag and message. The binary buffers (events, stats, security) are not text. */
const LOG_HEADER = 11, TEXT_BUFFERS = new Set([0, 1, 3, 4]);
const logd: Daemon = (bytes) => {
  if (bytes.length <= LOG_HEADER || !TEXT_BUFFERS.has(bytes[0])) return;
  const body = bytes.subarray(LOG_HEADER + 1), tagEnd = body.indexOf(0);
  if (tagEnd < 0) return;
  const msg = body.subarray(tagEnd + 1);
  logLine(bytes[LOG_HEADER], utf8.dec.decode(body.subarray(0, tagEnd)), utf8.dec.decode(msg.subarray(0, msg.indexOf(0) < 0 ? msg.length : msg.indexOf(0))));
};

// DnsProxyListener's replies: a NUL-terminated result code, then big-endian fields
const QUERY_RESULT = "222", OPERATION_FAILED = "401";
class Reply {
  private parts: number[] = [];
  code(c: string): this { this.parts.push(...utf8.enc.encode(c), 0); return this; }
  be32(v: number): this { this.parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  bytes(b: ArrayLike<number>): this { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  /** a length-prefixed NUL-terminated string */
  str(s: string): this { const b = utf8.enc.encode(s); return this.be32(b.length + 1).bytes(b).bytes([0]); }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}
const failed = (error: number) => new Reply().code(OPERATION_FAILED).be32(error).done();
const familyOf = (address: number[]) => address.length === 4 ? AF_INET : AF_INET6;
/** getaddrinfo's answers for its hints: one per socket type when none is asked for, as libc's explore table gives */
function addrinfo(node: string, service: string, flags: number, family: number, socktype: number, protocol: number): Uint8Array | Promise<Uint8Array> {
  if (family !== -1 && family !== 0 && family !== AF_INET && family !== AF_INET6) return failed(EAI_FAMILY);
  const port = service === "^" ? 0 : /^\d+$/.test(service) ? Number(service) : -1;
  if (port < 0 || port > 65535) return failed(EAI_SERVICE);
  const kinds = [[SOCK_STREAM, IPPROTO_TCP], [SOCK_DGRAM, IPPROTO_UDP], [SOCK_RAW, 0]]
    .filter(([type, proto]) => (socktype <= 0 || socktype === type) && (protocol <= 0 || protocol === proto || type === SOCK_RAW));
  if (!kinds.length) return failed(EAI_SOCKTYPE);
  const answer = (found: number[][] | number): Uint8Array => {
    if (typeof found === "number") return failed(found);
    const r = new Reply().code(QUERY_RESULT);
    for (const address of found) for (const [type, proto] of kinds) {
      const addr = sockaddrOf(familyOf(address), { address, port });
      r.be32(1).be32(flags < 0 ? 0 : flags).be32(familyOf(address)).be32(type).be32(proto).be32(addr.length).bytes(addr);
      if (flags > 0 && flags & 2) r.str(node); else r.be32(0);              // AI_CANONNAME
    }
    return r.be32(0).done();
  };
  return complete(resolveHost(node, family < 0 ? 0 : family, flags < 0 ? 0 : flags), answer);
}
/** android_read_hostent's serialization: name, aliases, type, length, addresses */
function hostent(name: string, addresses: number[][]): Uint8Array {
  const length = addresses[0].length, r = new Reply().code(QUERY_RESULT).str(name).be32(0).be32(familyOf(addresses[0])).be32(length);
  for (const a of addresses) r.be32(length).bytes(a);
  return r.be32(0).done();
}
const HOST_NOT_FOUND = 1;
function query(line: string): Uint8Array | Promise<Uint8Array> {
  const [command, ...args] = line.split(" ");
  if (command === "getaddrinfo") {
    const [host, service, flags, family, socktype, protocol] = args;
    return addrinfo(host, service, Number(flags), Number(family), Number(socktype), Number(protocol));
  }
  if (command === "gethostbyname") {
    const [, name, af] = args;
    if (Number(af) !== AF_INET && Number(af) !== AF_INET6) return failed(HOST_NOT_FOUND);
    return complete(resolveHost(name, Number(af), 0), f => typeof f === "number" ? failed(HOST_NOT_FOUND) : hostent(name, f));
  }
  if (command === "gethostbyaddr") {
    const address = parseIpv4(args[0]) ?? parseIpv6(args[0]), name = address && hostOf(address);
    return address && name ? hostent(name, [address]) : failed(HOST_NOT_FOUND);
  }
  return failed(E.NOSYS);
}
/** one NUL-terminated command per connection, as FrameworkListener reads it */
const dnsproxyd = (): Daemon => {
  let pending = "";
  return (bytes, reply) => {
    pending += utf8.dec.decode(bytes);
    const end = pending.indexOf("\0");
    if (end < 0) return;
    const r = query(pending.slice(0, end));
    pending = "";
    if (r instanceof Promise) void r.then(reply); else reply(r);
  };
};

const DAEMONS: Record<string, () => Daemon> = { "/dev/socket/logdw": () => logd, "/dev/socket/dnsproxyd": dnsproxyd };
