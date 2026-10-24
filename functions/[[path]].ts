// The shell page's Function, for the paths dist/_routes.json sends here (scripts/build-prod.ts): the platform files Pages'
// static serving cannot answer as the page reads them, and the backend Worker's routes, forwarded on the page's own origin.
import { gzipHeaders } from "../src/mime.ts";

type Env = { ASSETS: Fetcher; BACKEND: Fetcher; BACKEND_ORIGIN?: string };
/** each file answered in ranges by its size, and for one build-prod split to fit the asset size limit, its parts' */
type Sizes = Record<string, { size: number; partSize?: number }>;

let sizes: Promise<Sizes> | undefined;
const assetSizes = (env: Env, url: URL): Promise<Sizes> => sizes ??= env.ASSETS.fetch(new URL("/asset-sizes.json", url))
  .then(r => r.json<Sizes>()).catch(error => { sizes = undefined; throw error; });

/** Stream only the requested bytes, including when the asset store ignores Range. */
function sliceBody(body: ReadableStream<Uint8Array>, skip: number, length: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.error(new Error("Truncated asset")); return; }
        const from = Math.min(skip, value.length);
        skip -= from;
        const chunk = value.subarray(from, from + length);
        if (!chunk.length) continue;
        length -= chunk.length;
        controller.enqueue(chunk);
        if (!length) { controller.close(); await reader.cancel(); }
        return;
      }
    },
    cancel: reason => reader.cancel(reason),
  });
}

/** the file at `path` as the request's byte range: the assets binding ignores Range and omits Content-Length */
async function ranged(request: Request, env: Env, path: string, { size, partSize }: Sizes[string]): Promise<Response> {
  const range = request.method === "GET" ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "") : null;
  if (!range && !partSize) return env.ASSETS.fetch(request);
  const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const status = range ? 206 : 200, length = end - start + 1;
  const headers: Record<string, string> = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  if (request.method === "HEAD") return new Response(null, { status, headers: { ...headers, "content-length": String(length) } });
  const step = partSize ?? size, first = Math.floor(start / step), last = Math.floor(end / step);
  /** part `i`'s bytes of the range, which the store may answer whole */
  const part = async (i: number) => {
    const from = Math.max(start - i * step, 0), to = Math.min(end - i * step, step - 1);
    const response = await env.ASSETS.fetch(new URL(partSize ? `${path}.part${i}` : path, request.url), { headers: { range: `bytes=${from}-${to}` } });
    if (!response.ok || !response.body) throw new Error(`${path} part ${i} unavailable`);
    return sliceBody(response.body, response.status === 206 ? 0 : from, to - from + 1);
  };
  const opened = await part(first).catch(() => null);
  if (!opened) return new Response("asset unavailable", { status: 404 });
  const { readable, writable } = new FixedLengthStream(length);
  void (async () => {
    for (let i = first; i <= last; i++) await (i === first ? opened : await part(i)).pipeTo(writable, { preventClose: true });
    await writable.close();
  })().catch(error => writable.abort(error).catch(() => {}));
  return new Response(readable, { status, headers });
}

/** the backend Worker's answer; a preview's is the Worker deployed for its branch, which its alias host names (scripts/deploy.ts) */
function backend(request: Request, env: Env): Promise<Response> {
  if (!env.BACKEND_ORIGIN) return env.BACKEND.fetch(request);
  const url = new URL(request.url), origin = env.BACKEND_ORIGIN.replace("*", url.hostname.slice(0, url.hostname.indexOf(".")));
  return fetch(new Request(new URL(url.pathname + url.search, origin), request));
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/vendor/")) return backend(request, env);
  if (url.pathname.startsWith("/vendor/microg/")) {
    const asset = await env.ASSETS.fetch(request), gzip = gzipHeaders(url);
    if (!gzip || !asset.ok) return asset;
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(gzip)) headers.set(name, value);
    headers.delete("content-length");
    return new Response(asset.body, { status: asset.status, headers, encodeBody: "manual" });
  }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return new Response("bad path", { status: 400 }); }
  const entry = (await assetSizes(env, url))[path];
  return entry ? ranged(request, env, path, entry) : env.ASSETS.fetch(request);
};
