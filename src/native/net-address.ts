// Address parsing, host resolution and interfaces shared by sockets, libcore and netd.
import { sameBytes } from "../jvm/abi.ts";

export const AF_UNSPEC = 0, AF_UNIX = 1, AF_INET = 2, AF_INET6 = 10;
export const AI_NUMERICHOST = 4;
export const NI_NUMERICHOST = 2, NI_NAMEREQD = 4;
export const EAI_ADDRFAMILY = 1, EAI_FAMILY = 5, EAI_NODATA = 7, EAI_NONAME = 8, EAI_SERVICE = 9, EAI_SOCKTYPE = 10;
const IFF_UP = 1, IFF_LOOPBACK = 8, IFF_RUNNING = 0x40;

/** An address and port. An IPv4 address (IPv4-mapped IPv6 included) is 4 bytes, IPv6 16. */
export interface Endpoint { address: number[]; port: number; scope?: number }
export const V4_ANY = [0, 0, 0, 0], V4_LOOPBACK = [127, 0, 0, 1];
export const V6_LOOPBACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const isMapped = (b: ArrayLike<number>): boolean => {
  for (let i = 0; i < 10; i++) if (b[i]) return false;
  return b[10] === 255 && b[11] === 255;
};
/** an endpoint from a sockaddr's bytes, IPv4-mapped IPv6 as IPv4 */
export function endpointOf(bytes: ArrayLike<number>, port: number, scope = 0): Endpoint {
  if (bytes.length === 16 && isMapped(bytes)) return { address: [bytes[12], bytes[13], bytes[14], bytes[15]], port };
  return { address: Array.from(bytes), port, ...(scope ? { scope } : {}) };
}
export const isAny = (a: ArrayLike<number>): boolean => { for (let i = 0; i < a.length; i++) if (a[i]) return false; return true; };
export const isLoopback = (a: ArrayLike<number>): boolean => a.length === 4 ? a[0] === 127 : sameBytes(a, V6_LOOPBACK);
export const isMulticast = (a: ArrayLike<number>): boolean => a.length === 4 ? a[0] >= 224 && a[0] < 240 : a[0] === 0xff;
export const addressKey = (a: ArrayLike<number>) => Array.from(a).join(".");
/** an address's family: AF_INET for 4 bytes, AF_INET6 for 16 */
export const familyOf = (a: ArrayLike<number>): number => a.length === 4 ? AF_INET : AF_INET6;

/** gethostbyname's h_errno for a name or address with no entry */
export const HOST_NOT_FOUND = 1;

export type Ipv4 = [number, number, number, number];
/** inet_pton(AF_INET): dotted-decimal, 4 bytes, or null */
export function parseIpv4(text: string): Ipv4 | null {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) return null;
  const bytes: Ipv4 = [+match[1], +match[2], +match[3], +match[4]];
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}
export const ipv4Key = (bytes: ArrayLike<number>): number => ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
const ipv4Text = (bytes: ArrayLike<number>): string => `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;

/** RFC 5952 text: lower-case hex, the longest run of two or more zero groups as "::" */
function ipv6Text(b: ArrayLike<number>): string {
  const g = Array.from({ length: 8 }, (_, i) => (b[2 * i] << 8) | b[2 * i + 1]);
  let at = -1, len = 0;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && !g[j]) j++;
    if (j - i > len && j - i > 1) { at = i; len = j - i; }
    i = j === i ? i + 1 : j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  return at < 0 ? hex(g) : `${hex(g.slice(0, at))}::${hex(g.slice(at + len))}`;
}
/** inet_pton(AF_INET6): 16 bytes, or null */
export function parseIpv6(text: string): number[] | null {
  let t = text, tail: number[] = [];
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (dotted) { const v4 = parseIpv4(dotted[1]); if (!v4) return null; tail = v4; t = t.slice(0, dotted.index + 1) + "0:0"; }
  if (!/^[0-9a-fA-F:]+$/.test(t) || !t.includes(":")) return null;
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const groups = halves.map((h) => h ? h.split(":") : []);
  const missing = 8 - groups[0].length - (groups[1]?.length ?? 0);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...groups[0], ...Array(halves.length - 1 && missing).fill("0"), ...(groups[1] ?? [])];
  if (all.some((x) => !x || x.length > 4)) return null;
  const bytes = all.flatMap((x) => { const v = parseInt(x, 16); return [v >> 8, v & 255]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}
export const addressText = (a: ArrayLike<number>): string => a.length === 4 ? ipv4Text(a) : ipv6Text(a);

// ── the resolver: names the dev server confirms exist get the synthetic address relay.ts allots
/** getaddrinfo's addresses for `node`, or an EAI_* code; `family` is AF_UNSPEC, AF_INET or AF_INET6 */
export function resolveHost(node: string, family: number, flags: number): number[][] | number | Promise<number[][] | number> {
  const v4 = parseIpv4(node), v6 = v4 ? null : parseIpv6(node);
  if (v4) return family === AF_INET6 ? EAI_ADDRFAMILY : [v4];
  if (v6) return family === AF_INET ? EAI_ADDRFAMILY : [v6];
  if (flags & AI_NUMERICHOST) return EAI_NONAME;
  const name = node.toLowerCase();
  // /etc/hosts on the device: localhost is IPv4 only, ip6-localhost IPv6
  if (name === "localhost") return family === AF_INET6 ? EAI_NODATA : [V4_LOOPBACK];
  if (name === "ip6-localhost" || name === "ip6-loopback") return family === AF_INET ? EAI_NODATA : [V6_LOOPBACK];
  // the relay has no IPv6 route, so a name has no AAAA answer; a malformed numeric name is no name
  if (family === AF_INET6 || /^[\d.]+$/.test(name)) return EAI_NODATA;
  const exists = nameExists(node);
  if (!(exists instanceof Promise)) return [syntheticAddress(node)];
  return exists.then((known) => known === false ? EAI_NODATA : [syntheticAddress(node)]);
}
/** a name for `address` as getnameinfo finds one (the hosts file or a resolved name), else null */
export function hostOf(address: ArrayLike<number>): string | null {
  if (address.length === 4 && address[0] === 127 && address[1] === 0 && address[2] === 0 && address[3] === 1) return "localhost";
  if (sameBytes(address, V6_LOOPBACK)) return "ip6-localhost";
  return address.length === 4 ? syntheticHost(address) : null;
}
// bionic's gai_strerror
const GAI_TEXT = ["Success", "Address family for hostname not supported", "Temporary failure in name resolution",
  "Invalid value for ai_flags", "Non-recoverable failure in name resolution", "ai_family not supported", "Memory allocation failure",
  "No address associated with hostname", "hostname nor servname provided, or not known", "servname not supported for ai_socktype",
  "ai_socktype not supported", "System error returned in errno", "Invalid value for hints", "Resolved protocol is unknown",
  "Argument buffer overflow"];
export const gaiText = (code: number): string => GAI_TEXT[code] ?? "Unknown error";

/** The one interface: the relay is the network, but its addresses are the server's, not ours. */
export interface Interface { name: string; index: number; flags: number; mtu: number; addresses: { address: number[]; prefix: number }[] }
export const INTERFACES: Interface[] = [{
  name: "lo", index: 1, flags: IFF_UP | IFF_LOOPBACK | IFF_RUNNING, mtu: 65536,
  addresses: [{ address: V6_LOOPBACK, prefix: 128 }, { address: V4_LOOPBACK, prefix: 8 }],
}];


/** a URL hostname (canonical, as URL gives it) the device itself serves: a loopback or unspecified
 *  address, or a hosts-file name for one */
export function isGuestHost(hostname: string): boolean {
  return /^(localhost|ip6-localhost|ip6-loopback|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i.test(hostname);
}
/** where an http(s) URL the device serves itself connects: Linux takes an unspecified address as
 *  the loopback one */
export function guestEndpoint(url: string): Endpoint | null {
  const u = URL.parse(url);
  if (!u || !/^https?:$/.test(u.protocol) || !isGuestHost(u.hostname)) return null;
  const host = u.hostname.toLowerCase();
  const address = host.startsWith("[") || host.startsWith("ip6-") ? V6_LOOPBACK
    : host === "localhost" || host === "0.0.0.0" ? V4_LOOPBACK : parseIpv4(host)!;
  return { address, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) };
}

// A name resolves to a stable address in 198.18.0.0/15 (RFC 2544's benchmarking block, unrouted)
// shared by Java's InetAddress and the native resolver: whichever side later dials the address,
// the relay is given the name it stands for. A numeric literal is itself.
const syntheticByHost = new Map<string, Ipv4>();
const hostBySynthetic = new Map<number, string>();
let nextSynthetic = 1;
export function syntheticAddress(host: string): Ipv4 {
  const numeric = parseIpv4(host);
  if (numeric) return numeric;
  const found = syntheticByHost.get(host);
  if (found) return found;
  const id = nextSynthetic++ & 0xffff;
  const bytes: Ipv4 = [198, 18, id >>> 8, id & 255];
  syntheticByHost.set(host, bytes);
  hostBySynthetic.set(ipv4Key(bytes), host);
  return bytes;
}
export const syntheticHost = (bytes: ArrayLike<number>): string | null => hostBySynthetic.get(ipv4Key(bytes)) ?? null;
export const pageOrigin = () => typeof location === "undefined" ? "http://localhost" : `${location.protocol}//${location.host}`;
/** Whether `host` exists in DNS, asked of the dev server once per name: true, false for NXDOMAIN, or
 *  null when nothing could be asked (no server, a transport error), which callers treat as unknown
 *  rather than absent. A numeric literal exists. */
const knownNames = new Map<string, Promise<boolean | null>>();
export function nameExists(host: string): Promise<boolean | null> | boolean {
  if (parseIpv4(host) || host === "localhost") return true;
  let pending = knownNames.get(host);
  if (!pending) {
    pending = typeof location === "undefined" ? Promise.resolve(null) : fetch(`${pageOrigin()}/dns?host=${encodeURIComponent(host)}`).then(
      (r) => r.status === 200 ? true : r.status === 404 ? false : null, () => null);
    knownNames.set(host, pending);
  }
  return pending;
}
/** the name to dial for `host`: a synthetic literal stands for the name it was allotted to */
export function dialName(host: string): string {
  const numeric = parseIpv4(host);
  return (numeric && syntheticHost(numeric)) || host;
}
