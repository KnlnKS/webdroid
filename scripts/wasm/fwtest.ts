// The framework delegates' exercises (scripts/fwtest/*) over a World: AOSP's own bytecode for the classes under the given prefixes runs as Wasm
// against our delegates, and host code drives it through the entry seam; the coverage report counts their declared natives. Run: pnpm fwtest [prefix ...]
import { DEFAULT_CUTS } from "../fwtest/cuts.ts";
import { cli } from "../args.ts";
import { world } from "./lib.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { natives } from "../../src/wasm/host/nativesource.ts";
import { ROOT } from "./paths.ts";
import { PLATFORM_PATHS } from "../aosp.ts";

const { positionals } = cli("pnpm fwtest [prefix ...]", {});
const PREFIXES = positionals.length ? positionals : DEFAULT_CUTS;

await mountPlatform(ROOT);
// the exercises' modules register more host classes as they load
const w = world(PLATFORM_PATHS);
const gaps = new Set<string>();
w.onGap = (gap) => gaps.add(gap);
await startProcess(w);

// the natives the cut classes declare, against the ones the Wasm tier binds to a host import
let have = 0, total = 0;
const unbound: string[] = [];
for (const jc of w.prog.all()) {
  if (!PREFIXES.some((p) => jc.name.startsWith(p))) continue;
  for (const m of jc.methods) {
    if (m.codeOff || !(m.flags & 0x100)) continue;
    total++;
    if (natives.prepare(m)) have++; else unbound.push(`${jc.name}.${m.key}`);
  }
}
console.log(`${PREFIXES.length} prefixes; ${[...w.prog.all()].length} platform classes\n\ncoverage ${have}/${total} declared natives bound`);

// the device's languages and the main looper the exercises' Handlers attach to, as a booted page has them
await (await import("../../src/android/configuration.ts")).initDeviceLocales();
await (await import("../../src/android/mainloop.ts")).startMainLooper();

(await import("../fwtest/harness.ts")).loader.loadDex = (dex) => { w.addDexes([dex]); };

console.log("");
await import("../fwtest/fonts.ts");
await import("../fwtest/graphics.ts");
await import("../fwtest/bitmap.ts");
await import("../fwtest/text.ts");
await import("../fwtest/resources.ts");
await import("../fwtest/input.ts");
if (unbound.length) console.log(`\n${unbound.length} declared natives with no host binding, first 30:\n  ${unbound.slice(0, 30).join("\n  ")}`);
{ const { suspendedNatives } = await import("../../src/wasm/host/suspend.ts"); if (suspendedNatives.size) console.log(`\nnatives that answered a Promise on a plain import:\n  ${[...suspendedNatives].join("\n  ")}`); }
if (gaps.size) console.log(`\ncompile gaps hit:\n  ${[...gaps].join("\n  ")}`);

const { results } = await import("../fwtest/harness.ts");
const failed = results.filter((r) => r.status !== "ok");
for (const r of failed) console.log(`FAIL ${r.status} ${r.name}: ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} exercises pass`);
process.exit(failed.length ? 1 : 0);
