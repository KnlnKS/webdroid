import { connect } from "cloudflare:sockets";
import { tcpReady, tcpTarget } from "../src/shell/serve-routes.ts";
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
  catch (error) { server.close(4000, String(error).slice(0, 100)); return new Response(null, { status: 101, webSocket: client }); }

  const writer = socket.writable.getWriter();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    void socket.close().catch(() => {});
  };
  void socket.closed.then(close, close);
  let writes = Promise.resolve();
  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data === "shutdown") writes = writes.then(() => writer.close()).catch(close);
      return;
    }
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
      server.send(match ? tcpReady(match[1] ? "IPv6" : "IPv4", match[1] ?? match[2], Number(match[3]), "") : "ok");
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
