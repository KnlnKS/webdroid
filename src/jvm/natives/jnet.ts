// java.net / javax.net.ssl / java.nio.channels, over a real TCP connection borrowed from the
// dev server.
//
// A page cannot open a socket, so one WebSocket carries one TCP connection (server.ts's /tcp
// route) and TLS is terminated at the relay -- the page has no certificate store and could not
// handshake. That has one visible consequence: the certificate an app inspects is ours, not the
// peer's. It carries the requested host as its only SAN, which is exactly what a hostname
// verifier needs and nothing more, so an app that PINS a certificate will correctly fail rather
// than be told a comforting lie.
import { rt, JObj, maySuspend, type NativeSpec } from "../runtime";
import { newArrayList, toJsArray, mkIter } from "./jutil";
import { stringHash, mkEnumSet, newObj, vcall, defineException } from "./jlang";
import { JX509, mkPrincipal } from "./jx509";
import { jarray, strArray, dotName, utf8 } from "../abi";
import { vfs, type JInputStream, type JOutputStream } from "./jio";
import { Relay } from "../../shell/relay";

for (const marker of [
  "javax/net/ssl/HostnameVerifier", "javax/net/ssl/X509TrustManager", "javax/net/ssl/TrustManager",
  "javax/net/ssl/KeyManager", "javax/net/ssl/SSLSession",
  "java/nio/channels/ReadableByteChannel", "java/nio/channels/WritableByteChannel", "java/nio/channels/ByteChannel",
  "java/nio/channels/Channel",
  "java/net/ResponseCache",
]) rt.register({ name: marker, ctor: class extends JObj {} });

class JSocketFactory extends JObj {}
const socketFactory = new JSocketFactory();
/** a connected socket of the given class (SSLSocket's own <init> turns tls on) */
async function dial(cls: string, host: string, port: number): Promise<JSocket> {
  const s = new (rt.link(cls).ctor)() as JSocket;
  s.host = host ?? ""; s.port = port;
  if (cls !== "java/net/Socket") s.tls = true;
  await s.open();
  return s;
}
rt.register({
  name: "javax/net/SocketFactory", ctor: JSocketFactory,
  methods: {
    "static getDefault()Ljavax/net/SocketFactory;": () => socketFactory,
    "createSocket()Ljava/net/Socket;": async () => newObj("java/net/Socket", null),
    "createSocket(Ljava/lang/String;I)Ljava/net/Socket;": (h: string, p: number) => dial("java/net/Socket", h, p),
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
        const s = new (rt.link("javax/net/ssl/SSLSocket").ctor)() as JSocket;
        s.host = host ?? plain?.host ?? ""; s.port = port || plain?.port || 443; s.tls = true;
        if (autoClose && plain) { plain.relay?.close(); plain.relay = null; plain.closed = 1; }
        return s;
      },
    "createSocket(Ljava/lang/String;I)Ljava/net/Socket;": (h: string, p: number) => dial("javax/net/ssl/SSLSocket", h, p),
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
rt.register({ name: "java/net/Authenticator$RequestorType", ctor: class extends JObj {} });

class JSSLContext extends JObj {}
let defaultSSLContext: JSSLContext | null = null;
rt.register({
  name: "javax/net/ssl/SSLContext", ctor: JSSLContext,
  methods: {
    "static getDefault()Ljavax/net/ssl/SSLContext;": () => defaultSSLContext ??= new JSSLContext(),
    "static setDefault(Ljavax/net/ssl/SSLContext;)V": (context: JSSLContext | null) => {
      if (!context) throw rt.mkThrowable("java/lang/NullPointerException", "context");
      defaultSSLContext = context;
    },
    "static getInstance(Ljava/lang/String;)Ljavax/net/ssl/SSLContext;": () => new JSSLContext(),
    "init([Ljavax/net/ssl/KeyManager;[Ljavax/net/ssl/TrustManager;Ljava/security/SecureRandom;)V": () => {},
    "getSocketFactory()Ljavax/net/ssl/SSLSocketFactory;": () => new (rt.link("javax/net/ssl/SSLSocketFactory").ctor)(),
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

// java.net addresses, and Socket over the relay above
class JInetAddress extends JObj { host = ""; }
rt.register({
  name: "java/net/InetAddress", ctor: JInetAddress,
  methods: {
    "static getByName(Ljava/lang/String;)Ljava/net/InetAddress;": (h: string) => { const a = new JInetAddress(); a.host = h ?? ""; return a; },
    "static getAllByName(Ljava/lang/String;)[Ljava/net/InetAddress;": (h: string) => {
      const a = new JInetAddress(); a.host = h ?? "";
      return jarray([a], "Ljava/net/InetAddress;");
    },
    "getHostName()Ljava/lang/String;": function (this: JInetAddress) { return this.host; },
    "getHostAddress()Ljava/lang/String;": function (this: JInetAddress) { return "0.0.0.0"; },
    "getAddress()[B": () => new Int8Array(4),
    "isLoopbackAddress()Z": function (this: JInetAddress) { return this.host === "localhost" || this.host.startsWith("127.") ? 1 : 0; },
    "isAnyLocalAddress()Z": function (this: JInetAddress) { return this.host === "0.0.0.0" ? 1 : 0; },
    "toString()Ljava/lang/String;": function (this: JInetAddress) { return this.host + "/0.0.0.0"; },
  },
});
// NetworkInterface: the browser exposes no interfaces, and the relay's address is the server's,
// not ours. One loopback interface is what a device with no permission to enumerate sees, and
// it keeps the callers that walk them (device-id fallbacks, MAC lookups) on their empty path.
class JNetworkInterface extends JObj { iname = "lo"; }
const loopback = () => { const a = new JInetAddress(); a.host = "localhost"; return a; };
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
rt.register({ name: "java/net/SocketAddress", ctor: class extends JObj {} });
class JInetSocketAddress extends JObj { host = ""; port = 0; addr: JInetAddress | null = null; }
rt.register({
  name: "java/net/InetSocketAddress", ctor: JInetSocketAddress, sup: "java/net/SocketAddress",
  methods: {
    "<init>(Ljava/lang/String;I)V": function (this: JInetSocketAddress, h: string, p2: number) { this.host = h ?? ""; this.port = p2; },
    "<init>(Ljava/net/InetAddress;I)V": function (this: JInetSocketAddress, a: JInetAddress, p2: number) { this.addr = a; this.host = a?.host ?? ""; this.port = p2; },
    "static createUnresolved(Ljava/lang/String;I)Ljava/net/InetSocketAddress;": (h: string, p2: number) => {
      const x = new JInetSocketAddress(); x.host = h ?? ""; x.port = p2; return x;
    },
    "getHostName()Ljava/lang/String;": function (this: JInetSocketAddress) { return this.host; },
    "getPort()I": function (this: JInetSocketAddress) { return this.port; },
    "getAddress()Ljava/net/InetAddress;": function (this: JInetSocketAddress) {
      if (!this.addr) { this.addr = new JInetAddress(); this.addr.host = this.host; }
      return this.addr;
    },
    "isUnresolved()Z": () => 0,
    "toString()Ljava/lang/String;": function (this: JInetSocketAddress) { return this.host + ":" + this.port; },
  },
});
class JSocket extends JObj {
  host = ""; port = 0; tls = false; relay: Relay | null = null; closed = 0; soTimeout = 0;
  /** Opening is deferred so an SSLSocket wrapping a plain one can take the target over and
   *  connect with TLS instead -- which is exactly how OkHttp builds an HTTPS connection. */
  async open(): Promise<void> {
    if (this.relay || this.closed) return;
    const r = new Relay(this.host, this.port, this.tls);
    try { await r.ready; } catch {
      r.close();
      throw rt.mkThrowable("java/net/ConnectException", `Failed to connect to ${this.host}:${this.port}`);
    }
    this.relay = r;
  }
}
class JSocketIn extends JObj { s!: JSocket; }
/** A read under SO_TIMEOUT waits only that long, then throws and leaves the stream usable —
 *  which is how a caller probes whether a pooled connection is still alive. */
async function socketRead(s: JSocket, out: Uint8Array, off: number, len: number): Promise<number> {
  const relay = s.relay;
  if (!relay) return -1;
  if (s.soTimeout && !await relay.waitReadable(s.soTimeout)) {
    throw rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out");
  }
  return relay.read(out, off, len);
}
class JSocketOut extends JObj { s!: JSocket; }

async function socketConnect(this: JSocket, a: JInetSocketAddress) {
  this.host = a?.host ?? ""; this.port = a?.port ?? 0;
  await this.open();
}
const socketMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;I)V": async function (this: JSocket, h: string, p: number) {
    this.host = h ?? ""; this.port = p; await this.open();
  },
  "connect(Ljava/net/SocketAddress;)V": socketConnect,
  "connect(Ljava/net/SocketAddress;I)V": socketConnect,
  "getInputStream()Ljava/io/InputStream;": maySuspend(function (this: JSocket) {
    const o = new (rt.link("webdroid/SocketInputStream").ctor)() as JSocketIn; o.s = this; return o;
  }),
  "getOutputStream()Ljava/io/OutputStream;": function (this: JSocket) {
    const o = new (rt.link("webdroid/SocketOutputStream").ctor)() as JSocketOut; o.s = this; return o;
  },
  "close()V": function (this: JSocket) { this.closed = 1; this.relay?.close(); this.relay = null; },
  "isClosed()Z": function (this: JSocket) { return this.closed; },
  "isConnected()Z": function (this: JSocket) { return this.relay ? 1 : 0; },
  "isInputShutdown()Z": function (this: JSocket) { return this.relay ? 0 : 1; },
  "isOutputShutdown()Z": function (this: JSocket) { return this.relay ? 0 : 1; },
  "shutdownInput()V": () => {},
  "shutdownOutput()V": () => {},
  "getPort()I": function (this: JSocket) { return this.port; },
  "getLocalPort()I": () => 0,
  "getInetAddress()Ljava/net/InetAddress;": function (this: JSocket) {
    const a = new JInetAddress(); a.host = this.host; return a;
  },
  "getRemoteSocketAddress()Ljava/net/SocketAddress;": function (this: JSocket) {
    const a = new JInetSocketAddress(); a.host = this.host; a.port = this.port; return a;
  },
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
    "read()I": async function (this: JSocketIn) {
      const b = new Uint8Array(1);
      const n = await socketRead(this.s, b, 0, 1);
      return n < 0 ? -1 : b[0];
    },
    "read([B)I": maySuspend(function (this: JSocketIn, out: Int8Array) {
      return socketRead(this.s, new Uint8Array(out.buffer, out.byteOffset, out.length), 0, out.length);
    }),
    "read([BII)I": maySuspend(function (this: JSocketIn, out: Int8Array, off: number, len: number) {
      return socketRead(this.s, new Uint8Array(out.buffer, out.byteOffset, out.length), off, len);
    }),
    "available()I": function (this: JSocketIn) { return this.s.relay?.available() ?? 0; },
    "close()V": function (this: JSocketIn) { this.s.relay?.close(); },
  },
});
rt.register({
  name: "webdroid/SocketOutputStream", ctor: JSocketOut, sup: "java/io/OutputStream",
  methods: {
    "<init>()V": function () {},
    "write(I)V": function (this: JSocketOut, b: number) { this.s.relay?.write(new Uint8Array([b & 0xff])); },
    "write([B)V": function (this: JSocketOut, b: Int8Array) {
      this.s.relay?.write(new Uint8Array(b.buffer, b.byteOffset, b.length));
    },
    "write([BII)V": function (this: JSocketOut, b: Int8Array, off: number, len: number) {
      this.s.relay?.write(new Uint8Array(b.buffer, b.byteOffset + off, len));
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
    "startHandshake()V": async function (this: JSSLSocket) { await this.open(); },
    "getSession()Ljavax/net/ssl/SSLSession;": function (this: JSSLSocket) {
      const s = new (rt.link("webdroid/SSLSessionImpl").ctor)() as JSSLSession;
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
    "getSSLParameters()Ljavax/net/ssl/SSLParameters;": () => new (rt.link("javax/net/ssl/SSLParameters").ctor)(),
    "setSSLParameters(Ljavax/net/ssl/SSLParameters;)V": () => {},
    // The relay opens TLS without ALPN, so the server answers as HTTP/1.1. Saying so is
    // load-bearing: a client told "h2" would send an HTTP/2 preface down an HTTP/1.1 connection.
    "getApplicationProtocol()Ljava/lang/String;": () => "http/1.1",
    "getHandshakeApplicationProtocol()Ljava/lang/String;": () => "http/1.1",
  },
});
class JSSLParameters extends JObj { protocols: string[] = []; }
rt.register({
  name: "javax/net/ssl/SSLParameters", ctor: JSSLParameters,
  methods: {
    "<init>()V": function () {},
    "setApplicationProtocols([Ljava/lang/String;)V": function (this: JSSLParameters, v: string[]) { this.protocols = [...(v ?? [])]; },
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
// OkHttp's Android platform asks these before configuring ALPN/session tickets on a socket.
// Our sockets are relay-backed, so there is nothing to configure -- but the answer has to be
// "yes, that is one of ours", or it falls back to a reflection path that is not there either.
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
      const c = new (rt.link("java/security/cert/X509Certificate").ctor)() as JX509;
      c.host = this.host;
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

class JURI extends JObj { u = ""; }
// URLEncoder/URLDecoder: application/x-www-form-urlencoded, which is encodeURIComponent plus
// "+" for a space and the extra unreserved set Java leaves alone.
const formEncode = (s: string) =>
  encodeURIComponent(s ?? "").replace(/[!'()~*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, "+");
rt.register({
  name: "java/net/URLEncoder", ctor: class extends JObj {},
  methods: {
    "static encode(Ljava/lang/String;)Ljava/lang/String;": (s: string) => formEncode(s),
    "static encode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (s: string) => formEncode(s),
  },
});
rt.register({
  name: "java/net/URLDecoder", ctor: class extends JObj {},
  methods: {
    "static decode(Ljava/lang/String;)Ljava/lang/String;": (s: string) => decodeURIComponent((s ?? "").replace(/\+/g, " ")),
    "static decode(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": (s: string) => decodeURIComponent((s ?? "").replace(/\+/g, " ")),
  },
});
rt.register({
  name: "java/net/URI", ctor: JURI, ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JURI, s: string) { this.u = s ?? ""; },
    // (scheme, userInfo, host, port, path, query, fragment): how a URL is rebuilt from parts
    "<init>(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V":
      function (this: JURI, sch: string | null, ui: string | null, host: string | null, port: number, path: string | null, q: string | null, f: string | null) {
        this.u = (sch ? sch + ":" : "") + (host ? "//" + (ui ? ui + "@" : "") + host + (port === -1 ? "" : ":" + port) : "") +
          (path ?? "") + (q ? "?" + q : "") + (f ? "#" + f : "");
      },
    "static create(Ljava/lang/String;)Ljava/net/URI;": (s: string) => { const r = new JURI(); r.u = s ?? ""; return r; },
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
      const r = new JURI(); r.u = (m[1] ?? "") + (m[2] ?? "") + out.join("/") + m[4]; return r;
    },
    "toASCIIString()Ljava/lang/String;": function (this: JURI) { return this.u; },
    "getScheme()Ljava/lang/String;": function (this: JURI) { const i = this.u.indexOf(":"); return i > 0 ? this.u.slice(0, i) : null; },
    "getHost()Ljava/lang/String;": function (this: JURI) { try { return new URL(this.u).hostname; } catch { return null; } },
    "getPath()Ljava/lang/String;": function (this: JURI) { try { return new URL(this.u).pathname; } catch { return this.u.replace(/^[a-z]+:/i, ""); } },
    "toURL()Ljava/net/URL;": function (this: JURI) { const u = new JURL(); urlInit(u, this.u); return u; },
    "getUserInfo()Ljava/lang/String;": function (this: JURI) { const m = /^[^:/?#]+:\/\/([^@/?#]*)@/.exec(this.u); return m ? decodeURIComponent(m[1]) : null; },
    "getPort()I": function (this: JURI) { try { return Number(new URL(this.u).port) || -1; } catch { return -1; } },
    "getQuery()Ljava/lang/String;": function (this: JURI) { try { const q = new URL(this.u).search; return q ? q.slice(1) : null; } catch { return null; } },
    "getFragment()Ljava/lang/String;": function (this: JURI) { const i = this.u.indexOf("#"); return i < 0 ? null : this.u.slice(i + 1); },
    "getRawPath()Ljava/lang/String;": function (this: JURI) { try { return new URL(this.u).pathname; } catch { return null; } },
    "getSchemeSpecificPart()Ljava/lang/String;": function (this: JURI) { const i = this.u.indexOf(":"); return i < 0 ? this.u : this.u.slice(i + 1); },
    "resolve(Ljava/lang/String;)Ljava/net/URI;": function (this: JURI, o: string) { const r = new JURI(); try { r.u = new URL(o, this.u).href; } catch { r.u = o; } return r; },
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
defineException("java/net/URISyntaxException", "java/lang/Exception");

const SCHEMES = /^(https?|ftp|file|jar):$/;       // what Android's URL has a handler for
const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443, "ftp:": 21 };
const userInfo = (u: URL) => u.username ? u.username + (u.password ? ":" + u.password : "") : null;
const noRef = (u: URL) => u.href.slice(0, u.href.length - u.hash.length);

class JURL extends JObj {
  spec = ""; u!: URL;
  open(): JURLConnection {
    const https = this.u.protocol === "https:";
    if (this.u.protocol === "jar:") { const c = new (rt.link("java/net/JarURLConnection").ctor)() as JURLConnection; c.url = this; return c; }
    if (!https && this.u.protocol !== "http:") throw rt.unimplemented("URL.openConnection " + this.u.protocol);
    const c = new (rt.link(https ? "javax/net/ssl/HttpsURLConnection" : "java/net/HttpURLConnection").ctor)() as JURLConnection;
    c.url = this;
    return c;
  }
}
/** Java keeps the spec string it was given (toString round-trips); only a resolved URL is re-serialised */
function urlInit(r: JURL, spec: string | null, base?: URL): JURL {
  const s = String(spec);
  try { r.u = new URL(s, base); } catch {
    throw rt.mkThrowable("java/net/MalformedURLException", /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : "no protocol: " + s);
  }
  if (!SCHEMES.test(r.u.protocol)) throw rt.mkThrowable("java/net/MalformedURLException", "unknown protocol: " + r.u.protocol.slice(0, -1));
  r.spec = base ? r.u.href : s;
  return r;
}
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
    "getHost()Ljava/lang/String;": function (this: JURL) { return this.u.hostname; },
    "getPort()I": function (this: JURL) { return this.u.port ? Number(this.u.port) : -1; },
    "getDefaultPort()I": function (this: JURL) { return DEFAULT_PORT[this.u.protocol] ?? -1; },
    "getPath()Ljava/lang/String;": function (this: JURL) { return this.u.pathname; },
    "getQuery()Ljava/lang/String;": function (this: JURL) { return this.u.search ? this.u.search.slice(1) : null; },
    "getFile()Ljava/lang/String;": function (this: JURL) { return this.u.pathname + this.u.search; },
    "getRef()Ljava/lang/String;": function (this: JURL) { return this.u.hash ? this.u.hash.slice(1) : null; },
    "getUserInfo()Ljava/lang/String;": function (this: JURL) { return userInfo(this.u); },
    "getAuthority()Ljava/lang/String;": function (this: JURL) { const ui = userInfo(this.u); return (ui ? ui + "@" : "") + this.u.host; },
    "toExternalForm()Ljava/lang/String;": function (this: JURL) { return this.spec; },
    "toString()Ljava/lang/String;": function (this: JURL) { return this.spec; },
    "toURI()Ljava/net/URI;": maySuspend(function (this: JURL) { return newObj("java/net/URI", "(Ljava/lang/String;)V", this.spec); }),
    "equals(Ljava/lang/Object;)Z": function (this: JURL, o: unknown) { return o instanceof JURL && o.u.href === this.u.href ? 1 : 0; },
    "sameFile(Ljava/net/URL;)Z": function (this: JURL, o: JURL | null) { return o && noRef(o.u) === noRef(this.u) ? 1 : 0; },
    // over the normalised form, not the spec, so equal URLs hash alike as Object requires
    "hashCode()I": function (this: JURL) { return stringHash(this.u.href); },
    "openConnection()Ljava/net/URLConnection;": function (this: JURL) { return this.open(); },
    "openConnection(Ljava/net/Proxy;)Ljava/net/URLConnection;": function (this: JURL) { return this.open(); },
    "openStream()Ljava/io/InputStream;": async function (this: JURL) {
      if (this.u.protocol === "jar:") {
        const split = this.spec.indexOf("!/");
        if (split < 0) throw rt.mkThrowable("java/io/IOException", this.spec);
        const archive = new URL(this.spec.slice(4, split));
        if (archive.protocol !== "file:") throw rt.mkThrowable("java/io/IOException", this.spec);
        const zip = await newObj("java/util/zip/ZipFile", "(Ljava/lang/String;)V", decodeURIComponent(archive.pathname));
        const entry = await vcall(zip, "getEntry", "(Ljava/lang/String;)Ljava/util/zip/ZipEntry;", decodeURIComponent(this.spec.slice(split + 2)));
        if (!entry) throw rt.mkThrowable("java/io/FileNotFoundException", this.spec);
        return vcall(zip, "getInputStream", "(Ljava/util/zip/ZipEntry;)Ljava/io/InputStream;", entry);
      }
      if (this.u.protocol === "file:") {
        const bytes = await vfs.readFile(decodeURIComponent(this.u.pathname));
        if (!bytes) throw rt.mkThrowable("java/io/FileNotFoundException", this.spec);
        return newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
      }
      return vcall(this.open(), "getInputStream", "()Ljava/io/InputStream;");
    },
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

type HttpRes = { status: number; msg: string; hdrs: [string, string][]; body: Uint8Array };
const statusLine = (r: HttpRes) => "HTTP/1.1 " + r.status + (r.msg ? " " + r.msg : "");
const PUT = "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;";
/** Map<String, List<String>> as URLConnection and CookieHandler hand headers out (a null key is legal: the status line) */
async function headerMap(groups: Iterable<[string | null, string[]]>) {
  const m = new (rt.link("java/util/HashMap").ctor)();
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
  cto = 0; rto = 0; ifMod = 0n;
  req: [string, string][] = [];
  out: JOutputStream | null = null;
  inStream: JInputStream | null = null;
  ac: AbortController | null = null;
  res: HttpRes | null = null;
  /** The one fetch. Everything that needs the response funnels through here, which is what makes
   *  the connection lazy the way AOSP's is. The whole body is awaited: the VM can suspend, a
   *  Java read() cannot fail half-way, and the proxy has already removed the framing. */
  async connect(): Promise<HttpRes> {
    if (this.res) return this.res;
    const ac = (this.ac = new AbortController());
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = "";
    // fetch resolves once the head is in, so the connect timeout runs until then and the read timeout after
    const arm = (ms: number, what: string) => {
      clearTimeout(timer);
      if (ms > 0) timer = setTimeout(() => { timedOut = what; ac.abort(); }, ms);
    };
    const headers = new Headers();
    for (const [k, v] of this.req) headers.append("x-wd-" + k, v);
    if (this.ifMod) headers.set("x-wd-if-modified-since", new Date(Number(this.ifMod)).toUTCString());
    const hasBody = this.out && this.method !== "GET" && this.method !== "HEAD";
    let r: Response, body: Uint8Array;
    arm(this.cto, "connect timed out");
    try {
      r = await fetch("/proxy?url=" + encodeURIComponent(this.url.spec), {
        method: this.method, headers, signal: ac.signal, body: hasBody ? new Uint8Array(this.out!.chunks) : undefined,
      });
      arm(this.rto, "Read timed out");
      body = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (timedOut) throw rt.mkThrowable("java/net/SocketTimeoutException", timedOut);
      if (ac.signal.aborted) throw rt.mkThrowable("java/net/SocketException", "Socket closed");
      throw rt.mkThrowable("java/io/IOException", String(e));
    } finally { clearTimeout(timer); this.ac = null; }
    const final = r.headers.get("x-wd-final-url");
    // the proxy's own failure answer carries no final URL; a genuine upstream 502 does
    if (r.status === 502 && !final) throw rt.mkThrowable("java/net/UnknownHostException", utf8.dec.decode(body));
    if (final && final !== this.url.u.href) this.url = mkURL(final);   // getURL() reports where a redirect landed
    const hdrs: [string, string][] = [];
    r.headers.forEach((v, k) => { if (k !== "x-wd-final-url") hdrs.push([k === "x-wd-content-encoding" ? "content-encoding" : k, v]); });
    return (this.res = { status: r.status, msg: r.statusText, hdrs, body });
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
  stream(): JInputStream {
    if (!this.inStream) {
      this.inStream = new (rt.link("java/io/ByteArrayInputStream").ctor)() as JInputStream;
      this.inStream.buf = this.res!.body;
    }
    return this.inStream;
  }
}
/** an accessor that needs the response: connect first */
function withRes<A extends unknown[]>(f: (this: JURLConnection, r: HttpRes, ...a: A) => unknown) {
  return async function (this: JURLConnection, ...a: A) { return f.call(this, await this.connect(), ...a); };
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
  methods: {
    "<init>(Ljava/net/URL;)V": function (this: JURLConnection, u: JURL) { this.url = u; },
    "connect()V": async function (this: JURLConnection) { await this.connect(); },
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
      if (this.method === "GET") this.method = "POST";   // a GET that writes a body becomes a POST (OpenJDK and AOSP alike)
      return this.out ??= new (rt.link("java/io/OutputStream").ctor)() as JOutputStream;
    },
    "setRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JURLConnection, k: string | null, v: string) {
      if (k === null) throw rt.mkThrowable("java/lang/NullPointerException", "key is null");
      this.req = this.req.filter(([n]) => n.toLowerCase() !== k.toLowerCase());
      this.req.push([k, v]);
    },
    "addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JURLConnection, k: string | null, v: string) {
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
    "setAllowUserInteraction(Z)V": () => {},
    "setConnectTimeout(I)V": function (this: JURLConnection, ms: number) { this.cto = ms; },
    "getConnectTimeout()I": function (this: JURLConnection) { return this.cto; },
    "setReadTimeout(I)V": function (this: JURLConnection, ms: number) { this.rto = ms; },
    "getReadTimeout()I": function (this: JURLConnection) { return this.rto; },
    "setIfModifiedSince(J)V": function (this: JURLConnection, t: bigint) { this.ifMod = t; },
    "getIfModifiedSince()J": function (this: JURLConnection) { return this.ifMod; },
    "getHeaderField(Ljava/lang/String;)Ljava/lang/String;": withRes(function (_r, k: string | null) { return this.hdr(k); }),
    // index 0 is the status line under a null key; past the end both are null, which is how a caller finds the end
    "getHeaderField(I)Ljava/lang/String;": withRes((r, i: number) => i === 0 ? statusLine(r) : r.hdrs[i - 1]?.[1] ?? null),
    "getHeaderFieldKey(I)Ljava/lang/String;": withRes((r, i: number) => r.hdrs[i - 1]?.[0] ?? null),
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
    // the proxy strips content-length; the byte count is exact once the body is in hand, and HEAD has none to count
    "getContentLength()I": withRes(function (r) { return this.method === "HEAD" ? -1 : r.body.length; }),
    "getContentLengthLong()J": withRes(function (r) { return BigInt(this.method === "HEAD" ? -1 : r.body.length); }),
    "toString()Ljava/lang/String;": function (this: JURLConnection) {
      return dotName((this.constructor as typeof JObj).$i.name) + ":" + this.url.spec;
    },
  },
});
const HTTP_METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "PATCH"]);
class JHttpURLConnection extends JURLConnection {}
rt.register({
  name: "java/net/HttpURLConnection", ctor: JHttpURLConnection, sup: "java/net/URLConnection",
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
      if (this.res || this.ac) throw rt.mkThrowable("java/net/ProtocolException", "Can't reset method: already connected");
      if (!HTTP_METHODS.has(m)) throw rt.mkThrowable("java/net/ProtocolException", "Invalid HTTP method: " + m);
      this.method = m;
    },
    "getRequestMethod()Ljava/lang/String;": function (this: JHttpURLConnection) { return this.method; },
    "setInstanceFollowRedirects(Z)V": function (this: JHttpURLConnection, b: number) { this.follow = b; },
    "getInstanceFollowRedirects()Z": function (this: JHttpURLConnection) { return this.follow; },
    "static setFollowRedirects(Z)V": (b: number) => { followRedirects = b; },
    "static getFollowRedirects()Z": () => followRedirects,
    "setChunkedStreamingMode(I)V": () => {},
    "setFixedLengthStreamingMode(I)V": () => {},
    "setFixedLengthStreamingMode(J)V": () => {},
    "getResponseCode()I": withRes((r) => r.status),
    "getResponseMessage()Ljava/lang/String;": withRes((r) => r.msg || null),
    "getErrorStream()Ljava/io/InputStream;": async function (this: JHttpURLConnection) {
      // AOSP connects here too, and answers null for any failure rather than throwing
      try { return (await this.connect()).status >= 400 ? this.stream() : null; } catch { return null; }
    },
    // a response already in hand stays readable, as it does on AOSP; only an in-flight fetch is cut
    "disconnect()V": function (this: JHttpURLConnection) { this.ac?.abort(); },
    "usingProxy()Z": () => 0,
  },
});
// TLS ends at the proxy: there is no socket for a factory or verifier to attach to
rt.register({
  name: "javax/net/ssl/HttpsURLConnection", ctor: class extends JHttpURLConnection {}, sup: "java/net/HttpURLConnection",
  methods: {
    "setHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V": () => {},
    "setSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V": () => {},
    "static setDefaultHostnameVerifier(Ljavax/net/ssl/HostnameVerifier;)V": () => {},
    "static setDefaultSSLSocketFactory(Ljavax/net/ssl/SSLSocketFactory;)V": () => {},
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
rt.register({ name: "java/net/CookieStore", ctor: class extends JObj {} });
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
    "put(Ljava/net/URI;Ljava/util/Map;)V": async function (this: JCookieManager, uri: JURI | null, hdrs: unknown) {
      if (this.policy === acceptNone || !hdrs) return;
      const host = hostOf(uri);
      for (const e of await toJsArray(await vcall(hdrs, "entrySet", "()Ljava/util/Set;"))) {
        const k = await vcall(e, "getKey", "()Ljava/lang/Object;") as string | null;
        if (!k || !/^set-cookie2?$/i.test(k)) continue;
        for (const v of await toJsArray(await vcall(e, "getValue", "()Ljava/lang/Object;")) as string[]) {
          const m = /^\s*([^=;\s]+)=([^;]*)/.exec(v);
          if (!m) continue;
          let c = this.store.jar.get(host);
          if (!c) this.store.jar.set(host, c = new Map());
          c.set(m[1], m[2].trim());
        }
      }
    },
  },
});
