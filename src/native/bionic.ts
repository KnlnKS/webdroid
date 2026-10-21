// The reference build's bionic, the libc of every 64-bit process, run as guest code. The build
// ships no 32-bit bionic (its ABI list is arm64-v8a alone), so an armeabi-v7a process keeps the
// HLE libc. dl.ts is the dynamic linker, so the linker's share of process and thread setup is here:
// libc_shared_globals, the auxiliary vector, the static TLS layout and each thread's TCB,
// pthread_internal_t and bionic_tls. Offsets are this build's (checked against libc.so's own
// code: __errno, getauxval, __init_static_tls, __allocate_thread_mapping, pthread_getattr_np).

import { mem } from "./mem.ts";
import { defineHost, hostLib, ldp, stp, SERVED, type HostFn } from "./host.ts";
import { interposed, linkerHooks, loadModule, prefetchModules, runInit, libdl as dl, modules } from "./dl.ts";
import { setThreadHooks, type Cpu } from "./cpu.ts";
import { setAbortMessage } from "./crash.ts";
import { E, RET_SENTINEL, TRAMP_BASE, TRAMP_END } from "./abi.ts";
import { fail } from "./kernel.ts";
import { auxv, memcpyChk } from "./proc.ts";
import type { Module } from "./elf.ts";
import { processEnv } from "../shell/environment.ts";
import { procIdentity } from "../shell/procfs.ts";
import { PROPERTY_AREA_PATH, propertyArea } from "../shell/properties.ts";
import { vfs } from "../shell/vfs.ts";
import { targetSdkVersion } from "../jvm/natives/jvmruntime.ts";

/** device paths, in the order the linker initializes them (dependencies first) */
const BIONIC_LIBS = ["/apex/com.android.runtime/lib64/bionic/libdl.so", "/apex/com.android.runtime/lib64/bionic/libc.so",
  "/apex/com.android.runtime/lib64/bionic/libm.so", "/system/lib64/libc++.so", "/system/lib64/liblog.so", "/system/lib64/libz.so"];
/** every device library mirrored under vendor/aosp: bionic's, and what they dlopen by name
 *  (netdClientInit's libnetd_client.so, which connects getaddrinfo to netd's dnsproxyd) */
export const DEVICE_LIBS = [...BIONIC_LIBS, "/system/lib64/libnetd_client.so"];

/** what the host serves in place of bionic's own: the core's memory and string primitives */
const INTRINSICS = ["memcpy", "memmove", "memset", "memcmp", "memchr", "strlen", "strnlen", "strcmp", "strncmp", "__memcpy_chk"];
/** The heap is the core's too, reached through bionic's malloc dispatch table (what malloc_debug and
 *  heapprofd install), since libc calls its malloc directly as well as through its PLT. MallocDispatch
 *  on LP64: calloc, free, mallinfo, malloc, malloc_usable_size, memalign, posix_memalign, realloc,
 *  malloc_iterate, malloc_disable, malloc_enable, mallopt, aligned_alloc, malloc_info. */
const HEAP = ["calloc", "free", "mallinfo", "malloc", "malloc_usable_size", "memalign", "posix_memalign", "realloc",
  "malloc_iterate", "malloc_disable", "malloc_enable", "mallopt", "aligned_alloc", "malloc_info"];
const GLOBALS_DISPATCH = 0x48;

// libc_shared_globals
const G_SIZE = 0x6d8, G_AUXV = 0x418, G_ABORT_MSG = 0x448, G_TLS_SIZE = 0x450, G_TLS_ALIGN = 0x458, G_TLS_TCB = 0x460, G_TLS_BIONIC = 0x468, G_TLS_EXE = 0x470;
const G_GENERATION = 0x478, G_MODULE_COUNT = 0x4c0, G_STATIC_MODULES = 0x4c8, G_MODULE_TABLE = 0x4d0, G_PROGNAME = 0x630, G_ENVIRON = 0x638;
const TLS_MODULE = 0x40;
// pthread_internal_t
const T_SIZE = 0x308, T_TID = 0x10, T_CACHED_PID = 0x14, T_STACK_BASE = 0x20, T_STACK_SIZE = 0x28, T_JOIN_STATE = 0x50, T_START = 0x60,
  T_STACK_TOP = 0x90, T_BIONIC_TLS = 0x2f8, T_ERRNO = 0x300;
const THREAD_DETACHED = 3;
// static TLS: bionic_tcb's ten slots from TLS_SLOT -2, the thread pointer at slot 0; ELF TLS
// segments start past slot 7, the ARM variant 1 reservation; bionic_tls (12,192 bytes) last
const TCB_SIZE = 80, TP = 16, SLOT_DTV = 0, SLOT_THREAD = 8, SLOT_GUARD = 0x28, SLOT_BIONIC_TLS = -8, BIONIC_TLS_SIZE = 0x3000;

let globals = 0, tlsSize = 0, bionicTls = 0, zeroDtv = 0, stackGuard = 0n;
const staticModules: Module[] = [];

/** The linker's work before any guest instruction runs: map the libraries, lay out static TLS,
 *  give the calling thread its bionic identity, then run each library's initializers in order. */
export async function bootBionic(cpu: Cpu): Promise<void> {
  for (const name of INTRINSICS) interposed.set(name, defineHost(name, name === "__memcpy_chk" ? memcpyChk : SERVED));
  const heap = heapDispatch();
  hostLib("ld-android.so", loaderExports());
  linkerHooks.hwcap = BigInt(auxv().find(([type]) => type === 16)![1]);
  linkerHooks.deviceLib = (name) => DEVICE_LIBS.find((path) => path.endsWith("/" + name)) ?? null;
  globals = mem.calloc(1, G_SIZE);
  writeGlobals();
  // what init leaves for libc's __system_properties_init
  vfs.write(PROPERTY_AREA_PATH, propertyArea(), false);
  let cursor = TCB_SIZE;
  linkerHooks.placeTls = (mod) => {
    const tls = mod.tls!, align = Math.max(tls.align, 8);
    cursor = (cursor + align - 1) & -align;
    mod.tpOffset = cursor - TP;
    cursor += tls.size;
    staticModules.push(mod);
  };
  const mods: Module[] = [];
  // the libraries' reads overlap; they link in order
  prefetchModules(BIONIC_LIBS);
  try {
    for (const path of BIONIC_LIBS) mods.push(await loadModule(path, undefined, true, cpu));
  } finally { linkerHooks.placeTls = null; }
  // the executable's libraries are its global group, which dlclose never unloads
  for (const mod of mods) mod.nodelete = true;
  bionicTls = (cursor + 15) & -16;
  tlsSize = bionicTls + BIONIC_TLS_SIZE;
  writeTlsLayout();
  const libc = mods[1];
  const hidden = (name: string) => { const at = libc.locals.get(name); if (!at) throw new Error(`bionic: libc.so has no ${name}`); return at; };
  zeroDtv = hidden("_ZZ14__init_tcb_dtvP10bionic_tcbE8zero_dtv");
  const add = hidden("_Z22__pthread_internal_addP18pthread_internal_t"), remove = hidden("_Z25__pthread_internal_removeP18pthread_internal_t");
  const finalize = hidden("__cxa_thread_finalize"), keyCleanAll = hidden("_Z21pthread_key_clean_allv"), freeDynamicTls = hidden("_Z18__free_dynamic_tlsP10bionic_tcb");
  stackGuard = BigInt.asUintN(64, mem.ld64(auxv().find(([type]) => type === 25)![1]));
  // libc's own initializer adds the thread running it to the thread list as the process's first
  attach(cpu);
  setThreadHooks({
    start: async (c) => { attach(c); await c.call(add, [c.pthreadSelf]); },
    // pthread_create named the thread's pthread_internal_t in its TLS before the clone
    cloned: (c) => { c.errnoAddr = ldp(mem.txVa(c.tlsVa) + SLOT_THREAD) + T_ERRNO; },
    // pthread_exit's teardown, but for the stack, which the Cpu owns; the static TLS block starts
    // with the bionic_tcb, TP below the thread pointer
    end: async (c) => {
      const block = c.tlsBase - TP;
      await c.call(finalize, [], "thread_local destructors");
      await c.call(keyCleanAll, [], "key destructors");
      await c.call(freeDynamicTls, [block]);
      await c.call(remove, [c.pthreadSelf]);
      mem.free(c.pthreadSelf); mem.free(block);
    },
  });
  linkerHooks.linked = (mod, c) => cfiAdd([mod], c);
  // CFIShadowWriter::BeforeUnload: the granules only the image covered are invalid again
  linkerHooks.unloading = (mod) => {
    const granule = 2 ** CFI_SHADOW_ALIGN, begin = Math.ceil(mod.start / granule) * granule, end = Math.floor(mod.end / granule) * granule;
    if (cfiShadow && begin < end) cfiFill(begin, end, () => 0);
  };
  // abort_msg_t {size, msg[]}, which android_set_abort_message maps for the crash reporter
  setAbortMessage(() => { const m = mem.ld64(globals + G_ABORT_MSG); return m ? mem.cstr(mem.txVa(m) + 8) : ""; });
  await cfiAdd(mods, cpu);
  for (const mod of mods) await runInit(mod, cpu);
  // after libc's own init, which zeroes __libc_globals; what scudo allocated before is never freed
  stp(libc.locals.get("__libc_globals")! + GLOBALS_DISPATCH, heap);
}

function heapDispatch(): number {
  const own: Record<string, HostFn> = {
    // struct mallinfo is returned through x8: the core heap's arena and what is in use of it
    mallinfo: (cpu) => {
      const out = cpu.xp(8), s = mem.stats();
      mem.memset(out, 0, 80);
      mem.st64(out, BigInt(s.peak)); mem.st64(out + 56, BigInt(s.used)); mem.st64(out + 64, BigInt(Math.max(0, s.peak - s.used)));
      return 0;
    },
    malloc_iterate: (cpu) => fail(cpu, E.NOTSUP),
    malloc_info: (cpu) => fail(cpu, E.NOTSUP),
    // nothing allocates concurrently with a fork here, and the core heap has no tunables
    malloc_disable: () => 0, malloc_enable: () => 0, mallopt: () => 0,
  };
  const table = mem.hostAlloc(HEAP.length * 8, 32);
  HEAP.forEach((name, i) => stp(table + i * 8, defineHost(name === "aligned_alloc" ? "memalign" : name, own[name] ?? SERVED)));
  return table;
}

// linker_cfi.cpp's shadow: a u16 per 256 KiB of address space, kept by the linker once a module
// has __cfi_check and handed to libdl's __cfi_slowpath through __cfi_init
const CFI_SHADOW_SIZE = 2 ** 31, CFI_SHADOW_ALIGN = 18, CFI_CHECK_ALIGN = 12, CFI_UNCHECKED = 1, CFI_REGULAR_MIN = 2;
let cfiShadow = 0n;
async function cfiAdd(added: Module[], cpu: Cpu): Promise<void> {
  if (!cfiShadow) {
    if (!added.some((m) => m.exports.has("__cfi_check"))) return;
    cfiShadow = BigInt(mem.mapVa(CFI_SHADOW_SIZE, true));
    await cpu.call(modules.find((m) => m.name === "libdl.so")!.exports.get("__cfi_init")!, [cfiShadow]);
    added = modules;
    // host functions are targets like any library without __cfi_check
    cfiFill(TRAMP_BASE, TRAMP_END, () => CFI_UNCHECKED);
  }
  for (const mod of added) {
    const check = mod.exports.get("__cfi_check");
    if (!check) { cfiFill(mod.base, mod.end, () => CFI_UNCHECKED); continue; }
    // Add(): nothing below __cfi_check, each value the distance from the granule above to it
    const begin = Math.max(mod.base, check) & -(1 << CFI_SHADOW_ALIGN);
    cfiFill(begin, mod.end, (at, old) => {
      const v = ((at + (1 << CFI_SHADOW_ALIGN) - check) >>> CFI_CHECK_ALIGN) + CFI_REGULAR_MIN;
      return v > 0xffff || old ? CFI_UNCHECKED : v;
    });
  }
}
function cfiFill(begin: number, end: number, value: (granule: number, old: number) => number): void {
  const first = (begin >>> CFI_SHADOW_ALIGN) * 2, last = ((end - 1) >>> CFI_SHADOW_ALIGN) * 2;
  mem.commitVa(cfiShadow + BigInt(first), last - first + 2);
  for (let off = first; off <= last; off += 2) {
    const at = mem.txVa(cfiShadow + BigInt(off));
    mem.st16(at, value((off / 2) * 2 ** CFI_SHADOW_ALIGN, mem.ld16u(at)));
  }
}

/** a thread the host created (a Java thread entering native code) gets what pthread_create would
 *  have given it: static TLS holding its TCB and bionic_tls, and a pthread_internal_t naming its stack */
function attach(cpu: Cpu): void {
  cpu.ensureStack();
  const block = mem.memalign(16, tlsSize), thread = mem.calloc(1, T_SIZE);
  if (!block || !thread) throw new Error("bionic: out of memory for a thread");
  mem.memset(block, 0, tlsSize);
  for (const mod of staticModules) mem.write(block + TP + mod.tpOffset!, mod.tls!.image);
  const tp = block + TP;
  stp(tp + SLOT_DTV, zeroDtv);
  stp(tp + SLOT_THREAD, thread);
  mem.st64(tp + SLOT_GUARD, stackGuard);
  stp(tp + SLOT_BIONIC_TLS, block + bionicTls);
  mem.st32(thread + T_TID, cpu.osTid);
  mem.st32(thread + T_CACHED_PID, cpu.pid);
  mem.st64(thread + T_STACK_BASE, BigInt(cpu.stackBase));
  mem.st64(thread + T_STACK_SIZE, BigInt(cpu.stackTop - cpu.stackBase));
  // never joined, and not the main thread (whose stack bionic would look up in /proc/self/maps)
  mem.st32(thread + T_JOIN_STATE, THREAD_DETACHED);
  stp(thread + T_START, RET_SENTINEL);
  mem.st64(thread + T_STACK_TOP, BigInt(cpu.stackTop));
  stp(thread + T_BIONIC_TLS, block + bionicTls);
  cpu.bindThread(tp, thread, thread + T_ERRNO);
}

function writeGlobals(): void {
  const av = auxv();
  const vec = mem.calloc(av.length + 1, 16);
  av.forEach(([type, value], i) => { mem.st64(vec + i * 16, BigInt(type)); mem.st64(vec + i * 16 + 8, BigInt(value)); });
  stp(globals + G_AUXV, vec);
  mem.st64(globals + G_GENERATION, 1n);
  stp(globals + G_PROGNAME, mem.strdup(procIdentity.argv0 || "app_process64"));
  const env = Object.entries(processEnv), environ = mem.calloc(env.length + 1, 8);
  env.forEach(([k, v], i) => stp(environ + i * 8, mem.strdup(`${k}=${v}`)));
  stp(globals + G_ENVIRON, environ);
}

function writeTlsLayout(): void {
  mem.st64(globals + G_TLS_SIZE, BigInt(tlsSize));
  mem.st64(globals + G_TLS_ALIGN, 16n);
  mem.st64(globals + G_TLS_TCB, 0n);
  mem.st64(globals + G_TLS_BIONIC, BigInt(bionicTls));
  mem.st64(globals + G_TLS_EXE, -1n);
  // TlsModule: segment {size, align {value, skew}, init_ptr, init_size}, static_offset, first_generation, soinfo
  const table = mem.calloc(staticModules.length, TLS_MODULE);
  staticModules.forEach((mod, i) => {
    const e = table + i * TLS_MODULE, tls = mod.tls!, image = mem.malloc(Math.max(tls.image.length, 1));
    mem.write(image, tls.image);
    mem.st64(e, BigInt(tls.size)); mem.st64(e + 8, BigInt(tls.align));
    stp(e + 0x18, image); mem.st64(e + 0x20, BigInt(tls.image.length));
    mem.st64(e + 0x28, BigInt(TP + mod.tpOffset!)); mem.st64(e + 0x30, 1n);
  });
  mem.st64(globals + G_MODULE_COUNT, BigInt(staticModules.length));
  mem.st64(globals + G_STATIC_MODULES, BigInt(staticModules.length));
  stp(globals + G_MODULE_TABLE, table);
}

/** ld-android.so: the linker's exports libdl.so and libc.so call into */
function loaderExports(): Record<string, HostFn> {
  return {
    __loader_shared_globals: () => globals,
    __loader_dlopen: dl.dlopen, __loader_android_dlopen_ext: dl.dlopen,
    __loader_dlsym: dl.dlsym, __loader_dlvsym: dl.dlsym,
    __loader_dlclose: dl.dlclose, __loader_dlerror: dl.dlerror, __loader_dladdr: dl.dladdr,
    __loader_dl_iterate_phdr: dl.dl_iterate_phdr,
    __loader_cfi_fail: (cpu, a) => { a.l(); const target = a.p(); return cpu.fault(`CFI check failed for an indirect call to 0x${target.toString(16)}`); },
    __loader_android_get_application_target_sdk_version: () => targetSdkVersion(),
    // a module's thread_local destructors keep it loaded; nothing here unloads a module
    __loader_add_thread_local_dtor: dl.addThreadLocalDtor, __loader_remove_thread_local_dtor: dl.removeThreadLocalDtor,
  };
}
