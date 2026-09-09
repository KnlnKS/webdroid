import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JRect } from "./graphics";

test("RectEvaluator truncates the delta and optionally reuses its destination", async () => {
  const a = Object.assign(new JRect(), { left: 10, top: -10, right: 30, bottom: -30 });
  const b = Object.assign(new JRect(), { left: 7, top: -7, right: 35, bottom: -35 });
  const evaluator = await newObj("android/animation/RectEvaluator");
  const evaluate = (e: unknown, f: number) => vcall(e, "evaluate", "(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", f, a, b);
  const result = await evaluate(evaluator, 0.5);
  expect(result).toMatchObject({ left: 9, top: -9, right: 32, bottom: -32 });
  expect(await evaluate(evaluator, 0.5)).not.toBe(result);
  expect(a).toMatchObject({ left: 10, top: -10, right: 30, bottom: -30 });
  const reused = await newObj("android/animation/RectEvaluator", "(Landroid/graphics/Rect;)V", a);
  expect(await evaluate(reused, 1)).toBe(a);
  expect(a).toMatchObject({ left: 7, top: -7, right: 35, bottom: -35 });
});
