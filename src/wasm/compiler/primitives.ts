// The primitive types' wrapper classes and the widening the language allows between them.
import type { Code } from "./code.ts";
import type { Compiler } from "./j2w.ts";

/** the field letters a value of each type may be assigned to, which is also what a get of each may be read as */
export const WIDEN: Record<string, string> = { Z: "Z", B: "BSIJFD", C: "CIJFD", S: "SIJFD", I: "IJFD", J: "JFD", F: "FD", D: "D" };
/** each primitive's wrapper class and the accessor that unwraps it */
export const BOX: Record<string, [string, string, string]> = {
  Z: ["java/lang/Boolean", "booleanValue", "()Z"], B: ["java/lang/Byte", "byteValue", "()B"], C: ["java/lang/Character", "charValue", "()C"],
  S: ["java/lang/Short", "shortValue", "()S"], I: ["java/lang/Integer", "intValue", "()I"], J: ["java/lang/Long", "longValue", "()J"],
  F: ["java/lang/Float", "floatValue", "()F"], D: ["java/lang/Double", "doubleValue", "()D"],
};

/** pushes the wrapper of the primitive `desc` on the stack (valueOf) */
export function box(cx: Compiler, c: Code, desc: string): void {
  const [cls] = BOX[desc];
  cx.emitEnsure(c, cls);
  cx.callMethod(c, cx.prog.resolve(cls, "valueOf", `(${desc})L${cls};`)!);
}
/** replaces the (non-null) wrapper on the stack by its primitive value */
export function unbox(cx: Compiler, c: Code, desc: string): void {
  const [cls, name, d] = BOX[desc];
  cx.callMethod(c, cx.prog.resolve(cls, name, d)!);
}
