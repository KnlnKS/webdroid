import { expect, test } from "bun:test";
import "../src/natives";
import { JCanvas, JPaint } from "../src/android/graphics";
import { JObj, rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

const canvas = () => JCanvas.wrap({
  fillText() {}, fillRect() {},
} as unknown as OffscreenCanvasRenderingContext2D, 100, 100);

test("Canvas records custom-drawn text for semantic lookup", async () => {
  const cv = canvas(), paint = new JPaint();
  const owner = { drawnText: null as string[] | null };
  cv.semanticOwner = owner;

  await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "first", 0, 0, paint);
  await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "second", 0, 20, paint);

  expect(owner.drawnText).toEqual(["first", "second"]);
});

test("Canvas resolves virtual CharSequence text before drawing", async () => {
  class Sequence extends JObj {
    [mangleMethod("toString", "()Ljava/lang/String;")]() { return "Big Buck Bunny"; }
  }
  const cv = canvas(), paint = new JPaint();
  const owner = { drawnText: null as string[] | null };
  cv.semanticOwner = owner;

  await vcall(cv, "drawText", "(Ljava/lang/CharSequence;IIFFLandroid/graphics/Paint;)V", new Sequence(), 4, 8, 0, 0, paint);

  expect(owner.drawnText).toEqual(["Buck"]);
});
