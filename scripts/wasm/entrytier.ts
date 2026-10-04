// The Wasm tier alone, run with WEBDROID_TIER=wasm after the entry suite: no bytecode in the JS runtime, the platform and the fixture loaded through
// tier.loadDex, the seam installed by the tier; its answers are the JS tier's that the entry suite recorded.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/natives";
import { loadPlatformJar } from "../../src/android/framework";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { BOOT_JAR_PATHS } from "../../src/jvm/bootclasspath";
import { vfs } from "../../src/shell/vfs";
import { BytesFile } from "../../src/shell/lazyfile";
import { dexesIn } from "../../src/jvm/dex";
import { loadDex, loadTier, tier } from "../../src/jvm/tier";
import { rt } from "../../src/jvm/runtime";
import { settled } from "../../src/wasm/host/nativesource";
import { AOSP } from "./paths";
import { entryCases, entryDex } from "./entrycases";

if (tier !== "wasm") throw new Error("run with WEBDROID_TIER=wasm");
const recorded = JSON.parse(readFileSync(process.env.WASM_ENTRY_OUT!, "utf8")) as { js: string[]; settled: [string, unknown][] };
for (const [key, value] of recorded.settled) settled.set(key, value);
await loadTier();
// every jar of the boot class path is on the device; the classes of the three the fixture needs are loaded
PLATFORM_JARS.forEach((jar, i) => {
  const bytes = new Uint8Array(readFileSync(join(AOSP, jar)));
  if ([0, 1, 12].includes(i)) loadPlatformJar(bytes, i); else vfs.mount(BOOT_JAR_PATHS[i], new BytesFile(bytes));
});
for (const d of dexesIn(new Uint8Array(readFileSync(entryDex())), "E")) loadDex(rt, d);
const got = await entryCases();
let failed = 0;
recorded.js.forEach((want, i) => { if (got[i] !== want) { failed++; console.log(`FAIL ?tier=wasm: ${want.split(":")[0]}\n  js    ${want}\n  wasm  ${got[i]}`); } });
if (got.length !== recorded.js.length) { failed++; console.log(`FAIL ?tier=wasm: ${got.length} answers for ${recorded.js.length}`); }
console.log(failed ? `${failed} failures` : `${got.length} entry calls answer as on the JS tier through ?tier=wasm`);
process.exit(failed ? 1 : 0);
