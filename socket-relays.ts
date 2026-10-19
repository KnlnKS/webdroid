// The dev server's sockets for the page (server.ts): raw TCP and UDP, each over its own WebSocket.
import dgram from "node:dgram";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { RawData, WebSocket } from "ws";
import { parseIpv4 } from "./src/shell/relay.ts";

const MAX_PENDING_TCP_BYTES = 8 * 1024 * 1024;

// Raw TCP over a WebSocket. A page cannot open a socket, but every Java networking stack
// ultimately wants one, so the dev server lends it ours: one WS carries one TCP connection.
// Java sockets can ask the relay to terminate TLS; native stacks pass their own TLS bytes
// through the same relay unchanged.
// A text control frame means connected and carries the relay's local endpoint; a close before
// that means the connect failed. A plain "ok" (worker/tcp.ts, local address unparsed) also means connected.
//
// This is an outbound proxy for whatever the emulated app asks for — the same trust boundary
// as the dev server's /proxy, and the same reason both are dev-server-only: bound to loopback,
// never meant to face a network.
/** a WebSocket close reason, which holds 123 bytes: the message's printable ASCII */
const closeReason = (message: string) => message.replace(/[^ -~]/g, "?").slice(0, 123);

type TcpTarget = { host: string; port: number; alpn: string[]; secure: boolean };
/** the target a /tcp upgrade names, or why it is refused */
export function tcpTarget(url: URL): TcpTarget | string {
  const host = url.searchParams.get("host") ?? "", port = Number(url.searchParams.get("port")), alpn = url.searchParams.getAll("alpn");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return "bad target";
  if (alpn.length > 32 || alpn.some((p) => !p.length || Buffer.byteLength(p) > 255)) return "bad ALPN";
  return { host, port, alpn, secure: url.searchParams.get("tls") === "1" };
}

export function relayTcp(ws: WebSocket, { host, port, alpn, secure }: TcpTarget): void {
  let ready = false, connected = false, shut = false;
  const pending: Buffer[] = [];
  const socket: net.Socket = secure
    ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: alpn.length ? alpn : undefined })
    : net.connect({ host, port });
  // A TLS socket is ready at its handshake, not the TCP open: the ready control frame goes out
  // only once the socket can carry bytes, and anything that arrives before then is queued.
  const open = () => {
    ready = true;
    ws.send(JSON.stringify({ type: "ready", localFamily: socket.localFamily, localAddress: socket.localAddress,
      localPort: socket.localPort, alpn: (socket as tls.TLSSocket).alpnProtocol || "" }));
    for (const chunk of pending.splice(0)) socket.write(chunk);
    if (shut) socket.end();
  };
  socket.once("connect", () => { connected = true; if (!secure) open(); });
  if (secure) socket.once("secureConnect", open);
  socket.on("data", (chunk) => ws.send(chunk));
  socket.once("close", () => ws.close());
  socket.on("error", (e: NodeJS.ErrnoException) => {
    // the errno code leads, for the guest's connect(2) to report
    if (!connected) ws.close(4000, closeReason(`${e.code ?? ""} ${String(e)}`.trim()));
    else if (!ready) ws.close(4001, closeReason(String(e)));
    else ws.close();
  });
  ws.on("message", (data: RawData, binary: boolean) => {
    // the client's shutdown(SHUT_WR), once what it wrote before has gone
    if (!binary) { if (data.toString() === "shutdown") { shut = true; if (ready) socket.end(); } return; }
    if (shut) return;
    const chunk = data as Buffer;
    if (ready) socket.write(chunk); else pending.push(chunk);
    if (socket.writableLength + pending.reduce((n, c) => n + c.length, 0) > MAX_PENDING_TCP_BYTES) ws.close(4002, "TCP upstream is too slow");
  });
  ws.once("close", () => { pending.length = 0; socket.end(() => socket.destroy()); });
}

export function relayUdp(ws: WebSocket): void {
  const addresses = new Map<string, Promise<string>>(), names = new Map<string, string>();
  const socket = dgram.createSocket("udp4");
  // a reply names its source as the guest dialed it (the address is this server's resolution of
  // the name, which the guest never saw), framed as a request is
  socket.on("message", (bytes, { port, address }) => {
    if (!parseIpv4(address)) return;
    const name = new TextEncoder().encode(names.get(address) ?? address);
    const frame = new Uint8Array(3 + name.length + bytes.length);
    frame[0] = name.length; frame[1] = port >> 8; frame[2] = port & 255;
    frame.set(name, 3); frame.set(bytes, 3 + name.length);
    ws.send(frame);
  });
  let bound = false;
  // once bound, a failed send is a lost datagram
  socket.on("error", () => { if (!bound) ws.close(4000, "UDP bind failed"); });
  socket.bind(0, () => { bound = true; ws.send("ready"); });
  ws.on("message", async (data: RawData, binary: boolean) => {
    const msg = data as Buffer;
    if (!binary || msg.length < 3) return;
    const length = msg[0], port = msg[1] << 8 | msg[2];
    if (msg.length < 3 + length || !length || !port) return;
    const host = msg.subarray(3, 3 + length).toString();
    if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) return;
    try {
      let resolved = addresses.get(host);
      if (!resolved) {
        if (addresses.size >= 256) addresses.clear();
        resolved = dns.lookup(host, { family: 4 }).then((result) => result.address);
        addresses.set(host, resolved);
      }
      const address = await resolved;
      names.set(address, host);
      if (ws.readyState === ws.OPEN) socket.send(msg.subarray(3 + length), port, address);
    } catch { addresses.delete(host); }
  });
  ws.once("close", () => socket.close());
}
