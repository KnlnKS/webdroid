// The dev server's own routes, as a Vite plugin: Vite serves the page and its modules, this answers what the page asks of a
// server (packages, the reference build's files, the proxy, the WebView bridge) and lends it sockets. The routes the
// production backend answers alike are src/shell/serve-routes.ts's.
import { globSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { webDocument } from "./src/shell/webhtml.ts";
import { sandboxDocument } from "./src/shell/proxy.ts";
import { openInstall } from "./src/shell/install.ts";
import { gzipHeaders, mimeOf } from "./src/mime.ts";
import { backendHost, attachSockets } from "./backend/server.ts";
import { prepareSystemPackages } from "./scripts/system-packages.ts";
import { aotFile, aotManifest } from "./scripts/aot-serve.ts";
import { bundle } from "./scripts/bundle.ts";
import { runNode } from "./scripts/node.ts";
import { fileResponse, respond } from "./scripts/serve.ts";
import { WORKER_SCRIPTS } from "./src/worker-scripts.ts";
import { ISOLATION, sharedRoute } from "./src/shell/serve-routes.ts";

const apkDirectory = process.env.WEBDROID_APK_DIR ?? "apks";
const IMMUTABLE = "public, max-age=31536000, immutable";
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
const workerScript = async (entry: string) => new Response(await workerBuild(entry), { headers: { "content-type": "text/javascript", "cache-control": "no-cache", ...ISOLATION } });

type Route = (req: Request, url: URL, params: string[]) => PromiseOrVal<Response>;
const ROUTES: [RegExp, Route][] = [
  // as written: Vite's HTML transform would only add its HMR client, which this server leaves out
  [/^\/$/, (req) => fileResponse("index.html", req, { "cache-control": "no-cache", ...ISOLATION })],
  ...Object.values(WORKER_SCRIPTS).map(({ url, entry }): [RegExp, Route] => [new RegExp(`^${url.replaceAll(".", "\\.")}$`), () => workerScript(entry)]),
  [/^\/font-index\.json$/, async () => new Response(await fontIndexJson(), { headers: { "content-type": "application/json" } })],
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
  [/^\/aot\/current\.json$/, (req) => aotManifest(new URL(req.url).searchParams.get("key"))],
  [/^\/aot\/([^/]+)\/([^/]+)$/, (req, _, [key, file]) => aotFile(req, key, file)],
  [/^\/sqljs\/([^/]+)$/, (req, _, [file]) => serveFile(req, "vendor/sql.js/dist", file)],
  [/^\/(canvaskit\.wasm)$/, (req, _, [file]) => serveFile(req, "node_modules/canvaskit-wasm/bin", file, { "cache-control": IMMUTABLE })],
  [/^\/(harfbuzz(?:-subset)?\.wasm)$/, (req, _, [file]) => serveFile(req, "node_modules/harfbuzzjs/dist", file)],
  // under vendor/aosp, the reference build's class path, framework-res.apk and its ICU and time
  // zone files (pnpm gen-framework): they only change with the build, so let the browser keep them.
  // The page's modules among them are Vite's to serve.
  [/^\/(vendor(?:\/aosp(?:\/boot)?)?)\/(?![^/]*\.[cm]?[jt]s$)([^/]+)$/,(req, _, [dir, file]) => serveFile(req, dir, file, { "cache-control": IMMUTABLE })],
  [/^\/vendor\/aosp\/(?:apex|system|data)\//, (req, url) => devicePath(req, url.pathname)],
  [/^\/vendor\/microg\/([^/]+)$/, (req, url, [file]) =>
    serveFile(req, "vendor/microg", file, { "cache-control": file.endsWith(".json") ? "no-cache" : IMMUTABLE, ...gzipHeaders(url) })],
  [/^\/apks$/, () => Response.json(globSync("*.{apk,xapk}", { cwd: apkDirectory }).sort())],
  [/^\/apks\/([^/]+)$/, (req, _, [name]) => serveFile(req, apkDirectory, decodeURIComponent(name))],
];
const host = backendHost({
  webviewOrigin: (url) => process.env.WEBDROID_WEBVIEW_ORIGIN
    ?? (url.hostname === "localhost" || url.hostname === "127.0.0.1" ? `${url.protocol}//*.localhost:${url.port}` : null),
  isApp: (origin, url) => origin === url.origin,
  publicOnly: false,
});
export function devServer(): Plugin {
  return {
    name: "webdroid:dev-server",
    async configureServer(server) {
      await prepareSystemPackages();
      server.watcher.on("all", () => workerBuild.clear());
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost"), shared = sharedRoute(url, host);
        if (shared) return void respond(req, res, shared);
        for (const [pattern, route] of ROUTES) {
          const match = pattern.exec(url.pathname);
          if (match) return void respond(req, res, (request) => route(request, new URL(request.url), match.slice(1)));
        }
        next();
      });
      if (server.httpServer) attachSockets(server.httpServer, host);
    },
  };
}
