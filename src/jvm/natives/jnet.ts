// java.net / javax.net.ssl / java.nio.channels, over a real TCP connection borrowed from the
// dev server.
//
// A page cannot open a socket, so one WebSocket carries one TCP connection (server.ts's /tcp
// route) and TLS is terminated at the relay -- the page has no certificate store and could not
// handshake. That has one visible consequence: the certificate an app inspects is ours, not the
// peer's. It carries the requested host as its only SAN, which is exactly what a hostname
// verifier needs and nothing more, so an app that PINS a certificate will correctly fail rather
// than be told a comforting lie.
import { rt, JObj, type NativeSpec } from "../runtime";
import { newArrayList, mkIter } from "./jutil";
import { boxInt, stringHash, mkEnumSet, newObj } from "./jlang";
import { jarray } from "../abi";

const relayUrl = (host: string, port: number, tls: boolean) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}` +
  `/tcp?host=${encodeURIComponent(host)}&port=${port}${tls ? "&tls=1" : ""}`;

/**
 * One WebSocket, one TCP connection. Reads suspend until bytes arrive, which is legal here
 * because every compiled method can suspend -- that is the whole reason a blocking
 * InputStream.read() works in this VM at all.
 */
class Relay {
  private ws: WebSocket;
  private q: Uint8Array[] = [];
  private qLen = 0;
  eof = false;
  private wake: (() => void) | null = null;
  readonly ready: Promise<void>;

  constructor(host: string, port: number, tls: boolean) {
    const ws = (this.ws = new WebSocket(relayUrl(host, port, tls)));
    ws.binaryType = "arraybuffer";
    const done = () => { this.eof = true; const w = this.wake; this.wake = null; w?.(); };
    this.ready = new Promise<void>((res, rej) => {
      ws.onmessage = (e) => {
        if (typeof e.data === "string") { res(); return; }   // the relay's "connected" marker
        const b = new Uint8Array(e.data as ArrayBuffer);
        this.q.push(b); this.qLen += b.length;
        const w = this.wake; this.wake = null; w?.();
      };
      ws.onclose = () => { done(); rej(new Error("connect failed")); };
      ws.onerror = () => { done(); rej(new Error("connect failed")); };
    });
    // once connected, a close is end-of-stream rather than a failed connect
    this.ready.then(() => { ws.onclose = done; ws.onerror = done; }, () => { /* open() reports it */ });
  }
  available(): number { return this.qLen; }
  async read(out: Uint8Array, off: number, len: number): Promise<number> {
    while (this.qLen === 0 && !this.eof) await new Promise<void>((r) => (this.wake = r));
    if (this.qLen === 0) return -1;
    let n = 0;
    while (n < len && this.q.length) {
      const c = this.q[0];
      const take = Math.min(len - n, c.length);
      out.set(c.subarray(0, take), off + n);
      n += take; this.qLen -= take;
      if (take === c.length) this.q.shift(); else this.q[0] = c.subarray(take);
    }
    return n;
  }
  write(b: Uint8Array): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(b); }
  close(): void { try { this.ws.close(); } catch { /* already gone */ } this.eof = true; }
}

for (const marker of [
  "javax/net/ssl/HostnameVerifier", "javax/net/ssl/X509TrustManager", "javax/net/ssl/TrustManager",
  "javax/net/ssl/KeyManager", "javax/net/ssl/SSLSession",
  "java/nio/channels/ReadableByteChannel", "java/nio/channels/WritableByteChannel", "java/nio/channels/ByteChannel",
  "java/nio/channels/Channel",
  "java/net/CookieHandler", "java/net/ResponseCache",
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
    "createSocket()Ljava/net/Socket;": () => newObj("java/net/Socket", null),
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

class JTMF extends JObj {}
rt.register({
  name: "javax/net/ssl/TrustManagerFactory", ctor: JTMF,
  methods: {
    "static getDefaultAlgorithm()Ljava/lang/String;": () => "PKIX",
    "static getInstance(Ljava/lang/String;)Ljavax/net/ssl/TrustManagerFactory;": () => new JTMF(),
    "init(Ljava/security/KeyStore;)V": () => {},
    "getTrustManagers()[Ljavax/net/ssl/TrustManager;": () => jarray([new (rt.link("webdroid/X509TM").ctor)()], "Ljavax/net/ssl/TrustManager;"),
  },
});
rt.register({
  name: "webdroid/X509TM", ctor: class extends JObj {}, ifaces: ["javax/net/ssl/X509TrustManager", "javax/net/ssl/TrustManager"],
  methods: {
    "checkClientTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V": () => {},
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V": () => {},
    "getAcceptedIssuers()[Ljava/security/cert/X509Certificate;": () => jarray([], "Ljava/security/cert/X509Certificate;"),
  },
});
rt.register({
  name: "java/security/KeyStore", ctor: class extends JObj {},
  methods: {
    "static getDefaultType()Ljava/lang/String;": () => "AndroidKeyStore",
    "static getInstance(Ljava/lang/String;)Ljava/security/KeyStore;": () => new (rt.link("java/security/KeyStore").ctor)(),
    "load(Ljava/io/InputStream;[C)V": () => {},
    "load(Ljava/security/KeyStore$LoadStoreParameter;)V": () => {},
    "aliases()Ljava/util/Enumeration;": () => mkIter([]),
  },
});
class JSSLContext extends JObj {}
rt.register({
  name: "javax/net/ssl/SSLContext", ctor: JSSLContext,
  methods: {
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
    "toString()Ljava/lang/String;": function (this: JInetAddress) { return this.host + "/0.0.0.0"; },
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
  host = ""; port = 0; tls = false; relay: Relay | null = null; closed = 0;
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
  "getInputStream()Ljava/io/InputStream;": function (this: JSocket) {
    const o = new (rt.link("webdroid/SocketInputStream").ctor)() as JSocketIn; o.s = this; return o;
  },
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
  "setTcpNoDelay(Z)V": () => {}, "setSoTimeout(I)V": () => {}, "setKeepAlive(Z)V": () => {},
  "setReuseAddress(Z)V": () => {}, "setSoLinger(ZI)V": () => {},
  "setSendBufferSize(I)V": () => {}, "setReceiveBufferSize(I)V": () => {},
  "getSoTimeout()I": () => 0,
};
rt.register({ name: "java/net/Socket", ctor: JSocket, ifaces: ["java/io/Closeable"], methods: socketMethods });

rt.register({
  name: "webdroid/SocketInputStream", ctor: JSocketIn, sup: "java/io/InputStream",
  methods: {
    "<init>()V": function () {},
    "read()I": async function (this: JSocketIn) {
      const b = new Uint8Array(1);
      const n = await (this.s.relay?.read(b, 0, 1) ?? -1);
      return n < 0 ? -1 : b[0];
    },
    "read([B)I": function (this: JSocketIn, out: Int8Array) {
      return this.s.relay?.read(new Uint8Array(out.buffer, out.byteOffset, out.length), 0, out.length) ?? -1;
    },
    "read([BII)I": function (this: JSocketIn, out: Int8Array, off: number, len: number) {
      return this.s.relay?.read(new Uint8Array(out.buffer, out.byteOffset, out.length), off, len) ?? -1;
    },
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
const strArray = (v: string[]) => jarray([...v], "Ljava/lang/String;");

/**
 * The certificate an app sees for a relay-terminated connection. It is ours, and it says so:
 * the only thing it asserts is the host that was asked for, as a dNSName SAN, which is all a
 * hostname verifier reads. Anything that wants to check a signature or a pin gets nothing to
 * check and fails, which is the honest outcome.
 */
class JX509 extends JObj { host = ""; }
rt.register({
  name: "java/security/cert/Certificate", ctor: class extends JObj {},
  methods: { "getType()Ljava/lang/String;": () => "X.509" },
});
rt.register({
  name: "java/security/cert/X509Certificate", ctor: JX509, sup: "java/security/cert/Certificate",
  methods: {
    "getSubjectAlternativeNames()Ljava/util/Collection;": function (this: JX509) {
      const entry = newArrayList();
      // Collection<List<?>> whose first element is an INTEGER, not an int: Kotlin's
      // Intrinsics.areEqual calls .equals() on it, and a raw JS number has no such method.
      entry.a = [boxInt(2), this.host];         // GeneralName type 2 = dNSName
      const all = newArrayList();
      all.a = [entry];
      return all;
    },
    "getSubjectDN()Ljava/security/Principal;": function (this: JX509) { return mkPrincipal("CN=" + this.host); },
    "getIssuerDN()Ljava/security/Principal;": () => mkPrincipal("CN=webdroid relay"),
    "getSubjectX500Principal()Ljavax/security/auth/x500/X500Principal;": function (this: JX509) { return mkPrincipal("CN=" + this.host); },
    "getEncoded()[B": () => new Int8Array(0),
    "getPublicKey()Ljava/security/PublicKey;": () => null,
    "getSerialNumber()Ljava/math/BigInteger;": () => null,
    "checkValidity()V": () => {},
    "checkValidity(Ljava/util/Date;)V": () => {},
    "getType()Ljava/lang/String;": () => "X.509",
    "toString()Ljava/lang/String;": function (this: JX509) { return "CN=" + this.host + " (webdroid relay)"; },
  },
});
class JPrincipal extends JObj { name = ""; }
function mkPrincipal(name: string): JPrincipal { const p = new (rt.link("javax/security/auth/x500/X500Principal").ctor)() as JPrincipal; p.name = name; return p; }
rt.register({ name: "java/security/Principal", ctor: class extends JObj {} });
rt.register({
  name: "javax/security/auth/x500/X500Principal", ctor: JPrincipal, ifaces: ["java/security/Principal"],
  methods: {
    "getName()Ljava/lang/String;": function (this: JPrincipal) { return this.name; },
    "toString()Ljava/lang/String;": function (this: JPrincipal) { return this.name; },
  },
});

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
rt.register({
  name: "java/net/URI", ctor: JURI, ifaces: ["java/lang/Comparable", "java/io/Serializable"],
  methods: {
    "<init>(Ljava/lang/String;)V": function (this: JURI, s: string) { this.u = s ?? ""; },
    "static create(Ljava/lang/String;)Ljava/net/URI;": (s: string) => { const r = new JURI(); r.u = s ?? ""; return r; },
    "toString()Ljava/lang/String;": function (this: JURI) { return this.u; },
    "toASCIIString()Ljava/lang/String;": function (this: JURI) { return this.u; },
    "getScheme()Ljava/lang/String;": function (this: JURI) { const i = this.u.indexOf(":"); return i > 0 ? this.u.slice(0, i) : null; },
    "getHost()Ljava/lang/String;": function (this: JURI) { try { return new URL(this.u).hostname; } catch { return null; } },
    "getPath()Ljava/lang/String;": function (this: JURI) { try { return new URL(this.u).pathname; } catch { return this.u.replace(/^[a-z]+:/i, ""); } },
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
