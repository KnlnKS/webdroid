// The system daemons a guest libc talks to at /dev/socket names (unix.ts): logd's logdw (liblog's
// records) and netd's dnsproxyd (bionic's getaddrinfo and gethostby* proxy to it).

import { E } from "../abi.ts";
import { utf8 } from "../../jvm/abi.ts";
import { logLine } from "../kernel.ts";
import { complete } from "../host.ts";
import { AF_INET, AF_INET6, familyOf, resolveHost, hostOf, parseIpv4, parseIpv6 } from "../net-address.ts";
import { sockaddrOf } from "./abi.ts";
import { AI_CANONNAME, addrinfoCandidates } from "./resolver.ts";

/** a daemon's end of a connection: each write whole, and how it replies */
export type Daemon = (bytes: Uint8Array, reply: (bytes: Uint8Array) => void) => void;

/** logd_writer.cpp's datagram: android_log_header_t {u8 id, u16 tid, u32 sec, u32 nsec}, then a
 *  text buffer's priority, tag and message. The binary buffers (events, stats, security) are not text. */
const LOG_HEADER = 11, TEXT_BUFFERS = new Set([0, 1, 3, 4]);
const logd: Daemon = (bytes) => {
  if (bytes.length <= LOG_HEADER || !TEXT_BUFFERS.has(bytes[0])) return;
  const body = bytes.subarray(LOG_HEADER + 1), tagEnd = body.indexOf(0);
  if (tagEnd < 0) return;
  const msg = body.subarray(tagEnd + 1);
  logLine(bytes[LOG_HEADER], utf8.dec.decode(body.subarray(0, tagEnd)), utf8.dec.decode(msg.subarray(0, msg.indexOf(0) < 0 ? msg.length : msg.indexOf(0))));
};

// DnsProxyListener's replies: a NUL-terminated result code, then big-endian fields
const QUERY_RESULT = "222", OPERATION_FAILED = "401";
class Reply {
  private parts: number[] = [];
  code(c: string): this { this.parts.push(...utf8.enc.encode(c), 0); return this; }
  be32(v: number): this { this.parts.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); return this; }
  bytes(b: ArrayLike<number>): this { for (let i = 0; i < b.length; i++) this.parts.push(b[i]); return this; }
  /** a length-prefixed NUL-terminated string */
  str(s: string): this { const b = utf8.enc.encode(s); return this.be32(b.length + 1).bytes(b).bytes([0]); }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}
const failed = (error: number) => new Reply().code(OPERATION_FAILED).be32(error).done();
/** getaddrinfo's answers, every address for each socket type its hints allow */
function addrinfo(node: string, service: string, flags: number, family: number, socktype: number, protocol: number): Uint8Array | Promise<Uint8Array> {
  // the client sends -1 for hints it has none of, and "^" for no service
  const hints = addrinfoCandidates(Math.max(flags, 0), Math.max(family, 0), Math.max(socktype, 0), Math.max(protocol, 0), service === "^" ? null : service);
  if (typeof hints === "number") return failed(hints);
  const { port, kinds } = hints;
  const answer = (found: number[][] | number): Uint8Array => {
    if (typeof found === "number") return failed(found);
    const r = new Reply().code(QUERY_RESULT);
    for (const address of found) for (const [type, proto] of kinds) {
      const addr = sockaddrOf(familyOf(address), { address, port });
      r.be32(1).be32(flags < 0 ? 0 : flags).be32(familyOf(address)).be32(type).be32(proto).be32(addr.length).bytes(addr);
      if (flags > 0 && flags & AI_CANONNAME) r.str(node); else r.be32(0);
    }
    return r.be32(0).done();
  };
  return complete(resolveHost(node, family < 0 ? 0 : family, flags < 0 ? 0 : flags), answer);
}
/** android_read_hostent's serialization: name, aliases, type, length, addresses */
function hostent(name: string, addresses: number[][]): Uint8Array {
  const length = addresses[0].length, r = new Reply().code(QUERY_RESULT).str(name).be32(0).be32(familyOf(addresses[0])).be32(length);
  for (const a of addresses) r.be32(length).bytes(a);
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
    if (Number(af) !== AF_INET && Number(af) !== AF_INET6) return failed(HOST_NOT_FOUND);
    return complete(resolveHost(name, Number(af), 0), f => typeof f === "number" ? failed(HOST_NOT_FOUND) : hostent(name, f));
  }
  if (command === "gethostbyaddr") {
    const address = parseIpv4(args[0]) ?? parseIpv6(args[0]), name = address && hostOf(address);
    return address && name ? hostent(name, [address]) : failed(HOST_NOT_FOUND);
  }
  return failed(E.NOSYS);
}
/** one NUL-terminated command per connection, as FrameworkListener reads it */
const dnsproxyd = (): Daemon => {
  let pending = "";
  return (bytes, reply) => {
    pending += utf8.dec.decode(bytes);
    const end = pending.indexOf("\0");
    if (end < 0) return;
    const r = query(pending.slice(0, end));
    pending = "";
    if (r instanceof Promise) void r.then(reply); else reply(r);
  };
};

export const DAEMONS: Record<string, () => Daemon> = { "/dev/socket/logdw": () => logd, "/dev/socket/dnsproxyd": dnsproxyd };
