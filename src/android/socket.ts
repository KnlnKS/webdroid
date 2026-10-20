// libcore's socket syscalls (libcore.io.Linux) and the socket streams' natives, over the socket
// core native code shares (src/native/socket/): a descriptor from either side is the same socket.
import { awaited, rt, type JObj, getDeclared, setDeclared, driven, waits } from "../jvm/runtime.ts";
import { vcall, scall, newObj, after, iof } from "../jvm/natives/jentry.ts";
import { jarray, u8 } from "../jvm/abi.ts";
import { fdInt, mkFd } from "../jvm/natives/jio.ts";
import { errno, sys, ioResult, readBytes, writeBytes, FD, type IoBuffer } from "./os.ts";
import { E, ERRSTR, POLLIN, POLLERR } from "../native/abi.ts";
import { javaDup2Fd, dropFile } from "../native/fd.ts";
import { pollEntries, type PollEntry } from "../native/poll.ts";
import { SOL_SOCKET, MSG_DONTWAIT, MSG_TRUNC, sunPath, sunPathBytes, unixAddress, type SocketAddress } from "../native/socket/abi.ts";
import { SO_PEERCRED, SO_RCVTIMEO, SO_SNDTIMEO, SO_BINDTODEVICE, readSocket, socketOf, type Socket, type Received, type Accepted } from "../native/socket/core.ts";
import { IPPROTO_IP, IP_ADD_MEMBERSHIP, MCAST_JOIN_GROUP } from "../native/socket/inet.ts";
import { socketCreate, socketPair } from "../native/socket/syscalls.ts";
import {
  AF_UNIX, AF_INET, AF_INET6, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME, INTERFACES, resolveHost, hostOf, gaiText, endpointOf, addressText, parseIpv4, parseIpv6, type Endpoint,
} from "../native/net-address.ts";

const ISA = "java/net/InetSocketAddress", UNIX_ADDRESS = "android/system/UnixSocketAddress", ISA_HOLDER = "java/net/InetSocketAddress$InetSocketAddressHolder";
const INET = "Ljava/net/InetAddress;", SOCKADDR = "Ljava/net/SocketAddress;";
const IP_MULTICAST_IF = 32;

/** a bytecode throwable, thrown once made */
const thrown = (cls: string, desc: string, ...args: unknown[]): Promise<never> => after(newObj(cls, desc, ...args), (e) => { throw e; });
const socketClosed = () => rt.mkThrowable("java/net/SocketException", "Socket closed");
/** the descriptor a call waited on closed under it: libcore's AsynchronousCloseMonitor answer */
const closedUnder = (fn: string, r: number) => { if (r === -E.BADF) throw socketClosed(); sys(fn, r); return r; };
/** a result that may come after waiting */
const waited = <T>(fn: string, r: T | number | Promise<T | number>, done: (v: T) => unknown = (v) => v) =>
  r instanceof Promise ? r.then((v) => typeof v === "number" && v < 0 ? closedUnder(fn, v) : done(v as T))
    : typeof r === "number" && r < 0 ? sys(fn, r) : done(r as T);
/** the socket a FileDescriptor names, else the call's ErrnoException */
function socket(fn: string, d: JObj | null): Socket {
  const s = socketOf(fdInt(d));
  if (typeof s === "number") throw errno(fn, -s);
  return s;
}

/** an InetAddress's endpoint, as libcore's inetAddressToSockaddr reads it */
function endpoint(address: JObj | null, port: number): Endpoint | Promise<Endpoint> {
  if (address === null) return rt.npe();
  return after(vcall(address, "getAddress", "()[B") as Int8Array | Promise<Int8Array>, (bytes) => endpointOf(Uint8Array.from(bytes), port));
}
const inet = (ep: Endpoint): SocketAddress => ({ family: ep.address.length === 4 ? AF_INET : AF_INET6, ep });
/** a SocketAddress's sockaddr: an InetSocketAddress's endpoint, or a UnixSocketAddress's sun_path */
function socketAddress(fn: string, address: JObj | null): SocketAddress | Promise<SocketAddress> {
  if (address === null) return rt.npe();
  if (iof(address, UNIX_ADDRESS)) return unixAddress(sunPath(u8(getDeclared<Int8Array>(address, UNIX_ADDRESS, "sun_path"))));
  if (!iof(address, ISA)) throw errno(fn, E.AFNOSUPPORT);
  const holder = getDeclared(address, ISA, "holder") as JObj;
  const addr = getDeclared(holder, ISA_HOLDER, "addr") as JObj | null;
  if (addr === null) throw errno(fn, E.INVAL);
  return after(endpoint(addr, getDeclared(holder, ISA_HOLDER, "port") as number), inet);
}
/** sockaddrToInetAddress: InetAddress.getByAddress(null, bytes, scope) */
const inetAddress = (ep: { address: number[]; scope?: number }): JObj | Promise<JObj> =>
  scall("java/net/InetAddress", "getByAddress", "(Ljava/lang/String;[BI)Ljava/net/InetAddress;", null, Int8Array.from(ep.address), ep.scope ?? 0);
/** a sockaddr as libcore's SocketAddress: an InetSocketAddress, or a UnixSocketAddress over its sun_path */
const javaSocketAddress = (addr: SocketAddress): JObj | Promise<JObj> => addr.family === AF_UNIX
  ? newObj(UNIX_ADDRESS, "([B)V", new Int8Array(sunPathBytes(addr.path).buffer))
  : after(inetAddress(addr.ep), (a) => newObj(ISA, `(${INET}I)V`, a, addr.ep.port));
/** fillInetSocketAddress: a caller's InetSocketAddress takes an internet sender's address and port */
function fillSocketAddress(target: JObj | null, from: SocketAddress | null): void | Promise<void> {
  if (target === null || from === null || from.family === AF_UNIX || !iof(target, ISA)) return;
  return after(inetAddress(from.ep), (a) => {
    const holder = getDeclared(target, ISA, "holder") as JObj;
    setDeclared(holder, ISA_HOLDER, { addr: a, port: from.ep.port });
  });
}

function connect(d: JObj | null, addr: SocketAddress) { return waited("connect", socket("connect", d).connect(addr), () => {}); }
function bind(d: JObj | null, addr: SocketAddress) { sys("bind", socket("bind", d).bind(addr)); }
function sendto(d: JObj | null, buffer: IoBuffer, offset: number, count: number, to: SocketAddress | null) {
  const s = socket("sendto", d);
  return writeBytes(buffer, offset, count, (bytes) => ioResult("sendto", s.send(bytes, to, null)));
}
const intOption = (fn: string, d: JObj | null, level: number, name: number) => ioResult(fn, socket(fn, d).getOption(level, name));
const setIntOption = (fn: string, d: JObj | null, level: number, name: number, value: number) => sys(fn, socket(fn, d).setOption(level, name, value));
/** getaddrinfo's EAI_* as android.system.GaiException */
const gaiError = (fn: string, code: number) => thrown("android/system/GaiException", "(Ljava/lang/String;I)V", fn, code);
/** getsockname/getpeername */
function socketAddressOf(fn: string, d: JObj | null, peer: boolean) {
  const name = socket(fn, d).name(peer);
  if (typeof name === "number") throw errno(fn, -name);
  return javaSocketAddress(name);
}
const iface = (name: string | null) => INTERFACES.find((i) => i.name === name) ?? null;

const linux: Record<string, (...args: never[]) => unknown> = {
  "socket(III)Ljava/io/FileDescriptor;": (domain: number, type: number, protocol: number) => {
    const fd = socketCreate(domain, type, protocol);
    sys("socket", fd);
    return mkFd(fd);
  },
  [`socketpair(III${FD}${FD})V`]: (domain: number, type: number, _protocol: number, a: JObj | null, b: JObj | null) => {
    if (domain !== AF_UNIX) throw errno("socketpair", E.AFNOSUPPORT);
    const pair = socketPair(type);
    if (typeof pair === "number") throw errno("socketpair", -pair);
    const [x, y] = pair;
    setDeclared(a!, "java/io/FileDescriptor", { descriptor: x });
    setDeclared(b!, "java/io/FileDescriptor", { descriptor: y });
  },
  [`dup2(${FD}I)${FD}`]: (d: JObj | null, to: number) => {
    const fd = javaDup2Fd(fdInt(d), to);
    sys("dup2", fd);
    return mkFd(fd);
  },
  [`connect(${FD}${INET}I)V`]: waits((d: JObj | null, address: JObj | null, port: number) => after(endpoint(address, port), (ep) => connect(d, inet(ep)))),
  [`connect(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => after(socketAddress("connect", address), (addr) => connect(d, addr)),
  [`bind(${FD}${INET}I)V`]: (d: JObj | null, address: JObj | null, port: number) => after(endpoint(address, port), (ep) => bind(d, inet(ep))),
  [`bind(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => after(socketAddress("bind", address), (addr) => bind(d, addr)),
  [`listen(${FD}I)V`]: (d: JObj | null) => { sys("listen", socket("listen", d).listen()); },
  // an AF_UNIX peer is unnamed: its UnixSocketAddress stays as the caller made it
  [`accept(${FD}${SOCKADDR})${FD}`]: (d: JObj | null, peer: JObj | null) =>
    waited("accept", socket("accept", d).accept(fdInt(d), 0), (r: Accepted) => after(fillSocketAddress(peer, r.peer), () => mkFd(r.fd))),
  [`shutdown(${FD}I)V`]: (d: JObj | null, how: number) => { sys("shutdown", socket("shutdown", d).shutdown(how)); },
  [`getsockname(${FD})${SOCKADDR}`]: (d: JObj | null) => socketAddressOf("getsockname", d, false),
  [`getpeername(${FD})${SOCKADDR}`]: (d: JObj | null) => socketAddressOf("getpeername", d, true),
  "poll([Landroid/system/StructPollfd;I)I": waits((fds: JObj[] | null, timeout: number) => {
    if (fds === null) return rt.npe();
    const P = "android/system/StructPollfd";
    const entries: PollEntry[] = fds.map((p) => ({ fd: p === null ? -1 : fdInt(getDeclared(p, P, "fd") as JObj | null), events: getDeclared(p, P, "events") as number, revents: 0 }));
    return after(pollEntries(entries, timeout), (n) => {
      fds.forEach((p, i) => { if (p !== null) setDeclared(p, P, { revents: entries[i].revents }); });
      return n;
    });
  }),
  [`getsockoptInt(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name),
  [`setsockoptInt(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value),
  [`getsockoptByte(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name) & 255,
  [`setsockoptByte(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value & 255),
  [`getsockoptLinger(${FD}II)Landroid/system/StructLinger;`]: (d: JObj | null, level: number, name: number) => {
    const linger = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructLinger", "(II)V", linger ? 1 : 0, Math.max(0, linger - 1));
  },
  [`setsockoptLinger(${FD}IILandroid/system/StructLinger;)V`]: (d: JObj | null, level: number, name: number, linger: JObj | null) => {
    if (linger === null) return rt.npe();
    const L = "android/system/StructLinger";
    setIntOption("setsockopt", d, level, name, getDeclared(linger, L, "l_onoff") ? getDeclared(linger, L, "l_linger") as number : -1);
  },
  [`getsockoptTimeval(${FD}II)Landroid/system/StructTimeval;`]: (d: JObj | null, level: number, name: number) => {
    const ms = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructTimeval", "(JJ)V", BigInt(Math.floor(ms / 1000)), BigInt(ms % 1000 * 1000));
  },
  [`setsockoptTimeval(${FD}IILandroid/system/StructTimeval;)V`]: (d: JObj | null, level: number, name: number, tv: JObj | null) => {
    if (tv === null) return rt.npe();
    const T = "android/system/StructTimeval", sec = getDeclared(tv, T, "tv_sec") as bigint, usec = getDeclared(tv, T, "tv_usec") as bigint;
    if (level !== SOL_SOCKET || name !== SO_RCVTIMEO && name !== SO_SNDTIMEO || sec < 0n || usec < 0n || usec >= 1_000_000n) throw errno("setsockopt", E.INVAL);
    setIntOption("setsockopt", d, level, name, Number(sec) * 1000 + Math.ceil(Number(usec) / 1000));
  },
  [`getsockoptUcred(${FD}II)Landroid/system/StructUcred;`]: (d: JObj | null, level: number, name: number) => {
    if (level !== SOL_SOCKET || name !== SO_PEERCRED) throw errno("getsockopt", E.NOPROTOOPT);
    const c = socket("getsockopt", d).peerCredentials();
    if (typeof c === "number") throw errno("getsockopt", -c);
    return newObj("android/system/StructUcred", "(III)V", c.pid, c.uid, c.gid);
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
    const join = name === MCAST_JOIN_GROUP || name === IP_ADD_MEMBERSHIP;
    return after(endpoint(getDeclared(req, G, "gr_group") as JObj | null, 0), (ep) =>
      sys("setsockopt", socket("setsockopt", d).group(join, ep.address, getDeclared(req, G, "gr_interface") as number)));
  },
  [`setsockoptIfreq(${FD}IILjava/lang/String;)V`]: (d: JObj | null, level: number, name: number, ifname: string | null) => {
    socket("setsockopt", d);
    if (level !== SOL_SOCKET || name !== SO_BINDTODEVICE) throw errno("setsockopt", E.NOPROTOOPT);
    if (ifname && !iface(ifname)) throw errno("setsockopt", E.NODEV);
  },
  [`sendtoBytes(${FD}Ljava/lang/Object;III${INET}I)I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null, port: number) =>
    address === null ? sendto(d, buffer, offset, count, null) : after(endpoint(address, port), (ep) => sendto(d, buffer, offset, count, inet(ep))),
  [`sendtoBytes(${FD}Ljava/lang/Object;III${SOCKADDR})I`]: (d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null) =>
    address === null ? sendto(d, buffer, offset, count, null) : after(socketAddress("sendto", address), (to) => sendto(d, buffer, offset, count, to)),
  [`recvfromBytes(${FD}Ljava/lang/Object;III${"Ljava/net/InetSocketAddress;"})I`]: waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, source: JObj | null) => {
    const s = socket("recvfrom", d);
    let from: SocketAddress | null = null;
    const take = (r: Received | number) => {
      if (typeof r === "number") return r;
      r.rights.forEach(dropFile);
      from = r.from;
      return flags & MSG_TRUNC ? r.size : r.length;
    };
    const n = readBytes("recvfrom", buffer, offset, count, (target) => {
      const r = s.receive(fdInt(d), target, flags);
      return r instanceof Promise ? r.then((v) => closedUnder("recvfrom", take(v))) : take(r);
    });
    return after(n, (received) => after(fillSocketAddress(source, from), () => received));
  }),
  "android_getaddrinfo(Ljava/lang/String;Landroid/system/StructAddrinfo;I)[Ljava/net/InetAddress;": (node: string | null, hints: JObj | null) => {
    if (node === null || hints === null) return rt.npe();
    const A = "android/system/StructAddrinfo";
    const found = resolveHost(node, getDeclared(hints, A, "ai_family") as number, getDeclared(hints, A, "ai_flags") as number);
    return after(found, (addresses) => typeof addresses === "number" ? gaiError("android_getaddrinfo", addresses)
      : Promise.all(addresses.map((address) => inetAddress({ address }))).then((list) => jarray(list, INET)));
  },
  [`getnameinfo(${INET}I)Ljava/lang/String;`]: (address: JObj | null, flags: number) => after(endpoint(address, 0), (ep) => {
    const name = flags & NI_NUMERICHOST ? null : hostOf(ep.address);
    if (name === null && flags & NI_NAMEREQD) return gaiError("getnameinfo", EAI_NONAME);
    return name ?? addressText(ep.address);
  }),
  "gai_strerror(I)Ljava/lang/String;": (code: number) => gaiText(code),
  "inet_pton(ILjava/lang/String;)Ljava/net/InetAddress;": (family: number, text: string | null) => {
    if (text === null) return rt.npe();
    const bytes = family === AF_INET ? parseIpv4(text) : family === AF_INET6 ? parseIpv6(text) : null;
    return bytes ? inetAddress({ address: bytes }) : null;
  },
  "getifaddrs()[Landroid/system/StructIfaddrs;": driven(function* () {
    const list: JObj[] = [];
    for (const i of INTERFACES) for (const { address, prefix } of i.addresses) {
      const mask = Array.from({ length: address.length }, (_, k) => 255 & ~(255 >> Math.max(0, Math.min(8, prefix - 8 * k))));
      list.push(yield newObj("android/system/StructIfaddrs", `(Ljava/lang/String;I${INET}${INET}${INET}[B)V`, i.name, i.flags,
        yield* awaited(inetAddress({ address })), yield* awaited(inetAddress({ address: mask })), null, null));
    }
    return jarray(list, "Landroid/system/StructIfaddrs;");
  }),
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
rt.registerJni("java/net/SocketInputStream", `socketRead0(${FD}[BIII)I`, waits((d: JObj | null, b: Int8Array, off: number, len: number, timeout: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const target = new Uint8Array(b.buffer, b.byteOffset + off, len);
  if (timeout <= 0) { const n = readSocket(fd, target); return n instanceof Promise ? n.then(readDone) : readDone(n); }
  const n = readSocket(fd, target, MSG_DONTWAIT);
  if (n !== -E.AGAIN) return readDone(n as number);
  const entry = { fd, events: POLLIN | POLLERR, revents: 0 };
  return after(pollEntries([entry], timeout), (ready) => {
    if (!ready) throw rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out");
    return after(readSocket(fd, target, MSG_DONTWAIT), readDone);
  });
}));
rt.registerJni("java/net/SocketOutputStream", `socketWrite0(${FD}[BII)V`, (d: JObj | null, b: Int8Array, off: number, len: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const s = socketOf(fd), n = typeof s === "number" ? s : s.send(new Uint8Array(b.buffer, b.byteOffset + off, len), null, null);
  if (n >= 0) return;
  if (n === -E.CONNRESET) return thrown("sun/net/ConnectionResetException", "(Ljava/lang/String;)V", "Connection reset");
  throw n === -E.BADF ? socketClosed() : rt.mkThrowable("java/net/SocketException", ERRSTR[-n] ?? "Write failed");
});
