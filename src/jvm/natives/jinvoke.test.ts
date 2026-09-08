import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { boxInt, newObj, vcall } from "./jlang";
import { mkMethod } from "./jreflect";
import "./jinvoke";

for (const bound of [true, false]) test(`${bound ? "bound" : "unbound"} special handle uses its receiver`, async () => {
  const owner = rt.link("java/lang/Object");
  const method = mkMethod(owner, "plus", "(I)I", false, function (this: { base: number }, n: unknown) {
    if (typeof n !== "number") throw new TypeError("expected an unboxed number");
    return this.base + n;
  });
  const cls = rt.classFor(owner.name);
  const lookup = await newObj("java/lang/invoke/MethodHandles$Lookup", "(Ljava/lang/Class;I)V", cls, -1);
  const direct = await vcall(lookup, "unreflectSpecial", "(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;", method, cls);
  const receiver = Object.assign(new owner.ctor(), { base: 7 });
  const handle = bound ? await vcall(direct, "bindTo", "(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;", receiver) : direct;
  const args = bound ? [boxInt(5)] : [receiver, boxInt(5)];
  const result = await vcall(handle, "invokeWithArguments", "([Ljava/lang/Object;)Ljava/lang/Object;", args);
  expect(result.v).toBe(12);
  expect(rt.link("java/lang/invoke/MethodHandles$Lookup").stub).toBe(false);
});

test("a null bound receiver fails when the instance handle is invoked", async () => {
  rt.link("java/lang/NullPointerException");
  const owner = rt.link("java/lang/Object");
  const method = mkMethod(owner, "identity", "(I)I", false, (_n: unknown) => 0);
  const cls = rt.classFor(owner.name);
  const lookup = await newObj("java/lang/invoke/MethodHandles$Lookup", "(Ljava/lang/Class;I)V", cls, -1);
  const direct = await vcall(lookup, "unreflectSpecial", "(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;", method, cls);
  const bound = await vcall(direct, "bindTo", "(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;", null);
  try {
    await vcall(bound, "invokeWithArguments", "([Ljava/lang/Object;)Ljava/lang/Object;", [boxInt(1)]);
    throw new Error("expected a null receiver failure");
  } catch (error) {
    const name = (error as { constructor: { $i?: { name?: string } } }).constructor.$i?.name;
    expect(name).toBe("java/lang/NullPointerException");
  }
});
