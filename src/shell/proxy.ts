import { htmlAttribute, webDocument } from "./webhtml.ts";
import { webScript } from "./webscript.ts";
import { isGuestHost } from "../native/net-address.ts";
import type { BridgeCall, BridgeReply, WebResponse } from "./webpage/protocol.ts";
import { failedAnswer, fromProxyHeaders, parseProxyQuery, writeAnswer } from "./webpage/proxywire.ts";

const DROP = /^(content-encoding|transfer-encoding|set-cookie)$/i;
const DROP_FRAME = /^(x-frame-options|content-security-policy(-report-only)?|cross-origin-(opener|embedder)-policy)$/i;

/** what a frame inside the cross-origin isolated page embeds on (serve-routes.ts' ISOLATION). Credentialless embedding
 *  takes a WebView page's cross-origin subresources without their consent, as no-cors requests without credentials. */
export const EMBEDDER = { "cross-origin-embedder-policy": "credentialless" };

/** A WebView page reaches this server through its frame's fetches; a document loaded straight from it
 *  (a page's frame pointed at it) runs in an opaque origin, never as the origin that serves it. */
export function sandboxDocument(request: Request, response: Response): Response {
  if (/^(|document|iframe|frame|object|embed)$/.test(request.headers.get("sec-fetch-dest") ?? "")) {
    response.headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
    for (const [name, value] of Object.entries(EMBEDDER)) response.headers.set(name, value);
  }
  return response;
}

export interface ProxyOptions {
  /** whether this server may connect to `hostname`: the production backend keeps off private networks */
  reachable?: (hostname: string) => boolean;
  bridgeCall: (request: Request) => Promise<Response>;
  /** the upstream fetch, which follows a redirect unless told otherwise: the global one by default */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** one exchange whose body stays as the server encoded it, for a device that asked for an encoding and
   *  decodes it itself; without it (a Worker's fetch decodes), the device gets the body decoded */
  fetchEncoded?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The class of an upstream fetch failure, so the Java side can throw what a socket would. */
function failureKind(error: unknown): string {
  // Node's fetch fails as "fetch failed", with what failed as its cause
  const e = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; name?: string };
  const tag = `${e?.code ?? ""} ${e?.name ?? ""} ${e}`;
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
  const query = parseProxyQuery(new URL(request.url).searchParams);
  if (!query) return new Response("bad url", { status: 400 });
  const { url, manual, bridge, webview: isolated } = query, frame = !!query.frame;
  try {
    const headers = fromProxyHeaders(request.headers);
    // a media element sets no headers of its own: the device's travel in `headers`, and its Range is the element's
    for (const [name, value] of query.headers ?? []) headers.set(name, value);
    const range = request.headers.get("range");
    if (range && !headers.has("range")) headers.set("range", range);
    // only a manual answer names the encoding (a media element decodes none), so its redirects are the device's to follow
    const encoded = manual && !!options.fetchEncoded && !frame && !isolated && headers.has("accept-encoding");
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    /** the WebView's process answering `call`: its WebResourceResponse, or null for none */
    const bridged = async (call: BridgeCall): Promise<Response | null> => {
      const response = await options.bridgeCall(new Request(new URL(`/webview-call?id=${encodeURIComponent(bridge!)}`, request.url), {
        method: "POST", signal: request.signal, body: JSON.stringify(call),
      }));
      if (!response.ok) throw new Error("WebView request callback unavailable");
      const reply = await response.json() as BridgeReply<WebResponse | null>;
      if ("error" in reply) throw new Error(reply.error);
      const value = "value" in reply ? reply.value : null;
      if (!value) return null;
      const empty = request.method === "HEAD" || [204, 205, 304].includes(value.status);
      return new Response(empty ? null : Uint8Array.fromBase64(value.body), { status: value.status, statusText: value.reason, headers: value.headers });
    };
    let intercepted = bridge && query.intercept
      ? await bridged({ kind: "request", url, method: request.method, main: query.frame === "main", headers: Object.fromEntries(headers) }) : null;
    // the device's own address: the WebView's process serves it, and nothing else
    if (!intercepted && isGuestHost(new URL(url).hostname)) {
      intercepted = bridge ? await bridged({ kind: "loopback", url, method: request.method, headers: Object.fromEntries(headers),
        body: body && new Uint8Array(body).toBase64() }) : null;
      if (!intercepted) throw new Error(`ECONNREFUSED: nothing listens at ${new URL(url).host}`);
    }
    if (!intercepted && options.reachable && !options.reachable(new URL(url).hostname)) throw new Error(`ECONNREFUSED: ${new URL(url).host} is not reachable from this server`);
    const init: RequestInit = {
      method: request.method, headers,
      // buffered: a redirect (307/308) must replay the body, which a stream cannot
      body,
      redirect: manual ? "manual" : "follow", signal: request.signal,
    };
    const upstream = intercepted ?? await (encoded ? options.fetchEncoded! : options.fetch ?? fetch)(url, init);
    const contentType = upstream.headers.get("content-type") ?? "";
    const html = !!(frame && upstream.body && /^text\/html/i.test(contentType));
    const script = !!(isolated && upstream.body && /^(?:text|application)\/(?:x-)?(?:java|ecma)script(?:;|$)/i.test(contentType));
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (name === "content-length" && (upstream.headers.has("content-encoding") || html || script)) return;
      if (!DROP.test(name) && !(frame && DROP_FRAME.test(name))) out.set(name, value);
    });
    // the client's fetch would follow a redirect itself (or, told not to, see an opaque one): a manual one is an empty answer
    const redirect = manual && [301, 302, 303, 307, 308].includes(upstream.status);
    if (redirect) out.delete("content-length");
    writeAnswer(out, { finalUrl: upstream.url || url, setCookie: upstream.headers.getSetCookie(), status: manual ? upstream.status : undefined,
      statusText: redirect ? upstream.statusText : undefined, length: out.get("content-length"), encoding: encoded ? upstream.headers.get("content-encoding") : null });
    if (redirect) return new Response(null, { headers: out });
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
    return failedAnswer(failureKind(error), String(error));
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
