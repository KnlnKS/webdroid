import { beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { Cpu, setA64 } from "./cpu";
import { core, jitStats, JIT_HEAT } from "./core";
import { finish, pattern, sweep } from "./a64.testkit";
import { mainThread } from "../jvm/natives/jentry";
import { RET_SENTINEL } from "./abi";

let shared: Cpu | null = null;
function execute(at: number, setup: (c: Cpu) => void): Cpu {
  const c = (shared ??= new Cpu(mainThread, "test"));
  c.w.fill(0); c.si.fill(0); c.cpsr = 0; c.fpcr = 0; c.fpsr = 0; c.excl = 0;
  c.ensureStack();
  c.w[26] = c.stackTop;
  setup(c);
  c.w[28] = RET_SENTINEL;
  c.setPc(at);
  finish(c, 1000);
  return c;
}
function run(words: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  // ask for the page the way a module load does, rather than picking an address that the stack
  // allocator can march into
  const at = mem.reserve((words.length * 4 + 0xfff) & ~0xfff, 0x1000);
  for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
  return sweep(execute, at, setup);
}
function runThumb(half: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  const at = mem.reserve((half.length * 2 + 0xfff) & ~0xfff, 0x1000);
  for (let i = 0; i < half.length; i++) mem.u16[(at >>> 1) + i] = half[i];
  return sweep((pc, s) => execute(pc | 1, s), at, setup);
}
const BXLR = 0xe12fff1e;
/** the same program as ARM, then as Thumb: each runs when the loop reaches it */
function* both(arm: number[], thumb: number[], setup?: (c: Cpu) => void): Generator<Cpu> { yield run(arm, setup); yield runThumb(thumb, setup); }

beforeAll(() => setA64(false));

describe("arm decoder", () => {
  test("instruction synchronization preserves writeback, flags and Thumb IT state", () => {
    const data = mem.reserve(0x1000, 0x1000);
    const setup = (cpu: Cpu) => {
      cpu.w[0] = -1; cpu.w[2] = data; cpu.w[4] = 0x12345678;
      cpu.si.fill(0x33445566); cpu.fpcr = 0x400000; cpu.fpsr = 0x8000010;
    };
    const arm = run([
      0xe2900001, // adds r0, r0, #1
      0xe4812004, // str r2, [r1], #4
      0xf57ff06f, // isb
      0xe2a03000, // adc r3, r0, #0
      BXLR,
    ], setup);
    expect([arm.w[0], arm.w[2], arm.w[6], mem.ld32(data)]).toEqual([0, data + 4, 1, 0x12345678]);
    const thumb = runThumb([
      0x3001, 0xbf08, // adds r0, #1; it eq
      0xf841, 0x2b04, // streq.w r2, [r1], #4
      0xf3bf, 0x8f6f, // isb
      0xbf28, 0x2307, // it cs; movcs r3, #7
      0x4770,
    ], setup);
    expect([thumb.w[0], thumb.w[2], thumb.w[6], mem.ld32(data)]).toEqual([0, data + 4, 7, 0x12345678]);
    expect(thumb.cpsr & 0x0600fc00).toBe(0);
  });

  test("BLX reads its LR target before replacing the return address", () => {
    const c = run([
      0xe1a0400e, 0xe28fe00c, 0xe12fff3e, 0xe2800001,
      0xe12fff14, 0xe1a00000, 0xe280000a, BXLR,
    ], cpu => { cpu.w[0] = 5; });
    expect(c.w[0]).toBe(16);
    const thumb = runThumb([0xb510, 0xf20f, 0x010d, 0x468e, 0x47f0, 0x3001, 0xbd10, 0xbf00, 0x300a, 0x4770], cpu => { cpu.w[0] = 5; });
    expect(thumb.w[0]).toBe(16);
  });

  test("Thumb BL and BLX preserve state across Thumb and ARM callees", () => {
    const c = runThumb([
      0xb510, 0x4604, // push {r4, lr}; mov r4, r0
      0xf000, 0xf804, // bl Thumb callee
      0xf000, 0xe804, // blx ARM callee
      0x4420, 0xbd10, // add r0, r4; pop {r4, pc}
      0x3005, 0x4770, // adds r0, #5; bx lr
      0x0007, 0xe280, 0xff1e, 0xe12f, // ARM: add r0, #7; bx lr
    ], (cpu) => {
      for (let i = 0; i < 13; i++) cpu.w[2 * i] = 0x11220000 + i;
      for (let i = 0; i < cpu.si.length; i++) cpu.si[i] = 0x33440000 + i;
      cpu.fpcr = 0x400000; cpu.fpsr = 0x8000010; cpu.excl = 0x2000;
    });
    expect(c.w[0]).toBe(0x2244000c);
    expect(c.w[8]).toBe(0x11220004);
  });

  test("far Thumb branches take precedence over overlapping data prefixes", () => {
    const at = mem.reserve(0x400000, 0x1000), pc = at + 2;
    for (const h of [0xf3c0, 0xf240, 0xf2c0, 0xf200, 0xf2a0]) {
      for (const h2 of [0xf800, 0xe800, 0xb800]) {
        const target = (pc + 4 + ((h & 0x3ff) << 12)) & (h2 === 0xe800 ? ~3 : ~1);
        mem.st16(pc, h); mem.st16(pc + 2, h2);
        if (h2 === 0xe800) mem.st32(target, 0xe12fff1c);
        else mem.st16(target, 0x4760);
        const c = sweep((entry, setup) => execute(entry | 1, setup), pc, (cpu) => {
          for (let i = 0; i < 13; i++) cpu.w[2 * i] = 0x11220000 + i;
          for (let i = 0; i < cpu.si.length; i++) cpu.si[i] = 0x33440000 + i;
          cpu.w[24] = RET_SENTINEL;
          cpu.cpsr = 0x28000000; cpu.fpcr = 0x400000; cpu.fpsr = 0x8000010; cpu.excl = 0x2000;
        });
        expect(c.w[28] >>> 0).toBe(h2 === 0xb800 ? RET_SENTINEL : pc + 5);
      }
    }
  });

  test("DSP halfword multiplication and saturating arithmetic preserve architectural state", () => {
    const c = run([0xe1053281, 0xe1476281, 0xe1680281, 0xe10b905a, BXLR], (cpu) => {
      for (let i = 0; i < 13; i++) cpu.w[2 * i] = 0x11220000 + i;
      cpu.w[2] = 3; cpu.w[4] = 4; cpu.w[6] = 9;
      cpu.w[12] = -8; cpu.w[14] = 5; cpu.w[20] = 0x7fffffff; cpu.w[22] = 1;
      cpu.cpsr = 0x20000000;
    });
    expect([c.w[10], c.w[12], c.w[14], c.w[16], c.w[18]]).toEqual([21, 4, 6, 12, 0x7fffffff]);
    expect(c.cpsr & 0x28000000).toBe(0x28000000);
  });

  test("mov/add/sub immediates and flags", () => {
    const c = run([
      0xe3a00005,   // mov r0, #5
      0xe2801003,   // add r1, r0, #3
      0xe0512000,   // subs r2, r1, r0    -> 3, flags NZCV = 0 0 1 0
      0xe2503008,   // subs r3, r0, #8    -> -3, N=1, C=0
      BXLR]);
    expect(c.w[2]).toBe(8);
    expect(c.w[4]).toBe(3);
    expect(c.w[6]).toBe(-3);
    expect(c.n).toBe(1); expect(c.c).toBe(0); expect(c.z).toBe(0); expect(c.v).toBe(0);
  });
  test("adds carry and overflow", () => {
    const c = run([
      0xe3e00000,   // mvn r0, #0        -> 0xffffffff
      0xe2901001,   // adds r1, r0, #1   -> 0, Z=1 C=1 V=0
      BXLR]);
    expect(c.w[2]).toBe(0); expect(c.z).toBe(1); expect(c.c).toBe(1); expect(c.v).toBe(0);
    const d = run([
      0xe3a00102,   // mov r0, #0x80000000
      0xe2501001,   // subs r1, r0, #1   -> 0x7fffffff, V=1, C=1
      BXLR]);
    expect(d.w[2]).toBe(0x7fffffff); expect(d.v).toBe(1); expect(d.c).toBe(1);
  });
  test("shifts with carry out (movs lsr/lsl/asr/ror)", () => {
    const c = run([
      0xe3a00003,   // mov r0, #3
      0xe1b010a0,   // movs r1, r0, lsr #1  -> 1, C=1
      0xe1b02f80,   // movs r2, r0, lsl #31 -> 0x80000000, C=1
      0xe1b03fc2,   // movs r3, r2, asr #31 -> -1, C=1
      0xe1b04060,   // movs r4, r0, rrx     -> (3>>>1)|(C<<31) = 1 (asr #31 carried out bit 30 = 0), C=1
      BXLR]);
    expect(c.w[2]).toBe(1); expect(c.w[4]).toBe(-2147483648); expect(c.w[6]).toBe(-1); expect(c.w[8]).toBe(1); expect(c.c).toBe(1);
  });
  test("register shift by register", () => {
    const c = run([
      0xe3a00001,   // mov r0, #1
      0xe3a01020,   // mov r1, #32
      0xe1a02110,   // mov r2, r0, lsl r1  -> 0
      0xe3a01004,   // mov r1, #4
      0xe0806110,   // add r6, r0, r0, lsl r1 -> 17 (Rn and the shift amount need separate temporaries)
      0xe1a03110,   // mov r3, r0, lsl r1  -> 16
      BXLR]);
    expect(c.w[4]).toBe(0); expect(c.w[6]).toBe(16); expect(c.w[12]).toBe(17);
  });
  test("ldr/str addressing modes", () => {
    const c = run([
      0xe3a02c01,   // mov r2, #256
      0xe58d2000,   // str r2, [sp]
      0xe58d2004,   // str r2, [sp, #4]
      0xe1a0400d,   // mov r4, sp        -> the sp BEFORE either writeback
      0xe59d0004,   // ldr r0, [sp, #4]
      0xe49d1004,   // ldr r1, [sp], #4   (post-index)  -> sp += 4
      0xe5bd3004,   // ldr r3, [sp, #4]!  (pre-index)   -> sp += 4, then load
      BXLR], (c) => { c.w[26] -= 64; });
    expect(c.w[0]).toBe(256); expect(c.w[2]).toBe(256);
    expect(c.w[26] - c.w[8]).toBe(8);
  });
  test("ldrb/strb/ldrh/strh/ldrsb/ldrsh", () => {
    const c = run([
      0xe3a00cff,   // mov r0, #0xff00
      0xe2800081,   // add r0, r0, #0x81   -> 0xff81
      0xe1cd00b0,   // strh r0, [sp]
      0xe1dd10b0,   // ldrh r1, [sp]       -> 0xff81
      0xe1dd20f0,   // ldrsh r2, [sp]      -> -127
      0xe1dd30d0,   // ldrsb r3, [sp]      -> -127
      0xe5dd4001,   // ldrb r4, [sp, #1]   -> 0xff
      BXLR], (c) => { c.w[26] -= 64; });
    expect(c.w[2]).toBe(0xff81); expect(c.w[4]).toBe(-127); expect(c.w[6]).toBe(-127); expect(c.w[8]).toBe(0xff);
  });
  test("push/pop and bl/bx round trip", () => {
    const c = run([
      0xe92d4010,   // push {r4, lr}
      0xe3a04007,   // mov r4, #7
      0xeb000000,   // bl +1 -> to 'mov r0,#9; bx lr'
      0xe8bd8010,   // pop {r4, pc}
      0xe3a00009,   // mov r0, #9
      BXLR], (c) => { c.w[8] = 0x5eed; });
    expect(c.w[0]).toBe(9); expect(c.w[8]).toBe(0x5eed);
  });
  test("conditional execution and cmp", () => {
    const c = run([
      0xe3a00005,   // mov r0, #5
      0xe3500005,   // cmp r0, #5
      0x03a01001,   // moveq r1, #1
      0x13a01002,   // movne r1, #2
      0xe3500006,   // cmp r0, #6
      0xb3a02003,   // movlt r2, #3
      0x83a02004,   // movhi r2, #4
      BXLR]);
    expect(c.w[2]).toBe(1); expect(c.w[4]).toBe(3);
  });
  test("mul/umull/smull/mls", () => {
    const c = run([
      0xe3e00000,   // mvn r0, #0  (0xffffffff)
      0xe3a01002,   // mov r1, #2
      0xe0832190,   // umull r2, r3, r0, r1  -> 0x1_fffffffe
      0xe0c54190,   // smull r4, r5, r0, r1  -> -2 (r4=-2, r5=-1)
      0xe0060190,   // mul r6, r0, r1        -> -2
      0xe3500000,   // cmp r0, #0
      0x10604596,   // mlsne r0, r6, r5, r4 -> -4
      BXLR]);
    expect(c.w[4]).toBe(-2); expect(c.w[6]).toBe(1);
    expect(c.w[8]).toBe(-2); expect(c.w[10]).toBe(-1);
    expect(c.w[12]).toBe(-2);
    expect(c.w[0]).toBe(-4);
    expect(c.cpsr >>> 28).toBe(10);
  });
  test("saturation uses its source register, wraps shifts and retains sticky Q", () => {
    const setup = (cpu: Cpu) => {
      cpu.w[0] = 8; cpu.w[2] = 0x40000001; cpu.w[4] = -16; cpu.w[6] = -2147483648;
    };
    for (const c of both([0xe6e28010, 0xe6a79211, 0xe6e4a1d2, 0xe6bfb013, BXLR], [0xf380, 0x0802, 0xf301, 0x1907, 0xf3a2, 0x0ac4, 0xf303, 0x0b1f, 0x4770], setup)) {
      expect([c.w[16], c.w[18], c.w[20], c.w[22], c.q]).toEqual([3, 16, 0, -2147483648, 1]);
    }
  });
  test("packing, byte-pair extension, word-by-half products and IT bodies without flags", () => {
    const setup = (cpu: Cpu) => { cpu.w[0] = 0x12345678; cpu.w[2] = 0x9abcdef0; cpu.w[4] = 0x7fff0003; cpu.w[14] = 10; };
    // pkhbt r3, r0, r1, lsl #8; pkhtb r4, r0, r1, asr #16; uxtab16 r5, r2, r1, ror #8; sxtb16 r6, r1
    const arm = run([0xe6803411, 0xe6804851, 0xe6c25471, 0xe68f6071, 0xe1272180, 0xe12801e0, BXLR], setup); // smlawb r7; smulwt r8
    expect([3, 4, 5, 6].map((i) => arm.w[2 * i] >>> 0)).toEqual([0xbcde5678, 0x12349abc, 0x809900e1, 0xffbcfff0]);
    const thumb = runThumb([0xeac0, 0x2301, 0xeac0, 0x4421, 0xfa32, 0xf591, 0xfa2f, 0xf681,
      0xea60, 0x1901, 0xfb10, 0x2a01, // orn r9, r0, r1, lsl #4; smlabb r10, r0, r1, r2
      0x4282, 0xbf8a, 0x3705, 0x4347, 0xf301, 0x080f, // cmp r2, r0; itet hi; addhi r7, #5; mulls r7, r0; ssathi r8, #16, r1
      0x4770], setup);
    expect([3, 4, 5, 6, 9, 7, 8].map((i) => thumb.w[2 * i] >>> 0)).toEqual([0xbcde5678, 0x12349abc, 0x809900e1, 0xffbcfff0, 0x563656ff, 15, 0xffff8000]);
    expect([thumb.cpsr >>> 28, thumb.q]).toEqual([2, 1]);
  });
  test("parallel add/subtract sets GE for SEL and saturates or halves per lane", () => {
    const setup = (cpu: Cpu) => { cpu.w[0] = 0x80ff7f01; cpu.w[2] = 0x0102ff7f; cpu.w[14] = 0x7fffffff; };
    // uadd8 r2, r0, r1; sel r3, r0, r1; qsub16 r4, r0, r1; shasx r5, r0, r1; qadd r6, r7, r7
    for (const c of both([0xe6502f91, 0xe6803fb1, 0xe6204f71, 0xe6305f31, 0xe1076057, BXLR], [0xfa80, 0xf241, 0xfaa0, 0xf381, 0xfad0, 0xf411, 0xfaa0, 0xf521, 0xfa87, 0xf687, 0x4770], setup)) {
      expect([4, 6, 8, 10, 12].map((i) => c.w[i] >>> 0)).toEqual([0x81017e80, 0x01ff7f7f, 0x80007f82, 0xc03f3eff, 0x7fffffff]);
      expect([(c.cpsr >>> 16) & 15, c.q]).toEqual([6, 1]);
    }
  });
  test("clz, mrs/msr", () => {
    const c = run([
      0xe3a00001,   // mov r0, #1
      0xe16f1f10,   // clz r1, r0 -> 31
      0xe3a02000,   // mov r2, #0 (doesn't set flags)
      0xe3520000,   // cmp r2, #0 -> Z=1 C=1
      0xe10f3000,   // mrs r3, cpsr
      0xe6ff4f30,   // rbit r4, r0
      BXLR]);
    expect(c.w[2]).toBe(31);
    expect(c.w[6] >>> 30).toBe(1); // Z set, N clear
    expect((c.w[6] >>> 29) & 1).toBe(1);
    expect(c.w[8] >>> 0).toBe(0x80000000);
  });
  test("exclusive stores require a live monitor", () => {
    const c = run([0xe1912f9f, 0xe2822001, 0xe1810f92, 0xf57ff01f, 0xe3a02063, 0xe1813f92, BXLR], (cpu) => {
      cpu.w[2] = cpu.stackTop - 16;
      mem.st32(cpu.w[2], 41);
    });
    expect(mem.ld32(c.w[2])).toBe(42);
    expect([c.w[0], c.w[6]]).toEqual([0, 1]);
    const double = run([0xe1b12f9f, 0xe2924001, 0xe2a35000, 0xe1a12f94, BXLR], (cpu) => {
      cpu.w[2] = cpu.stackTop - 16;
      mem.st64(cpu.w[2], 0x12345678ffffffffn);
    });
    expect(double.w[2]).toBe(double.stackTop - 16);
    expect(mem.ld64(double.w[2])).toBe(0x1234567900000000n);
    expect(double.w[4]).toBe(0);
  });
  test("ldm/stm ia/db forms", () => {
    const c = run([
      0xe3a00001, 0xe3a01002, 0xe3a02003,   // r0..r2 = 1,2,3
      0xe92d0007,   // push {r0,r1,r2}  (stmdb sp!)
      0xe8bd0038,   // pop {r3,r4,r5}   (ldmia sp!)
      0xe92d6000,   // push {sp, lr}: the stored sp is the one before the push (__aeabi_uldivmod)
      0xe59d6000,   // ldr r6, [sp]
      0xe28dd008,   // add sp, sp, #8
      BXLR], (c) => { c.w[26] -= 64; });
    expect(c.w[6]).toBe(1); expect(c.w[8]).toBe(2); expect(c.w[10]).toBe(3);
    expect(c.w[12]).toBe(c.w[26]);
  });
  test("NEON structure transfers work in ARM mode", () => {
    const c = run([
      0xf4610a0d,   // vld1.8 {d16,d17}, [r1]!
      0xf4400a0d,   // vst1.8 {d16,d17}, [r0]!
      BXLR,
    ], (cpu) => {
      cpu.w[0] = cpu.stackTop - 32;
      cpu.w[2] = cpu.stackTop - 16;
      mem.st32(cpu.w[2], 0x12345678);
      mem.st32(cpu.w[2] + 4, 0x76543210);
      mem.st32(cpu.w[2] + 8, 0x0badf00d);
      mem.st32(cpu.w[2] + 12, 0x5eedface);
    });
    expect(Array.from(mem.u32.slice((c.w[0] - 16) >>> 2, c.w[0] >>> 2))).toEqual([0x12345678, 0x76543210, 0x0badf00d, 0x5eedface]);
    expect(c.w[2]).toBe(c.stackTop);
    const interleaved = run([
      0xf421188f, // vld2.32 {d1,d2}, [r1]
      0xf400398d, // vst2.32 {d3,d5}, [r0]!
      BXLR,
    ], (cpu) => {
      cpu.w[0] = cpu.stackTop - 32; cpu.w[2] = cpu.stackTop - 16;
      mem.u32.set([1, 2, 3, 4], cpu.w[2] >>> 2);
      cpu.si.set([5, 7], 6); cpu.si.set([6, 8], 10);
    });
    expect(Array.from(interleaved.si.slice(2, 6))).toEqual([1, 3, 2, 4]);
    expect(Array.from(mem.u32.slice((interleaved.w[0] - 16) >>> 2, interleaved.w[0] >>> 2))).toEqual([5, 6, 7, 8]);
    expect(interleaved.w[0]).toBe(interleaved.w[2]);
    const setup = (cpu: Cpu) => {
      cpu.w[0] = cpu.stackTop - 16; cpu.w[2] = cpu.stackTop - 32; cpu.w[4] = 4;
      mem.st32(cpu.w[0], 0x12345678); mem.st32(cpu.w[2], 0x7f0000);
      cpu.si.set([42, 43], 54);
    };
    for (const lanes of both([0xf4e0b8bf, 0xf4c1b4cd, 0xf4e1cc22, BXLR], [0xf9e0, 0xb8bf, 0xf9c1, 0xb4cd, 0xf9e1, 0xcc22, 0x4770], setup)) {
      expect(Array.from(lanes.si.slice(54, 60))).toEqual([42, 0x12345678, 0x7f7f7f7f, 0x7f7f7f7f, 0x7f7f7f7f, 0x7f7f7f7f]);
      expect(mem.ld32(lanes.stackTop - 32)).toBe(0x7f1234);
      expect(lanes.w[2]).toBe(lanes.stackTop - 26);
    }
  });
  test("NEON modified immediates select high quad registers in ARM mode", () => {
    const c = run([
      0xf2c00050,   // vmov.i32 q8, #0
      BXLR,
    ], (cpu) => { cpu.si.fill(-1, 32, 36); });
    expect(Array.from(c.si.slice(32, 36))).toEqual([0, 0, 0, 0]);
    const setup = (cpu: Cpu) => {
      cpu.si.set([0x03020100, 0x07060504], 4);
      cpu.si.set([0x0b0a0908, 0x0f0e0d0c], 34);
      cpu.si.set([0x11223344, 0x55667788], 8);
    };
    for (const c of both([0xf3bf1c02, 0xf3ba6c61, 0xf3bc8c44, BXLR], [0xffbf, 0x1c02, 0xffba, 0x6c61, 0xffbc, 0x8c44, 0x4770], setup)) {
      expect(Array.from(c.si.slice(2, 4))).toEqual([0x07070707, 0x07070707]);
      expect(Array.from(c.si.slice(12, 16))).toEqual(Array(4).fill(0x0d0c0d0c));
      expect(Array.from(c.si.slice(16, 20))).toEqual(Array(4).fill(0x55667788));
    }
  });
  test("NEON table lookups retain source bytes across overlapping registers", () => {
    const setup = (cpu: Cpu) => {
      const bytes = new Uint8Array(cpu.si.buffer, cpu.si.byteOffset, 256);
      bytes.set(Array.from({ length: 256 }, (_, i) => i));
      bytes.set([7, 6, 5, 4, 3, 2, 1, 0], 0);
      bytes.set([0, 7, 8, 23, 24, 255, 15, 16], 8);
      bytes.set([0, 7, 8, 15, 16, 255, 1, 14], 26 * 8);
      bytes.set([0, 7, 8, 15, 16, 23, 24, 31], 27 * 8);
    };
    for (const c of both([0xf3f8e9aa, 0xf3b31a41, 0xf3b00800, 0xf3fcfbab, BXLR], [0xfff8, 0xe9aa, 0xffb3, 0x1a41, 0xffb0, 0x0800, 0xfffc, 0xfbab, 0x4770], setup)) {
      const bytes = new Uint8Array(c.si.buffer, c.si.byteOffset, 256);
      expect(Array.from(bytes.slice(0, 16))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 24, 31, 32, 47, 24, 255, 39, 40]);
      expect(Array.from(bytes.slice(240))).toEqual([192, 199, 200, 207, 0, 0, 193, 206, 224, 231, 232, 239, 192, 206, 248, 255]);
    }
  });
  test("NEON permutations update both operands from their original lanes", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([10, 11, 12, 13, 0, 1, 2, 3, 20, 21, 22, 23], 32);
      cpu.si.set([0x03020100, 0x07060504, 0x13121110, 0x17161514], 2);
    };
    for (const c of both([0xf3fa21e0, 0xf3fa40e2, 0xf3b21102, 0xf2f064e2, BXLR], [0xfffa, 0x21e0, 0xfffa, 0x40e2, 0xffb2, 0x1102, 0xeff0, 0x64e2, 0x4770], setup)) {
      expect(Array.from(c.si.slice(32, 44))).toEqual([2, 12, 3, 13, 21, 10, 23, 11, 20, 0, 22, 1]);
      expect(Array.from(c.si.slice(2, 6))).toEqual([0x06040200, 0x16141210, 0x07050301, 0x17151311]);
      expect(Array.from(c.si.slice(44, 48))).toEqual([12, 3, 13, 21]);
    }
  });
  test("NEON VSWP exchanges D and Q registers in ARM and Thumb mode", () => {
    const setup = (cpu: Cpu) => { for (let i = 0; i < cpu.si.length; i++) cpu.si[i] = i; };
    for (const c of both([0xf3b22027, 0xf3b2404a, BXLR], [0xffb2, 0x2027, 0xffb2, 0x404a, 0x4770], setup)) {
      expect(Array.from(c.si.slice(4, 6))).toEqual([46, 47]);
      expect(Array.from(c.si.slice(46, 48))).toEqual([4, 5]);
      expect(Array.from(c.si.slice(8, 12))).toEqual([20, 21, 22, 23]);
      expect(Array.from(c.si.slice(20, 24))).toEqual([8, 9, 10, 11]);
    }
  });
  test("NEON narrowing shifts retain rounding and saturation", () => {
    const cases: [number, number, bigint[], number[]][] = [
      [0xf2f23812, 0xeff2, [0x123456789abcdef0n, 0xfedcba9876543210n], [0x59e26af3, 0xea61d950]],
      [0xf2f23852, 0xeff2, [0x123456789abcdef0n, 0xfedcba9876543210n], [0x59e26af3, 0xea61d951]],
      [0xf2f23912, 0xeff2, [0x7fffffffffffffffn, 0x8000000000000000n], [0x7fffffff, 0x80000000]],
      [0xf3f23812, 0xfff2, [0x7fffffffffffffffn, 0x8000000000000000n], [0xffffffff, 0]],
    ];
    for (const [word, first, values, expected] of cases) {
      const setup = (cpu: Cpu) => { new BigUint64Array(cpu.si.buffer, cpu.si.byteOffset, 32).set(values, 2); };
      for (const c of both([word, BXLR], [first, word & 0xffff, 0x4770], setup)) {
        expect(Array.from(c.si.slice(38, 40), x => x >>> 0)).toEqual(expected);
      }
    }
  });
  test("NEON arithmetic shares D/Q lanes in ARM and Thumb encodings", () => {
    const setup = (cpu: Cpu) => {
      const floats = new Float32Array(cpu.si.buffer, cpu.si.byteOffset, cpu.si.length);
      floats.set([1, 2, 3, 4, 5, 6, 7, 8], 8);
      cpu.si.set([0x00050007, 0x00010003, 0x00020004, 0x00060008], 20);
      cpu.si.set([0x03020100, 0x07060504], 2);
      cpu.w[2] = 0x12345678;
    };
    for (const c of both([0xf2042d46, 0xf31a980b, 0xf30aa15a, 0xf2b11302, 0xee821b30, BXLR], [0xef04, 0x2d46, 0xff1a, 0x980b, 0xff0a, 0xa15a, 0xefb1, 0x1302, 0xee82, 0x1b30, 0x4770], setup)) {
      expect(Array.from(c.si.slice(2, 8))).toEqual([0x06050403, -1073741817, 0x56785678, 0x56785678, 0x41200000, 0x41400000]);
      expect(Array.from(c.si.slice(18, 24))).toEqual([0x00030003, -262149, 0, 0, 0, 0]);
    }
    const accumulated = run([0xf26a8df2, BXLR], (cpu) => {
      cpu.s.set([1, 8, -1, 0], 48);
      cpu.s.set([1 + 2 ** -23, 2, -2, 0], 52);
      cpu.s.set([1 - 2 ** -23, 3, 4, 1], 36);
    });
    expect(Array.from(accumulated.s.slice(48, 52))).toEqual([0, 2, 7, 0]);
    const scalar = (cpu: Cpu) => {
      cpu.s.set([1, 2, 3, 4, 3, 4, 5, 6], 32);
      cpu.s.set([10, 11, 12, 13, 14, 15, 16, 17], 40);
      cpu.s[13] = 1; cpu.s[14] = 2;
      cpu.s.set([1 - 2 ** -23, 1 + 2 ** -23, 2, 1, 8], 5);
    };
    for (const c of both([0xf3a0c9c7, 0xf3a2c1e6, 0xf2a34562, 0xf2f428e6, BXLR], [0xffa0, 0xc9c7, 0xffa2, 0xc1e6, 0xefa3, 0x4562, 0xeff4, 0x28e6, 0x4770], scalar)) {
      expect(Array.from(c.s.slice(24, 28))).toEqual([5, 8, 11, 14]);
      expect(Array.from(c.s.slice(8, 10))).toEqual([0, 6]);
      expect(Array.from(c.s.slice(36, 40))).toEqual([12, 13, 14, 15]);
    }
    const shifts = (cpu: Cpu) => {
      cpu.si.set([1, 0, 0, -2147483648], 40);
      cpu.si.set([32, 0, 192, 0], 36);
      cpu.si.set([-8, -2147483648, -2, 32], 4);
    };
    for (const c of both([0xf37284e4, 0xf2231402, BXLR], [0xff72, 0x84e4, 0xef23, 0x1402, 0x4770], shifts)) {
      expect(Array.from(c.si.slice(48, 52))).toEqual([0, 1, 0, 0]);
      expect(Array.from(c.si.slice(2, 4))).toEqual([-2, 0]);
    }
  });
  test("NEON scalar integer multiply wraps each lane before accumulation", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([2147483647, 3, -2, -2147483648, 2, -3, 4, 5], 0);
      cpu.si.set([10, 20, 30, 40], 36);
      cpu.si.set([0x00020001, 0xfffeffff, 0x00040003, 0x0002ffff], 12);
      cpu.si.set([0x00020001, 0xffff8000, 0x00030004, 0x7fff0000], 20);
      cpu.si.set([0x000a000a, 0x000a000a], 10);
    };
    for (const c of both([0xf3e00860, 0xf3e22062, 0xf296546f, 0xf39a8863, BXLR], [0xffe0, 0x0860, 0xffe2, 0x2062, 0xef96, 0x546f, 0xff9a, 0x8863, 0x4770], setup)) {
      expect(Array.from(c.si.slice(32, 40))).toEqual([2147483645, 9, -6, -2147483648, 4, 29, 18, 25]);
      expect(Array.from(c.si.slice(10, 12))).toEqual([0x00060008, 0x000e000c]);
      expect(Array.from(c.si.slice(16, 20))).toEqual([0x000a0005, 0xfffb8000 | 0, 0x000f0014, 0x7ffb0000]);
    }
  });
  test("NEON reciprocal estimates and steps retain ARM32 rounding", () => {
    const setup = (cpu: Cpu) => {
      cpu.s.set([1, 4, 0, Infinity], 44);
      cpu.s.set([1 + 2 ** -23, 0, 1e-45, NaN], 8);
      cpu.s.set([2 - 2 ** -22, Infinity, Infinity, 1], 12);
      cpu.s.set([3, Infinity, 0, 2], 48);
      cpu.s.set([1 + 2 ** -23, 0, -Infinity, 6], 52);
    };
    for (const c of both([0xf2042f56, 0xf26aaff8, 0xf3fbc5e6, 0xf3f9e566, 0xf3f80066, BXLR], [0xef04, 0x2f56, 0xef6a, 0xaff8, 0xfffb, 0xc5e6, 0xfff9, 0xe566, 0xfff8, 0x0066, 0x4770], setup)) {
      expect(Array.from(c.s.slice(4, 8))).toEqual([0, 2, 2, NaN]);
      expect(Array.from(c.s.slice(52, 56))).toEqual([-(2 ** -22), 1.5, 1.5, -4.5]);
      expect(Math.abs(c.s[56] - 1)).toBeLessThan(2 ** -8);
      expect(Math.abs(c.s[57] - 0.5)).toBeLessThan(2 ** -9);
      expect(Array.from(c.s.slice(58, 60))).toEqual([Infinity, 0]);
      expect(Array.from(c.si.slice(60, 64))).toEqual([0, 0, -1, 0]);
      expect(Array.from(c.s.slice(32, 36))).toEqual([4, 1, Infinity, 0]);
    }
  });
  test("NEON float comparisons produce masks that narrow without saturation", () => {
    const setup = (cpu: Cpu) => {
      cpu.s.set([1, -2, NaN, 0, 0, 1, 5, -0], 8);
      cpu.s.set([2, 1, NaN, -0], 44);
      cpu.s.set([1, 1, 0, 0], 56);
    };
    for (const c of both([0xf2042e46, 0xf3040e46, 0xf3248e56, 0xf3662eec, 0xf3f62222, BXLR], [0xef04, 0x2e46, 0xff04, 0x0e46, 0xff24, 0x8e56, 0xff66, 0x2eec, 0xfff6, 0x2222, 0x4770], setup)) {
      expect(Array.from(c.si.slice(4, 8))).toEqual([0, 0, 0, -1]);
      expect(Array.from(c.si.slice(0, 4))).toEqual([-1, 0, 0, -1]);
      expect(Array.from(c.si.slice(16, 20))).toEqual([-1, -1, 0, 0]);
      expect(Array.from(c.si.slice(36, 40))).toEqual([0xffff, 0, 0, 0]);
    }
  });
  test("NEON integer comparison and multiplication retain unsigned lanes", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([1, 2, 3, -1, -2, 3, 4, 5, 0, 2, -1, 4], 32);
    };
    for (const c of both([0xf364a3f0, 0xf260c9f2, 0xf2626ab2, 0xf2603aa0, BXLR], [0xff64, 0xa3f0, 0xef60, 0xc9f2, 0xef62, 0x6ab2, 0xef60, 0x3aa0, 0x4770], setup)) {
      expect(Array.from(c.si.slice(52, 56))).toEqual([0, -1, -1, 0]);
      expect(Array.from(c.si.slice(56, 60))).toEqual([-2, 6, 12, -5]);
      expect(Array.from(c.si.slice(44, 46))).toEqual([-2, -2]);
      expect(Array.from(c.si.slice(38, 40))).toEqual([2, 2]);
    }
  });
  test("NEON integer signs, zero comparisons and extrema retain signedness", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([0x807fff01, -1, 0, 0], 8);
      cpu.si.set([0x8000ffff, 0x7fff0001, 0, 0], 16);
      cpu.si.set([-2147483648, 7], 18);
      cpu.si.set([-5, -1, 3, -7], 32);
      cpu.si.set([-1, -1, -1, -1], 20);
    };
    for (const c of both([0xf3b90144, 0xf3b9e389, 0xf3b12344, 0xf3b563c8, 0xf26106a0, 0xf328a65a, 0xf3b005c0, BXLR], [0xffb9, 0x0144, 0xffb9, 0xe389, 0xffb1, 0x2344, 0xffb5, 0x63c8, 0xef61, 0x06a0, 0xff28, 0xa65a, 0xffb0, 0x05c0, 0x4770], setup)) {
      expect(Array.from(c.si.slice(0, 4))).toEqual([-1, -1, 0, 0]);
      expect(Array.from(c.si.slice(28, 30))).toEqual([-2147483648, -7]);
      expect(Array.from(c.si.slice(4, 8))).toEqual([0x807f0101 | 0, 0x01010101, 0, 0]);
      expect(Array.from(c.si.slice(12, 16))).toEqual([0x80000001 | 0, 0x8001ffff | 0, -2147483648, 65529]);
      expect(Array.from(c.si.slice(32, 34))).toEqual([3, -1]);
      expect(Array.from(c.si.slice(20, 24))).toEqual([0x8000ffff | 0, 0x7fff0001, -2147483648, 7]);
    }
  });
  test("NEON core-register transfers extend scalar lanes and preserve neighbors", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([0x8000ffff, 0x80000001], 36);
      cpu.w[10] = 0xab; cpu.w[12] = 0xbeef; cpu.w[14] = 0x12345678;
    };
    const words = [0xeef20bf0, 0xee521bf0, 0xeeb22bf0, 0xee123bf0, 0xee324b90, 0xee227b90, 0xee625bf0, 0xee226bb0];
    for (const c of both([...words, BXLR], [...words.flatMap(w => [w >>> 16, w & 0xffff]), 0x4770], setup)) {
      expect([c.w[0], c.w[2], c.w[4], c.w[6], c.w[8]]).toEqual([128, -128, 32768, -32768, -2147483647]);
      expect(Array.from(c.si.slice(36, 38), x => x >>> 0)).toEqual([0x8000ffff, 0xab34beef]);
    }
  });
  test("high VFP register loads remain distinct from core-register pair moves", () => {
    const setup = (cpu: Cpu) => {
      cpu.w[0] = cpu.stackTop - 64; cpu.w[2] = cpu.stackTop - 32;
      mem.u32.set([1, 2, 3, 4], cpu.w[2] >>> 2);
      cpu.w[8] = 5; cpu.w[10] = 6;
    };
    const words = [0xecd12b04, 0xece02b04, 0xec532b32, 0xec454b34];
    for (const c of both([...words, BXLR], [...words.flatMap(w => [w >>> 16, w & 0xffff]), 0x4770], setup)) {
      expect([c.w[0], c.w[2]]).toEqual([c.stackTop - 48, c.stackTop - 32]);
      expect(Array.from(mem.u32.slice((c.stackTop - 64) >>> 2, (c.stackTop - 48) >>> 2))).toEqual([1, 2, 3, 4]);
      expect([c.w[4], c.w[6]]).toEqual([1, 2]);
      expect(Array.from(c.si.slice(40, 42))).toEqual([5, 6]);
    }
  });
  test("VFP arithmetic preserves aliased lanes and rounds multiply before accumulation", () => {
    const words = [0xeeb60a00, 0xee710a02, 0xee711a42, 0xee612a02, 0xeec13a02, 0xee010a02, 0xee010a42,
      0xee614a42, 0xeef05ae4, 0xeef16a65, 0xeef07a66, 0xeef12be0, 0xee703ba1, 0xee098a0a];
    const setup = (cpu: Cpu) => {
      cpu.cpsr = 0xa0000000;
      cpu.s[2] = 3; cpu.s[4] = 4;
      cpu.s[16] = -1; cpu.s[18] = 1 + 2 ** -23; cpu.s[20] = 1 - 2 ** -23;
      cpu.d[16] = 81; cpu.d[17] = 19;
    };
    for (const c of both([...words, BXLR], [...words.flatMap(w => [w >>> 16, w & 0xffff]), 0x4770], setup)) {
      expect([0, 1, 3, 5, 7, 9, 11, 13, 15, 16].map(i => c.s[i])).toEqual([0.5, 7, -1, 12, 0.75, -12, 12, -12, -12, 0]);
      expect(Array.from(c.d.slice(16, 20))).toEqual([81, 19, 9, 100]);
      expect(c.cpsr >>> 28).toBe(10);
    }
  });
  test("NEON float extrema and sign operations preserve NaN and signed zero", () => {
    const setup = (cpu: Cpu) => {
      cpu.s.set([-2, -0, -Infinity, NaN], 40);
      cpu.s.set([1, -2, NaN, 0], 8);
      cpu.s.set([-0, -2, NaN, -Infinity], 0); cpu.s.set([0, -3, 4, Infinity], 56);
      cpu.s.set([-0, -2, NaN, -Infinity, 0, -3, 4, Infinity], 16);
    };
    for (const c of both([0xf3f94764, 0xf3b927c4, 0xf2402f6c, 0xf2286f4a, 0xf3f96444, 0xf3f98644, 0xf3f9a4c4, 0xf3f9c5c4, BXLR], [0xfff9, 0x4764, 0xffb9, 0x27c4, 0xef40, 0x2f6c, 0xef28, 0x6f4a, 0xfff9, 0x6444, 0xfff9, 0x8644, 0xfff9, 0xa4c4, 0xfff9, 0xc5c4, 0x4770], setup)) {
      expect(Array.from(c.s.slice(40, 44))).toEqual([2, 0, Infinity, NaN]);
      expect(Array.from(c.s.slice(4, 8))).toEqual([-1, 2, NaN, -0]);
      expect(Array.from(c.s.slice(36, 40))).toEqual([0, -2, NaN, Infinity]);
      expect(Array.from(c.s.slice(12, 16))).toEqual([-0, -3, NaN, -Infinity]);
      expect(Array.from(c.si.slice(44, 60))).toEqual([-1, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, 0, -1]);
    }
  });
  test("NEON widening multiply uses original narrow operands before accumulation", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([-1, -1, 10, 0, -1, -2147483648, 2, 3], 36);
      cpu.si.set([0x0002ffff, 0x7fff8000, 0x00030004, 0x00010002], 6);
      cpu.si.set([0x0302ff80, 0, 0x01020202, 0], 10);
    };
    for (const c of both([0xf3e428a5, 0xf2932a04, 0xf2854c06, BXLR], [0xffe4, 0x28a5, 0xef93, 0x2a04, 0xef85, 0x4c06, 0x4770], setup)) {
      expect(Array.from(c.si.slice(36, 40))).toEqual([-3, 1, -2147483638, 1]);
      expect(Array.from(c.si.slice(4, 8))).toEqual([4, -6, 65536 + 0x0002ffff, 0x7fff8000 - 32767]);
      expect(Array.from(c.si.slice(8, 12))).toEqual([0xfffeff00 | 0, 0x00030004, 0, 0]);
    }
  });
  test("NEON high narrowing arithmetic wraps before optional rounding", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([0x00ff7fff, -1, 0, 0x01008000], 40);
      cpu.si.set([0x00010001, 0x00010001, -1, 0x7fff8000], 36);
      cpu.si.set([0, 0x7fffffff, -1, 0x00018000, 1, -1, 0, 0], 8);
      cpu.si.set([-1, -1, 0x7fffffff, 4, 1, 0, 0, 0], 16);
    };
    for (const c of both([0xf2c434a2, 0xf3941606, 0xf3a8340a, BXLR], [0xefc4, 0x34a2, 0xff94, 0x1606, 0xffa8, 0x340a, 0x4770], setup)) {
      expect(Array.from(c.si.slice(38, 40))).toEqual([0x00000180, 0x8000ffff | 0]);
      expect(Array.from(c.si.slice(2, 4))).toEqual([0x80000000 | 0, 0x00020000]);
      expect(Array.from(c.si.slice(6, 8))).toEqual([0, 4]);
    }
  });
  test("NEON float/integer conversions round and saturate at lane bounds", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([-1, 2147483647, -2147483648, 16777217], 60);
      cpu.si.set([-1, 0, -2147483648, 16777217], 8);
      cpu.s.set([1.9, -1.9, NaN, Infinity], 16);
    };
    for (const c of both([0xf3fbe66e, 0xf3bb26c4, 0xf3bb6748, 0xf3bb5788, BXLR], [0xfffb, 0xe66e, 0xffbb, 0x26c4, 0xffbb, 0x6748, 0xffbb, 0x5788, 0x4770], setup)) {
      expect(Array.from(c.s.slice(60, 64))).toEqual([-1, 2147483648, -2147483648, 16777216]);
      expect(Array.from(c.s.slice(4, 8))).toEqual([4294967296, 0, 2147483648, 16777216]);
      expect(Array.from(c.si.slice(12, 16))).toEqual([1, -1, 0, 2147483647]);
      expect(Array.from(c.si.slice(10, 12))).toEqual([1, 0]);
    }
  });
  test("NEON immediate shifts preserve signed, rounded and accumulating behavior", () => {
    const setup = (cpu: Cpu) => {
      cpu.si.set([-1, 0, -2147483648, 2147483647], 36);
      cpu.si.set([-1, -1], 4);
      cpu.si.fill(0x00010001, 12, 16); cpu.si.fill(0x0010fff8, 16, 20);
      cpu.si.set([-1, 2, 3, 4], 24); cpu.si.set([1, 0, 2, 0], 32);
    };
    for (const c of both([0xf2e14072, 0xf3881012, 0xf29d6158, 0xf3bfa25c, 0xf2a8e5f0, BXLR], [0xefe1, 0x4072, 0xff88, 0x1012, 0xef9d, 0x6158, 0xffbf, 0xa25c, 0xefa8, 0xe5f0, 0x4770], setup)) {
      expect(Array.from(c.si.slice(40, 44))).toEqual([-1, 0, -1, 0]);
      expect(Array.from(c.si.slice(2, 4))).toEqual([0, 0]);
      expect(Array.from(c.si.slice(12, 16))).toEqual(Array(4).fill(0x00030000));
      expect(Array.from(c.si.slice(20, 24))).toEqual([-2147483648, 1, 2, 2]);
      expect(Array.from(c.si.slice(28, 32))).toEqual([0, 256, 0, 512]);
    }
    const widen = (cpu: Cpu) => {
      cpu.si.set([0x80007fff, 0xffff0001], 32);
      cpu.si.set([0x7fff0180, 0xfe0200ff], 6);
      cpu.si.set([-2147483648, 2147483647], 10);
    };
    for (const c of both([0xf3d00a30, 0xf2a08a15, 0xf28c4a13, BXLR], [0xffd0, 0x0a30, 0xefa0, 0x8a15, 0xef8c, 0x4a13, 0x4770], widen)) {
      expect(Array.from(c.si.slice(32, 36))).toEqual([32767, 32768, 1, 65535]);
      expect(Array.from(new Int16Array(c.si.buffer, c.si.byteOffset + 32, 8))).toEqual([-2048, 16, -16, 2032, -16, 0, 32, -32]);
      expect(Array.from(c.si.slice(16, 20))).toEqual([-2147483648, -1, 2147483647, 0]);
    }
    // vmlal.u32 q6, d28, d0[1]; vmull.s16 q7, d1, d2[3]; vmull.p8 q8, d16, d6
    const byScalar = (cpu: Cpu) => {
      cpu.si.set([3, -1, 0x0003fffe, 0x80007fff, 0, 0xfffd0000], 0);
      cpu.si[12] = 0x7ff; cpu.si[32] = 0x3ff;
      cpu.si.set([1, 0, 2, 0], 24);
      cpu.si.set([0x80000000, 7], 56);
    };
    for (const c of both([0xf3acc2e0, 0xf291ea6a, 0xf2c00e86, BXLR], [0xffac, 0xc2e0, 0xef91, 0xea6a, 0xefc0, 0x0e86, 0x4770], byScalar)) {
      expect(Array.from(c.si.slice(24, 28))).toEqual([-2147483647, 2147483647, -5, 6]);
      expect(Array.from(c.si.slice(28, 32))).toEqual([6, -9, -98301, 98304]);
      expect(Array.from(c.si.slice(32, 36))).toEqual([0x95555, 0, 0, 0]);
    }
  });
  test("rsb/adc/sbc", () => {
    const c = run([
      0xe3a00005,   // mov r0, #5
      0xe2601008,   // rsb r1, r0, #8  -> 3
      0xe3a02000,   // mov r2, #0
      0xe3520000,   // cmp r2, #0  (C=1)
      0xe0a03000,   // adc r3, r0, r0 -> 11
      0xe0c04000,   // sbc r4, r0, r0 -> 0
      BXLR]);
    expect(c.w[2]).toBe(3); expect(c.w[6]).toBe(11); expect(c.w[8]).toBe(0);
  });
});

describe("thumb decoder", () => {
  test("bitfield insertion and clearing preserve bits outside the field", () => {
    const setup = (cpu: Cpu) => { cpu.w[2] = 0x12345678; cpu.w[4] = -1; cpu.w[6] = -1; cpu.w[26] -= 8; };
    for (const [i, execute] of [
      () => runThumb([0xf36f, 0x0313, 0xf361, 0x021d, 0x4770], setup),
      () => run([0xe7d3301f, 0xe7dd2011, 0xe7c3d01f, BXLR], setup),
    ].entries()) {
      const c = execute();
      expect(c.w[4] >>> 0).toBe(0xd2345678);
      expect(c.w[6] >>> 0).toBe(0xfff00000);
      expect(c.w[26] & 15).toBe(i === 0 ? 8 : 0);
    }
  });
  test("NEON modified immediates populate both halves of a quad register", () => {
    const c = runThumb([
      0xef81, 0x6452, // vmov.i32 q3, #0x120000
      0x4770,         // bx lr
    ]);
    expect(Array.from(c.si.slice(12, 16))).toEqual([0x120000, 0x120000, 0x120000, 0x120000]);
  });

  test("NEON modified immediates select high quad registers", () => {
    const c = runThumb([
      0xefc0, 0x0050, // vmov.i32 q8, #0
      0x4770,
    ], (cpu) => { cpu.si.fill(-1, 32, 36); });
    expect(Array.from(c.si.slice(32, 36))).toEqual([0, 0, 0, 0]);
  });

  test("NEON structure transfers preserve two D registers and write back", () => {
    const c = runThumb([
      0xf942, 0x0acd, // vst1.64 {d16,d17}, [r2]!
      0x3a10,         // subs r2, #16
      0xf922, 0x4acd, // vld1.64 {d4,d5}, [r2]!
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[4] = cpu.stackTop - 32;
      cpu.si.set([1, 2, 3, 4], 32);
    });
    expect(Array.from(c.si.slice(8, 12))).toEqual([1, 2, 3, 4]);
    expect(c.w[4]).toBe(c.stackTop - 16);
  });

  test("NEON structure transfers support single D registers without writeback", () => {
    const c = runThumb([
      0xf962, 0x070f, // vld1.8 {d16}, [r2]
      0xf940, 0x170f, // vst1.8 {d17}, [r0]
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[0] = cpu.stackTop - 32;
      cpu.w[4] = cpu.stackTop - 16;
      mem.st32(cpu.w[4], 0x12345678);
      mem.st32(cpu.w[4] + 4, 0x76543210);
      cpu.si[34] = 0x0badf00d;
      cpu.si[35] = 0x5eedface;
    });
    expect(mem.ld32(c.w[0])).toBe(0x0badf00d);
    expect(mem.ld32(c.w[0] + 4)).toBe(0x5eedface);
    expect(Array.from(c.si.slice(32, 34))).toEqual([0x12345678, 0x76543210]);
    expect(c.w[4]).toBe(c.stackTop - 16);
  });

  test("NEON immediates clear a stack buffer through consecutive structure stores", () => {
    const c = runThumb([
      0xb092,         // sub sp, #0x48
      0xf10d, 0x0a08, // add.w r10, sp, #8
      0xefc0, 0x0050, // vmov.i32 q8, #0
      0x4656,         // mov r6, r10
      0xf946, 0x0acd, // vst1.64 {d16,d17}, [r6]!
      0xf946, 0x0acd, // vst1.64 {d16,d17}, [r6]!
      0x4770,
    ], (cpu) => {
      mem.u8.fill(0xff, cpu.stackTop - 0x40, cpu.stackTop - 0x20);
      cpu.si.fill(-1, 32, 36);
    });
    expect(Array.from(mem.u8.slice(c.w[26] + 8, c.w[26] + 40))).toEqual(Array(32).fill(0));
  });

  test("Thumb VFP loads and stores preserve double registers", () => {
    const c = runThumb([
      0xeddd, 0x0b00, // vldr d16, [sp]
      0xedcd, 0x0b02, // vstr d16, [sp, #8]
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[26] -= 32;
      mem.st32(cpu.w[26], 0x12345678);
      mem.st32(cpu.w[26] + 4, 0x76543210);
    });
    expect(mem.ld32(c.w[26] + 8)).toBe(0x12345678);
    expect(mem.ld32(c.w[26] + 12)).toBe(0x76543210);
  });

  test("VFP scalar memory transfers preserve register bits in both instruction modes", () => {
    const setup = (cpu: Cpu) => {
      cpu.w[0] = cpu.stackTop - 16;
      cpu.w[8] = cpu.stackTop - 32;
      mem.st32(cpu.w[8], 0x7fc12345);
    };
    for (const c of both([0xed944a00, 0xed804a00, BXLR], [0xed94, 0x4a00, 0xed80, 0x4a00, 0x4770], setup)) {
      expect(mem.ld32(c.w[0])).toBe(0x7fc12345);
    }
  });

  test("wide immediate moves assemble both halves of a register", () => {
    const c = runThumb([
      0xf241, 0x2034, // movw r0, #0x1234
      0xf6ca, 0x50cd, // movt r0, #0xadcd
      0xf04f, 0x31ff, // mov.w r1, #0xffffffff
      0xf44f, 0x3280, // mov.w r2, #0x10000
      0xf06f, 0x0304, // mvn r3, #4
      0xf464, 0x0a0d, // orn r10, r4, #0x8d0000
      0x4770,         // bx lr
    ]);
    expect(c.w[0] >>> 0).toBe(0xadcd1234);
    expect(c.w[2]).toBe(-1);
    expect(c.w[4]).toBe(0x10000);
    expect(c.w[6]).toBe(-5);
    expect(c.w[20]).toBe(~0x8d0000);
    const conditional = [0x2800, 0xbf04, 0xf241, 0x2034, 0xf6ca, 0x50cd, 0x4770];
    expect(runThumb(conditional).w[0] >>> 0).toBe(0xadcd1234);
    expect(runThumb(conditional, (cpu) => { cpu.w[0] = 1; }).w[0]).toBe(1);
  });

  test("wide multiply and multiply-accumulate preserve flags", () => {
    const c = runThumb([
      0xfb01, 0xf505, // mul r5, r1, r5
      0xfb02, 0x4100, // mla r1, r2, r0, r4
      0xfb02, 0x4310, // mls r3, r2, r0, r4
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[0] = 11;
      cpu.w[2] = 0x5bd1e995;
      cpu.w[4] = 3;
      cpu.w[8] = 40;
      cpu.w[10] = 0x3a6d6f63;
      cpu.cpsr = 0xa0000000;
    });
    expect(c.w[10] >>> 0).toBe(Math.imul(0x5bd1e995, 0x3a6d6f63) >>> 0);
    expect(c.w[2]).toBe(73);
    expect(c.w[6]).toBe(7);
    expect(c.cpsr >>> 28).toBe(0xa);
  });

  test("wide long multiply and multiply-accumulate preserve both halves", () => {
    const c = runThumb([
      0xfbaa, 0x2308, // umull r2, r3, r10, r8
      0xfb8a, 0x4508, // smull r4, r5, r10, r8
      0xfbe1, 0x6708, // umlal r6, r7, r1, r8
      0xfbca, 0xbc08, // smlal r11, r12, r10, r8
      0xfbea, 0x2368, // umaal r2, r3, r10, r8
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[2] = 3;
      cpu.w[12] = 5;
      cpu.w[14] = 1;
      cpu.w[16] = 2;
      cpu.w[20] = -1;
      cpu.w[22] = 5;
      cpu.cpsr = 0xa0000000;
    });
    expect([c.w[4], c.w[6]]).toEqual([-3, 2]);
    expect([c.w[8], c.w[10]]).toEqual([-2, -1]);
    expect([c.w[12], c.w[14]]).toEqual([11, 1]);
    expect([c.w[22], c.w[24]]).toEqual([3, 0]);
    expect(c.cpsr >>> 28).toBe(0xa);
    const arm = run([0xe0410392, BXLR], cpu => {
      cpu.w[0] = 5; cpu.w[2] = 6; cpu.w[4] = -1; cpu.w[6] = -1;
    });
    expect([arm.w[0], arm.w[2]]).toEqual([12, -2]);
  });

  test("flags resume after a multi-instruction IT block", () => {
    const c = runThumb([
      0x2b00,         // cmp r3, #0
      0xbf04,         // itt eq
      0x1c48,         // addeq r0, r1, #1
      0x085a,         // lsreq r2, r3, #1
      0x2500,         // movs r5, #0
      0x3501,         // adds r5, #1
      0x2d10,         // cmp r5, #16
      0xd1fc,         // bne -8
      0x4770,         // bx lr
    ]);
    expect(c.w[10]).toBe(16);
  });

  test("predicated byte loads and shifts preserve IT conditions and writeback", () => {
    const data = mem.reserve(0x1000, 0x1000);
    mem.st8(data, 0x7f);
    const words = [0xbf3a, 0xf813, 0x5b01, 0x022d, 0x2500, 0x4770];
    const lo = runThumb(words, cpu => {
      cpu.w[6] = data;
      cpu.w[10] = 42;
      cpu.cpsr = 0;
    });
    expect([lo.w[6], lo.w[10], lo.cpsr & 0x0600fc00]).toEqual([data + 1, 0x7f00, 0]);
    const hs = runThumb(words, cpu => {
      cpu.w[6] = 0;
      cpu.w[10] = 42;
      cpu.cpsr = 0x20000000;
    });
    expect([hs.w[6], hs.w[10], hs.cpsr & 0x0600fc00]).toEqual([0, 0, 0]);

    const at = mem.reserve(0x1000, 0x1000);
    mem.u16.set(words, at >>> 1);
    const before = jitStats.regions;
    for (let i = 0; i <= JIT_HEAT; i++) execute(at | 1, cpu => { cpu.w[6] = data; });
    expect(jitStats.regions).toBeGreaterThan(before);
    expect(() => execute(at | 1, cpu => { cpu.w[6] = 0; })).toThrow("signal 11 code 1 addr 0x0");
  });

  test("compiled VFP compares, conversions and transfers match the interpreter", () => {
    const data = mem.reserve(0x1000, 0x1000);
    const program = [
      0xee00, 0x0a10, 0xee00, 0x1a90, // vmov s0, r0; vmov s1, r1
      0xeeb8, 0x1ac0, 0xeef8, 0x1a60, // vcvt.f32.s32 s2, s0; vcvt.f32.u32 s3, s1
      0xeeb4, 0x1ae1, 0xeef1, 0xfa10, // vcmpe.f32 s2, s3; vmrs APSR_nzcv, fpscr
      0xbfcc, 0x2201, 0x2202,         // ite gt; movgt r2, #1; movle r2, #2
      0xeeb5, 0x1a40, 0xeef1, 0x3a10, // vcmp.f32 s2, #0; vmrs r3, fpscr
      0xeeb7, 0x2ac1, 0xec55, 0x4b12, // vcvt.f64.f32 d2, s2; vmov r4, r5, d2
      0xec44, 0x5b13, 0xeef7, 0x0bc3, // vmov d3, r5, r4; vcvt.f32.f64 s1, d3
      0xeebd, 0x0ae1, 0xeebc, 0x2a41, // vcvt.s32.f32 s0, s3; vcvtr.u32.f32 s4, s2
      0xee10, 0x6a10, 0xee12, 0x7a10, // vmov r6, s0; vmov r7, s4
      0xed2d, 0x0b08, 0xeeb7, 0x0b00, // vpush {d0-d3}; vmov.f64 d0, #1.0
      0xecbd, 0x0b08,                 // vpop {d0-d3}
      0xeca8, 0x0a04, 0xed38, 0x2a04, // vstmia r8!, {s0-s3}; vldmdb r8!, {s4-s7}
      0xec5a, 0x9a12, 0xeee1, 0x0a10, // vmov r9, r10, s4, s5; vmsr fpscr, r0
      0xf3bf, 0x8f5b, 0x4770,         // dmb ish; bx lr
    ];
    const at = (r0: number, r1: number) => (cpu: Cpu) => { cpu.w[0] = r0; cpu.w[2] = r1; cpu.w[16] = data; };
    expect(runThumb(program, at(7, 3)).w[4]).toBe(1);
    expect(runThumb(program, at(-5, 0xffffffff)).w[4]).toBe(2);
    const compare = [0xee00, 0x0a10, 0xee00, 0x1a90, 0xeeb4, 0x0ae0, 0xeef1, 0xfa10, 0xeeb5, 0x0b40, 0xeef1, 0x3a10, 0x4770];
    expect(runThumb(compare, at(0x7fc00000, 0x3f800000)).cpsr >>> 28).toBe(3); // unordered: C and V
    expect(runThumb(compare, at(0x3f800000, 0x40000000)).cpsr >>> 28).toBe(8);
  });

  test("compiled NEON whole-register loads and stores match the interpreter", () => {
    const data = mem.reserve(0x1000, 0x1000);
    for (let i = 0; i < 64; i++) mem.st8(data + i, i * 7);
    // vld1.8 {d16,d17}, [r2]!; vst1.32 {d16-d19}, [r6], r1; vld1.64 {d0}, [r3:64]; vst1.16 {d1-d3}, [r4]
    const setup = (cpu: Cpu) => { cpu.w[4] = data; cpu.w[12] = data + 64; cpu.w[2] = 8; cpu.w[6] = data + 8; cpu.w[8] = data + 128; };
    const thumb = runThumb([0xf962, 0x0a0d, 0xf946, 0x0281, 0xf923, 0x07df, 0xf904, 0x164f, 0x4770], setup);
    const arm = run([0xf4620a0d, 0xf4460281, 0xf42307df, 0xf404164f, BXLR], setup);
    for (const c of [thumb, arm]) expect([c.w[4], c.w[12], mem.ld32(data + 64)]).toEqual([data + 16, data + 72, 0x150e0700]);
    expect(() => run([0xf42307df, BXLR], (cpu) => { cpu.w[6] = data + 4; })).toThrow(`signal 7 code 1 addr 0x${(data + 4).toString(16)}`);
    // vld1.32 {d0[1]}, [r2]; vst1.16 {d1[2]}, [r3]!; vld1.8 {d2[]}, [r4]
    const lanes = (cpu: Cpu) => { setup(cpu); cpu.w[8] = data + 5; cpu.vu[3] = 0xabcd1234; };
    for (const c of both([0xf4a2088f, 0xf483148d, 0xf4a42c0f, BXLR], [0xf9a2, 0x088f, 0xf983, 0x148d, 0xf9a4, 0x2c0f, 0x4770], lanes)) {
      expect([c.vu[1], c.w[6] - data, mem.u16[(data + 8) >>> 1], c.vu[4], c.vu[5]]).toEqual([0x150e0700, 10, 0x1234, 0x23232323, 0x23232323]);
    }
  });

  test("compiled NEON data processing and lane moves match the interpreter in both encodings", () => {
    // the ARM words; Thumb's NEON forms carry U in bit 12 of 0xef, and its VFP-space moves are the same word
    const thumb = (ws: number[]) => [...ws.flatMap((w) => w >>> 28 === 0xf ? [0xef00 | (w >>> 12 & 0x1000) | (w >>> 16 & 0xff), w & 0xffff] : [w >>> 16, w & 0xffff]), 0x4770];
    const programs = [
      // vadd/vsub/vmul/vmla/vmls/vabd.f32 (Q, D, by scalar), float compares, vabs/vneg.f32 and compares with zero, vnmla/vnmls
      [0xf2400d42, 0xf2602d04, 0xf3413d15, 0xf3404d54, 0xf2424d50, 0xf2626d14, 0xf2e17962, 0xf3e08944, 0xf3e28161, 0xf3e4a540, 0xf360cd44, 0xf240ee02,
        0xf341fe05, 0xf3216e04, 0xf3008e15, 0xf3239e11, 0xf3b9a742, 0xf3b9c7c4, 0xf3b9e400, 0xf3b9f582, 0xf3b90503, 0xf3b91605, 0xee107ac4, 0xee517a21],
      // vadd.i32/vsub.i64, vand/vorr/veor/vbic/vorn/vbsl/vbit/vbif, integer compares, vmax/vmin, vtst/vceq, vmul/vmla/vmls (by scalar too)
      [0xf266084c, 0xf37c2846, 0xf24c415e, 0xf26c611e, 0xf34d711f, 0xf25c8116, 0xf27d9117, 0xf35ca15e, 0xf36cc116, 0xf37dd117, 0xf266e30e,
        0xf357f31f, 0xf226064e, 0xf30a261c, 0xf226381c, 0xf317481d, 0xf226591e, 0xf22c894e, 0xf31ca90e, 0xf2acb86d, 0xf29cf06f, 0xf3a6e446],
      // vshl by register and immediate, vshr/vsra, vneg/vabs.s, compares with zero, vdup (scalar and core), vmov lane <-> core, vmvn
      [0xf3680446, 0xf2682446, 0xf248440a, 0xf3795406, 0xf3fd6016, 0xf2e07017, 0xf3d0811c, 0xf2cf951d, 0xf2d8a09c, 0xf3f9b386, 0xf3f1c307, 0xf3f5d00c, 0xf3f9e186,
        0xf3fafc0d, 0xf3bc0c4c, 0xeec20b10, 0xeea41b30, 0xee232b10, 0xeeda4b70, 0xee3c5b70, 0xee376b10, 0xee7d7b70, 0xee663b30, 0xee270b30, 0xf3b0e58b],
      // vext, vrev64/32/16, vtrn/vzip/vuzp/vswp, vmull/vmlal/vmlsl, modified immediates
      [0xf2fa034c, 0xf2fa250c, 0xf3f84046, 0xf3f4608a, 0xf3f0710b, 0xf3fa80a9, 0xf3f6a1ec, 0xf3f2e12f, 0xf3b20001, 0xf3b620c4,
        0xf3ac6c0e, 0xf29a880b, 0xf38caa0d, 0xf28ecc0f, 0xf284e45f, 0xf2831b3f, 0xf2872f18, 0xf3823e35, 0xf382403b, 0xf2815710],
      // vpadd.i16, vpmax.s8, vpmin.u32, vpadd.f32, vpmax.f32 and vpmin.f32 over NaN lanes: checked only against the interpreter
      [0xf2103b11, 0xf2004a01, 0xf3205a11, 0xf3006d01, 0xf3007f01, 0xf3218f05],
    ];
    const setup = (cpu: Cpu) => {
      for (let i = 0; i < 64; i++) cpu.si[i] = Math.imul(i + 1, 0x9e3779b9) ^ (i << 7);
      cpu.s.set([1.5, -2, 0, Infinity, -0, 0, -Infinity, 3.25, 0.5, Infinity, 2, 0]);
      cpu.si[2] = 0x7fc00001; cpu.si[5] = 1; cpu.si[11] = 0x7f800001; // quiet NaN, denormal, signalling NaN
      cpu.si.set([0x80000000, 0x7fffffff, -128, -5, 3, -3, 64, 0xe0, 0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c,
        0x12345678, 0x9abcdef0, 0x0f0f0f0f, 0xf0f0f0f0, -1, 2, -3, 0x80000000], 12);
      cpu.w.set([0x89abcdef, 0, 0x1234, 0, 0xdeadbeef, 0, 0x7f]);
    };
    for (const encode of [(ws: number[]) => run([...ws, BXLR], setup), (ws: number[]) => runThumb(thumb(ws), setup)]) {
      // every run returns the one shared Cpu, so each result is copied out before the next
      const [float, integer, shifts, permutes] = programs.map((ws) => { const c = encode(ws); return { s: c.s.slice(), vu: c.vu.slice(), w: c.w.slice() }; });
      expect([...float.s.slice(32, 34), float.s[35]]).toEqual([1.5, -2, Infinity]);
      expect(Array.from(float.vu.slice(20, 24))).toEqual([0, 0, 0x7f800000, 0x40500000]);
      expect(float.vu[27]).toBe(0x7fc00000);
      expect(Array.from(integer.vu.slice(32, 36))).toEqual([0x92345678, 0x1abcdeef, 0x0f0f0e8f, 0xf0f0f0eb]);
      expect(Array.from(shifts.vu.slice(32, 40))).toEqual([0, 0x0fffffff, 0, 0, 0, 0x0fffffff, 0, 0xffffffff]);
      expect([shifts.w[8], shifts.w[10] >>> 0, shifts.w[12], shifts.w[14], shifts.vu[4]]).toEqual([3, 0xffff9abc, -5, -16, 0xefefefef]);
      expect(Array.from(permutes.vu.slice(32, 36))).toEqual([0x06050403, 0x0a090807, 0x0e0d0c0b, 0x3456780f]);
      expect(Array.from(permutes.vu.slice(12, 14))).toEqual([0xedcba988, 0x12345677]);
    }
  });

  test("wide doubleword transfers preserve register pairs", () => {
    const c = runThumb([
      0xe9cd, 0x3500, // strd r3, r5, [sp]
      0xe9dd, 0x6700, // ldrd r6, r7, [sp]
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[6] = 0x12345678;
      cpu.w[10] = 0x76543210;
      cpu.w[26] -= 32;
    });
    expect(c.w[12]).toBe(0x12345678);
    expect(c.w[14]).toBe(0x76543210);
  });

  test("wide exclusive transfers and memory barriers preserve atomic loops", () => {
    const c = runThumb([
      0xe850, 0x1f00, // ldrex r1, [r0]
      0x3101,         // adds r1, #1
      0xe840, 0x1200, // strex r2, r1, [r0]
      0xf3bf, 0x8f5b, // dmb ish
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[0] = cpu.stackTop - 16;
      mem.st32(cpu.w[0], 41);
    });
    expect(mem.ld32(c.w[0])).toBe(42);
    expect(c.w[4]).toBe(0);
    // ARM: ldrex r1, [r0]; add r1, #1; strex r2, r1, [r0]; strex r3, r1, [r0] (monitor closed)
    const arm = run([0xe1901f9f, 0xe2811001, 0xe1802f91, 0xe1803f91, BXLR], (cpu) => {
      cpu.w[0] = cpu.stackTop - 16;
      mem.st32(cpu.w[0], 41);
    });
    expect([mem.ld32(arm.w[0]), arm.w[4], arm.w[6]]).toEqual([42, 0, 1]);
    const double = runThumb([
      0xe8d4, 0x327f, // ldrexd r3, r2, [r4]
      0x3301, 0x3202,
      0xe8c4, 0x3270, // strexd r0, r3, r2, [r4]
      0xf3bf, 0x8f2f, // clrex
      0xe8c4, 0x3271, // strexd r1, r3, r2, [r4]
      0x4770,
    ], (cpu) => {
      cpu.w[8] = cpu.stackTop - 16;
      mem.st64(cpu.w[8], 0x1234567811223344n);
    });
    expect(mem.ld64(double.w[8])).toBe(0x1234567a11223345n);
    expect([double.w[0], double.w[2]]).toEqual([0, 1]);
    for (const [kind, loaded, stored] of [[0x40, 0x44, 0x11223399], [0x50, 0x3344, 0x1122ef99]]) {
      const c = runThumb([0xe8d7, 0x0f0f | kind, 0xe8c7, 0x4f01 | kind, 0xf3bf, 0x8f2f, 0xe8c7, 0x0f02 | kind, 0x4770], (cpu) => {
        cpu.w[14] = cpu.stackTop - 16; cpu.w[8] = 0xabcdef99;
        mem.st32(cpu.w[14], 0x11223344);
      });
      expect([c.w[0], c.w[2], c.w[4], mem.ld32(c.w[14])]).toEqual([loaded, 0, 1, stored]);
    }
  });

  test("wide register lists preserve high registers", () => {
    const c = runThumb([
      0xe92d, 0x0f00, // push.w {r8,r9,r10,r11}
      0xe8bd, 0x0f00, // pop.w {r8,r9,r10,r11}
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[16] = 1;
      cpu.w[18] = 2;
      cpu.w[20] = 3;
      cpu.w[22] = 4;
      cpu.w[26] -= 32;
    });
    expect(Array.from(c.w.slice(16, 24).filter((_, i) => i % 2 === 0))).toEqual([1, 2, 3, 4]);
    expect(c.w[26]).toBe(c.stackTop - 32);
    const returned = runThumb([
      0xe92d, 0x4100, // push.w {r8,lr}
      0xe8bd, 0x8100, // pop.w {r8,pc}
    ], (cpu) => { cpu.w[16] = 123; });
    expect(returned.w[16]).toBe(123);
    expect(returned.w[26]).toBe(returned.stackTop);
  });

  test("wide conditional branches preserve taken and fallthrough paths", () => {
    const program = [
      0x2800,         // cmp r0, #0
      0xf300, 0x8001, // bgt.w +2
      0x2101,         // movs r1, #1
      0x4770,         // bx lr
    ];
    expect(runThumb(program, (cpu) => { cpu.w[0] = 1; }).w[2]).toBe(0);
    expect(runThumb(program, (cpu) => { cpu.w[0] = -1; }).w[2]).toBe(1);
    expect(runThumb([0xf000, 0xb801, 0x2001, 0x4770]).w[0]).toBe(0);
    expect(runThumb([0x2800, 0xf47f, 0xaf08, 0x4770]).w[0]).toBe(0);
  });

  test("table branches load byte offsets relative to the Thumb PC", () => {
    const program = [
      0xe8df, 0xf000, // tbb [pc, r0]
      0x0402, 0xbf00, // offsets 2, 4; padding
      0x2101, 0xe001, // first: r1=1; branch to return
      0x2102, 0xbf00, // second: r1=2; padding
      0x4770,         // return
    ];
    expect(runThumb(program).w[2]).toBe(1);
    expect(runThumb(program, (cpu) => { cpu.w[0] = 1; }).w[2]).toBe(2);
  });

  test("IT conditions survive a compiled function prologue", () => {
    const c = runThumb([
      0xb5d0,         // push {r4,r6,r7,lr}
      0xaf02,         // add r7, sp, #8
      0x4604,         // mov r4, r0
      0x2801,         // cmp r0, #1
      0xbf98,         // it ls
      0x2401,         // movls r4, #1
      0x4620,         // mov r0, r4
      0xb900,         // cbnz r0, return
      0x2000,         // movs r0, #0
      0xbdd0,         // return: pop {r4,r6,r7,pc}
    ], (cpu) => { cpu.w[0] = 20; });
    expect(c.w[0]).toBe(20);
  });

  test("tail chaining preserves multi-instruction IT state and flags", () => {
    const at = mem.reserve(0x1000, 0x1000);
    mem.u16.set([
      0x4285, // cmp r5, r0
      0xbf3c, // itt lo
      0x1913, // addlo r3, r2, r4
      0x4631, // movlo r1, r6
      0x4770, // bx lr
    ], at >>> 1);
    for (let i = 0; i <= JIT_HEAT; i++) execute((at + 4) | 1, (cpu) => { cpu.w[2] = 3; });
    for (let i = 0; i <= JIT_HEAT; i++) {
      const skipped = execute(at | 1, (cpu) => {
        cpu.w[0] = 2;
        cpu.w[2] = 11;
        cpu.w[4] = 3;
        cpu.w[6] = 24;
        cpu.w[8] = ~1;
        cpu.w[10] = 83;
        cpu.w[12] = 19;
      });
      expect(skipped.w[2]).toBe(11);
      expect(skipped.w[6]).toBe(24);
      const taken = execute(at | 1, (cpu) => {
        cpu.w[0] = 2;
        cpu.w[2] = 11;
        cpu.w[4] = 3;
        cpu.w[6] = 24;
        cpu.w[8] = ~1;
        cpu.w[10] = 0;
        cpu.w[12] = 19;
      });
      expect(taken.w[2]).toBe(19);
      expect(taken.w[6]).toBe(1);
    }
    core.invalidate_all();
  });

  test("wide arithmetic immediates update values and comparison flags", () => {
    const c = runThumb([
      0xf107, 0x050c, // add.w r5, r7, #12
      0xf025, 0x060f, // bic r6, r5, #15
      0xf046, 0x0607, // orr r6, r6, #7
      0xf1c5, 0x0138, // rsb.w r1, r5, #56
      0xf1b5, 0x3fff, // cmp.w r5, #0xffffffff
      0x4770,         // bx lr
    ], (cpu) => { cpu.w[14] = 20; });
    expect(c.w[10]).toBe(32);
    expect(c.w[12]).toBe(39);
    expect(c.w[2]).toBe(24);
    expect(c.z).toBe(0);
    expect(c.c).toBe(0);
  });

  test("wide add and subtract immediates preserve flags", () => {
    const c = runThumb([
      0xf204, 0x3085, // addw r0, r4, #0x385
      0xf2a4, 0x3185, // subw r1, r4, #0x385
      0x4770,
    ], (cpu) => { cpu.w[8] = 0x400; cpu.cpsr = 0xa0000000; });
    expect(c.w[0]).toBe(0x785);
    expect(c.w[2]).toBe(0x7b);
    expect(c.cpsr >>> 28).toBe(0xa);
  });

  test("wide carry arithmetic consumes carry from immediates and shifted registers", () => {
    const edge = runThumb([
      0x2800, 0xe000, 0xbf00, // cmp r0, #0; branch over nop
      0xeb40, 0x0201,        // adc.w r2, r0, r1 consumes carry across the edge
      0x2b00, 0x4770,        // cmp r3, #0; bx lr
    ]);
    expect(edge.w[4]).toBe(1);
    const c = runThumb([
      0x2800,         // cmp r0, #0 (C=1)
      0xf170, 0x0000, // sbcs r0, r0, #0
      0xf151, 0x0305, // adcs r3, r1, #5
      0x4770,         // bx lr
    ], (cpu) => { cpu.w[2] = -1; });
    expect(c.w[0]).toBe(0);
    expect(c.w[6]).toBe(5);
    expect(c.c).toBe(1);
    const shifted = runThumb([
      0xeb75, 0x05c1, // sbcs.w r5, r5, r1, lsl #3
      0xeb40, 0x0251, // adc.w r2, r0, r1, lsr #1
      0xebd0, 0x0341, // rsbs.w r3, r0, r1, lsl #1
      0xf04f, 0x24ff, // mov.w r4, #0xff00ff00
      0x4770,
    ], (cpu) => { cpu.w[0] = 10; cpu.w[2] = 2; cpu.w[10] = 16; });
    expect([shifted.w[10], shifted.w[4], shifted.w[6], shifted.w[8] >>> 0]).toEqual([-1, 11, -6, 0xff00ff00]);
    expect(shifted.cpsr >>> 28).toBe(8);
  });

  test("IT conditions gate instructions and bitfield extraction", () => {
    const program = [
      0x2800,         // cmp r0, #0
      0xbf08,         // it eq
      0xf3c3, 0x0546, // ubfxeq r5, r3, #1, #7
      0x4770,         // bx lr
    ];
    expect(runThumb(program, (cpu) => { cpu.w[0] = 0; cpu.w[6] = 0xfe; }).w[10]).toBe(0x7f);
    expect(runThumb(program, (cpu) => { cpu.w[0] = 1; cpu.w[6] = 0xfe; }).w[10]).toBe(0);
    const signed = runThumb([0xf340, 0x001e, 0xf343, 0x1207, 0xf343, 0x041f, 0xf3c3, 0x1507, 0x4770], (cpu) => {
      cpu.w[0] = 0x40000000; cpu.w[6] = -16;
    });
    expect([signed.w[0], signed.w[4], signed.w[8], signed.w[10]]).toEqual([-1073741824, -1, -16, 255]);
    const multiple = runThumb([
      0x4280,             // cmp r0, r0
      0xbf01,             // itttt eq
      0x2001, 0x2102,     // moveq r0, #1; moveq r1, #2
      0x2203, 0x2304,     // moveq r2, #3; moveq r3, #4
      0x4770,
    ]);
    expect([multiple.w[0], multiple.w[2], multiple.w[4], multiple.w[6]]).toEqual([1, 2, 3, 4]);
    const wideMove = [0x2800, 0xbf04, 0xf04f, 0x0907, 0x2203, 0x4770];
    const taken = runThumb(wideMove);
    expect([taken.w[18], taken.w[4]]).toEqual([7, 3]);
    const skipped = runThumb(wideMove, cpu => { cpu.w[0] = 1; });
    expect([skipped.w[18], skipped.w[4]]).toEqual([0, 0]);
    for (const input of [0, 1]) {
      let startIc = 0;
      const moves = runThumb([
        0x2800,                         // cmp r0, #0
        0xbf08, 0x2101,                 // it eq; moveq r1, #1
        0xbf08, 0x460b,                 // it eq; moveq r3, r1
        0xbf08, 0xf04f, 0x0907,         // it eq; moveq.w r9, #7
        0xbf18, 0x2209,                 // it ne; movne r2, #9
        0x4770,
      ], cpu => { cpu.w[0] = input; startIc = cpu.ic; });
      expect([moves.w[2], moves.w[6], moves.w[18], moves.w[4]]).toEqual(input ? [0, 0, 0, 9] : [1, 1, 7, 0]);
      expect(moves.cpsr >>> 28).toBe(input ? 2 : 6);
      expect(moves.cpsr & 0x0600fc00).toBe(0);
      expect(moves.ic - startIc).toBe(10);
    }
  });

  test("signed high multiplication rounds the complete accumulate or subtract result", () => {
    const setup = (cpu: Cpu) => { cpu.w[0] = 10; cpu.w[2] = -5; cpu.w[4] = 0x40000000; };
    for (const c of both([0xe758f211, 0xe753f231, 0xe7540211, 0xe7550231, 0xe75602d1, 0xe75702f1, BXLR], [0xfb51, 0xf802, 0xfb51, 0xf312, 0xfb51, 0x0402, 0xfb51, 0x0512, 0xfb61, 0x0602, 0xfb61, 0x0712, 0x4770], setup)) {
      expect([c.w[16], c.w[6], c.w[8], c.w[10], c.w[12], c.w[14]]).toEqual([-2, -1, 8, 9, 11, 11]);
    }
  });

  test("halfword packing shifts before merging without changing flags", () => {
    const setup = (cpu: Cpu) => {
      cpu.w[0] = 0x12345678; cpu.w[2] = 0x87654321; cpu.w[4] = 0xfedcba98; cpu.w[12] = 0xaabbccdd;
      cpu.cpsr |= 0xa8000000;
    };
    for (const c of both([0xe6806016, 0xe6814692, 0xe6815052, 0xe6817252, BXLR], [0xeac0, 0x0606, 0xeac1, 0x3442, 0xeac1, 0x0522, 0xeac1, 0x1722, 0x4770], setup)) {
      expect([c.w[12] >>> 0, c.w[8] >>> 0, c.w[10] >>> 0, c.w[14] >>> 0]).toEqual([0xaabb5678, 0x97534321, 0x8765ffff, 0x8765cba9]);
      expect(c.cpsr >>> 27).toBe(0x15);
    }
  });

  test("wide shifted-register operations preserve shifts and high destinations", () => {
    const c = runThumb([
      0xea5f, 0x7bc6, // lsls.w r11, r6, #31
      0xeb05, 0x0a01, // add.w r10, r5, r1
      0x4770,         // bx lr
    ], (cpu) => { cpu.w[12] = 3; cpu.w[10] = 8; cpu.w[2] = 4; });
    expect(c.w[22]).toBe(-2147483648);
    expect(c.c).toBe(1);
    expect(c.w[20]).toBe(12);
  });

  test("wide register-controlled shifts support high registers", () => {
    const c = runThumb([
      0xfa0c, 0xf201, // lsl.w r2, r12, r1
      0xfa2c, 0xf003, // lsr.w r0, r12, r3
      0x4770,
    ], (cpu) => { cpu.w[24] = 0x80000001; cpu.w[2] = 1; cpu.w[6] = 31; });
    expect(c.w[4]).toBe(2);
    expect(c.w[0]).toBe(1);
  });

  test("wide extensions rotate before extending and adding", () => {
    const c = runThumb([
      0xfa1f, 0xfa80, // uxth.w r10, r0
      0xfa0f, 0xfb90, // sxth.w r11, r0, ror #8
      0xfa51, 0xfca0, // uxtab r12, r1, r0, ror #16
      0xfa41, 0xf9b0, // sxtab r9, r1, r0, ror #24
      0x4770,
    ], (cpu) => { cpu.w[0] = 0x80ffaa55; cpu.w[2] = 10; });
    expect([c.w[20], c.w[22], c.w[24], c.w[18]]).toEqual([0xaa55, -86, 265, -118]);
    const setup = (cpu: Cpu) => { cpu.w[0] = 0x80ffaa55; cpu.w[2] = 0x0000ffff; cpu.cpsr = 0xa8000000; };
    for (const pair of both([0xe6cf2070, 0xe68f3470, 0xe6c14070, 0xe6815470, BXLR], [0xfa3f, 0xf280, 0xfa2f, 0xf390, 0xfa31, 0xf480, 0xfa21, 0xf590, 0x4770], setup)) {
      expect([pair.w[4], pair.w[6], pair.w[8], pair.w[10]]).toEqual([0x00ff0055, 0xff80ffaa | 0, 0x00ff0054, 0xff80ffa9 | 0]);
      expect(pair.cpsr).toBe(0xa8000000);
    }
  });
  test("signed halfword multiply-accumulate wraps and sets sticky Q", () => {
    const setup = (cpu: Cpu) => {
      cpu.w[0] = 0x7fffffff; cpu.w[2] = 1; cpu.w[6] = 1;
      cpu.w[4] = 0xfffeffff; cpu.w[8] = 0xfffd0004;
    };
    const thumb = runThumb([0xfb11, 0x0103, 0xfb12, 0x0514, 0xfb12, 0xf634, 0x4770], setup);
    expect([thumb.w[2], thumb.w[10], thumb.w[12], thumb.q]).toEqual([-2147483648, -2147483646, 6, 1]);
    const arm = run([0xe1010381, BXLR], setup);
    expect([arm.w[2], arm.q]).toEqual([-2147483648, 1]);
  });

  test("wide reversals and leading-zero count preserve their source", () => {
    const c = runThumb([
      0xfab2, 0xf082, // clz r0, r2
      0xfab3, 0xf183, // clz r1, r3
      0xfa92, 0xf4a2, // rbit r4, r2
      0xfa94, 0xf5a4, // rbit r5, r4
      0xfa96, 0xfb86, // rev.w r11, r6
      0xfa96, 0xfc96, // rev16.w r12, r6
      0xfa96, 0xf9b6, // revsh.w r9, r6
      0x4770,         // bx lr
    ], (cpu) => { cpu.w[4] = 0x0000ffff; cpu.w[6] = 0; cpu.w[12] = 0x123480ff; });
    expect(c.w[0]).toBe(16);
    expect(c.w[2]).toBe(32);
    expect(c.w[8] >>> 0).toBe(0xffff0000);
    expect(c.w[10]).toBe(c.w[4]);
    expect([c.w[22] >>> 0, c.w[24] >>> 0, c.w[18], c.w[12]]).toEqual([0xff803412, 0x3412ff80, -128, 0x123480ff]);
  });

  test("wide word spills support pre-index and post-index writeback", () => {
    const c = runThumb([
      0xf84d, 0x8d04, // str r8, [sp, #-4]!
      0xf85d, 0x9b04, // ldr r9, [sp], #4
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[16] = 0x12345678;
      cpu.w[26] -= 64;
    });
    expect(c.w[18]).toBe(0x12345678);
    expect(c.w[26]).toBe(c.stackTop - 64);
  });

  test("wide byte and halfword transfers support indexed writeback", () => {
    const c = runThumb([
      0xf810, 0x1f0c, // ldrb r1, [r0, #12]!
      0xf820, 0x2d02, // strh r2, [r0, #-2]!
      0xf830, 0x3b02, // ldrh r3, [r0], #2
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[0] = cpu.stackTop - 64;
      cpu.w[4] = 0x12345678;
      mem.u8[cpu.w[0] + 12] = 0xab;
    });
    expect(c.w[2]).toBe(0xab);
    expect(c.w[6]).toBe(0x5678);
    expect(c.w[0]).toBe(c.stackTop - 52);
    const signed = runThumb([0xf9b5, 0x0008, 0xf915, 0x1002, 0xf935, 0x3f02, 0x4770], (cpu) => {
      cpu.w[10] = cpu.stackTop - 32; cpu.w[4] = 3;
      mem.st16(cpu.w[10] + 2, 0x8123); mem.st16(cpu.w[10] + 8, 0xfedc);
    });
    expect([signed.w[0], signed.w[2], signed.w[6]]).toEqual([-292, -127, -32477]);
    expect(signed.w[10]).toBe(signed.stackTop - 30);
  });

  test("wide word offsets address high registers and large fields", () => {
    const c = runThumb([
      0xf884, 0x8020, // strb.w r8, [r4, #0x20]
      0xf894, 0xa020, // ldrb.w r10, [r4, #0x20]
      0xf804, 0x800a, // strb.w r8, [r4, r10]
      0xf814, 0xb00a, // ldrb.w r11, [r4, r10]
      0xf8c4, 0x81c4, // str.w r8, [r4, #0x1c4]
      0xf8d4, 0x91c4, // ldr.w r9, [r4, #0x1c4]
      0x4770,         // bx lr
    ], (cpu) => {
      cpu.w[8] = cpu.stackTop - 0x400;
      cpu.w[16] = 0x12345678;
    });
    expect(c.w[20]).toBe(0x78);
    expect(c.w[22]).toBe(0x78);
    expect(c.w[18]).toBe(0x12345678);
  });

  test("wide literal loads align the Thumb PC", () => {
    const c = runThumb([
      0xf8df, 0x0004, // ldr.w r0, [pc, #4]
      0x4770, 0x0000, // bx lr; padding
      0x5678, 0x1234,
    ]);
    expect(c.w[0]).toBe(0x12345678);
  });

  test("the format-4 ALU ops, with flags", () => {
    const c = runThumb([
      0x43fb,       // mvns r3, r7       -> ~5, N=1
      0x4059,       // eors r1, r3
      0x4019,       // ands r1, r3
      0x4399,       // bics r1, r3
      0x431a,       // orrs r2, r3
      0x40c2,       // lsrs r2, r0
      0x4142,       // adcs r2, r0
      0x4182,       // sbcs r2, r0
      0x41c2,       // rors r2, r0
      0x4243,       // negs r3, r0
      0x4343,       // muls r3, r0
      0x4218,       // tst r0, r3
      0x42c8,       // cmn r0, r1
      0x4770,       // bx lr
    ], (c) => { c.w[0] = 3; c.w[2] = 0x0f0f; c.w[4] = 0x100; c.w[14] = 5; });
    expect(c.w[6]).toBe(-9);
    expect(c.w[2]).toBe(0);
  });
  test("compiled modified immediates, multiplies, reversals, exclusives and PC-relative loads match the interpreter", () => {
    const flags = [
      0xfab0, 0xf380, 0xf1b1, 0x1f01, // clz r3, r0; cmp.w r1, #0x10001
      0xbf8c, 0x2401, 0x2402,         // ite hi; movhi r4, #1; movls r4, #2
      0xf3ef, 0x8500, 0xf011, 0x467f, // mrs r5, apsr; ands r6, r1, #0xff000000
      0xf146, 0x0600, 0xf05f, 0x1755, // adc r6, r6, #0; movs.w r7, #0x550055
      0xf147, 0x0700, 0xf06f, 0x1801, // adc r7, r7, #0; mvn r8, #0x10001
      0xf178, 0x28ff, 0xf3ef, 0x8900, // sbcs r8, r8, #0xff00ff00; mrs r9, apsr
      0xf111, 0x4a80, 0xf3ef, 0x8b00, // adds.w r10, r1, #0x40000000; mrs r11, apsr
      0xf012, 0x4f00, 0x4770,         // tst.w r2, #0x80000000; bx lr
    ];
    const integer = [
      0xfb00, 0xf301, 0xfb03, 0x2301, // mul r3, r0, r1; mla r3, r3, r1, r2
      0xfb03, 0x1410, 0xfa32, 0xf501, // mls r4, r3, r0, r1; lsrs.w r5, r2, r1
      0xf3ef, 0x8600, 0xfa52, 0xf7a1, // mrs r6, apsr; uxtab r7, r2, r1, ror #16
      0xfa07, 0xf790, 0xfa1f, 0xf8b2, // sxtah r7, r7, r0, ror #8; uxth.w r8, r2, ror #24
      0xfa91, 0xf9a1, 0xfa91, 0xfa81, // rbit r9, r1; rev.w r10, r1
      0xfa91, 0xfc91, 0xfa52, 0xfb00, // rev16.w r12, r1; asrs.w r11, r2, r0
      0xba10, 0xba49, 0xbad2, 0x4770, // rev r0, r2; rev16 r1, r1; revsh r2, r2; bx lr
    ];
    const literal = [
      0xf20f, 0x0334, 0xf602, 0x24bc, // adr.w r3, lit; addw r4, r2, #0xabc
      0xf6a2, 0x25bc, 0xf8df, 0x602c, // subw r5, r2, #0xabc; ldr.w r6, lit + 4
      0xed9f, 0x0a09, 0xed9f, 0x1b08, // vldr s0, lit; vldr d1, lit
      0xee00, 0x0a90, 0xec42, 0x1b13, // vmov s1, r0; vmov d3, r1, r2
      0xef00, 0x2f01, 0xef20, 0x4f42, // vmax.f32 d2, d0, d1; vmin.f32 q2, q0, q1
      0xef03, 0x6f07, 0xec58, 0x7b12, // vmax.f32 d6, d3, d7; vmov r7, r8, d2
      0xec5a, 0x9b15, 0x4770, 0xbf00, // vmov r9, r10, d5; bx lr; nop
      0x0000, 0x3fc0, 0x0001, 0x7f80, // lit: 1.5, a signalling NaN
    ];
    const memory = [
      0xf000, 0xb801, 0xbf00, 0xb088, // b.w 1f; nop; 1: sub sp, #32
      0x46e8, 0xe9e8, 0x0102,         // mov r8, sp; strd r0, r1, [r8, #8]!
      0xe8d8, 0x457f, 0x3401,         // ldrexd r4, r5, [r8]; adds r4, #1
      0xe8c8, 0x4573, 0xf3bf, 0x8f2f, // strexd r3, r4, r5, [r8]; clrex
      0x3401, 0xe8c8, 0x4576,         // adds r4, #1; strexd r6, r4, r5, [r8] (monitor closed)
      0xe878, 0x4502, 0xe888, 0x0007, // ldrd r4, r5, [r8], #-8; stm.w r8, {r0, r1, r2}
      0xf108, 0x080c, 0xe938, 0x0e00, // add.w r8, r8, #12; ldmdb r8!, {r9, r10, r11}
      0xb008, 0x4770,                 // add sp, #32; bx lr
    ];
    const arm = [
      0xe24d8010, 0xe1c800f0, 0xe1b82f9f, // sub r8, sp, #16; strd r0, r1, [r8]; ldrexd r2, r3, [r8]
      0xe2822001, 0xe1a84f92, 0xf57ff01f, // add r2, r2, #1; strexd r4, r2, r3, [r8]; clrex
      0xe2822001, 0xe1a85f92, 0xe1c860d0, // add r2, r2, #1; strexd r5, r2, r3, [r8]; ldrd r6, r7, [r8]
      0xe6e09871, 0xe6ffaf31, 0xe6bfbf30, // uxtab r9, r0, r1, ror #16; rbit r10, r1; rev r11, r0
      0xed9f1b06, 0xec410b10, 0xf2012f00, // vldr d1, lit; vmov d0, r0, r1; vmax.f32 d2, d1, d0
      0xf2203f01, 0xec532b12, 0xec58cb13, // vmin.f32 d3, d0, d1; vmov r2, r3, d2; vmov r12, r8, d3
      BXLR, 0xe320f000, 0x3fc00000, 0x7f800001, // nop; lit: 1.5, a signalling NaN
    ];
    // clz of 0, an equal compare, mul overflow, shifts by 0 and by 255, NaN and signed-zero lanes
    const inputs = (r0: number, r1: number, r2: number) => (cpu: Cpu) => { cpu.w[0] = r0; cpu.w[2] = r1; cpu.w[4] = r2; };
    const cases = [inputs(0, 0x10001, 0x80000000), inputs(0x7fc00001, 0x7fffffff, 0x12345678), inputs(0x80000000, 0x80000000, 0xff)];
    for (const setup of cases.slice(1)) for (const program of [flags, integer, literal, memory]) runThumb(program, setup);
    for (const setup of cases.slice(1)) run(arm, setup);
    // flags pending from a compare when a back edge's instruction limit exits the region
    expect(runThumb([0x2901, 0xe7ff, 0x3d01, 0xd1fb, 0x4770], (cpu) => { cpu.w[10] = 3; }).w[10]).toBe(0); // cmp r1, #1; b 1f; 1: subs r5, #1; bne 0b
    const f = runThumb(flags, cases[0]);
    expect([f.w[6], f.w[8], f.w[10], f.w[12], f.w[14], f.w[18], f.cpsr >>> 28]).toEqual([32, 2, 0x60000000, 1, 0x550056, 0x20000000, 0xa]);
    runThumb(integer, cases[0]);
    const v = runThumb(literal, cases[0]);
    expect([v.w[12] >>> 0, v.w[14], v.w[16] >>> 0, v.w[18], v.w[20] >>> 0]).toEqual([0x7f800001, 0x3fc00000, 0x7f800001, 0x10001, 0x7f800001]);
    const m = runThumb(memory, cases[0]);
    expect([m.w[6], m.w[12], m.w[8], m.w[10], m.w[18], m.w[20]]).toEqual([0, 1, 1, 0x10001, 0, 0x10001]);
    const a = run(arm, cases[0]);
    expect([a.w[8], a.w[10], a.w[12], a.w[4], a.w[6] >>> 0, a.w[24], a.w[16] >>> 0]).toEqual([0, 1, 1, 0x3fc00000, 0x7f800001, 0, 0x7f800001]);
  });

  test("a window copy loop: high-register moves and adds, byte loads and stores by register", () => {
    const buf = pattern(), state = pattern();
    const c = runThumb([
      0x1c19, 0x1bda, 0x43fb, 0x185b, 0x469c, 0x44cc, 0x1c0b, 0x1c21, 0x1c3c, 0x4667, 0x46b4, 0x4646, 0x4688,
      0xe000, 0x3201, 0x2100, 0x429c, 0xd900, 0x1c31, 0x1841, 0x5c89, 0x54c1, 0x3301, 0x42ba, 0xd1f4,
      0x9a0b, 0x4666, 0x1c13, 0x4644, 0x444b, 0x6263, 0x4770,
    ], (c) => {
      c.w[0] = buf; c.w[6] = 0x100; c.w[14] = 5; c.w[18] = 12; c.w[12] = 0x800; c.w[8] = state;
      c.w[26] -= 0x100; mem.st32(c.w[26] + 0x2c, 0x100);
    });
    expect(c.w[6]).toBe(0x10c);
    expect(mem.ld32(state + 0x24)).toBe(0x10c);
    expect(mem.u8[buf + 0x10b]).toBe(mem.u8[buf + 0x106]);
  });
});

describe("arm block coverage", () => {
  // An interpreted block used to run past the end of its page, and cover() masks both ends to the
  // page, so the range it was handed ran backwards and marked nothing -- not even the words on the
  // page it started on. code_write only drops a page for a word that is marked.
  test("a block that reaches the next page still marks the words it ran", () => {
    const nop = 0xe1a00000, bxLr = 0xe12fff1e;
    const at = mem.reserve(0x2000, 0x1000);
    for (let i = 0; i < 4; i++) mem.u32[((at + 0xff0) >>> 2) + i] = nop;
    mem.u32[(at + 0x1000) >>> 2] = bxLr;
    execute(at + 0xff0, () => {});
    expect(core.code_write(at + 0xff0, 4)).toBe(1);
  });
});
