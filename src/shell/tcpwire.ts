// The /tcp relay's wire, between relay.ts and the relay (socket-relays.ts):
// one WebSocket carries one TCP connection, its binary frames the bytes. The relay's first text frame says
// it connected (and, when it can, its local endpoint); a close before it says why not. The client's
// "shutdown" text frame is its shutdown(SHUT_WR).

export type TcpTarget = { host: string; port: number; alpn: string[]; secure: boolean };
/** the target a /tcp upgrade names, or why it is refused */
export function tcpTarget(url: URL): TcpTarget | string {
  const host = url.searchParams.get("host") ?? "", port = Number(url.searchParams.get("port")), alpn = url.searchParams.getAll("alpn");
  if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) return "bad target";
  if (alpn.length > 32 || alpn.some((p) => !p.length || new TextEncoder().encode(p).length > 255)) return "bad ALPN";
  return { host, port, alpn, secure: url.searchParams.get("tls") === "1" };
}

export type RelayEndpoint = { family: "IPv4" | "IPv6"; address: string; port: number };
/** the frame that opens a relayed connection */
export const tcpReady = (localFamily: string | undefined, localAddress: string | undefined, localPort: number | undefined, alpn: string): string =>
  JSON.stringify({ type: "ready", localFamily, localAddress, localPort, alpn });
/** what the first text frame says of the connection: any such frame means connected */
export function parseTcpReady(data: string): { local: RelayEndpoint | null; alpn: string } {
  try {
    const m = JSON.parse(data) as { type?: unknown; localFamily?: unknown; localAddress?: unknown; localPort?: unknown; alpn?: unknown };
    if (m.type === "ready" && (m.localFamily === "IPv4" || m.localFamily === "IPv6") && typeof m.localAddress === "string"
      && Number.isInteger(m.localPort) && Number(m.localPort) >= 1 && Number(m.localPort) <= 65535)
      return { local: { family: m.localFamily, address: m.localAddress, port: Number(m.localPort) }, alpn: typeof m.alpn === "string" ? m.alpn : "" };
  } catch { /* "ok": a relay that could not read its local address */ }
  return { local: null, alpn: "" };
}

/** the close codes before the ready frame: the connect failed (its reason leads with the errno when there
 *  is one, which the guest's connect(2) reports), or the TLS handshake did; and a client that sends faster
 *  than the upstream takes past MAX_PENDING_TCP_BYTES */
export const TCP_CONNECT_FAILED = 4000, TCP_HANDSHAKE_FAILED = 4001, TCP_TOO_SLOW = 4002;
export const MAX_PENDING_TCP_BYTES = 8 * 1024 * 1024;
/** a WebSocket close reason, which holds 123 bytes: the message's printable ASCII */
export const closeReason = (message: string) => message.replace(/[^ -~]/g, "?").slice(0, 123);

/** a /udp relay frame, each way: the name's length, the port, the name the peer is dialed by, then the datagram */
export function udpFrame(name: Uint8Array, port: number, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(3 + name.length + bytes.length);
  frame[0] = name.length; frame[1] = port >> 8; frame[2] = port & 255;
  frame.set(name, 3); frame.set(bytes, 3 + name.length);
  return frame;
}
