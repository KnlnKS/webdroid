// AF_UNIX sockets to the system daemons a guest libc talks to, as /dev/socket names: logd's logdw
// (liblog's records) and netd's dnsproxyd (bionic's getaddrinfo and gethostby* proxy to it). A
// connected socket is a socketpair end whose peer is the daemon here; a name no daemon serves
// refuses the connection, as a socket file with no listener does.

import { mem } from "./mem";
import { E } from "./abi";
import type { Cpu } from "./cpu";
import { fail, logLine } from "./libc";
import { attachUnixPeer, isUnixSocket } from "./stdio";
import { AF_INET, resolveHost, hostOf } from "./net";
import { parseIpv4 } from "../shell/relay";

type Daemon = (bytes: Uint8Array, reply: (bytes: Uint8Array) => void) => void;
const dec = new TextDecoder(), enc = new TextEncoder();

/** logd_writer.cpp's datagram: android_log_header_t {u8 id, u16 tid, u32 sec, u32 nsec}, then a
 *  text buffer's priority, tag and message. The binary buffers (events, stats, security) are not text. */
const LOG_HEADER = 11, TEXT_BUFFERS = new Set([0, 1, 3, 4]);
const logd: Daemon = (bytes) => {
  if (bytes.length <= LOG_HEADER || !TEXT_BUFFERS.has(bytes[0])) return;
  const body = bytes.subarray(LOG_HEADER + 1), tagEnd = body.indexOf(0);
  if (tagEnd < 0) return;
  const msg = body.subarray(tagEnd + 1);
  logLine(bytes[LOG_HEADER], dec.decode(body.subarray(0, tagEnd)), dec.decode(msg.subarray(0, msg.indexOf(0) < 0 ? msg.length : msg.indexOf(0))));
};

// DnsProxyListener's replies: a NUL-terminated result code, then big-endian fields
const QUERY_RESULT = "222", OPERATION_FAILED = "401";
const SOCK_STREAM = 1, SOCK_DGRAM = 2, SOCK_RAW = 3, IPPROTO_TCP = 6, IPPROTO_UDP = 17, EAI_SERVICE = 9, EAI_SOCKTYPE = 10, EAI_FAMILY = 5;
class Reply {
  private parts: number[] = [];
  code(c: string): this { this.parts.push(...enc.encode(c), 0); return this; }
  be32(v: number): this { this.parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  bytes(b: ArrayLike<number>): this { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  /** a length-prefixed NUL-terminated string */
  str(s: string): this { const b = enc.encode(s); return this.be32(b.length + 1).bytes(b).bytes([0]); }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}
const failed = (error: number) => new Reply().code(OPERATION_FAILED).be32(error).done();
/** a sockaddr_in as the struct lies in memory: family in host order, port and address big-endian */
const sockaddrIn = (address: number[], port: number) => [AF_INET & 255, AF_INET >> 8, port >>> 8, port & 255, ...address, 0, 0, 0, 0, 0, 0, 0, 0];
/** getaddrinfo's answers for its hints: one per socket type when none is asked for, as libc's explore table gives */
function addrinfo(node: string, service: string, flags: number, family: number, socktype: number, protocol: number): Uint8Array | Promise<Uint8Array> {
  if (family !== -1 && family !== 0 && family !== AF_INET) return failed(EAI_FAMILY);
  const port = service === "^" ? 0 : /^\d+$/.test(service) ? Number(service) : -1;
  if (port < 0 || port > 65535) return failed(EAI_SERVICE);
  const kinds = [[SOCK_STREAM, IPPROTO_TCP], [SOCK_DGRAM, IPPROTO_UDP], [SOCK_RAW, 0]]
    .filter(([type, proto]) => (socktype <= 0 || socktype === type) && (protocol <= 0 || protocol === proto || type === SOCK_RAW));
  if (!kinds.length) return failed(EAI_SOCKTYPE);
  const answer = (found: number[][] | number): Uint8Array => {
    if (typeof found === "number") return failed(found);
    const r = new Reply().code(QUERY_RESULT);
    for (const address of found) for (const [type, proto] of kinds) {
      const addr = sockaddrIn(address, port);
      r.be32(1).be32(flags < 0 ? 0 : flags).be32(AF_INET).be32(type).be32(proto).be32(addr.length).bytes(addr);
      if (flags > 0 && flags & 2) r.str(node); else r.be32(0);              // AI_CANONNAME
    }
    return r.be32(0).done();
  };
  const found = resolveHost(node, 0, flags < 0 ? 0 : flags);
  return found instanceof Promise ? found.then(answer) : answer(found);
}
/** android_read_hostent's serialization: name, aliases, type, length, addresses */
function hostent(name: string, addresses: number[][]): Uint8Array {
  const r = new Reply().code(QUERY_RESULT).str(name).be32(0).be32(AF_INET).be32(4);
  for (const a of addresses) r.be32(4).bytes(a);
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
    if (Number(af) !== AF_INET) return failed(HOST_NOT_FOUND);
    const found = resolveHost(name, AF_INET, 0);
    const answer = (f: number[][] | number) => (typeof f === "number" ? failed(HOST_NOT_FOUND) : hostent(name, f));
    return found instanceof Promise ? found.then(answer) : answer(found);
  }
  if (command === "gethostbyaddr") {
    const address = parseIpv4(args[0]), name = address && hostOf(address);
    return address && name ? hostent(name, [address]) : failed(HOST_NOT_FOUND);
  }
  return failed(E.NOSYS);
}
/** one NUL-terminated command per connection, as FrameworkListener reads it */
const dnsproxyd = (): Daemon => {
  let pending = "";
  return (bytes, reply) => {
    pending += dec.decode(bytes);
    const end = pending.indexOf("\0");
    if (end < 0) return;
    const r = query(pending.slice(0, end));
    pending = "";
    if (r instanceof Promise) void r.then(reply); else reply(r);
  };
};

const DAEMONS: Record<string, () => Daemon> = { "/dev/socket/logdw": () => logd, "/dev/socket/dnsproxyd": dnsproxyd };

/** connect(2) on an AF_UNIX socket: sockaddr_un's path names the daemon */
export function unixConnect(cpu: Cpu, fd: number, sockaddr: number, length: number): number {
  if (!isUnixSocket(fd)) return fail(cpu, E.NOTSOCK);
  const path = mem.cstr(sockaddr + 2, length - 2), daemon = DAEMONS[path];
  if (!daemon) return fail(cpu, path.startsWith("/dev/socket/") ? E.CONNREFUSED : E.NOENT);
  const e = attachUnixPeer(fd, daemon());
  return e ? fail(cpu, e) : 0;
}
