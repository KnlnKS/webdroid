// ELF32/ARM shared-object loader: map PT_LOAD segments into guest memory, apply the four
// relocation kinds Android's static linker emits, expose exports/init arrays/exidx.

import { mem } from "./mem";
import { PAGE_SIZE } from "./abi";

export interface Module {
  name: string;
  base: number;
  size: number;
  end: number;
  exports: Map<string, number>;
  initArray: number[];
  finiArray: number[];
  init: number;
  needed: string[];
  exidx: { addr: number; count: number };
  symbols: { addr: Uint32Array; names: string[] };
  textrel: boolean;
  /** dlopen handle bookkeeping */
  refs: number;
  inited: boolean;
}

export type Resolver = (sym: string, weak: boolean, from: Module) => number;

const PT_LOAD = 1, PT_DYNAMIC = 2, PT_ARM_EXIDX = 0x70000001;
const R_ARM_ABS32 = 2, R_ARM_REL32 = 3, R_ARM_GLOB_DAT = 21, R_ARM_JUMP_SLOT = 22, R_ARM_RELATIVE = 23;

export function loadElf(name: string, bytes: Uint8Array, resolve: Resolver): Module {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x464c457f || bytes[4] !== 1 || bytes[5] !== 1) throw new Error(`${name}: not an ELF32 LE image`);
  if (dv.getUint16(18, true) !== 0x28) throw new Error(`${name}: e_machine is not ARM`);
  const phoff = dv.getUint32(28, true), phentsize = dv.getUint16(42, true), phnum = dv.getUint16(44, true);
  let lo = 0xffffffff, hi = 0, dynOff = 0, dynSz = 0, exidxAddr = 0, exidxSz = 0;
  const loads: { off: number; vaddr: number; filesz: number; memsz: number }[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const type = dv.getUint32(p, true), off = dv.getUint32(p + 4, true), vaddr = dv.getUint32(p + 8, true);
    const filesz = dv.getUint32(p + 16, true), memsz = dv.getUint32(p + 20, true);
    if (type === PT_LOAD) {
      loads.push({ off, vaddr, filesz, memsz });
      lo = Math.min(lo, vaddr & -PAGE_SIZE);
      hi = Math.max(hi, (vaddr + memsz + PAGE_SIZE - 1) & -PAGE_SIZE);
    } else if (type === PT_DYNAMIC) { dynOff = vaddr; dynSz = memsz; }
    else if (type === PT_ARM_EXIDX) { exidxAddr = vaddr; exidxSz = memsz; }
  }
  if (!loads.length) throw new Error(`${name}: no PT_LOAD`);
  const size = hi - lo;
  const base = mem.reserve(size) - lo;
  for (const l of loads) {
    mem.u8.set(bytes.subarray(l.off, l.off + l.filesz), base + l.vaddr);
    if (l.memsz > l.filesz) mem.u8.fill(0, base + l.vaddr + l.filesz, base + l.vaddr + l.memsz);
  }
  const mod: Module = {
    name, base, size, end: base + hi, exports: new Map(), initArray: [], finiArray: [], init: 0, needed: [],
    exidx: { addr: base + exidxAddr, count: exidxSz >> 3 }, symbols: { addr: new Uint32Array(0), names: [] }, textrel: false,
    refs: 1, inited: false,
  };
  if (!dynOff) return mod;

  // .dynamic
  let strtab = 0, symtab = 0, hash = 0, rel = 0, relsz = 0, jmprel = 0, pltrelsz = 0, initArr = 0, initArrSz = 0, finiArr = 0, finiArrSz = 0;
  const neededOffs: number[] = [];
  for (let p = base + dynOff; p < base + dynOff + dynSz; p += 8) {
    const tag = mem.i32[p >>> 2], val = mem.u32[(p + 4) >>> 2];
    if (tag === 0) break;
    switch (tag) {
      case 1: neededOffs.push(val); break;
      case 2: pltrelsz = val; break;
      case 4: hash = val; break;
      case 5: strtab = val; break;
      case 6: symtab = val; break;
      case 12: mod.init = base + val; break;
      case 17: rel = val; break;
      case 18: relsz = val; break;
      case 22: mod.textrel = true; break;
      case 23: jmprel = val; break;
      case 25: initArr = val; break;
      case 27: initArrSz = val; break;
      case 26: finiArr = val; break;
      case 28: finiArrSz = val; break;
    }
  }
  const str = (off: number) => mem.cstr(base + strtab + off);
  mod.needed = neededOffs.map(str);
  const nsyms = hash ? mem.u32[(base + hash + 4) >>> 2] : 0;
  const symAddr = new Uint32Array(nsyms), symName: string[] = new Array(nsyms);
  const symAddrs: number[] = [], symNames: string[] = [];
  for (let i = 0; i < nsyms; i++) {
    const s = base + symtab + i * 16;
    const nameOff = mem.u32[s >>> 2], value = mem.u32[(s + 4) >>> 2], info = mem.u8[s + 12], shndx = mem.u16[(s + 14) >>> 1];
    const bind = info >> 4, type = info & 15;
    if (shndx === 0) continue;
    const nm = str(nameOff);
    symName[i] = nm;
    symAddr[i] = base + value;
    if (bind === 1 || bind === 2) mod.exports.set(nm, base + value);
    // a Thumb function's st_value carries the interworking bit: keep it in exports (callers need
    // it), strip it for pc symbolisation
    if (type === 2 || type === 0) { symAddrs.push((base + value) & ~1); symNames.push(nm); }
  }
  const order = symAddrs.map((_, i) => i).sort((a, b) => symAddrs[a] - symAddrs[b]);
  mod.symbols = { addr: Uint32Array.from(order.map((i) => symAddrs[i])), names: order.map((i) => symNames[i]) };

  // relocations: DT_SYMBOLIC modules bind to their own definitions first, which is what the
  // `shndx !== 0` check above already gives us for every module.
  const cache = new Map<number, number>();
  const symValue = (idx: number): number => {
    let v = cache.get(idx);
    if (v !== undefined) return v;
    if (symName[idx] !== undefined) v = symAddr[idx];
    else {
      const s = base + symtab + idx * 16;
      const nm = str(mem.u32[s >>> 2]);
      v = resolve(nm, (mem.u8[s + 12] >> 4) === 2, mod);
    }
    cache.set(idx, v);
    return v;
  };
  const apply = (tab: number, sz: number) => {
    for (let p = base + tab; p < base + tab + sz; p += 8) {
      const off = mem.u32[p >>> 2], info = mem.u32[(p + 4) >>> 2];
      const type = info & 0xff, sym = info >>> 8;
      const at = (base + off) >>> 2;
      switch (type) {
        case R_ARM_RELATIVE: mem.u32[at] = mem.u32[at] + base; break;
        case R_ARM_ABS32: mem.u32[at] = mem.u32[at] + symValue(sym); break;
        case R_ARM_GLOB_DAT: case R_ARM_JUMP_SLOT: mem.u32[at] = symValue(sym); break;
        case R_ARM_REL32: mem.u32[at] = mem.u32[at] + symValue(sym) - (base + off); break;
        case 0: break;
        default: throw new Error(`${name}: unsupported relocation type ${type} at 0x${off.toString(16)}`);
      }
    }
  };
  if (rel) apply(rel, relsz);
  if (jmprel) apply(jmprel, pltrelsz);
  for (let i = 0; i < initArrSz; i += 4) mod.initArray.push(mem.u32[(base + initArr + i) >>> 2]);
  for (let i = 0; i < finiArrSz; i += 4) mod.finiArray.push(mem.u32[(base + finiArr + i) >>> 2]);
  return mod;
}

/** "libfoo.so!symbol+0x12" for a guest pc, or the raw hex when no module covers it */
export function symbolize(mods: Iterable<Module>, pc: number): string {
  for (const m of mods) {
    if (pc < m.base || pc >= m.end) continue;
    const a = m.symbols.addr;
    let lo = 0, hi = a.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    // the nearest preceding symbol, skipping the zero-sized aliases that share an address
    const off = pc - m.base;
    if (best >= 0) return `${m.name}!${m.symbols.names[best]}+0x${(pc - a[best]).toString(16)} (+0x${off.toString(16)})`;
    return `${m.name}+0x${off.toString(16)}`;
  }
  return "0x" + (pc >>> 0).toString(16);
}
