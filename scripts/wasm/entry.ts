// The entry seam (B1): host code calls Java through jentry's names, once on the JS tier and once over a World next to it, and the answers, the exceptions
// that leave the calls and the identity of the objects must be the same. (entrytier.ts then runs them on the Wasm tier alone.) Run: bun run wasm entry
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { fieldNames, rt } from "../../src/jvm/runtime";
import { jsEntry, useEntry } from "../../src/jvm/natives/jentry";
import { perf } from "../../src/perf";
import { fieldNamesOf, wasmEntry } from "../../src/wasm/host/entry";
import { loadDexes, world } from "./lib";
import { jsTier, natives } from "./oracle";
import { AOSP } from "./paths";
import { settled } from "../../src/wasm/host/nativesource";
import { entryCases, entryDex } from "./entrycases";

const dex = entryDex(), jars = [0, 1, 12].map((i) => join(AOSP, PLATFORM_JARS[i]));
await jsTier(loadDexes(dex));
useEntry(jsEntry);
const js = await entryCases();

const w = world([dex, ...jars], { natives }), gaps: string[] = [];
w.onGap = (id) => gaps.push(w.gapList[id]);
useEntry(wasmEntry(w));
fieldNames.find = fieldNamesOf(w);
const missesBefore = perf.wasmFacadeMisses;
const wasm = await entryCases();
const facade = (await (await import("../../src/jvm/natives/jentry")).newObj("E")) as Record<string, unknown>;
void facade.noSuchField;
const counted = perf.wasmFacadeMisses - missesBefore === 1 && rt.missing.has("facade E.noSuchField") && perf.wasmEntries > 0;

let failed = 0;
js.forEach((want, i) => { if (wasm[i] !== want) { failed++; console.log(`FAIL wasm: ${want.split(":")[0]}\n  js    ${want}\n  wasm  ${wasm[i]}`); } });
if (wasm.length !== js.length) { failed++; console.log(`FAIL wasm: ${wasm.length} answers for ${js.length}`); }
if (!counted) { failed++; console.log("FAIL a read no field backs is not counted in perf and the missing entries"); }
if (gaps.length) { failed++; console.log(`FAIL gaps hit: ${[...new Set(gaps)].join("; ")}`); }
// what the process on the Wasm tier is compared with, and the values of the natives the JS tier settled for it (it has no JS tier to settle them)
writeFileSync(process.env.WASM_ENTRY_OUT!, JSON.stringify({ js, settled: [...settled] }));
console.log(failed ? `${failed} failures` : `${js.length} entry calls answer alike on the JS tier and on a World`);
process.exit(failed ? 1 : 0);
