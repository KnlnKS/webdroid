import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { newObj, vcall } from "../../../src/jvm/natives/jlang";
import { newPaint } from "../../../src/android/paint";
import { locateDrawnText, canvasOver, canvasOf } from "../../../src/android/canvas";
import { loadPlatformDex } from "../../../src/android/framework";
import { systemFonts } from "./fonts";

async function probe() {
  await loadPlatformDex();
  rt.linkNatives();
  await systemFonts();
  const shader = await newObj("android/graphics/RuntimeShader", "(Ljava/lang/String;)V", `
    layout(color) uniform half4 color;
    uniform float boundary, green;
    uniform float2x2 transform;
    half4 main(float2 p) { return (transform * p).x < boundary ? half4(color.rgb * color.a, color.a) : half4(0, green, 0, 1); }
  `);
  await vcall(shader, "setFloatUniform", "(Ljava/lang/String;[F)V", "transform", new Float32Array([1, 0, 0, 1]));
  await vcall(shader, "setFloatUniform", "(Ljava/lang/String;F)V", "boundary", 8);
  await vcall(shader, "setColorUniform", "(Ljava/lang/String;I)V", "color", 0x80ff0000);
  await vcall(shader, "setFloatUniform", "(Ljava/lang/String;F)V", "green", 1);
  const paint = newPaint();
  await vcall(paint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", shader);
  const node = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "shader");
  await vcall(node, "setPosition", "(IIII)Z", 0, 0, 16, 16);
  const recording = await vcall(node, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", 16, 16);
  await vcall(recording, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 0, 0, 16, 16, paint);
  await vcall(recording, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 8, 0, 16, 16, paint);
  const textPaint = newPaint();
  await vcall(textPaint, "setTextSize", "(F)V", 2);
  await vcall(recording, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "Label", 0, 14, textPaint);
  await vcall(node, "endRecording", "()V");
  await vcall(shader, "setColorUniform", "(Ljava/lang/String;I)V", "color", 0xff0000ff);
  const ctx = new OffscreenCanvas(64, 64).getContext("2d")!;
  const canvas = canvasOver(ctx, 64, 64, true);
  const owner = { drawnText: null, drawnTextPoints: null, drawnTextCount: 0 };
  canvasOf(canvas).semanticOwner = owner;
  ctx.translate(10, 12); ctx.scale(2, 2);
  let rasterizations = 0;
  const drawArrays = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function(mode, first, count) {
    rasterizations++; return drawArrays.call(this, mode, first, count);
  };
  await vcall(canvas, "drawRenderNode", "(Landroid/graphics/RenderNode;)V", node);
  const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
  const recorded = pixel(20, 20), outside = pixel(30, 20), recordedRasters = rasterizations;
  ctx.clearRect(0, 0, 16, 16);
  await vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 0, 0, 16, 16, paint);
  const direct = pixel(20, 20);
  WebGL2RenderingContext.prototype.drawArrays = drawArrays;
  let invalid = false;
  try { await vcall(shader, "setFloatUniform", "(Ljava/lang/String;F)V", "color", 1); }
  catch (error) { invalid = !!rt.iof(error, "java/lang/IllegalArgumentException"); }
  const text = locateDrawnText(owner, "label", 64, 64);
  return { recorded, outside, direct, invalid, recordedRasters, rasterizations, text: text && [Math.round(text.x), Math.round(text.y)] };
}
export default probe;
