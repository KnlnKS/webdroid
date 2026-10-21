// HTTP as the device fetches it. Host code fetches http(s) through the dev server's proxy (proxy.ts),
// which would reach the host's own loopback; Android's clients outside the app (the media server,
// WebView's network service) reach the app's loopback listener instead.
import { concat, utf8 } from "../jvm/abi.ts";
import { guestEndpoint } from "../native/net-address.ts";
import type { Stream } from "../native/socket/core.ts";
import { loopbackConnection } from "../native/socket/inet.ts";
import { fromProxyHeaders, proxyPath, writeAnswer } from "./webpage/proxywire.ts";

type Init = { method?: string; headers?: Headers; body?: ArrayBuffer | Uint8Array; signal?: AbortSignal };

/** what the stream has, or null at its end */
const received = (stream: Stream) => new Promise<Uint8Array | null>((resolve) => {
  const attempt = () => {
    const n = stream.available();
    if (n) { const out = new Uint8Array(n); stream.take(out, 0, n); resolve(out); }
    else if (stream.eof) resolve(null);
    else stream.subscribe(attempt);
  };
  attempt();
});
class HttpReader {
  private readonly stream: Stream;
  private buf: Uint8Array = new Uint8Array(0);
  /** what is left of the chunk being read; -1 before the first */
  private chunkLeft = -1;
  constructor(stream: Stream) { this.stream = stream; }
  private async fill(): Promise<boolean> {
    const bytes = await received(this.stream);
    if (bytes) this.buf = this.buf.length ? concat([this.buf, bytes]) : bytes;
    return !!bytes;
  }
  async line(): Promise<string> {
    for (;;) {
      const at = this.buf.indexOf(10);
      if (at >= 0) {
        const line = utf8.dec.decode(this.buf.subarray(0, at)).replace(/\r$/, "");
        this.buf = this.buf.subarray(at + 1);
        return line;
      }
      if (!await this.fill()) throw new Error("connection closed mid-response");
    }
  }
  async head(): Promise<{ status: number; reason: string; headers: [string, string][] }> {
    const status = /^HTTP\/\d\.\d (\d{3}) ?(.*)$/.exec(await this.line());
    if (!status) throw new Error("malformed status line");
    const headers: [string, string][] = [];
    for (let line; (line = await this.line());) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return { status: Number(status[1]), reason: status[2], headers };
  }
  /** up to `max` bytes, null at the end of the stream */
  async some(max: number): Promise<Uint8Array | null> {
    if (!this.buf.length && !await this.fill()) return null;
    const out = this.buf.subarray(0, Math.min(max, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }
  /** the next bytes of a chunked body, null after its last chunk and trailers */
  async chunk(): Promise<Uint8Array | null> {
    if (this.chunkLeft <= 0) {
      if (this.chunkLeft === 0) await this.line();
      this.chunkLeft = parseInt(await this.line(), 16);
      if (!this.chunkLeft) { while (await this.line()); return null; }
      if (Number.isNaN(this.chunkLeft)) throw new Error("malformed chunk size");
    }
    const data = await this.some(this.chunkLeft);
    if (!data) throw new Error("connection closed mid-chunk");
    this.chunkLeft -= data.length;
    return data;
  }
}

/** `url`'s HTTP/1.1 exchange with this process's listener, shaped as the proxy's manual=1 answer: a
 *  redirect is not followed and Set-Cookie values travel in x-wd-set-cookie. Null when no listener
 *  takes the connection. */
export async function loopbackFetch(url: string, init: Init = {}): Promise<Response | null> {
  const ep = guestEndpoint(url), connection = ep && loopbackConnection(ep);
  if (!connection) return null;
  const u = new URL(url), method = init.method ?? "GET", body = init.body ? new Uint8Array(init.body) : null;
  if (u.protocol === "https:") { connection.close(); throw new Error("no TLS client for a loopback server"); }
  const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
  init.headers?.forEach((value, name) => { if (!/^(host|connection|keep-alive|content-length|transfer-encoding)$/i.test(name)) lines.push(`${name}: ${value}`); });
  if (body || !/^(GET|HEAD)$/.test(method)) lines.push(`Content-Length: ${body?.length ?? 0}`);
  const { stream } = connection;
  stream.write(utf8.enc.encode([...lines, "Connection: close", "", ""].join("\r\n")));
  if (body?.length) stream.write(body);
  init.signal?.addEventListener("abort", connection.close, { once: true });
  const reader = new HttpReader(stream);
  let head;
  try {
    // an interim (1xx) answer precedes the final one
    do head = await reader.head(); while (head.status < 200);
  } catch (error) { connection.close(); throw error; }
  const { status, reason, headers } = head, out = new Headers(), cookies: string[] = [];
  for (const [name, value] of headers) {
    if (/^set-cookie$/i.test(name)) cookies.push(value);
    else if (!/^(connection|keep-alive|transfer-encoding)$/i.test(name)) out.append(name, value);
  }
  writeAnswer(out, { finalUrl: url, setCookie: cookies });
  const chunked = headers.some(([name, value]) => /^transfer-encoding$/i.test(name) && /chunked/i.test(value));
  const length = Number(out.get("content-length") ?? Infinity);
  let left = method === "HEAD" || status === 204 || status === 304 ? 0 : chunked ? Infinity : length;
  if (!left) { connection.close(); return new Response(null, { status, statusText: reason, headers: out }); }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const data = chunked ? await reader.chunk() : await reader.some(left);
      if (data) { left -= data.length; controller.enqueue(data); }
      if (!data || !left) { connection.close(); controller.close(); }
    },
    cancel: connection.close,
  }), { status, statusText: reason, headers: out });
}

/** an http(s) request as the proxy's manual=1 answer: from this process's own server when it serves
 *  the URL, else through the dev server's proxy (headers prefixed x-wd-, as it takes them) */
export async function deviceFetch(url: string, init: Init & { headers: Headers }): Promise<Response> {
  if (guestEndpoint(url)) {
    const own = await loopbackFetch(url, { ...init, headers: fromProxyHeaders(init.headers) });
    if (own) return own;
  }
  return fetch(proxyPath({ url, manual: true }), init as RequestInit);
}
