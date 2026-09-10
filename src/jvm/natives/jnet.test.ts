import { expect, test } from "bun:test";
import "../../natives";
import { rt } from "../runtime";
import { mangleMethod } from "../abi";
import { newObj, vcall } from "./jlang";

test("wrapped TLS sockets open one relay for concurrent input and output", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location"), requests: string[] = [];
  let complete!: (bytes: number[]) => void;
  const received = new Promise<number[]>((resolve) => { complete = resolve; });
  const server = Bun.serve({
    port: 0,
    fetch(request, server) { requests.push(new URL(request.url).search); if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(socket) { socket.send("ok"); socket.send(new Uint8Array([17, 23])); },
      message(_socket, bytes) { complete([...new Uint8Array(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)]); },
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost:" + server.port } });
  let socket: unknown;
  try {
    const factory = rt.link("javax/net/ssl/SSLContext").ctor[mangleMethod("getDefault", "()Ljavax/net/ssl/SSLContext;")]();
    const ssl = await vcall(factory, "getSocketFactory", "()Ljavax/net/ssl/SSLSocketFactory;");
    socket = await vcall(ssl, "createSocket", "(Ljava/net/Socket;Ljava/lang/String;IZ)Ljava/net/Socket;", await newObj("java/net/Socket"), "test.invalid", 443, 1);
    const input = await vcall(socket, "getInputStream", "()Ljava/io/InputStream;"), output = await vcall(socket, "getOutputStream", "()Ljava/io/OutputStream;");
    const [first] = await Promise.all([vcall(input, "read", "()I"), vcall(output, "write", "([B)V", new Int8Array([29, 31]))]);
    expect(first).toBe(17); expect(await vcall(input, "read", "()I")).toBe(23);
    expect(await received).toEqual([29, 31]);
    expect(requests).toEqual(["?host=test.invalid&port=443&tls=1"]);
    await vcall(socket, "close", "()V");
    await expect(vcall(output, "write", "(I)V", 1)).rejects.toBeTruthy();
  } finally {
    if (socket) await vcall(socket, "close", "()V");
    await server.stop(true);
    if (previous) Object.defineProperty(globalThis, "location", previous); else Reflect.deleteProperty(globalThis, "location");
  }
});
