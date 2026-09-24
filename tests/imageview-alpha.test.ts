import { expect, test } from "bun:test";
import "../src/natives";
import { JImageView } from "../src/android/imageview";
import { JDrawable } from "../src/android/drawable";
import { vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";

rt.linkNatives();

test("ImageView image alpha applies to the drawable and survives replacement", async () => {
  const view = new JImageView();
  const first = new JDrawable();
  await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", first);
  await vcall(view, "setImageAlpha", "(I)V", 64);
  expect(first.alpha).toBe(64);
  expect(await vcall(view, "getImageAlpha", "()I")).toBe(64);
  expect(view.alphaV).toBe(1);

  const replacement = new JDrawable();
  await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", replacement);
  expect(replacement.alpha).toBe(64);
  await vcall(view, "setAlpha", "(I)V", 255);
  expect(replacement.alpha).toBe(255);
});
