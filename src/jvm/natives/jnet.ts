// java.net / javax.net.ssl / java.nio.channels, over a real TCP connection borrowed from the
// dev server.
//
// A page cannot open a socket, so one WebSocket carries one TCP connection (server.ts's /tcp
// route) and TLS is terminated at the relay -- the page has no certificate store and could not
// handshake. That has one visible consequence: the certificate an app inspects is ours, not the
// peer's. It carries the requested host as its only SAN, which is exactly what a hostname
// verifier needs and nothing more, so an app that PINS a certificate will correctly fail rather
// than be told a comforting lie.
import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { mimeFromFilename } from "../../mime";
import { newArrayList, toJsArray, mkIter } from "./jutil";
import { JThrowable, stringHash, mkEnumSet, newObj, vcall, defineException } from "./jlang";
import { JX509, mkPrincipal } from "./jx509";
import { jarray, strArray, dotName, i8, u8 } from "../abi";
import { type JBAOS } from "./jio";
import { vfs } from "../../shell/vfs";
import { Relay, DatagramRelay, syntheticAddress, syntheticHost, nameExists, ipv4Text } from "../../shell/relay";

rt.markers("javax/net/ssl/HostnameVerifier", "javax/net/ssl/X509TrustManager", "javax/net/ssl/TrustManager", "javax/net/ssl/KeyManager",
  "javax/net/ssl/SSLSession", "javax/net/ssl/SSLContextSpi", "java/nio/channels/ReadableByteChannel", "java/nio/channels/WritableByteChannel",
  "java/nio/channels/ByteChannel", "java/nio/channels/Channel", "java/net/ResponseCache");

class JSocketFactory extends JObj {}
const socketFactory = new JSocketFactory();
/** a connected socket of the given class; rt.make skips <init>, so TLS is set here */
async function dial(cls: string, host: string, port: number): Promise<JSocket> {
  const s = rt.make(cls) as JSocket;
  s.host = host ?? ""; s.port = port;
  if (cls !== "java/net/Socket") s.tls = true;
  await s.open();
  return s;
}
rt.register({
  name: "javax/net/SocketFactory", ctor: JSocketFactory,
  methods: {
    "static getDefault()Ljavax/net/SocketFactory;": () => socketFactory,
    "createSocket()Ljava/net/Socket;": function () { return newObj("java/net/Socket", null); },
    "createSocket(Ljava/lang/String;I)Ljava/net/Socket;": (h: string, p: number) => dial("java/net/Socket", h, p),
    "createSocket(Ljava/net/InetAddress;I)Ljava/net/Socket;": (address: JInetAddress, port: number) => dial("java/net/Socket", address?.host ?? "localhost", port),
  },
});
class JSSLSocketFactory extends JSocketFactory {}
const sslSocketFactory = new JSSLSocketFactory();
rt.register({
  name: "javax/net/ssl/SSLSocketFactory", ctor: JSSLSocketFactory, sup: "javax/net/SocketFactory",
  methods: {
    "static getDefault()Ljavax/net/SocketFactory;": () => sslSocketFactory,
    // The OkHttp shape: connect a plain socket, then hand it here to be wrapped for TLS. Our
    // TLS lives at the relay, so the wrapper takes the target over and re-dials with tls=1;
    // the plain connection is dropped, which is invisible because nothing has been written yet.
    "createSocket(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;":
      function (plain: JSocket, host: string, port: number, autoClose: number) {
        const s = rt.make("javax/net/ssl/SSLSocket") as JSocket;
        s.host = host ?? plain?.host ?? ""; s.port = port || plain?.port || 443; s.tls = true;
        if (plain) {
          plain.wrapped = s;
          if (autoClose) {
            plain.relay?.close(); plain.relay = null;
            s.underlying = plain;
          }
        }
        return s;
      },
    "createSocket()Ljava/net/Socket;": () => newObj("javax/net/ssl/SSLSocket"),
    "createSocket(Ljava/lang/String;I)Ljava/net/Socket;": (h: string, p: number) => dial("javax/net/ssl/SSLSocket", h, p),
    "createSocket(Ljava/net/InetAddress;I)Ljava/net/Socket;": (address: JInetAddress, port: number) => dial("javax/net/ssl/SSLSocket", address?.host ?? "localhost", port),
    "getDefaultCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "getSupportedCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
  },
});

class JServerSocketFactory extends JObj {}
const serverSocketFactory = new JServerSocketFactory();
rt.register({
  name: "javax/net/ServerSocketFactory", ctor: JServerSocketFactory,
  methods: { "static getDefault()Ljavax/net/ServerSocketFactory;": () => serverSocketFactory },
});
class JSSLServerSocketFactory extends JServerSocketFactory {}
const sslServerSocketFactory = new JSSLServerSocketFactory();
rt.register({
  name: "javax/net/ssl/SSLServerSocketFactory", ctor: JSSLServerSocketFactory, sup: "javax/net/ServerSocketFactory",
  methods: {
    "static getDefault()Ljavax/net/ServerSocketFactory;": () => sslServerSocketFactory,
    "getDefaultCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "getSupportedCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
  },
});

const proxyTypes = mkEnumSet("java/net/Proxy$Type", ["DIRECT", "HTTP", "SOCKS"]);
class JProxy extends JObj {}
const noProxy = new JProxy();
rt.register({
  name: "java/net/Proxy", ctor: JProxy,
  statics: { NO_PROXY: noProxy },
  methods: {
    "address()Ljava/net/SocketAddress;": () => null,
    "type()Ljava/net/Proxy$Type;": () => proxyTypes[0],
    "toString()Ljava/lang/String;": () => "DIRECT",
  },
});
class JProxySelector extends JObj {}
const proxySelector = new JProxySelector();
rt.register({
  name: "java/net/ProxySelector", ctor: JProxySelector,
  methods: {
    "static getDefault()Ljava/net/ProxySelector;": () => proxySelector,
    "select(Ljava/net/URI;)Ljava/util/List;": () => newArrayList([noProxy]),
  },
});
rt.register({
  name: "java/net/Authenticator", ctor: class extends JObj {},
  methods: { "<init>()V": function () {} },
});
rt.markers("java/net/Authenticator$RequestorType");

class JSSLContext extends JObj { protocol = "TLS"; provider: unknown = null; }
function sslContext(protocol: string | null, provider: unknown = null): JSSLContext {
  if (protocol === null) throw rt.mkThrowable("java/lang/NullPointerException", "protocol");
  if (!["Default", "TLS", "TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3", "SSL"].includes(protocol)) throw rt.mkThrowable("java/security/NoSuchAlgorithmException", protocol);
  return Object.assign(new JSSLContext(), { protocol, provider });
}
let defaultSSLContext: JSSLContext | null = null;
rt.register({
  name: "javax/net/ssl/SSLContext", ctor: JSSLContext,
  methods: {
    "static getDefault()Ljavax/net/ssl/SSLContext;": () => defaultSSLContext ??= new JSSLContext(),
    "static setDefault(Ljavax/net/ssl/SSLContext;)V": (context: JSSLContext | null) => {
      if (!context) throw rt.mkThrowable("java/lang/NullPointerException", "context");
      defaultSSLContext = context;
    },
    "static getInstance(Ljava/lang/String;)Ljavax/net/ssl/SSLContext;": sslContext,
    "static getInstance(Ljava/lang/String;Ljava/security/Provider;)Ljavax/net/ssl/SSLContext;": (protocol: string, provider: unknown) => {
      if (!provider) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Missing provider");
      return sslContext(protocol, provider);
    },
    "getProtocol()Ljava/lang/String;": function (this: JSSLContext) { return this.protocol; },
    "createSSLEngine()Ljavax/net/ssl/SSLEngine;": () => rt.make("javax/net/ssl/SSLEngine"),
    "init([Ljavax/net/ssl/KeyManager;[Ljavax/net/ssl/TrustManager;Ljava/security/SecureRandom;)V": () => {},
    "getProvider()Ljava/security/Provider;": function (this: JSSLContext) { return this.provider ?? vcall(rt.link("java/security/Security").ctor, "getProvider", "(Ljava/lang/String;)Ljava/security/Provider;", "AndroidOpenSSL"); },
    "getSocketFactory()Ljavax/net/ssl/SSLSocketFactory;": () => rt.make("javax/net/ssl/SSLSocketFactory"),
  },
});

class JQName extends JObj { ns = ""; local = ""; prefix = ""; }
rt.register({
  name: "javax/xml/namespace/QName", ctor: JQName,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JQName, ns: string, l: string, p: string) { this.ns = ns; this.local = l; this.prefix = p; },
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JQName, ns: string, l: string) { this.ns = ns; this.local = l; },
    "<init>(Ljava/lang/String;)V": function (this: JQName, l: string) { this.local = l; },
    "getLocalPart()Ljava/lang/String;": function (this: JQName) { return this.local; },
    "getNamespaceURI()Ljava/lang/String;": function (this: JQName) { return this.ns; },
    "getPrefix()Ljava/lang/String;": function (this: JQName) { return this.prefix; },
    "toString()Ljava/lang/String;": function (this: JQName) { return this.ns ? "{" + this.ns + "}" + this.local : this.local; },
  },
});

// java.net addresses, and Socket over the relay above. A name's address is the synthetic one the
// native resolver hands out for it, so an app that resolves in Java and dials natively (or the
// other way round) reaches the same relay connection.
class JInetAddress extends JObj { host = ""; bytes: number[] = [0, 0, 0, 0]; }
class JInet4Address extends JInetAddress {}
class JInet6Address extends JInetAddress {}
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
function parseIpv6(text: string): number[] | null {
  const t = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (!/^[0-9a-f:]+$/i.test(t) || !t.includes(":")) return null;
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const groups = halves.map((h) => h ? h.split(":") : []);
  const missing = 8 - groups[0].length - (groups[1]?.length ?? 0);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...groups[0], ...Array(halves.length - 1 && missing).fill("0"), ...(groups[1] ?? [])];
  if (all.some((x) => x.length > 4)) return null;
  return all.flatMap((x) => { const v = parseInt(x, 16); return [v >> 8, v & 255]; });
}
const addressText = (bytes: number[]) => bytes.length === 16 ? ipv6Text(bytes) : ipv4Text(bytes);
const inetAddr = (host: string | null) => {
  const name = host === null || host === "" ? "localhost" : host;
  const v6 = parseIpv6(name);
  if (v6) return Object.assign(new JInet6Address(), { host: ipv6Text(v6), bytes: v6 });
  const address = () => Object.assign(new JInet4Address(), { host: name, bytes: name === "localhost" ? [127, 0, 0, 1] : syntheticAddress(name) });
  const exists = nameExists(name);
  if (!(exists instanceof Promise)) return address();
  return exists.then((known) => { if (known === false) throw rt.mkThrowable("java/net/UnknownHostException", "Unable to resolve host \"" + name + "\": No address associated with hostname"); return address(); });
};
const inetBytes = (bytes: Int8Array, host: string | null) => {
  if (bytes?.length !== 4 && bytes?.length !== 16) throw rt.mkThrowable("java/net/UnknownHostException", "addr is of illegal length");
  const ip = Array.from(bytes, (b) => b & 255);
  if (ip.length === 16) return Object.assign(new JInet6Address(), { host: host ?? ipv6Text(ip), bytes: ip });
  return Object.assign(new JInet4Address(), { host: host ?? syntheticHost(ip) ?? ipv4Text(ip), bytes: ip });
};
rt.register({ name: "java/net/Inet4Address", ctor: JInet4Address, sup: "java/net/InetAddress" });
rt.register({ name: "java/net/Inet6Address", ctor: JInet6Address, sup: "java/net/InetAddress" });
const v6 = (a: JInetAddress) => a.bytes.length === 16;
const localhostAddress = () => inetAddr("localhost");
rt.register({
  name: "java/net/InetAddress", ctor: JInetAddress,
  methods: {
    "static getByName(Ljava/lang/String;)Ljava/net/InetAddress;": inetAddr,
    "static getAllByName(Ljava/lang/String;)[Ljava/net/InetAddress;": driven(function* (h: string): Gen { return jarray([yield inetAddr(h)], "Ljava/net/InetAddress;"); }),
    "static getByAddress([B)Ljava/net/InetAddress;": (b: Int8Array) => inetBytes(b, null),
    "static getByAddress(Ljava/lang/String;[B)Ljava/net/InetAddress;": (h: string | null, b: Int8Array) => inetBytes(b, h),
    "static getLoopbackAddress()Ljava/net/InetAddress;": localhostAddress,
    "static getLocalHost()Ljava/net/InetAddress;": localhostAddress,
    "getHostName()Ljava/lang/String;": function (this: JInetAddress) { return this.host; },
    "getCanonicalHostName()Ljava/lang/String;": function (this: JInetAddress) { return this.host; },
    "getHostAddress()Ljava/lang/String;": function (this: JInetAddress) { return addressText(this.bytes); },
    "getAddress()[B": function (this: JInetAddress) { return Int8Array.from(this.bytes); },
    "isLoopbackAddress()Z": function (this: JInetAddress) { const b = this.bytes; return +(v6(this) ? b.every((x, i) => x === (i === 15 ? 1 : 0)) : b[0] === 127); },
    "isAnyLocalAddress()Z": function (this: JInetAddress) { return this.bytes.every((b) => b === 0) ? 1 : 0; },
    "isSiteLocalAddress()Z": function (this: JInetAddress) { const [a, b] = this.bytes; return +(v6(this) ? a === 0xfe && (b & 0xc0) === 0xc0 : a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)); },
    "isLinkLocalAddress()Z": function (this: JInetAddress) { const [a, b] = this.bytes; return +(v6(this) ? a === 0xfe && (b & 0xc0) === 0x80 : a === 169 && b === 254); },
    "isMulticastAddress()Z": function (this: JInetAddress) { const a = this.bytes[0]; return +(v6(this) ? a === 0xff : a >= 224 && a < 240); },
    "equals(Ljava/lang/Object;)Z": function (this: JInetAddress, o: unknown) { return o instanceof JInetAddress && o.bytes.length === this.bytes.length && o.bytes.every((b, i) => b === this.bytes[i]) ? 1 : 0; },
    "hashCode()I": function (this: JInetAddress) { let h = 0; for (let i = 0; i < this.bytes.length; i += 4) h ^= (this.bytes[i] << 24) | (this.bytes[i + 1] << 16) | (this.bytes[i + 2] << 8) | this.bytes[i + 3]; return h | 0; },
    "toString()Ljava/lang/String;": function (this: JInetAddress) { return this.host + "/" + addressText(this.bytes); },
  },
});
// NetworkInterface: the browser exposes no interfaces, and the relay's address is the server's,
// not ours. One loopback interface is what a device with no permission to enumerate sees, and
// it keeps the callers that walk them (device-id fallbacks, MAC lookups) on their empty path.
class JNetworkInterface extends JObj { iname = "lo"; }
const loopback = () => inetAddr("localhost") as JInetAddress;   // a literal name resolves synchronously
rt.register({
  name: "java/net/NetworkInterface", ctor: JNetworkInterface,
  methods: {
    "getName()Ljava/lang/String;": function (this: JNetworkInterface) { return this.iname; },
    "getDisplayName()Ljava/lang/String;": function (this: JNetworkInterface) { return this.iname; },
    "getHardwareAddress()[B": () => null,
    "isLoopback()Z": () => 1,
    "isUp()Z": () => 1,
    "getIndex()I": () => 1,
    "getInetAddresses()Ljava/util/Enumeration;": () => mkIter([loopback()]),
    "getInterfaceAddresses()Ljava/util/List;": () => newArrayList(),
    "static getByName(Ljava/lang/String;)Ljava/net/NetworkInterface;": (n: string) =>
      n === "lo" ? new JNetworkInterface() : null,
    "static getNetworkInterfaces()Ljava/util/Enumeration;": () => mkIter([new JNetworkInterface()]),
  },
});
rt.markers("java/net/SocketAddress");
class JServerSocket extends JObj { closed = false; reuseAddress = false; }
const noInbound = (): never => { throw rt.mkThrowable("java/io/IOException", "inbound sockets are unavailable"); };
rt.register({
  name: "java/net/ServerSocket", ctor: JServerSocket, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>()V": function () {},
    "setReuseAddress(Z)V": function (this: JServerSocket, on: number) { this.reuseAddress = !!on; },
    "getReuseAddress()Z": function (this: JServerSocket) { return +this.reuseAddress; },
    "bind(Ljava/net/SocketAddress;)V": noInbound,
    "bind(Ljava/net/SocketAddress;I)V": noInbound,
    "close()V": function (this: JServerSocket) { this.closed = true; },
    "isClosed()Z": function (this: JServerSocket) { return this.closed ? 1 : 0; },
    "isBound()Z": () => 0,
  },
});
class JInetSocketAddress extends JObj { host = ""; port = 0; addr: JInetAddress | null = null; unresolved = false; }
const inetSock = (host: string | null, port: number) => Object.assign(new JInetSocketAddress(), { host: host ?? "", port });
function unresolvedSock(host: string, port: number): JInetSocketAddress {
  if (host == null || port < 0 || port > 65535) throw rt.mkThrowable("java/lang/IllegalArgumentException", `host=${host}, port=${port}`);
  return Object.assign(new JInetSocketAddress(), { host, port, unresolved: true });
}
rt.register({
  name: "java/net/InetSocketAddress", ctor: JInetSocketAddress, sup: "java/net/SocketAddress",
  methods: {
    "<init>(Ljava/lang/String;I)V": function (this: JInetSocketAddress, h: string, p2: number) { this.host = h ?? ""; this.port = p2; },
    "<init>(Ljava/net/InetAddress;I)V": function (this: JInetSocketAddress, a: JInetAddress, p2: number) { this.addr = a; this.host = a?.host ?? ""; this.port = p2; },
    "static createUnresolved(Ljava/lang/String;I)Ljava/net/InetSocketAddress;": unresolvedSock,
    "getHostString()Ljava/lang/String;": function (this: JInetSocketAddress) { return this.host; },
    "getHostName()Ljava/lang/String;": function (this: JInetSocketAddress) { return this.host; },
    "getPort()I": function (this: JInetSocketAddress) { return this.port; },
    "getAddress()Ljava/net/InetAddress;": driven(function* (this: JInetSocketAddress): Gen {
      if (this.unresolved) return null;
      return this.addr ??= yield inetAddr(this.host);
    }),
    "isUnresolved()Z": function (this: JInetSocketAddress) { return +this.unresolved; },
    "toString()Ljava/lang/String;": function (this: JInetSocketAddress) { return this.host + ":" + this.port; },
  },
});
class JDatagramPacket extends JObj {
  data: Int8Array = new Int8Array(0); offset = 0; length = 0; address: JInetAddress | null = null; port = -1;
}
function packetData(packet: JDatagramPacket, data: Int8Array, offset: number, length: number) {
  if (!data || offset < 0 || length < 0 || offset + length > data.length)
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "illegal length or offset");
  packet.data = data; packet.offset = offset; packet.length = length;
}
function packetTarget(packet: JDatagramPacket, address: JInetAddress | null, port: number) {
  if (port < 0 || port > 65535) throw rt.mkThrowable("java/lang/IllegalArgumentException", `Port out of range:${port}`);
  packet.address = address; packet.port = port;
}
rt.register({
  name: "java/net/DatagramPacket", ctor: JDatagramPacket,
  methods: {
    "<init>([BI)V": function (this: JDatagramPacket, data: Int8Array, length: number) { packetData(this, data, 0, length); },
    "<init>([BII)V": function (this: JDatagramPacket, data: Int8Array, offset: number, length: number) { packetData(this, data, offset, length); },
    "<init>([BILjava/net/InetAddress;I)V": function (this: JDatagramPacket, data: Int8Array, length: number, address: JInetAddress, port: number) {
      packetData(this, data, 0, length); packetTarget(this, address, port);
    },
    "<init>([BIILjava/net/InetAddress;I)V": function (this: JDatagramPacket, data: Int8Array, offset: number, length: number, address: JInetAddress, port: number) {
      packetData(this, data, offset, length); packetTarget(this, address, port);
    },
    "getData()[B": function (this: JDatagramPacket) { return this.data; },
    "getOffset()I": function (this: JDatagramPacket) { return this.offset; },
    "getLength()I": function (this: JDatagramPacket) { return this.length; },
    "getAddress()Ljava/net/InetAddress;": function (this: JDatagramPacket) { return this.address; },
    "getPort()I": function (this: JDatagramPacket) { return this.port; },
    "setData([B)V": function (this: JDatagramPacket, data: Int8Array) { packetData(this, data, 0, data.length); },
    "setData([BII)V": function (this: JDatagramPacket, data: Int8Array, offset: number, length: number) { packetData(this, data, offset, length); },
    "setLength(I)V": function (this: JDatagramPacket, length: number) { packetData(this, this.data, this.offset, length); },
    "setAddress(Ljava/net/InetAddress;)V": function (this: JDatagramPacket, address: JInetAddress | null) { this.address = address; },
    "setPort(I)V": function (this: JDatagramPacket, port: number) { packetTarget(this, this.address, port); },
  },
});
type Datagram = { bytes: Int8Array; address: JInetAddress; port: number };
type DatagramWaiter = { resolve: (packet: Datagram) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | null };
const datagramPorts = new Map<number, JDatagramSocket>();
let nextDatagramPort = 49152;
class JDatagramSocket extends JObj {
  port = -1;
  timeout = 0;
  closed = false;
  remote: JInetSocketAddress | null = null;
  relay: DatagramRelay | null = null;
  queue: Datagram[] = [];
  waiters: DatagramWaiter[] = [];
  bind(port: number) {
    if (this.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
    if (this.port >= 0) throw rt.mkThrowable("java/net/SocketException", "Socket is already bound");
    if (port < 0 || port > 65535) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Port out of range");
    if (!port) {
      for (let i = 0; i < 16384; i++) {
        const candidate = nextDatagramPort++;
        if (nextDatagramPort > 65535) nextDatagramPort = 49152;
        if (!datagramPorts.has(candidate)) { port = candidate; break; }
      }
    }
    if (!port || datagramPorts.has(port)) throw rt.mkThrowable("java/net/BindException", "Address already in use");
    this.port = port;
    datagramPorts.set(port, this);
  }
  deliver(packet: Datagram) {
    const waiter = this.waiters.shift();
    if (waiter) { if (waiter.timer) clearTimeout(waiter.timer); waiter.resolve(packet); }
    else this.queue.push(packet);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.relay?.close();
    if (this.port >= 0) datagramPorts.delete(this.port);
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(rt.mkThrowable("java/net/SocketException", "Socket is closed"));
    }
    this.queue = [];
  }
}
rt.register({
  name: "java/net/DatagramSocket", ctor: JDatagramSocket, ifaces: ["java/io/Closeable"],
  methods: {
    "<init>()V": function (this: JDatagramSocket) { this.bind(0); },
    "<init>(I)V": function (this: JDatagramSocket, port: number) { this.bind(port); },
    "<init>(Ljava/net/SocketAddress;)V": function (this: JDatagramSocket, address: JInetSocketAddress | null) { this.bind(address?.port ?? 0); },
    "bind(Ljava/net/SocketAddress;)V": function (this: JDatagramSocket, address: JInetSocketAddress | null) { this.bind(address?.port ?? 0); },
    "connect(Ljava/net/InetAddress;I)V": function (this: JDatagramSocket, address: JInetAddress, port: number) {
      if (port < 0 || port > 65535) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Port out of range");
      this.remote = Object.assign(new JInetSocketAddress(), { addr: address, host: address.host, port });
    },
    "disconnect()V": function (this: JDatagramSocket) { this.remote = null; },
    "send(Ljava/net/DatagramPacket;)V": driven(function* (this: JDatagramSocket, packet: JDatagramPacket): Gen {
      if (this.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
      const address = packet.address ?? this.remote?.addr;
      const port = packet.port >= 0 ? packet.port : this.remote?.port ?? -1;
      if (!address || port < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Destination is not set");
      const bytes = packet.data.slice(packet.offset, packet.offset + packet.length);
      if (address.bytes[0] !== 127) {
        this.relay ??= new DatagramRelay((data, source, sourcePort) => {
          if (!this.closed) this.deliver({ bytes: i8(data), address: inetBytes(Int8Array.from(source), null), port: sourcePort });
        });
        try { yield this.relay.send(address.host, port, u8(bytes)); }
        catch {
          rt.noteMissing("UDP remote transport");
          throw rt.mkThrowable("java/net/SocketException", "Remote UDP transport is unavailable");
        }
        return;
      }
      datagramPorts.get(port)?.deliver({ bytes, address: inetAddr("localhost") as JInetAddress, port: this.port });
    }),
    "receive(Ljava/net/DatagramPacket;)V": driven(function* (this: JDatagramSocket, packet: JDatagramPacket): Gen {
      if (this.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
      const incoming = this.queue.shift() ?? (yield new Promise<Datagram>((resolve, reject) => {
        const waiter: DatagramWaiter = { resolve, reject, timer: null };
        if (this.timeout) waiter.timer = setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(rt.mkThrowable("java/net/SocketTimeoutException", "Receive timed out"));
        }, this.timeout);
        this.waiters.push(waiter);
      }));
      const length = Math.min(packet.length, incoming.bytes.length);
      packet.data.set(incoming.bytes.subarray(0, length), packet.offset);
      packet.length = length;
      packet.address = incoming.address;
      packet.port = incoming.port;
    }),
    "setSoTimeout(I)V": function (this: JDatagramSocket, ms: number) {
      if (ms < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timeout < 0");
      this.timeout = ms;
    },
    "getSoTimeout()I": function (this: JDatagramSocket) { return this.timeout; },
    "getLocalPort()I": function (this: JDatagramSocket) { return this.port; },
    "isBound()Z": function (this: JDatagramSocket) { return +(this.port >= 0); },
    "isClosed()Z": function (this: JDatagramSocket) { return +this.closed; },
    "close()V": function (this: JDatagramSocket) { this.close(); },
  },
});
class JSocket extends JObj {
  host = ""; port = 0; tls = false; alpn: string[] = []; relay: Relay | null = null; closed = 0; soTimeout = 0;
  wrapped: JSocket | null = null; underlying: JSocket | null = null;
  private opening: Promise<void> | null = null;
  /** Opening is deferred so an SSLSocket wrapping a plain one can take the target over and
   *  connect with TLS instead -- which is exactly how OkHttp builds an HTTPS connection. */
  open(): Promise<void> {
    if (this.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
    if (this.opening) return this.opening;
    if (this.relay) return Promise.resolve();
    if (this.wrapped) return this.wrapped.open();
    const r = this.relay = new Relay(this.host, this.port, this.tls, this.alpn);
    return this.opening = r.ready.catch(() => {
      r.close();
      if (this.relay === r) this.relay = null;
      throw rt.mkThrowable("java/net/ConnectException", `Failed to connect to ${this.host}:${this.port}`);
    }).finally(() => { this.opening = null; });
  }
  close(): void {
    if (this.closed) return;
    this.closed = 1;
    this.relay?.close(); this.relay = null;
    this.wrapped?.close(); this.underlying?.close();
  }
  activeRelay(): Relay | null { return this.relay ?? this.wrapped?.relay ?? null; }
}
class JSocketIn extends JObj { s!: JSocket; }
/** A read under SO_TIMEOUT waits only that long, then throws and leaves the stream usable —
 *  which is how a caller probes whether a pooled connection is still alive. */
async function socketRead(s: JSocket, out: Uint8Array, off: number, len: number): Promise<number> {
  if (!s.relay?.connected) await s.open();
  const relay = s.relay;
  if (!relay || s.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
  if (s.soTimeout && !await relay.waitReadable(s.soTimeout)) {
    throw rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out");
  }
  return relay.read(out, off, len);
}
class JSocketOut extends JObj { s!: JSocket; }
function socketWrite(s: JSocket, bytes: Uint8Array): void | Promise<void> {
  if (s.closed) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
  if (!s.relay?.connected) return s.open().then(() => socketWrite(s, bytes));
  if (!s.relay.write(bytes)) throw rt.mkThrowable("java/net/SocketException", "Socket write failed");
}

async function socketConnect(this: JSocket, a: JInetSocketAddress) {
  this.host = a?.host ?? ""; this.port = a?.port ?? 0;
  await this.open();
}
const socketMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;I)V": driven(function* (this: JSocket, h: string, p: number): Gen {
    this.host = h ?? ""; this.port = p; yield this.open();
  }),
  "connect(Ljava/net/SocketAddress;)V": socketConnect,
  "connect(Ljava/net/SocketAddress;I)V": socketConnect,
  "getInputStream()Ljava/io/InputStream;": function (this: JSocket) {
    const o = rt.make("webdroid/SocketInputStream") as JSocketIn; o.s = this; return o;
  },
  "getOutputStream()Ljava/io/OutputStream;": function (this: JSocket) {
    const o = rt.make("webdroid/SocketOutputStream") as JSocketOut; o.s = this; return o;
  },
  "close()V": function (this: JSocket) { this.close(); },
  "isClosed()Z": function (this: JSocket) { return this.closed; },
  "isConnected()Z": function (this: JSocket) { return this.activeRelay()?.connected ? 1 : 0; },
  "isInputShutdown()Z": function (this: JSocket) { return this.activeRelay() ? 0 : 1; },
  "isOutputShutdown()Z": function (this: JSocket) { return this.activeRelay() ? 0 : 1; },
  "shutdownInput()V": () => {},
  "shutdownOutput()V": () => {},
  "getPort()I": function (this: JSocket) { return this.port; },
  "getLocalPort()I": function (this: JSocket) { return this.activeRelay()?.localEndpoint?.port ?? -1; },
  "getLocalSocketAddress()Ljava/net/SocketAddress;": function (this: JSocket) {
    const local = this.activeRelay()?.localEndpoint; return local ? inetSock(local.address, local.port) : null;
  },
  "getInetAddress()Ljava/net/InetAddress;": function (this: JSocket) { return inetAddr(this.host); },
  "getRemoteSocketAddress()Ljava/net/SocketAddress;": function (this: JSocket) { return inetSock(this.host, this.port); },
  "setTcpNoDelay(Z)V": () => {}, "setKeepAlive(Z)V": () => {},
  "setReuseAddress(Z)V": () => {}, "setSoLinger(ZI)V": () => {},
  "setSendBufferSize(I)V": () => {}, "setReceiveBufferSize(I)V": () => {},
  "setSoTimeout(I)V": function (this: JSocket, ms: number) { this.soTimeout = ms; },
  "getSoTimeout()I": function (this: JSocket) { return this.soTimeout; },
};
rt.register({ name: "java/net/Socket", ctor: JSocket, ifaces: ["java/io/Closeable"], methods: { ...socketMethods, "<init>(Ljava/net/SocketImpl;)V": function () {} } });

rt.register({
  name: "webdroid/SocketInputStream", ctor: JSocketIn, sup: "java/io/InputStream",
  methods: {
    "<init>()V": function () {},
    "read()I": driven(function* (this: JSocketIn): Gen {
      const b = new Uint8Array(1);
      const n = yield socketRead(this.s, b, 0, 1);
      return n < 0 ? -1 : b[0];
    }),
    "read([B)I": function (this: JSocketIn, out: Int8Array) {
      return socketRead(this.s, u8(out), 0, out.length);
    },
    "read([BII)I": function (this: JSocketIn, out: Int8Array, off: number, len: number) {
      return socketRead(this.s, u8(out), off, len);
    },
    "available()I": function (this: JSocketIn) { return this.s.relay?.available() ?? 0; },
    "close()V": function (this: JSocketIn) { this.s.relay?.close(); },
  },
});
rt.register({
  name: "webdroid/SocketOutputStream", ctor: JSocketOut, sup: "java/io/OutputStream",
  methods: {
    "<init>()V": function () {},
    "write(I)V": function (this: JSocketOut, b: number) { return socketWrite(this.s, new Uint8Array([b & 0xff])); },
    "write([B)V": function (this: JSocketOut, b: Int8Array) {
      return socketWrite(this.s, u8(b));
    },
    "write([BII)V": function (this: JSocketOut, b: Int8Array, off: number, len: number) {
      return socketWrite(this.s, u8(b, off, len));
    },
    "flush()V": () => {},
    "close()V": function (this: JSocketOut) { this.s.relay?.close(); },
  },
});

const CIPHERS = ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"];
const PROTOCOLS = ["TLSv1.2", "TLSv1.3"];

/** SSLSocket is a Socket that dials with TLS; the handshake happens at the relay, so
 *  startHandshake just makes sure the connection is actually up before anyone reads. */
class JSSLSocket extends JSocket {}
rt.register({
  name: "javax/net/ssl/SSLSocket", ctor: JSSLSocket, sup: "java/net/Socket",
  methods: {
    ...socketMethods,
    "<init>()V": function (this: JSSLSocket) { this.tls = true; },
    "startHandshake()V": driven(function* (this: JSSLSocket): Gen { yield this.open(); }),
    "getSession()Ljavax/net/ssl/SSLSession;": function (this: JSSLSocket) {
      const s = rt.make("webdroid/SSLSessionImpl") as JSSLSession;
      s.host = this.host; s.port = this.port;
      return s;
    },
    "setUseClientMode(Z)V": () => {}, "getUseClientMode()Z": () => 1,
    "setEnabledProtocols([Ljava/lang/String;)V": () => {},
    "getEnabledProtocols()[Ljava/lang/String;": () => strArray(PROTOCOLS),
    "getSupportedProtocols()[Ljava/lang/String;": () => strArray(PROTOCOLS),
    "setEnabledCipherSuites([Ljava/lang/String;)V": () => {},
    "getEnabledCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "getSupportedCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "setHandshakeTimeout(I)V": () => {},
    "addHandshakeCompletedListener(Ljavax/net/ssl/HandshakeCompletedListener;)V": () => {},
    "getSSLParameters()Ljavax/net/ssl/SSLParameters;": function (this: JSSLSocket) {
      rt.link("javax/net/ssl/SSLParameters"); return Object.assign(new JSSLParameters(), { protocols: [...this.alpn] });
    },
    "setSSLParameters(Ljavax/net/ssl/SSLParameters;)V": function (this: JSSLSocket, p: JSSLParameters | null) {
      if (!p) throw rt.mkThrowable("java/lang/IllegalArgumentException", "parameters == null");
      this.alpn = [...p.protocols];
    },
    "getApplicationProtocol()Ljava/lang/String;": function (this: JSSLSocket) { return this.relay?.applicationProtocol ?? null; },
    "getHandshakeApplicationProtocol()Ljava/lang/String;": () => null,
  },
});
rt.register({ name: "javax/net/ssl/SSLEngine", ctor: class extends JObj {}, methods: {
  "getApplicationProtocol()Ljava/lang/String;": () => null,
  "getHandshakeApplicationProtocol()Ljava/lang/String;": () => null,
} });
class JSSLParameters extends JObj { protocols: string[] = []; }
rt.register({
  name: "javax/net/ssl/SSLParameters", ctor: JSSLParameters,
  methods: {
    "<init>()V": function () {},
    "setApplicationProtocols([Ljava/lang/String;)V": function (this: JSSLParameters, v: string[]) { if (!v || v.some(p => !p)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid application protocols"); this.protocols = [...v]; },
    "getApplicationProtocols()[Ljava/lang/String;": function (this: JSSLParameters) { return strArray(this.protocols); },
    "setProtocols([Ljava/lang/String;)V": () => {},
    "getProtocols()[Ljava/lang/String;": () => strArray(PROTOCOLS),
    "setCipherSuites([Ljava/lang/String;)V": () => {},
    "getCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "setEndpointIdentificationAlgorithm(Ljava/lang/String;)V": () => {},
    "getEndpointIdentificationAlgorithm()Ljava/lang/String;": () => null,
    "setUseCipherSuitesOrder(Z)V": () => {},
  },
});
// Conscrypt's platform parameters class. OkHttp 3.13+ picks its Android 10 platform by finding
// it (SDK >= 29) and then speaks TLS only through SSLSockets and SSLParameters ALPN, below and
// above; without it Platform.<clinit> finds no platform and every OkHttpClient fails.
rt.markers("com/android/org/conscrypt/SSLParametersImpl");
rt.register({
  name: "android/net/ssl/SSLSockets", ctor: class extends JObj {},
  methods: {
    "static isSupportedSocket(Ljavax/net/ssl/SSLSocket;)Z": (s: unknown) => (s ? 1 : 0),
    "static setUseSessionTickets(Ljavax/net/ssl/SSLSocket;Z)V": () => {},
  },
});
class JSSLSession extends JObj { host = ""; port = 0; }
rt.register({
  name: "webdroid/SSLSessionImpl", ctor: JSSLSession, ifaces: ["javax/net/ssl/SSLSession"],
  methods: {
    "getCipherSuite()Ljava/lang/String;": () => CIPHERS[0],
    "getProtocol()Ljava/lang/String;": () => PROTOCOLS[1],
    "getPeerHost()Ljava/lang/String;": function (this: JSSLSession) { return this.host; },
    "getPeerPort()I": function (this: JSSLSession) { return this.port; },
    "getPeerCertificates()[Ljava/security/cert/Certificate;": function (this: JSSLSession) {
      const c = rt.make("java/security/cert/X509Certificate") as JX509;
      c.host = this.host; c.relayPeer = true;
      return jarray([c], "Ljava/security/cert/Certificate;");
    },
    "getLocalCertificates()[Ljava/security/cert/Certificate;": () => null,
    "getPeerPrincipal()Ljava/security/Principal;": function (this: JSSLSession) { return mkPrincipal("CN=" + this.host); },
    "getLocalPrincipal()Ljava/security/Principal;": () => null,
    "getId()[B": () => new Int8Array(0),
    "isValid()Z": () => 1,
    "invalidate()V": () => {},
    "getCreationTime()J": () => 0n,
    "getLastAccessedTime()J": () => 0n,
    "getApplicationBufferSize()I": () => 16384,
    "getPacketBufferSize()I": () => 16709,
    "getSessionContext()Ljavax/net/ssl/SSLSessionContext;": () => null,
  },
});

class JURI extends JObj {
  u = "";
  private parsed: ReturnType<typeof parseURI> | null = null;
  parts(): ReturnType<typeof parseURI> { return this.parsed ??= parseURI(this.u); }
}
function parseURI(uri: string) {
  const match = /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(uri)!;
  const scheme = match[1] ?? null, authority = match[2] || null;
  const opaque = scheme !== null && !uri.slice(scheme.length + 1).startsWith("/");
  const server = authority ? /^(?:([^@]*)@)?(\[[^\]]+\]|[^:]+)(?::([0-9]*))?$/.exec(authority) : null;
  const candidate = server?.[2] ?? null;
  let host: string | null = null;
  if (candidate?.startsWith("[")) { try { new URL("http://" + candidate.replace(/%[^\]]+/, "")); host = candidate; } catch {} }
  else if (candidate && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/.test(candidate)) host = candidate;
  const port = host && server?.[3] ? Number(server[3]) : -1;
  return { scheme, authority, host, port, userInfo: host ? server?.[1] ?? null : null,
    path: opaque ? null : match[3], query: opaque ? null : match[4] ?? null, fragment: match[5] ?? null,
    ssp: uri.slice(scheme ? scheme.length + 1 : 0).split("#", 1)[0] };
}
const decodeUriPart = (part: string | null): string | null => part === null ? null : decodeURIComponent(part);
function quoteUriPart(value: string, delimiters: string): string {
  let result = "";
  for (const c of value) result += /[A-Za-z0-9_.!~*'()-]/.test(c) || delimiters.includes(c) || c.charCodeAt(0) > 159 && !/\s/u.test(c) ? c : encodeURIComponent(c);
  return result;
}
function hierarchicalURI(scheme: string | null, authority: string | null, path: string | null, query: string | null, fragment: string | null): string {
  const uri = (scheme === null ? "" : scheme + ":") + (authority === null ? "" : "//" + quoteUriPart(authority, ";:@&=+$,[]")) +
    quoteUriPart(path ?? "", ";:@&=+$,/") + (query === null ? "" : "?" + quoteUriPart(query, ";/?:@&=+$,[]")) +
    (fragment === null ? "" : "#" + quoteUriPart(fragment, ";/?:@&=+$,[]"));
  if (scheme !== null && !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) || (scheme !== null || authority !== null) && path && !path.startsWith("/")) {
    rt.link("java/net/URISyntaxException"); const error = new JURISyntaxException(); uriSyntax.call(error, uri, "Invalid scheme or relative path"); throw error;
  }
  return uri;
}
const mkURI = (u: string | null) => Object.assign(new JURI(), { u: u ?? "" });
// URLEncoder/URLDecoder: application/x-www-form-urlencoded, which is encodeURIComponent plus
// "+" for a space and the extra unreserved set Java leaves alone.
const formEncode = (s: string) =>
  encodeURIComponent(s ?? "").replace(/[!'()~*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+");
const formDecode = (s: string) => decodeURIComponent((s ?? "").replace(/\+/g, " "));
rt.register({
  name: "java/net/URLEncoder", ctor: class extends JObj {},
  methods: {
    "static encode(Ljava/lang/String;)Ljava/lang/String;": formEncode,
    "static encode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": formEncode,
  },
});
rt.register({
  name: "java/net/URLDecoder", ctor: class extends JObj {},
  methods: {
    "static decode(Ljava/lang/String;)Ljava/lang/String;": formDecode,
    "static decode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": formDecode,
  },
});
rt.register({
  name: "java/net/URI", ctor: JURI, ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JURI, s: string) { this.u = s ?? ""; },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JURI, scheme: string | null, user: string | null, host: string | null, port: number, path: string | null, query: string | null, fragment: string | null) {
        const authority = host === null ? null : (user === null ? "" : user + "@") + (host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host) + (port === -1 ? "" : ":" + port);
        this.u = hierarchicalURI(scheme, authority, path, query, fragment);
      },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JURI, scheme: string | null, authority: string | null, path: string | null, query: string | null, fragment: string | null) { this.u = hierarchicalURI(scheme, authority, path, query, fragment); },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JURI, scheme: string | null, host: string | null, path: string | null, fragment: string | null) {
      this.u = hierarchicalURI(scheme, host?.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host, path, null, fragment);
    },

    "static create(Ljava/lang/String;)Ljava/net/URI;": mkURI,
    "toString()Ljava/lang/String;": function (this: JURI) { return this.u; },
    // RFC 2396 path normalisation: "." and ".." segments resolved, the rest of the URI untouched
    "normalize()Ljava/net/URI;": function (this: JURI) {
      const m = /^([^:/?#]+:)?(\/\/[^/?#]*)?([^?#]*)(.*)$/.exec(this.u)!;
      const out: string[] = [];
      for (const seg of (m[3] ?? "").split("/")) {
        if (seg === ".") continue;
        if (seg === ".." && out.length > 1) { out.pop(); continue; }
        out.push(seg);
      }
      return mkURI((m[1] ?? "") + (m[2] ?? "") + out.join("/") + m[4]);
    },
    "toASCIIString()Ljava/lang/String;": function (this: JURI) { return this.u; },
    "isAbsolute()Z": function (this: JURI) { return +(this.parts().scheme !== null); },
    "getScheme()Ljava/lang/String;": function (this: JURI) { return this.parts().scheme; },
    "getHost()Ljava/lang/String;": function (this: JURI) { return this.parts().host; },
    "getAuthority()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().authority); },
    "getRawAuthority()Ljava/lang/String;": function (this: JURI) { return this.parts().authority; },
    "getPath()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().path); },
    "toURL()Ljava/net/URL;": function (this: JURI) { return mkURL(this.u); },
    "getUserInfo()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().userInfo); },
    "getRawUserInfo()Ljava/lang/String;": function (this: JURI) { return this.parts().userInfo; },
    "getPort()I": function (this: JURI) { return this.parts().port; },
    "getQuery()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().query); },
    "getRawQuery()Ljava/lang/String;": function (this: JURI) { return this.parts().query; },
    "getFragment()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().fragment); },
    "getRawFragment()Ljava/lang/String;": function (this: JURI) { const i = this.u.indexOf("#"); return i < 0 ? null : this.u.slice(i + 1); },
    "getRawPath()Ljava/lang/String;": function (this: JURI) { return this.parts().path; },
    "getSchemeSpecificPart()Ljava/lang/String;": function (this: JURI) { return decodeUriPart(this.parts().ssp); },
    "resolve(Ljava/lang/String;)Ljava/net/URI;": function (this: JURI, o: string) { try { return mkURI(new URL(o, this.u).href); } catch { return mkURI(o); } },
    "equals(Ljava/lang/Object;)Z": function (this: JURI, o: unknown) { return o instanceof JURI && o.u === this.u ? 1 : 0; },
    "hashCode()I": function (this: JURI) { return stringHash(this.u); },
  },
});

// ── java.net.URL and HttpURLConnection, over the dev server's /proxy route: a page cannot speak
// raw HTTP to another origin. The proxy forwards `x-wd-*` request headers with the prefix
// stripped, follows redirects itself and reports the final URL in x-wd-final-url.
defineException("java/net/MalformedURLException", "java/io/IOException");
// the abstract socket implementation an app may subclass to reach a socket's descriptor
rt.register({ name: "java/net/SocketImpl", ctor: class extends JObj { fd: unknown = null; }, fields: { fd: "fd" }, methods: { "<init>()V": function () {} } });
defineException("java/net/ProtocolException", "java/io/IOException");
defineException("javax/net/ssl/SSLException", "java/io/IOException");
defineException("javax/net/ssl/SSLHandshakeException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLPeerUnverifiedException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLProtocolException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLKeyException", "javax/net/ssl/SSLException");
class JURISyntaxException extends JThrowable { input = ""; reason = ""; index = -1; }
function uriSyntax(this: JURISyntaxException, input: string | null, reason: string | null, index = -1): void {
  if (input === null || reason === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (index < -1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "index < -1");
  this.input = input; this.reason = reason; this.index = index;
  this.msg = reason + (index >= 0 ? " at index " + index : "") + ": " + input;
}
rt.register({ name: "java/net/URISyntaxException", ctor: JURISyntaxException, sup: "java/lang/Exception", methods: {
  "<init>(Ljava/lang/String;Ljava/lang/String;)V": uriSyntax,
  "<init>(Ljava/lang/String;Ljava/lang/String;I)V": uriSyntax,
  "getInput()Ljava/lang/String;": function (this: JURISyntaxException) { return this.input; },
  "getReason()Ljava/lang/String;": function (this: JURISyntaxException) { return this.reason; },
  "getIndex()I": function (this: JURISyntaxException) { return this.index; },
} });

const SCHEMES = /^(https?|ftp|file|jar):$/;       // what Android's URL has a handler for
const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443, "ftp:": 21 };
const userInfo = (u: URL) => u.username ? u.username + (u.password ? ":" + u.password : "") : null;

class JURL extends JObj {
  spec = ""; u!: URL; emptyAuthority = false; emptyPath = false;
  open(): JURLConnection {
    if (this.emptyAuthority) throw rt.mkThrowable("java/net/UnknownHostException", "");
    const https = this.u.protocol === "https:";
    if (this.u.protocol === "jar:") { const c = rt.make("java/net/JarURLConnection") as JURLConnection; c.url = this; return c; }
    if (!https && this.u.protocol !== "http:") throw rt.unimplemented("URL.openConnection " + this.u.protocol);
    const c = rt.make(https ? "javax/net/ssl/HttpsURLConnection" : "java/net/HttpURLConnection") as JURLConnection;
    c.url = this;
    if (c instanceof JHttpsURLConnection) { c.sslFactory = defaultHttpsFactory; c.hostnameVerifier = defaultHostnameVerifier; }
    return c;
  }
}
/** Java keeps the spec string it was given (toString round-trips); only a resolved URL is re-serialised */
function urlInit(r: JURL, spec: string | null, base?: URL): JURL {
  const s = String(spec);
  // Android accepts an empty authority; WHATWG URL needs a host for these schemes.
  const empty = !base && /^(https?|ftp):\/\/(?=\/|[?#]|$)/i.test(s);
  try { r.u = new URL(empty ? s.replace("://", "://webdroid.invalid") : s, base); } catch {
    throw rt.mkThrowable("java/net/MalformedURLException", /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "no protocol: " + s);
  }
  if (!SCHEMES.test(r.u.protocol)) throw rt.mkThrowable("java/net/MalformedURLException", "unknown protocol: " + r.u.protocol.slice(0, -1));
  r.emptyAuthority = empty;
  r.emptyPath = empty && !s.slice(s.indexOf("://") + 3).startsWith("/");
  r.spec = base ? r.u.href : s;
  return r;
}
const urlKey = (r: JURL) => r.emptyAuthority ? r.u.protocol + "//" + (r.emptyPath ? "" : r.u.pathname) + r.u.search + r.u.hash : r.u.href;
const urlFile = (r: JURL) => (r.emptyPath ? "" : r.u.pathname) + r.u.search;
const mkURL = (spec: string) => urlInit(new JURL(), spec);
rt.register({
  name: "java/net/URL", ctor: JURL, ifaces: ["java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JURL, s: string) { urlInit(this, s); },
    "<init>(Ljava/net/URL;Ljava/lang/String;)V": function (this: JURL, ctx: JURL | null, s: string) { urlInit(this, s, ctx?.u); },
    // Java concatenates "file" verbatim after the authority, so a file without a leading "/" fuses with the host
    "<init>(Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;)V": function (this: JURL, p: string, h: string, port: number, file: string) {
      urlInit(this, p + ":" + (h ? "//" + h + (port === -1 ? "" : ":" + port) : "") + (file ?? ""));
    },
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V": function (this: JURL, p: string, h: string, file: string) {
      urlInit(this, p + ":" + (h ? "//" + h : "") + (file ?? ""));
    },
    "getProtocol()Ljava/lang/String;": function (this: JURL) { return this.u.protocol.slice(0, -1); },
    "getHost()Ljava/lang/String;": function (this: JURL) { return this.emptyAuthority ? "" : this.u.hostname; },
    "getPort()I": function (this: JURL) { return this.u.port ? Number(this.u.port) : -1; },
    "getDefaultPort()I": function (this: JURL) { return DEFAULT_PORT[this.u.protocol] ?? -1; },
    "getPath()Ljava/lang/String;": function (this: JURL) { return this.emptyPath ? "" : this.u.pathname; },
    "getQuery()Ljava/lang/String;": function (this: JURL) { return this.u.search ? this.u.search.slice(1) : null; },
    "getFile()Ljava/lang/String;": function (this: JURL) { return urlFile(this); },
    "getRef()Ljava/lang/String;": function (this: JURL) { return this.u.hash ? this.u.hash.slice(1) : null; },
    "getUserInfo()Ljava/lang/String;": function (this: JURL) { return userInfo(this.u); },
    "getAuthority()Ljava/lang/String;": function (this: JURL) { const ui = userInfo(this.u); return this.emptyAuthority ? "" : (ui ? ui + "@" : "") + this.u.host; },
    "toExternalForm()Ljava/lang/String;": function (this: JURL) { return this.spec; },
    "toString()Ljava/lang/String;": function (this: JURL) { return this.spec; },
    "toURI()Ljava/net/URI;": function (this: JURL) { return newObj("java/net/URI", "(Ljava/lang/String;)V", this.spec); },
    "equals(Ljava/lang/Object;)Z": function (this: JURL, o: unknown) { return o instanceof JURL && urlKey(o) === urlKey(this) ? 1 : 0; },
    "sameFile(Ljava/net/URL;)Z": function (this: JURL, o: JURL | null) { return o && urlKey(o).split("#")[0] === urlKey(this).split("#")[0] ? 1 : 0; },
    // over the normalised form, not the spec, so equal URLs hash alike as Object requires
    "hashCode()I": function (this: JURL) { return stringHash(urlKey(this)); },
    "openConnection()Ljava/net/URLConnection;": function (this: JURL) { return this.open(); },
    "openConnection(Ljava/net/Proxy;)Ljava/net/URLConnection;": function (this: JURL) { return this.open(); },
    "openStream()Ljava/io/InputStream;": driven(function* (this: JURL): Gen {
      if (this.u.protocol === "jar:") {
        const split = this.spec.indexOf("!/");
        if (split < 0) throw rt.mkThrowable("java/io/IOException", this.spec);
        const archive = new URL(this.spec.slice(4, split));
        if (archive.protocol !== "file:") throw rt.mkThrowable("java/io/IOException", this.spec);
        const zip = yield newObj("java/util/zip/ZipFile", "(Ljava/lang/String;)V", decodeURIComponent(archive.pathname));
        const entry = yield vcall(zip, "getEntry", "(Ljava/lang/String;)Ljava/util/zip/ZipEntry;", decodeURIComponent(this.spec.slice(split + 2)));
        if (!entry) throw rt.mkThrowable("java/io/FileNotFoundException", this.spec);
        return vcall(zip, "getInputStream", "(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;", entry);
      }
      if (this.u.protocol === "file:") {
        const bytes = yield vfs.readFile(decodeURIComponent(this.u.pathname));
        if (!bytes) throw rt.mkThrowable("java/io/FileNotFoundException", this.spec);
        return newObj("java/io/ByteArrayInputStream", "([B)V", i8(bytes));
      }
      return vcall(this.open(), "getInputStream", "()Ljava/io/InputStream;");
    }),
  },
});
const idnAscii = (s: string) => {
  if (!s) return s;
  // a hostname only: URL would silently truncate anything with a delimiter in it
  if (/[/?#@:\\\s]/.test(s)) throw rt.mkThrowable("java/lang/IllegalArgumentException", s);
  try { return new URL("http://" + s).hostname; } catch { throw rt.mkThrowable("java/lang/IllegalArgumentException", s); }
};
rt.register({
  name: "java/net/IDN", ctor: class extends JObj {}, statics: { ALLOW_UNASSIGNED: 1, USE_STD3_ASCII_RULES: 2 },
  methods: {
    "static toASCII(Ljava/lang/String;)Ljava/lang/String;": idnAscii,
    "static toASCII(Ljava/lang/String;I)Ljava/lang/String;": idnAscii,
    // no punycode decoder in the page; ToUnicode's contract is to hand back the input when it cannot convert
    "static toUnicode(Ljava/lang/String;)Ljava/lang/String;": (s: string) => s,
    "static toUnicode(Ljava/lang/String;I)Ljava/lang/String;": (s: string) => s,
  },
});

class JHttpInputStream extends JObj {
  reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  timeout: () => number = () => 0;
  bytes: Uint8Array = new Uint8Array(0); offset = 0;
  closed = false; ended = false;
  /** body bytes Content-Length still promises; a stream that ends short is truncated, not done */
  remaining = Infinity;
  pending: Promise<void> | null = null;
  async fill(): Promise<boolean> {
    if (this.closed) throw rt.mkThrowable("java/io/IOException", "Stream closed");
    if (this.offset < this.bytes.length) return true;
    if (this.ended || !this.reader) return false;
    this.pending ??= this.reader.read().then(result => {
      this.ended = !!result.done; this.bytes = result.value ?? new Uint8Array(0); this.offset = 0;
      this.remaining -= this.bytes.length;
      if (this.ended && this.remaining > 0 && this.remaining !== Infinity) throw rt.mkThrowable("java/net/ProtocolException", "unexpected end of stream");
    }).catch(e => { throw e instanceof JObj ? e : rt.mkThrowable("java/io/IOException", String(e)); }).finally(() => { this.pending = null; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = this.timeout();
    try {
      if (timeout > 0) await Promise.race([this.pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out")), timeout);
      })]);
      else await this.pending;
    } finally { clearTimeout(timer); }
    return this.fill();
  }
  async read(out: Int8Array | null, offset: number, count: number): Promise<number> {
    if (!out) return rt.npe();
    if (offset < 0 || count < 0 || offset > out.length - count) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", null);
    if (!count) return 0;
    if (!await this.fill()) return -1;
    const n = Math.min(count, this.bytes.length - this.offset);
    out.set(this.bytes.subarray(this.offset, this.offset + n), offset); this.offset += n;
    return n;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.bytes = new Uint8Array(0); this.offset = 0;
    void this.reader?.cancel().catch(() => {});
  }
}
rt.register({ name: "webdroid/HttpInputStream", ctor: JHttpInputStream, sup: "java/io/InputStream", methods: {
  "read()I": driven(function* (this: JHttpInputStream): Gen { return (yield this.fill()) ? this.bytes[this.offset++] : -1; }),
  "read([B)I": function (this: JHttpInputStream, out: Int8Array | null) { return this.read(out, 0, out?.length ?? 0); },
  "read([BII)I": function (this: JHttpInputStream, out: Int8Array | null, off: number, len: number) { return this.read(out, off, len); },
  "available()I": function (this: JHttpInputStream) { return this.bytes.length - this.offset; },
  "skip(J)J": driven(function* (this: JHttpInputStream, count: bigint): Gen {
    let left = count;
    while (left > 0n && (yield this.fill())) {
      const n = Number(left < BigInt(this.bytes.length - this.offset) ? left : BigInt(this.bytes.length - this.offset));
      this.offset += n; left -= BigInt(n);
    }
    return count > 0n ? count - left : 0n;
  }),
  "close()V": function (this: JHttpInputStream) { this.close(); },
  "markSupported()Z": () => 0,
  "mark(I)V": () => {},
  "reset()V": () => { throw rt.mkThrowable("java/io/IOException", "mark/reset not supported"); },
} });
type HttpRes = { status: number; msg: string; hdrs: [string, string][]; stream: JHttpInputStream };
const statusLine = (r: HttpRes) => "HTTP/1.1 " + r.status + (r.msg ? " " + r.msg : "");
const PUT = "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;";
/** Map<String, List<String>> as URLConnection and CookieHandler hand headers out (a null key is legal: the status line) */
async function headerMap(groups: Iterable<[string | null, string[]]>) {
  const m = rt.make("java/util/HashMap");
  for (const [k, v] of groups) await vcall(m, "put", PUT, k, newArrayList(v));
  return m;
}
function group(entries: [string | null, string][]): Map<string | null, string[]> {
  const g = new Map<string | null, string[]>();
  for (const [k, v] of entries) { let l = g.get(k); if (!l) g.set(k, l = []); l.push(v); }
  return g;
}
let followRedirects = 1, defaultUseCaches = 1;
class JURLConnection extends JObj {
  url!: JURL;
  method = "GET"; follow = followRedirects; doOut = 0; doIn = 1; useCaches = defaultUseCaches;
  allowUserInteraction = 0;
  /** the protected field a subclass implementing its own transport maintains; ours reads res */
  connected = 0;
  cto = 0; rto = 0; ifMod = 0n;
  req: [string, string][] = [];
  out: JBAOS | null = null;
  ac: AbortController | null = null;
  res: HttpRes | null = null;
  pending: Promise<HttpRes> | null = null;
  connect(): Promise<HttpRes> {
    if (this.res) return Promise.resolve(this.res);
    return this.pending ??= this.fetchResponse().finally(() => { this.pending = null; });
  }
  private async fetchResponse(): Promise<HttpRes> {
    this.connected = 1;
    const ac = (this.ac = new AbortController());
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = "";
    const arm = (ms: number, what: string) => {
      clearTimeout(timer);
      if (ms > 0) timer = setTimeout(() => { timedOut = what; ac.abort(); }, ms);
    };
    const headers = new Headers();
    for (const [k, v] of this.req) headers.append("x-wd-" + k, v);
    if (this.ifMod) headers.set("x-wd-if-modified-since", new Date(Number(this.ifMod)).toUTCString());
    const hasBody = this.out && this.method !== "GET" && this.method !== "HEAD";
    let r: Response;
    arm(this.cto, "connect timed out");
    try {
      r = await fetch("/proxy?url=" + encodeURIComponent(this.url.spec) + (this.follow ? "" : "&manual=1"), {
        method: this.method, headers, signal: ac.signal, body: hasBody ? this.out!.bytes().slice() : undefined,
      });
    } catch (e) {
      if (timedOut) throw rt.mkThrowable("java/net/SocketTimeoutException", timedOut);
      if (ac.signal.aborted) throw rt.mkThrowable("java/net/SocketException", "Socket closed");
      throw rt.mkThrowable("java/io/IOException", String(e));
    } finally { clearTimeout(timer); }
    const final = r.headers.get("x-wd-final-url");
    // the proxy's own failure answer carries no final URL; a genuine upstream 502 does
    if (r.status === 502 && !final) {
      const { hostname, port, protocol } = this.url.u, kind = r.headers.get("x-wd-error");
      const detail = (await r.text()).replace(/^proxy error: /, "");
      if (kind === "host") throw rt.mkThrowable("java/net/UnknownHostException", `Unable to resolve host "${hostname}": No address associated with hostname`);
      if (kind === "refused") throw rt.mkThrowable("java/net/ConnectException", `Failed to connect to ${hostname}/${port || (protocol === "https:" ? 443 : 80)}`);
      throw rt.mkThrowable(kind === "timeout" ? "java/net/SocketTimeoutException" : kind === "tls" ? "javax/net/ssl/SSLHandshakeException" : "java/io/IOException", detail);
    }
    if (final && final !== this.url.u.href) this.url = mkURL(final);   // getURL() reports where a redirect landed
    const hdrs: [string, string][] = [];
    r.headers.forEach((v, k) => { if (k !== "x-wd-final-url" && k !== "x-wd-status" && k !== "x-wd-status-text" && k !== "x-wd-content-length") hdrs.push([k === "x-wd-content-encoding" ? "content-encoding" : k, v]); });
    const length = r.headers.get("content-length") ?? r.headers.get("x-wd-content-length");
    if (length && !r.headers.has("content-length")) hdrs.push(["content-length", length]);
    const stream = new JHttpInputStream();
    stream.reader = r.body?.getReader() ?? null; stream.timeout = () => this.rto;
    const status = this.follow ? r.status : Number(r.headers.get("x-wd-status")) || r.status;
    if (length && this.method !== "HEAD" && status >= 200 && status !== 204 && status !== 304) stream.remaining = Number(length);
    return (this.res = { status,
      msg: this.follow ? r.statusText : r.headers.get("x-wd-status-text") ?? r.statusText, hdrs, stream });
  }
  /** case-insensitive; the last value wins, as URLConnection documents */
  hdr(name: string | null): string | null {
    const r = this.res!;
    if (name === null) return statusLine(r);
    const k = name.toLowerCase();
    let v: string | null = null;
    for (const [hk, hv] of r.hdrs) if (hk === k) v = hv;
    return v;
  }
  stream(): JHttpInputStream { return this.res!.stream; }
}
/** an accessor that needs the response: connect first */
function withRes<A extends unknown[], C extends JURLConnection = JURLConnection>(f: (this: C, r: HttpRes, ...a: A) => unknown) {
  return async function (this: C, ...a: A) { return f.call(this, await this.connect(), ...a); };
}
const asLong = (v: string | null, d: bigint) => v && /^\s*-?\d+\s*$/.test(v) ? BigInt(v.trim()) : d;
// a jar: URL names an entry of an archive on the class path; the stream is the URL's own openStream
rt.register({
  name: "java/net/JarURLConnection", ctor: class extends JURLConnection {}, sup: "java/net/URLConnection",
  methods: {
    "connect()V": () => {},
    "getInputStream()Ljava/io/InputStream;": function (this: JURLConnection) { return vcall(this.url, "openStream", "()Ljava/io/InputStream;"); },
    "getContentLength()I": () => -1,
    "getContentLengthLong()J": () => -1n,
    "getContentType()Ljava/lang/String;": () => null,
    "getHeaderField(Ljava/lang/String;)Ljava/lang/String;": () => null,
  },
});
rt.register({
  name: "java/net/URLConnection", ctor: JURLConnection,
  fields: { connected: "connected", url: "url", doInput: "doIn", doOutput: "doOut", useCaches: "useCaches" },
  methods: {
    "static guessContentTypeFromName(Ljava/lang/String;)Ljava/lang/String;": (name: string | null) => mimeFromFilename(name ?? rt.npe()),
    "<init>(Ljava/net/URL;)V": function (this: JURLConnection, u: JURL) { this.url = u; },
    "connect()V": driven(function* (this: JURLConnection): Gen {
      this.connected = 1;
      // Fetch buffers uploads: connecting must leave the output stream writable until a response is requested.
      if (!this.doOut) yield this.connect();
    }),
    "getURL()Ljava/net/URL;": function (this: JURLConnection) { return this.url; },
    "getInputStream()Ljava/io/InputStream;": withRes(function (r) {
      if (!this.doIn) throw rt.mkThrowable("java/net/ProtocolException", "Cannot read from URLConnection if doInput=false (call setDoInput(true))");
      if (r.status >= 400) throw r.status === 404 || r.status === 410
        ? rt.mkThrowable("java/io/FileNotFoundException", this.url.spec)
        : rt.mkThrowable("java/io/IOException", `Server returned HTTP response code: ${r.status} for URL: ${this.url.spec}`);
      return this.stream();
    }),
    "getOutputStream()Ljava/io/OutputStream;": function (this: JURLConnection) {
      if (!this.doOut) throw rt.mkThrowable("java/net/ProtocolException", "cannot write to a URLConnection if doOutput=false - call setDoOutput(true)");
      if (this.res || this.pending) throw rt.mkThrowable("java/net/ProtocolException", "Cannot write output after reading input");
      if (this.method === "GET") this.method = "POST";   // a GET that writes a body becomes a POST (OpenJDK and AOSP alike)
      this.connected = 1;
      return this.out ??= rt.make("java/io/ByteArrayOutputStream") as JBAOS;
    },
    "setRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JURLConnection, k: string | null, v: string) {
      if (this.connected) throw rt.mkThrowable("java/lang/IllegalStateException", "Already connected");
      if (k === null) throw rt.mkThrowable("java/lang/NullPointerException", "key is null");
      this.req = this.req.filter(([n]) => n.toLowerCase() !== k.toLowerCase());
      this.req.push([k, v]);
    },
    "addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JURLConnection, k: string | null, v: string) {
      if (this.connected) throw rt.mkThrowable("java/lang/IllegalStateException", "Already connected");
      if (k === null) throw rt.mkThrowable("java/lang/NullPointerException", "key is null");
      this.req.push([k, v]);
    },
    "getRequestProperty(Ljava/lang/String;)Ljava/lang/String;": function (this: JURLConnection, k: string | null) {
      let v: string | null = null;
      for (const [n, x] of this.req) if (n.toLowerCase() === k?.toLowerCase()) v = x;
      return v;
    },
    "getRequestProperties()Ljava/util/Map;": function (this: JURLConnection) { return headerMap(group(this.req)); },
    "setDoOutput(Z)V": function (this: JURLConnection, b: number) { this.doOut = b; },
    "getDoOutput()Z": function (this: JURLConnection) { return this.doOut; },
    "setDoInput(Z)V": function (this: JURLConnection, b: number) { this.doIn = b; },
    "getDoInput()Z": function (this: JURLConnection) { return this.doIn; },
    "setUseCaches(Z)V": function (this: JURLConnection, b: number) { this.useCaches = b; },
    "getUseCaches()Z": function (this: JURLConnection) { return this.useCaches; },
    "setDefaultUseCaches(Z)V": (b: number) => { defaultUseCaches = b; },
    "getDefaultUseCaches()Z": () => defaultUseCaches,
    "setAllowUserInteraction(Z)V": function (this: JURLConnection, b: number) { this.allowUserInteraction = b ? 1 : 0; },
    "getAllowUserInteraction()Z": function (this: JURLConnection) { return this.allowUserInteraction; },
    "setConnectTimeout(I)V": function (this: JURLConnection, ms: number) { this.cto = ms; },
    "getConnectTimeout()I": function (this: JURLConnection) { return this.cto; },
    "setReadTimeout(I)V": function (this: JURLConnection, ms: number) { this.rto = ms; },
    "getReadTimeout()I": function (this: JURLConnection) { return this.rto; },
    "setIfModifiedSince(J)V": function (this: JURLConnection, t: bigint) { this.ifMod = t; },
    "getIfModifiedSince()J": function (this: JURLConnection) { return this.ifMod; },
    "getHeaderField(Ljava/lang/String;)Ljava/lang/String;": withRes(function (_r, k: string | null) { return this.hdr(k); }),
    "getHeaderField(I)Ljava/lang/String;": withRes((r, i: number) => r.hdrs[i]?.[1] ?? null),
    "getHeaderFieldKey(I)Ljava/lang/String;": withRes((r, i: number) => r.hdrs[i]?.[0] ?? null),
    "getHeaderFields()Ljava/util/Map;": withRes((r) => headerMap(group([[null, statusLine(r)], ...r.hdrs]))),
    "getHeaderFieldInt(Ljava/lang/String;I)I": withRes(function (_r, k: string, d: number) {
      const n = parseInt(this.hdr(k) ?? "", 10);
      return Number.isNaN(n) ? d : n;
    }),
    "getHeaderFieldLong(Ljava/lang/String;J)J": withRes(function (_r, k: string, d: bigint) { return asLong(this.hdr(k), d); }),
    "getHeaderFieldDate(Ljava/lang/String;J)J": withRes(function (_r, k: string, d: bigint) {
      const t = Date.parse(this.hdr(k) ?? "");
      return Number.isNaN(t) ? d : BigInt(t);
    }),
    "getContentType()Ljava/lang/String;": withRes(function () { return this.hdr("content-type"); }),
    "getContentEncoding()Ljava/lang/String;": withRes(function () { return this.hdr("content-encoding"); }),
    "getContentLength()I": withRes(function () { const n = asLong(this.hdr("content-length"), -1n); return n > 0x7fffffffn ? -1 : Number(n); }),
    "getContentLengthLong()J": withRes(function () { return asLong(this.hdr("content-length"), -1n); }),
    "toString()Ljava/lang/String;": function (this: JURLConnection) {
      return dotName((this.constructor as typeof JObj).$i.name) + ":" + this.url.spec;
    },
  },
});
const HTTP_METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "PATCH"]);
class JHttpURLConnection extends JURLConnection { responseCode = -1; responseMessage: string | null = null; chunkLength = -1; fixedContentLength = -1; fixedContentLengthLong = -1n; }
rt.register({
  name: "java/net/HttpURLConnection", ctor: JHttpURLConnection, sup: "java/net/URLConnection",
  fields: { responseCode: "responseCode", responseMessage: "responseMessage", method: "method", instanceFollowRedirects: "follow", chunkLength: "chunkLength", fixedContentLength: "fixedContentLength", fixedContentLengthLong: "fixedContentLengthLong" },
  statics: {
    HTTP_OK: 200, HTTP_CREATED: 201, HTTP_ACCEPTED: 202, HTTP_NOT_AUTHORITATIVE: 203, HTTP_NO_CONTENT: 204, HTTP_RESET: 205,
    HTTP_PARTIAL: 206, HTTP_MULT_CHOICE: 300, HTTP_MOVED_PERM: 301, HTTP_MOVED_TEMP: 302, HTTP_SEE_OTHER: 303,
    HTTP_NOT_MODIFIED: 304, HTTP_USE_PROXY: 305, HTTP_BAD_REQUEST: 400, HTTP_UNAUTHORIZED: 401, HTTP_PAYMENT_REQUIRED: 402,
    HTTP_FORBIDDEN: 403, HTTP_NOT_FOUND: 404, HTTP_BAD_METHOD: 405, HTTP_NOT_ACCEPTABLE: 406, HTTP_PROXY_AUTH: 407,
    HTTP_CLIENT_TIMEOUT: 408, HTTP_CONFLICT: 409, HTTP_GONE: 410, HTTP_LENGTH_REQUIRED: 411, HTTP_PRECON_FAILED: 412,
    HTTP_ENTITY_TOO_LARGE: 413, HTTP_REQ_TOO_LONG: 414, HTTP_UNSUPPORTED_TYPE: 415, HTTP_SERVER_ERROR: 500,
    HTTP_INTERNAL_ERROR: 500, HTTP_NOT_IMPLEMENTED: 501, HTTP_BAD_GATEWAY: 502, HTTP_UNAVAILABLE: 503,
    HTTP_GATEWAY_TIMEOUT: 504, HTTP_VERSION: 505,
  },
  methods: {
    "setRequestMethod(Ljava/lang/String;)V": function (this: JHttpURLConnection, m: string) {
      if (this.connected) throw rt.mkThrowable("java/net/ProtocolException", "Can't reset method: already connected");
      if (!HTTP_METHODS.has(m)) throw rt.mkThrowable("java/net/ProtocolException", "Invalid HTTP method: " + m);
      this.method = m;
    },
    "getRequestMethod()Ljava/lang/String;": function (this: JHttpURLConnection) { return this.method; },
    "setInstanceFollowRedirects(Z)V": function (this: JHttpURLConnection, b: number) { this.follow = b; },
    "getInstanceFollowRedirects()Z": function (this: JHttpURLConnection) { return this.follow; },
    "static setFollowRedirects(Z)V": (b: number) => { followRedirects = b; },
    "static getFollowRedirects()Z": () => followRedirects,
    // the body is buffered whole either way; the fields record the mode for a subclass's transport
    "setChunkedStreamingMode(I)V": function (this: JHttpURLConnection, n: number) { this.chunkLength = n <= 0 ? 4096 : n; },
    "setFixedLengthStreamingMode(I)V": function (this: JHttpURLConnection, n: number) { this.fixedContentLength = n; this.fixedContentLengthLong = BigInt(n); },
    "setFixedLengthStreamingMode(J)V": function (this: JHttpURLConnection, n: bigint) { this.fixedContentLengthLong = n; this.fixedContentLength = Number(BigInt.asIntN(32, n)); },
    "getResponseCode()I": withRes(function (this: JHttpURLConnection, r) { this.responseMessage = r.msg || null; return this.responseCode = r.status; }),
    "getResponseMessage()Ljava/lang/String;": withRes(function (this: JHttpURLConnection, r) { this.responseCode = r.status; return this.responseMessage = r.msg || null; }),
    "getErrorStream()Ljava/io/InputStream;": driven(function* (this: JHttpURLConnection): Gen {
      // AOSP connects here too, and answers null for any failure rather than throwing
      try { return (yield this.connect()).status >= 400 ? this.stream() : null; } catch { return null; }
    }),
    "disconnect()V": function (this: JHttpURLConnection) { this.res?.stream.close(); this.ac?.abort(); this.ac = null; },
    "usingProxy()Z": () => 0,
  },
});
// TLS ends at the proxy, but the Java connection still preserves the configured factory and
// verifier and exposes the relay's synthetic peer identity through the standard accessors.
class JHttpsURLConnection extends JHttpURLConnection {
  sslFactory: unknown = sslSocketFactory;
  hostnameVerifier: unknown = null;
}
class JDefaultHostnameVerifier extends JObj {}
const hostName = (host: string) => host.toLowerCase().replace(/\.$/, "");
const platformHostnameVerifier = new JDefaultHostnameVerifier();
rt.register({
  name: "webdroid/DefaultHostnameVerifier", ctor: JDefaultHostnameVerifier, ifaces: ["javax/net/ssl/HostnameVerifier"],
  methods: {
    "verify(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z": (host: string, session: JSSLSession) =>
      hostName(host) === hostName(session?.host ?? "") ? 1 : 0,
  },
});
let defaultHttpsFactory: unknown = sslSocketFactory;
let defaultHostnameVerifier: unknown = platformHostnameVerifier;
rt.register({
  name: "javax/net/ssl/HttpsURLConnection", ctor: JHttpsURLConnection, sup: "java/net/HttpURLConnection",
  methods: {
    "<init>(Ljava/net/URL;)V": function (this: JHttpsURLConnection, url: JURL) {
      this.url = url; this.sslFactory = defaultHttpsFactory; this.hostnameVerifier = defaultHostnameVerifier;
    },
    "setHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V": function (this: JHttpsURLConnection, verifier: unknown) {
      if (verifier === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "null HostnameVerifier");
      this.hostnameVerifier = verifier;
    },
    "getHostnameVerifier()Ljavax/net/ssl/HostnameVerifier;": function (this: JHttpsURLConnection) { return this.hostnameVerifier; },
    "setSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V": function (this: JHttpsURLConnection, factory: unknown) {
      if (factory === null) return rt.npe();
      this.sslFactory = factory;
    },
    "getSSLSocketFactory()Ljavax/net/ssl/SSLSocketFactory;": function (this: JHttpsURLConnection) { return this.sslFactory; },
    "static setDefaultHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V": (verifier: unknown) => {
      if (verifier === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "null HostnameVerifier");
      defaultHostnameVerifier = verifier;
    },
    "static getDefaultHostnameVerifier()Ljavax/net/ssl/HostnameVerifier;": () => defaultHostnameVerifier,
    "static setDefaultSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V": (factory: unknown) => {
      if (factory === null) return rt.npe();
      defaultHttpsFactory = factory;
    },
    "static getDefaultSSLSocketFactory()Ljavax/net/ssl/SSLSocketFactory;": () => defaultHttpsFactory,
    "getCipherSuite()Ljava/lang/String;": () => CIPHERS[0],
    "getLocalCertificates()[Ljava/security/cert/Certificate;": () => null,
    "getLocalPrincipal()Ljava/security/Principal;": () => null,
    "getServerCertificates()[Ljava/security/cert/Certificate;": function (this: JHttpsURLConnection) {
      const cert = rt.make("java/security/cert/X509Certificate") as JX509;
      cert.host = this.url.u.hostname; cert.relayPeer = true;
      return jarray([cert], "Ljava/security/cert/Certificate;");
    },
    "getPeerPrincipal()Ljava/security/Principal;": function (this: JHttpsURLConnection) { return mkPrincipal("CN=" + this.url.u.hostname); },
  },
});

// ── cookies. CookieHandler.get/put are abstract and always reach a CookieManager receiver, so the
// manager carries them; the store is a host → name → value map (attributes are not kept).
class JCookieHandler extends JObj {}
let defaultCookieHandler: JCookieHandler | null = null;
rt.register({
  name: "java/net/CookieHandler", ctor: JCookieHandler,
  methods: {
    "<init>()V": function () {},
    "static getDefault()Ljava/net/CookieHandler;": () => defaultCookieHandler,
    "static setDefault(Ljava/net/CookieHandler;)V": (h: JCookieHandler | null) => { defaultCookieHandler = h; },
  },
});
class JCookiePolicy extends JObj { accept = 1; }
const acceptAll = new JCookiePolicy(), acceptOriginal = new JCookiePolicy(), acceptNone = Object.assign(new JCookiePolicy(), { accept: 0 });
rt.register({
  name: "java/net/CookiePolicy", ctor: JCookiePolicy,
  statics: { ACCEPT_ALL: acceptAll, ACCEPT_NONE: acceptNone, ACCEPT_ORIGINAL_SERVER: acceptOriginal },
  methods: { "shouldAccept(Ljava/net/URI;Ljava/net/HttpCookie;)Z": function (this: JCookiePolicy) { return this.accept; } },
});
rt.markers("java/net/CookieStore");
class JCookieStore extends JObj { jar = new Map<string, Map<string, string>>(); }
rt.register({
  name: "webdroid/CookieStore", ctor: JCookieStore, ifaces: ["java/net/CookieStore"],
  methods: { "removeAll()Z": function (this: JCookieStore) { const n = this.jar.size; this.jar.clear(); return n ? 1 : 0; } },
});
class JCookieManager extends JCookieHandler { store = new JCookieStore(); policy: JObj = acceptOriginal; }
const hostOf = (uri: JURI | null) => { try { return new URL(uri?.u ?? "").hostname; } catch { return uri?.u ?? ""; } };
rt.register({
  name: "java/net/CookieManager", ctor: JCookieManager, sup: "java/net/CookieHandler",
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/net/CookieStore;Ljava/net/CookiePolicy;)V": function (this: JCookieManager, _s: unknown, p: JObj | null) { if (p) this.policy = p; },
    "setCookiePolicy(Ljava/net/CookiePolicy;)V": function (this: JCookieManager, p: JObj | null) { if (p) this.policy = p; },
    "getCookieStore()Ljava/net/CookieStore;": function (this: JCookieManager) { rt.link("webdroid/CookieStore"); return this.store; },
    "get(Ljava/net/URI;Ljava/util/Map;)Ljava/util/Map;": function (this: JCookieManager, uri: JURI | null) {
      const c = this.store.jar.get(hostOf(uri));
      // OpenJDK always answers the Cookie key, with an empty list when nothing matches
      return headerMap([["Cookie", c ? [...c].map(([k, v]) => k + "=" + v) : []]]);
    },
    "put(Ljava/net/URI;Ljava/util/Map;)V": driven(function* (this: JCookieManager, uri: JURI | null, hdrs: unknown): Gen {
      if (this.policy === acceptNone || !hdrs) return;
      const host = hostOf(uri);
      for (const e of yield toJsArray(yield vcall(hdrs, "entrySet", "()Ljava/util/Set;"))) {
        const k = (yield vcall(e, "getKey", "()Ljava/lang/Object;")) as string | null;
        if (!k || !/^set-cookie2?$/i.test(k)) continue;
        for (const v of (yield toJsArray(yield vcall(e, "getValue", "()Ljava/lang/Object;"))) as string[]) {
          const m = /^\s*([^=;\s]+)=([^;]*)/.exec(v);
          if (!m) continue;
          let c = this.store.jar.get(host);
          if (!c) this.store.jar.set(host, c = new Map());
          c.set(m[1], m[2].trim());
        }
      }
    }),
  },
});
