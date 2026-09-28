import index from "./index.html";
import processIndex from "./process.html";
import { WEB_PROXY_WORKER, WEB_FRAME } from "./src/shell/webinject";
import { webDocument } from "./src/shell/webhtml";
import { forwardDnsMessage, proxyRequest } from "./src/shell/proxy";
import { openInstall } from "./src/shell/install";
import { EXT_MIME } from "./src/mime";
import { prepareSystemPackages } from "./scripts/system-packages";
import { ensureFrameworkRes } from "./scripts/gen-framework-res";

import { WebRelay, type WebRelayData } from "./src/shell/webrelay";
import { parseIpv4 } from "./src/shell/relay";
import dns from "node:dns/promises";

await Promise.all([prepareSystemPackages(), ensureFrameworkRes()]);
const webRelay = new WebRelay();
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

type TcpData = { kind: "tcp"; host: string; port: number; tls: boolean; alpn: string[]; sock: import("bun").Socket | null; ready: boolean; closed: boolean; pending: Uint8Array[]; pendingBytes: number };
type UdpData = { kind: "udp"; sock: { send(data: Uint8Array, port: number, address: string): boolean; close(): void } | null; closed: boolean; addresses: Map<string, Promise<string>> };
type SocketData = TcpData | UdpData | WebRelayData;
const MAX_PENDING_TCP_BYTES = 8 * 1024 * 1024;

function flushTcp(ws: import("bun").ServerWebSocket<SocketData>, data: TcpData): void {
  const socket = data.sock;
  if (!socket || !data.ready || data.closed) return;
  while (data.pending.length) {
    const bytes = data.pending[0];
    const written = socket.write(bytes);
    if (written < 0) { ws.close(); return; }
    data.pendingBytes -= written;
    if (written < bytes.length) {
      data.pending[0] = bytes.subarray(written);
      return;
    }
    data.pending.shift();
  }
}

const IMMUTABLE = "public, max-age=31536000, immutable";
function serveFile(dir: string, name: string, headers?: Record<string, string>): Response {
  if (!name || /[/\\]|\.\./.test(name)) return new Response("nope", { status: 400 });
  return new Response(Bun.file(`${dir}/${name}`), { headers });
}

const assetCache = new Map<string, Promise<Record<string, Uint8Array>>>();
/** The apk's assets/ tree, through the same merge the shell boots: a split install's assets
 *  live in its splits, so filtering the container's own entries finds nothing. */
function apkAssets(apk: string): Promise<Record<string, Uint8Array>> {
  let pending = assetCache.get(apk);
  if (!pending) {
    pending = Bun.file(`${apkDirectory}/${apk}`).arrayBuffer()
      .then((bytes) => openInstall(new Uint8Array(bytes)).zip)
      .catch((error: unknown) => { assetCache.delete(apk); throw error; });
    assetCache.set(apk, pending);
  }
  return pending;
}

const server: Bun.Server<SocketData> = Bun.serve({
  port: Number(process.env.PORT ?? 4080),
  development: { hmr: false },
  routes: {
    "/": index,
    "/process": processIndex,
    "/webview": () => new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } }),
    "/webview-call": (req) => webRelay.call(req),
    "/webview-origin": (req) => {
      const url = new URL(req.url);
      if (process.env.WEBDROID_WEBVIEW_ORIGIN) return Response.json(process.env.WEBDROID_WEBVIEW_ORIGIN);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("Configure WEBDROID_WEBVIEW_ORIGIN on a separate site", { status: 503 });
      url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
      return Response.json(url.origin);
    },
    "/webview-worker.js": () => new Response(WEB_PROXY_WORKER, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } }),
    "/dns-query": forwardDnsMessage,
    "/proxy": (req) => proxyRequest(req, { target: proxyTarget, bridgeCall: (call) => webRelay.call(call),
      fetchUpstream: (url, init, encoded) => fetch(url, { ...init, decompress: !encoded }) }),
    // an apk's assets/ entry — what file:///android_asset/ resolves to inside a WebView. Path-shaped
    // so a page's relative subresources resolve to siblings, as they do under android_asset.
    "/asset/:apk/*": async (req) => {
      // the apk segment is measured in the raw pathname, so an escaped name is not counted at
      // its decoded length
      const [, rawApk, rawPath] = /^\/asset\/([^/]+)\/(.*)$/.exec(new URL(req.url).pathname) ?? [];
      const apk = decodeURIComponent(rawApk ?? "");
      const path = decodeURIComponent(rawPath ?? "");
      if (apk.includes("/") || apk.includes("..") || !path.startsWith("assets/") || path.includes("..")) return new Response("nope", { status: 400 });
      const bytes = (await apkAssets(apk))[path];
      if (!bytes) return new Response("not found", { status: 404 });
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      const type = EXT_MIME[ext] ?? "application/octet-stream";
      if (ext === "html") return new Response(await webDocument(new TextDecoder().decode(bytes)), { headers: { "content-type": type } });
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } });
    },
    "/sqljs/:file": (req) => serveFile("vendor/sql.js/dist", req.params.file),
    "/canvaskit.wasm": () => serveFile("node_modules/canvaskit-wasm/bin", "canvaskit.wasm", { "cache-control": IMMUTABLE }),
    // the android: resource package (bun run gen-framework-res) and, under vendor/aosp, the
    // device's own framework.jar + framework-res.apk (bun run gen-framework). Both only change
    // when the device profile does, so let the browser keep them across reloads.
    "/vendor/:file": (req) => serveFile("vendor", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/fonts/:file": (req) => serveFile("vendor/fonts", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/aosp/:file": (req) => serveFile("vendor/aosp", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/aosp/boot/:file": (req) => serveFile("vendor/aosp/boot", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/microg/:file": (req) => {
      const file = req.params.file;
      const headers: Record<string, string> = { "cache-control": file.endsWith(".json") ? "no-cache" : IMMUTABLE };
      if (file.endsWith(".gz") && !new URL(req.url).searchParams.has("raw")) headers["content-encoding"] = "gzip";
      return serveFile("vendor/microg", file, headers);
    },
    "/apks": async () => {
      const names: string[] = [];
      for await (const f of new Bun.Glob("*.{apk,xapk}").scan(apkDirectory)) names.push(f);
      return Response.json(names.sort());
    },
    "/apks/:name": (req) => serveFile(apkDirectory, decodeURIComponent(req.params.name)),
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
    if (/^[a-f0-9-]{36}$/.test(u.searchParams.get("__wd_bridge") ?? "")) return new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (u.pathname === "/webview-socket") {
      const id = u.searchParams.get("id") ?? "";
      if (!/^[a-f0-9-]{36}$/.test(id) || req.headers.get("origin") !== u.origin) return new Response("bad bridge", { status: 403 });
      return srv.upgrade(req, { data: { kind: "webview", id } }) ? undefined : new Response("expected websocket", { status: 400 });
    }
    // Whether a name resolves: the guest's resolvers answer a synthetic address for every name
    // (the relay dials by name), so this is how a name that does not exist fails as it would on a
    // device, instead of every connection to it being refused.
    if (u.pathname === "/dns") {
      const name = u.searchParams.get("host") ?? "";
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(name)) return new Response("bad name", { status: 400 });
      return dns.lookup(name, { all: true }).then(
        (addresses) => Response.json({ addresses: addresses.map((a) => a.address) }),
        (e: { code?: string }) => new Response(String(e.code ?? e), { status: e.code === "ENOTFOUND" || e.code === "ENODATA" ? 404 : 502 }));
    }
    if (u.pathname === "/udp") return srv.upgrade(req, { data: { kind: "udp", sock: null, closed: false, addresses: new Map() } })
      ? undefined : new Response("expected websocket", { status: 400 });
    if (u.pathname !== "/tcp") return new Response("not found", { status: 404 });
    const host = u.searchParams.get("host") ?? "";
    const port = Number(u.searchParams.get("port"));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response("bad target", { status: 400 });
    }
    const alpn = u.searchParams.getAll("alpn");
    if (alpn.length > 32 || alpn.some(p => !p.length || Buffer.byteLength(p) > 255)) return new Response("bad ALPN", { status: 400 });
    const data: TcpData = { alpn, kind: "tcp", host, port, tls: u.searchParams.get("tls") === "1", sock: null, ready: false, closed: false, pending: [], pendingBytes: 0 };
    return srv.upgrade(req, { data }) ? undefined : new Response("expected websocket", { status: 400 });
  },
  websocket: {
    async open(ws) {
      const d = ws.data;
      if (d.kind === "webview") { webRelay.open(d.id, ws); return; }
      if (d.kind === "udp") {
        try {
          const sock = await Bun.udpSocket({ socket: {
            data: (_socket, bytes, port, address) => {
              const ip = parseIpv4(address.replace(/^::ffff:/, ""));
              if (!ip || d.closed) return;
              const frame = new Uint8Array(6 + bytes.length);
              frame.set(ip); frame[4] = port >> 8; frame[5] = port & 255; frame.set(bytes, 6);
              ws.send(frame);
            },
          } });
          d.sock = sock;
          if (d.closed) sock.close();
          else ws.send("ready");
        } catch { ws.close(4000, "UDP bind failed"); }
        return;
      }
      // A TLS socket silently drops (returns 0 for) anything written before its handshake
      // completes, and connect() resolves on the TCP open, not the handshake. The ready control
      // frame goes out only once the socket can carry bytes, and anything that arrives before
      // then is queued.
      const ready = (socket: import("bun").Socket) => {
        if (d.closed) { socket.end(); return; }
        d.sock = socket;
        d.ready = true;
        ws.send(JSON.stringify({
          type: "ready", localFamily: socket.localFamily,
          localAddress: socket.localAddress, localPort: socket.localPort, alpn: socket.alpnProtocol || "",
        }));
        flushTcp(ws, d);
      };
      try {
        const socket = await Bun.connect({
          hostname: d.host, port: d.port,
          tls: d.tls ? { ALPNProtocols: Buffer.concat(d.alpn.flatMap(p => { const bytes = Buffer.from(p); return [Buffer.from([bytes.length]), bytes]; })) } : false,
          socket: {
            data: (_s, chunk) => { ws.send(chunk); },
            drain: () => flushTcp(ws, d),
            handshake: (socket, ok, err) => { if (ok) ready(socket); else ws.close(4001, String(err ?? "tls handshake failed").slice(0, 100)); },
            close: () => ws.close(),
            error: () => ws.close(),
          },
        });
        d.sock = socket;
        if (d.closed) socket.end();
        else if (!d.tls) ready(socket);
      } catch (e) {
        ws.close(4000, String(e).slice(0, 100));
      }
    },
    async message(ws, msg) {
      if (ws.data.kind === "webview") { if (typeof msg === "string") webRelay.reply(ws, msg); return; }
      if (ws.data.kind === "udp") {
        if (typeof msg === "string" || msg.length < 3) return;
        const length = msg[0], port = msg[1] << 8 | msg[2];
        if (msg.length < 3 + length || !length || !port) return;
        const host = new TextDecoder().decode(msg.subarray(3, 3 + length));
        if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) return;
        try {
          let resolved = ws.data.addresses.get(host);
          if (!resolved) {
            if (ws.data.addresses.size >= 256) ws.data.addresses.clear();
            resolved = dns.lookup(host, { family: 4 }).then((result) => result.address);
            ws.data.addresses.set(host, resolved);
          }
          const address = await resolved;
          if (!ws.data.closed) ws.data.sock?.send(msg.subarray(3 + length), port, address);
        } catch { ws.data.addresses.delete(host); }
        return;
      }
      if (typeof msg === "string") return;
      if (ws.data.ready && ws.data.pendingBytes === 0 && ws.data.sock) {
        const written = ws.data.sock.write(msg);
        if (written < 0) { ws.close(); return; }
        if (written === msg.length) return;
        msg = msg.subarray(written);
      }
      ws.data.pendingBytes += msg.length;
      if (ws.data.pendingBytes > MAX_PENDING_TCP_BYTES) { ws.close(4002, "TCP upstream is too slow"); return; }
      ws.data.pending.push(msg);
      flushTcp(ws, ws.data);
    },
    close(ws) {
      if (ws.data.kind === "webview") webRelay.close(ws.data.id, ws);
      else if (ws.data.kind === "udp") { ws.data.closed = true; ws.data.sock?.close(); }
      else { ws.data.closed = true; ws.data.pending.length = 0; ws.data.pendingBytes = 0; ws.data.sock?.end(); }
    },
  },
});

console.log(`webdroid dev server: http://localhost:${server.port}`);
