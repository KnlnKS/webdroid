import { beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { Cpu, setA64 } from "./cpu";
import { sweep } from "./a64.testkit";
import { mainThread } from "../jvm/natives/jlang";
import { RET_SENTINEL } from "./abi";

let shared: Cpu | null = null;
function execute(at: number, setup: (c: Cpu) => void): Cpu {
  const c = (shared ??= new Cpu(mainThread, "test"));
  c.w.fill(0); c.cpsr = 0;
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
const BXLR = 0xe12fff1e;

beforeAll(() => setA64(false));

describe("arm decoder", () => {
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
      0xe1a03110,   // mov r3, r0, lsl r1  -> 16
      BXLR]);
    expect(c.w[4]).toBe(0); expect(c.w[6]).toBe(16);
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
      BXLR], (c) => { c.w[26] -= 64; });
    expect(c.w[6]).toBe(1); expect(c.w[8]).toBe(2); expect(c.w[10]).toBe(3);
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
