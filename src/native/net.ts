// Sockets, shared by bionic (native code) and libcore's Linux natives (Java): one descriptor
// namespace (fd.ts) and one socket model. A TCP connection to another host is a relay connection;
// TCP to a listener in this process and UDP between this process's sockets stay in the process.
// The core answers -errno and takes JS values; the kernel's socket calls (NET_SYSCALLS) and the
// ARM32 libc's resolver functions at the end adapt it to guest memory and errno.

import { ByteQueue, DatagramRelay, Relay, syntheticHost, ipv4Key, ipv4Text, parseIpv4 } from "../shell/relay";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { hostLib, PTR, stp, ldp, ldLong, stLong, type HostFn, type HostRet, ptr } from "./host";
import { mem, anchor } from "./mem";
import { fail } from "./libc";
import { allocateFd, releaseFd } from "./fd";
import {
  unixSocket, isUnixSocket, unixBind, unixListen, unixAccept, unixSocketName, unixSocketOption, unixSetOption, unixSend, unixReceive, gather, openFd,
  javaShutdownFd, fdRead, fdWrite, brokenPipe, installPassed, releasePassed, processCredentials, unixPeerCredentials, unixPassesCredentials, type Received,
} from "./fs";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock";
import { unixAt, unixConnectPath, sockaddrUn, sunPath } from "./unix";
import {
  AF_UNSPEC, AF_UNIX, AF_INET, AF_INET6, AI_NUMERICHOST, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME,
  V4_ANY, V4_LOOPBACK, V6_LOOPBACK, isAny, isLoopback, isMulticast, sameAddress, addressKey,
  endpointOf, parseIpv6, addressText, resolveHost, hostOf, gaiText, INTERFACES, type Endpoint,
} from "./net-address";
const enc = new TextEncoder();

const SOCK_STREAM = 1, SOCK_DGRAM = 2, IPPROTO_ICMP = 1, IPPROTO_TCP = 6, IPPROTO_UDP = 17, IPPROTO_ICMPV6 = 58;
const SOCK_NONBLOCK = 0x800, SOCK_CLOEXEC = 0x80000;
const F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
const O_RDWR = 2, O_NONBLOCK = 0x800;
export const SOL_SOCKET = 1, IPPROTO_IP = 0, IPPROTO_IPV6 = 41;
const SO_REUSEADDR = 2, SO_TYPE = 3, SO_ERROR = 4, SO_BROADCAST = 6, SO_SNDBUF = 7, SO_RCVBUF = 8, SO_LINGER = 13;
const SO_RCVTIMEO = 20, SO_SNDTIMEO = 21, SO_ACCEPTCONN = 30, SO_PROTOCOL = 38, SO_DOMAIN = 39;
const TCP_NODELAY = 1, IP_TOS = 1, IP_TTL = 2, IP_MULTICAST_IF = 32, IP_MULTICAST_TTL = 33, IP_MULTICAST_LOOP = 34;
const IP_ADD_MEMBERSHIP = 35, IP_DROP_MEMBERSHIP = 36, IP_MULTICAST_ALL = 49, MCAST_JOIN_GROUP = 42, MCAST_LEAVE_GROUP = 45;
const IPV6_UNICAST_HOPS = 16, IPV6_MULTICAST_IF = 17, IPV6_MULTICAST_HOPS = 18, IPV6_MULTICAST_LOOP = 19, IPV6_V6ONLY = 26, IPV6_TCLASS = 67;
export const POLLIN = 1, POLLPRI = 2, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32, POLLRDHUP = 0x2000;
const AI_PASSIVE = 1, AI_CANONNAME = 2, AI_NUMERICSERV = 8, AI_ADDRCONFIG = 0x400;
const EAI_BADFLAGS = 3, EAI_FAMILY = 5;
const EAI_SERVICE = 9, EAI_SOCKTYPE = 10, EAI_SYSTEM = 11, EAI_PROTOCOL = 13, EAI_OVERFLOW = 14;
export const MSG_PEEK = 0x2, MSG_TRUNC = 0x20, MSG_DONTWAIT = 0x40;
const MSG_CTRUNC = 0x8, MSG_CMSG_CLOEXEC = 0x40000000, SO_PEERCRED = 17, SCM_RIGHTS = 1, SCM_CREDENTIALS = 2;
const SHUT_RD = 0, SHUT_WR = 1, SHUT_RDWR = 2;
const UDP_MAX_PAYLOAD = 65_507;
const UDP_QUEUE_PACKETS = 256, UDP_QUEUE_BYTES = 1 << 20;
// Linux's buffer sizing (measured on the reference device): a set value is doubled, with a floor
const RCVBUF_MIN = 2304, SNDBUF_MIN = 4608;

// ── byte streams: a relay connection, or one end of an in-process loopback connection
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
class Loopback implements Stream {
  readonly q = new ByteQueue();
  eof = false;
  closed = false;
  peer!: Loopback;
  private readonly waiters = new Set<() => void>();
  static pair(): [Loopback, Loopback] {
    const a = new Loopback(), b = new Loopback();
    a.peer = b; b.peer = a;
    return [a, b];
  }
  available(): number { return this.q.length; }
  take(out: Uint8Array, off: number, len: number, peek = false): number { return this.q.take(out, off, len, peek); }
  write(bytes: Uint8Array): boolean {
    if (this.closed || this.peer.closed) return false;
    this.peer.q.push(bytes.slice());
    this.peer.wake();
    return true;
  }
  subscribe(waiter: () => void): () => void { this.waiters.add(waiter); return () => this.waiters.delete(waiter); }
  wake(): void { const ws = [...this.waiters]; this.waiters.clear(); for (const w of ws) w(); }
  shutdownWrite(): void { this.peer.eof = true; this.peer.wake(); }
  close(): void {
    this.closed = this.eof = true;
    this.shutdownWrite();
    this.wake();
  }
}

// ── sockets
interface SocketState {
  family: number;
  protocol: number;
  nonblock: boolean;
  connected: boolean;
  error: number;
  waiters: Set<() => void>;
  references: number;
  peer: Endpoint | null;
  local: Endpoint | null;
  /** setsockopt values by level << 16 | option */
  options: Map<number, number>;
  readShut: boolean;
  writeShut: boolean;
}
interface StreamSocket extends SocketState {
  kind: "stream";
  stream: Stream | null;
  connecting: boolean;
  /** a listening socket's connections not yet accepted */
  backlog: StreamSocket[] | null;
}
interface Datagram { bytes: Uint8Array; source: Endpoint }
interface DatagramSocket extends SocketState {
  kind: "datagram";
  relay: DatagramRelay | null;
  queue: Datagram[];
  queuedBytes: number;
  groups: Set<string>;
}
type Socket = StreamSocket | DatagramSocket;
interface SocketFd { socket: Socket; cloexec: boolean }

const sockets = new Map<number, SocketFd>();
const bound = { stream: new Set<StreamSocket>(), datagram: new Set<DatagramSocket>() };
let nextEphemeral = 32_768;
export const netDebug = { events: [] as string[] };
function record(event: string): void {
  netDebug.events.push(event);
  if (netDebug.events.length > 100) netDebug.events.shift();
}
interface NativePollProvider {
  query(fd: number, events: number): number | null;
  subscribe(fd: number, wake: () => void): () => void;
}
let localPollProvider: NativePollProvider | null = null;
export function setNativePollProvider(provider: NativePollProvider): void {
  localPollProvider = provider;
}

function wake(socket: Socket): void {
  const waiters = [...socket.waiters];
  socket.waiters.clear();
  for (const waiter of waiters) waiter();
}
export const isNativeSocket = (fd: number): boolean => sockets.has(fd);
const socketOf = (fd: number): Socket | null => sockets.get(fd)?.socket ?? null;
const optionKey = (level: number, option: number) => level << 16 | option;
const option = (socket: Socket, level: number, name: number, fallback = 0) => socket.options.get(optionKey(level, name)) ?? fallback;
const timeoutOf = (socket: Socket, name: number) => option(socket, SOL_SOCKET, name);

/** Wait until `attempt` answers (anything but null), the socket's `timeoutOption` (SO_RCVTIMEO or
 *  SO_SNDTIMEO) elapses (EAGAIN) or the descriptor closes (EBADF). */
function block<T>(fd: number, socket: Socket, attempt: () => T | null, timeoutOption: number): Promise<T | number> {
  return new Promise((resolve) => {
    const ms = timeoutOf(socket, timeoutOption);
    let timer: GuestTimer | undefined, unsubscribe: (() => void) | undefined;
    const done = (value: T | number) => { clearGuestTimeout(timer); unsubscribe?.(); resolve(value); };
    const retry = () => {
      unsubscribe?.(); unsubscribe = undefined;
      if (sockets.get(fd)?.socket !== socket) return done(-E.BADF);
      const result = attempt();
      if (result !== null) return done(result);
      unsubscribe = watchSocket(socket, retry);
    };
    if (ms > 0) timer = setGuestTimeout(() => done(-E.AGAIN), ms);
    unsubscribe = watchSocket(socket, retry);
  });
}
function watchSocket(socket: Socket, waiter: () => void): () => void {
  socket.waiters.add(waiter);
  const stream = socket.kind === "stream" ? socket.stream?.subscribe(waiter) : undefined;
  return () => { socket.waiters.delete(waiter); stream?.(); };
}

export function socketCreate(domain: number, type: number, protocol: number): number {
  const kind = type & 0xf;
  if (domain !== AF_INET && domain !== AF_INET6) return -E.AFNOSUPPORT;
  if (kind !== SOCK_STREAM && kind !== SOCK_DGRAM) return -E.SOCKTNOSUPPORT;
  // an unprivileged ping socket: the relay cannot carry ICMP
  if (kind === SOCK_DGRAM && (protocol === IPPROTO_ICMP || protocol === IPPROTO_ICMPV6)) return -E.ACCES;
  const expected = kind === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP;
  if (protocol !== 0 && protocol !== expected) return -E.PROTONOSUPPORT;
  const common: SocketState = {
    family: domain, protocol: expected, nonblock: !!(type & SOCK_NONBLOCK), connected: false, error: 0,
    waiters: new Set(), references: 1, peer: null, local: null, options: new Map(), readShut: false, writeShut: false,
  };
  const socket: Socket = kind === SOCK_DGRAM
    ? { ...common, kind: "datagram", relay: null, queue: [], queuedBytes: 0, groups: new Set() }
    : { ...common, kind: "stream", stream: null, connecting: false, backlog: null };
  const fd = allocateFd();
  sockets.set(fd, { cloexec: !!(type & SOCK_CLOEXEC), socket });
  record(`socket fd=${fd} family=${domain} type=${type.toString(16)} protocol=${protocol}`);
  return fd;
}

/** EAFNOSUPPORT for an IPv6 address on an IPv4 socket (libcore retries IPv4-mapped ones as IPv4);
 *  ENETUNREACH for an IPv4(-mapped) one on an IPV6_V6ONLY socket */
const familyError = (socket: Socket, ep: Endpoint) => socket.family === AF_INET && ep.address.length === 16 ? -E.AFNOSUPPORT
  : socket.family === AF_INET6 && ep.address.length === 4 && option(socket, IPPROTO_IPV6, IPV6_V6ONLY) ? -E.NETUNREACH : 0;

function portTaken(socket: Socket, ep: Endpoint): boolean {
  const set: Set<Socket> = bound[socket.kind];
  for (const other of set) {
    const local = other.local!;
    if (other === socket || local.port !== ep.port) continue;
    const overlap = isAny(local.address) || isAny(ep.address) || sameAddress(local.address, ep.address);
    const shared = option(socket, SOL_SOCKET, SO_REUSEADDR) && option(other, SOL_SOCKET, SO_REUSEADDR) &&
      (other.kind === "datagram" || !other.backlog);
    if (overlap && !shared) return true;
  }
  return false;
}
function bindTo(socket: Socket, ep: Endpoint): number {
  if (socket.local) return -E.INVAL;
  const error = familyError(socket, ep);
  if (error) return error === -E.NETUNREACH ? -E.INVAL : error;
  if (!isAny(ep.address) && !isLoopback(ep.address) && !isMulticast(ep.address)) return -E.ADDRNOTAVAIL;
  let port = ep.port;
  if (!port) {
    for (let tries = 0; tries < 28_232 && !port; tries++) {
      const candidate = nextEphemeral++;
      if (nextEphemeral > 60_999) nextEphemeral = 32_768;
      if (!portTaken(socket, { address: ep.address, port: candidate })) port = candidate;
    }
    if (!port) return -E.ADDRINUSE;
  } else if (portTaken(socket, ep)) return -E.ADDRINUSE;
  socket.local = { address: ep.address, port };
  (bound[socket.kind] as Set<Socket>).add(socket);
  return 0;
}
export function socketBind(fd: number, ep: Endpoint): number {
  const socket = socketOf(fd);
  return socket ? bindTo(socket, ep) : -E.BADF;
}
const anyFor = (socket: Socket): number[] => socket.family === AF_INET6 ? new Array(16).fill(0) : V4_ANY;

export function socketListen(fd: number): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind !== "stream") return -E.NOTSUP;
  if (socket.connected || socket.connecting) return -E.INVAL;
  if (!socket.local) { const r = bindTo(socket, { address: anyFor(socket), port: 0 }); if (r) return r; }
  socket.backlog ??= [];
  return 0;
}

function listenerFor(ep: Endpoint): StreamSocket | null {
  for (const s of bound.stream) {
    if (!s.backlog || s.local!.port !== ep.port) continue;
    const local = s.local!.address;
    if (s.family === AF_INET && ep.address.length === 16) continue;
    if (s.family === AF_INET6 && ep.address.length === 4 && option(s, IPPROTO_IPV6, IPV6_V6ONLY)) continue;
    if (sameAddress(local, ep.address) || isAny(local)) return s;
  }
  return null;
}
function newStreamSocket(family: number, stream: Stream, local: Endpoint | null, peer: Endpoint): StreamSocket {
  return {
    family, protocol: IPPROTO_TCP, nonblock: false, connected: true, error: 0, waiters: new Set(), references: 1,
    peer, local, options: new Map(), kind: "stream", stream, connecting: false, backlog: null, readShut: false, writeShut: false,
  };
}
/** the errno a relay's failure reason stands for; no reason at all is no relay to reach */
function connectErrno(reason: string): number {
  if (!reason) return E.NETUNREACH;
  if (/ETIMEDOUT|timed out/i.test(reason)) return E.TIMEDOUT;
  if (/ENETUNREACH/.test(reason)) return E.NETUNREACH;
  if (/EHOSTUNREACH/.test(reason)) return E.HOSTUNREACH;
  return E.CONNREFUSED;
}

/** connect(2); `ep` null is AF_UNSPEC, which dissolves a datagram socket's association */
export function socketConnect(fd: number, ep: Endpoint | null): number | Promise<number> {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind === "datagram") {
    if (!ep) { socket.peer = null; socket.connected = false; return 0; }
    const error = familyError(socket, ep) || (ep.address.length === 16 && !isLoopback(ep.address) && !isAny(ep.address) && !isMulticast(ep.address) ? -E.NETUNREACH : 0); // no IPv6 route, as send finds
    if (error) return error;
    if (!socket.local) { const r = bindTo(socket, { address: anyFor(socket), port: 0 }); if (r) return r; }
    socket.peer = ep;
    socket.connected = true;
    return 0;
  }
  if (!ep) return -E.AFNOSUPPORT;
  if (socket.connected) return -E.ISCONN;
  if (socket.connecting) return -E.ALREADY;
  if (socket.backlog) return -E.INVAL;
  const error = familyError(socket, ep);
  if (error) return error;
  // Linux connects an unspecified address to the loopback one
  const target: Endpoint = isAny(ep.address) ? { address: ep.address.length === 4 ? V4_LOOPBACK : V6_LOOPBACK, port: ep.port } : ep;
  socket.peer = target;
  if (isLoopback(target.address)) {
    if (!socket.local || !socket.local.port) {
      if (socket.local) bound.stream.delete(socket);
      socket.local = null;
      const r = bindTo(socket, { address: target.address.length === 4 ? V4_LOOPBACK : V6_LOOPBACK, port: 0 });
      if (r) return r;
    }
    if (isAny(socket.local!.address)) socket.local = { address: target.address.length === 4 ? V4_LOOPBACK : V6_LOOPBACK, port: socket.local!.port };
    const listener = listenerFor(target);
    record(`connect fd=${fd} loopback :${target.port} ${listener ? "accepted" : "refused"}`);
    if (!listener) {
      if (!socket.nonblock) return -E.CONNREFUSED;
      socket.error = E.CONNREFUSED;
      return -E.INPROGRESS;
    }
    const [client, server] = Loopback.pair();
    socket.stream = client;
    socket.connected = true;
    listener.backlog!.push(newStreamSocket(listener.family, server, { address: target.address, port: target.port }, socket.local!));
    wake(listener);
    return socket.nonblock ? -E.INPROGRESS : 0;
  }
  const host = target.address.length === 4 ? syntheticHost(target.address) ?? ipv4Text(target.address) : addressText(target.address);
  record(`connect fd=${fd} ${host}:${target.port} nonblock=${socket.nonblock}`);
  const relay = new Relay(host, target.port, false);
  socket.stream = relay;
  socket.connecting = true;
  const completion = relay.ready.then(() => {
    socket.connecting = false;
    socket.connected = true;
    const local = relay.localEndpoint;
    const address = local?.family === "IPv4" ? parseIpv4(local.address) : local ? parseIpv6(local.address) : null;
    if (local && address && (!socket.local || isAny(socket.local.address))) socket.local = endpointOf(address, local.port);
    record(`connected fd=${fd}`);
    wake(socket);
    return 0;
  }, () => {
    socket.connecting = false;
    socket.stream = null;
    socket.error = connectErrno(relay.failure);
    record(`connect failed fd=${fd} errno=${socket.error} ${relay.failure}`);
    wake(socket);
    return -socket.error;
  });
  if (socket.nonblock) return -E.INPROGRESS;
  return completion.then((r) => { if (r) socket.error = 0; return r; });
}

/** A connection to this process's listener at `ep` from outside its descriptor table, as another
 *  process's client (the media server, WebView's network service) opens one; null when refused.
 *  Its ephemeral port stays taken until `close`. */
export function loopbackConnection(ep: Endpoint): { stream: Stream; close(): void } | null {
  const listener = listenerFor(ep);
  record(`connect host loopback :${ep.port} ${listener ? "accepted" : "refused"}`);
  if (!listener) return null;
  const [client, server] = Loopback.pair(), socket = newStreamSocket(listener.family, client, null, ep);
  if (bindTo(socket, { address: ep.address.length === 4 ? V4_LOOPBACK : V6_LOOPBACK, port: 0 })) return null;
  listener.backlog!.push(newStreamSocket(listener.family, server, ep, socket.local!));
  wake(listener);
  return { stream: client, close: () => { client.close(); bound.stream.delete(socket); } };
}

/** accept(2): the new descriptor and its peer */
export function socketAccept(fd: number, nonblock = false): { fd: number; peer: Endpoint } | number | Promise<{ fd: number; peer: Endpoint } | number> {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind !== "stream") return -E.NOTSUP;
  if (!socket.backlog) return -E.INVAL;
  const attempt = () => {
    const accepted = socket.backlog!.shift();
    if (!accepted) return null;
    const child = allocateFd();
    sockets.set(child, { socket: accepted, cloexec: false });
    bound.stream.add(accepted);
    record(`accept fd=${fd} -> ${child}`);
    return { fd: child, peer: accepted.peer! };
  };
  const ready = attempt();
  if (ready) return ready;
  if (socket.nonblock || nonblock) return -E.AGAIN;
  return block(fd, socket, attempt, SO_RCVTIMEO);
}

export function socketShutdown(fd: number, how: number): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (how !== SHUT_RD && how !== SHUT_WR && how !== SHUT_RDWR) return -E.INVAL;
  if (!socket.connected) return socket.kind === "stream" && socket.backlog ? 0 : -E.NOTCONN;
  if (how !== SHUT_WR) socket.readShut = true;
  if (how !== SHUT_RD && !socket.writeShut) { socket.writeShut = true; if (socket.kind === "stream") socket.stream?.shutdownWrite(); }
  wake(socket);
  return 0;
}

function datagramRecipients(sender: DatagramSocket, destination: Endpoint): DatagramSocket[] {
  const loopback = isLoopback(destination.address), multicast = isMulticast(destination.address);
  const source = sender.local ? datagramSource(sender.local) : null;
  const recipients: DatagramSocket[] = [];
  for (const candidate of bound.datagram) {
    const local = candidate.local!;
    if (local.port !== destination.port) continue;
    if (candidate.family === AF_INET && destination.address.length === 16) continue;
    const addressMatches = multicast
      ? candidate.groups.has(addressKey(destination.address)) && (candidate !== sender || !!option(sender, IPPROTO_IP, IP_MULTICAST_LOOP, 1))
      : sameAddress(local.address, destination.address) || loopback && isAny(local.address);
    const peerMatches = !candidate.peer || !!source && candidate.peer.port === source.port && sameAddress(candidate.peer.address, source.address);
    if (addressMatches && peerMatches) recipients.push(candidate);
  }
  return recipients;
}
const datagramSource = (local: Endpoint): Endpoint => isAny(local.address) ? { address: V4_LOOPBACK, port: local.port } : local;

function queueDatagram(socket: DatagramSocket, bytes: Uint8Array, source: Endpoint): void {
  if (!socket.references || socket.queue.length >= UDP_QUEUE_PACKETS || socket.queuedBytes + bytes.length > UDP_QUEUE_BYTES) return;
  const peer = socket.peer;
  if (peer && (peer.port !== source.port || !sameAddress(peer.address, source.address))) return;
  socket.queue.push({ bytes, source });
  socket.queuedBytes += bytes.length;
  wake(socket);
}

/** send(2)/sendto(2)/write(2) of `bytes`; `destination` only for an unconnected datagram socket */
export function socketSend(fd: number, bytes: Uint8Array, destination: Endpoint | null = null): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind === "stream") {
    if (destination) return socket.connected ? -E.ISCONN : -E.NOTCONN;
    if (socket.writeShut) return -E.PIPE;
    if (!socket.connected || !socket.stream) return -(socket.error || E.NOTCONN);
    if (!bytes.length) return 0;
    return socket.stream.write(bytes) ? bytes.length : -E.PIPE;
  }
  if (socket.writeShut) return -E.PIPE;
  if (bytes.length > UDP_MAX_PAYLOAD) return -E.MSGSIZE;
  const endpoint = destination ?? socket.peer;
  if (!endpoint) return -E.DESTADDRREQ;
  const error = familyError(socket, endpoint);
  if (error) return error;
  if (!endpoint.port) return -E.INVAL;
  if (endpoint.address.length === 4 && ipv4Key(endpoint.address) === 0xffffffff && !option(socket, SOL_SOCKET, SO_BROADCAST)) return -E.ACCES;
  if (!socket.local) { const r = bindTo(socket, { address: anyFor(socket), port: 0 }); if (r) return r; }
  const recipients = datagramRecipients(socket, endpoint);
  const copy = bytes.slice();
  for (const recipient of recipients) queueDatagram(recipient, copy, datagramSource(socket.local!));
  if (!isLoopback(endpoint.address) && !recipients.length) {
    if (endpoint.address.length === 16) return -E.NETUNREACH;
    const relay = socket.relay ??= new DatagramRelay((packet, address, port) => {
      queueDatagram(socket, packet, { address, port });
    });
    void relay.send(syntheticHost(endpoint.address) ?? ipv4Text(endpoint.address), endpoint.port, copy).catch(() => {
      socket.error = E.NETUNREACH;
      relay.close();
      if (socket.relay === relay) socket.relay = null;
      wake(socket);
    });
  }
  return bytes.length;
}

/** recv(2)/recvfrom(2)/read(2) into `target`; a datagram's sender is left in `from.source` */
export function socketReceive(fd: number, target: Uint8Array, flags = 0, from?: { source: Endpoint | null }): number | Promise<number> {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind === "stream") {
    if (from) from.source = null;
    if (socket.readShut) return 0;
    if (!socket.stream) return -(socket.error || E.NOTCONN);
    const stream = socket.stream;
    const attempt = () => stream.available() ? stream.take(target, 0, target.length, !!(flags & MSG_PEEK)) : stream.eof ? 0 : null;
    if (!target.length) return 0;
    const ready = attempt();
    if (ready !== null) return ready;
    if (!socket.connected && !socket.connecting) return -(socket.error || E.NOTCONN);
    if (socket.nonblock || flags & MSG_DONTWAIT) return -E.AGAIN;
    return block(fd, socket, attempt, SO_RCVTIMEO);
  }
  if (socket.readShut) return 0;
  const attempt = (): number | null => {
    const datagram = socket.queue[0];
    if (!datagram) { if (socket.error) { const e = socket.error; socket.error = 0; return -e; } return null; }
    if (!(flags & MSG_PEEK)) { socket.queue.shift(); socket.queuedBytes -= datagram.bytes.length; }
    const copied = Math.min(target.length, datagram.bytes.length);
    target.set(datagram.bytes.subarray(0, copied));
    if (from) from.source = datagram.source;
    return flags & MSG_TRUNC ? datagram.bytes.length : copied;
  };
  const ready = attempt();
  if (ready !== null) return ready;
  if (socket.nonblock || flags & MSG_DONTWAIT) return -E.AGAIN;
  return block(fd, socket, attempt, SO_RCVTIMEO);
}

/** getsockname(2)/getpeername(2) */
export function socketName(fd: number, peer: boolean): Endpoint | number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (peer) return socket.connected && socket.peer ? socket.peer : -E.NOTCONN;
  return socket.local ?? { address: anyFor(socket), port: 0 };
}

/** getsockopt(2) for an int-valued option */
export function socketOption(fd: number, level: number, name: number): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  const stream = socket.kind === "stream";
  const stored = socket.options.get(optionKey(level, name));
  if (level === SOL_SOCKET) {
    switch (name) {
      case SO_TYPE: return stream ? SOCK_STREAM : SOCK_DGRAM;
      case SO_ERROR: { const e = socket.error; socket.error = 0; return e; }
      case SO_DOMAIN: return socket.family;
      case SO_PROTOCOL: return socket.protocol;
      case SO_ACCEPTCONN: return +(stream && !!socket.backlog);
      case SO_RCVBUF: return stored ?? (stream ? 1_048_576 : 229_376);
      case SO_SNDBUF: return stored ?? (stream ? socket.connected ? 1_048_576 : 524_288 : 229_376);
      case SO_REUSEADDR: case SO_BROADCAST: case 9 /* SO_KEEPALIVE */: case 10 /* SO_OOBINLINE */: case 5 /* SO_DONTROUTE */:
      case SO_RCVTIMEO: case SO_SNDTIMEO: case SO_LINGER:
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
  if (level === IPPROTO_IPV6 && socket.family === AF_INET6) {
    switch (name) {
      case IPV6_TCLASS: case IPV6_MULTICAST_IF: case IPV6_V6ONLY: return stored ?? 0;
      case IPV6_UNICAST_HOPS: return stored ?? 64;
      case IPV6_MULTICAST_HOPS: case IPV6_MULTICAST_LOOP: return stored ?? 1;
    }
  }
  return -E.NOPROTOOPT;
}
/** setsockopt(2) for an int-valued option (SO_LINGER takes the seconds, -1 for off, and reads back
 *  as seconds + 1, 0 for off; the timeouts are ms) */
export function setSocketOption(fd: number, level: number, name: number, value: number): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (level === SOL_SOCKET && (name === SO_TYPE || name === SO_ERROR || name === SO_DOMAIN || name === SO_PROTOCOL || name === SO_ACCEPTCONN)) return -E.NOPROTOOPT;
  const current = socketOption(fd, level, name);
  if (current < 0) return current;
  let stored = value;
  if (level === SOL_SOCKET && name === SO_RCVBUF) stored = Math.max(2 * Math.max(0, value), RCVBUF_MIN);
  else if (level === SOL_SOCKET && name === SO_SNDBUF) stored = Math.max(2 * Math.max(0, value), SNDBUF_MIN);
  else if (level === SOL_SOCKET && name === SO_LINGER) stored = value < 0 ? 0 : Math.min(value, 65535) + 1;
  else if (level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO)) stored = Math.max(0, value);
  else if (level === IPPROTO_IP && (name === IP_TTL || name === IP_MULTICAST_TTL) && (value < -1 || value > 255 || name === IP_TTL && value === 0)) return -E.INVAL;
  else if (!(level === IPPROTO_IP && (name === IP_TOS || name === IP_TTL || name === IP_MULTICAST_TTL || name === IP_MULTICAST_IF)) &&
    !(level === IPPROTO_IPV6 && (name === IPV6_TCLASS || name === IPV6_UNICAST_HOPS || name === IPV6_MULTICAST_HOPS || name === IPV6_MULTICAST_IF))) stored = value ? 1 : 0;
  if (level === IPPROTO_IP && name === IP_TOS) stored &= 0xfc;
  socket.options.set(optionKey(level, name), stored);
  return 0;
}
/** IP_ADD_MEMBERSHIP/MCAST_JOIN_GROUP and their drops: membership on this host's one interface */
export function socketGroup(fd: number, join: boolean, group: number[], ifindex: number): number {
  const socket = socketOf(fd);
  if (!socket) return -E.BADF;
  if (socket.kind !== "datagram") return -E.PROTONOSUPPORT;
  if (!isMulticast(group)) return -E.INVAL;
  if (ifindex && !INTERFACES.some((i) => i.index === ifindex)) return -E.NODEV;
  const key = addressKey(group);
  if (join) { if (socket.groups.has(key)) return -E.ADDRINUSE; socket.groups.add(key); }
  else if (!socket.groups.delete(key)) return -E.ADDRNOTAVAIL;
  return 0;
}
export const GROUP_OPTIONS = { IP_ADD_MEMBERSHIP, IP_DROP_MEMBERSHIP, MCAST_JOIN_GROUP, MCAST_LEAVE_GROUP };

export function nativeSocketIoctl(cpu: Cpu, fd: number, request: number, argument: number): number {
  if (!sockets.has(fd)) return fail(cpu, E.BADF);
  if (request !== 0x541b) return fail(cpu, E.NOTTY);
  if (!argument) return fail(cpu, E.FAULT);
  mem.st32(argument, nativeSocketAvailable(fd));
  return 0;
}
/** FIONREAD on an open socket: a stream's buffered bytes, a datagram socket's next packet */
export function nativeSocketAvailable(fd: number): number {
  const socket = sockets.get(fd)!.socket;
  if (socket.readShut) return 0;
  return socket.kind === "stream" ? socket.stream?.available() ?? 0 : socket.queue[0]?.bytes.length ?? 0;
}

export function socketClose(fd: number): number {
  const descriptor = sockets.get(fd);
  if (!descriptor) return -E.BADF;
  const socket = descriptor.socket;
  sockets.delete(fd);
  releaseFd(fd);
  releaseSocket(socket);
  return 0;
}
export const nativeSocketClose = (cpu: Cpu | null, fd: number): number => sys(cpu, socketClose(fd));

/** The TLS relay replaces a plain connection a TLS socket wraps: the plain one's relay goes, and
 *  its descriptor reads end of stream. */
export function abandonConnection(fd: number): void {
  const socket = socketOf(fd);
  if (socket?.kind === "stream" && socket.stream instanceof Relay) { socket.stream.close(); wake(socket); }
}

/** a descriptor for the socket at the lowest free number at or above `min` */
export function nativeSocketDup(cpu: Cpu | null, fd: number, min = 0, cloexec = false): number {
  const descriptor = sockets.get(fd);
  if (!descriptor) return fail(cpu, E.BADF);
  const duplicate = allocateFd(min);
  descriptor.socket.references++;
  sockets.set(duplicate, { socket: descriptor.socket, cloexec });
  return duplicate;
}

/** SCM_RIGHTS's hold on a socket while a message carries it: one more reference, installed at the
 *  lowest free number when the message is read, or released */
export type NetSocket = Socket;
export const heldSocket = (fd: number): NetSocket | null => socketOf(fd);
export const retainSocket = (socket: NetSocket): NetSocket => { socket.references++; return socket; };
export function installSocket(socket: NetSocket, cloexec: boolean): number {
  const fd = allocateFd();
  sockets.set(fd, { socket, cloexec });
  return fd;
}
export function releaseSocket(socket: NetSocket): void {
  if (--socket.references === 0) {
    (bound[socket.kind] as Set<Socket>).delete(socket);
    if (socket.kind === "stream") {
      socket.stream?.close();
      for (const pending of socket.backlog?.splice(0) ?? []) pending.stream?.close();
    } else socket.relay?.close();
  }
  wake(socket);
}

export function nativeSocketFcntl(cpu: Cpu | null, fd: number, command: number, value: number): number {
  const descriptor = sockets.get(fd);
  if (!descriptor) return fail(cpu, E.BADF);
  const socket = descriptor.socket;
  if (command === F_GETFD) return descriptor.cloexec ? 1 : 0;
  if (command === F_SETFD) { descriptor.cloexec = !!(value & 1); return 0; }
  if (command === F_GETFL) return O_RDWR | (socket.nonblock ? O_NONBLOCK : 0);
  if (command === F_SETFL) { socket.nonblock = !!(value & O_NONBLOCK); return 0; }
  return fail(cpu, E.INVAL);
}

/** a result as libc returns it: -1 and errno for a native caller, -errno as it is for Java */
function sys(cpu: Cpu | null, r: number): number { return r < 0 ? fail(cpu, -r) : r; }
function sysAsync(cpu: Cpu | null, r: number | Promise<number>): number | Promise<number> {
  return r instanceof Promise ? r.then((x) => sys(cpu, x)) : sys(cpu, r);
}

export function nativeSocketRead(cpu: Cpu | null, fd: number, destination: number, length: number): number | Promise<number> {
  return nativeReceive(cpu, fd, [guestBuffer(destination, length)], 0);
}
export function nativeSocketWrite(cpu: Cpu, fd: number, source: number, length: number, flags = 0): number {
  const r = socketSend(fd, mem.u8.subarray(source, source + length));
  return r === -E.PIPE && socketOf(fd)?.kind === "stream" ? brokenPipe(cpu, flags) : sys(cpu, r);
}

export function nativePollEvents(fd: number, events: number): number {
  const socket = sockets.get(fd)?.socket;
  if (!socket) return localPollProvider?.query(fd, events) ?? POLLNVAL;
  let ready = socket.error ? POLLERR : 0;
  if (socket.kind === "datagram") {
    ready |= events & POLLOUT;
    if (socket.queue.length) ready |= events & POLLIN;
  } else if (socket.backlog) {
    if (socket.backlog.length) ready |= events & POLLIN;
  } else {
    const stream = socket.stream;
    if (socket.connected && !socket.writeShut) ready |= events & POLLOUT;
    if (socket.readShut || stream && (stream.available() || stream.eof)) ready |= events & POLLIN;
    if (stream?.eof) ready |= events & POLLRDHUP;
    if (stream?.eof && socket.writeShut || socket.error) ready |= POLLHUP | events & POLLOUT;
  }
  return ready;
}
export function watchNativeFd(fd: number, wake: () => void): () => void {
  const socket = sockets.get(fd)?.socket;
  return socket ? watchSocket(socket, wake) : localPollProvider?.subscribe(fd, wake) ?? (() => {});
}

export interface PollEntry { fd: number; events: number; revents: number }
/** poll(2) over any descriptors: the number ready, once one is or `timeout` ms pass (-1: forever) */
export function pollEntries(entries: PollEntry[], timeout: number, signal?: AbortSignal): number | Promise<number> {
  const scan = () => {
    let ready = 0;
    for (const e of entries) { e.revents = e.fd < 0 ? 0 : nativePollEvents(e.fd, e.events); if (e.revents) ready++; }
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
    for (const e of entries) if (e.fd >= 0) cleanups.push(watchNativeFd(e.fd, finish));
    if (signal) { signal.addEventListener("abort", finish, { once: true }); cleanups.push(() => signal.removeEventListener("abort", finish)); }
    if (timeout >= 0) timer = setGuestTimeout(finish, timeout);
  });
}

// ── bionic's socket functions over guest memory

/** a sockaddr_in or sockaddr_in6 for a socket of `family`, or -errno: a datagram an AF_INET6 socket
 *  sends may name an IPv4 destination, which it reaches as IPv4-mapped */
function sockaddrEndpoint(family: number, sockaddr: number, length: number, send = false): Endpoint | number {
  const given = sockaddr && length >= 2 ? mem.ld16u(sockaddr) : -1;
  if (length < (given === AF_INET ? 16 : given === AF_INET6 ? 24 : 2)) return -E.INVAL;
  if (given !== family && !(send && family === AF_INET6 && given === AF_INET)) return -E.AFNOSUPPORT;
  const port = (mem.u8[sockaddr + 2] << 8) | mem.u8[sockaddr + 3];
  return given === AF_INET ? { port, address: Array.from(mem.bytes(sockaddr + 4, 4)) }
    : endpointOf(mem.bytes(sockaddr + 8, 16), port, length >= 28 ? mem.ld32(sockaddr + 24) : 0);
}
function readEndpoint(cpu: Cpu, fd: number, sockaddr: number, length: number, send = false): Endpoint | null {
  const ep = sockaddrEndpoint(socketOf(fd)!.family, sockaddr, length, send);
  if (typeof ep === "number") { fail(cpu, -ep); return null; }
  return ep;
}
/** an endpoint as a sockaddr of `family`: an AF_INET6 socket's IPv4 endpoint is IPv4-mapped */
export function sockaddrOf(family: number, { port, address, scope = 0 }: Endpoint): Uint8Array {
  if (family !== AF_INET6) return Uint8Array.of(AF_INET, 0, port >>> 8, port & 255, ...(address.length === 4 ? address : [0, 0, 0, 0]), 0, 0, 0, 0, 0, 0, 0, 0);
  const sockaddr = Uint8Array.of(AF_INET6, 0, port >>> 8, port & 255, 0, 0, 0, 0, ...new Array(20).fill(0));
  if (address.length === 4) sockaddr.set([255, 255, ...address], 18); else sockaddr.set(address, 8);
  new DataView(sockaddr.buffer).setUint32(24, scope, true);
  return sockaddr;
}
/** an address result: as much of `sockaddr` as `capacity` holds, and its whole length */
function putSockaddr(sockaddr: Uint8Array, address: number, length: number, capacity: number): void {
  if (capacity > 0) mem.write(address, sockaddr.subarray(0, Math.min(capacity, sockaddr.length)));
  mem.st32(length, sockaddr.length);
}

/** the ARM32 struct ifaddrs: its size and the offsets of what getifaddrs fills */
const IFADDRS = { size: 28, name: 4, flags: 8, addr: 12, netmask: 16 };
function nativeGetifaddrs(cpu: Cpu, result: number): number {
  if (!result) return fail(cpu, E.FAULT);
  const size = IFADDRS.size;
  const entry = mem.malloc(size + 35);
  if (!entry) return fail(cpu, E.NOMEM);
  mem.memset(entry, 0, size + 35);
  const lo = INTERFACES[0], address = entry + size, netmask = address + 16, name = netmask + 16;
  stp(entry + IFADDRS.name, name);
  mem.st32(entry + IFADDRS.flags, lo.flags);
  stp(entry + IFADDRS.addr, address);
  stp(entry + IFADDRS.netmask, netmask);
  mem.st16(address, AF_INET); mem.u8.set(V4_LOOPBACK, address + 4);
  mem.st16(netmask, AF_INET); mem.u8.set([255, 0, 0, 0], netmask + 4);
  mem.u8.set([...enc.encode(lo.name), 0], name);
  stp(result, entry);
  return 0;
}

/** the ARM32 struct addrinfo: its size and the offsets of its fields */
const ADDRINFO = { size: 32, flags: 0, family: 4, socktype: 8, protocol: 12, addrlen: 16, canon: 20, addr: 24, next: 28 };

function nativeGetaddrinfo(cpu: Cpu, nodePtr: number, servicePtr: number, hints: number, result: number): number | Promise<number> {
  if (!result) { fail(cpu, E.FAULT); return EAI_SYSTEM; }
  const flags = hints ? mem.ld32(hints + ADDRINFO.flags) : 0;
  const family = hints ? mem.ld32(hints + ADDRINFO.family) : AF_UNSPEC;
  const socktype = hints ? mem.ld32(hints + ADDRINFO.socktype) : 0;
  const protocol = hints ? mem.ld32(hints + ADDRINFO.protocol) : 0;
  const v6 = family === AF_INET6;
  const node = nodePtr ? mem.cstr(nodePtr) : flags & AI_PASSIVE ? v6 ? "::" : "0.0.0.0" : v6 ? "::1" : "127.0.0.1";
  const service = servicePtr ? mem.cstr(servicePtr) : "0";
  record(`getaddrinfo ${node}:${service} flags=${flags.toString(16)} family=${family} type=${socktype} protocol=${protocol}`);
  if (flags & ~(AI_PASSIVE | AI_CANONNAME | AI_NUMERICHOST | AI_NUMERICSERV | AI_ADDRCONFIG)) return EAI_BADFLAGS;
  if (family !== AF_UNSPEC && family !== AF_INET && family !== AF_INET6) return EAI_FAMILY;
  if (socktype !== 0 && socktype !== SOCK_STREAM && socktype !== SOCK_DGRAM) return EAI_SOCKTYPE;
  if (protocol !== 0 && protocol !== IPPROTO_TCP && protocol !== IPPROTO_UDP) return EAI_PROTOCOL;
  if ((socktype === SOCK_STREAM && protocol === IPPROTO_UDP) || (socktype === SOCK_DGRAM && protocol === IPPROTO_TCP)) return EAI_SOCKTYPE;
  if (!nodePtr && !servicePtr) return EAI_NONAME;
  const port = /^\d+$/.test(service) ? Number(service) : service === "http" && !(flags & AI_NUMERICSERV) ? 80 : service === "https" && !(flags & AI_NUMERICSERV) ? 443 : -1;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return EAI_SERVICE;
  const resultType = socktype || (protocol === IPPROTO_UDP ? SOCK_DGRAM : SOCK_STREAM);
  const resultProtocol = protocol || (resultType === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP);
  const resultAt = anchor(result);
  const answer = (found: number[][] | number): number => {
    if (typeof found === "number") return found;
    const address = found[0], addressFamily = address.length === 4 ? AF_INET : AF_INET6;
    const sockaddr = sockaddrOf(addressFamily, { address, port });
    const canonBytes = flags & AI_CANONNAME ? enc.encode(node) : null;
    const size = ADDRINFO.size + sockaddr.length + (canonBytes ? canonBytes.length + 1 : 0);
    const allocation = mem.malloc(size);
    if (!allocation) { fail(cpu, E.NOMEM); return EAI_SYSTEM; }
    mem.memset(allocation, 0, size);
    mem.st32(allocation + ADDRINFO.flags, flags);
    mem.st32(allocation + ADDRINFO.family, addressFamily);
    mem.st32(allocation + ADDRINFO.socktype, resultType);
    mem.st32(allocation + ADDRINFO.protocol, resultProtocol);
    mem.st32(allocation + ADDRINFO.addrlen, sockaddr.length);
    stp(allocation + ADDRINFO.addr, allocation + ADDRINFO.size);
    mem.write(allocation + ADDRINFO.size, sockaddr);
    if (canonBytes) {
      const canon = allocation + ADDRINFO.size + sockaddr.length;
      mem.u8.set(canonBytes, canon);
      stp(allocation + ADDRINFO.canon, canon);
    }
    stp(resultAt(), allocation);
    record(`resolved ${node} -> ${addressText(address)} result=${mem.va(allocation).toString()}`);
    return 0;
  };
  const found = resolveHost(node, family, flags & AI_NUMERICHOST);
  return found instanceof Promise ? found.then(answer) : answer(found);
}

/** a guest buffer an await may outlive */
interface GuestBuffer { at: () => number; length: number }
const guestBuffer = (p: number, length: number): GuestBuffer => ({ at: anchor(p), length });
const NO_ADDRESS = new Uint8Array(0);
/** recvmsg's msg_control and where its length goes back */
interface Control { at: () => number; capacity: number; lengthAt: () => number }
/** recv(2)/recvfrom(2)/recvmsg(2) on any socket into the guest's buffers, which the bytes reach once
 *  they arrive; the sender's address goes to `name` and its length to `nameLength`, msg_flags to
 *  `messageFlags` and the ancillary data to `control` */
function nativeReceive(cpu: Cpu | null, fd: number, buffers: GuestBuffer[], flags: number, name = 0, nameLength = 0, messageFlags = 0, control: Control | null = null): number | Promise<number> {
  const unix = isUnixSocket(fd), socket = socketOf(fd);
  if (!unix && !socket) return fail(cpu, E.BADF);
  if (name && !nameLength) return fail(cpu, E.FAULT);
  if (name && mem.ld32(nameLength) < 0) return fail(cpu, E.INVAL);
  const total = buffers.reduce((n, b) => n + b.length, 0), target = new Uint8Array(total);
  const from: Received & { source: Endpoint | null } = { source: null, name: "", rights: control ? [] : null };
  const nameAt = anchor(name), lengthAt = anchor(nameLength), flagsAt = anchor(messageFlags);
  // a datagram's whole length, which tells a short buffer it was cut
  const n = unix ? unixReceive(fd, target, flags, from) : socketReceive(fd, target, socket!.kind === "datagram" ? flags | MSG_TRUNC : flags, from);
  const land = (n: number): number => {
    if (n < 0) return fail(cpu, -n);
    let cut = 0;
    if (control) {
      const { used, truncated } = unix ? putControl(control.at(), control.capacity, unixPassesCredentials(fd), from.rights!, !!(flags & MSG_CMSG_CLOEXEC)) : { used: 0, truncated: false };
      stLong(control.lengthAt(), used);
      if (truncated) cut = MSG_CTRUNC;
    }
    const copied = Math.min(n, total);
    for (let i = 0, at = 0; at < copied; i++) {
      const k = Math.min(buffers[i].length, copied - at);
      if (k) mem.write(buffers[i].at(), target.subarray(at, at + k));
      at += k;
    }
    if (name) {
      const sockaddr = unix ? from.name ? sockaddrUn(from.name) : NO_ADDRESS : from.source ? sockaddrOf(socket!.family, from.source) : NO_ADDRESS;
      putSockaddr(sockaddr, nameAt(), lengthAt(), mem.ld32(lengthAt()));
    }
    if (messageFlags) mem.st32(flagsAt(), (n > total ? MSG_TRUNC : 0) | cut);
    return flags & MSG_TRUNC ? n : copied;
  };
  return n instanceof Promise ? n.then(land) : land(n);
}

/** struct cmsghdr's size (cmsg_len is a size_t) and CMSG_ALIGN */
const cmsgHeader = () => PTR === 8 ? 16 : 12;
const cmsgAlign = (n: number) => (n + PTR - 1) & -PTR;
/** recvmsg's ancillary data, as scm_recv lays it into msg_control: SCM_CREDENTIALS when the socket
 *  passes them, then SCM_RIGHTS with the descriptors that fit installed; the rest are released and
 *  the cut is MSG_CTRUNC, as is a message put_cmsg shortens */
function putControl(at: number, capacity: number, credentials: boolean, passed: Parameters<typeof releasePassed>[0], cloexec: boolean): { used: number; truncated: boolean } {
  const header = cmsgHeader();
  let used = 0, truncated = false;
  const cmsg = (type: number, data: Uint8Array) => {
    const room = at ? capacity - used : 0;
    if (room < header) { truncated = true; return; }
    const length = Math.min(header + data.length, room);
    if (length < header + data.length) truncated = true;
    stLong(at + used, length);
    mem.st32(at + used + PTR, SOL_SOCKET); mem.st32(at + used + PTR + 4, type);
    mem.write(at + used + header, data.subarray(0, length - header));
    used += Math.min(cmsgAlign(header + data.length), room);
  };
  if (credentials) { const c = processCredentials(); cmsg(SCM_CREDENTIALS, new Uint8Array(Int32Array.of(c.pid, c.uid, c.gid).buffer)); }
  if (passed.length) {
    const room = at ? capacity - used : 0, fit = room > header ? Math.min(passed.length, (room - header) >> 2) : 0;
    if (fit < passed.length) truncated = true;
    if (fit) cmsg(SCM_RIGHTS, new Uint8Array(Int32Array.from(passed.slice(0, fit), (p) => installPassed(p, cloexec)).buffer));
    releasePassed(passed.slice(fit));
  }
  return { used, truncated };
}
/** sendmsg's ancillary data: SCM_RIGHTS's descriptors, and SCM_CREDENTIALS checked as Linux checks an
 *  unprivileged sender's (its own pid, uid and gid); -errno for what the kernel refuses */
function readControl(control: number, length: number): number[] | number {
  const header = cmsgHeader(), passing: number[] = [], own = processCredentials();
  for (let off = 0; off + header <= length;) {
    const at = control + off, len = ldLong(at), level = mem.ld32(at + PTR), type = mem.ld32(at + PTR + 4);
    if (len < header || off + len > length) return -E.INVAL;
    if (level === SOL_SOCKET) {
      if (type === SCM_RIGHTS) for (let i = header; i + 4 <= len; i += 4) passing.push(mem.ld32(at + i));
      else if (type === SCM_CREDENTIALS) {
        if (len !== header + 12) return -E.INVAL;
        if (mem.ld32(at + header) !== own.pid || mem.ld32(at + header + 4) !== own.uid || mem.ld32(at + header + 8) !== own.gid) return -E.PERM;
      } else return -E.INVAL;
    }
    off += cmsgAlign(len);
  }
  return passing;
}

function nativeSocketName(cpu: Cpu, fd: number, address: number, length: number, peer: boolean): number {
  const name = isUnixSocket(fd) ? unixSocketName(fd, peer) : socketName(fd, peer);
  if (typeof name === "number") return fail(cpu, -name);
  if (!length) return fail(cpu, E.FAULT);
  const capacity = mem.ld32(length);
  if (capacity < 0) return fail(cpu, E.INVAL);
  if (capacity && !address) return fail(cpu, E.FAULT);
  putSockaddr(typeof name === "string" ? sockaddrUn(name) : sockaddrOf(socketOf(fd)!.family, name), address, length, capacity);
  return 0;
}
/** EBADF, or ENOTSOCK for a descriptor that is open but no socket */
const notSocket = (cpu: Cpu | null, fd: number) => fail(cpu, openFd(fd) ? E.NOTSOCK : E.BADF);

function nativeGetsockopt(cpu: Cpu, fd: number, level: number, name: number, value: number, length: number): number {
  const unix = isUnixSocket(fd);
  if (!unix && !sockets.has(fd)) return notSocket(cpu, fd);
  if (!value || !length || mem.ld32(length) < 4) return fail(cpu, E.FAULT);
  if (unix && level === SOL_SOCKET && name === SO_PEERCRED) {
    const c = unixPeerCredentials(fd), n = Math.min(mem.ld32(length), 12);
    if (typeof c === "number") return fail(cpu, -c);
    mem.write(value, new Uint8Array(Int32Array.of(c.pid, c.uid, c.gid).buffer, 0, n));
    mem.st32(length, n);
    return 0;
  }
  const result = unix ? unixSocketOption(fd, level, name) : socketOption(fd, level, name);
  if (result < 0) return fail(cpu, -result);
  if (level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO)) {
    if (mem.ld32(length) < 2 * PTR) return fail(cpu, E.INVAL);
    stLong(value, Math.floor(result / 1000)); stLong(value + PTR, result % 1000 * 1000); mem.st32(length, 2 * PTR);
    return 0;
  }
  if (level === SOL_SOCKET && name === SO_LINGER && mem.ld32(length) >= 8) {
    mem.st32(value, +(result > 0)); mem.st32(value + 4, Math.max(0, result - 1)); mem.st32(length, 8);
    return 0;
  }
  mem.st32(value, result);
  mem.st32(length, 4);
  return 0;
}
function nativeSetsockopt(cpu: Cpu, fd: number, level: number, name: number, value: number, length: number): number {
  const unix = isUnixSocket(fd);
  if (!unix && !sockets.has(fd)) return notSocket(cpu, fd);
  const set = unix ? unixSetOption : setSocketOption;
  if (!unix && level === IPPROTO_IP && (name === IP_ADD_MEMBERSHIP || name === IP_DROP_MEMBERSHIP) && value && length >= 8)
    return sys(cpu, socketGroup(fd, name === IP_ADD_MEMBERSHIP, Array.from(mem.bytes(value, 4)), length >= 12 ? mem.ld32(value + 8) : 0));
  if (level === SOL_SOCKET && name === SO_LINGER) return value && length >= 8 ? sys(cpu, set(fd, level, name, mem.ld32(value) ? mem.ld32(value + 4) : -1)) : fail(cpu, E.INVAL);
  if (level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO)) {
    if (!value || length < 2 * PTR) return fail(cpu, E.INVAL);
    const seconds = ldLong(value), micros = ldLong(value + PTR);
    if (micros < 0 || micros >= 1_000_000) return fail(cpu, E.DOM);
    return sys(cpu, set(fd, level, name, seconds < 0 ? 0 : seconds * 1000 + Math.ceil(micros / 1000)));
  }
  if (!value || length < 1) return fail(cpu, E.INVAL);
  // an option the model does not keep is accepted as the kernel would, with nothing to observe
  const r = set(fd, level, name, length >= 4 ? mem.ld32(value) : mem.u8[value]);
  return r === -E.NOPROTOOPT ? 0 : sys(cpu, r);
}

/** sendto(2)/sendmsg(2) of `bytes` on any socket, to the sockaddr at `destination` if there is one,
 *  an AF_UNIX one passing the descriptors `passing`. A stream whose reader is gone raises SIGPIPE. */
function nativeSendTo(cpu: Cpu, fd: number, bytes: Uint8Array, destination: number, destinationLength: number, flags = 0, passing: number[] = []): number {
  const named = !!(destination || destinationLength);
  const sent = (r: number, stream: boolean) => r === -E.PIPE && stream ? brokenPipe(cpu, flags) : sys(cpu, r);
  if (isUnixSocket(fd)) {
    if (named && (!destination || destinationLength < 2 || mem.ld16u(destination) !== AF_UNIX)) return fail(cpu, E.INVAL);
    const path = named ? sunPath(mem.bytes(destination + 2, destinationLength - 2)) : null;
    return sent(unixSend(fd, bytes, path, passing), unixSocketOption(fd, SOL_SOCKET, SO_TYPE) === SOCK_STREAM);
  }
  if (!sockets.has(fd)) return notSocket(cpu, fd);
  const endpoint = named ? readEndpoint(cpu, fd, destination, destinationLength, true) : null;
  if (named && !endpoint) return -1;
  return sent(socketSend(fd, bytes, endpoint), socketOf(fd)!.kind === "stream");
}

function copyText(text: string, destination: number, capacity: number): boolean {
  const bytes = enc.encode(text);
  if (!destination) return capacity === 0;
  if (bytes.length + 1 > capacity) return false;
  mem.write(destination, bytes);
  mem.st8(destination + bytes.length, 0);
  return true;
}

function nativeGetnameinfo(sockaddr: number, length: number, host: number, hostLength: number, service: number, serviceLength: number, flags = 0): number {
  const family = sockaddr && length >= 2 ? mem.ld16u(sockaddr) : -1;
  if (family !== AF_INET && family !== AF_INET6) return EAI_FAMILY;
  const ep = sockaddrEndpoint(family, sockaddr, length);
  if (typeof ep === "number") return EAI_FAMILY;
  const resolved = flags & NI_NUMERICHOST ? null : hostOf(ep.address);
  if (!resolved && flags & NI_NAMEREQD) return EAI_NONAME;
  return copyText(resolved ?? addressText(ep.address), host, hostLength) && copyText(String(ep.port), service, serviceLength) ? 0 : EAI_OVERFLOW;
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

const gaiStrings = new Map<number, number>();
function gaiStrerror(code: number): number {
  let address = gaiStrings.get(code);
  if (address === undefined) { address = mem.hostStr(gaiText(code)); gaiStrings.set(code, address); }
  return address;
}

/** struct msghdr's fields, pointer-sized after msg_namelen (PTR is the process ABI's, set after load) */
const MSG = { name: 0, nameLength: 1, iov: 2, iovLength: 3, control: 4, controlLength: 5, flags: 6 };
const UIO_MAXIOV = 1024;

export const NET_SYSCALLS: Record<string, HostFn> = {
  socket: (cpu, args) => {
    const domain = args.i(), type = args.i(), protocol = args.i();
    return sys(cpu, domain === AF_INET || domain === AF_INET6 ? socketCreate(domain, type, protocol) : domain === AF_UNIX ? unixSocket(type) : -E.AFNOSUPPORT);
  },
  connect: (cpu, args) => {
    const fd = args.i(), sockaddr = args.p(), length = args.u();
    if (!sockets.has(fd)) return isUnixSocket(fd) ? unixAt(cpu, sockaddr, length, (path) => unixConnectPath(fd, path)) : notSocket(cpu, fd);
    if (sockaddr && length >= 2 && mem.ld16u(sockaddr) === AF_UNSPEC) return sys(cpu, socketConnect(fd, null) as number);
    const endpoint = readEndpoint(cpu, fd, sockaddr, length);
    return endpoint ? sysAsync(cpu, socketConnect(fd, endpoint)) : -1;
  },
  bind: (cpu, args) => {
    const fd = args.i(), sockaddr = args.p(), length = args.u();
    if (!sockets.has(fd)) return isUnixSocket(fd) ? unixAt(cpu, sockaddr, length, (path) => unixBind(fd, path)) : notSocket(cpu, fd);
    const endpoint = readEndpoint(cpu, fd, sockaddr, length);
    return endpoint ? sys(cpu, socketBind(fd, endpoint)) : -1;
  },
  listen: (cpu, args) => { const fd = args.i(); args.i(); return sys(cpu, isUnixSocket(fd) ? unixListen(fd) : socketListen(fd)); },
  accept: (cpu, args) => nativeAccept(cpu, args.i(), args.p(), args.p(), 0),
  accept4: (cpu, args) => nativeAccept(cpu, args.i(), args.p(), args.p(), args.i()),
  sendto: (cpu, args) => {
    const fd = args.i(), source = args.p(), length = args.u(), flags = args.i(), destination = args.p(), destinationLength = args.u();
    if (!isNativeSocket(fd) && !isUnixSocket(fd)) return destination || destinationLength ? fail(cpu, E.ISCONN) : fdWrite(cpu, fd, source, length);
    if (length && !source) return fail(cpu, E.FAULT);
    return nativeSendTo(cpu, fd, mem.bytes(source, length), destination, destinationLength, flags);
  },
  recvfrom: (cpu, args) => {
    const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i();
    const source = args.p(), sourceLength = args.p();
    if (isNativeSocket(fd) || isUnixSocket(fd)) return length && !destination ? fail(cpu, E.FAULT) : nativeReceive(cpu, fd, [guestBuffer(destination, length)], flags, source, sourceLength);
    if (source || sourceLength) return fail(cpu, E.NOTCONN);
    return fdRead(cpu, fd, destination, length);
  },
  // ancillary data is AF_UNIX's SCM_RIGHTS and SCM_CREDENTIALS; an internet socket sends none
  sendmsg: (cpu, args) => {
    const fd = args.i(), msg = args.p(), flags = args.i(), unix = isUnixSocket(fd);
    if (!isNativeSocket(fd) && !unix) return notSocket(cpu, fd);
    const count = ldLong(msg + MSG.iovLength * PTR);
    if (count < 0 || count > UIO_MAXIOV) return fail(cpu, E.MSGSIZE);
    const control = ldp(msg + MSG.control * PTR), controlLength = ldLong(msg + MSG.controlLength * PTR);
    const passing = control && controlLength ? unix ? readControl(control, controlLength) : -E.INVAL : [];
    if (typeof passing === "number") return fail(cpu, -passing);
    return nativeSendTo(cpu, fd, gather(ldp(msg + MSG.iov * PTR), count), ldp(msg + MSG.name * PTR), mem.ld32(msg + MSG.nameLength * PTR), flags, passing);
  },
  recvmsg: (cpu, args) => {
    const fd = args.i(), msg = args.p(), flags = args.i();
    if (!isNativeSocket(fd) && !isUnixSocket(fd)) return notSocket(cpu, fd);
    const iov = ldp(msg + MSG.iov * PTR), count = ldLong(msg + MSG.iovLength * PTR);
    if (count < 0 || count > UIO_MAXIOV) return fail(cpu, E.MSGSIZE);
    const buffers = Array.from({ length: count }, (_, i) => guestBuffer(ldp(iov + i * 2 * PTR), ldLong(iov + i * 2 * PTR + PTR)));
    const control = { at: anchor(ldp(msg + MSG.control * PTR)), capacity: ldLong(msg + MSG.controlLength * PTR), lengthAt: anchor(msg + MSG.controlLength * PTR) };
    return nativeReceive(cpu, fd, buffers, flags, ldp(msg + MSG.name * PTR), msg + MSG.nameLength * PTR, msg + MSG.flags * PTR, control);
  },
  shutdown: (cpu, args) => { const fd = args.i(), how = args.i(); return sys(cpu, isUnixSocket(fd) ? javaShutdownFd(fd, how) : socketShutdown(fd, how)); },
  setsockopt: (cpu, args) => nativeSetsockopt(cpu, args.i(), args.i(), args.i(), args.p(), args.u()),
  getsockopt: (cpu, args) => nativeGetsockopt(cpu, args.i(), args.i(), args.i(), args.p(), args.p()),
  getsockname: (cpu, args) => nativeSocketName(cpu, args.i(), args.p(), args.p(), false),
  getpeername: (cpu, args) => nativeSocketName(cpu, args.i(), args.p(), args.p(), true),
};

export function netInit(): void {
  const functions: Record<string, HostFn> = {
    send: (cpu, args) => { const fd = args.i(), source = args.p(), length = args.u(); args.i(); return fdWrite(cpu, fd, source, length); },
    recv: (cpu, args) => {
      const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i();
      return isNativeSocket(fd) || isUnixSocket(fd) ? nativeReceive(cpu, fd, [guestBuffer(destination, length)], flags) : fdRead(cpu, fd, destination, length);
    },
    getaddrinfo: (cpu, args) => nativeGetaddrinfo(cpu, args.p(), args.p(), args.p(), args.p()),
    freeaddrinfo: (_cpu, args) => { const address = args.p(); if (address) mem.free(address); },
    getifaddrs: (cpu, args) => nativeGetifaddrs(cpu, args.p()),
    freeifaddrs: (_cpu, args) => { const entry = args.p(); if (entry) mem.free(entry); },
    gai_strerror: (_cpu, args) => ptr(gaiStrerror(args.i())),
    getnameinfo: (_cpu, args) => nativeGetnameinfo(args.p(), args.u(), args.p(), args.u(), args.p(), args.u(), args.i()),
    inet_pton: (cpu, args) => {
      const family = args.i(), text = args.str(), out = args.p();
      if (family !== AF_INET && family !== AF_INET6) return fail(cpu, E.AFNOSUPPORT);
      const bytes = family === AF_INET ? parseIpv4(text) : parseIpv6(text);
      if (!bytes) return 0;
      mem.write(out, bytes);
      return 1;
    },
    inet_ntop: (cpu, args) => {
      const family = args.i(), source = args.p(), destination = args.p(), length = args.u();
      if (family !== AF_INET && family !== AF_INET6) { fail(cpu, E.AFNOSUPPORT); return 0; }
      if (!copyText(addressText(mem.bytes(source, family === AF_INET ? 4 : 16)), destination, length)) { fail(cpu, E.NOSPC); return 0; }
      return ptr(destination);
    },
    poll: (cpu, args) => nativePoll(cpu, args.p(), args.u(), args.i()),
    select: (cpu, args) => {
      const count = args.i(), r = args.p(), w = args.p(), x = args.p(), timeout = args.p();
      if (!timeout) return nativeSelect(cpu, count, r, w, x, -1);
      const seconds = mem.ld32(timeout), micros = mem.ld32(timeout + PTR);
      if (seconds < 0 || micros < 0 || micros >= 1_000_000) return fail(cpu, E.INVAL);
      return nativeSelect(cpu, count, r, w, x, seconds * 1000 + micros / 1000);
    },
  };
  hostLib("libc.so", functions);
}

function nativeAccept(cpu: Cpu, fd: number, address: number, length: number, flags: number): HostRet | Promise<HostRet> {
  const addressAt = anchor(address), lengthAt = anchor(length);
  const land = (fd: number, peer: Uint8Array): number => {
    if (address && length) { const at = lengthAt(); putSockaddr(peer, addressAt(), at, mem.ld32(at)); }
    return fd;
  };
  if (isUnixSocket(fd)) {
    const r = unixAccept(fd, flags), unix = (r: number) => r < 0 ? fail(cpu, -r) : land(r, sockaddrUn(""));   // an unnamed peer
    return r instanceof Promise ? r.then(unix) : unix(r);
  }
  const family = socketOf(fd)?.family ?? AF_INET;
  const inet = (r: { fd: number; peer: Endpoint } | number): number => {
    if (typeof r === "number") return fail(cpu, -r);
    if (flags & SOCK_NONBLOCK) nativeSocketFcntl(cpu, r.fd, F_SETFL, O_NONBLOCK);
    if (flags & SOCK_CLOEXEC) sockets.get(r.fd)!.cloexec = true;
    return land(r.fd, sockaddrOf(family, r.peer));
  };
  const r = socketAccept(fd);
  return r instanceof Promise ? r.then(inet) : inet(r);
}
