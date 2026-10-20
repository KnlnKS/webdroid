// Tests' calls into host functions by name: a library's, or the kernel's that a 64-bit process reaches without an HLE libc.
import type { Cpu } from "./cpu.ts";
import { defineHost, lookupHost } from "./host.ts";
import { KERNEL_SYSCALLS as KERNEL } from "./syscall.ts";

const slots = new Map<string, number>();
export const kernel = (name: string): number => { let at = slots.get(name); if (at === undefined) slots.set(name, (at = defineHost(name, KERNEL[name]))); return at; };
export const kernelCalls = (cpu: Cpu) => (name: string, ...args: number[]) => cpu.call(kernel(name), args);
export const libCalls = (cpu: Cpu, lib: string) => (name: string, ...args: (number | bigint)[]) => cpu.call(lookupHost(name, lib)!, args);
