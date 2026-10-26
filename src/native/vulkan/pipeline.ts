// Shader modules, descriptor sets and their layouts, render passes, framebuffers and pipelines. A
// pipeline's WGSL is its SPIR-V translated (spirv.ts), and its bind group layouts are the ones WebGPU
// derives from that WGSL, so a bind group is made for a pipeline from a descriptor set when a draw or
// dispatch first uses that set's contents with it. A Vulkan binding b is WGSL binding 2b, and the
// sampler of a combined image sampler is 2b + 1. Push constants take the group after the layout's
// sets, or share the last group with the last set when the layout has as many sets as WebGPU groups.

import { mem } from "../mem.ts";
import { PTR, stp, type HostFn } from "../host.ts";
import { struct, list, u64s, stU64, WHOLE } from "../struct.ts";
import { textureFormat, vertexFormat } from "./formats.ts";
import { handle, object, maybe, release } from "./handles.ts";
import { R } from "./instance.ts";
import { deviceOf, nd, type Buffer, type View, type Device } from "./device.ts";
import { translate, PUSH_BINDING, type Stage, type Translation, type Resource } from "./spirv.ts";

export const DESCRIPTOR = { SAMPLER: 0, COMBINED: 1, SAMPLED_IMAGE: 2, STORAGE_IMAGE: 3, UNIFORM_TEXEL: 4, STORAGE_TEXEL: 5, UNIFORM: 6, STORAGE: 7, UNIFORM_DYNAMIC: 8, STORAGE_DYNAMIC: 9, INPUT_ATTACHMENT: 10 } as const;

export interface SetLayoutBinding { type: number; count: number; samplers: GPUSampler[] }
export class SetLayout {
  readonly bindings: Map<number, SetLayoutBinding>;
  /** the dynamic buffer bindings in the order their offsets are given: binding, then array element */
  readonly dynamic: number[];
  constructor(bindings: Map<number, SetLayoutBinding>) {
    this.bindings = bindings;
    this.dynamic = [...bindings].filter(([, b]) => b.type === DESCRIPTOR.UNIFORM_DYNAMIC || b.type === DESCRIPTOR.STORAGE_DYNAMIC)
      .sort(([a], [b]) => a - b).flatMap(([n, b]) => Array<number>(b.count).fill(n));
  }
}
export type Descriptor =
  | { kind: "buffer"; buffer: Buffer; offset: number; range: number }
  | { kind: "image"; view: View | null; sampler: GPUSampler | null };
export class DescriptorSet {
  /** the bind groups made from these contents, by the layout each was made for, then by dynamic offsets */
  groups = new WeakMap<GPUBindGroupLayout, Map<string, GPUBindGroup>>();
  readonly slots = new Map<number, Descriptor[]>();
  readonly layout: SetLayout;
  constructor(layout: SetLayout) {
    this.layout = layout;
    for (const [n, b] of layout.bindings) this.slots.set(n, Array.from({ length: b.count }, () => ({ kind: "image", view: null, sampler: b.samplers[0] ?? null })));
  }
  changed(): void { this.groups = new WeakMap(); }
}
interface Pool { sets: Set<number> }
/** its sets' layouts, and the group of its push constants (-1 without any) */
export interface PipelineLayout { sets: SetLayout[]; push: number }
/** a buffer the device keeps for push constants, PUSH_SLOT bytes a slot, each draw's or dispatch's in a slot of its own;
 *  `data` holds what a submit writes to it */
export interface PushChunk { buffer: GPUBuffer; data: Uint8Array; groups: WeakMap<GPUBindGroupLayout, Map<string, GPUBindGroup>> }
export interface PushSlot { chunk: PushChunk; offset: number }
/** maxPushConstantsSize, and the slot it takes at minStorageBufferOffsetAlignment's largest */
export const PUSH_SIZE = 128, PUSH_SLOT = 256;

export interface Attachment { format: number; samples: number; load: GPULoadOp; store: GPUStoreOp; stencilLoad: GPULoadOp; stencilStore: GPUStoreOp; clear: boolean; stencilClear: boolean }
export interface Subpass { colors: number[]; resolves: number[]; depth: number }
export interface RenderPass { attachments: Attachment[]; subpasses: Subpass[] }
export interface Framebuffer { views: View[]; width: number; height: number }

/** a graphics pipeline's GPURenderPipelines: one per vertex Y direction and strip index format a draw needs */
export class GraphicsPipeline {
  private readonly variants = new Map<string, GPURenderPipeline>();
  readonly dev: Device;
  readonly desc: GPURenderPipelineDescriptor;
  readonly resources: Resource[];
  readonly layout: PipelineLayout;
  readonly strip: boolean;
  constructor(dev: Device, desc: GPURenderPipelineDescriptor, resources: Resource[], layout: PipelineLayout, strip: boolean) {
    this.dev = dev; this.desc = desc; this.resources = resources; this.layout = layout; this.strip = strip;
  }
  variant(flipY: boolean, index: GPUIndexFormat | undefined): GPURenderPipeline {
    const key = `${flipY}${this.strip ? index ?? "" : ""}`;
    let p = this.variants.get(key);
    if (!p) {
      const desc = { ...this.desc, vertex: { ...this.desc.vertex, constants: { webdroid_flip_y: flipY ? 1 : 0 } }, primitive: { ...this.desc.primitive, stripIndexFormat: this.strip ? index : undefined } };
      this.variants.set(key, p = this.dev.gpu.createRenderPipeline(desc));
    }
    return p;
  }
}
export interface ComputePipeline { gpu: GPUComputePipeline; resources: Resource[]; layout: PipelineLayout }

/** the bind group of `set` and push constants `push` for group `index` of `pipeline`, holding the resources its shaders use */
export function bindGroup(dev: Device, pipeline: GPURenderPipeline | GPUComputePipeline, index: number, resources: Resource[], set: DescriptorSet | null, offsets: number[], push: PushSlot | null): GPUBindGroup {
  const layout = pipeline.getBindGroupLayout(index), owner = set ?? push!.chunk;
  const key = push ? `${offsets.join(",")}|${dev.push.indexOf(push.chunk)}:${push.offset}` : offsets.join(",");
  let byOffsets = owner.groups.get(layout);
  if (!byOffsets) owner.groups.set(layout, byOffsets = new Map());
  let group = byOffsets.get(key);
  if (group) return group;
  const entries: GPUBindGroupEntry[] = [];
  for (const r of resources) {
    if (r.set !== index) continue;
    if (r.kind === "push") { entries.push({ binding: PUSH_BINDING, resource: { buffer: push!.chunk.buffer, offset: push!.offset, size: PUSH_SIZE } }); continue; }
    const d = set?.slots.get(r.binding)?.[0];
    if (!d) throw new Error(`vulkan: set ${index} has no binding ${r.binding}`);
    if (d.kind === "buffer") {
      const dyn = set!.layout.dynamic.indexOf(r.binding), offset = d.offset + (dyn >= 0 ? offsets[dyn] ?? 0 : 0);
      entries.push({ binding: 2 * r.binding, resource: { buffer: d.buffer.gpu, offset, size: d.range === WHOLE ? d.buffer.size - d.offset : d.range } });
    } else {
      if (r.kind !== "sampler") entries.push({ binding: 2 * r.binding, resource: d.view!.gpu });
      if (r.kind === "sampler") entries.push({ binding: 2 * r.binding, resource: d.sampler! });
      else if (r.kind === "combined") entries.push({ binding: 2 * r.binding + 1, resource: d.sampler! });
    }
  }
  byOffsets.set(key, group = dev.gpu.createBindGroup({ layout, entries }));
  return group;
}

const ShaderModuleInfo = struct("sType:u32 pNext:ptr flags:u32 codeSize:size pCode:ptr");
const SetLayoutInfo = struct("sType:u32 pNext:ptr flags:u32 bindingCount:u32 pBindings:ptr");
const SetLayoutBindingS = struct("binding:u32 descriptorType:u32 descriptorCount:u32 stageFlags:u32 pImmutableSamplers:ptr");
const LayoutInfo = struct("sType:u32 pNext:ptr flags:u32 setLayoutCount:u32 pSetLayouts:ptr pushConstantRangeCount:u32 pPushConstantRanges:ptr");
const SetAllocateInfo = struct("sType:u32 pNext:ptr descriptorPool:u64 descriptorSetCount:u32 pSetLayouts:ptr");
const WriteSet = struct("sType:u32 pNext:ptr dstSet:u64 dstBinding:u32 dstArrayElement:u32 descriptorCount:u32 descriptorType:u32 pImageInfo:ptr pBufferInfo:ptr pTexelBufferView:ptr");
const ImageInfo = struct("sampler:u64 imageView:u64 imageLayout:u32");
const BufferInfo = struct("buffer:u64 offset:u64 range:u64");
const CopySet = struct("sType:u32 pNext:ptr srcSet:u64 srcBinding:u32 srcArrayElement:u32 dstSet:u64 dstBinding:u32 dstArrayElement:u32 descriptorCount:u32");
const RenderPassInfo = struct("sType:u32 pNext:ptr flags:u32 attachmentCount:u32 pAttachments:ptr subpassCount:u32 pSubpasses:ptr dependencyCount:u32 pDependencies:ptr");
const AttachmentS = struct("flags:u32 format:u32 samples:u32 loadOp:u32 storeOp:u32 stencilLoadOp:u32 stencilStoreOp:u32 initialLayout:u32 finalLayout:u32");
const SubpassS = struct("flags:u32 bindPoint:u32 inputs:u32 pInputs:ptr colors:u32 pColors:ptr pResolves:ptr pDepth:ptr preserves:u32 pPreserves:ptr");
const RenderPassInfo2 = struct("sType:u32 pNext:ptr flags:u32 attachmentCount:u32 pAttachments:ptr subpassCount:u32 pSubpasses:ptr dependencyCount:u32 pDependencies:ptr correlatedViewMaskCount:u32 pCorrelatedViewMasks:ptr");
const Attachment2 = struct("sType:u32 pNext:ptr flags:u32 format:u32 samples:u32 loadOp:u32 storeOp:u32 stencilLoadOp:u32 stencilStoreOp:u32 initialLayout:u32 finalLayout:u32");
const Subpass2 = struct("sType:u32 pNext:ptr flags:u32 bindPoint:u32 viewMask:u32 inputs:u32 pInputs:ptr colors:u32 pColors:ptr pResolves:ptr pDepth:ptr preserves:u32 pPreserves:ptr");
const Reference2 = struct("sType:u32 pNext:ptr attachment:u32 layout:u32 aspectMask:u32");
const FramebufferInfo = struct("sType:u32 pNext:ptr flags:u32 renderPass:u64 attachmentCount:u32 pAttachments:ptr width:u32 height:u32 layers:u32");
const GraphicsInfo = struct(`sType:u32 pNext:ptr flags:u32 stageCount:u32 pStages:ptr pVertexInputState:ptr pInputAssemblyState:ptr pTessellationState:ptr
  pViewportState:ptr pRasterizationState:ptr pMultisampleState:ptr pDepthStencilState:ptr pColorBlendState:ptr pDynamicState:ptr layout:u64 renderPass:u64
  subpass:u32 basePipelineHandle:u64 basePipelineIndex:i32`);
const StageInfo = struct("sType:u32 pNext:ptr flags:u32 stage:u32 module:u64 pName:ptr pSpecializationInfo:ptr");
const ComputeInfo = struct("sType:u32 pNext:ptr flags:u32 stage:u64[0] stage_sType:u32 stage_pNext:ptr stage_flags:u32 stage_stage:u32 stage_module:u64 stage_pName:ptr stage_pSpecializationInfo:ptr layout:u64 basePipelineHandle:u64 basePipelineIndex:i32");
const SpecInfo = struct("mapEntryCount:u32 pMapEntries:ptr dataSize:size pData:ptr");
const SpecEntry = struct("constantID:u32 offset:u32 size:size");
const VertexInput = struct("sType:u32 pNext:ptr flags:u32 bindings:u32 pBindings:ptr attributes:u32 pAttributes:ptr");
const VertexBinding = struct("binding:u32 stride:u32 inputRate:u32");
const VertexAttribute = struct("location:u32 binding:u32 format:u32 offset:u32");
const InputAssembly = struct("sType:u32 pNext:ptr flags:u32 topology:u32 primitiveRestartEnable:u32");
const Rasterization = struct(`sType:u32 pNext:ptr flags:u32 depthClampEnable:u32 rasterizerDiscardEnable:u32 polygonMode:u32 cullMode:u32 frontFace:u32
  depthBiasEnable:u32 depthBiasConstantFactor:f32 depthBiasClamp:f32 depthBiasSlopeFactor:f32 lineWidth:f32`);
const Multisample = struct("sType:u32 pNext:ptr flags:u32 rasterizationSamples:u32 sampleShadingEnable:u32 minSampleShading:f32 pSampleMask:ptr alphaToCoverageEnable:u32 alphaToOneEnable:u32");
const DepthStencil = struct(`sType:u32 pNext:ptr flags:u32 depthTestEnable:u32 depthWriteEnable:u32 depthCompareOp:u32 depthBoundsTestEnable:u32 stencilTestEnable:u32
  front_failOp:u32 front_passOp:u32 front_depthFailOp:u32 front_compareOp:u32 front_compareMask:u32 front_writeMask:u32 front_reference:u32
  back_failOp:u32 back_passOp:u32 back_depthFailOp:u32 back_compareOp:u32 back_compareMask:u32 back_writeMask:u32 back_reference:u32 minDepthBounds:f32 maxDepthBounds:f32`);
const ColorBlend = struct("sType:u32 pNext:ptr flags:u32 logicOpEnable:u32 logicOp:u32 attachmentCount:u32 pAttachments:ptr blendConstants:f32[4]");
const BlendAttachment = struct("blendEnable:u32 srcColor:u32 dstColor:u32 colorOp:u32 srcAlpha:u32 dstAlpha:u32 alphaOp:u32 colorWriteMask:u32");

const LOAD: GPULoadOp[] = ["load", "clear", "clear"];
const store = (op: number): GPUStoreOp => op === 1 ? "discard" : "store";
const STAGES: [number, Stage][] = [[0x1, "vertex"], [0x10, "fragment"], [0x20, "compute"]];
export const COMPARE: GPUCompareFunction[] = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
const STENCIL_OP: GPUStencilOperation[] = ["keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
const TOPOLOGY: (GPUPrimitiveTopology | undefined)[] = ["point-list", "line-list", "line-strip", "triangle-list", "triangle-strip"];
// the dual-source factors are dual-source-blending's, which the DOM types predate
const BLEND_FACTOR = ["zero", "one", "src", "one-minus-src", "dst", "one-minus-dst", "src-alpha", "one-minus-src-alpha", "dst-alpha",
  "one-minus-dst-alpha", "constant", "one-minus-constant", "constant", "one-minus-constant", "src-alpha-saturated", "src1", "one-minus-src1", "src1-alpha", "one-minus-src1-alpha"] as GPUBlendFactor[];
const BLEND_OP: GPUBlendOperation[] = ["add", "subtract", "reverse-subtract", "min", "max"];

function attachmentOf(a: Record<string, number>): Attachment {
  return { format: a.format, samples: a.samples, load: LOAD[a.loadOp] ?? "load", store: store(a.storeOp), stencilLoad: LOAD[a.stencilLoadOp] ?? "load", stencilStore: store(a.stencilStoreOp), clear: a.loadOp === 1, stencilClear: a.stencilLoadOp === 1 };
}
const UNUSED = 0xffffffff;
/** the specialization constants of a stage, by constant ID: their bits as 32-bit words, or 64-bit pairs */
function specialization(p: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (!p) return out;
  const s = SpecInfo.read(p);
  for (const e of list(s.pMapEntries, s.mapEntryCount, SpecEntry.size(), (at) => SpecEntry.read(at)))
    out.set(e.constantID, e.size === 8 ? [mem.ld32(s.pData + e.offset), mem.ld32(s.pData + e.offset + 4)] : e.size === 1 ? [mem.ld8u(s.pData + e.offset)] : [mem.ld32(s.pData + e.offset)]);
  return out;
}
function stageOf(info: Record<string, number>, layout: PipelineLayout): { stage: Stage; t: Translation; module: GPUShaderModule } {
  const stage = STAGES.find(([bit]) => bit === info.stage)?.[1];
  if (!stage) throw new Error(`vulkan: stage 0x${info.stage.toString(16)}`);
  const sm = object<ShaderModule>(info.module), t = sm.translation(mem.cstr(info.pName), stage, specialization(info.pSpecializationInfo), layout.push);
  return { stage, t, module: sm.compiled(t) };
}

export class ShaderModule {
  private readonly translations = new Map<string, Translation>();
  private readonly modules = new Map<string, GPUShaderModule>();
  readonly dev: Device; readonly words: Uint32Array;
  constructor(dev: Device, words: Uint32Array) { this.dev = dev; this.words = words; }
  translation(entry: string, stage: Stage, spec: Map<number, number[]>, pushGroup: number): Translation {
    const key = `${stage} ${entry} ${pushGroup} ${[...spec].join(";")}`;
    let t = this.translations.get(key);
    if (!t) this.translations.set(key, t = translate(this.words, entry, stage, spec, pushGroup));
    return t;
  }
  compiled(t: Translation): GPUShaderModule {
    let m = this.modules.get(t.code);
    if (!m) {
      this.modules.set(t.code, m = this.dev.gpu.createShaderModule({ code: t.code }));
      void m.getCompilationInfo().then((info) => {
        for (const msg of info.messages) if (msg.type === "error") console.warn(`[vulkan] WGSL ${msg.lineNum}:${msg.linePos} ${msg.message}\n${t.code}`);
      });
    }
    return m;
  }
}

function graphicsPipeline(dev: Device, info: Record<string, number>): GraphicsPipeline {
  const layout = object<PipelineLayout>(info.layout);
  const stages = list(info.pStages, info.stageCount, StageInfo.size(), (at) => stageOf(StageInfo.read(at), layout));
  const vs = stages.find((s) => s.stage === "vertex"), fs = stages.find((s) => s.stage === "fragment");
  if (!vs) throw new Error("vulkan: a graphics pipeline without a vertex stage");
  const rp = object<RenderPass>(info.renderPass), sub = rp.subpasses[info.subpass];
  const vi = VertexInput.read(info.pVertexInputState), buffers: (GPUVertexBufferLayout | null)[] = [];
  for (const b of list(vi.pBindings, vi.bindings, VertexBinding.size(), (at) => VertexBinding.read(at)))
    buffers[b.binding] = { arrayStride: b.stride, stepMode: b.inputRate ? "instance" : "vertex", attributes: [] };
  for (const a of list(vi.pAttributes, vi.attributes, VertexAttribute.size(), (at) => VertexAttribute.read(at))) {
    const format = vertexFormat(a.format);
    if (!format) throw new Error(`vulkan: vertex format ${a.format}`);
    (buffers[a.binding]!.attributes as GPUVertexAttribute[]).push({ shaderLocation: a.location, offset: a.offset, format });
  }
  for (let i = 0; i < buffers.length; i++) buffers[i] ??= null;
  const ia = InputAssembly.read(info.pInputAssemblyState), topology = TOPOLOGY[ia.topology];
  if (!topology) throw new Error(`vulkan: topology ${ia.topology}`);
  const rs = Rasterization.read(info.pRasterizationState);
  const ms = info.pMultisampleState ? Multisample.read(info.pMultisampleState) : null;
  const samples = ms?.rasterizationSamples ?? 1;
  const strip = topology.endsWith("strip");
  const desc: GPURenderPipelineDescriptor = {
    layout: "auto",
    vertex: { module: vs.module, entryPoint: vs.t.entry, buffers },
    primitive: { topology, cullMode: (["none", "front", "back", "none"] as GPUCullMode[])[rs.cullMode], frontFace: rs.frontFace ? "cw" : "ccw", unclippedDepth: !!rs.depthClampEnable || undefined },
    multisample: { count: samples, mask: ms?.pSampleMask ? mem.ld32(ms.pSampleMask) >>> 0 : 0xffffffff, alphaToCoverageEnabled: !!ms?.alphaToCoverageEnable },
  };
  if (sub.depth !== UNUSED) {
    const a = rp.attachments[sub.depth], f = textureFormat(a.format)!;
    const ds = info.pDepthStencilState ? DepthStencil.read(info.pDepthStencilState) : null;
    const face = (side: "front" | "back"): GPUStencilFaceState => ds?.stencilTestEnable
      ? { compare: COMPARE[ds[`${side}_compareOp`]], failOp: STENCIL_OP[ds[`${side}_failOp`]], depthFailOp: STENCIL_OP[ds[`${side}_depthFailOp`]], passOp: STENCIL_OP[ds[`${side}_passOp`]] }
      : {};
    desc.depthStencil = {
      format: f.gpu, depthWriteEnabled: !!ds?.depthTestEnable && !!ds.depthWriteEnable, depthCompare: ds?.depthTestEnable ? COMPARE[ds.depthCompareOp] : "always",
      stencilFront: face("front"), stencilBack: face("back"),
      stencilReadMask: ds?.stencilTestEnable ? ds.front_compareMask : 0xffffffff, stencilWriteMask: ds?.stencilTestEnable ? ds.front_writeMask : 0xffffffff,
      depthBias: rs.depthBiasEnable ? Math.round(rs.depthBiasConstantFactor) : 0, depthBiasSlopeScale: rs.depthBiasEnable ? rs.depthBiasSlopeFactor : 0, depthBiasClamp: rs.depthBiasEnable ? rs.depthBiasClamp : 0,
    };
  }
  if (fs && !rs.rasterizerDiscardEnable) {
    const cb = info.pColorBlendState ? ColorBlend.read(info.pColorBlendState) : null;
    const blends = cb ? list(cb.pAttachments, cb.attachmentCount, BlendAttachment.size(), (at) => BlendAttachment.read(at)) : [];
    const targets = sub.colors.map((ai, i): GPUColorTargetState | null => {
      if (ai === UNUSED) return null;
      const b = blends[i], target: GPUColorTargetState = { format: textureFormat(rp.attachments[ai].format)!.gpu, writeMask: b?.colorWriteMask ?? 0xf };
      if (b?.blendEnable) target.blend = {
        color: { srcFactor: BLEND_FACTOR[b.srcColor], dstFactor: BLEND_FACTOR[b.dstColor], operation: BLEND_OP[b.colorOp] },
        alpha: { srcFactor: BLEND_FACTOR[b.srcAlpha], dstFactor: BLEND_FACTOR[b.dstAlpha], operation: BLEND_OP[b.alphaOp] },
      };
      return target;
    });
    desc.fragment = { module: fs.module, entryPoint: fs.t.entry, targets };
  }
  const resources = [...new Map(stages.flatMap((s) => s.t.resources).map((r) => [`${r.set}:${r.binding}`, r])).values()];
  return new GraphicsPipeline(dev, desc, resources, layout, strip);
}

export const PIPELINE: Record<string, HostFn> = {
  vkCreateShaderModule: (_c, a) => {
    const dev = deviceOf(a.p()), info = ShaderModuleInfo.read(a.p()); a.p(); const out = a.p();
    stU64(out, handle(new ShaderModule(dev, new Uint32Array(mem.bytes(info.pCode, info.codeSize).slice().buffer))));
    return R.SUCCESS;
  },
  vkDestroyShaderModule: (_c, a) => { a.p(); release(nd(a)); },
  // pipelines are made from WGSL WebGPU compiles and caches itself; the cache holds nothing
  vkCreatePipelineCache: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), handle({})); return R.SUCCESS; },
  vkDestroyPipelineCache: (_c, a) => { a.p(); release(nd(a)); },
  vkGetPipelineCacheData: (_c, a) => { a.p(); nd(a); stp(a.p(), 0); return R.SUCCESS; },
  vkMergePipelineCaches: () => R.SUCCESS,

  vkCreateDescriptorSetLayout: (_c, a) => {
    a.p(); const info = SetLayoutInfo.read(a.p()); a.p(); const out = a.p(), bindings = new Map<number, SetLayoutBinding>();
    for (const b of list(info.pBindings, info.bindingCount, SetLayoutBindingS.size(), (at) => SetLayoutBindingS.read(at)))
      bindings.set(b.binding, { type: b.descriptorType, count: b.descriptorCount, samplers: u64s(b.pImmutableSamplers, b.descriptorCount).map((h) => object<GPUSampler>(h)) });
    stU64(out, handle(new SetLayout(bindings)));
    return R.SUCCESS;
  },
  vkDestroyDescriptorSetLayout: (_c, a) => { a.p(); release(nd(a)); },
  vkGetDescriptorSetLayoutSupport: (_c, a) => { a.p(); a.p(); mem.st32(a.p() + 2 * PTR, 1); },
  vkCreatePipelineLayout: (_c, a) => {
    const dev = deviceOf(a.p()), info = LayoutInfo.read(a.p()); a.p(); const out = a.p();
    const push = info.pushConstantRangeCount ? Math.min(info.setLayoutCount, dev.physical.limits.maxBindGroups - 1) : -1;
    stU64(out, handle({ sets: u64s(info.pSetLayouts, info.setLayoutCount).map((h) => object<SetLayout>(h)), push } satisfies PipelineLayout));
    return R.SUCCESS;
  },
  vkDestroyPipelineLayout: (_c, a) => { a.p(); release(nd(a)); },
  vkCreateDescriptorPool: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), handle({ sets: new Set() } satisfies Pool)); return R.SUCCESS; },
  vkDestroyDescriptorPool: (_c, a) => { a.p(); const h = nd(a), pool = maybe<Pool>(h); for (const s of pool?.sets ?? []) release(s); release(h); },
  vkResetDescriptorPool: (_c, a) => { a.p(); const pool = object<Pool>(nd(a)); for (const s of pool.sets) release(s); pool.sets.clear(); return R.SUCCESS; },
  vkAllocateDescriptorSets: (_c, a) => {
    a.p(); const info = SetAllocateInfo.read(a.p()), out = a.p(), pool = object<Pool>(info.descriptorPool);
    u64s(info.pSetLayouts, info.descriptorSetCount).forEach((h, i) => { const s = handle(new DescriptorSet(object<SetLayout>(h))); pool.sets.add(s); stU64(out + 8 * i, s); });
    return R.SUCCESS;
  },
  vkFreeDescriptorSets: (_c, a) => { a.p(); const pool = object<Pool>(nd(a)), n = a.u(); for (const s of u64s(a.p(), n)) { pool.sets.delete(s); release(s); } return R.SUCCESS; },
  vkUpdateDescriptorSets: (_c, a) => {
    a.p(); const writes = a.u(), pWrites = a.p(), copies = a.u(), pCopies = a.p();
    for (const w of list(pWrites, writes, WriteSet.size(), (at) => WriteSet.read(at))) {
      const set = object<DescriptorSet>(w.dstSet);
      let binding = w.dstBinding, element = w.dstArrayElement;
      for (let i = 0; i < w.descriptorCount; i++) {
        // a write past a binding's end goes on in the next binding (descriptor update consecutive-binding rules)
        while (element >= (set.slots.get(binding)?.length ?? Infinity)) { binding++; element = 0; }
        const slots = set.slots.get(binding)!;
        if (w.descriptorType >= DESCRIPTOR.UNIFORM && w.descriptorType <= DESCRIPTOR.STORAGE_DYNAMIC) {
          const b = BufferInfo.read(w.pBufferInfo + i * BufferInfo.size());
          slots[element] = { kind: "buffer", buffer: object<Buffer>(b.buffer), offset: b.offset, range: b.range };
        } else if (w.descriptorType <= DESCRIPTOR.STORAGE_IMAGE || w.descriptorType === DESCRIPTOR.INPUT_ATTACHMENT) {
          const im = ImageInfo.read(w.pImageInfo + i * ImageInfo.size()), prev = slots[element];
          const fixed = set.layout.bindings.get(binding)!.samplers[element];
          slots[element] = {
            kind: "image", view: w.descriptorType === DESCRIPTOR.SAMPLER ? null : object<View>(im.imageView),
            sampler: fixed ?? (w.descriptorType === DESCRIPTOR.SAMPLER || w.descriptorType === DESCRIPTOR.COMBINED ? object<GPUSampler>(im.sampler) : prev.kind === "image" ? prev.sampler : null),
          };
        } else throw new Error(`vulkan: texel buffer descriptors`);
        element++;
      }
      set.changed();
    }
    for (const c of list(pCopies, copies, CopySet.size(), (at) => CopySet.read(at))) {
      const src = object<DescriptorSet>(c.srcSet), dst = object<DescriptorSet>(c.dstSet);
      for (let i = 0; i < c.descriptorCount; i++) dst.slots.get(c.dstBinding)![c.dstArrayElement + i] = src.slots.get(c.srcBinding)![c.srcArrayElement + i];
      dst.changed();
    }
  },

  vkCreateRenderPass: (_c, a) => {
    a.p(); const info = RenderPassInfo.read(a.p()); a.p(); const out = a.p();
    const attachments = list(info.pAttachments, info.attachmentCount, AttachmentS.size(), (at) => attachmentOf(AttachmentS.read(at)));
    const refs = (p: number, n: number) => list(p, n, 8, (at) => mem.ld32(at) >>> 0);
    const subpasses = list(info.pSubpasses, info.subpassCount, SubpassS.size(), (at) => {
      const s = SubpassS.read(at);
      return { colors: refs(s.pColors, s.colors), resolves: refs(s.pResolves, s.colors), depth: s.pDepth ? mem.ld32(s.pDepth) >>> 0 : UNUSED };
    });
    stU64(out, handle({ attachments, subpasses } satisfies RenderPass));
    return R.SUCCESS;
  },
  vkCreateRenderPass2: (_c, a) => {
    a.p(); const info = RenderPassInfo2.read(a.p()); a.p(); const out = a.p();
    const attachments = list(info.pAttachments, info.attachmentCount, Attachment2.size(), (at) => attachmentOf(Attachment2.read(at)));
    const refs = (p: number, n: number) => list(p, n, Reference2.size(), (at) => Reference2.read(at).attachment);
    const subpasses = list(info.pSubpasses, info.subpassCount, Subpass2.size(), (at) => {
      const s = Subpass2.read(at);
      return { colors: refs(s.pColors, s.colors), resolves: refs(s.pResolves, s.colors), depth: s.pDepth ? Reference2.read(s.pDepth).attachment : UNUSED };
    });
    stU64(out, handle({ attachments, subpasses } satisfies RenderPass));
    return R.SUCCESS;
  },
  vkDestroyRenderPass: (_c, a) => { a.p(); release(nd(a)); },
  vkGetRenderAreaGranularity: (_c, a) => { a.p(); nd(a); const out = a.p(); mem.st32(out, 1); mem.st32(out + 4, 1); },
  vkCreateFramebuffer: (_c, a) => {
    a.p(); const info = FramebufferInfo.read(a.p()); a.p(); const out = a.p();
    stU64(out, handle({ views: u64s(info.pAttachments, info.attachmentCount).map((h) => object<View>(h)), width: info.width, height: info.height } satisfies Framebuffer));
    return R.SUCCESS;
  },
  vkDestroyFramebuffer: (_c, a) => { a.p(); release(nd(a)); },

  vkCreateGraphicsPipelines: (_c, a) => {
    const dev = deviceOf(a.p()); nd(a); const n = a.u(), infos = a.p(); a.p(); const out = a.p();
    for (let i = 0; i < n; i++) {
      try { stU64(out + 8 * i, handle(graphicsPipeline(dev, GraphicsInfo.read(infos + i * GraphicsInfo.size())))); }
      catch (e) { console.warn("[vulkan] vkCreateGraphicsPipelines:", (e as Error).message); for (let j = 0; j < n; j++) if (j >= i) stU64(out + 8 * j, 0); return R.FEATURE_NOT_PRESENT; }
    }
    return R.SUCCESS;
  },
  vkCreateComputePipelines: (_c, a) => {
    const dev = deviceOf(a.p()); nd(a); const n = a.u(), infos = a.p(); a.p(); const out = a.p();
    for (let i = 0; i < n; i++) {
      const info = ComputeInfo.read(infos + i * ComputeInfo.size()), layout = object<PipelineLayout>(info.layout);
      try {
        const s = stageOf({ stage: info.stage_stage, module: info.stage_module, pName: info.stage_pName, pSpecializationInfo: info.stage_pSpecializationInfo }, layout);
        const gpu = dev.gpu.createComputePipeline({ layout: "auto", compute: { module: s.module, entryPoint: s.t.entry } });
        stU64(out + 8 * i, handle({ gpu, resources: s.t.resources, layout } satisfies ComputePipeline));
      } catch (e) { console.warn("[vulkan] vkCreateComputePipelines:", (e as Error).message); stU64(out + 8 * i, 0); return R.FEATURE_NOT_PRESENT; }
    }
    return R.SUCCESS;
  },
  vkDestroyPipeline: (_c, a) => { a.p(); release(nd(a)); },
};
