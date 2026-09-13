import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

class Value extends JObj {
  constructor(readonly value: number) { super(); }
}
rt.register({
  name: "test/MapValue",
  ctor: Value,
  methods: {
    "equals(Ljava/lang/Object;)Z": async function (this: Value, other: unknown) {
      return other instanceof Value && this.value === other.value ? 1 : 0;
    },
    "hashCode()I": async function (this: Value) { return this.value; },
  },
});
rt.linkNatives();

const O = "Ljava/lang/Object;";
const map = (cls = "java/util/HashMap") => newObj(cls);
const put = (target: unknown, key: unknown, value: unknown) =>
  vcall(target, "put", `(${O}${O})${O}`, key, value);
const equals = (a: unknown, b: unknown) => vcall(a, "equals", `(${O})Z`, b);
const hash = (value: unknown) => vcall(value, "hashCode", "()I");

test("maps compare structurally and hash equal entries identically", async () => {
  const a = await map(), b = await map("java/util/LinkedHashMap");
  await put(a, "a", new Value(7));
  await put(a, "b", "value");
  await put(b, "b", "value");
  await put(b, "a", new Value(7));

  expect(await equals(a, b)).toBe(1);
  expect(await equals(b, a)).toBe(1);
  expect(await hash(a)).toBe(await hash(b));
});

test("a null mapping is distinct from an absent key", async () => {
  const a = await map(), b = await map();
  await put(a, "present", null);
  await put(b, "other", null);

  expect(await equals(a, b)).toBe(0);
  await put(b, "present", null);
  expect(await equals(a, b)).toBe(0);
});
