// JavaVM + JNIEnv function tables in guest memory, the object-handle tables, and the marshalling
// between guest natives (AAPCS words) and the JVM's value model.

import type { Cpu } from "./cpu";

export function jniInit(): void { throw new Error("TODO jniInit"); }
export const javaVM = { addr: 0 };
export function envFor(_cpu: Cpu): number { throw new Error("TODO envFor"); }
export function toRef(_o: unknown): number { throw new Error("TODO toRef"); }
export function newGlobalRef(_o: unknown): number { throw new Error("TODO newGlobalRef"); }
export function deref(_h: number): unknown { throw new Error("TODO deref"); }
export function pushFrame(): void { throw new Error("TODO pushFrame"); }
export function popFrame(): void { throw new Error("TODO popFrame"); }
export const jniMissing = new Set<string>();
export interface Registered { cls: string; name: string; sig: string; fn: number; isStatic: boolean }
export const registered: Registered[] = [];
export function callGuestNative(_cpu: Cpu, _r: Registered, _self: unknown, _args: unknown[]): Promise<unknown> {
  throw new Error("TODO callGuestNative");
}
export const jniTrace = { on: false };
