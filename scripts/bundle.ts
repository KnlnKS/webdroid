// An entry point and everything it imports as one script, for the workers and pages the servers and tests hand a browser
import { builtinModules } from "node:module";
import { build, type Plugin } from "vite/rolldown";

export interface BundleOptions {
  platform?: "browser" | "node";
  format?: "esm" | "iife";
  minify?: boolean | "syntax";
  define?: Record<string, string>;
  alias?: Record<string, string>;
}

/** Inlining a dynamic import wraps its module, and the core's top-level await makes most wrappers async. Rolldown awaits a
 *  wrapper's imports one by one, so a cycle reached after the first wait waits on itself; ESM starts them in order and then
 *  waits for them all, as this rewrite of each run of imports does. Any other awaited wrapper than a dynamic import's is a run
 *  written in a form the rewrite does not know, which would deadlock again, so it fails the bundle. */
const startImportsTogether: Plugin = {
  name: "webdroid:start-imports-together",
  renderChunk(code) {
    const rewritten = code.replace(/(?:^[ \t]*(?:await )?init_[\w$]+\(\);\n)+/gm, (run) => !run.includes("await ") ? run
      : `${/^[ \t]*/.exec(run)![0]}await Promise.all([${run.match(/init_[\w$]+/g)!.map((init) => init + "()").join(", ")}]);\n`);
    const missed = /await init_[\w$]+\(\)(?!\.then\()/.exec(rewritten);
    if (missed) throw new Error(`an awaited module wrapper the rewrite does not recognise: ${missed[0].trim()}`);
    return rewritten;
  },
};

/** the code of `entry` bundled for `platform`, dynamic imports inlined; "syntax" minifies without renaming. For a browser,
 *  node's modules that `alias` does not replace stay unresolved: packages reach them only on their paths for node. */
export async function bundle(entry: string, { platform = "browser", format = "esm", minify = false, define, alias = {} }: BundleOptions = {}): Promise<string> {
  const external = platform === "browser" ? builtinModules.flatMap((m) => [m, `node:${m}`]).filter((m) => !(m in alias)) : undefined;
  const { output } = await build({
    input: entry, platform, write: false, logLevel: "warn", resolve: { alias }, transform: { define }, external, plugins: [startImportsTogether],
    output: { format, codeSplitting: false, minify: minify === "syntax" ? { compress: true, mangle: false } : minify },
  });
  return output[0].code;
}
