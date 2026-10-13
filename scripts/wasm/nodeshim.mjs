import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
Uint8Array.fromBase64 ??= (s) => new Uint8Array(Buffer.from(s, "base64"));
Uint8Array.prototype.toHex ??= function () { return Buffer.from(this).toString("hex"); };
Uint8Array.prototype.toBase64 ??= function (o) {
  const s = Buffer.from(this).toString("base64");
  return (o?.alphabet === "base64url" ? s.replace(/\+/g, "-").replace(/\//g, "_") : s).replace(/=+$/, o?.omitPadding ? "" : "$&");
};
globalThis.Bun ??= {
  spawnSync(cmd, o = {}) { const r = spawnSync(cmd[0], cmd.slice(1), { cwd: o.cwd, input: o.stdin && o.stdin !== "ignore" ? o.stdin : undefined, maxBuffer: 1 << 28 }); return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }; },
  spawn(cmd, o = {}) {
    const p = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", o.stdout === "pipe" ? "pipe" : "ignore", o.stderr === "pipe" ? "pipe" : "ignore"] });
    return { stdout: p.stdout && Readable.toWeb(p.stdout), stderr: p.stderr && Readable.toWeb(p.stderr), exited: new Promise((done) => p.on("close", done)) };
  },
  which: () => null,
  file(u) { const buf = () => { const b = readFileSync(u); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }; return { exists: async () => existsSync(u), arrayBuffer: async () => buf(), text: async () => readFileSync(u, "utf8"), json: async () => JSON.parse(readFileSync(u, "utf8")), bytes: async () => new Uint8Array(readFileSync(u)), slice: (a, b) => ({ arrayBuffer: async () => buf().slice(a, b) }) }; },
  Glob: class { constructor(pattern) { this.pattern = pattern; } scanSync(o) { return globSync(this.pattern, { cwd: typeof o === "string" ? o : o?.cwd }); } },
  /** a server answering through `fetch`, listening once this returns (as Bun's does): node binds a port with no host synchronously */
  serve({ port = 0, fetch: answer }) {
    const server = createServer(async (req, res) => {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
      const response = await answer(new Request(new URL(req.url, url), { method: req.method, headers: req.headers, body, duplex: "half" }));
      const headers = [...response.headers].filter(([k]) => k !== "set-cookie").concat(response.headers.getSetCookie().map((c) => ["set-cookie", c]));
      res.writeHead(response.status, headers.flat());
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    });
    server.listen(port);
    const url = new URL(`http://localhost:${server.address().port}/`);
    return { url, port: server.address().port, stop: (force) => { if (force) server.closeAllConnections(); server.close(); } };
  },
  write: async (u, data) => { writeFileSync(u, data); },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  gc: () => globalThis.gc?.(),
  deepEquals: isDeepStrictEqual,
  gunzipSync: (bytes) => new Uint8Array(gunzipSync(bytes)),
  CryptoHasher: class { constructor(algorithm) { this.hash = createHash(algorithm); } update(data) { this.hash.update(data); return this; } digest(encoding) { return this.hash.digest(encoding); } },
};
// Bun's fetch reads file: URLs (the shaper loads harfbuzz.wasm that way); node's does not
const fetchHttp = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith("file:") ? Promise.resolve(new Response(readFileSync(fileURLToPath(String(url))))) : fetchHttp(url, init);
// The production yield port is unref'd, so a script awaiting a yield would let node exit with its top-level await pending. Run the
// script from here instead of with --import: `node nodeshim.mjs script.mjs args...` keeps the loop alive until the script finishes.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const keep = setInterval(() => {}, 1 << 30);
  process.argv.splice(1, 1);
  try { await import(pathToFileURL(resolve(process.argv[1])).href); } finally { clearInterval(keep); }
  process.exit(process.exitCode ?? 0);
}
