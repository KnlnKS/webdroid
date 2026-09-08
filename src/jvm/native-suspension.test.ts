import { expect, test } from "bun:test";
import { Runtime, JObj, rt, maySuspend } from "./runtime";
import { mangleMethod } from "./abi";
import "./natives/jutil";

test("conditional suspension declarations preserve immediate returns and reach the oracle and audit", async () => {
  const runtime = new Runtime();
  runtime.auditNatives = true;
  const conditional = (wait: number) => wait ? Promise.resolve(42) : 17;
  expect(maySuspend(conditional)).toBe(conditional);
  runtime.register({ name: "java/lang/Object", ctor: class {} });
  runtime.register({
    name: "test/ConditionalNative", ctor: class {},
    clinit: maySuspend(() => undefined),
    methods: { "value(Z)I": conditional, "undeclared()I": () => Promise.resolve(3) },
  });
  const info = runtime.link("test/ConditionalNative"), object = new info.ctor();
  const value = object[mangleMethod("value", "(Z)I")];
  expect(value).toBe(conditional);
  expect(value(0)).toBe(17);
  expect(await value(1)).toBe(42);
  expect(runtime.nativeOracle()(info.name, "value(Z)I")).toBe(true);
  expect(runtime.nativeOracle()(info.name, "<clinit>()V")).toBe(true);
  expect(runtime.nativeLiars.size).toBe(0);
  await object[mangleMethod("undeclared", "()I")]();
  expect([...runtime.nativeLiars]).toEqual(["test/ConditionalNative undeclared()I"]);
});

test("map puts keep the immediate primitive-key path while custom equality can suspend", async () => {
  rt.register({
    name: "test/SuspendingMapKey", ctor: class extends JObj {},
    methods: { "equals(Ljava/lang/Object;)Z": async () => 1 },
  });
  const Key = rt.link("test/SuspendingMapKey").ctor;
  const map = new (rt.link("java/util/LinkedHashMap").ctor)();
  const signature = "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;";
  const put = map[mangleMethod("put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;")];
  expect(put.call(map, "key", 1)).toBeNull();
  expect(put.call(map, "key", 2)).toBe(1);
  const first = put.call(map, new Key(), 3);
  expect(first).toBeInstanceOf(Promise);
  expect(await first).toBeNull();
  expect(await put.call(map, new Key(), 4)).toBe(3);
  expect(rt.nativeOracle()("java/util/LinkedHashMap", signature)).toBe(true);
});
