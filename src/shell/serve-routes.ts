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
  /** the shell page's origin for a request to `url`: the request's own on the dev server, the Pages site's for the Worker */
  appOrigin(url: URL): string;
  proxy?: Omit<ProxyOptions, "bridgeCall">;
}
type Route = (request: Request) => Response | Promise<Response>;

/** what the app's page asks of its backend, which Pages forwards to the Worker (scripts/build-prod.ts) */
export const BACKEND_PATHS = ["/proxy", "/dns", "/dns-query", "/webview-origin", "/tcp", "/webview-socket"];

type Header = (name: string) => string | null | undefined;
/** the origin of the page a request comes from, as the browser that sent it says: the page's Origin (a WebSocket's, a POST's),
 *  or for a same-origin GET, which names none, the origin it was sent to. A client outside a browser can claim either. */
export function pageOrigin(url: URL, header: Header): string | null {
  return header("origin") || (header("sec-fetch-site") === "same-origin" ? url.origin : null);
}
/** whether a request comes from the app's page: its sockets reach the network, which no other site's page, a renderer's included, may */
export const fromApp = (url: URL, header: Header, host: ServeHost): boolean => pageOrigin(url, header) === host.appOrigin(url);
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
    // the app's and its renderers' own HTTP: a page of another origin would make this an open proxy
    case "/proxy": return request => {
      const url = new URL(request.url), from = pageOrigin(url, name => request.headers.get(name));
      return from === url.origin || from === host.appOrigin(url)
        ? proxyRequest(request, { ...host.proxy, bridgeCall: call => bridgeCall(call, host) }) : forbidden();
    };
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
      return origin && origin !== "null" && origin !== host.appOrigin(url) ? Response.json(template)
        : new Response("Configure the WebView renderer origin on a separate site", { status: 503 });
    };
  }
}

/** the bridge a /webview-socket upgrade opens, or null when it names none or comes from a page other than the app's */
export function bridgeSocket(url: URL, header: Header, host: ServeHost): string | null {
  const id = url.searchParams.get("id") ?? "";
  return BRIDGE_ID.test(id) && fromApp(url, header, host) ? id : null;
}
