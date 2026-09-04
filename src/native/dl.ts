// The dynamic linker: module table, global symbol scope (modules, then host libs, then logging
// stubs), dlopen/dlsym over virtual host libs and APK-shipped libraries, exidx lookup for the
// guest's own unwinder.

import { loadElf, symbolize, nearestSymbol, type Module } from "./elf";
import { mem } from "./mem";
import { probeHost, hostLib, lookupHost, hostLibNames, missingStub, slotName, isTrampPc, PTR, stp } from "./host";
import { cpuFor, setSymbolizeHook, setA64, isA64, type Cpu } from "./cpu";
import { trampSlot, RET_SENTINEL } from "./abi";
import { rt } from "../jvm/runtime";
import { curThread } from "../jvm/natives/jlang";

export const modules: Module[] = [];
const byName = new Map<string, Module>();

type Handle = { mod: Module } | { lib: string };
const handles: Handle[] = [];
/** dlopen handles start here: 0, -1 and 1 (the main program) mean the global scope to dlsym */
const HANDLE_BASE = 0x100;
let dlerrorMsg: string | null = null;
let dlerrorBuf = 0;
const inflight = new Map<string, Promise<Module>>();

function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }

/** the bytes of lib<name>.so shipped in the booted apk, for any ABI the tier runs */
function apkLibBytes(name: string): Uint8Array | null {
  for (const a of rt.nativeAbis) { const b = rt.classpath[`lib/${a}/${name}`]; if (b) return b; }
  return null;
}

/** `link` loads and relocates without executing anything — no init array, no JNI_OnLoad. It is
 *  what an image whose machine code the tier cannot run yet can still be proved to do. */
export async function loadModule(name: string, bytes?: Uint8Array, link = false): Promise<Module> {
  name = basename(name);
  const have = byName.get(name);
  if (have) { have.refs++; return have; }
  const p = inflight.get(name);
  if (p) return p;
  const q = (async () => {
    const b = bytes ?? apkLibBytes(name);
    if (!b) throw new Error(`dlopen failed: library "${name}" not found`);
    const mod = loadElf(name, b, resolveGlobal);
    // a process is one ABI: the first image decides which emitter its code compiles with
    if (!modules.length) setA64(mod.w64);
    else if (mod.w64 !== isA64()) throw new Error(`${name}: ${mod.w64 ? "64" : "32"}-bit image in a ${isA64() ? "64" : "32"}-bit process`);
    modules.push(mod);
    byName.set(name, mod);
    // dependencies that are real modules in the apk load (and initialise) first; host libs need nothing
    for (const n of mod.needed) if (!hostLibNames().includes(n) && !byName.has(n) && apkLibBytes(n)) await loadModule(n, undefined, link);
    if (!link) await runInit(mod);
    return mod;
  })();
  inflight.set(name, q);
  try { return await q; } finally { inflight.delete(name); }
}

async function runInit(mod: Module): Promise<void> {
  if (mod.inited) return;
  mod.inited = true;
  const cpu = cpuFor(curThread);
  if (mod.init) await cpu.call(mod.init);
  for (const f of mod.initArray) if (f && f !== 0xffffffff && f !== RET_SENTINEL) await cpu.call(f);
}

function resolveGlobal(sym: string, weak: boolean, _from: Module): number {
  for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; }
  const h = lookupHost(sym);
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

/** the frame-pointer chain from x29: what called what, as module+offset (a debugging aid) */
export function backtrace(cpu: Cpu, max = 24): string[] {
  const out = [symbolizePc(cpu.r[cpu.pcx] >>> 0), symbolizePc(cpu.r[cpu.lrx] >>> 0)];
  let fp = cpu.r[29] >>> 0;
  for (let i = 0; i < max && fp; i++) {
    try { out.push(symbolizePc(Number(mem.ld64(fp + 8) & 0xffffffffn))); fp = Number(mem.ld64(fp) & 0xffffffffn); } catch { break; }
  }
  return out;
}

function setErr(msg: string): void { dlerrorMsg = msg; }
function handleOf(h: Handle): number {
  const i = handles.findIndex((x) => ("mod" in x && "mod" in h && x.mod === h.mod) || ("lib" in x && "lib" in h && x.lib === h.lib));
  if (i >= 0) return HANDLE_BASE + i;
  handles.push(h);
  return HANDLE_BASE + handles.length - 1;
}

export function dlInit(): void {
  setSymbolizeHook(symbolizePc);
  dlerrorBuf = mem.hostAlloc(256);
  hostLib("libdl.so", {
    dlopen: async (_cpu, a) => {
      const path = a.p(), name = path ? basename(mem.cstr(path)) : "";
      if (!name) return 1; // the main program
      if (hostLibNames().includes(name)) return handleOf({ lib: name });
      const have = byName.get(name);
      if (have) { have.refs++; return handleOf({ mod: have }); }
      if (!apkLibBytes(name)) { setErr(`dlopen failed: library "${name}" not found`); return 0; }
      try { return handleOf({ mod: await loadModule(name) }); }
      catch (e) { setErr(String((e as Error).message ?? e)); return 0; }
    },
    dlsym: (_cpu, a) => {
      const h = a.i(), sym = a.str();
      if (h === 0 || h === -1 || h === -2 || h === 1) {
        const v = resolveGlobalOrNull(sym);
        if (v === undefined) { setErr(`undefined symbol: ${sym}`); return 0; }
        return v;
      }
      const hd = handles[h - HANDLE_BASE];
      if (!hd) { setErr("invalid handle"); return 0; }
      if ("mod" in hd) {
        const v = hd.mod.exports.get(sym);
        if (v === undefined) { setErr(`undefined symbol: ${sym}`); return 0; }
        return v;
      }
      return probeHost(sym, hd.lib);
    },
    dlclose: (_cpu, a) => { const hd = handles[a.i() - HANDLE_BASE]; if (hd && "mod" in hd) hd.mod.refs--; return 0; },
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
    __gnu_Unwind_Find_exidx: (_cpu, a) => {
      const pc = a.p(), pcount = a.p();
      const m = moduleOf(pc);
      if (!m) { mem.st32(pcount, 0); return 0; }
      mem.st32(pcount, m.exidx.count);
      return m.exidx.addr;
    },
  });
}

const nameStrs = new Map<Module, number>();
function nameStr(m: Module): number { let p = nameStrs.get(m); if (!p) nameStrs.set(m, (p = mem.hostStr(`/data/app/lib/${m.w64 ? "arm64-v8a" : "armeabi-v7a"}/${m.name}`))); return p; }

function resolveGlobalOrNull(sym: string): number | undefined {
  for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; }
  return lookupHost(sym);
}
