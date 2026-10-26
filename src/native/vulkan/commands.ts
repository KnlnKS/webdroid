// Command pools and buffers. Recording reads each command's arguments into an operation, and a submit
// replays a buffer's operations into GPUCommandEncoders: render passes into render pass encoders,
// dispatches into compute passes, copies and clears into the encoder itself. Vulkan's state outlives
// passes and WebGPU's does not, so the replay keeps it and sets on each pass what a draw needs.

import { mem } from "../mem.ts";
import { PTR, ldp, stp, type HostFn } from "../host.ts";
import { struct, list, u64s, stU64, WHOLE, type Read } from "../struct.ts";
import { texel, type TextureFormat } from "./formats.ts";
import { R, UNUSED, objects, dispatchable, nd } from "./vk.ts";
import { BU, TU, Buffer, Device, Image } from "./device.ts";
import { bindGroup, BindGroupCache, PUSH_SIZE, PUSH_SLOT, DescriptorSet, GraphicsPipeline, type Bound, type ComputePipeline, type Framebuffer, type PushSlot, type RenderPass } from "./pipeline.ts";
import { take } from "./ahb.ts";
import { blit, clearAttachments, copyBytes } from "./internal.ts";
import type { Resource } from "./spirv/index.ts";

/** an operation of a command buffer, carried out in a submit's replay */
export type Op = (r: Replay) => void;
export class CommandBuffer {
  ops: Op[] = [];
  /** the buffers in host-visible memory the commands use, and those of them they write */
  readonly host = new Set<Buffer>();
  readonly written = new Set<Buffer>();
  readonly dev: Device;
  constructor(dev: Device) { this.dev = dev; }
  reset(): void { this.ops = []; this.host.clear(); this.written.clear(); }
  use(b: Buffer, write = false): void { if (!b.host) return; this.host.add(b); if (write) this.written.add(b); }
}
export const cbOf = (h: number): CommandBuffer => objects.get(h, CommandBuffer);
/** records `op` on the command buffer `h` */
const record = (h: number, op: Op) => { cbOf(h).ops.push(op); };
/** a command pool: the handles of its command buffers, to free and reset them with it */
class CommandPool { readonly buffers = new Set<number>(); }

const QUEUE_FAMILY_FOREIGN = 0xfffffffd, QUEUE_FAMILY_EXTERNAL = 0xfffffffe;
const foreign = (family: number) => family === QUEUE_FAMILY_FOREIGN || family === QUEUE_FAMILY_EXTERNAL;
/** what is set on the current pass encoder, to set only what changes */
interface PassState { pipeline: GPURenderPipeline | GPUComputePipeline | null; groups: (GPUBindGroup | null)[]; vertex: ({ buffer: GPUBuffer; offset: number } | undefined)[];  viewport: string; scissor: string; blend: string; stencil: number }
const freshPass = (): PassState => ({ pipeline: null, groups: [], vertex: [], viewport: "", scissor: "", blend: "", stencil: -1 });

/** a submit's replay: the encoder being written, the pass in progress and the state commands set */
export class Replay {
  enc: GPUCommandEncoder;
  /** finished encoders, submitted in order before what comes next */
  readonly done: GPUCommandBuffer[] = [];
  pass: GPURenderPassEncoder | null = null;
  compute: GPUComputePassEncoder | null = null;
  passState = freshPass();
  /** the render pass instance: its pass, framebuffer, subpass and clear values */
  rp: { pass: RenderPass; fb: Framebuffer; subpass: number; clears: number[][] } | null = null;
  graphics: GraphicsPipeline | null = null; computePipeline: ComputePipeline | null = null;
  graphicsSets: (Bound | null)[] = []; computeSets: (Bound | null)[] = [];
  vertex: ({ buffer: Buffer; offset: number } | null)[] = [];
  index: { buffer: Buffer; offset: number; format: GPUIndexFormat } | null = null;
  viewport: Read<typeof ViewportS> | null = null; scissor: number[] | null = null; blend = [0, 0, 0, 0]; stencil = 0;
  /** the push constants, the slot holding them since they last changed, and the device's slots this submit fills */
  readonly push = new Uint8Array(PUSH_SIZE); pushSlot: PushSlot | null = null; pushed = 0;
  /** images handed to the foreign queue family, to give their pixels to their buffers once submitted */
  readonly released = new Set<Image>();
  readonly dev: Device;
  constructor(dev: Device) { this.dev = dev; this.enc = dev.gpu.createCommandEncoder(); }
  /** forgets what is set on the pass, for the next draw to set all it needs */
  forget(): void { this.passState = freshPass(); }
  /** ends the compute pass, if one is open, before an encoder-level command */
  outside(): GPUCommandEncoder { if (this.compute) { this.compute.end(); this.compute = null; } return this.enc; }
  /** finishes the encoder so a queue operation can come between it and what follows */
  cut(): void { this.outside(); this.done.push(this.enc.finish()); this.enc = this.dev.gpu.createCommandEncoder(); }
  finish(): GPUCommandBuffer[] { this.outside(); this.done.push(this.enc.finish()); return this.done; }
  /** an image taken from the foreign queue family with its contents: its buffer's pixels, uploaded before what follows */
  acquire(img: Image): void {
    if (!img.ahb) return;
    this.cut(); this.writePush(); this.dev.gpu.queue.submit(this.done.splice(0));
    take(this.dev, img);
  }
  /** a slot of the device's push buffers holding `bytes` (PUSH_SLOT at most) for what this submit runs */
  slot(bytes: Uint8Array): PushSlot {
    const n = this.pushed++, offset = n % PER_CHUNK * PUSH_SLOT;
    const chunk = this.dev.push[Math.floor(n / PER_CHUNK)] ??= {
      buffer: this.dev.gpu.createBuffer({ size: PER_CHUNK * PUSH_SLOT, usage: BU.STORAGE | BU.COPY_DST }), data: new Uint8Array(PER_CHUNK * PUSH_SLOT), groups: new BindGroupCache(),
    };
    chunk.data.set(bytes, offset);
    return { chunk, offset };
  }
  /** `words` as a binding of read-only storage, for the driver's own pipelines (internal.ts) */
  data(words: Uint32Array): GPUBufferBinding {
    const { chunk, offset } = this.slot(new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
    return { buffer: chunk.buffer, offset, size: words.byteLength };
  }
  /** writes the push constants' slots, before a queue submission of what uses them */
  writePush(): void {
    for (let i = 0; i * PER_CHUNK < this.pushed; i++) {
      const chunk = this.dev.push[i];
      this.dev.gpu.queue.writeBuffer(chunk.buffer, 0, chunk.data, 0, Math.min(PER_CHUNK, this.pushed - i * PER_CHUNK) * PUSH_SLOT);
    }
  }
}
const PER_CHUNK = 256;
/** the slot of the push constants as the commands so far set them, filled once after each change */
const pushSlot = (r: Replay): PushSlot => r.pushSlot ??= r.slot(r.push);
/** sets on the pass the bind groups `resources` need: of the descriptor sets bound, and of the push constants */
function bindGroups(r: Replay, pass: GPURenderPassEncoder | GPUComputePassEncoder, gpu: GPURenderPipeline | GPUComputePipeline, resources: Resource[], bound: (Bound | null)[]): void {
  const s = r.passState;
  for (const i of new Set(resources.map((res) => res.set))) {
    const push = resources.some((res) => res.set === i && res.kind === "push") ? pushSlot(r) : null;
    const g = bindGroup(r.dev, gpu, i, resources, bound[i] ?? null, push);
    if (s.groups[i] !== g) { pass.setBindGroup(i, g); s.groups[i] = g; }
  }
}

const bits = new DataView(new ArrayBuffer(4));
const f32 = (w: number) => { bits.setInt32(0, w, true); return bits.getFloat32(0, true); };
/** a VkClearColorValue's words as the format's channels read them */
function clearValue(f: TextureFormat, words: number[]): GPUColorDict {
  const [r, g, b, a] = words.map(f.gpu.endsWith("uint") ? (w) => w >>> 0 : f.gpu.endsWith("sint") ? (w) => w | 0 : f32);
  return { r, g, b, a };
}

function beginSubpass(r: Replay): void {
  const { pass, fb, subpass, clears } = r.rp!, sub = pass.subpasses[subpass];
  // an attachment loads as the pass says where the instance first uses it and stores where it last does
  const first = (ai: number) => pass.subpasses.findIndex((s) => s.colors.includes(ai) || s.depth === ai || s.resolves.includes(ai)) === subpass;
  const last = (ai: number) => pass.subpasses.findLastIndex((s) => s.colors.includes(ai) || s.depth === ai || s.resolves.includes(ai)) === subpass;
  const colorAttachments = sub.colors.map((ai, i): GPURenderPassColorAttachment | null => {
    if (ai === UNUSED) return null;
    const a = pass.attachments[ai], view = fb.views[ai], resolve = sub.resolves[i];
    const att: GPURenderPassColorAttachment = { view: view.gpu, loadOp: first(ai) ? a.load : "load", storeOp: last(ai) ? a.store : "store" };
    if (att.loadOp === "clear") att.clearValue = a.clear ? clearValue(view.image.format, clears[ai] ?? [0, 0, 0, 0]) : [0, 0, 0, 0];
    if (resolve !== undefined && resolve !== UNUSED) att.resolveTarget = fb.views[resolve].gpu;
    return att;
  });
  const desc: GPURenderPassDescriptor = { colorAttachments };
  if (sub.depth !== UNUSED) {
    const a = pass.attachments[sub.depth], view = fb.views[sub.depth], f = view.image.format, c = clears[sub.depth] ?? [0, 0];
    const ds: GPURenderPassDepthStencilAttachment = { view: view.gpu };
    if (f.depth) Object.assign(ds, { depthLoadOp: first(sub.depth) ? a.load : "load", depthStoreOp: last(sub.depth) ? a.store : "store", depthClearValue: a.clear ? f32(c[0]) : 0 });
    if (f.stencil) Object.assign(ds, { stencilLoadOp: first(sub.depth) ? a.stencilLoad : "load", stencilStoreOp: last(sub.depth) ? a.stencilStore : "store", stencilClearValue: a.stencilClear ? c[1] >>> 0 : 0 });
    desc.depthStencilAttachment = ds;
  }
  r.pass = r.outside().beginRenderPass(desc);
  r.passState = freshPass();
}

/** sets on the pass what the next draw needs and changed since the pass last had it */
function prepareDraw(r: Replay): GraphicsPipeline {
  const p = r.graphics, pass = r.pass, s = r.passState;
  if (!p || !pass) throw new Error("vulkan: a draw without a pipeline or render pass");
  // Vulkan's +Y is down a viewport of positive height and up one of negative height, as WebGPU's always is
  const vp = r.viewport, flip = !vp || vp.height > 0;
  const gpu = p.variant(flip, r.index?.format);
  if (s.pipeline !== gpu) { pass.setPipeline(gpu); s.pipeline = gpu; s.groups = []; }
  bindGroups(r, pass, gpu, p.resources, r.graphicsSets);
  (p.desc.vertex.buffers ?? []).forEach((layout, slot) => {
    const v = r.vertex[slot];
    if (!layout || !v) return;
    const set = s.vertex[slot];
    if (set?.buffer !== v.buffer.gpu || set.offset !== v.offset) { pass.setVertexBuffer(slot, v.buffer.gpu, v.offset); s.vertex[slot] = { buffer: v.buffer.gpu, offset: v.offset }; }
  });
  if (vp) {
    const key = `${vp.x},${vp.y},${vp.width},${vp.height},${vp.minDepth},${vp.maxDepth}`;
    if (s.viewport !== key) {
      if (vp.height < 0) pass.setViewport(vp.x, vp.y + vp.height, vp.width, -vp.height, vp.minDepth, vp.maxDepth);
      else pass.setViewport(vp.x, vp.y, vp.width, vp.height, vp.minDepth, vp.maxDepth);
      s.viewport = key;
    }
  }
  if (r.scissor) { const key = r.scissor.join(); if (s.scissor !== key) { pass.setScissorRect(r.scissor[0], r.scissor[1], r.scissor[2], r.scissor[3]); s.scissor = key; } }
  const blend = r.blend.join();
  if (s.blend !== blend) { pass.setBlendConstant(r.blend); s.blend = blend; }
  if (s.stencil !== r.stencil) { pass.setStencilReference(r.stencil); s.stencil = r.stencil; }
  return p;
}
function prepareDispatch(r: Replay): GPUComputePassEncoder {
  const p = r.computePipeline;
  if (!p) throw new Error("vulkan: a dispatch without a pipeline");
  if (r.pass) throw new Error("vulkan: a dispatch in a render pass");
  const pass = r.compute ??= (r.passState = freshPass(), r.enc.beginComputePass()), s = r.passState;
  if (s.pipeline !== p.gpu) { pass.setPipeline(p.gpu); s.pipeline = p.gpu; s.groups = []; }
  bindGroups(r, pass, p.gpu, p.resources, r.computeSets);
  return pass;
}

const BufferImageCopy = struct(`bufferOffset:u64 bufferRowLength:u32 bufferImageHeight:u32 aspectMask:u32 mipLevel:u32 baseArrayLayer:u32 layerCount:u32
  x:i32 y:i32 z:i32 width:u32 height:u32 depth:u32`);
const ImageCopy = struct(`srcAspect:u32 srcMip:u32 srcLayer:u32 srcLayers:u32 srcX:i32 srcY:i32 srcZ:i32 dstAspect:u32 dstMip:u32 dstLayer:u32 dstLayers:u32
  dstX:i32 dstY:i32 dstZ:i32 width:u32 height:u32 depth:u32`);
const BufferCopy = struct("srcOffset:u64 dstOffset:u64 size:u64");
const Range = struct("aspectMask:u32 baseMipLevel:u32 levelCount:u32 baseArrayLayer:u32 layerCount:u32");
const ImageBarrier = struct(`sType:u32 pNext:ptr srcAccessMask:u32 dstAccessMask:u32 oldLayout:u32 newLayout:u32 srcQueueFamilyIndex:u32 dstQueueFamilyIndex:u32
  image:u64 aspectMask:u32 baseMipLevel:u32 levelCount:u32 baseArrayLayer:u32 layerCount:u32`);
const BeginInfo = struct(`sType:u32 pNext:ptr renderPass:u64 framebuffer:u64 x:i32 y:i32 width:u32 height:u32 clearValueCount:u32 pClearValues:ptr`);
const ClearAttachment = struct("aspectMask:u32 colorAttachment:u32 value:u32[4]");
const ClearRect = struct("x:i32 y:i32 width:u32 height:u32 baseArrayLayer:u32 layerCount:u32");
const Subresource = struct("aspectMask:u32 mip:u32 layer:u32 layers:u32");
const ImageBlit = struct("src:struct srcOffsets:i32[6] dst:struct dstOffsets:i32[6]", { src: Subresource, dst: Subresource });
const ViewportS = struct("x:f32 y:f32 width:f32 height:f32 minDepth:f32 maxDepth:f32");
const AllocateInfo = struct("sType:u32 pNext:ptr commandPool:u64 level:u32 commandBufferCount:u32");

type BufferImageRegion = Read<typeof BufferImageCopy>;
/** the texture side of a buffer–image copy, and the buffer's layout of it */
function bufferImage(img: Image, c: BufferImageRegion, buffer: GPUBuffer) {
  const f = img.format, layered = !img.is3d;
  const rowTexels = c.bufferRowLength || c.width, rows = Math.ceil((c.bufferImageHeight || c.height) / f.bh);
  const bytesPerRow = Math.ceil(rowTexels / f.bw) * f.bytes;
  const texture: GPUTexelCopyTextureInfo = { texture: img.texture, mipLevel: c.mipLevel, origin: { x: c.x, y: c.y, z: layered ? c.baseArrayLayer : c.z }, aspect: img.aspect(c.aspectMask) };
  const size = { width: c.width, height: c.height, depthOrArrayLayers: layered ? c.layerCount : c.depth };
  return { texture, size, layout: { buffer, offset: c.bufferOffset, bytesPerRow, rowsPerImage: rows }, rowBytes: bytesPerRow, rows };
}
/** a buffer–image copy, row by row where the buffer's rows are not 256-byte aligned as WebGPU's must be */
function copyBufferImage(enc: GPUCommandEncoder, img: Image, c: BufferImageRegion, buffer: GPUBuffer, toImage: boolean): void {
  const { texture, size, layout, rowBytes, rows } = bufferImage(img, c, buffer);
  const copy = (l: GPUTexelCopyBufferInfo, t: GPUTexelCopyTextureInfo, s: GPUExtent3DDict) => toImage ? enc.copyBufferToTexture(l, t, s) : enc.copyTextureToBuffer(t, l, s);
  if (rowBytes % 256 === 0 || (size.height <= img.format.bh && size.depthOrArrayLayers === 1)) return copy(layout, texture, size);
  const o = texture.origin as GPUOrigin3DDict;
  for (let z = 0; z < size.depthOrArrayLayers; z++)
    for (let y = 0; y < Math.ceil(size.height / img.format.bh); y++)
      copy({ buffer, offset: layout.offset + (z * rows + y) * rowBytes }, { ...texture, origin: { x: o.x, y: o.y! + y * img.format.bh, z: o.z! + z } }, { width: size.width, height: Math.min(img.format.bh, size.height - y * img.format.bh), depthOrArrayLayers: 1 });
}
/** a buffer holding `bytes`, as a command reads it when it runs */
function staged(dev: Device, bytes: Uint8Array): GPUBuffer {
  const b = dev.gpu.createBuffer({ size: Math.ceil(bytes.length / 4) * 4, usage: BU.COPY_SRC, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(bytes);
  b.unmap();
  return b;
}
/** clears levels and layers of a renderable image with render passes, or zeroes others with copies of a zeroed buffer */
function clearImage(r: Replay, img: Image, range: Read<typeof Range>, color: GPUColorDict | null, depth: number, stencil: number): void {
  const f = img.format, { baseMipLevel, mipLevelCount, baseArrayLayer, arrayLayerCount } = img.range(range);
  const renderable = !img.is3d && img.renderable && !!(img.texture.usage & TU.RENDER_ATTACHMENT);
  const enc = r.outside();
  // what WebGPU cannot render to is copied from a buffer of the texel, laid out for the largest level
  let fill: { buffer: GPUBuffer; bytesPerRow: number; rows: number } | null = null;
  for (let l = baseMipLevel; l < baseMipLevel + mipLevelCount; l++) {
    for (let layer = baseArrayLayer; layer < baseArrayLayer + arrayLayerCount; layer++) {
      if (renderable) {
        const view = img.texture.createView({ dimension: "2d", baseMipLevel: l, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        if (color) enc.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: color }] }).end();
        else enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, ...(f.depth && range.aspectMask & 2 ? { depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: depth } : f.depth ? { depthLoadOp: "load", depthStoreOp: "store" } : {}), ...(f.stencil && range.aspectMask & 4 ? { stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: stencil } : f.stencil ? { stencilLoadOp: "load", stencilStoreOp: "store" } : {}) } }).end();
        continue;
      }
      fill ??= filled(r.dev, f, color && texel(f, color), img.extent(baseMipLevel));
      enc.copyBufferToTexture({ buffer: fill.buffer, bytesPerRow: fill.bytesPerRow, rowsPerImage: fill.rows }, { texture: img.texture, mipLevel: l, origin: { x: 0, y: 0, z: img.is3d ? 0 : layer } }, img.extent(l));
    }
  }
}
/** a buffer of `e`'s texels, each `t` (zero without one) */
function filled(dev: Device, f: TextureFormat, t: Uint8Array | null, e: Required<GPUExtent3DDict>): { buffer: GPUBuffer; bytesPerRow: number; rows: number } {
  const row = Math.ceil(e.width / f.bw) * f.bytes, bytesPerRow = Math.ceil(row / 256) * 256, rows = Math.ceil(e.height / f.bh);
  const zero = !t || t.every((b) => !b), buffer = dev.gpu.createBuffer({ size: bytesPerRow * rows * e.depthOrArrayLayers, usage: BU.COPY_SRC, mappedAtCreation: !zero });
  if (!zero) {
    const bytes = new Uint8Array(buffer.getMappedRange());
    for (let i = 0; i < row; i += t.length) bytes.set(t, i);
    for (let i = bytesPerRow; i < bytes.length; i *= 2) bytes.copyWithin(i, 0, Math.min(i, bytes.length - i));
    buffer.unmap();
  }
  return { buffer, bytesPerRow, rows };
}
const words = (p: number, n: number) => Array.from({ length: n }, (_, i) => mem.ld32(p + 4 * i));

export const COMMANDS: Record<string, HostFn> = {
  // a command pool is the set of its command buffers, to free and reset them with it
  vkCreateCommandPool: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), objects.add(new CommandPool())); return R.SUCCESS; },
  vkDestroyCommandPool: (_c, a) => { a.p(); const h = nd(a); for (const b of objects.find(h, CommandPool)?.buffers ?? []) objects.delete(b); objects.delete(h); },
  vkResetCommandPool: (_c, a) => { a.p(); for (const b of objects.get(nd(a), CommandPool).buffers) cbOf(b).reset(); return R.SUCCESS; },
  vkTrimCommandPool: () => {},
  vkAllocateCommandBuffers: (_c, a) => {
    const dev = objects.get(a.p(), Device), info = AllocateInfo.read(a.p()), out = a.p(), pool = objects.get(info.commandPool, CommandPool);
    for (let i = 0; i < info.commandBufferCount; i++) {
      const h = dispatchable(new CommandBuffer(dev));
      pool.buffers.add(h); stp(out + i * PTR, h);
    }
    return R.SUCCESS;
  },
  vkFreeCommandBuffers: (_c, a) => {
    a.p(); const pool = objects.get(nd(a), CommandPool), n = a.u(), p = a.p();
    for (let i = 0; i < n; i++) { const h = ldp(p + i * PTR); if (h) { pool.buffers.delete(h); objects.delete(h); } }
  },
  vkBeginCommandBuffer: (_c, a) => { cbOf(a.p()).reset(); return R.SUCCESS; },
  vkEndCommandBuffer: () => R.SUCCESS,
  vkResetCommandBuffer: (_c, a) => { cbOf(a.p()).reset(); return R.SUCCESS; },
  vkCmdExecuteCommands: (_c, a) => {
    const cb = cbOf(a.p()), n = a.u(), p = a.p();
    for (let i = 0; i < n; i++) {
      const s = cbOf(ldp(p + i * PTR));
      cb.ops.push(...s.ops);
      for (const b of s.host) cb.use(b, s.written.has(b));
    }
  },

  vkCmdPipelineBarrier: (_c, a) => {
    const h = a.p(); a.u(); a.u(); a.u(); a.u(); a.p(); a.u(); a.p(); const n = a.u(), p = a.p();
    for (const b of list(p, n, ImageBarrier.size(), (at) => ImageBarrier.read(at))) {
      if (foreign(b.dstQueueFamilyIndex) && !foreign(b.srcQueueFamilyIndex)) { const img = objects.get(b.image, Image); record(h, (r) => { r.released.add(img); }); }
      // contents survive an acquire even from VK_IMAGE_LAYOUT_UNDEFINED, as Android's drivers keep them and
      // Chrome, which always acquires from it (crbug.com/327111284), relies on
      else if (foreign(b.srcQueueFamilyIndex) && !foreign(b.dstQueueFamilyIndex)) { const img = objects.get(b.image, Image); record(h, (r) => r.acquire(img)); }
    }
  },
  vkCmdBeginRenderPass: (_c, a) => {
    const h = a.p(), info = BeginInfo.read(a.p());
    const pass = objects.get<RenderPass>(info.renderPass), fb = objects.get<Framebuffer>(info.framebuffer);
    const clears = list(info.pClearValues, info.clearValueCount, 16, (at) => words(at, 4));
    record(h, (r) => { r.rp = { pass, fb, subpass: 0, clears }; beginSubpass(r); });
  },
  vkCmdNextSubpass: (_c, a) => record(a.p(), (r) => { r.pass!.end(); r.rp!.subpass++; beginSubpass(r); }),
  vkCmdEndRenderPass: (_c, a) => record(a.p(), (r) => { r.pass!.end(); r.pass = null; r.rp = null; }),

  vkCmdBindPipeline: (_c, a) => {
    const h = a.p(), point = a.u(), p = nd(a);
    record(h, point === 1 ? (r) => { r.computePipeline = objects.get<ComputePipeline>(p); } : (r) => { r.graphics = objects.get(p, GraphicsPipeline); });
  },
  vkCmdBindDescriptorSets: (_c, a) => {
    const h = a.p(), point = a.u(); nd(a); const first = a.u(), n = a.u(), pSets = a.p(), nOffsets = a.u(), pOffsets = a.p();
    const sets = u64s(pSets, n).map((s) => objects.get(s, DescriptorSet)), offsets = words(pOffsets, nOffsets).map((o) => o >>> 0);
    record(h, (r) => {
      const bound = point === 1 ? r.computeSets : r.graphicsSets;
      let o = 0;
      sets.forEach((set, i) => { const k = set.layout.dynamic.length; bound[first + i] = { set, offsets: offsets.slice(o, o + k) }; o += k; });
    });
  },
  vkCmdPushConstants: (_c, a) => {
    const h = a.p(); nd(a); a.u(); const offset = a.u(), size = a.u(), bytes = mem.bytes(a.p(), size).slice();
    record(h, (r) => { r.push.set(bytes, offset); r.pushSlot = null; });
  },
  vkCmdBindVertexBuffers: (_c, a) => {
    const h = a.p(), first = a.u(), n = a.u(), buffers = u64s(a.p(), n), offsets = u64s(a.p(), n), cb = cbOf(h);
    const bound = buffers.map((b, i) => b ? { buffer: objects.get(b, Buffer), offset: offsets[i] } : null);
    for (const b of bound) if (b) cb.use(b.buffer);
    record(h, (r) => { bound.forEach((b, i) => { r.vertex[first + i] = b; }); });
  },
  vkCmdBindIndexBuffer: (_c, a) => {
    const h = a.p(), buffer = objects.get(nd(a), Buffer), offset = Number(a.ul()), type = a.u();
    cbOf(h).use(buffer);
    record(h, (r) => { r.index = { buffer, offset, format: type === 1 ? "uint32" : "uint16" }; });
  },
  vkCmdSetViewport: (_c, a) => {
    const h = a.p(), first = a.u(), n = a.u(), p = a.p();
    if (first !== 0 || n < 1) return;
    const v = ViewportS.read(p);
    record(h, (r) => { r.viewport = v; });
  },
  vkCmdSetScissor: (_c, a) => {
    const h = a.p(), first = a.u(), n = a.u(), p = a.p();
    if (first !== 0 || n < 1) return;
    const s = [mem.ld32(p), mem.ld32(p + 4), mem.ld32(p + 8) >>> 0, mem.ld32(p + 12) >>> 0];
    record(h, (r) => { r.scissor = s; });
  },
  vkCmdSetBlendConstants: (_c, a) => { const h = a.p(), p = a.p(), c = [0, 1, 2, 3].map((i) => mem.ldf32(p + 4 * i)); record(h, (r) => { r.blend = c; }); },
  vkCmdSetStencilReference: (_c, a) => { const h = a.p(); a.u(); const ref = a.u(); record(h, (r) => { r.stencil = ref; }); },
  // pipeline state WebGPU fixes, which the pipelines carry: line width 1, no depth bounds, stencil masks and depth bias
  vkCmdSetLineWidth: () => {}, vkCmdSetDepthBounds: () => {},
  vkCmdSetStencilCompareMask: () => {}, vkCmdSetStencilWriteMask: () => {}, vkCmdSetDepthBias: () => {},
  vkCmdSetDeviceMask: () => {},

  vkCmdDraw: (_c, a) => {
    const h = a.p(), vertices = a.u(), instances = a.u(), firstVertex = a.u(), firstInstance = a.u();
    record(h, (r) => { prepareDraw(r); r.pass!.draw(vertices, instances, firstVertex, firstInstance); });
  },
  vkCmdDrawIndexed: (_c, a) => {
    const h = a.p(), indices = a.u(), instances = a.u(), firstIndex = a.u(), vertexOffset = a.i(), firstInstance = a.u();
    record(h, (r) => { prepareDraw(r); const ix = r.index!; r.pass!.setIndexBuffer(ix.buffer.gpu, ix.format, ix.offset); r.pass!.drawIndexed(indices, instances, firstIndex, vertexOffset, firstInstance); });
  },
  vkCmdDrawIndirect: (_c, a) => {
    const h = a.p(), buffer = objects.get(nd(a), Buffer), offset = Number(a.ul()), n = a.u(), stride = a.u();
    cbOf(h).use(buffer);
    record(h, (r) => { prepareDraw(r); for (let i = 0; i < n; i++) r.pass!.drawIndirect(buffer.gpu, offset + i * stride); });
  },
  vkCmdDrawIndexedIndirect: (_c, a) => {
    const h = a.p(), buffer = objects.get(nd(a), Buffer), offset = Number(a.ul()), n = a.u(), stride = a.u();
    cbOf(h).use(buffer);
    record(h, (r) => { prepareDraw(r); const ix = r.index!; r.pass!.setIndexBuffer(ix.buffer.gpu, ix.format, ix.offset); for (let i = 0; i < n; i++) r.pass!.drawIndexedIndirect(buffer.gpu, offset + i * stride); });
  },
  vkCmdDispatch: (_c, a) => { const h = a.p(), x = a.u(), y = a.u(), z = a.u(); record(h, (r) => prepareDispatch(r).dispatchWorkgroups(x, y, z)); },
  vkCmdDispatchIndirect: (_c, a) => {
    const h = a.p(), buffer = objects.get(nd(a), Buffer), offset = Number(a.ul());
    cbOf(h).use(buffer);
    record(h, (r) => prepareDispatch(r).dispatchWorkgroupsIndirect(buffer.gpu, offset));
  },

  vkCmdCopyBuffer: (_c, a) => {
    const h = a.p(), src = objects.get(nd(a), Buffer), dst = objects.get(nd(a), Buffer), n = a.u(), regions = list(a.p(), n, BufferCopy.size(), (at) => BufferCopy.read(at)), cb = cbOf(h);
    cb.use(src); cb.use(dst, true);
    record(h, (r) => { for (const c of regions) copyBytes(r, src.gpu, c.srcOffset, dst.gpu, c.dstOffset, c.size); });
  },
  vkCmdCopyBufferToImage: (_c, a) => {
    const h = a.p(), src = objects.get(nd(a), Buffer), img = objects.get(nd(a), Image); a.u(); const n = a.u(), regions = list(a.p(), n, BufferImageCopy.size(), (at) => BufferImageCopy.read(at));
    cbOf(h).use(src);
    record(h, (r) => { const enc = r.outside(); for (const c of regions) copyBufferImage(enc, img, c, src.gpu, true); });
  },
  vkCmdCopyImageToBuffer: (_c, a) => {
    const h = a.p(), img = objects.get(nd(a), Image); a.u(); const dst = objects.get(nd(a), Buffer), n = a.u(), regions = list(a.p(), n, BufferImageCopy.size(), (at) => BufferImageCopy.read(at));
    cbOf(h).use(dst, true);
    record(h, (r) => { const enc = r.outside(); for (const c of regions) copyBufferImage(enc, img, c, dst.gpu, false); });
  },
  vkCmdCopyImage: (_c, a) => {
    const h = a.p(), src = objects.get(nd(a), Image); a.u(); const dst = objects.get(nd(a), Image); a.u(); const n = a.u(), regions = list(a.p(), n, ImageCopy.size(), (at) => ImageCopy.read(at));
    record(h, (r) => {
      const enc = r.outside();
      for (const c of regions) {
        enc.copyTextureToTexture(
          { texture: src.texture, mipLevel: c.srcMip, origin: { x: c.srcX, y: c.srcY, z: src.is3d ? c.srcZ : c.srcLayer }, aspect: src.aspect(c.srcAspect) },
          { texture: dst.texture, mipLevel: c.dstMip, origin: { x: c.dstX, y: c.dstY, z: dst.is3d ? c.dstZ : c.dstLayer }, aspect: dst.aspect(c.dstAspect) },
          { width: c.width, height: c.height, depthOrArrayLayers: src.is3d ? c.depth : c.srcLayers });
      }
    });
  },
  vkCmdUpdateBuffer: (_c, a) => {
    const h = a.p(), dst = objects.get(nd(a), Buffer), offset = Number(a.ul()), size = Number(a.ul()), bytes = mem.bytes(a.p(), size).slice();
    cbOf(h).use(dst, true);
    record(h, (r) => { const src = staged(r.dev, bytes); r.outside().copyBufferToBuffer(src, 0, dst.gpu, offset, size); });
  },
  vkCmdFillBuffer: (_c, a) => {
    const h = a.p(), dst = objects.get(nd(a), Buffer), offset = Number(a.ul()), sizeArg = Number(a.ul()), data = a.u();
    const size = sizeArg === WHOLE ? (dst.size - offset) & ~3 : sizeArg;
    cbOf(h).use(dst, true);
    record(h, (r) => {
      const enc = r.outside();
      if (data === 0) return enc.clearBuffer(dst.gpu, offset, size);
      const fill = new Uint32Array(size / 4).fill(data);
      enc.copyBufferToBuffer(staged(r.dev, new Uint8Array(fill.buffer)), 0, dst.gpu, offset, size);
    });
  },
  vkCmdClearAttachments: (_c, a) => {
    const h = a.p(), n = a.u(), p = a.p(), m = a.u(), q = a.p();
    const clears = list(p, n, ClearAttachment.size(), (at) => ({ ...ClearAttachment.read(at), words: new Uint32Array(ClearAttachment.array(at, "value")) }));
    const rects = list(q, m, ClearRect.size(), (at) => ClearRect.read(at));
    record(h, (r) => clearAttachments(r, clears, rects));
  },
  vkCmdBlitImage: (_c, a) => {
    const h = a.p(), src = objects.get(nd(a), Image); a.u(); const dst = objects.get(nd(a), Image); a.u(); const n = a.u(), p = a.p(), linear = a.u() === 1;
    const regions = list(p, n, ImageBlit.size(), (at) => {
      const b = ImageBlit.read(at), side = (s: Read<typeof Subresource>, [x0, y0, , x1, y1]: number[]) => ({ ...s, x0, y0, x1, y1 });
      return [side(b.src, ImageBlit.array(at, "srcOffsets")), side(b.dst, ImageBlit.array(at, "dstOffsets"))];
    });
    record(h, (r) => { for (const [s, d] of regions) blit(r, src, s, dst, d, linear); });
  },
  vkCmdClearColorImage: (_c, a) => {
    const h = a.p(), img = objects.get(nd(a), Image); a.u(); const color = words(a.p(), 4), n = a.u(), ranges = list(a.p(), n, Range.size(), (at) => Range.read(at));
    record(h, (r) => { for (const range of ranges) clearImage(r, img, range, clearValue(img.format, color), 0, 0); });
  },
  vkCmdClearDepthStencilImage: (_c, a) => {
    const h = a.p(), img = objects.get(nd(a), Image); a.u(); const p = a.p(), depth = mem.ldf32(p), stencil = mem.ld32(p + 4) >>> 0, n = a.u(), ranges = list(a.p(), n, Range.size(), (at) => Range.read(at));
    record(h, (r) => { for (const range of ranges) clearImage(r, img, range, null, depth, stencil); });
  },
  vkCmdResolveImage: (_c, a) => {
    const h = a.p(), src = objects.get(nd(a), Image); a.u(); const dst = objects.get(nd(a), Image); a.u(); const n = a.u(), regions = list(a.p(), n, ImageCopy.size(), (at) => ImageCopy.read(at));
    record(h, (r) => {
      for (const c of regions) r.outside().beginRenderPass({ colorAttachments: [{
        view: src.texture.createView({ dimension: "2d", baseMipLevel: c.srcMip, mipLevelCount: 1, baseArrayLayer: c.srcLayer, arrayLayerCount: 1 }), loadOp: "load", storeOp: "store",
        resolveTarget: dst.texture.createView({ dimension: "2d", baseMipLevel: c.dstMip, mipLevelCount: 1, baseArrayLayer: c.dstLayer, arrayLayerCount: 1 }),
      }] }).end();
    });
  },
};
