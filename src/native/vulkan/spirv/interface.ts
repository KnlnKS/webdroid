// An entry point's interface: the globals its functions use and what the uses say of them, their
// declarations as WGSL resources and private variables, and the entry function that fills the
// interface variables from its parameters, calls the SPIR-V entry and returns its outputs.

import { D, O, SC, operandIds, str, type Inst } from "./module.ts";
import type { Translator } from "./layout.ts";
import type { Fn } from "./cfg.ts";

export type Stage = "vertex" | "fragment" | "compute";
export interface Resource { set: number; binding: number; kind: "buffer" | "texture" | "sampler" | "combined" | "storage" | "push" }
/** the WGSL binding of push constants: past those of Vulkan bindings below 499 (2b and 2b + 1), under maxBindingsPerBindGroup */
export const PUSH_BINDING = 999;
interface Variable { id: number; type: number }

const BUILTIN: Record<number, [string, string]> = {
  0: ["position", "vec4<f32>"], 15: ["position", "vec4<f32>"], 17: ["front_facing", "bool"], 18: ["sample_index", "u32"], 20: ["sample_mask", "u32"],
  22: ["frag_depth", "f32"], 24: ["num_workgroups", "vec3<u32>"], 26: ["workgroup_id", "vec3<u32>"], 27: ["local_invocation_id", "vec3<u32>"],
  28: ["global_invocation_id", "vec3<u32>"], 29: ["local_invocation_index", "u32"], 42: ["vertex_index", "u32"], 43: ["instance_index", "u32"],
  3: ["clip_distances", ""], 36: ["subgroup_size", "u32"], 41: ["subgroup_invocation_id", "u32"],
};
const POINT_SIZE = 1, CULL_DISTANCE = 4;
/** a storage image variable's access */
const accessOf = (t: Translator, id: number) => t.dec(id, D.NonReadable) ? "write" : t.dec(id, D.NonWritable) ? "read" : "read_write";

/** the globals the reached functions and the entry point's interface use, and what the uses say of them: atomics, depth
 *  comparisons, storage images' access */
export function analyze(t: Translator, fns: Map<number, Fn>, globals: Inst[], reached: Set<number>, ep: Inst): Set<number> {
  const used = new Set<number>(), globalIds = new Set(globals.map((g) => g.w[1]));
  const roots = new Map<number, number>();                                       // pointer → the variable it points into
  for (const id of reached) for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) {
    for (const a of operandIds(i)) if (globalIds.has(a)) used.add(a);
    if (i.op === O.AccessChain || i.op === O.InBoundsAccessChain) roots.set(i.w[1], roots.get(i.w[2]) ?? i.w[2]);
    if (i.op === O.Load) t.sources.set(i.w[1], roots.get(i.w[2]) ?? i.w[2]);
    if (i.op === O.SampledImage || i.op === O.Image || i.op === O.CopyObject) t.sources.set(i.w[1], t.sources.get(i.w[2]) ?? -1);
  }
  for (const id of ep.w.subarray(3 + Math.ceil((str(ep.w, 2).length + 1) / 4))) used.add(id);
  for (const id of reached) for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) {
    if (i.op === O.ImageSampleDrefImplicitLod || i.op === O.ImageSampleDrefExplicitLod || i.op === O.ImageDrefGather) {
      const si = b.insts.find((s) => s.op === O.SampledImage && s.w[1] === i.w[2]);
      t.depthVars.add(t.sources.get(i.w[2]) ?? -1);
      if (si) t.depthVars.add(t.sources.get(si.w[3]) ?? -1);
    }
    if (i.op >= O.AtomicLoad && i.op <= O.AtomicXor) markAtomic(t, i.op === O.AtomicStore ? i.w[0] : i.w[2], fns);
  }
  for (const g of globals) {
    const ty = t.pointee(g.w[0]), it = t.type(ty);
    if (used.has(g.w[1]) && g.w[2] === SC.UniformConstant && it.k === "image" && it.usage === 2) t.storageAccess.set(ty, accessOf(t, g.w[1]));
  }
  return used;
}
function markAtomic(t: Translator, ptr: number, fns: Map<number, Fn>): void {
  // the access chain into the variable decides what is atomic: a struct member or an array's elements
  for (const f of fns.values()) for (const b of f.blocks.values()) for (const i of b.insts) {
    if ((i.op !== O.AccessChain && i.op !== O.InBoundsAccessChain) || i.w[1] !== ptr) continue;
    let ty = t.pointee(t.resultType.get(i.w[2])!);
    const idx = [...i.w.subarray(3)];
    for (let k = 0; k < idx.length; k++) {
      const tt = t.type(ty);
      if (k === idx.length - 1) {
        if (tt.k === "struct") {
          const members = t.atomicMembers.get(ty) ?? new Set<number>();
          t.atomicMembers.set(ty, members.add(t.constValue(idx[k])));
        } else if (tt.k === "array") t.atomicArrays.add(ty);
        return;
      }
      ty = tt.k === "struct" ? tt.members[t.constValue(idx[k])] : t.element(ty);
    }
    return;
  }
  throw new Error("SPIR-V: an atomic on a variable itself");
}

/** the used globals' declarations, the resources they bind and the interface variables */
export function declarations(t: Translator, globals: Inst[], used: Set<number>, pushGroup: number): { decls: string[]; resources: Resource[]; inputs: Variable[]; outputs: Variable[] } {
  const decls: string[] = [], resources: Resource[] = [], inputs: Variable[] = [], outputs: Variable[] = [];
  for (const g of globals) {
    const id = g.w[1], ty = t.pointee(g.w[0]), sc = g.w[2];
    if (!used.has(id)) continue;
    const name = `x_${id}`;
    const set = t.dec(id, D.DescriptorSet)?.[0] ?? 0, binding = t.dec(id, D.Binding)?.[0] ?? 0;
    const at = `@group(${set}) @binding(${2 * binding})`;
    const init = g.w[3] ? ` = ${t.consts.get(g.w[3])}` : "";
    if (sc === SC.Uniform || sc === SC.StorageBuffer) {
      const bufferBlock = !!t.dec(ty, D.BufferBlock);
      const readOnly = !!t.dec(id, D.NonWritable) || t.kind(ty, "struct").members.every((_, i) => t.memberDec(ty, i, D.NonWritable));
      const space = sc === SC.StorageBuffer || bufferBlock ? `storage, ${readOnly ? "read" : "read_write"}` : "uniform";
      decls.push(`${at} var<${space}> ${name}: ${t.wgsl(ty)};`);
      resources.push({ set, binding, kind: "buffer" });
    } else if (sc === SC.UniformConstant) {
      const rt = t.type(ty), depth = t.depthVars.has(id);
      if (rt.k === "sampled") {
        decls.push(`${at} var ${name}: ${t.imageType(rt.image, t.kind(rt.image, "image"), depth)};`, `@group(${set}) @binding(${2 * binding + 1}) var ${name}_s: ${depth ? "sampler_comparison" : "sampler"};`);
        resources.push({ set, binding, kind: "combined" });
      } else {
        decls.push(`${at} var ${name}: ${rt.k === "image" ? t.imageType(ty, rt, depth, accessOf(t, id)) : depth ? "sampler_comparison" : t.wgsl(ty)};`);
        resources.push({ set, binding, kind: rt.k === "sampler" ? "sampler" : rt.k === "image" && rt.usage === 2 ? "storage" : "texture" });
      }
    } else if (sc === SC.Input || sc === SC.Output) {
      (sc === SC.Input ? inputs : outputs).push({ id, type: ty });
      decls.push(`var<private> ${name}: ${t.wgsl(ty)}${init};`);
    } else if (sc === SC.PushConstant) {
      decls.push(`@group(${pushGroup}) @binding(${PUSH_BINDING}) var<storage, read> ${name}: ${t.wgsl(ty)};`);
      resources.push({ set: pushGroup, binding: PUSH_BINDING, kind: "push" });
    } else if (sc === SC.Private) decls.push(`var<private> ${name}: ${t.wgsl(ty)}${init};`);
    else if (sc === SC.Workgroup) decls.push(`var<workgroup> ${name}: ${t.wgsl(ty)};`);
    else throw new Error(`SPIR-V: storage class ${sc}`);
  }
  return { decls, resources, inputs, outputs };
}

/** the WGSL entry function, and the extensions its interface needs */
export function entryWrapper(t: Translator, stage: Stage, epFn: number, inputs: Variable[], outputs: Variable[]): { code: string; enables: Set<string> } {
  const params: string[] = [], pre: string[] = [], fields: string[] = [], post: string[] = [], enables = new Set<string>();
  let usesFlip = false;
  const interp = (id: number, ty: number) => {
    if (t.dec(id, D.Flat) || t.isInt(ty)) return " @interpolate(flat)";
    const mode = t.dec(id, D.NoPerspective) ? "linear" : "perspective", where = t.dec(id, D.Centroid) ? ", centroid" : t.dec(id, D.Sample) ? ", sample" : "";
    return mode === "perspective" && !where ? "" : ` @interpolate(${mode}${where})`;
  };
  for (const { id, type } of inputs) {
    const b = t.dec(id, D.BuiltIn)?.[0];
    if (b !== undefined) {
      const [name, wty] = BUILTIN[b] ?? [];
      if (!name) throw new Error(`SPIR-V: input builtin ${b}`);
      const have = t.wgsl(type);
      params.push(`@builtin(${name}) p_${id}: ${wty}`);
      if (b === 20) pre.push(`x_${id}[0] = ${have.includes("i32") ? `bitcast<i32>(p_${id})` : `p_${id}`};`);
      else pre.push(`x_${id} = ${have === wty ? `p_${id}` : `bitcast<${have}>(p_${id})`};`);
      continue;
    }
    const loc = t.dec(id, D.Location)?.[0];
    if (loc === undefined) throw new Error("SPIR-V: an input without a location");
    params.push(`@location(${loc})${stage === "fragment" ? interp(id, type) : ""} p_${id}: ${t.wgsl(type)}`);
    pre.push(`x_${id} = p_${id};`);
  }
  for (const { id, type } of outputs) {
    const st = t.type(type);
    // a block of builtins, as glslang writes gl_PerVertex
    if (st.k === "struct" && st.members.some((_, i) => t.memberDec(type, i, D.BuiltIn))) {
      st.members.forEach((m, i) => {
        const b = t.memberDec(type, i, D.BuiltIn)?.[0];
        if (b === 0) { fields.push(`@builtin(position) o_${id}_${i}: vec4<f32>,`); post.push(`out.o_${id}_${i} = x_${id}.m${i};`); usesFlip = true; post.push(`if (webdroid_flip_y) { out.o_${id}_${i}.y = -out.o_${id}_${i}.y; }`); }
        else if (b === 3 && t.kind(m, "array").len) { enables.add("clip_distances"); fields.push(`@builtin(clip_distances) o_${id}_${i}: ${t.wgsl(m)},`); post.push(`out.o_${id}_${i} = x_${id}.m${i};`); }
      });
      continue;
    }
    const b = t.dec(id, D.BuiltIn)?.[0];
    if (b === POINT_SIZE || b === CULL_DISTANCE) continue;
    if (b !== undefined) {
      const [name, wty] = BUILTIN[b] ?? [];
      if (!name) throw new Error(`SPIR-V: output builtin ${b}`);
      if (b === 3) { enables.add("clip_distances"); fields.push(`@builtin(clip_distances) o_${id}: ${t.wgsl(type)},`); post.push(`out.o_${id} = x_${id};`); continue; }
      fields.push(`@builtin(${name}) o_${id}: ${wty},`);
      if (b === 20) post.push(`out.o_${id} = ${t.wgsl(type).includes("i32") ? `bitcast<u32>(x_${id}[0])` : `x_${id}[0]`};`);
      else post.push(`out.o_${id} = ${t.wgsl(type) === wty ? `x_${id}` : `bitcast<${wty}>(x_${id})`};`);
      if (b === 0 && stage === "vertex") { usesFlip = true; post.push(`if (webdroid_flip_y) { out.o_${id}.y = -out.o_${id}.y; }`); }
      continue;
    }
    const loc = t.dec(id, D.Location)?.[0], index = t.dec(id, D.Index)?.[0];
    if (loc === undefined) throw new Error("SPIR-V: an output without a location");
    if (index) enables.add("dual_source_blending");
    fields.push(`@location(${loc})${index !== undefined && stage === "fragment" ? ` @blend_src(${index})` : ""}${stage === "vertex" ? interp(id, type) : ""} o_${id}: ${t.wgsl(type)},`);
    post.push(`out.o_${id} = x_${id};`);
  }
  if (stage === "vertex" && !usesFlip) pre.push("_ = webdroid_flip_y;");
  let attr = `@${stage}`;
  if (stage === "compute") {
    const size = t.insts.find((i) => i.op === O.ExecutionMode && i.w[0] === epFn && i.w[1] === 17);
    const builtin = [...t.decorations].find(([, d]) => d.get(D.BuiltIn)?.[0] === 25)?.[0];
    const dims = builtin !== undefined ? (t.consts.get(builtin) ?? "").replace(/^vec3<u32>\(|\)$/g, "") : size ? `${size.w[2]}, ${size.w[3]}, ${size.w[4]}` : "1, 1, 1";
    attr += ` @workgroup_size(${dims})`;
  }
  const call = `  f_${epFn}();`, prelude = pre.map((p) => `  ${p}`).join("\n");
  if (!fields.length) return { code: `${attr} fn webdroid_main(${params.join(", ")}) {\n${prelude}\n${call}\n}`, enables };
  return { code: `struct WebdroidOut {\n${fields.map((f) => `  ${f}`).join("\n")}\n}\n${attr} fn webdroid_main(${params.join(", ")}) -> WebdroidOut {\n${prelude}\n${call}\n  var out: WebdroidOut;\n${post.map((p) => `  ${p}`).join("\n")}\n  return out;\n}`, enables };
}
