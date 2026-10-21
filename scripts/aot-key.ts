// What identifies a platform build (wasm/aot-build.ts): the sources that make its modules, the jars it is made from, the natives it was bound to and its options.
// A page asks the server for the current key (aot-serve.ts) and fetches /aot/<key>/..., so a build made by other code is never served for these sources.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../src/jvm/provenance.ts";
import { VERSION } from "../src/wasm/link/aot.ts";
import { AOSP } from "./aosp.ts";
import { ROOT } from "./wasm/paths.ts";

// Host registrations outside Wasm determine class layouts and suspension imports too.
const SOURCES = ["src", "scripts/wasm/aot-build.ts", "scripts/aot-key.ts", "scripts/wasm/aot-startup.ts", "scripts/wasm/harness.ts", "scripts/wasm/lib.ts"];

export const AOT_ROOT = join(ROOT, "vendor/wasm-aot");

export function sourcePaths(): string[] {
  return SOURCES.flatMap((s) => s.endsWith(".ts") ? [s] : readdirSync(join(ROOT, s), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".wasm.ts")).sort().map((f) => join(s, f)));
}

/** a digest of the platform jars, the compiler sources and the build format */
export function sourceKey(): string {
  const h = createHash("sha256").update(`v${VERSION}\n`);
  for (const jar of PLATFORM_JARS) h.update(jar).update(readFileSync(join(AOSP, jar)));
  for (const path of sourcePaths()) {
    h.update(path).update(readFileSync(join(ROOT, path)));
  }
  return h.digest("hex");
}

/** the key of a build: the sources, the natives it was bound to (`natives`: their sorted keys) and its options */
export const buildKey = (source: string, natives: string[], options: string): string => createHash("sha256").update(source).update(natives.join("\n")).update(options).digest("hex").slice(0, 16);

/** what /aot/current.json says: the build to fetch and the sources it was made from */
export interface AotManifest { key: string; source: string }
