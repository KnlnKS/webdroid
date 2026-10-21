// pnpm findstr <apk> <needle> — grep an APK's dex string pools.
import { loadDexes } from "./dexes.ts";
import { cli } from "./args.ts";

const { positionals: [apk, needle] } = cli("pnpm findstr <apk> <needle>", {}, { min: 2 });
for (const d of loadDexes(apk)) {
  for (let i = 0; i < d.stringCount; i++) {
    const s = d.string(i);
    if (s.includes(needle)) console.log(`${d.name} #${i}: ${JSON.stringify(s).slice(0, 200)}`);
  }
}
