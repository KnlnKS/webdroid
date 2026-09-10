import { expect, test } from "bun:test";
import "../natives";
import { JObj, rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JView } from "./view";
import { JSurface, JSurfaceTexture } from "./glview";
import { inMainJob, onMain } from "./mainloop";

test("TextureView supplies a sized surface and honors retained ownership on detach", async () => {
  const events: string[] = [];
  let release = false;
  rt.register({ name: "test/TextureListener", ctor: class extends JObj {}, methods: {
    "onSurfaceTextureAvailable(Landroid/graphics/SurfaceTexture;II)V": (_s: unknown, w: number, h: number) => { expect(inMainJob()).toBe(true); events.push(`available ${w} ${h}`); },
    "onSurfaceTextureSizeChanged(Landroid/graphics/SurfaceTexture;II)V": (_s: unknown, w: number, h: number) => { events.push(`size ${w} ${h}`); },
    "onSurfaceTextureDestroyed(Landroid/graphics/SurfaceTexture;)Z": () => { events.push("destroyed"); return +release; },
  } });
  const view = await newObj("android/view/TextureView", null) as JView;
  const listener = await newObj("test/TextureListener", null);
  await vcall(view, "setSurfaceTextureListener", "(Landroid/view/TextureView$SurfaceTextureListener;)V", listener);
  expect(await vcall(view, "isAvailable", "()Z")).toBe(0);
  view.attached = true; view.right = 320; view.bottom = 180;
  await vcall(view, "onLayout", "(ZIIII)V", 1, 0, 0, 320, 180);
  await onMain(() => {});
  const texture = await vcall(view, "getSurfaceTexture", "()Landroid/graphics/SurfaceTexture;") as JSurfaceTexture;
  const surface = await newObj("android/view/Surface", "(Landroid/graphics/SurfaceTexture;)V", texture) as JSurface;
  expect(surface.surf?.view).toBe(view);
  expect(await vcall(view, "isAvailable", "()Z")).toBe(1);
  view.right = 640;
  await vcall(view, "onLayout", "(ZIIII)V", 1, 0, 0, 640, 180);
  await onMain(() => {});
  await vcall(view, "onDetachedFromWindow", "()V");
  await onMain(() => {});
  expect(texture.released).toBe(false);
  expect(surface.surf?.view).toBeNull();
  expect(await vcall(view, "isAvailable", "()Z")).toBe(0);
  expect(events).toEqual(["available 320 180", "size 640 180", "destroyed"]);
  await vcall(surface, "release", "()V");
  expect(surface.surf).toBeNull();
  expect(texture.released).toBe(false);
  release = true;
  await vcall(view, "onAttachedToWindow", "()V");
  await onMain(() => {});
  const second = await vcall(view, "getSurfaceTexture", "()Landroid/graphics/SurfaceTexture;") as JSurfaceTexture;
  expect(second).not.toBe(texture);
  await vcall(view, "onDetachedFromWindow", "()V");
  await onMain(() => {});
  expect(second.released).toBe(true);
});
