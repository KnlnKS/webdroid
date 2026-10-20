// One conformance class on the Wasm tier, in this process: prints "\u0001" and ConformRunner's lines.
// Run by conform.ts: conformone.ts <dex directory> <runner class> <class> [filter]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rt } from "../../src/jvm/runtime.ts";
import { vcall } from "../../src/jvm/natives/jentry.ts";
import { extraBootEntries } from "../../src/jvm/natives/jvmruntime.ts";
import { suspendedNatives } from "../../src/wasm/host/suspend.ts";
import { world } from "./lib.ts";
import { attachHostClasses, mountPlatform, natives, startProcess } from "./harness.ts";
import { ROOT, platformJars } from "./paths.ts";
import { filesIn } from "./tools.ts";
import { vfs } from "../../src/shell/vfs.ts";

const [dexDir, runner, cls, filter = ""] = process.argv.slice(2);
const dexFiles = filesIn(dexDir, /\.dex$/).sort();
await mountPlatform(ROOT);
const jars = platformJars("core-oj", "core-libart", "okhttp", "bouncycastle", "apache-xml", "core-icu4j", "conscrypt");
// the runner's own output (60 MB of test names for the largest class, two bytes a char here) is far over ART's 512 MB limit with the suite's objects: the limit is raised
const w = world([...dexFiles, ...jars], { heapLimit: 3 * 2 ** 30, natives, claim: (owner, handle) => rt.claimHandle?.(owner, handle) });
w.onGap = (gap) => { if (process.env.CONFORM_DEBUG) console.error("gap: " + gap); };
attachHostClasses(w);
if (existsSync(join(dexDir, "resources.jar"))) {
  // the suite's resources are read from this jar by the boot class loader, which the classes of a Program without loaders of its own ask
  vfs.write("/data/local/tmp/resources.jar", new Uint8Array(readFileSync(join(dexDir, "resources.jar"))));
  extraBootEntries.push("/data/local/tmp/resources.jar");
}
await startProcess(w);
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
// a pipe takes its bytes asynchronously: exiting first cuts the output at the pipe's buffer
await new Promise<void>((done) => process.stdout.write("\u0001" + text, () => done()));
process.exit(0);
