// android.animation runs from AOSP bytecode; this is PropertyValuesHolder's native half
// (android_animation_PropertyValuesHolder.cpp): a setter found by JNI's GetMethodID, which the
// holder then calls on its target, dispatched virtually.

import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { type JClass } from "../jvm/natives/jlang";
import { deref, handle } from "./handles";

/** a jmethodID: the mangled virtual method a class has, which NoSuchMethodError reports missing */
const ids = new Map<string, bigint>();
function methodId(cls: JClass, name: string, desc: string): bigint {
  const m = mangleMethod(name, desc);
  if (typeof (cls.ci?.ctor.prototype as Record<string, unknown> | undefined)?.[m] !== "function") // js-tier
    throw rt.mkThrowable("java/lang/NoSuchMethodError", `no non-static method "L${cls.ci?.name};.${name}${desc}"`);
  let id = ids.get(m);
  if (id === undefined) ids.set(m, id = handle({ m }));
  return id;
}
const call = (target: object, id: bigint, ...args: unknown[]) =>
  (target as Record<string, (...a: unknown[]) => unknown>)[deref<{ m: string }>(id).m](...args);
rt.registerJnis("android/animation/PropertyValuesHolder", {
  "nGetIntMethod(Ljava/lang/Class;Ljava/lang/String;)J": (cls: JClass, name: string) => methodId(cls, name, "(I)V"),
  "nGetFloatMethod(Ljava/lang/Class;Ljava/lang/String;)J": (cls: JClass, name: string) => methodId(cls, name, "(F)V"),
  "nGetMultipleIntMethod(Ljava/lang/Class;Ljava/lang/String;I)J": (cls: JClass, name: string, n: number) => methodId(cls, name, `(${"I".repeat(n)})V`),
  "nGetMultipleFloatMethod(Ljava/lang/Class;Ljava/lang/String;I)J": (cls: JClass, name: string, n: number) => methodId(cls, name, `(${"F".repeat(n)})V`),
  "nCallIntMethod(Ljava/lang/Object;JI)V": call,
  "nCallFloatMethod(Ljava/lang/Object;JF)V": call,
  "nCallTwoIntMethod(Ljava/lang/Object;JII)V": call,
  "nCallTwoFloatMethod(Ljava/lang/Object;JFF)V": call,
  "nCallFourIntMethod(Ljava/lang/Object;JIIII)V": call,
  "nCallFourFloatMethod(Ljava/lang/Object;JFFFF)V": call,
  "nCallMultipleIntMethod(Ljava/lang/Object;J[I)V": (target: object, id: bigint, args: Int32Array) => call(target, id, ...args),
  "nCallMultipleFloatMethod(Ljava/lang/Object;J[F)V": (target: object, id: bigint, args: Float32Array) => call(target, id, ...args),
});
