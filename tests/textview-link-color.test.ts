import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextView } from "../src/android/textview";
import { perf } from "../src/perf";

test("TextView retains link color lists and updates its paint across state changes without layout", async () => {
  rt.linkNatives();
  const view = rt.make("android/widget/TextView");
  if (!(view instanceof JTextView)) throw new Error("Invalid TextView");
  const colors = await newObj("android/content/res/ColorStateList", "([[I[I)V",
    [Int32Array.of(16842919), new Int32Array(0)], Int32Array.of(0xff123456, 0xffabcdef));
  const layouts = perf.layoutRequests;
  await vcall(view, "setLinkTextColor", "(Landroid/content/res/ColorStateList;)V", colors);
  expect(await vcall(view, "getLinkTextColors", "()Landroid/content/res/ColorStateList;")).toBe(colors);
  expect(view.paintT.linkColor).toBe(0xffabcdef | 0);
  view.pressed = true;
  await view.refreshDrawableState();
  expect(view.paintT.linkColor).toBe(0xff123456 | 0);
  await vcall(view, "setLinkTextColor", "(I)V", 0xff112233 | 0);
  expect(view.paintT.linkColor).toBe(0xff112233 | 0);
  await vcall(view, "setLinkTextColor", "(Landroid/content/res/ColorStateList;)V", null);
  expect(await vcall(view, "getLinkTextColors", "()Landroid/content/res/ColorStateList;")).toBeNull();
  expect(view.paintT.linkColor).toBe(0xff112233 | 0);
  expect(perf.layoutRequests).toBe(layouts);
});
