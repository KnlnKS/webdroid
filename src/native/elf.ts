// ELF shared-object loader: map PT_LOAD segments into guest memory, apply the relocation kinds
// Android's static linker emits, expose exports/init arrays/exidx.
//
// One loader, two header shapes. Everything that differs between ELF32/ARM and ELF64/AArch64 is
// a field offset or a stride, so it lives in the two descriptors below and the body reads
// through them. Values do not need width-aware reads: the guest address space is under 4 GiB by
// construction, and little-endian puts a 64-bit field's low word at its own address.

import { mem } from "./mem";
import { PAGE_SIZE } from "./abi";

export interface Module {
  name: string;
  base: number;
  end: number;
  /** an AArch64 image: its code needs the A64 emitter, and its ABI is LP64 */
  w64: boolean;
  exports: Map<string, number>;
  initArray: number[];
  init: number;
  needed: string[];
  exidx: { addr: number; count: number };
  symbols: { addr: Uint32Array; names: string[] };
  /** dlopen handle bookkeeping */
  refs: number;
  inited: boolean;
  /** the program headers, copied into guest memory for dl_iterate_phdr */
  phdr: number;
  phnum: number;
}

type Resolver = (sym: string, weak: boolean, from: Module) => number;

const PT_LOAD = 1, PT_DYNAMIC = 2, PT_ARM_EXIDX = 0x70000001;

interface Fmt {
  machine: number; ptr: number;
  phEnt: number; phOff: number; phVaddr: number; phFilesz: number; phMemsz: number;
  dynEnt: number;
  symEnt: number; symValue: number; symInfo: number; symShndx: number;
  relEnt: number; rela: boolean;
  RELATIVE: number; ABS: number; GLOB_DAT: number; JUMP_SLOT: number; REL32: number;
}
const ELF32: Fmt = {
  machine: 0x28, ptr: 4,
  phEnt: 32, phOff: 4, phVaddr: 8, phFilesz: 16, phMemsz: 20,
  dynEnt: 8,
  symEnt: 16, symValue: 4, symInfo: 12, symShndx: 14,
  relEnt: 8, rela: false,
  RELATIVE: 23, ABS: 2, GLOB_DAT: 21, JUMP_SLOT: 22, REL32: 3,
};
const ELF64: Fmt = {
  machine: 0xb7, ptr: 8,
  phEnt: 56, phOff: 8, phVaddr: 16, phFilesz: 32, phMemsz: 40,
  dynEnt: 16,
  symEnt: 24, symValue: 8, symInfo: 4, symShndx: 6,
  relEnt: 24, rela: true,
  // AArch64 emits exactly these four across every .so in the corpus; R_AARCH64_REL32 exists but
  // is not one of them, and -1 matches no type
  RELATIVE: 1027, ABS: 257, GLOB_DAT: 1025, JUMP_SLOT: 1026, REL32: -1,
};

// Relocations packed in a form we do not decode. Ignoring one of these tags is not a partial
// load, it is an image whose relocations were silently never applied, so it is named and refused.
const PACKED = new Map<number, string>([
  [35, "DT_RELRSZ"], [36, "DT_RELR"], [37, "DT_RELRENT"],
  [0x6000000f, "DT_ANDROID_REL"], [0x60000011, "DT_ANDROID_RELA"],
]);

/** how many symbols DT_GNU_HASH's tables describe. Modern arm64 images ship GNU hash alone, so
 *  DT_HASH's nchain is simply absent and there is no other way to size the symbol table. */
function gnuHashSymCount(p: number, ptr: number): number {
  const nbuckets = mem.u32[p >>> 2], symoffset = mem.u32[(p + 4) >>> 2], bloomSize = mem.u32[(p + 8) >>> 2];
  const buckets = p + 16 + bloomSize * ptr;
  let last = 0;
  for (let i = 0; i < nbuckets; i++) { const b = mem.u32[(buckets + i * 4) >>> 2]; if (b > last) last = b; }
  if (last < symoffset) return symoffset;
  // the hash chain runs to an entry with its low bit set
  const chain = buckets + nbuckets * 4;
  while (!(mem.u32[(chain + (last - symoffset) * 4) >>> 2] & 1)) last++;
  return last + 1;
}

export function loadElf(name: string, bytes: Uint8Array, resolve: Resolver): Module {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cls = bytes[4];
  if (dv.getUint32(0, true) !== 0x464c457f || (cls !== 1 && cls !== 2) || bytes[5] !== 1) throw new Error(`${name}: not a little-endian ELF image`);
  const f = cls === 2 ? ELF64 : ELF32;
  const machine = dv.getUint16(18, true);
  if (machine !== f.machine) throw new Error(`${name}: e_machine 0x${machine.toString(16)} is not ${cls === 2 ? "AArch64" : "ARM"}`);
  const phoff = dv.getUint32(cls === 2 ? 32 : 28, true);
  const phentsize = dv.getUint16(cls === 2 ? 54 : 42, true), phnum = dv.getUint16(cls === 2 ? 56 : 44, true);
  let lo = 0xffffffff, hi = 0, dynOff = 0, dynSz = 0, exidxAddr = 0, exidxSz = 0;
  const loads: { off: number; vaddr: number; filesz: number; memsz: number }[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * (phentsize || f.phEnt);
    const type = dv.getUint32(p, true), off = dv.getUint32(p + f.phOff, true), vaddr = dv.getUint32(p + f.phVaddr, true);
    const filesz = dv.getUint32(p + f.phFilesz, true), memsz = dv.getUint32(p + f.phMemsz, true);
    if (type === PT_LOAD) {
      loads.push({ off, vaddr, filesz, memsz });
      lo = Math.min(lo, vaddr & -PAGE_SIZE);
      hi = Math.max(hi, (vaddr + memsz + PAGE_SIZE - 1) & -PAGE_SIZE);
    } else if (type === PT_DYNAMIC) { dynOff = vaddr; dynSz = memsz; }
    // exidx is ARM's unwind table; AArch64 has no such segment and reuses the number
    else if (type === PT_ARM_EXIDX && cls === 1) { exidxAddr = vaddr; exidxSz = memsz; }
  }
  if (!loads.length) throw new Error(`${name}: no PT_LOAD`);
  const size = hi - lo;
  const base = mem.reserve(size) - lo;
  for (const l of loads) {
    mem.u8.set(bytes.subarray(l.off, l.off + l.filesz), base + l.vaddr);
    if (l.memsz > l.filesz) mem.u8.fill(0, base + l.vaddr + l.filesz, base + l.vaddr + l.memsz);
  }
  const phdr = mem.hostAlloc(phnum * f.phEnt, 8);
  mem.u8.set(bytes.subarray(phoff, phoff + phnum * f.phEnt), phdr);
  const mod: Module = {
    name, base, end: base + hi, w64: cls === 2, exports: new Map(), initArray: [], init: 0, needed: [],
    exidx: { addr: base + exidxAddr, count: exidxSz >> 3 }, symbols: { addr: new Uint32Array(0), names: [] },
    refs: 1, inited: false, phdr, phnum,
  };
  if (!dynOff) return mod;

  // .dynamic. REL and RELA never both appear: a file carries whichever its ABI defines, so one
  // pair of variables holds it either way.
  let strtab = 0, symtab = 0, hash = 0, gnuHash = 0, rel = 0, relsz = 0, jmprel = 0, pltrelsz = 0, initArr = 0, initArrSz = 0;
  const neededOffs: number[] = [];
  for (let p = base + dynOff; p < base + dynOff + dynSz; p += f.dynEnt) {
    const tag = mem.i32[p >>> 2], val = mem.u32[(p + f.ptr) >>> 2];
    if (tag === 0) break;
    const packed = PACKED.get(tag >>> 0);
    if (packed) throw new Error(`${name}: ${packed} relocations are not decoded`);
    switch (tag) {
      case 1: neededOffs.push(val); break;
      case 2: pltrelsz = val; break;
      case 4: hash = val; break;
      case 5: strtab = val; break;
      case 6: symtab = val; break;
      case 7: case 17: rel = val; break;
      case 8: case 18: relsz = val; break;
      case 12: mod.init = base + val; break;
      case 23: jmprel = val; break;
      case 25: initArr = val; break;
      case 27: initArrSz = val; break;
      case 0x6ffffef5: gnuHash = val; break;
    }
  }
  const str = (off: number) => mem.cstr(base + strtab + off);
  mod.needed = neededOffs.map(str);
  const nsyms = hash ? mem.u32[(base + hash + 4) >>> 2] : gnuHash ? gnuHashSymCount(base + gnuHash, f.ptr) : 0;
  const symAddr = new Uint32Array(nsyms), symName: string[] = new Array(nsyms);
  const symAddrs: number[] = [], symNames: string[] = [];
  for (let i = 0; i < nsyms; i++) {
    const s = base + symtab + i * f.symEnt;
    const nameOff = mem.u32[s >>> 2], value = mem.u32[(s + f.symValue) >>> 2];
    const info = mem.u8[s + f.symInfo], shndx = mem.u16[(s + f.symShndx) >>> 1];
    const bind = info >> 4, type = info & 15;
    if (shndx === 0) continue;
    const nm = str(nameOff);
    symName[i] = nm;
    symAddr[i] = base + value;
    if (bind === 1 || bind === 2) mod.exports.set(nm, base + value);
    // a Thumb function's st_value carries the interworking bit: keep it in exports (callers need
    // it), strip it for pc symbolisation. A64 has no such bit and the mask is a no-op there.
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
      const s = base + symtab + idx * f.symEnt;
      const nm = str(mem.u32[s >>> 2]);
      v = resolve(nm, (mem.u8[s + f.symInfo] >> 4) === 2, mod);
    }
    cache.set(idx, v);
    return v;
  };
  const apply = (tab: number, sz: number) => {
    for (let p = base + tab; p < base + tab + sz; p += f.relEnt) {
      const off = mem.u32[p >>> 2], info = mem.u32[(p + f.ptr) >>> 2];
      // RELA's r_info splits type/symbol across the two halves of a 64-bit word; REL's packs
      // them into one. RELA also carries the addend the linker left implicit in REL's slot.
      const type = f.rela ? info : info & 0xff;
      const sym = f.rela ? mem.u32[(p + f.ptr + 4) >>> 2] : info >>> 8;
      const addend = f.rela ? mem.i32[(p + f.ptr * 2) >>> 2] : 0;
      const at = (base + off) >>> 2;
      switch (type) {
        case f.RELATIVE: mem.u32[at] = (f.rela ? 0 : mem.u32[at]) + base + addend; break;
        case f.ABS: mem.u32[at] = (f.rela ? 0 : mem.u32[at]) + symValue(sym) + addend; break;
        case f.GLOB_DAT: case f.JUMP_SLOT: mem.u32[at] = symValue(sym) + addend; break;
        case f.REL32: mem.u32[at] = mem.u32[at] + symValue(sym) - (base + off); break;
        case 0: continue;
        default: throw new Error(`${name}: unsupported relocation type ${type} at 0x${off.toString(16)}`);
      }
      // the high half of a 64-bit slot: our address space is under 4 GiB, so it is always zero
      if (f.ptr === 8) mem.u32[at + 1] = 0;
    }
  };
  if (rel) apply(rel, relsz);
  if (jmprel) apply(jmprel, pltrelsz);
  for (let i = 0; i < initArrSz; i += f.ptr) mod.initArray.push(mem.u32[(base + initArr + i) >>> 2]);
  return mod;
}

/** the nearest symbol at or before `pc` in `m`, or null */
export function nearestSymbol(m: Module, pc: number): { name: string; addr: number } | null {
  const a = m.symbols.addr;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 ? { name: m.symbols.names[best], addr: a[best] } : null;
}
/** "libfoo.so!symbol+0x12" for a guest pc, or the raw hex when no module covers it */
export function symbolize(mods: Iterable<Module>, pc: number): string {
  for (const m of mods) {
    if (pc < m.base || pc >= m.end) continue;
    const off = pc - m.base, s = nearestSymbol(m, pc);
    if (s) return `${m.name}!${s.name}+0x${(pc - s.addr).toString(16)} (+0x${off.toString(16)})`;
    return `${m.name}+0x${off.toString(16)}`;
  }
  return "0x" + (pc >>> 0).toString(16);
}
