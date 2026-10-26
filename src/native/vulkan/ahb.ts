// Images an AHardwareBuffer backs: they give the buffer their pixels when released to the foreign
// queue family, and take its pixels when acquired from it with their contents kept.

import { TU, type Device, type Image } from "./device.ts";

/** an OffscreenCanvas whose WebGPU context turns textures into ImageBitmaps */
export class FrameCanvas {
  private ctx: GPUCanvasContext | null = null;
  private readonly alphaMode: GPUCanvasAlphaMode;
  private configured: { gpu: GPUDevice; format: GPUTextureFormat } | null = null;
  constructor(alphaMode: GPUCanvasAlphaMode) { this.alphaMode = alphaMode; }
  /** the top-left `width` × `height` of the texture's first level */
  frame(gpu: GPUDevice, texture: GPUTexture, width: number, height: number): ImageBitmap {
    const ctx = this.ctx ??= new OffscreenCanvas(width, height).getContext("webgpu") as GPUCanvasContext;
    const canvas = ctx.canvas as OffscreenCanvas, format = texture.format.replace("-srgb", "") as GPUTextureFormat;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    if (this.configured?.gpu !== gpu || this.configured.format !== format) {
      ctx.configure({ device: gpu, format, usage: TU.COPY_DST, alphaMode: this.alphaMode });
      this.configured = { gpu, format };
    }
    const enc = gpu.createCommandEncoder();
    enc.copyTextureToTexture({ texture }, { texture: ctx.getCurrentTexture() }, { width, height });
    gpu.queue.submit([enc.finish()]);
    return canvas.transferToImageBitmap();
  }
}

const canvas = new FrameCanvas("premultiplied");
export function publish(dev: Device, img: Image): void {
  const b = img.ahb!;
  b.queueFrame(canvas.frame(dev.gpu, img.texture, b.width, b.height));
}
export function take(dev: Device, img: Image): void {
  const b = img.ahb!;
  b.withFrame((source) => dev.gpu.queue.copyExternalImageToTexture({ source }, { texture: img.texture, premultipliedAlpha: true }, { width: b.width, height: b.height }));
}
