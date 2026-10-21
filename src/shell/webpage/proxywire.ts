// The /proxy route's wire (proxy.ts). A request names what to fetch in its query and carries the upstream
// request's headers prefixed x-wd- (a page's fetch may set few of its own); the answer's x-wd- headers carry
// what a browser's fetch would hide or a manual redirect would lose. A redirect in a manual answer is
// followed one hop at a time by the WebView's proxy worker, HttpURLConnection and the media server, as
// fetch's redirect mode follows it.

/** what a request to the proxy asks of it */
export type ProxyQuery = {
  url: string;
  /** a redirect is the answer, its status in x-wd-status, for the client to follow */
  manual?: boolean;
  /** a frame's document, which the proxy readies for the renderer: the main frame's or a subframe's */
  frame?: "main" | "sub";
  /** the WebView whose process serves its loopback URLs and, on `intercept`, its shouldInterceptRequest */
  bridge?: string;
  intercept?: boolean;
  /** a WebView page's request, whose documents and scripts the proxy isolates */
  webview?: boolean;
  /** the upstream request's headers, for a client that can set none (a media element) */
  headers?: [string, string][];
};
export const proxyPath = (q: ProxyQuery): string => "/proxy?" + (q.manual ? "manual=1&" : "") + "url=" + encodeURIComponent(q.url)
  + (q.frame ? "&frame=1" + (q.frame === "sub" ? "&sub=1" : "") : "") + (q.bridge ? "&bridge=" + encodeURIComponent(q.bridge) : "")
  + (q.intercept ? "&intercept=1" : "") + (q.webview ? "&webview=1" : "") + (q.headers ? "&headers=" + encodeURIComponent(JSON.stringify(q.headers)) : "");
/** the query `proxyPath` wrote, or null when it names no http(s) URL or its headers are malformed */
export function parseProxyQuery(params: URLSearchParams): ProxyQuery | null {
  const url = params.get("url") ?? "", flag = (name: string) => params.get(name) === "1";
  let headers: [string, string][] | undefined;
  try { headers = JSON.parse(params.get("headers") ?? "null") ?? undefined; } catch { return null; }
  return /^https?:\/\//.test(url) ? { url, manual: flag("manual"), frame: flag("frame") ? flag("sub") ? "sub" : "main" : undefined,
    bridge: params.get("bridge") ?? undefined, intercept: flag("intercept"), webview: flag("webview"), headers } : null;
}

/** the upstream request's headers among a request to the proxy's */
export function fromProxyHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => { if (name.startsWith("x-wd-")) out.set(name.slice(5), value); });
  return out;
}

/** what an answer carries past the upstream response's own headers */
export type ProxyAnswer = {
  /** where the request landed */
  finalUrl: string;
  /** the Set-Cookie values, which a browser hides from fetch */
  setCookie?: string[];
  /** a manual answer's upstream status, and an opaque redirect's text */
  status?: number;
  statusText?: string;
  /** the body's length, which a server streaming the answer may drop */
  length?: string | null;
  /** the body's encoding, left for the client to decode */
  encoding?: string | null;
};
export function writeAnswer(out: Headers, answer: ProxyAnswer): void {
  out.set("x-wd-final-url", answer.finalUrl);
  if (answer.setCookie?.length) out.set("x-wd-set-cookie", JSON.stringify(answer.setCookie));
  if (answer.status !== undefined) out.set("x-wd-status", String(answer.status));
  if (answer.statusText !== undefined) out.set("x-wd-status-text", answer.statusText);
  if (answer.length) out.set("x-wd-content-length", answer.length);
  if (answer.encoding) out.set("x-wd-content-encoding", answer.encoding);
}
/** the proxy's own failure, which names no final URL (an upstream 502 does): `kind` is the class of the
 *  socket error the device would see, host, refused, timeout, tls or io */
export const failedAnswer = (kind: string, detail: string) => new Response("proxy error: " + detail, { status: 502, headers: { "x-wd-error": kind } });

const WIRE = /^x-wd-(final-url|status|status-text|content-length|error)$/;
/** an answer as the client reads it */
export function readAnswer(response: Response) {
  const finalUrl = response.headers.get("x-wd-final-url"), setCookie: string[] = [], headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name === "x-wd-set-cookie") for (const cookie of JSON.parse(value) as string[]) { setCookie.push(cookie); headers.push(["set-cookie", cookie]); }
    else if (!WIRE.test(name)) headers.push([name === "x-wd-content-encoding" ? "content-encoding" : name, value]);
  });
  const length = response.headers.get("content-length") ?? response.headers.get("x-wd-content-length");
  if (length && !response.headers.has("content-length")) headers.push(["content-length", length]);
  return {
    status: proxyStatus(response), statusText: response.headers.get("x-wd-status-text") ?? response.statusText, finalUrl, setCookie,
    /** the upstream response's headers, Set-Cookie and Content-Length restored */
    headers, length,
    /** the proxy's own failure (failedAnswer's kind), or null for an upstream answer */
    error: response.status === 502 && !finalUrl ? response.headers.get("x-wd-error") ?? "io" : null,
  };
}

/** a request to the proxy: `headers` are the upstream request's, prefixed x-wd- */
export type ProxyRequest = { url: string; method: string; headers: Headers; body?: ArrayBuffer | Uint8Array<ArrayBuffer> };
/** the upstream status, which x-wd-status carries past an opaque redirect */
export const proxyStatus = (response: Response): number => Number(response.headers.get("x-wd-status")) || response.status;
/** the request `response` redirects `request` to, or null when it is no redirect. 303 (or 301/302 after
 *  a POST) turns it into a GET without its body; a hop to another origin drops its Authorization. */
export function nextHop(response: Response, request: ProxyRequest): ProxyRequest | null {
  const status = proxyStatus(response), location = response.headers.get("location");
  if (!location || status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return null;
  const url = new URL(location, request.url).href, headers = new Headers(request.headers);
  let { method, body } = request;
  if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") { method = "GET"; body = undefined; headers.delete("x-wd-content-type"); }
  if (new URL(url).origin !== new URL(request.url).origin) headers.delete("x-wd-authorization");
  return { url, method, headers, body };
}
