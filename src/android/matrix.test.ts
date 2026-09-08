import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { deref, handle, release } from "./handles";

const set = (m: unknown, src: Float32Array, dst: Float32Array, count: number, si = 0, di = 0) => vcall(m, "setPolyToPoly", "([FI[FII)Z", src, si, dst, di, count);

test("Matrix point mappings cover reset, translation, rotated similarity, shear and reader rectangles", async () => {
  const matrix = await newObj("android/graphics/Matrix");
  const cases = [
    { src: [], dst: [], count: 0 },
    { src: [4, 7], dst: [10, 2], count: 1 },
    { src: [0, 0, 4, 0], dst: [3, 5, 3, 13], count: 2 },
    { src: [2, 3, 8, 3, 2, 9], dst: [11, 13, 23, 19, 29, 37], count: 3 },
    { src: [0, 0, 1024, 0, 1024, 1500, 0, 1500], dst: [10, 20, 522, 20, 522, 770, 10, 770], count: 4 },
    { src: [0, 0, 100, 0, 100, 200, 0, 200], dst: [200, 10, 200, 60, 100, 60, 100, 10], count: 4 },
  ];
  for (const { src, dst, count } of cases) {
    const input = Float32Array.of(999, ...src), output = Float32Array.of(999, ...dst);
    expect(await set(matrix, input, output, count, 1, 1)).toBe(1);
    const points = Float32Array.from(src);
    await vcall(matrix, "mapPoints", "([F)V", points);
    expect([...points]).toEqual(dst);
  }
});

test("failed degenerate and perspective mappings preserve the previous matrix", async () => {
  const matrix = await newObj("android/graphics/Matrix");
  await vcall(matrix, "setTranslate", "(FF)V", 11, 12);
  const before = [...matrix.m];
  expect(await set(matrix, Float32Array.of(0, 0, 0, 0), Float32Array.of(1, 2, 3, 4), 2)).toBe(0);
  expect(await set(matrix, Float32Array.of(0, 0, 1, 1, 2, 2), Float32Array.of(1, 2, 3, 4, 5, 6), 3)).toBe(0);
  expect(await set(matrix, Float32Array.of(0, 0, 10, 0, 10, 10, 0, 10), Float32Array.of(0, 0, 10, 0, 8, 10, 2, 10), 4)).toBe(0);
  expect(matrix.m).toEqual(before);
  await expect(set(matrix, new Float32Array(8), new Float32Array(8), 5)).rejects.toBeDefined();
  await expect(set(matrix, new Float32Array(8), new Float32Array(8), 4, 1)).rejects.toBeDefined();
});

test("framework Matrix JNI uses the same affine four-point solve", async () => {
  const h = handle(Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1));
  try {
    const fn = rt.jni.get("android/graphics/Matrix|nSetPolyToPoly(J[FI[FII)Z")!;
    const src = Float32Array.of(0, 0, 10, 0, 10, 10, 0, 10), dst = Float32Array.of(5, 6, 25, 6, 25, 36, 5, 36);
    expect(await Reflect.apply(fn, null, [h, src, 0, dst, 0, 4])).toBe(1);
    expect([...deref<Float64Array>(h)]).toEqual([2, 0, 5, 0, 3, 6, 0, 0, 1]);
    dst[6] = 7;
    expect(await Reflect.apply(fn, null, [h, src, 0, dst, 0, 4])).toBe(0);
    expect([...deref<Float64Array>(h)]).toEqual([2, 0, 5, 0, 3, 6, 0, 0, 1]);
  } finally { release(h); }
});
