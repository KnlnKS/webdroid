import { createServer } from "node:http";
import { respond } from "../scripts/serve.ts";
import { sharedRoute } from "../src/shell/serve-routes.ts";
import { attachSockets, backendHost } from "./server.ts";

const app = new URL(process.env.APP_ORIGIN ?? "https://webdroid.pages.dev");
const renderer = new URL(process.env.WEBVIEW_ORIGIN ?? "http://localhost:8787");
if (app.origin === renderer.origin) throw new Error("WebView must use a separate site");
const host = backendHost({ publicOnly: true, webviewOrigin: () => renderer.origin,
  isApp: origin => {
    const page = URL.parse(origin);
    return page?.protocol === app.protocol && (page.host === app.host || app.hostname.endsWith(".pages.dev") && page.hostname.endsWith(`.${app.hostname}`) && page.port === app.port);
  },
});
const server = createServer((req, res) => void respond(req, res, request => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ status: "ok" });
  const route = sharedRoute(url, host);
  return route ? route(request) : url.pathname === "/" ? Response.redirect(app.origin, 308) : new Response("not found", { status: 404 });
}, renderer.protocol));
const sockets = attachSockets(server, host);
server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1", () => console.log(`Backend listening on ${JSON.stringify(server.address())}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  for (const peer of sockets.clients) peer.close(1012, "Service restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
