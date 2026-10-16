// The platform build's two routes, for the dev server and for scripts/wasm/boot-probe.ts:
//   /aot/current.json    the build `pnpm aot` made last, if it was made from these sources (a stale one would run code the compiler no longer produces)
//   /aot/<key>/<file>    a file of that build, which never changes under its key
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { fileResponse } from "../serve.ts";
import { AOT_ROOT, sourceKey, sourcePaths, type AotManifest } from "./aot-key.ts";
import { PLATFORM_PATHS, ROOT } from "./paths.ts";

let current: { stamp: string; source: string } | undefined;
/** the key of the sources now, recomputed when a file has changed */
function currentSource(): string {
  const paths = [...sourcePaths().map((f) => join(ROOT, f)), ...PLATFORM_PATHS];
  const stamp = paths.map((path) => { const s = statSync(path); return `${path}:${s.mtimeMs}:${s.size}`; }).join("\n");
  if (current?.stamp !== stamp) current = { stamp, source: sourceKey() };
  return current.source;
}

export function aotManifest(): Response {
  const path = join(AOT_ROOT, "current.json");
  const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as AotManifest : undefined;
  // WEBDROID_AOT_STALE=1 serves the last build to sources whose edits leave it unchanged, such as diagnostics outside the compiler
  if (!manifest || manifest.source !== currentSource() && !process.env.WEBDROID_AOT_STALE) return new Response("no platform build for these sources; run: pnpm aot", { status: 404 });
  return Response.json(manifest, { headers: { "cache-control": "no-cache" } });
}

const compressed = new Map<string, Uint8Array<ArrayBuffer>>();
/** the production host compresses application/wasm for the browsers that accept it; so does the dev server, so that a page here transfers what it would there */
function brotli(path: string): Uint8Array<ArrayBuffer> {
  const key = path + statSync(path).mtimeMs;
  let out = compressed.get(key);
  if (!out) {
    const bytes = readFileSync(path);
    compressed.set(key, out = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
  }
  return out;
}

export function aotFile(req: Request, key: string, file: string): Response {
  if (!/^[0-9a-f]+$/.test(key) || !/^[\w.]+$/.test(file)) return new Response("nope", { status: 400 });
  const path = join(AOT_ROOT, key, file);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const headers: Record<string, string> = { "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/json", "cache-control": "public, max-age=31536000, immutable", vary: "accept-encoding" };
  if (!/\bbr\b/.test(req.headers.get("accept-encoding") ?? "")) return fileResponse(path, req, headers);
  return new Response(brotli(path), { headers: { ...headers, "content-encoding": "br" } });
}
