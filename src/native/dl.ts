// The dynamic linker: module table, global symbol scope (modules, then host libs, then logging
// stubs), dlopen/dlsym over virtual host libs and APK-shipped libraries, exidx lookup for the
// guest's own unwinder.

import { loadElf, symbolize, type Module } from "./elf";
import { mem } from "./mem";
import { hostLib, lookupHost, hostLibNames, missingStub, slotName, isTrampPc } from "./host";
import { cpuFor, setSymbolizeHook } from "./cpu";
import { trampSlot, RET_SENTINEL } from "./abi";
import { rt } from "../jvm/runtime";
import { curThread } from "../jvm/natives/jlang";

export const modules: Module[] = [];
const byName = new Map<string, Module>();
const ABIS = ["armeabi-v7a", "armeabi"];
type Handle = { mod: Module } | { lib: string };
const handles: Handle[] = [];
let dlerrorMsg: string | null = null;
let dlerrorBuf = 0;
const inflight = new Map<string, Promise<Module>>();

function basename(p: string): string { return p.slice(p.lastIndexOf("/") + 1); }

/** the bytes of lib<name>.so shipped in the booted apk, for any ABI the tier runs */
export function apkLibBytes(name: string): Uint8Array | null {
  for (const a of ABIS) { const b = rt.classpath[`lib/${a}/${name}`]; if (b) return b; }
  return null;
}

export async function loadModule(name: string, bytes?: Uint8Array): Promise<Module> {
  name = basename(name);
  const have = byName.get(name);
  if (have) { have.refs++; return have; }
  const p = inflight.get(name);
  if (p) return p;
  const q = (async () => {
    const b = bytes ?? apkLibBytes(name);
    if (!b) throw new Error(`dlopen failed: library "${name}" not found`);
    const mod = loadElf(name, b, resolveGlobal);
    modules.push(mod);
    byName.set(name, mod);
    // dependencies that are real modules in the apk load (and initialise) first; host libs need nothing
    for (const n of mod.needed) if (!hostLibNames().includes(n) && !byName.has(n) && apkLibBytes(n)) await loadModule(n);
    await runInit(mod);
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

export function resolveGlobal(sym: string, weak: boolean, _from: Module): number {
  for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; }
  const h = lookupHost(sym);
  if (h !== undefined) return h;
  if (weak) return 0;
  return missingStub(sym);
}

export function moduleOf(pc: number): Module | null {
  for (const m of modules) if (pc >= m.base && pc < m.end) return m;
  return null;
}
export function symbolizePc(pc: number): string {
  if (isTrampPc(pc)) return "host:" + slotName(trampSlot(pc));
  return symbolize(modules, pc);
}

function setErr(msg: string): void { dlerrorMsg = msg; }
function handleOf(h: Handle): number {
  const i = handles.findIndex((x) => ("mod" in x && "mod" in h && x.mod === h.mod) || ("lib" in x && "lib" in h && x.lib === h.lib));
  if (i >= 0) return i + 1;
  handles.push(h);
  return handles.length;
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
      if (h === 0 || h === -1 || h === 1) {
        const v = resolveGlobalOrNull(sym);
        if (v === undefined) { setErr(`undefined symbol: ${sym}`); return 0; }
        return v;
      }
      const hd = handles[h - 1];
      if (!hd) { setErr("invalid handle"); return 0; }
      if ("mod" in hd) {
        const v = hd.mod.exports.get(sym);
        if (v === undefined) { setErr(`undefined symbol: ${sym}`); return 0; }
        return v;
      }
      const v = lookupHost(sym, hd.lib);
      if (v !== undefined) return v;
      // a host library answers every dlsym: the entry point logs itself in calledMissing when it is
      // actually called, so telemetry rather than a symbol list decides what matters
      return missingStub(hd.lib + "!" + sym);
    },
    dlclose: (_cpu, a) => { const hd = handles[a.i() - 1]; if (hd && "mod" in hd) hd.mod.refs--; return 0; },
    dlerror: () => {
      if (dlerrorMsg === null) return 0;
      mem.putCstr(dlerrorBuf, dlerrorMsg, 256);
      dlerrorMsg = null;
      return dlerrorBuf;
    },
    dladdr: () => 0,
    __gnu_Unwind_Find_exidx: (_cpu, a) => {
      const pc = a.p(), pcount = a.p();
      const m = moduleOf(pc);
      if (!m) { mem.st32(pcount, 0); return 0; }
      mem.st32(pcount, m.exidx.count);
      return m.exidx.addr;
    },
  });
}

function resolveGlobalOrNull(sym: string): number | undefined {
  for (const m of modules) { const a = m.exports.get(sym); if (a !== undefined) return a; }
  return lookupHost(sym);
}
