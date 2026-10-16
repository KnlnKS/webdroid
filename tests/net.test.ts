import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives.ts";
import { rt, JObj } from "../src/jvm/runtime.ts";
import { newObj, vcall, vcallAsync, iof } from "../src/jvm/natives/jentry.ts";
import { dialName, syntheticAddress } from "../src/shell/relay.ts";
import { scall, mountApexData, loadFrameworkJar, thrown } from "./java.ts";
import { vfs } from "../src/shell/vfs.ts";
import { jarray } from "../src/jvm/abi.ts";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);


describe("ssl-relay-peer", () => {
  test("a relay-terminated peer presents a chain the relay CA issued, which hostname and trust checks accept", async () => {
    await mountApexData();
    const socket = Object.assign(rt.make("javax/net/ssl/SSLSocket"), { host: "example.com" });
    const session = await vcall(socket, "getSession", "()Ljavax/net/ssl/SSLSession;");
    const chain = await vcall(session, "getPeerCertificates", "()[Ljava/security/cert/Certificate;");
    const factory = await scall("javax/net/ssl/TrustManagerFactory", "getInstance",
      "(Ljava/lang/String;)Ljavax/net/ssl/TrustManagerFactory;", "PKIX");
    await vcall(factory, "init", "(Ljava/security/KeyStore;)V", null);
    const managers = await vcall(factory, "getTrustManagers", "()[Ljavax/net/ssl/TrustManager;");
    const trusted = await vcallAsync(managers[0], "checkServerTrusted", "([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V", chain, "ECDHE_ECDSA").then(() => true, (e) => rt.jx(e)?.msg);
    expect(trusted).toBe(true);
    const verifier = await scall("javax/net/ssl/HttpsURLConnection", "getDefaultHostnameVerifier", "()Ljavax/net/ssl/HostnameVerifier;");
    expect(await vcall(verifier, "verify", "(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z", "EXAMPLE.COM.", session)).toBe(1);
    expect(await vcall(verifier, "verify", "(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z", "other.example", session)).toBe(0);
  }, 30_000);
});

describe("datagram-socket", () => {
  test("DatagramSocket delivers loopback packets and preserves source metadata", async () => {
    const receiver = await newObj("java/net/DatagramSocket", "()V");
    const sender = await newObj("java/net/DatagramSocket", "()V");
    const port = await vcall(receiver, "getLocalPort", "()I") as number;
    const loopback = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "localhost");
    const outgoing = await newObj("java/net/DatagramPacket", "([BILjava/net/InetAddress;I)V", new Int8Array([4, 5, 6]), 3, loopback, port);
    await vcall(sender, "send", "(Ljava/net/DatagramPacket;)V", outgoing);
    const incoming = await newObj("java/net/DatagramPacket", "([BI)V", new Int8Array(8), 8);
    await vcall(receiver, "receive", "(Ljava/net/DatagramPacket;)V", incoming);
    expect(await vcall(incoming, "getLength", "()I")).toBe(3);
    expect(Array.from((await vcall(incoming, "getData", "()[B") as Int8Array).subarray(0, 3))).toEqual([4, 5, 6]);
    expect(await vcall(incoming, "getPort", "()I")).toBe(await vcall(sender, "getLocalPort", "()I"));
    await vcall(sender, "close", "()V");
    await vcall(receiver, "close", "()V");
  });
});

describe("http-stream", () => {
  /** `body` with fetch reaching a local server that answers through `handler` as the fetch proxy
   *  would, and with `cookies` as the default CookieHandler */
  async function viaProxy(handler: (request: Request) => Response, body: () => Promise<void>, cookies: unknown = null) {
    const server = Bun.serve({ port: 0, fetch: handler }), original = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      original(new URL(String(input), server.url), init), { preconnect: original.preconnect });
    if (cookies) await scall("java/net/CookieHandler", "setDefault", "(Ljava/net/CookieHandler;)V", cookies);
    try { await body(); } finally {
      if (cookies) await scall("java/net/CookieHandler", "setDefault", "(Ljava/net/CookieHandler;)V", null);
      globalThis.fetch = original; server.stop(true);
    }
  }
  const open = async (spec: string) => vcall(await newObj("java/net/URL", "(Ljava/lang/String;)V", spec), "openConnection", "()Ljava/net/URLConnection;");

  test("HTTP headers and incremental reads do not await the entire response, and timed-out reads remain usable", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    await viaProxy(() => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(Uint8Array.of(1, 2, 3)); } }),
      { headers: { "content-type": "application/octet-stream", "x-wd-content-length": "7", "x-wd-final-url": "https://example.test/stream" } }), async () => {
      const connection = await open("https://example.test/stream");
      await vcall(connection, "setReadTimeout", "(I)V", 30);
      expect(await vcall(connection, "getResponseCode", "()I")).toBe(200);
      expect(await vcall(connection, "getContentLength", "()I")).toBe(7);
      const stream = await vcall(connection, "getInputStream", "()Ljava/io/InputStream;");
      const out = new Int8Array(5);
      expect(await vcall(stream, "read", "([BII)I", out, 1, 2)).toBe(2);
      expect([...out]).toEqual([0, 1, 2, 0, 0]);
      expect(await vcall(stream, "available", "()I")).toBe(1);
      expect(await vcall(stream, "read", "()I")).toBe(3);
      await expect(vcallAsync(stream, "read", "()I")).rejects.toMatchObject({ msg: "Read timed out" });
      controller!.enqueue(Uint8Array.of(4, 5, 6, 7));
      expect(await vcall(stream, "skip", "(J)J", 2n)).toBe(2n);
      expect(await vcall(stream, "read", "()I")).toBe(6);
      expect(await vcall(stream, "read", "()I")).toBe(7);
      controller!.close();
      expect(await vcall(stream, "read", "()I")).toBe(-1);
      expect(await vcall(stream, "read", "([BII)I", out, 0, 0)).toBe(0);
      expect(await vcall(stream, "markSupported", "()Z")).toBe(0);
      await vcall(connection, "disconnect", "()V");
      await expect(vcallAsync(stream, "read", "()I")).rejects.toMatchObject({ msg: "Stream closed" });
    });
  }, 5000);

  test("HttpURLConnection preserves a redirect when following is disabled", async () => {
    const seen: string[] = [];
    await viaProxy((request) => {
      seen.push(new URL(request.url).searchParams.get("manual") ?? "");
      return new Response(null, { headers: { "x-wd-status": "302", "x-wd-status-text": "Found", "x-wd-final-url": "https://example.test/start", location: "/next" } });
    }, async () => {
      const connection = await open("https://example.test/start");
      await vcall(connection, "setInstanceFollowRedirects", "(Z)V", 0);
      expect(await vcall(connection, "getResponseCode", "()I")).toBe(302);
      expect(await vcall(connection, "getResponseMessage", "()Ljava/lang/String;")).toBe("Found");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", null)).toBe("HTTP/1.1 302 Found");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "location")).toBe("/next");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "x-wd-status")).toBeNull();
      expect(seen).toEqual(["1"]);
    });
  });

  test("HttpURLConnection consults the CookieHandler on every redirect hop", async () => {
    const seen: string[] = [];
    class Handler extends JObj { log: string[] = []; }
    rt.register({ name: "test/RecordingCookieHandler", ctor: Handler, sup: "java/net/CookieHandler", methods: {
      "get(Ljava/net/URI;Ljava/util/Map;)Ljava/util/Map;": async function (this: Handler, uri: unknown) {
        this.log.push("get " + await vcall(uri, "toString", "()Ljava/lang/String;"));
        return newObj("java/util/HashMap");
      },
      "put(Ljava/net/URI;Ljava/util/Map;)V": async function (this: Handler, uri: unknown, headers: unknown) {
        const cookies = await vcall(headers, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "set-cookie");
        this.log.push(`put ${await vcall(uri, "toString", "()Ljava/lang/String;")} ${await vcall(cookies, "toString", "()Ljava/lang/String;")}`);
      },
    } });
    const handler = new Handler();
    await viaProxy((request) => {
      const url = new URL(request.url).searchParams.get("url")!, start = url.endsWith("/start");
      seen.push(url);
      const headers: Record<string, string> = { "x-wd-final-url": url, "x-wd-status": start ? "302" : "200", "x-wd-set-cookie": JSON.stringify([start ? "hop=1" : "end=2"]) };
      if (start) headers.location = "https://other.test/end";
      return new Response(start ? null : "done", { headers });
    }, async () => {
      const connection = await open("https://example.test/start");
      expect(await vcall(connection, "getResponseCode", "()I")).toBe(200);
      expect(await vcall(await vcall(connection, "getURL", "()Ljava/net/URL;"), "toString", "()Ljava/lang/String;")).toBe("https://other.test/end");
      expect(seen).toEqual(["https://example.test/start", "https://other.test/end"]);
      expect(handler.log).toEqual([
        "get https://example.test/start", "put https://example.test/start [hop=1]",
        "get https://other.test/end", "put https://other.test/end [end=2]",
      ]);
    }, handler);
  });

  test("a default CookieManager returns a hop's Set-Cookie on the next hop, for URLs java.net.URI would reject", async () => {
    const seen: (string | null)[] = [];
    await viaProxy((request) => {
      const url = new URL(request.url).searchParams.get("url")!, start = url.includes("/start");
      seen.push(request.headers.get("x-wd-cookie"));
      const headers: Record<string, string> = { "x-wd-final-url": url, "x-wd-status": start ? "302" : "200" };
      if (start) Object.assign(headers, { location: "https://example.test/end?v=a|b", "x-wd-set-cookie": JSON.stringify(["hop=1"]) });
      return new Response(start ? null : "done", { headers });
    }, async () => {
      expect(await vcall(await open("https://example.test/start?q={x}"), "getResponseCode", "()I")).toBe(200);
      expect(seen).toEqual([null, "hop=1"]);
    }, await newObj("java/net/CookieManager"));
  });
});

describe("http-upload", () => {
  test("HTTP connect leaves the upload writable and response accessors share one request", async () => {
    const original = globalThis.fetch;
    const requests: { method: string; body: number[] }[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({ method: init!.method!, body: [...init!.body as Uint8Array] });
      await Promise.resolve();
      return new Response("ok", { status: 200, statusText: "OK", headers: { "Content-Type": "application/binary", "X-Example": "value" } });
    }) as typeof fetch;
    try {
      const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/upload");
      const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
      await vcall(connection, "setDoOutput", "(Z)V", 1);
      const output = await vcall(connection, "getOutputStream", "()Ljava/io/OutputStream;");
      await vcall(connection, "connect", "()V");
      expect(requests).toEqual([]);
      await vcall(output, "write", "([BII)V", Int8Array.of(0, 1, -1, 2), 1, 2);
      await vcall(output, "close", "()V");
      expect(await Promise.all([
        vcall(connection, "getResponseCode", "()I"),
        vcall(connection, "getResponseMessage", "()Ljava/lang/String;"),
      ])).toEqual([200, "OK"]);
      expect(requests).toEqual([{ method: "POST", body: [1, 255] }]);
      const headers = new Map<string, string>();
      for (let i = 0; ; i++) {
        const key = await vcall(connection, "getHeaderFieldKey", "(I)Ljava/lang/String;", i);
        if (key === null) break;
        headers.set(key.toLowerCase(), await vcall(connection, "getHeaderField", "(I)Ljava/lang/String;", i));
      }
      expect(headers.get("content-type")).toBe("application/binary");
      expect(headers.get("x-example")).toBe("value");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", null)).toBe("HTTP/1.1 200 OK");
      await expect(vcallAsync(connection, "getOutputStream", "()Ljava/io/OutputStream;")).rejects.toMatchObject({ msg: "Cannot write output after reading input" });
    } finally { globalThis.fetch = original; }
  });
});

describe("inet", () => {
  test("InetAddress hands out the resolver's synthetic address, which dials the name again", async () => {
    const a = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "v16m.example.com");
    const text = await vcall(a, "getHostAddress", "()Ljava/lang/String;");
    expect(text).toMatch(/^198\.1[89]\.\d+\.\d+$/);
    expect(text).toBe(syntheticAddress("v16m.example.com").join("."));
    expect(await vcall(a, "toString", "()Ljava/lang/String;")).toBe("v16m.example.com/" + text);
    expect(iof(a, "java/net/Inet4Address")).toBeTruthy();
    const bytes = await vcall(a, "getAddress", "()[B");
    const back = await scall("java/net/InetAddress", "getByAddress", "([B)Ljava/net/InetAddress;", bytes);
    expect(await vcall(back, "getHostName", "()Ljava/lang/String;")).toBe("v16m.example.com");
    expect(await vcall(back, "equals", "(Ljava/lang/Object;)Z", a)).toBe(1);
    expect(dialName(text)).toBe("v16m.example.com");
    expect(dialName("93.184.216.34")).toBe("93.184.216.34");
    const literal = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "127.0.0.1");
    expect(await vcall(literal, "isLoopbackAddress", "()Z")).toBe(1);
    expect(await vcall(literal, "getHostAddress", "()Ljava/lang/String;")).toBe("127.0.0.1");
  });

  test("SSL wrapping keeps the underlying socket open until the wrapper closes", async () => {
    const plain = await newObj("java/net/Socket");
    const factory = await scall("javax/net/ssl/SSLSocketFactory", "getDefault", "()Ljavax/net/SocketFactory;");
    const secure = await vcall(factory, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;", plain, "example.com", 443, 1);
    expect(await vcall(plain, "isClosed", "()Z")).toBe(0);
    await vcall(secure, "close", "()V");
    expect(await vcall(plain, "isClosed", "()Z")).toBe(1);
    const retained = await newObj("java/net/Socket");
    const independent = await vcall(factory, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;", retained, "example.com", 443, 0);
    await vcall(independent, "close", "()V");
    expect(await vcall(retained, "isClosed", "()Z")).toBe(0);
  });
});

describe("localsocket", () => {
  test("LocalServerSocket accepts an in-process LocalSocket and streams bytes both ways", async () => {
    const server = await newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock");
    expect(await thrown(() => newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock"))).toStartWith("java/io/IOException:");
    const accepted = vcall(server, "accept", "()Landroid/net/LocalSocket;");
    const client = await newObj("android/net/LocalSocket");
    await vcall(client, "connect", "(Landroid/net/LocalSocketAddress;)V", await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.sock"));
    const peer = await accepted;
    expect(await vcall(client, "isConnected", "()Z")).toBe(1);
    const out = await vcall(client, "getOutputStream", "()Ljava/io/OutputStream;");
    await vcall(out, "write", "([B)V", Int8Array.from([1, 2, 3]));
    const input = await vcall(peer, "getInputStream", "()Ljava/io/InputStream;");
    const buf = new Int8Array(8);
    expect(await vcall(input, "read", "([BII)I", buf, 0, 8)).toBe(3);
    expect([...buf.subarray(0, 3)]).toEqual([1, 2, 3]);
    const back = await vcall(peer, "getOutputStream", "()Ljava/io/OutputStream;");
    await vcall(back, "write", "(I)V", 0x41);
    expect(await vcall(await vcall(client, "getInputStream", "()Ljava/io/InputStream;"), "read", "()I")).toBe(0x41);
    await vcall(client, "close", "()V");
    expect(await vcall(input, "read", "([BII)I", buf, 0, 8)).toBe(-1);
    await vcall(server, "close", "()V");
    const late = await newObj("android/net/LocalSocket");
    const address = await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.sock");
    expect(await thrown(() => vcall(late, "connect", "(Landroid/net/LocalSocketAddress;)V", address))).toStartWith("java/io/IOException:");
  });
  test("LocalSocket passes descriptors and credentials through the kernel, and its timeout reads EAGAIN", async () => {
    const pair: JObj[] = [await newObj("java/io/FileDescriptor"), await newObj("java/io/FileDescriptor")];
    await scall("android/system/Os", "socketpair", "(IIILjava/io/FileDescriptor;Ljava/io/FileDescriptor;)V", 1, 1, 0, pair[0], pair[1]);
    const socket = (fd: JObj) => newObj("android/net/LocalSocket", "(Ljava/io/FileDescriptor;)V", fd);
    const [a, b] = [await socket(pair[0]), await socket(pair[1])];
    vfs.write("/tmp/passed.txt", Uint8Array.of(42));
    const file = await newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", "/tmp/passed.txt");
    const fds = jarray(new Array(1).fill(null), "Ljava/io/FileDescriptor;");
    fds[0] = await vcall(file, "getFD", "()Ljava/io/FileDescriptor;");
    await vcall(a, "setFileDescriptorsForSend", "([Ljava/io/FileDescriptor;)V", fds);
    await vcall(await vcall(a, "getOutputStream", "()Ljava/io/OutputStream;"), "write", "(I)V", 7);
    await vcall(file, "close", "()V");
    expect(await vcall(await vcall(b, "getInputStream", "()Ljava/io/InputStream;"), "read", "()I")).toBe(7);
    const [passed] = await vcall(b, "getAncillaryFileDescriptors", "()[Ljava/io/FileDescriptor;");
    expect(await vcall(await newObj("java/io/FileInputStream", "(Ljava/io/FileDescriptor;)V", passed), "read", "()I")).toBe(42);
    const credentials = await vcall(b, "getPeerCredentials", "()Landroid/net/Credentials;");
    expect(await vcall(credentials, "getUid", "()I")).toBe(await scall("android/os/Process", "myUid", "()I"));
    await vcall(b, "setSoTimeout", "(I)V", 20);
    const input = await vcall(b, "getInputStream", "()Ljava/io/InputStream;");
    expect(await thrown(() => vcall(input, "read", "()I"))).toStartWith("java/io/IOException:");
    for (const s of [a, b]) await vcall(s, "close", "()V");
  });
  test("closing a LocalServerSocket ends the streams of connections it never accepted", async () => {
    const address = await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.pending");
    const server = await newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.pending");
    const client = await newObj("android/net/LocalSocket");
    await vcall(client, "connect", "(Landroid/net/LocalSocketAddress;)V", address);
    const read = vcall(await vcall(client, "getInputStream", "()Ljava/io/InputStream;"), "read", "()I");
    await vcall(server, "close", "()V");
    expect(await read).toBe(-1);
  });
});

describe("url-handlers", () => {
  test("URL resolves http, https and class path jar handlers as a device does", async () => {
    const connection = async (spec: string) => vcall(await newObj("java/net/URL", "(Ljava/lang/String;)V", spec), "openConnection", "()Ljava/net/URLConnection;");
    expect(iof(await connection("https://example.test/a"), "javax/net/ssl/HttpsURLConnection")).toBeTruthy();
    const http = await connection("http://example.test/a");
    expect(iof(http, "java/net/HttpURLConnection") && !iof(http, "javax/net/ssl/HttpsURLConnection")).toBeTruthy();
    const loader = await scall("java/lang/ClassLoader", "getSystemClassLoader", "()Ljava/lang/ClassLoader;");
    const url = await vcall(loader, "getResource", "(Ljava/lang/String;)Ljava/net/URL;", "calendars.properties");
    expect(await vcall(url, "toString", "()Ljava/lang/String;")).toBe("jar:file:/apex/com.android.art/javalib/core-oj.jar!/calendars.properties");
    const stream = await vcall(url, "openStream", "()Ljava/io/InputStream;");
    expect(await vcall(stream, "read", "()I")).toBe("#".charCodeAt(0));
  });
});

describe("ssl-parameters", () => {
  test("SSL sockets copy application protocols and report no selection before handshake", async () => {
    const socket = await newObj("javax/net/ssl/SSLSocket");
    const parameters = await vcall(socket, "getSSLParameters", "()Ljavax/net/ssl/SSLParameters;");
    const protocols = ["h2", "http/1.1"];
    await vcall(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", protocols);
    protocols[0] = "changed";
    await vcall(socket, "setSSLParameters", "(Ljavax/net/ssl/SSLParameters;)V", parameters);
    await vcall(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", ["changed"]);
    const stored = await vcall(socket, "getSSLParameters", "()Ljavax/net/ssl/SSLParameters;");
    expect(await vcall(stored, "getApplicationProtocols", "()[Ljava/lang/String;")).toEqual(["h2", "http/1.1"]);
    expect(await vcall(socket, "getApplicationProtocol", "()Ljava/lang/String;")).toBeNull();
    await expect(vcallAsync(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", [""])).rejects.toBeDefined();
  });

  test("SSLContext retains the selected protocol and provider", async () => {
    const initial = await scall("javax/net/ssl/SSLContext", "getDefault", "()Ljavax/net/ssl/SSLContext;");
    const provider = await vcall(initial, "getProvider", "()Ljava/security/Provider;");
    const context = await scall("javax/net/ssl/SSLContext", "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljavax/net/ssl/SSLContext;", "TLS", provider);
    expect(await vcall(context, "getProvider", "()Ljava/security/Provider;")).toBe(provider);
    expect(await vcall(context, "getProtocol", "()Ljava/lang/String;")).toBe("TLS");
    const engine = await vcall(context, "createSSLEngine", "()Ljavax/net/ssl/SSLEngine;");
    expect(await vcall(engine, "getApplicationProtocol", "()Ljava/lang/String;")).toBeNull();
  });
});
