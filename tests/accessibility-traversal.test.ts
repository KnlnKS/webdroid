import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("views retain accessibility traversal relationships", async () => {
  const view = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", null);
  expect(await vcall(view, "getAccessibilityTraversalBefore", "()I")).toBe(-1);
  expect(await vcall(view, "getAccessibilityTraversalAfter", "()I")).toBe(-1);
  await vcall(view, "setAccessibilityTraversalBefore", "(I)V", 41);
  await vcall(view, "setAccessibilityTraversalAfter", "(I)V", 42);
  expect(await vcall(view, "getAccessibilityTraversalBefore", "()I")).toBe(41);
  expect(await vcall(view, "getAccessibilityTraversalAfter", "()I")).toBe(42);
});
