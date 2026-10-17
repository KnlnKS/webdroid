import { declaredMethod, type MethodInfo, type Program } from "./program.ts";

/** a method's identity across the program, the key of intrinsics and native bindings: "cls.name+descriptor" */
export const mid = (m: MethodInfo) => m.cls + "." + m.key;
/** the method `id` names (class names have no dots) */
export const methodOf = (prog: Program, id: string): MethodInfo | undefined => { const dot = id.indexOf("."); return declaredMethod(prog.get(id.slice(0, dot)), id.slice(dot + 1)); };
