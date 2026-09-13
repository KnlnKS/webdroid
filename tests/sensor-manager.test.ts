import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";

rt.linkNatives();

const rotation = (r: Float32Array | null, i: Float32Array | null, gravity: Float32Array, field: Float32Array): number => {
  const fn = (rt.link("android/hardware/SensorManager").ctor as unknown as Record<string, unknown>)[mangleMethod("getRotationMatrix", "([F[F[F[F)Z")];
  if (typeof fn !== "function") throw new Error("getRotationMatrix is not linked");
  return (fn as (r: Float32Array | null, i: Float32Array | null, g: Float32Array, f: Float32Array) => number)(r, i, gravity, field);
};

test("SensorManager.getRotationMatrix produces Android's ENU basis", () => {
  const r = new Float32Array(9), i = new Float32Array(9);
  expect(rotation(r, i, new Float32Array([0, 0, 9.81]), new Float32Array([0, 1, 0]))).toBe(1);
  expect([...r]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  expect([...i].map((v) => Math.abs(v))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test("SensorManager.getRotationMatrix supports 4x4 output and rejects free fall", () => {
  const r = new Float32Array(16);
  expect(rotation(r, null, new Float32Array([0, 0, 9.81]), new Float32Array([0, 1, 0]))).toBe(1);
  expect([...r]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(rotation(r, null, new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0]))).toBe(0);
});
