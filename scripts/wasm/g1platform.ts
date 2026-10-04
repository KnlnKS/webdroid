// What oracle.ts's `tests/platform` import does for the G1 harness, in node and in the browser: index the boot jars and mount the /apex data.
// Bytes come from node:fs, or in a page from the files g1.ts pre-fetched (the page's fs shim), so the same bundle times both engines.
import { openSync, readFileSync, readSync } from "node:fs";
import { loadPlatformJar } from "../../../src/android/framework";
import { PLATFORM_JARS } from "../../../src/jvm/provenance";
import { mountPlatformData } from "../../../src/shell/apex";

const g = globalThis as { document?: unknown; G1_ROOT?: string; process?: { env: Record<string, string | undefined> } };
const root = g.G1_ROOT ?? g.process?.env.G1_ROOT!;
PLATFORM_JARS.forEach((name, i) => loadPlatformJar(new Uint8Array(readFileSync(`${root}/vendor/aosp/${name}`)), i));
// a page maps the data by range requests to the server; node reads the file
if (g.document) mountPlatformData();
else mountPlatformData((path, size) => {
  const fd = openSync(`${root}/vendor/aosp${path}`, "r");
  return { size, read: async (at, length) => { const b = new Uint8Array(length); readSync(fd, b, 0, length, at); return b; } };
});
