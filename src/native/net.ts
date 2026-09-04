// Bionic's IPv4 stream-socket surface over the shared browser WebSocket → TCP relay.

import { Relay, type RelayTransportFactory } from "../shell/relay";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { hostLib, PTR, stp, type HostFn, type HostRet, ptr } from "./host";
import { mem } from "./mem";
import { allocateFd, releaseFd, reserveFd } from "./fd";

const AF_UNSPEC = 0, AF_INET = 2, SOCK_STREAM = 1, IPPROTO_TCP = 6;
const SOCK_NONBLOCK = 0x800, SOCK_CLOEXEC = 0x80000;
const F_GETFD = 1, F_SETFD = 2, F_GETFL = 3, F_SETFL = 4;
const O_RDWR = 2, O_NONBLOCK = 0x800;
const SOL_SOCKET = 1, SO_ERROR = 4;
const POLLIN = 1, POLLPRI = 2, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;
const AI_PASSIVE = 1, AI_CANONNAME = 2, AI_NUMERICHOST = 4, AI_NUMERICSERV = 8, AI_ADDRCONFIG = 0x400;
const EAI_ADDRFAMILY = 1, EAI_BADFLAGS = 3, EAI_FAMILY = 5, EAI_NONAME = 8;
const EAI_SERVICE = 9, EAI_SOCKTYPE = 10, EAI_SYSTEM = 11, EAI_PROTOCOL = 13, EAI_OVERFLOW = 14;
const NI_NUMERICHOST = 2, NI_NAMEREQD = 4;

interface NativeSocket {
  nonblock: boolean;
  relay: Relay | null;
  connecting: boolean;
  connected: boolean;
  error: number;
  waiters: Set<() => void>;
  references: number;
  peer: Ipv4Endpoint | null;
  local: Ipv4Endpoint | null;
}
interface NativeSocketFd { socket: NativeSocket; cloexec: boolean }
interface Ipv4Endpoint { address: [number, number, number, number]; port: number }

const sockets = new Map<number, NativeSocketFd>();
const syntheticHosts = new Map<number, string>();
const syntheticAddresses = new Map<string, [number, number, number, number]>();
let nextSynthetic = 1;
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
const wake = (socket: NativeSocket): void => { for (const waiter of socket.waiters) waiter(); socket.waiters.clear(); };
const socketFdOf = (cpu: Cpu, fd: number): NativeSocketFd | null => sockets.get(fd) ?? (fail(cpu, E.BADF), null);
const ipv4Key = (bytes: ArrayLike<number>): number =>
  (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
const ipv4Text = (bytes: ArrayLike<number>): string => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;

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
  if (socktype !== 0 && socktype !== SOCK_STREAM) return EAI_SOCKTYPE;
  if (protocol !== 0 && protocol !== IPPROTO_TCP) return EAI_PROTOCOL;
  if (!nodePtr && !servicePtr) return EAI_NONAME;

  const numeric = parseIpv4(node);
  if (!numeric && flags & AI_NUMERICHOST) return EAI_NONAME;
  let port = /^\d+$/.test(service) ? Number(service) : service === "http" && !(flags & AI_NUMERICSERV) ? 80 : service === "https" && !(flags & AI_NUMERICSERV) ? 443 : -1;
  if (!Number.isInteger(port) || port < 0 || port > 65535) return EAI_SERVICE;

  const bytes = numeric ?? addressFor(node);
  const layout = addrinfoLayout();
  const sockaddr = layout.size;
  const canonBytes = flags & AI_CANONNAME ? new TextEncoder().encode(node) : null;
  const allocation = mem.malloc(layout.size + 16 + (canonBytes ? canonBytes.length + 1 : 0));
  if (!allocation) { fail(cpu, E.NOMEM); return EAI_SYSTEM; }
  mem.memset(allocation, 0, layout.size + 16 + (canonBytes ? canonBytes.length + 1 : 0));
  mem.st32(allocation, flags);
  mem.st32(allocation + 4, AF_INET);
  mem.st32(allocation + 8, SOCK_STREAM);
  mem.st32(allocation + 12, IPPROTO_TCP);
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
  if (baseType !== SOCK_STREAM) return fail(cpu, E.SOCKTNOSUPPORT);
  if (protocol !== 0 && protocol !== IPPROTO_TCP) return fail(cpu, E.PROTONOSUPPORT);
  const fd = allocateFd();
  sockets.set(fd, {
    cloexec: !!(type & SOCK_CLOEXEC),
    socket: {
      nonblock: !!(type & SOCK_NONBLOCK), relay: null, connecting: false, connected: false,
      error: 0, waiters: new Set(), references: 1, peer: null, local: null,
    },
  });
  record(`socket fd=${fd} family=${domain} type=${type.toString(16)} protocol=${protocol}`);
  return fd;
}

export function nativeConnect(cpu: Cpu, fd: number, sockaddr: number, length: number): HostRet | Promise<HostRet> {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (socket.connected) return fail(cpu, E.ISCONN);
  if (socket.connecting) return fail(cpu, E.ALREADY);
  if (!sockaddr || length < 8) return fail(cpu, E.INVAL);
  if (mem.ld16u(sockaddr) !== AF_INET) return fail(cpu, E.PROTONOSUPPORT);
  const port = (mem.u8[sockaddr + 2] << 8) | mem.u8[sockaddr + 3];
  const bytes: [number, number, number, number] = [
    mem.u8[sockaddr + 4], mem.u8[sockaddr + 5], mem.u8[sockaddr + 6], mem.u8[sockaddr + 7],
  ];
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

export function isNativeSocket(fd: number): boolean { return sockets.has(fd); }

export function nativeSocketClose(cpu: Cpu, fd: number): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  sockets.delete(fd);
  releaseFd(fd);
  if (--socket.references === 0) socket.relay?.close();
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
  if (!socket.connected || !socket.relay) return fail(cpu, socket.error || E.NOTCONN);
  if (!length) return 0;
  return socket.relay.write(mem.u8.slice(source, source + length)) ? length : fail(cpu, E.NOTCONN);
}

export function pollHasNativeSocket(pollfds: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (sockets.has(mem.ld32(pollfds + i * 8))) return true;
  return false;
}

function scanPoll(pollfds: number, count: number): number {
  let ready = 0;
  for (let i = 0; i < count; i++) {
    const entry = pollfds + i * 8, fd = mem.ld32(entry), events = mem.ld16u(entry + 4);
    if (fd < 0) { mem.st16(entry + 6, 0); continue; }
    const socket = sockets.get(fd)?.socket;
    let revents = 0;
    if (!socket) revents = localPollProvider?.query(fd, events) ?? POLLNVAL;
    else {
      if (socket.error) revents |= POLLERR;
      if ((socket.connected || socket.relay?.connected) && events & POLLOUT) revents |= POLLOUT;
      if (socket.relay && (socket.relay.available() || socket.relay.eof) && events & POLLIN) revents |= POLLIN;
      if (socket.relay?.eof) revents |= POLLHUP;
    }
    mem.st16(entry + 6, revents);
    if (revents) ready++;
  }
  return ready;
}

export function nativePoll(_cpu: Cpu, pollfds: number, count: number, timeout: number): number | Promise<number> {
  const immediate = scanPoll(pollfds, count);
  if (immediate || timeout === 0) return immediate;
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
    for (let i = 0; i < count; i++) {
      const socket = sockets.get(mem.ld32(pollfds + i * 8))?.socket;
      if (!socket) continue;
      socket.waiters.add(finish);
      cleanups.push(() => socket.waiters.delete(finish));
      if (socket.relay) cleanups.push(socket.relay.subscribe(finish));
    }
    if (localPollProvider) {
      for (let i = 0; i < count; i++) {
        const fd = mem.ld32(pollfds + i * 8);
        if (!sockets.has(fd)) cleanups.push(localPollProvider.subscribe(fd, finish));
      }
    }
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
  if (level !== SOL_SOCKET || option !== SO_ERROR) { mem.st32(value, 0); mem.st32(length, 4); return 0; }
  mem.st32(value, socket.error);
  socket.error = 0;
  mem.st32(length, 4);
  return 0;
}

function nativeSocketName(cpu: Cpu, fd: number, address: number, length: number, peer: boolean): number {
  const descriptor = socketFdOf(cpu, fd);
  if (!descriptor) return -1;
  const socket = descriptor.socket;
  if (peer && !socket.connected) return fail(cpu, E.NOTCONN);
  const endpoint = peer ? socket.peer : socket.connected ? socket.local : { address: [0, 0, 0, 0] as [number, number, number, number], port: 0 };
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
    send: (cpu, args) => { const fd = args.i(), source = args.p(), length = args.u(); args.i(); return nativeSend(cpu, fd, source, length); },
    sendto: (cpu, args) => {
      const fd = args.i(), source = args.p(), length = args.u();
      args.i(); const destination = args.p(), destinationLength = args.u();
      if (destination || destinationLength) return fail(cpu, E.ISCONN);
      return nativeSend(cpu, fd, source, length);
    },
    recv: (cpu, args) => { const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i(); return nativeReceive(cpu, fd, destination, length, !!(flags & 0x40)); },
    recvfrom: (cpu, args) => {
      const fd = args.i(), destination = args.p(), length = args.u(), flags = args.i();
      const source = args.p(), sourceLength = args.p();
      if (source || sourceLength) return fail(cpu, E.NOTCONN);
      return nativeReceive(cpu, fd, destination, length, !!(flags & 0x40));
    },
    shutdown: (cpu, args) => { const fd = args.i(); args.i(); const descriptor = socketFdOf(cpu, fd); if (!descriptor) return -1; descriptor.socket.relay?.close(); return 0; },
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
  for (const socket of states) socket.relay?.close();
  sockets.clear();
  syntheticHosts.clear();
  syntheticAddresses.clear();
  nextSynthetic = 1;
  transportFactory = undefined;
  netDebug.events.length = 0;
}
