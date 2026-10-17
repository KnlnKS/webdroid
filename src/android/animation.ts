// android.animation runs from AOSP bytecode; this is PropertyValuesHolder's native half
// (android_animation_PropertyValuesHolder.cpp): a setter found by JNI's GetMethodID, which the
// holder then calls on its target, dispatched virtually.

import { rt, type JObj } from "../jvm/runtime.ts";
import { vcall, linkClass, after } from "../jvm/natives/jentry.ts";
import { deref, handle } from "./handles.ts";

/** a jmethodID: the virtual method `name``desc` a class has, which NoSuchMethodError reports missing */
const ids = new Map<string, bigint>();
function methodId(cls: JObj, name: string, desc: string): bigint | Promise<bigint> {
  return after(vcall(cls, "getName", "()Ljava/lang/String;"), (dotted: string) => {
    const owner = dotted.replace(/\./g, "/");
    if (!linkClass(owner).has(name, desc)) throw rt.mkThrowable("java/lang/NoSuchMethodError", `no non-static method "L${owner};.${name}${desc}"`);
    const key = name + desc;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, id = handle({ name, desc }));
    return id;
  });
}
const call = (target: object, id: bigint, ...args: unknown[]) => { const m = deref<{ name: string; desc: string }>(id); return vcall(target, m.name, m.desc, ...args); };
rt.registerJnis("android/animation/PropertyValuesHolder", {
  "nGetIntMethod(Ljava/lang/Class;Ljava/lang/String;)J": (cls: JObj, name: string) => methodId(cls, name, "(I)V"),
  "nGetFloatMethod(Ljava/lang/Class;Ljava/lang/String;)J": (cls: JObj, name: string) => methodId(cls, name, "(F)V"),
  "nGetMultipleIntMethod(Ljava/lang/Class;Ljava/lang/String;I)J": (cls: JObj, name: string, n: number) => methodId(cls, name, `(${"I".repeat(n)})V`),
  "nGetMultipleFloatMethod(Ljava/lang/Class;Ljava/lang/String;I)J": (cls: JObj, name: string, n: number) => methodId(cls, name, `(${"F".repeat(n)})V`),
  "nCallIntMethod(Ljava/lang/Object;JI)V": call,
  "nCallFloatMethod(Ljava/lang/Object;JF)V": call,
  "nCallTwoIntMethod(Ljava/lang/Object;JII)V": call,
  "nCallTwoFloatMethod(Ljava/lang/Object;JFF)V": call,
  "nCallFourIntMethod(Ljava/lang/Object;JIIII)V": call,
  "nCallFourFloatMethod(Ljava/lang/Object;JFFFF)V": call,
  "nCallMultipleIntMethod(Ljava/lang/Object;J[I)V": (target: object, id: bigint, args: Int32Array) => call(target, id, ...args),
  "nCallMultipleFloatMethod(Ljava/lang/Object;J[F)V": (target: object, id: bigint, args: Float32Array) => call(target, id, ...args),
});
