import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const AOSP = join(ROOT, "vendor/aosp");
/** the Java sources the suites compile with javac and d8 */
export const JAVA = join(ROOT, "tests/fixtures/wasm/java");
