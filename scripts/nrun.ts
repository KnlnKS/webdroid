// Load an apk's native library headless and run its JNI_OnLoad: the fastest way to shake out the
// CPU/libc/JNI layers without a browser.
//
//   pnpm ts scripts/nrun.ts <apk> <libname.so> [--link]
//
// An ABI the tier can execute runs. One it cannot is loaded and relocated only, and the report
// says so — that is how a loader is proved before its emitter exists. --link forces it.
import { openApk } from "./lib.ts";
import { dexesOfZip } from "../src/jvm/dex.ts";
import { mountLocalPlatformData, platformJarBytes } from "./aosp.ts";
import { rt } from "../src/jvm/runtime.ts";
import { loadDex, loadTier } from "../src/jvm/tier.ts";
import { loadPlatformJar } from "../src/android/framework.ts";
import "../src/natives.ts";
import { loadNativeLib, linkNativeLib } from "../src/native/loader.ts";
import { calledMissing, unresolved, hostTrace } from "../src/native/host.ts";
import { jniMissing, registered } from "../src/native/jni.ts";
import { codeStats, lastFault } from "../src/native/cpu.ts";
import { NativeFault } from "../src/native/core.ts";
import { perf } from "../src/perf.ts";

const args = process.argv.slice(2);
const [apk, lib] = args.filter((a) => !a.startsWith("--"));
const zip = openApk(apk);
await loadTier();
platformJarBytes().forEach((bytes, i) => bytes && loadPlatformJar(bytes, i));
for (const dex of dexesOfZip(zip)) loadDex(dex);
rt.classpath = zip;
hostTrace.on = !!process.env.TRACE;
mountLocalPlatformData();

// the ABIs this apk actually ships this library for, in the order the tree lists them
const abis = Object.keys(rt.classpath).flatMap((k) => {
  const m = /^lib\/([^/]+)\/(.+)$/.exec(k);
  return m && m[2] === lib ? [m[1]] : [];
});
if (!abis.length) { console.error(`no lib/*/${lib} in ${apk}`); process.exit(1); }
const abi = abis.find((a) => rt.nativeAbis.includes(a)) ?? abis[0];
const link = args.includes("--link") || !rt.nativeAbis.includes(abi);

const t0 = performance.now();
try {
  if (link) {
    const mod = await linkNativeLib(lib, rt.classpath[`lib/${abi}/${lib}`], abi);
    const ms = (performance.now() - t0).toFixed(0);
    console.log(`linked ${lib} (${abi}${rt.nativeAbis.includes(abi) ? "" : ", no emitter"}) in ${ms}ms`);
    console.log(`  base=0x${mod.base.toString(16)} size=0x${(mod.end - mod.base).toString(16)} ${mod.w64 ? "ELF64" : "ELF32"}`);
    console.log(`  NEEDED: ${mod.needed.join(" ")}`);
    console.log(`  exports: ${mod.exports.size}  initArray: ${mod.initArray.length}  init: ${mod.init ? "yes" : "no"}`);
    console.log(`  JNI_OnLoad: ${mod.exports.has("JNI_OnLoad") ? "0x" + mod.exports.get("JNI_OnLoad")!.toString(16) : "absent"}`);
    console.log("  0 instructions executed");
  } else {
    await loadNativeLib(lib, rt.classpath[`lib/${abi}/${lib}`], abi);
    console.log("loaded", lib, `(${abi})`, "in", (performance.now() - t0).toFixed(0), "ms");
  }
} catch (e) {
  console.error("FAULT", e instanceof NativeFault ? e.message : e);
  if (process.env.TRACE) console.error((e as Error).stack, "\n  " + (lastFault.regs?.bt.join("\n  ") ?? ""));
  if (hostTrace.on) console.error("host trace:\n  " + hostTrace.ring.slice(-40).join("\n  "));
}
console.log("registered natives:", registered.map((r) => `${r.cls.split("/").pop()}.${r.name}${r.sig}`).join(" "));
console.log("unresolved imports:", [...unresolved].join(" "));
console.log("calledMissing:", [...calledMissing].join(" "));
console.log("jniMissing:", [...jniMissing].join(" "));
console.log("decoded pages:", codeStats.pages, "invalidated:", codeStats.invalidated, "instr:", perf.nativeInstr, "ms:", perf.nativeMs.toFixed(1), "hostCalls:", perf.nativeHostCalls);
process.exit(0);
