// The Vulkan instance and its one physical device: the host's WebGPU adapter, its identity, limits and
// features answered in Vulkan's terms. The device exposes what WebGPU can carry out: no geometry or
// tessellation stages, sparse resources, input attachments or resource arrays a shader indexes.

import { mem } from "../mem.ts";
import { PTR, ldp, stp, type HostFn, type ArgReader } from "../host.ts";
import { struct, ptrs } from "../struct.ts";
import { R, S, AHB_HANDLE, SYNC_FD, UNIFORM_RANGE, objects, dispatchable, chain, enumerate } from "./vk.ts";
import { formatFeatures, multisamples, textureFormat } from "./formats.ts";

const API_VERSION = (1 << 22) | (1 << 12);                                // 1.1.0
const DRIVER_VERSION = (1 << 22);
const INSTANCE_EXTENSIONS: [string, number][] = [
  ["VK_KHR_get_physical_device_properties2", 2], ["VK_KHR_external_memory_capabilities", 1],
  ["VK_KHR_external_semaphore_capabilities", 1], ["VK_KHR_external_fence_capabilities", 1], ["VK_KHR_surface", 25], ["VK_KHR_android_surface", 6],
];
export const DEVICE_EXTENSIONS: [string, number][] = [
  ["VK_KHR_driver_properties", 1], ["VK_KHR_external_memory", 1], ["VK_KHR_external_semaphore", 1], ["VK_KHR_external_semaphore_fd", 1],
  ["VK_KHR_sampler_ycbcr_conversion", 14], ["VK_KHR_dedicated_allocation", 3], ["VK_KHR_get_memory_requirements2", 1],
  ["VK_KHR_maintenance1", 2], ["VK_KHR_bind_memory2", 1], ["VK_KHR_storage_buffer_storage_class", 1],
  ["VK_EXT_queue_family_foreign", 1], ["VK_ANDROID_external_memory_android_hardware_buffer", 5], ["VK_KHR_swapchain", 70],
];

const Extension = struct("extensionName:u8[256] specVersion:u32");
const Layer = struct("layerName:u8[256] specVersion:u32 implementationVersion:u32 description:u8[256]");
const Limits = struct(`maxImageDimension1D:u32 maxImageDimension2D:u32 maxImageDimension3D:u32 maxImageDimensionCube:u32 maxImageArrayLayers:u32 maxTexelBufferElements:u32
  maxUniformBufferRange:u32 maxStorageBufferRange:u32 maxPushConstantsSize:u32 maxMemoryAllocationCount:u32 maxSamplerAllocationCount:u32
  bufferImageGranularity:u64 sparseAddressSpaceSize:u64 maxBoundDescriptorSets:u32 maxPerStageDescriptorSamplers:u32
  maxPerStageDescriptorUniformBuffers:u32 maxPerStageDescriptorStorageBuffers:u32 maxPerStageDescriptorSampledImages:u32
  maxPerStageDescriptorStorageImages:u32 maxPerStageDescriptorInputAttachments:u32 maxPerStageResources:u32 maxDescriptorSetSamplers:u32
  maxDescriptorSetUniformBuffers:u32 maxDescriptorSetUniformBuffersDynamic:u32 maxDescriptorSetStorageBuffers:u32
  maxDescriptorSetStorageBuffersDynamic:u32 maxDescriptorSetSampledImages:u32 maxDescriptorSetStorageImages:u32 maxDescriptorSetInputAttachments:u32
  maxVertexInputAttributes:u32 maxVertexInputBindings:u32 maxVertexInputAttributeOffset:u32 maxVertexInputBindingStride:u32
  maxVertexOutputComponents:u32 maxTessellationGenerationLevel:u32 maxTessellationPatchSize:u32 maxTessellationControlPerVertexInputComponents:u32
  maxTessellationControlPerVertexOutputComponents:u32 maxTessellationControlPerPatchOutputComponents:u32 maxTessellationControlTotalOutputComponents:u32
  maxTessellationEvaluationInputComponents:u32 maxTessellationEvaluationOutputComponents:u32 maxGeometryShaderInvocations:u32
  maxGeometryInputComponents:u32 maxGeometryOutputComponents:u32 maxGeometryOutputVertices:u32 maxGeometryTotalOutputComponents:u32
  maxFragmentInputComponents:u32 maxFragmentOutputAttachments:u32 maxFragmentDualSrcAttachments:u32 maxFragmentCombinedOutputResources:u32
  maxComputeSharedMemorySize:u32 maxComputeWorkGroupCount:u32[3] maxComputeWorkGroupInvocations:u32 maxComputeWorkGroupSize:u32[3]
  subPixelPrecisionBits:u32 subTexelPrecisionBits:u32 mipmapPrecisionBits:u32 maxDrawIndexedIndexValue:u32 maxDrawIndirectCount:u32
  maxSamplerLodBias:f32 maxSamplerAnisotropy:f32 maxViewports:u32 maxViewportDimensions:u32[2] viewportBoundsRange:f32[2] viewportSubPixelBits:u32
  minMemoryMapAlignment:size minTexelBufferOffsetAlignment:u64 minUniformBufferOffsetAlignment:u64 minStorageBufferOffsetAlignment:u64
  minTexelOffset:i32 maxTexelOffset:u32 minTexelGatherOffset:i32 maxTexelGatherOffset:u32 minInterpolationOffset:f32 maxInterpolationOffset:f32
  subPixelInterpolationOffsetBits:u32 maxFramebufferWidth:u32 maxFramebufferHeight:u32 maxFramebufferLayers:u32 framebufferColorSampleCounts:u32
  framebufferDepthSampleCounts:u32 framebufferStencilSampleCounts:u32 framebufferNoAttachmentsSampleCounts:u32 maxColorAttachments:u32
  sampledImageColorSampleCounts:u32 sampledImageIntegerSampleCounts:u32 sampledImageDepthSampleCounts:u32 sampledImageStencilSampleCounts:u32
  storageImageSampleCounts:u32 maxSampleMaskWords:u32 timestampComputeAndGraphics:u32 timestampPeriod:f32 maxClipDistances:u32 maxCullDistances:u32
  maxCombinedClipAndCullDistances:u32 discreteQueuePriorities:u32 pointSizeRange:f32[2] lineWidthRange:f32[2] pointSizeGranularity:f32
  lineWidthGranularity:f32 strictLines:u32 standardSampleLocations:u32 optimalBufferCopyOffsetAlignment:u64 optimalBufferCopyRowPitchAlignment:u64
  nonCoherentAtomSize:u64`);
// no sparse residency: VkPhysicalDeviceSparseProperties' five VkBool32s are false
const Properties = struct(`apiVersion:u32 driverVersion:u32 vendorID:u32 deviceID:u32 deviceType:u32 deviceName:u8[256] pipelineCacheUUID:u8[16]
  limits:struct sparseProperties:u32[5]`, { limits: Limits });
const FEATURE_NAMES = `robustBufferAccess fullDrawIndexUint32 imageCubeArray independentBlend geometryShader tessellationShader sampleRateShading
  dualSrcBlend logicOp multiDrawIndirect drawIndirectFirstInstance depthClamp depthBiasClamp fillModeNonSolid depthBounds wideLines largePoints
  alphaToOne multiViewport samplerAnisotropy textureCompressionETC2 textureCompressionASTC_LDR textureCompressionBC occlusionQueryPrecise
  pipelineStatisticsQuery vertexPipelineStoresAndAtomics fragmentStoresAndAtomics shaderTessellationAndGeometryPointSize shaderImageGatherExtended
  shaderStorageImageExtendedFormats shaderStorageImageMultisample shaderStorageImageReadWithoutFormat shaderStorageImageWriteWithoutFormat
  shaderUniformBufferArrayDynamicIndexing shaderSampledImageArrayDynamicIndexing shaderStorageBufferArrayDynamicIndexing
  shaderStorageImageArrayDynamicIndexing shaderClipDistance shaderCullDistance shaderFloat64 shaderInt64 shaderInt16 shaderResourceResidency
  shaderResourceMinLod sparseBinding sparseResidencyBuffer sparseResidencyImage2D sparseResidencyImage3D sparseResidency2Samples
  sparseResidency4Samples sparseResidency8Samples sparseResidency16Samples sparseResidencyAliased variableMultisampleRate inheritedQueries`.trim().split(/\s+/);
const Features = struct(FEATURE_NAMES.map((n) => `${n}:u32`).join(" "));
const QueueFamily = struct("queueFlags:u32 queueCount:u32 timestampValidBits:u32 granularity:u32[3]");
const FormatProperties = struct("linearTilingFeatures:u32 optimalTilingFeatures:u32 bufferFeatures:u32");
const ImageFormatProperties = struct("maxExtent:u32[3] maxMipLevels:u32 maxArrayLayers:u32 sampleCounts:u32 maxResourceSize:u64");
const MemoryProperties = struct("memoryTypeCount:u32 memoryTypes:u32[64] memoryHeapCount:u32 memoryHeaps:u64[32]");
// the *2 queries' structs: sType, pNext, then the 1.0 struct
const Properties2 = struct("sType:u32 pNext:ptr properties:struct", { properties: Properties });
const Features2 = struct("sType:u32 pNext:ptr features:struct", { features: Features });
const MemoryProperties2 = struct("sType:u32 pNext:ptr memoryProperties:struct", { memoryProperties: MemoryProperties });
const QueueFamily2 = struct("sType:u32 pNext:ptr queueFamilyProperties:struct", { queueFamilyProperties: QueueFamily });
const FormatProperties2 = struct("sType:u32 pNext:ptr formatProperties:struct", { formatProperties: FormatProperties });
const ImageFormatProperties2 = struct("sType:u32 pNext:ptr imageFormatProperties:struct", { imageFormatProperties: ImageFormatProperties });
const ImageFormatInfo2 = struct("sType:u32 pNext:ptr format:u32 type:u32 tiling:u32 usage:u32 flags:u32");
const IdProperties = struct("sType:u32 pNext:ptr deviceUUID:u8[16] driverUUID:u8[16] deviceLUID:u8[8] deviceNodeMask:u32 deviceLUIDValid:u32");
const Maintenance3 = struct("sType:u32 pNext:ptr maxPerSetDescriptors:u32 maxMemoryAllocationSize:u64");
const Subgroup = struct("sType:u32 pNext:ptr subgroupSize:u32 supportedStages:u32 supportedOperations:u32 quadOperationsInAllStages:u32");
const Driver = struct("sType:u32 pNext:ptr driverID:u32 driverName:u8[256] driverInfo:u8[256] conformance:u8[4]");
/** a chained struct of 32-bit members alone */
const Words = struct("sType:u32 pNext:ptr v:u32[4]");
// VkExternalMemoryProperties puts the features first; the semaphore and fence properties put them last
const ExternalMemoryProperties = struct("sType:u32 pNext:ptr features:u32 exportFrom:u32 compatible:u32");
const ExternalProperties = struct("sType:u32 pNext:ptr exportFrom:u32 compatible:u32 features:u32");
const InstanceInfo = struct("sType:u32 pNext:ptr flags:u32 app:ptr layers:u32 layerNames:ptr extensions:u32 extensionNames:ptr");
const DeviceGroup = struct("sType:u32 pNext:ptr count:u32 devices:ptr[32] subsetAllocation:u32");
const AhbUsage = struct("sType:u32 pNext:ptr usage:u64");
const ExternalBufferInfo = struct("sType:u32 pNext:ptr flags:u32 usage:u32 handleType:u32");
const ExternalInfo = struct("sType:u32 pNext:ptr handleType:u32");

class Instance {}
/** the adapter, its device's capabilities and the Vulkan answers derived from them */
export class Physical {
  readonly handle: number;
  readonly adapter: GPUAdapter;
  /** whether `adapter` has made its one device */
  consumed = false;
  readonly features: Set<string>;
  readonly limits: GPUSupportedLimits;
  readonly info: GPUAdapterInfo;
  constructor(adapter: GPUAdapter) {
    this.adapter = adapter; this.features = new Set(adapter.features); this.limits = adapter.limits; this.info = adapter.info;
    this.handle = dispatchable(this);
  }
}
const VENDORS: Record<string, number> = { apple: 0x106b, nvidia: 0x10de, amd: 0x1002, intel: 0x8086, qualcomm: 0x5143, arm: 0x13b5, "img-tec": 0x1010, microsoft: 0x1414, google: 0x1ae0 };
let physical: Promise<Physical | null> | null = null;
/** the realm's adapter, null where the host offers no WebGPU */
function physicalDevice(): Promise<Physical | null> {
  return physical ??= requestAdapter().then((adapter) => adapter && new Physical(adapter));
}
const physicalOf = (h: number): Physical => objects.get(h, Physical);
const requestAdapter = () => (globalThis.navigator as Navigator & { gpu?: GPU }).gpu?.requestAdapter().catch(() => null) ?? Promise.resolve(null);
/** an adapter for a new device: an adapter makes one device, so each after the first asks for another */
export async function deviceAdapter(p: Physical): Promise<GPUAdapter | null> {
  if (!p.consumed) { p.consumed = true; return p.adapter; }
  return requestAdapter();
}

/** VkImageCreateInfo's usage bits a format's features must carry, by usage bit */
const USAGE_NEEDS: [number, number][] = [[0x1, 0x4000], [0x2, 0x8000], [0x4, 0x1], [0x8, 0x2], [0x10, 0x80], [0x20, 0x200]];
/** vkGetPhysicalDeviceImageFormatProperties's answer, or null for VK_ERROR_FORMAT_NOT_SUPPORTED */
function imageFormatLimits(p: Physical, format: number, type: number, tiling: number, usage: number, flags: number):
  { extent: [number, number, number]; mips: number; layers: number; samples: number } | null {
  const f = textureFormat(format), features = formatFeatures(format, p.features).optimal, L = p.limits;
  if (!f || tiling !== 0 || !features) return null;                              // VK_IMAGE_TILING_OPTIMAL only
  if (USAGE_NEEDS.some(([bit, need]) => usage & bit && !(features & need))) return null;
  if (type === 2 && (f.depth || f.stencil || (f.bw > 1 && !p.features.has(f.gpu.startsWith("astc") ? "texture-compression-astc-sliced-3d" : "texture-compression-bc-sliced-3d")))) return null;
  if (type === 0 && (f.depth || f.stencil || f.bw > 1)) return null;
  const extent: [number, number, number] = type === 0 ? [L.maxTextureDimension1D, 1, 1] : type === 1 ? [L.maxTextureDimension2D, L.maxTextureDimension2D, 1] : [L.maxTextureDimension3D, L.maxTextureDimension3D, L.maxTextureDimension3D];
  const cube = flags & 0x10;
  const samples = type === 1 && !cube && !(usage & 0x8) && multisamples(format, p.features) ? 0x5 : 0x1;
  return { extent, mips: type === 0 ? 1 : Math.floor(Math.log2(Math.max(...extent))) + 1, layers: type === 2 ? 1 : L.maxTextureArrayLayers, samples };
}

function writeProperties(p: Physical, at: number): void {
  const L = p.limits, F = p.features, vendor = VENDORS[p.info.vendor] ?? 0, d2 = L.maxTextureDimension2D;
  const perStage = (n: number) => n * 2;
  mem.memset(at, 0, Properties.size());
  Properties.write(at, {
    apiVersion: API_VERSION, driverVersion: DRIVER_VERSION, vendorID: vendor, deviceID: 0,
    deviceType: p.info.isFallbackAdapter ? 4 : vendor === 0x10de || vendor === 0x1002 ? 2 : 1,
    deviceName: [p.info.vendor, p.info.architecture, p.info.description].filter(Boolean).join(" ") || "WebGPU",
    pipelineCacheUUID: [...new TextEncoder().encode("webdroid-webgpu1")],
    limits: {
      maxImageDimension1D: L.maxTextureDimension1D, maxImageDimension2D: d2, maxImageDimension3D: L.maxTextureDimension3D,
      maxImageDimensionCube: d2, maxImageArrayLayers: L.maxTextureArrayLayers, maxTexelBufferElements: 65536,
      maxUniformBufferRange: UNIFORM_RANGE, maxStorageBufferRange: Math.min(L.maxStorageBufferBindingSize, 0xffffffff),
      maxPushConstantsSize: 128, maxMemoryAllocationCount: 4096, maxSamplerAllocationCount: 4000, bufferImageGranularity: 1,
      maxBoundDescriptorSets: L.maxBindGroups, maxPerStageDescriptorSamplers: L.maxSamplersPerShaderStage,
      maxPerStageDescriptorUniformBuffers: L.maxUniformBuffersPerShaderStage, maxPerStageDescriptorStorageBuffers: L.maxStorageBuffersPerShaderStage,
      maxPerStageDescriptorSampledImages: L.maxSampledTexturesPerShaderStage, maxPerStageDescriptorStorageImages: L.maxStorageTexturesPerShaderStage,
      maxPerStageResources: L.maxSamplersPerShaderStage + L.maxUniformBuffersPerShaderStage + L.maxStorageBuffersPerShaderStage +
        L.maxSampledTexturesPerShaderStage + L.maxStorageTexturesPerShaderStage + L.maxColorAttachments,
      maxDescriptorSetSamplers: perStage(L.maxSamplersPerShaderStage), maxDescriptorSetUniformBuffers: perStage(L.maxUniformBuffersPerShaderStage),
      maxDescriptorSetUniformBuffersDynamic: L.maxDynamicUniformBuffersPerPipelineLayout, maxDescriptorSetStorageBuffers: perStage(L.maxStorageBuffersPerShaderStage),
      maxDescriptorSetStorageBuffersDynamic: L.maxDynamicStorageBuffersPerPipelineLayout, maxDescriptorSetSampledImages: perStage(L.maxSampledTexturesPerShaderStage),
      maxDescriptorSetStorageImages: perStage(L.maxStorageTexturesPerShaderStage),
      maxVertexInputAttributes: L.maxVertexAttributes, maxVertexInputBindings: L.maxVertexBuffers,
      maxVertexInputAttributeOffset: L.maxVertexBufferArrayStride - 1, maxVertexInputBindingStride: L.maxVertexBufferArrayStride,
      // position and the point size aside, as Dawn reserves them
      maxVertexOutputComponents: (L.maxInterStageShaderVariables + 2) * 4, maxFragmentInputComponents: (L.maxInterStageShaderVariables + 2) * 4,
      maxFragmentOutputAttachments: L.maxColorAttachments, maxFragmentDualSrcAttachments: F.has("dual-source-blending") ? 1 : 0,
      maxFragmentCombinedOutputResources: L.maxColorAttachments + L.maxStorageBuffersPerShaderStage + L.maxStorageTexturesPerShaderStage,
      maxComputeSharedMemorySize: L.maxComputeWorkgroupStorageSize,
      maxComputeWorkGroupCount: [L.maxComputeWorkgroupsPerDimension, L.maxComputeWorkgroupsPerDimension, L.maxComputeWorkgroupsPerDimension],
      maxComputeWorkGroupInvocations: L.maxComputeInvocationsPerWorkgroup,
      maxComputeWorkGroupSize: [L.maxComputeWorkgroupSizeX, L.maxComputeWorkgroupSizeY, L.maxComputeWorkgroupSizeZ],
      subPixelPrecisionBits: 4, subTexelPrecisionBits: 4, mipmapPrecisionBits: 4, maxDrawIndexedIndexValue: 0xffffffff, maxDrawIndirectCount: 1,
      maxSamplerAnisotropy: 16, maxViewports: 1, maxViewportDimensions: [d2, d2], viewportBoundsRange: [-2 * d2, 2 * d2 - 1],
      minMemoryMapAlignment: 64, minTexelBufferOffsetAlignment: 256,
      minUniformBufferOffsetAlignment: L.minUniformBufferOffsetAlignment, minStorageBufferOffsetAlignment: L.minStorageBufferOffsetAlignment,
      minTexelOffset: -8, maxTexelOffset: 7, minTexelGatherOffset: -8, maxTexelGatherOffset: 7, minInterpolationOffset: -0.5,
      maxInterpolationOffset: 0.4375, subPixelInterpolationOffsetBits: 4, maxFramebufferWidth: d2, maxFramebufferHeight: d2, maxFramebufferLayers: 1,
      framebufferColorSampleCounts: 5, framebufferDepthSampleCounts: 5, framebufferStencilSampleCounts: 5, framebufferNoAttachmentsSampleCounts: 5,
      maxColorAttachments: L.maxColorAttachments, sampledImageColorSampleCounts: 5, sampledImageIntegerSampleCounts: 5,
      sampledImageDepthSampleCounts: 5, sampledImageStencilSampleCounts: 5, storageImageSampleCounts: 1, maxSampleMaskWords: 1,
      timestampPeriod: 1, maxClipDistances: F.has("clip-distances") ? 8 : 0, maxCombinedClipAndCullDistances: F.has("clip-distances") ? 8 : 0,
      discreteQueuePriorities: 2, pointSizeRange: [1, 1], lineWidthRange: [1, 1], standardSampleLocations: 1,
      optimalBufferCopyOffsetAlignment: 256, optimalBufferCopyRowPitchAlignment: 256, nonCoherentAtomSize: 64,
    },
  });
}
function writeFeatures(p: Physical, at: number): void {
  const F = p.features, on = new Set(["robustBufferAccess", "fullDrawIndexUint32", "imageCubeArray", "independentBlend", "sampleRateShading",
    "depthBiasClamp", "samplerAnisotropy", "occlusionQueryPrecise", "fragmentStoresAndAtomics",
    // WGSL has no resource arrays, so no shader written for this device indexes one
    "shaderUniformBufferArrayDynamicIndexing", "shaderSampledImageArrayDynamicIndexing", "shaderStorageBufferArrayDynamicIndexing", "shaderStorageImageArrayDynamicIndexing"]);
  const byFeature: [string, string][] = [["dualSrcBlend", "dual-source-blending"], ["drawIndirectFirstInstance", "indirect-first-instance"],
    ["depthClamp", "depth-clip-control"], ["textureCompressionETC2", "texture-compression-etc2"], ["textureCompressionASTC_LDR", "texture-compression-astc"],
    ["textureCompressionBC", "texture-compression-bc"], ["shaderClipDistance", "clip-distances"]];
  for (const [vk, gpu] of byFeature) if (F.has(gpu)) on.add(vk);
  Features.write(at, Object.fromEntries(FEATURE_NAMES.map((n) => [n, on.has(n) ? 1 : 0])));
}
/** the chained structs of 32-bit members alone: point clipping on all clip planes, one view of multiview, the
 *  samplerYcbcrConversion feature (for external formats) and the features this device lacks */
const WORDS = new Map<number, number[]>([
  [S.POINT_CLIPPING_PROPERTIES, [0]], [S.MULTIVIEW_PROPERTIES, [1, 0x7ffffff]], [S.PROTECTED_MEMORY_PROPERTIES, [0]],
  [S.STORAGE_16BIT_FEATURES, [0, 0, 0, 0]], [S.MULTIVIEW_FEATURES, [0, 0, 0]], [S.VARIABLE_POINTERS_FEATURES, [0, 0]], [S.YCBCR_FEATURES, [1]],
  [S.PROTECTED_MEMORY_FEATURES, [0]], [S.SHADER_DRAW_PARAMETERS_FEATURES, [0]], [S.EXTENDED_DYNAMIC_STATE_FEATURES, [0]],
]);
/** the chained structs Vulkan 1.1 and the advertised extensions define, filled in; others left as they are */
function writeChain(p: Physical, pNext: number): void {
  for (const [sType, at] of chain(pNext)) {
    const words = WORDS.get(sType);
    if (words) { Words.write(at, { v: words }); continue; }
    switch (sType) {
      case S.ID_PROPERTIES:
        IdProperties.write(at, { deviceUUID: [...new TextEncoder().encode("webdroid-device0")], driverUUID: [...new TextEncoder().encode("webdroid-driver0")], deviceLUID: [0, 0, 0, 0, 0, 0, 0, 0], deviceNodeMask: 0, deviceLUIDValid: 0 });
        break;
      case S.MAINTENANCE_3_PROPERTIES: Maintenance3.write(at, { maxPerSetDescriptors: 1024, maxMemoryAllocationSize: Math.min(p.limits.maxBufferSize, 2 ** 31) }); break;
      // no subgroup operations: WGSL's need a feature Vulkan 1.1 cannot ask for
      case S.SUBGROUP_PROPERTIES: Subgroup.write(at, { subgroupSize: 1, supportedStages: 0, supportedOperations: 1, quadOperationsInAllStages: 0 }); break;
      case S.DRIVER_PROPERTIES: Driver.write(at, { driverID: 0, driverName: "webdroid", driverInfo: "WebGPU", conformance: [0, 0, 0, 0] }); break;
    }
  }
}
// memory types: device-local only (images, buffers the host never maps), and device-local host-visible coherent
// memory in guest memory; one heap holds both
export const MEMORY_TYPES = [1, 1 | 2 | 4 | 8];
function writeMemory(p: Physical, at: number): void {
  mem.memset(at, 0, MemoryProperties.size());
  // memory types as (propertyFlags, heapIndex 0); the heap as (size, VK_MEMORY_HEAP_DEVICE_LOCAL_BIT)
  MemoryProperties.write(at, {
    memoryTypeCount: MEMORY_TYPES.length, memoryTypes: MEMORY_TYPES.flatMap((flags) => [flags, 0]),
    memoryHeapCount: 1, memoryHeaps: [Math.min(p.limits.maxBufferSize, 2 ** 31), 1],
  });
}
function writeQueueFamily(at: number): void { QueueFamily.write(at, { queueFlags: 7, queueCount: 1, timestampValidBits: 0, granularity: [1, 1, 1] }); }
function writeFormat(p: Physical, format: number, at: number): void {
  const { optimal, buffer } = formatFeatures(format, p.features);
  FormatProperties.write(at, { linearTilingFeatures: 0, optimalTilingFeatures: optimal, bufferFeatures: buffer });
}
function imageFormat(p: Physical, at: number, format: number, type: number, tiling: number, usage: number, flags: number): number {
  const l = imageFormatLimits(p, format, type, tiling, usage, flags);
  if (!l) { mem.memset(at, 0, ImageFormatProperties.size()); return R.FORMAT_NOT_SUPPORTED; }
  ImageFormatProperties.write(at, { maxExtent: l.extent, maxMipLevels: l.mips, maxArrayLayers: l.layers, sampleCounts: l.samples, maxResourceSize: 2 ** 31 });
  return R.SUCCESS;
}
/** an external handle type's support: AHardwareBuffers for images and buffers, sync fds for semaphores and fences */
function externalProperties(at: number, handleType: number, supported: number, features: number): void {
  (supported === AHB_HANDLE ? ExternalMemoryProperties : ExternalProperties).write(at, handleType === supported ? { exportFrom: supported, compatible: supported, features } : { exportFrom: 0, compatible: 0, features: 0 });
}

/** vkEnumerate*ExtensionProperties(pLayerName, pPropertyCount, pProperties) of `list` */
function extensionProperties(list: [string, number][], a: ArgReader): number {
  const layer = a.p(), count = a.p(), props = a.p();
  if (layer) return R.LAYER_NOT_PRESENT;
  return enumerate(list, count, props, Extension.size(), (at, [name, version]) => Extension.write(at, { extensionName: name, specVersion: version }));
}
/** whether `list` has each of the `n` extension names at `names` */
export function hasExtensions(list: [string, number][], names: number, n: number): boolean {
  const known = new Set(list.map(([name]) => name));
  return ptrs(names, n).every((p) => known.has(mem.cstr(p)));
}

export const INSTANCE: Record<string, HostFn> = {
  vkEnumerateInstanceVersion: (_c, a) => { mem.st32(a.p(), API_VERSION); return R.SUCCESS; },
  vkEnumerateInstanceExtensionProperties: (_c, a) => extensionProperties(INSTANCE_EXTENSIONS, a),
  vkEnumerateInstanceLayerProperties: (_c, a) => enumerate([], a.p(), a.p(), Layer.size(), () => {}),
  vkEnumerateDeviceLayerProperties: (_c, a) => { a.p(); return enumerate([], a.p(), a.p(), Layer.size(), () => {}); },
  vkEnumerateDeviceExtensionProperties: (_c, a) => { a.p(); return extensionProperties(DEVICE_EXTENSIONS, a); },
  // the instance is the realm's: one adapter, asked for once
  vkCreateInstance: (_c, a) => {
    const info = InstanceInfo.read(a.p()); a.p(); const out = a.p();
    if (!hasExtensions(INSTANCE_EXTENSIONS, info.extensionNames, info.extensions)) return R.EXTENSION_NOT_PRESENT;
    if (info.layers) return R.LAYER_NOT_PRESENT;
    stp(out, dispatchable(new Instance()));
    return R.SUCCESS;
  },
  vkDestroyInstance: (_c, a) => { const h = a.p(); if (h) objects.delete(h); },
  vkEnumeratePhysicalDevices: async (_c, a) => {
    a.p(); const count = a.p(), out = a.p(), p = await physicalDevice();
    return enumerate(p ? [p.handle] : [], count, out, PTR, (at, h) => stp(at, h));
  },
  vkEnumeratePhysicalDeviceGroups: async (_c, a) => {
    a.p(); const count = a.p(), out = a.p(), p = await physicalDevice();
    return enumerate(p ? [p.handle] : [], count, out, DeviceGroup.size(), (at, h) => DeviceGroup.write(at, { count: 1, devices: [h], subsetAllocation: 0 }));
  },
  vkGetPhysicalDeviceProperties: (_c, a) => { const p = physicalOf(a.p()); writeProperties(p, a.p()); },
  vkGetPhysicalDeviceProperties2: (_c, a) => { const p = physicalOf(a.p()), at = a.p(); writeProperties(p, at + Properties2.off("properties")); writeChain(p, ldp(at + PTR)); },
  vkGetPhysicalDeviceFeatures: (_c, a) => { const p = physicalOf(a.p()); writeFeatures(p, a.p()); },
  vkGetPhysicalDeviceFeatures2: (_c, a) => { const p = physicalOf(a.p()), at = a.p(); writeFeatures(p, at + Features2.off("features")); writeChain(p, ldp(at + PTR)); },
  vkGetPhysicalDeviceMemoryProperties: (_c, a) => { const p = physicalOf(a.p()); writeMemory(p, a.p()); },
  vkGetPhysicalDeviceMemoryProperties2: (_c, a) => { const p = physicalOf(a.p()), at = a.p(); writeMemory(p, at + MemoryProperties2.off("memoryProperties")); },
  vkGetPhysicalDeviceQueueFamilyProperties: (_c, a) => { a.p(); return void enumerate([0], a.p(), a.p(), QueueFamily.size(), writeQueueFamily); },
  vkGetPhysicalDeviceQueueFamilyProperties2: (_c, a) => {
    a.p(); return void enumerate([0], a.p(), a.p(), QueueFamily2.size(), (at) => writeQueueFamily(at + QueueFamily2.off("queueFamilyProperties")));
  },
  vkGetPhysicalDeviceFormatProperties: (_c, a) => { const p = physicalOf(a.p()); writeFormat(p, a.i(), a.p()); },
  vkGetPhysicalDeviceFormatProperties2: (_c, a) => { const p = physicalOf(a.p()), format = a.i(), at = a.p(); writeFormat(p, format, at + FormatProperties2.off("formatProperties")); },
  vkGetPhysicalDeviceImageFormatProperties: (_c, a) => {
    const p = physicalOf(a.p()), format = a.i(), type = a.i(), tiling = a.i(), usage = a.i(), flags = a.i();
    return imageFormat(p, a.p(), format, type, tiling, usage, flags);
  },
  vkGetPhysicalDeviceImageFormatProperties2: (_c, a) => {
    const p = physicalOf(a.p()), info = ImageFormatInfo2.read(a.p()), out = a.p();
    const external = chain(info.pNext).get(S.EXTERNAL_IMAGE_FORMAT_INFO), handleType = external ? ExternalInfo.read(external).handleType : 0;
    if (handleType && handleType !== AHB_HANDLE) return R.FORMAT_NOT_SUPPORTED;
    const r = imageFormat(p, out + ImageFormatProperties2.off("imageFormatProperties"), info.format, info.type, info.tiling, info.usage, info.flags);
    for (const [sType, at] of chain(ldp(out + PTR))) {
      // an AHardwareBuffer image is imported and needs its dedicated allocation (exportable, importable, dedicated only)
      if (sType === S.EXTERNAL_IMAGE_FORMAT_PROPERTIES) externalProperties(at, handleType, AHB_HANDLE, 7);
      // GPU_SAMPLED_IMAGE for a sampled image, GPU_COLOR_OUTPUT for a color attachment
      else if (sType === S.AHB_USAGE) AhbUsage.write(at, { usage: (info.usage & 0x4 ? 1 << 8 : 0) | (info.usage & 0x10 ? 1 << 9 : 0) });
      else if (sType === S.YCBCR_IMAGE_FORMAT_PROPERTIES) Words.write(at, { v: [1] });
    }
    return r;
  },
  vkGetPhysicalDeviceSparseImageFormatProperties: (_c, a) => { a.p(); a.i(); a.i(); a.i(); a.i(); a.i(); mem.st32(a.p(), 0); },
  vkGetPhysicalDeviceSparseImageFormatProperties2: (_c, a) => { a.p(); a.p(); mem.st32(a.p(), 0); },
  vkGetPhysicalDeviceExternalBufferProperties: (_c, a) => { a.p(); const info = a.p(), out = a.p(); externalProperties(out, ExternalBufferInfo.read(info).handleType, AHB_HANDLE, 7); },
  vkGetPhysicalDeviceExternalSemaphoreProperties: (_c, a) => { a.p(); const info = a.p(), out = a.p(); externalProperties(out, ExternalInfo.read(info).handleType, SYNC_FD, 3); },
  vkGetPhysicalDeviceExternalFenceProperties: (_c, a) => { a.p(); const info = a.p(), out = a.p(); externalProperties(out, ExternalInfo.read(info).handleType, SYNC_FD, 3); },
};
