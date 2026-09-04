import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { boxInt, newObj, vcall } from "./jlang";
import { mkMethod } from "./jreflect";
import "./jinvoke";

test("unreflectSpecial invokes the declaring implementation on a bound receiver", async () => {
  const owner = rt.link("java/lang/Object");
  const method = mkMethod(owner, "plus", "(I)I", false, function (this: unknown, n: unknown) {
    if (typeof this !== "object" || this === null || !("base" in this) || typeof this.base !== "number" || typeof n !== "number")
      throw new TypeError("expected a numeric receiver and argument");
    return this.base + n;
  });
  const cls = rt.classFor(owner.name);
  const lookup = await newObj("java/lang/invoke/MethodHandles$Lookup", "(Ljava/lang/Class;I)V", cls, -1);
  const direct = await vcall(lookup, "unreflectSpecial", "(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;", method, cls);
  const receiver = new owner.ctor() as { base: number };
  receiver.base = 7;
  const bound = await vcall(direct, "bindTo", "(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;", receiver);
  const result = await vcall(bound, "invokeWithArguments", "([Ljava/lang/Object;)Ljava/lang/Object;", [boxInt(5)]);
  expect(result.v).toBe(12);
  expect(rt.link("java/lang/invoke/MethodHandles$Lookup").stub).toBe(false);
});

test("an unbound special handle consumes its receiver as the first argument", async () => {
  const owner = rt.link("java/lang/Object");
  const method = mkMethod(owner, "plus", "(I)I", false, function (this: unknown, n: unknown) {
    if (typeof this !== "object" || this === null || !("base" in this) || typeof this.base !== "number" || typeof n !== "number")
      throw new TypeError("expected a numeric receiver and argument");
    return this.base + n;
  });
  const cls = rt.classFor(owner.name);
  const lookup = await newObj("java/lang/invoke/MethodHandles$Lookup", "(Ljava/lang/Class;I)V", cls, -1);
  const direct = await vcall(lookup, "unreflectSpecial", "(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;", method, cls);
  const receiver = new owner.ctor() as { base: number };
  receiver.base = 4;
  const result = await vcall(direct, "invokeWithArguments", "([Ljava/lang/Object;)Ljava/lang/Object;", [receiver, boxInt(6)]);
  expect(result.v).toBe(10);
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
