import { expect, test } from "bun:test";
import "./natives/jlang";
import "./natives/jreflect";
import { rt, JObj } from "./runtime";
import { vcall } from "./natives/jlang";

test("reflected fields begin inaccessible and retain per-object accessibility overrides", async () => {
  rt.link("java/lang/reflect/Field");
  rt.register({ name: "test/FieldAccess", ctor: class extends JObj { value = "payload"; }, fields: { value: "value" } });
  const cls = rt.classFor("test/FieldAccess"), first = await vcall(cls, "getDeclaredField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", "value");
  const second = await vcall(cls, "getDeclaredField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", "value");
  expect(await vcall(first, "isAccessible", "()Z")).toBe(0);
  await vcall(first, "setAccessible", "(Z)V", 1);
  expect(await vcall(first, "isAccessible", "()Z")).toBe(1);
  expect(await vcall(second, "isAccessible", "()Z")).toBe(0);
  await vcall(first, "setAccessible", "(Z)V", 0);
  expect(await vcall(first, "isAccessible", "()Z")).toBe(0);
});
