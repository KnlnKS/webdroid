import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { boxInt, newObj, vcall } from "./jlang";
import { mkMethod } from "./jreflect";
import "./jinvoke";

test("unreflectSpecial invokes the declaring implementation on a bound receiver", async () => {
  const owner = rt.link("java/lang/Object");
  const method = mkMethod(owner, "plus", "(I)I", false, function (this: { base: number }, n: number) {
    return this.base + n;
  });
  const cls = rt.classFor(owner.name);
  const lookup = await newObj("java/lang/invoke/MethodHandles$Lookup", "(Ljava/lang/Class;I)V", cls, -1);
  const direct = await vcall(lookup, "unreflectSpecial", "(Ljava/lang/reflect/Method;Ljava/lang/Class;)Ljava/lang/invoke/MethodHandle;", method, cls);
  const bound = await vcall(direct, "bindTo", "(Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;", { base: 7 });
  const result = await vcall(bound, "invokeWithArguments", "([Ljava/lang/Object;)Ljava/lang/Object;", [boxInt(5)]);
  expect(result.v).toBe(12);
  expect(rt.link("java/lang/invoke/MethodHandles$Lookup").stub).toBe(false);
});
