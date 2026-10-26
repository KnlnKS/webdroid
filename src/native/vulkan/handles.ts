// Vulkan handles: a dispatchable one (instance, physical device, device, queue, command buffer) is a
// pointer with room for the loader's dispatch table; a non-dispatchable one is a counted 64-bit value.

import { Handles } from "../handles.ts";
import { PTR } from "../host.ts";

const objects = new Handles<unknown>("vulkan");
export const dispatchable = (o: unknown): number => objects.alloc(o, 2 * PTR);
export const handle = (o: unknown): number => objects.add(o);
export const object = <T>(h: number): T => objects.get(h) as T;
export const maybe = <T>(h: number): T | undefined => objects.find(h) as T | undefined;
export const release = (h: number): void => void objects.delete(h);
