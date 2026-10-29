// What the dev server (server.ts), the Pages deployment (scripts/build-prod.ts, functions/) and the backend (backend/routes.ts) agree on:
// the shell page's isolation, and whose page a request comes from.
import { WORKER_SCRIPTS } from "../worker-scripts.ts";

/** what a frame inside the cross-origin isolated page embeds on. Credentialless embedding takes a WebView page's
 *  cross-origin subresources without their consent, as no-cors requests without credentials. */
export const EMBEDDER = { "cross-origin-embedder-policy": "credentialless" };
/** Cross-origin isolation, which lets process Workers share memory: the paths of the shell page and its Worker scripts
 *  answer with it, on the dev server and in the Pages deployment's _headers. A subresource needs none. */
export const ISOLATION = { "cross-origin-opener-policy": "same-origin", ...EMBEDDER };
export const ISOLATED_PATHS = ["/", ...Object.values(WORKER_SCRIPTS).map(({ url }) => url)];

export type Header = (name: string) => string | null | undefined;
/** the origin of the page a request comes from, as the browser that sent it says: the page's Origin (a WebSocket's, a POST's),
 *  or for a same-origin GET, which names none, the origin it was sent to. A client outside a browser can claim either. */
export function pageOrigin(url: URL, header: Header): string | null {
  return header("origin") || (header("sec-fetch-site") === "same-origin" ? url.origin : null);
}
