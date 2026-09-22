import { expect, test } from "bun:test";
import "../src/natives";
import { recordingContext, type Ctx2D } from "../src/android/recording";
import { JCanvas } from "../src/android/graphics";
import { drawView } from "../src/android/view";
import { newObj } from "../src/jvm/natives/jlang";

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
