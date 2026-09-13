import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { classCtors } from "../src/jvm/natives/jreflect";

rt.linkNatives();
test("FrameLayout declares its view constructors for reflection", () => {
  expect(classCtors(rt.link("android/widget/FrameLayout")).map(c => c.desc)).toEqual([
    "(Landroid/content/Context;)V", "(Landroid/content/Context;Landroid/util/AttributeSet;)V",
    "(Landroid/content/Context;Landroid/util/AttributeSet;I)V", "(Landroid/content/Context;Landroid/util/AttributeSet;II)V",
  ]);
});
test("RelativeLayout rules stay live across reads, updates and removal", async () => {
  const lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 100, 100);
  const rules: Int32Array = await vcall(lp, "getRules", "()[I");
  expect(rules.length).toBe(22);
  await vcall(lp, "addRule", "(II)V", 3, 123);
  expect(rules[3]).toBe(123);
  rules[10] = -1;
  expect(await vcall(lp, "getRule", "(I)I", 10)).toBe(-1);
  await vcall(lp, "removeRule", "(I)V", 3);
  expect(rules[3]).toBe(0);
});
