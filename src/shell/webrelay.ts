import type { ServerWebSocket } from "bun";
import { BridgeCalls } from "./bridgecalls.ts";

export type WebRelayData = { kind: "webview"; id: string };
type Peer = Pick<ServerWebSocket<WebRelayData>, "send" | "close">;

export class WebRelay {
  private peers = new Map<string, Peer>();
  private calls = new BridgeCalls<Peer>();

  open(id: string, peer: Peer) {
    if (this.peers.has(id)) { peer.close(1008, "duplicate bridge"); return; }
    this.peers.set(id, peer);
  }
  close(id: string, peer: Peer) {
    if (this.peers.get(id) === peer) this.peers.delete(id);
    this.calls.close(peer);
  }
  reply(peer: Peer, message: string) {
    this.calls.reply(peer, message);
  }
  async call(req: Request): Promise<Response> {
    const id = new URL(req.url).searchParams.get("id") ?? "", peer = this.peers.get(id);
    return peer ? this.calls.call(req, peer, () => this.peers.get(id) === peer)
      : new Response("bridge unavailable", { status: 410 });
  }
}
