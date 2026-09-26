import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { dialName, syntheticAddress } from "../src/shell/relay";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

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
