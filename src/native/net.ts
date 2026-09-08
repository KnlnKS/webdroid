// Bionic IPv4 sockets: TCP over the browser WebSocket relay, plus process-local UDP.

import { Relay, type RelayTransportFactory } from "../shell/relay";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { hostLib, PTR, stp, type HostFn, type HostRet, ptr } from "./host";
import { mem } from "./mem";
import { allocateFd, releaseFd, reserveFd } from "./fd";

const AF_UNSPEC = 0, AF_INET = 2, SOCK_STREAM = 1, SOCK_DGRAM = 2, IPPROTO_TCP = 6, IPPROTO_UDP = 17;
const SOCK_NONBLOCK = 0x800, SOCK_CLOEXEC = 0x80000;
const F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
const O_RDWR = 2, O_NONBLOCK = 0x800;
const SOL_SOCKET = 1, SO_TYPE = 3, SO_ERROR = 4;
const POLLIN = 1, POLLPRI = 2, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;
const AI_PASSIVE = 1, AI_CANONNAME = 2, AI_NUMERICHOST = 4, AI_NUMERICSERV = 8, AI_ADDRCONFIG = 0x400;
const EAI_ADDRFAMILY = 1, EAI_BADFLAGS = 3, EAI_FAMILY = 5, EAI_NONAME = 8;
const EAI_SERVICE = 9, EAI_SOCKTYPE = 10, EAI_SYSTEM = 11, EAI_PROTOCOL = 13, EAI_OVERFLOW = 14;
const NI_NUMERICHOST = 2, NI_NAMEREQD = 4;
const MSG_PEEK = 0x2, MSG_TRUNC = 0x20, MSG_DONTWAIT = 0x40;
const E_DESTADDRREQ = 89, E_MSGSIZE = 90, E_OPNOTSUPP = 95, E_ADDRINUSE = 98;
const UDP_MAX_PAYLOAD = 65_507;
const UDP_QUEUE_PACKETS = 256, UDP_QUEUE_BYTES = 1 << 20;

interface SocketState {
  nonblock: boolean;
  connected: boolean;
  error: number;
  waiters: Set<() => void>;
  references: number;
  peer: Ipv4Endpoint | null;
  local: Ipv4Endpoint | null;
}
interface NativeStreamSocket extends SocketState {
  kind: "stream";
  relay: Relay | null;
  connecting: boolean;
}
interface Datagram {
  bytes: Uint8Array;
  source: Ipv4Endpoint;
}
interface NativeDatagramSocket extends SocketState {
  kind: "datagram";
  queue: Datagram[];
  queuedBytes: number;
}
type NativeSocket = NativeStreamSocket | NativeDatagramSocket;
interface NativeSocketFd { socket: NativeSocket; cloexec: boolean }
interface Ipv4Endpoint { address: [number, number, number, number]; port: number }

const sockets = new Map<number, NativeSocketFd>();
const datagramBindings = new Set<NativeDatagramSocket>();
const syntheticHosts = new Map<number, string>();
const syntheticAddresses = new Map<string, [number, number, number, number]>();
let nextSynthetic = 1;
let nextDatagramPort = 49_152;
let transportFactory: RelayTransportFactory | undefined;
export const netDebug = { events: [] as string[] };
function record(event: string): void {
  netDebug.events.push(event);
  if (netDebug.events.length > 100) netDebug.events.shift();
}
export interface NativePollProvider {
  query(fd: number, events: number): number | null;
  subscribe(fd: number, wake: () => void): () => void;
  read(cpu: Cpu, fd: number, destination: number, length: number): number | Promise<number> | null;
  write(cpu: Cpu, fd: number, source: number, length: number): number | null;
}
let localPollProvider: NativePollProvider | null = null;
export function setNativePollProvider(provider: NativePollProvider): () => void {
  const previous = localPollProvider;
  localPollProvider = provider;
  return () => { localPollProvider = previous; };
}

const fail = (cpu: Cpu, errno: number): number => { mem.st32(cpu.errnoAddr, errno); return -1; };
const wake = (socket: NativeSocket): void => {
  const waiters = [...socket.waiters];
  socket.waiters.clear();
  for (const waiter of waiters) waiter();
};
const socketFdOf = (cpu: Cpu, fd: number): NativeSocketFd | null => sockets.get(fd) ?? (fail(cpu, E.BADF), null);
const ipv4Key = (bytes: ArrayLike<number>): number =>
  (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
const ipv4Text = (bytes: ArrayLike<number>): string => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
const sameAddress = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const isAnyAddress = (address: ArrayLike<number>): boolean => ipv4Key(address) === 0;
const isLoopback = (address: ArrayLike<number>): boolean => address[0] === 127;

function readEndpoint(cpu: Cpu, sockaddr: number, length: number): Ipv4Endpoint | null {
  if (!sockaddr || length < 8) { fail(cpu, E.INVAL); return null; }
  if (mem.ld16u(sockaddr) !== AF_INET) { fail(cpu, E.AFNOSUPPORT); return null; }
  return {
    port: (mem.u8[sockaddr + 2] << 8) | mem.u8[sockaddr + 3],
    address: [mem.u8[sockaddr + 4], mem.u8[sockaddr + 5], mem.u8[sockaddr + 6], mem.u8[sockaddr + 7]],
  };
}

function parseIpv4(text: string): [number, number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  const bytes: [number, number, number, number] = [+match[1], +match[2], +match[3], +match[4]];
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

function addressFor(host: string): [number, number, number, number] {
  const numeric = parseIpv4(host);
  if (numeric) return numeric;
  const found = syntheticAddresses.get(host);
  if (found) return found;
  const id = nextSynthetic++ & 0xffff;
  const bytes: [number, number, number, number] = [198, 18, id >>> 8, id & 255];
  syntheticAddresses.set(host, bytes);
  syntheticHosts.set(ipv4Key(bytes), host);
  return bytes;
}

const addrinfoLayout = () => PTR === 8
  ? { size: 48, canon: 24, addr: 32, next: 40 }
  : { size: 32, canon: 20, addr: 24, next: 28 };

export function nativeGetaddrinfo(cpu: Cpu, nodePtr: number, servicePtr: number, hints: number, result: number): number {
  if (!result) { fail(cpu, E.FAULT); return EAI_SYSTEM; }
  const flags = hints ? mem.ld32(hints) : 0;
  const family = hints ? mem.ld32(hints + 4) : AF_UNSPEC;
  const socktype = hints ? mem.ld32(hints + 8) : 0;
  const protocol = hints ? mem.ld32(hints + 12) : 0;
  const node = nodePtr ? mem.cstr(nodePtr) : flags & AI_PASSIVE ? "0.0.0.0" : "127.0.0.1";
  const service = servicePtr ? mem.cstr(servicePtr) : "0";
  record(`getaddrinfo ${node}:${service} flags=${flags.toString(16)} family=${family} type=${socktype} protocol=${protocol}`);
  if (flags & ~(AI_PASSIVE | AI_CANONNAME | AI_NUMERICHOST | AI_NUMERICSERV | AI_ADDRCONFIG)) return EAI_BADFLAGS;
  if (family !== AF_UNSPEC && family !== AF_INET) return EAI_FAMILY;
  if (socktype !== 0 && socktype !== SOCK_STREAM && socktype !== SOCK_DGRAM) return EAI_SOCKTYPE;
  if (protocol !== 0 && protocol !== IPPROTO_TCP && protocol !== IPPROTO_UDP) return EAI_PROTOCOL;
  if ((socktype === SOCK_STREAM && protocol === IPPROTO_UDP) || (socktype === SOCK_DGRAM && protocol === IPPROTO_TCP)) return EAI_SOCKTYPE;
  if (!nodePtr && !servicePtr) return EAI_NONAME;

  const numeric = parseIpv4(node);
  if (!numeric && flags & AI_NUMERICHOST) return EAI_NONAME;
  let port = /^\d+$/.test(service) ? Number(service) : service === "http" && !(flags & AI_NUMERICSERV) ? 80 : service === "https" && !(flags & AI_NUMERICSERV) ? 443 : -1;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return EAI_SERVICE;

  const resultType = socktype || (protocol === IPPROTO_UDP ? SOCK_DGRAM : SOCK_STREAM);
  const resultProtocol = protocol || (resultType === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP);
  const bytes = numeric ?? addressFor(node);
  const layout = addrinfoLayout();
  const sockaddr = layout.size;
  const canonBytes = flags & AI_CANONNAME ? new TextEncoder().encode(node) : null;
  const allocation = mem.malloc(layout.size + 16 + (canonBytes ? canonBytes.length + 1 : 0));
  if (!allocation) { fail(cpu, E.NOMEM); return EAI_SYSTEM; }
  mem.memset(allocation, 0, layout.size + 16 + (canonBytes ? canonBytes.length + 1 : 0));
  mem.st32(allocation, flags);
  mem.st32(allocation + 4, AF_INET);
  mem.st32(allocation + 8, resultType);
  mem.st32(allocation + 12, resultProtocol);
  mem.st32(allocation + 16, 16);
  stp(allocation + layout.addr, allocation + sockaddr);
  stp(allocation + layout.next, 0);
  mem.st16(allocation + sockaddr, AF_INET);
  mem.u8[allocation + sockaddr + 2] = port >>> 8;
  mem.u8[allocation + sockaddr + 3] = port & 255;
  mem.u8.set(bytes, allocation + sockaddr + 4);
  if (canonBytes) {
    const canon = allocation + sockaddr + 16;
    mem.u8.set(canonBytes, canon);
    stp(allocation + layout.canon, canon);
  }
  stp(result, allocation);
  record(`resolved ${node} -> ${ipv4Text(bytes)} result=${mem.va(allocation).toString()}`);
  return 0;
}

export function nativeFreeaddrinfo(address: number): void { if (address) mem.free(address); }

export function nativeSocket(cpu: Cpu, domain: number, type: number, protocol: number): number {
  const baseType = type & 0xf;
  if (domain !== AF_INET) return fail(cpu, E.PROTONOSUPPORT);
  if (baseType !== SOCK_STREAM && baseType !== SOCK_DGRAM) return fail(cpu, E.SOCKTNOSUPPORT);
  const expectedProtocol = baseType === SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP;
  if (protocol !== 0 && protocol !== expectedProtocol) return fail(cpu, E.PROTONOSUPPORT);
  const fd = allocateFd();
  const common: SocketState = {
    nonblock: !!(type & SOCK_NONBLOCK), connected: false, error: 0,
    waiters: new Set(), references: 1, peer: null, local: null,
  };
  const socket: NativeSocket = baseType === SOCK_DGRAM
    ? { ...common, kind: "datagram", queue: [], queuedBytes: 0 }
    : { ...common, kind: "stream", relay: null, connecting: false };
  sockets.set(fd, {
    cloexec: !!(type & SOCK_CLOEXEC),
    socket,
  });
  record(`socket fd=${fd} family=${domain} type=${type.toString(16)} protocol=${protocol}`);
  return fd;
}

export function nativeConnect(cpu: Cpu, fd: number, sockaddr: number, length: number): HostRet | Promise<HostRet> {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind === "datagram") {
    if (!sockaddr || length < 2) return fail(cpu, E.INVAL);
    if (mem.ld16u(sockaddr) === AF_UNSPEC) {
      socket.peer = null;
      socket.connected = false;
      return 0;
    }
    const endpoint = readEndpoint(cpu, sockaddr, length);
    if (!endpoint) return -1;
    if (!endpoint.port) return fail(cpu, E.INVAL);
    if (!socket.local && !bindDatagram(cpu, socket, { address: [0, 0, 0, 0], port: 0 })) return -1;
    socket.peer = endpoint;
    socket.connected = true;
    return 0;
  }
  if (socket.connected) return fail(cpu, E.ISCONN);
  if (socket.connecting) return fail(cpu, E.ALREADY);
  const endpoint = readEndpoint(cpu, sockaddr, length);
  if (!endpoint) return -1;
  const { address: bytes, port } = endpoint;
  const host = syntheticHosts.get(ipv4Key(bytes)) ?? ipv4Text(bytes);
  record(`connect fd=${fd} ${host}:${port} nonblock=${socket.nonblock}`);
  const relay = new Relay(host, port, false, transportFactory);
  socket.relay = relay;
  socket.connecting = true;
  socket.peer = { address: bytes, port };
  const completion = relay.ready.then(() => {
    socket.connecting = false;
    socket.connected = true;
    const local = relay.localEndpoint;
    const address = local?.family === "IPv4" ? parseIpv4(local.address) : null;
    socket.local = local && address ? { address, port: local.port } : null;
    record(`connected fd=${fd}`);
    wake(socket);
    return true;
  }, () => {
    socket.connecting = false;
    socket.error = E.CONNREFUSED;
    record(`connect failed fd=${fd} errno=${socket.error}`);
    wake(socket);
    return false;
  });
  if (socket.nonblock) { void completion; return fail(cpu, E.INPROGRESS); }
  return completion.then((connected) => connected ? 0 : fail(cpu, socket.error));
}

function bindingConflicts(socket: NativeDatagramSocket, endpoint: Ipv4Endpoint): boolean {
  for (const other of datagramBindings) {
    if (other === socket || other.local?.port !== endpoint.port) continue;
    if (isAnyAddress(other.local.address) || isAnyAddress(endpoint.address) || sameAddress(other.local.address, endpoint.address)) return true;
  }
  return false;
}

function ephemeralEndpoint(socket: NativeDatagramSocket, address: Ipv4Endpoint["address"]): Ipv4Endpoint | null {
  for (let attempts = 0; attempts < 16_384; attempts++) {
    const port = nextDatagramPort++;
    if (nextDatagramPort > 65_535) nextDatagramPort = 49_152;
    const endpoint = { address, port };
    if (!bindingConflicts(socket, endpoint)) return endpoint;
  }
  return null;
}

function bindDatagram(cpu: Cpu, socket: NativeDatagramSocket, requested: Ipv4Endpoint): boolean {
  if (socket.local) { fail(cpu, E.INVAL); return false; }
  const endpoint = requested.port ? requested : ephemeralEndpoint(socket, requested.address);
  if (!endpoint) { fail(cpu, E_ADDRINUSE); return false; }
  if (bindingConflicts(socket, endpoint)) { fail(cpu, E_ADDRINUSE); return false; }
  socket.local = endpoint;
  datagramBindings.add(socket);
  return true;
}

export function nativeBind(cpu: Cpu, fd: number, sockaddr: number, length: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind !== "datagram") return fail(cpu, E_OPNOTSUPP);
  const endpoint = readEndpoint(cpu, sockaddr, length);
  if (!endpoint) return -1;
  return bindDatagram(cpu, socket, endpoint) ? 0 : -1;
}

function datagramRecipients(sender: NativeDatagramSocket, destination: Ipv4Endpoint): NativeDatagramSocket[] {
  const loopback = isLoopback(destination.address);
  const source = sender.local ? datagramSource(sender.local) : null;
  const recipients: NativeDatagramSocket[] = [];
  for (const candidate of datagramBindings) {
    const local = candidate.local;
    if (!local || local.port !== destination.port) continue;
    const addressMatches = sameAddress(local.address, destination.address) || (loopback && isAnyAddress(local.address));
    const peerMatches = !candidate.peer || !!source && candidate.peer.port === source.port && sameAddress(candidate.peer.address, source.address);
    if (addressMatches && peerMatches) recipients.push(candidate);
  }
  return recipients;
}

function datagramSource(local: Ipv4Endpoint): Ipv4Endpoint {
  return isAnyAddress(local.address)
    ? { address: [127, 0, 0, 1], port: local.port }
    : local;
}

export function nativeSendTo(cpu: Cpu, fd: number, source: number, length: number, destination: number, destinationLength: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind === "stream") {
    if (destination || destinationLength) return fail(cpu, E.ISCONN);
    return nativeSocketWrite(cpu, fd, source, length);
  }
  if (length && !source) return fail(cpu, E.FAULT);
  if (length > UDP_MAX_PAYLOAD) return fail(cpu, E_MSGSIZE);
  const endpoint = destination || destinationLength
    ? readEndpoint(cpu, destination, destinationLength)
    : socket.peer;
  if (!endpoint) return destination || destinationLength ? -1 : fail(cpu, E_DESTADDRREQ);
  if (!endpoint.port) return fail(cpu, E.INVAL);
  if (!socket.local && !bindDatagram(cpu, socket, { address: [0, 0, 0, 0], port: 0 })) return -1;
  const recipients = datagramRecipients(socket, endpoint);
  if (!isLoopback(endpoint.address) && !recipients.length) return fail(cpu, E.NETUNREACH);
  const local = socket.local;
  if (!local) return fail(cpu, E.IO);
  const bytes = mem.u8.slice(source, source + length);
  const datagram = { bytes, source: datagramSource(local) };
  for (const recipient of recipients) {
    if (recipient.queue.length >= UDP_QUEUE_PACKETS || recipient.queuedBytes + bytes.length > UDP_QUEUE_BYTES) continue;
    recipient.queue.push(datagram);
    recipient.queuedBytes += bytes.length;
    wake(recipient);
  }
  return length;
}

function writeDatagramAddress(endpoint: Ipv4Endpoint, address: number, length: number): void {
  const capacity = mem.ld32(length);
  const sockaddr = new Uint8Array(16);
  sockaddr[0] = AF_INET;
  sockaddr[2] = endpoint.port >>> 8;
  sockaddr[3] = endpoint.port & 255;
  sockaddr.set(endpoint.address, 4);
  if (capacity > 0) mem.u8.set(sockaddr.subarray(0, Math.min(capacity, sockaddr.length)), address);
  mem.st32(length, sockaddr.length);
}

export function nativeReceiveFrom(cpu: Cpu, fd: number, destination: number, length: number, flags: number, source: number, sourceLength: number): number | Promise<number> {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind === "stream") {
    if (source) return fail(cpu, E.NOTCONN);
    return nativeSocketRead(cpu, fd, destination, length, !!(flags & MSG_DONTWAIT));
  }
  if (length && !destination) return fail(cpu, E.FAULT);
  if (source && !sourceLength) return fail(cpu, E.FAULT);
  if (source && mem.ld32(sourceLength) < 0) return fail(cpu, E.INVAL);
  const destinationVa = destination ? mem.va(destination) : 0;
  const sourceVa = source ? mem.va(source) : 0;
  const sourceLengthVa = sourceLength ? mem.va(sourceLength) : 0;
  const receive = (): number | null => {
    const datagram = socket.queue[0];
    if (!datagram) return null;
    if (!(flags & MSG_PEEK)) {
      socket.queue.shift();
      socket.queuedBytes -= datagram.bytes.length;
    }
    const currentDestination = typeof destinationVa === "bigint" ? mem.txVa(destinationVa) : destinationVa;
    const copied = Math.min(length, datagram.bytes.length);
    if (copied) mem.write(currentDestination, datagram.bytes.subarray(0, copied));
    if (sourceVa && sourceLengthVa) {
      const currentSource = typeof sourceVa === "bigint" ? mem.txVa(sourceVa) : sourceVa;
      const currentLength = typeof sourceLengthVa === "bigint" ? mem.txVa(sourceLengthVa) : sourceLengthVa;
      writeDatagramAddress(datagram.source, currentSource, currentLength);
    }
    return flags & MSG_TRUNC ? datagram.bytes.length : copied;
  };
  const immediate = receive();
  if (immediate !== null) return immediate;
  if (socket.nonblock || flags & MSG_DONTWAIT) return fail(cpu, E.AGAIN);
  return new Promise<number>((resolve) => {
    const retry = () => {
      const result = receive();
      if (result !== null) resolve(result);
      else if (!socket.references) resolve(fail(cpu, E.BADF));
      else socket.waiters.add(retry);
    };
    socket.waiters.add(retry);
  });
}

export function isNativeSocket(fd: number): boolean { return sockets.has(fd); }

export function nativeSocketIoctl(cpu: Cpu, fd: number, request: number, argument: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  if (request !== 0x541b) return fail(cpu, 25);
  if (!argument) return fail(cpu, E.FAULT);
  const socket = descriptor.socket;
  mem.st32(argument, socket.kind === "stream" ? socket.relay?.available() ?? 0 : socket.queue[0]?.bytes.length ?? 0);
  return 0;
}

export function nativeSocketClose(cpu: Cpu, fd: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  sockets.delete(fd);
  releaseFd(fd);
  if (--socket.references === 0) {
    if (socket.kind === "stream") socket.relay?.close();
    else datagramBindings.delete(socket);
  }
  wake(socket);
  return 0;
}

export function nativeSocketDup(cpu: Cpu, fd: number, target?: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const duplicate = target ?? allocateFd();
  if (target !== undefined) reserveFd(target);
  descriptor.socket.references++;
  sockets.set(duplicate, { socket: descriptor.socket, cloexec: false });
  return duplicate;
}

export function nativeSocketFcntl(cpu: Cpu, fd: number, command: number, value: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (command === F_GETFD) return descriptor.cloexec ? 1 : 0;
  if (command === F_SETFD) { descriptor.cloexec = !!(value & 1); return 0; }
  if (command === F_GETFL) return O_RDWR | (socket.nonblock ? O_NONBLOCK : 0);
  if (command === F_SETFL) { socket.nonblock = !!(value & O_NONBLOCK); return 0; }
  return fail(cpu, E.INVAL);
}

export function nativeSocketRead(cpu: Cpu, fd: number, destination: number, length: number, nonblock = false): number | Promise<number> {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind === "datagram") return nativeReceiveFrom(cpu, fd, destination, length, nonblock ? MSG_DONTWAIT : 0, 0, 0);
  if (!socket.connected || !socket.relay) return fail(cpu, socket.error || E.NOTCONN);
  if (!length) return 0;
  if (!socket.relay.available() && !socket.relay.eof && (socket.nonblock || nonblock)) return fail(cpu, E.AGAIN);
  const target = mem.va(destination);
  const bytes = new Uint8Array(length);
  return socket.relay.read(bytes, 0, length).then((read) => {
    if (read < 0) return 0;
    mem.write(typeof target === "bigint" ? mem.txVa(target) : target, bytes.subarray(0, read));
    return read;
  });
}

export function nativeSocketWrite(cpu: Cpu, fd: number, source: number, length: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.kind === "datagram") return nativeSendTo(cpu, fd, source, length, 0, 0);
  if (!socket.connected || !socket.relay) return fail(cpu, socket.error || E.NOTCONN);
  if (!length) return 0;
  return socket.relay.write(mem.u8.slice(source, source + length)) ? length : fail(cpu, E.NOTCONN);
}

export function nativePollEvents(fd: number, events: number): number {
  const socket = sockets.get(fd)?.socket;
  if (!socket) return localPollProvider?.query(fd, events) ?? POLLNVAL;
  let ready = socket.error ? POLLERR : 0;
  if (socket.kind === "datagram") {
    ready |= events & POLLOUT;
    if (socket.queue.length) ready |= events & POLLIN;
  } else {
    if (socket.connected || socket.relay?.connected) ready |= events & POLLOUT;
    if (socket.relay && (socket.relay.available() || socket.relay.eof)) ready |= events & POLLIN;
    if (socket.relay?.eof) ready |= POLLHUP | (events & 0x2000);
  }
  return ready;
}
export function watchNativeFd(fd: number, wake: () => void): () => void {
  const socket = sockets.get(fd)?.socket;
  if (!socket) return localPollProvider?.subscribe(fd, wake) ?? (() => {});
  socket.waiters.add(wake);
  const remove = socket.kind === "stream" ? socket.relay?.subscribe(wake) : undefined;
  return () => { socket.waiters.delete(wake); remove?.(); };
}
function scanPoll(pollfds: number, count: number): number {
  let ready = 0;
  for (let i = 0; i < count; i++) {
    const entry = pollfds + i * 8, fd = mem.ld32(entry);
    const events = fd < 0 ? 0 : nativePollEvents(fd, mem.ld16u(entry + 4));
    mem.st16(entry + 6, events);
    if (events) ready++;
  }
  return ready;
}

export function nativePoll(_cpu: Cpu, pollfds: number, count: number, timeout: number, signal?: AbortSignal): number | Promise<number> {
  const immediate = scanPoll(pollfds, count);
  if (immediate || timeout === 0 || signal?.aborted) return immediate;
  const target = mem.va(pollfds);
  return new Promise<number>((resolve) => {
    let finished = false;
    const cleanups: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const cleanup of cleanups) cleanup();
      if (timer !== undefined) clearTimeout(timer);
      const current = typeof target === "bigint" ? mem.txVa(target) : target;
      resolve(scanPoll(current, count));
    };
    for (let i = 0; i < count; i++) cleanups.push(watchNativeFd(mem.ld32(pollfds + i * 8), finish));
    if (signal) { signal.addEventListener("abort", finish, { once: true }); cleanups.push(() => signal.removeEventListener("abort", finish)); }
    if (timeout >= 0) timer = setTimeout(finish, timeout);
  });
}

const FD_SETSIZE = 1024;
const fdIsSet = (set: number, fd: number): boolean => !!set && !!(mem.u8[set + (fd >>> 3)] & (1 << (fd & 7)));
const setFd = (set: number, fd: number): void => { mem.u8[set + (fd >>> 3)] |= 1 << (fd & 7); };

/** Bionic select(2), sharing readiness and wakeups with poll(2). */
export function nativeSelect(cpu: Cpu, count: number, readSet: number, writeSet: number, exceptSet: number, timeout: number): number | Promise<number> {
  if (count < 0 || count > FD_SETSIZE) return fail(cpu, E.INVAL);
  const setBytes = Math.ceil(count / (PTR * 8)) * PTR;
  const requested: { fd: number; events: number }[] = [];
  for (let fd = 0; fd < count; fd++) {
    let events = 0;
    if (fdIsSet(readSet, fd)) events |= POLLIN;
    if (fdIsSet(writeSet, fd)) events |= POLLOUT;
    if (fdIsSet(exceptSet, fd)) events |= POLLPRI;
    if (events) requested.push({ fd, events });
  }

  let ms = -1;
  if (timeout) {
    const seconds = mem.ld32(timeout), micros = mem.ld32(timeout + PTR);
    if (seconds < 0 || micros < 0 || micros >= 1_000_000) return fail(cpu, E.INVAL);
    ms = seconds * 1000 + micros / 1000;
  }

  const pollfds = mem.malloc(requested.length * 8 || 1);
  for (let i = 0; i < requested.length; i++) {
    const entry = pollfds + i * 8;
    mem.st32(entry, requested[i].fd);
    mem.st16(entry + 4, requested[i].events);
    mem.st16(entry + 6, 0);
  }
  const pollVa = mem.va(pollfds);
  const setVas = [readSet, writeSet, exceptSet].map((set) => set ? mem.va(set) : 0);

  const finish = (): number => {
    const currentPoll = typeof pollVa === "bigint" ? mem.txVa(pollVa) : pollVa;
    const sets = setVas.map((set) => typeof set === "bigint" ? mem.txVa(set) : set);
    if (requested.some((_request, i) => mem.ld16u(currentPoll + i * 8 + 6) & POLLNVAL)) {
      mem.free(currentPoll);
      return fail(cpu, E.BADF);
    }
    for (const set of sets) if (set && setBytes) mem.memset(set, 0, setBytes);
    let ready = 0;
    for (let i = 0; i < requested.length; i++) {
      const { fd, events } = requested[i];
      const revents = mem.ld16u(currentPoll + i * 8 + 6);
      if (sets[0] && events & POLLIN && revents & (POLLIN | POLLERR | POLLHUP)) { setFd(sets[0], fd); ready++; }
      if (sets[1] && events & POLLOUT && revents & (POLLOUT | POLLERR)) { setFd(sets[1], fd); ready++; }
      if (sets[2] && events & POLLPRI && revents & POLLPRI) { setFd(sets[2], fd); ready++; }
    }
    mem.free(currentPoll);
    return ready;
  };

  const result = nativePoll(cpu, pollfds, requested.length, ms);
  return result instanceof Promise ? result.then(finish) : finish();
}

export function nativeGetsockopt(cpu: Cpu, fd: number, level: number, option: number, value: number, length: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (!value || !length || mem.ld32(length) < 4) return fail(cpu, E.FAULT);
  let result = 0;
  if (level === SOL_SOCKET && option === SO_TYPE) result = socket.kind === "datagram" ? SOCK_DGRAM : SOCK_STREAM;
  else if (level === SOL_SOCKET && option === SO_ERROR) {
    result = socket.error;
    socket.error = 0;
  }
  mem.st32(value, result);
  mem.st32(length, 4);
  return 0;
}

function nativeSocketName(cpu: Cpu, fd: number, address: number, length: number, peer: boolean): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (peer && !socket.connected) return fail(cpu, E.NOTCONN);
  const unbound: Ipv4Endpoint = { address: [0, 0, 0, 0], port: 0 };
  const endpoint = peer ? socket.peer : socket.local ?? (socket.kind === "datagram" || !socket.connected ? unbound : null);
  if (!endpoint) return fail(cpu, E.AFNOSUPPORT);
  if (!length) return fail(cpu, E.FAULT);
  const capacity = mem.ld32(length);
  if (capacity < 0) return fail(cpu, E.INVAL);
  if (capacity && !address) return fail(cpu, E.FAULT);

  const sockaddr = new Uint8Array(16);
  sockaddr[0] = AF_INET;
  sockaddr[2] = endpoint.port >>> 8;
  sockaddr[3] = endpoint.port & 255;
  sockaddr.set(endpoint.address, 4);
  mem.u8.set(sockaddr.subarray(0, Math.min(capacity, sockaddr.length)), address);
  mem.st32(length, sockaddr.length);
  return 0;
}

export function nativeGetsockname(cpu: Cpu, fd: number, address: number, length: number): number {
  return nativeSocketName(cpu, fd, address, length, false);
}

export function nativeGetpeername(cpu: Cpu, fd: number, address: number, length: number): number {
  return nativeSocketName(cpu, fd, address, length, true);
}

function copyText(text: string, destination: number, capacity: number): boolean {
  const bytes = new TextEncoder().encode(text);
  if (!destination) return capacity === 0;
  if (bytes.length + 1 > capacity) return false;
  mem.u8.set(bytes, destination);
  mem.u8[destination + bytes.length] = 0;
  return true;
}

export function nativeGetnameinfo(sockaddr: number, length: number, host: number, hostLength: number, service: number, serviceLength: number, flags = 0): number {
  if (!sockaddr || length < 8 || mem.ld16u(sockaddr) !== AF_INET) return EAI_ADDRFAMILY;
  const bytes = mem.u8.subarray(sockaddr + 4, sockaddr + 8);
  const numeric = ipv4Text(bytes), resolved = syntheticHosts.get(ipv4Key(bytes));
  if (!resolved && flags & NI_NAMEREQD) return EAI_NONAME;
  const name = flags & NI_NUMERICHOST ? numeric : resolved ?? numeric;
  const port = (mem.u8[sockaddr + 2] << 8) | mem.u8[sockaddr + 3];
  return copyText(name, host, hostLength) && copyText(String(port), service, serviceLength) ? 0 : EAI_OVERFLOW;
}

export function nativeSend(cpu: Cpu, fd: number, source: number, length: number): number {
  if (isNativeSocket(fd)) return nativeSocketWrite(cpu, fd, source, length);
  return localPollProvider?.write(cpu, fd, source, length) ?? fail(cpu, E.BADF);
}

export function nativeReceive(cpu: Cpu, fd: number, destination: number, length: number, nonblock = false): number | Promise<number> {
  if (isNativeSocket(fd)) return nativeSocketRead(cpu, fd, destination, length, nonblock);
  return localPollProvider?.read(cpu, fd, destination, length) ?? fail(cpu, E.BADF);
}

const gaiStrings = new Map<number, number>();
function gaiStrerror(code: number): number {
  const text = new Map<number, string>([
    [EAI_ADDRFAMILY, "address family for hostname not supported"], [2, "temporary failure in name resolution"],
    [EAI_BADFLAGS, "invalid value for ai_flags"], [EAI_FAMILY, "ai_family not supported"],
    [EAI_NONAME, "hostname nor servname provided, or not known"], [EAI_SERVICE, "servname not supported"],
    [EAI_SOCKTYPE, "ai_socktype not supported"], [EAI_SYSTEM, "system error"], [EAI_PROTOCOL, "resolved protocol is unknown"],
    [EAI_OVERFLOW, "argument buffer overflow"],
  ]).get(code) ?? "unknown error";
  let address = gaiStrings.get(code);
  if (address === undefined) { address = mem.hostStr(text); gaiStrings.set(code, address); }
  return address;
}

export function netInit(): void {
  const functions: Record<string, HostFn> = {
    socket: (cpu, args) => nativeSocket(cpu, args.i(), args.i(), args.i()),
    connect: (cpu, args) => nativeConnect(cpu, args.i(), args.p(), args.u()),
    bind: (cpu, args) => nativeBind(cpu, args.i(), args.p(), args.u()),
    send: (cpu, args) => { const fd = args.i(), source = args.p(), length = args.u(); args.i(); return nativeSend(cpu, fd, source, length); },
    sendto: (cpu, args) => {
      const fd = args.i(), source = args.p(), length = args.u();
      args.i(); const destination = args.p(), destinationLength = args.u();
      if (isNativeSocket(fd)) return nativeSendTo(cpu, fd, source, length, destination, destinationLength);
      if (destination || destinationLength) return fail(cpu, E.ISCONN);
      return nativeSend(cpu, fd, source, length);
    },
    recv: (cpu, args) => {
      const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i();
      return isNativeSocket(fd)
        ? nativeReceiveFrom(cpu, fd, destination, length, flags, 0, 0)
        : localPollProvider?.read(cpu, fd, destination, length) ?? fail(cpu, E.BADF);
    },
    recvfrom: (cpu, args) => {
      const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i();
      const source = args.p(), sourceLength = args.p();
      if (isNativeSocket(fd)) return nativeReceiveFrom(cpu, fd, destination, length, flags, source, sourceLength);
      if (source || sourceLength) return fail(cpu, E.NOTCONN);
      return nativeReceive(cpu, fd, destination, length, !!(flags & MSG_DONTWAIT));
    },
    shutdown: (cpu, args) => {
      const fd = args.i(); args.i();
      const descriptor = socketFdOf(cpu, fd);
      if (!descriptor) return -1;
      if (descriptor.socket.kind === "stream") descriptor.socket.relay?.close();
      return 0;
    },
    setsockopt: (cpu, args) => { const descriptor = socketFdOf(cpu, args.i()); args.i(); args.i(); args.p(); args.u(); return descriptor ? 0 : -1; },
    getsockopt: (cpu, args) => nativeGetsockopt(cpu, args.i(), args.i(), args.i(), args.p(), args.p()),
    getsockname: (cpu, args) => nativeGetsockname(cpu, args.i(), args.p(), args.p()),
    getpeername: (cpu, args) => nativeGetpeername(cpu, args.i(), args.p(), args.p()),
    getaddrinfo: (cpu, args) => nativeGetaddrinfo(cpu, args.p(), args.p(), args.p(), args.p()),
    freeaddrinfo: (_cpu, args) => nativeFreeaddrinfo(args.p()),
    gai_strerror: (_cpu, args) => ptr(gaiStrerror(args.i())),
    getnameinfo: (_cpu, args) => nativeGetnameinfo(args.p(), args.u(), args.p(), args.u(), args.p(), args.u(), args.i()),
    inet_pton: (_cpu, args) => { const family = args.i(), text = args.str(), out = args.p(); const bytes = parseIpv4(text); if (family !== AF_INET) return -1; if (!bytes) return 0; mem.u8.set(bytes, out); return 1; },
    inet_ntop: (_cpu, args) => { const family = args.i(), source = args.p(), destination = args.p(), length = args.u(); if (family !== AF_INET || !copyText(ipv4Text(mem.u8.subarray(source, source + 4)), destination, length)) return 0; return ptr(destination); },
    poll: (cpu, args) => nativePoll(cpu, args.p(), args.u(), args.i()),
    select: (cpu, args) => nativeSelect(cpu, args.i(), args.p(), args.p(), args.p(), args.p()),
  };
  hostLib("libc.so", functions);
}

export function setNativeRelayTransportFactoryForTest(factory: RelayTransportFactory | undefined): void { transportFactory = factory; }
export function resetNativeNetworkForTest(): void {
  const states = new Set<NativeSocket>();
  for (const [fd, descriptor] of sockets) { states.add(descriptor.socket); releaseFd(fd); }
  for (const socket of states) if (socket.kind === "stream") socket.relay?.close();
  sockets.clear();
  datagramBindings.clear();
  syntheticHosts.clear();
  syntheticAddresses.clear();
  nextSynthetic = 1;
  nextDatagramPort = 49_152;
  transportFactory = undefined;
  netDebug.events.length = 0;
}
