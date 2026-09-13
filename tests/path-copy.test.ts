import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPath } from "../src/android/path";

rt.linkNatives();
test("path copies retain contours and fill rules without sharing mutable geometry", async () => {
  const source = rt.make("android/graphics/Path") as JPath;
  await vcall(source, "moveTo", "(FF)V", 10, 20);
  await vcall(source, "lineTo", "(FF)V", 30, 40);
  source.fillRule = "evenodd";
  const copy = await newObj("android/graphics/Path", "(Landroid/graphics/Path;)V", source) as JPath;
  const target = rt.make("android/graphics/Path") as JPath;
  await vcall(target, "set", "(Landroid/graphics/Path;)V", copy);
  await vcall(target, "set", "(Landroid/graphics/Path;)V", target);
  await vcall(target, "rLineTo", "(FF)V", 5, 6);
  expect(target.ops.at(-1)).toEqual(["l", 35, 46]);
  await vcall(target, "close", "()V");
  expect([target.curX, target.curY, target.fillRule]).toEqual([10, 20, "evenodd"]);
  await vcall(copy, "offset", "(FF)V", 100, 200);
  expect(source.ops).toEqual([["m", 10, 20], ["l", 30, 40]]);
  expect(target.ops.slice(0, 2)).toEqual(source.ops);
});
