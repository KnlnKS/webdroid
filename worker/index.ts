import { WEB_FRAME, WEB_PROXY_WORKER } from "../src/shell/webinject.ts";
import { forwardDnsMessage, proxyRequest } from "../src/shell/proxy.ts";
import { WebBridgeSession } from "./bridge.ts";
import { tcpRelay } from "./tcp.ts";

export { WebBridgeSession };

const UUID = /^[a-f0-9-]{36}$/;

async function bridgeCall(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return new Response("bad bridge", { status: 403 });
  return env.WEB_BRIDGES.getByName(id).fetch(request);
}

async function dnsLookup(request: Request): Promise<Response> {
  const host = new URL(request.url).searchParams.get("host") ?? "";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return new Response("bad name", { status: 400 });
  try {
    const endpoint = new URL("https://cloudflare-dns.com/dns-query");
    endpoint.searchParams.set("name", host);
    endpoint.searchParams.set("type", "A");
    const response = await fetch(endpoint, { headers: { accept: "application/dns-json" } });
    if (!response.ok) return new Response("DNS unavailable", { status: 502 });
    const result = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (result.Status === 3) return new Response("ENOTFOUND", { status: 404 });
    if (result.Status !== 0) return new Response("DNS unavailable", { status: 502 });
    const addresses = (result.Answer ?? []).filter((answer) => answer.type === 1).map((answer) => answer.data);
    return addresses.length ? Response.json({ addresses }) : new Response("ENODATA", { status: 404 });
  } catch { return new Response("DNS unavailable", { status: 502 }); }
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
    if (UUID.test(url.searchParams.get("__wd_bridge") ?? "")) return new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (path === "/proxy") return proxyRequest(request, { bridgeCall: (call) => bridgeCall(call, env, new URL(call.url).searchParams.get("id") ?? "") });
    if (path === "/tcp") return tcpRelay(request, context);
    if (path === "/dns") return dnsLookup(request);
    if (path === "/dns-query") return forwardDnsMessage(request);
    if (path === "/webview") return new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (path === "/webview-worker.js") return new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
    if (path === "/webview-origin") {
      if (!env.WEBVIEW_ORIGIN) return new Response("Configure WEBVIEW_ORIGIN on a separate hostname", { status: 503 });
      const origin = new URL(env.WEBVIEW_ORIGIN).origin;
      return origin === url.origin ? new Response("WebView origin must differ", { status: 503 }) : Response.json(origin);
    }
    if (path === "/webview-socket" || path === "/webview-call") {
      const id = url.searchParams.get("id") ?? "";
      if (path === "/webview-socket" && request.headers.get("origin") !== url.origin) return new Response("bad bridge", { status: 403 });
      return bridgeCall(request, env, id);
    }
    if (path.startsWith("/vendor/aosp/")) return largeAsset(request, env);
    if (path.startsWith("/vendor/microg/") && path.endsWith(".gz") && !url.searchParams.has("raw")) {
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      headers.set("content-encoding", "gzip");
      headers.set("content-type", "application/octet-stream");
      headers.set("content-disposition", "inline");
      headers.delete("content-length");
      return new Response(asset.body, { status: asset.status, headers, encodeBody: "manual" });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
