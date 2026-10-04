// scratch: runs P.run() of a dex directory on a World
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { fieldNames, rt } from "../../src/jvm/runtime";
import { useEntry, vcall } from "../../src/jvm/natives/jentry";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { fieldNamesOf, hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { loadDexes, world } from "./lib";
import { jsTier, natives, processState } from "./oracle";
import { AOSP } from "./paths";
const [dexDir, cls] = process.argv.slice(2);
const dexFiles = readdirSync(dexDir).filter((f) => f.endsWith(".dex")).sort().map((f) => join(dexDir, f));
await jsTier(dexFiles.flatMap(loadDexes));
const jars = [0, 1, 2, 3, 4, 5, 12, 18].map((i) => join(AOSP, PLATFORM_JARS[i]));
const w = world([...dexFiles, ...jars], { natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
w.onGap = (id) => console.error("gap: " + w.gapList[id]);
for (const spec of natives.source!.hostSpecs!()) w.addHostClass(spec);
useEntry(wasmEntry(w));
fieldNames.find = fieldNamesOf(w);
rt.mkThrowable = hostThrowable;
processState(w);
try { console.log(await w.entryAsync(cls, "run", "()Ljava/lang/String;")()); } catch (e) { const t = w.throwable(e); console.log("threw", t ? await vcall(w.bridge.toHost(t), "toString", "()Ljava/lang/String;") : e); }
process.exit(0);
