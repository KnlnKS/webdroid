import { connect } from "cloudflare:sockets";

export async function tcpRelay(request: Request, context: ExecutionContext): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 400 });
  const query = new URL(request.url).searchParams;
  const host = query.get("host") ?? "", port = Number(query.get("port"));
  if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) return new Response("bad target", { status: 400 });
  const alpn = query.getAll("alpn");
  if (alpn.length > 32 || alpn.some((item) => !item.length || new TextEncoder().encode(item).length > 255)) return new Response("bad ALPN", { status: 400 });

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let socket: ReturnType<typeof connect>;
  try { socket = connect({ hostname: host, port }, { secureTransport: query.get("tls") === "1" ? "on" : "off", allowHalfOpen: false }); }
  catch (error) { server.close(4000, String(error).slice(0, 100)); return new Response(null, { status: 101, webSocket: client }); }

  const writer = socket.writable.getWriter();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* already closed */ }
    void socket.close().catch(() => {});
  };
  void socket.closed.then(close, close);
  let writes = Promise.resolve();
  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    writes = writes.then(async () => {
      const bytes = event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : new Uint8Array(event.data);
      await writer.write(bytes);
    }).catch(close);
  });
  server.addEventListener("close", close);
  server.addEventListener("error", close);

  const pump = async () => {
    try {
      const info = await socket.opened;
      const address = info.localAddress ?? "";
      const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(address);
      server.send(match ? JSON.stringify({ type: "ready", localFamily: match[1] ? "IPv6" : "IPv4",
        localAddress: match[1] ?? match[2], localPort: Number(match[3]), alpn: "" }) : "ok");
      const reader = socket.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        server.send(value);
      }
    } catch (error) {
      if (!closed) server.close(4001, String(error).slice(0, 100));
    } finally { close(); }
  };
  context.waitUntil(pump());
  return new Response(null, { status: 101, webSocket: client });
}
