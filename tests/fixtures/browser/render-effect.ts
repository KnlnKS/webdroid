import "../../../src/natives.ts";
import { newObj, vcall, scall } from "../../../src/jvm/natives/jentry.ts";
import { newPaint } from "../../../src/android/paint.ts";
import { canvasOver } from "../../../src/android/canvas.ts";
import { bootWithFonts } from "./boot.ts";

const E = "android/graphics/RenderEffect", LE = `L${E};`;
/** the red channel along the middle row of a 60x20 node, white with its left half black, drawn under `effect` */
async function row(effect: unknown): Promise<number[]> {
  const node = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "effect");
  await vcall(node, "setPosition", "(IIII)Z", 0, 0, 60, 20);
  const rec = await vcall(node, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", 60, 20);
  await vcall(rec, "drawColor", "(I)V", -1);
  const black = await newPaint();
  await vcall(black, "setColor", "(I)V", 0xff000000 | 0);
  await vcall(rec, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 0, 0, 30, 20, black);
  await vcall(node, "endRecording", "()V");
  await vcall(node, "setRenderEffect", `(${LE})Z`, effect);
  const ctx = new OffscreenCanvas(60, 20).getContext("2d")!;
  await vcall(await canvasOver(ctx, 60, 20, true), "drawRenderNode", "(Landroid/graphics/RenderNode;)V", node);
  const d = ctx.getImageData(0, 10, 60, 1).data;
  return Array.from({ length: 60 }, (_, x) => d[x * 4]);
}

export default async function probe() {
  await bootWithFonts();
  const clamp = await scall("android/graphics/Shader$TileMode", "valueOf", "(Ljava/lang/String;)Landroid/graphics/Shader$TileMode;", "CLAMP");
  const blur = await scall(E, "createBlurEffect", `(FFLandroid/graphics/Shader$TileMode;)${LE}`, 10, 10, clamp);
  const offset = await scall(E, "createOffsetEffect", `(FF)${LE}`, 5, 0);
  const matrix = await newObj("android/graphics/ColorMatrix", "()V");
  await vcall(matrix, "set", "([F)V", Float32Array.of(-1, 0, 0, 0, 255, 0, -1, 0, 0, 255, 0, 0, -1, 0, 255, 0, 0, 0, 1, 0));
  const invert = await scall(E, "createColorFilterEffect", `(Landroid/graphics/ColorFilter;)${LE}`,
    await newObj("android/graphics/ColorMatrixColorFilter", "(Landroid/graphics/ColorMatrix;)V", matrix));
  return {
    blurred: await row(blur),
    shifted: await row(await scall(E, "createChainEffect", `(${LE}${LE})${LE}`, offset, blur)),
    inverted: await row(invert),
  };
}
