// The ARM32 libc's resolver functions over guest memory: getaddrinfo, getnameinfo, getifaddrs,
// gai_strerror and inet_pton/ntop, over net-address.ts's resolver and interfaces. (A 64-bit
// process's bionic resolves through netd's dnsproxyd, unix.ts.)

import { parseIpv4 } from "../../shell/relay.ts";
import { E } from "../abi.ts";
import { utf8 } from "../../jvm/abi.ts";
import type { Cpu } from "../cpu.ts";
import { stp, ptr, cstr, complete, type HostFn } from "../host.ts";
import { mem, anchor } from "../mem.ts";
import { fail } from "../kernel.ts";
import {
  AF_UNSPEC, AF_INET, AF_INET6, AI_NUMERICHOST, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME, EAI_FAMILY, EAI_SERVICE, EAI_SOCKTYPE, V4_LOOPBACK,
  parseIpv6, addressText, resolveHost, hostOf, gaiText, INTERFACES,
} from "../net-address.ts";
import { SOCK_STREAM, SOCK_DGRAM, sockaddrOf, readEndpoint } from "./abi.ts";
import { record } from "./core.ts";
import { IPPROTO_TCP, IPPROTO_UDP } from "./inet.ts";

const AI_PASSIVE = 1, AI_CANONNAME = 2, AI_NUMERICSERV = 8, AI_ADDRCONFIG = 0x400;
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

/** the ARM32 struct addrinfo: its size and the offsets of its fields */
const ADDRINFO = { size: 32, flags: 0, family: 4, socktype: 8, protocol: 12, addrlen: 16, canon: 20, addr: 24, next: 28 };
function getaddrinfo(cpu: Cpu, nodePtr: number, servicePtr: number, hints: number, result: number): number | Promise<number> {
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
    const canonBytes = flags & AI_CANONNAME ? utf8.enc.encode(node) : null;
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
