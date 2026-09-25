import { expect, test } from "bun:test";
import "../src/natives";
import { recordingContext, type Ctx2D } from "../src/android/recording";
import { JCanvas } from "../src/android/graphics";
import { drawView, layoutView } from "../src/android/view";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { rt } from "../src/jvm/runtime";

test("a recorded SurfaceView picks up its first frame after recording", async () => {
  const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
  view.right = 320;
  view.bottom = 180;
  const ops: ((target: Ctx2D) => void)[] = [];
  const images: unknown[] = [];
  const target = new Proxy({
    drawImage: (image: unknown) => images.push(image),
  }, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => {} }) as unknown as CanvasRenderingContext2D;

  await drawView(view, JCanvas.wrap(recordingContext(target, ops), 320, 180));
  expect(images).toHaveLength(0);

  const firstFrame = {} as VideoFrame;
  view.surfaceLayer = firstFrame;
  for (const op of ops) op(target);
  expect(images).toEqual([firstFrame]);
});

test("a SurfaceView subclass gets a surface when its onLayout skips the base method", async () => {
  const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
  view.attached = true;
  view[mangleMethod("onLayout", "(ZIIII)V")] = () => {};
  await layoutView(view, 0, 0, 320, 180);

  rt.link("android/view/SurfaceHolder");
  const holder = await vcall(view, "getHolder", "()Landroid/view/SurfaceHolder;");
  const surface = await vcall(holder, "getSurface", "()Landroid/view/Surface;");
  expect(surface.surf?.view).toBe(view);
  expect(surface.surf?.width).toBe(320);
  expect(surface.surf?.height).toBe(180);
});
