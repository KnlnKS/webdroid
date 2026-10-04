// scripts/fwtest.ts over a World: AOSP's own bytecode for the cut classes runs as Wasm against our delegates, host code drives it through the entry seam, and the
// exercises are the ones of the JS tier (scripts/fwtest/*), with the lines they print compared in the suite's report. Run: bun run wasm fwtest [prefix ...]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CUTS } from "../fwtest/cuts";
import { BYTECODE, PLATFORM_JARS, isBytecode } from "../../src/jvm/provenance";

const CUTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
BYTECODE.push(...(CUTS.length ? CUTS : DEFAULT_CUTS));

// imported after the policy is set: rt.register consults it, so the specs never land
const { rt } = await import("../../src/jvm/runtime");
const { hostThrowable } = await import("../../src/wasm/host/entry");
const { strandEntry } = await import("./strandentry");
const { world } = await import("./lib");
const { jsTier, natives } = await import("./oracle");
const { AOSP } = await import("./paths");

await jsTier([]);
const w = world(PLATFORM_JARS.map((j) => join(AOSP, j)), { natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
const gaps = new Set<string>();
w.onGap = (id) => gaps.add(w.gapList[id]);
const hosted = new Set<string>();
/** the classes the host implements that have been registered since: the exercises' modules register more as they load, each when it does */
const addHostClasses = () => { for (const spec of natives.source!.hostSpecs!()) if (!hosted.has(spec.name)) { hosted.add(spec.name); w.addHostClass(spec); } };
addHostClasses();
strandEntry(w);
rt.mkThrowable = hostThrowable;
// the process state ActivityThread.main leaves, entered on a strand: System's initialization reads files
try {
  await w.entryAsync("dalvik/system/CloseGuard", "setEnabled", "(Z)V")(0);
  await w.entryAsync("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")("java.io.tmpdir", "/data/local/tmp");
} catch (e) { const t = w.throwable(e); throw new Error(`process state: ${t ? w.classNameOf(t) : e} ${[...gaps]}`); }

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

// the main looper the exercises' Handlers attach to (it is not run: the loop on a strand is Track C's)
const { scall, vcall } = await import("../../src/jvm/natives/jentry");
try { await scall("android/os/Looper", "prepareMainLooper", "()V"); } catch (e) { console.log("prepareMainLooper:", e instanceof Error ? e.stack : await vcall(e, "toString", "()Ljava/lang/String;")); }

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

// every exercise passes on the JS tier; a failure here is pinned to its mechanism in tests/conformance/wasm-fwtest.json, or it is unexplained
const { results } = await import("../fwtest/harness");
const pins: Record<string, string> = JSON.parse(readFileSync("tests/conformance/wasm-fwtest.json", "utf8"));
let bad = 0;
for (const r of results) {
  const pin = pins[r.name];
  if (r.status === "ok" && pin) { bad++; console.log(`STALE ${r.name}: pinned, but it passes now`); }
  if (r.status !== "ok" && !pin) { bad++; console.log(`UNEXPLAINED ${r.status} ${r.name}: ${r.detail}`); }
}
for (const name of Object.keys(pins)) if (!results.some((r) => r.name === name)) { bad++; console.log(`STALE ${name}: pinned, but no exercise has that name`); }
console.log(`\n${results.filter((r) => r.status === "ok").length}/${results.length} exercises pass on the Wasm tier (the JS tier: all); ${results.filter((r) => r.status !== "ok" && pins[r.name]).length} pinned, ${bad} unexplained`);
process.exit(bad ? 1 : 0);
