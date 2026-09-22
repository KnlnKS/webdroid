import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { mangleMethod } from "../../src/jvm/abi";
import { newObj, vcall } from "../../src/jvm/natives/jlang";
import { JTextView } from "../../src/android/textview";
import { JCanvas, measureText, type JPaint } from "../../src/android/graphics";
import { makeSpec, MS_EXACTLY, MS_AT_MOST, JViewGroup } from "../../src/android/view";

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
  const result = { measures, draws, width: view.layout?.lines[0].width, height: view.measuredH,
    center: [...ctx.getImageData(50, 16, 1, 1).data], outside: [...ctx.getImageData(10, 16, 1, 1).data],
    layout: await vcall(view, "getLayout", "()Landroid/text/Layout;") === view.layout };
  const heightLimits: number[] = [];
  for (const [method, value] of [["setHeight", 20], ["setMaxHeight", 25], ["setLines", 1]] as const) {
    await vcall(view, method, "(I)V", value);
    await vcall(view, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(100, MS_AT_MOST));
    heightLimits.push(view.measuredH);
  }
  await vcall(view, "setText", "(Ljava/lang/CharSequence;)V", "A long title with a location");
  view.singleLine = view.ellipsizeEnd = true;
  const width = measureText(view.paintT, "A long title…"), wrapped = await view.measuredLines(width);
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
  const aligned = rt.make("android/widget/TextView");
  if (!(aligned instanceof JTextView)) throw new Error("Invalid aligned TextView");
  aligned.right = 100; aligned.bottom = 50; aligned.paintT.textSize = 20;
  const parent = new JViewGroup(); aligned.parent = parent;
  await vcall(aligned, "setText", "(Ljava/lang/CharSequence;)V", "Hi");
  await vcall(aligned, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(50, MS_EXACTLY));
  const alignmentPixels: number[] = [];
  for (const alignment of [2, 4, 3]) {
    await vcall(parent, "setTextAlignment", "(I)V", alignment);
    const ctx = new OffscreenCanvas(100, 50).getContext("2d")!;
    await vcall(aligned, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 100, 50));
    const pixels = ctx.getImageData(0, 0, 100, 50).data;
    let lo = 100, hi = -1;
    for (let y = 0; y < 50; y++) for (let x = 0; x < 100; x++) if (pixels[(y * 100 + x) * 4 + 3]) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    alignmentPixels.push((lo + hi) / 2);
  }
  await vcall(aligned, "setTextAlignment", "(I)V", 4);
  await vcall(parent, "setTextAlignment", "(I)V", 2);
  const alignment = { centers: alignmentPixels, own: await vcall(aligned, "getTextAlignment", "()I"),
    relative: [aligned.horizontalGravity("مرحبا", 2, 0), aligned.horizontalGravity("مرحبا", 3, 0),
      aligned.horizontalGravity("Hi", 5, 1), aligned.horizontalGravity("Hi", 6, 1)] };
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
  const mixed = rt.make("android/widget/TextView");
  if (!(mixed instanceof JTextView)) throw new Error("Invalid mixed TextView");
  mixed.paintT.textSize = 12; mixed.singleLine = mixed.ellipsizeEnd = mixed.allCaps = true;
  const mixedText = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "a ß replacement trailing words");
  await vcall(mixedText, "setSpan", "(Ljava/lang/Object;III)V", span, 4, 15, 33);
  await vcall(mixed, "setText", "(Ljava/lang/CharSequence;)V", mixedText);
  await vcall(mixed, "onMeasure", "(II)V", makeSpec(80, MS_EXACTLY), makeSpec(60, MS_EXACTLY));
  mixed.right = 80; mixed.bottom = 60;
  const mixedLayout = await vcall(mixed, "getLayout", "()Landroid/text/Layout;");
  const mixedCanvas = new OffscreenCanvas(80, 60).getContext("2d")!;
  const directCanvas = new OffscreenCanvas(80, 60).getContext("2d")!;
  await vcall(mixed, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(mixedCanvas, 80, 60));
  await vcall(mixedLayout, "draw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(directCanvas, 80, 60));
  const directPixels = directCanvas.getImageData(0, 0, 80, 60).data;
  const combined = { line: mixedLayout.lines[0].text, width: await vcall(mixedLayout, "getLineWidth", "(I)F", 0),
    ellipsis: await vcall(mixedLayout, "getEllipsisCount", "(I)I", 0),
    span: [mixedLayout.replacements[0].start, mixedLayout.replacements[0].end], original: mixedText.text,
    same: mixedLayout === mixed.layout, pixels: mixedCanvas.getImageData(0, 0, 80, 60).data.every((v, i) => v === directPixels[i]) };
  const selectionView = rt.make("android/widget/TextView");
  await vcall(selectionView, "setText", "(Ljava/lang/CharSequence;)V", "ab\ncd");
  await vcall(selectionView, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(100, MS_EXACTLY));
  const selectedLayout = await vcall(selectionView, "getLayout", "()Landroid/text/Layout;");
  const path = await newObj("android/graphics/Path");
  await vcall(selectedLayout, "getSelectionPath", "(IILandroid/graphics/Path;)V", 4, 1, path);
  const selection = path.ops.map((op: number[]) => [op[1], op[3]]);
  await vcall(selectedLayout, "getSelectionPath", "(IILandroid/graphics/Path;)V", 2, 2, path);
  const emptySelection = path.ops.length;
  const emptyCanvas = await newObj("android/graphics/Canvas", "()V"), otherCanvas = await newObj("android/graphics/Canvas", "()V");
  await vcall(emptyCanvas, "save", "()I");
  await vcall(emptyCanvas, "translate", "(FF)V", 4, 7);
  const independentCanvas = otherCanvas.ctx.getTransform().isIdentity && emptyCanvas.ctx.getTransform().e === 4;
  const checkBox = rt.make("android/widget/CheckBox");
  await vcall(checkBox, "measure", "(II)V", 0x40000030, 0x40000030);
  const checkBoxHeight = await vcall(checkBox, "getMeasuredHeight", "()I");
  const input = rt.make("android/widget/EditText");
  if (!(input instanceof JTextView)) throw new Error("Invalid EditText");
  input.right = 100; input.bottom = 50; input.focused = true;
  await vcall(input, "setHint", "(Ljava/lang/CharSequence;)V", "Phone number");
  await vcall(input, "setHintTextColor", "(I)V", 0);
  await vcall(input, "measure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(50, MS_EXACTLY));
  input.blinkStart = performance.now();
  const cursor = await newObj("android/graphics/drawable/GradientDrawable", "()V");
  await vcall(cursor, "setColor", "(I)V", 0xffff0000 | 0);
  await vcall(cursor, "setSize", "(II)V", 4, -1);
  await vcall(input, "setTextCursorDrawable", "(Landroid/graphics/drawable/Drawable;)V", cursor);
  const cursorIdentity = await vcall(input, "getTextCursorDrawable", "()Landroid/graphics/drawable/Drawable;") === cursor;
  const caretCanvas = new OffscreenCanvas(100, 50).getContext("2d")!;
  await vcall(input, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(caretCanvas, 100, 50));
  const caretAtStart = caretCanvas.getImageData(2, 0, 1, 50).data.some((v, i) => i % 4 === 3 && v === 255);
  const cursorPixels = [...caretCanvas.getImageData(2, 20, 1, 1).data];
  await vcall(input, "setTextCursorDrawable", "(I)V", 0);
  const cursorCleared = await vcall(input, "getTextCursorDrawable", "()Landroid/graphics/drawable/Drawable;") === null;
  return { ...result, cursorIdentity, cursorPixels, cursorCleared, selection, emptySelection, independentCanvas, checkBoxHeight, caretAtStart, heightLimits, styles, alignment, combined, ellipsis: wrapped.lines.map(l => l.text), cached: wrapped === await view.measuredLines(width),
    fitting: (await view.measuredLines(measureText(view.paintT, view.text))).lines.map(l => l.text), cleared: (await view.measuredLines(width)).replacements.length === 0,
    compound: { drawsAt, retained, restored: surface.getTransform().isIdentity } };
}
Object.defineProperty(window, "textViewProbe", { value: probe() });
