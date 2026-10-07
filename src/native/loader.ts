import { rt, type Runtime, type Gen } from "../jvm/runtime";
import { curThread, mainThread } from "../jvm/natives/jentry";
import { libcInit } from "./libc";
import { kernelInit } from "./syscall";
import { dlInit, loadModule, modulePath, modules, resolveGlobalOrNull } from "./dl";
import type { Module } from "./elf";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni";
import { vm } from "./jnivm";
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
import { ABIS_32, ABIS_64 } from "../shell/properties";

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
  rt.nativeAbis = wide ? ABIS_64 : ABIS_32;
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

/** The ABIs this tier can execute, most-preferred first: the device's (ro.product.cpu.abilist).
 *  The ELF loader, the dynamic linker's own lib search and System.loadLibrary's choice all read it. */
const NATIVE_ABIS = [...ABIS_64, ...ABIS_32];
rt.nativeAbis = NATIVE_ABIS;

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

/** `caller` is the java.lang.Class whose code loads the library: JNI_OnLoad finds classes through its loader, as ART's loader override has it */
export async function loadNativeLib(name: string, bytes: Uint8Array, abi: string, owner: Runtime = rt, caller: unknown = null): Promise<void> {
  if (!NATIVE_ABIS.includes(abi)) {
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${name}" is ${abi} machine code`);
  }
  // the ABI decides the pointer width the JNI tables are laid out at, so it has to be known
  // before nativeInit builds them
  nativeInit(abi);
  // the caller's Cpu, chosen before anything suspends: init arrays and JNI_OnLoad run on the thread
  // that called dlopen (the main Cpu may be parked mid-static-initialiser meanwhile, where libc++'s
  // guard would report a recursive initialisation), and driven, as its call chain: a <clinit>'s
  // when it loads its library
  const cpu = cpuFor(curThread);
  return rt.drive(function* (): Gen<void> {
    yield libcReady(cpu);
    const mod: Module = yield loadModule(name, bytes, false, owner, cpu);
    const onload = mod.exports.get("JNI_OnLoad");
    if (!onload) return;
    const previous = cpu.nativeRuntime, previousClass = cpu.nativeClass;
    cpu.nativeRuntime = owner;
    cpu.nativeClass = caller === null ? null : vm.classOf(caller);
    pushFrame(cpu);
    try { yield cpu.call(onload, [javaVM.addr, 0]); }
    finally { popFrame(cpu); cpu.nativeRuntime = previous; cpu.nativeClass = previousClass; }
  }());
}

rt.loadNativeLib = loadNativeLib;
