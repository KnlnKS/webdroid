// Conformance classes on the Wasm tier, one after another in this process: conform.ts sends a class (and a test-name filter) over IPC and is answered
// ConformRunner's lines. Each class runs in a World of its own, which is closed after it, and the files it made are removed; the process's other host
// state (its natives' tables) carries over. Run by conform.ts: conformworker.ts <dex directory> <runner class>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vcall } from "../../src/jvm/natives/jentry.ts";
import { extraBootEntries } from "../../src/jvm/natives/jvmruntime.ts";
import { suspendedNatives } from "../../src/wasm/host/suspend.ts";
import { world } from "./lib.ts";
import { mountPlatform, startProcess } from "./harness.ts";
import { ROOT, platformJars } from "./paths.ts";
import { filesIn } from "../java.ts";
import { cli } from "../args.ts";
import { vfs } from "../../src/shell/vfs.ts";

const { positionals: [dexDir, runner] } = cli("conformworker.ts <dex directory> <runner class>", {}, { min: 2 });
const dexFiles = filesIn(dexDir, /\.dex$/).sort();
await mountPlatform(ROOT);
const jars = platformJars("core-oj", "core-libart", "okhttp", "bouncycastle", "apache-xml", "core-icu4j", "conscrypt");
if (existsSync(join(dexDir, "resources.jar"))) {
  // the suite's resources are read from this jar by the boot class loader, which the classes of a Program without loaders of its own ask
  vfs.write("/data/local/tmp/resources.jar", new Uint8Array(readFileSync(join(dexDir, "resources.jar"))));
  extraBootEntries.push("/data/local/tmp/resources.jar");
}
console.warn = () => {};
const made: string[] = [];
vfs.watch((path, change) => { if (change === "create") made.push(path); });
/** a throwable's string, its first frames and its causes, on one line */
async function describe(t: unknown): Promise<string> {
  const str = "()Ljava/lang/String;", out: string[] = [];
  for (let c = t; c && out.length < 4; c = await vcall(c, "getCause", "()Ljava/lang/Throwable;")) {
    const frames = (await vcall(c, "getStackTrace", "()[Ljava/lang/StackTraceElement;")) as unknown[];
    out.push([await vcall(c, "toString", str), ...await Promise.all(frames.slice(0, 8).map((f) => vcall(f, "toString", str)))].join(" <- "));
  }
  return out.join(" || caused by ");
}
async function run(cls: string, filter: string): Promise<string> {
  // the runner's own output (60 MB of test names for the largest class, two bytes a char here) is far over ART's 512 MB limit with the suite's objects: the limit is raised
  const w = world([...dexFiles, ...jars], { heapLimit: 3 * 2 ** 30 });
  w.onGap = (gap) => { if (process.env.CONFORM_DEBUG) console.error("gap: " + gap); };
  await startProcess(w);
  try { return await w.entryAsync(runner, "run", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;")(cls, filter) as string; }
  catch (e) {
    const t = w.throwable(e);
    return `F\t${cls}\t${(t ? await describe(w.bridge.toHost(t)) : process.env.CONFORM_DEBUG ? String((e as Error).stack) : String(e)).replace(/\s*\n\s*/g, " | ")}\n`;
  } finally {
    if (process.env.CONFORM_DEBUG) for (const id of suspendedNatives) console.error("suspended: " + id);
    suspendedNatives.clear();
    w.close();
    for (const path of made.splice(0).reverse()) if (!vfs.delete(path, false)) vfs.rmdir(path, false);
  }
}
process.on("message", async ({ cls, filter }: { cls: string; filter: string }) => process.send!(await run(cls, filter)));
