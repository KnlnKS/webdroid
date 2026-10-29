// The public backend: what the shell page on Pages forwards here (functions/), and the WebView renderer's origin.
import { createServer } from "node:http";
import { respond } from "../scripts/serve.ts";
import { hold } from "../src/shell/pages-hop.ts";
import { publicNetwork } from "./network.ts";
import { backend, pagesSite } from "./routes.ts";

const app = new URL(process.env.APP_ORIGIN ?? "https://webdroid.pages.dev");
const renderer = new URL(process.env.WEBVIEW_ORIGIN ?? "http://localhost:8787");
if (app.origin === renderer.origin) throw new Error("WebView must use a separate site");
const routes = backend({ network: publicNetwork, webviewOrigin: () => renderer.origin, isApp: pagesSite(app) });
// behind the TLS proxy, a request arrives as plain HTTP for the renderer's origin
const server = createServer((req, res) => void respond(req, res, async request => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ status: "ok" });
  const route = routes.route(url);
  if (route) return hold(request, await route(request));
  return url.pathname === "/" ? Response.redirect(app.origin, 308) : new Response("not found", { status: 404 });
}, renderer.protocol));
const sockets = routes.attach(server);
server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1", () => console.log(`Backend listening on ${JSON.stringify(server.address())}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  for (const peers of sockets) for (const peer of peers.clients) peer.close(1012, "Service restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
