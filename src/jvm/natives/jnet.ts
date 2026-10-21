// The boundaries java.net keeps in TS: TLS on libcore's sockets (javax.net.ssl) and
// HttpURLConnection over the dev server's fetch proxy. libcore's sockets run over src/native/socket/.
//
// A page cannot open a socket, so one WebSocket carries one TCP connection (server.ts's /tcp
// route) and TLS is terminated at the relay -- the page has no certificate store and could not
// handshake. That has one visible consequence: the certificate an app inspects is ours, not the
// peer's. It carries the requested host as its only SAN, which is exactly what a hostname
// verifier needs and nothing more, so an app that PINS a certificate will correctly fail rather
// than be told a comforting lie.
import { awaited, rt, JObj, type NativeSpec, driven, instanceField, getDeclared, setDeclared, waits, type Gen } from "../runtime.ts";
import { newArrayList, toJsArray } from "./jcoll.ts";
import { newObj, vcall, scall, after, linkClass, classNameOf } from "./jentry.ts";
import { checkFromIndexSize } from "./jlang.ts";
import { strArray } from "../abi.ts";
import { baosBytes, fdInt } from "./jio.ts";
import { relayChain } from "./jrelaycert.ts";
import { startTls, type TlsResult } from "../../native/socket/inet.ts";
import { E, strerror } from "../../native/abi.ts";
import { deviceFetch } from "../../shell/devicefetch.ts";
import { nextHop, readAnswer, type ProxyRequest } from "../../shell/webpage/proxywire.ts";

const SOCKET = "java/net/Socket", SSL_SOCKET = "javax/net/ssl/SSLSocket";
class JSSLSocketFactory extends JObj {}
const sslSocketFactory = new JSSLSocketFactory();
rt.register({
  name: "javax/net/ssl/SSLSocketFactory", ctor: JSSLSocketFactory, sup: "javax/net/SocketFactory",
  methods: {
    "static getDefault()Ljavax/net/SocketFactory;": () => sslSocketFactory,
    // The OkHttp shape: connect a plain socket, then hand it here to carry TLS on its descriptor
    "createSocket(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;": driven(function* (plain: JObj | null, host: string | null, port: number, autoClose: number): Gen {
      if (plain === null) return rt.npe();
      if (!(yield vcall(plain, "isConnected", "()Z"))) throw rt.mkThrowable("java/net/SocketException", "Socket is not connected.");
      const s: JSSLSocket = yield newObj(SSL_SOCKET);
      setDeclared(s, SOCKET, Object.fromEntries(["impl", "created", "bound", "connected"].map((f) => [f, getDeclared(plain, SOCKET, f)])));
      return Object.assign(s, { host: host ?? "", port, plain, autoClose: !!autoClose });
    }),
    "createSocket()Ljava/net/Socket;": () => newObj(SSL_SOCKET),
    "createSocket(Ljava/lang/String;I)Ljava/net/Socket;": waits((host: string | null, port: number) =>
      after(newObj(SSL_SOCKET, "(Ljava/lang/String;I)V", host, port), (s: JSSLSocket) => Object.assign(s, { host: host ?? "" }))),
    "createSocket(Ljava/net/InetAddress;I)Ljava/net/Socket;": (address: JObj | null, port: number) => newObj(SSL_SOCKET, "(Ljava/net/InetAddress;I)V", address, port),
    "getDefaultCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
    "getSupportedCipherSuites()[Ljava/lang/String;": () => strArray(CIPHERS),
  },
});
class JSSLServerSocketFactory extends JObj {}
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
    // TLS is the relay's: there is no engine to wrap records, and no client certificate to present
    "createSSLEngine()Ljavax/net/ssl/SSLEngine;": () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "SSLEngine: TLS is terminated at the relay"); },
    "init([Ljavax/net/ssl/KeyManager;[Ljavax/net/ssl/TrustManager;Ljava/security/SecureRandom;)V": (keyManagers: unknown[] | null) => {
      if (keyManagers?.length) throw rt.mkThrowable("java/security/KeyManagementException", "client certificates: TLS is terminated at the relay");
    },
    "getProvider()Ljava/security/Provider;": function (this: JSSLContext) { return this.provider ?? scall("java/security/Security", "getProvider", "(Ljava/lang/String;)Ljava/security/Provider;", "AndroidOpenSSL"); },
    "getSocketFactory()Ljavax/net/ssl/SSLSocketFactory;": () => rt.make("javax/net/ssl/SSLSocketFactory"),
  },
});

const CIPHERS = ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"];
const PROTOCOLS = ["TLSv1.2", "TLSv1.3"];

/** a libcore Socket's descriptor, -1 once closed */
const socketFd = (socket: JObj): number => {
  const impl = getDeclared<JObj | null>(socket, SOCKET, "impl");
  return impl ? fdInt(getDeclared<JObj | null>(impl, "java/net/SocketImpl", "fd")) : -1;
};
const inherited = (name: string, desc: string) => linkClass(SOCKET).special(name, desc);
/** startTls's failure as the exception libcore's connect or Conscrypt's handshake throws */
function tlsFailure({ errno, reason }: Exclude<TlsResult, string>, host: string, port: number): Error {
  const cls = !errno ? "javax/net/ssl/SSLHandshakeException" : errno === E.TIMEDOUT ? "java/net/SocketTimeoutException"
    : errno === E.HOSTUNREACH ? "java/net/NoRouteToHostException" : errno === E.NOTCONN ? "java/net/SocketException" : "java/net/ConnectException";
  return rt.mkThrowable(cls, `${host}:${port}: ${reason || strerror(errno)}`);
}
const tlsHandshake = driven(function* (this: JSSLSocket): Gen {
  const fd = socketFd(this);
  if (fd < 0) throw rt.mkThrowable("java/net/SocketException", "Socket is closed");
  if (!getDeclared(this, SOCKET, "connected")) throw rt.mkThrowable("java/net/SocketException", "Socket is not connected");
  this.host ||= yield vcall(yield vcall(this, "getInetAddress", "()Ljava/net/InetAddress;"), "getHostName", "()Ljava/lang/String;");
  this.port ||= yield vcall(this, "getPort", "()I");
  const r: TlsResult = yield startTls(fd, this.host, this.port, this.alpn);
  if (typeof r !== "string") throw tlsFailure(r, this.host, this.port);
  this.protocol = r;
});

/** An SSLSocket is a libcore Socket whose descriptor carries TLS from its first handshake, which
 *  an explicit startHandshake or the first stream asked for starts. One made to wrap a connected
 *  socket shares its descriptor, and closes it with autoClose. */
class JSSLSocket extends JObj {
  host = ""; port = 0; alpn: string[] = []; protocol: string | null = null;
  plain: JObj | null = null; autoClose = false;
  private handshaking: unknown = null;
  handshake(): unknown { return this.handshaking ??= tlsHandshake.call(this); }
}
const stream = (name: string, desc: string) => driven(function* (this: JSSLSocket): Gen {
  yield this.handshake();
  return yield inherited(name, desc)(this);
});

rt.register({
  name: SSL_SOCKET, ctor: JSSLSocket, sup: SOCKET,
  methods: {
    "getInputStream()Ljava/io/InputStream;": stream("getInputStream", "()Ljava/io/InputStream;"),
    "getOutputStream()Ljava/io/OutputStream;": stream("getOutputStream", "()Ljava/io/OutputStream;"),
    "close()V": driven(function* (this: JSSLSocket): Gen {
      if (this.plain && !this.autoClose) return void setDeclared(this, SOCKET, { closed: true });
      yield inherited("close", "()V")(this);
      if (this.plain) yield vcall(this.plain, "close", "()V");
    }),
    "startHandshake()V": driven(function* (this: JSSLSocket): Gen { yield this.handshake(); }),
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
    "addHandshakeCompletedListener(Ljavax/net/ssl/HandshakeCompletedListener;)V": () => {},
    "getSSLParameters()Ljavax/net/ssl/SSLParameters;": function (this: JSSLSocket) {
      linkClass("javax/net/ssl/SSLParameters"); return Object.assign(new JSSLParameters(), { protocols: [...this.alpn] });
    },
    "setSSLParameters(Ljavax/net/ssl/SSLParameters;)V": function (this: JSSLSocket, p: JSSLParameters | null) {
      if (!p) throw rt.mkThrowable("java/lang/IllegalArgumentException", "parameters == null");
      this.alpn = [...p.protocols];
    },
    "getApplicationProtocol()Ljava/lang/String;": function (this: JSSLSocket) { return this.protocol; },
    "getHandshakeApplicationProtocol()Ljava/lang/String;": () => null,
  },
});
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
rt.register({ name: "com/android/org/conscrypt/SSLParametersImpl", ctor: class extends JObj {} });
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
    "getPeerCertificates()[Ljava/security/cert/Certificate;": waits(function (this: JSSLSession) { return relayChain(this.host); }),
    "getLocalCertificates()[Ljava/security/cert/Certificate;": () => null,
    "getPeerPrincipal()Ljava/security/Principal;": waits(function (this: JSSLSession) { return after(relayChain(this.host), subjectOf); }),
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

// ── java.net.URL and HttpURLConnection, over the dev server's /proxy route (or this process's own
// server for a loopback URL): a page cannot speak raw HTTP to another origin. The proxy forwards `x-wd-*` request headers with the prefix
// stripped and, with manual=1, hands a redirect back with its status in x-wd-status.
/** a URL's external form, through its Java API */
const urlText = (url: unknown) => vcall(url, "toExternalForm", "()Ljava/lang/String;") as string | Promise<string>;
// URL.createBuiltinHandler instantiates these by name for http and https, as OkHttp's are on a
// device; their connections are the fetch-backed ones below.
class JHttpHandler extends JObj {}
const openHttp = (cls: string) => function (url: unknown, proxy?: unknown) {
  if (url === null || proxy === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "url == null || proxy == null");
  const c = linkClass(cls).new() as JHttpURLConnection;
  initConnection(c, url);
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
  "read()I": driven(function* (this: JHttpInputStream): Gen { return (yield* awaited(this.fill())) ? this.bytes[this.offset++] : -1; }),
  "read([B)I": waits(function (this: JHttpInputStream, out: Int8Array | null) { return this.read(out, 0, out?.length ?? 0); }),
  "read([BII)I": waits(function (this: JHttpInputStream, out: Int8Array | null, off: number, len: number) { return this.read(out, off, len); }),
  "available()I": function (this: JHttpInputStream) { return this.bytes.length - this.offset; },
  "skip(J)J": driven(function* (this: JHttpInputStream, count: bigint): Gen {
    let left = count;
    while (left > 0n && (yield* awaited(this.fill()))) {
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
const headerMap = driven(function* (groups: Iterable<[string | null, string[]]>): Gen<JObj> {
  const m: JObj = yield newObj("java/util/HashMap");
  for (const [k, v] of groups) yield vcall(m, "put", PUT, k, yield newArrayList(v));
  return m;
});
function group(entries: [string | null, string][]): Map<string | null, string[]> {
  const g = new Map<string | null, string[]>();
  for (const [k, v] of entries) { let l = g.get(k); if (!l) g.set(k, l = []); l.push(v); }
  return g;
}
/** the URI a CookieHandler sees, escaped as OkHttp's HttpUrl.uri() does: WHATWG leaves characters
 *  in the path, query and fragment that java.net.URI rejects */
function cookieURI(target: string): unknown {
  const u = new URL(target), tail = u.pathname + u.search + u.hash;
  const text = u.href.slice(0, u.href.length - tail.length) + tail.replace(/[[\]{}|\\^`"<> ]|%(?![\dA-Fa-f]{2})/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return newObj("java/net/URI", "(Ljava/lang/String;)V", text);
}
let followRedirects = 1;
// URLConnection is libcore's; its fields are what this transport reads
const UC = "java/net/URLConnection";
const uc = { url: instanceField<unknown>(UC, "url"), doInput: instanceField<number>(UC, "doInput"), doOutput: instanceField<number>(UC, "doOutput"),
  connected: instanceField<number>(UC, "connected"), connectTimeout: instanceField<number>(UC, "connectTimeout"),
  readTimeout: instanceField<number>(UC, "readTimeout"), ifModifiedSince: instanceField<bigint>(UC, "ifModifiedSince") };
/** URLConnection(URL), the constructor HttpURLConnection(URL) runs */
function initConnection(c: JObj, url: unknown): void {
  linkClass(UC).special("<init>", "(Ljava/net/URL;)V")(c, url);
}
/** the exchange, redirects followed: a driven native, so the CookieHandler and every other Java
 *  call after a fetch runs on the thread that connected, not on whatever the event loop resumed */
const fetchResponse = driven(function* (this: JHttpURLConnection): Gen<HttpRes> {
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
  const agent: string | null = yield scall("java/lang/System", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", "http.agent");
  if (!base.has("x-wd-user-agent") && agent) base.set("x-wd-user-agent", agent);
  if (this.ifMod) base.set("x-wd-if-modified-since", new Date(Number(this.ifMod)).toUTCString());
  const spec = yield* awaited(urlText(this.url));
  // OkHttp's HttpUrl.getChecked
  if (!(yield vcall(this.url, "getHost", "()Ljava/lang/String;"))) throw rt.mkThrowable("java/net/UnknownHostException", "Invalid host: " + spec);
  let hop: ProxyRequest = { url: spec, method: this.method, headers: base,
    body: this.out && this.method !== "GET" && this.method !== "HEAD" ? baosBytes(this.out).slice() : undefined };
  let r: Response, answer: ReturnType<typeof readAnswer>;
  // Redirects are followed here, one proxy hop each, because the process CookieHandler that
  // Android's HttpURLConnection consults around every exchange must see each hop's URL.
  for (let hops = 0; ; hops++) {
    const target = hop.url, cookies = yield scall("java/net/CookieHandler", "getDefault", "()Ljava/net/CookieHandler;");
    const uri = cookies && (yield cookieURI(target)), headers = new Headers(hop.headers);
    if (cookies) {
      const offered = yield vcall(cookies, "get", "(Ljava/net/URI;Ljava/util/Map;)Ljava/util/Map;", uri, yield* awaited(headerMap(group(this.req))));
      for (const e of yield* awaited(toJsArray(yield vcall(offered, "entrySet", "()Ljava/util/Set;")))) {
        const key: string | null = yield vcall(e, "getKey", "()Ljava/lang/Object;");
        const values = (yield* awaited(toJsArray(yield vcall(e, "getValue", "()Ljava/lang/Object;")))) as string[];
        if (key && /^cookie2?$/i.test(key) && values.length) headers.set("x-wd-" + key, values.join("; "));
      }
    }
    arm(this.cto, "connect timed out");
    try {
      r = yield* awaited(deviceFetch(target, { method: hop.method, headers, signal: ac.signal, body: hop.body }));
    } catch (e) {
      if (timedOut) throw rt.mkThrowable("java/net/SocketTimeoutException", timedOut);
      if (ac.signal.aborted) throw rt.mkThrowable("java/net/SocketException", "Socket closed");
      throw rt.mkThrowable("java/io/IOException", String(e));
    } finally { clearTimeout(timer); }
    answer = readAnswer(r);
    const kind = answer.error;
    if (kind) {
      const { hostname, port, protocol } = new URL(target);
      const detail = (yield* awaited(r.text())).replace(/^proxy error: /, "");
      if (kind === "host") throw rt.mkThrowable("java/net/UnknownHostException", `Unable to resolve host "${hostname}": No address associated with hostname`);
      if (kind === "refused") throw rt.mkThrowable("java/net/ConnectException", `Failed to connect to ${hostname}/${port || (protocol === "https:" ? 443 : 80)}`);
      throw rt.mkThrowable(kind === "timeout" ? "java/net/SocketTimeoutException" : kind === "tls" ? "javax/net/ssl/SSLHandshakeException" : "java/io/IOException", detail);
    }
    if (cookies) yield vcall(cookies, "put", "(Ljava/net/URI;Ljava/util/Map;)V", uri, yield* awaited(headerMap(group(answer.headers))));
    const next = this.follow ? nextHop(r, hop) : null;
    if (!next) break;
    // OkHttp's MAX_FOLLOW_UPS
    if (hops === 20) throw rt.mkThrowable("java/net/ProtocolException", "Too many follow-up requests: 21");
    yield r.body?.cancel();
    hop = next;
  }
  if (hop.url !== spec) this.url = yield newObj("java/net/URL", "(Ljava/lang/String;)V", hop.url);   // getURL() reports where a redirect landed
  const stream = new JHttpInputStream();
  stream.reader = r.body?.getReader() ?? null; stream.timeout = () => this.rto;
  const { status, statusText: msg, headers: hdrs, length } = answer;
  if (length && hop.method !== "HEAD" && status >= 200 && status !== 204 && status !== 304) stream.remaining = Number(length);
  return (this.res = { status, msg, hdrs, stream });
});
class JHttpURLConnection extends JObj {
  get url(): unknown { return uc.url.get(this); }
  set url(u: unknown) { uc.url.set(this, u); }
  get doIn(): number { return uc.doInput.get(this); }
  get doOut(): number { return uc.doOutput.get(this); }
  get connected(): number { return uc.connected.get(this); }
  set connected(v: number) { uc.connected.set(this, v); }
  get cto(): number { return uc.connectTimeout.get(this); }
  get rto(): number { return uc.readTimeout.get(this); }
  get ifMod(): bigint { return uc.ifModifiedSince.get(this); }
  method = "GET"; follow = followRedirects;
  responseCode = -1; responseMessage: string | null = null; chunkLength = -1; fixedContentLength = -1; fixedContentLengthLong = -1n;
  req: [string, string][] = [];
  out: JObj | null = null;
  ac: AbortController | null = null;
  res: HttpRes | null = null;
  pending: Promise<HttpRes> | null = null;
  connect(): Promise<HttpRes> {
    if (this.res) return Promise.resolve(this.res);
    return this.pending ??= Promise.resolve(fetchResponse.call(this)).finally(() => { this.pending = null; });
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
/** an accessor that needs the response: connect first, then answer on the calling thread */
function withRes<A extends unknown[], C extends JHttpURLConnection = JHttpURLConnection>(f: (this: C, r: HttpRes, ...a: A) => unknown) {
  return driven(function* (this: C, ...a: A): Gen { return yield f.call(this, yield* awaited(this.connect()), ...a); });
}
/** URLConnection's checks before a request property changes */
function checkRequestKey(c: JHttpURLConnection, k: string | null): asserts k is string {
  if (c.connected) throw rt.mkThrowable("java/lang/IllegalStateException", "Already connected");
  if (k === null) throw rt.mkThrowable("java/lang/NullPointerException", "key is null");
}
const connectionMethods: NativeSpec["methods"] = {
  "connect()V": driven(function* (this: JHttpURLConnection): Gen {
    this.connected = 1;
    // Fetch buffers uploads: connecting must leave the output stream writable until a response is requested.
    if (!this.doOut) yield this.connect();
  }),
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
  "getOutputStream()Ljava/io/OutputStream;": async function (this: JHttpURLConnection) {
    if (!this.doOut) throw rt.mkThrowable("java/net/ProtocolException", "cannot write to a URLConnection if doOutput=false - call setDoOutput(true)");
    if (this.res || this.pending) throw rt.mkThrowable("java/net/ProtocolException", "Cannot write output after reading input");
    if (this.method === "GET") this.method = "POST";   // a GET that writes a body becomes a POST (OpenJDK and AOSP alike)
    this.connected = 1;
    return this.out ??= await newObj("java/io/ByteArrayOutputStream");
  },
  "setRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JHttpURLConnection, k: string | null, v: string) {
    checkRequestKey(this, k);
    this.req = this.req.filter(([n]) => n.toLowerCase() !== k.toLowerCase());
    this.req.push([k, v]);
  },
  "addRequestProperty(Ljava/lang/String;Ljava/lang/String;)V": function (this: JHttpURLConnection, k: string | null, v: string) {
    checkRequestKey(this, k);
    this.req.push([k, v]);
  },
  "getRequestProperty(Ljava/lang/String;)Ljava/lang/String;": function (this: JHttpURLConnection, k: string | null) {
    let v: string | null = null;
    for (const [n, x] of this.req) if (n.toLowerCase() === k?.toLowerCase()) v = x;
    return v;
  },
  "getRequestProperties()Ljava/util/Map;": function (this: JHttpURLConnection) { return headerMap(group(this.req)); },
  "getHeaderField(Ljava/lang/String;)Ljava/lang/String;": withRes(function (_r, k: string | null) { return this.hdr(k); }),
  "getHeaderField(I)Ljava/lang/String;": withRes((r, i: number) => r.hdrs[i]?.[1] ?? null),
  "getHeaderFieldKey(I)Ljava/lang/String;": withRes((r, i: number) => r.hdrs[i]?.[0] ?? null),
  "getHeaderFields()Ljava/util/Map;": withRes((r) => headerMap(group([[null, statusLine(r)], ...r.hdrs]))),
};
const HTTP_METHODS = new Set(["GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "PATCH"]);
/** AOSP's getResponseCode for a Java subclass, which may bring its own transport: its getInputStream, then the status line as header 0 */
const statusFromHeader = driven(function* (this: JHttpURLConnection): Gen {
  if (this.responseCode !== -1) return this.responseCode;
  let failure: unknown = null;
  try { yield vcall(this, "getInputStream", "()Ljava/io/InputStream;"); } catch (e) { failure = e; }
  if (this.res) { this.responseMessage = this.res.msg || null; return this.responseCode = this.res.status; }
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
    ...connectionMethods,
    "<init>(Ljava/net/URL;)V": function (this: JHttpURLConnection, url: unknown) { initConnection(this, url); },
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
    "getResponseCode()I": waits(function (this: JHttpURLConnection) {
      if (!rt.natives.has(classNameOf(this)!)) return statusFromHeader.call(this);
      return after(this.connect(), (r) => { this.responseMessage = r.msg || null; return this.responseCode = r.status; });
    }),
    "getResponseMessage()Ljava/lang/String;": waits(function (this: JHttpURLConnection) {
      return after(vcall(this, "getResponseCode", "()I"), () => this.responseMessage);
    }),
    "getErrorStream()Ljava/io/InputStream;": driven(function* (this: JHttpURLConnection): Gen {
      // AOSP connects here too, and answers null for any failure rather than throwing
      try { return (yield* awaited(this.connect())).status >= 400 ? this.stream() : null; } catch { return null; }
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
      initConnection(this, url); this.sslFactory = defaultHttpsFactory; this.hostnameVerifier = defaultHostnameVerifier;
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
    "getLocalPrincipal()Ljava/security/Principal;": waits(function (this: JHttpsURLConnection) {
      return after(vcall(this, "getLocalCertificates", "()[Ljava/security/cert/Certificate;") as unknown[] | null, (certs) => certs === null ? null : subjectOf(certs));
    }),
    "getServerCertificates()[Ljava/security/cert/Certificate;": waits(function (this: JHttpsURLConnection) {
      return after(vcall(this.url, "getHost", "()Ljava/lang/String;") as string | Promise<string>, relayChain);
    }),
    "getPeerPrincipal()Ljava/security/Principal;": waits(function (this: JHttpsURLConnection) {
      return after(vcall(this, "getServerCertificates", "()[Ljava/security/cert/Certificate;") as unknown[], subjectOf);
    }),
  },
});
