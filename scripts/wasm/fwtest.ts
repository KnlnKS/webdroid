// The framework delegates' exercises (scripts/fwtest/*) over a World: AOSP's own bytecode for the cut classes runs as Wasm against our delegates, and host code
// drives it through the entry seam. Run: bun run fwtest [prefix ...]
import { DEFAULT_CUTS } from "../fwtest/cuts";
import { BYTECODE, isBytecode } from "../../src/jvm/provenance";

const CUTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
BYTECODE.push(...(CUTS.length ? CUTS : DEFAULT_CUTS));

// imported after the policy is set: rt.register consults it, so the specs never land
const { rt } = await import("../../src/jvm/runtime");
const { world } = await import("./lib");
const { mountPlatform, natives, startProcess } = await import("./harness");
const { PLATFORM_PATHS, ROOT } = await import("./paths");

await mountPlatform(ROOT);
const w = world(PLATFORM_PATHS, { natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
const gaps = new Set<string>();
w.onGap = (id) => gaps.add(w.gapList[id]);
const hosted = new Set<string>();
/** the classes the host implements that have been registered since: the exercises' modules register more as they load, each when it does */
const addHostClasses = () => { for (const spec of natives.source!.hostSpecs!()) if (!hosted.has(spec.name)) { hosted.add(spec.name); w.addHostClass(spec); } };
addHostClasses();
const register = rt.register.bind(rt);
rt.register = (spec) => { const r = register(spec); addHostClasses(); return r; };
await startProcess(w);

// the natives the cut classes declare, against the ones the Wasm tier binds to a host import
let have = 0, total = 0;
const unbound: string[] = [];
for (const jc of w.prog.all()) {
  if (!isBytecode(jc.name)) continue;
  for (const m of jc.methods) {
    if (m.codeOff || !(m.flags & 0x100)) continue;
    total++;
    if (natives.prepare(m)) have++; else unbound.push(`${jc.name}.${m.key}`);
  }
}
console.log(`withheld ${BYTECODE.length} prefixes; ${[...w.prog.all()].length} platform classes\n\ncoverage ${have}/${total} declared natives bound`);

// the device's languages and the main looper the exercises' Handlers attach to, as a booted page has them
await (await import("../../src/android/resnative")).initDeviceLocales();
await (await import("../../src/android/mainloop")).startMainLooper();

(await import("../fwtest/harness")).loader.loadDex = (dex) => { w.addDexes([dex]); };

console.log("");
await import("../fwtest/fonts");
await import("../fwtest/graphics");
await import("../fwtest/bitmap");
await import("../fwtest/text");
await import("../fwtest/resources");
await import("../fwtest/input");
if (unbound.length) console.log(`\n${unbound.length} declared natives with no host binding, first 30:\n  ${unbound.slice(0, 30).join("\n  ")}`);
{ const { suspendedNatives } = await import("../../src/wasm/host/suspend"); if (suspendedNatives.size) console.log(`\nnatives that answered a Promise on a plain import:\n  ${[...suspendedNatives].join("\n  ")}`); }
if (gaps.size) console.log(`\ncompile gaps hit:\n  ${[...gaps].join("\n  ")}`);

const { results } = await import("../fwtest/harness");
const failed = results.filter((r) => r.status !== "ok");
for (const r of failed) console.log(`FAIL ${r.status} ${r.name}: ${r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} exercises pass`);
process.exit(failed.length ? 1 : 0);
