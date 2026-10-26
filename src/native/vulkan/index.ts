// libvulkan.so: the loader and the driver in one, over the host's WebGPU. Every Vulkan 1.0 and 1.1
// command and those of the advertised extensions resolve, as a loader's must for an application that
// loads them all; one this driver cannot carry out reports itself when called and fails.

import { hostLib, lookupHost, calledMissing, type HostFn } from "../host.ts";
import { INSTANCE, R } from "./instance.ts";
import { DEVICE } from "./device.ts";
import { PIPELINE } from "./pipeline.ts";
import { COMMANDS } from "./commands.ts";
import { SYNC } from "./submit.ts";

const CORE = `vkCreateInstance vkDestroyInstance vkEnumeratePhysicalDevices vkGetPhysicalDeviceFeatures vkGetPhysicalDeviceFormatProperties
  vkGetPhysicalDeviceImageFormatProperties vkGetPhysicalDeviceProperties vkGetPhysicalDeviceQueueFamilyProperties vkGetPhysicalDeviceMemoryProperties
  vkGetInstanceProcAddr vkGetDeviceProcAddr vkCreateDevice vkDestroyDevice vkEnumerateInstanceExtensionProperties vkEnumerateDeviceExtensionProperties
  vkEnumerateInstanceLayerProperties vkEnumerateDeviceLayerProperties vkGetDeviceQueue vkQueueSubmit vkQueueWaitIdle vkDeviceWaitIdle vkAllocateMemory
  vkFreeMemory vkMapMemory vkUnmapMemory vkFlushMappedMemoryRanges vkInvalidateMappedMemoryRanges vkGetDeviceMemoryCommitment vkBindBufferMemory
  vkBindImageMemory vkGetBufferMemoryRequirements vkGetImageMemoryRequirements vkGetImageSparseMemoryRequirements
  vkGetPhysicalDeviceSparseImageFormatProperties vkQueueBindSparse vkCreateFence vkDestroyFence vkResetFences vkGetFenceStatus vkWaitForFences
  vkCreateSemaphore vkDestroySemaphore vkCreateQueryPool vkDestroyQueryPool vkGetQueryPoolResults vkCreateBuffer vkDestroyBuffer vkCreateImage
  vkDestroyImage vkGetImageSubresourceLayout vkCreateImageView vkDestroyImageView vkCreateCommandPool vkDestroyCommandPool vkResetCommandPool
  vkAllocateCommandBuffers vkFreeCommandBuffers vkBeginCommandBuffer vkEndCommandBuffer vkResetCommandBuffer vkCmdCopyBuffer vkCmdCopyImage
  vkCmdCopyBufferToImage vkCmdCopyImageToBuffer vkCmdUpdateBuffer vkCmdFillBuffer vkCmdPipelineBarrier vkCmdBeginQuery vkCmdEndQuery
  vkCmdResetQueryPool vkCmdWriteTimestamp vkCmdCopyQueryPoolResults vkCmdExecuteCommands vkCreateEvent vkDestroyEvent vkGetEventStatus vkSetEvent
  vkResetEvent vkCreateBufferView vkDestroyBufferView vkCreateShaderModule vkDestroyShaderModule vkCreatePipelineCache vkDestroyPipelineCache
  vkGetPipelineCacheData vkMergePipelineCaches vkCreateComputePipelines vkDestroyPipeline vkCreatePipelineLayout vkDestroyPipelineLayout
  vkCreateSampler vkDestroySampler vkCreateDescriptorSetLayout vkDestroyDescriptorSetLayout vkCreateDescriptorPool vkDestroyDescriptorPool
  vkResetDescriptorPool vkAllocateDescriptorSets vkFreeDescriptorSets vkUpdateDescriptorSets vkCmdBindPipeline vkCmdBindDescriptorSets
  vkCmdClearColorImage vkCmdDispatch vkCmdDispatchIndirect vkCmdSetEvent vkCmdResetEvent vkCmdWaitEvents vkCmdPushConstants
  vkCreateGraphicsPipelines vkCreateFramebuffer vkDestroyFramebuffer vkCreateRenderPass vkDestroyRenderPass vkGetRenderAreaGranularity
  vkCmdSetViewport vkCmdSetScissor vkCmdSetLineWidth vkCmdSetDepthBias vkCmdSetBlendConstants vkCmdSetDepthBounds vkCmdSetStencilCompareMask
  vkCmdSetStencilWriteMask vkCmdSetStencilReference vkCmdBindIndexBuffer vkCmdBindVertexBuffers vkCmdDraw vkCmdDrawIndexed vkCmdDrawIndirect
  vkCmdDrawIndexedIndirect vkCmdBlitImage vkCmdClearDepthStencilImage vkCmdClearAttachments vkCmdResolveImage vkCmdBeginRenderPass
  vkCmdNextSubpass vkCmdEndRenderPass vkEnumerateInstanceVersion vkBindBufferMemory2 vkBindImageMemory2 vkGetDeviceGroupPeerMemoryFeatures
  vkCmdSetDeviceMask vkEnumeratePhysicalDeviceGroups vkGetImageMemoryRequirements2 vkGetBufferMemoryRequirements2
  vkGetImageSparseMemoryRequirements2 vkGetPhysicalDeviceFeatures2 vkGetPhysicalDeviceProperties2 vkGetPhysicalDeviceFormatProperties2
  vkGetPhysicalDeviceImageFormatProperties2 vkGetPhysicalDeviceQueueFamilyProperties2 vkGetPhysicalDeviceMemoryProperties2
  vkGetPhysicalDeviceSparseImageFormatProperties2 vkTrimCommandPool vkGetDeviceQueue2 vkGetPhysicalDeviceExternalBufferProperties
  vkGetPhysicalDeviceExternalFenceProperties vkGetPhysicalDeviceExternalSemaphoreProperties vkCmdDispatchBase vkCreateDescriptorUpdateTemplate
  vkDestroyDescriptorUpdateTemplate vkUpdateDescriptorSetWithTemplate vkGetDescriptorSetLayoutSupport vkCreateSamplerYcbcrConversion
  vkDestroySamplerYcbcrConversion
  vkGetSemaphoreFdKHR vkImportSemaphoreFdKHR vkGetAndroidHardwareBufferPropertiesANDROID vkGetMemoryAndroidHardwareBufferANDROID`.trim().split(/\s+/);
/** the extension names of commands Vulkan 1.1 promoted, which an application may load by either name */
const PROMOTED = `vkGetPhysicalDeviceFeatures2 vkGetPhysicalDeviceProperties2 vkGetPhysicalDeviceFormatProperties2
  vkGetPhysicalDeviceImageFormatProperties2 vkGetPhysicalDeviceQueueFamilyProperties2 vkGetPhysicalDeviceMemoryProperties2
  vkGetPhysicalDeviceSparseImageFormatProperties2 vkGetPhysicalDeviceExternalBufferProperties vkGetPhysicalDeviceExternalFenceProperties
  vkGetPhysicalDeviceExternalSemaphoreProperties vkGetImageMemoryRequirements2 vkGetBufferMemoryRequirements2 vkGetImageSparseMemoryRequirements2
  vkBindBufferMemory2 vkBindImageMemory2 vkTrimCommandPool vkCreateDescriptorUpdateTemplate vkDestroyDescriptorUpdateTemplate
  vkUpdateDescriptorSetWithTemplate vkCreateSamplerYcbcrConversion vkDestroySamplerYcbcrConversion vkCreateRenderPass2`.trim().split(/\s+/);

const LIB = "libvulkan.so";
const procAddr: HostFn = (_c, a) => { a.p(); return lookupHost(a.str(), LIB) ?? 0; };
export function vulkanInit(): void {
  const fns: Record<string, HostFn> = { ...INSTANCE, ...DEVICE, ...PIPELINE, ...COMMANDS, ...SYNC, vkGetInstanceProcAddr: procAddr, vkGetDeviceProcAddr: procAddr };
  for (const name of CORE) {
    fns[name] ??= () => {
      calledMissing.add(`${LIB}!${name}`);
      console.warn("[vulkan] unimplemented", name);
      return R.FEATURE_NOT_PRESENT;
    };
  }
  for (const name of PROMOTED) fns[name + "KHR"] = fns[name];
  hostLib(LIB, fns, { closed: true });
}
