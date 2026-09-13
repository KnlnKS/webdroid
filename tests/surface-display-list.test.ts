import { expect, test } from "bun:test";
import "../src/natives";
import { JCanvas } from "../src/android/graphics";
import { drawView } from "../src/android/view";
import { newObj } from "../src/jvm/natives/jlang";

test("a recorded SurfaceView picks up its first frame after recording", async () => {
  const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
  view.right = 320;
  view.bottom = 180;
  const ops: ((target: CanvasRenderingContext2D) => void)[] = [];
  const images: unknown[] = [];
  const ctx = new Proxy({
    __isRecorder: true,
    __record: (op: (target: CanvasRenderingContext2D) => void) => ops.push(op),
    drawImage: (image: unknown) => images.push(image),
  }, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => {} }) as unknown as CanvasRenderingContext2D;

  await drawView(view, JCanvas.wrap(ctx, 320, 180));
  expect(ops).toHaveLength(1);
  expect(images).toHaveLength(0);

  const firstFrame = {} as VideoFrame;
  view.surfaceLayer = firstFrame;
  ops[0](ctx);
  expect(images).toEqual([firstFrame]);
});
