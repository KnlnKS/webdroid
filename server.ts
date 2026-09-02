import index from "./index.html";

type TcpData = { host: string; port: number; tls: boolean; sock: import("bun").Socket | null };

const server: Bun.Server<TcpData> = Bun.serve({
  port: 4080,
  development: { hmr: false },
  routes: {
    "/": index,
    "/proxy": async (req) => {
      const url = new URL(req.url).searchParams.get("url");
      if (!url || !/^https?:\/\//.test(url)) return new Response("bad url", { status: 400 });
      try {
        const headers = new Headers();
        // forward selected headers the app set (via x-wd-* prefix)
        req.headers.forEach((v, k) => {
          if (k.startsWith("x-wd-")) headers.set(k.slice(5), v);
        });
        const upstream = await fetch(url, {
          method: req.method === "HEAD" ? "HEAD" : req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "follow",
        });
        const h = new Headers();
        upstream.headers.forEach((v, k) => {
          if (!/^(content-encoding|content-length|transfer-encoding|set-cookie)$/i.test(k)) h.set(k, v);
        });
        h.set("Access-Control-Allow-Origin", "*");
        h.set("x-wd-final-url", upstream.url);
        return new Response(upstream.body, { status: upstream.status, headers: h });
      } catch (e) {
        return new Response(`proxy error: ${e}`, { status: 502 });
      }
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
  // TLS is terminated here because the page has no certificate store and could not handshake.
  // A text frame "ok" means connected; a close before that means the connect failed.
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
    const data: TcpData = { host, port, tls: u.searchParams.get("tls") === "1", sock: null };
    return srv.upgrade(req, { data }) ? undefined : new Response("expected websocket", { status: 400 });
  },
  websocket: {
    async open(ws) {
      const d = ws.data;
      try {
        d.sock = await Bun.connect({
          hostname: d.host, port: d.port, tls: d.tls,
          socket: {
            data: (_s, chunk) => { ws.send(chunk); },
            close: () => ws.close(),
            error: () => ws.close(),
          },
        });
        ws.send("ok");
      } catch (e) {
        ws.close(4000, String(e).slice(0, 100));
      }
    },
    message(ws, msg) {
      if (typeof msg !== "string") ws.data.sock?.write(msg);
    },
    close(ws) { ws.data.sock?.end(); },
  },
});

console.log(`webdroid dev server: http://localhost:${server.port}`);
