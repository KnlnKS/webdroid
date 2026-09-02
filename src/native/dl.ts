// The dynamic linker: module table, global symbol scope (modules, then host libs, then logging
// stubs), dlopen/dlsym over virtual host libs and APK-shipped libraries, exidx lookup for the
// guest's own unwinder.

import type { Module } from "./elf";

export const modules: Module[] = [];
export function loadModule(_basename: string, _bytes?: Uint8Array): Promise<Module> { throw new Error("TODO loadModule"); }
export function resolveGlobal(_sym: string, _weak: boolean, _from: Module): number { throw new Error("TODO resolveGlobal"); }
export function moduleOf(_pc: number): Module | null { throw new Error("TODO moduleOf"); }
export function symbolizePc(_pc: number): string { throw new Error("TODO symbolizePc"); }
export function dlInit(): void { throw new Error("TODO dlInit"); }
