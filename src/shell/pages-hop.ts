// Cloudflare answers a Pages Function's subrequest that ends in 502 or 504 with its own error page, which drops the
// proxy's failure kind and an upstream answer's final URL. So the Function (functions/) asks the backend (backend/index.ts)
// to carry such a status in a header, and restores it.
const HELD = "webdroid-held-status";

/** a request to the backend that asks it to hold a 502 or 504 */
export function holding(headers: Headers): Headers {
  headers.set(HELD, "1");
  return headers;
}

/** the backend's `response` to `request`, a 502 or 504 held as a 200 when the request asks */
export function hold(request: Request, response: Response): Response {
  if (!request.headers.has(HELD) || response.status !== 502 && response.status !== 504) return response;
  const headers = new Headers(response.headers);
  headers.set(HELD, String(response.status));
  return new Response(response.body, { headers });
}

/** `response` with the status the backend held restored */
export function release(response: Response): Response {
  const status = Number(response.headers.get(HELD));
  if (!status) return response;
  const headers = new Headers(response.headers);
  headers.delete(HELD);
  return new Response(response.body, { status, headers });
}
