import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, makeSpec, MS_AT_MOST, MS_EXACTLY } from "../src/android/view";

rt.linkNatives();
test("Space constructors initialize an invisible spacer whose wrap size respects its minimum", async () => {
  for (const desc of ["(Landroid/content/Context;)V", "(Landroid/content/Context;Landroid/util/AttributeSet;)V"]) {
    const space = await newObj("android/widget/Space", desc, null, null) as JView;
    expect(space.visibility).toBe(4);
    space.minW = 10; space.minH = 20;
    await vcall(space, "onMeasure", "(II)V", makeSpec(100, MS_AT_MOST), makeSpec(80, MS_EXACTLY));
    expect([space.measuredW, space.measuredH]).toEqual([10, 80]);
  }
});
