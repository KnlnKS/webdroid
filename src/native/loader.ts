import { rt, type Gen } from "../jvm/runtime.ts";
import { curThread, mainThread } from "../jvm/natives/jentry.ts";
import { libcInit } from "./libc32/libc.ts";
import { kernelInit } from "./syscall.ts";
import { dlInit, loadModule, modulePath, modules, resolveGlobalOrNull } from "./dl.ts";
import type { Module } from "./elf.ts";
import { jniInit, javaVM, pushFrame, popFrame, resolveByExport } from "./jni.ts";
import { java } from "../jvm/javahost.ts";
import { gles1Init } from "./gles1.ts";
import { gles3Init } from "./gles3.ts";
import { eglInit } from "./egl.ts";
import { aaudioInit } from "./aaudio.ts";
import { hardwareBufferInit } from "./hardwarebuffer.ts";
import { surfaceControlInit } from "./surfacecontrol.ts";
import { imageReaderInit } from "./imagereader.ts";
import { mediaInit } from "./media.ts";
import { ndkInit } from "./libandroid.ts";
import { bitmapInit } from "./bitmap.ts";
import { vulkanInit } from "./vulkan/index.ts";
import { cpuFor, cpuOf, cpus, setA64, isA64, type Cpu } from "./cpu.ts";
import { procMemory } from "../shell/procfs.ts";
import { bootBionic } from "./bionic.ts";
import { ABIS_32, ABIS_64 } from "../shell/properties.ts";

const hex = (n: number) => n.toString(16).padStart(8, "0");
const perms = (flags: number) => `${flags & 4 ? "r" : "-"}${flags & 2 ? "w" : "-"}${flags & 1 ? "x" : "-"}p`;
/** each segment's file-backed pages, then its zero-filled tail as bionic's linker names it; an image
 *  mapped from inside an apk shows the apk */
function segmentLines(m: Module): string[] {
  const path = modulePath(m), file = m.apkOffset === undefined ? path : path.slice(0, path.indexOf("!/"));
  return m.segments.flatMap((s) => [...s.fileEnd > s.start ? [`${hex(s.start)}-${hex(s.fileEnd)} ${perms(s.flags)} ${hex(s.offset + (m.apkOffset ?? 0))} 00:00 0  ${file}`] : [],
    ...s.end > s.fileEnd ? [`${hex(s.fileEnd)}-${hex(s.end)} ${perms(s.flags)} 00000000 00:00 0  [anon:.bss]`] : []]);
}
/** /proc/self/maps: each image's segments, then each thread's stack, the main thread's named as the kernel names it */
procMemory.maps = () => [...modules.flatMap(segmentLines),
  ...[...cpus].filter((c) => c.stackBase).map((c) => `${hex(c.stackBase)}-${hex(c.stackTop)} rw-p 00000000 00:00 0  ${c.jthread === mainThread ? "[stack]" : `[anon:stack_and_tls:${c.osTid}]`}`)].join("\n") + "\n";
procMemory.startStack = () => { const main = cpuOf(mainThread); return main?.stackTop ? main.stackTop - 64 : 0; };

let inited = false;
function nativeInit(wide: boolean): void {
  if (inited) {
    if (wide !== isA64()) throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `Cannot load ${wide ? "64" : "32"}-bit code in a ${isA64() ? "64" : "32"}-bit process`);
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
  hardwareBufferInit();
  surfaceControlInit();
  mediaInit();
  imageReaderInit();
  aaudioInit();
  bitmapInit();
  vulkanInit();
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
export async function linkNativeLib(name: string, bytes: Uint8Array): Promise<Module> {
  nativeInit(bytes[4] === 2);                                                   // EI_CLASS: ELFCLASS64
  await libcReady(cpuFor(curThread));
  return loadModule(name, bytes, true);
}

/** `name` is the library's path, or its name when it came from the class path. `caller` is the java.lang.Class whose code loads the
 *  library: JNI_OnLoad finds classes through its loader, as ART's loader override has it */
export async function loadNativeLib(name: string, bytes: Uint8Array, abi: string, caller: unknown = null): Promise<void> {
  if (!NATIVE_ABIS.includes(abi)) {
    throw rt.mkThrowable("java/lang/UnsatisfiedLinkError", `dlopen failed: library "${name}" is ${abi} machine code`);
  }
  // the ABI decides the pointer width the JNI tables are laid out at, so it has to be known
  // before nativeInit builds them
  nativeInit(ABIS_64.includes(abi));
  // the caller's Cpu, chosen before anything suspends: init arrays and JNI_OnLoad run on the thread
  // that called dlopen (the main Cpu may be parked mid-static-initialiser meanwhile, where libc++'s
  // guard would report a recursive initialisation), and driven, as its call chain: a <clinit>'s
  // when it loads its library
  const cpu = cpuFor(curThread);
  return rt.drive(function* (): Gen<void> {
    yield libcReady(cpu);
    const mod: Module = yield loadModule(name, bytes, false, cpu);
    const onload = mod.exports.get("JNI_OnLoad");
    if (!onload) return;
    const previousClass = cpu.nativeClass;
    cpu.nativeClass = caller === null ? null : java.jni.classOf(caller);
    pushFrame(cpu);
    try { yield cpu.call(onload, [javaVM.addr, 0]); }
    finally { popFrame(cpu); cpu.nativeClass = previousClass; }
  }());
}

rt.loadNativeLib = loadNativeLib;
