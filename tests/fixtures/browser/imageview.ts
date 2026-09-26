import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { mangleMethod } from "../../../src/jvm/abi";
import { vcall } from "../../../src/jvm/natives/jlang";
import { JImageView } from "../../../src/android/imageview";
import { JCanvas, JMatrix } from "../../../src/android/graphics";

async function probe() {
  rt.linkNatives();
  const view = rt.make("android/widget/ImageView");
  if (!(view instanceof JImageView)) throw new Error("Invalid ImageView");
  view.right = 100; view.bottom = 80;
  view.padL = 2; view.padT = 3; view.padR = 4; view.padB = 5;
  const drawable = rt.make("android/graphics/drawable/Drawable");
  let transform: number[] = [];
  Object.assign(drawable, {
    [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async (canvas: JCanvas) => {
      await Promise.resolve();
      const m = canvas.ctx.getTransform(); transform = [m.a, m.b, m.c, m.d, m.e, m.f];
      canvas.ctx.fillStyle = "#00ff00"; canvas.ctx.fillRect(0, 0, 2, 3);
    },
  });
  await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", drawable);
  view.drawableW = 20; view.drawableH = 10;
  const types = await vcall(rt.link("android/widget/ImageView$ScaleType").ctor, "values", "()[Landroid/widget/ImageView$ScaleType;");
  const results = [];
  for (const type of types) {
    await vcall(view, "setScaleType", "(Landroid/widget/ImageView$ScaleType;)V", type);
    const source = new JMatrix(); source.m = [2, 0, 0, 3, 5, 7];
    if (!type.ord) {
      await vcall(view, "setImageMatrix", "(Landroid/graphics/Matrix;)V", source);
      source.m[4] = 99;
    }
    const ctx = new OffscreenCanvas(100, 80).getContext("2d")!;
    await vcall(view, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 100, 80));
    const matrix = await vcall(view, "getImageMatrix", "()Landroid/graphics/Matrix;");
    const bounds = await vcall(drawable, "getBounds", "()Landroid/graphics/Rect;");
    results.push({ type: (await vcall(view, "getScaleType", "()Landroid/widget/ImageView$ScaleType;")).ord,
      matrix: [...matrix.m], transform, bounds: [bounds.left, bounds.top, bounds.right, bounds.bottom],
      restored: ctx.getTransform().isIdentity, pixel: [...ctx.getImageData(8, 11, 1, 1).data] });
  }
  await vcall(view, "setScaleType", "(Landroid/widget/ImageView$ScaleType;)V", types[0]);
  await vcall(view, "setImageMatrix", "(Landroid/graphics/Matrix;)V", null);
  const first = await vcall(view, "getImageMatrix", "()Landroid/graphics/Matrix;"); first.m[4] = 99;
  const reset = await vcall(view, "getImageMatrix", "()Landroid/graphics/Matrix;");
  return { results, reset: reset.m };
}
export default probe;
