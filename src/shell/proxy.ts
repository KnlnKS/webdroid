import { htmlAttribute, webDocument } from "./webhtml";
import { webScript } from "./webscript";

const DROP = /^(content-encoding|transfer-encoding|set-cookie)$/i;
const DROP_FRAME = /^(x-frame-options|content-security-policy(-report-only)?|cross-origin-(opener|embedder)-policy)$/i;

interface ProxyOptions {
  target?: (requested: string) => string;
  bridgeCall: (request: Request) => Promise<Response>;
  fetchUpstream?: (url: string, init: RequestInit, encoded: boolean) => Promise<Response>;
}

export async function proxyRequest(request: Request, options: ProxyOptions): Promise<Response> {
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
    let intercepted: Response | null = null;
    const bridge = query.get("bridge");
    if (bridge) {
      const callback = new Request(new URL(`/webview-call?id=${encodeURIComponent(bridge)}`, request.url), {
        method: "POST", signal: request.signal,
        body: JSON.stringify({ kind: "request", url, method: request.method, main: frame, headers: Object.fromEntries(headers) }),
      });
      const response = await options.bridgeCall(callback);
      if (!response.ok) throw new Error("WebView request callback unavailable");
      const reply = await response.json() as { error?: string; value?: { body: string; status: number; reason: string; headers: Record<string, string> } };
      if (reply.error) throw new Error(reply.error);
      if (reply.value) {
        const value = reply.value, empty = request.method === "HEAD" || [204, 205, 304].includes(value.status);
        intercepted = new Response(empty ? null : Uint8Array.from(atob(value.body), (c) => c.charCodeAt(0)), {
          status: value.status, statusText: value.reason, headers: value.headers,
        });
      }
    }
    const init: RequestInit = {
      method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
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
    if (manual) {
      out.set("x-wd-status", String(upstream.status));
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) out.set("x-wd-set-cookie", JSON.stringify(cookies));
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
    return new Response(`proxy error: ${error}`, { status: 502 });
  }
}
