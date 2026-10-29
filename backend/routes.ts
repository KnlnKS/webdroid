// What the dev server (server.ts) and the public backend (index.ts) answer for the page: its proxy and name lookups, the WebView
// renderer's frames and bridges, and its sockets. Each says where its network reaches, which pages are the app's and where renderers live.
import dns from "node:dns/promises";
import type { Server } from "node:http";
import type { Http2SecureServer } from "node:http2";
import { WebSocketServer, type WebSocket } from "ws";
import { WEB_FRAME, WEB_PROXY_WORKER } from "../src/shell/webinject.ts";
import { forwardDnsMessage, proxyRequest } from "../src/shell/proxy.ts";
import { EMBEDDER, pageOrigin, type Header } from "../src/shell/serve-routes.ts";
import { MAX_PENDING_BYTES, tcpTarget } from "../src/shell/tcpwire.ts";
import { Bridges } from "./bridges.ts";
import { relayTcp, relayUdp } from "./relays.ts";
import type { Network } from "./network.ts";

export interface BackendConfig {
  network: Network;
  /** whether a page of `origin` is the shell page for a request to `url` */
  isApp(origin: string, url: URL): boolean;
  /** the WebView renderer origin, a "*" label standing for each partition (webrenderer.ts), for a shell page at `url`; null when there is none */
  webviewOrigin(url: URL): string | null;
}
type Route = (request: Request) => PromiseOrVal<Response>;

/** what the app's page asks of its backend, which Pages forwards to it (scripts/build-prod.ts) */
export const BACKEND_PATHS = ["/proxy", "/dns", "/dns-query", "/webview-origin", "/tcp", "/udp", "/webview-socket"];

/** a renderer bridge's id, as the page's crypto.randomUUID() names it */
const BRIDGE_ID = /^[a-f0-9-]{36}$/;
const DNS_NAME = /^[A-Za-z0-9.-]{1,253}$/;
const forbidden = () => new Response("forbidden", { status: 403 });
const frame = () => new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store", ...EMBEDDER } });
/** whether `name` has an address, as getaddrinfo finds one; null when the resolver cannot say */
const nameExists = (name: string) => dns.lookup(name, { all: true })
  .then(() => true, (e: { code?: string }) => e.code === "ENOTFOUND" || e.code === "ENODATA" ? false : null);

/** whether a page of `origin` is the Pages site `app`, or for a pages.dev project one of its branch aliases or deployments */
export const pagesSite = (app: URL) => (origin: string): boolean => {
  const page = URL.parse(origin);
  if (page?.protocol !== app.protocol || page.port !== app.port) return false;
  return page.hostname === app.hostname || app.hostname.endsWith(".pages.dev") && page.hostname.endsWith(`.${app.hostname}`);
};

export function backend({ network, isApp, webviewOrigin }: BackendConfig) {
  const bridges = new Bridges();
  /** whether a request comes from the app's page: its sockets reach the network, which no other site's page, a renderer's included, may */
  const fromApp = (url: URL, header: Header) => {
    const origin = pageOrigin(url, header);
    return origin !== null && isApp(origin, url);
  };
  const bridgeCall = async (request: Request): Promise<Response> => {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return BRIDGE_ID.test(id) ? bridges.call(request, id) : new Response("bad bridge", { status: 403 });
  };

  /** the route for a request to `url`, or undefined for one the host answers itself */
  function route(url: URL): Route | undefined {
    // a renderer frame at any path of its origin
    if (BRIDGE_ID.test(url.searchParams.get("__wd_bridge") ?? "")) return frame;
    switch (url.pathname) {
      case "/webview": return frame;
      case "/webview-worker.js": return () => new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
      case "/webview-call": return bridgeCall;
      // the app's and its renderers' own HTTP: a page of another origin would make this an open proxy
      case "/proxy": return request => {
        const url = new URL(request.url), header = (name: string) => request.headers.get(name);
        return pageOrigin(url, header) === url.origin || fromApp(url, header) ? proxyRequest(request, { ...network, bridgeCall }) : forbidden();
      };
      case "/dns-query": return forwardDnsMessage;
      // Whether a name resolves: the guest's resolvers answer a synthetic address for every name (the relay
      // dials by name), so this is how a name that does not exist fails as it would on a device, instead of
      // every connection to it being refused.
      case "/dns": return async request => {
        const name = new URL(request.url).searchParams.get("host") ?? "";
        if (!DNS_NAME.test(name)) return new Response("bad name", { status: 400 });
        const exists = await nameExists(name);
        return new Response(null, { status: exists ? 200 : exists === false ? 404 : 502 });
      };
      // a renderer on this origin would share the app's window and storage
      case "/webview-origin": return request => {
        const url = new URL(request.url), template = URL.parse(webviewOrigin(url) ?? "")?.origin;
        const origin = template && URL.parse(template.replace("*", "x"))?.origin;
        return origin && origin !== "null" && !isApp(origin, url) ? Response.json(template)
          : new Response("Configure the WebView renderer origin on a separate site", { status: 503 });
      };
    }
  }

  /** the WebSocket servers `server` upgrades to: the relays', whose frames are bounded as their pending bytes are, and the
   *  renderer bridges', whose replies carry whole response bodies */
  function attach(server: Server | Http2SecureServer): WebSocketServer[] {
    const relays = new WebSocketServer({ noServer: true, maxPayload: MAX_PENDING_BYTES }), renderers = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = URL.parse(req.url ?? "/", `http://${req.headers.host}`);
      const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      if (!url) return void reject("400 Bad Request");
      // a socket's error (a frame past the size limit) closes it, which its relay ends with
      const upgrade = (sockets: WebSocketServer, use: (ws: WebSocket) => void) => sockets.handleUpgrade(req, socket, head, ws => {
        ws.on("error", () => ws.terminate());
        use(ws);
      });
      if (url.pathname !== "/webview-socket" && url.pathname !== "/udp" && url.pathname !== "/tcp") return void reject("404 Not Found");
      // a WebSocket skips CORS: a page of any site open in the browser could otherwise use this server's network or bridges
      if (!fromApp(url, (name) => req.headers[name] as string | undefined)) return void reject("403 Forbidden");
      if (url.pathname === "/webview-socket") {
        const id = url.searchParams.get("id") ?? "";
        return BRIDGE_ID.test(id) ? upgrade(renderers, ws => bridges.connect(id, ws)) : void reject("403 Forbidden");
      }
      if (url.pathname === "/udp") return upgrade(relays, ws => relayUdp(ws, network));
      const target = tcpTarget(url);
      if (typeof target === "string") return void reject("400 Bad Request");
      upgrade(relays, ws => relayTcp(ws, target, network));
    });
    return [relays, renderers];
  }

  return { route, attach };
}
