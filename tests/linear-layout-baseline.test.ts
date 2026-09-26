import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { JLinearLayout } from "../src/android/layouts";
import { JView } from "../src/android/view";

rt.linkNatives();

test("LinearLayout retains a valid baseline child index", async () => {
  const layout = new JLinearLayout();
  layout.children.push(new JView(), new JView());
  expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(-1);
  await vcall(layout, "setBaselineAlignedChildIndex", "(I)V", 1);
  expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(1);
});

test("LinearLayout rejects baseline indexes outside its current children", async () => {
  const layout = new JLinearLayout();
  layout.children.push(new JView());
  for (const index of [-1, 1]) {
    await expect(vcallAsync(layout, "setBaselineAlignedChildIndex", "(I)V", index)).rejects.toMatchObject({
      constructor: rt.link("java/lang/IllegalArgumentException").ctor,
    });
  }
  expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(-1);
});
