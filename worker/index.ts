// The backend: what the shell page (deployed to Pages, functions/) forwards here, and the WebView renderer's origin.
import { bridgeSocket, fromApp, sharedRoute, type ServeHost } from "../src/shell/serve-routes.ts";
import { WebBridgeSession } from "./bridge.ts";
import { tcpRelay } from "./tcp.ts";
import { isPublicHost } from "../src/native/net-address.ts";

export { WebBridgeSession };

/** whether `name` has an IPv4 or else an IPv6 address, as getaddrinfo finds one; null when the resolver cannot say */
async function nameExists(name: string): Promise<boolean | null> {
  for (const [type, code] of [["A", 1], ["AAAA", 28]] as const) {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", name);
    endpoint.searchParams.set("type", type);
    try {
      const response = await fetch(endpoint, { headers: { accept: "application/dns-json" } });
      if (!response.ok) return null;
      const result = await response.json() as { Status?: number; Answer?: { type: number }[] };
      if (result.Status === 3) return false;
      if (result.Status !== 0) return null;
      if (result.Answer?.some((answer) => answer.type === code)) return true;
    } catch { return null; }
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), header = (name: string) => request.headers.get(name);
    // a preview's "*" is the alias Pages gave its branch (scripts/deploy.ts)
    const origin = (template: string) => env.PREVIEW_ALIAS ? template.replace("*", env.PREVIEW_ALIAS) : template;
    const appOrigin = origin(env.APP_ORIGIN);
    const host: ServeHost = { bridge: (call, id) => env.WEB_BRIDGES.getByName(id).fetch(call), nameExists,
      webviewOrigin: () => origin(env.WEBVIEW_ORIGIN), appOrigin: () => appOrigin, proxy: { reachable: isPublicHost } };
    const shared = sharedRoute(url, host);
    if (shared) return shared(request);
    // a renderer's pages share this origin, so the app's sockets answer only the app's
    if (url.pathname === "/tcp") return fromApp(url, header, host) ? tcpRelay(request, context) : new Response("forbidden", { status: 403 });
    if (url.pathname === "/webview-socket") {
      const id = bridgeSocket(url, header, host);
      return id === null ? new Response("bad bridge", { status: 403 }) : host.bridge(request, id);
    }
    if (url.pathname === "/") return Response.redirect(appOrigin, 308);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
