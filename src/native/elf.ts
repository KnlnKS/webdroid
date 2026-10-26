// ELF shared-object loader: map PT_LOAD segments into guest memory, apply the relocation kinds
// Android's static linker emits, expose exports/init arrays/exidx.
//
// One loader, two header shapes. Everything that differs between ELF32/ARM and ELF64/AArch64 is
// a field offset or a stride, so it lives in the two descriptors below and the body reads
// through them. Values do not need width-aware reads: the guest address space is under 4 GiB by
// construction, and little-endian puts a 64-bit field's low word at its own address.

import { mem } from "./mem.ts";
import { PAGE_SIZE } from "./abi.ts";
import { utf8 } from "../jvm/abi.ts";

export interface Module {
  name: string;
  base: number;
  end: number;
  /** where the image's reservation starts (base plus its lowest PT_LOAD page) */
  start: number;
  /** an AArch64 image: its code needs the A64 emitter, and its ABI is LP64 */
  w64: boolean;
  exports: Map<string, number>;
  initArray: number[];
  init: number;
  /** DT_FINI_ARRAY and DT_FINI, which dlclose runs when it unloads the image */
  finiArray: number[];
  fini: number;
  /** DF_1_NODELETE, or dlopen's RTLD_NODELETE: the image stays once loaded */
  nodelete: boolean;
  needed: string[];
  exidx: { addr: number; count: number };
  symbols: { addr: Uint32Array; names: string[] };
  /** dlopen handle bookkeeping */
  refs: number;
  inited: boolean;
  /** the loaded program headers, for dl_iterate_phdr */
  phdr: number;
  phnum: number;
  tls: TlsSegment | null;
  /** the dynamic TLS module id the linker gave the image (DTPMOD), 0 without a TLS segment */
  tlsId: number;
  /** exported STT_TLS symbols: their offsets in the TLS segment */
  tlsExports: Map<string, number>;
  tlsDescriptors: { addr: number; offset: number }[];
  /** the TLS segment's offset from the thread pointer, when the linker placed it in static TLS */
  tpOffset: number | null;
  /** STT_GNU_IFUNC exports by name: their resolvers, run by the loader before relocation */
  ifuncs: Map<string, number>;
  /** .symtab's definitions that are not exports (hidden functions and objects), when not stripped */
  locals: Map<string, number>;
  /** where the image lives on the device, when it is not the app's own */
  path?: string;
}

/** PT_TLS as bionic's TlsSegment holds it: each thread's block starts as a copy of the loaded,
 *  relocated template at `init` (`.tdata` may hold pointers), zero-filled to `size` */
export interface TlsSegment { init: number; initSize: number; size: number; align: number }

type Resolver = (sym: string, weak: boolean, from: Module) => number;
/** a TLS symbol another image defines: that image's TLS module id and the symbol's offset in its block */
type TlsResolver = (sym: string) => { id: number; offset: number } | undefined;

const PT_LOAD = 1, PT_DYNAMIC = 2, PT_PHDR = 6, PT_TLS = 7, PT_ARM_EXIDX = 0x70000001;

interface Fmt {
  machine: number; ptr: 4 | 8;
  phEnt: number; phOff: number; phVaddr: number; phFilesz: number; phMemsz: number; phAlign: number;
  dynEnt: number;
  symEnt: number; symValue: number; symInfo: number; symShndx: number;
  relEnt: number; rela: boolean;
  RELATIVE: number; ABS: number; GLOB_DAT: number; JUMP_SLOT: number; REL32: number; TLSDESC: number; TPREL: number; DTPMOD: number; DTPOFF: number;
  shOff: number; shEntOff: number; shType: number; shOffset: number; shSize: number; shLink: number;
}
const ELF32: Fmt = {
  machine: 0x28, ptr: 4,
  phEnt: 32, phOff: 4, phVaddr: 8, phFilesz: 16, phMemsz: 20, phAlign: 28,
  dynEnt: 8,
  symEnt: 16, symValue: 4, symInfo: 12, symShndx: 14,
  relEnt: 8, rela: false,
  // ARM32 Android reaches dynamic TLS through __tls_get_addr (the general-dynamic model), never descriptors
  RELATIVE: 23, ABS: 2, GLOB_DAT: 21, JUMP_SLOT: 22, REL32: 3, TLSDESC: -1, TPREL: 19, DTPMOD: 17, DTPOFF: 18,
  shOff: 32, shEntOff: 46, shType: 4, shOffset: 16, shSize: 20, shLink: 24,
};
const ELF64: Fmt = {
  machine: 0xb7, ptr: 8,
  phEnt: 56, phOff: 8, phVaddr: 16, phFilesz: 32, phMemsz: 40, phAlign: 48,
  dynEnt: 16,
  symEnt: 24, symValue: 8, symInfo: 4, symShndx: 6,
  relEnt: 24, rela: true,
  // AArch64 emits exactly these four across every .so in the corpus; R_AARCH64_REL32 exists but
  // is not one of them, and -1 matches no type
  RELATIVE: 1027, ABS: 257, GLOB_DAT: 1025, JUMP_SLOT: 1026, REL32: -1, TLSDESC: 1031, TPREL: 1030, DTPMOD: -1, DTPOFF: -1,
  shOff: 40, shEntOff: 58, shType: 4, shOffset: 24, shSize: 32, shLink: 40,
};
const STT_TLS = 6, STT_GNU_IFUNC = 10;

type PackedRelocation = { off: number; info: bigint; addend: number };

/** Android APS2: SLEB128 values grouped by shared offset delta, symbol info and addend. */
export function decodeAndroidPacked(name: string, bytes: Uint8Array, rela: boolean, visit: (r: PackedRelocation) => void): void {
  if (bytes.length < 4 || bytes[0] !== 65 || bytes[1] !== 80 || bytes[2] !== 83 || bytes[3] !== 50)
    throw new Error(`${name}: invalid Android packed relocation header`);
  let at = 4;
  const pop = (): bigint => {
    let value = 0n, shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) throw new Error(`${name}: truncated Android packed relocations`);
      const b = bytes[at++];
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if (!(b & 0x80)) return b & 0x40 ? value | (-1n << shift) : value;
    }
    throw new Error(`${name}: invalid Android packed relocation integer`);
  };
  const num = (value: bigint, what: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new Error(`${name}: Android packed ${what} is out of range`);
    return n;
  };
  const count = num(pop(), "count");
  if (count < 0) throw new Error(`${name}: negative Android packed relocation count`);
  let off = num(pop(), "offset"), info = 0n, addend = 0, done = 0;
  while (done < count) {
    const size = num(pop(), "group size"), flags = num(pop(), "group flags");
    if (size <= 0 || size > count - done) throw new Error(`${name}: invalid Android packed relocation group size`);
    if (flags < 0 || flags & ~15) throw new Error(`${name}: invalid Android packed relocation group flags`);
    const offsetDelta = flags & 2 ? num(pop(), "offset delta") : 0;
    if (flags & 1) info = pop();
    if (flags & 8) {
      if (!rela) throw new Error(`${name}: addend in Android packed REL relocations`);
      if (flags & 4) addend += num(pop(), "addend");
    } else addend = 0;
    for (let i = 0; i < size; i++) {
      off += flags & 2 ? offsetDelta : num(pop(), "offset delta");
      if (!(flags & 1)) info = pop();
      if (flags & 8 && !(flags & 4)) addend += num(pop(), "addend");
      visit({ off, info, addend });
      done++;
    }
  }
}

/** RELR's pointer-aligned offsets, read as 32-bit words: a 64-bit entry's high word holds bitmap bits 32 to 63 */
export function decodeRelr(name: string, bytes: Uint8Array, ptr: 4 | 8, visit: (off: number) => void): void {
  if (bytes.length % ptr) throw new Error(`${name}: invalid RELR size`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let next = -1;
  for (let at = 0; at < bytes.length; at += ptr) {
    const lo = dv.getUint32(at, true), hi = ptr === 8 ? dv.getUint32(at + 4, true) : 0;
    if (!(lo & 1)) {
      if (hi >= 0x200000) throw new Error(`${name}: RELR offset is out of range`);
      if (lo & (ptr - 1)) throw new Error(`${name}: RELR offset is misaligned`);
      const off = hi * 2 ** 32 + lo;
      visit(off);
      next = off + ptr;
      continue;
    }
    if (next < 0) throw new Error(`${name}: RELR bitmap precedes an address`);
    for (let word = lo >>> 1, i = 0; word; word >>>= 1, i++) if (word & 1) visit(next + i * ptr);
    for (let word = hi, i = 31; word; word >>>= 1, i++) if (word & 1) visit(next + i * ptr);
    next += (ptr * 8 - 1) * ptr;
  }
}

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

/** Map and parse an image without binding its imports: DT_NEEDED modules must be loaded
 *  before `relocate` sees them, and every unresolved slot stays a stub for good. */
export function mapElf(name: string, bytes: Uint8Array): { mod: Module; relocate: (resolve: Resolver, resolveTls: TlsResolver) => void } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cls = bytes[4];
  if (dv.getUint32(0, true) !== 0x464c457f || (cls !== 1 && cls !== 2) || bytes[5] !== 1) throw new Error(`${name}: not a little-endian ELF image`);
  const f = cls === 2 ? ELF64 : ELF32;
  const machine = dv.getUint16(18, true);
  if (machine !== f.machine) throw new Error(`${name}: e_machine 0x${machine.toString(16)} is not ${cls === 2 ? "AArch64" : "ARM"}`);
  const phoff = dv.getUint32(cls === 2 ? 32 : 28, true);
  const phentsize = dv.getUint16(cls === 2 ? 54 : 42, true), phnum = dv.getUint16(cls === 2 ? 56 : 44, true);
  let lo = 0xffffffff, hi = 0, dynOff = 0, dynSz = 0, exidxAddr = 0, exidxSz = 0, phdrAddr = -1;
  let tls: Module["tls"] = null;
  const loads: { off: number; vaddr: number; filesz: number; memsz: number }[] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * (phentsize || f.phEnt);
    const type = dv.getUint32(p, true), off = dv.getUint32(p + f.phOff, true), vaddr = dv.getUint32(p + f.phVaddr, true);
    const filesz = dv.getUint32(p + f.phFilesz, true), memsz = dv.getUint32(p + f.phMemsz, true);
    if (type === PT_LOAD) {
      loads.push({ off, vaddr, filesz, memsz });
      lo = Math.min(lo, (vaddr & -PAGE_SIZE) >>> 0);
      hi = Math.max(hi, ((vaddr + memsz + PAGE_SIZE - 1) & -PAGE_SIZE) >>> 0);
    } else if (type === PT_DYNAMIC) { dynOff = vaddr; dynSz = memsz; }
    else if (type === PT_PHDR) phdrAddr = vaddr;
    else if (type === PT_TLS) {
      const align = dv.getUint32(p + f.phAlign, true);
      if (filesz > memsz || off + filesz > bytes.length || align && (align & (align - 1))) throw new Error(`${name}: invalid PT_TLS`);
      tls = { init: vaddr, initSize: filesz, size: memsz, align: align || 1 };
    }
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
  // bionic's ElfReader::FindPhdr: PT_PHDR, else the headers in a first segment that maps the file's start
  const tableSize = phnum * (phentsize || f.phEnt), first = loads[0];
  if (phdrAddr < 0 && first.off === 0 && phoff + tableSize <= first.filesz) phdrAddr = first.vaddr + phoff;
  if (phdrAddr < 0 || !loads.some((l) => phdrAddr >= l.vaddr && phdrAddr + tableSize <= l.vaddr + l.filesz)) throw new Error(`${name}: can't find loaded phdr`);
  const phdr = base + phdrAddr;
  if (tls) tls.init += base;
  const mod: Module = {
    name, base, end: base + hi, start: base + lo, w64: cls === 2, exports: new Map(), initArray: [], init: 0, finiArray: [], fini: 0, nodelete: false, needed: [],
    exidx: { addr: base + exidxAddr, count: exidxSz >> 3 }, symbols: { addr: new Uint32Array(0), names: [] },
    refs: 1, inited: false, phdr, phnum, tls, tlsId: 0, tlsExports: new Map(), tlsDescriptors: [], tpOffset: null, ifuncs: new Map(), locals: new Map(),
  };
  if (!dynOff) return { mod, relocate: () => {} };

  // .dynamic. REL and RELA never both appear: a file carries whichever its ABI defines, so one
  // pair of variables holds it either way.
  let strtab = 0, symtab = 0, hash = 0, gnuHash = 0, rel = 0, relsz = 0, androidRel = 0, androidRelSz = 0;
  let relr = 0, relrSz = 0, relrEnt = 0;
  let androidRela: boolean | null = null, jmprel = 0, pltrelsz = 0, initArr = 0, initArrSz = 0, finiArr = 0, finiArrSz = 0;
  const neededOffs: number[] = [];
  for (let p = base + dynOff; p < base + dynOff + dynSz; p += f.dynEnt) {
    const tag = mem.i32[p >>> 2], val = mem.u32[(p + f.ptr) >>> 2];
    if (tag === 0) break;
    switch (tag) {
      case 1: neededOffs.push(val); break;
      case 2: pltrelsz = val; break;
      case 4: hash = val; break;
      case 5: strtab = val; break;
      case 6: symtab = val; break;
      case 7: case 17: rel = val; break;
      case 8: case 18: relsz = val; break;
      case 0x6000000f: androidRel = val; androidRela = false; break;
      case 0x60000010: androidRelSz = val; break;
      case 0x60000011: androidRel = val; androidRela = true; break;
      case 0x60000012: androidRelSz = val; break;
      case 12: mod.init = base + val; break;
      case 13: mod.fini = base + val; break;
      case 26: finiArr = val; break;
      case 28: finiArrSz = val; break;
      case 0x6ffffffb: mod.nodelete = !!(val & 8); break;
      case 23: jmprel = val; break;
      case 25: initArr = val; break;
      case 27: initArrSz = val; break;
      case 35: case 0x6fffe001: relrSz = val; break;
      case 36: case 0x6fffe000: relr = val; break;
      case 37: case 0x6fffe003: relrEnt = val; break;
      case 0x6ffffef5: gnuHash = val; break;
    }
  }
  const str = (off: number) => mem.cstr(base + strtab + off);
  mod.needed = neededOffs.map(str);
  const nsyms = hash ? mem.u32[(base + hash + 4) >>> 2] : gnuHash ? gnuHashSymCount(base + gnuHash, f.ptr) : 0;
  const symAddr = new Uint32Array(nsyms), symName: string[] = new Array(nsyms), tlsSyms = new Map<number, number>();
  const symAddrs: number[] = [], symNames: string[] = [];
  for (let i = 0; i < nsyms; i++) {
    const s = base + symtab + i * f.symEnt;
    const nameOff = mem.u32[s >>> 2], value = mem.u32[(s + f.symValue) >>> 2];
    const info = mem.u8[s + f.symInfo], shndx = mem.u16[(s + f.symShndx) >>> 1];
    const bind = info >> 4, type = info & 15;
    if (shndx === 0) continue;
    const nm = str(nameOff);
    // an IFUNC's value is its resolver: references bind through the scope, to what it resolves to
    if (type === STT_GNU_IFUNC) { mod.ifuncs.set(nm, base + value); continue; }
    // a TLS symbol's value is its offset in the image's TLS block, which each thread has its own of
    if (type === STT_TLS) { tlsSyms.set(i, value); if (bind === 1 || bind === 2) mod.tlsExports.set(nm, value); continue; }
    symName[i] = nm;
    symAddr[i] = base + value;
    if (bind === 1 || bind === 2) mod.exports.set(nm, base + value);
    // a Thumb function's st_value carries the interworking bit: keep it in exports (callers need
    // it), strip it for pc symbolisation. A64 has no such bit and the mask is a no-op there.
    if (type === 2 || type === 0) { symAddrs.push(((base + value) & ~1) >>> 0); symNames.push(nm); }
  }
  readSymtab(bytes, dv, f, base, mod, symAddrs, symNames);
  const order = symAddrs.map((_, i) => i).sort((a, b) => symAddrs[a] - symAddrs[b]);
  mod.symbols = { addr: Uint32Array.from(order.map((i) => symAddrs[i])), names: order.map((i) => symNames[i]) };

  // relocations: DT_SYMBOLIC modules bind to their own definitions first, which is what the
  // `shndx !== 0` check above already gives us for every module.
  const relocate = (resolve: Resolver, resolveTls: TlsResolver) => {
  const cache = new Map<number, number>();
  /** the TLS module and offset symbol `idx` names: the image's own block for none */
  const tlsOf = (idx: number): { id: number; offset: number } => {
    const own = idx ? tlsSyms.get(idx) : 0;
    if (own !== undefined) {
      if (!mod.tlsId) throw new Error(`${name}: TLS relocation without a TLS segment`);
      return { id: mod.tlsId, offset: own };
    }
    const sym = str(mem.u32[(base + symtab + idx * f.symEnt) >>> 2]), found = resolveTls(sym);
    if (!found) throw new Error(`${name}: undefined TLS symbol ${sym}`);
    return found;
  };
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
  const applyOne = (off: number, type: number, sym: number, addend: number) => {
    const at = (base + off) >>> 2;
    let value: number;
    switch (type) {
      case f.RELATIVE: value = (f.rela ? 0 : mem.u32[at]) + base + addend; break;
      case f.ABS: value = (f.rela ? 0 : mem.u32[at]) + symValue(sym) + addend; break;
      case f.GLOB_DAT: case f.JUMP_SLOT: value = symValue(sym) + addend; break;
      case f.REL32: value = mem.u32[at] + symValue(sym) - (base + off); break;
      case f.TLSDESC:
        if (!mod.tls || sym) throw new Error(`${name}: unsupported TLS descriptor symbol ${sym}`);
        if (addend < 0 || addend >= mod.tls.size) throw new Error(`${name}: TLS descriptor offset is out of range`);
        mod.tlsDescriptors.push({ addr: base + off, offset: addend });
        return;
      case f.TPREL:
        if (mod.tpOffset === null || sym) throw new Error(`${name}: initial-exec TLS outside static TLS`);
        value = mod.tpOffset + addend; break;
      case f.DTPMOD: value = tlsOf(sym).id; break;
      case f.DTPOFF: value = (f.rela ? 0 : mem.u32[at]) + (sym ? tlsOf(sym).offset : 0) + addend; break;
      case 0: return;
      default: throw new Error(`${name}: unsupported relocation type ${type} at 0x${off.toString(16)}`);
    }
    mem.u32[at] = value >>> 0;
    // The high half of a 64-bit slot carries the sum's overflow rather than a flat zero: an
    // image that stores base + A with A past its own end, and comes back inside by adding a
    // negative 64-bit offset in a register, relies on that carry (libmetasec's pointer
    // obfuscation). Nothing dereferences the intermediate, so no plane is ever named by it.
    if (f.ptr === 8) mem.u32[at + 1] = Math.floor(value / 4294967296) | 0;
  };
  const apply = (tab: number, sz: number) => {
    for (let p = base + tab; p < base + tab + sz; p += f.relEnt) {
      const off = mem.u32[p >>> 2], info = mem.u32[(p + f.ptr) >>> 2];
      // RELA's r_info splits type/symbol across the two halves of a 64-bit word; REL's packs
      // them into one. RELA also carries the addend the linker left implicit in REL's slot.
      const type = f.rela ? info : info & 0xff;
      const sym = f.rela ? mem.u32[(p + f.ptr + 4) >>> 2] : info >>> 8;
      // an LP64 addend is 64-bit; the sum is kept as a double (exact below 2^53) so a slot can
      // hold what the linker meant even when that is outside the 4 GiB of address space here
      const addend = !f.rela ? 0 : f.ptr === 8 ? mem.i32[(p + f.ptr * 2 + 4) >>> 2] * 4294967296 + mem.u32[(p + f.ptr * 2) >>> 2] : mem.i32[(p + f.ptr * 2) >>> 2];
      applyOne(off, type, sym, addend);
    }
  };
  if (!!androidRel !== !!androidRelSz || androidRela !== null && androidRela !== f.rela)
    throw new Error(`${name}: invalid Android packed relocation tags`);
  if (androidRel) {
    if (androidRel + androidRelSz > hi) throw new Error(`${name}: Android packed relocations are out of bounds`);
    decodeAndroidPacked(name, mem.u8.subarray(base + androidRel, base + androidRel + androidRelSz), f.rela, ({ off, info, addend }) => {
      const low = Number(info & 0xffffffffn) >>> 0;
      applyOne(off, f.rela ? low : low & 0xff, f.rela ? Number(info >> 32n) : low >>> 8, addend);
    });
  }
  if (!!relr !== !!relrSz || relrEnt && relrEnt !== f.ptr) throw new Error(`${name}: invalid RELR tags`);
  if (relr) {
    if (relr + relrSz > hi) throw new Error(`${name}: RELR table is out of bounds`);
    decodeRelr(name, mem.u8.subarray(base + relr, base + relr + relrSz), f.ptr, (off) => {
      if (off < lo || off + f.ptr > hi) throw new Error(`${name}: RELR target is out of bounds`);
      const at = (base + off) >>> 2, sum = mem.u32[at] + base;
      mem.u32[at] = sum;
      if (f.ptr === 8 && sum > 0xffffffff) mem.u32[at + 1]++;
    });
  }
  if (rel) apply(rel, relsz);
  if (jmprel) apply(jmprel, pltrelsz);
  for (let i = 0; i < initArrSz; i += f.ptr) mod.initArray.push(mem.u32[(base + initArr + i) >>> 2]);
  for (let i = 0; i < finiArrSz; i += f.ptr) mod.finiArray.push(mem.u32[(base + finiArr + i) >>> 2]);
  };
  return { mod, relocate };
}

/** .symtab, which an unstripped image keeps beside .dynsym: its other functions and objects
 *  become locals (what a linker may call by name) and symbolize pcs */
function readSymtab(bytes: Uint8Array, dv: DataView, f: Fmt, base: number, mod: Module, addrs: number[], names: string[]): void {
  const shoff = dv.getUint32(f.shOff, true), shentsize = dv.getUint16(f.shEntOff, true), shnum = dv.getUint16(f.shEntOff + 2, true);
  if (!shoff || shoff + shnum * shentsize > bytes.length) return;
  const sh = (i: number, at: number) => dv.getUint32(shoff + i * shentsize + at, true);
  for (let i = 0; i < shnum; i++) {
    if (sh(i, f.shType) !== 2) continue;                                     // SHT_SYMTAB
    const off = sh(i, f.shOffset), size = sh(i, f.shSize), strOff = sh(sh(i, f.shLink), f.shOffset);
    if (off + size > bytes.length) return;
    for (let s = off; s < off + size; s += f.symEnt) {
      const type = bytes[s + f.symInfo] & 15, value = dv.getUint32(s + f.symValue, true);
      if ((type !== 1 && type !== 2) || !dv.getUint16(s + f.symShndx, true)) continue;
      const at = strOff + dv.getUint32(s, true), nm = utf8.dec.decode(bytes.subarray(at, bytes.indexOf(0, at)));
      if (!nm || mod.exports.has(nm)) continue;
      mod.locals.set(nm, base + value);
      if (type === 2) { addrs.push(base + value); names.push(nm); }
    }
    return;
  }
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
