import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { newObj, vcall, scall, linkInit } from "../../../src/jvm/natives/jentry";
import { bootWithFonts } from "./boot";
import { deref } from "../../../src/android/handles";
import { NativeShader, NativeGradient, NativeBitmapShader, NativeComposeShader } from "../../../src/android/graphics";

/** AOSP's Canvas over our natives: clip bounds, quick rejects, save flags, layers and bitmap
 *  densities, for comparison with values recorded on the reference AVD */
async function probe() {
  await bootWithFonts();
  const S = "Ljava/lang/String;", R = "Landroid/graphics/Rect;", P = "Landroid/graphics/Paint;", TILE = "Landroid/graphics/Shader$TileMode;";
  const argb = await scall("android/graphics/Bitmap$Config", "valueOf", `(${S})Landroid/graphics/Bitmap$Config;`, "ARGB_8888");
  const bitmap = (w: number, h: number) => scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", w, h, argb);
  const px = async (b: unknown, x: number, y: number) => ((await vcall(b, "getPixel", "(II)I", x, y)) >>> 0).toString(16);
  const bounds = async (c: unknown) => String(await vcall(await vcall(c, "getClipBounds", `()${R}`), "toShortString", `()${S}`));
  const qr = (c: unknown, l: number, t: number, r: number, b: number) => vcall(c, "quickReject", "(FFFF)Z", l, t, r, b);
  const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return rt.jx(e).msg; } return null; };
  const out: Record<string, unknown> = {};

  const b = await bitmap(100, 80), c = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", b);
  out.clip0 = await bounds(c);
  out.qr = [await qr(c, 100.5, 0, 120, 10), await qr(c, 101, 0, 120, 10), await qr(c, 10, 10, 10, 20), await qr(c, -5, -5, -0.5, -0.5), await qr(c, -5, -5, -1, -1)];
  out.restore = [await thrown(() => vcall(c, "restore", "()V")), await thrown(() => vcall(c, "restoreToCount", "(I)V", 0))];
  let s = await vcall(c, "save", "()I");
  out.clipRect = [s, await vcall(c, "clipRect", "(FFFF)Z", 10, 10, 50, 50), await bounds(c), await vcall(c, "getSaveCount", "()I")];
  out.clipOut = [await vcall(c, "clipOutRect", "(FFFF)Z", 0, 0, 100, 100), await bounds(c), await qr(c, 0, 0, 100, 100)];
  await vcall(c, "restore", "()V");
  await vcall(c, "save", "()I");
  out.clipOutSides = [await vcall(c, "clipOutRect", "(FFFF)Z", 0, 0, 100, 40), await bounds(c), await vcall(c, "clipOutRect", "(FFFF)Z", 0, 0, 10, 80), await bounds(c)];
  await vcall(c, "restore", "()V");
  await vcall(c, "save", "()I");
  await vcall(c, "rotate", "(FFF)V", 45, 50, 40);
  out.rotated = [await bounds(c), await vcall(c, "clipRect", "(FFFF)Z", 40, 30, 60, 50), await bounds(c)];
  await vcall(c, "restore", "()V");
  await vcall(c, "save", "()I");
  await vcall(c, "translate", "(FF)V", 10.5, 3.25);
  await vcall(c, "scale", "(FF)V", 2, 3);
  out.scaled = [await bounds(c), await vcall(c, "clipRect", "(FFFF)Z", 5, 5, 5, 10), await bounds(c), await qr(c, 0, 0, 1000, 1000)];
  await vcall(c, "restore", "()V");
  await vcall(c, "save", "()I");
  const path = await newObj("android/graphics/Path", "()V");
  const cw = await scall("android/graphics/Path$Direction", "valueOf", `(${S})Landroid/graphics/Path$Direction;`, "CW");
  await vcall(path, "addCircle", "(FFFLandroid/graphics/Path$Direction;)V", 50, 40, 20, cw);
  out.clipPath = [await vcall(c, "clipPath", "(Landroid/graphics/Path;)Z", path), await bounds(c), await qr(c, 0, 0, 29, 19), await qr(c, 0, 0, 31, 21)];
  await vcall(c, "restore", "()V");
  s = await vcall(c, "saveLayer", `(FFFF${P})I`, 0, 0, 50, 50, null);
  out.saveLayer = [s, await vcall(c, "getSaveCount", "()I"), await bounds(c)];
  await vcall(c, "restoreToCount", "(I)V", 1);
  const empty = await newObj("android/graphics/Canvas", "()V");
  out.empty = [await vcall(empty, "getWidth", "()I"), await bounds(empty), await vcall(empty, "getClipBounds", `(${R})Z`, await newObj("android/graphics/Rect", "()V")), await qr(empty, 0, 0, 1, 1)];

  // save(int): a save without the clip flag keeps its clips, one without the matrix flag its matrix
  const pc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", await bitmap(10, 10)), m = await newObj("android/graphics/Matrix", "()V");
  await vcall(pc, "save", "(I)I", 2);
  await vcall(pc, "translate", "(FF)V", 3, 4);
  await vcall(pc, "clipRect", "(FFFF)Z", 0, 0, 5, 5);
  await vcall(pc, "restore", "()V");
  await vcall(pc, "getMatrix", "(Landroid/graphics/Matrix;)V", m);
  out.partialClip = [await vcall(m, "toShortString", `()${S}`), await bounds(pc)];
  await vcall(pc, "setMatrix", "(Landroid/graphics/Matrix;)V", null);
  await vcall(pc, "save", "(I)I", 1);
  await vcall(pc, "translate", "(FF)V", 1, 1);
  await vcall(pc, "clipRect", "(FFFF)Z", 0, 0, 2, 2);
  await vcall(pc, "restore", "()V");
  await vcall(pc, "getMatrix", "(Landroid/graphics/Matrix;)V", m);
  out.partialMatrix = [await vcall(m, "toShortString", `()${S}`), await bounds(pc)];

  // a bitmap of another density is scaled to the canvas's; a paint's alpha fades it
  const small = await bitmap(10, 10);
  await vcall(small, "eraseColor", "(I)V", 0xff0000ff | 0);
  await vcall(small, "setDensity", "(I)V", 160);
  const big = await bitmap(60, 60);
  await vcall(big, "setDensity", "(I)V", 320);
  const bc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", big);
  await vcall(bc, "drawBitmap", `(Landroid/graphics/Bitmap;FF${P})V`, small, 5, 5, null);
  const half = await newObj("android/graphics/Paint", "()V");
  await vcall(half, "setAlpha", "(I)V", 128);
  await vcall(bc, "setDensity", "(I)V", 0);
  await vcall(bc, "drawBitmap", `(Landroid/graphics/Bitmap;FF${P})V`, small, 40, 40, half);
  out.density = [await vcall(bc, "getDensity", "()I"), await px(big, 24, 24), await px(big, 25, 25), await px(big, 49, 49), await px(big, 50, 50)];

  // drawColor's modes, a save-behind layer and a punched hole
  const cb = await bitmap(4, 4), cc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", cb);
  const mode = async (name: string) => scall("android/graphics/PorterDuff$Mode", "valueOf", `(${S})Landroid/graphics/PorterDuff$Mode;`, name);
  await vcall(cc, "drawColor", "(I)V", 0x80ff0000 | 0);
  const colors = [await px(cb, 0, 0)];
  await vcall(cc, "drawColor", "(ILandroid/graphics/PorterDuff$Mode;)V", 0x8000ff00 | 0, await mode("SRC"));
  colors.push(await px(cb, 0, 0));
  await vcall(cc, "drawColor", "(ILandroid/graphics/PorterDuff$Mode;)V", 0, await mode("CLEAR"));
  colors.push(await px(cb, 0, 0));
  out.colors = colors;
  const ub = await bitmap(20, 20), uc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", ub);
  await vcall(uc, "drawColor", "(I)V", 0xffff0000 | 0);
  const us = await vcall(uc, "saveUnclippedLayer", "(IIII)I", 0, 0, 10, 20);
  const during = [us, await vcall(uc, "getSaveCount", "()I"), await px(ub, 5, 5), await px(ub, 15, 5)];
  const green = await newObj("android/graphics/Paint", "()V");
  await vcall(green, "setColor", "(I)V", 0xff00ff00 | 0);
  await vcall(uc, "drawRect", `(FFFF${P})V`, 0, 0, 20, 20, green);
  const dstOut = await newObj("android/graphics/Paint", "()V");
  await vcall(dstOut, "setBlendMode", "(Landroid/graphics/BlendMode;)V", await scall("android/graphics/BlendMode", "valueOf", `(${S})Landroid/graphics/BlendMode;`, "DST_OUT"));
  await vcall(dstOut, "setAlpha", "(I)V", 128);
  await vcall(uc, "restoreUnclippedLayer", `(I${P})V`, us, dstOut);
  out.unclipped = [...during, await vcall(uc, "getSaveCount", "()I"), await px(ub, 5, 5), await px(ub, 15, 5)];
  const hb = await bitmap(10, 10), hc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", hb);
  await vcall(hc, "drawColor", "(I)V", -1);
  await vcall(hc, "punchHole", "(FFFFFFF)V", 2, 2, 8, 8, 0, 0, 0.5);
  out.punch = [await px(hb, 5, 5), await px(hb, 0, 0)];

  // text on a path: laid along the line from its start
  const tb = await bitmap(200, 60), tc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", tb);
  const tp = await newObj("android/graphics/Paint", "()V");
  await vcall(tp, "setTextSize", "(F)V", 20);
  const line = await newObj("android/graphics/Path", "()V");
  await vcall(line, "moveTo", "(FF)V", 10, 40);
  await vcall(line, "lineTo", "(FF)V", 190, 40);
  await vcall(tc, "drawTextOnPath", `(${S}Landroid/graphics/Path;FF${P})V`, "Hello", line, 0, 0, tp);
  const pixels = new Int32Array(200 * 60);
  await vcall(tb, "getPixels", "([IIIIIII)V", pixels, 0, 200, 0, 0, 200, 60);
  let minX = 999, maxX = -1, minY = 999, maxY = -1;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 200; x++) if (pixels[y * 200 + x] >>> 24) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  out.textOnPath = [minX, minY, maxX, maxY];

  // text through a CLEAR paint erases its glyphs, as SkCanvas applies the paint's blender to text
  const xb = await bitmap(40, 40), xc = await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", xb);
  await vcall(xc, "drawColor", "(I)V", 0xffff0000 | 0);
  const clear = await newObj("android/graphics/Paint", "()V");
  await vcall(clear, "setTextSize", "(F)V", 40);
  await vcall(clear, "setXfermode", "(Landroid/graphics/Xfermode;)Landroid/graphics/Xfermode;", await newObj("android/graphics/PorterDuffXfermode", "(Landroid/graphics/PorterDuff$Mode;)V", await mode("CLEAR")));
  await vcall(xc, "drawText", `(${S}FF${P})V`, "M", 0, 35, clear);
  const xpixels = new Int32Array(40 * 40);
  await vcall(xb, "getPixels", "([IIIIIII)V", xpixels, 0, 40, 0, 0, 40, 40);
  out.clearText = [xpixels.some((v) => v === 0), xpixels.some((v) => v === (0xff000000 | 0))];

  // a picture drawn into another picture's recording replays when that one is drawn, over its target
  const inner = await newObj("android/graphics/Picture", "()V"), outer = await newObj("android/graphics/Picture", "()V");
  await vcall(await vcall(inner, "beginRecording", "(II)Landroid/graphics/Canvas;", 20, 20), "drawColor", "(I)V", 0xffff0000 | 0);
  await vcall(inner, "endRecording", "()V");
  await vcall(await vcall(outer, "beginRecording", "(II)Landroid/graphics/Canvas;", 20, 20), "drawPicture", "(Landroid/graphics/Picture;)V", inner);
  await vcall(outer, "endRecording", "()V");
  const pb = await bitmap(20, 20);
  await vcall(await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", pb), "drawPicture", "(Landroid/graphics/Picture;)V", outer);
  out.nestedPicture = [await px(pb, 0, 0), await px(pb, 19, 19)];

  // a RenderNode's recording canvas, and the software canvas refusing to draw a node
  const node = await newObj("android/graphics/RenderNode", `(${S})V`, "n");
  const rc = await vcall(node, "beginRecording", "(II)Landroid/graphics/RecordingCanvas;", 100, 50);
  out.recording = [await vcall(rc, "getWidth", "()I"), await vcall(rc, "isHardwareAccelerated", "()Z"), await vcall(rc, "getMaximumBitmapWidth", "()I"),
    await vcall(rc, "getDensity", "()I"), await bounds(rc), await qr(rc, 99.5, 0, 120, 10), await qr(rc, 101, 0, 120, 10)];
  await vcall(rc, "drawColor", "(I)V", -65536);
  await vcall(node, "endRecording", "()V");
  out.recorded = [await vcall(node, "hasDisplayList", "()Z"), await thrown(() => vcall(node, "endRecording", "()V")),
    await thrown(() => vcall(c, "drawRenderNode", "(Landroid/graphics/RenderNode;)V", node))];

  // a shader's native instance: setLocalMatrix replaces it, and a ComposeShader composes the current one
  const clamp = (await linkInit("android/graphics/Shader$TileMode")).static("CLAMP"), srcOver = (await linkInit("android/graphics/PorterDuff$Mode")).static("SRC_OVER");
  const native = async (shader: unknown) => deref<NativeShader>(await vcall(shader, "getNativeInstance", "()J"));
  const linear = await newObj("android/graphics/LinearGradient", "(FFFFIILandroid/graphics/Shader$TileMode;)V", 0, 0, 10, 0, -65536, -16776961, clamp);
  const first = await native(linear), local = await newObj("android/graphics/Matrix", "()V");
  await vcall(local, "setTranslate", "(FF)V", 5, 0);
  await vcall(linear, "setLocalMatrix", "(Landroid/graphics/Matrix;)V", local);
  const second = await native(linear);
  const bitmapShader = await newObj("android/graphics/BitmapShader", "(Landroid/graphics/Bitmap;Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V", await bitmap(2, 2), clamp, clamp);
  const compose = await newObj("android/graphics/ComposeShader", "(Landroid/graphics/Shader;Landroid/graphics/Shader;Landroid/graphics/PorterDuff$Mode;)V", linear, bitmapShader, srcOver);
  const composed = await native(compose) as NativeComposeShader;
  // a replaced shader's new handle must differ from the one discarded, or ComposeShader keeps the old
  await vcall(local, "setTranslate", "(FF)V", 7, 0);
  await vcall(linear, "setLocalMatrix", "(Landroid/graphics/Matrix;)V", local);
  const recomposed = String((await native(compose) as NativeComposeShader).dst.local);
  out.shaders = { gradient: first instanceof NativeGradient && !first.local, replaced: second !== first && String(second.local),
    bitmap: await native(bitmapShader) instanceof NativeBitmapShader, composed: composed.dst === second && composed.op, recomposed };

  // a bitmap shader's fill and drawPaint, recorded, reach the whole target they replay on, not the recorder's one-pixel mirror
  const red = await bitmap(2, 2), shaded = await newObj("android/graphics/Paint", "()V"), blue = await newObj("android/graphics/Paint", "()V");
  await vcall(red, "eraseColor", "(I)V", 0xffff0000 | 0);
  await vcall(shaded, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", await newObj("android/graphics/BitmapShader", `(Landroid/graphics/Bitmap;${TILE}${TILE})V`, red, clamp, clamp));
  await vcall(blue, "setColor", "(I)V", 0xff0000ff | 0);
  const shot = await newObj("android/graphics/Picture", "()V"), sc = await vcall(shot, "beginRecording", "(II)Landroid/graphics/Canvas;", 20, 20);
  await vcall(sc, "drawRect", `(FFFF${P})V`, 0, 0, 20, 10, shaded);
  await vcall(sc, "clipRect", "(FFFF)Z", 0, 10, 20, 20);
  await vcall(sc, "drawPaint", `(${P})V`, blue);
  await vcall(shot, "endRecording", "()V");
  const sb = await bitmap(20, 20);
  await vcall(await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", sb), "drawPicture", "(Landroid/graphics/Picture;)V", shot);
  out.recordedFills = [await px(sb, 18, 5), await px(sb, 18, 18)];
  return out;
}
export default probe;
