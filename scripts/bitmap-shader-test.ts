import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser } from "../tests/e2e/drivers/webdroid";
import type { Runtime } from "../src/jvm/runtime";
import type { newObj, vcall } from "../src/jvm/natives/jlang";

declare const wd: { rt: Runtime; newObj: typeof newObj; vcall: typeof vcall; scall: (cls: string, name: string, desc: string, ...args: unknown[]) => Promise<unknown> };
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(BASE_URL);
  await page.waitForFunction(() => typeof wd !== "undefined");
  console.log(await page.evaluate(async () => {
    const config = wd.rt.link("android/graphics/Bitmap$Config").ctor.s$ARGB_8888;
    const modes = wd.rt.link("android/graphics/Shader$TileMode").ctor;
    const bitmap = (w: number, h: number) => wd.scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", w, h, config);
    const source = await bitmap(2, 2), colors = [-65536, -16711936, -16776961, -1];
    for (let i = 0; i < 4; i++) await wd.vcall(source, "setPixel", "(III)V", i % 2, i >> 1, colors[i]);
    const tile = (n: number, mode: string) => mode === "CLAMP" ? Math.max(0, Math.min(1, n))
      : mode === "DECAL" ? n < 0 || n > 1 ? -1 : n
      : mode === "REPEAT" ? ((n % 2) + 2) % 2 : [0, 1, 1, 0][((n % 4) + 4) % 4];
    let checks = 0;
    for (const mx of ["CLAMP", "REPEAT", "MIRROR", "DECAL"]) for (const my of ["CLAMP", "REPEAT", "MIRROR", "DECAL"]) {
      const shader = await wd.newObj("android/graphics/BitmapShader", "(Landroid/graphics/Bitmap;Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V", source, modes["s$" + mx], modes["s$" + my]);
      const paint = await wd.newObj("android/graphics/Paint");
      await wd.vcall(paint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", shader);
      const matrix = await wd.newObj("android/graphics/Matrix");
      await wd.vcall(matrix, "setValues", "([F)V", new Float32Array([0, -1, 1, 1, 0, 0, 0, 0, 1]));
      for (const rotated of [false, true, false]) {
        await wd.vcall(shader, "setLocalMatrix", "(Landroid/graphics/Matrix;)V", rotated ? matrix : null);
        const target = await bitmap(10, 10), canvas = await wd.newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", target);
        await wd.vcall(canvas, "translate", "(FF)V", 4, 4);
        await wd.vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", -4, -4, 6, 6, paint);
        for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
          const sx = tile(rotated ? y - 4 : x - 4, mx), sy = tile(rotated ? 4 - x : y - 4, my);
          const expected = sx < 0 || sy < 0 ? 0 : colors[sy * 2 + sx];
          const actual = await wd.vcall(target, "getPixel", "(II)I", x, y);
          if (actual !== expected) throw new Error(`${mx}/${my} rotated=${rotated} (${x},${y}): ${actual} != ${expected}`);
          checks++;
        }
      }
    }
    const shader = await wd.newObj("android/graphics/BitmapShader", "(Landroid/graphics/Bitmap;Landroid/graphics/Shader$TileMode;Landroid/graphics/Shader$TileMode;)V", source, modes.s$CLAMP, modes.s$CLAMP);
    const paint = await wd.newObj("android/graphics/Paint");
    await wd.vcall(paint, "setShader", "(Landroid/graphics/Shader;)Landroid/graphics/Shader;", shader);
    let target: unknown, canvas: unknown;
    const fresh = async () => {
      target = await bitmap(10, 10);
      if (canvas) await wd.vcall(canvas, "setBitmap", "(Landroid/graphics/Bitmap;)V", target);
      else canvas = await wd.newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", target);
      await wd.vcall(canvas, "setMatrix", "(Landroid/graphics/Matrix;)V", null);
      await wd.vcall(canvas, "translate", "(FF)V", 4, 4);
    };
    await fresh();
    const pixel = async (x: number, y: number, color: number) => {
      if (await wd.vcall(target, "getPixel", "(II)I", x, y) !== color) throw new Error(`shape pixel ${x},${y}`);
      checks++;
    };
    await wd.vcall(canvas, "drawCircle", "(FFFLandroid/graphics/Paint;)V", 0, 0, 3, paint);
    await pixel(0, 0, 0); await pixel(4, 4, colors[0]);
    await wd.vcall(source, "setPixel", "(III)V", 0, 0, -256);
    await fresh();
    await wd.vcall(canvas, "drawCircle", "(FFFLandroid/graphics/Paint;)V", 0, 0, 3, paint);
    await pixel(4, 4, -256);
    await fresh();
    await wd.vcall(paint, "setStyle", "(Landroid/graphics/Paint$Style;)V", wd.rt.link("android/graphics/Paint$Style").ctor.s$STROKE);
    await wd.vcall(paint, "setStrokeWidth", "(F)V", 2);
    await wd.vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", -3, -3, 3, 3, paint);
    await pixel(1, 4, -256); await pixel(4, 4, 0);
    const sourceCanvas = await wd.newObj("android/graphics/Canvas", "(Landroid/graphics/Bitmap;)V", source);
    await wd.vcall(sourceCanvas, "drawColor", "(I)V", -65281);
    if (await wd.vcall(source, "getPixel", "(II)I", 0, 0) !== -65281) throw new Error("Canvas mutation left stale bitmap pixels");
    await wd.vcall(target, "eraseColor", "(I)V", 0);
    await wd.vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", -3, -3, 3, 3, paint);
    await pixel(1, 4, -65281); await pixel(4, 4, 0);
    return { checks };
  }));
} finally { await browser.close(); }
