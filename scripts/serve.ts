// HTTP through fetch handlers: a loopback server for the harnesses and tests that serve a browser, and the dev server's routes
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { mimeOf } from "../src/mime.ts";

export type Handler = (req: Request) => Response | Promise<Response>;
export interface Served { url: URL; port: number; stop(force?: boolean): void }

/** answers `req` through `fetch`: the Request aborts when the client goes away, and a throw answers 500 */
export async function respond(req: IncomingMessage, res: ServerResponse, fetch: Handler): Promise<void> {
  const aborted = new AbortController();
  res.once("close", () => { if (!res.writableFinished) aborted.abort(); });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req) as unknown as ReadableStream;
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  try {
    const response = await fetch(new Request(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`),
      { method: req.method, headers, body, duplex: "half", signal: aborted.signal } as RequestInit));
    const out: string[] = [];
    response.headers.forEach((value, name) => { if (name !== "set-cookie") out.push(name, value); });
    for (const cookie of response.headers.getSetCookie()) out.push("set-cookie", cookie);
    res.writeHead(response.status, response.statusText || undefined, out);
    if (response.body) await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res);
    else res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(e));
  }
}

/** serves `fetch` on `port` (0: any free one), listening once this resolves. On 127.0.0.1, which browsers also reach
 *  as localhost and its subdomains, where "localhost" can bind ::1 alone. */
export function serve({ port = 0, hostname = "127.0.0.1", fetch }: { port?: number; hostname?: string; fetch: Handler }): Promise<Served> {
  const server = createServer((req, res) => void respond(req, res, fetch));
  return new Promise((resolve, reject) => {
    server.once("error", reject).listen(port, hostname, () => {
      const at = (server.address() as { port: number }).port;
      resolve({ url: new URL(`http://${hostname}:${at}/`), port: at, stop: (force) => { if (force) server.closeAllConnections(); server.close(); } });
    });
  });
}

const SERVED_MIME: Record<string, string> = { wasm: "application/wasm", mjs: "text/javascript", ttf: "font/ttf", otf: "font/otf" };
/** the file at `path` as a streamed answer to `req`, typed by its extension: 404 when there is none, the span a single
 *  byte range asks for (RangeFile reads files that way), headers alone for HEAD */
export function fileResponse(path: string, req?: Request, headers?: HeadersInit): Response {
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat?.isFile()) return new Response("not found", { status: 404 });
  const h = new Headers(headers), type = SERVED_MIME[path.slice(path.lastIndexOf(".") + 1)] ?? mimeOf(path), size = stat.size;
  if (type && !h.has("content-type")) h.set("content-type", type);
  h.set("accept-ranges", "bytes");
  let start = 0, end = size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    [start, end] = range[1] ? [Number(range[1]), Math.min(range[2] ? Number(range[2]) : end, end)] : [Math.max(0, size - Number(range[2])), end];
    if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    h.set("content-range", `bytes ${start}-${end}/${size}`);
    status = 206;
  }
  h.set("content-length", String(end - start + 1));
  const body = req?.method === "HEAD" || start > end ? null : Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
  return new Response(body, { status, headers: h });
}
