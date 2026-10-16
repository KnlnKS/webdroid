// A loopback HTTP server answering through a fetch handler, for the harnesses and tests that serve a browser
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mimeOf } from "../src/mime.ts";

export type Handler = (req: Request) => Response | Promise<Response>;
export interface Served { url: URL; port: number; stop(force?: boolean): void }

/** `req` as a fetch Request: the body streams, the URL is absolute against `base` */
export function toRequest(req: IncomingMessage, base: string): Request {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req) as ReadableStream;
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  return new Request(new URL(req.url ?? "/", base), { method: req.method, headers, body, duplex: "half" } as RequestInit);
}

/** writes `response` to `res`, each Set-Cookie its own header */
export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: [string, string][] = [...response.headers].filter(([k]) => k !== "set-cookie");
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  res.writeHead(response.status, response.statusText, headers.flat());
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}

/** serves `fetch` on `port` (0: any free one), listening once this resolves */
export function serve({ port = 0, hostname = "localhost", fetch }: { port?: number; hostname?: string; fetch: Handler }): Promise<Served> {
  const server = createServer((req, res) => {
    void (async () => sendResponse(res, await fetch(toRequest(req, url.href))))().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    });
  });
  let url: URL;
  return new Promise((resolve, reject) => {
    server.once("error", reject).listen(port, hostname, () => {
      const at = (server.address() as { port: number }).port;
      url = new URL(`http://${hostname}:${at}/`);
      resolve({ url, port: at, stop: (force) => { if (force) server.closeAllConnections(); server.close(); } });
    });
  });
}

const SERVED_MIME: Record<string, string> = { wasm: "application/wasm", mjs: "text/javascript", ttf: "font/ttf", otf: "font/otf" };
/** the file at `path` as a streamed response typed by its extension, 404 when there is none */
export function fileResponse(path: string, headers?: HeadersInit): Response {
  if (!existsSync(path) || !statSync(path).isFile()) return new Response("not found", { status: 404 });
  const h = new Headers(headers), type = SERVED_MIME[path.slice(path.lastIndexOf(".") + 1)] ?? mimeOf(path);
  h.set("content-length", String(statSync(path).size));
  if (type && !h.has("content-type")) h.set("content-type", type);
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers: h });
}
