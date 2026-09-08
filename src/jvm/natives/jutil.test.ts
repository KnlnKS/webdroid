import { expect, test } from "bun:test";
import { JObj, rt } from "../runtime";
import { linkInit, newObj, vcall } from "./jlang";
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

test("Map.compute receives old values, removes null results and preserves values on failure", async () => {
  let result: unknown = "initial", fail = false;
  const seen: unknown[] = [];
  rt.register({ name: "webdroid/ComputeFunction", ctor: class extends JObj {}, ifaces: ["java/util/function/BiFunction"], methods: {
    "apply(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": (_key: unknown, old: unknown) => {
      seen.push(old); if (fail) throw new Error("failed remapping"); return result;
    },
  } });
  const fn = await newObj("webdroid/ComputeFunction", null);
  for (const cls of ["java/util/HashMap", "java/util/concurrent/ConcurrentHashMap"]) {
    const map = await newObj(cls);
    result = "initial"; fail = false;
    expect(await vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).toBe("initial");
    expect(seen.at(-1)).toBeNull();
    fail = true;
    await expect(vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).rejects.toThrow("failed remapping");
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key")).toBe("initial");
    fail = false; result = null;
    expect(await vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).toBeNull();
    expect(seen.at(-1)).toBe("initial");
    expect(await vcall(map, "containsKey", "(Ljava/lang/Object;)Z", "key")).toBe(0);
  }
});
