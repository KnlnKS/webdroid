import { rt, type Runtime } from "../jvm/runtime";
import { curThread, appNativeAbi, mainThread, type JThread } from "../jvm/natives/jlang";
import { setNativeMemorySizer } from "../jvm/natives/jnio";
import { libcInit } from "./libc";
import { kernelInit } from "./syscall";
import { dlInit, loadModule, modulePath, modules, resolveGlobalOrNull } from "./dl";
import type { Module } from "./elf";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni";
import { gles1Init } from "./gles1";
import { gles3Init } from "./gles3";
import { eglInit } from "./egl";
import { aaudioInit } from "./aaudio";
import { mediaInit } from "./media";
import { ndkInit } from "./libandroid";
import { bitmapInit } from "./bitmap";
import { cpuFor, cpuOf, cpus, setA64, isA64, type Cpu } from "./cpu";
import { procMemory } from "../shell/procfs";
import { bootBionic } from "./bionic";

const hex = (n: number) => n.toString(16).padStart(8, "0");
/** /proc/self/maps: each image, then each thread's stack, the main thread's named as the kernel names it */
procMemory.maps = () => [...modules.map((m) => `${hex(m.base)}-${hex(m.end)} r-xp 00000000 00:00 0  ${modulePath(m)}`),
  ...[...cpus].filter((c) => c.stackBase).map((c) => `${hex(c.stackBase)}-${hex(c.stackTop)} rw-p 00000000 00:00 0  ${c.jthread === mainThread ? "[stack]" : `[anon:stack_and_tls:${c.osTid}]`}`)].join("\n") + "\n";
procMemory.startStack = () => { const main = cpuOf(mainThread); return main?.stackTop ? main.stackTop - 64 : 0; };

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
  kernelInit();
  if (!wide) libcInit();
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
setNativeMemorySizer(() => {
  const abi = appNativeAbi();
  if (!abi || !(NATIVE_ABIS as readonly string[]).includes(abi)) return false;
  nativeInit(abi);
  return true;
});

let bionic: Promise<void> | null = null;
/** a 64-bit process's libc: bionic's libraries load and initialize before the first image that needs them */
function libcReady(cpu: Cpu): Promise<void> | null {
  if (!isA64()) return null;
  return (bionic ??= bootBionic(cpu));
}

/** Load and relocate an image without executing a single instruction of it. An ABI whose
 *  emitter does not exist yet can still prove its loader: scripts/nrun.ts --load-only. */
export async function linkNativeLib(name: string, bytes: Uint8Array, abi = ""): Promise<Module> {
  nativeInit(abi);
  await libcReady(cpuFor(curThread));
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
  // that called dlopen. After an await the current thread may be another one (the main Cpu,
  // parked mid-static-initialiser, where libc++'s guard reports a recursive initialisation).
  const cpu = cpuFor(thread);
  await libcReady(cpu);
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
