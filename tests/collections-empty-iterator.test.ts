import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Collections.emptyIterator is empty and immutable by state", async () => {
  const method = rt.link("java/util/Collections").ctor[mangleMethod("emptyIterator", "()Ljava/util/Iterator;")];
  expect(typeof method).toBe("function");
  if (typeof method !== "function") return;
  const iterator = method();
  expect(await vcall(iterator, "hasNext", "()Z")).toBe(0);
  expect(vcall(iterator, "next", "()Ljava/lang/Object;")).rejects.toBeDefined();
  expect(vcall(iterator, "remove", "()V")).rejects.toBeDefined();
});
