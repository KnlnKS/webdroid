import { beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { Cpu, setA64 } from "./cpu";
import { core, JIT_HEAT } from "./core";
import { pattern, sweep } from "./a64.testkit";
import { mainThread } from "../jvm/natives/jlang";
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
  while (c.runSlice(1000) !== 2) { /* spin */ }
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
  test("mul/umull/smull", () => {
    const c = run([
      0xe3e00000,   // mvn r0, #0  (0xffffffff)
      0xe3a01002,   // mov r1, #2
      0xe0832190,   // umull r2, r3, r0, r1  -> 0x1_fffffffe
      0xe0c54190,   // smull r4, r5, r0, r1  -> -2 (r4=-2, r5=-1)
      0xe0060190,   // mul r6, r0, r1        -> -2
      BXLR]);
    expect(c.w[4]).toBe(-2); expect(c.w[6]).toBe(1);
    expect(c.w[8]).toBe(-2); expect(c.w[10]).toBe(-1);
    expect(c.w[12]).toBe(-2);
  });
  test("clz, mrs/msr", () => {
    const c = run([
      0xe3a00001,   // mov r0, #1
      0xe16f1f10,   // clz r1, r0 -> 31
      0xe3a02000,   // mov r2, #0 (doesn't set flags)
      0xe3520000,   // cmp r2, #0 -> Z=1 C=1
      0xe10f3000,   // mrs r3, cpsr
      BXLR]);
    expect(c.w[2]).toBe(31);
    expect(c.w[6] >>> 30).toBe(1); // Z set, N clear
    expect((c.w[6] >>> 29) & 1).toBe(1);
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
    for (const execute of [
      () => run([0xf4e0b8bf, 0xf4c1b4cd, 0xf4e1cc22, BXLR], setup),
      () => runThumb([0xf9e0, 0xb8bf, 0xf9c1, 0xb4cd, 0xf9e1, 0xcc22, 0x4770], setup),
    ]) {
      const lanes = execute();
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
  });
  test("NEON arithmetic shares D/Q lanes in ARM and Thumb encodings", () => {
    const setup = (cpu: Cpu) => {
      const floats = new Float32Array(cpu.si.buffer, cpu.si.byteOffset, cpu.si.length);
      floats.set([1, 2, 3, 4, 5, 6, 7, 8], 8);
      cpu.si.set([0x00050007, 0x00010003, 0x00020004, 0x00060008], 20);
      cpu.si.set([0x03020100, 0x07060504], 2);
      cpu.w[2] = 0x12345678;
    };
    for (const execute of [
      () => run([0xf2042d46, 0xf31a980b, 0xf30aa15a, 0xf2b11302, 0xee821b30, BXLR], setup),
      () => runThumb([0xef04, 0x2d46, 0xff1a, 0x980b, 0xff0a, 0xa15a, 0xefb1, 0x1302, 0xee82, 0x1b30, 0x4770], setup),
    ]) {
      const c = execute();
      expect(Array.from(c.si.slice(2, 8))).toEqual([0x06050403, -1073741817, 0x56785678, 0x56785678, 0x41200000, 0x41400000]);
      expect(Array.from(c.si.slice(18, 24))).toEqual([0x00030003, -262149, 0, 0, 0, 0]);
    }
    const accumulated = run([0xf26a8df2, BXLR], (cpu) => {
      cpu.s.set([1, 8, -1, 0], 48);
      cpu.s.set([1 + 2 ** -23, 2, -2, 0], 52);
      cpu.s.set([1 - 2 ** -23, 3, 4, 1], 36);
    });
    expect(Array.from(accumulated.s.slice(48, 52))).toEqual([0, 2, 7, 0]);
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
    expect([c.w[4], c.w[6]]).toEqual([-2, 1]);
    expect([c.w[8], c.w[10]]).toEqual([-2, -1]);
    expect([c.w[12], c.w[14]]).toEqual([11, 1]);
    expect([c.w[22], c.w[24]]).toEqual([3, 0]);
    expect(c.cpsr >>> 28).toBe(0xa);
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
    const multiple = runThumb([
      0x4280,             // cmp r0, r0
      0xbf01,             // itttt eq
      0x2001, 0x2102,     // moveq r0, #1; moveq r1, #2
      0x2203, 0x2304,     // moveq r2, #3; moveq r3, #4
      0x4770,
    ]);
    expect([multiple.w[0], multiple.w[2], multiple.w[4], multiple.w[6]]).toEqual([1, 2, 3, 4]);
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

  test("wide bit reversal and leading-zero count preserve their source", () => {
    const c = runThumb([
      0xfab2, 0xf082, // clz r0, r2
      0xfab3, 0xf183, // clz r1, r3
      0xfa92, 0xf4a2, // rbit r4, r2
      0xfa94, 0xf5a4, // rbit r5, r4
      0x4770,         // bx lr
    ], (cpu) => { cpu.w[4] = 0x0000ffff; cpu.w[6] = 0; });
    expect(c.w[0]).toBe(16);
    expect(c.w[2]).toBe(32);
    expect(c.w[8] >>> 0).toBe(0xffff0000);
    expect(c.w[10]).toBe(c.w[4]);
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
