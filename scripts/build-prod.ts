import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareSystemPackages } from "./system-packages";
import { PLATFORM_JARS } from "../src/jvm/provenance";
import { PLATFORM_DATA } from "../src/jvm/bootclasspath";

const out = "dist";
const partSize = 24 * 1024 * 1024;
const aospFiles = [...PLATFORM_JARS, "framework-res.apk", ...Object.keys(PLATFORM_DATA).map((path) => path.slice(1))];
for (const name of aospFiles) if (!(await Bun.file(`vendor/aosp/${name}`).exists()))
  throw new Error(`Missing vendor/aosp/${name}; run bun run gen-framework`);

await prepareSystemPackages();
await rm(out, { recursive: true, force: true });
await mkdir(out);
const build = Bun.spawn(["bun", "build", "--target", "browser", "--production", "--minify", "--splitting", "--external", "*core.wasm", "--external", "*core.safe.wasm", "--outdir", out, "index.html", "process.html"], {
  stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Browser build failed");
const worker = await Bun.build({ entrypoints: ["src/jvm/compileworker.ts"], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!worker.success) throw new Error("Compile worker build failed");
await Bun.write(join(out, "compile-worker.js"), worker.outputs[0]);

async function copyFile(source: string, target = source): Promise<void> {
  await mkdir(dirname(join(out, target)), { recursive: true });
  await cp(source, join(out, target), { dereference: true });
}

await Promise.all([
  copyFile("vendor/platform.x509.pem"),
  copyFile("src/native/native-core.wasm", "native-core.wasm"),
  copyFile("vendor/android-cacerts.pem"),
  cp("vendor/fonts", join(out, "vendor/fonts"), { recursive: true, dereference: true }),
  cp("vendor/microg", join(out, "vendor/microg"), { recursive: true, dereference: true }),
  cp("vendor/sql.js/dist", join(out, "sqljs"), { recursive: true, dereference: true }),
  copyFile("node_modules/canvaskit-wasm/bin/canvaskit.wasm", "canvaskit.wasm"),
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

console.log(`Production assets ready in ${out}/`);
