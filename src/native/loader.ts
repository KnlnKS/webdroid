import { rt } from "../jvm/runtime";
import { curThread } from "../jvm/natives/jlang";
import { libcInit } from "./libc";
import { dlInit, loadModule, resolveGlobalOrNull } from "./dl";
import type { Module } from "./elf";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni";
import { gles1Init } from "./gles1";
import { gles3Init } from "./gles3";
import { eglInit } from "./egl";
import { ndkInit } from "./libandroid";
import { cpuFor, setA64 } from "./cpu";

let inited = false;
function nativeInit(): void {
  if (inited) return;
  inited = true;
  libcInit();
  dlInit();
  jniInit();
  gles1Init();
  gles3Init();
  eglInit();
  ndkInit();
  resolveByExport(resolveGlobalOrNull);
}

/** The ABIs this tier can execute, most-preferred first. The one place that knows: the ELF
 *  loader, the dynamic linker's own lib search and System.loadLibrary's choice all read it, and
 *  adding a backend is one edit here. */
export const NATIVE_ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi"] as const;
rt.nativeAbis = NATIVE_ABIS;

/** Load and relocate an image without executing a single instruction of it. An ABI whose
 *  emitter does not exist yet can still prove its loader: scripts/nrun.ts --load-only. */
export async function linkNativeLib(name: string, bytes: Uint8Array, abi = ""): Promise<Module> {
  setA64(abi === "arm64-v8a");
  nativeInit();
  return loadModule(name, bytes, true);
}

export async function loadNativeLib(name: string, bytes: Uint8Array, abi: string): Promise<void> {
  if (!(NATIVE_ABIS as readonly string[]).includes(abi)) {
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${name}" is ${abi} machine code`);
  }
  // the ABI decides the pointer width the JNI tables are laid out at, so it has to be known
  // before nativeInit builds them
  setA64(abi === "arm64-v8a");
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
