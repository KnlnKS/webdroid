// Functions the generated code calls through table slots like any method: the class model's runtime (classes.ts) and the per-class allocators.
// A definition is registered by name; World.synthSlot gives it a slot with a lazy-link stub and compiles it with Compiler.buildSynthetic on first call.
import type { Code } from "./code.ts";
import type { Kind } from "./program.ts";
import type { Compiler } from "./j2w.ts";

export interface Synth { params: Kind[]; ret: Kind | "V"; body: (cx: Compiler, c: Code) => void; pure?: boolean }
export const rtfns = new Map<string, Synth>();
/** registers the runtime function `name`; a pure one runs no Java code, which the compiler counts on to leave frames that call only such functions out of the depth */
export const rt = (name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, pure = false) => rtfns.set(name, { params, ret, body, pure });
