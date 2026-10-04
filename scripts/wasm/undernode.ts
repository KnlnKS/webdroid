// Re-runs a j2w harness under node: Reflection.getCallerClass and anything caller-sensitive read V8's wasm frames, which Bun's JavaScriptCore lacks.
// `import.meta.dir/url` keep naming the original source files, so the bundle can live in a temp directory.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** `import.meta.{dir,path,url,main}`, spelled so this file does not match itself */
const META = new RegExp(`import\\.${"meta"}\\.(dir|path|url|main)\\b`, "g");

/** Under Bun: bundles `entry` for node, runs it with the same arguments and exits with its status. Under node: returns. */
export async function underNode(entry: string) {
  if (!process.versions.bun) return;
  const here = import.meta.dir, out = mkdtempSync(join(tmpdir(), "j2w-node-"));
  const built = await Bun.build({
    entrypoints: [entry], target: "node", outdir: out,
    plugins: [{ name: "meta", setup: (b) => {
      b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const src = await Bun.file(path).text();
        const repl: Record<string, string> = { dir: join(path, ".."), path, url: pathToFileURL(path).href };
        return { loader: "ts", contents: src.replace(META, (_, k) => k === "main" ? "false" : JSON.stringify(repl[k])) };
      });
    } }],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const r = Bun.spawnSync(["node", join(here, "nodeshim.mjs"), built.outputs[0].path, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  process.exit(r.exitCode ?? 1);
}
