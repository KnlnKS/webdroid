import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { dialName, syntheticAddress } from "../src/shell/relay";
import { systemService } from "../src/android/context";
import { scall } from "./java";

describe("datagram-socket", () => {
  test("DatagramSocket delivers loopback packets and preserves source metadata", async () => {
    const receiver = await newObj("java/net/DatagramSocket", "()V");
    const sender = await newObj("java/net/DatagramSocket", "()V");
    const port = await vcall(receiver, "getLocalPort", "()I") as number;
    const loopback = await vcall(rt.link("java/net/InetAddress").ctor, "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "localhost");
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
  rt.linkNatives();

  test("HTTP headers and incremental reads do not await the entire response, and timed-out reads remain usable", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
      start(c) { controller = c; c.enqueue(Uint8Array.of(1, 2, 3)); },
    }), { headers: { "content-type": "application/octet-stream", "x-wd-content-length": "7", "x-wd-final-url": "https://example.test/stream" } }) });
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      original(new URL(String(input), server.url), init), { preconnect: original.preconnect });
    try {
      const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/stream");
      const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
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
      if (!controller) throw new Error("No response stream");
      controller.enqueue(Uint8Array.of(4, 5, 6, 7));
      expect(await vcall(stream, "skip", "(J)J", 2n)).toBe(2n);
      expect(await vcall(stream, "read", "()I")).toBe(6);
      expect(await vcall(stream, "read", "()I")).toBe(7);
      controller.close();
      expect(await vcall(stream, "read", "()I")).toBe(-1);
      expect(await vcall(stream, "read", "([BII)I", out, 0, 0)).toBe(0);
      expect(await vcall(stream, "markSupported", "()Z")).toBe(0);
      await vcall(connection, "disconnect", "()V");
      await expect(vcallAsync(stream, "read", "()I")).rejects.toMatchObject({ msg: "Stream closed" });
    } finally { globalThis.fetch = original; server.stop(true); }
  }, 5000);

  test("HttpURLConnection preserves a redirect when following is disabled", async () => {
    const seen: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const query = new URL(request.url).searchParams;
      seen.push(query.get("manual") ?? "");
      return new Response(null, { headers: {
        "x-wd-status": "302", "x-wd-status-text": "Found", "x-wd-final-url": "https://example.test/start",
        location: "/next",
      } });
    } });
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      original(new URL(String(input), server.url), init), { preconnect: original.preconnect });
    try {
      const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/start");
      const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
      await vcall(connection, "setInstanceFollowRedirects", "(Z)V", 0);
      expect(await vcall(connection, "getResponseCode", "()I")).toBe(302);
      expect(await vcall(connection, "getResponseMessage", "()Ljava/lang/String;")).toBe("Found");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", null)).toBe("HTTP/1.1 302 Found");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "location")).toBe("/next");
      expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "x-wd-status")).toBeNull();
      expect(seen).toEqual(["1"]);
    } finally { globalThis.fetch = original; server.stop(true); }
  });
});

describe("http-upload", () => {
  rt.linkNatives();
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
  rt.linkNatives();

  test("InetAddress hands out the resolver's synthetic address, which dials the name again", async () => {
    const a = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "v16m.example.com");
    const text = await vcall(a, "getHostAddress", "()Ljava/lang/String;");
    expect(text).toMatch(/^198\.1[89]\.\d+\.\d+$/);
    expect(text).toBe(syntheticAddress("v16m.example.com").join("."));
    expect(await vcall(a, "toString", "()Ljava/lang/String;")).toBe("v16m.example.com/" + text);
    expect(rt.iof(a, "java/net/Inet4Address")).toBeTruthy();
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

  test("createUnresolved keeps the host without resolving its address", async () => {
    const socket = await scall("java/net/InetSocketAddress", "createUnresolved",
      "(Ljava/lang/String;I)Ljava/net/InetSocketAddress;", "example.com", 443);
    expect(await vcall(socket, "getHostString", "()Ljava/lang/String;")).toBe("example.com");
    expect(await vcall(socket, "isUnresolved", "()Z")).toBe(1);
    expect(await vcall(socket, "getAddress", "()Ljava/net/InetAddress;")).toBeNull();
  });

  test("SSL wrapping keeps the underlying socket open until the wrapper closes", async () => {
    const plain = rt.make("java/net/Socket");
    const factory = await scall("javax/net/ssl/SSLSocketFactory", "getDefault", "()Ljavax/net/SocketFactory;");
    const secure = await vcall(factory, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;", plain, "example.com", 443, 1);
    expect(await vcall(plain, "isClosed", "()Z")).toBe(0);
    await vcall(secure, "close", "()V");
    expect(await vcall(plain, "isClosed", "()Z")).toBe(1);
    const retained = rt.make("java/net/Socket");
    const independent = await vcall(factory, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;", retained, "example.com", 443, 0);
    await vcall(independent, "close", "()V");
    expect(await vcall(retained, "isClosed", "()Z")).toBe(0);
  });

  test("the platform trust manager accepts relay-verified peers", async () => {
    const socket = Object.assign(rt.make("javax/net/ssl/SSLSocket"), { host: "example.com" });
    const session = await vcall(socket, "getSession", "()Ljavax/net/ssl/SSLSession;");
    const chain = await vcall(session, "getPeerCertificates", "()[Ljava/security/cert/Certificate;");
    const factory = await scall("javax/net/ssl/TrustManagerFactory", "getInstance",
      "(Ljava/lang/String;)Ljavax/net/ssl/TrustManagerFactory;", "PKIX");
    const managers = await vcall(factory, "getTrustManagers", "()[Ljavax/net/ssl/TrustManager;");
    await expect(vcallAsync(managers[0], "checkServerTrusted", "([Ljava/security/cert/X509Certificate;Ljava/lang/String;)V", chain, "RSA")).resolves.toBeUndefined();
    const verifier = await scall("javax/net/ssl/HttpsURLConnection", "getDefaultHostnameVerifier", "()Ljavax/net/ssl/HostnameVerifier;");
    expect(await vcall(verifier, "verify", "(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z", "EXAMPLE.COM.", session)).toBe(1);
    expect(await vcall(verifier, "verify", "(Ljava/lang/String;Ljavax/net/ssl/SSLSession;)Z", "other.example", session)).toBe(0);
  });
});

describe("localsocket", () => {
  rt.linkNatives();

  test("LocalServerSocket accepts an in-process LocalSocket and streams bytes both ways", async () => {
    const server = await newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock");
    await expect((async () => newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock"))()).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
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
    await expect(vcallAsync(late, "connect", "(Landroid/net/LocalSocketAddress;)V", await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.sock"))).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
  });

  test("collections are instances of their abstract supers", async () => {
    expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractCollection")).toBe(1);
    expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractSet")).toBe(1);
    expect(rt.iof(await newObj("java/util/ArrayList"), "java/util/AbstractList")).toBe(1);
    expect(rt.iof(await newObj("java/util/HashMap"), "java/util/AbstractMap")).toBe(1);
    expect(rt.iof(await newObj("java/util/Stack"), "java/util/Vector")).toBe(1);
  });
});

describe("network-request", () => {
  rt.linkNatives();

  test("NetworkRequest builder includes other UID networks fluently", async () => {
    const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
    expect(await vcall(builder, "setIncludeOtherUidNetworks", "(Z)Landroid/net/NetworkRequest$Builder;", 1)).toBe(builder);
    const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
    expect(request).not.toBeNull();
  });

  test("NetworkRequest exposes the builder's network specifier", async () => {
    const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
    const specifier = rt.make("android/net/NetworkSpecifier");
    expect(await vcall(builder, "setNetworkSpecifier", "(Landroid/net/NetworkSpecifier;)Landroid/net/NetworkRequest$Builder;", specifier)).toBe(builder);
    const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
    expect(await vcall(request, "getNetworkSpecifier", "()Landroid/net/NetworkSpecifier;")).toBe(specifier);

    const empty = await newObj("android/net/NetworkRequest$Builder", "()V");
    const emptyRequest = await vcall(empty, "build", "()Landroid/net/NetworkRequest;");
    expect(await vcall(emptyRequest, "getNetworkSpecifier", "()Landroid/net/NetworkSpecifier;")).toBeNull();
  });

  test("NetworkRequest exposes a defensive array of transport types", async () => {
    const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
    await vcall(builder, "addTransportType", "(I)Landroid/net/NetworkRequest$Builder;", 3);
    await vcall(builder, "addTransportType", "(I)Landroid/net/NetworkRequest$Builder;", 1);
    await vcall(builder, "addTransportType", "(I)Landroid/net/NetworkRequest$Builder;", 3);
    const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
    const transports = await vcall(request, "getTransportTypes", "()[I") as Int32Array;
    expect([...transports]).toEqual([1, 3]);
    transports[0] = 7;
    expect([...(await vcall(request, "getTransportTypes", "()[I") as Int32Array)]).toEqual([1, 3]);
  });

  test("NetworkRequest exposes a defensive array of capabilities", async () => {
    const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
    await vcall(builder, "addCapability", "(I)Landroid/net/NetworkRequest$Builder;", 12);
    await vcall(builder, "addCapability", "(I)Landroid/net/NetworkRequest$Builder;", 5);
    await vcall(builder, "addCapability", "(I)Landroid/net/NetworkRequest$Builder;", 12);
    const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
    const capabilities = await vcall(request, "getCapabilities", "()[I") as Int32Array;
    expect([...capabilities]).toEqual([5, 12]);
    capabilities[0] = 7;
    expect([...(await vcall(request, "getCapabilities", "()[I") as Int32Array)]).toEqual([5, 12]);
  });
});

describe("network-stats", () => {
  rt.linkNatives();

  test("network stats expose an empty supported query", async () => {
    const context = rt.make("android/content/Context");
    const manager = systemService(context, "netstats");
    expect(rt.iof(manager, "android/app/usage/NetworkStatsManager")).toBe(1);
    const stats = await vcall(manager, "querySummary", "(ILjava/lang/String;JJ)Landroid/app/usage/NetworkStats;", 1, null, 0n, 1n);
    expect(await vcall(stats, "hasNextBucket", "()Z")).toBe(0);
    const bucket = await newObj("android/app/usage/NetworkStats$Bucket");
    expect(await vcall(stats, "getNextBucket", "(Landroid/app/usage/NetworkStats$Bucket;)Z", bucket)).toBe(0);
    expect(await vcall(bucket, "getUid", "()I")).toBe(-1);
    expect(await vcall(bucket, "getRxBytes", "()J")).toBe(0n);
    expect(await vcall(bucket, "getTxBytes", "()J")).toBe(0n);
  });
});

describe("nsd-service", () => {
  let failure: { serviceType: string; code: number } | null = null;
  let finish: (() => void) | null = null;
  class DiscoveryListener extends JObj {}
  rt.register({
    name: "test/DiscoveryListener", ctor: DiscoveryListener,
    ifaces: ["android/net/nsd/NsdManager$DiscoveryListener"],
    methods: {
      "onStartDiscoveryFailed(Ljava/lang/String;I)V": (serviceType: string, code: number) => {
        failure = { serviceType, code };
        finish?.();
      },
    },
  });
  rt.linkNatives();

  test("NSD reports unavailable multicast discovery without fabricated services", async () => {
    const context = rt.make("android/content/Context");
    const manager = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "servicediscovery");
    expect(manager).not.toBeNull();
    const callback = new Promise<void>((resolve) => { finish = resolve; });
    await vcall(manager, "discoverServices", "(Ljava/lang/String;ILandroid/net/nsd/NsdManager$DiscoveryListener;)V",
      "_googlecast._tcp.", 1, rt.make("test/DiscoveryListener"));
    await callback;
    expect(failure).toEqual({ serviceType: "_googlecast._tcp.", code: 0 });
  });
});

describe("uri-raw-authority", () => {
  rt.linkNatives();

  test("URI.getRawAuthority preserves escaped authority text", async () => {
    const uri = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://user%20name@example.com:8443/a?q=1");
    expect(await vcall(uri, "getRawAuthority", "()Ljava/lang/String;")).toBe("user%20name@example.com:8443");
    expect(await vcall(uri, "getAuthority", "()Ljava/lang/String;")).toBe("user name@example.com:8443");
    const relative = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "//example.test/path");
    expect(await vcall(relative, "getRawAuthority", "()Ljava/lang/String;")).toBe("example.test");
    const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test");
    expect(await vcall(opaque, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
    const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "file:///tmp/video.mp4");
    expect(await vcall(empty, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
    expect(await vcall(empty, "getAuthority", "()Ljava/lang/String;")).toBeNull();
  });

  test("URI.getRawUserInfo preserves escaped credentials", async () => {
    const uri = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://user%20name:p%40ss@example.com/path");
    expect(await vcall(uri, "getRawUserInfo", "()Ljava/lang/String;")).toBe("user%20name:p%40ss");
    expect(await vcall(uri, "getUserInfo", "()Ljava/lang/String;")).toBe("user name:p@ss");
    const anonymous = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.com/path");
    expect(await vcall(anonymous, "getRawUserInfo", "()Ljava/lang/String;")).toBeNull();
  });

  test("URI.getRawQuery preserves the hierarchical query component", async () => {
    const escaped = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/a?name=a%20b&path=%2F#fragment");
    expect(await vcall(escaped, "getRawQuery", "()Ljava/lang/String;")).toBe("name=a%20b&path=%2F");
    const relative = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "a/b?x=1");
    expect(await vcall(relative, "getRawQuery", "()Ljava/lang/String;")).toBe("x=1");
    const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/path?#fragment");
    expect(await vcall(empty, "getRawQuery", "()Ljava/lang/String;")).toBe("");
    const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test?subject=hello");
    expect(await vcall(opaque, "getRawQuery", "()Ljava/lang/String;")).toBeNull();
  });

  test("URI.getRawFragment preserves escaped and empty fragments", async () => {
    const escaped = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/a?q=1#section%202%2F3");
    expect(await vcall(escaped, "getRawFragment", "()Ljava/lang/String;")).toBe("section%202%2F3");
    const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test#contact%20card");
    expect(await vcall(opaque, "getRawFragment", "()Ljava/lang/String;")).toBe("contact%20card");
    const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "relative#");
    expect(await vcall(empty, "getRawFragment", "()Ljava/lang/String;")).toBe("");
    const absent = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "relative");
    expect(await vcall(absent, "getRawFragment", "()Ljava/lang/String;")).toBeNull();
  });
});

describe("uri-syntax", () => {
  rt.linkNatives();
  test("URI syntax exceptions preserve input, reason and optional index", async () => {
    const error = await newObj("java/net/URISyntaxException", "(Ljava/lang/String;Ljava/lang/String;I)V", "a b", "Illegal character", 1);
    expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("Illegal character at index 1: a b");
    expect(await vcall(error, "getInput", "()Ljava/lang/String;")).toBe("a b");
    expect(await vcall(error, "getReason", "()Ljava/lang/String;")).toBe("Illegal character");
    expect(await vcall(error, "getIndex", "()I")).toBe(1);
  });
  test("URI parses relative authorities without URL normalization", async () => {
    for (const [text, host, port, path] of [
      ["//API.example.com:443/a%20b", "API.example.com", 443, "/a b"],
      ["//example.com:0", "example.com", 0, ""],
      ["//[::1]:443/", "[::1]", 443, "/"],
      ["dns:///example.com", null, -1, "/example.com"],
      ["mailto:a@example.com", null, -1, null],
    ]) {
      const uri = await newObj("java/net/URI", "(Ljava/lang/String;)V", text);
      expect(await vcall(uri, "getHost", "()Ljava/lang/String;")).toBe(host);
      expect(await vcall(uri, "getPort", "()I")).toBe(port);
      expect(await vcall(uri, "getPath", "()Ljava/lang/String;")).toBe(path);
    }
  });
  test("URI component construction quotes delimiters and retains empty query and fragment", async () => {
    const uri = await newObj("java/net/URI", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V", "https", "example.com:443", "/a b?c", "", "");
    expect(await vcall(uri, "toString", "()Ljava/lang/String;")).toBe("https://example.com:443/a%20b%3Fc?#");
    expect(await vcall(uri, "getPath", "()Ljava/lang/String;")).toBe("/a b?c");
    expect(await vcall(uri, "getQuery", "()Ljava/lang/String;")).toBe("");
  });
});

describe("url-empty-authority", () => {
  rt.linkNatives();

  test("URL preserves Android's empty HTTP authority", async () => {
    for (const [spec, path, query] of [
      ["http://", "", null],
      ["http:///path", "/path", null],
      ["http://?query", "", "query"],
    ] as const) {
      const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", spec);
      expect(await vcall(url, "getAuthority", "()Ljava/lang/String;")).toBe("");
      expect(await vcall(url, "getHost", "()Ljava/lang/String;")).toBe("");
      expect(await vcall(url, "getPath", "()Ljava/lang/String;")).toBe(path);
      expect(await vcall(url, "getQuery", "()Ljava/lang/String;")).toBe(query);
      expect(await vcall(url, "toString", "()Ljava/lang/String;")).toBe(spec);
    }
  });
});

describe("urlconnection-mime", () => {
  rt.linkNatives();

  test("URLConnection guesses names using Android fragment and directory rules", async () => {
    const guess = (name: string | null) => vcallAsync(rt.link("java/net/URLConnection").ctor, "guessContentTypeFromName", "(Ljava/lang/String;)Ljava/lang/String;", name);
    expect(await guess("/assets/INDEX.HTML#part")).toBe("text/html");
    expect(await guess("/assets/")).toBe("text/html");
    expect(await guess("html")).toBe("text/html");
    expect(await guess("/html")).toBeNull();
    expect(await guess("page.html?query=1")).toBeNull();
    expect(await guess("unknown.extension")).toBeNull();
    const error = await guess(null).then(() => null, e => e);
    expect(rt.iof(error, "java/lang/NullPointerException")).toBeTruthy();
  });
});

describe("wifi", () => {
  rt.linkNatives();

  const signalLevel = (rssi: number, levels: number) =>
    (rt.link("android/net/wifi/WifiManager").ctor as unknown as Record<string, (rssi: number, levels: number) => number>)[
      mangleMethod("calculateSignalLevel", "(II)I")
    ](rssi, levels);

  test("WifiManager retains its DHCP and redacted connection state", async () => {
    const wifi = rt.make("android/net/wifi/WifiManager");
    expect(await vcall(wifi, "getDhcpInfo", "()Landroid/net/DhcpInfo;")).not.toBeNull();
    const info = await vcall(wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;");
    expect(await vcall(info, "getSSID", "()Ljava/lang/String;")).toBe("<unknown ssid>");
  });

  test("WifiManager clamps and truncates signal levels like Android", () => {
    expect(signalLevel(-101, 5)).toBe(0);
    expect(signalLevel(-100, 5)).toBe(0);
    expect(signalLevel(-89, 5)).toBe(0);
    expect(signalLevel(-77, 5)).toBe(2);
    expect(signalLevel(-56, 5)).toBe(3);
    expect(signalLevel(-55, 5)).toBe(4);
    expect(signalLevel(-54, 5)).toBe(4);
    expect(signalLevel(-77, 9)).toBe(4);
    expect(signalLevel(-77, 1)).toBe(0);
  });
});
