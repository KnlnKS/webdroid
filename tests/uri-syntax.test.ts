import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("URI syntax exceptions preserve input, reason and optional index", async () => {
  const error = await newObj("java/net/URISyntaxException", "(Ljava/lang/String;Ljava/lang/String;I)V", "a b", "Illegal character", 1);
  expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("Illegal character at index 1: a b");
  expect(await vcall(error, "getInput", "()Ljava/lang/String;")).toBe("a b");
  expect(await vcall(error, "getReason", "()Ljava/lang/String;")).toBe("Illegal character");
  expect(await vcall(error, "getIndex", "()I")).toBe(1);
});
