// Runs a harness under node: Reflection.getCallerClass and stack symbolisation read V8's wasm frames, which Bun's JavaScriptCore lacks.
// node 24 (V8 13.6) has JSPI only behind --experimental-wasm-jspi; Chrome has it on. --expose-gc lets the heap limit be judged on live data (WorldOptions.collect).
// `import.meta.dir/url` keep naming the original source files, so the bundle can live in a temp directory.
//   bun scripts/wasm/undernode.ts <entry> [args]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** `import.meta.{dir,path,url,main}`, spelled so this file does not match itself */
const META = new RegExp(`import\\.${"meta"}\\.(dir|path|url|main)\\b`, "g");

/** bundles `entry` for node and answers the command that runs it with `args`; the bundle's directory is the caller's to remove (`removeBundle`) */
export async function bundleForNode(entry: string, args: string[], plugins: Bun.BunPlugin[] = []): Promise<string[]> {
  const out = mkdtempSync(join(tmpdir(), "wasm-node-"));
  const built = await Bun.build({
    entrypoints: [entry], target: "node", outdir: out,
    plugins: [...plugins, { name: "meta", setup: (b) => {
      b.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const src = await Bun.file(path).text();
        const repl: Record<string, string> = { dir: join(path, ".."), path, url: pathToFileURL(path).href };
        return { loader: "ts", contents: src.replace(META, (_, k) => k === "main" ? "false" : JSON.stringify(repl[k])) };
      });
    } }],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  return ["node", "--experimental-wasm-jspi", "--expose-gc", join(import.meta.dir, "nodeshim.mjs"), built.outputs[0].path, ...args];
}

/** removes the bundle a `bundleForNode` command runs */
export const removeBundle = (command: string[], args: string[] = []): void => rmSync(dirname(command[command.length - args.length - 1]), { recursive: true, force: true });

/** bundles `entry` for node, runs it with `args` and answers its exit status */
export async function runUnderNode(entry: string, args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const command = await bundleForNode(entry, args);
  try { return Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"], env }).exitCode ?? 1; }
  finally { removeBundle(command, args); }
}

if (import.meta.main) process.exit(await runUnderNode(resolve(process.argv[2]), process.argv.slice(3)));
