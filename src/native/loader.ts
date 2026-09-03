// The System.loadLibrary hook for lib/{armeabi,armeabi-v7a}/lib<name>.so: registers the host
// libraries once, loads + relocates the module, runs its init arrays and JNI_OnLoad.

import { rt } from "../jvm/runtime";
import { curThread } from "../jvm/natives/jlang";
import { libcInit } from "./libc";
import { dlInit, loadModule, modules } from "./dl";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni";
import { gles1Init } from "./gles1";
import { cpuFor } from "./cpu";
import { lookupHost } from "./host";

let inited = false;
function nativeInit(): void {
  if (inited) return;
  inited = true;
  libcInit();
  dlInit();
  jniInit();
  gles1Init();
  resolveByExport((sym) => { for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; } return lookupHost(sym); });
}

export async function loadNativeLib(name: string, bytes: Uint8Array, abi: string): Promise<void> {
  if (abi !== "armeabi" && abi !== "armeabi-v7a") {
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${name}" is ${abi} machine code`);
  }
  nativeInit();
  const mod = await loadModule(name, bytes);
  const onload = mod.exports.get("JNI_OnLoad");
  if (onload) {
    const cpu = cpuFor(curThread);
    pushFrame(cpu);
    try { await cpu.call(onload, [javaVM.addr, 0]); }
    finally { popFrame(cpu); }
  }
}

rt.loadNativeLib = loadNativeLib;
