import dns from "node:dns/promises";
import type { Server } from "node:http";
import type { Http2SecureServer } from "node:http2";
import { WebSocketServer, type WebSocket } from "ws";
import { WebRelay } from "../src/shell/webrelay.ts";
import { bridgeSocket, fromApp, type ServeHost } from "../src/shell/serve-routes.ts";
import { tcpTarget, MAX_PENDING_TCP_BYTES } from "../src/shell/tcpwire.ts";
import { relayTcp, relayUdp } from "./relays.ts";
import { fetchEncoded, publicFetch, resolvePublic } from "./network.ts";

type Host = ServeHost & { relay: WebRelay; publicOnly: boolean };
export function backendHost({ publicOnly, ...config }: Pick<ServeHost, "isApp" | "webviewOrigin"> & { publicOnly: boolean }): Host {
  const relay = new WebRelay();
  return { ...config, relay, publicOnly,
    bridge: (request, id) => relay.call(request, id),
    nameExists: name => dns.lookup(name, { all: true }).then(() => true,
      (e: { code?: string }) => e.code === "ENOTFOUND" || e.code === "ENODATA" ? false : null),
    proxy: { fetch: publicOnly ? publicFetch : undefined, fetchEncoded: (url, init) => fetchEncoded(url, init, publicOnly) },
  };
}

export function attachSockets(server: Server | Http2SecureServer, host: Host): WebSocketServer {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PENDING_TCP_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const url = URL.parse(req.url ?? "/", `http://${req.headers.host}`);
    const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!url) return void reject("400 Bad Request");
    const header = (name: string) => req.headers[name] as string | undefined;
    const upgrade = (use: (ws: WebSocket) => void) => sockets.handleUpgrade(req, socket, head, ws => {
      ws.on("error", () => ws.terminate());
      use(ws);
    });
    if (url.pathname === "/webview-socket") {
      const id = bridgeSocket(url, header, host);
      if (id === null) return void reject("403 Forbidden");
      return upgrade(ws => {
        host.relay.open(id, ws);
        ws.on("message", (data, binary) => { if (!binary) host.relay.reply(ws, data.toString()); });
        ws.once("close", () => host.relay.close(id, ws));
      });
    }
    if (url.pathname !== "/udp" && url.pathname !== "/tcp") return void reject("404 Not Found");
    if (!fromApp(url, header, host)) return void reject("403 Forbidden");
    if (url.pathname === "/udp") return upgrade(ws => relayUdp(ws, host.publicOnly ? resolvePublic : undefined));
    const target = tcpTarget(url);
    if (typeof target === "string") return void reject("400 Bad Request");
    upgrade(ws => relayTcp(ws, target, host.publicOnly ? resolvePublic : undefined));
  });
  return sockets;
}
