import { bridgeSocket, gzipHeaders, ownPage, sharedRoute, type ServeHost } from "../src/shell/serve-routes.ts";
import { WebBridgeSession } from "./bridge.ts";
import { tcpRelay } from "./tcp.ts";
import { isPublicHost } from "../src/native/net-address.ts";
import { branchOrigin } from "./preview.ts";

export { WebBridgeSession };

export function serveHost(env: Env): ServeHost {
  return { bridge: (call, id) => env.WEB_BRIDGES.getByName(id).fetch(call), nameExists,
    webviewOrigin: () => env.WEBVIEW_ORIGIN && (env.PREVIEW_BRANCH ? branchOrigin(env.WEBVIEW_ORIGIN, env.PREVIEW_BRANCH) : env.WEBVIEW_ORIGIN),
    proxy: { reachable: isPublicHost } };
}

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

/** a file build-prod split into parts, whole or as the byte range the request names */
async function largeAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const manifestResponse = await env.ASSETS.fetch(new URL("/large-assets.json", url));
  if (!manifestResponse.ok) return new Response("asset manifest unavailable", { status: 500 });
  const manifest = await manifestResponse.json() as Record<string, { parts: number; size: number; partSize: number }>;
  const entry = manifest[url.pathname];
  if (!entry) return env.ASSETS.fetch(request);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), entry.size - 1) : entry.size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${entry.size}` } });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let i = Math.floor(start / entry.partSize); i * entry.partSize <= end; i++) {
          const from = Math.max(start - i * entry.partSize, 0), to = Math.min(end - i * entry.partSize, entry.partSize - 1);
          const part = await env.ASSETS.fetch(new URL(`${url.pathname}.part${i}`, url), { headers: { range: `bytes=${from}-${to}` } });
          if (!part.ok || !part.body) throw new Error(`missing asset part ${i}`);
          // an asset store that ignores Range sends the whole part: skip to `from` and stop after `to`
          let at = part.status === 206 ? from : 0;
          const reader = part.body.getReader();
          while (at <= to) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.subarray(Math.max(from - at, 0), Math.max(to + 1 - at, 0));
            if (chunk.length) controller.enqueue(chunk);
            at += value.length;
          }
          await reader.cancel();
        }
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  const headers: Record<string, string> = { "content-type": "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate",
    "accept-ranges": "bytes", "content-length": String(end - start + 1) };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${entry.size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    const host = serveHost(env);
    const shared = sharedRoute(url, host), header = (name: string) => request.headers.get(name);
    if (shared) return shared(request);
    if (path === "/tcp") return ownPage(url, header) ? tcpRelay(request, context) : new Response("forbidden", { status: 403 });
    if (path === "/webview-socket") {
      const id = bridgeSocket(url, header);
      return id === null ? new Response("bad bridge", { status: 403 }) : host.bridge(request, id);
    }
    if (path.startsWith("/vendor/aosp/")) return largeAsset(request, env);
    const gzip = path.startsWith("/vendor/microg/") ? gzipHeaders(url) : null;
    if (gzip) {
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      for (const [name, value] of Object.entries(gzip)) headers.set(name, value);
      headers.delete("content-length");
      return new Response(asset.body, { status: asset.status, headers, encodeBody: "manual" });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
