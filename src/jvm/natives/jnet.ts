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
import { newArrayList, toJsArray } from "./jutil";
import { newObj, vcall, scall, after, defineException, sysProps, checkFromIndexSize } from "./jlang";
import { JX509, mkPrincipal } from "./jx509";
import { jarray, strArray, dotName, u8, mangleMethod } from "../abi";
import { baosBytes } from "./jio";
import { Relay } from "../../shell/relay";

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
    "createSocket(Ljava/net/InetAddress;I)Ljava/net/Socket;": (address: JObj | null, port: number) => after(hostAddress(address), (h) => dial("java/net/Socket", h, port)),
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
    "createSocket(Ljava/net/InetAddress;I)Ljava/net/Socket;": (address: JObj | null, port: number) => after(hostAddress(address), (h) => dial("javax/net/ssl/SSLSocket", h, port)),
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

// Addresses are libcore's: a name's address is the synthetic one the resolver hands out, which
// dials the name again (relay.ts dialName).
const byName = (host: string) => scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", host);
const hostAddress = (a: JObj | null): string | Promise<string> => a === null ? "localhost" : vcall(a, "getHostAddress", "()Ljava/lang/String;");
const socketPort = (a: JObj | null): number | Promise<number> => a === null ? 0 : vcall(a, "getPort", "()I");

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

async function socketConnect(this: JSocket, a: JObj | null) {
  this.host = a === null ? "" : await vcall(a, "getHostString", "()Ljava/lang/String;"); this.port = await socketPort(a);
  await this.open();
}
const socketMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;I)V": driven(function* (this: JSocket, h: string, p: number): Gen {
    this.host = h ?? ""; this.port = p; yield this.open();
  }),
  "connect(Ljava/net/SocketAddress;)V": function (this: JSocket, a: unknown) { return vcall(this, "connect", "(Ljava/net/SocketAddress;I)V", a, 0); },
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
    const local = this.activeRelay()?.localEndpoint; return local ? newObj("java/net/InetSocketAddress", "(Ljava/lang/String;I)V", local.address, local.port) : null;
  },
  "getInetAddress()Ljava/net/InetAddress;": function (this: JSocket) { return byName(this.host); },
  // the connection-state checks around these are left out: opening is deferred (see JSocket.open)
  "getRemoteSocketAddress()Ljava/net/SocketAddress;": driven(function* (this: JSocket): Gen {
    const addr: JObj | null = yield vcall(this, "getInetAddress", "()Ljava/net/InetAddress;");
    const port: number = yield vcall(this, "getPort", "()I");
    return addr === null ? null : newObj("java/net/InetSocketAddress", "(Ljava/net/InetAddress;I)V", addr, port);
  }),
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

// ── java.net.URL and HttpURLConnection, over the dev server's /proxy route: a page cannot speak
// raw HTTP to another origin. The proxy forwards `x-wd-*` request headers with the prefix
// stripped and, with manual=1, hands a redirect back with its status in x-wd-status.
// the abstract socket implementation an app may subclass to reach a socket's descriptor
rt.register({ name: "java/net/SocketImpl", ctor: class extends JObj { fd: unknown = null; }, fields: { fd: "fd" }, methods: { "<init>()V": function () {} } });
defineException("java/net/ProtocolException", "java/io/IOException");
defineException("javax/net/ssl/SSLException", "java/io/IOException");
defineException("javax/net/ssl/SSLHandshakeException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLPeerUnverifiedException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLProtocolException", "javax/net/ssl/SSLException");
defineException("javax/net/ssl/SSLKeyException", "javax/net/ssl/SSLException");
/** a URL's external form, through its Java API */
const urlText = (url: unknown) => vcall(url, "toExternalForm", "()Ljava/lang/String;") as string | Promise<string>;
// URL.createBuiltinHandler instantiates these by name for http and https, as OkHttp's are on a
// device; their connections are the fetch-backed ones below.
class JHttpHandler extends JObj {}
const openHttp = (cls: string) => function (url: unknown, proxy?: unknown) {
  if (url === null || proxy === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "url == null || proxy == null");
  const c = rt.make(cls) as JURLConnection;
  c.url = url;
  if (c instanceof JHttpsURLConnection) { c.sslFactory = defaultHttpsFactory; c.hostnameVerifier = defaultHostnameVerifier; }
  return c;
};
const handlerMethods = (cls: string, port: number) => ({
  "<init>()V": function () {},
  "getDefaultPort()I": () => port,
  "openConnection(Ljava/net/URL;)Ljava/net/URLConnection;": openHttp(cls),
  "openConnection(Ljava/net/URL;Ljava/net/Proxy;)Ljava/net/URLConnection;": openHttp(cls),
});
rt.register({ name: "com/android/okhttp/HttpHandler", ctor: JHttpHandler, sup: "java/net/URLStreamHandler", methods: handlerMethods("java/net/HttpURLConnection", 80) });
rt.register({ name: "com/android/okhttp/HttpsHandler", ctor: class extends JHttpHandler {}, sup: "com/android/okhttp/HttpHandler", methods: handlerMethods("javax/net/ssl/HttpsURLConnection", 443) });
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
    checkFromIndexSize(offset, count, out.length);
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
/** the URI a CookieHandler sees, escaped as OkHttp's HttpUrl.uri() does: WHATWG leaves characters
 *  in the path, query and fragment that java.net.URI rejects */
function cookieURI(target: string): Promise<unknown> {
  const u = new URL(target), tail = u.pathname + u.search + u.hash;
  const text = u.href.slice(0, u.href.length - tail.length) + tail.replace(/[[\]{}|\\^`"<> ]|%(?![\dA-Fa-f]{2})/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return newObj("java/net/URI", "(Ljava/lang/String;)V", text);
}
let followRedirects = 1, defaultUseCaches = 1;
class JURLConnection extends JObj {
  url: unknown = null;
  method = "GET"; follow = followRedirects; doOut = 0; doIn = 1; useCaches = defaultUseCaches;
  allowUserInteraction = 0;
  /** the protected field a subclass implementing its own transport maintains; ours reads res */
  connected = 0;
  cto = 0; rto = 0; ifMod = 0n;
  req: [string, string][] = [];
  out: JObj | null = null;
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
    const base = new Headers();
    for (const [k, v] of this.req) base.append("x-wd-" + k, v);
    // Android's engine adds http.agent to requests that set no User-Agent
    if (!base.has("x-wd-user-agent") && sysProps["http.agent"]) base.set("x-wd-user-agent", sysProps["http.agent"]);
    if (this.ifMod) base.set("x-wd-if-modified-since", new Date(Number(this.ifMod)).toUTCString());
    const spec = await urlText(this.url);
    // OkHttp's HttpUrl.getChecked
    if (!await vcall(this.url, "getHost", "()Ljava/lang/String;")) throw rt.mkThrowable("java/net/UnknownHostException", "Invalid host: " + spec);
    let method = this.method, target = spec, r: Response, hdrs: [string, string][], length: string | null;
    let body = this.out && method !== "GET" && method !== "HEAD" ? baosBytes(this.out).slice() : undefined;
    // Redirects are followed here, one proxy hop each, because the process CookieHandler that
    // Android's HttpURLConnection consults around every exchange must see each hop's URL.
    for (let hop = 0; ; hop++) {
      const cookies = await scall("java/net/CookieHandler", "getDefault", "()Ljava/net/CookieHandler;");
      const uri = cookies && await cookieURI(target), headers = new Headers(base);
      if (cookies) {
        const offered = await vcall(cookies, "get", "(Ljava/net/URI;Ljava/util/Map;)Ljava/util/Map;", uri, await headerMap(group(this.req)));
        for (const e of await toJsArray(await vcall(offered, "entrySet", "()Ljava/util/Set;"))) {
          const key: string | null = await vcall(e, "getKey", "()Ljava/lang/Object;");
          const values = await toJsArray(await vcall(e, "getValue", "()Ljava/lang/Object;")) as string[];
          if (key && /^cookie2?$/i.test(key) && values.length) headers.set("x-wd-" + key, values.join("; "));
        }
      }
      arm(this.cto, "connect timed out");
      try {
        r = await fetch("/proxy?manual=1&url=" + encodeURIComponent(target), { method, headers, signal: ac.signal, body });
      } catch (e) {
        if (timedOut) throw rt.mkThrowable("java/net/SocketTimeoutException", timedOut);
        if (ac.signal.aborted) throw rt.mkThrowable("java/net/SocketException", "Socket closed");
        throw rt.mkThrowable("java/io/IOException", String(e));
      } finally { clearTimeout(timer); }
      // the proxy's own failure answer carries no final URL; a genuine upstream 502 does
      if (r.status === 502 && !r.headers.get("x-wd-final-url")) {
        const { hostname, port, protocol } = new URL(target), kind = r.headers.get("x-wd-error");
        const detail = (await r.text()).replace(/^proxy error: /, "");
        if (kind === "host") throw rt.mkThrowable("java/net/UnknownHostException", `Unable to resolve host "${hostname}": No address associated with hostname`);
        if (kind === "refused") throw rt.mkThrowable("java/net/ConnectException", `Failed to connect to ${hostname}/${port || (protocol === "https:" ? 443 : 80)}`);
        throw rt.mkThrowable(kind === "timeout" ? "java/net/SocketTimeoutException" : kind === "tls" ? "javax/net/ssl/SSLHandshakeException" : "java/io/IOException", detail);
      }
      hdrs = [];
      r.headers.forEach((v, k) => {
        if (k === "x-wd-set-cookie") for (const c of JSON.parse(v) as string[]) hdrs.push(["set-cookie", c]);
        else if (k !== "x-wd-final-url" && k !== "x-wd-status" && k !== "x-wd-status-text" && k !== "x-wd-content-length") hdrs.push([k === "x-wd-content-encoding" ? "content-encoding" : k, v]);
      });
      length = r.headers.get("content-length") ?? r.headers.get("x-wd-content-length");
      if (length && !r.headers.has("content-length")) hdrs.push(["content-length", length]);
      if (cookies) await vcall(cookies, "put", "(Ljava/net/URI;Ljava/util/Map;)V", uri, await headerMap(group(hdrs)));
      const status = Number(r.headers.get("x-wd-status")) || r.status, location = r.headers.get("location");
      if (!this.follow || ![301, 302, 303, 307, 308].includes(status) || !location) break;
      // OkHttp's MAX_FOLLOW_UPS
      if (hop === 20) throw rt.mkThrowable("java/net/ProtocolException", "Too many follow-up requests: 21");
      await r.body?.cancel();
      // the method rewrites fetch's redirect mode (the proxy's former follower) applies
      if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") { method = "GET"; body = undefined; base.delete("x-wd-content-type"); }
      const next = new URL(location, target).href;
      if (new URL(next).origin !== new URL(target).origin) base.delete("x-wd-authorization");
      target = next;
    }
    if (target !== spec) this.url = await newObj("java/net/URL", "(Ljava/lang/String;)V", target);   // getURL() reports where a redirect landed
    const stream = new JHttpInputStream();
    stream.reader = r.body?.getReader() ?? null; stream.timeout = () => this.rto;
    const status = Number(r.headers.get("x-wd-status")) || r.status;
    if (length && method !== "HEAD" && status >= 200 && status !== 204 && status !== 304) stream.remaining = Number(length);
    return (this.res = { status, msg: r.headers.get("x-wd-status-text") ?? r.statusText, hdrs, stream });
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
const header = (c: JURLConnection, name: string): string | null | Promise<string | null> =>
  vcall(c, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", name);
const asLong = (v: string | null, d: bigint) => v && /^\s*-?\d+\s*$/.test(v) ? BigInt(v.trim()) : d;
rt.register({
  name: "java/net/URLConnection", ctor: JURLConnection,
  fields: { connected: "connected", url: "url", doInput: "doIn", doOutput: "doOut", useCaches: "useCaches" },
  // the platform getFileNameMap/setFileNameMap keep the map here
  statics: { fileNameMap: null },
  methods: {
    "static guessContentTypeFromName(Ljava/lang/String;)Ljava/lang/String;": (name: string | null) => mimeFromFilename(name ?? rt.npe()),
    "<init>(Ljava/net/URL;)V": function (this: JURLConnection, u: unknown) { this.url = u; },
    "connect()V": driven(function* (this: JURLConnection): Gen {
      this.connected = 1;
      // Fetch buffers uploads: connecting must leave the output stream writable until a response is requested.
      if (!this.doOut) yield this.connect();
    }),
    "getURL()Ljava/net/URL;": function (this: JURLConnection) { return this.url; },
    "getInputStream()Ljava/io/InputStream;": withRes(async function (r) {
      if (!this.doIn) throw rt.mkThrowable("java/net/ProtocolException", "Cannot read from URLConnection if doInput=false (call setDoInput(true))");
      if (r.status >= 400) {
        const spec = await urlText(this.url);
        throw r.status === 404 || r.status === 410
          ? rt.mkThrowable("java/io/FileNotFoundException", spec)
          : rt.mkThrowable("java/io/IOException", `Server returned HTTP response code: ${r.status} for URL: ${spec}`);
      }
      return this.stream();
    }),
    "getOutputStream()Ljava/io/OutputStream;": async function (this: JURLConnection) {
      if (!this.doOut) throw rt.mkThrowable("java/net/ProtocolException", "cannot write to a URLConnection if doOutput=false - call setDoOutput(true)");
      if (this.res || this.pending) throw rt.mkThrowable("java/net/ProtocolException", "Cannot write output after reading input");
      if (this.method === "GET") this.method = "POST";   // a GET that writes a body becomes a POST (OpenJDK and AOSP alike)
      this.connected = 1;
      return this.out ??= await newObj("java/io/ByteArrayOutputStream");
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
    // the typed accessors read through getHeaderField(String), which a subclass's transport overrides
    "getHeaderFieldInt(Ljava/lang/String;I)I": function (this: JURLConnection, k: string, d: number) {
      return after(header(this, k), (v) => { const n = parseInt(v ?? "", 10); return Number.isNaN(n) ? d : n; });
    },
    "getHeaderFieldLong(Ljava/lang/String;J)J": function (this: JURLConnection, k: string, d: bigint) { return after(header(this, k), (v) => asLong(v, d)); },
    "getHeaderFieldDate(Ljava/lang/String;J)J": function (this: JURLConnection, k: string, d: bigint) {
      return after(header(this, k), (v) => { const t = Date.parse(v ?? ""); return Number.isNaN(t) ? d : BigInt(t); });
    },
    "getContentType()Ljava/lang/String;": function (this: JURLConnection) { return header(this, "content-type"); },
    "getContentEncoding()Ljava/lang/String;": function (this: JURLConnection) { return header(this, "content-encoding"); },
    "getContentLength()I": function (this: JURLConnection) {
      return after(vcall(this, "getContentLengthLong", "()J") as bigint | Promise<bigint>, (n) => (n > 0x7fffffffn ? -1 : Number(n)));
    },
    "getContentLengthLong()J": function (this: JURLConnection) { return vcall(this, "getHeaderFieldLong", "(Ljava/lang/String;J)J", "content-length", -1n); },
    "toString()Ljava/lang/String;": function (this: JURLConnection) {
      return after(urlText(this.url), (spec) => dotName((this.constructor as typeof JObj).$i.name) + ":" + spec);
    },
  },
});
const HTTP_METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "PATCH"]);
const GET_INPUT = mangleMethod("getInputStream", "()Ljava/io/InputStream;");
const HEADER_AT = mangleMethod("getHeaderField", "(I)Ljava/lang/String;");
/** AOSP's getResponseCode over a subclass's transport: its getInputStream, then the status line as header 0 */
const statusFromHeader = driven(function* (this: JHttpURLConnection): Gen {
  if (this.responseCode !== -1) return this.responseCode;
  let failure: unknown = null;
  try { yield vcall(this, "getInputStream", "()Ljava/io/InputStream;"); } catch (e) { failure = e; }
  const line: string | null = yield vcall(this, "getHeaderField", "(I)Ljava/lang/String;", 0);
  if (line === null) { if (failure !== null) throw failure; return -1; }
  if (!line.startsWith("HTTP/1.")) return -1;
  const codeAt = line.indexOf(" ");
  if (codeAt <= 0) return -1;
  let phraseAt = line.indexOf(" ", codeAt + 1);
  if (phraseAt > 0 && phraseAt < line.length) this.responseMessage = line.slice(phraseAt + 1);
  if (phraseAt < 0) phraseAt = line.length;
  const code = line.slice(codeAt + 1, phraseAt);
  return /^[+-]?\d+$/.test(code) ? this.responseCode = parseInt(code, 10) : -1;
});
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
    "getResponseCode()I": function (this: JHttpURLConnection) {
      if ((this as any)[GET_INPUT] !== (JURLConnection.prototype as any)[GET_INPUT] || (this as any)[HEADER_AT] !== (JURLConnection.prototype as any)[HEADER_AT]) return statusFromHeader.call(this);
      return after(this.connect(), (r) => { this.responseMessage = r.msg || null; return this.responseCode = r.status; });
    },
    "getResponseMessage()Ljava/lang/String;": function (this: JHttpURLConnection) {
      return after(vcall(this, "getResponseCode", "()I"), () => this.responseMessage);
    },
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
const subjectOf = (certs: unknown[]) => vcall(certs[0], "getSubjectX500Principal", "()Ljavax/security/auth/x500/X500Principal;");
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
    "<init>(Ljava/net/URL;)V": function (this: JHttpsURLConnection, url: unknown) {
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
    // both principals are the first certificate's subject, from the overridable certificate accessors
    "getLocalPrincipal()Ljava/security/Principal;": function (this: JHttpsURLConnection) {
      return after(vcall(this, "getLocalCertificates", "()[Ljava/security/cert/Certificate;") as unknown[] | null, (certs) => certs === null ? null : subjectOf(certs));
    },
    "getServerCertificates()[Ljava/security/cert/Certificate;": function (this: JHttpsURLConnection) {
      return after(vcall(this.url, "getHost", "()Ljava/lang/String;") as string | Promise<string>, (host) => {
        const cert = rt.make("java/security/cert/X509Certificate") as JX509;
        cert.host = host; cert.relayPeer = true;
        return jarray([cert], "Ljava/security/cert/Certificate;");
      });
    },
    "getPeerPrincipal()Ljava/security/Principal;": function (this: JHttpsURLConnection) {
      return after(vcall(this, "getServerCertificates", "()[Ljava/security/cert/Certificate;") as unknown[], subjectOf);
    },
  },
});
