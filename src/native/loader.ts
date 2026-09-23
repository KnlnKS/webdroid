import { rt, type Runtime } from "../jvm/runtime";
import { curThread, type JThread } from "../jvm/natives/jlang";
import { libcInit } from "./libc";
import { dlInit, loadModule, resolveGlobalOrNull } from "./dl";
import type { Module } from "./elf";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni";
import { gles1Init } from "./gles1";
import { gles3Init } from "./gles3";
import { eglInit } from "./egl";
import { aaudioInit } from "./aaudio";
import { mediaInit } from "./media";
import { ndkInit } from "./libandroid";
import { bitmapInit } from "./bitmap";
import { cpuFor, setA64, isA64 } from "./cpu";

let inited = false;
function nativeInit(abi: string): void {
  const wide = abi === "arm64-v8a";
  if (inited) {
    if (wide !== isA64()) throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `Cannot load ${abi} code in a ${isA64() ? "64" : "32"}-bit process`);
    return;
  }
  setA64(wide);
  rt.nativeAbis = NATIVE_ABIS.filter(a => (a === "arm64-v8a") === wide);
  inited = true;
  libcInit();
  dlInit();
  jniInit();
  gles1Init();
  gles3Init();
  eglInit();
  ndkInit();
  mediaInit();
  aaudioInit();
  bitmapInit();
  resolveByExport(resolveGlobalOrNull);
}

/** The ABIs this tier can execute, most-preferred first. The one place that knows: the ELF
 *  loader, the dynamic linker's own lib search and System.loadLibrary's choice all read it, and
 *  adding a backend is one edit here. */
const NATIVE_ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi"] as const;
rt.nativeAbis = NATIVE_ABIS;

/** Load and relocate an image without executing a single instruction of it. An ABI whose
 *  emitter does not exist yet can still prove its loader: scripts/nrun.ts --load-only. */
export async function linkNativeLib(name: string, bytes: Uint8Array, abi = ""): Promise<Module> {
  nativeInit(abi);
  return loadModule(name, bytes, true);
}

export async function loadNativeLib(name: string, bytes: Uint8Array, abi: string, owner: Runtime = rt, thread: JThread = curThread): Promise<void> {
  if (!(NATIVE_ABIS as readonly string[]).includes(abi)) {
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${name}" is ${abi} machine code`);
  }
  // the ABI decides the pointer width the JNI tables are laid out at, so it has to be known
  // before nativeInit builds them
  nativeInit(abi);
  // the caller's Cpu, chosen before anything awaits: init arrays and JNI_OnLoad run on the thread
  // that called dlopen. Picking it afterwards once ran an executor's JNI_OnLoad on the main Cpu,
  // parked mid-static-initialiser, and libc++'s guard reported a recursive initialisation.
  const cpu = cpuFor(thread);
  const mod = await loadModule(name, bytes, false, owner, cpu);
  const onload = mod.exports.get("JNI_OnLoad");
  if (onload) {
    const previous = cpu.nativeRuntime;
    cpu.nativeRuntime = owner;
    pushFrame(cpu);
    try { await cpu.call(onload, [javaVM.addr, 0]); }
    finally { popFrame(cpu); cpu.nativeRuntime = previous; }
  }
}

rt.loadNativeLib = (name, bytes, abi, owner, thread) => loadNativeLib(name, bytes, abi, owner, thread as JThread | undefined);
