import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { newObj, vcall, linkInit } from "../../src/jvm/natives/jlang";
import { JCanvas, JPaint } from "../../src/android/graphics";

async function probe() {
  rt.linkNatives();
  const results = [];
  const enums = (await linkInit("android/graphics/BlurMaskFilter$Blur")).ctor;
  for (const style of ["NORMAL", "SOLID", "OUTER", "INNER"]) {
    const value = await vcall(enums, "valueOf", "(Ljava/lang/String;)Landroid/graphics/BlurMaskFilter$Blur;", style);
    const filter = await newObj("android/graphics/BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", 5, value);
    const paint = rt.make("android/graphics/Paint");
    if (!(paint instanceof JPaint)) throw new Error("Invalid Paint");
    paint.color = 0x80ff0000;
    await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", filter);
    const ctx = new OffscreenCanvas(80, 80).getContext("2d")!;
    const canvas = JCanvas.wrap(ctx, 80, 80);
    ctx.translate(8, 4);
    ctx.scale(2, 2);
    ctx.beginPath(); ctx.rect(10, 0, 30, 40); ctx.clip();
    const draw = () => vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 10, 10, 26, 26, paint);
    await draw();
    const first = ctx.getImageData(0, 0, 80, 80).data;
    const alpha = (x: number, y: number) => first[(y * 80 + x) * 4 + 3];
    const m = ctx.getTransform();
    ctx.save(); ctx.resetTransform(); ctx.clearRect(0, 0, 80, 80); ctx.restore();
    await draw();
    const second = ctx.getImageData(0, 0, 80, 80).data;
    let maximum = 0;
    for (let i = 3; i < first.length; i += 4) maximum = Math.max(maximum, first[i]);
    results.push({ style, inside: alpha(44, 40), outside: alpha(64, 40), clipped: alpha(26, 40), maximum,
      restored: m.a === 2 && m.d === 2 && m.e === 8 && m.f === 4 && ctx.filter === "none" && ctx.globalCompositeOperation === "source-over",
      repeated: first.every((v, i) => v === second[i]) });
  }
  return results;
}
Object.defineProperty(window, "blurMaskProbe", { value: probe() });
