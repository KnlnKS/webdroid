// VK_KHR_android_surface and VK_KHR_swapchain: a surface is an ANativeWindow's surface, and a present
// hands the image's pixels to the surface's consumer as an EGL swap hands its frame.

import { mem } from "../mem.ts";
import type { HostFn } from "../host.ts";
import { noteNativeFrame } from "../cpu.ts";
import { windowOf } from "../libandroid.ts";
import { bufferHeight, bufferWidth, presentSurface, type GlSurface } from "../../android/glsurface.ts";
import { vsync } from "../../android/vsync.ts";
import { struct, list, u64s, stU64 } from "../struct.ts";
import { R, objects, nd, enumerate } from "./vk.ts";
import { TU, Device, Image, Queue } from "./device.ts";
import { textureFormat } from "./formats.ts";
import { FrameCanvas } from "./ahb.ts";
import { Signal } from "./submit.ts";

class Surface {
  readonly window: GlSurface;
  constructor(window: GlSurface) { this.window = window; }
}
class Swapchain {
  readonly canvas = new FrameCanvas("opaque");
  next = 0;
  readonly surface: Surface; readonly images: number[]; readonly width: number; readonly height: number;
  constructor(surface: Surface, images: number[], width: number, height: number) { this.surface = surface; this.images = images; this.width = width; this.height = height; }
  /** whether the window's buffers have changed size since */
  get stale(): boolean { return bufferWidth(this.surface.window) !== this.width || bufferHeight(this.surface.window) !== this.height; }
}

const SurfaceInfo = struct("sType:u32 pNext:ptr flags:u32 window:ptr");
const Capabilities = struct(`minImageCount:u32 maxImageCount:u32 currentExtent:u32[2] minImageExtent:u32[2] maxImageExtent:u32[2] maxImageArrayLayers:u32
  supportedTransforms:u32 currentTransform:u32 supportedCompositeAlpha:u32 supportedUsageFlags:u32`);
const SurfaceFormat = struct("format:u32 colorSpace:u32");
const SwapchainInfo = struct(`sType:u32 pNext:ptr flags:u32 surface:u64 minImageCount:u32 imageFormat:u32 imageColorSpace:u32 width:u32 height:u32
  imageArrayLayers:u32 imageUsage:u32 imageSharingMode:u32 queueFamilyIndexCount:u32 pQueueFamilyIndices:ptr preTransform:u32 compositeAlpha:u32
  presentMode:u32 clipped:u32 oldSwapchain:u64`);
const PresentInfo = struct("sType:u32 pNext:ptr waits:u32 pWaits:ptr swapchains:u32 pSwapchains:ptr pImageIndices:ptr pResults:ptr");

/** R8G8B8A8_UNORM and _SRGB, in VK_COLOR_SPACE_SRGB_NONLINEAR */
const FORMATS = [37, 43];
const FIFO = 2;
const MIN_IMAGES = 2, MAX_IMAGES = 3;
/** TRANSFER_SRC, TRANSFER_DST, SAMPLED, COLOR_ATTACHMENT */
const USAGE = 0x1 | 0x2 | 0x4 | 0x10;
const MAX_EXTENT = 16384;

export const SWAPCHAIN: Record<string, HostFn> = {
  vkCreateAndroidSurfaceKHR: (_c, a) => {
    a.p(); const window = windowOf(SurfaceInfo.read(a.p()).window); a.p(); const out = a.p();
    if (!window) return R.SURFACE_LOST;
    stU64(out, objects.add(new Surface(window)));
    return R.SUCCESS;
  },
  vkDestroySurfaceKHR: (_c, a) => { a.p(); objects.delete(nd(a)); },
  vkGetPhysicalDeviceSurfaceSupportKHR: (_c, a) => { a.p(); a.u(); nd(a); mem.st32(a.p(), 1); return R.SUCCESS; },
  vkGetPhysicalDeviceSurfaceCapabilitiesKHR: (_c, a) => {
    a.p(); const { window } = objects.get(nd(a), Surface), extent = [bufferWidth(window), bufferHeight(window)];
    // the identity transform, with the window's alpha ignored or as the surface's consumer takes it
    Capabilities.write(a.p(), {
      minImageCount: MIN_IMAGES, maxImageCount: MAX_IMAGES, currentExtent: extent, minImageExtent: [1, 1], maxImageExtent: [MAX_EXTENT, MAX_EXTENT],
      maxImageArrayLayers: 1, supportedTransforms: 1, currentTransform: 1, supportedCompositeAlpha: 0x1 | 0x8, supportedUsageFlags: USAGE,
    });
    return R.SUCCESS;
  },
  vkGetPhysicalDeviceSurfaceFormatsKHR: (_c, a) => {
    a.p(); nd(a); return enumerate(FORMATS, a.p(), a.p(), SurfaceFormat.size(), (at, format) => SurfaceFormat.write(at, { format, colorSpace: 0 }));
  },
  vkGetPhysicalDeviceSurfacePresentModesKHR: (_c, a) => { a.p(); nd(a); return enumerate([FIFO], a.p(), a.p(), 4, (at, mode) => mem.st32(at, mode)); },

  vkCreateSwapchainKHR: (_c, a) => {
    const dev = objects.get(a.p(), Device), info = SwapchainInfo.read(a.p()); a.p(); const out = a.p();
    const f = textureFormat(info.imageFormat);
    if (!f || !FORMATS.includes(info.imageFormat)) return R.FORMAT_NOT_SUPPORTED;
    const size = { width: info.width, height: info.height, depthOrArrayLayers: 1 };
    const images = Array.from({ length: Math.min(MAX_IMAGES, Math.max(MIN_IMAGES, info.minImageCount)) }, () => {
      const img = new Image({ dimension: "2d", format: f.gpu, size, usage: TU.COPY_SRC | TU.COPY_DST | TU.TEXTURE_BINDING | TU.RENDER_ATTACHMENT }, f, info.imageFormat, false, true);
      img.gpu = dev.gpu.createTexture(img.desc);
      return objects.add(img);
    });
    stU64(out, objects.add(new Swapchain(objects.get(info.surface, Surface), images, info.width, info.height)));
    return R.SUCCESS;
  },
  vkDestroySwapchainKHR: (_c, a) => {
    a.p(); const h = nd(a), sc = objects.find(h, Swapchain);
    if (!sc) return;
    for (const i of sc.images) { objects.get(i, Image).gpu?.destroy(); objects.delete(i); }
    objects.delete(h);
  },
  vkGetSwapchainImagesKHR: (_c, a) => { a.p(); const sc = objects.get(nd(a), Swapchain); return enumerate(sc.images, a.p(), a.p(), 8, stU64); },
  // the images are presented in turn and each is free once presented, as one queue runs a present after the work before it
  vkAcquireNextImageKHR: (_c, a) => {
    a.p(); const sc = objects.get(nd(a), Swapchain); a.ul(); const semaphore = objects.find(nd(a), Signal), fence = objects.find(nd(a), Signal), out = a.p();
    if (sc.stale) return R.OUT_OF_DATE;
    mem.st32(out, sc.next);
    sc.next = (sc.next + 1) % sc.images.length;
    semaphore?.set(true); fence?.set(true);
    return R.SUCCESS;
  },
  vkQueuePresentKHR: (cpu, a) => {
    const dev = objects.get(a.p(), Queue).dev, info = PresentInfo.read(a.p());
    const indices = list(info.pImageIndices, info.swapchains, 4, (at) => mem.ld32(at) >>> 0);
    let result: number = R.SUCCESS;
    u64s(info.pSwapchains, info.swapchains).forEach((h, i) => {
      const sc = objects.get(h, Swapchain);
      presentSurface(sc.surface.window, sc.canvas.frame(dev.gpu, objects.get(sc.images[indices[i]], Image).texture, sc.width, sc.height));
      const r = sc.stale ? R.OUT_OF_DATE : R.SUCCESS;
      if (info.pResults) mem.st32(info.pResults + 4 * i, r);
      if (r !== R.SUCCESS) result = r;
    });
    // a present is the thread's frame, as an EGL swap is, and FIFO paces it to the display
    noteNativeFrame(cpu);
    return vsync().then(() => result);
  },
};
