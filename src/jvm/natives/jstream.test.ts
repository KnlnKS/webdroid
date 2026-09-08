import { expect, test } from "bun:test";
import { newObj, vcall } from "./jlang";
import "./jstream";

test("Stream.findFirst returns a linked Optional before any Optional static call", async () => {
  const stream = await newObj("java/util/stream/Stream", null);
  const empty = await vcall(stream, "findFirst", "()Ljava/util/Optional;");
  expect(await vcall(empty, "isPresent", "()Z")).toBe(0);
  expect(await vcall(empty, "orElse", "(Ljava/lang/Object;)Ljava/lang/Object;", "fallback")).toBe("fallback");
  stream.a = ["first", "second"];
  const present = await vcall(stream, "findFirst", "()Ljava/util/Optional;");
  expect(await vcall(present, "isPresent", "()Z")).toBe(1);
  expect(await vcall(present, "get", "()Ljava/lang/Object;")).toBe("first");
});
