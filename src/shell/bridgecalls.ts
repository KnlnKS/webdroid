import { decodeFrame, encodeFrame } from "./webpage/protocol.ts";

interface BridgePeer { send(message: string): void }

export class BridgeCalls<Peer extends BridgePeer> {
  private pending = new Map<number, { peer: Peer; finish: (response: Response) => void }>();
  private next = 0;

  async call(request: Request, peer: Peer, active: () => boolean): Promise<Response> {
    if (request.method !== "POST" || !active()) return new Response("bridge unavailable", { status: 410 });
    const body = await request.text();
    if (body.length > 1024 * 1024) return new Response("bridge request too large", { status: 413 });
    if (request.signal.aborted || !active()) return new Response("bridge closed", { status: 410 });
    // a caller may wait less: the page's probe of whether this side can answer while it waits
    const wait = Math.min(30_000, Number(new URL(request.url).searchParams.get("timeout")) || 30_000);
    return new Promise<Response>((resolve) => {
      const seq = ++this.next;
      const finish = (response: Response) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.pending.delete(seq);
        resolve(response);
      };
      const abort = () => finish(new Response("bridge request cancelled", { status: 408 }));
      const timer = setTimeout(() => finish(new Response("bridge timed out", { status: 504 })), wait);
      this.pending.set(seq, { peer, finish });
      request.signal.addEventListener("abort", abort, { once: true });
      try { peer.send(encodeFrame(seq, body)); } catch { finish(new Response("bridge unavailable", { status: 410 })); }
    });
  }

  reply(peer: Peer, message: string): void {
    const frame = decodeFrame(message), call = frame && this.pending.get(Number(frame.seq));
    if (call?.peer !== peer) return;
    call.finish(new Response(frame!.body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));
  }

  close(peer: Peer): void {
    for (const call of this.pending.values()) if (call.peer === peer)
      call.finish(new Response("bridge closed", { status: 410 }));
  }
}
