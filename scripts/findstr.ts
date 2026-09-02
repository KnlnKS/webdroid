// bun scripts/findstr.ts <apk> <needle> — grep an APK's dex string pools.
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";

const [apk, needle] = process.argv.slice(2);
if (!apk || !needle) { console.error("usage: bun scripts/findstr.ts <apk> <needle>"); process.exit(2); }
const zip = unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()),
  { filter: (f) => /classes\d*\.dex$/.test(f.name) });
for (const [name, bytes] of Object.entries(zip)) {
  const d = new DexFile(bytes, name);
  for (let i = 0; i < d.stringCount; i++) {
    const s = d.string(i);
    if (s.includes(needle)) console.log(`${name} #${i}: ${JSON.stringify(s).slice(0, 200)}`);
  }
}
