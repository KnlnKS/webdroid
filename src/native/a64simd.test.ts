import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { mem } from "./mem.ts";
import { setA64 } from "./cpu.ts";
import { run, RET, pattern } from "./a64.testkit.ts";

// Encodings from `clang -target aarch64-linux-gnu`, mnemonics from objdump. Lanes are set and read
// through the integer views: a move must be bit-exact, and the float views cannot say so.
beforeAll(() => setA64(true));
afterAll(() => setA64(false));

const I = (c: { si: Int32Array }, v: number) => [c.si[4 * v], c.si[4 * v + 1], c.si[4 * v + 2], c.si[4 * v + 3]];

test("USHL halfword lanes handle signed shift counts and destination aliasing", () => {
  const c = run([0x6e614465, 0x2e614463, RET], cpu => {
    cpu.vw.set([0x8001, 0x00ff, 0xffff, 0x1234, 0x0080, 0xffff, 1, 0x7777], 8 * 3);
    cpu.vw.set([0xff, 3, 0xf0, 16, 1, 0xf1, 15, 0x80], 8);
  });
  expect([...c.vw.subarray(8 * 5, 8 * 6)]).toEqual([0x4000, 0x07f8, 0, 0, 0x0100, 1, 0x8000, 0]);
  expect([...c.vw.subarray(8 * 3, 8 * 4)]).toEqual([0x4000, 0x07f8, 0, 0, 0, 0, 0, 0]);
});

test("PMULL2 multiplies upper byte lanes when the destination aliases a source", () => {
  const a = [0x80, 0x01, 0xff, 0x53, 0x17, 0xc0, 0x7e, 0x39];
  const b = [0x02, 0x80, 0xff, 0x65, 0xb4, 0x09, 0x42, 0xe1];
  const c = run([0x4e23e0a5, RET], cpu => {
    cpu.vb.set(a, 16 * 5 + 8);
    cpu.vb.set(b, 16 * 3 + 8);
  });
  const expected = a.flatMap((x, lane) => {
    let product = 0;
    for (let bit = 0; bit < 8; bit++) if (b[lane] & (1 << bit)) product ^= x << bit;
    return [product & 255, product >> 8];
  });
  expect([...c.vb.subarray(16 * 5, 16 * 6)]).toEqual(expected);
});

describe("a64 simd: memory", () => {
  test("vector reads survive scalar work and refresh after a vector load", () => {
    const buf = pattern();
    const c = run([
      0x3dc00120, // ldr q0, [x9]
      0x9100054a, // add x10, x10, #1
      0x4e208401, // add v1.16b, v0.16b, v0.16b
      0x3dc00520, // ldr q0, [x9, #16]
      0x9100054a, // add x10, x10, #1
      0x4e218402, // add v2.16b, v0.16b, v1.16b
      RET,
    ], cpu => { cpu.w[18] = buf + 256; });
    expect(c.w[20]).toBe(2);
    expect([...c.vb.subarray(16, 32)]).toEqual(Array.from({ length: 16 }, (_, i) => i * 2));
    expect([...c.vb.subarray(32, 48)]).toEqual(Array.from({ length: 16 }, (_, i) => 16 + i * 3));
  });

  test("lane stores use the latest vector value across compiled instructions", () => {
    const buf = pattern();
    const c = run([
      0x4e080458, // dup v24.2d, v2.d[0]
      0x4d818518, // st1 { v24.d }[1], [x8], x1
      0x4e080478, // dup v24.2d, v3.d[0]
      0x4d818518, // st1 { v24.d }[1], [x8], x1
      RET,
    ], cpu => {
      cpu.w[16] = buf + 256;
      cpu.w[2] = 8;
      cpu.vb.set([1, 2, 3, 4, 5, 6, 7, 8], 16 * 2);
      cpu.vb.set([9, 10, 11, 12, 13, 14, 15, 16], 16 * 3);
    });
    expect(c.w[16] >>> 0).toBe(buf + 272);
    expect([...mem.u8.subarray(buf + 256, buf + 272)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  test("interleaved stores preserve lane order at both vector widths", () => {
    const buf = pattern();
    const c = run([0x0c9f8926, 0x4c00813e, RET], cpu => {
      cpu.w[18] = buf + 256;
      cpu.vb.set(Array.from({ length: 16 }, (_, i) => i), 16 * 6);
      cpu.vb.set(Array.from({ length: 16 }, (_, i) => i + 32), 16 * 7);
      cpu.vb.set(Array.from({ length: 16 }, (_, i) => i + 64), 16 * 30);
      cpu.vb.set(Array.from({ length: 16 }, (_, i) => i + 96), 16 * 31);
    });
    expect(c.w[18] >>> 0).toBe(buf + 272);
    expect([...mem.u8.subarray(buf + 256, buf + 272)]).toEqual([
      0, 1, 2, 3, 32, 33, 34, 35, 4, 5, 6, 7, 36, 37, 38, 39,
    ]);
    expect([...mem.u8.subarray(buf + 272, buf + 304)]).toEqual(
      Array.from({ length: 32 }, (_, i) => (i & 1 ? 96 : 64) + (i >> 1)),
    );
  });

  test("multi-register lanes preserve wraparound, writeback and stores across tiers", () => {
    const buf = pattern();
    const c = run([
      0x0d60e13c, // ld4r { v28.8b, v29.8b, v30.8b, v31.8b }, [x9]
      0x0dff913f, // ld2 { v31.s, v0.s }[1], [x9], #8
      0x0d40693d, // ld3 { v29.h, v30.h, v31.h }[1], [x9]
      0x0dbf913f, // st2 { v31.s, v0.s }[1], [x9], #8
      RET,
    ], cpu => {
      cpu.w[18] = buf + 256;
      for (let i = 8; i < 16; i++) mem.u8[buf + 256 + i] = i;
    });
    expect(c.w[18] >>> 0).toBe(buf + 272);
    expect(I(c, 28)).toEqual([0, 0, 0, 0]);
    expect(I(c, 31)[1]).toBe(0x03020100);
    expect(I(c, 0)[1]).toBe(0x07060504);
    expect([...mem.u8.subarray(buf + 264, buf + 272)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

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
      RET], (c) => { c.w[18] = buf + 256; c.w[2] = 24; });
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
    expect(c.w[18] >>> 0).toBe(buf + 332);
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
      0x4e1e1c41,   // mov v1.w[15], w2
      0x6e042427,   // mov v7.s[0], v1.s[1]
      0x6e180427,   // mov v7.d[1], v1.d[0]
      0x0e1f3c23,   // umov w3, v1.b[15]
      0x0e1e3c24,   // umov w4, v1.w[15]
      0x0e0c3c25,   // mov w5, v1.s[1]
      0x4e183c26,   // mov x6, v1.d[1]
      0x0e012c27,   // smov w7, v1.b[0]
      0x4e022c28,   // smov x8, v1.w[1]
      0x4e042c29,   // smov x9, v1.s[0]
      0x4ea11c28,   // mov v8.16b, v1.16b
      0x5e0c0429,   // mov s9, v1.s[1]
      0x5e18042a,   // mov d10, v1.d[1]
      0x5e1f042b,   // mov b11, v1.b[15]
      RET], (c) => { c.w[0] = 0x55667788; c.w[1] = 0x11223344; c.w[2] = 0xdeadbeef | 0; c.w[4] = 0x99; c.si.fill(-1, 0, 128); });
    expect(I(c, 0)).toEqual([0x55667788, 0x11223344, 0x55667788, 0x11223344]);
    expect(I(c, 1)).toEqual([0xdeadbeef | 0, 0x99, 0x55667788, 0x00993344]);
    expect(I(c, 2)).toEqual([0xefefefef | 0, 0xefefefef | 0, 0xefefefef | 0, 0xefefefef | 0]);
    expect(I(c, 3)).toEqual([0xbeefbeef | 0, 0xbeefbeef | 0, 0, 0]);
    expect(I(c, 4)).toEqual([0x11223344, 0x11223344, 0x11223344, 0x11223344]);
    expect(I(c, 5)).toEqual([0x55667788, 0x11223344, 0x55667788, 0x11223344]);
    expect(I(c, 6)).toEqual([0xefefefef | 0, 0xefefefef | 0, 0, 0]);
    expect(I(c, 7)).toEqual([0x99, -1, 0xdeadbeef | 0, 0x99]);
    expect([c.w[6], c.w[8], c.w[10]]).toEqual([0, 0x99, 0x99]);
    expect([c.w[12], c.w[13]]).toEqual([0x55667788, 0x00993344]);
    expect([c.w[14], c.w[15]]).toEqual([-17, 0]);
    expect([c.w[16], c.w[17]]).toEqual([-16657, -1]);
    expect([c.w[18], c.w[19]]).toEqual([0xdeadbeef | 0, -1]);
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

describe("a64 simd: vector arithmetic", () => {
  test("float compares against zero, 64-bit lane conversions and narrowing", () => {
    const c = run([
      0x0ea0c820,   // fcmgt v0.2s, v1.2s, #0.0
      0x6ea0c822,   // fcmge v2.4s, v1.4s, #0.0
      0x4ee0d883,   // fcmeq v3.2d, v4.2d, #0.0
      0x6ea0d825,   // fcmle v5.4s, v1.4s, #0.0
      0x4ee0e886,   // fcmlt v6.2d, v4.2d, #0.0
      0x4e61d907,   // scvtf v7.2d, v8.2d
      0x6e61d909,   // ucvtf v9.2d, v8.2d
      0x0e61688a,   // fcvtn v10.2s, v4.2d
      0x4e61696a,   // fcvtn2 v10.4s, v11.2d
      RET], (cpu) => {
      cpu.si.fill(-1, 0, 128);
      new Float32Array(cpu.si.buffer, cpu.si.byteOffset, 128).set([1.5, -0, NaN, -2], 4);
      const d = new Float64Array(cpu.si.buffer, cpu.si.byteOffset, 64);
      d.set([-0, -3.25], 8);
      d.set([1e40, 0.1], 22);
      cpu.si.set([-5, -1, 7, 0x40000000], 32);
    });
    const f = new Float32Array(c.si.buffer, c.si.byteOffset, 128), d = new Float64Array(c.si.buffer, c.si.byteOffset, 64);
    expect(I(c, 0)).toEqual([-1, 0, 0, 0]);
    expect(I(c, 2)).toEqual([-1, -1, 0, 0]);
    expect(I(c, 3)).toEqual([-1, -1, 0, 0]);
    expect(I(c, 5)).toEqual([0, -1, 0, -1]);
    expect(I(c, 6)).toEqual([0, 0, -1, -1]);
    expect([d[14], d[15], d[18], d[19]]).toEqual([-5, 2 ** 62 + 7, 2 ** 64 - 5, 2 ** 62 + 7]);
    expect([...f.subarray(40, 44)]).toEqual([-0, -3.25, Infinity, Math.fround(0.1)]);
  });

  test("a scalar B/H result owns its whole word: nothing of the old lane survives", () => {
    const c = run([
      0x9e670000,   // fmov d0, x0              (x0 = 0x10000)
      0x0e205800,   // cnt v0.8b, v0.8b
      0x2e303800,   // uaddlv h0, v0.8b         (popcount: 1, not 0x10001)
      0x1e260001,   // fmov w1, s0
      0x4e30a862,   // smaxv b2, v3.16b
      0x5e607864,   // sqabs h4, h3
      0x5f445465,   // shl d5, d3, #4
      0x5e214866,   // sqxtn b6, h3
      RET], (c) => { c.w[0] = 0x10000; c.si.fill(-1, 0, 128); c.si.set([0x80017f02 | 0, 0x10, 0x7fffffff, 0], 12); });
    expect(I(c, 0)).toEqual([1, 0, 0, 0]);
    expect(c.w[2]).toBe(1);
    expect(I(c, 2)).toEqual([127, 0, 0, 0]);
    expect(I(c, 4)).toEqual([0x7f02, 0, 0, 0]);
    expect(I(c, 5)).toEqual([0x0017f020, 0x108, 0, 0]);
    expect(I(c, 6)).toEqual([0x7f, 0, 0, 0]);
  });

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

  test("sqrshl saturates left shifts and rounds signed right shifts", () => {
    const c = run([0x4ea45e32, RET], (c) => {
      c.si.set([0x40000000, -0x40000000, 7, -3], 4 * 17);
      c.si.set([2, 2, -1, -2], 4 * 4);
    });
    expect(I(c, 18)).toEqual([0x7fffffff, -0x80000000, 4, -1]);
    expect(c.fpsr & (1 << 27)).toBe(1 << 27);
  });

  test("64-bit SQRSHL ignores saturation in inactive upper lanes", () => {
    const c = run([0x0ea45e32, RET], (cpu) => {
      cpu.si.set([7, -3, 0x40000000, -0x40000000], 4 * 17);
      cpu.si.set([-1, -2, 2, 2], 4 * 4);
    });
    expect(I(c, 18)).toEqual([4, -1, 0, 0]);
    expect(c.fpsr & (1 << 27)).toBe(0);
  });

  test("byte-aligned SHRN preserves destination halves", () => {
    const c = run([0x0f188420, 0x4f188420, RET], (cpu) => {
      cpu.vb.set(Array.from({ length: 16 }, (_, i) => i), 16);
      cpu.vb.fill(0xa5, 0, 16);
    });
    expect([...c.vb.subarray(0, 16)]).toEqual([1, 2, 5, 6, 9, 10, 13, 14, 1, 2, 5, 6, 9, 10, 13, 14]);
  });

  test("64-bit vector saturation ignores inactive upper lanes", () => {
    const c = run([0x0ea20c20, RET], (cpu) => {
      cpu.si.set([1, 2, 0x7fffffff, 0x7fffffff], 4);
      cpu.si.set([3, 4, 1, 1], 8);
    });
    expect(I(c, 0)).toEqual([4, 6, 0, 0]);
    expect(c.fpsr & (1 << 27)).toBe(0);
  });

  test("64-bit UQSHL ignores saturation in inactive upper lanes", () => {
    const c = run([0x2f0974e7, RET], (cpu) => {
      cpu.vb.set([1, 2, 3, 4, 5, 6, 7, 8, 255, 255, 255, 255, 255, 255, 255, 255], 16 * 7);
    });
    expect([...c.vb.subarray(16 * 7, 16 * 8)]).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(c.fpsr & (1 << 27)).toBe(0);
  });

  test("64-bit UADALP clears inactive upper lanes", () => {
    const c = run([0x2e206820, RET], (cpu) => {
      cpu.vb.set([1, 2, 3, 4, 5, 6, 7, 8], 16);
      cpu.vw.fill(10, 0, 8);
    });
    expect([...c.vw.subarray(0, 8)]).toEqual([13, 17, 21, 25, 0, 0, 0, 0]);
  });

  test("sqrshrun rounds signed lanes into both unsigned destination halves", () => {
    const c = run([0x2f098c20, 0x6f0a8c40, RET], (cpu) => {
      cpu.vsw.set([-32768, -129, -65, -64, -1, 0, 64, 32767], 8);
      cpu.vsw.set([-32768, -65, 0, 31, 32, 127, 16320, 32767], 16);
    });
    expect([...c.vb.subarray(0, 16)]).toEqual([0, 0, 0, 0, 0, 0, 1, 255, 0, 0, 0, 0, 1, 2, 255, 255]);
    expect(c.fpsr & (1 << 27)).toBe(1 << 27);
  });
});

// frsqrte had no coverage of any kind, here or in the hardware oracle. The architecture fixes the
// estimate's precision rather than its bits, so the check is the guarantee itself -- eight bits of
// 1/sqrt(x) -- plus the values the spec pins exactly.
describe("a64 simd: reciprocal square root estimate", () => {
  const dupV1 = 0x4e040c01, frsqrteV0V1 = 0x6ea1d820; // dup v1.4s, w0 ; frsqrte v0.4s, v1.4s
  const estimate = (bits: number): number => {
    const c = run([dupV1, frsqrteV0V1, RET], (cpu) => { cpu.w[0] = bits | 0; });
    const out = I(c, 0);
    expect(out[1]).toBe(out[0]); // every lane took the same input
    return new Float32Array(new Int32Array([out[0]]).buffer)[0];
  };
  const f32 = (v: number): number => new Int32Array(new Float32Array([v]).buffer)[0];

  test("is within eight bits of 1/sqrt(x) across the exponent range", () => {
    for (const v of [0.25, 0.5, 1, 1.5, 2, 3, 4, 7.9, 16, 100, 1e-30, 1e30, 3.4e38, 1.4e-45]) {
      const got = estimate(f32(v)), want = 1 / Math.sqrt(v);
      expect(Math.abs(got - want) / want).toBeLessThan(2 ** -8);
    }
  });
  test("pins the values the architecture fixes", () => {
    expect(estimate(f32(0))).toBe(Infinity);
    expect(estimate(f32(-0))).toBe(-Infinity);
    expect(estimate(f32(Infinity))).toBe(0);
    expect(estimate(f32(-1))).toBeNaN();
    expect(estimate(f32(-Infinity))).toBeNaN();
    expect(estimate(f32(NaN))).toBeNaN();
  });
});
