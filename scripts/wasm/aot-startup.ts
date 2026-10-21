// Records which module files a start of the process (the state ActivityThread.main leaves) loads, into startup.json beside the build, so that a page can fetch and
// compile them in parallel before the World runs. Run: WEBDROID_AOT=<dir> pnpm wasm aot-startup
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./lib.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { ROOT } from "./paths.ts";
import { PLATFORM_PATHS } from "../aosp.ts";

const dir = process.env.WEBDROID_AOT;
if (!dir) throw new Error("set WEBDROID_AOT to a build");
await mountPlatform(ROOT);
const w = world(PLATFORM_PATHS);
await startProcess(w);
writeFileSync(join(dir, "startup.json"), JSON.stringify(w.aot!.loaded));
console.log(`${w.aot!.loaded.length} files`);
process.exit();
