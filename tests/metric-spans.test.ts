import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { JLayout, JSpannable, JTextPaint } from "../src/android/text";
import { fillFontMetrics } from "../src/android/graphics";

rt.linkNatives();

test("paragraph spans use general layout and run before font padding", async () => {
  const paint = new JTextPaint(); paint.textSize = 48;
  const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0, width: 0 };
  fillFontMetrics(paint, metrics, true);
  for (const pad of [false, true]) {
    const boring = await newObj("android/text/BoringLayout", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;ILandroid/text/Layout$Alignment;FFLandroid/text/BoringLayout$Metrics;Z)V",
      "", paint, 500, null, 1, 0, metrics, +pad);
    expect([await vcall(boring, "getHeight", "()I"), await vcall(boring, "getLineBaseline", "(I)I", 0)]).toEqual(pad ? [65, 51] : [57, 45]);
    for (const density of [false, true]) {
      const span = rt.make("android/text/style/LineHeightSpan" + (density ? "$WithDensity" : ""));
      const signature = "(Ljava/lang/CharSequence;IIIILandroid/graphics/Paint$FontMetricsInt;" + (density ? "Landroid/text/TextPaint;" : "") + ")V";
      Object.assign(span, { [mangleMethod("chooseHeight", signature)]:
        (_text: unknown, _start: number, _end: number, _spanY: number, _y: number, fm: typeof metrics, suppliedPaint?: JTextPaint) => {
          expect([fm.ascent, fm.descent]).toEqual([-45, 12]);
          if (density) expect(suppliedPaint).toBe(paint);
          fm.descent += Math.ceil((72 - (fm.descent - fm.ascent)) / 2);
          fm.ascent = fm.descent - 72;
        },
      });
      const text = new JSpannable(); text.text = "Afghanistan";
      text.spans.push({ span, start: 0, end: 11, flags: 18 });
      expect(await vcall(rt.link("android/text/BoringLayout").ctor, "isBoring", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)Landroid/text/BoringLayout$Metrics;", text, paint)).toBeNull();
      const layout = new JLayout(); layout.paint = paint; layout.src = text; layout.includePad = pad;
      layout.lines = [{ start: 0, end: 11, text: text.text, width: 260 }];
      layout.updateMetrics();
      await layout.applyLineHeightSpans();
      expect([layout.lineTop(1), layout.baseline(0), -layout.padTop, layout.padBottom]).toEqual(pad ? [65, 51, 1, -6] : [72, 52, -0, 0]);
    }
  }
});

test("style spans preserve existing italics for drawing and measurement", async () => {
  const typeface = rt.link("android/graphics/Typeface").ctor;
  const italic = await vcall(typeface, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2);
  const span = await newObj("android/text/style/StyleSpan", "(I)V", 1);
  for (const method of ["updateDrawState", "updateMeasureState"]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    await vcall(paint, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", italic);
    await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
    const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
    expect(await vcall(face, "getStyle", "()I")).toBe(3);
    expect(await vcall(face, "getWeight", "()I")).toBe(700);
  }
  expect(await vcall(italic, "getStyle", "()I")).toBe(2);
});

test("style span weight adjustment clamps to Android's supported range", async () => {
  for (const [adjustment, weight] of [[900, 1000], [-900, 1]]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    const span = await newObj("android/text/style/StyleSpan", "(II)V", 1, adjustment);
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
    expect(await vcall(face, "getWeight", "()I")).toBe(weight);
  }
});

test("relative size spans multiply the current size for drawing and measurement", async () => {
  const span = await newObj("android/text/style/RelativeSizeSpan", "(F)V", 1.5);
  expect(await vcall(span, "getSizeChange", "()F")).toBe(1.5);
  for (const method of ["updateDrawState", "updateMeasureState"]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    await vcall(paint, "setTextSize", "(F)V", 20);
    await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(paint, "getTextSize", "()F")).toBe(30);
  }
});
