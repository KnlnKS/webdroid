// bun scripts/findstr.ts <apk> <needle> — grep an APK's dex string pools.
import { openDexes } from "./lib.ts";

const [apk, needle] = process.argv.slice(2);
if (!apk || !needle) { console.error("usage: bun scripts/findstr.ts <apk> <needle>"); process.exit(2); }
for (const d of await openDexes(apk)) {
  for (let i = 0; i < d.stringCount; i++) {
    const s = d.string(i);
    if (s.includes(needle)) console.log(`${d.name} #${i}: ${JSON.stringify(s).slice(0, 200)}`);
  }
}
