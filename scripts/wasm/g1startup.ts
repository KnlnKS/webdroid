// The startup list of a platform build made with the G1 dex as its app (bun run wasm aot-build --out DIR --app <G1_DIR>/classes.dex): the modules a start and the first call of
// each workload load, as a launch profile records them for an installed app (aot-profile.ts). With it a page compiles the app's code and the platform modules the workloads
// use before the World runs, the way a saved app build is loaded at launch (host/appcode.ts).
//   WEBDROID_AOT=DIR bun run wasm g1startup <workload ...>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { program, world } from "./lib";
import { jsTier, natives, processStateAsync } from "./oracle";
import { AOSP, G1_DIR } from "./paths";

const dir = process.env.WEBDROID_AOT, dex = join(G1_DIR, "classes.dex"), files = new Set<string>();
if (!dir) throw new Error("set WEBDROID_AOT to a build made with --app");
await jsTier([]);
for (const workload of process.argv.slice(2)) {
  const w = world(program([dex, ...PLATFORM_JARS.map((j) => join(AOSP, j))]), { natives });
  await processStateAsync(w);
  await w.entryAsync("Bench", `w_${workload}`, "()I")();
  for (const f of w.aot!.loaded) files.add(f);
}
writeFileSync(join(dir, "startup.json"), JSON.stringify([...files]));
console.log(`${files.size} files`);
process.exit();
