import index from "./index.html";
import processIndex from "./process.html";
import { WEB_INJECT, WEB_PROXY_WORKER } from "./src/shell/webinject";
import { openInstall } from "./src/shell/install";
import { prepareSystemPackages } from "./scripts/system-packages";

await prepareSystemPackages();

type TcpData = { host: string; port: number; tls: boolean; sock: import("bun").Socket | null; ready: boolean; pending: (Uint8Array | Buffer)[] };

// Hop-by-hop/encoding headers never survive the proxy; the framing/isolation set is dropped
// only for `frame=1`, where the shell embeds the document in an iframe it must be able to script.
const DROP = /^(content-encoding|content-length|transfer-encoding|set-cookie)$/i;
const DROP_FRAME = /^(x-frame-options|content-security-policy(-report-only)?|cross-origin-(opener|embedder)-policy)$/i;
const attr = (s: string) => s.replace(/[&"<]/g, (c) => c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&lt;");
/** html with `s` inserted at the top of <head>, before any of the page's own scripts */
function inHead(html: string, s: string): string {
  const m = /<head[^>]*>/i.exec(html);
  const at = m ? m.index + m[0].length : 0;
  return html.slice(0, at) + s + html.slice(at);
}

const ASSET_TYPE: Record<string, string> = {
  html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  svg: "image/svg+xml", json: "application/json", txt: "text/plain", woff2: "font/woff2", pdf: "application/pdf",
};
function serveVendor(path: string): Response {
  if (!/^(aosp\/)?[\w.-]+$/.test(path)) return new Response("nope", { status: 400 });
  return new Response(Bun.file(`vendor/${path}`), { headers: { "cache-control": "max-age=31536000, immutable" } });
}

const assetCache = new Map<string, Promise<Record<string, Uint8Array>>>();
/** The apk's assets/ tree, through the same merge the shell boots: a split install's assets
 *  live in its splits, so filtering the container's own entries finds nothing. */
function apkAssets(apk: string): Promise<Record<string, Uint8Array>> {
  let pending = assetCache.get(apk);
  if (!pending) {
    pending = Bun.file(`apks/${apk}`).arrayBuffer()
      .then((bytes) => openInstall(new Uint8Array(bytes)).zip)
      .catch((error: unknown) => { assetCache.delete(apk); throw error; });
    assetCache.set(apk, pending);
  }
  return pending;
}

const server: Bun.Server<TcpData> = Bun.serve({
  port: Number(process.env.PORT ?? 4080),
  development: { hmr: false },
  routes: {
    "/": index,
    "/process": processIndex,
    "/webview-worker.js": () => new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } }),
    "/proxy": async (req) => {
      const q = new URL(req.url).searchParams;
      const url = q.get("url");
      const frame = q.get("frame") === "1";
      if (!url || !/^https?:\/\//.test(url)) return new Response("bad url", { status: 400 });
      try {
        const headers = new Headers();
        // forward selected headers the app set (via x-wd-* prefix)
        req.headers.forEach((v, k) => {
          if (k.startsWith("x-wd-")) headers.set(k.slice(5), v);
        });
        const encoded = !frame && headers.has("accept-encoding");
        const upstream = await fetch(url, {
          method: req.method === "HEAD" ? "HEAD" : req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "follow",
          decompress: !encoded,
        });
        const h = new Headers();
        upstream.headers.forEach((v, k) => {
          if (!DROP.test(k) && !(frame && DROP_FRAME.test(k))) h.set(k, v);
        });
        h.set("Access-Control-Allow-Origin", "*");
        h.set("x-wd-final-url", upstream.url);
        if (encoded && upstream.headers.has("content-encoding")) h.set("x-wd-content-encoding", upstream.headers.get("content-encoding")!);
        if (frame && upstream.body && /^text\/html/i.test(upstream.headers.get("content-type") ?? "")) {
          // Served from our origin so the shell can script it; <base> keeps its subresources and
          // links resolving against the real one. text() re-encodes as UTF-8, so say so.
          h.set("content-type", "text/html; charset=utf-8");
          return new Response(inHead(await upstream.text(), `<meta name="wd-proxy-url" content="${attr(upstream.url)}"><base href="${attr(upstream.url)}">` + WEB_INJECT), { status: upstream.status, headers: h });
        }
        return new Response(upstream.body, { status: upstream.status, headers: h });
      } catch (e) {
        // a WebView reads the meta to report onReceivedError — a contract, not text sniffing
        if (frame) return new Response(`<!doctype html><meta name="wd-proxy-error" content="${attr(String(e))}">`,
          { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response(`proxy error: ${e}`, { status: 502 });
      }
    },
    // an apk's assets/ entry — what file:///android_asset/ resolves to inside a WebView. Path-shaped
    // so a page's relative subresources resolve to siblings, as they do under android_asset.
    "/asset/:apk/*": async (req) => {
      // the apk segment is measured in the raw pathname, so a name that had to be escaped
      // ("Among%20Us.xapk") must not be counted at its decoded length
      const [, rawApk, rawPath] = /^\/asset\/([^/]+)\/(.*)$/.exec(new URL(req.url).pathname) ?? [];
      const apk = decodeURIComponent(rawApk ?? "");
      const path = decodeURIComponent(rawPath ?? "");
      if (apk.includes("/") || apk.includes("..") || !path.startsWith("assets/") || path.includes("..")) return new Response("nope", { status: 400 });
      const bytes = (await apkAssets(apk))[path];
      if (!bytes) return new Response("not found", { status: 404 });
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const type = ASSET_TYPE[ext] ?? "application/octet-stream";
      if (ext === "html") return new Response(inHead(new TextDecoder().decode(bytes), WEB_INJECT), { headers: { "content-type": type } });
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } });
    },
    "/Roboto/:file": (req) => {
      const f = req.params.file;
      if (!/^[\w.-]+$/.test(f)) return new Response("nope", { status: 400 });
      return new Response(Bun.file(`public/${f}`));
    },
    "/sqljs/:file": (req) => {
      const f = req.params.file;
      if (!/^[\w.-]+$/.test(f)) return new Response("nope", { status: 400 });
      return new Response(Bun.file(`node_modules/sql.js/dist/${f}`));
    },
    // the android: resource package (bun run gen-framework-res) and, under vendor/aosp, the
    // device's own framework.jar + framework-res.apk (bun run gen-framework). Both only change
    // when the device profile does, so let the browser keep them across reloads.
    "/vendor/:file": (req) => serveVendor(req.params.file),
    "/vendor/aosp/:file": (req) => serveVendor(`aosp/${req.params.file}`),
    "/vendor/microg/:file": (req) => {
      const file = req.params.file;
      if (!/^[\w.-]+$/.test(file)) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = { "cache-control": file.endsWith(".json") ? "no-cache" : "public, max-age=31536000, immutable" };
      if (file.endsWith(".gz") && !new URL(req.url).searchParams.has("raw")) headers["content-encoding"] = "gzip";
      return new Response(Bun.file("vendor/microg/" + file), { headers });
    },
    "/apks": async () => {
      const names: string[] = [];
      for await (const f of new Bun.Glob("*.{apk,xapk}").scan("apks")) names.push(f);
      return Response.json(names.sort());
    },
    "/apks/:name": (req) => {
      const name = decodeURIComponent(req.params.name);
      if (name.includes("/") || name.includes("..")) return new Response("nope", { status: 400 });
      return new Response(Bun.file(`apks/${name}`));
    },
  },
  // Raw TCP over a WebSocket. A page cannot open a socket, but every Java networking stack
  // ultimately wants one, so the dev server lends it ours: one WS carries one TCP connection.
  // Java sockets can ask the relay to terminate TLS; native stacks pass their own TLS bytes
  // through the same relay unchanged.
  // A text control frame means connected and carries the relay's local endpoint; a close before
  // that means the connect failed. Relay still accepts the old plain "ok" frame.
  //
  // This is an outbound proxy for whatever the emulated app asks for — the same trust boundary
  // as /proxy above, and the same reason both are dev-server-only: bound to loopback, never
  // meant to face a network.
  fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname !== "/tcp") return new Response("not found", { status: 404 });
    const host = u.searchParams.get("host") ?? "";
    const port = Number(u.searchParams.get("port"));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response("bad target", { status: 400 });
    }
    const data: TcpData = { host, port, tls: u.searchParams.get("tls") === "1", sock: null, ready: false, pending: [] };
    return srv.upgrade(req, { data }) ? undefined : new Response("expected websocket", { status: 400 });
  },
  websocket: {
    async open(ws) {
      const d = ws.data;
      // A TLS socket silently drops (returns 0 for) anything written before its handshake
      // completes, and connect() resolves on the TCP open, not the handshake. The ready control
      // frame goes out only once the socket can carry bytes, and anything that arrives before
      // then is queued.
      const ready = (socket: import("bun").Socket) => {
        d.ready = true;
        ws.send(JSON.stringify({
          type: "ready", localFamily: socket.localFamily,
          localAddress: socket.localAddress, localPort: socket.localPort,
        }));
        for (const m of d.pending.splice(0)) d.sock?.write(m);
      };
      try {
        d.sock = await Bun.connect({
          hostname: d.host, port: d.port, tls: d.tls,
          socket: {
            data: (_s, chunk) => { ws.send(chunk); },
            handshake: (socket, ok, err) => { if (ok) ready(socket); else ws.close(4001, String(err ?? "tls handshake failed").slice(0, 100)); },
            close: () => ws.close(),
            error: () => ws.close(),
          },
        });
        if (!d.tls) ready(d.sock);
      } catch (e) {
        ws.close(4000, String(e).slice(0, 100));
      }
    },
    message(ws, msg) {
      if (typeof msg === "string") return;
      if (ws.data.ready) ws.data.sock?.write(msg); else ws.data.pending.push(msg);
    },
    close(ws) { ws.data.sock?.end(); },
  },
});

console.log(`webdroid dev server: http://localhost:${server.port}`);
