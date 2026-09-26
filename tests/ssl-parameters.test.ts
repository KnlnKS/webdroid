import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
rt.linkNatives();

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
  const cls = rt.link("javax/net/ssl/SSLContext").ctor;
  const initial = await vcall(cls, "getDefault", "()Ljavax/net/ssl/SSLContext;");
  const provider = await vcall(initial, "getProvider", "()Ljava/security/Provider;");
  const context = await vcall(cls, "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljavax/net/ssl/SSLContext;", "TLS", provider);
  expect(await vcall(context, "getProvider", "()Ljava/security/Provider;")).toBe(provider);
  expect(await vcall(context, "getProtocol", "()Ljava/lang/String;")).toBe("TLS");
  const engine = await vcall(context, "createSSLEngine", "()Ljavax/net/ssl/SSLEngine;");
  expect(await vcall(engine, "getApplicationProtocol", "()Ljava/lang/String;")).toBeNull();
});
