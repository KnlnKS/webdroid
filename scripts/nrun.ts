// Load an apk's ARM32 library headless and run its JNI_OnLoad: the fastest way to shake out the
// CPU/libc/JNI layers without a browser. bun scripts/nrun.ts <apk> <libname.so>
import { unzipSync } from "fflate";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import "../src/jvm/natives/jlang";
import "../src/jvm/natives/jutil";
import "../src/jvm/natives/jio";
import { loadNativeLib } from "../src/native/loader";
import { calledMissing, unresolved, hostTrace } from "../src/native/host";
import { jniMissing, registered } from "../src/native/jni";
import { blockStats, NativeFault } from "../src/native/cpu";
import { symbolizePc } from "../src/native/dl";
import { perf } from "../src/perf";

const [apk, lib] = process.argv.slice(2);
const zip = unzipSync(new Uint8Array(await Bun.file(apk).arrayBuffer()));
for (const [name, bytes] of Object.entries(zip)) {
  if (/classes\d*\.dex$/.test(name)) rt.loadDex(new DexFile(bytes, name));
  rt.classpath[name] = bytes;
}
hostTrace.on = !!process.env.TRACE;
const abi = ["armeabi-v7a", "armeabi"].find((a) => rt.classpath[`lib/${a}/${lib}`])!;
const t0 = performance.now();
try {
  await loadNativeLib(lib, rt.classpath[`lib/${abi}/${lib}`], abi);
  console.log("loaded", lib, "in", (performance.now() - t0).toFixed(0), "ms");
} catch (e) {
  console.error("FAULT", e instanceof NativeFault ? e.message : e);
  if (e instanceof NativeFault) console.error("ring:", e.ring.slice(-16).map((p) => symbolizePc(p)).join("\n  "));
  if (hostTrace.on) console.error("host trace:\n  " + hostTrace.ring.slice(-40).join("\n  "));
}
console.log("registered natives:", registered.map((r) => `${r.cls.split("/").pop()}.${r.name}${r.sig}`).join(" "));
console.log("unresolved imports:", [...unresolved].join(" "));
console.log("calledMissing:", [...calledMissing].join(" "));
console.log("jniMissing:", [...jniMissing].join(" "));
console.log("blocks:", blockStats, "instr:", perf.nativeInstr, "ms:", perf.nativeMs.toFixed(1), "hostCalls:", perf.nativeHostCalls);
process.exit(0);
