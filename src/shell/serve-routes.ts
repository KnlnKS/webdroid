// What the dev server (server.ts) and the deployed Worker (worker/index.ts) both answer; each host lends its
// bridge sessions, its resolver and its upstream fetch.
import { WEB_FRAME, WEB_PROXY_WORKER } from "./webinject.ts";
import { forwardDnsMessage, proxyRequest, type ProxyOptions } from "./proxy.ts";

/** a renderer bridge's id, as the page's crypto.randomUUID() names it */
const BRIDGE_ID = /^[a-f0-9-]{36}$/;
const DNS_NAME = /^[A-Za-z0-9.-]{1,253}$/;

export interface ServeHost {
  /** bridge `id`'s session answering a renderer's /webview-call */
  bridge(request: Request, id: string): Response | Promise<Response>;
  /** `name`'s IPv4 addresses as `{addresses}`, or 404 (ENOTFOUND, ENODATA) or 502 */
  dnsLookup(name: string): Promise<Response>;
  proxy?: Omit<ProxyOptions, "bridgeCall">;
}
type Route = (request: Request) => Response | Promise<Response>;

/** whether a request comes from a page of `url`'s own origin, as the browser that sent it says: by the page's
 *  Origin (a WebSocket's, a POST's), or by Sec-Fetch-Site for a same-origin GET, which names none. A client
 *  outside a browser can claim either. */
export function ownPage(url: URL, header: (name: string) => string | null | undefined): boolean {
  const origin = header("origin");
  return origin ? origin === url.origin : header("sec-fetch-site") === "same-origin";
}
const forbidden = () => new Response("forbidden", { status: 403 });
const frame = () => new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
const bridgeCall = async (request: Request, host: ServeHost): Promise<Response> => {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  return BRIDGE_ID.test(id) ? host.bridge(request, id) : new Response("bad bridge", { status: 403 });
};

/** the shared route for a request to `url`, or undefined for one the host answers itself */
export function sharedRoute(url: URL, host: ServeHost): Route | undefined {
  // a renderer frame at any path of its origin
  if (BRIDGE_ID.test(url.searchParams.get("__wd_bridge") ?? "")) return frame;
  switch (url.pathname) {
    case "/webview": return frame;
    case "/webview-worker.js": return () => new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
    case "/webview-call": return request => bridgeCall(request, host);
    // the app's own HTTP: a page of another origin would make this an open proxy
    case "/proxy": return request => ownPage(new URL(request.url), name => request.headers.get(name))
      ? proxyRequest(request, { ...host.proxy, bridgeCall: call => bridgeCall(call, host) }) : forbidden();
    case "/dns-query": return forwardDnsMessage;
    // Whether a name resolves: the guest's resolvers answer a synthetic address for every name (the relay
    // dials by name), so this is how a name that does not exist fails as it would on a device, instead of
    // every connection to it being refused.
    case "/dns": return request => {
      const name = new URL(request.url).searchParams.get("host") ?? "";
      return DNS_NAME.test(name) ? host.dnsLookup(name) : new Response("bad name", { status: 400 });
    };
  }
}

/** the bridge a /webview-socket upgrade opens, or null when it names none or comes from another origin */
export function bridgeSocket(url: URL, header: (name: string) => string | null | undefined): string | null {
  const id = url.searchParams.get("id") ?? "";
  return BRIDGE_ID.test(id) && ownPage(url, header) ? id : null;
}

export type TcpTarget = { host: string; port: number; alpn: string[]; secure: boolean };
/** the target a /tcp upgrade names, or why it is refused */
export function tcpTarget(url: URL): TcpTarget | string {
  const host = url.searchParams.get("host") ?? "", port = Number(url.searchParams.get("port")), alpn = url.searchParams.getAll("alpn");
  if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) return "bad target";
  if (alpn.length > 32 || alpn.some((p) => !p.length || new TextEncoder().encode(p).length > 255)) return "bad ALPN";
  return { host, port, alpn, secure: url.searchParams.get("tls") === "1" };
}
/** the text frame that opens a relayed connection (relay.ts's TcpSocket) */
export const tcpReady = (localFamily: string | undefined, localAddress: string | undefined, localPort: number | undefined, alpn: string): string =>
  JSON.stringify({ type: "ready", localFamily, localAddress, localPort, alpn });

/** the headers by which the browser inflates a microg .gz download, or null to serve the file as stored */
export function gzipHeaders(url: URL): Record<string, string> | null {
  if (!url.pathname.endsWith(".gz") || url.searchParams.has("raw")) return null;
  // A .gz download filename makes WebKit retain the compressed transport body.
  return { "content-encoding": "gzip", "content-type": "application/octet-stream", "content-disposition": "inline" };
}
