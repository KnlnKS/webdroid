import { htmlAttribute, webDocument } from "./webhtml.ts";
import { webScript } from "./webscript.ts";
import { isGuestHost } from "../native/net-address.ts";
import type { BridgeCall } from "./webpage/protocol.ts";

const DROP = /^(content-encoding|transfer-encoding|set-cookie)$/i;
const DROP_FRAME = /^(x-frame-options|content-security-policy(-report-only)?|cross-origin-(opener|embedder)-policy)$/i;

/** A WebView page reaches this server through its frame's fetches; a document loaded straight from it
 *  (a page's frame pointed at it) runs in an opaque origin, never as the origin that serves it. */
export function sandboxDocument(request: Request, response: Response): Response {
  if (/^(|document|iframe|frame|object|embed)$/.test(request.headers.get("sec-fetch-dest") ?? ""))
    response.headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
  return response;
}

interface ProxyOptions {
  target?: (requested: string) => string;
  bridgeCall: (request: Request) => Promise<Response>;
  fetchUpstream?: (url: string, init: RequestInit, encoded: boolean) => Promise<Response>;
}

/** The class of an upstream fetch failure, so the Java side can throw what a socket would. */
function failureKind(error: unknown): string {
  const e = error as { code?: string; name?: string };
  const tag = `${e?.code ?? ""} ${e?.name ?? ""} ${error}`;
  if (/ENOTFOUND|EAI_|getaddrinfo|DNS/i.test(tag)) return "host";
  if (/Refused|ECONNREFUSED/i.test(tag)) return "refused";
  if (/Timeout|ETIMEDOUT/i.test(tag)) return "timeout";
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(tag)) return "tls";
  return "io";
}

export async function proxyRequest(request: Request, options: ProxyOptions): Promise<Response> {
  return sandboxDocument(request, await proxied(request, options));
}

async function proxied(request: Request, options: ProxyOptions): Promise<Response> {
  if (request.headers.get("service-worker") === "script") return new Response("invalid worker", { status: 403 });
  const query = new URL(request.url).searchParams;
  const requested = query.get("url"), frame = query.get("frame") === "1";
  const manual = query.get("manual") === "1", isolated = query.get("webview") === "1";
  if (!requested || !/^https?:\/\//.test(requested)) return new Response("bad url", { status: 400 });
  const url = options.target?.(requested) ?? requested;
  try {
    const headers = new Headers();
    request.headers.forEach((value, name) => { if (name.startsWith("x-wd-")) headers.set(name.slice(5), value); });
    const encoded = !frame && !isolated && headers.has("accept-encoding");
    const bridge = query.get("bridge"), body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    /** the WebView's process answering `call`: its WebResourceResponse, or null for none */
    const bridged = async (call: BridgeCall): Promise<Response | null> => {
      const response = await options.bridgeCall(new Request(new URL(`/webview-call?id=${encodeURIComponent(bridge!)}`, request.url), {
        method: "POST", signal: request.signal, body: JSON.stringify(call),
      }));
      if (!response.ok) throw new Error("WebView request callback unavailable");
      const reply = await response.json() as { error?: string; value?: { body: string; status: number; reason: string; headers: Record<string, string> } };
      if (reply.error) throw new Error(reply.error);
      if (!reply.value) return null;
      const value = reply.value, empty = request.method === "HEAD" || [204, 205, 304].includes(value.status);
      return new Response(empty ? null : Uint8Array.fromBase64(value.body), { status: value.status, statusText: value.reason, headers: value.headers });
    };
    let intercepted = bridge && query.get("intercept") === "1"
      ? await bridged({ kind: "request", url, method: request.method, main: frame && query.get("sub") !== "1", headers: Object.fromEntries(headers) }) : null;
    // the device's own address: the WebView's process serves it, and nothing else unless a remap
    // (adb reverse's role) names a host server
    if (!intercepted && url === requested && isGuestHost(new URL(url).hostname)) {
      intercepted = bridge ? await bridged({ kind: "loopback", url, method: request.method, headers: Object.fromEntries(headers),
        body: body && new Uint8Array(body).toBase64() }) : null;
      if (!intercepted) throw new Error(`ECONNREFUSED: nothing listens at ${new URL(url).host}`);
    }
    const init: RequestInit = {
      method: request.method, headers,
      // buffered: a redirect (307/308) must replay the body, which a stream cannot
      body,
      redirect: manual ? "manual" : "follow",
    };
    const upstream = intercepted ?? await (options.fetchUpstream?.(url, init, encoded) ?? fetch(url, init));
    const contentType = upstream.headers.get("content-type") ?? "";
    const html = !!(frame && upstream.body && /^text\/html/i.test(contentType));
    const script = !!(isolated && upstream.body && /^(?:text|application)\/(?:x-)?(?:java|ecma)script(?:;|$)/i.test(contentType));
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (name === "content-length" && (upstream.headers.has("content-encoding") || html || script)) return;
      if (!DROP.test(name) && !(frame && DROP_FRAME.test(name))) out.set(name, value);
    });
    // Bun drops Content-Length from streamed responses; URLConnection restores this value.
    if (out.has("content-length")) out.set("x-wd-content-length", out.get("content-length")!);
    out.set("access-control-allow-origin", "*");
    out.set("x-wd-final-url", upstream.url || url);
    // a browser hides Set-Cookie from fetch, so the values travel under our own name
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) out.set("x-wd-set-cookie", JSON.stringify(cookies));
    if (manual) {
      out.set("x-wd-status", String(upstream.status));
      if ([301, 302, 303, 307, 308].includes(upstream.status)) {
        out.set("x-wd-status-text", upstream.statusText);
        out.delete("content-length");
        out.delete("x-wd-content-length");
        return new Response(null, { headers: out });
      }
    }
    if (encoded && upstream.headers.has("content-encoding")) out.set("x-wd-content-encoding", upstream.headers.get("content-encoding")!);
    if (html) {
      out.set("content-type", "text/html; charset=utf-8");
      if (isolated) { out.delete("etag"); out.delete("last-modified"); }
      return new Response(await webDocument(await upstream.text(), upstream.url || url, isolated), { status: upstream.status, headers: out });
    }
    if (script) {
      out.delete("etag"); out.delete("last-modified");
      out.set("content-type", "text/javascript; charset=utf-8");
      return new Response(webScript(await upstream.text()), { status: upstream.status, headers: out });
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    if (frame) return new Response(`<!doctype html><meta name="wd-proxy-error" content="${htmlAttribute(String(error))}">`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response(`proxy error: ${error}`, { status: 502, headers: { "x-wd-error": failureKind(error) } });
  }
}

/** One wire-format DNS message (RFC 8484) for guests that run their own resolver. */
export async function forwardDnsMessage(request: Request): Promise<Response> {
  const body = request.method === "POST" ? await request.arrayBuffer() : null;
  if (!body || body.byteLength < 12 || body.byteLength > 65535) return new Response("bad DNS message", { status: 400 });
  try {
    const answer = await fetch("https://cloudflare-dns.com/dns-query", {
      method: "POST", body, headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
    });
    if (answer.ok) return new Response(answer.body, { headers: { "content-type": "application/dns-message" } });
  } catch { /* reported below */ }
  return new Response("DNS unavailable", { status: 502 });
}
