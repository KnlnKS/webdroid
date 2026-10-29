// The WebView renderers' bridges: each renderer's page holds a WebSocket (/webview-socket) over which the backend passes it the
// /webview-call requests its proxied loads make, and takes back its replies.
import type { WebSocket } from "ws";
import { decodeFrame, encodeFrame } from "../src/shell/webpage/protocol.ts";

export class Bridges {
  private peers = new Map<string, WebSocket>();
  private calls = new Map<number, { peer: WebSocket; finish: (response: Response) => void }>();
  private next = 0;

  /** `ws` as bridge `id`'s renderer, unless one already is */
  connect(id: string, ws: WebSocket): void {
    if (this.peers.has(id)) return ws.close(1008, "duplicate bridge");
    this.peers.set(id, ws);
    ws.on("message", (data, binary) => {
      const frame = binary ? null : decodeFrame(data.toString()), call = frame && this.calls.get(Number(frame.seq));
      // a reply answers only a call its own renderer was sent
      if (call?.peer === ws) call.finish(new Response(frame!.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    });
    ws.once("close", () => {
      this.peers.delete(id);
      for (const call of this.calls.values()) if (call.peer === ws) call.finish(new Response("bridge closed", { status: 410 }));
    });
  }

  /** bridge `id`'s renderer's answer to `request`, a /webview-call */
  async call(request: Request, id: string): Promise<Response> {
    const peer = this.peers.get(id), live = () => this.peers.get(id) === peer;
    if (!peer || request.method !== "POST") return new Response("bridge unavailable", { status: 410 });
    const body = await request.text();
    if (body.length > 1024 * 1024) return new Response("bridge request too large", { status: 413 });
    if (request.signal.aborted || !live()) return new Response("bridge closed", { status: 410 });
    // a caller may wait less: the page's probe of whether this side can answer while it waits
    const wait = Math.min(30_000, Number(new URL(request.url).searchParams.get("timeout")) || 30_000);
    return new Promise<Response>((resolve) => {
      const seq = ++this.next;
      const finish = (response: Response) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.calls.delete(seq);
        resolve(response);
      };
      const abort = () => finish(new Response("bridge request cancelled", { status: 408 }));
      const timer = setTimeout(() => finish(new Response("bridge timed out", { status: 504 })), wait);
      this.calls.set(seq, { peer, finish });
      request.signal.addEventListener("abort", abort, { once: true });
      try { peer.send(encodeFrame(seq, body)); } catch { finish(new Response("bridge unavailable", { status: 410 })); }
    });
  }
}
