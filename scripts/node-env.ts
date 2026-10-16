// What src assumes of its host that node 24 lacks: ES2026 Uint8Array base64/hex (behind a flag), fetch of file: URLs (the shaper loads harfbuzz.wasm
// that way), and the Workers' HTMLRewriter the proxy rewrites documents with (lol-html, as html-rewriter-wasm builds it)
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as LolHtml from "html-rewriter-wasm";

Uint8Array.fromBase64 ??= (s: string, o?: { alphabet?: "base64" | "base64url" }) => {
  // as strict as the native decoder: Buffer skips what is not of the alphabet
  const text = s.replace(/[\t\n\f\r ]/g, ""), url = o?.alphabet === "base64url";
  // padding completes its chunk of four; unpadded, a last chunk of one character holds no byte
  const complete = text.endsWith("=") ? text.length % 4 === 0 : text.length % 4 !== 1;
  if (!complete || !(url ? /^[\w-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/).test(text)) throw new SyntaxError("Invalid base64 string");
  return new Uint8Array(Buffer.from(text, url ? "base64url" : "base64"));
};
Uint8Array.prototype.toHex ??= function (this: Uint8Array) { return Buffer.from(this).toString("hex"); };
Uint8Array.prototype.toBase64 ??= function (this: Uint8Array, o?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) {
  const s = Buffer.from(this).toString("base64");
  return (o?.alphabet === "base64url" ? s.replace(/\+/g, "-").replace(/\//g, "_") : s).replace(/=+$/, o?.omitPadding ? "" : "$&");
};
const fetchUrl = globalThis.fetch;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) =>
  String(input).startsWith("file:") ? readFile(new URL(String(input))).then((bytes) => new Response(bytes)) : fetchUrl(input, init);

const lolHtml = (): typeof LolHtml => createRequire(import.meta.url)("html-rewriter-wasm");
globalThis.HTMLRewriter ??= class {
  #handlers: ((rewriter: LolHtml.HTMLRewriter) => void)[] = [];
  on(selector: string, handlers: LolHtml.ElementHandlers) { this.#handlers.push((r) => r.on(selector, handlers)); return this; }
  onDocument(handlers: LolHtml.DocumentHandlers) { this.#handlers.push((r) => r.onDocument(handlers)); return this; }
  transform(response: Response): Response {
    const handlers = this.#handlers, headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        // each output chunk is a view of the rewriter's memory, which the next write reuses
        const rewriter = new (lolHtml().HTMLRewriter)((chunk) => controller.enqueue(chunk.slice()));
        for (const add of handlers) add(rewriter);
        try {
          if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) await rewriter.write(chunk);
          await rewriter.end();
          controller.close();
        } catch (e) { controller.error(e); } finally { rewriter.free(); }
      },
    }), { status: response.status, statusText: response.statusText, headers });
  }
};
