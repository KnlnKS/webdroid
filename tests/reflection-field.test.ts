import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { JField } from "../src/jvm/natives/jreflect";
import { vcall, newObj, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";

class Fields extends JObj { value: number | bigint = 0; static value: number | bigint = 0; }
rt.register({ name: "test/PrimitiveFields", ctor: Fields });
rt.linkNatives();
const owner = rt.link("test/PrimitiveFields");
const field = (desc: string, isStatic = false) => Object.assign(new JField(), { owner, prop: "value", desc, isStatic });

test("concurrent proxy creation shares classes without crossing interface sets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    input === "/vendor/aosp/framework.jar"
      ? Promise.resolve(new Response(Bun.file(new URL("../vendor/aosp/framework.jar", import.meta.url))))
      : originalFetch(input, init), { preconnect: originalFetch.preconnect });
  try {
    const names = ["test/ConcurrentProxyA", "test/ConcurrentProxyB"];
    rt.markers(...names);
    const handler = { [mangleMethod("invoke", "(Ljava/lang/Object;Ljava/lang/reflect/Method;[Ljava/lang/Object;)Ljava/lang/Object;")]: () => null };
    const create = (name: string) => vcall(rt.link("java/lang/reflect/Proxy").ctor, "newProxyInstance",
      "(Ljava/lang/ClassLoader;[Ljava/lang/Class;Ljava/lang/reflect/InvocationHandler;)Ljava/lang/Object;", null, [rt.classFor(name)], handler);
    const [first, repeated, other] = await Promise.all([create(names[0]), create(names[0]), create(names[1])]);
    expect(first.constructor === repeated.constructor).toBe(true);
    expect(first.constructor === other.constructor).toBe(false);
    expect([rt.iof(first, names[0]), rt.iof(first, names[1]), rt.iof(other, names[0]), rt.iof(other, names[1])]).toEqual([1, 0, 0, 1]);
  } finally { globalThis.fetch = originalFetch; }
});

test("typed field writes preserve primitive representation and Java widening rules", async () => {
  const methods = ["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"];
  const descriptors = "ZBCSIJFD";
  const allowed = ["Z", "BSIJFD", "CIJFD", "SIJFD", "IJFD", "JFD", "FD", "D"];
  for (let i = 0; i < methods.length; i++) for (const destination of descriptors) {
    const object = new Fields(), f = field(destination), value = descriptors[i] === "J" ? 1n : 1;
    const write = vcallAsync(f, "set" + methods[i], `(Ljava/lang/Object;${descriptors[i]})V`, object, value);
    if (allowed[i].includes(destination)) {
      await write;
      expect(object.value).toBe(destination === "J" ? 1n : 1);
    } else {
      await expect(write).rejects.toMatchObject({ msg: "Invalid primitive field conversion" });
      expect(object.value).toBe(0);
    }
  }
});

test("long field writes keep all bits and round directly when widening to float", async () => {
  const object = new Fields();
  const value = (1n << 62n) + (1n << 38n) + 1n;
  await vcall(field("J"), "setLong", "(Ljava/lang/Object;J)V", object, value);
  expect(object.value).toBe(value);
  await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, value);
  expect(object.value).toBe(2 ** 62 + 2 ** 39);
  await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, -value);
  expect(object.value).toBe(-(2 ** 62 + 2 ** 39));
  await vcall(field("F"), "setLong", "(Ljava/lang/Object;J)V", object, value - 1n);
  expect(object.value).toBe(2 ** 62);
});

test("typed setters ignore static receivers and reject invalid instance receivers and reference fields", async () => {
  await vcall(field("J", true), "setLong", "(Ljava/lang/Object;J)V", null, 7n);
  expect(Fields.value).toBe(7n);
  const error = await vcallAsync(field("J"), "setLong", "(Ljava/lang/Object;J)V", null, 7n).catch(error => error);
  expect(rt.iof(error, "java/lang/NullPointerException")).toBe(1);
  await expect(vcallAsync(field("J"), "setLong", "(Ljava/lang/Object;J)V", new JObj(), 7n)).rejects.toMatchObject({ msg: "Wrong field receiver" });
  await expect(vcallAsync(field("Ljava/lang/Long;"), "setLong", "(Ljava/lang/Object;J)V", new Fields(), 7n)).rejects.toMatchObject({ msg: "Invalid primitive field conversion" });
});

test("a static primitive write waits for its declaring class to initialize", async () => {
  class DelayedFields extends JObj { static value = 0n; }
  rt.register({ name: "test/DelayedFields", ctor: DelayedFields, clinit: async () => {
    await Promise.resolve(); DelayedFields.value = 3n;
  } });
  const f = Object.assign(new JField(), { owner: rt.link("test/DelayedFields"), prop: "value", desc: "J", isStatic: true });
  await vcall(f, "setLong", "(Ljava/lang/Object;J)V", null, 9n);
  expect(DelayedFields.value).toBe(9n);
});

test("type variables are equal only within one generic declaration", async () => {
  const forName = (n: string) => (rt.link("java/lang/Class").ctor as any)[mangleMethod("forName", "(Ljava/lang/String;)Ljava/lang/Class;")](n);
  const arrayList = await forName("java.util.ArrayList"), list = await forName("java.util.List");
  const listOfE = (await vcall(arrayList, "getGenericInterfaces", "()[Ljava/lang/reflect/Type;"))[0];
  const eOfArrayList = (await vcall(listOfE, "getActualTypeArguments", "()[Ljava/lang/reflect/Type;"))[0];
  const eOfList = (await vcall(list, "getTypeParameters", "()[Ljava/lang/reflect/TypeVariable;"))[0];
  expect(await vcall(eOfArrayList, "equals", "(Ljava/lang/Object;)Z", (await vcall(arrayList, "getTypeParameters", "()[Ljava/lang/reflect/TypeVariable;"))[0])).toBe(1);
  expect(await vcall(eOfArrayList, "equals", "(Ljava/lang/Object;)Z", eOfList)).toBe(0);
  expect(await vcall(eOfArrayList, "hashCode", "()I")).not.toBe(await vcall(eOfList, "hashCode", "()I"));
  expect(await vcall(eOfArrayList, "toString", "()Ljava/lang/String;")).toBe("E");
  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", eOfList, "list");
  expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", eOfArrayList)).toBe(null);
  expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", eOfList)).toBe("list");
});

test("Unsafe reference-array offsets preserve adjacent elements and compare-and-swap", async () => {
  const unsafe = await vcall(rt.link("sun/misc/Unsafe").ctor, "getUnsafe", "()Lsun/misc/Unsafe;");
  const cls = rt.classFor("[Ljava/lang/Object;");
  const base = await vcall(unsafe, "arrayBaseOffset", "(Ljava/lang/Class;)I", cls);
  const scale = await vcall(unsafe, "arrayIndexScale", "(Ljava/lang/Class;)I", cls);
  expect([4, 8]).toContain(scale);
  const values = ["first", null, "last"];
  const offset = BigInt(base + scale);
  await vcall(unsafe, "putOrderedObject", "(Ljava/lang/Object;JLjava/lang/Object;)V", values, offset, "middle");
  expect(await vcall(unsafe, "getObjectVolatile", "(Ljava/lang/Object;J)Ljava/lang/Object;", values, offset)).toBe("middle");
  expect(await vcall(unsafe, "compareAndSwapObject", "(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z", values, offset, "middle", "changed")).toBe(1);
  expect(values).toEqual(["first", "changed", "last"]);
});
