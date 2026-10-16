import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareSystemPackages } from "./system-packages.ts";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { PLATFORM_DATA } from "../src/jvm/bootclasspath.ts";
import { AOT_ROOT, sourceKey, type AotManifest } from "./wasm/aot-key.ts";

const out = "dist";
const partSize = 24 * 1024 * 1024;
const aospFiles = [...PLATFORM_JARS, "framework-res.apk", ...Object.keys(PLATFORM_DATA).map((path) => path.slice(1))];
for (const name of aospFiles) if (!(await Bun.file(`vendor/aosp/${name}`).exists()))
  throw new Error(`Missing vendor/aosp/${name}; run bun run gen-framework`);

await prepareSystemPackages();
await rm(out, { recursive: true, force: true });
await mkdir(out);
const build = Bun.spawn(["bun", "build", "--target", "browser", "--production", "--minify", "--splitting", "--external", "*core.wasm", "--external", "*core.safe.wasm", "--outdir", out, "index.html"], {
  stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Browser build failed");
const wasmWorker = await Bun.build({ entrypoints: ["src/wasm/host/compile-worker.ts"], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!wasmWorker.success) throw new Error("Wasm compile worker build failed");
await Bun.write(join(out, "wasm-compile-worker.js"), wasmWorker.outputs[0]);
const appWorker = await Bun.build({ entrypoints: ["src/process-worker.ts"], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!appWorker.success) throw new Error("Process worker build failed");
await Bun.write(join(out, "process-worker.js"), appWorker.outputs[0]);
const fontIndex = Bun.spawn(["bun", "scripts/font-index.ts"], { stdout: "pipe", stderr: "inherit" });
await Bun.write(join(out, "font-index.json"), await new Response(fontIndex.stdout).text());
if (await fontIndex.exited !== 0) throw new Error("Font index failed");

async function copyFile(source: string, target = source): Promise<void> {
  await mkdir(dirname(join(out, target)), { recursive: true });
  await cp(source, join(out, target), { dereference: true });
}

await Promise.all([
  copyFile("vendor/platform.x509.pem"),
  copyFile("src/native/native-core.wasm", "native-core.wasm"),
  copyFile("vendor/android-cacerts.pem"),
  cp("vendor/microg", join(out, "vendor/microg"), { recursive: true, dereference: true }),
  cp("vendor/sql.js/dist", join(out, "sqljs"), { recursive: true, dereference: true }),
  copyFile("node_modules/canvaskit-wasm/bin/canvaskit.wasm", "canvaskit.wasm"),
  copyFile("node_modules/harfbuzzjs/dist/harfbuzz.wasm", "harfbuzz.wasm"),
  copyFile("node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm", "harfbuzz-subset.wasm"),
]);

const large: Record<string, { parts: number; size: number; partSize: number }> = {};
for (const name of aospFiles) {
  const path = `vendor/aosp/${name}`;
  const size = (await stat(path)).size;
  if (size <= partSize) { await copyFile(path); continue; }
  const parts = Math.ceil(size / partSize), file = Bun.file(path);
  await mkdir(dirname(join(out, path)), { recursive: true });
  for (let i = 0; i < parts; i++) await Bun.write(join(out, `${path}.part${i}`), await file.slice(i * partSize, (i + 1) * partSize).arrayBuffer());
  large[`/${path}`] = { parts, size, partSize };
}
await Bun.write(join(out, "large-assets.json"), JSON.stringify(large));

// The Wasm tier's platform build (bun run aot). It is optional, but one made from other sources than these would run code the compiler no longer produces.
// Every module is below the 25 MiB asset file limit, the files are far below the 20,000 of the free plan (docs: workers/platform/limits, static assets),
// and the files of a key never change, so they are cached for good; current.json names the key and must revalidate.
const manifestFile = Bun.file(join(AOT_ROOT, "current.json"));
if (await manifestFile.exists()) {
  const manifest = await manifestFile.json() as AotManifest;
  if (manifest.source !== sourceKey()) throw new Error("vendor/wasm-aot is a build of other sources; run bun run aot");
  await cp(join(AOT_ROOT, manifest.key), join(out, "aot", manifest.key), { recursive: true });
  await Bun.write(join(out, "aot/current.json"), JSON.stringify(manifest));
  await Bun.write(join(out, "_headers"), "/aot/*/*\n  Cache-Control: public, max-age=31536000, immutable\n");
}

console.log(`Production assets ready in ${out}/`);
