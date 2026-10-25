// The socket calls over guest memory: the kernel's (NET_SYSCALLS, which raw svcs and libc's
// wrappers reach) and the ARM32 libc's send, recv, poll, select and resolver functions. Each
// marshals with abi.ts and hands the socket core JS values.

import { E } from "../abi.ts";
import type { Cpu } from "../cpu.ts";
import { hostLib, stLong, complete, type HostFn, type HostRet } from "../host.ts";
import { mem, anchor } from "../mem.ts";
import { wrapped } from "../kernel.ts";
import { fdWrite, written } from "../fs.ts";
import { installFile, dropFile, readFd, type OpenFile } from "../fd.ts";
import { nativePoll, nativeSelect } from "../poll.ts";
import { AF_UNSPEC, AF_UNIX, AF_INET, AF_INET6 } from "../net-address.ts";
import {
  SOL_SOCKET, MSG_CTRUNC, MSG_TRUNC, MSG_CMSG_CLOEXEC, readSockaddr, writeSockaddr, readMsghdr, readCmsgs, writeControl, gather,
  iovecs, guestBuffer, ucredBytes, readTimeval, writeTimeval, TIMEVAL_SIZE, type GuestBuffer, type Cmsg,
} from "./abi.ts";
import { record, installSocket, socketOf, SO_LINGER, SO_PEERCRED, SO_RCVTIMEO, SO_SNDTIMEO, type Socket, type Received, type Accepted } from "./core.ts";
import { inetSocket, IPPROTO_IP, IP_ADD_MEMBERSHIP, IP_DROP_MEMBERSHIP } from "./inet.ts";
import { unixSocket, unixSocketPair } from "./unix.ts";
import { RESOLVER, hostLookups } from "./resolver.ts";

const UIO_MAXIOV = 1024;

/** socket(2): a new socket's descriptor, or -errno */
export function socketCreate(domain: number, type: number, protocol: number): number {
  const s = domain === AF_INET || domain === AF_INET6 ? inetSocket(domain, type, protocol) : domain === AF_UNIX ? unixSocket(type) : -E.AFNOSUPPORT;
  if (typeof s === "number") return s;
  const fd = installSocket(s, type);
  record(`socket fd=${fd} family=${domain} type=${type.toString(16)} protocol=${protocol}`);
  return fd;
}
/** socketpair(2) of AF_UNIX: two connected sockets' descriptors, or -errno */
export function socketPair(type: number): [number, number] | number {
  const pair = unixSocketPair(type);
  return typeof pair === "number" ? pair : [installSocket(pair[0], type), installSocket(pair[1], type)];
}

/** where recvfrom(2)/recvmsg(2) report what came with the bytes: the sender's sockaddr and its
 *  length, msg_flags, and msg_control with where its length goes back */
interface Results { name: number; nameLength: number; messageFlags: number; control: { at: () => number; capacity: number; lengthAt: () => number } | null }
const NO_RESULTS: Results = { name: 0, nameLength: 0, messageFlags: 0, control: null };
/** recv(2)/recvfrom(2)/recvmsg(2) into the guest's buffers, which the bytes reach once they arrive */
function receive(fd: number, s: Socket, buffers: GuestBuffer[], flags: number, { name, nameLength, messageFlags, control }: Results): number | Promise<number> {
  if (name && !nameLength) return -E.FAULT;
  if (name && mem.ld32(nameLength) < 0) return -E.INVAL;
  const total = buffers.reduce((n, b) => n + b.length, 0), target = new Uint8Array(total);
  const nameAt = anchor(name), lengthAt = anchor(nameLength), flagsAt = anchor(messageFlags);
  const land = (r: Received | number): number => {
    if (typeof r === "number") return r;
    let cut = 0;
    if (control) {
      const { used, truncated } = writeControl(control.at(), control.capacity, r.credentials, r.rights.length, (fit) => install(r.rights, fit, !!(flags & MSG_CMSG_CLOEXEC)));
      stLong(control.lengthAt(), used);
      if (truncated) cut = MSG_CTRUNC;
    } else r.rights.forEach(dropFile);
    for (let i = 0, at = 0; at < r.length; i++) {
      const k = Math.min(buffers[i].length, r.length - at);
      if (k) mem.write(buffers[i].at(), target.subarray(at, at + k));
      at += k;
    }
    if (name) writeSockaddr(r.from, nameAt(), lengthAt());
    if (messageFlags) mem.st32(flagsAt(), (r.size > total ? MSG_TRUNC : 0) | cut);
    return flags & MSG_TRUNC ? r.size : r.length;
  };
  return complete(s.receive(fd, target, flags), land);
}
/** the first `fit` received open files at the lowest free descriptors; the rest are dropped */
function install(rights: OpenFile[], fit: number, cloexec: boolean): number[] {
  rights.slice(fit).forEach(dropFile);
  return rights.slice(0, fit).map((f) => installFile(f, cloexec));
}
/** sendto(2)/sendmsg(2) of `bytes`, to the sockaddr at `destination` if there is one */
function send(cpu: Cpu, s: Socket, bytes: Uint8Array, destination: number, destinationLength: number, flags: number, control: Cmsg[] | null = null): number {
  const to = destination || destinationLength ? readSockaddr(s.family, destination, destinationLength, true) : null;
  if (typeof to === "number") return to;
  return written(cpu, s.file, s.send(bytes, to, control), flags);
}
function accept(fd: number, address: number, length: number, flags: number): HostRet | Promise<HostRet> {
  const s = socketOf(fd);
  if (typeof s === "number") return s;
  const addressAt = anchor(address), lengthAt = anchor(length);
  const land = (r: Accepted | number): number => {
    if (typeof r === "number") return r;
    if (address && length) writeSockaddr(r.peer, addressAt(), lengthAt());
    return r.fd;
  };
  return complete(s.accept(fd, flags), land);
}
function sockname(fd: number, address: number, length: number, peer: boolean): number {
  const s = socketOf(fd);
  if (typeof s === "number") return s;
  const name = s.name(peer);
  if (typeof name === "number") return name;
  const capacity = mem.ld32(length);
  if (capacity < 0) return -E.INVAL;
  writeSockaddr(name, address, length, capacity);
  return 0;
}
function getsockopt(fd: number, level: number, name: number, value: number, length: number): number {
  const s = socketOf(fd);
  if (typeof s === "number") return s;
  if (!value || !length || mem.ld32(length) < 4) return -E.FAULT;
  if (level === SOL_SOCKET && name === SO_PEERCRED) {
    const c = s.peerCredentials(), n = Math.min(mem.ld32(length), 12);
    if (typeof c === "number") return c;
    mem.write(value, ucredBytes(c).subarray(0, n));
    mem.st32(length, n);
    return 0;
  }
  const result = s.getOption(level, name);
  if (result < 0) return result;
  if (level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO)) {
    if (mem.ld32(length) < TIMEVAL_SIZE()) return -E.INVAL;
    writeTimeval(value, result); mem.st32(length, TIMEVAL_SIZE());
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
/** an option the model does not keep is accepted as the kernel would, with nothing to observe */
const accepted = (r: number): number => r === -E.NOPROTOOPT ? 0 : r;
function setsockopt(fd: number, level: number, name: number, value: number, length: number): number {
  const s = socketOf(fd);
  if (typeof s === "number") return s;
  if (level === IPPROTO_IP && (name === IP_ADD_MEMBERSHIP || name === IP_DROP_MEMBERSHIP) && value && length >= 8)
    return accepted(s.group(name === IP_ADD_MEMBERSHIP, Array.from(mem.bytes(value, 4)), length >= 12 ? mem.ld32(value + 8) : 0));
  if (level === SOL_SOCKET && name === SO_LINGER) return value && length >= 8 ? s.setOption(level, name, mem.ld32(value) ? mem.ld32(value + 4) : -1) : -E.INVAL;
  if (level === SOL_SOCKET && (name === SO_RCVTIMEO || name === SO_SNDTIMEO)) {
    if (!value || length < TIMEVAL_SIZE()) return -E.INVAL;
    const { sec, usec } = readTimeval(value);
    if (usec < 0 || usec >= 1_000_000) return -E.DOM;
    return s.setOption(level, name, sec < 0 ? 0 : sec * 1000 + Math.ceil(usec / 1000));
  }
  if (!value || length < 1) return -E.INVAL;
  return accepted(s.setOption(level, name, length >= 4 ? mem.ld32(value) : mem.u8[value]));
}
/** sendto(2): a descriptor that is no socket takes a plain write */
function sendto(cpu: Cpu, fd: number, source: number, length: number, flags: number, destination: number, destinationLength: number): number | Promise<number> {
  const s = socketOf(fd);
  if (typeof s === "number") return destination || destinationLength ? -E.ISCONN : fdWrite(cpu, fd, source, length);
  return send(cpu, s, mem.bytes(source, length), destination, destinationLength, flags);
}
/** recvfrom(2): a descriptor that is no socket takes a plain read */
function recvfrom(fd: number, destination: number, length: number, flags: number, source = 0, sourceLength = 0): number | Promise<number> {
  const s = socketOf(fd);
  if (typeof s !== "number") return length && !destination ? -E.FAULT : receive(fd, s, [guestBuffer(destination, length)], flags, { ...NO_RESULTS, name: source, nameLength: sourceLength });
  if (source || sourceLength) return -E.NOTCONN;
  return readFd(fd, destination, length);
}

export const NET_SYSCALLS: Record<string, HostFn> = {
  socket: (_c, a) => { const domain = a.i(), type = a.i(), protocol = a.i(); return socketCreate(domain, type, protocol); },
  socketpair: (_c, a) => {
    const domain = a.i(), type = a.i(); a.i(); const sv = a.p();
    if (domain !== AF_UNIX) return -(domain === AF_INET || domain === AF_INET6 ? E.NOTSUP : E.AFNOSUPPORT);
    const pair = socketPair(type);
    if (typeof pair === "number") return pair;
    mem.st32(sv, pair[0]); mem.st32(sv + 4, pair[1]);
    return 0;
  },
  connect: (_c, a) => {
    const fd = a.i(), sockaddr = a.p(), length = a.u(), s = socketOf(fd);
    if (typeof s === "number") return s;
    if (sockaddr && length >= 2 && mem.ld16u(sockaddr) === AF_UNSPEC) return s.connect(null);
    const addr = readSockaddr(s.family, sockaddr, length);
    return typeof addr === "number" ? addr : s.connect(addr);
  },
  bind: (_c, a) => {
    const fd = a.i(), sockaddr = a.p(), length = a.u(), s = socketOf(fd);
    if (typeof s === "number") return s;
    const addr = readSockaddr(s.family, sockaddr, length);
    return typeof addr === "number" ? addr : s.bind(addr);
  },
  listen: (_c, a) => { const s = socketOf(a.i()); a.i(); return typeof s === "number" ? s : s.listen(); },
  accept: (_c, a) => accept(a.i(), a.p(), a.p(), 0),
  accept4: (_c, a) => accept(a.i(), a.p(), a.p(), a.i()),
  sendto: (cpu, a) => sendto(cpu, a.i(), a.p(), a.u(), a.i(), a.p(), a.u()),
  recvfrom: (_c, a) => recvfrom(a.i(), a.p(), a.u(), a.i(), a.p(), a.p()),
  sendmsg: (cpu, a) => {
    const fd = a.i(), msg = a.p(), flags = a.i(), s = socketOf(fd);
    if (typeof s === "number") return s;
    const m = readMsghdr(msg);
    if (m.iovCount < 0 || m.iovCount > UIO_MAXIOV) return -E.MSGSIZE;
    const control = m.control && m.controlLength ? readCmsgs(m.control, m.controlLength) : null;
    if (typeof control === "number") return control;
    return send(cpu, s, gather(m.iov, m.iovCount), m.name, m.nameLength, flags, control);
  },
  recvmsg: (_c, a) => {
    const fd = a.i(), msg = a.p(), flags = a.i(), s = socketOf(fd);
    if (typeof s === "number") return s;
    const m = readMsghdr(msg);
    if (m.iovCount < 0 || m.iovCount > UIO_MAXIOV) return -E.MSGSIZE;
    const control = { at: anchor(m.control), capacity: m.controlLength, lengthAt: anchor(m.controlLengthAt) };
    return receive(fd, s, iovecs(m.iov, m.iovCount), flags, { name: m.name, nameLength: m.nameLengthAt, messageFlags: m.flagsAt, control });
  },
  shutdown: (_c, a) => { const s = socketOf(a.i()), how = a.i(); return typeof s === "number" ? s : s.shutdown(how); },
  setsockopt: (_c, a) => setsockopt(a.i(), a.i(), a.i(), a.p(), a.u()),
  getsockopt: (_c, a) => getsockopt(a.i(), a.i(), a.i(), a.p(), a.p()),
  getsockname: (_c, a) => sockname(a.i(), a.p(), a.p(), false),
  getpeername: (_c, a) => sockname(a.i(), a.p(), a.p(), true),
};

export function netInit(): void {
  hostLib("libc.so", {
    ...RESOLVER, ...hostLookups(),
    send: wrapped((cpu, a) => sendto(cpu, a.i(), a.p(), a.u(), a.i(), 0, 0)),
    recv: wrapped((_c, a) => recvfrom(a.i(), a.p(), a.u(), a.i())),
    poll: wrapped((_c, a) => nativePoll(a.p(), a.u(), a.i())),
    select: wrapped((_c, a) => {
      const count = a.i(), r = a.p(), w = a.p(), x = a.p(), timeout = a.p();
      if (!timeout) return nativeSelect(count, r, w, x, -1);
      const { sec, usec } = readTimeval(timeout);
      if (sec < 0 || usec < 0 || usec >= 1_000_000) return -E.INVAL;
      return nativeSelect(count, r, w, x, sec * 1000 + usec / 1000);
    }),
  });
}
