// The ARM32 libc's resolver functions over guest memory: getaddrinfo, getnameinfo, getifaddrs,
// gai_strerror and inet_pton/ntop, over net-address.ts's resolver and interfaces; and getaddrinfo's
// hints, which netd's dnsproxyd (daemons.ts) checks alike for a 64-bit process's bionic.

import { E } from "../abi.ts";
import { utf8 } from "../../jvm/abi.ts";
import type { Cpu } from "../cpu.ts";
import { stp, ptr, cstr, complete, type HostFn } from "../host.ts";
import { mem, anchor } from "../mem.ts";
import { fail } from "../kernel.ts";
import {
  AF_UNSPEC, AF_INET, AF_INET6, AI_NUMERICHOST, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME, EAI_FAMILY, EAI_SERVICE, EAI_SOCKTYPE, V4_LOOPBACK,
  familyOf, parseIpv4, parseIpv6, addressText, resolveHost, hostOf, gaiText, INTERFACES,
} from "../net-address.ts";
import { SOCK_STREAM, SOCK_DGRAM, SOCK_RAW, sockaddrOf, readEndpoint } from "./abi.ts";
import { record } from "./core.ts";
import { IPPROTO_TCP, IPPROTO_UDP } from "./inet.ts";

const AI_PASSIVE = 1, AI_NUMERICSERV = 8, AI_ADDRCONFIG = 0x400;
export const AI_CANONNAME = 2;
const EAI_BADFLAGS = 3, EAI_SYSTEM = 11, EAI_PROTOCOL = 13, EAI_OVERFLOW = 14;

/** the ARM32 struct ifaddrs: its size and the offsets of what getifaddrs fills */
const IFADDRS = { size: 28, name: 4, flags: 8, addr: 12, netmask: 16 };
function getifaddrs(cpu: Cpu, result: number): number {
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
  mem.u8.set([...utf8.enc.encode(lo.name), 0], name);
  stp(result, entry);
  return 0;
}

/** getaddrinfo's hints checked: the port, and the socket types with their protocols to answer,
 *  stream before datagram (SOCK_RAW only when asked for, as bionic's explore table matches it); or an EAI_* code */
export function addrinfoCandidates(flags: number, family: number, socktype: number, protocol: number, service: string | null): { port: number; kinds: number[][] } | number {
  if (flags & ~(AI_PASSIVE | AI_CANONNAME | AI_NUMERICHOST | AI_NUMERICSERV | AI_ADDRCONFIG)) return EAI_BADFLAGS;
  if (family !== AF_UNSPEC && family !== AF_INET && family !== AF_INET6) return EAI_FAMILY;
  if (socktype !== 0 && socktype !== SOCK_STREAM && socktype !== SOCK_DGRAM && socktype !== SOCK_RAW) return EAI_SOCKTYPE;
  if (socktype !== SOCK_RAW && protocol !== 0 && protocol !== IPPROTO_TCP && protocol !== IPPROTO_UDP) return EAI_PROTOCOL;
  const kinds = socktype === SOCK_RAW ? [[SOCK_RAW, protocol]]
    : [[SOCK_STREAM, IPPROTO_TCP], [SOCK_DGRAM, IPPROTO_UDP]].filter(([type, proto]) => (!socktype || socktype === type) && (!protocol || protocol === proto));
  if (!kinds.length) return EAI_SOCKTYPE;
  // of the services table, the names a client here asks for
  const named = service === "http" ? 80 : service === "https" ? 443 : -1;
  const port = service === null ? 0 : /^\d+$/.test(service) ? Number(service) : flags & AI_NUMERICSERV ? -1 : named;
  if (port < 0 || port > 65535 || service !== null && socktype === SOCK_RAW) return EAI_SERVICE;
  return { port, kinds };
}

/** the ARM32 struct addrinfo: its size and the offsets of its fields */
const ADDRINFO = { size: 32, flags: 0, family: 4, socktype: 8, protocol: 12, addrlen: 16, canon: 20, addr: 24, next: 28 };
/** getaddrinfo(3): one allocation holding the list, every address for each socket type, the
 *  canonical name on the first */
function getaddrinfo(cpu: Cpu, nodePtr: number, servicePtr: number, hints: number, result: number): number | Promise<number> {
  if (!result) { fail(cpu, E.FAULT); return EAI_SYSTEM; }
  const flags = hints ? mem.ld32(hints + ADDRINFO.flags) : 0;
  const family = hints ? mem.ld32(hints + ADDRINFO.family) : AF_UNSPEC;
  const socktype = hints ? mem.ld32(hints + ADDRINFO.socktype) : 0;
  const protocol = hints ? mem.ld32(hints + ADDRINFO.protocol) : 0;
  const v6 = family === AF_INET6;
  const node = nodePtr ? mem.cstr(nodePtr) : flags & AI_PASSIVE ? v6 ? "::" : "0.0.0.0" : v6 ? "::1" : "127.0.0.1";
  const service = servicePtr ? mem.cstr(servicePtr) : null;
  record(`getaddrinfo ${node}:${service} flags=${flags.toString(16)} family=${family} type=${socktype} protocol=${protocol}`);
  const candidates = addrinfoCandidates(flags, family, socktype, protocol, service);
  if (typeof candidates === "number") return candidates;
  if (!nodePtr && !servicePtr) return EAI_NONAME;
  const { port, kinds } = candidates, resultAt = anchor(result);
  const answer = (found: number[][] | number): number => {
    if (typeof found === "number") return found;
    const sockaddrs = found.map((address) => sockaddrOf(familyOf(address), { address, port }));
    const canon = flags & AI_CANONNAME ? utf8.enc.encode(node) : null;
    let size = canon ? canon.length + 1 : 0;
    for (const sockaddr of sockaddrs) size += (ADDRINFO.size + sockaddr.length) * kinds.length;
    const allocation = mem.malloc(size);
    if (!allocation) { fail(cpu, E.NOMEM); return EAI_SYSTEM; }
    mem.memset(allocation, 0, size);
    let at = allocation, previous = 0;
    for (let i = 0; i < found.length; i++) for (const [type, proto] of kinds) {
      const sockaddr = sockaddrs[i];
      if (previous) stp(previous + ADDRINFO.next, at);
      mem.st32(at + ADDRINFO.flags, flags);
      mem.st32(at + ADDRINFO.family, familyOf(found[i]));
      mem.st32(at + ADDRINFO.socktype, type);
      mem.st32(at + ADDRINFO.protocol, proto);
      mem.st32(at + ADDRINFO.addrlen, sockaddr.length);
      stp(at + ADDRINFO.addr, at + ADDRINFO.size);
      mem.write(at + ADDRINFO.size, sockaddr);
      previous = at; at += ADDRINFO.size + sockaddr.length;
    }
    if (canon) { mem.u8.set(canon, at); stp(allocation + ADDRINFO.canon, at); }
    stp(resultAt(), allocation);
    record(`resolved ${node} -> ${addressText(found[0])} result=${mem.va(allocation).toString()}`);
    return 0;
  };
  return complete(resolveHost(node, family, flags & AI_NUMERICHOST), answer);
}

function copyText(text: string, destination: number, capacity: number): boolean {
  const bytes = utf8.enc.encode(text);
  if (!destination) return capacity === 0;
  if (bytes.length + 1 > capacity) return false;
  mem.write(destination, bytes);
  mem.st8(destination + bytes.length, 0);
  return true;
}
function getnameinfo(sockaddr: number, length: number, host: number, hostLength: number, service: number, serviceLength: number, flags = 0): number {
  const family = sockaddr && length >= 2 ? mem.ld16u(sockaddr) : -1;
  if (family !== AF_INET && family !== AF_INET6) return EAI_FAMILY;
  const ep = readEndpoint(family, sockaddr, length);
  if (typeof ep === "number") return EAI_FAMILY;
  const resolved = flags & NI_NUMERICHOST ? null : hostOf(ep.address);
  if (!resolved && flags & NI_NAMEREQD) return EAI_NONAME;
  return copyText(resolved ?? addressText(ep.address), host, hostLength) && copyText(String(ep.port), service, serviceLength) ? 0 : EAI_OVERFLOW;
}

export const RESOLVER: Record<string, HostFn> = {
  getaddrinfo: (cpu, args) => getaddrinfo(cpu, args.p(), args.p(), args.p(), args.p()),
  freeaddrinfo: (_cpu, args) => { const address = args.p(); if (address) mem.free(address); },
  getifaddrs: (cpu, args) => getifaddrs(cpu, args.p()),
  freeifaddrs: (_cpu, args) => { const entry = args.p(); if (entry) mem.free(entry); },
  gai_strerror: (_cpu, args) => ptr(cstr(gaiText(args.i()))),
  getnameinfo: (_cpu, args) => getnameinfo(args.p(), args.u(), args.p(), args.u(), args.p(), args.u(), args.i()),
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
};
