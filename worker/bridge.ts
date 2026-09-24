import { DurableObject } from "cloudflare:workers";

export class WebBridgeSession extends DurableObject<Env> {
  private pending = new Map<number, (response: Response) => void>();
  private next = 0;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/webview-socket") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 400 });
      if (this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.OPEN)) return new Response("duplicate bridge", { status: 409 });
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path !== "/webview-call" || request.method !== "POST") return new Response("not found", { status: 404 });
    const peer = this.ctx.getWebSockets().find((ws) => ws.readyState === WebSocket.OPEN);
    if (!peer) return new Response("bridge unavailable", { status: 410 });
    const body = await request.text();
    if (body.length > 1024 * 1024) return new Response("bridge request too large", { status: 413 });
    if (request.signal.aborted) return new Response("bridge closed", { status: 410 });
    return new Promise<Response>((resolve) => {
      const seq = ++this.next;
      const finish = (response: Response) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.pending.delete(seq);
        resolve(response);
      };
      const abort = () => finish(new Response("bridge request cancelled", { status: 408 }));
      const timer = setTimeout(() => finish(new Response("bridge timed out", { status: 504 })), 30_000);
      this.pending.set(seq, finish);
      request.signal.addEventListener("abort", abort, { once: true });
      try { peer.send(`${seq}\n${body}`); }
      catch { finish(new Response("bridge unavailable", { status: 410 })); }
    });
  }

  webSocketMessage(_peer: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    const at = message.indexOf("\n"), seq = Number(message.slice(0, at));
    if (at < 1 || !Number.isSafeInteger(seq)) return;
    this.pending.get(seq)?.(new Response(message.slice(at + 1), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));
  }

  webSocketClose(_peer: WebSocket): void {
    for (const finish of this.pending.values()) finish(new Response("bridge closed", { status: 410 }));
  }

  webSocketError(peer: WebSocket): void {
    peer.close(1011, "bridge error");
    for (const finish of this.pending.values()) finish(new Response("bridge closed", { status: 410 }));
  }
}
