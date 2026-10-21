import { connect } from "cloudflare:sockets";
import { closeReason, MAX_PENDING_TCP_BYTES, TCP_CONNECT_FAILED, TCP_TOO_SLOW, tcpReady, tcpTarget } from "../src/shell/tcpwire.ts";
import { isPublicHost } from "../src/native/net-address.ts";

export async function tcpRelay(request: Request, context: ExecutionContext): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 400 });
  const target = tcpTarget(new URL(request.url));
  if (typeof target === "string") return new Response(target, { status: 400 });
  const { host, port, secure } = target;
  // nothing to reach on Cloudflare's own network; the guest's connect fails as unreachable
  if (!isPublicHost(host)) return new Response("unreachable target", { status: 403 });

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  let socket: ReturnType<typeof connect>;
  try { socket = connect({ hostname: host, port }, { secureTransport: secure ? "on" : "off", allowHalfOpen: false }); }
  catch (error) { server.close(TCP_CONNECT_FAILED, closeReason(String(error))); return new Response(null, { status: 101, webSocket: client }); }

  const writer = socket.writable.getWriter();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    void socket.close().catch(() => {});
  };
  void socket.closed.then(close, close);
  let writes = Promise.resolve(), pending = 0;
  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data === "shutdown") writes = writes.then(() => writer.close()).catch(close);
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if ((pending += bytes.length) > MAX_PENDING_TCP_BYTES) { server.close(TCP_TOO_SLOW, "TCP upstream is too slow"); close(); return; }
    writes = writes.then(() => writer.write(bytes)).then(() => { pending -= bytes.length; }).catch(close);
  });
  server.addEventListener("close", close);
  server.addEventListener("error", close);

  const pump = async () => {
    let ready = false;
    try {
      const info = await socket.opened;
      const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(info.localAddress ?? "");
      server.send(match ? tcpReady(match[1] ? "IPv6" : "IPv4", match[1] ?? match[2], Number(match[3]), "") : "ok");
      ready = true;
      const reader = socket.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        server.send(value);
      }
    } catch (error) {
      if (!closed && !ready) server.close(TCP_CONNECT_FAILED, closeReason(String(error)));
    } finally { close(); }
  };
  context.waitUntil(pump());
  return new Response(null, { status: 101, webSocket: client });
}
