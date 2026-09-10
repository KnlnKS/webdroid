import type { ServerWebSocket } from "bun";

export type WebRelayData = { kind: "webview"; id: string };
type Peer = Pick<ServerWebSocket<WebRelayData>, "send" | "close">;

export class WebRelay {
  private peers = new Map<string, Peer>();
  private pending = new Map<number, { owner: Peer; finish: (response: Response) => void }>();
  private next = 0;

  open(id: string, peer: Peer) {
    if (this.peers.has(id)) { peer.close(1008, "duplicate bridge"); return; }
    this.peers.set(id, peer);
  }
  close(id: string, peer: Peer) {
    if (this.peers.get(id) === peer) this.peers.delete(id);
    for (const p of this.pending.values()) if (p.owner === peer) p.finish(new Response("bridge closed", { status: 410 }));
  }
  reply(peer: Peer, message: string) {
    const at = message.indexOf("\n"), id = Number(message.slice(0, at));
    const p = this.pending.get(id);
    if (at < 1 || p?.owner !== peer) return;
    p.finish(new Response(message.slice(at + 1), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
  }
  async call(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("id") ?? "", peer = this.peers.get(id);
    if (!peer || req.method !== "POST") return new Response("bridge unavailable", { status: 410 });
    const body = await req.text();
    if (body.length > 1024 * 1024) return new Response("bridge request too large", { status: 413 });
    if (req.signal.aborted || this.peers.get(id) !== peer) return new Response("bridge closed", { status: 410 });
    return new Promise<Response>((resolve) => {
      const seq = ++this.next;
      const finish = (response: Response) => {
        clearTimeout(timer); req.signal.removeEventListener("abort", abort);
        this.pending.delete(seq); resolve(response);
      };
      const abort = () => finish(new Response("bridge request cancelled", { status: 408 }));
      const timer = setTimeout(() => finish(new Response("bridge timed out", { status: 504 })), 30_000);
      this.pending.set(seq, { owner: peer, finish });
      req.signal.addEventListener("abort", abort, { once: true });
      if (peer.send(seq + "\n" + body) < 0) finish(new Response("bridge unavailable", { status: 503 }));
    });
  }
}
