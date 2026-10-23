// pnpm aot [aot-build options] [--keep]: aot-build then aot-startup into vendor/wasm-aot/<key>, and makes it the build the server offers (--keep adds it
// beside that one, for ?aot=<key>; --out <dir> builds into <dir> instead)
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeWhole } from "../generated.ts";
import { nodeCommand, run } from "../node.ts";
import { AOT_ROOT, type AotManifest } from "../aot-key.ts";

/** runs the script `name` here, its output shown: a failure ends this run with its status */
async function step(name: string, args: string[], env = process.env): Promise<void> {
  const { status } = await run(...nodeCommand(join(import.meta.dirname, name + ".ts"), ...args), { env, show: true });
  if (status) process.exit(status);
}

const args = process.argv.slice(2), at = args.indexOf("--out");
await step("aot-build", args.filter((a) => a !== "--keep"));
const manifest = at < 0 ? JSON.parse(readFileSync(join(AOT_ROOT, "latest.json"), "utf8")) as AotManifest : undefined, dir = manifest ? join(AOT_ROOT, manifest.key) : args[at + 1];
if (!existsSync(join(dir, "startup.json"))) await step("aot-startup", [], { ...process.env, WEBDROID_AOT: dir });
if (manifest && !args.includes("--keep")) {
  writeWhole(join(AOT_ROOT, "current.json"), JSON.stringify(manifest));
  for (const old of readdirSync(AOT_ROOT).filter((f) => f !== manifest.key && !f.endsWith(".json"))) rmSync(join(AOT_ROOT, old), { recursive: true, force: true });
}
