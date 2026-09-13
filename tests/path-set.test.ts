import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPath } from "../src/android/path";
import { JMatrix } from "../src/android/graphics";

rt.linkNatives();

test("Path.set replaces geometry with an independent copy", async () => {
  const source = await newObj("android/graphics/Path") as JPath;
  const target = await newObj("android/graphics/Path") as JPath;
  await vcall(source, "moveTo", "(FF)V", 1, 2);
  await vcall(source, "lineTo", "(FF)V", 3, 4);
  await vcall(target, "moveTo", "(FF)V", 9, 9);
  await vcall(target, "set", "(Landroid/graphics/Path;)V", source);
  await vcall(source, "offset", "(FF)V", 10, 20);

  expect(target.ops).toEqual([["m", 1, 2], ["l", 3, 4]]);
  expect([target.curX, target.curY, target.startX, target.startY]).toEqual([3, 4, 1, 2]);
});

test("Path.addPath applies a matrix without mutating its source", async () => {
  const source = await newObj("android/graphics/Path") as JPath;
  const target = await newObj("android/graphics/Path") as JPath;
  const matrix = await newObj("android/graphics/Matrix") as JMatrix;
  await vcall(source, "moveTo", "(FF)V", 1, 2);
  await vcall(matrix, "setTranslate", "(FF)V", 10, 20);
  await vcall(target, "addPath", "(Landroid/graphics/Path;Landroid/graphics/Matrix;)V", source, matrix);

  expect(target.ops).toEqual([["m", 11, 22]]);
  expect(source.ops).toEqual([["m", 1, 2]]);
});
