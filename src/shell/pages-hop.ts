// The Pages Function (functions/) forwards the backend's routes on the page's own origin. Two things would not survive that hop as is: the
// backend would take a same-origin request that names no origin for its own, and Cloudflare answers a Function's subrequest that ends in 502
// or 504 with its own error page, which drops the proxy's failure kind and an upstream answer's final URL. So the Function names the page's
// origin and asks the backend (backend/index.ts) to carry such a status in a header, which the Function restores.
import { pageOrigin } from "./serve-routes.ts";

const HELD = "webdroid-held-status";

/** `request` as the backend at `origin` receives it */
export function forward(request: Request, origin: URL): Request {
  const url = new URL(request.url), headers = new Headers(request.headers), page = pageOrigin(url, name => headers.get(name));
  if (page) headers.set("origin", page);
  headers.set(HELD, "1");
  return new Request(new URL(url.pathname + url.search, origin), new Request(request, { headers }));
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
