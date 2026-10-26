// Vulkan's shared conventions: result codes, structure types and other constants, handles, pNext
// chains and the two-call enumeration idiom.

import { mem } from "../mem.ts";
import { PTR, ldp, type ArgReader } from "../host.ts";
import { Handles } from "../handles.ts";

/** VkResult */
export const R = { SUCCESS: 0, NOT_READY: 1, TIMEOUT: 2, EVENT_SET: 3, EVENT_RESET: 4, INCOMPLETE: 5, OUT_OF_HOST_MEMORY: -1, OUT_OF_DEVICE_MEMORY: -2, INITIALIZATION_FAILED: -3, DEVICE_LOST: -4, MEMORY_MAP_FAILED: -5, LAYER_NOT_PRESENT: -6, EXTENSION_NOT_PRESENT: -7, FEATURE_NOT_PRESENT: -8, FORMAT_NOT_SUPPORTED: -11, SURFACE_LOST: -1000000000, OUT_OF_DATE: -1000001004, INVALID_EXTERNAL_HANDLE: -1000072003 } as const;
/** VkStructureType */
export const S = {
  EXTERNAL_IMAGE_FORMAT_INFO: 1000071000, EXTERNAL_IMAGE_FORMAT_PROPERTIES: 1000071001, ID_PROPERTIES: 1000071004,
  EXTERNAL_IMAGE: 1000072001, EXPORT_MEMORY: 1000072002,
  STORAGE_16BIT_FEATURES: 1000083000, MULTIVIEW_FEATURES: 1000053001, MULTIVIEW_PROPERTIES: 1000053002, SHADER_DRAW_PARAMETERS_FEATURES: 1000063000,
  SUBGROUP_PROPERTIES: 1000094000, POINT_CLIPPING_PROPERTIES: 1000117000, VARIABLE_POINTERS_FEATURES: 1000120000,
  DEDICATED_REQUIREMENTS: 1000127000, AHB_USAGE: 1000129000, AHB_FORMAT_PROPERTIES: 1000129002, IMPORT_AHB: 1000129003, EXTERNAL_FORMAT: 1000129005,
  PROTECTED_MEMORY_FEATURES: 1000145001, PROTECTED_MEMORY_PROPERTIES: 1000145002,
  YCBCR_FEATURES: 1000156004, YCBCR_IMAGE_FORMAT_PROPERTIES: 1000156005, MAINTENANCE_3_PROPERTIES: 1000168000,
  DRIVER_PROPERTIES: 1000196000, EXTENDED_DYNAMIC_STATE_FEATURES: 1000267000,
} as const;
/** VkExternalMemoryHandleTypeFlagBits / VkExternalSemaphoreHandleTypeFlagBits used here */
export const AHB_HANDLE = 0x400, SYNC_FD = 0x10;
/** VK_ATTACHMENT_UNUSED, and VK_REMAINING_MIP_LEVELS / VK_REMAINING_ARRAY_LAYERS */
export const UNUSED = 0xffffffff, REMAINING = 0xffffffff;
/** maxUniformBufferRange, WebGPU's guaranteed maxUniformBufferBindingSize: a shader's uniform block is bound whole (pipeline.ts),
 *  so a uniform buffer has this much room past its end */
export const UNIFORM_RANGE = 65536;
/** VkCompareOp */
export const COMPARE: GPUCompareFunction[] = ["never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];

/** the driver's objects by handle: a dispatchable one (instance, physical device, device, queue, command buffer)
 *  is a pointer with room for the loader's dispatch table, a non-dispatchable one a counted 64-bit value */
export const objects = new Handles<object>("vulkan");
export const dispatchable = (o: object): number => objects.alloc(o, 2 * PTR);
/** a non-dispatchable handle argument */
export const nd = (a: ArgReader): number => Number(a.ul());

/** the structs chained from `pNext`, by sType: each one's address */
export function chain(pNext: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let p = pNext; p; p = ldp(p + PTR)) out.set(mem.ld32(p) >>> 0, p);
  return out;
}
/** the two-call enumeration idiom: with no array, the count; else up to *pCount items written and
 *  VK_INCOMPLETE when some did not fit */
export function enumerate<T>(items: T[], pCount: number, pItems: number, size: number, put: (at: number, item: T) => void): number {
  if (!pItems) { mem.st32(pCount, items.length); return R.SUCCESS; }
  const n = Math.min(mem.ld32(pCount) >>> 0, items.length);
  for (let i = 0; i < n; i++) put(pItems + i * size, items[i]);
  mem.st32(pCount, n);
  return n < items.length ? R.INCOMPLETE : R.SUCCESS;
}
