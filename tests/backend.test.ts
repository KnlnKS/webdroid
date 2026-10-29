import { afterEach, expect, test, vi } from "vite-plus/test";
import { once } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import dns, { type LookupAddress } from "node:dns";
import { WebSocket } from "ws";
import { backendHost, attachSockets } from "../backend/server.ts";
import { localNetwork, publicNetwork, type Network } from "../backend/network.ts";
import { parseTcpReady, udpFrame } from "../src/shell/tcpwire.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
async function relay(network: Network = localNetwork) {
  const server = createServer(), sockets = attachSockets(server, backendHost({ network,
    isApp: origin => origin === "https://app.example", webviewOrigin: () => "https://renderer.example" }));
  cleanup.push(() => { for (const s of sockets) { for (const client of s.clients) client.terminate(); s.close(); } server.close(); });
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

test("production blocks private sockets and foreign browser origins", async () => {
  const url = await relay(publicNetwork), ws = peer(`${url}/tcp?host=169.254.169.254&port=80`);
  expect((await once(ws, "close"))[0]).toBe(4000);
  const foreign = peer(`${url}/udp`, "https://unrelated.example");
  const error = await new Promise<Error>(resolve => foreign.once("error", resolve));
  expect(error.message).toContain("403");
});

test("the public network reaches public addresses only, every address a name resolves to", async () => {
  const refused = { cause: { code: "ECONNREFUSED" } }, answer = (addresses: LookupAddress[]) =>
    vi.spyOn(dns, "lookup").mockImplementation(((_name: string, _options: object, callback: (e: null, a: LookupAddress[]) => void) => callback(null, addresses)) as never);
  await expect(publicNetwork.fetch!("http://169.254.169.254/", {})).rejects.toMatchObject(refused);
  await expect(publicNetwork.fetch!("http://[::ffff:127.0.0.1]/", {})).rejects.toMatchObject(refused);
  answer([{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]);
  await expect(publicNetwork.fetch!("http://example.com/", {})).rejects.toMatchObject(refused);
  // a connection falls back across all of them
  answer([{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
  expect(await new Promise(resolve => publicNetwork.lookup("example.com", { all: true }, (_e, all) => resolve(all)))).toHaveLength(2);
});
