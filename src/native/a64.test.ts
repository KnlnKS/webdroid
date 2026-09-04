import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { Cpu, setA64 } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { RET_SENTINEL } from "./abi";

// Encodings come from `clang -target aarch64-linux-gnu`, never hand-derived; the mnemonic beside
// each word is objdump's own.
function run(words: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  const at = mem.reserve((words.length * 4 + 0xfff) & ~0xfff, 0x1000);
  for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
  const c = new Cpu(mainThread, "test");
  c.ensureStack();
  setup(c);
  c.r[30] = RET_SENTINEL;
  c.setPc(at);
  while (c.runSlice(10000) !== 2) { /* spin */ }
  return c;
}
const RET = 0xd65f03c0;

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

describe("a64 decoder", () => {
  test("a W write zero-extends into its X register", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0x2a0003e1,   // mov w1, w0
      0x11000402,   // add w2, w0, #1
      0xaa0003e3,   // mov x3, x0
      RET]);
    expect([c.r[0], c.h[0]]).toEqual([-1, -1]);
    expect([c.r[1], c.h[1]]).toEqual([-1, 0]);
    expect([c.r[2], c.h[2]]).toEqual([0, 0]);
    expect([c.r[3], c.h[3]]).toEqual([-1, -1]);
  });

  test("logical immediates decode through DecodeBitMasks", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0x92009c04,   // and x4, x0, #0xff00ff00ff00ff
      0x3200cfe5,   // mov w5, #0xf0f0f0f
      0xf2703c06,   // ands x6, x0, #0xffff0000
      RET]);
    expect([c.r[4], c.h[4]]).toEqual([0x00ff00ff, 0x00ff00ff]);
    expect([c.r[5], c.h[5]]).toEqual([0x0f0f0f0f, 0]);
    expect([c.r[6], c.h[6]]).toEqual([-65536, 0]);
  });

  test("bitfield: the aliases every compiler emits", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0x93407c07,   // sxtw x7, w0
      0xd3485c08,   // ubfx x8, x0, #8, #16
      0xd3585c09,   // lsl  x9, x0, #40
      0xd368fc0a,   // lsr  x10, x0, #40
      0x9368fc0b,   // asr  x11, x0, #40
      0x93442c0c,   // sbfx x12, x0, #4, #8
      0x53001c0d,   // uxtb w13, w0
      RET]);
    expect([c.r[7], c.h[7]]).toEqual([-1, -1]);
    expect([c.r[8], c.h[8]]).toEqual([0xffff, 0]);
    expect([c.r[9], c.h[9]]).toEqual([0, -256]);
    expect([c.r[10], c.h[10]]).toEqual([0xffffff, 0]);
    expect([c.r[11], c.h[11]]).toEqual([-1, -1]);
    expect([c.r[12], c.h[12]]).toEqual([-1, -1]);
    expect([c.r[13], c.h[13]]).toEqual([255, 0]);
  });

  test("shifted register operands carry across the halves", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0x8b00100e,   // add x14, x0, x0, lsl #4
      0xcb4083ef,   // neg x15, x0, lsr #32
      RET]);
    expect([c.r[14], c.h[14]]).toEqual([-17, -1]);
    expect([c.r[15], c.h[15]]).toEqual([1, -1]);
  });

  test("cmp sets NZCV over 64 bits, and the conditional selects read it", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0xf100001f,   // cmp x0, #0
      0x9a9f1010,   // csel  x16, x0, xzr, ne
      0x1a9f17f1,   // cset  w17, eq
      0x9a9f1412,   // csinc x18, x0, xzr, ne
      RET]);
    expect([c.n, c.z, c.c, c.v]).toEqual([1, 0, 1, 0]);
    expect([c.r[16], c.h[16]]).toEqual([-1, -1]);
    expect(c.r[17]).toBe(0);
    expect([c.r[18], c.h[18]]).toEqual([-1, -1]);
  });

  test("multiply, divide and the register-amount shifts", () => {
    const c = run([
      0xd28000f3,   // mov x19, #7
      0xd2800074,   // mov x20, #3
      0x9b147e75,   // mul   x21, x19, x20
      0x9ad40a76,   // udiv  x22, x19, x20
      0x9ad40e77,   // sdiv  x23, x19, x20
      0x9b547e78,   // smulh x24, x19, x20
      0x9b144e79,   // madd  x25, x19, x20, x19
      0x9ad4227a,   // lsl   x26, x19, x20
      0x9ad42e7b,   // ror   x27, x19, x20
      RET]);
    expect(c.r[21]).toBe(21);
    expect(c.r[22]).toBe(2);
    expect(c.r[23]).toBe(2);
    expect([c.r[24], c.h[24]]).toEqual([0, 0]);
    expect(c.r[25]).toBe(28);
    expect(c.r[26]).toBe(56);
    expect([c.r[27], c.h[27]]).toEqual([0, -536870912 | 0]);
  });

  test("a 64-bit add carries into the high half, and adds flag it", () => {
    const c = run([
      0x92800000,   // mov  x0, #-1        (0xffff_ffff_ffff_ffff)
      0x91000401,   // add  x1, x0, #1     -> 0, carry out
      0xb1000402,   // adds x2, x0, #1     -> 0, Z=1 C=1 V=0
      RET]);
    expect([c.r[1], c.h[1]]).toEqual([0, 0]);
    expect([c.r[2], c.h[2]]).toEqual([0, 0]);
    expect([c.n, c.z, c.c, c.v]).toEqual([0, 1, 1, 0]);
  });

  test("loads and stores, including pre/post index and pairs", () => {
    const buf = mem.reserve(0x1000, 0x1000);
    const c = run([
      0xd2824680,   // mov  x0, #0x1234
      0xd2800081,   // mov  x1, #4
      0x91000422,   // add  x2, x1, #1
      0xf9000520,   // str  x0, [x9, #8]
      0xf9400523,   // ldr  x3, [x9, #8]
      0xb9000921,   // str  w1, [x9, #8]
      0xb9400924,   // ldr  w4, [x9, #8]
      0x39002521,   // strb w1, [x9, #9]
      0x39402525,   // ldrb w5, [x9, #9]
      0xa9010921,   // stp  x1, x2, [x9, #16]
      0xa9411d26,   // ldp  x6, x7, [x9, #16]
      0xf8020d21,   // str  x1, [x9, #32]!
      0xf85e0528,   // ldr  x8, [x9], #-32
      RET], (c) => { c.r[9] = buf; });
    expect(c.r[3]).toBe(0x1234);
    expect(c.r[4]).toBe(4);
    expect(c.r[5]).toBe(4);
    expect(c.r[6]).toBe(4);
    expect(c.r[7]).toBe(5);
    expect(c.r[8]).toBe(4);
    expect(c.r[9]).toBe(buf);
  });

  test("branches: b.cond, cbz, tbz and the fallthrough", () => {
    const c = run([
      0xd2800000,   // mov  x0, #0
      0xb4000060,   // cbz  x0, +12
      0xd2800020,   // mov  x0, #1        (skipped)
      0xd2800040,   // mov  x0, #2        (skipped)
      0xd2800100,   // mov  x0, #8
      0xf100201f,   // cmp  x0, #8
      0x54000060,   // b.eq +12
      0xd2800021,   // mov  x1, #1        (skipped)
      0xd2800041,   // mov  x1, #2        (skipped)
      0xd2800061,   // mov  x1, #3
      0xd2800002,   // mov  x2, #0
      0x37000042,   // tbnz w2, #0, +8    (not taken: bit 0 is clear)
      0xd2800082,   // mov  x2, #4
      RET]);
    expect(c.r[0]).toBe(8);
    expect(c.r[1]).toBe(3);
    expect(c.r[2]).toBe(4);
  });
});

describe("a64 decoder: hints, atomics, the REV family and system registers", () => {
  test("rev, rev16, rev32, rbit and cls, both widths, rd may be rn", () => {
    const c = run([
      0xd299bde0,   // mov x0, #0xcdef
      0xf2b13560,   // movk x0, #0x89ab, lsl #16
      0xf2c8ace0,   // movk x0, #0x4567, lsl #32
      0xf2e02460,   // movk x0, #0x123, lsl #48
      0x5ac00801,   // rev w1, w0
      0xdac00c02,   // rev x2, x0
      0x5ac00403,   // rev16 w3, w0
      0xdac00404,   // rev16 x4, x0
      0xdac00805,   // rev32 x5, x0
      0x5ac00006,   // rbit w6, w0
      0xdac00007,   // rbit x7, x0
      0x5ac01408,   // cls w8, w0
      0xdac01409,   // cls x9, x0
      0x12801fea,   // mov w10, #-256
      0x5ac0154b,   // cls w11, w10
      0xaa0003ec,   // mov x12, x0
      0xdac00d8c,   // rev x12, x12
      0xdac0000d,   // rbit x13, x0
      0xdac001ad,   // rbit x13, x13
      RET]);
    expect([c.r[1], c.h[1]]).toEqual([-271733879, 0]);
    expect([c.r[2], c.h[2]]).toEqual([1732584193, -271733879]);
    expect([c.r[3], c.h[3]]).toEqual([-1417023539, 0]);
    expect([c.r[4], c.h[4]]).toEqual([-1417023539, 587294533]);
    expect([c.r[5], c.h[5]]).toEqual([-271733879, 1732584193]);
    expect([c.r[6], c.h[6]]).toEqual([-139209327, 0]);
    expect([c.r[7], c.h[7]]).toEqual([-425540480, -139209327]);
    expect([c.r[8], c.r[9], c.r[11]]).toEqual([0, 6, 23]);
    expect([c.r[12], c.h[12]]).toEqual([1732584193, -271733879]);
    expect([c.r[13], c.h[13]]).toEqual([c.r[0], c.h[0]]);
  });

  test("system registers: NZCV round-trips, FPCR is kept, the ID space reads as nothing", () => {
    const c = run([
      0x92800000,   // mov x0, #-1
      0xf100001f,   // cmp x0, #0
      0xd53b4201,   // mrs x1, NZCV
      0xd2a80002,   // mov x2, #0x40000000
      0xd51b4202,   // msr NZCV, x2
      0x1a9f17ec,   // cset w12, eq
      0xd53b4403,   // mrs x3, FPCR
      0xd2a02004,   // mov x4, #0x1000000
      0xd51b4404,   // msr FPCR, x4
      0xd53b4405,   // mrs x5, FPCR
      0xd53b00e6,   // mrs x6, DCZID_EL0
      0xd53b0027,   // mrs x7, CTR_EL0
      0xd53be008,   // mrs x8, CNTFRQ_EL0
      0xd5380609,   // mrs x9, ID_AA64ISAR0_EL1
      0xd538000a,   // mrs x10, MIDR_EL1
      0xd53be04b,   // mrs x11, CNTVCT_EL0
      0xd503413f,   // msr SSBS, #1
      0xd50b7e20,   // dc civac, x0
      0xd50b7520,   // ic ivau, x0
      0xd51bd044,   // msr TPIDR_EL0, x4
      0xd53bd04d,   // mrs x13, TPIDR_EL0
      RET]);
    expect([c.r[1], c.h[1]]).toEqual([-1610612736, 0]);
    expect(c.r[12]).toBe(1);
    expect([c.r[3], c.r[5]]).toEqual([0, 0x1000000]);
    expect([c.r[6], c.r[7], c.r[8], c.r[9], c.r[10]]).toEqual([0x10, 0x8444c004 | 0, 19200000, 0, 0]);
    expect(c.h[11]).toBeGreaterThanOrEqual(0);
    expect(c.r[13]).toBe(0x1000000);
  });
});
