// A redirect in the proxy's manual=1 answer, followed one hop at a time by the WebView's proxy worker,
// HttpURLConnection and the media server, as fetch's redirect mode follows it.

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
