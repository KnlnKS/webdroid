import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Matrix.set copies independently and null restores identity", async () => {
  const source = await newObj("android/graphics/Matrix", "()V");
  const target = await newObj("android/graphics/Matrix", "()V");
  await vcall(source, "setTranslate", "(FF)V", 3, 4);
  await vcall(target, "set", "(Landroid/graphics/Matrix;)V", source);
  await vcall(source, "reset", "()V");
  const points = new Float32Array([1, 2]);
  await vcall(target, "mapPoints", "([F)V", points);
  expect([...points]).toEqual([4, 6]);
  await vcall(target, "set", "(Landroid/graphics/Matrix;)V", null);
  expect(await vcall(target, "isIdentity", "()Z")).toBe(1);
  await vcall(target, "mapPoints", "([F)V", points);
  expect([...points]).toEqual([4, 6]);
});
