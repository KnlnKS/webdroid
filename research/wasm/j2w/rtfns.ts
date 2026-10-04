// Functions the generated code calls through table slots like any method: the class model's runtime (classes.ts) and the per-class allocators.
// A definition is registered by name; World.synthSlot gives it a slot with a lazy-link stub and compiles it with Compiler.buildSynthetic on first call.
import type { Code } from "./code";
import type { Kind } from "./program";
import type { Compiler } from "./j2w";

export interface Synth { params: Kind[]; ret: Kind | "V"; body: (cx: Compiler, c: Code) => void }
export const rtfns = new Map<string, Synth>();
/** registers the runtime function `name` */
export const rt = (name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void) => rtfns.set(name, { params, ret, body });
