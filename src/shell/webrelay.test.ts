import { expect, test } from "bun:test";
import { WebRelay } from "./webrelay";

function serve() {
  const relay = new WebRelay();
  return Bun.serve<{ id: string }>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/call") return relay.call(req);
      return server.upgrade(req, { data: { id: url.searchParams.get("id")! } }) ? undefined : new Response("bad request", { status: 400 });
    },
    websocket: {
      open(ws) { relay.open(ws.data.id, ws); },
      message(ws, message) { if (typeof message === "string") relay.reply(ws, message); },
      close(ws) { relay.close(ws.data.id, ws); },
    },
  });
}
async function connect(port: number, id: string) {
  const socket = new WebSocket(`ws://localhost:${port}/?id=${id}`);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  return socket;
}
const message = (socket: WebSocket) => new Promise<string>((resolve) => socket.addEventListener("message", event => resolve(String(event.data)), { once: true }));

test("WebView relay correlates real HTTP calls with the owning WebSocket and releases closed calls", async () => {
  const server = serve();
  const a = await connect(server.port!, "a"), b = await connect(server.port!, "b");
  const call = (id: string) => fetch(`http://localhost:${server.port}/call?id=${id}`, { method: "POST", body: '{"kind":"describe"}' });
  try {
    const receivedA = message(a), receivedB = message(b);
    const first = call("a"), second = call("b");
    const seqA = (await receivedA).split("\n")[0], seqB = (await receivedB).split("\n")[0];
    b.send(seqA + '\n{"value":"wrong owner"}');
    b.send(seqB + '\n{"value":2}');
    await Bun.sleep(5);
    a.send(seqA + '\n{"value":1}');
    expect(await (await first).json()).toEqual({ value: 1 });
    expect(await (await second).json()).toEqual({ value: 2 });
    const duplicate = await connect(server.port!, "a");
    await new Promise<void>(resolve => duplicate.addEventListener("close", () => resolve(), { once: true }));
    const closing = message(a), pending = call("a");
    await closing;
    a.close();
    expect((await pending).status).toBe(410);
    expect((await call("a")).status).toBe(410);
  } finally { a.close(); b.close(); server.stop(true); }
});
