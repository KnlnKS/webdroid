// SPIR-V to WGSL for one entry point of a shader module. Types, constants and resources become WGSL
// declarations; functions keep their structure, each result a `let` (or a function-scope `var` where
// a later block uses it, as OpPhi results are), and structured control flow becomes if, switch and
// loop statements. Interface variables are private variables an entry function fills from its
// parameters, calls the SPIR-V entry with, and returns. A vertex position's Y can be negated
// (webdroid_flip_y) for a viewport of positive height, whose +Y points down where WebGPU's points up.
// Push constants are a read-only storage buffer at PUSH_BINDING of the group the pipeline layout gives
// them, laid out as std430 is.

import { O, str } from "./module.ts";
import { Translator } from "./layout.ts";
import { partition, reach, emitFunction } from "./cfg.ts";
import { analyze, declarations, entryWrapper, type Resource, type Stage } from "./interface.ts";

export { PUSH_BINDING, type Resource, type Stage } from "./interface.ts";
export interface Translation { code: string; entry: string; resources: Resource[] }

const MODEL: Record<Stage, number> = { vertex: 0, fragment: 4, compute: 5 };

export function translate(words: Uint32Array, entry: string, stage: Stage, spec: Map<number, number[]>, pushGroup: number): Translation {
  const t = new Translator(words, spec);
  const ep = t.insts.find((i) => i.op === O.EntryPoint && i.w[0] === MODEL[stage] && str(i.w, 2) === entry);
  if (!ep) throw new Error(`SPIR-V: no ${stage} entry point ${entry}`);
  const epFn = ep.w[1];
  const { fns, globals } = partition(t);
  const reached = reach(fns, epFn);
  const used = analyze(t, fns, globals, reached, ep);
  t.defineConstants();
  const { decls, resources, inputs, outputs } = declarations(t, globals, used, pushGroup);
  const body = [...reached].reverse().map((id) => emitFunction(t, fns.get(id)!));
  const wrapper = entryWrapper(t, stage, epFn, inputs, outputs);
  const head = [...(t.hasF16() ? ["f16"] : []), ...wrapper.enables].map((e) => `enable ${e};`);
  head.push("diagnostic(off, derivative_uniformity);");
  if (stage === "vertex") head.push("override webdroid_flip_y: bool = false;");
  return { code: [...head, ...t.structs(), ...decls, ...body, wrapper.code].join("\n"), entry: "webdroid_main", resources };
}
