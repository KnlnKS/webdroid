// node runner.js <workload> <reps>: the first call's time and the steady median of Bench.run(workload)
import { openSync, readFileSync, readSync } from "node:fs";
import { rt } from "../../src/jvm/runtime";
import "../../src/natives";
import { dexesIn } from "../../src/jvm/dex";
import { loadPlatformJar } from "../../src/android/framework";
import { PLATFORM_JARS } from "../../src/jvm/provenance";
import { scall, vcallAsync } from "../../src/jvm/natives/jentry";
import { mountPlatformData } from "../../src/shell/apex";

const keep = setInterval(() => {}, 1 << 30); // the yield channel is unref'd
mountPlatformData((path, size) => {
  const fd = openSync(`vendor/aosp${path}`, "r");
  return { size, read: async (at, length) => { const b = new Uint8Array(length); readSync(fd, b, 0, length, at); return b; } };
});
for (const d of dexesIn(new Uint8Array(readFileSync(process.env.JBENCH_DEX!)), "jbench.dex")) rt.loadDex(d);
for (const [i, jar] of PLATFORM_JARS.entries()) loadPlatformJar(new Uint8Array(readFileSync(`vendor/aosp/${jar}`)), i);
rt.linkNatives();
console.warn = () => {};
const bench = rt.link("Bench");
await rt.initClass(bench);
await scall("dalvik/system/CloseGuard", "setEnabled", "(Z)V", 0); // as ActivityThread.main leaves an app process
await scall("java/lang/System", "setProperty", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", "java.io.tmpdir", "/data/local/tmp");
const [workload, repsArg] = process.argv.slice(2), reps = Number(repsArg);
const call = () => vcallAsync(bench.ctor, "run", "(Ljava/lang/String;)I", workload);
let t = performance.now();
const result = await call();
const firstMs = performance.now() - t, times: number[] = [];
for (let i = 0; i < reps; i++) { t = performance.now(); await call(); times.push(performance.now() - t); }
times.sort((a, b) => a - b);
console.log(JSON.stringify({ workload, cut: process.env.WEBDROID_BYTECODE ?? "", result, firstMs: +firstMs.toFixed(2), medianMs: +times[reps >> 1].toFixed(4) }));
clearInterval(keep);
