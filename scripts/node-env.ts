// What src assumes of its host that node 24 lacks: ES2026 Uint8Array base64/hex, and fetch of file: URLs (the shaper loads harfbuzz.wasm that way)
import { readFile } from "node:fs/promises";

Uint8Array.fromBase64 ??= (s: string) => new Uint8Array(Buffer.from(s, "base64"));
Uint8Array.prototype.toHex ??= function (this: Uint8Array) { return Buffer.from(this).toString("hex"); };
Uint8Array.prototype.toBase64 ??= function (this: Uint8Array, o?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) {
  const s = Buffer.from(this).toString("base64");
  return (o?.alphabet === "base64url" ? s.replace(/\+/g, "-").replace(/\//g, "_") : s).replace(/=+$/, o?.omitPadding ? "" : "$&");
};
const fetchUrl = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) =>
  String(input).startsWith("file:") ? readFile(new URL(String(input))).then((bytes) => new Response(bytes)) : fetchUrl(input, init), fetchUrl);
