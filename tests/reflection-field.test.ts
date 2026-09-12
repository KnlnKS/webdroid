import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { JField } from "../src/jvm/natives/jreflect";
import { vcall } from "../src/jvm/natives/jlang";

class Fields extends JObj { value: number | bigint = 0; static value: number | bigint = 0; }
rt.register({ name: "test/PrimitiveFields", ctor: Fields });
rt.linkNatives();
const owner = rt.link("test/PrimitiveFields");
const field = (desc: string, isStatic = false) => Object.assign(new JField(), { owner, prop: "value", desc, isStatic });

test("typed field writes preserve primitive representation and Java widening rules", async () => {
  const methods = ["Boolean", "Byte", "Char", "Short", "Int", "Long", "Float", "Double"];
  const descriptors = "ZBCSIJFD";
  const allowed = ["Z", "BSIJFD", "CIJFD", "SIJFD", "IJFD", "JFD", "FD", "D"];
  for (let i = 0; i < methods.length; i++) for (const destination of descriptors) {
    const object = new Fields(), f = field(destination), value = descriptors[i] === "J" ? 1n : 1;
    const write = vcall(f, "set" + methods[i], `(Ljava/lang/Object;${descriptors[i]})V`, object, value);
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
  const error = await vcall(field("J"), "setLong", "(Ljava/lang/Object;J)V", null, 7n).catch(error => error);
  expect(rt.iof(error, "java/lang/NullPointerException")).toBe(1);
  await expect(vcall(field("J"), "setLong", "(Ljava/lang/Object;J)V", new JObj(), 7n)).rejects.toMatchObject({ msg: "Wrong field receiver" });
  await expect(vcall(field("Ljava/lang/Long;"), "setLong", "(Ljava/lang/Object;J)V", new Fields(), 7n)).rejects.toMatchObject({ msg: "Invalid primitive field conversion" });
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
