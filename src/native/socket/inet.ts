// AF_INET and AF_INET6: a TCP connection to another host is a relay connection; TCP to a listener
// in this process and UDP between this process's sockets stay in the process.

import { DatagramRelay, Relay } from "../../shell/relay.ts";
import { syntheticHost } from "../net-address.ts";
import { E, POLLIN, POLLOUT, POLLERR, POLLHUP, POLLRDHUP } from "../abi.ts";
import { sameBytes } from "../../jvm/abi.ts";
import {
  AF_UNIX, AF_INET, AF_INET6, V4_ANY, V4_LOOPBACK, V6_LOOPBACK, isAny, isLoopback, isMulticast, addressKey,
  endpointOf, parseIpv4, parseIpv6, ipv4Key, addressText, INTERFACES, type Endpoint,
} from "../net-address.ts";
import { SOL_SOCKET, SOCK_STREAM, SOCK_DGRAM, MSG_PEEK, MSG_DONTWAIT, SHUT_RD, SHUT_WR, type SocketAddress, type Cmsg } from "./abi.ts";
import {
  Socket, Loopback, block, record, received, installSocket, socketOf, naming, type Stream, type Received, type Accepted,
  SO_REUSEADDR, SO_BROADCAST, SO_RCVBUF, SO_SNDBUF, SO_LINGER, SO_RCVTIMEO,
} from "./core.ts";

export const IPPROTO_IP = 0, IPPROTO_TCP = 6, IPPROTO_UDP = 17, IPPROTO_IPV6 = 41;
const IPPROTO_ICMP = 1, IPPROTO_ICMPV6 = 58;
const TCP_NODELAY = 1, IP_TOS = 1, IP_TTL = 2, IP_MULTICAST_IF = 32, IP_MULTICAST_TTL = 33, IP_MULTICAST_LOOP = 34, IP_MULTICAST_ALL = 49;
export const IP_ADD_MEMBERSHIP = 35, IP_DROP_MEMBERSHIP = 36, MCAST_JOIN_GROUP = 42;
const IPV6_UNICAST_HOPS = 16, IPV6_MULTICAST_IF = 17, IPV6_MULTICAST_HOPS = 18, IPV6_MULTICAST_LOOP = 19, IPV6_V6ONLY = 26, IPV6_TCLASS = 67;
const UDP_MAX_PAYLOAD = 65_507, UDP_QUEUE_PACKETS = 256, UDP_QUEUE_BYTES = 1 << 20;
// Linux's buffer sizing (measured on the reference device): a set value is doubled, with a floor
const RCVBUF_MIN = 2304, SNDBUF_MIN = 4608;

let nextEphemeral = 32_768;
const loopbackOf = (ep: Endpoint) => ep.address.length === 4 ? V4_LOOPBACK : V6_LOOPBACK;
/** an internet address a call named: an AF_UNIX one is a family this socket lacks */
const endpoint = (addr: SocketAddress): Endpoint | number => addr.family === AF_UNIX ? -E.AFNOSUPPORT : addr.ep;

abstract class InetSocket extends Socket {
  readonly family: typeof AF_INET | typeof AF_INET6;
  connected = false;
  peer: Endpoint | null = null;
  local: Endpoint | null = null;
  constructor(family: typeof AF_INET | typeof AF_INET6, type: number, protocol: number) { super(type, protocol); this.family = family; }
  protected abstract get bound(): Set<InetSocket>;
  /** another socket's port binding that a shared SO_REUSEADDR does not let this one share */
  protected abstract exclusive(other: InetSocket): boolean;
  protected address(ep: Endpoint): SocketAddress { return { family: this.family, ep }; }
  protected any(): number[] { return this.family === AF_INET6 ? new Array(16).fill(0) : V4_ANY; }
  /** EAFNOSUPPORT for an IPv6 address on an IPv4 socket (libcore retries IPv4-mapped ones as IPv4);
   *  ENETUNREACH for an IPv4(-mapped) one on an IPV6_V6ONLY socket */
  protected familyError(ep: Endpoint): number {
    return this.family === AF_INET && ep.address.length === 16 ? -E.AFNOSUPPORT
      : ep.address.length === 4 && this.v6only ? -E.NETUNREACH : 0;
  }
  get v6only(): boolean { return this.family === AF_INET6 && !!this.option(IPPROTO_IPV6, IPV6_V6ONLY); }
  private portTaken(ep: Endpoint): boolean {
    for (const other of this.bound) {
      const local = other.local!;
      if (other === this || local.port !== ep.port) continue;
      // an IPV6_V6ONLY socket leaves the port's IPv4 addresses to IPv4 sockets
      if (other.family !== this.family && (this.v6only || other.v6only)) continue;
      const overlap = isAny(local.address) || isAny(ep.address) || sameBytes(local.address, ep.address);
      const shared = this.option(SOL_SOCKET, SO_REUSEADDR) && other.option(SOL_SOCKET, SO_REUSEADDR) && !this.exclusive(other);
      if (overlap && !shared) return true;
    }
    return false;
  }
  bindTo(ep: Endpoint): number {
    if (this.local) return -E.INVAL;
    const error = this.familyError(ep);
    if (error) return error === -E.NETUNREACH ? -E.INVAL : error;
    if (!isAny(ep.address) && !isLoopback(ep.address) && !isMulticast(ep.address)) return -E.ADDRNOTAVAIL;
    let port = ep.port;
    if (!port) {
      for (let tries = 0; tries < 28_232 && !port; tries++) {
        const candidate = nextEphemeral++;
        if (nextEphemeral > 60_999) nextEphemeral = 32_768;
        if (!this.portTaken({ address: ep.address, port: candidate })) port = candidate;
      }
      if (!port) return -E.ADDRINUSE;
    } else if (this.portTaken(ep)) return -E.ADDRINUSE;
    this.local = { address: ep.address, port };
    this.bound.add(this);
    return 0;
  }
  protected bindAny(): number { return this.local ? 0 : this.bindTo({ address: this.any(), port: 0 }); }
  bind(addr: SocketAddress): number { const ep = endpoint(addr); return typeof ep === "number" ? ep : this.bindTo(ep); }
  name(peer: boolean): SocketAddress | number {
    if (peer) return this.connected && this.peer ? this.address(this.peer) : -E.NOTCONN;
    return this.address(this.local ?? { address: this.any(), port: 0 });
  }
  protected familyOption(level: number, name: number): number {
    const stream = this.type === SOCK_STREAM, stored = this.options.get(level << 16 | name);
    if (level === SOL_SOCKET) {
      switch (name) {
        case SO_RCVBUF: return stored ?? (stream ? 1_048_576 : 229_376);
        case SO_SNDBUF: return stored ?? (stream ? this.connected ? 1_048_576 : 524_288 : 229_376);
        case SO_REUSEADDR: case SO_BROADCAST: case 9 /* SO_KEEPALIVE */: case 10 /* SO_OOBINLINE */: case 5 /* SO_DONTROUTE */: case SO_LINGER:
          return stored ?? 0;
      }
      return -E.NOPROTOOPT;
    }
    if (level === IPPROTO_TCP) return stream && name === TCP_NODELAY ? stored ?? 0 : -E.NOPROTOOPT;
    if (level === IPPROTO_IP) {
      switch (name) {
        case IP_TOS: return stored ?? 0;
        case IP_TTL: return stored ?? 64;
        case IP_MULTICAST_TTL: return stored ?? 1;
        case IP_MULTICAST_LOOP: case IP_MULTICAST_ALL: return stored ?? 1;
        case IP_MULTICAST_IF: return stored ?? 0;
      }
      return -E.NOPROTOOPT;
    }
    if (level === IPPROTO_IPV6 && this.family === AF_INET6) {
      switch (name) {
        case IPV6_TCLASS: case IPV6_MULTICAST_IF: case IPV6_V6ONLY: return stored ?? 0;
        case IPV6_UNICAST_HOPS: return stored ?? 64;
        case IPV6_MULTICAST_HOPS: case IPV6_MULTICAST_LOOP: return stored ?? 1;
      }
    }
    return -E.NOPROTOOPT;
  }
  /** SO_LINGER takes the seconds, -1 for off, and reads back as seconds + 1, 0 for off */
  protected setFamilyOption(level: number, name: number, value: number): number {
    const current = this.familyOption(level, name);
    if (current < 0) return current;
    let stored = value;
    if (level === SOL_SOCKET && name === SO_RCVBUF) stored = Math.max(2 * Math.max(0, value), RCVBUF_MIN);
    else if (level === SOL_SOCKET && name === SO_SNDBUF) stored = Math.max(2 * Math.max(0, value), SNDBUF_MIN);
    else if (level === SOL_SOCKET && name === SO_LINGER) stored = value < 0 ? 0 : Math.min(value, 65535) + 1;
    else if (level === IPPROTO_IP && (name === IP_TTL || name === IP_MULTICAST_TTL) && (value < -1 || value > 255 || name === IP_TTL && value === 0)) return -E.INVAL;
    else if (!(level === IPPROTO_IP && (name === IP_TOS || name === IP_TTL || name === IP_MULTICAST_TTL || name === IP_MULTICAST_IF)) &&
      !(level === IPPROTO_IPV6 && (name === IPV6_TCLASS || name === IPV6_UNICAST_HOPS || name === IPV6_MULTICAST_HOPS || name === IPV6_MULTICAST_IF))) stored = value ? 1 : 0;
    if (level === IPPROTO_IP && name === IP_TOS) stored &= 0xfc;
    this.options.set(level << 16 | name, stored);
    return 0;
  }
  group(_join: boolean, _group: number[], _ifindex: number): number { return -E.PROTONOSUPPORT; }
}

class TcpSocket extends InetSocket {
  static readonly bound = new Set<TcpSocket>();
  stream: Stream | null = null;
  connecting = false;
  /** a listening socket's connections not yet accepted */
  backlog: TcpSocket[] | null = null;
  constructor(family: typeof AF_INET | typeof AF_INET6) { super(family, SOCK_STREAM, IPPROTO_TCP); }
  protected get bound(): Set<InetSocket> { return TcpSocket.bound; }
  protected exclusive(other: InetSocket): boolean { return !!(other as TcpSocket).backlog; }
  get listening(): boolean { return !!this.backlog; }
  static connected(family: typeof AF_INET | typeof AF_INET6, stream: Stream, local: Endpoint | null, peer: Endpoint): TcpSocket {
    const s = new TcpSocket(family);
    Object.assign(s, { stream, local, peer, connected: true });
    return s;
  }
  protected override get rx(): Stream | null { return this.stream; }
  listen(): number {
    if (this.connected || this.connecting) return -E.INVAL;
    const r = this.bindAny();
    if (r) return r;
    this.backlog ??= [];
    return 0;
  }
  connect(addr: SocketAddress | null): PromiseOrVal<number> {
    if (!addr) return -E.AFNOSUPPORT;
    const ep = endpoint(addr);
    if (typeof ep === "number") return ep;
    if (this.connected) return -E.ISCONN;
    if (this.connecting) return -E.ALREADY;
    if (this.backlog) return -E.INVAL;
    const error = this.familyError(ep);
    if (error) return error;
    // Linux connects an unspecified address to the loopback one
    const target: Endpoint = isAny(ep.address) ? { address: loopbackOf(ep), port: ep.port } : ep;
    this.peer = target;
    if (isLoopback(target.address)) return this.connectLoopback(target);
    const host = target.address.length === 4 ? syntheticHost(target.address) ?? addressText(target.address) : addressText(target.address);
    record(`connect ${host}:${target.port} nonblock=${this.nonblock}`);
    const relay = new Relay(host, target.port, false);
    this.stream = relay;
    this.connecting = true;
    const completion = relay.ready.then(() => {
      this.connecting = false;
      this.connected = true;
      const local = relay.localEndpoint;
      const address = local?.family === "IPv4" ? parseIpv4(local.address) : local ? parseIpv6(local.address) : null;
      if (local && address && (!this.local || isAny(this.local.address))) this.local = endpointOf(address, local.port);
      record(`connected ${host}:${target.port}`);
      this.wake();
      return 0;
    }, () => {
      this.connecting = false;
      this.stream = null;
      this.error = connectErrno(relay.failure);
      record(`connect failed ${host}:${target.port} errno=${this.error} ${relay.failure}`);
      this.wake();
      return -this.error;
    });
    if (this.nonblock) return -E.INPROGRESS;
    return completion.then((r) => { if (r) this.error = 0; return r; });
  }
  private connectLoopback(target: Endpoint): number {
    if (!this.local || !this.local.port) {
      if (this.local) TcpSocket.bound.delete(this);
      this.local = null;
      const r = this.bindTo({ address: loopbackOf(target), port: 0 });
      if (r) return r;
    }
    if (isAny(this.local!.address)) this.local = { address: loopbackOf(target), port: this.local!.port };
    const listener = listenerFor(target);
    record(`connect loopback :${target.port} ${listener ? "accepted" : "refused"}`);
    if (!listener) {
      if (!this.nonblock) return -E.CONNREFUSED;
      this.error = E.CONNREFUSED;
      return -E.INPROGRESS;
    }
    const [client, server] = Loopback.pair();
    this.stream = client;
    this.connected = true;
    listener.backlog!.push(TcpSocket.connected(listener.family, server, { address: target.address, port: target.port }, this.local!));
    listener.wake();
    return this.nonblock ? -E.INPROGRESS : 0;
  }
  accept(fd: number, flags: number): PromiseOrVal<Accepted | number> {
    if (!this.backlog) return -E.INVAL;
    const attempt = (): Accepted | null => {
      const accepted = this.backlog!.shift();
      if (!accepted) return null;
      const child = installSocket(accepted, flags);
      TcpSocket.bound.add(accepted);
      record(`accept fd=${fd} -> ${child}`);
      return { fd: child, peer: accepted.address(accepted.peer!) };
    };
    const ready = attempt();
    if (ready) return ready;
    if (this.nonblock) return -E.AGAIN;
    return block(this, naming(fd, this), attempt, SO_RCVTIMEO);
  }
  protected shut(how: number): number {
    if (!this.connected) return this.backlog ? 0 : -E.NOTCONN;
    if (how !== SHUT_WR) this.readShut = true;
    if (how !== SHUT_RD && !this.writeShut) { this.writeShut = true; this.stream?.shutdownWrite(); }
    this.wake();
    return 0;
  }
  send(bytes: Uint8Array, to: SocketAddress | null, control: Cmsg[] | null): number {
    if (control) return -E.INVAL;
    if (to) return this.connected ? -E.ISCONN : -E.NOTCONN;
    if (this.writeShut) return -E.PIPE;
    if (!this.connected || !this.stream) return -(this.error || E.NOTCONN);
    if (!bytes.length) return 0;
    return this.stream.write(bytes) ? bytes.length : -E.PIPE;
  }
  receive(fd: number, target: Uint8Array, flags: number): PromiseOrVal<Received | number> {
    if (this.readShut) return received(0);
    if (!this.stream) return -(this.error || E.NOTCONN);
    const stream = this.stream;
    const attempt = () => stream.available() ? received(stream.take(target, 0, target.length, !!(flags & MSG_PEEK))) : stream.eof ? received(0) : null;
    if (!target.length) return received(0);
    const ready = attempt();
    if (ready !== null) return ready;
    if (!this.connected && !this.connecting) return -(this.error || E.NOTCONN);
    if (this.nonblock || flags & MSG_DONTWAIT) return -E.AGAIN;
    return block(this, naming(fd, this), attempt, SO_RCVTIMEO);
  }
  poll(events: number): number {
    let ready = this.error ? POLLERR : 0;
    if (this.backlog) {
      if (this.backlog.length) ready |= events & POLLIN;
      return ready;
    }
    const stream = this.stream;
    if (this.connected && !this.writeShut) ready |= events & POLLOUT;
    if (this.readShut || stream && (stream.available() || stream.eof)) ready |= events & POLLIN;
    if (stream?.eof) ready |= events & POLLRDHUP;
    if (stream?.eof && this.writeShut || this.error) ready |= POLLHUP | events & POLLOUT;
    return ready;
  }
  available(): number { return this.readShut ? 0 : this.stream?.available() ?? 0; }
  close(): void {
    TcpSocket.bound.delete(this);
    this.stream?.close();
    for (const pending of this.backlog?.splice(0) ?? []) pending.stream?.close();
    this.wake();
  }
  /** TLS on this connection: the relay terminates it (a page cannot handshake), so it dials
   *  `host:port` again with TLS, and that connection takes the place of the plain one, which has
   *  carried nothing yet. A failed one leaves the stream at its end. */
  startTls(host: string, port: number, alpn: string[]): PromiseOrVal<TlsResult> {
    if (!this.connected) return { errno: E.NOTCONN, reason: "" };
    if (!(this.stream instanceof Relay)) return { errno: 0, reason: "no TLS to a listener in this process" };
    this.stream.close();
    const relay = this.stream = new Relay(host, port, true, alpn);
    record(`starttls ${host}:${port}`);
    return relay.ready.then(() => { this.wake(); return relay.applicationProtocol ?? ""; }, () => {
      record(`starttls failed ${host}:${port} ${relay.failure}`);
      this.wake();
      return { errno: relay.failureCode === 4001 ? 0 : connectErrno(relay.failure), reason: relay.failure };
    });
  }
}
/** the negotiated application protocol ("" for none), or why TLS failed: errno 0 is the handshake */
export type TlsResult = string | { errno: number; reason: string };

/** the errno a relay's failure reason stands for; no reason at all is no relay to reach */
function connectErrno(reason: string): number {
  if (!reason) return E.NETUNREACH;
  if (/ETIMEDOUT|timed out/i.test(reason)) return E.TIMEDOUT;
  if (/ENETUNREACH/.test(reason)) return E.NETUNREACH;
  if (/EHOSTUNREACH/.test(reason)) return E.HOSTUNREACH;
  return E.CONNREFUSED;
}
function listenerFor(ep: Endpoint): TcpSocket | null {
  for (const s of TcpSocket.bound) {
    if (!s.backlog || s.local!.port !== ep.port) continue;
    const local = s.local!.address;
    if (s.family === AF_INET && ep.address.length === 16) continue;
    if (ep.address.length === 4 && s.v6only) continue;
    if (sameBytes(local, ep.address) || isAny(local)) return s;
  }
  return null;
}

interface Datagram { bytes: Uint8Array; source: Endpoint }
class UdpSocket extends InetSocket {
  static readonly bound = new Set<UdpSocket>();
  relay: DatagramRelay | null = null;
  queue: Datagram[] = [];
  queuedBytes = 0;
  groups = new Set<string>();
  closed = false;
  readonly listening = false;
  constructor(family: typeof AF_INET | typeof AF_INET6) { super(family, SOCK_DGRAM, IPPROTO_UDP); }
  protected get bound(): Set<InetSocket> { return UdpSocket.bound; }
  protected exclusive(): boolean { return false; }
  listen(): number { return -E.NOTSUP; }
  accept(): number { return -E.NOTSUP; }
  connect(addr: SocketAddress | null): number {
    if (!addr) { this.peer = null; this.connected = false; return 0; }
    const ep = endpoint(addr);
    if (typeof ep === "number") return ep;
    // no IPv6 route, as send finds
    const error = this.familyError(ep) || (ep.address.length === 16 && !isLoopback(ep.address) && !isAny(ep.address) && !isMulticast(ep.address) ? -E.NETUNREACH : 0);
    if (error) return error;
    const r = this.bindAny();
    if (r) return r;
    this.peer = ep;
    this.connected = true;
    return 0;
  }
  protected shut(how: number): number {
    if (!this.connected) return -E.NOTCONN;
    if (how !== SHUT_WR) this.readShut = true;
    if (how !== SHUT_RD) this.writeShut = true;
    this.wake();
    return 0;
  }
  private recipients(destination: Endpoint): UdpSocket[] {
    const loopback = isLoopback(destination.address), multicast = isMulticast(destination.address);
    const source = this.local ? datagramSource(this.local) : null;
    const recipients: UdpSocket[] = [];
    for (const candidate of UdpSocket.bound) {
      const local = candidate.local!;
      if (local.port !== destination.port) continue;
      if (candidate.family === AF_INET && destination.address.length === 16) continue;
      const addressMatches = multicast
        ? candidate.groups.has(addressKey(destination.address)) && (candidate !== this || !!this.option(IPPROTO_IP, IP_MULTICAST_LOOP, 1))
        : sameBytes(local.address, destination.address) || loopback && isAny(local.address);
      const peerMatches = !candidate.peer || !!source && candidate.peer.port === source.port && sameBytes(candidate.peer.address, source.address);
      if (addressMatches && peerMatches) recipients.push(candidate);
    }
    return recipients;
  }
  private enqueue(bytes: Uint8Array, source: Endpoint): void {
    if (this.closed || this.queue.length >= UDP_QUEUE_PACKETS || this.queuedBytes + bytes.length > UDP_QUEUE_BYTES) return;
    const peer = this.peer;
    if (peer && (peer.port !== source.port || !sameBytes(peer.address, source.address))) return;
    this.queue.push({ bytes, source });
    this.queuedBytes += bytes.length;
    this.wake();
  }
  send(bytes: Uint8Array, to: SocketAddress | null, control: Cmsg[] | null): number {
    if (control) return -E.INVAL;
    if (this.writeShut) return -E.PIPE;
    if (bytes.length > UDP_MAX_PAYLOAD) return -E.MSGSIZE;
    const destination = to ? endpoint(to) : this.peer;
    if (typeof destination === "number") return destination;
    if (!destination) return -E.DESTADDRREQ;
    const error = this.familyError(destination);
    if (error) return error;
    if (!destination.port) return -E.INVAL;
    if (destination.address.length === 4 && ipv4Key(destination.address) === 0xffffffff && !this.option(SOL_SOCKET, SO_BROADCAST)) return -E.ACCES;
    const r = this.bindAny();
    if (r) return r;
    const recipients = this.recipients(destination);
    const copy = bytes.slice();
    for (const recipient of recipients) recipient.enqueue(copy, datagramSource(this.local!));
    if (!isLoopback(destination.address) && !recipients.length) {
      if (destination.address.length === 16) return -E.NETUNREACH;
      const relay = this.relay ??= new DatagramRelay((packet, address, port) => this.enqueue(packet, { address, port }));
      void relay.send(syntheticHost(destination.address) ?? addressText(destination.address), destination.port, copy).catch(() => {
        this.error = E.NETUNREACH;
        relay.close();
        if (this.relay === relay) this.relay = null;
        this.wake();
      });
    }
    return bytes.length;
  }
  receive(fd: number, target: Uint8Array, flags: number): PromiseOrVal<Received | number> {
    if (this.readShut) return received(0);
    const attempt = (): Received | number | null => {
      const datagram = this.queue[0];
      if (!datagram) { if (this.error) { const e = this.error; this.error = 0; return -e; } return null; }
      if (!(flags & MSG_PEEK)) { this.queue.shift(); this.queuedBytes -= datagram.bytes.length; }
      const copied = Math.min(target.length, datagram.bytes.length);
      target.set(datagram.bytes.subarray(0, copied));
      return received(copied, datagram.bytes.length, this.address(datagram.source));
    };
    const ready = attempt();
    if (ready !== null) return ready;
    if (this.nonblock || flags & MSG_DONTWAIT) return -E.AGAIN;
    return block(this, naming(fd, this), attempt, SO_RCVTIMEO);
  }
  poll(events: number): number {
    let ready = (this.error ? POLLERR : 0) | events & POLLOUT;
    if (this.queue.length) ready |= events & POLLIN;
    return ready;
  }
  available(): number { return this.readShut ? 0 : this.queue[0]?.bytes.length ?? 0; }
  close(): void {
    this.closed = true;
    UdpSocket.bound.delete(this);
    this.relay?.close();
    this.wake();
  }
  /** IP_ADD_MEMBERSHIP/MCAST_JOIN_GROUP and their drops: membership on this host's one interface */
  group(join: boolean, group: number[], ifindex: number): number {
    if (!isMulticast(group)) return -E.INVAL;
    if (ifindex && !INTERFACES.some((i) => i.index === ifindex)) return -E.NODEV;
    const key = addressKey(group);
    if (join) { if (this.groups.has(key)) return -E.ADDRINUSE; this.groups.add(key); }
    else if (!this.groups.delete(key)) return -E.ADDRNOTAVAIL;
    return 0;
  }
}
const datagramSource = (local: Endpoint): Endpoint => isAny(local.address) ? { address: V4_LOOPBACK, port: local.port } : local;

/** socket(AF_INET or AF_INET6, type, protocol) */
export function inetSocket(domain: typeof AF_INET | typeof AF_INET6, type: number, protocol: number): Socket | number {
  const kind = type & 0xf;
  if (kind !== SOCK_STREAM && kind !== SOCK_DGRAM) return -E.SOCKTNOSUPPORT;
  // an unprivileged ping socket: the relay cannot carry ICMP
  if (kind === SOCK_DGRAM && (protocol === IPPROTO_ICMP || protocol === IPPROTO_ICMPV6)) return -E.ACCES;
  if (protocol !== 0 && protocol !== (kind === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP)) return -E.PROTONOSUPPORT;
  return kind === SOCK_DGRAM ? new UdpSocket(domain) : new TcpSocket(domain);
}

/** A connection to this process's listener at `ep` from outside its descriptor table, as another
 *  process's client (the media server, WebView's network service) opens one; null when refused.
 *  Its ephemeral port stays taken until `close`. */
export function loopbackConnection(ep: Endpoint): { stream: Stream; close(): void } | null {
  const listener = listenerFor(ep);
  record(`connect host loopback :${ep.port} ${listener ? "accepted" : "refused"}`);
  if (!listener) return null;
  const [client, server] = Loopback.pair(), socket = TcpSocket.connected(listener.family, client, null, ep);
  if (socket.bindTo({ address: loopbackOf(ep), port: 0 })) return null;
  listener.backlog!.push(TcpSocket.connected(listener.family, server, ep, socket.local!));
  listener.wake();
  return { stream: client, close: () => { client.close(); TcpSocket.bound.delete(socket); } };
}

/** TLS on stream socket `fd` (TcpSocket.startTls) */
export function startTls(fd: number, host: string, port: number, alpn: string[]): PromiseOrVal<TlsResult> {
  const s = socketOf(fd);
  return s instanceof TcpSocket ? s.startTls(host, port, alpn) : { errno: typeof s === "number" ? -s : E.NOTSOCK, reason: "" };
}
