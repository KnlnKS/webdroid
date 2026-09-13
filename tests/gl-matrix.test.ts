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
