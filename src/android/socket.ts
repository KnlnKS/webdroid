// libcore's socket syscalls (libcore.io.Linux) and the socket streams' natives, over the socket
// model native code shares (src/native/net.ts): a descriptor from either side is the same socket.
import { rt, JObj, declaredField } from "../jvm/runtime";
import { vcall, scall, newObj, after } from "../jvm/natives/jlang";
import { jarray } from "../jvm/abi";
import { fdInt, mkFd } from "../jvm/natives/jio";
import { errno, sys, ioResult, readBytes, ioRegion, FD, type IoBuffer } from "./os";
import { E, ERRSTR } from "../native/abi";
import { javaDup2Fd, javaSocketPair } from "../native/stdio";
import {
  AF_INET, AF_INET6, POLLIN, POLLERR, MSG_DONTWAIT, SOL_SOCKET, IPPROTO_IP, INTERFACES, GROUP_OPTIONS,
  socketCreate, socketConnect, socketBind, socketListen, socketAccept, socketShutdown, socketSend, socketReceive, socketName,
  socketOption, setSocketOption, socketGroup, pollEntries, resolveHost, hostOf, gaiText, endpointOf, addressText,
  parseIpv6, isNativeSocket, type Endpoint, type PollEntry,
} from "../native/net";
import { parseIpv4 } from "../shell/relay";

const ISA = "java/net/InetSocketAddress", ISA_HOLDER = "java/net/InetSocketAddress$InetSocketAddressHolder";
const INET = "Ljava/net/InetAddress;", SOCKADDR = "Ljava/net/SocketAddress;";
const SO_RCVTIMEO = 20, SO_SNDTIMEO = 21, IP_MULTICAST_IF = 32, SO_BINDTODEVICE = 25;
type Obj = Record<string, unknown>;
const field = (o: JObj, cls: string, name: string) => (o as unknown as Obj)[declaredField(cls, name)];
const setField = (o: JObj, cls: string, name: string, v: unknown) => { (o as unknown as Obj)[declaredField(cls, name)] = v; };

/** a bytecode throwable, initialized before it is made (a native's exception needs its class ready) */
function thrown(cls: string, desc: string, ...args: unknown[]): never | Promise<never> {
  const info = rt.link(cls), init = rt.initClass(info);
  const make = (): never | Promise<never> => {
    const e = new info.ctor();
    return after(vcall(e, "<init>", desc, ...args), () => { throw e; }) as never | Promise<never>;
  };
  return init ? init.then(make) : make();
}
const socketClosed = () => rt.mkThrowable("java/net/SocketException", "Socket closed");
/** the descriptor a call waited on closed under it: libcore's AsynchronousCloseMonitor answer */
const closedUnder = (fn: string, r: number) => { if (r === -E.BADF) throw socketClosed(); sys(fn, r); return r; };
/** a result that may come after waiting */
const waited = <T>(fn: string, r: T | number | Promise<T | number>, done: (v: T) => unknown = (v) => v) =>
  r instanceof Promise ? r.then((v) => typeof v === "number" && v < 0 ? closedUnder(fn, v) : done(v as T))
    : typeof r === "number" && r < 0 ? sys(fn, r) : done(r as T);

/** an InetAddress's endpoint, as libcore's inetAddressToSockaddr reads it */
function endpoint(address: JObj | null, port: number): Endpoint | Promise<Endpoint> {
  if (address === null) return rt.npe();
  return after(vcall(address, "getAddress", "()[B") as Int8Array | Promise<Int8Array>, (bytes) => endpointOf(Uint8Array.from(bytes), port));
}
/** an InetSocketAddress's endpoint; other SocketAddress kinds are address families these sockets lack */
function socketAddressEndpoint(fn: string, address: JObj | null): Endpoint | Promise<Endpoint> {
  if (address === null) return rt.npe();
  if (!rt.iof(address, ISA)) throw errno(fn, E.AFNOSUPPORT);
  const holder = field(address, ISA, "holder") as JObj;
  const inet = field(holder, ISA_HOLDER, "addr") as JObj | null;
  if (inet === null) throw errno(fn, E.INVAL);
  return endpoint(inet, field(holder, ISA_HOLDER, "port") as number);
}
/** sockaddrToInetAddress: InetAddress.getByAddress(null, bytes, scope) */
const inetAddress = (ep: { address: number[]; scope?: number }): JObj | Promise<JObj> =>
  scall("java/net/InetAddress", "getByAddress", "(Ljava/lang/String;[BI)Ljava/net/InetAddress;", null, Int8Array.from(ep.address), ep.scope ?? 0);
const inetSocketAddress = (ep: Endpoint): Promise<JObj> =>
  Promise.resolve(inetAddress(ep)).then((a) => newObj(ISA, `(${INET}I)V`, a, ep.port));
/** fillInetSocketAddress: a caller's InetSocketAddress takes the sender's address and port */
function fillSocketAddress(target: JObj | null, ep: Endpoint | null): void | Promise<void> {
  if (target === null || ep === null || !rt.iof(target, ISA)) return;
  return after(inetAddress(ep), (a) => {
    const holder = field(target, ISA, "holder") as JObj;
    setField(holder, ISA_HOLDER, "addr", a);
    setField(holder, ISA_HOLDER, "port", ep.port);
  });
}
const withEndpoint = <T>(ep: Endpoint | Promise<Endpoint>, f: (ep: Endpoint) => T) => after(ep, f);

function connect(d: JObj | null, ep: Endpoint) { return waited("connect", socketConnect(fdInt(d), ep), () => {}); }
function bind(d: JObj | null, ep: Endpoint) { sys("bind", socketBind(fdInt(d), ep)); }
function sendto(d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, ep: Endpoint | null) {
  const bytes = ioRegion(buffer, offset, count);
  return ioResult("sendto", socketSend(fdInt(d), bytes, ep));
}
const intOption = (fn: string, d: JObj | null, level: number, name: number) => ioResult(fn, socketOption(fdInt(d), level, name));
const setIntOption = (fn: string, d: JObj | null, level: number, name: number, value: number) => sys(fn, setSocketOption(fdInt(d), level, name, value));
/** getaddrinfo's EAI_* as android.system.GaiException */
const gaiError = (fn: string, code: number) => thrown("android/system/GaiException", "(Ljava/lang/String;I)V", fn, code);
const iface = (name: string | null) => INTERFACES.find((i) => i.name === name) ?? null;

const linux: Record<string, (...args: never[]) => unknown> = {
  "socket(III)Ljava/io/FileDescriptor;": (domain: number, type: number, protocol: number) => {
    const fd = socketCreate(domain, type, protocol);
    sys("socket", fd);
    return mkFd(fd);
  },
  [`socketpair(III${FD}${FD})V`]: (domain: number, type: number, _protocol: number, a: JObj | null, b: JObj | null) => {
    if (domain !== 1 /* AF_UNIX */) throw errno("socketpair", E.AFNOSUPPORT);
    const [x, y] = javaSocketPair(type);
    (a as unknown as Obj)[declaredField("java/io/FileDescriptor", "descriptor")] = x;
    (b as unknown as Obj)[declaredField("java/io/FileDescriptor", "descriptor")] = y;
  },
  [`dup2(${FD}I)${FD}`]: (d: JObj | null, to: number) => {
    const fd = javaDup2Fd(fdInt(d), to);
    sys("dup2", fd);
    return mkFd(fd);
  },
  [`connect(${FD}${INET}I)V`]: (d: JObj | null, address: JObj | null, port: number) => withEndpoint(endpoint(address, port), (ep) => connect(d, ep)),
  [`connect(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => withEndpoint(socketAddressEndpoint("connect", address), (ep) => connect(d, ep)),
  [`bind(${FD}${INET}I)V`]: (d: JObj | null, address: JObj | null, port: number) => withEndpoint(endpoint(address, port), (ep) => bind(d, ep)),
  [`bind(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => withEndpoint(socketAddressEndpoint("bind", address), (ep) => bind(d, ep)),
  [`listen(${FD}I)V`]: (d: JObj | null) => sys("listen", socketListen(fdInt(d))),
  [`accept(${FD}${SOCKADDR})${FD}`]: (d: JObj | null, peer: JObj | null) =>
    waited("accept", socketAccept(fdInt(d)), (r: { fd: number; peer: Endpoint }) => after(fillSocketAddress(peer, r.peer), () => mkFd(r.fd))),
  [`shutdown(${FD}I)V`]: (d: JObj | null, how: number) => sys("shutdown", socketShutdown(fdInt(d), how)),
  [`getsockname(${FD})${SOCKADDR}`]: (d: JObj | null) => {
    const ep = socketName(fdInt(d), false);
    if (typeof ep === "number") throw errno("getsockname", -ep);
    return inetSocketAddress(ep);
  },
  [`getpeername(${FD})${SOCKADDR}`]: (d: JObj | null) => {
    const ep = socketName(fdInt(d), true);
    if (typeof ep === "number") throw errno("getpeername", -ep);
    return inetSocketAddress(ep);
  },
  "poll([Landroid/system/StructPollfd;I)I": (fds: JObj[] | null, timeout: number) => {
    if (fds === null) return rt.npe();
    const P = "android/system/StructPollfd";
    const entries: PollEntry[] = fds.map((p) => ({ fd: p === null ? -1 : fdInt(field(p, P, "fd") as JObj | null), events: field(p, P, "events") as number, revents: 0 }));
    return after(pollEntries(entries, timeout), (n) => {
      fds.forEach((p, i) => { if (p !== null) setField(p, P, "revents", entries[i].revents); });
      return n;
    });
  },
  [`getsockoptInt(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name),
  [`setsockoptInt(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value),
  [`getsockoptByte(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name) & 255,
  [`setsockoptByte(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value & 255),
  [`getsockoptLinger(${FD}II)Landroid/system/StructLinger;`]: (d: JObj | null, level: number, name: number) => {
    const secs = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructLinger", "(II)V", secs < 0 ? 0 : 1, Math.max(0, secs));
  },
  [`setsockoptLinger(${FD}IILandroid/system/StructLinger;)V`]: (d: JObj | null, level: number, name: number, linger: JObj | null) => {
    if (linger === null) return rt.npe();
    const L = "android/system/StructLinger";
    setIntOption("setsockopt", d, level, name, field(linger, L, "l_onoff") ? field(linger, L, "l_linger") as number : -1);
  },
  [`getsockoptTimeval(${FD}II)Landroid/system/StructTimeval;`]: (d: JObj | null, level: number, name: number) => {
    const ms = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructTimeval", "(JJ)V", BigInt(Math.floor(ms / 1000)), BigInt(ms % 1000 * 1000));
  },
  [`setsockoptTimeval(${FD}IILandroid/system/StructTimeval;)V`]: (d: JObj | null, level: number, name: number, tv: JObj | null) => {
    if (tv === null) return rt.npe();
    const T = "android/system/StructTimeval", sec = field(tv, T, "tv_sec") as bigint, usec = field(tv, T, "tv_usec") as bigint;
    if (level !== SOL_SOCKET || name !== SO_RCVTIMEO && name !== SO_SNDTIMEO || sec < 0n || usec < 0n || usec >= 1_000_000n) throw errno("setsockopt", E.INVAL);
    setIntOption("setsockopt", d, level, name, Number(sec) * 1000 + Math.ceil(Number(usec) / 1000));
  },
  [`getsockoptInAddr(${FD}II)${INET}`]: (d: JObj | null, level: number, name: number) => {
    const v = intOption("getsockopt", d, level, name);
    return inetAddress({ address: level === IPPROTO_IP && name === IP_MULTICAST_IF && v > 255 ? [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255] : [0, 0, 0, 0] });
  },
  [`setsockoptIpMreqn(${FD}III)V`]: (d: JObj | null, level: number, name: number, index: number) => {
    if (index && !INTERFACES.some((i) => i.index === index)) throw errno("setsockopt", E.NODEV);
    setIntOption("setsockopt", d, level, name, index);
  },
  [`setsockoptGroupReq(${FD}IILandroid/system/StructGroupReq;)V`]: (d: JObj | null, _level: number, name: number, req: JObj | null) => {
    if (req === null) return rt.npe();
    const G = "android/system/StructGroupReq";
    const join = name === GROUP_OPTIONS.MCAST_JOIN_GROUP || name === GROUP_OPTIONS.IP_ADD_MEMBERSHIP;
    return after(endpoint(field(req, G, "gr_group") as JObj | null, 0), (ep) =>
      sys("setsockopt", socketGroup(fdInt(d), join, ep.address, field(req, G, "gr_interface") as number)));
  },
  [`setsockoptIfreq(${FD}IILjava/lang/String;)V`]: (d: JObj | null, level: number, name: number, ifname: string | null) => {
    if (!isNativeSocket(fdInt(d))) throw errno("setsockopt", fdInt(d) < 0 ? E.BADF : E.NOTSOCK);
    if (level !== SOL_SOCKET || name !== SO_BINDTODEVICE) throw errno("setsockopt", E.NOPROTOOPT);
    if (ifname && !iface(ifname)) throw errno("setsockopt", E.NODEV);
  },
  [`sendtoBytes(${FD}Ljava/lang/Object;III${INET}I)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null, port: number) =>
    address === null ? sendto(d, buffer, offset, count, flags, null) : withEndpoint(endpoint(address, port), (ep) => sendto(d, buffer, offset, count, flags, ep)),
  [`sendtoBytes(${FD}Ljava/lang/Object;III${SOCKADDR})I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null) =>
    address === null ? sendto(d, buffer, offset, count, flags, null) : withEndpoint(socketAddressEndpoint("sendto", address), (ep) => sendto(d, buffer, offset, count, flags, ep)),
  [`recvfromBytes(${FD}Ljava/lang/Object;III${"Ljava/net/InetSocketAddress;"})I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, source: JObj | null) => {
    const from = { source: null as Endpoint | null }, fd = fdInt(d);
    const n = readBytes("recvfrom", buffer, offset, count, (target) => socketReceive(fd, target, flags, from));
    return after(n, (received) => after(fillSocketAddress(source, from.source), () => received));
  },
  "android_getaddrinfo(Ljava/lang/String;Landroid/system/StructAddrinfo;I)[Ljava/net/InetAddress;": (node: string | null, hints: JObj | null) => {
    if (node === null || hints === null) return rt.npe();
    const A = "android/system/StructAddrinfo";
    const found = resolveHost(node, field(hints, A, "ai_family") as number, field(hints, A, "ai_flags") as number);
    return after(found, (addresses) => typeof addresses === "number" ? gaiError("android_getaddrinfo", addresses)
      : Promise.all(addresses.map((address) => inetAddress({ address }))).then((list) => jarray(list, INET)));
  },
  [`getnameinfo(${INET}I)Ljava/lang/String;`]: (address: JObj | null, flags: number) => after(endpoint(address, 0), (ep) => {
    const name = flags & 2 /* NI_NUMERICHOST */ ? null : hostOf(ep.address);
    if (name === null && flags & 4 /* NI_NAMEREQD */) return gaiError("getnameinfo", 8 /* EAI_NONAME */);
    return name ?? addressText(ep.address);
  }),
  "gai_strerror(I)Ljava/lang/String;": (code: number) => gaiText(code),
  "inet_pton(ILjava/lang/String;)Ljava/net/InetAddress;": (family: number, text: string | null) => {
    if (text === null) return rt.npe();
    const bytes = family === AF_INET ? parseIpv4(text) : family === AF_INET6 ? parseIpv6(text) : null;
    return bytes ? inetAddress({ address: bytes }) : null;
  },
  "getifaddrs()[Landroid/system/StructIfaddrs;": () => Promise.all(INTERFACES.flatMap((i) => i.addresses.map(async ({ address, prefix }) => {
    const mask = Array.from({ length: address.length }, (_, k) => 255 & ~(255 >> Math.max(0, Math.min(8, prefix - 8 * k))));
    return newObj("android/system/StructIfaddrs", `(Ljava/lang/String;I${INET}${INET}${INET}[B)V`, i.name, i.flags,
      await inetAddress({ address }), await inetAddress({ address: mask }), null, null);
  }))).then((list) => jarray(list, "Landroid/system/StructIfaddrs;")),
  "if_nametoindex(Ljava/lang/String;)I": (name: string | null) => iface(name)?.index ?? 0,
  "if_indextoname(I)Ljava/lang/String;": (index: number) => INTERFACES.find((i) => i.index === index)?.name ?? null,
  [`ioctlFlags(${FD}Ljava/lang/String;)I`]: (_d: JObj | null, name: string | null) => { const i = iface(name); if (!i) throw errno("ioctl", E.NODEV); return i.flags; },
  [`ioctlMTU(${FD}Ljava/lang/String;)I`]: (_d: JObj | null, name: string | null) => { const i = iface(name); if (!i) throw errno("ioctl", E.NODEV); return i.mtu; },
  [`ioctlInetAddress(${FD}ILjava/lang/String;)${INET}`]: (_d: JObj | null, request: number, name: string | null) => {
    const i = iface(name);
    if (!i) throw errno("ioctl", E.NODEV);
    const v4 = i.addresses.find((a) => a.address.length === 4);
    if (!v4) throw errno("ioctl", E.ADDRNOTAVAIL);
    // SIOCGIFADDR, SIOCGIFNETMASK; loopback has no broadcast or destination address
    if (request === 0x8915) return inetAddress({ address: v4.address });
    if (request === 0x891b) return inetAddress({ address: [255, 0, 0, 0] });
    throw errno("ioctl", E.ADDRNOTAVAIL);
  },
};
rt.registerJnis("libcore/io/Linux", linux);

// java.net.SocketInputStream/SocketOutputStream: OpenJDK's socketRead0 (NET_Timeout, then read)
// and socketWrite0 (write until done)
const readFailure = (e: number) => e === E.CONNRESET || e === E.PIPE
  ? thrown("sun/net/ConnectionResetException", "(Ljava/lang/String;)V", "Connection reset")
  : Promise.reject(e === E.BADF ? socketClosed() : rt.mkThrowable("java/net/SocketException", ERRSTR[e] ?? "Read failed"));
const readDone = (n: number) => n >= 0 ? n : readFailure(-n);
rt.registerJni("java/net/SocketInputStream", `socketRead0(${FD}[BIII)I`, (d: JObj | null, b: Int8Array, off: number, len: number, timeout: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const target = new Uint8Array(b.buffer, b.byteOffset + off, len);
  if (timeout <= 0) { const n = socketReceive(fd, target); return n instanceof Promise ? n.then(readDone) : readDone(n); }
  const n = socketReceive(fd, target, MSG_DONTWAIT);
  if (n !== -E.AGAIN) return readDone(n as number);
  const entry = { fd, events: POLLIN | POLLERR, revents: 0 };
  return after(pollEntries([entry], timeout), (ready) => {
    if (!ready) throw rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out");
    return after(socketReceive(fd, target, MSG_DONTWAIT), readDone);
  });
});
rt.registerJni("java/net/SocketOutputStream", `socketWrite0(${FD}[BII)V`, (d: JObj | null, b: Int8Array, off: number, len: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const n = socketSend(fd, new Uint8Array(b.buffer, b.byteOffset + off, len));
  if (n >= 0) return;
  if (n === -E.CONNRESET) return thrown("sun/net/ConnectionResetException", "(Ljava/lang/String;)V", "Connection reset");
  throw n === -E.BADF ? socketClosed() : rt.mkThrowable("java/net/SocketException", ERRSTR[-n] ?? "Write failed");
});
