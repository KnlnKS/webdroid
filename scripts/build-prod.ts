// What `vp build` adds to the page's bundle for production: the workers, the font index and the static assets the page fetches
import { cp, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { PLATFORM_DATA } from "../src/jvm/bootclasspath.ts";
import { AOT_ROOT, sourceKey, type AotManifest } from "./wasm/aot-key.ts";
import { bundle } from "./bundle.ts";
import { runNode } from "./node.ts";

const PART_SIZE = 24 * 1024 * 1024;
const aospFiles = [...PLATFORM_JARS, "framework-res.apk", ...Object.keys(PLATFORM_DATA).map((path) => path.slice(1))];
const PRODUCTION = { "process.env.NODE_ENV": '"production"' };
const STATIC: [string, string?][] = [
  ["vendor/platform.x509.pem"], ["vendor/android-cacerts.pem"], ["src/native/native-core.wasm", "native-core.wasm"],
  ["vendor/microg"], ["vendor/sql.js/dist", "sqljs"], ["node_modules/canvaskit-wasm/bin/canvaskit.wasm", "canvaskit.wasm"],
  ["node_modules/harfbuzzjs/dist/harfbuzz.wasm", "harfbuzz.wasm"], ["node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm", "harfbuzz-subset.wasm"],
];

/** copies the reference build's files, each larger than the 25 MiB asset limit in parts, and names the split ones in large-assets.json */
async function copyAosp(out: string): Promise<void> {
  const large: Record<string, { parts: number; size: number; partSize: number }> = {};
  for (const name of aospFiles) {
    const path = `vendor/aosp/${name}`, { size } = await stat(path);
    await mkdir(dirname(join(out, path)), { recursive: true });
    if (size <= PART_SIZE) { await cp(path, join(out, path), { dereference: true }); continue; }
    const parts = Math.ceil(size / PART_SIZE), file = await open(path);
    for (let i = 0; i < parts; i++) {
      const { buffer, bytesRead } = await file.read(Buffer.alloc(PART_SIZE), 0, PART_SIZE, i * PART_SIZE);
      await writeFile(join(out, `${path}.part${i}`), buffer.subarray(0, bytesRead));
    }
    await file.close();
    large[`/${path}`] = { parts, size, partSize: PART_SIZE };
  }
  await writeFile(join(out, "large-assets.json"), JSON.stringify(large));
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
  await writeFile(join(out, "_headers"), "/aot/*/*\n  Cache-Control: public, max-age=31536000, immutable\n");
}

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
        bundle("src/wasm/host/compile-worker.ts", { minify: true, define: PRODUCTION }),
        bundle("src/process-worker.ts", { minify: true, define: PRODUCTION }),
        runNode("scripts/font-index.ts"),
      ]);
      for (const pending of [systemPackages, emitted]) pending.catch(() => {});
    },
    async generateBundle() {
      const [compileWorker, processWorker, fontIndex] = await emitted;
      this.emitFile({ type: "asset", fileName: "wasm-compile-worker.js", source: compileWorker });
      this.emitFile({ type: "asset", fileName: "process-worker.js", source: processWorker });
      this.emitFile({ type: "asset", fileName: "font-index.json", source: fontIndex });
    },
    async closeBundle(error) {
      if (error) return;
      process.stdout.write(await systemPackages);
      await Promise.all([...STATIC.map(([from, to = from]) => cp(from, join(out, to), { recursive: true, dereference: true })), copyAosp(out), copyAot(out)]);
      console.log(`Production assets ready in ${out}/`);
    },
  };
}
