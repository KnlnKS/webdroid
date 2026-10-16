// An entry point and everything it imports as one script, for the workers and pages the servers and tests hand a browser
import { builtinModules } from "node:module";
import { build } from "vite/rolldown";

export interface BundleOptions {
  platform?: "browser" | "node";
  format?: "esm" | "iife";
  minify?: boolean | "syntax";
  define?: Record<string, string>;
  alias?: Record<string, string>;
}

/** the code of `entry` bundled for `platform`, dynamic imports inlined; "syntax" minifies without renaming. For a browser,
 *  node's modules that `alias` does not replace stay unresolved: packages reach them only on their paths for node. */
export async function bundle(entry: string, { platform = "browser", format = "esm", minify = false, define, alias = {} }: BundleOptions = {}): Promise<string> {
  const external = platform === "browser" ? builtinModules.flatMap((m) => [m, `node:${m}`]).filter((m) => !(m in alias)) : undefined;
  const { output } = await build({
    input: entry, platform, write: false, logLevel: "warn", resolve: { alias }, transform: { define }, external,
    output: { format, codeSplitting: false, minify: minify === "syntax" ? { compress: true, mangle: false } : minify },
  });
  return output[0].code;
}
