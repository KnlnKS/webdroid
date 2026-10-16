import index from "./index.html";
import { WEB_PROXY_WORKER, WEB_FRAME } from "./src/shell/webinject.ts";
import { webDocument } from "./src/shell/webhtml.ts";
import { forwardDnsMessage, proxyRequest, sandboxDocument } from "./src/shell/proxy.ts";
import { openInstall } from "./src/shell/install.ts";
import { EXT_MIME } from "./src/mime.ts";
import { prepareSystemPackages } from "./scripts/system-packages.ts";
import { aotFile, aotManifest } from "./scripts/wasm/aot-serve.ts";

import { WebRelay, type WebRelayData } from "./src/shell/webrelay.ts";
import { parseIpv4 } from "./src/shell/relay.ts";
import dns from "node:dns/promises";

await prepareSystemPackages();
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

type TcpData = { kind: "tcp"; host: string; port: number; tls: boolean; alpn: string[]; sock: import("bun").Socket | null; ready: boolean; closed: boolean; pending: Uint8Array[]; pendingBytes: number; shut?: boolean };
type UdpData = { kind: "udp"; sock: { send(data: Uint8Array, port: number, address: string): boolean; close(): void } | null; closed: boolean; addresses: Map<string, Promise<string>>; names: Map<string, string> };
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
  // the client's shutdown(SHUT_WR), once what it wrote before has gone
  if (data.shut) socket.shutdown(true);
}

const IMMUTABLE = "public, max-age=31536000, immutable";
function serveFile(dir: string, name: string, headers?: Record<string, string>): Response {
  if (!name || /[/\\]|\.\./.test(name)) return new Response("nope", { status: 400 });
  return new Response(Bun.file(`${dir}/${name}`), { headers });
}
/** a reference-build file mirrored under vendor/aosp at its device path (PLATFORM_DATA) */
function devicePath(req: Request): Response {
  const path = new URL(req.url).pathname.slice(1);
  return path.includes("..") ? new Response("nope", { status: 400 }) : new Response(Bun.file(path), { headers: { "cache-control": IMMUTABLE } });
}

/** scripts/font-index.ts, run once: the reference build's fonts change only with gen-framework */
let fontIndex: Promise<string> | null = null;

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

/** the newest modification among the files `globs` match */
function stampOf(...globs: string[]): number {
  let stamp = 0;
  for (const glob of globs) for (const f of new Bun.Glob(glob).scanSync()) stamp = Math.max(stamp, Bun.file(f).lastModified);
  return stamp;
}
/** a worker (src/wasm/host/compile-worker.ts, src/process-worker.ts) bundled for the page, rebuilt when a source file has changed since */
const workerBuilds = new Map<string, { stamp: number; code: Promise<string> }>();
async function compileWorker(entry: string): Promise<Response> {
  const stamp = stampOf("src/**/*.ts");
  let build = workerBuilds.get(entry);
  if (build?.stamp !== stamp) workerBuilds.set(entry, build = { stamp, code: Bun.build({ entrypoints: [entry], target: "browser" }).then((r) => r.outputs[0].text()) });
  return new Response(await build.code, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
}

const server: Bun.Server<SocketData> = Bun.serve({
  port: Number(process.env.PORT ?? 4080),
  development: { hmr: false },
  routes: {
    "/": index,
    "/webview": () => new Response(WEB_FRAME, { headers: { "content-type": "text/html", "cache-control": "no-store" } }),
    "/webview-call": (req) => webRelay.call(req),
    "/webview-origin": (req) => {
      const url = new URL(req.url);
      if (process.env.WEBDROID_WEBVIEW_ORIGIN) return Response.json(process.env.WEBDROID_WEBVIEW_ORIGIN);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("Configure WEBDROID_WEBVIEW_ORIGIN on a separate site", { status: 503 });
      // a browser resolves every *.localhost name to this loopback server, each its own site
      return Response.json(`${url.protocol}//*.localhost:${url.port}`);
    },
    "/wasm-compile-worker.js": () => compileWorker("src/wasm/host/compile-worker.ts"),
    "/process-worker.js": () => compileWorker("src/process-worker.ts"),
    "/font-index.json": async () => new Response(await (fontIndex ??= new Response(Bun.spawn(["bun", "scripts/font-index.ts"], { stdout: "pipe", stderr: "inherit" }).stdout).text()),
      { headers: { "content-type": "application/json" } }),
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
      if (ext === "html") return sandboxDocument(req, new Response(await webDocument(new TextDecoder().decode(bytes)), { headers: { "content-type": type } }));
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type } });
    },
    "/aot/current.json": aotManifest,
    "/aot/:key/:file": (req) => aotFile(req.params.key, req.params.file, req.headers.get("accept-encoding") ?? ""),
    "/sqljs/:file": (req) => serveFile("vendor/sql.js/dist", req.params.file),
    "/canvaskit.wasm": () => serveFile("node_modules/canvaskit-wasm/bin", "canvaskit.wasm", { "cache-control": IMMUTABLE }),
    "/harfbuzz.wasm": () => serveFile("node_modules/harfbuzzjs/dist", "harfbuzz.wasm"),
    "/harfbuzz-subset.wasm": () => serveFile("node_modules/harfbuzzjs/dist", "harfbuzz-subset.wasm"),
    // under vendor/aosp, the reference build's class path, framework-res.apk and its ICU and time
    // zone files (bun run gen-framework): they only change with the build, so let the browser keep them.
    "/vendor/:file": (req) => serveFile("vendor", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/aosp/:file": (req) => serveFile("vendor/aosp", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/aosp/boot/:file": (req) => serveFile("vendor/aosp/boot", req.params.file, { "cache-control": IMMUTABLE }),
    "/vendor/aosp/apex/*": devicePath,
    "/vendor/aosp/system/*": devicePath,
    "/vendor/aosp/data/*": devicePath,
    "/vendor/microg/:file": (req) => {
      const file = req.params.file;
      const headers: Record<string, string> = { "cache-control": file.endsWith(".json") ? "no-cache" : IMMUTABLE };
      if (file.endsWith(".gz") && !new URL(req.url).searchParams.has("raw")) {
        headers["content-encoding"] = "gzip";
        headers["content-type"] = "application/octet-stream";
        // A .gz download filename makes WebKit retain the compressed transport body.
        headers["content-disposition"] = "inline";
      }
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
  // that means the connect failed. A plain "ok" (worker/tcp.ts, local address unparsed) also means connected.
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
    if (u.pathname === "/udp") return srv.upgrade(req, { data: { kind: "udp", sock: null, closed: false, addresses: new Map(), names: new Map() } })
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
            // a reply names its source as the guest dialed it (the address is this server's
            // resolution of the name, which the guest never saw), framed as a request is
            data: (_socket, bytes, port, address) => {
              const ip = address.replace(/^::ffff:/, "");
              if (!parseIpv4(ip) || d.closed) return;
              const name = new TextEncoder().encode(d.names.get(ip) ?? ip);
              const frame = new Uint8Array(3 + name.length + bytes.length);
              frame[0] = name.length; frame[1] = port >> 8; frame[2] = port & 255;
              frame.set(name, 3); frame.set(bytes, 3 + name.length);
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
        // the errno code leads, for the guest's connect(2) to report
        ws.close(4000, `${(e as { code?: string }).code ?? ""} ${String(e)}`.trim().slice(0, 100));
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
          ws.data.names.set(address, host);
          if (!ws.data.closed) ws.data.sock?.send(msg.subarray(3 + length), port, address);
        } catch { ws.data.addresses.delete(host); }
        return;
      }
      if (typeof msg === "string") { if (msg === "shutdown") { ws.data.shut = true; flushTcp(ws, ws.data); } return; }
      if (ws.data.shut) return;
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
