import { expect, test } from "bun:test";
import "../src/natives";
import { JCanvas, JPaint, locateDrawnText } from "../src/android/graphics";
import { JObj, rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextView } from "../src/android/textview";

rt.linkNatives();

const canvas = () => JCanvas.wrap({
  fillText() {}, fillRect() {},
  getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }; },
} as unknown as OffscreenCanvasRenderingContext2D, 100, 100);

test("Canvas records custom-drawn text for semantic lookup", async () => {
  const cv = canvas(), paint = new JPaint();
  const owner = { drawnText: null as string[] | null, drawnTextPoints: null as Float32Array | null, drawnTextCount: 0 };
  cv.semanticOwner = owner;

  await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "first", 0, 0, paint);
  await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "second", 0, 20, paint);

  expect(owner.drawnText).toEqual(["first", "second"]);
  expect(owner.drawnTextPoints![0]).toBe(58);
  expect(owner.drawnTextPoints![1]).toBeCloseTo(5.6);
  expect(owner.drawnTextPoints![2]).toBe(58);
  expect(owner.drawnTextPoints![3]).toBeCloseTo(25.6);
});

test("Canvas resolves virtual CharSequence text before drawing", async () => {
  class Sequence extends JObj {
    [mangleMethod("toString", "()Ljava/lang/String;")]() { return "Big Buck Bunny"; }
  }
  const cv = canvas(), paint = new JPaint();
  const owner = { drawnText: null as string[] | null, drawnTextPoints: null as Float32Array | null, drawnTextCount: 0 };
  cv.semanticOwner = owner;

  await vcall(cv, "drawText", "(Ljava/lang/CharSequence;IIFFLandroid/graphics/Paint;)V", new Sequence(), 4, 8, 0, 0, paint);

  expect(owner.drawnText).toEqual(["Buck"]);
});

test("drawn text lookup uses the matching run point", () => {
  const owner = {
    drawnText: ["leading", "later target", "tail"],
    drawnTextPoints: new Float32Array([10, 11, 20, 21, 30, 31]),
    drawnTextCount: 3,
  };

  expect(locateDrawnText(owner, "target", 100, 100)).toEqual({ x: 20, y: 21 });
});

test("drawn text lookup preserves contiguous phrases", () => {
  const owner = {
    drawnText: ["Big", "Buck", "Bunny"],
    drawnTextPoints: new Float32Array([10, 11, 20, 21, 30, 31]),
    drawnTextCount: 3,
  };

  expect(locateDrawnText(owner, "Buck Bunny", 100, 100)).toEqual({ x: 20, y: 21 });
});

test("ImageSpan retains its supplied drawable", async () => {
  const drawable = new JObj();
  const span = await newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;I)V", drawable, 1);

  expect(await vcall(span, "getDrawable", "()Landroid/graphics/drawable/Drawable;")).toBe(drawable);
});

test("TextView defaults to no movement method", async () => {
  expect(await vcall(new JTextView(), "getDefaultMovementMethod", "()Landroid/text/method/MovementMethod;")).toBeNull();
});
