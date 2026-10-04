// One conformance class on the Wasm tier, in this process: prints "\u0001" and ConformRunner's lines (scripts/conform/run.ts --one is the JS tier's).
// Run by conform.ts under node: conformone.ts <dex directory> <runner class> <class> [filter]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldNames, rt } from "../../src/jvm/runtime";
import { useEntry, vcall } from "../../src/jvm/natives/jentry";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { extraBootEntries } from "../../src/wasm/host/hostnatives";
import { suspendedNatives } from "../../src/wasm/host/suspend";
import { fieldNamesOf, hostThrowable, wasmEntry } from "../../src/wasm/host/entry";
import { loadDexes, world } from "./lib";
import { jsTier, natives, processState } from "./oracle";
import { AOSP } from "./paths";
import { vfs } from "../../src/shell/vfs";

const [dexDir, runner, cls, filter = ""] = process.argv.slice(2);
const dexFiles = readdirSync(dexDir).filter((f) => f.endsWith(".dex")).sort().map((f) => join(dexDir, f));
await jsTier(dexFiles.flatMap(loadDexes));
const jars = [0, 1, 2, 3, 4, 12, 18].map((i) => join(AOSP, PLATFORM_JARS[i]));
const w = world([...dexFiles, ...jars], { natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
w.onGap = (id) => { if (process.env.CONFORM_DEBUG) console.error("gap: " + w.gapList[id]); };
for (const spec of natives.source!.hostSpecs!()) w.addHostClass(spec);
useEntry(wasmEntry(w));
fieldNames.find = fieldNamesOf(w);
rt.mkThrowable = hostThrowable;
if (existsSync(join(dexDir, "resources.jar"))) {
  // the suite's resources are read from this jar by the boot class loader, which the classes of a Program without loaders of its own ask
  vfs.write("/data/local/tmp/resources.jar", new Uint8Array(readFileSync(join(dexDir, "resources.jar"))));
  extraBootEntries.push("/data/local/tmp/resources.jar");
}
processState(w);
console.warn = () => {};
/** a throwable's string, its first frames and its causes, on one line */
async function describe(t: unknown): Promise<string> {
  const str = "()Ljava/lang/String;", out: string[] = [];
  for (let c = t; c && out.length < 4; c = await vcall(c, "getCause", "()Ljava/lang/Throwable;")) {
    const frames = (await vcall(c, "getStackTrace", "()[Ljava/lang/StackTraceElement;")) as unknown[];
    out.push([await vcall(c, "toString", str), ...await Promise.all(frames.slice(0, 8).map((f) => vcall(f, "toString", str)))].join(" <- "));
  }
  return out.join(" || caused by ");
}
let text: string;
try { text = await w.entryAsync(runner, "run", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")(cls, filter) as string; }
catch (e) {
  const t = w.throwable(e);
  text = `F\t${cls}\t${(t ? await describe(w.bridge.toHost(t)) : process.env.CONFORM_DEBUG ? String((e as Error).stack) : String(e)).replace(/\s*\n\s*/g, " | ")}\n`;
}
if (process.env.CONFORM_DEBUG) for (const id of suspendedNatives) console.error("suspended: " + id);
process.stdout.write("\u0001" + text);
process.exit(0);
