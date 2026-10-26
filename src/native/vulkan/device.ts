// The logical device and its resources: a GPUDevice with every feature and limit of the adapter, one
// queue, and memory, buffers, images, views and samplers over WebGPU objects. Memory a host may map is
// guest memory; a buffer bound to it is a GPUBuffer whose contents a submit carries to and from it.
// An image bound to an imported AHardwareBuffer's memory takes its pixels from and gives them back to
// the buffer when it changes hands with the foreign queue family (submit.ts).

import { mem } from "../mem.ts";
import { PTR, ldp, stp, type HostFn } from "../host.ts";
import { bufferAt, acquire, release as releaseBuffer, vulkanFormat, type HardwareBuffer } from "../hardwarebuffer.ts";
import { struct, ptrs, stU64, WHOLE } from "../struct.ts";
import { R, S, AHB_HANDLE, REMAINING, COMPARE, UNIFORM_RANGE, objects, dispatchable, nd, chain } from "./vk.ts";
import { F, decodedFormat, formatFeatures, textureFormat, vkFormatOf, type TextureFormat } from "./formats.ts";
import { DEVICE_EXTENSIONS, MEMORY_TYPES, Physical, deviceAdapter } from "./instance.ts";
import type { PushChunk } from "./pipeline.ts";

/** GPUBufferUsage and GPUTextureUsage */
export const BU = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, STORAGE: 0x80 } as const;
export const TU = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10 } as const;

export class Device {
  lost = false;
  /** the buffers of push constants (pipeline.ts) */
  readonly push: PushChunk[] = [];
  readonly physical: Physical;
  readonly gpu: GPUDevice;
  /** the handle of its one queue */
  readonly queue: number;
  constructor(physical: Physical, gpu: GPUDevice) { this.physical = physical; this.gpu = gpu; this.queue = dispatchable(new Queue(this)); }
}
export class Queue {
  readonly dev: Device;
  constructor(dev: Device) { this.dev = dev; }
}

export class Memory {
  /** the guest bytes of host-visible memory, 0 for device-local memory */
  host = 0;
  ahb: HardwareBuffer | null = null;
  readonly size: number;
  readonly type: number;
  constructor(size: number, type: number) { this.size = size; this.type = type; }
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
type Extent = Required<GPUExtent3DDict>;
export class Image {
  gpu: GPUTexture | null = null;
  /** a compressed image whose size is not whole blocks, which WebGPU cannot create: its blocks, padded to whole blocks, as copies
   *  give them, which `texture` holds decoded at the image's size (internal.ts decodes them after each copy) */
  blocks: GPUTexture | null = null;
  ahb: HardwareBuffer | null = null;
  readonly desc: GPUTextureDescriptor & { size: Extent };
  readonly format: TextureFormat;
  readonly vk: number;
  readonly external: boolean;
  /** whether the format can be an attachment */
  readonly renderable: boolean;
  readonly is3d: boolean;
  readonly levels: number;
  readonly layers: number;
  constructor(desc: GPUTextureDescriptor & { size: Extent }, format: TextureFormat, vk: number, external: boolean, renderable: boolean) {
    this.desc = desc; this.format = format; this.vk = vk; this.external = external; this.renderable = renderable;
    this.is3d = desc.dimension === "3d"; this.levels = desc.mipLevelCount ?? 1; this.layers = this.is3d ? 1 : desc.size.depthOrArrayLayers;
  }
  get texture(): GPUTexture { if (!this.gpu) throw new Error("vulkan: image without memory"); return this.gpu; }
  /** the texture copies to and from the image use */
  get copied(): GPUTexture { return this.blocks ?? this.texture; }
  /** whether its size is not whole blocks of its format */
  get partial(): boolean { const { width, height } = this.desc.size; return width % this.format.bw !== 0 || height % this.format.bh !== 0; }
  create(gpu: GPUDevice): void {
    if (!this.partial) { this.gpu = gpu.createTexture(this.desc); return; }
    const { bw, bh } = this.format, { width, height } = this.desc.size;
    this.blocks = gpu.createTexture({ ...this.desc, size: { ...this.desc.size, width: align(width, bw), height: align(height, bh) }, usage: TU.COPY_SRC | TU.COPY_DST | TU.TEXTURE_BINDING, viewFormats: [] });
    this.gpu = gpu.createTexture({ ...this.desc, format: decodedFormat(this.format), usage: this.desc.usage | TU.RENDER_ATTACHMENT, viewFormats: [] });
  }
  destroy(): void { this.gpu?.destroy(); this.blocks?.destroy(); }
  /** level `l`'s extent, a layer's */
  extent(l: number): Extent {
    const { width, height, depthOrArrayLayers } = this.desc.size;
    return { width: Math.max(1, width >> l), height: Math.max(1, height >> l), depthOrArrayLayers: this.is3d ? Math.max(1, depthOrArrayLayers >> l) : 1 };
  }
  /** the aspect VkImageAspectFlags `mask` names */
  aspect(mask: number): GPUTextureAspect { return mask === 2 && this.format.stencil ? "depth-only" : mask === 4 && this.format.depth ? "stencil-only" : "all"; }
  /** the levels and layers of a VkImageSubresourceRange, the remaining ones counted */
  range(r: { baseMipLevel: number; levelCount: number; baseArrayLayer: number; layerCount: number }): { baseMipLevel: number; mipLevelCount: number; baseArrayLayer: number; arrayLayerCount: number } {
    return {
      baseMipLevel: r.baseMipLevel, mipLevelCount: r.levelCount === REMAINING ? this.levels - r.baseMipLevel : r.levelCount,
      baseArrayLayer: r.baseArrayLayer, arrayLayerCount: r.layerCount === REMAINING ? this.layers - r.baseArrayLayer : r.layerCount,
    };
  }
}
/** a texel buffer view: the range of the buffer a shader reads as an array of its texels' components */
export class BufferView {
  readonly buffer: Buffer; readonly offset: number; readonly size: number;
  constructor(buffer: Buffer, offset: number, size: number) { this.buffer = buffer; this.offset = offset; this.size = size; }
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
const Requirements2 = struct("sType:u32 pNext:ptr requirements:struct", { requirements: Requirements });
const Dedicated = struct("sType:u32 pNext:ptr prefers:u32 requires:u32");
const BindInfo = struct("sType:u32 pNext:ptr object:u64 memory:u64 memoryOffset:u64");
/** a struct naming one object: VkBuffer/ImageMemoryRequirementsInfo2, VkMemoryGetAndroidHardwareBufferInfoANDROID */
const ObjectInfo = struct("sType:u32 pNext:ptr object:u64");
const ImageInfo = struct(`sType:u32 pNext:ptr flags:u32 imageType:u32 format:u32 width:u32 height:u32 depth:u32 mipLevels:u32 arrayLayers:u32
  samples:u32 tiling:u32 usage:u32 sharingMode:u32 queueFamilyIndexCount:u32 pQueueFamilyIndices:ptr initialLayout:u32`);
const ExternalImage = struct("sType:u32 pNext:ptr handleTypes:u32");
const ExternalFormat = struct("sType:u32 pNext:ptr externalFormat:u64");
const BufferViewInfo = struct("sType:u32 pNext:ptr flags:u32 buffer:u64 format:u32 offset:u64 range:u64");
const ViewInfo = struct(`sType:u32 pNext:ptr flags:u32 image:u64 viewType:u32 format:u32 r:u32 g:u32 b:u32 a:u32
  aspectMask:u32 baseMipLevel:u32 levelCount:u32 baseArrayLayer:u32 layerCount:u32`);
const SamplerInfo = struct(`sType:u32 pNext:ptr flags:u32 magFilter:u32 minFilter:u32 mipmapMode:u32 addressModeU:u32 addressModeV:u32
  addressModeW:u32 mipLodBias:f32 anisotropyEnable:u32 maxAnisotropy:f32 compareEnable:u32 compareOp:u32 minLod:f32 maxLod:f32 borderColor:u32
  unnormalizedCoordinates:u32`);
const AhbProperties = struct("sType:u32 pNext:ptr allocationSize:u64 memoryTypeBits:u32");
const AhbFormat = struct(`sType:u32 pNext:ptr format:u32 externalFormat:u64 formatFeatures:u32 r:u32 g:u32 b:u32 a:u32
  suggestedYcbcrModel:u32 suggestedYcbcrRange:u32 suggestedXChromaOffset:u32 suggestedYChromaOffset:u32`);
/** VK_FORMAT_R8G8B8A8_UNORM: the pixels of the AHardwareBuffers that are an external format, a decoder's frames */
const EXTERNAL_PIXELS = 37;

/** the alignment of every buffer and image in memory: WebGPU's buffer-offset and copy alignments */
const ALIGN = 256;
const align = (n: number, to: number) => Math.ceil(n / to) * to;
const HOST_VISIBLE = 2;

// VkBufferUsageFlags → GPUBufferUsage: uniform, index, vertex, indirect; every buffer is a storage buffer, as a copy to it at
// any byte offset writes through a shader (internal.ts)
const BUFFER_USAGE: [number, number][] = [[0x10, 0x40], [0x40, 0x10], [0x80, 0x20], [0x100, 0x100]];
const bufferUsage = (vk: number) => BUFFER_USAGE.reduce((u, [bit, gpu]) => vk & bit ? u | gpu : u, BU.COPY_SRC | BU.COPY_DST | BU.STORAGE);
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
  const f = img.format;
  let total = 0;
  for (let l = 0; l < img.levels; l++) {
    const e = img.extent(l);
    total += Math.ceil(e.width / f.bw) * Math.ceil(e.height / f.bh) * f.bytes * e.depthOrArrayLayers * img.layers;
  }
  return align(total * (img.desc.sampleCount ?? 1), ALIGN);
}

function bind(dev: Device, img: Image, memory: Memory): number {
  if (img.external) {
    const b = memory.ahb;
    if (!b) return R.INVALID_EXTERNAL_HANDLE;
    img.ahb = b;
  }
  img.create(dev.gpu);
  return R.SUCCESS;
}
function writeRequirements(at: number, size: number, bits: number): void { Requirements.write(at, { size, alignment: ALIGN, memoryTypeBits: bits }); }
const allTypes = (1 << MEMORY_TYPES.length) - 1;

export const DEVICE: Record<string, HostFn> = {
  vkCreateDevice: async (_c, a) => {
    const p = objects.get(a.p(), Physical), info = DeviceInfo.read(a.p()); a.p(); const out = a.p();
    const known = new Set(DEVICE_EXTENSIONS.map(([n]) => n));
    if (ptrs(info.extensionNames, info.extensions).some((n) => !known.has(mem.cstr(n)))) return R.EXTENSION_NOT_PRESENT;
    // every capability the adapter has: Vulkan enables features a device then never needs to ask WebGPU for
    const requiredLimits: Record<string, number> = {};
    for (const k in p.limits) { const v = p.limits[k as keyof GPUSupportedLimits]; if (typeof v === "number") requiredLimits[k] = v; }
    const adapter = await deviceAdapter(p);
    if (!adapter) return R.INITIALIZATION_FAILED;
    const gpu = await adapter.requestDevice({ requiredFeatures: [...p.features] as GPUFeatureName[], requiredLimits }).catch((e: Error) => e);
    if (gpu instanceof Error) { console.warn("[vulkan] requestDevice:", gpu.message); return R.INITIALIZATION_FAILED; }
    const dev = new Device(p, gpu);
    gpu.onuncapturederror = (e) => console.warn("[vulkan] WebGPU error:", e.error.message);
    void gpu.lost.then((l) => { dev.lost = true; if (l.reason !== "destroyed") console.warn("[vulkan] device lost:", l.message); });
    stp(out, dispatchable(dev));
    return R.SUCCESS;
  },
  vkDestroyDevice: (_c, a) => { const h = a.p(); if (!h) return; const dev = objects.get(h, Device); dev.gpu.destroy(); objects.delete(dev.queue); objects.delete(h); },
  vkGetDeviceQueue: (_c, a) => { const dev = objects.get(a.p(), Device); a.u(); a.u(); stp(a.p(), dev.queue); },
  vkGetDeviceQueue2: (_c, a) => { const dev = objects.get(a.p(), Device); a.p(); stp(a.p(), dev.queue); },
  vkDeviceWaitIdle: async (_c, a) => { const dev = objects.get(a.p(), Device); await dev.gpu.queue.onSubmittedWorkDone(); return dev.lost ? R.DEVICE_LOST : R.SUCCESS; },

  vkAllocateMemory: (_c, a) => {
    a.p(); const info = AllocateInfo.read(a.p()); a.p(); const out = a.p();
    const m = new Memory(info.allocationSize, info.memoryTypeIndex), links = chain(info.pNext);
    const ahb = links.get(S.IMPORT_AHB);
    if (ahb) {
      const b = bufferAt(ImportAhb.read(ahb).buffer);
      if (!b) return R.INVALID_EXTERNAL_HANDLE;
      acquire(b); m.ahb = b;
    } else if (links.has(S.EXPORT_MEMORY)) return R.INVALID_EXTERNAL_HANDLE;           // no AHardwareBuffer is made here
    if (MEMORY_TYPES[m.type] & HOST_VISIBLE) {
      if (m.size > 2 ** 31 || !(m.host = mem.memalign(64, m.size))) return R.OUT_OF_HOST_MEMORY;
      mem.memset(m.host, 0, m.size);
    }
    stU64(out, objects.add(m));
    return R.SUCCESS;
  },
  vkFreeMemory: (_c, a) => {
    a.p(); const h = nd(a), m = objects.find(h, Memory);
    if (!m) return;
    if (m.host) mem.free(m.host);
    if (m.ahb) releaseBuffer(m.ahb);
    objects.delete(h);
  },
  vkMapMemory: (_c, a) => {
    a.p(); const m = objects.get(nd(a), Memory), offset = Number(a.ul()); a.ul(); a.u(); const out = a.p();
    if (!m.host) return R.MEMORY_MAP_FAILED;
    stp(out, m.host + offset);
    return R.SUCCESS;
  },
  vkUnmapMemory: () => {},
  // the memory is coherent: a submit reads it as it stands then
  vkFlushMappedMemoryRanges: () => R.SUCCESS,
  vkInvalidateMappedMemoryRanges: () => R.SUCCESS,
  vkGetDeviceMemoryCommitment: (_c, a) => { a.p(); const m = objects.get(nd(a), Memory); stU64(a.p(), m.size); },

  vkCreateBuffer: (_c, a) => {
    const dev = objects.get(a.p(), Device), info = BufferInfo.read(a.p()); a.p(); const out = a.p();
    if (info.size > dev.physical.limits.maxBufferSize) return R.OUT_OF_DEVICE_MEMORY;
    const gpu = dev.gpu.createBuffer({ size: align(info.size, 4) + (info.usage & 0x10 ? UNIFORM_RANGE : 0), usage: bufferUsage(info.usage) });
    stU64(out, objects.add(new Buffer(gpu, info.size, info.usage)));
    return R.SUCCESS;
  },
  vkDestroyBuffer: (_c, a) => { a.p(); const h = nd(a); objects.find(h, Buffer)?.gpu.destroy(); objects.delete(h); },
  vkGetBufferMemoryRequirements: (_c, a) => { a.p(); const b = objects.get(nd(a), Buffer); writeRequirements(a.p(), align(b.size, ALIGN), allTypes); },
  vkGetBufferMemoryRequirements2: (_c, a) => {
    a.p(); const b = objects.get(ObjectInfo.read(a.p()).object, Buffer), out = a.p();
    writeRequirements(out + Requirements2.off("requirements"), align(b.size, ALIGN), allTypes);
    const d = chain(ldp(out + PTR)).get(S.DEDICATED_REQUIREMENTS);
    if (d) Dedicated.write(d, { prefers: 0, requires: 0 });
  },
  vkBindBufferMemory: (_c, a) => { a.p(); const b = objects.get(nd(a), Buffer); b.memory = objects.get(nd(a), Memory); b.offset = Number(a.ul()); return R.SUCCESS; },
  vkBindBufferMemory2: (_c, a) => {
    a.p(); const n = a.u(), infos = a.p();
    for (let i = 0; i < n; i++) {
      const info = BindInfo.read(infos + i * BindInfo.size()), b = objects.get(info.object, Buffer);
      b.memory = objects.get(info.memory, Memory); b.offset = info.memoryOffset;
    }
    return R.SUCCESS;
  },

  vkCreateBufferView: (_c, a) => {
    a.p(); const info = BufferViewInfo.read(a.p()); a.p(); const out = a.p(), b = objects.get(info.buffer, Buffer);
    stU64(out, objects.add(new BufferView(b, info.offset, info.range === WHOLE ? (b.size - info.offset) & ~3 : info.range)));
    return R.SUCCESS;
  },
  vkDestroyBufferView: (_c, a) => { a.p(); objects.delete(nd(a)); },

  vkCreateImage: (_c, a) => {
    const dev = objects.get(a.p(), Device), info = ImageInfo.read(a.p()); a.p(); const out = a.p();
    const ef = chain(info.pNext).get(S.EXTERNAL_FORMAT), externalFormat = ef ? ExternalFormat.read(ef).externalFormat : 0;
    if (externalFormat && (info.format || !vulkanFormat(externalFormat)?.external)) return R.FORMAT_NOT_SUPPORTED;
    if (externalFormat) info.format = EXTERNAL_PIXELS;
    const f = textureFormat(info.format);
    if (!f || info.tiling !== 0) return R.FORMAT_NOT_SUPPORTED;
    const ext = chain(info.pNext).get(S.EXTERNAL_IMAGE), external = !!ext && !!(ExternalImage.read(ext).handleTypes & AHB_HANDLE);
    const samples = info.samples, mutable = info.flags & 0x8, pair = mutable ? srgbPair(f.gpu) : null;
    const renderable = !!(formatFeatures(info.format, dev.physical.features).optimal & (F.COLOR | F.DEPTH));
    const img = new Image({
      dimension: IMAGE_DIMENSION[info.imageType], format: f.gpu, mipLevelCount: info.mipLevels, sampleCount: samples,
      size: { width: info.width, height: info.height, depthOrArrayLayers: info.imageType === 2 ? info.depth : info.arrayLayers },
      usage: imageUsage(info.usage, samples, renderable), viewFormats: pair ? [pair] : [],
    }, f, info.format, external, renderable);
    if (img.partial && img.is3d) return R.FORMAT_NOT_SUPPORTED;
    if (!external) img.create(dev.gpu);
    stU64(out, objects.add(img));
    return R.SUCCESS;
  },
  vkDestroyImage: (_c, a) => { a.p(); const h = nd(a); objects.find(h, Image)?.destroy(); objects.delete(h); },
  vkGetImageMemoryRequirements: (_c, a) => { a.p(); const img = objects.get(nd(a), Image); writeRequirements(a.p(), imageBytes(img), 1); },
  vkGetImageMemoryRequirements2: (_c, a) => {
    a.p(); const img = objects.get(ObjectInfo.read(a.p()).object, Image), out = a.p();
    writeRequirements(out + Requirements2.off("requirements"), imageBytes(img), 1);
    const d = chain(ldp(out + PTR)).get(S.DEDICATED_REQUIREMENTS);
    if (d) Dedicated.write(d, { prefers: img.external ? 1 : 0, requires: img.external ? 1 : 0 });
  },
  vkGetImageSparseMemoryRequirements: (_c, a) => { a.p(); nd(a); mem.st32(a.p(), 0); },
  vkGetImageSparseMemoryRequirements2: (_c, a) => { a.p(); a.p(); mem.st32(a.p(), 0); },
  vkBindImageMemory: (_c, a) => { const dev = objects.get(a.p(), Device), img = objects.get(nd(a), Image), m = objects.get(nd(a), Memory); a.ul(); return bind(dev, img, m); },
  vkBindImageMemory2: (_c, a) => {
    const dev = objects.get(a.p(), Device), n = a.u(), infos = a.p();
    for (let i = 0; i < n; i++) {
      const info = BindInfo.read(infos + i * BindInfo.size()), r = bind(dev, objects.get(info.object, Image), objects.get(info.memory, Memory));
      if (r) return r;
    }
    return R.SUCCESS;
  },
  // no image is linear, so no layout is the host's to give
  vkGetImageSubresourceLayout: (_c, a) => { a.p(); nd(a); a.p(); mem.memset(a.p(), 0, 40); },

  vkCreateImageView: (_c, a) => {
    const dev = objects.get(a.p(), Device), info = ViewInfo.read(a.p()); a.p(); const out = a.p(), img = objects.get(info.image, Image);
    // an image of an external format has views of no format of their own
    const f = info.format ? textureFormat(info.format) : img.format;
    if (!f) return R.FORMAT_NOT_SUPPORTED;
    const desc: GPUTextureViewDescriptor = { format: img.blocks ? img.texture.format : f.gpu, dimension: VIEW_DIMENSION[info.viewType], aspect: img.aspect(info.aspectMask), ...img.range(info) };
    const swizzle = [info.r, info.g, info.b, info.a].map((c, i) => "rgba01"[c === 0 ? i : c === 1 ? 4 : c === 2 ? 5 : c - 3]).join("");
    if (swizzle !== "rgba") {
      if (!dev.physical.features.has("texture-component-swizzle")) return R.FEATURE_NOT_PRESENT;
      (desc as GPUTextureViewDescriptor & { swizzle?: string }).swizzle = swizzle;
    }
    stU64(out, objects.add(new View(img, desc)));
    return R.SUCCESS;
  },
  vkDestroyImageView: (_c, a) => { a.p(); objects.delete(nd(a)); },

  vkCreateSampler: (_c, a) => {
    const dev = objects.get(a.p(), Device), s = SamplerInfo.read(a.p()); a.p(); const out = a.p();
    const filter = (v: number): GPUFilterMode => v ? "linear" : "nearest";
    // clamp-to-border has no WebGPU counterpart; its edge texels stand in for the border colour
    const address = (v: number): GPUAddressMode => v === 0 ? "repeat" : v === 1 ? "mirror-repeat" : "clamp-to-edge";
    const linear = s.magFilter && s.minFilter && s.mipmapMode;
    const desc: GPUSamplerDescriptor = {
      magFilter: filter(s.magFilter), minFilter: filter(s.minFilter), mipmapFilter: s.mipmapMode ? "linear" : "nearest",
      addressModeU: address(s.addressModeU), addressModeV: address(s.addressModeV), addressModeW: address(s.addressModeW),
      lodMinClamp: Math.max(0, s.minLod), lodMaxClamp: Math.min(32, Math.max(s.minLod, s.maxLod)),
      maxAnisotropy: s.anisotropyEnable && linear ? Math.max(1, Math.min(16, Math.floor(s.maxAnisotropy))) : 1,
    };
    if (s.compareEnable) desc.compare = COMPARE[s.compareOp];
    stU64(out, objects.add(dev.gpu.createSampler(desc)));
    return R.SUCCESS;
  },
  vkDestroySampler: (_c, a) => { a.p(); objects.delete(nd(a)); },
  // the only formats that take a conversion are the external ones, whose pixels need none (RGB_IDENTITY)
  vkCreateSamplerYcbcrConversion: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), objects.add({})); return R.SUCCESS; },
  vkDestroySamplerYcbcrConversion: (_c, a) => { a.p(); objects.delete(nd(a)); },

  vkGetAndroidHardwareBufferPropertiesANDROID: (_c, a) => {
    a.p(); const b = bufferAt(a.p()), out = a.p();
    if (!b) return R.INVALID_EXTERNAL_HANDLE;
    const format = vulkanFormat(b.format), vk = format?.vk, external = format?.external ? b.format : 0;
    if (!vk && !external) return R.INVALID_EXTERNAL_HANDLE;
    AhbProperties.write(out, { allocationSize: align(b.bytes, ALIGN), memoryTypeBits: 1 });
    const f = chain(ldp(out + PTR)).get(S.AHB_FORMAT_PROPERTIES);
    // a known format with the identity swizzle; an external one sampled through a conversion that is the identity, of
    // full-range RGB (SAMPLED_IMAGE, linear filtering, of the conversion too, and cosited chroma)
    const features = vk ? 0x1 | 0x80 | 0x100 | 0x1000 | 0x4000 | 0x8000 : 0x1 | 0x1000 | 0x40000 | 0x800000;
    if (f) AhbFormat.write(f, { format: vk ?? 0, externalFormat: external, formatFeatures: features, r: 0, g: 0, b: 0, a: 0, suggestedYcbcrModel: 0, suggestedYcbcrRange: 0, suggestedXChromaOffset: 0, suggestedYChromaOffset: 0 });
    return R.SUCCESS;
  },
  vkGetMemoryAndroidHardwareBufferANDROID: (_c, a) => {
    a.p(); const info = a.p(), out = a.p(), m = objects.get(ObjectInfo.read(info).object, Memory);
    if (!m.ahb) return R.INVALID_EXTERNAL_HANDLE;
    acquire(m.ahb); stp(out, m.ahb.at);
    return R.SUCCESS;
  },
};
