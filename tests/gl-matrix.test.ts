import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const matrix = rt.link("android/opengl/Matrix").ctor;
test("invertM handles a perspective transform, overlapping arrays and singular input", async () => {
  const source = Float32Array.of(2, 1, 0, 1, 0, 3, 1, 0, 1, 0, 4, 1, 5, 6, 7, 1);
  const inverse = new Float32Array(20); inverse.set(source, 2);
  expect(await vcall(matrix, "invertM", "([FI[FI)Z", inverse, 0, inverse, 2)).toBe(1);
  const product = new Float32Array(16);
  await vcall(matrix, "multiplyMM", "([FI[FI[FI)V", product, 0, source, 0, inverse, 0);
  for (let i = 0; i < 16; i++) expect(product[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
  const before = inverse.slice();
  expect(await vcall(matrix, "invertM", "([FI[FI)Z", inverse, 0, new Float32Array(16), 0)).toBe(0);
  expect(inverse).toEqual(before);
});

test("perspectiveM maps the frustum to clip space and preserves the output range", async () => {
  const projection = new Float32Array(20).fill(42);
  await vcall(matrix, "perspectiveM", "([FIFFFF)V", projection, 2, 90, 2, 1, 11);
  expect([...projection.slice(0, 2), ...projection.slice(18)]).toEqual([42, 42, 42, 42]);
  const clip = new Float32Array(4);
  for (const [point, expected] of [
    [[2, 1, -1, 1], [1, 1, -1]],
    [[22, 11, -11, 1], [1, 1, 1]],
    [[0, 0, -2, 1], [0, 0, 0.1]],
  ]) {
    await vcall(matrix, "multiplyMV", "([FI[FI[FI)V", clip, 0, projection, 2, Float32Array.from(point), 0);
    for (let i = 0; i < 3; i++) expect(clip[i] / clip[3]).toBeCloseTo(expected[i], 6);
  }
});
test("setLookAtM moves the eye to the origin and aligns its viewing direction", async () => {
  const view = new Float32Array(18).fill(42), result = new Float32Array(4);
  await vcall(matrix, "setLookAtM", "([FIFFFFFFFFF)V", view, 1, 3, 4, 5, 4, 4, 5, 0, 2, 0);
  expect([view[0], view[17]]).toEqual([42, 42]);
  for (const [point, expected] of [
    [[3, 4, 5, 1], [0, 0, 0, 1]],
    [[4, 4, 5, 1], [0, 0, -1, 1]],
    [[3, 5, 5, 1], [0, 1, 0, 1]],
  ]) {
    await vcall(matrix, "multiplyMV", "([FI[FI[FI)V", result, 0, view, 1, Float32Array.from(point), 0);
    for (let i = 0; i < 4; i++) expect(result[i]).toBeCloseTo(expected[i], 6);
  }
});
