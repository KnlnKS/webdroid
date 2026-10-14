// The frame the kernel's setup_rt_frame builds for a signal handler, per ABI: siginfo_t, then a
// ucontext_t with the alternate stack, the interrupted registers, the mask to restore and the
// FP/SIMD state (arm64's fpsimd_context in __reserved, ARM32's vfp_sigframe in uc_regspace), all of
// which the handler may rewrite before rt_sigreturn loads them back.

import { mem } from "./mem";
import { PTR, ldWord } from "./host";
import type { Cpu } from "./cpu";
import { BLOCKABLE } from "./signals";

/** siginfo's si_code and si_addr, for a signal an instruction raised */
export type SigInfo = { code: number; addr: bigint };
export const SIGINFO_SIZE = 0x80;
const SI_TKILL = -6, FPSIMD_MAGIC = 0x46508001, VFP_MAGIC = 0x56465001;

/** siginfo_t: si_signo, si_code and a fault's si_addr */
export function writeSiginfo(p: number, sig: number, code: number, addr: bigint | null = null): void {
  mem.memset(p, 0, SIGINFO_SIZE);
  mem.st32(p, sig);
  mem.st32(p + 8, code);
  if (addr !== null) { if (PTR === 8) mem.st64(p + 16, addr); else mem.st32(p + 12, Number(addr & 0xffffffffn)); }
}
export const readSiginfo = (p: number): SigInfo => ({ code: mem.ld32(p + 8), addr: ldWord(p + (PTR === 8 ? 16 : 12)) });

/** an ABI's frame: its size, and its ucontext's writing and loading */
interface FrameLayout { size: number; write(cpu: Cpu, context: number, info: SigInfo | null, mask: bigint): void; load(cpu: Cpu, context: number): void }
const A64: FrameLayout = {
  size: 0x1300,
  // uc_stack, uc_sigmask, then sigcontext: fault_address, x0-x30, sp, pc, pstate, then __reserved's fpsimd_context
  write(cpu, context, info, mask) {
    const alt = cpu.alternateStack;
    if (alt) { mem.st64(context + 0x10, alt.sp); mem.st32(context + 0x18, alt.flags); mem.st64(context + 0x20, alt.size); }
    mem.st64(context + 0x28, mask);
    if (info) mem.st64(context + 0xb0, info.addr);
    new Uint32Array(mem.buf, context + 0xb8, 64).set(new Uint32Array(cpu.w.buffer, cpu.w.byteOffset, 64));
    mem.st64(context + 0x1b8, BigInt(cpu.pc));
    mem.st64(context + 0x1c0, BigInt(cpu.cpsr >>> 0));
    mem.st32(context + 0x1d0, FPSIMD_MAGIC); mem.st32(context + 0x1d4, 0x210);
    mem.st32(context + 0x1d8, cpu.fpsr); mem.st32(context + 0x1dc, cpu.fpcr);
    mem.u8.set(cpu.vb, context + 0x1e0);
  },
  load(cpu, context) {
    cpu.signalMask = mem.ld64(context + 0x28) & BLOCKABLE;
    new Uint32Array(cpu.w.buffer, cpu.w.byteOffset, 64).set(new Uint32Array(mem.buf, context + 0xb8, 64));
    cpu.setPc(Number(mem.ld64(context + 0x1b8) & 0xffffffffn));
    cpu.cpsr = mem.ld32(context + 0x1c0);
    if (mem.ld32(context + 0x1d0) === FPSIMD_MAGIC) {
      cpu.fpsr = mem.ld32(context + 0x1d8); cpu.fpcr = mem.ld32(context + 0x1dc);
      cpu.vb.set(mem.u8.subarray(context + 0x1e0, context + 0x3e0));
    }
  },
};
const A32: FrameLayout = {
  size: 0x380,
  // uc_stack, then sigcontext at 20: trap_no, error_code, oldmask, r0-r15, cpsr, fault_address; the mask at 104
  write(cpu, context, info, mask) {
    const alt = cpu.alternateStack;
    if (alt) { mem.st32(context + 8, Number(alt.sp)); mem.st32(context + 12, alt.flags); mem.st32(context + 16, Number(alt.size)); }
    mem.st32(context + 28, Number(mask & 0xffffffffn));
    for (let i = 0; i < 15; i++) mem.st32(context + 32 + 4 * i, cpu.w[2 * i]);
    mem.st32(context + 92, cpu.pc);
    mem.st32(context + 96, cpu.cpsr);
    if (info) mem.st32(context + 100, Number(info.addr & 0xffffffffn));
    mem.st64(context + 104, mask);
    // uc_regspace: vfp_sigframe's d0-d31 and fpscr
    mem.st32(context + 232, VFP_MAGIC); mem.st32(context + 236, 0x120);
    mem.u8.set(cpu.vb.subarray(0, 256), context + 240);
    mem.st32(context + 496, cpu.fpcr);
  },
  load(cpu, context) {
    cpu.signalMask = mem.ld64(context + 104) & BLOCKABLE;
    for (let i = 0; i < 15; i++) cpu.w[2 * i] = mem.ld32(context + 32 + 4 * i);
    cpu.cpsr = mem.ld32(context + 96);
    cpu.setPc((mem.ld32(context + 92) & ~1) | cpu.t);
    if (mem.ld32(context + 232) === VFP_MAGIC) {
      cpu.vb.set(mem.u8.subarray(context + 240, context + 496));
      cpu.fpcr = mem.ld32(context + 496);
    }
  },
};
export const frameSize = (cpu: Cpu): number => (cpu.a64 ? A64 : A32).size;
/** the siginfo and ucontext a handler of `sig` receives at `frame`: the interrupted state and `mask` */
export function writeFrame(cpu: Cpu, frame: number, sig: number, info: SigInfo | null, mask: bigint): number {
  const layout = cpu.a64 ? A64 : A32;
  mem.memset(frame, 0, layout.size);
  writeSiginfo(frame, sig, info ? info.code : SI_TKILL, info ? info.addr : null);
  layout.write(cpu, frame + SIGINFO_SIZE, info, mask);
  return frame + SIGINFO_SIZE;
}
/** rt_sigreturn: the state the handler left in its ucontext */
export const loadContext = (cpu: Cpu, context: number): void => (cpu.a64 ? A64 : A32).load(cpu, context);
