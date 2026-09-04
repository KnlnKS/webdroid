import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { setA64 } from "./cpu";
import { run, RET } from "./a64.testkit";

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

  test("the multiply family: widening, high halves, and the subtracting forms", () => {
    // umull x2,w0,w1; smull x3; umaddl x4,w0,w1,x5; smaddl x6; umsubl x7; smsubl x8; umulh x9,x0,x1; mul x10; mneg x11; mul w12; msub x13,x0,x1,x5
    const W = [0x9ba17c02, 0x9b217c03, 0x9ba11404, 0x9b211406, 0x9ba19407, 0x9b219408, 0x9bc17c09, 0x9b017c0a, 0x9b01fc0b, 0x1b017c0c, 0x9b01940d, RET];
    const x = (c: { r: Int32Array; h: Int32Array }, i: number) => (BigInt(c.h[i] >>> 0) << 32n) | BigInt(c.r[i] >>> 0);
    const set = (c: { r: Int32Array; h: Int32Array }, i: number, v: bigint) => { c.r[i] = Number(v & 0xffffffffn) | 0; c.h[i] = Number((v >> 32n) & 0xffffffffn) | 0; };
    const U = (v: bigint) => BigInt.asUintN(64, v), U32 = (v: bigint) => BigInt.asUintN(32, v), S32 = (v: bigint) => BigInt.asIntN(32, v);
    for (const [a, b, acc] of [[0x1050n, 0x2492493n, 0x123n], [0xffffffffn, 0xffffffffn, 0n], [0x80000000n, 2n, 0x10n], [0x1_00000007n, 0xf_00000009n, 0x5n], [0x7fffffffn, 0x80000001n, 0xffffffffffffffffn]] as [bigint, bigint, bigint][]) {
      const c = run(W, (c) => { set(c, 0, a); set(c, 1, b); set(c, 5, acc); });
      const ua = U32(a), ub = U32(b), sa = S32(ua), sb = S32(ub);
      expect(x(c, 2)).toBe(ua * ub); expect(x(c, 3)).toBe(U(sa * sb));
      expect(x(c, 4)).toBe(U(acc + ua * ub)); expect(x(c, 6)).toBe(U(acc + sa * sb));
      expect(x(c, 7)).toBe(U(acc - ua * ub)); expect(x(c, 8)).toBe(U(acc - sa * sb));
      expect(x(c, 9)).toBe((U(a) * U(b)) >> 64n); expect(x(c, 10)).toBe(U(a * b)); expect(x(c, 11)).toBe(U(-(a * b)));
      expect(c.r[12] >>> 0).toBe(Number(U32(a * b))); expect(x(c, 13)).toBe(U(acc - a * b));
    }
  });
  test("ROR/EXTR into one of their own sources keep the high half", () => {
    // ror x8,x8,#9; extr x10,x11,x12,#9; extr x13,x11,x12,#40; ror w14,w15,#5; extr w16,w17,w18,#7; ror x19,x11,#32; ror x20,x11,#0
    const W = [0x93c82508, 0x93cc256a, 0x93cca16d, 0x138f15ee, 0x13921e30, 0x93cb8173, 0x93cb0174, RET];
    const x = (c: { r: Int32Array; h: Int32Array }, i: number) => (BigInt(c.h[i] >>> 0) << 32n) | BigInt(c.r[i] >>> 0);
    const set = (c: { r: Int32Array; h: Int32Array }, i: number, v: bigint) => { c.r[i] = Number(v & 0xffffffffn) | 0; c.h[i] = Number((v >> 32n) & 0xffffffffn) | 0; };
    const ror = (v: bigint, s: bigint, w = 64n) => BigInt.asUintN(Number(w), (v >> s) | (v << (w - s)));
    const extr = (hi: bigint, lo: bigint, s: bigint, w = 64n) => BigInt.asUintN(Number(w), ((hi << w) | lo) >> s);
    const a = 0x072884f61000n, b = 0x1122334455667788n, d = 0x99aabbccddeeff00n;
    const c = run(W, (c) => { set(c, 8, a); set(c, 11, b); set(c, 12, d); c.r[15] = 0x80000001 | 0; c.r[17] = 0x12345678; c.r[18] = 0x9abcdef0 | 0; });
    expect(x(c, 8)).toBe(ror(a, 9n));
    expect(x(c, 10)).toBe(extr(b, d, 9n));
    expect(x(c, 13)).toBe(extr(b, d, 40n));
    expect(c.r[14] >>> 0).toBe(Number(ror(0x80000001n, 5n, 32n)));
    expect(c.r[16] >>> 0).toBe(Number(extr(0x12345678n, 0x9abcdef0n, 7n, 32n)));
    expect(x(c, 19)).toBe(ror(b, 32n));
    expect(x(c, 20)).toBe(b);
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
    expect(c.r[9] >>> 0).toBe(buf);
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
  test("PRFM in every form is a hint, not a store", () => {
    const buf = mem.reserve(0x1000, 0x1000);
    const c = run([
      0xd2824680,   // mov x0, #0x1234
      0xd2800081,   // mov x1, #4
      0xf9000120,   // str x0, [x9]
      0xf9800121,   // prfm pldl1strm, [x9]
      0xf9800921,   // prfm pldl1strm, [x9, #0x10]
      0xf8808121,   // prfum pldl1strm, [x9, #0x8]
      0xf8a16921,   // prfm pldl1strm, [x9, x1]
      0xd8000001,   // prfm pldl1strm, .
      0xf9400123,   // ldr x3, [x9]
      RET], (c) => { c.r[9] = buf; });
    expect(c.r[3]).toBe(0x1234);
    expect(mem.ld32(buf + 8)).toBe(0);
    expect(mem.ld32(buf + 16)).toBe(0);
  });

  test("LSE atomics read-modify-write the word and return the old value", () => {
    const buf = mem.reserve(0x1000, 0x1000);
    const c = run([
      0x528000a1,   // mov w1, #5
      0x5280014d,   // mov w13, #10
      0xb900012d,   // str w13, [x9]
      0xb8210122,   // ldadd w1, w2, [x9]
      0xb8211123,   // ldclr w1, w3, [x9]
      0xb8212134,   // ldeor w1, w20, [x9]
      0xb8212134,   // ldeor w1, w20, [x9]
      0xb8213135,   // ldset w1, w21, [x9]
      0x12800004,   // mov w4, #-1
      0xb8244125,   // ldsmax w4, w5, [x9]
      0xb8246126,   // ldumax w4, w6, [x9]
      0xb8218127,   // swp w1, w7, [x9]
      0xb821013f,   // stadd w1, [x9]
      0x38e10128,   // ldaddalb w1, w8, [x9]
      0x9100212c,   // add x12, x9, #8
      0xd280002d,   // mov x13, #1
      0xf900018d,   // str x13, [x12]
      0xb2407fea,   // mov x10, #0xffffffff
      0xf8ea018b,   // ldaddal x10, x11, [x12]
      0xf940018e,   // ldr x14, [x12]
      0x528009af,   // mov w15, #77
      0x88a17d2f,   // cas w1, w15, [x9]       (w1 = 5 does not match 15)
      0x528001e1,   // mov w1, #15
      0x88a17d2f,   // cas w1, w15, [x9]       (matches: stores 77)
      0xb9400136,   // ldr w22, [x9]
      0xf900058d,   // str x13, [x12, #8]
      0xaa0e03f0,   // mov x16, x14
      0xd2800031,   // mov x17, #1
      0xd2800052,   // mov x18, #2
      0xd2800073,   // mov x19, #3
      0x48307d92,   // casp x16, x17, x18, x19, [x12]
      0xf9400197,   // ldr x23, [x12]
      0xf9400598,   // ldr x24, [x12, #8]
      0xb8bfc139,   // ldapr w25, [x9]
      RET], (c) => { c.r[9] = buf; });
    expect([c.r[2], c.r[3], c.r[20], c.r[21], c.r[5], c.r[6], c.r[7], c.r[8]]).toEqual([10, 15, 15, 10, 15, 15, -1, 10]);
    expect([c.r[11], c.h[11], c.r[14], c.h[14]]).toEqual([1, 0, 0, 1]);
    expect([c.r[1], c.r[22]]).toEqual([15, 77]);
    expect([c.r[16], c.h[16], c.r[17], c.r[23], c.r[24], c.r[25]]).toEqual([0, 1, 1, 2, 3, 77]);
  });

  test("a store-exclusive succeeds only after a load-exclusive; pairs and clrex", () => {
    const buf = mem.reserve(0x1000, 0x1000);
    const c = run([
      0x5280014d,   // mov w13, #10
      0xb900012d,   // str w13, [x9]
      0x885f7d21,   // ldxr w1, [x9]
      0x11000421,   // add w1, w1, #1
      0x88027d21,   // stxr w2, w1, [x9]
      0x88037d21,   // stxr w3, w1, [x9]       (no monitor: fails)
      0xb940012a,   // ldr w10, [x9]
      0x9100212c,   // add x12, x9, #8
      0xd280002d,   // mov x13, #1
      0xd280004e,   // mov x14, #2
      0xa900398d,   // stp x13, x14, [x12]
      0xc87f9584,   // ldaxp x4, x5, [x12]
      0xc8269185,   // stlxp w6, x5, x4, [x12]
      0xa940418f,   // ldp x15, x16, [x12]
      0x885ffd21,   // ldaxr w1, [x9]
      0xd5033f5f,   // clrex
      0x8807fd21,   // stlxr w7, w1, [x9]      (cleared: fails)
      0x88dffd31,   // ldar w17, [x9]
      0x889ffd2e,   // stlr w14, [x9]
      0xb9400132,   // ldr w18, [x9]
      RET], (c) => { c.r[9] = buf; });
    expect([c.r[2], c.r[3], c.r[10]]).toEqual([0, 1, 11]);
    expect([c.r[4], c.r[5], c.r[6], c.r[15], c.r[16]]).toEqual([1, 2, 0, 2, 1]);
    expect([c.r[7], c.r[17], c.r[18]]).toEqual([1, 11, 2]);
    expect(c.excl).toBe(0);
  });

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
