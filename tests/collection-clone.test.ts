import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const O = "Ljava/lang/Object;";

test("ArrayList.clone has its own element store", async () => {
  const list = await newObj("java/util/ArrayList", "()V");
  for (const s of ["a", "b", "c"]) await vcall(list, "add", `(${O})Z`, s);
  const copy = await vcall(list, "clone", `()${O}`);
  expect(copy).not.toBe(list);
  expect(rt.iof(copy, "java/util/ArrayList")).toBe(1);
  await vcall(list, "remove", `(${O})Z`, "b");
  expect(await vcall(copy, "size", "()I")).toBe(3);
  await vcall(copy, "add", `(${O})Z`, "d");
  expect(await vcall(list, "size", "()I")).toBe(2);
});

test("HashMap and HashSet clones are independent shallow copies in the same order", async () => {
  const map = await newObj("java/util/LinkedHashMap", "()V");
  await vcall(map, "put", `(${O}${O})${O}`, "z", 1);
  await vcall(map, "put", `(${O}${O})${O}`, "a", 2);
  const copy = await vcall(map, "clone", `()${O}`);
  expect(rt.iof(copy, "java/util/LinkedHashMap")).toBe(1);
  await vcall(copy, "put", `(${O}${O})${O}`, "z", 9);
  expect(await vcall(map, "get", `(${O})${O}`, "z")).toBe(1);
  expect(await vcall(await vcall(copy, "keySet", "()Ljava/util/Set;"), "toString", "()Ljava/lang/String;")).toBe("[z, a]");
  const set = await newObj("java/util/HashSet", "()V");
  await vcall(set, "add", `(${O})Z`, "x");
  const setCopy = await vcall(set, "clone", `()${O}`);
  await vcall(setCopy, "add", `(${O})Z`, "y");
  expect(await vcall(set, "size", "()I")).toBe(1);
  expect(await vcall(setCopy, "contains", `(${O})Z`, "x")).toBe(1);
});
