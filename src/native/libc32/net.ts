// The ARM32 libc's network functions over guest memory: send, recv, poll and select over the
// kernel's calls, and the resolver's getaddrinfo, getnameinfo, gethostby*, getifaddrs, gai_strerror
// and inet_pton/ntop/aton over net-address.ts's resolver and interfaces.

import { E } from "../abi.ts";
import { utf8 } from "../../jvm/abi.ts";
import type { Cpu } from "../cpu.ts";
import { stp, ldLong, ptr, cstr, complete, type HostFn } from "../host.ts";
import { mem, anchor } from "../mem.ts";
import { fail, readTs, wrapped, KLAYOUT } from "../kernel.ts";
import {
  AF_UNSPEC, AF_INET, AF_INET6, AI_NUMERICHOST, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME, EAI_FAMILY, V4_LOOPBACK,
  HOST_NOT_FOUND, familyOf, parseIpv4, parseIpv6, addressText, resolveHost, hostOf, gaiText, INTERFACES,
} from "../net-address.ts";
import { sockaddrOf, readEndpoint } from "../socket/abi.ts";
import { record } from "../socket/core.ts";
import { AI_CANONNAME, addrinfoCandidates } from "../socket/daemons.ts";
import { recvfrom, sendto } from "../socket/syscalls.ts";
import { nativePoll, nativeSelect } from "../poll.ts";
import { struct } from "../struct.ts";

const AI_PASSIVE = 1;
const EAI_SYSTEM = 11, EAI_OVERFLOW = 14;

const Ifaddrs = struct("next:ptr name:ptr flags:u32 addr:ptr netmask:ptr broadaddr:ptr data:ptr");
function getifaddrs(cpu: Cpu, result: number): number {
  if (!result) return fail(cpu, E.FAULT);
  const size = Ifaddrs.size();
  const entry = mem.malloc(size + 35);
  if (!entry) return fail(cpu, E.NOMEM);
  mem.memset(entry, 0, size + 35);
  const lo = INTERFACES[0], address = entry + size, netmask = address + 16, name = netmask + 16;
  Ifaddrs.write(entry, { name, flags: lo.flags, addr: address, netmask });
  mem.st16(address, AF_INET); mem.u8.set(V4_LOOPBACK, address + 4);
  mem.st16(netmask, AF_INET); mem.u8.set([255, 0, 0, 0], netmask + 4);
  mem.u8.set([...utf8.enc.encode(lo.name), 0], name);
  stp(result, entry);
  return 0;
}

const Addrinfo = struct("flags:i32 family:i32 socktype:i32 protocol:i32 addrlen:u32 canon:ptr addr:ptr next:ptr");
/** getaddrinfo(3): one allocation holding the list, every address for each socket type, the
 *  canonical name on the first */
function getaddrinfo(cpu: Cpu, nodePtr: number, servicePtr: number, hints: number, result: number): PromiseOrVal<number> {
  if (!result) { fail(cpu, E.FAULT); return EAI_SYSTEM; }
  const { flags, family, socktype, protocol } = hints ? Addrinfo.read(hints) : { flags: 0, family: AF_UNSPEC, socktype: 0, protocol: 0 };
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
    for (const sockaddr of sockaddrs) size += (Addrinfo.size() + sockaddr.length) * kinds.length;
    const allocation = mem.malloc(size);
    if (!allocation) { fail(cpu, E.NOMEM); return EAI_SYSTEM; }
    mem.memset(allocation, 0, size);
    let at = allocation, previous = 0;
    for (let i = 0; i < found.length; i++) for (const [type, proto] of kinds) {
      const sockaddr = sockaddrs[i];
      if (previous) Addrinfo.write(previous, { next: at });
      Addrinfo.write(at, { flags, family: familyOf(found[i]), socktype: type, protocol: proto, addrlen: sockaddr.length, addr: at + Addrinfo.size() });
      mem.write(at + Addrinfo.size(), sockaddr);
      previous = at; at += Addrinfo.size() + sockaddr.length;
    }
    if (canon) { mem.u8.set(canon, at); Addrinfo.write(allocation, { canon: at }); }
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

const Hostent = struct("name:ptr aliases:ptr type:i32 length:i32 list:ptr");
const NO_RECOVERY = 3;
/** gethostbyname and gethostbyaddr, and the h_errno they set: one for the process, where bionic keeps one per thread */
function hostLookups(): Record<string, HostFn> {
  const hostErrno = mem.hostAlloc(4);
  let entry = 0;
  const noHost = (code = HOST_NOT_FOUND): number => { mem.st32(hostErrno, code); return 0; };
  /** the answer, in the storage the next lookup replaces */
  const hostent = (name: string, addresses: number[][]): number => {
    const text = utf8.enc.encode(name + "\0"), length = addresses[0].length;
    const list = Hostent.size() + 4, bytes = list + 4 * (addresses.length + 1), size = bytes + length * addresses.length + text.length;
    if (entry) mem.free(entry);
    const at = entry = mem.malloc(size);
    if (!at) return noHost(NO_RECOVERY);
    mem.memset(at, 0, size);
    mem.write(at + size - text.length, text);
    Hostent.write(at, { name: at + size - text.length, aliases: at + Hostent.size(), type: familyOf(addresses[0]), length, list: at + list });
    addresses.forEach((address, i) => { stp(at + list + 4 * i, at + bytes + length * i); mem.write(at + bytes + length * i, address); });
    return at;
  };
  return {
    gethostbyname: (_cpu, args) => { const name = args.str(); return complete(resolveHost(name, AF_INET, 0), (found) => typeof found === "number" ? noHost() : hostent(name, found)); },
    gethostbyaddr: (_cpu, args) => {
      const at = args.p(), length = args.u(), type = args.i();
      if (length !== (type === AF_INET ? 4 : type === AF_INET6 ? 16 : -1)) return noHost();
      const address = Array.from(mem.bytes(at, length)), name = hostOf(address);
      return name ? hostent(name, [address]) : noHost();
    },
    __get_h_errno: () => hostErrno,
  };
}

const RESOLVER: Record<string, HostFn> = {
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
  // dotted-decimal alone, as inet_pton reads it; inet_addr answers INADDR_NONE when it cannot
  inet_aton: (_cpu, args) => { const bytes = parseIpv4(args.str()), out = args.p(); if (!bytes) return 0; if (out) mem.write(out, bytes); return 1; },
  inet_addr: (_cpu, args) => { const bytes = parseIpv4(args.str()); return bytes ? bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24 : -1; },
  inet_ntop: (cpu, args) => {
    const family = args.i(), source = args.p(), destination = args.p(), length = args.u();
    if (family !== AF_INET && family !== AF_INET6) { fail(cpu, E.AFNOSUPPORT); return 0; }
    if (!copyText(addressText(mem.bytes(source, family === AF_INET ? 4 : 16)), destination, length)) { fail(cpu, E.NOSPC); return 0; }
    return ptr(destination);
  },
};
/** the ARM32 libc's network functions */
export function netLibc(): Record<string, HostFn> {
  return {
    ...RESOLVER, ...hostLookups(),
    send: wrapped((cpu, a) => sendto(cpu, a.i(), a.p(), a.u(), a.i(), 0, 0)),
    recv: wrapped((_c, a) => recvfrom(a.i(), a.p(), a.u(), a.i())),
    poll: wrapped((_c, a) => nativePoll(a.p(), a.u(), a.i())),
    select: wrapped((_c, a) => {
      const count = a.i(), r = a.p(), w = a.p(), x = a.p(), timeout = a.p();
      if (!timeout) return nativeSelect(count, r, w, x, -1);
      const sec = ldLong(timeout + KLAYOUT.TS_SEC), usec = ldLong(timeout + KLAYOUT.TS_NSEC);
      if (sec < 0 || usec < 0 || usec >= 1_000_000) return -E.INVAL;
      return nativeSelect(count, r, w, x, readTs(timeout, 1e3));
    }),
  };
}
