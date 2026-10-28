import { afterEach, expect, test, vi } from "vite-plus/test";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { WebSocket, WebSocketServer } from "ws";
import { relayTcp } from "../socket-relays.ts";
import { backendHost, attachSockets } from "../backend/server.ts";
import { publicFetch, resolvePublic } from "../backend/network.ts";
import { parseTcpReady, udpFrame } from "../src/shell/tcpwire.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function relay(publicOnly = false) {
  const server = createServer(), sockets = attachSockets(server, backendHost({ publicOnly,
    isApp: origin => origin === "https://app.example", webviewOrigin: () => "https://renderer.example" }));
  cleanup.push(() => { for (const client of sockets.clients) client.terminate(); sockets.close(); server.close(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}
function peer(url: string, origin = "https://app.example") {
  const ws = new WebSocket(url, { origin }); cleanup.push(() => ws.terminate()); return ws;
}

test("TCP relays bytes, local endpoint and write shutdown", async () => {
  const upstream = net.createServer(socket => { socket.on("data", data => socket.write(data)); socket.on("error", () => {}); });
  cleanup.push(() => upstream.close()); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const ws = peer(`${await relay()}/tcp?host=127.0.0.1&port=${(upstream.address() as net.AddressInfo).port}`);
  const [ready] = await once(ws, "message");
  expect(parseTcpReady(ready.toString()).local?.address).toBe("127.0.0.1");
  ws.send(Buffer.from([0, 1, 255]));
  expect((await once(ws, "message"))[0]).toEqual(Buffer.from([0, 1, 255]));
  ws.send("shutdown"); await once(ws, "close");
});

test("UDP preserves datagrams and the requested peer name", async () => {
  const upstream = dgram.createSocket("udp4"); cleanup.push(() => upstream.close());
  upstream.on("message", (bytes, peer) => upstream.send(bytes, peer.port, peer.address));
  upstream.bind(0, "127.0.0.1"); await once(upstream, "listening");
  const ws = peer(`${await relay()}/udp`);
  expect((await once(ws, "message"))[0].toString()).toBe("ready");
  const frame = udpFrame(new TextEncoder().encode("localhost"), upstream.address().port, new Uint8Array([1, 2, 3]));
  ws.send(frame);
  expect((await once(ws, "message"))[0]).toEqual(Buffer.from(frame));
});

test("TCP tries the remaining checked DNS addresses when the first is unavailable", async () => {
  const upstream = net.createServer(socket => socket.end("connected"));
  cleanup.push(() => upstream.close()); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  cleanup.push(() => server.close()); await once(server, "listening");
  server.on("connection", ws => void relayTcp(ws, { host: "checked.example", port: (upstream.address() as net.AddressInfo).port, secure: false, alpn: [] },
    async () => [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]));
  const ws = peer(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`), messages: Buffer[] = [];
  ws.on("message", bytes => messages.push(bytes as Buffer));
  await once(ws, "close");
  expect(messages.at(-1)?.toString()).toBe("connected");
});

test("production blocks private sockets and foreign browser origins", async () => {
  const url = await relay(true), ws = peer(`${url}/tcp?host=169.254.169.254&port=80`);
  expect((await once(ws, "close"))[0]).toBe(4000);
  const foreign = peer(`${url}/udp`, "https://unrelated.example");
  const error = await new Promise<Error>(resolve => foreign.once("error", resolve));
  expect(error.message).toContain("403");
});

test("HTTP and DNS reject private destinations, including mixed DNS answers", async () => {
  await expect(publicFetch("http://169.254.169.254/", {})).rejects.toThrow("Private network");
  await expect(publicFetch("http://[::ffff:127.0.0.1]/", {})).rejects.toThrow("Private network");
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }] as never);
  await expect(resolvePublic("example.com")).rejects.toThrow("Private network");
  await expect(publicFetch("http://example.com/", {})).rejects.toMatchObject({ cause: { message: "Private network is unreachable" } });
});
