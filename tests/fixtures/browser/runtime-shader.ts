import "../../../src/natives.ts";
import { newObj, vcall, scall, iof } from "../../../src/jvm/natives/jentry.ts";
import { newPaint } from "../../../src/android/paint.ts";
import { canvasOver } from "../../../src/android/canvas.ts";
import { bootWithFonts } from "./boot.ts";

async function probe() {
  await bootWithFonts();
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
  const paint = await newPaint();
  await vcall(paint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", shader);
  const node = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "shader");
  await vcall(node, "setPosition", "(IIII)Z", 0, 0, 16, 16);
  const recording = await vcall(node, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", 16, 16);
  await vcall(recording, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 0, 0, 16, 16, paint);
  await vcall(recording, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 8, 0, 16, 16, paint);
  await vcall(node, "endRecording", "()V");
  await vcall(shader, "setColorUniform", "(Ljava/lang/String;I)V", "color", 0xff0000ff);
  const ctx = new OffscreenCanvas(64, 64).getContext("2d")!;
  const canvas = await canvasOver(ctx, 64, 64, true);
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
  catch (error) { invalid = iof(error, "java/lang/IllegalArgumentException"); }
  // the framework's ripple: SkSL with a child shader, integer literals in float context, saturate()
  const ripple = await newObj("android/graphics/drawable/RippleShader", "()V");
  for (const [name, desc, ...args] of [["setOrigin", "(FF)V", 50, 50], ["setTouch", "(FF)V", 50, 50], ["setRadius", "(F)V", 40],
    ["setProgress", "(F)V", 0.3], ["setNoisePhase", "(F)V", 10], ["setColor", "(II)V", 0x80ff0000 | 0, -1], ["setResolution", "(FF)V", 100, 100]] as const)
    await vcall(ripple, name, desc, ...args);
  const ripplePaint = await newPaint();
  await vcall(ripplePaint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", ripple);
  const rippleCtx = new OffscreenCanvas(100, 100).getContext("2d")!;
  await vcall(await canvasOver(rippleCtx, 100, 100, true), "drawCircle", "(FFFLandroid/graphics/Paint;)V", 50, 50, 40, ripplePaint);
  const rippleCenter = Array.from(rippleCtx.getImageData(50, 50, 1, 1).data);
  // RecordingCanvas.drawRipple rasterizes only under the circle, here partly off the canvas: it
  // paints what the whole-canvas raster of the same uniforms paints
  const P = "android/graphics/CanvasProperty", prop = (v: number) => scall(P, "createFloat", `(F)L${P};`, v);
  const rippleNode = await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", "ripple");
  await vcall(rippleNode, "setPosition", "(IIII)Z", 0, 0, 100, 100);
  const rec = await vcall(rippleNode, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", 100, 100);
  await vcall(rec, "drawRipple", `(L${P};L${P};L${P};L${P};L${P};L${P};ILandroid/graphics/RuntimeShader;)V`,
    await prop(30), await prop(20), await prop(40), await scall(P, "createPaint", `(Landroid/graphics/Paint;)L${P};`, ripplePaint),
    await prop(0.3), await prop(10), 0x80ff0000 | 0, ripple);
  await vcall(rippleNode, "endRecording", "()V");
  const regionCtx = new OffscreenCanvas(100, 100).getContext("2d")!, wholeCtx = new OffscreenCanvas(100, 100).getContext("2d")!;
  for (const c of [regionCtx, wholeCtx]) { c.translate(-10, 5); c.scale(1.5, 1.5); }
  await vcall(await canvasOver(regionCtx, 100, 100, true), "drawRenderNode", "(Landroid/graphics/RenderNode;)V", rippleNode);
  await vcall(ripple, "setOrigin", "(FF)V", 30, 20);
  await vcall(ripplePaint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", ripple);
  await vcall(await canvasOver(wholeCtx, 100, 100, true), "drawCircle", "(FFFLandroid/graphics/Paint;)V", 30, 20, 40, ripplePaint);
  const a = regionCtx.getImageData(0, 0, 100, 100).data, b = wholeCtx.getImageData(0, 0, 100, 100).data;
  let rippleDiff = 0, rippleInk = 0;
  for (let i = 0; i < a.length; i++) { rippleDiff = Math.max(rippleDiff, Math.abs(a[i] - b[i])); if (i % 4 === 3 && a[i]) rippleInk++; }
  return { recorded, outside, direct, invalid, recordedRasters, rasterizations, rippleCenter,
    rippleDiff, rippleInked: rippleInk > 1000 };
}
export default probe;
