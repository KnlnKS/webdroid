import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureFrameworkRes } from "./gen-framework-res";
import { prepareSystemPackages } from "./system-packages";

const out = "dist";
const partSize = 24 * 1024 * 1024;
const aospFiles = ["framework.jar", "framework-res.apk"];
const includeAosp = process.env.WEBDROID_INCLUDE_AOSP === "1";
if (process.env.WEBDROID_INCLUDE_AOSP && !includeAosp)
  throw new Error("WEBDROID_INCLUDE_AOSP must be 1 when set");
if (includeAosp) for (const name of aospFiles) if (!(await Bun.file(`vendor/aosp/${name}`).exists()))
  throw new Error(`Missing vendor/aosp/${name}; run bun run gen-framework`);

await Promise.all([ensureFrameworkRes(), prepareSystemPackages()]);
await rm(out, { recursive: true, force: true });
await mkdir(out);
const build = Bun.spawn(["bun", "build", "--target", "browser", "--production", "--splitting", "--outdir", out, "index.html", "process.html"], {
  stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) throw new Error("Browser build failed");

async function copyFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(join(out, target)), { recursive: true });
  await cp(source, join(out, target), { dereference: true });
}

await Promise.all([
  copyFile("vendor/framework-res.apk", "vendor/framework-res.apk"),
  copyFile("vendor/android-cacerts.pem", "vendor/android-cacerts.pem"),
  cp("vendor/fonts", join(out, "vendor/fonts"), { recursive: true, dereference: true }),
  cp("vendor/microg", join(out, "vendor/microg"), { recursive: true, dereference: true }),
  cp("vendor/sql.js/dist", join(out, "sqljs"), { recursive: true, dereference: true }),
  copyFile("node_modules/canvaskit-wasm/bin/canvaskit.wasm", "canvaskit.wasm"),
]);

const large: Record<string, { parts: number }> = {};
if (includeAosp) for (const name of aospFiles) {
  const source = `vendor/aosp/${name}`;
  const size = (await stat(source)).size;
  const path = `vendor/aosp/${name}`;
  if (size <= partSize) { await copyFile(source, path); continue; }
  const parts = Math.ceil(size / partSize), file = Bun.file(source);
  await mkdir(join(out, "vendor/aosp"), { recursive: true });
  for (let i = 0; i < parts; i++) await Bun.write(join(out, `${path}.part${i}`), await file.slice(i * partSize, (i + 1) * partSize).arrayBuffer());
  large[`/${path}`] = { parts };
}
await Bun.write(join(out, "large-assets.json"), JSON.stringify(large));

const files = await readdir(out);
if (!files.includes("index.html") || !files.includes("process.html")) throw new Error("Browser entrypoints missing");
console.log(`Production assets ready in ${out}/`);
