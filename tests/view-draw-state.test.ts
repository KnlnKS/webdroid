import { expect, test } from "bun:test";
import { canvasMethods, JCanvas } from "../src/android/graphics";
import { JDrawable } from "../src/android/drawable";
import { JImageView } from "../src/android/imageview";
import { drawView, JView } from "../src/android/view";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";

test("view traversal exposes the child draw save to Android canvas code", async () => {
  let depth = 0;
  const context = {
    save() { depth++; },
    restore() { depth--; },
    translate() {},
    beginPath() {},
    rect() {},
    clip() {},
  } as unknown as OffscreenCanvasRenderingContext2D;
  const canvas = JCanvas.wrap(context, 100, 100);
  class CustomView extends JView {
    observedSaveCount = 0;
    [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")](target: JCanvas) {
      this.observedSaveCount = target.saveCount;
    }
  }
  const view = new CustomView();
  view.right = view.bottom = 100;

  await drawView(view, canvas);

  expect(view.observedSaveCount).toBe(2);
  expect(canvas.saveCount).toBe(1);
  expect(depth).toBe(0);
});

test("canvas root state rejects unmatched restores", () => {
  let restores = 0;
  const context = {
    restore() { restores++; },
  } as unknown as OffscreenCanvasRenderingContext2D;
  const canvas = JCanvas.wrap(context, 100, 100);
  const restore = canvasMethods!["restore()V"] as (this: JCanvas) => void;
  const restoreToCount = canvasMethods!["restoreToCount(I)V"] as (this: JCanvas, count: number) => void;

  expect(() => restore.call(canvas)).toThrow();
  expect(() => restoreToCount.call(canvas, 0)).toThrow();
  expect(canvas.saveCount).toBe(1);
  expect(restores).toBe(0);
});

test.each([
  ["fit-center", 3, 1],
  ["center-crop", 6, 2],
] as const)("image view retains its %s draw state until a suspending drawable completes", async (_name, scaleType, pendingDepth) => {
  rt.link("android/widget/ImageView");
  let depth = 0;
  const context = {
    save() { depth++; },
    restore() { depth--; },
    translate() {},
    beginPath() {},
    rect() {},
    clip() {},
  } as unknown as OffscreenCanvasRenderingContext2D;
  const canvas = JCanvas.wrap(context, 100, 100);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  class SuspendedDrawable extends JDrawable {
    intrinsicW() { return 20; }
    intrinsicH() { return 20; }
    async [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]() {
      await gate;
      completed = true;
    }
  }
  const view = new JImageView();
  view.drawable = new SuspendedDrawable();
  view.scaleType = scaleType;
  view.right = view.bottom = 100;

  const drawing = drawView(view, canvas);
  await Promise.resolve();
  expect(completed).toBeFalse();
  expect(depth).toBe(pendingDepth);

  release();
  await drawing;
  expect(completed).toBeTrue();
  expect(canvas.saveCount).toBe(1);
  expect(depth).toBe(0);
});
