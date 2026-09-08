import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { linkInit, vcall } from "./jlang";
import "./jutil";
import "./jreflect";

test("Arrays.asList returns a linked Serializable list backed by its array", async () => {
  await linkInit("java/lang/Class");
  const arrays = (await linkInit("java/util/Arrays")).ctor;
  const values = ["first", "second"];
  const list = await vcall(arrays, "asList", "([Ljava/lang/Object;)Ljava/util/List;", values);
  expect(await vcall(rt.classFor("java/io/Serializable"), "isInstance", "(Ljava/lang/Object;)Z", list)).toBe(1);
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 0)).toBe("first");
  await vcall(list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 0, "updated");
  expect(values[0]).toBe("updated");
  values[1] = "changed";
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 1)).toBe("changed");
});
