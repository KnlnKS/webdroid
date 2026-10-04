// The platform build's two routes, for the dev server and for scripts/wasm/boot-probe.ts:
//   /aot/current.json    the build `bun run aot` made last, if it was made from these sources (a stale one would run code the compiler no longer produces)
//   /aot/<key>/<file>    a file of that build, which never changes under its key
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { AOT_ROOT, sourceKey, type AotManifest } from "./aot-key";
import { AOSP, ROOT } from "./paths";

const GLOBS = ["src/wasm/{compiler,link}/**/*.ts", "src/jvm/{dex,prepared,structure,opcodes,abi}.ts"];
let current: { stamp: number; source: string } | undefined;
/** the key of the sources now, recomputed when a file has changed */
function currentSource(): string {
  let stamp = 0;
  for (const glob of GLOBS) for (const f of new Bun.Glob(glob).scanSync({ cwd: ROOT })) stamp = Math.max(stamp, Bun.file(join(ROOT, f)).lastModified);
  for (const jar of PLATFORM_JARS) stamp = Math.max(stamp, Bun.file(join(AOSP, jar)).lastModified);
  if (current?.stamp !== stamp) current = { stamp, source: sourceKey() };
  return current.source;
}

export function aotManifest(): Response {
  const path = join(AOT_ROOT, "current.json");
  const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as AotManifest : undefined;
  if (!manifest || manifest.source !== currentSource()) return new Response("no platform build for these sources; run: bun run aot", { status: 404 });
  return Response.json(manifest, { headers: { "cache-control": "no-cache" } });
}

export function aotFile(key: string, file: string): Response {
  if (!/^[0-9a-f]+$/.test(key) || !/^[\w.]+$/.test(file)) return new Response("nope", { status: 400 });
  const path = join(AOT_ROOT, key, file);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(path), { headers: { "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/json", "cache-control": "public, max-age=31536000, immutable" } });
}
