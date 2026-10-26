// The logical device and its resources: a GPUDevice with every feature and limit of the adapter, one
// queue, and memory, buffers, images, views and samplers over WebGPU objects. Memory a host may map is
// guest memory; a buffer bound to it is a GPUBuffer whose contents a submit carries to and from it.
// An image bound to an imported AHardwareBuffer's memory takes its pixels from and gives them back to
// the buffer when it changes hands with the foreign queue family (submit.ts).

import { mem } from "../mem.ts";
import { PTR, ldp, stp, type ArgReader, type HostFn } from "../host.ts";
import { bufferAt, acquire, release as releaseBuffer, type HardwareBuffer } from "../hardwarebuffer.ts";
import { struct, ptrs, stU64 } from "../struct.ts";
import { chain } from "./vk.ts";
import { F, formatFeatures, textureFormat, vkFormatOf, type TextureFormat } from "./formats.ts";
import { dispatchable, handle, object, maybe, release } from "./handles.ts";
import { DEVICE_EXTENSIONS, MEMORY_TYPES, R, AHB_HANDLE, physicalOf, deviceAdapter, type Physical } from "./instance.ts";
import type { PushChunk } from "./pipeline.ts";

/** GPUBufferUsage and GPUTextureUsage */
export const BU = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, STORAGE: 0x80 } as const;
export const TU = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 } as const;
/** a non-dispatchable handle argument */
export const nd = (a: ArgReader): number => Number(a.ul());

export interface Device { physical: Physical; gpu: GPUDevice; queue: number; lost: boolean; push: PushChunk[] }
export const deviceOf = (h: number): Device => object<Device>(h);

export interface Memory {
  size: number;
  type: number;
  /** the guest bytes of host-visible memory, 0 for device-local memory */
  host: number;
  ahb: HardwareBuffer | null;
}
export class Buffer {
  memory: Memory | null = null;
  offset = 0;
  readonly gpu: GPUBuffer;
  readonly size: number;
  readonly usage: number;
  constructor(gpu: GPUBuffer, size: number, usage: number) { this.gpu = gpu; this.size = size; this.usage = usage; }
  /** the guest bytes holding the buffer's contents, 0 when its memory is device-local */
  get host(): number { return this.memory?.host ? this.memory.host + this.offset : 0; }
}
export class Image {
  gpu: GPUTexture | null = null;
  ahb: HardwareBuffer | null = null;
  readonly desc: GPUTextureDescriptor;
  readonly format: TextureFormat;
  readonly vk: number;
  readonly external: boolean;
  constructor(desc: GPUTextureDescriptor, format: TextureFormat, vk: number, external: boolean) {
    this.desc = desc; this.format = format; this.vk = vk; this.external = external;
  }
  get texture(): GPUTexture { if (!this.gpu) throw new Error("vulkan: image without memory"); return this.gpu; }
}
export class View {
  readonly gpu: GPUTextureView;
  readonly image: Image;
  readonly desc: GPUTextureViewDescriptor;
  constructor(image: Image, desc: GPUTextureViewDescriptor) { this.image = image; this.desc = desc; this.gpu = image.texture.createView(desc); }
}

const DeviceInfo = struct("sType:u32 pNext:ptr flags:u32 queueInfos:u32 pQueueInfos:ptr layers:u32 layerNames:ptr extensions:u32 extensionNames:ptr pEnabledFeatures:ptr");
const AllocateInfo = struct("sType:u32 pNext:ptr allocationSize:u64 memoryTypeIndex:u32");
const ImportAhb = struct("sType:u32 pNext:ptr buffer:ptr");
const BufferInfo = struct("sType:u32 pNext:ptr flags:u32 size:u64 usage:u32 sharingMode:u32 queueFamilyIndexCount:u32 pQueueFamilyIndices:ptr");
const Requirements = struct("size:u64 alignment:u64 memoryTypeBits:u32");
const Requirements2 = struct("sType:u32 pNext:ptr requirements:u64[0]");
const Dedicated = struct("sType:u32 pNext:ptr prefers:u32 requires:u32");
const BindInfo = struct("sType:u32 pNext:ptr object:u64 memory:u64 memoryOffset:u64");
const RequirementsInfo2 = struct("sType:u32 pNext:ptr object:u64");
const ImageInfo = struct(`sType:u32 pNext:ptr flags:u32 imageType:u32 format:u32 width:u32 height:u32 depth:u32 mipLevels:u32 arrayLayers:u32
  samples:u32 tiling:u32 usage:u32 sharingMode:u32 queueFamilyIndexCount:u32 pQueueFamilyIndices:ptr initialLayout:u32`);
const ExternalImage = struct("sType:u32 pNext:ptr handleTypes:u32");
const ViewInfo = struct(`sType:u32 pNext:ptr flags:u32 image:u64 viewType:u32 format:u32 r:u32 g:u32 b:u32 a:u32
  aspectMask:u32 baseMipLevel:u32 levelCount:u32 baseArrayLayer:u32 layerCount:u32`);
const SamplerInfo = struct(`sType:u32 pNext:ptr flags:u32 magFilter:u32 minFilter:u32 mipmapMode:u32 addressModeU:u32 addressModeV:u32
  addressModeW:u32 mipLodBias:f32 anisotropyEnable:u32 maxAnisotropy:f32 compareEnable:u32 compareOp:u32 minLod:f32 maxLod:f32 borderColor:u32
  unnormalizedCoordinates:u32`);
const AhbProperties = struct("sType:u32 pNext:ptr allocationSize:u64 memoryTypeBits:u32");
const AhbFormat = struct(`sType:u32 pNext:ptr format:u32 externalFormat:u64 formatFeatures:u32 r:u32 g:u32 b:u32 a:u32
  suggestedYcbcrModel:u32 suggestedYcbcrRange:u32 suggestedXChromaOffset:u32 suggestedYChromaOffset:u32`);
const ST = {
  IMPORT_AHB: 1000129003, AHB_FORMAT_PROPERTIES: 1000129002, DEDICATED_REQUIREMENTS: 1000127000, EXTERNAL_IMAGE: 1000072001,
  EXPORT_MEMORY: 1000072002, VIEW_USAGE: 1000117002, EXTERNAL_FORMAT: 1000129005,
} as const;
/** VK_FORMAT_R8G8B8A8_UNORM: the pixels of the AHardwareBuffers that are an external format, a decoder's frames */
const EXTERNAL_PIXELS = 37;

/** the alignment of every buffer and image in memory: WebGPU's buffer-offset and copy alignments */
const ALIGN = 256;
const align = (n: number, to: number) => Math.ceil(n / to) * to;
const HOST_VISIBLE = 2;

// VkBufferUsageFlags → GPUBufferUsage: transfer src/dst, uniform, storage, index, vertex, indirect
const BUFFER_USAGE: [number, number][] = [[0x1, 0x4], [0x2, 0x8], [0x10, 0x40], [0x20, 0x80], [0x40, 0x10], [0x80, 0x20], [0x100, 0x100]];
const bufferUsage = (vk: number) => BUFFER_USAGE.reduce((u, [bit, gpu]) => vk & bit ? u | gpu : u, BU.COPY_SRC | BU.COPY_DST);
/** `renderable`: the format can be an attachment, so a transfer destination is cleared by a render pass */
function imageUsage(vk: number, samples: number, renderable: boolean): number {
  let u = TU.COPY_SRC | TU.COPY_DST;
  if (vk & (0x4 | 0x80)) u |= TU.TEXTURE_BINDING;
  if (vk & 0x8) u |= TU.STORAGE_BINDING;
  if (vk & (0x10 | 0x20 | 0x40) || samples > 1 || (vk & 0x2 && renderable)) u |= TU.RENDER_ATTACHMENT;
  return u;
}
const IMAGE_DIMENSION: GPUTextureDimension[] = ["1d", "2d", "3d"];
const VIEW_DIMENSION: GPUTextureViewDimension[] = ["1d", "2d", "3d", "cube", "1d", "2d-array", "cube-array"];
const srgbPair = (gpu: string): GPUTextureFormat | null => gpu.endsWith("-srgb") ? gpu.slice(0, -5) as GPUTextureFormat : textureFormat(vkFormatOf(`${gpu}-srgb` as GPUTextureFormat) ?? -1) ? `${gpu}-srgb` as GPUTextureFormat : null;

/** the image's bytes, as its requirements report them: every level of every layer, tightly packed */
function imageBytes(img: Image): number {
  const f = img.format, { width, height, depthOrArrayLayers } = img.desc.size as GPUExtent3DDict;
  let total = 0;
  for (let l = 0; l < (img.desc.mipLevelCount ?? 1); l++) {
    const w = Math.max(1, width >> l), h = Math.max(1, (height ?? 1) >> l), d = img.desc.dimension === "3d" ? Math.max(1, (depthOrArrayLayers ?? 1) >> l) : depthOrArrayLayers ?? 1;
    total += Math.ceil(w / f.bw) * Math.ceil(h / f.bh) * f.bytes * d;
  }
  return align(total * (img.desc.sampleCount ?? 1), ALIGN);
}

function bind(dev: Device, img: Image, memory: Memory): number {
  if (img.external) {
    const b = memory.ahb;
    if (!b) return R.INVALID_EXTERNAL_HANDLE;
    img.ahb = b;
  }
  img.gpu = dev.gpu.createTexture(img.desc);
  return R.SUCCESS;
}
function writeRequirements(at: number, size: number, bits: number): void { Requirements.write(at, { size, alignment: ALIGN, memoryTypeBits: bits }); }
const allTypes = (1 << MEMORY_TYPES.length) - 1;

export const DEVICE: Record<string, HostFn> = {
  vkCreateDevice: async (_c, a) => {
    const p = physicalOf(a.p()), info = DeviceInfo.read(a.p()); a.p(); const out = a.p();
    const known = new Set(DEVICE_EXTENSIONS.map(([n]) => n));
    if (ptrs(info.extensionNames, info.extensions).some((n) => !known.has(mem.cstr(n)))) return R.EXTENSION_NOT_PRESENT;
    // every capability the adapter has: Vulkan enables features a device then never needs to ask WebGPU for
    const requiredLimits: Record<string, number> = {};
    for (const k in p.limits) { const v = (p.limits as unknown as Record<string, unknown>)[k]; if (typeof v === "number") requiredLimits[k] = v; }
    const adapter = await deviceAdapter(p);
    if (!adapter) return R.INITIALIZATION_FAILED;
    const gpu = await adapter.requestDevice({ requiredFeatures: [...p.features] as GPUFeatureName[], requiredLimits }).catch((e: Error) => e);
    if (gpu instanceof Error) { console.warn("[vulkan] requestDevice:", gpu.message); return R.INITIALIZATION_FAILED; }
    const dev: Device = { physical: p, gpu, queue: 0, lost: false, push: [] };
    dev.queue = dispatchable({ device: dev });
    gpu.onuncapturederror = (e) => console.warn("[vulkan] WebGPU error:", e.error.message);
    void gpu.lost.then((l) => { dev.lost = true; if (l.reason !== "destroyed") console.warn("[vulkan] device lost:", l.message); });
    stp(out, dispatchable(dev));
    return R.SUCCESS;
  },
  vkDestroyDevice: (_c, a) => { const h = a.p(); if (!h) return; const dev = deviceOf(h); dev.gpu.destroy(); release(dev.queue); release(h); },
  vkGetDeviceQueue: (_c, a) => { const dev = deviceOf(a.p()); a.u(); a.u(); stp(a.p(), dev.queue); },
  vkGetDeviceQueue2: (_c, a) => { const dev = deviceOf(a.p()); a.p(); stp(a.p(), dev.queue); },
  vkDeviceWaitIdle: async (_c, a) => { const dev = deviceOf(a.p()); await dev.gpu.queue.onSubmittedWorkDone(); return dev.lost ? R.DEVICE_LOST : R.SUCCESS; },

  vkAllocateMemory: (_c, a) => {
    a.p(); const info = AllocateInfo.read(a.p()); a.p(); const out = a.p();
    const m: Memory = { size: info.allocationSize, type: info.memoryTypeIndex, host: 0, ahb: null }, links = chain(info.pNext);
    const ahb = links.get(ST.IMPORT_AHB);
    if (ahb) {
      const b = bufferAt(ImportAhb.read(ahb).buffer);
      if (!b) return R.INVALID_EXTERNAL_HANDLE;
      acquire(b); m.ahb = b;
    } else if (links.has(ST.EXPORT_MEMORY)) return R.INVALID_EXTERNAL_HANDLE;           // no AHardwareBuffer is made here
    if (MEMORY_TYPES[m.type] & HOST_VISIBLE) {
      if (m.size > 2 ** 31 || !(m.host = mem.memalign(64, m.size))) return R.OUT_OF_HOST_MEMORY;
      mem.memset(m.host, 0, m.size);
    }
    stU64(out, handle(m));
    return R.SUCCESS;
  },
  vkFreeMemory: (_c, a) => {
    a.p(); const h = nd(a), m = maybe<Memory>(h);
    if (!m) return;
    if (m.host) mem.free(m.host);
    if (m.ahb) releaseBuffer(m.ahb);
    release(h);
  },
  vkMapMemory: (_c, a) => {
    a.p(); const m = object<Memory>(nd(a)), offset = Number(a.ul()); a.ul(); a.u(); const out = a.p();
    if (!m.host) return R.MEMORY_MAP_FAILED;
    stp(out, m.host + offset);
    return R.SUCCESS;
  },
  vkUnmapMemory: () => {},
  // the memory is coherent: a submit reads it as it stands then
  vkFlushMappedMemoryRanges: () => R.SUCCESS,
  vkInvalidateMappedMemoryRanges: () => R.SUCCESS,
  vkGetDeviceMemoryCommitment: (_c, a) => { a.p(); const m = object<Memory>(nd(a)); stU64(a.p(), m.size); },

  vkCreateBuffer: (_c, a) => {
    const dev = deviceOf(a.p()), info = BufferInfo.read(a.p()); a.p(); const out = a.p();
    if (info.size > dev.physical.limits.maxBufferSize) return R.OUT_OF_DEVICE_MEMORY;
    const gpu = dev.gpu.createBuffer({ size: align(info.size, 4), usage: bufferUsage(info.usage) });
    stU64(out, handle(new Buffer(gpu, info.size, info.usage)));
    return R.SUCCESS;
  },
  vkDestroyBuffer: (_c, a) => { a.p(); const h = nd(a), b = maybe<Buffer>(h); b?.gpu.destroy(); release(h); },
  vkGetBufferMemoryRequirements: (_c, a) => { a.p(); const b = object<Buffer>(nd(a)); writeRequirements(a.p(), align(b.size, ALIGN), allTypes); },
  vkGetBufferMemoryRequirements2: (_c, a) => {
    a.p(); const b = object<Buffer>(RequirementsInfo2.read(a.p()).object), out = a.p();
    writeRequirements(out + Requirements2.off("requirements"), align(b.size, ALIGN), allTypes);
    const d = chain(ldp(out + PTR)).get(ST.DEDICATED_REQUIREMENTS);
    if (d) Dedicated.write(d, { prefers: 0, requires: 0 });
  },
  vkBindBufferMemory: (_c, a) => { a.p(); const b = object<Buffer>(nd(a)); b.memory = object<Memory>(nd(a)); b.offset = Number(a.ul()); return R.SUCCESS; },
  vkBindBufferMemory2: (_c, a) => {
    a.p(); const n = a.u(), infos = a.p();
    for (let i = 0; i < n; i++) {
      const info = BindInfo.read(infos + i * BindInfo.size()), b = object<Buffer>(info.object);
      b.memory = object<Memory>(info.memory); b.offset = info.memoryOffset;
    }
    return R.SUCCESS;
  },

  vkCreateImage: (_c, a) => {
    const dev = deviceOf(a.p()), info = ImageInfo.read(a.p()); a.p(); const out = a.p();
    const ef = chain(info.pNext).get(ST.EXTERNAL_FORMAT), externalFormat = ef ? Number(mem.ld64(ef + 2 * PTR)) : 0;
    if (externalFormat && (info.format || !EXTERNAL_FORMATS.has(externalFormat))) return R.FORMAT_NOT_SUPPORTED;
    if (externalFormat) info.format = EXTERNAL_PIXELS;
    const f = textureFormat(info.format);
    if (!f || info.tiling !== 0) return R.FORMAT_NOT_SUPPORTED;
    const ext = chain(info.pNext).get(ST.EXTERNAL_IMAGE), external = !!ext && !!(ExternalImage.read(ext).handleTypes & AHB_HANDLE);
    const samples = info.samples, mutable = info.flags & 0x8, pair = mutable ? srgbPair(f.gpu) : null;
    const desc: GPUTextureDescriptor = {
      dimension: IMAGE_DIMENSION[info.imageType], format: f.gpu, mipLevelCount: info.mipLevels, sampleCount: samples,
      size: { width: info.width, height: info.height, depthOrArrayLayers: info.imageType === 2 ? info.depth : info.arrayLayers },
      usage: imageUsage(info.usage, samples, !!(formatFeatures(info.format, dev.physical.features).optimal & (F.COLOR | F.DEPTH))), viewFormats: pair ? [pair] : [],
    };
    const img = new Image(desc, f, info.format, external);
    if (!external) img.gpu = dev.gpu.createTexture(desc);
    stU64(out, handle(img));
    return R.SUCCESS;
  },
  vkDestroyImage: (_c, a) => { a.p(); const h = nd(a), img = maybe<Image>(h); img?.gpu?.destroy(); release(h); },
  vkGetImageMemoryRequirements: (_c, a) => { a.p(); const img = object<Image>(nd(a)); writeRequirements(a.p(), imageBytes(img), 1); },
  vkGetImageMemoryRequirements2: (_c, a) => {
    a.p(); const img = object<Image>(RequirementsInfo2.read(a.p()).object), out = a.p();
    writeRequirements(out + Requirements2.off("requirements"), imageBytes(img), 1);
    const d = chain(ldp(out + PTR)).get(ST.DEDICATED_REQUIREMENTS);
    if (d) Dedicated.write(d, { prefers: img.external ? 1 : 0, requires: img.external ? 1 : 0 });
  },
  vkGetImageSparseMemoryRequirements: (_c, a) => { a.p(); nd(a); mem.st32(a.p(), 0); },
  vkGetImageSparseMemoryRequirements2: (_c, a) => { a.p(); a.p(); mem.st32(a.p(), 0); },
  vkBindImageMemory: (_c, a) => { const dev = deviceOf(a.p()), img = object<Image>(nd(a)), m = object<Memory>(nd(a)); a.ul(); return bind(dev, img, m); },
  vkBindImageMemory2: (_c, a) => {
    const dev = deviceOf(a.p()), n = a.u(), infos = a.p();
    for (let i = 0; i < n; i++) {
      const info = BindInfo.read(infos + i * BindInfo.size()), r = bind(dev, object<Image>(info.object), object<Memory>(info.memory));
      if (r) return r;
    }
    return R.SUCCESS;
  },
  // no image is linear, so no layout is the host's to give
  vkGetImageSubresourceLayout: (_c, a) => { a.p(); nd(a); a.p(); mem.memset(a.p(), 0, 40); },

  vkCreateImageView: (_c, a) => {
    const dev = deviceOf(a.p()), info = ViewInfo.read(a.p()); a.p(); const out = a.p(), img = object<Image>(info.image);
    // an image of an external format has views of no format of their own
    const f = info.format ? textureFormat(info.format) : img.format;
    if (!f) return R.FORMAT_NOT_SUPPORTED;
    const aspect: GPUTextureAspect = info.aspectMask === 2 && img.format.stencil ? "depth-only" : info.aspectMask === 4 && img.format.depth ? "stencil-only" : "all";
    const levels = img.desc.mipLevelCount ?? 1, layers = img.desc.dimension === "3d" ? 1 : (img.desc.size as GPUExtent3DDict).depthOrArrayLayers ?? 1;
    const desc: GPUTextureViewDescriptor = {
      format: f.gpu, dimension: VIEW_DIMENSION[info.viewType], aspect,
      baseMipLevel: info.baseMipLevel, mipLevelCount: info.levelCount === 0xffffffff ? levels - info.baseMipLevel : info.levelCount,
      baseArrayLayer: info.baseArrayLayer, arrayLayerCount: info.layerCount === 0xffffffff ? layers - info.baseArrayLayer : info.layerCount,
    };
    const swizzle = [info.r, info.g, info.b, info.a].map((c, i) => "rgba01"[c === 0 ? i : c === 1 ? 4 : c === 2 ? 5 : c - 3]).join("");
    if (swizzle !== "rgba") {
      if (!dev.physical.features.has("texture-component-swizzle")) return R.FEATURE_NOT_PRESENT;
      (desc as GPUTextureViewDescriptor & { swizzle?: string }).swizzle = swizzle;
    }
    stU64(out, handle(new View(img, desc)));
    return R.SUCCESS;
  },
  vkDestroyImageView: (_c, a) => { a.p(); release(nd(a)); },

  vkCreateSampler: (_c, a) => {
    const dev = deviceOf(a.p()), s = SamplerInfo.read(a.p()); a.p(); const out = a.p();
    const filter = (v: number): GPUFilterMode => v ? "linear" : "nearest";
    // clamp-to-border has no WebGPU counterpart; its edge texels stand in for the border colour
    const address = (v: number): GPUAddressMode => v === 0 ? "repeat" : v === 1 ? "mirror-repeat" : "clamp-to-edge";
    const COMPARE: GPUCompareFunction[] = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
    const linear = s.magFilter && s.minFilter && s.mipmapMode;
    const desc: GPUSamplerDescriptor = {
      magFilter: filter(s.magFilter), minFilter: filter(s.minFilter), mipmapFilter: s.mipmapMode ? "linear" : "nearest",
      addressModeU: address(s.addressModeU), addressModeV: address(s.addressModeV), addressModeW: address(s.addressModeW),
      lodMinClamp: Math.max(0, s.minLod), lodMaxClamp: Math.min(32, Math.max(s.minLod, s.maxLod)),
      maxAnisotropy: s.anisotropyEnable && linear ? Math.max(1, Math.min(16, Math.floor(s.maxAnisotropy))) : 1,
    };
    if (s.compareEnable) desc.compare = COMPARE[s.compareOp];
    stU64(out, handle(dev.gpu.createSampler(desc)));
    return R.SUCCESS;
  },
  vkDestroySampler: (_c, a) => { a.p(); release(nd(a)); },
  // the only formats that take a conversion are the external ones, whose pixels need none (RGB_IDENTITY)
  vkCreateSamplerYcbcrConversion: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), handle({})); return R.SUCCESS; },
  vkDestroySamplerYcbcrConversion: (_c, a) => { a.p(); release(nd(a)); },

  vkGetAndroidHardwareBufferPropertiesANDROID: (_c, a) => {
    a.p(); const b = bufferAt(a.p()), out = a.p();
    if (!b) return R.INVALID_EXTERNAL_HANDLE;
    const vk = AHB_FORMATS.get(b.format), external = EXTERNAL_FORMATS.has(b.format) ? b.format : 0;
    if (!vk && !external) return R.INVALID_EXTERNAL_HANDLE;
    AhbProperties.write(out, { allocationSize: align(b.bytes, ALIGN), memoryTypeBits: 1 });
    const f = chain(ldp(out + PTR)).get(ST.AHB_FORMAT_PROPERTIES);
    // a known format with the identity swizzle; an external one sampled through a conversion that is the identity, of
    // full-range RGB (SAMPLED_IMAGE, linear filtering, of the conversion too, and cosited chroma)
    const features = vk ? 0x1 | 0x80 | 0x100 | 0x1000 | 0x4000 | 0x8000 : 0x1 | 0x1000 | 0x40000 | 0x800000;
    if (f) AhbFormat.write(f, { format: vk ?? 0, externalFormat: external, formatFeatures: features, r: 0, g: 0, b: 0, a: 0, suggestedYcbcrModel: 0, suggestedYcbcrRange: 0, suggestedXChromaOffset: 0, suggestedYChromaOffset: 0 });
    return R.SUCCESS;
  },
  vkGetMemoryAndroidHardwareBufferANDROID: (_c, a) => {
    a.p(); const info = a.p(), out = a.p(), m = object<Memory>(Number(mem.ld64(info + RequirementsInfo2.off("object"))));
    if (!m.ahb) return R.INVALID_EXTERNAL_HANDLE;
    acquire(m.ahb); stp(out, m.ahb.at);
    return R.SUCCESS;
  },
};
/** AHardwareBuffer formats as VkFormats, those WebGPU has: RGBA8, RGBX8, RGBA16F, RGB10A2 */
const AHB_FORMATS = new Map([[1, 37], [2, 37], [0x16, 97], [0x2b, 64]]);
/** IMPLEMENTATION_DEFINED and Y8Cb8Cr8_420, external formats named by their AHardwareBuffer format, whose pixels are RGBA (hardwarebuffer.ts) */
const EXTERNAL_FORMATS = new Set([0x22, 0x23]);
