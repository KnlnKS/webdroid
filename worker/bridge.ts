import { DurableObject } from "cloudflare:workers";
import { BridgeCalls } from "../src/shell/bridgecalls.ts";

export class WebBridgeSession extends DurableObject<Env> {
  private calls = new BridgeCalls<WebSocket>();

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
    return this.calls.call(request, peer, () => peer.readyState === WebSocket.OPEN);
  }

  webSocketMessage(peer: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string") this.calls.reply(peer, message);
  }

  webSocketClose(peer: WebSocket): void {
    this.calls.close(peer);
  }

  webSocketError(peer: WebSocket): void {
    peer.close(1011, "bridge error");
    this.calls.close(peer);
  }
}
