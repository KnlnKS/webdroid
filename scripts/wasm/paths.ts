import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PLATFORM_PATHS } from "../aosp.ts";

export const ROOT = join(import.meta.dirname, "../..");
/** the platform jars named (core-oj, framework, ...), in class path order */
export function platformJars(...names: string[]): string[] {
  const paths = PLATFORM_PATHS.filter((p) => names.includes(basename(p, ".jar")));
  if (paths.length !== names.length) throw new Error(`not every one of ${names} is a platform jar`);
  return paths;
}
/** what String, the collections and the ICU-backed natives need */
export const CORE_PATHS = platformJars("core-oj", "core-libart", "core-icu4j");
/** the Java sources the suites compile with javac and d8 */
export const JAVA = join(ROOT, "tests/fixtures/wasm/java");
/** what ART answers for each workload of Bench.java (g1art --record) */
export const BENCH_EXPECTED = join(JAVA, "Bench.expected.json");
/** where g1.ts and watdump.ts build and read the benchmark dex: per checkout, so worktrees running side by side do not share it */
export const G1_DIR = process.env.G1_DIR ?? join(tmpdir(), `g1-${createHash("sha1").update(ROOT).digest("hex").slice(0, 8)}`);
