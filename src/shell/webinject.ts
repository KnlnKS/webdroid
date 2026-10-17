// The programs a WebView's renderer runs, bundled from shell/webpage (scripts/build-web.ts): the page
// script every page's document starts with, the renderer bootstrap document and the proxy worker.
export { WEB_INJECT, WEB_FRAME, WEB_PROXY_WORKER } from "./webpage.gen.ts";

/** a WebView frame's sandbox: its own (renderer) origin, and no navigation of the app's window */
export const WEB_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
