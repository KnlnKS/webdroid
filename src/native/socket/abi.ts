// The guest's socket structs as the process ABI lays them out: sockaddr_in/in6/un, msghdr, iovec,
// cmsghdr with its SCM payloads, struct ucred, linger and timeval. Pointer-sized offsets are taken
// from PTR when a call reads them, after the process ABI is set.

import { mem, anchor } from "../mem";
import { PTR, ldp, ldLong, stLong } from "../host";
import { E } from "../abi";
import { concat, utf8 } from "../../jvm/abi";
import { AF_UNIX, AF_INET, AF_INET6, endpointOf, type Endpoint } from "../net-address";

export const SOL_SOCKET = 1;
export const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_RAW = 3, SOCK_SEQPACKET = 5, SOCK_NONBLOCK = 0x800;
export const MSG_PEEK = 2, MSG_CTRUNC = 8, MSG_TRUNC = 0x20, MSG_DONTWAIT = 0x40, MSG_NOSIGNAL = 0x4000, MSG_CMSG_CLOEXEC = 0x40000000;
export const SCM_RIGHTS = 1, SCM_CREDENTIALS = 2;
export const SHUT_RD = 0, SHUT_WR = 1, SHUT_RDWR = 2;

/** a socket's address: an AF_UNIX name (an abstract one leads with NUL, "" is unnamed) or an
 *  internet endpoint, in its socket's family (an AF_INET6 socket's IPv4 peer is IPv4-mapped) */
export type SocketAddress = { family: typeof AF_UNIX; path: string } | { family: typeof AF_INET | typeof AF_INET6; ep: Endpoint };
export const unixAddress = (path: string): SocketAddress => ({ family: AF_UNIX, path });

/** sockaddr_un's sun_path bytes → the name: an abstract one is its bytes after the leading NUL */
export function sunPath(bytes: Uint8Array): string {
  if (bytes[0] === 0) return "\0" + utf8.dec.decode(bytes.subarray(1));
  const end = bytes.indexOf(0);
  return utf8.dec.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
/** a name's sun_path bytes, as getsockname(2) reports them: a pathname with its NUL */
export const sunPathBytes = (path: string): Uint8Array => utf8.enc.encode(path === "" || path[0] === "\0" ? path : path + "\0");
/** an endpoint as a sockaddr_in, or for an AF_INET6 socket a sockaddr_in6 (an IPv4 endpoint IPv4-mapped) */
export function sockaddrOf(family: number, { port, address, scope = 0 }: Endpoint): Uint8Array {
  if (family !== AF_INET6) return Uint8Array.of(AF_INET, 0, port >>> 8, port & 255, ...(address.length === 4 ? address : [0, 0, 0, 0]), 0, 0, 0, 0, 0, 0, 0, 0);
  const sockaddr = Uint8Array.of(AF_INET6, 0, port >>> 8, port & 255, 0, 0, 0, 0, ...new Array(20).fill(0));
  if (address.length === 4) sockaddr.set([255, 255, ...address], 18); else sockaddr.set(address, 8);
  new DataView(sockaddr.buffer).setUint32(24, scope, true);
  return sockaddr;
}
const NO_ADDRESS = new Uint8Array(0);
/** an address's whole sockaddr; none for no address */
export function sockaddrBytes(addr: SocketAddress | null): Uint8Array {
  if (!addr) return NO_ADDRESS;
  if (addr.family !== AF_UNIX) return sockaddrOf(addr.family, addr.ep);
  const name = sunPathBytes(addr.path), sockaddr = new Uint8Array(2 + name.length);
  sockaddr[0] = AF_UNIX;
  sockaddr.set(name, 2);
  return sockaddr;
}
/** a sockaddr_in or sockaddr_in6 for a socket of `family`, or -errno: a datagram an AF_INET6
 *  socket sends may name an IPv4 destination, which it reaches as IPv4-mapped */
export function readEndpoint(family: number, sockaddr: number, length: number, send = false): Endpoint | number {
  const given = sockaddr && length >= 2 ? mem.ld16u(sockaddr) : -1;
  if (length < (given === AF_INET ? 16 : given === AF_INET6 ? 24 : 2)) return -E.INVAL;
  if (given !== family && !(send && family === AF_INET6 && given === AF_INET)) return -E.AFNOSUPPORT;
  const port = (mem.ld8u(sockaddr + 2) << 8) | mem.ld8u(sockaddr + 3);
  return given === AF_INET ? { port, address: Array.from(mem.bytes(sockaddr + 4, 4)) }
    : endpointOf(mem.bytes(sockaddr + 8, 16), port, length >= 28 ? mem.ld32(sockaddr + 24) : 0);
}
/** the sockaddr a call names for a socket of `family`, or -errno */
export function readSockaddr(family: number, sockaddr: number, length: number, send = false): SocketAddress | number {
  if (family === AF_UNIX) {
    if (!sockaddr || length < 2 || mem.ld16u(sockaddr) !== AF_UNIX) return -E.INVAL;
    return unixAddress(sunPath(mem.bytes(sockaddr + 2, length - 2)));
  }
  const ep = readEndpoint(family, sockaddr, length, send);
  return typeof ep === "number" ? ep : { family: family as typeof AF_INET | typeof AF_INET6, ep };
}
/** an address result: as much of the sockaddr as `capacity` holds at `p`, and its whole length at `lengthAt` */
export function writeSockaddr(addr: SocketAddress | null, p: number, lengthAt: number, capacity = mem.ld32(lengthAt)): void {
  const sockaddr = sockaddrBytes(addr);
  if (capacity > 0) mem.write(p, sockaddr.subarray(0, Math.min(capacity, sockaddr.length)));
  mem.st32(lengthAt, sockaddr.length);
}

/** a guest buffer an await may outlive */
export interface GuestBuffer { at: () => number; length: number }
export const guestBuffer = (p: number, length: number): GuestBuffer => ({ at: anchor(p), length });
/** an iovec array's entries */
export const iovecs = (iov: number, count: number): GuestBuffer[] =>
  Array.from({ length: count }, (_, i) => guestBuffer(ldp(iov + i * 2 * PTR), ldLong(iov + i * 2 * PTR + PTR)));
/** an iovec array's bytes as one buffer: what one datagram carries */
export function gather(iov: number, count: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) { const entry = iov + i * 2 * PTR; parts.push(mem.bytes(ldp(entry), mem.ld32(entry + PTR) >>> 0)); }
  return concat(parts);
}

/** struct msghdr: pointer-sized fields after msg_namelen; the *At fields are where results go back */
export function readMsghdr(msg: number) {
  return {
    name: ldp(msg), nameLength: mem.ld32(msg + PTR), nameLengthAt: msg + PTR, iov: ldp(msg + 2 * PTR), iovCount: ldLong(msg + 3 * PTR),
    control: ldp(msg + 4 * PTR), controlLength: ldLong(msg + 5 * PTR), controlLengthAt: msg + 5 * PTR, flagsAt: msg + 6 * PTR,
  };
}

/** struct cmsghdr's size (cmsg_len is a size_t) and CMSG_ALIGN */
const cmsgHeader = () => PTR === 8 ? 16 : 12;
const cmsgAlign = (n: number) => (n + PTR - 1) & -PTR;
/** one ancillary data object: its level, type and payload */
export interface Cmsg { level: number; type: number; data: Uint8Array }
/** sendmsg's msg_control as its objects; -EINVAL for one that overruns it */
export function readCmsgs(control: number, length: number): Cmsg[] | number {
  const header = cmsgHeader(), out: Cmsg[] = [];
  for (let off = 0; off + header <= length;) {
    const at = control + off, len = ldLong(at);
    if (len < header || off + len > length) return -E.INVAL;
    out.push({ level: mem.ld32(at + PTR), type: mem.ld32(at + PTR + 4), data: mem.bytes(at + header, len - header).slice() });
    off += cmsgAlign(len);
  }
  return out;
}
/** an SCM_RIGHTS payload's descriptors */
export const scmRights = (data: Uint8Array): Int32Array => new Int32Array(data.slice(0, data.length & ~3).buffer);
/** recvmsg's ancillary data as scm_recv lays it into msg_control: SCM_CREDENTIALS, then SCM_RIGHTS
 *  with as many of `rights` descriptors as fit, which `install` makes (releasing the rest). What is
 *  cut is MSG_CTRUNC's, as put_cmsg shortens a message. */
export function writeControl(at: number, capacity: number, credentials: Ucred | null, rights: number, install: (fit: number) => ArrayLike<number>): { used: number; truncated: boolean } {
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
  if (credentials) cmsg(SCM_CREDENTIALS, ucredBytes(credentials));
  if (rights) {
    const room = at ? capacity - used : 0, fit = room > header ? Math.min(rights, (room - header) >> 2) : 0;
    if (fit < rights) truncated = true;
    const fds = install(fit);
    if (fit) cmsg(SCM_RIGHTS, new Uint8Array(Int32Array.from(fds).buffer));
  }
  return { used, truncated };
}

/** struct ucred */
export interface Ucred { pid: number; uid: number; gid: number }
export const ucredBytes = (c: Ucred): Uint8Array => new Uint8Array(Int32Array.of(c.pid, c.uid, c.gid).buffer);
export const readUcred = (data: Uint8Array): Ucred | null => {
  if (data.length !== 12) return null;
  const v = new DataView(data.buffer, data.byteOffset, 12);
  return { pid: v.getInt32(0, true), uid: v.getInt32(4, true), gid: v.getInt32(8, true) };
};
/** struct timeval: tv_sec and tv_usec, longs */
export const TIMEVAL_SIZE = (): number => 2 * PTR;
export const readTimeval = (p: number): { sec: number; usec: number } => ({ sec: ldLong(p), usec: ldLong(p + PTR) });
export function writeTimeval(p: number, ms: number): void { stLong(p, Math.floor(ms / 1000)); stLong(p + PTR, ms % 1000 * 1000); }
