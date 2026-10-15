import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";

export const ROOT = join(import.meta.dir, "../..");
export const AOSP = join(ROOT, "vendor/aosp");
/** every platform jar in the checkout, in class path order */
export const PLATFORM_PATHS: string[] = PLATFORM_JARS.map((j) => join(AOSP, j));
/** core-oj, core-libart and core-icu4j: what String, the collections and the ICU-backed natives need */
export const CORE_PATHS: string[] = [...PLATFORM_PATHS.slice(0, 2), join(AOSP, "boot/core-icu4j.jar")];
/** the Java sources the suites compile with javac and d8 */
export const JAVA = join(ROOT, "tests/fixtures/wasm/java");
/** where g1.ts and watdump.ts build and read the benchmark dex: per checkout, so worktrees running side by side do not share it */
export const G1_DIR = process.env.G1_DIR ?? join(tmpdir(), `g1-${createHash("sha1").update(ROOT).digest("hex").slice(0, 8)}`);
