import { PLATFORM_DATA } from "../src/jvm/bootclasspath.ts";
import { certificates } from "../vendor/android-cacerts-index.ts";

const certificateSize = certificates.reduce((size, [, length]) => size + length, 0);

/** Stream only the requested bytes, including when the asset store ignores Range. */
export function sliceBody(body: ReadableStream<Uint8Array>, skip: number, length: number): ReadableStream<Uint8Array> {
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

export async function rangeResponse(request: Request, response: Response): Promise<Response> {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (request.method !== "GET" || response.status !== 200 || !range || !response.body) return response;
  // The assets binding omits Content-Length; use the same index as the browser’s lazy mounts.
  let path: string;
  try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return response; }
  const size = (path === "/vendor/android-cacerts.pem" ? certificateSize
    : path.startsWith("/vendor/aosp/") ? PLATFORM_DATA[path.slice("/vendor/aosp".length)] : undefined)
    ?? Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0) return response;
  const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    await response.body.cancel();
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  }
  const headers = new Headers(response.headers);
  headers.set("accept-ranges", "bytes");
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(sliceBody(response.body, start, end - start + 1), { status: 206, headers });
}
