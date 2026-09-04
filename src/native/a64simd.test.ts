import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mem } from "./mem";
import { setA64 } from "./cpu";
import { run, RET, pattern } from "./a64.testkit";

// Encodings from `clang -target aarch64-linux-gnu`, mnemonics from objdump. Lanes are set and read
// through the integer views: a move must be bit-exact, and the float views cannot say so.
beforeAll(() => setA64(true));
afterAll(() => setA64(false));

const I = (c: { si: Int32Array }, v: number) => [c.si[4 * v], c.si[4 * v + 1], c.si[4 * v + 2], c.si[4 * v + 3]];

describe("a64 simd: memory", () => {
  test("every width, addressing mode, pair, structure and replicating load", () => {
    const buf = pattern();
    const c = run([
      0x3dc00120,   // ldr q0, [x9]
      0x3dc00521,   // ldr q1, [x9, #0x10]
      0x3d800921,   // str q1, [x9, #0x20]
      0xfd400522,   // ldr d2, [x9, #0x8]
      0xbd400523,   // ldr s3, [x9, #0x4]
      0x7d400524,   // ldr h4, [x9, #0x2]
      0x3d400525,   // ldr b5, [x9, #0x1]
      0xfd001922,   // str d2, [x9, #0x30]
      0xbd003923,   // str s3, [x9, #0x38]
      0x7d007924,   // str h4, [x9, #0x3c]
      0x3d00f925,   // str b5, [x9, #0x3e]
      0x3cdf0126,   // ldur q6, [x9, #-0x10]
      0x3c840126,   // stur q6, [x9, #0x40]
      0xad402127,   // ldp q7, q8, [x9]
      0xad02a127,   // stp q7, q8, [x9, #0x50]
      0x6d40a929,   // ldp d9, d10, [x9, #0x8]
      0x2d0e0d23,   // stp s3, s3, [x9, #0x70]
      0x3ce1692b,   // ldr q11, [x9, x1]
      0xfc61792c,   // ldr d12, [x9, x1, lsl #3]
      0x3cc10d2d,   // ldr q13, [x9, #0x10]!
      0x3cdf052e,   // ldr q14, [x9], #-0x10
      0x4c40792f,   // ld1 { v15.4s }, [x9]
      0x4c40a130,   // ld1 { v16.16b, v17.16b }, [x9]
      0x4c9f792f,   // st1 { v15.4s }, [x9], #16
      0x0c407932,   // ld1 { v18.2s }, [x9]
      0x4d40c933,   // ld1r { v19.4s }, [x9]
      0x4d409134,   // ld1 { v20.s }[3], [x9]
      0x4d401d35,   // ld1 { v21.b }[15], [x9]
      0x4d9f9134,   // st1 { v20.s }[3], [x9], #4
      0x4cdf8936,   // ld2 { v22.4s, v23.4s }, [x9], #32
      0x0c408938,   // ld2 { v24.2s, v25.2s }, [x9]
      0x4c818936,   // st2 { v22.4s, v23.4s }, [x9], x1
      0x4c40493a,   // ld3 { v26.4s, v27.4s, v28.4s }, [x9]
      0x4c40013d,   // ld4 { v29.16b, v30.16b, v31.16b, v0.16b }, [x9]
      0x0d40c923,   // ld1r { v3.2s }, [x9]
      0x0d609124,   // ld2 { v4.s, v5.s }[1], [x9]
      0x4d008526,   // st1 { v6.d }[1], [x9]
      0x9c000041,   // ldr q1, +8   (the words at RET)
      0x5c000042,   // ldr d2, +8   (the zero words past RET)
      RET], (c) => { c.r[9] = buf + 256; c.r[1] = 24; });
    const w = (o: number) => mem.ld32(buf + 256 + o);
    expect(I(c, 0)).toEqual([185010975, 454497039, 2064058143, -1954053249]);
    expect(I(c, 1)).toEqual([RET | 0, 0, 0, 0]);
    expect(I(c, 2)).toEqual([0, 0, 0, 0]);
    expect(I(c, 3)).toEqual([522067228, 522067228, 0, 0]);
    expect(I(c, 4)).toEqual([770, 522067228, 0, 0]);
    expect(I(c, 5)).toEqual([1, 185207048, 0, 0]);
    expect(I(c, 6)).toEqual([-202182160, -134810124, -67438088, -66052]);
    expect(I(c, 7)).toEqual([50462976, 117835012, 185207048, 252579084]);
    expect(I(c, 8)).toEqual([319951120, 387323156, 454695192, 522067228]);
    expect(I(c, 9)).toEqual([185207048, 252579084, 0, 0]);
    expect(I(c, 10)).toEqual([319951120, 387323156, 0, 0]);
    expect(I(c, 11)).toEqual([454695192, 522067228, 319951120, 387323156]);
    expect(I(c, 12)).toEqual([-1010646592, -943274556, 0, 0]);
    expect(I(c, 13)).toEqual([319951120, 387323156, 454695192, 522067228]);
    expect(I(c, 14)).toEqual([319951120, 387323156, 454695192, 522067228]);
    expect(I(c, 15)).toEqual([50462976, 117835012, 185207048, 252579084]);
    expect(I(c, 16)).toEqual([50462976, 117835012, 185207048, 252579084]);
    expect(I(c, 17)).toEqual([319951120, 387323156, 454695192, 522067228]);
    expect(I(c, 18)).toEqual([319951120, 387323156, 0, 0]);
    expect(I(c, 19)).toEqual([319951120, 319951120, 319951120, 319951120]);
    expect(I(c, 20)).toEqual([0, 0, 0, 319951120]);
    expect(I(c, 21)).toEqual([0, 0, 0, 268435456]);
    expect(I(c, 22)).toEqual([387323156, 522067228, 387323156, 522067228]);
    expect(I(c, 23)).toEqual([454695192, 319951120, 454695192, 185207048]);
    expect(I(c, 24)).toEqual([252579084, 1057030914, 0, 0]);
    expect(I(c, 25)).toEqual([117835012, -202182160, 0, 0]);
    expect(I(c, 26)).toEqual([522067228, 185207048, 387323156, 117835012]);
    expect(I(c, 27)).toEqual([185207048, 252579084, 454695192, 117835012]);
    expect(I(c, 28)).toEqual([117835012, 319951120, 522067228, 2071624056]);
    expect(I(c, 29)).toEqual([134481948, 403968012, 2013529116, -2004582276]);
    expect(I(c, 30)).toEqual([151324957, 420811021, 2030372125, -1987739267]);
    expect(I(c, 31)).toEqual([168167966, 437654030, 2047215134, -1970896258]);
    expect([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map((k) => w(4 * k)))
      .toEqual([319951120, 387323156, 454695192, 522067228, 185207048, 387323156, 454695192, 522067228, 319951120, 387323156, 454695192, -67438088, -66052, 117835012, 185207048, 252579084, 319951120, 387323156, 454695192, 522067228, 117835012, 117835012, 2071624056, 2138996092]);
    expect(c.r[9]).toBe(buf + 332);
    expect([w(76), w(80)]).toEqual([-67438088, -66052]);
  });
});

describe("a64 simd: immediates, copies, permutes and bitwise ops", () => {
  test("modified immediates expand per cmode, including the byte mask and float forms", () => {
    const c = run([
      0x6f00e400,   // movi v0.2d, #0
      0x4f0307e1,   // movi v1.4s, #0x7f
      0x0f0367e2,   // movi v2.2s, #0x7f, lsl #24
      0x6f0327e3,   // mvni v3.4s, #0x7f, lsl #8
      0x4f00a644,   // movi v4.8h, #0x12, lsl #8
      0x4f05e565,   // movi v5.16b, #0xab
      0x6f05e4a6,   // movi v6.2d, #0xff00ff0000ff00ff
      0x2f07e607,   // movi d7, #0xffffffff00000000
      0x4f00c648,   // movi v8.4s, #0x12, msl #8
      0x6f00d649,   // mvni v9.4s, #0x12, msl #16
      0x4f07f60a,   // fmov v10.4s, #-1.0
      0x6f00f48b,   // fmov v11.2d, #2.5
      0x0f03f40c,   // fmov v12.2s, #0.5
      0x4f047401,   // orr v1.4s, #0x80, lsl #24
      0x6f009421,   // bic v1.8h, #0x1
      0x0f00e4ad,   // movi v13.8b, #0x5
      RET], (c) => { c.si.fill(-1, 0, 128); });
    expect(I(c, 0)).toEqual([0, 0, 0, 0]);
    expect(I(c, 1)).toEqual([0x8000007e | 0, 0x8000007e | 0, 0x8000007e | 0, 0x8000007e | 0]);
    expect(I(c, 2)).toEqual([0x7f000000, 0x7f000000, 0, 0]);
    expect(I(c, 3)).toEqual([-32513, -32513, -32513, -32513]);
    expect(I(c, 4)).toEqual([0x12001200, 0x12001200, 0x12001200, 0x12001200]);
    expect(I(c, 5)).toEqual([0xabababab | 0, 0xabababab | 0, 0xabababab | 0, 0xabababab | 0]);
    expect(I(c, 6)).toEqual([0x00ff00ff, 0xff00ff00 | 0, 0x00ff00ff, 0xff00ff00 | 0]);
    expect(I(c, 7)).toEqual([0, -1, 0, 0]);
    expect(I(c, 8)).toEqual([0x12ff, 0x12ff, 0x12ff, 0x12ff]);
    expect(I(c, 9)).toEqual([0xffed0000 | 0, 0xffed0000 | 0, 0xffed0000 | 0, 0xffed0000 | 0]);
    expect(I(c, 10)).toEqual([0xbf800000 | 0, 0xbf800000 | 0, 0xbf800000 | 0, 0xbf800000 | 0]);
    expect(I(c, 11)).toEqual([0, 0x40040000, 0, 0x40040000]);
    expect(I(c, 12)).toEqual([0x3f000000, 0x3f000000, 0, 0]);
    expect(I(c, 13)).toEqual([0x05050505, 0x05050505, 0, 0]);
  });

  test("dup, ins, umov, smov and the scalar moves", () => {
    const c = run([
      0x4e080c00,   // dup v0.2d, x0
      0x4e040c21,   // dup v1.4s, w1
      0x4e010c22,   // dup v2.16b, w1
      0x0e020c23,   // dup v3.4h, w1
      0x4e0c0404,   // dup v4.4s, v0.s[1]
      0x4e180405,   // dup v5.2d, v0.d[1]
      0x0e010446,   // dup v6.8b, v2.b[0]
      0x4e0c1c41,   // mov v1.s[1], w2
      0x4e181c01,   // mov v1.d[1], x0
      0x4e1f1c41,   // mov v1.b[15], w2
      0x4e1e1c41,   // mov v1.h[7], w2
      0x6e042427,   // mov v7.s[0], v1.s[1]
      0x6e180427,   // mov v7.d[1], v1.d[0]
      0x0e1f3c23,   // umov w3, v1.b[15]
      0x0e1e3c24,   // umov w4, v1.h[7]
      0x0e0c3c25,   // mov w5, v1.s[1]
      0x4e183c26,   // mov x6, v1.d[1]
      0x0e012c27,   // smov w7, v1.b[0]
      0x4e022c28,   // smov x8, v1.h[0]
      0x4e042c29,   // smov x9, v1.s[0]
      0x4ea11c28,   // mov v8.16b, v1.16b
      0x5e0c0429,   // mov s9, v1.s[1]
      0x5e18042a,   // mov d10, v1.d[1]
      0x5e1f042b,   // mov b11, v1.b[15]
      RET], (c) => { c.r[0] = 0x55667788; c.h[0] = 0x11223344; c.r[1] = 0xdeadbeef | 0; c.r[2] = 0x99; c.si.fill(-1, 0, 128); });
    expect(I(c, 0)).toEqual([0x55667788, 0x11223344, 0x55667788, 0x11223344]);
    expect(I(c, 1)).toEqual([0xdeadbeef | 0, 0x99, 0x55667788, 0x00993344]);
    expect(I(c, 2)).toEqual([0xefefefef | 0, 0xefefefef | 0, 0xefefefef | 0, 0xefefefef | 0]);
    expect(I(c, 3)).toEqual([0xbeefbeef | 0, 0xbeefbeef | 0, 0, 0]);
    expect(I(c, 4)).toEqual([0x11223344, 0x11223344, 0x11223344, 0x11223344]);
    expect(I(c, 5)).toEqual([0x55667788, 0x11223344, 0x55667788, 0x11223344]);
    expect(I(c, 6)).toEqual([0xefefefef | 0, 0xefefefef | 0, 0, 0]);
    expect(I(c, 7)).toEqual([0x99, -1, 0xdeadbeef | 0, 0x99]);
    expect([c.r[3], c.r[4], c.r[5]]).toEqual([0, 0x99, 0x99]);
    expect([c.r[6], c.h[6]]).toEqual([0x55667788, 0x00993344]);
    expect([c.r[7], c.h[7]]).toEqual([-17, 0]);
    expect([c.r[8], c.h[8]]).toEqual([-16657, -1]);
    expect([c.r[9], c.h[9]]).toEqual([0xdeadbeef | 0, -1]);
    expect(I(c, 8)).toEqual(I(c, 1));
    expect(I(c, 9)).toEqual([0x99, 0, 0, 0]);
    expect(I(c, 10)).toEqual([0x55667788, 0x00993344, 0, 0]);
    expect(I(c, 11)).toEqual([0, 0, 0, 0]);
  });

  test("ext, zip/uzp/trn and the bitwise three-same ops, with aliased destinations", () => {
    const c = run([
      0x6e022020,   // ext v0.16b, v1.16b, v2.16b, #4
      0x6e022823,   // ext v3.16b, v1.16b, v2.16b, #5
      0x2e021824,   // ext v4.8b, v1.8b, v2.8b, #3
      0x6e024021,   // ext v1.16b, v1.16b, v2.16b, #8
      0x6e024022,   // ext v2.16b, v1.16b, v2.16b, #8
      0x4e823825,   // zip1 v5.4s, v1.4s, v2.4s
      0x4e827826,   // zip2 v6.4s, v1.4s, v2.4s
      0x4e421827,   // uzp1 v7.8h, v1.8h, v2.8h
      0x4e425828,   // uzp2 v8.8h, v1.8h, v2.8h
      0x4e022829,   // trn1 v9.16b, v1.16b, v2.16b
      0x4ec2682a,   // trn2 v10.2d, v1.2d, v2.2d
      0x0e82382b,   // zip1 v11.2s, v1.2s, v2.2s
      0x4e221c2c,   // and v12.16b, v1.16b, v2.16b
      0x4e621c2d,   // bic v13.16b, v1.16b, v2.16b
      0x0ea21c2e,   // orr v14.8b, v1.8b, v2.8b
      0x4ee21c2f,   // orn v15.16b, v1.16b, v2.16b
      0x6e221c30,   // eor v16.16b, v1.16b, v2.16b
      0x6e621c31,   // bsl v17.16b, v1.16b, v2.16b
      0x6ea21c32,   // bit v18.16b, v1.16b, v2.16b
      0x6ee21c33,   // bif v19.16b, v1.16b, v2.16b
      0x6e205834,   // mvn v20.16b, v1.16b
      0x4e823821,   // zip1 v1.4s, v1.4s, v2.4s
      RET], (c) => { c.si.fill(0xf, 0, 128); c.si.set([1, 2, 3, 4], 4); c.si.set([5, 6, 7, 8], 8); });
    expect(I(c, 0)).toEqual([2, 3, 4, 5]);
    expect(I(c, 3)).toEqual([0x03000000, 0x04000000, 0x05000000, 0x06000000]);
    expect(I(c, 4)).toEqual([512, 1280, 0, 0]);
    expect(I(c, 2)).toEqual([5, 6, 5, 6]);
    expect(I(c, 5)).toEqual([3, 5, 4, 6]);
    expect(I(c, 6)).toEqual([5, 5, 6, 6]);
    expect(I(c, 7)).toEqual([0x40003, 0x60005, 0x60005, 0x60005]);
    expect(I(c, 8)).toEqual([0, 0, 0, 0]);
    expect(I(c, 9)).toEqual([0x0503, 0x0604, 0x0505, 0x0606]);
    expect(I(c, 10)).toEqual([5, 6, 5, 6]);
    expect(I(c, 11)).toEqual([3, 5, 0, 0]);
    expect(I(c, 12)).toEqual([1, 4, 5, 6]);
    expect(I(c, 13)).toEqual([2, 0, 0, 0]);
    expect(I(c, 14)).toEqual([7, 6, 0, 0]);
    expect(I(c, 15)).toEqual([-5, -3, -1, -1]);
    expect(I(c, 16)).toEqual([6, 2, 0, 0]);
    expect(I(c, 17)).toEqual([3, 4, 5, 6]);
    expect(I(c, 18)).toEqual([11, 13, 15, 15]);
    expect(I(c, 19)).toEqual([7, 6, 5, 6]);
    expect(I(c, 20)).toEqual([-4, -5, -6, -7]);
    expect(I(c, 1)).toEqual([3, 5, 4, 6]);
  });
});

describe("a64 simd: scalar floating point", () => {
  test("arithmetic, conversions, rounding, compares and selects, single and double", () => {
    const c = run([
      0x1e270020,   // fmov s0, w1
      0x9e670041,   // fmov d1, x2
      0x1e2e1002,   // fmov s2, #1.0
      0x1e7c1003,   // fmov d3, #-0.5
      0x1e222804,   // fadd s4, s0, s2
      0x1e633825,   // fsub d5, d1, d3
      0x1e200806,   // fmul s6, s0, s0
      0x1e631827,   // fdiv d7, d1, d3
      0x1e214008,   // fneg s8, s0
      0x1e60c069,   // fabs d9, d3
      0x1e21c0ca,   // fsqrt s10, s6
      0x1e22480b,   // fmax s11, s0, s2
      0x1e63582c,   // fmin d12, d1, d3
      0x1e2e680d,   // fmaxnm s13, s0, s14      (s14 is NaN)
      0x1e61882f,   // fnmul d15, d1, d1
      0x1f020810,   // fmadd s16, s0, s2, s2
      0x1f418c31,   // fmsub d17, d1, d1, d3
      0x1f220852,   // fnmadd s18, s2, s2, s2
      0x1f618c33,   // fnmsub d19, d1, d1, d3
      0x1e22c014,   // fcvt d20, s0
      0x1e624035,   // fcvt s21, d1
      0x1e23c056,   // fcvt h22, s2
      0x1ee242d7,   // fcvt s23, h22
      0x1e244338,   // frintn s24, s25          (s25 = 2.5)
      0x1e64c37a,   // frintp d26, d27          (d27 = -2.5)
      0x1e25433c,   // frintm s28, s25
      0x1e65c37d,   // frintz d29, d27
      0x1e26433e,   // frinta s30, s25
      0x1e67437f,   // frintx d31, d27
      0x1e380003,   // fcvtzs w3, s0
      0x1e390004,   // fcvtzu w4, s0
      0x1e200325,   // fcvtns w5, s25
      0x1e240326,   // fcvtas w6, s25
      0x1e680367,   // fcvtps w7, d27
      0x1e700368,   // fcvtms w8, d27
      0x9e780029,   // fcvtzs x9, d1
      0x1e3801ca,   // fcvtzs w10, s14
      0x1e39010b,   // fcvtzu w11, s8
      0x1e7801ec,   // fcvtzs w12, d15
      0x128000d4,   // mov w20, #-7
      0x1e220282,   // scvtf s2, w20
      0x1e630283,   // ucvtf d3, w20
      0x9e6202a5,   // scvtf d5, x21            (x21 = 1 << 32)
      0x9e2302c6,   // ucvtf s6, x22            (x22 = -1)
      0x1e02f287,   // scvtf s7, w20, #4
      0x1e18f0ee,   // fcvtzs w14, s7, #4
      0x1e222000,   // fcmp s0, s2
      0x1a9fd7ef,   // cset w15, gt
      0x1e2021c0,   // fcmp s14, s0
      0x1a9f77f0,   // cset w16, vs
      0x1e602028,   // fcmp d1, #0.0
      0x1a9fd7f1,   // cset w17, gt
      0x1e22b404,   // fccmp s0, s2, #4, lt
      0x1a9f17f2,   // cset w18, eq
      0x1e200400,   // fccmp s0, s0, #0, eq
      0x1a9f17f3,   // cset w19, eq
      0x1e220c1c,   // fcsel s28, s0, s2, eq
      0x1e631c3d,   // fcsel d29, d1, d3, ne
      0x1e260017,   // fmov w23, s0
      0x9e660038,   // fmov x24, d1
      0x9e67004e,   // fmov d14, x2
      0x9eaf004e,   // fmov v14.d[1], x2
      0x9eae01d9,   // fmov x25, v14.d[1]
      RET], (c) => {
        c.r[1] = 1078530011;                       // pi as a float
        c.r[2] = 0; c.h[2] = 1074003968;           // 2.5 as a double
        c.si[56] = 0x7fc00000;                     // s14 = NaN
        c.si[100] = 1075838976;                    // s25 = 2.5
        c.si[108] = 0; c.si[109] = -1073479680;    // d27 = -2.5
        c.r[21] = 0; c.h[21] = 1;
        c.r[22] = -1; c.h[22] = -1;
      });
    const S = (v: number) => c.si[4 * v], D = (v: number) => [c.si[4 * v], c.si[4 * v + 1]];
    expect([S(0), S(4), S(8), S(10), S(11), S(13)]).toEqual([1078530011, 1082427374, -1068953637, 1078530011, 1078530011, 1078530011]);
    expect([S(16), S(18), S(21), S(23), S(24), S(30)]).toEqual([1082427374, -1073741824, 1075838976, 1065353216, 1073741824, 1077936128]);
    expect(c.si[88]).toBe(0x3c00);
    expect([D(1), D(9), D(12), D(15)]).toEqual([[0, 1074003968], [0, 1071644672], [0, -1075838976], [0, -1072103424]]);
    expect([D(17), D(19), D(20), D(26), D(31)]).toEqual([[0, -1071972352], [0, 1075511296], [1610612736, 1074340347], [0, -1073741824], [0, -1073741824]]);
    expect([c.si[1], c.si[2], c.si[3], c.si[82], c.si[83]]).toEqual([0, 0, 0, 0, 0]);
    expect([c.r[3], c.r[4], c.r[5], c.r[6], c.r[7], c.r[8], c.r[9], c.h[9], c.r[10], c.r[11], c.r[12]]).toEqual([3, 3, 2, 3, -2, -3, 2, 0, 0, 0, -6]);
    expect([S(2), S(6), S(7), c.r[14]]).toEqual([-1059061760, 1602224128, -1092616192, -7]);
    expect([D(3), D(5)]).toEqual([[-14680064, 1106247679], [0, 1106247680]]);
    expect([c.r[15], c.r[16], c.r[17], c.r[18], c.r[19]]).toEqual([1, 1, 1, 1, 1]);
    expect(S(28)).toBe(1078530011);
    expect(D(29)).toEqual([-14680064, 1106247679]);
    expect([c.r[23], c.r[24], c.h[24], c.r[25], c.h[25]]).toEqual([1078530011, 0, 1074003968, 0, 1074003968]);
    expect([c.si[56], c.si[57], c.si[58], c.si[59]]).toEqual([0, 1074003968, 0, 1074003968]);
  });
});

describe("a64 simd: vector arithmetic", () => {
  test("integer lanes: three-same, shifts, widening, narrowing, reductions, dot", () => {
    const c = run([
      0x4ea28425,   // add v5.4s, v1.4s, v2.4s
      0x6ea28426,   // sub v6.4s, v1.4s, v2.4s
      0x4ea29c27,   // mul v7.4s, v1.4s, v2.4s
      0x4ea29427,   // mla v7.4s, v1.4s, v2.4s
      0x6ea28c28,   // cmeq v8.4s, v1.4s, v2.4s
      0x4ea13449,   // cmgt v9.4s, v2.4s, v1.4s
      0x6ea2342a,   // cmhi v10.4s, v1.4s, v2.4s
      0x4ea13c2b,   // cmge v11.4s, v1.4s, v1.4s
      0x4ea28c2c,   // cmtst v12.4s, v1.4s, v2.4s
      0x4ea6642d,   // smax v13.4s, v1.4s, v6.4s
      0x6ea66c2e,   // umin v14.4s, v1.4s, v6.4s
      0x4ea2442f,   // sshl v15.4s, v1.4s, v2.4s
      0x6eb14430,   // ushl v16.4s, v1.4s, v17.4s    (v17 = -1: a right shift by one)
      0x4ea2bc32,   // addp v18.4s, v1.4s, v2.4s
      0x0e238473,   // add v19.8b, v3.8b, v3.8b
      0x4f245434,   // shl v20.4s, v1.4s, #4
      0x4f1f0495,   // sshr v21.8h, v4.8h, #1
      0x6f140496,   // ushr v22.8h, v4.8h, #12
      0x4f3f1437,   // ssra v23.4s, v1.4s, #1
      0x0f10a498,   // sshll v24.4s, v4.4h, #0
      0x6f14a499,   // ushll2 v25.4s, v4.8h, #4
      0x0e61283a,   // xtn v26.4h, v1.4s
      0x4e61285a,   // xtn2 v26.8h, v2.4s
      0x6ea0283b,   // uaddlp v27.2d, v1.4s
      0x4eb1b83c,   // addv s28, v1.4s
      0x6e71a89d,   // uminv h29, v4.8h
      0x4e30a87e,   // smaxv b30, v3.16b
      0x0e20587f,   // cnt v31.8b, v3.8b
      0x4ea00820,   // rev64 v0.4s, v1.4s
      0x6ea0b821,   // neg v1.4s, v1.4s
      0x4e60b882,   // abs v2.8h, v4.8h
      0x4e640c84,   // sqadd v4.8h, v4.8h, v4.8h
      0x6e230c63,   // uqadd v3.16b, v3.16b, v3.16b
      0x0e64c085,   // smull v5.4s, v4.4h, v4.4h
      0x6ea1c026,   // umull2 v6.2d, v1.4s, v1.4s
      0x0e230067,   // saddl v7.8h, v3.8b, v3.8b
      0x0e694128,   // addhn v8.4h, v9.4s, v9.4s
      0x4e83946a,   // sdot v10.4s, v3.16b, v3.16b
      0x4fa2828b,   // mul v11.4s, v20.4s, v2.s[1]
      0x4efb876c,   // add v12.2d, v27.2d, v27.2d
      0x4eec376d,   // cmgt v13.2d, v27.2d, v12.2d
      0x4f61576e,   // shl v14.2d, v27.2d, #33
      0x6f7f05cf,   // ushr v15.2d, v14.2d, #1
      RET], (c) => {
        c.si.set([1, 2, 3, 4], 4); c.si.set([5, 6, 7, 8], 8);
        for (let i = 0; i < 16; i++) c.vb[48 + i] = i;
        c.vsw.set([-1, 2, -3, 4, -5, 6, -7, 8], 32);
        c.si.set([-1, -1, -1, -1], 68); c.si.set([10, 10, 10, 10], 92);
      });
    expect(I(c, 6)).toEqual([9, -6, 16, -8]);
    expect(I(c, 7)).toEqual([262144, 786440, 1310736, 1835032]);
    expect(I(c, 8)).toEqual([-1, -1, 0, 0]);
    expect(I(c, 9)).toEqual([-1, -1, -1, -1]);
    expect(I(c, 10)).toEqual([56, 504, 1464, 2936]);
    expect(I(c, 11)).toEqual([4194352, 8388704, 12583056, 16777408]);
    expect(I(c, 12)).toEqual([6, 0, 14, 0]);
    expect(I(c, 13)).toEqual([0, 0, 0, 0]);
    expect(I(c, 14)).toEqual([0, 6, 0, 14]);
    expect(I(c, 15)).toEqual([0, 3, 0, 7]);
    expect(I(c, 16)).toEqual([0, 1, 1, 2]);
    expect(I(c, 18)).toEqual([3, 7, 11, 15]);
    expect(I(c, 19)).toEqual([100925952, 235670024, 0, 0]);
    expect(I(c, 20)).toEqual([16, 32, 48, 64]);
    expect(I(c, 21)).toEqual([131071, 196606, 262141, 327676]);
    expect(I(c, 22)).toEqual([15, 15, 15, 15]);
    expect(I(c, 23)).toEqual([10, 11, 11, 12]);
    expect(I(c, 24)).toEqual([-1, 2, -3, 4]);
    expect(I(c, 25)).toEqual([1048496, 96, 1048464, 128]);
    expect(I(c, 26)).toEqual([131073, 262147, 393221, 524295]);
    expect(I(c, 27)).toEqual([3, 0, 7, 0]);
    expect(I(c, 28)).toEqual([10, 0, 0, 0]);
    expect(I(c, 29)).toEqual([2, 0, 0, 0]);
    expect(I(c, 30)).toEqual([15, 0, 0, 0]);
    expect(I(c, 31)).toEqual([33620224, 50463233, 0, 0]);
    expect(I(c, 0)).toEqual([2, 1, 4, 3]);
    expect(I(c, 1)).toEqual([-1, -2, -3, -4]);
    expect(I(c, 2)).toEqual([131073, 262147, 393221, 524295]);
    expect(I(c, 4)).toEqual([327678, 589818, 851958, 1114098]);
    expect(I(c, 3)).toEqual([100925952, 235670024, 370414096, 505158168]);
    expect(I(c, 5)).toEqual([4, 16, 36, 64]);
  });

  test("floating-point lanes: arithmetic, compares, pairs, reductions, conversions, estimates", () => {
    const c = run([
      0x6e22dc24,   // fmul v4.4s, v1.4s, v2.4s
      0x4e22d425,   // fadd v5.4s, v1.4s, v2.4s
      0x0ea2d426,   // fsub v6.2s, v1.2s, v2.2s
      0x6e22fc27,   // fdiv v7.4s, v1.4s, v2.4s
      0x4e22cc28,   // fmla v8.4s, v1.4s, v2.4s
      0x4ee3cc69,   // fmls v9.2d, v3.2d, v3.2d
      0x6ea0f82a,   // fneg v10.4s, v1.4s
      0x4ee0f86b,   // fabs v11.2d, v3.2d
      0x6ea1f84c,   // fsqrt v12.4s, v2.4s
      0x4e22f42d,   // fmax v13.4s, v1.4s, v2.4s
      0x4eafc42e,   // fminnm v14.4s, v1.4s, v15.4s   (v15 is NaN)
      0x6ea2e430,   // fcmgt v16.4s, v1.4s, v2.4s
      0x4e22e451,   // fcmeq v17.4s, v2.4s, v2.4s
      0x6e22ec32,   // facge v18.4s, v1.4s, v2.4s
      0x4ea0e833,   // fcmlt v19.4s, v1.4s, #0.0
      0x6e22d434,   // faddp v20.4s, v1.4s, v2.4s
      0x2e22f435,   // fmaxp v21.2s, v1.2s, v2.2s
      0x7e30d836,   // faddp s22, v1.2s
      0x6e30f837,   // fmaxv s23, v1.4s
      0x4e21db38,   // scvtf v24.4s, v25.4s
      0x6e61db7a,   // ucvtf v26.2d, v27.2d
      0x4ea1b83c,   // fcvtzs v28.4s, v1.4s
      0x4e21abdd,   // fcvtns v29.4s, v30.4s
      0x6ea1b83f,   // fcvtzu v31.4s, v1.4s
      0x4e219bc0,   // frintm v0.4s, v30.4s
      0x0e616861,   // fcvtn v1.2s, v3.2d
      0x0e6178c2,   // fcvtl v2.2d, v6.2s
      0x4f8d9883,   // fmul v3.4s, v4.4s, v13.s[2]
      0x4f8d1085,   // fmla v5.4s, v4.4s, v13.s[0]
      0x4ea1d9a6,   // frecpe v6.4s, v13.4s
      0x6ea1d9a7,   // frsqrte v7.4s, v13.4s
      0x5e21db28,   // scvtf s8, s25
      0x5ea1b889,   // fcvtzs s9, s4
      0x5ee1bb4a,   // fcvtzs d10, d26
      0x5e2ddc8b,   // fmulx s11, s4, s13
      0x4e2dfc8c,   // frecps v12.4s, v4.4s, v13.4s
      0x5e24e48d,   // fcmeq s13, s4, s4
      0x7efb8f6e,   // cmeq d14, d27, d27
      0x5ef1bb6f,   // addp d15, v27.2d
      RET], (c) => {
        c.si.set([1069547520, -1073741824, 1082130432, 1048576000], 4);       // v1 = 1.5, -2, 4, 0.25
        c.si.set([1073741824, 1073741824, 1073741824, 1073741824], 8);        // v2 = 2, 2, 2, 2
        c.si.set([0, 1074266112, 0, -1074790400], 12);                        // v3 = 3.0, -1.0
        c.si.set([1065353216, 1065353216, 1065353216, 1065353216], 32);       // v8 = 1, 1, 1, 1
        c.si.set([0, 1076101120, 0, 1076101120], 36);                         // v9 = 10.0, 10.0
        c.si.set([0x7fc00000, 0x7fc00000, 0x7fc00000, 0x7fc00000], 60);      // v15 = NaN
        c.si.set([1, -2, 3, -4], 100);                                        // v25 ints
        c.si.set([5, 0, 6, 0], 108);                                          // v27 = 5, 6 (64-bit)
        c.si.set([1075838976, -1071644672, 1069547520, 1056964608], 120);     // v30 = 2.5, -2.5, 1.5, 0.5
      });
    expect(I(c, 4)).toEqual([1077936128, -1065353216, 1090519040, 1056964608]);
    expect(I(c, 5)).toEqual([1092091904, -1056964608, 1102053376, 1078984704]);
    expect(I(c, 6)).toEqual([1056931840, 1056931840, 1048543232, 1056931840]);
    expect(I(c, 7)).toEqual([1060405248, 1060405248, 1056931840, 1060405248]);
    expect(I(c, 8)).toEqual([1065353216, 0, 0, 0]);
    expect(I(c, 9)).toEqual([3, 0, 0, 0]);
    expect(I(c, 10)).toEqual([5, 0, 0, 0]);
    expect(I(c, 11)).toEqual([1086324736, 0, 0, 0]);
    expect(I(c, 12)).toEqual([-1065353216, 1092616192, -1041235968, 1065353216]);
    expect(I(c, 13)).toEqual([-1, 0, 0, 0]);
    expect(I(c, 14)).toEqual([-1, -1, 0, 0]);
    expect(I(c, 15)).toEqual([11, 0, 0, 0]);
    expect(I(c, 16)).toEqual([0, 0, -1, 0]);
    expect(I(c, 17)).toEqual([-1, -1, -1, -1]);
    expect(I(c, 18)).toEqual([0, -1, -1, 0]);
    expect(I(c, 19)).toEqual([0, -1, 0, 0]);
    expect(I(c, 20)).toEqual([-1090519040, 1082654720, 1082130432, 1082130432]);
    expect(I(c, 21)).toEqual([1069547520, 1073741824, 0, 0]);
    expect(I(c, 22)).toEqual([-1090519040, 0, 0, 0]);
    expect(I(c, 23)).toEqual([1082130432, 0, 0, 0]);
    expect(I(c, 24)).toEqual([1065353216, -1073741824, 1077936128, -1065353216]);
    expect(I(c, 26)).toEqual([0, 1075052544, 0, 1075314688]);
    expect(I(c, 28)).toEqual([1, -2, 4, 0]);
    expect(I(c, 29)).toEqual([2, -2, 2, 0]);
    expect(I(c, 31)).toEqual([1, 0, 4, 0]);
    expect(I(c, 0)).toEqual([1073741824, -1069547520, 1065353216, 0]);
    expect(I(c, 1)).toEqual([1077936128, -1082130432, 0, 0]);
    expect(I(c, 2)).toEqual([0, -1075838976, 0, -1072693248]);
    expect(I(c, 3)).toEqual([1094713344, -1048576000, 1107296256, 1073741824]);
  });
});
