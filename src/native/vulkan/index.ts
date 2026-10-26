// libvulkan.so: the loader and the driver in one, over the host's WebGPU. Every Vulkan 1.0 and 1.1
// command and those of the advertised extensions resolve, as a loader's must for an application that
// loads them all; one this driver cannot carry out reports itself when called and fails.

import { hostLib, hostData, lookupHost, missingStub, type HostFn } from "../host.ts";
import { R } from "./vk.ts";
import { INSTANCE } from "./instance.ts";
import { DEVICE } from "./device.ts";
import { PIPELINE } from "./pipeline.ts";
import { COMMANDS } from "./commands.ts";
import { SYNC } from "./submit.ts";
import { SWAPCHAIN } from "./swapchain.ts";

/** the Vulkan 1.1 commands the modules above leave out: queries, texel buffer views, device
 *  groups (VK_KHR_swapchain's among them) and descriptor update templates */
const UNIMPLEMENTED = `vkCreateQueryPool vkDestroyQueryPool vkGetQueryPoolResults vkCmdBeginQuery vkCmdEndQuery vkCmdResetQueryPool
  vkCmdWriteTimestamp vkCmdCopyQueryPoolResults vkCreateBufferView vkDestroyBufferView
  vkGetDeviceGroupPeerMemoryFeatures vkCmdDispatchBase vkCreateDescriptorUpdateTemplate vkDestroyDescriptorUpdateTemplate
  vkUpdateDescriptorSetWithTemplate vkGetDeviceGroupPresentCapabilitiesKHR vkGetDeviceGroupSurfacePresentModesKHR
  vkGetPhysicalDevicePresentRectanglesKHR vkAcquireNextImage2KHR`.trim().split(/\s+/);
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
  hostLib(LIB, { ...INSTANCE, ...DEVICE, ...PIPELINE, ...COMMANDS, ...SYNC, ...SWAPCHAIN, vkGetInstanceProcAddr: procAddr, vkGetDeviceProcAddr: procAddr }, { closed: true });
  for (const name of UNIMPLEMENTED) hostData(LIB, name, missingStub(`${LIB}!${name}`, R.FEATURE_NOT_PRESENT));
  for (const name of PROMOTED) hostData(LIB, name + "KHR", lookupHost(name, LIB)!);
}
