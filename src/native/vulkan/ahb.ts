// Images an AHardwareBuffer backs: they give the buffer their pixels when released to the foreign
// queue family, and take its pixels when acquired from it with their contents kept.

import { queueFrame, bufferFrame } from "../hardwarebuffer.ts";
import { TU, type Device, type Image } from "./device.ts";

/** the canvas that turns textures into frames for the AHardwareBuffers they fill, by format */
const canvases = new Map<string, GPUCanvasContext>();
export function publish(dev: Device, img: Image): void {
  const b = img.ahb!, format = img.format.gpu;
  let ctx = canvases.get(format);
  if (!ctx) {
    ctx = new OffscreenCanvas(b.width, b.height).getContext("webgpu") as GPUCanvasContext;
    canvases.set(format, ctx);
  }
  const canvas = ctx.canvas as OffscreenCanvas;
  if (canvas.width !== b.width || canvas.height !== b.height) { canvas.width = b.width; canvas.height = b.height; }
  ctx.configure({ device: dev.gpu, format: format === "rgba8unorm-srgb" ? "rgba8unorm" : format, usage: TU.COPY_DST, alphaMode: "premultiplied" });
  const enc = dev.gpu.createCommandEncoder();
  enc.copyTextureToTexture({ texture: img.texture }, { texture: ctx.getCurrentTexture() }, { width: b.width, height: b.height });
  dev.gpu.queue.submit([enc.finish()]);
  queueFrame(b, canvas.transferToImageBitmap());
}
export function take(dev: Device, img: Image): void {
  const b = img.ahb!, queued = b.frame, frame = queued ?? bufferFrame(b);
  if (frame) dev.gpu.queue.copyExternalImageToTexture({ source: frame }, { texture: img.texture, premultipliedAlpha: true }, { width: b.width, height: b.height });
  if (frame !== queued) frame?.close();
}
