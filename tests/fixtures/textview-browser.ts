import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { mangleMethod } from "../../src/jvm/abi";
import { newObj, vcall } from "../../src/jvm/natives/jlang";
import { JTextView } from "../../src/android/textview";
import { JCanvas, measureText, type JPaint } from "../../src/android/graphics";
import { makeSpec, MS_EXACTLY, MS_AT_MOST } from "../../src/android/view";

async function probe() {
  rt.linkNatives();
  const view = rt.make("android/widget/TextView");
  if (!(view instanceof JTextView)) throw new Error("Invalid TextView");
  view.paintT.textSize = 12;
  const span = rt.make("android/text/style/ReplacementSpan");
  let measures = 0, draws = 0;
  Object.assign(span, {
    [mangleMethod("getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I")]:
      async (_p: JPaint, _cs: unknown, _a: number, _b: number, fm: { top: number; ascent: number; descent: number; bottom: number }) => {
        measures++; await Promise.resolve();
        fm.top = fm.ascent = -32; fm.descent = fm.bottom = 0;
        return 24;
      },
    [mangleMethod("draw", "(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V")]:
      async (canvas: JCanvas, _cs: unknown, _a: number, _b: number, x: number, _top: number, baseline: number) => {
        draws++; await Promise.resolve();
        canvas.ctx.fillStyle = "#00ff00"; canvas.ctx.fillRect(x, baseline - 32, 24, 32);
      },
  });
  const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "replacement");
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 11, 33);
  await vcall(view, "setText", "(Ljava/lang/CharSequence;)V", text);
  await vcall(view, "setGravity", "(I)V", 17);
  for (let i = 0; i < 2; i++) await vcall(view, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(100, MS_AT_MOST));
  view.right = 100; view.bottom = view.measuredH;
  const canvas = new OffscreenCanvas(100, view.measuredH), ctx = canvas.getContext("2d")!;
  await vcall(view, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 100, view.measuredH));
  const result = { measures, draws, width: view.lineWidths[0], height: view.measuredH,
    center: [...ctx.getImageData(50, 16, 1, 1).data], outside: [...ctx.getImageData(10, 16, 1, 1).data],
    layout: await vcall(view, "getLayout", "()Landroid/text/Layout;") === view.spanLayout };
  await vcall(view, "setText", "(Ljava/lang/CharSequence;)V", "A long title with a location");
  view.singleLine = view.ellipsizeEnd = true;
  const width = measureText(view.paintT, "A long title…"), wrapped = view.linesFor(width);
  const styles: boolean[] = [];
  for (const style of [0, 1, 2]) {
    const actual = new OffscreenCanvas(100, 60).getContext("2d")!;
    const expected = new OffscreenCanvas(100, 60).getContext("2d")!;
    const paint = view.paintT;
    paint.textSize = 40; paint.strokeWidth = 4; paint.style = style;
    await vcall(JCanvas.wrap(actual, 100, 60), "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "Hi", 8, 45, paint);
    expected.font = paint.font(); expected.fillStyle = expected.strokeStyle = "black";
    expected.lineWidth = 4; expected.lineJoin = "miter";
    if (style !== 1) expected.fillText("Hi", 8, 45);
    if (style !== 0) expected.strokeText("Hi", 8, 45);
    const pixels = expected.getImageData(0, 0, 100, 60).data;
    styles.push(actual.getImageData(0, 0, 100, 60).data.every((v, i) => v === pixels[i]));
  }
  view.paintT.textSize = 12;
  const compound = rt.make("android/widget/TextView");
  if (!(compound instanceof JTextView)) throw new Error("Invalid compound TextView");
  compound.right = 60; compound.bottom = 70;
  compound.padL = 2; compound.padT = 3; compound.padR = 4; compound.padB = 5; compound.drawablePad = 2;
  const bounds = [[2, 3, 8, 11], [1, 2, 11, 8], [0, 0, 5, 7], [2, 1, 14, 6]];
  const drawsAt: number[][] = [], drawables = [];
  for (const bound of bounds) {
    const d = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff00ff00);
    await vcall(d, "setBounds", "(IIII)V", ...bound);
    Object.assign(d, { [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async (canvas: JCanvas) => {
      await Promise.resolve(); const m = canvas.ctx.getTransform(); drawsAt.push([m.e, m.f]);
      canvas.ctx.fillStyle = "#00ff00"; canvas.ctx.fillRect(bound[0], bound[1], bound[2] - bound[0], bound[3] - bound[1]);
    } });
    drawables.push(d);
  }
  await vcall(compound, "setCompoundDrawables", "(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V", ...drawables);
  await vcall(compound, "onMeasure", "(II)V", makeSpec(60, MS_EXACTLY), makeSpec(70, MS_EXACTLY));
  const surface = new OffscreenCanvas(60, 70).getContext("2d")!;
  await vcall(compound, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(surface, 60, 70));
  const retained = await Promise.all(drawables.map(async d => { const b = await vcall(d, "getBounds", "()Landroid/graphics/Rect;"); return [b.left, b.top, b.right, b.bottom]; }));
  return { ...result, styles, ellipsis: wrapped.lines, cached: wrapped === view.linesFor(width),
    fitting: view.linesFor(measureText(view.paintT, view.text)).lines, cleared: view.spanLayout === null,
    compound: { drawsAt, retained, restored: surface.getTransform().isIdentity } };
}
Object.defineProperty(window, "textViewProbe", { value: probe() });
