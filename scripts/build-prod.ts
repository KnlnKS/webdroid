// What `vp build` adds to the page's bundle for its Pages deployment: the workers, the font index, the static assets the page fetches and the Function's routes
import { cp, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { PLATFORM_DATA } from "../src/jvm/bootclasspath.ts";
import { AOT_ROOT, sourceKey, type AotManifest } from "./aot-key.ts";
import { bundle } from "./bundle.ts";
import { runNode } from "./node.ts";
import { WORKER_SCRIPTS } from "../src/worker-scripts.ts";
import { WEB_PROXY_WORKER } from "../src/shell/webinject.ts";
import { BACKEND_PATHS, ISOLATED_PATHS, ISOLATION } from "../src/shell/serve-routes.ts";

const PART_SIZE = 24 * 1024 * 1024;
const aospFiles = [...PLATFORM_JARS, "framework-res.apk", ...Object.keys(PLATFORM_DATA).map((path) => path.slice(1))];
const RANGED = [...aospFiles.map((name) => `vendor/aosp/${name}`), "vendor/android-cacerts.pem"];
const PRODUCTION = { "process.env.NODE_ENV": '"production"' };
const STATIC: [string, string?][] = [
  ["vendor/platform.x509.pem"], ["src/native/native-core.wasm", "native-core.wasm"],
  ["vendor/microg"], ["vendor/sql.js/dist", "sqljs"], ["node_modules/canvaskit-wasm/bin/canvaskit.wasm", "canvaskit.wasm"],
  ["node_modules/harfbuzzjs/dist/harfbuzz.wasm", "harfbuzz.wasm"], ["node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm", "harfbuzz-subset.wasm"],
];

/** copies the files the Function answers in ranges, each larger than the 25 MiB asset limit in parts, and indexes their sizes in
 *  asset-sizes.json, which the asset store does not give */
async function copyRanged(out: string): Promise<void> {
  const sizes: Record<string, { size: number; partSize?: number }> = {};
  for (const path of RANGED) {
    const { size } = await stat(path);
    await mkdir(dirname(join(out, path)), { recursive: true });
    if (size <= PART_SIZE) {
      await cp(path, join(out, path), { dereference: true });
      sizes[`/${path}`] = { size };
      continue;
    }
    const parts = Math.ceil(size / PART_SIZE), file = await open(path);
    for (let i = 0; i < parts; i++) {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(PART_SIZE), 0, PART_SIZE, i * PART_SIZE);
      await writeFile(join(out, `${path}.part${i}`), buffer.subarray(0, bytesRead));
    }
    await file.close();
    sizes[`/${path}`] = { size, partSize: PART_SIZE };
  }
  await writeFile(join(out, "asset-sizes.json"), JSON.stringify(sizes));
}

/** The Wasm tier's platform build (pnpm aot). It is optional, but one made from other sources than these would run code the compiler no longer produces.
 *  Every module is below the 25 MiB asset file limit, the files are far below the 20,000 of the free plan (docs: workers/platform/limits, static assets),
 *  and the files of a key never change, so they are cached for good; current.json names the key and must revalidate. */
async function copyAot(out: string): Promise<void> {
  const current = join(AOT_ROOT, "current.json");
  if (!existsSync(current)) return;
  const manifest = JSON.parse(await readFile(current, "utf8")) as AotManifest;
  if (manifest.source !== sourceKey()) throw new Error("vendor/wasm-aot is a build of other sources; run pnpm aot");
  await cp(join(AOT_ROOT, manifest.key), join(out, "aot", manifest.key), { recursive: true });
  await writeFile(join(out, "aot/current.json"), JSON.stringify(manifest));
}
/** Pages' _headers: the shell page and its Worker scripts isolated, and a platform build's files kept for good (copyAot) */
const HEADERS = [...ISOLATED_PATHS.map((path) => [path, ISOLATION] as const),
  ["/aot/current.json", { "cache-control": "no-cache" }] as const,
  ["/aot/*/*", { "cache-control": "public, max-age=31536000, immutable" }] as const]
  .map(([path, headers]) => `${path}\n${Object.entries(headers).map(([name, value]) => `  ${name}: ${value}\n`).join("")}`).join("");

/** what Pages runs its Function for (functions/): the platform files it answers in ranges or inflates, and the backend's routes */
const FUNCTION_ROUTES = ["/vendor/aosp/*", "/vendor/android-cacerts.pem", "/vendor/microg/*", ...BACKEND_PATHS];

/** each Worker script's entry and the file it is served from (its URL without the leading slash) */
const WORKERS = Object.values(WORKER_SCRIPTS).map(({ entry, url }) => [entry, url.slice(1)] as const);

export function prodAssets(): Plugin {
  let out = "dist", systemPackages: Promise<string>, emitted: Promise<string[]>;
  return {
    name: "webdroid:prod-assets",
    configResolved: (config) => { out = config.build.outDir; },
    buildStart() {
      for (const name of aospFiles) if (!existsSync(`vendor/aosp/${name}`)) throw new Error(`Missing vendor/aosp/${name}; run pnpm gen-framework`);
      // beside the page's build: the workers and the font index are emitted with it, and the system packages (in node of their own, as
      // they load the runtime) are copied after it. Each failure surfaces where its result is awaited.
      systemPackages = runNode("scripts/system-packages.ts");
      emitted = Promise.all([
        ...WORKERS.map(([entry]) => bundle(entry, { minify: true, define: PRODUCTION })),
        runNode("scripts/font-index.ts"),
      ]);
      for (const pending of [systemPackages, emitted]) pending.catch(() => {});
    },
    async generateBundle() {
      const sources = await emitted;
      WORKERS.forEach(([, fileName], i) => this.emitFile({ type: "asset", fileName, source: sources[i] }));
      this.emitFile({ type: "asset", fileName: "font-index.json", source: sources[WORKERS.length] });
      // the page's own service worker, which serves a local package's WebView assets
      this.emitFile({ type: "asset", fileName: "webview-worker.js", source: WEB_PROXY_WORKER });
      this.emitFile({ type: "asset", fileName: "_headers", source: HEADERS });
      this.emitFile({ type: "asset", fileName: "_routes.json", source: JSON.stringify({ version: 1, include: FUNCTION_ROUTES, exclude: [] }) });
      // without one Pages answers every unknown path with index.html, which optional fetches (aot/current.json) take for a file
      this.emitFile({ type: "asset", fileName: "404.html", source: "<!doctype html><title>Not found</title>Not found" });
    },
    async closeBundle(error) {
      if (error) return;
      process.stdout.write(await systemPackages);
      await Promise.all([...STATIC.map(([from, to = from]) => cp(from, join(out, to), { recursive: true, dereference: true })), copyRanged(out), copyAot(out)]);
      console.log(`Production assets ready in ${out}/`);
    },
  };
}
