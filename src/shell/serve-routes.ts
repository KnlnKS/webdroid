// What the dev server (server.ts) and the deployed Worker (worker/index.ts) both answer; each host lends its
// bridge sessions, its resolver, its renderer origin and its upstream fetch.
import { WEB_FRAME, WEB_PROXY_WORKER } from "./webinject.ts";
import { forwardDnsMessage, proxyRequest, type ProxyOptions } from "./proxy.ts";

/** a renderer bridge's id, as the page's crypto.randomUUID() names it */
const BRIDGE_ID = /^[a-f0-9-]{36}$/;
const DNS_NAME = /^[A-Za-z0-9.-]{1,253}$/;

export interface ServeHost {
  /** bridge `id`'s session answering a renderer's /webview-call */
  bridge(request: Request, id: string): Response | Promise<Response>;
  /** whether `name` has an address, as getaddrinfo finds one; null when the resolver cannot say */
  nameExists(name: string): Promise<boolean | null>;
  /** the WebView renderer origin, a "*" label standing for each partition (webrenderer.ts), for a
   *  shell page at `url`; null when there is none */
  webviewOrigin(url: URL): string | null;
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
/** what a renderer origin serves, which functions/[[path]].ts deploys there: its documents, its proxy worker, the bridge's calls and the proxy */
const RENDERER_PATHS = new Set(["/webview", "/webview-worker.js", "/webview-call", "/proxy"]);
export const rendererRoute = (url: URL): boolean => RENDERER_PATHS.has(url.pathname) || BRIDGE_ID.test(url.searchParams.get("__wd_bridge") ?? "");
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
    case "/dns": return async request => {
      const name = new URL(request.url).searchParams.get("host") ?? "";
      if (!DNS_NAME.test(name)) return new Response("bad name", { status: 400 });
      const exists = await host.nameExists(name);
      return new Response(null, { status: exists ? 200 : exists === false ? 404 : 502 });
    };
    // a renderer on this origin would share the app's window and storage
    case "/webview-origin": return request => {
      const url = new URL(request.url), template = URL.parse(host.webviewOrigin(url) ?? "")?.origin;
      const origin = template && URL.parse(template.replace("*", "x"))?.origin;
      return origin && origin !== "null" && origin !== url.origin ? Response.json(template)
        : new Response("Configure the WebView renderer origin on a separate site", { status: 503 });
    };
  }
}

/** the bridge a /webview-socket upgrade opens, or null when it names none or comes from another origin */
export function bridgeSocket(url: URL, header: (name: string) => string | null | undefined): string | null {
  const id = url.searchParams.get("id") ?? "";
  return BRIDGE_ID.test(id) && ownPage(url, header) ? id : null;
}

/** the headers by which the browser inflates a microg .gz download, or null to serve the file as stored */
export function gzipHeaders(url: URL): Record<string, string> | null {
  if (!url.pathname.endsWith(".gz") || url.searchParams.has("raw")) return null;
  // A .gz download filename makes WebKit retain the compressed transport body.
  return { "content-encoding": "gzip", "content-type": "application/octet-stream", "content-disposition": "inline" };
}
