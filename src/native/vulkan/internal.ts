// The commands WebGPU has no counterpart of, carried out with the driver's own pipelines: clears of
// attachment rectangles, scaled blits and buffer copies at any byte offset. The draws cover their
// viewport with one triangle and read their parameters from a slot of the device's push buffers.

import { UNUSED } from "./vk.ts";
import { BU, type Image } from "./device.ts";
import { F, formatFeatures } from "./formats.ts";
import type { Replay } from "./commands.ts";

const made = new WeakMap<GPUDevice, Map<string, GPURenderPipeline | GPUComputePipeline>>();
function cached<P extends GPURenderPipeline | GPUComputePipeline>(gpu: GPUDevice, key: string, make: () => P): P {
  let byKey = made.get(gpu);
  if (!byKey) made.set(gpu, byKey = new Map());
  let p = byKey.get(key);
  if (!p) byKey.set(key, p = make());
  return p as P;
}
const TRIANGLE = `fn corner(i: u32) -> vec4f { return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0); }`;
const channel = (format: GPUTextureFormat) => format.endsWith("uint") ? "u32" : format.endsWith("sint") ? "i32" : "f32";

/** a render pass's attachment formats, as a pipeline drawn in it must name them */
interface PassFormats { colors: (GPUTextureFormat | null)[]; depth: GPUTextureFormat | null; samples: number }
/** a pipeline that writes, over the viewport it draws, color target `target` (-1 for none) with the words group 0 holds as
 *  the target's channels, the viewport's depth where `depth`, and the stencil reference where `stencil` */
function clearPipeline(gpu: GPUDevice, f: PassFormats, target: number, depth: boolean, stencil: boolean): GPURenderPipeline {
  return cached(gpu, `clear|${f.colors}|${f.depth}|${f.samples}|${target}|${depth}|${stencil}`, () => {
    const c = target >= 0 ? channel(f.colors[target]!) : "";
    const module = gpu.createShaderModule({ code: `${TRIANGLE}
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return corner(i); }
      ${c ? `@group(0) @binding(0) var<storage, read> color: vec4u;
      @fragment fn fs() -> @location(${target}) vec4<${c}> { return bitcast<vec4<${c}>>(color); }` : "@fragment fn fs() {}"}` });
    const face: GPUStencilFaceState = stencil ? { compare: "always", passOp: "replace" } : {};
    return gpu.createRenderPipeline({
      layout: "auto", primitive: { topology: "triangle-list" }, multisample: { count: f.samples },
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: f.colors.map((format, k) => format && { format, writeMask: k === target ? 0xf : 0 }) },
      depthStencil: f.depth ? { format: f.depth, depthWriteEnabled: depth, depthCompare: "always", stencilFront: face, stencilBack: face, stencilWriteMask: stencil ? 0xff : 0 } : undefined,
    });
  });
}
export interface Clear { aspectMask: number; colorAttachment: number; words: Uint32Array }
export interface Rect { x: number; y: number; width: number; height: number }
/** vkCmdClearAttachments in the render pass in progress: the color words as the attachment's channels read them, the depth as
 *  its viewport's and the stencil as the reference */
export function clearAttachments(r: Replay, clears: Clear[], rects: Rect[]): void {
  const pass = r.pass!, { pass: rp, fb, subpass } = r.rp!, sub = rp.subpasses[subpass], gpu = r.dev.gpu;
  const view = (ai: number) => ai === UNUSED ? null : fb.views[ai];
  const formats: PassFormats = {
    colors: sub.colors.map((ai) => view(ai)?.desc.format ?? null), depth: view(sub.depth)?.desc.format ?? null,
    samples: [...sub.colors, sub.depth].map(view).find((v) => v)?.image.desc.sampleCount ?? 1,
  };
  for (const c of clears) {
    const color = c.aspectMask & 1 ? c.colorAttachment : -1, depth = !!(c.aspectMask & 2), stencil = !!(c.aspectMask & 4);
    if (color >= 0 ? !formats.colors[color] : !formats.depth) continue;
    const pipeline = clearPipeline(gpu, formats, color, depth, stencil);
    pass.setPipeline(pipeline);
    if (color >= 0) pass.setBindGroup(0, gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: r.data(c.words) }] }));
    if (stencil) pass.setStencilReference(c.words[1]);
    const z = Math.min(1, Math.max(0, new Float32Array(c.words.buffer, c.words.byteOffset, 1)[0] || 0));
    for (const { x, y, width, height } of rects) {
      pass.setViewport(x, y, width, height, z, z);
      pass.setScissorRect(x, y, width, height);
      pass.draw(3);
    }
  }
  // what the draws after rely on: the whole framebuffer where no viewport or scissor is set, and everything else set anew
  pass.setViewport(0, 0, fb.width, fb.height, 0, 1);
  pass.setScissorRect(0, 0, fb.width, fb.height);
  r.forget();
}

/** GPUShaderStage */
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
/** a pipeline that samples a 2D view (group 0: the view, a sampler and the source rectangle's corners in texture coordinates)
 *  over the viewport it draws */
function blitPipeline(gpu: GPUDevice, format: GPUTextureFormat, filterable: boolean): GPURenderPipeline {
  return cached(gpu, `blit|${format}|${filterable}`, () => {
    const module = gpu.createShaderModule({ code: `${TRIANGLE}
      @group(0) @binding(0) var t: texture_2d<f32>;
      @group(0) @binding(1) var s: sampler;
      @group(0) @binding(2) var<storage, read> rect: vec4f;
      struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f }
      @vertex fn vs(@builtin(vertex_index) i: u32) -> V { let c = corner(i); return V(c, mix(rect.xy, rect.zw, vec2f(c.x, -c.y) * 0.5 + 0.5)); }
      @fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleLevel(t, s, v.uv, 0.0); }` });
    const layout = gpu.createBindGroupLayout({ entries: [
      { binding: 0, visibility: STAGE.FRAGMENT, texture: { sampleType: filterable ? "float" : "unfilterable-float" } },
      { binding: 1, visibility: STAGE.FRAGMENT, sampler: { type: filterable ? "filtering" : "non-filtering" } },
      { binding: 2, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" } },
    ] });
    return gpu.createRenderPipeline({
      layout: gpu.createPipelineLayout({ bindGroupLayouts: [layout] }), primitive: { topology: "triangle-list" },
      vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] },
    });
  });
}
const samplers = new WeakMap<GPUDevice, GPUSampler[]>();
const samplerOf = (gpu: GPUDevice, linear: boolean) => {
  let s = samplers.get(gpu);
  if (!s) samplers.set(gpu, s = [gpu.createSampler(), gpu.createSampler({ magFilter: "linear", minFilter: "linear" })]);
  return s[+linear];
};
export interface Blit { mip: number; layer: number; layers: number; x0: number; y0: number; x1: number; y1: number }
/** vkCmdBlitImage's region: a copy where it scales nothing between images of one format, else a draw sampling the source */
export function blit(r: Replay, src: Image, s: Blit, dst: Image, d: Blit, linear: boolean): void {
  const enc = r.outside(), gpu = r.dev.gpu, sw = s.x1 - s.x0, sh = s.y1 - s.y0, dw = d.x1 - d.x0, dh = d.y1 - d.y0;
  const copy = sw === dw && sh === dh && sw > 0 && sh > 0 && src.format.gpu === dst.format.gpu;
  if (!copy && (src.is3d || dst.is3d || channel(src.format.gpu) !== "f32" || src.format.depth || src.format.stencil)) throw new Error(`vulkan: a scaled blit of ${src.format.gpu}`);
  const { width, height } = src.extent(s.mip), filterable = !!(formatFeatures(src.vk, r.dev.physical.features).optimal & F.LINEAR);
  for (let l = 0; l < s.layers; l++) {
    if (copy) {
      enc.copyTextureToTexture({ texture: src.texture, mipLevel: s.mip, origin: { x: s.x0, y: s.y0, z: s.layer + l } },
        { texture: dst.texture, mipLevel: d.mip, origin: { x: d.x0, y: d.y0, z: d.layer + l } }, { width: sw, height: sh });
      continue;
    }
    // the corners in the destination's order: a flip is a rectangle drawn the other way round
    const rect = new Float32Array([(dw < 0 ? s.x1 : s.x0) / width, (dh < 0 ? s.y1 : s.y0) / height, (dw < 0 ? s.x0 : s.x1) / width, (dh < 0 ? s.y0 : s.y1) / height]);
    const pipeline = blitPipeline(gpu, dst.format.gpu, filterable), single = (mip: number, layer: number) => ({ dimension: "2d", baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }) as const;
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.texture.createView(single(d.mip, d.layer + l)), loadOp: "load", storeOp: "store" }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.texture.createView(single(s.mip, s.layer + l)) }, { binding: 1, resource: samplerOf(gpu, linear && filterable) },
      { binding: 2, resource: r.data(new Uint32Array(rect.buffer)) },
    ] }));
    pass.setViewport(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(dw), Math.abs(dh), 0, 1);
    pass.draw(3);
    pass.end();
  }
}

/** a compute pipeline that merges bytes of a staged copy of the source's whole words (binding 0) into the destination's words
 *  (binding 1), each invocation one word; binding 2 holds the bytes' offsets in each and their count */
function copyPipeline(gpu: GPUDevice): GPUComputePipeline {
  return cached(gpu, "copy", () => gpu.createComputePipeline({ layout: "auto", compute: { entryPoint: "main", module: gpu.createShaderModule({ code: `
    struct P { src: u32, dst: u32, size: u32 }
    @group(0) @binding(0) var<storage, read> s: array<u32>;
    @group(0) @binding(1) var<storage, read_write> d: array<u32>;
    @group(0) @binding(2) var<storage, read> p: P;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
      let w = (p.dst >> 2u) + g.x;
      if (w * 4u >= p.dst + p.size) { return; }
      var v = d[w];
      for (var k = 0u; k < 4u; k++) {
        let at = w * 4u + k;
        if (at < p.dst || at >= p.dst + p.size) { continue; }
        let i = p.src + at - p.dst;
        v = (v & ~(0xffu << (8u * k))) | (((s[i >> 2u] >> (8u * (i & 3u))) & 0xffu) << (8u * k));
      }
      d[w] = v;
    }` }) } }));
}
/** copies `size` bytes between buffers at any offsets, through copyPipeline where WebGPU's 4-byte alignment does not hold */
export function copyBytes(r: Replay, src: GPUBuffer, so: number, dst: GPUBuffer, d: number, size: number): void {
  const enc = r.outside(), gpu = r.dev.gpu;
  if (!((so | d | size) & 3)) return enc.copyBufferToBuffer(src, so, dst, d, size);
  // the destination is bound from its storage offset alignment below the copy, to the copy's last word
  const from = so & ~3, words = ((so + size + 3) & ~3) - from, base = d & ~255, end = (d + size + 3) & ~3;
  const staging = gpu.createBuffer({ size: words, usage: BU.STORAGE | BU.COPY_DST });
  enc.copyBufferToBuffer(src, from, staging, 0, words);
  const pipeline = copyPipeline(gpu), pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, gpu.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: staging } },
    { binding: 1, resource: { buffer: dst, offset: base, size: end - base } }, { binding: 2, resource: r.data(new Uint32Array([so - from, d - base, size])) }] }));
  pass.dispatchWorkgroups(Math.ceil((end - (d & ~3)) / 256));
  pass.end();
}
