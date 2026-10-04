import type { MethodInfo } from "./program";

/** a method's identity across the program, the key of intrinsics and native bindings: "cls.name+descriptor" */
export const mid = (m: MethodInfo) => m.cls + "." + m.key;
