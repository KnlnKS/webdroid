// An entry point and everything it imports as one script, for the workers and pages the servers and tests hand a browser
import { build } from "vite/rolldown";

export interface BundleOptions { format?: "esm" | "iife"; minify?: boolean | "syntax"; define?: Record<string, string> }

/** the code of `entry` bundled for a browser, dynamic imports inlined; "syntax" minifies without renaming */
export async function bundle(entry: string, { format = "esm", minify = false, define }: BundleOptions = {}): Promise<string> {
  const { output } = await build({
    input: entry, platform: "browser", write: false, logLevel: "warn", transform: { define },
    output: { format, codeSplitting: false, minify: minify === "syntax" ? { compress: true, mangle: false } : minify },
  });
  return output[0].code;
}
