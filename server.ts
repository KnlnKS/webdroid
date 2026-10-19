// The dev server's own routes, as a Vite plugin: Vite serves the page and its modules, this answers what the page asks of a
// server (packages, the reference build's files, the proxy, the WebView bridge) and lends it sockets.
import dns from "node:dns/promises";
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import { WEB_PROXY_WORKER, WEB_FRAME } from "./src/shell/webinject.ts";
import { webDocument } from "./src/shell/webhtml.ts";
import { forwardDnsMessage, proxyRequest, sandboxDocument } from "./src/shell/proxy.ts";
import { openInstall } from "./src/shell/install.ts";
import { mimeOf } from "./src/mime.ts";
import { WebRelay } from "./src/shell/webrelay.ts";
import { prepareSystemPackages } from "./scripts/system-packages.ts";
import { aotFile, aotManifest } from "./scripts/aot-serve.ts";
import { bundle } from "./scripts/bundle.ts";
import { runNode } from "./scripts/node.ts";
import { fileResponse, respond, toWeb } from "./scripts/serve.ts";
import { WORKER_SCRIPTS } from "./src/worker-scripts.ts";
import { relayTcp, relayUdp, tcpTarget } from "./socket-relays.ts";

const apkDirectory = process.env.WEBDROID_APK_DIR ?? "apks";
const fuzzOrigin = process.env.WEBDROID_FUZZ_ORIGIN ? new URL(process.env.WEBDROID_FUZZ_ORIGIN) : null;
if (fuzzOrigin && !["127.0.0.1", "localhost"].includes(fuzzOrigin.hostname))
  throw new Error("WEBDROID_FUZZ_ORIGIN must use loopback");

function proxyTarget(requested: string): string {
  if (!fuzzOrigin) return requested;
  const url = new URL(requested);
  if (url.origin !== "http://127.0.0.1:4876") return requested;
  return new URL(`${url.pathname}${url.search}`, fuzzOrigin).href;
}

/** fetch that leaves the body encoded: node's fetch always decodes, and a guest that asked for an encoding decodes it itself */
async function fetchEncoded(url: string, init: RequestInit): Promise<Response> {
  for (let hops = 0; ; hops++) {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const body = init.body ? Buffer.from(init.body as ArrayBuffer) : undefined, headers = Object.fromEntries(init.headers as Headers);
      if (body) headers["content-length"] ??= String(body.length);
      const req = (url.startsWith("https:") ? https : http).request(url, { method: init.method, headers }, resolve);
      req.once("error", reject).end(body);
    });
    const status = res.statusCode!, location = res.headers.location;
    if (init.redirect !== "manual" && location && [301, 302, 303, 307, 308].includes(status) && hops < 20) {
      res.resume();
      const next = new URL(location, url);
      if (next.origin !== new URL(url).origin) {
        // as node's fetch does: credentials stay with the origin they were sent to
        const headers = new Headers(init.headers);
        for (const name of ["authorization", "proxy-authorization", "cookie", "host"]) headers.delete(name);
        init = { ...init, headers };
      }
      url = next.href;
      if (status === 303 || ((status === 301 || status === 302) && init.method === "POST")) {
        const headers = new Headers(init.headers);
        for (const name of ["content-length", "content-type", "content-encoding"]) headers.delete(name);
        init = { ...init, method: "GET", headers, body: undefined };
      }
      continue;
    }
    const headers = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
    const empty = init.method === "HEAD" || [204, 205, 304].includes(status);
    if (empty) res.resume();
    const response = new Response(empty ? null : toWeb(res), { status, statusText: res.statusMessage, headers });
    return Object.defineProperty(response, "url", { value: url });
  }
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
function serveFile(req: Request, dir: string, name: string, headers?: Record<string, string>): Response {
  if (!name || /[/\\]|\.\./.test(name)) return new Response("nope", { status: 400 });
  return fileResponse(`${dir}/${name}`, req, headers);
}
/** a reference-build file mirrored under vendor/aosp at its device path (PLATFORM_DATA) */
const devicePath = (req: Request, path: string) => path.includes("..") ? new Response("nope", { status: 400 }) : fileResponse(path.slice(1), req, { "cache-control": IMMUTABLE });

/** `make(key)` once per key, made again after it fails or the cache is cleared */
function memo<T>(make: (key: string) => Promise<T>): ((key?: string) => Promise<T>) & { clear(): void } {
  const made = new Map<string, Promise<T>>();
  return Object.assign((key = "") => {
    let pending = made.get(key);
    if (!pending) made.set(key, pending = make(key).catch((e: unknown) => { made.delete(key); throw e; }));
    return pending;
  }, { clear: () => made.clear() });
}
/** scripts/font-index.ts, run once: the reference build's fonts change only with gen-framework */
const fontIndexJson = memo(() => runNode("scripts/font-index.ts"));
/** The apk's assets/ tree, through the same merge the shell boots: a split install's assets
 *  live in its splits, so filtering the container's own entries finds nothing. */
const apkAssets = memo(async (apk) => openInstall(new Uint8Array(await readFile(`${apkDirectory}/${apk}`))).zip);
/** a Worker script bundled for the page, until a source changes */
const workerBuild = memo((entry) => bundle(entry, { define: { "process.env.NODE_ENV": '"development"' } }));
const workerScript = async (entry: string) => new Response(await workerBuild(entry), { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });

type Route = (req: Request, url: URL, params: string[]) => Response | Promise<Response>;
const ROUTES: [RegExp, Route][] = [
  // as written: Vite's HTML transform would only add its HMR client, which this server leaves out
  [/^\/$/, (req) => fileResponse("index.html", req, { "cache-control": "no-cache" })],
  [/^\/webview$/, () => html(WEB_FRAME)],
  [/^\/webview-call$/, (req) => webRelay.call(req)],
  [/^\/webview-origin$/, (_, url) => {
    if (process.env.WEBDROID_WEBVIEW_ORIGIN) return Response.json(process.env.WEBDROID_WEBVIEW_ORIGIN);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("Configure WEBDROID_WEBVIEW_ORIGIN on a separate site", { status: 503 });
    // a browser resolves every *.localhost name to this loopback server, each its own site
    return Response.json(`${url.protocol}//*.localhost:${url.port}`);
  }],
  ...Object.values(WORKER_SCRIPTS).map(({ url, entry }): [RegExp, Route] => [new RegExp(`^${url.replaceAll(".", "\\.")}$`), () => workerScript(entry)]),
  [/^\/font-index\.json$/, async () => new Response(await fontIndexJson(), { headers: { "content-type": "application/json" } })],
  [/^\/webview-worker\.js$/, () => new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } })],
  [/^\/dns-query$/, (req) => forwardDnsMessage(req)],
  [/^\/proxy$/, (req) => proxyRequest(req, { target: proxyTarget, bridgeCall: (call) => webRelay.call(call),
    fetchUpstream: (url, init, encoded) => encoded ? fetchEncoded(url, init) : fetch(url, init) })],
  // an apk's assets/ entry — what file:///android_asset/ resolves to inside a WebView. Path-shaped
  // so a page's relative subresources resolve to siblings, as they do under android_asset.
  [/^\/asset\/([^/]+)\/(.*)$/, async (req, _, [rawApk, rawPath]) => {
    // the apk segment is measured in the raw pathname, so an escaped name is not counted at its decoded length
    const apk = decodeURIComponent(rawApk), path = decodeURIComponent(rawPath);
    if (apk.includes("/") || apk.includes("..") || !path.startsWith("assets/") || path.includes("..")) return new Response("nope", { status: 400 });
    const bytes = (await apkAssets(apk))[path];
    if (!bytes) return new Response("not found", { status: 404 });
    const type = mimeOf(path) ?? "application/octet-stream";
    if (type === "text/html") return sandboxDocument(req, new Response(await webDocument(new TextDecoder().decode(bytes)), { headers: { "content-type": type } }));
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } });
  }],
  [/^\/aot\/current\.json$/, () => aotManifest()],
  [/^\/aot\/([^/]+)\/([^/]+)$/, (req, _, [key, file]) => aotFile(req, key, file)],
  [/^\/sqljs\/([^/]+)$/, (req, _, [file]) => serveFile(req, "vendor/sql.js/dist", file)],
  [/^\/(canvaskit\.wasm)$/, (req, _, [file]) => serveFile(req, "node_modules/canvaskit-wasm/bin", file, { "cache-control": IMMUTABLE })],
  [/^\/(harfbuzz(?:-subset)?\.wasm)$/, (req, _, [file]) => serveFile(req, "node_modules/harfbuzzjs/dist", file)],
  // under vendor/aosp, the reference build's class path, framework-res.apk and its ICU and time
  // zone files (pnpm gen-framework): they only change with the build, so let the browser keep them.
  // The page's modules among them are Vite's to serve.
  [/^\/(vendor(?:\/aosp(?:\/boot)?)?)\/(?![^/]*\.[cm]?[jt]s$)([^/]+)$/,(req, _, [dir, file]) => serveFile(req, dir, file, { "cache-control": IMMUTABLE })],
  [/^\/vendor\/aosp\/(?:apex|system|data)\//, (req, url) => devicePath(req, url.pathname)],
  [/^\/vendor\/microg\/([^/]+)$/, (req, url, [file]) => {
    const headers: Record<string, string> = { "cache-control": file.endsWith(".json") ? "no-cache" : IMMUTABLE };
    if (file.endsWith(".gz") && !url.searchParams.has("raw")) {
      headers["content-encoding"] = "gzip";
      headers["content-type"] = "application/octet-stream";
      // A .gz download filename makes WebKit retain the compressed transport body.
      headers["content-disposition"] = "inline";
    }
    return serveFile(req, "vendor/microg", file, headers);
  }],
  [/^\/apks$/, () => Response.json(globSync("*.{apk,xapk}", { cwd: apkDirectory }).sort())],
  [/^\/apks\/([^/]+)$/, (req, _, [name]) => serveFile(req, apkDirectory, decodeURIComponent(name))],
  // Whether a name resolves: the guest's resolvers answer a synthetic address for every name
  // (the relay dials by name), so this is how a name that does not exist fails as it would on a
  // device, instead of every connection to it being refused.
  [/^\/dns$/, (_, url) => {
    const name = url.searchParams.get("host") ?? "";
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return new Response("bad name", { status: 400 });
    return dns.lookup(name, { all: true }).then(
      (addresses) => Response.json({ addresses: addresses.map((a) => a.address) }),
      (e: { code?: string }) => new Response(String(e.code ?? e), { status: e.code === "ENOTFOUND" || e.code === "ENODATA" ? 404 : 502 }));
  }],
];
const webRelay = new WebRelay();
const BRIDGE_ID = /^[a-f0-9-]{36}$/;
export function devServer(): Plugin {
  return {
    name: "webdroid:dev-server",
    async configureServer(server) {
      await prepareSystemPackages();
      server.watcher.on("all", () => workerBuild.clear());
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        for (const [pattern, route] of ROUTES) {
          const match = pattern.exec(url.pathname);
          if (match) return void respond(req, res, (request) => route(request, new URL(request.url), match.slice(1)));
        }
        // a renderer frame at any other path of its origin
        if (BRIDGE_ID.test(url.searchParams.get("__wd_bridge") ?? "")) return void respond(req, res, () => html(WEB_FRAME));
        next();
      });
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (req, socket, head) => {
        const url = URL.parse(req.url ?? "/", `http://${req.headers.host}`);
        if (!url) return void socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        // a socket's error (a frame past the size limit) closes it, which its relay ends with
        const upgrade = (use: (ws: WebSocket) => void) => sockets.handleUpgrade(req, socket, head, (ws) => { ws.on("error", () => ws.terminate()); use(ws); });
        if (url.pathname === "/webview-socket") {
          const id = url.searchParams.get("id") ?? "";
          if (!BRIDGE_ID.test(id) || req.headers.origin !== url.origin) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\nbad bridge");
          return upgrade((ws) => {
            webRelay.open(id, ws);
            ws.on("message", (data, binary) => { if (!binary) webRelay.reply(ws, data.toString()); });
            ws.once("close", () => webRelay.close(id, ws));
          });
        }
        if (url.pathname === "/udp") return upgrade(relayUdp);
        if (url.pathname !== "/tcp") return void socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        const target = tcpTarget(url);
        if (typeof target === "string") return void socket.end(`HTTP/1.1 400 Bad Request\r\n\r\n${target}`);
        upgrade((ws) => relayTcp(ws, target));
      });
    },
  };
}
