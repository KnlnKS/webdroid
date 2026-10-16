import "../../../src/natives.ts";
import { loadFramework } from "../../../src/android/framework.ts";
import { vcall, newObj, scall } from "../../../src/jvm/natives/jentry.ts";
import { canvasOver } from "../../../src/android/canvas.ts";
import { edges } from "../../../src/android/graphics.ts";
import { bootPlatform } from "./boot.ts";
import { initDeviceLocales } from "../../../src/android/resnative.ts";
import { applyDeviceConfiguration } from "../../../src/android/resources.ts";

const STATE_ENABLED = 0x0101009e; // android.R.attr.state_enabled
const D = "Landroid/graphics/drawable/Drawable;", THEME = "Landroid/content/res/Resources$Theme;", S = "Ljava/lang/String;";

/** framework drawables through the system Resources under Theme.Material, drawn as the view stack draws them */
async function probe() {
  await Promise.all([loadFramework(), bootPlatform()]);
  // the system Resources as the zygote leaves them: the device's languages and configuration
  await initDeviceLocales();
  await applyDeviceConfiguration();
  const res = await scall("android/content/res/Resources", "getSystem", "()Landroid/content/res/Resources;");
  const id = (name: string, type: string): Promise<number> => vcall(res, "getIdentifier", `(${S}${S}${S})I`, name, type, "android");
  const theme = await vcall(res, "newTheme", `()${THEME}`);
  await vcall(theme, "applyStyle", "(IZ)V", await id("Theme.Material", "style"), 1);
  const drawable = async (name: string) => vcall(res, "getDrawable", `(I${THEME})${D}`, await id(name, "drawable"), theme);
  const track = await drawable("seekbar_track_material");
  await vcall(track, "setState", "([I)Z", Int32Array.of(STATE_ENABLED));
  await vcall(track, "setBounds", "(IIII)V", 0, 0, 300, 54);
  const progress = await vcall(track, "findDrawableByLayerId", `(I)${D}`, 0x0102000d);
  await vcall(progress, "setLevel", "(I)Z", 5000);
  const ctx = new OffscreenCanvas(300, 54).getContext("2d")!;
  await vcall(track, "draw", "(Landroid/graphics/Canvas;)V", await canvasOver(ctx, 300, 54));
  const heights: number[] = [];
  for (let i = 0, n = await vcall(track, "getNumberOfLayers", "()I"); i < n; i++) {
    const b = await vcall(await vcall(track, "getDrawable", `(I)${D}`, i), "getBounds", "()Landroid/graphics/Rect;");
    const { top, bottom } = edges(b);
    heights.push(bottom - top);
  }
  const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  const before = pixel(50, 27), after = pixel(250, 27), above = pixel(50, 15);
  const thumb = await drawable("seekbar_thumb_material_anim");
  await vcall(thumb, "setBounds", "(IIII)V", 0, 0, 54, 54);
  ctx.clearRect(0, 0, 300, 54); ctx.globalAlpha = 0.5;
  await vcall(thumb, "setState", "([I)Z", Int32Array.of(STATE_ENABLED));
  await vcall(thumb, "draw", "(Landroid/graphics/Canvas;)V", await canvasOver(ctx, 300, 54));
  const center = pixel(27, 27), outside = pixel(2, 2);
  ctx.globalAlpha = 1; ctx.clearRect(0, 0, 300, 54);
  const rotate = await newObj("android/graphics/drawable/RotateDrawable", "()V");
  const fill = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xffff0000);
  await vcall(rotate, "setDrawable", `(${D})V`, fill);
  await vcall(rotate, "setBounds", "(IIII)V", 10, 20, 50, 40);
  await vcall(rotate, "setToDegrees", "(F)V", 180);
  await vcall(rotate, "setLevel", "(I)Z", 5000);
  await vcall(rotate, "draw", "(Landroid/graphics/Canvas;)V", await canvasOver(ctx, 300, 54));
  const rotated = [pixel(30, 12), pixel(12, 30)];
  ctx.clearRect(0, 0, 300, 54);
  await vcall(rotate, "setPivotXRelative", "(Z)V", 0);
  await vcall(rotate, "setPivotX", "(F)V", 5);
  await vcall(rotate, "setLevel", "(I)Z", 10000);
  await vcall(rotate, "draw", "(Landroid/graphics/Canvas;)V", await canvasOver(ctx, 300, 54));
  const absolute = [pixel(0, 30), pixel(30, 30)], restored = ctx.getTransform().isIdentity;
  // VectorDrawableProbe's cases on the device: framework vectors drawn into ARGB bitmaps
  const light = await vcall(res, "newTheme", `()${THEME}`);
  await vcall(light, "applyStyle", "(IZ)V", await id("Theme.Material.Light", "style"), 1);
  const vector = async (name: string) => vcall(res, "getDrawable", `(I${THEME})${D}`, await id(name, "drawable"), light);
  const pixels = async (d: unknown, w: number, h: number) => {
    const config = (await scall("android/graphics/Bitmap$Config", "valueOf", `(${S})Landroid/graphics/Bitmap$Config;`, "ARGB_8888"));
    const bitmap = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", w, h, config);
    await vcall(d, "setBounds", "(IIII)V", 0, 0, w, h);
    await vcall(d, "draw", "(Landroid/graphics/Canvas;)V", await newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", bitmap));
    const out = new Int32Array(w * h);
    await vcall(bitmap, "getPixels", "([IIIIIII)V", out, 0, w, 0, 0, w, h);
    return [...out];
  };
  const box = await vector("btn_checkbox_checked_mtrl"), arrow = await vector("ic_ab_back_material");
  const vectors: Record<string, number[]> = {
    checkbox: await pixels(box, 24, 24), "checkbox-wide": await pixels(box, 36, 30),
  };
  await vcall(box, "setAlpha", "(I)V", 128);
  vectors["checkbox-alpha"] = await pixels(box, 24, 24);
  vectors.back = await pixels(arrow, 24, 24);
  await vcall(arrow, "setLayoutDirection", "(I)Z", 1);
  vectors["back-rtl"] = await pixels(arrow, 24, 24);
  return { heights, before, after, above, center, outside, rotated, absolute, restored, vectors };
}
export default probe;
