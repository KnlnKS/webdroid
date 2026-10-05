import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "../..");
export const AOSP = join(ROOT, "vendor/aosp");
/** the Java sources the suites compile with javac and d8 */
export const JAVA = join(ROOT, "tests/fixtures/wasm/java");
/** where g1.ts and watdump.ts build and read the benchmark dex: per checkout, so worktrees running side by side do not share it */
export const G1_DIR = process.env.G1_DIR ?? join(tmpdir(), `g1-${createHash("sha1").update(ROOT).digest("hex").slice(0, 8)}`);
