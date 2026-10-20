// The dynamic linker: module table, global symbol scope (modules, then host libs, then logging
// stubs), dlopen/dlsym over virtual host libs and APK-shipped libraries, exidx lookup for the
// guest's own unwinder.

import { mapElf, symbolize, nearestSymbol, type Module } from "./elf.ts";
import { mem } from "./mem.ts";
import { defineHost, probeHost, hostLib, lookupHost, hostLibNames, missingStub, slotName, isTrampPc, PTR, stp, type HostFn } from "./host.ts";
import { cpuFor, cpus, setSymbolizeHook, setA64, isA64, type Cpu } from "./cpu.ts";
import type { TombstoneFrame } from "./tombstone.ts";
import { trampSlot, RET_SENTINEL } from "./abi.ts";
import { rt, type Gen } from "../jvm/runtime.ts";
import { curThread } from "../jvm/natives/jentry.ts";
import { vfs } from "../shell/vfs.ts";

export const modules: Module[] = [];
const byName = new Map<string, Module>();

/** a dlopen handle: a module, a host library, or one dlclose unloaded */
type Handle = { mod: Module } | { lib: string } | null;
const handles: Handle[] = [];
/** dlopen handles start here: 0, -1 and 1 (the main program) mean the global scope to dlsym */
const HANDLE_BASE = 0x100;
const RTLD_NOLOAD = 4, RTLD_NODELETE = 0x1000;
let dlerrorMsg: string | null = null;
let dlerrorBuf = 0;
const inflight = new Map<string, Promise<Module>>();
const tlsDescriptors = new Map<number, { mod: Module; offset: number }>();
let tlsDescResolver = 0;
/** names the host serves in place of any image's own definition */
export const interposed = new Map<string, number>();
/** the linker's process-specific parts: static TLS placement for a module mapped while it is set
 *  (bionic's initial set), AT_HWCAP for IFUNC resolvers, and the device libraries dlopen may name */
export const linkerHooks: {
  placeTls: ((mod: Module) => void) | null; hwcap: bigint; deviceLib: (name: string) => string | null;
  /** a module is linked and about to be initialized */
  linked: (mod: Module, cpu: Cpu) => Promise<void> | void;
  /** a module's image is about to be unmapped */
  unloading: (mod: Module) => void;
} = { placeTls: null, hwcap: 0n, deviceLib: () => null, linked: () => {}, unloading: () => {} };

function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }

/** where lib<name>.so comes from: the booted apk's lib/<abi>/, for any ABI the tier runs, else a
 *  device library at its path in the VFS */
function libSource(name: string): { device?: string; read: () => Promise<Uint8Array | null> } | null {
  for (const a of rt.nativeAbis) { const path = `lib/${a}/${name}`; if (rt.hasClasspath(path)) return { read: async () => rt.readClasspath(path) }; }
  const device = linkerHooks.deviceLib(name);
  return device ? { device, read: async () => (await vfs.readFile(device)) ?? null } : null;
}

/** `link` loads and relocates without executing anything — no init array, no JNI_OnLoad. It is
 *  what an image whose machine code the tier cannot run yet can still be proved to do. */
export async function loadModule(name: string, bytes?: Uint8Array, link = false, cpu: Cpu = cpuFor(curThread)): Promise<Module> {
  name = basename(name);
  const have = byName.get(name);
  if (have) { have.refs++; return have; }
  const p = inflight.get(name);
  if (p) return p;
  // driven: initializers run as the call chain that loads the image (a <clinit>'s, when it loads its library)
  const q = Promise.resolve(rt.drive(function* (): Gen<Module> {
    const source = bytes ? null : libSource(name), b: Uint8Array | null = bytes ?? (source ? yield source.read() : null);
    if (!b) throw new Error(`dlopen failed: library "${name}" not found`);
    const { mod, relocate } = mapElf(name, b);
    mod.path = source?.device;
    // a process is one ABI: the first image decides which emitter its code compiles with
    if (!modules.length) setA64(mod.w64);
    else if (mod.w64 !== isA64()) throw new Error(`${name}: ${mod.w64 ? "64" : "32"}-bit image in a ${isA64() ? "64" : "32"}-bit process`);
    modules.push(mod);
    byName.set(name, mod);
    // dependencies that are real modules load (and initialise) first, each holding a reference;
    // host libs need nothing
    for (const n of mod.needed) {
      const have = byName.get(n);
      if (have) have.refs++;
      else if (!hostLibNames().includes(n) && libSource(n)) yield loadModule(n, undefined, link, cpu);
    }
    yield* resolveIfuncs(mod, cpu);
    if (mod.tls) linkerHooks.placeTls?.(mod);
    relocate(resolveGlobal);
    installTlsDescriptors(mod);
    yield linkerHooks.linked(mod, cpu);
    if (!link) yield* initialize(mod, cpu);
    return mod;
  }()));
  inflight.set(name, q);
  try { return await q; } finally { inflight.delete(name); }
}

/** The host's interposed names replace the image's own; an IFUNC export's resolver picks the
 *  implementation for this CPU, run with AT_HWCAP and the __ifunc_arg_t AArch64 passes beside it. */
function* resolveIfuncs(mod: Module, cpu: Cpu): Gen<void> {
  for (const [name, addr] of interposed) if (mod.exports.has(name) || mod.ifuncs.delete(name)) mod.exports.set(name, addr);
  if (!mod.ifuncs.size) return;
  const arg = mem.malloc(24);
  try {
    mem.st64(arg, 24n); mem.st64(arg + 8, linkerHooks.hwcap); mem.st64(arg + 16, 0n);
    for (const [name, resolver] of mod.ifuncs) {
      mod.exports.set(name, (yield cpu.call(resolver, [linkerHooks.hwcap | 1n << 62n, arg])) >>> 0);
    }
  } finally { mem.free(arg); }
}

function installTlsDescriptors(mod: Module): void {
  if (!mod.tlsDescriptors.length) return;
  if (!tlsDescResolver) tlsDescResolver = defineHost("__tlsdesc_resolver", (cpu, a) => {
    const descriptor = a.p(), entry = tlsDescriptors.get(descriptor);
    if (!entry) return cpu.fault("invalid TLS descriptor");
    const tls = entry.mod.tls;
    if (!tls) return cpu.fault("TLS descriptor without a TLS segment");
    if (entry.mod.tpOffset !== null) return entry.mod.tpOffset + entry.offset;
    return BigInt(cpu.staticTls(entry.mod, tls.image, tls.size, tls.align) + entry.offset) - cpu.tlsVa;
  });
  for (const entry of mod.tlsDescriptors) {
    tlsDescriptors.set(entry.addr, { mod, offset: entry.offset });
    stp(entry.addr, tlsDescResolver);
    stp(entry.addr + PTR, entry.offset);
  }
}

function* initialize(mod: Module, cpu: Cpu): Gen<void> {
  if (mod.inited) return;
  mod.inited = true;
  if (mod.init) yield cpu.call(mod.init);
  for (const f of mod.initArray) if (f && f !== 0xffffffff && f !== RET_SENTINEL) yield cpu.call(f);
}
/** run an image's DT_INIT and init array once, as the call chain asking */
export async function runInit(mod: Module, cpu: Cpu): Promise<void> { return rt.drive(initialize(mod, cpu)); }

/** dlclose's release of a reference, bionic's soinfo_unload: when an image's last goes, it and the
 *  dependencies only it held run DT_FINI_ARRAY (in reverse) and DT_FINI, root first, before any
 *  image is unmapped and its symbols leave the scope, so a later dlopen loads it fresh. NODELETE
 *  images stay; an image's dynamic TLS blocks go with it, as unregister_soinfo_tls retires its
 *  module and each thread's dtv update frees the block. */
async function unload(root: Module, cpu: Cpu): Promise<void> {
  const gone: Module[] = [];
  const release = (m: Module) => {
    if (m.refs > 0 && --m.refs > 0 || m.nodelete || m.tpOffset !== null || gone.includes(m)) return;
    gone.push(m);
    for (const n of m.needed) { const dep = byName.get(n); if (dep) release(dep); }
  };
  release(root);
  for (const m of gone) if (m.inited) {
    for (const f of [...m.finiArray].reverse()) if (f && f !== 0xffffffff && f !== RET_SENTINEL) await cpu.call(f);
    if (m.fini) await cpu.call(m.fini);
  }
  for (const m of gone) {
    linkerHooks.unloading(m);
    modules.splice(modules.indexOf(m), 1);
    byName.delete(m.name);
    nameStrs.delete(m);
    handles.forEach((h, i) => { if (h && "mod" in h && h.mod === m) handles[i] = null; });
    for (const at of tlsDescriptors.keys()) if (at >= m.base && at < m.end) tlsDescriptors.delete(at);
    if (m.tls) for (const c of cpus) c.releaseTls(m);
    mem.releaseImage(m.start, m.end - m.start);
  }
}

function resolveGlobal(sym: string, weak: boolean, from: Module): number {
  const h = resolveGlobalOrNull(sym, from.needed);
  if (h !== undefined) return h;
  if (weak) return 0;
  return missingStub(sym);
}

function moduleOf(pc: number): Module | null {
  pc >>>= 0;                                               // a pc in a register is int32; an image above 2 GiB is not
  for (const m of modules) if (pc >= m.base && pc < m.end) return m;
  return null;
}
export function symbolizePc(pc: number): string {
  pc >>>= 0;
  if (isTrampPc(pc)) return "host:" + slotName(trampSlot(pc));
  return symbolize(modules, pc);
}

/** the frame-pointer chain from x29: the pc, lr and each saved return address */
export function backtracePcs(cpu: Cpu, max = 24): number[] {
  const out = [cpu.pc >>> 0, cpu.lr >>> 0];
  let fp = cpu.w[58] >>> 0;
  for (let i = 0; i < max && fp; i++) {
    try { out.push(Number(mem.ld64(fp + 8) & 0xffffffffn)); fp = Number(mem.ld64(fp) & 0xffffffffn); } catch { break; }
  }
  return out;
}
/** what called what, as module+offset (a debugging aid) */
export const backtrace = (cpu: Cpu, max = 24): string[] => backtracePcs(cpu, max).map(symbolizePc);
/** a frame as debuggerd's unwinder names it: the image's path and the nearest symbol */
export function tombstoneFrame(pc: number): TombstoneFrame {
  const m = moduleOf(pc), s = m && nearestSymbol(m, pc);
  // a host body stands for the library function of its name
  if (!m) return { pc, relPc: pc, file: "", fn: isTrampPc(pc) ? slotName(trampSlot(pc)) : "", fnOffset: 0 };
  return { pc, relPc: pc - m.base, file: m.path ?? m.name, fn: s?.name ?? "", fnOffset: s ? pc - s.addr : 0 };
}
function handleOf(h: Handle): number {
  const i = handles.findIndex((x) => x && h && (("mod" in x && "mod" in h && x.mod === h.mod) || ("lib" in x && "lib" in h && x.lib === h.lib)));
  if (i >= 0) return HANDLE_BASE + i;
  handles.push(h);
  return HANDLE_BASE + handles.length - 1;
}

export function dlInit(): void {
  setSymbolizeHook(symbolizePc);
  dlerrorBuf = mem.hostAlloc(256);
  // a 64-bit process links bionic's libdl.so, which reaches these bodies through ld-android.so
  if (!isA64()) hostLib("libdl.so", libdl);
}

const findExidx: HostFn = (_cpu, a) => {
  const pc = a.p(), pcount = a.p(), m = moduleOf(pc);
  mem.st32(pcount, m?.exidx.count ?? 0);
  return m?.exidx.addr ?? 0;
};
/** libdl's bodies, which bionic's libdl.so reaches as ld-android.so's __loader_* (their extra
 *  caller-address argument is unread) */
export const libdl: Record<string, HostFn> = {
  dlopen: async (cpu, a) => {
    const path = a.p(), flags = a.i(), name = path ? basename(mem.cstr(path)) : "";
    if (!name) return 1; // the main program
    if (hostLibNames().includes(name)) return handleOf({ lib: name });
    const have = byName.get(name);
    const opened = (mod: Module) => { if (flags & RTLD_NODELETE) mod.nodelete = true; return handleOf({ mod }); };
    if (have) { have.refs++; return opened(have); }
    if (flags & RTLD_NOLOAD) { dlerrorMsg = `dlopen failed: library "${name}" wasn't loaded and RTLD_NOLOAD prevented it`; return 0; }
    if (!libSource(name)) { dlerrorMsg = `dlopen failed: library "${name}" not found`; return 0; }
    try { return opened(await loadModule(name, undefined, false, cpu)); }
    catch (e) { dlerrorMsg = String((e as Error).message ?? e); return 0; }
  },
  dlsym: (_cpu, a) => {
    const h = a.i(), sym = a.str();
    if (h === 0 || h === -1 || h === -2 || h === 1) {
      const v = resolveGlobalOrNull(sym);
      if (v === undefined) { dlerrorMsg = `undefined symbol: ${sym}`; return 0; }
      return v;
    }
    const hd = handles[h - HANDLE_BASE];
    if (!hd) { dlerrorMsg = "invalid handle"; return 0; }
    if ("mod" in hd) {
      const v = hd.mod.exports.get(sym);
      if (v === undefined) { dlerrorMsg = `undefined symbol: ${sym}`; return 0; }
      return v;
    }
    return probeHost(sym, hd.lib);
  },
  dlclose: async (cpu, a) => {
    const h = a.i(), hd = handles[h - HANDLE_BASE];
    if (h === 1) return 0;
    if (!hd) { dlerrorMsg = `invalid handle: 0x${(h >>> 0).toString(16)}`; return -1; }
    if ("mod" in hd) await unload(hd.mod, cpu);
    return 0;
  },
  // a thread_local's destructor holds its image until the destructor has run
  addThreadLocalDtor: (_cpu, a) => { const m = moduleOf(a.p()); if (m) m.refs++; return 0; },
  removeThreadLocalDtor: async (cpu, a) => { const m = moduleOf(a.p()); if (m) await unload(m, cpu); return 0; },
  dlerror: () => {
    if (dlerrorMsg === null) return 0;
    mem.putCstr(dlerrorBuf, dlerrorMsg, 256);
    dlerrorMsg = null;
    return dlerrorBuf;
  },
  // Dl_info: dli_fname, dli_fbase, dli_sname, dli_saddr
  dladdr: (_cpu, a) => {
    const addr = a.p(), info = a.p();
    const m = moduleOf(addr);
    if (!m) return 0;
    const s = nearestSymbol(m, addr);
    stp(info, nameStr(m)); stp(info + PTR, m.base);
    stp(info + 2 * PTR, s ? mem.hostStr(s.name) : 0); stp(info + 3 * PTR, s ? s.addr : 0);
    return 1;
  },
  // dl_phdr_info: dlpi_addr, dlpi_name, dlpi_phdr, dlpi_phnum (u16), then the counters, all at
  // the pointer stride — 64 bytes on LP64, 32 on ILP32. The unwinder walks this to find
  // PT_GNU_EH_FRAME, so it is the C++ throw path.
  dl_iterate_phdr: async (cpu, a) => {
    const cb = a.p(), data = a.va();
    const size = PTR === 8 ? 64 : 32;
    const info = mem.malloc(size);
    try {
      for (const m of [...modules]) {
        mem.memset(info, 0, size);
        stp(info, m.base); stp(info + PTR, nameStr(m)); stp(info + 2 * PTR, m.phdr); mem.st16(info + 3 * PTR, m.phnum);
        const r = await cpu.call(cb, [info, size, data]);
        if (r) return r;
      }
      return 0;
    } finally { mem.free(info); }
  },
  __gnu_Unwind_Find_exidx: findExidx,
  dl_unwind_find_exidx: findExidx,
};

/** where an image lives: its device path, else the app's library directory for its ABI */
export const modulePath = (m: Module): string => m.path ?? `/data/app/lib/${m.w64 ? "arm64-v8a" : "armeabi-v7a"}/${m.name}`;
const nameStrs = new Map<Module, number>();
function nameStr(m: Module): number { let p = nameStrs.get(m); if (!p) nameStrs.set(m, (p = mem.hostStr(modulePath(m)))); return p; }

export function resolveGlobalOrNull(sym: string, needed: readonly string[] = []): number | undefined {
  for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; }
  for (const lib of needed) { const a = lookupHost(sym, lib); if (a !== undefined) return a; }
  return lookupHost(sym);
}
