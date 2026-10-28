import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { LookupAddress } from "node:dns";
import type { WebSocket } from "ws";
import { closeReason, MAX_PENDING_TCP_BYTES, TCP_CONNECT_FAILED, TCP_HANDSHAKE_FAILED, TCP_TOO_SLOW, tcpReady, udpFrame, type TcpTarget } from "./src/shell/tcpwire.ts";

type Resolve = (host: string, family?: number) => Promise<LookupAddress[]>;

export async function relayTcp(ws: WebSocket, { host, port, alpn, secure }: TcpTarget, resolve?: Resolve): Promise<void> {
  let address = host;
  if (resolve) {
    ws.pause();
    try { address = (await resolve(host))[0].address; }
    catch (error) { ws.close(TCP_CONNECT_FAILED, closeReason(String(error))); ws.resume(); return; }
    if (ws.readyState !== ws.OPEN) return;
  }
  let ready = false, connected = false, shut = false, pendingBytes = 0;
  const pending: Buffer[] = [];
  const socket: net.Socket = secure
    ? tls.connect({ host: address, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: alpn.length ? alpn : undefined })
    : net.connect({ host: address, port });
  const open = () => {
    ready = true;
    socket.setTimeout(0);
    ws.send(tcpReady(socket.localFamily, socket.localAddress, socket.localPort, (socket as tls.TLSSocket).alpnProtocol || ""));
    for (const chunk of pending.splice(0)) socket.write(chunk);
    pendingBytes = 0;
    if (shut) socket.end();
  };
  socket.setTimeout(30_000, () => socket.destroy(Object.assign(new Error("Connect timeout"), { code: "ETIMEDOUT" })));
  socket.once("connect", () => { connected = true; if (!secure) open(); });
  if (secure) socket.once("secureConnect", open);
  socket.on("data", chunk => {
    if (ws.readyState !== ws.OPEN) return;
    socket.pause();
    ws.send(chunk, error => { if (error) socket.destroy(); else socket.resume(); });
  });
  socket.once("close", () => ws.close());
  socket.on("error", (e: NodeJS.ErrnoException) => {
    if (!connected) ws.close(TCP_CONNECT_FAILED, closeReason(`${e.code ?? ""} ${String(e)}`.trim()));
    else if (!ready) ws.close(TCP_HANDSHAKE_FAILED, closeReason(String(e)));
    else ws.close();
  });
  ws.on("message", (data, binary) => {
    if (!binary) { if (data.toString() === "shutdown") { shut = true; if (ready) socket.end(); } return; }
    if (shut) return;
    const chunk = data as Buffer;
    if (ready) socket.write(chunk); else { pending.push(chunk); pendingBytes += chunk.length; }
    if (socket.writableLength + pendingBytes > MAX_PENDING_TCP_BYTES) {
      ws.close(TCP_TOO_SLOW, "TCP upstream is too slow");
      socket.destroy();
    }
  });
  ws.once("close", () => {
    pending.length = 0;
    if (!ready) socket.destroy();
    else {
      socket.end(() => socket.destroy());
      const deadline = setTimeout(() => socket.destroy(), 5000).unref();
      socket.once("close", () => clearTimeout(deadline));
    }
  });
  if (resolve) ws.resume();
}

export function relayUdp(ws: WebSocket, resolve: Resolve = (host, family) => dns.lookup(host, { family, all: true })): void {
  const addresses = new Map<string, Promise<string>>(), peers = new Map<string, string>();
  const socket = dgram.createSocket("udp4");
  socket.on("message", (bytes, { port, address }) => {
    const name = peers.get(`${address}:${port}`);
    if (name && ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_PENDING_TCP_BYTES)
      ws.send(udpFrame(new TextEncoder().encode(name), port, bytes));
  });
  let bound = false, closed = false, pending = 0;
  socket.on("error", () => { if (!bound) ws.close(4000, "UDP bind failed"); });
  socket.bind(0, () => {
    bound = true;
    if (closed) socket.close(); else ws.send("ready");
  });
  ws.on("message", async (data, binary) => {
    const msg = data as Buffer;
    if (!binary || msg.length < 3 || closed || !bound || pending >= 64) return;
    const length = msg[0], port = msg[1] << 8 | msg[2];
    if (msg.length < 3 + length || msg.length - 3 - length > 65507 || !length || !port) return;
    const host = msg.subarray(3, 3 + length).toString();
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) return;
    pending++;
    try {
      let resolved = addresses.get(host);
      if (!resolved) {
        if (addresses.size >= 256) addresses.clear();
        resolved = resolve(host, 4).then(result => result[0].address);
        addresses.set(host, resolved);
      }
      const address = await resolved;
      if (closed) return;
      if (peers.size >= 256) peers.clear();
      peers.set(`${address}:${port}`, host);
      socket.send(msg.subarray(3 + length), port, address, () => {});
    } catch { addresses.delete(host); }
    finally { pending--; }
  });
  ws.once("close", () => { closed = true; if (bound) socket.close(); });
}
